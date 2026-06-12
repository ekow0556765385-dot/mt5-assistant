const express = require('express');
const app = express();
const http = require('http').createServer(app);
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server: http });
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { detectPatterns } = require('./patternDetector');

// ── MIDDLEWARE FIRST (fix: was after smcRoute — broke req.body parsing) ──
app.use(require('cors')());
app.use(express.json({ limit: '10mb' }));

// ── SMC route registered AFTER middleware so req.body is parsed ───
const smcRoute  = require('./smc-route');
const smcStore  = smcRoute.smcStore;
app.use(smcRoute);

// ── Agent ─────────────────────────────────────────────────────────
const { registerAgentRoutes, startAgentLoop, triggerAgentOnCandle } = require('./agent-module');

// ── Telegram config ───────────────────────────────────────────────
const TELEGRAM_TOKEN    = '8591020831:AAF7m22h7gwmuDWklvbRvnXtpPlNolScwZw';
const TELEGRAM_CHAT_ID  = '770749859';
const TELEGRAM_MIN_CONF = 70;
let   TELEGRAM_PAUSED   = false;
let   lastUpdateId      = 0;

async function sendTelegram(message) {
  if (TELEGRAM_PAUSED) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
    console.log('[TELEGRAM] Sent');
  } catch (e) {
    console.warn('[TELEGRAM] Failed:', e.message);
  }
}

// ── Telegram command polling ──────────────────────────────────────
async function pollTelegramCommands() {
  try {
    const { data } = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`,
      { timeout: 8000 }
    );
    for (const update of data.result || []) {
      lastUpdateId = update.update_id;
      const text   = (update.message?.text || '').trim().toLowerCase();
      const chatId = update.message?.chat?.id;
      if (String(chatId) !== String(TELEGRAM_CHAT_ID)) continue;

      let reply = '';

      if (text === '/start' || text === '/help') {
        reply =
          `🤖 <b>MT5 Assistant Bot</b>\n\n` +
          `Commands:\n` +
          `/status — server &amp; account info\n` +
          `/trades — open positions\n` +
          `/lastalerts — last 10 pattern alerts\n` +
          `/pause — stop pattern alerts\n` +
          `/resume — resume pattern alerts\n` +
          `/agentstatus — autonomous agent status\n` +
          `/agenton — enable agent (demo mode)\n` +
          `/agentlive — enable agent (LIVE trades ⚡)\n` +
          `/agentoff — disable agent\n` +
          `/help — show this menu`;

      } else if (text === '/status') {
        const a      = s.accountInfo;
        const uptime = Math.floor(process.uptime() / 60);
        reply =
          `📡 <b>Server Status</b>\n` +
          `✅ Online · Uptime: ${uptime} min\n\n` +
          `💼 <b>Account</b>\n` +
          `Balance: $${parseFloat(a.balance  || 0).toFixed(2)}\n` +
          `Equity:  $${parseFloat(a.equity   || 0).toFixed(2)}\n` +
          `Open P&amp;L: $${parseFloat(a.profit || 0).toFixed(2)}\n\n` +
          `📊 Open trades: ${s.openTrades.length}\n` +
          `🔔 Alerts this session: ${s.patternAlerts.length}\n` +
          `🔕 Alerts paused: ${TELEGRAM_PAUSED ? 'YES' : 'No'}\n` +
          `⚙️ Min confidence: ${TELEGRAM_MIN_CONF}%`;

      } else if (text === '/trades') {
        if (!s.openTrades.length) {
          reply = '📭 No open trades right now.';
        } else {
          reply = `📂 <b>Open Trades (${s.openTrades.length})</b>\n\n`;
          s.openTrades.forEach(t => {
            const pl    = parseFloat(t.profit || 0);
            const plStr = (pl >= 0 ? '🟢 +$' : '🔴 -$') + Math.abs(pl).toFixed(2);
            const sl    = t.sl && parseFloat(t.sl) !== 0 ? parseFloat(t.sl).toFixed(5) : '⚠️ NONE';
            const tp    = t.tp && parseFloat(t.tp) !== 0 ? parseFloat(t.tp).toFixed(5) : '—';
            reply +=
              `<b>${t.symbol}</b> ${(t.type || '').toUpperCase()}\n` +
              `Vol: ${parseFloat(t.volume).toFixed(2)} · Entry: ${parseFloat(t.openPrice).toFixed(5)}\n` +
              `SL: ${sl} · TP: ${tp}\n` +
              `P&amp;L: ${plStr}\n\n`;
          });
        }

      } else if (text === '/lastalerts') {
        if (!s.patternAlerts.length) {
          reply = '📭 No pattern alerts yet this session.';
        } else {
          const last = s.patternAlerts.slice(0, 10);
          reply = `🔔 <b>Last ${last.length} Alerts</b>\n\n`;
          last.forEach(a => {
            const icon = a.direction === 'bullish' ? '🟢' : a.direction === 'bearish' ? '🔴' : '🟡';
            const t    = new Date(a.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            reply += `${icon} <b>${a.name}</b> · ${a.symbol} ${a.timeframe} · ${a.confidence}% · ${t}\n`;
          });
        }

      } else if (text === '/pause') {
        TELEGRAM_PAUSED = true;
        reply = '🔕 Pattern alerts paused. Send /resume to turn back on.';

      } else if (text === '/resume') {
        TELEGRAM_PAUSED = false;
        reply = '🔔 Pattern alerts resumed.';

      // ── Agent Telegram commands ───────────────────────────────
      } else if (text === '/agentstatus') {
        const { agentState } = require('./agent-module');
        const last = agentState.lastDecision;
        reply =
          `🤖 <b>Agent Status</b>\n` +
          `State: ${agentState.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
          `Mode: ${agentState.demoMode ? '🔵 DEMO' : '⚡ LIVE'}\n` +
          `Runs: ${agentState.runCount}\n` +
          `Active ticket: ${agentState.activeTicket || 'None'}\n` +
          `Last action: ${agentState.lastAction}\n` +
          `Last confidence: ${agentState.lastConfidence}\n` +
          `Last reason: ${agentState.lastReason || '—'}\n` +
          `Last run: ${agentState.lastRunAt ? new Date(agentState.lastRunAt).toLocaleTimeString() : 'Never'}`;

      } else if (text === '/agenton') {
        const { agentState } = require('./agent-module');
        agentState.enabled  = true;
        agentState.demoMode = true;
        reply = '🔵 <b>Agent ENABLED — DEMO mode</b>\nDecisions will be logged but no real trades placed. Use /agentlive to go live.';

      } else if (text === '/agentlive') {
        const { agentState } = require('./agent-module');
        agentState.enabled  = true;
        agentState.demoMode = false;
        reply = '⚡ <b>Agent ENABLED — LIVE mode</b>\nReal trades will be placed on your MT5 account. Use /agentoff to stop.';

      } else if (text === '/agentoff') {
        const { agentState } = require('./agent-module');
        agentState.enabled = false;
        reply = '❌ <b>Agent DISABLED</b>\nNo more autonomous decisions. Use /agenton to restart in demo mode.';

      } else {
        reply = '❓ Unknown command. Send /help to see available commands.';
      }

      if (reply) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: TELEGRAM_CHAT_ID,
          text: reply,
          parse_mode: 'HTML'
        });
      }
    }
  } catch (e) { /* silent fail */ }
}

setInterval(pollTelegramCommands, 3000);

// ── Serve dashboards ──────────────────────────────────────────────
app.get('/',         (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/smc-panel',(req, res) => res.sendFile(path.join(__dirname, 'smc-panel.html')));
app.get('/patterns', (req, res) => res.sendFile(path.join(__dirname, 'patterns.html')));
app.get('/brain',    (req, res) => res.sendFile(path.join(__dirname, 'mt5_trading_brain_v3.html')));
app.get('/agent',    (req, res) => res.sendFile(path.join(__dirname, 'agent-dashboard.html')));
app.get('/math',     (req, res) => res.sendFile(path.join(__dirname, 'blackwood_math_dashboard_v2.html')));

// ── State ─────────────────────────────────────────────────────────
let s = {
  watchlist: [], candles: {}, patterns: {}, indicators: {},
  openTrades: [], closedTrades: [], accountInfo: {}, newsEvents: [],
  patternAlerts: [], livePatterns: {}
};

let candlesStore = {};
const lastAlerted = {};

// ── Register agent routes (surgical — no existing routes touched) ─
registerAgentRoutes(app, () => s, smcStore, candlesStore);

// ── WebSocket ─────────────────────────────────────────────────────
wss.on('connection', ws => {
  console.log('Dashboard connected');
  ws.send(JSON.stringify({ type: 'FULL_STATE', data: s }));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// ── Pattern detection ─────────────────────────────────────────────
const ALERT_TIMEFRAMES = ['H1', 'H4'];

function runPatternDetection(symbol, timeframe, candleArray) {
  if (!ALERT_TIMEFRAMES.includes(timeframe)) return [];
  if (!candleArray || candleArray.length < 3) return [];

  const detected = detectPatterns(candleArray, timeframe);
  if (!detected.length) return [];

  const key    = `${symbol}_${timeframe}`;
  const latest = detected[0];

  if (lastAlerted[key] === latest.name) return detected;
  lastAlerted[key] = latest.name;

  const alert = {
    id: Date.now(), symbol, timeframe,
    name: latest.name, direction: latest.direction,
    type: latest.type, confidence: latest.confidence,
    desc: latest.desc,
    price: candleArray[candleArray.length - 1].c,
    time: new Date().toISOString()
  };

  s.patternAlerts.unshift(alert);
  if (s.patternAlerts.length > 50) s.patternAlerts.pop();

  console.log(`[PATTERN] ${symbol} ${timeframe} — ${latest.name} (${latest.direction}, ${latest.confidence}%)`);

  if (latest.confidence >= TELEGRAM_MIN_CONF) {
    const dirIcon   = latest.direction === 'bullish' ? '🟢' : latest.direction === 'bearish' ? '🔴' : '🟡';
    const typeLabel = latest.type === 'reversal' ? '⚡ Reversal' : '➡️ Continuation';
    sendTelegram(
      `${dirIcon} <b>${latest.name}</b>\n` +
      `📊 ${symbol} · ${timeframe}\n` +
      `💰 Price: ${parseFloat(alert.price).toFixed(5)}\n` +
      `${typeLabel} · Confidence: ${latest.confidence}%\n` +
      `📝 ${latest.desc}`
    );
  }

  broadcast('PATTERN_ALERT', alert);

  try {
    const allPatterns = Object.values(s.patterns[symbol] || {}).flat();
    if (allPatterns.length) {
      axios.post(`http://localhost:${PORT}/smc/patterns`, {
        symbol,
        patterns: allPatterns.map(p => ({ ...p, price: candleArray[candleArray.length - 1].c, timeframe }))
      }).catch(() => {});
    }
  } catch(e) {}

  return detected;
}

// ── /api/update ───────────────────────────────────────────────────
app.post('/api/update', (req, res) => {
  const d = req.body;
  if (d.watchlist)                             s.watchlist    = d.watchlist;
  if (d.indicators)                            s.indicators   = d.indicators;
  if (d.openTrades)                            s.openTrades   = d.openTrades;
  if (d.closedTrades && d.closedTrades.length) s.closedTrades = d.closedTrades;
  if (d.accountInfo  && d.accountInfo.balance) s.accountInfo  = d.accountInfo;

  // ── Mirror live account into mathStore for math dashboard ──────
  if (d.accountInfo && d.accountInfo.balance) {
    try {
      const mf = loadMathTrades();
      mf.account = {
        balance:     d.accountInfo.balance,
        equity:      d.accountInfo.equity,
        margin:      d.accountInfo.margin,
        free_margin: d.accountInfo.freeMargin || d.accountInfo.free_margin,
        currency:    d.accountInfo.currency   || 'USD',
        leverage:    d.accountInfo.leverage,
        profit:      d.accountInfo.profit,
        server:      d.accountInfo.server || ''
      };
      if (d.openTrades) mf.open_trades = d.openTrades;
      mf.last_update = new Date().toISOString();
      saveMathTrades(mf);
    } catch(e) { /* non-critical */ }
  }

  if (d.candles && d.symbol && d.timeframe) {
    const sym = d.symbol, tf = d.timeframe;
    if (!s.candles[sym])  s.candles[sym]  = {};
    if (!s.patterns[sym]) s.patterns[sym] = {};
    s.candles[sym][tf]  = d.candles;
    const pats = runPatternDetection(sym, tf, d.candles);
    s.patterns[sym][tf] = pats;
    s.candlesList = d.candles; s.activePatterns = pats;
    s.symbol = sym; s.timeframe = tf;
  }
  if (d.candles && !d.symbol) s.candlesList    = d.candles;
  if (d.patterns)              s.activePatterns = d.patterns;

  broadcast('TICK', {
    watchlist: s.watchlist, candles: s.candlesList || [],
    patterns: s.activePatterns || [], indicators: s.indicators,
    openTrades: s.openTrades, closedTrades: s.closedTrades,
    accountInfo: s.accountInfo, newsEvents: s.newsEvents,
    symbol: s.symbol || d.symbol || '', timeframe: s.timeframe || d.timeframe || '',
    patternAlerts: s.patternAlerts
  });
  res.json({ ok: true });
});

// ── /api/candles ──────────────────────────────────────────────────
app.post('/api/candles', (req, res) => {
  const d = req.body;
  if (!d || !d.symbol) return res.status(400).json({ error: 'symbol required' });
  const sym = d.symbol;
  if (!s.candles[sym])  s.candles[sym]  = {};
  if (!s.patterns[sym]) s.patterns[sym] = {};

  // Format A — EA v3.4: flat array + timeframe
  if (Array.isArray(d.candles) && d.timeframe) {
    const tf = d.timeframe;
    s.candles[sym][tf]  = d.candles;
    s.patterns[sym][tf] = runPatternDetection(sym, tf, d.candles);
    candlesStore[sym] = {
      symbol: sym, timeframe: tf, candles: d.candles,
      timestamp: d.timestamp || new Date().toISOString(),
      received_at: new Date().toISOString()
    };
    console.log(`[Candles] ${sym} ${tf} — ${d.candles.length} bars stored`);
    broadcast('CANDLE_UPDATE', { symbol: sym, timeframe: tf, candles: d.candles });

    // ── Agent trigger on H1/H4 candle close ──────────────────────
    triggerAgentOnCandle(s, smcStore, candlesStore, tf);

    return res.json({ ok: true, symbol: sym, timeframe: tf, bars: d.candles.length });
  }

  // Format B — old multi-tf object
  if (d.candles && typeof d.candles === 'object' && !Array.isArray(d.candles)) {
    const allPatterns = {};
    Object.entries(d.candles).forEach(([tf, arr]) => {
      s.candles[sym][tf]  = arr;
      allPatterns[tf]      = runPatternDetection(sym, tf, arr);
      s.patterns[sym][tf] = allPatterns[tf];
      triggerAgentOnCandle(s, smcStore, candlesStore, tf);
    });
    broadcast('CANDLE_UPDATE', { symbol: sym, candles: s.candles[sym], patterns: allPatterns });
    return res.json({ ok: true, patternsDetected: Object.values(allPatterns).flat().length });
  }

  return res.status(400).json({ error: 'invalid candles format' });
});

app.get('/api/candles', (req, res) => {
  const { symbol } = req.query;
  if (symbol) {
    const data = candlesStore[symbol];
    if (!data) return res.json({ symbol, candles: [], note: 'No candle data yet' });
    return res.json(data);
  }
  const all = Object.values(candlesStore);
  if (!all.length) return res.json({ candles: [], note: 'No candle data yet' });
  all.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
  res.json(all[0]);
});

app.get('/api/news',   (req, res) => res.json(s.newsEvents));
app.get('/api/state',  (req, res) => res.json(s));
app.get('/api/alerts', (req, res) => res.json(s.patternAlerts));

// ── /api/patterns ─────────────────────────────────────────────────
app.post('/api/patterns', (req, res) => {
  const data = req.body;
  if (!data || !data.symbol) return res.status(400).json({ error: 'Missing symbol' });
  const key = `${data.symbol}_${data.timeframe}`;
  s.livePatterns[key] = { ...data, received_at: new Date().toISOString() };
  console.log(`[PatternDetector] ${data.symbol} ${data.timeframe} | bias: ${data.bias} | score: ${data.bias_score} | patterns: ${(data.patterns || []).length}`);
  broadcast('LIVE_PATTERNS', s.livePatterns[key]);
  res.json({ status: 'ok', key });
});

app.get('/api/patterns/latest', (req, res) => {
  const all = Object.values(s.livePatterns);
  if (!all.length) return res.json({});
  all.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
  res.json(all[0]);
});

app.get('/api/patterns', (req, res) => {
  const { symbol, tf } = req.query;
  if (symbol && tf) return res.json(s.livePatterns[`${symbol}_${tf}`] || {});
  res.json(s.livePatterns);
});

// ── /api/analyse — existing Claude verdict (UNCHANGED) ────────────
app.post('/api/analyse', async (req, res) => {
  const { ssi } = req.body;

  const sym = s.symbol
    || Object.keys(candlesStore)[0]
    || (Object.keys(s.livePatterns)[0] || '').split('_')[0]
    || Object.keys(smcStore)[0]
    || '';

  if (!sym) {
    return res.status(400).json({ error: 'No live data yet — make sure EA is running and sending data' });
  }
  console.log(`[ANALYSE] Active symbol resolved: ${sym}`);

  const updateData = {
    symbol:    sym,
    timeframe: s.timeframe,
    price:     s.candlesList?.length ? s.candlesList[s.candlesList.length - 1].c : 0,
    ...s.indicators,
    openTrades:  s.openTrades,
    accountInfo: s.accountInfo
  };

  const smcData = smcStore[sym]
    || smcStore[sym.replace('c','')]
    || Object.values(smcStore)[0]
    || {};

  const patKey      = Object.keys(s.livePatterns).find(k => k.startsWith(sym)) || Object.keys(s.livePatterns)[0] || '';
  const patternData = s.livePatterns[patKey] || {};
  const candleData  = candlesStore[sym] || Object.values(candlesStore)[0] || {};

  const candleArr = (candleData.candles || []).slice(-8);
  const candleSummary = candleArr.length
    ? candleArr.map((c, i) => {
        const dir = c.close > c.open ? '▲' : '▼';
        const body = Math.abs(c.close - c.open).toFixed(2);
        const time = c.time ? new Date(c.time * 1000).toISOString().slice(11,16) : `bar${i}`;
        return `${time} ${dir} O:${parseFloat(c.open).toFixed(2)} H:${parseFloat(c.high).toFixed(2)} L:${parseFloat(c.low).toFixed(2)} C:${parseFloat(c.close).toFixed(2)} body:${body}`;
      }).join('\n')
    : 'No candle data available';

  const prompt = [
    `Live MT5 market data for ${sym} (${s.timeframe || 'unknown TF'}) — ${new Date().toUTCString()}:\n`,
    '=== SOURCE 1: Price + Indicators ===',
    JSON.stringify(updateData,  null, 2),
    '\n=== SOURCE 2: SMC (Smart Money Concepts) ===',
    JSON.stringify(smcData,     null, 2),
    '\n=== SOURCE 3: Pattern Detector ===',
    JSON.stringify(patternData, null, 2),
    '\n=== SOURCE 4: SSI Engine (Structure Signal Indicator) ===',
    JSON.stringify(ssi || {},   null, 2),
    '\n=== RECENT M15 CANDLES (last 8 bars) ===',
    candleSummary,
    '\nAnalyse all sources and give your verdict.'
  ].join('\n');

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: `You are an expert Forex, Gold and crypto market analyst. You work across all pairs — Forex (EURUSD, GBPUSD, USDJPY, USDCHF, GBPJPY), Gold (XAUUSD), and crypto (BTCUSD etc).

You receive data from 5 sources:
1. Price + Indicators — live price, RSI, EMA20/EMA50, bias_score, open trades
2. SMC — CHoCH, BOS, Order Blocks, FVGs, HTF bias
3. Pattern Detector — candlestick patterns with confidence % and bar_index
4. SSI Engine — signal codes +1/-1 (Structure+Trend), +2/-2 (Pattern+Trend), 0 (no signal); bias_score, ema_bias, trendBuy/trendSell
5. Recent M15 Candles — last 8 bars

When an open trade exists, state whether to hold, add, or close it.
Use bias_score: positive = bullish pressure, negative = bearish.

Structure your response as:
📊 MARKET STRUCTURE
[2-3 sentences: structure, HTF bias, key levels]

📈 CONFLUENCE ANALYSIS
[How all 5 sources agree or conflict]

🎯 TRADE SETUP
[Direction, entry logic, SL, invalidation. Open trade recommendation if applicable.]

⚠️ KEY RISK
[1-2 sentences]

IMPORTANT — finish your response with EXACTLY these two lines, no markdown, no bold, no extra text:
VERDICT: BULLISH
CONFIDENCE: Medium

Substitute BULLISH with BEARISH or NEUTRAL as appropriate.
Substitute Medium with Low or High as appropriate.
These two lines must be the very last lines of your response.`,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        timeout: 60000
      }
    );

    const text = (response.data.content || []).map(c => c.text || '').join('');
    const clean = text.replace(/\*\*/g, '');

    let verdict = 'NEUTRAL';
    const bullCount = (clean.match(/BULLISH/gi) || []).length;
    const bearCount = (clean.match(/BEARISH/gi) || []).length;

    if (clean.match(/^VERDICT:\s*BEARISH/im))        verdict = 'BEARISH';
    else if (clean.match(/^VERDICT:\s*BULLISH/im))   verdict = 'BULLISH';
    else if (clean.match(/^VERDICT:\s*NEUTRAL/im))   verdict = 'NEUTRAL';
    else if (clean.match(/VERDICT[^a-z]*BEARISH/i))  verdict = 'BEARISH';
    else if (clean.match(/VERDICT[^a-z]*BULLISH/i))  verdict = 'BULLISH';
    else if (bearCount > bullCount + 1)               verdict = 'BEARISH';
    else if (bullCount > bearCount + 1)               verdict = 'BULLISH';

    let confidence = 'Medium';
    if (clean.match(/^CONFIDENCE:\s*High/im))         confidence = 'High';
    else if (clean.match(/^CONFIDENCE:\s*Low/im))     confidence = 'Low';
    else if (clean.match(/^CONFIDENCE:\s*Medium/im))  confidence = 'Medium';
    else if (clean.match(/Confidence[^a-z]*High/i))   confidence = 'High';
    else if (clean.match(/Confidence[^a-z]*Low/i))    confidence = 'Low';

    console.log('[ANALYSE] verdict=' + verdict + ' confidence=' + confidence);
    res.json({ ok: true, verdict: text, extractedVerdict: verdict, extractedConfidence: confidence });

  } catch (e) {
    console.error('[ANALYSE] Claude API error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ── News Fetcher ──────────────────────────────────────────────────
const HIGH_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];

async function fetchNews() {
  console.log('Fetching forex news...');
  const mapEvents = data => data
    .filter(e => e.impact === 'High' && HIGH_CURRENCIES.includes(e.country))
    .map(e => ({
      title: e.title, country: e.country, impact: 'high',
      timestamp: Math.floor(new Date(e.date).getTime() / 1000),
      forecast: e.forecast || '—', previous: e.previous || '—', actual: e.actual || null,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  try {
    const { data } = await axios.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const events = mapEvents(data);
    if (events.length > 0) {
      s.newsEvents = events; broadcast('NEWS_UPDATE', events);
      console.log(`✓ Fetched ${events.length} HIGH impact events this week`); return;
    }
  } catch (e) { console.warn('This week fetch failed:', e.message); }

  try {
    const { data } = await axios.get('https://nfs.faireconomy.media/ff_calendar_nextweek.json', { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const events = mapEvents(data);
    s.newsEvents = events; broadcast('NEWS_UPDATE', events);
    console.log(`✓ Fetched ${events.length} HIGH impact events next week`);
  } catch (e) {
    console.warn('Next week fetch also failed:', e.message);
    s.newsEvents = getPlaceholderNews(); broadcast('NEWS_UPDATE', s.newsEvents);
  }
}

cron.schedule('* * * * *', () => {
  const now = Date.now() / 1000;
  s.newsEvents.forEach(e => {
    const mins = (e.timestamp - now) / 60;
    if (mins > 14 && mins <= 15) {
      sendTelegram(`⚡ <b>HIGH IMPACT NEWS</b>\n📰 ${e.title} (${e.country})\n⏰ Releasing in 15 minutes!\nForecast: ${e.forecast} · Previous: ${e.previous}`);
      broadcast('NEWS_ALERT', { message: `⚡ HIGH IMPACT: ${e.title} (${e.country}) in 15 minutes!`, event: e });
    }
  });
});

function getPlaceholderNews() {
  const now = Math.floor(Date.now() / 1000);
  return [
    { title: 'Non-Farm Payrolls', country: 'USD', impact: 'high', timestamp: now + 3600,  forecast: '—', previous: '—', actual: null },
    { title: 'CPI y/y',           country: 'USD', impact: 'high', timestamp: now + 7200,  forecast: '—', previous: '—', actual: null },
    { title: 'Interest Rate',     country: 'EUR', impact: 'high', timestamp: now + 10800, forecast: '—', previous: '—', actual: null },
    { title: 'GDP q/q',           country: 'GBP', impact: 'high', timestamp: now + 14400, forecast: '—', previous: '—', actual: null },
  ];
}

fetchNews();
cron.schedule('*/30 * * * *', fetchNews);

// ── Journal ───────────────────────────────────────────────────────
let appendTrade = null;
try {
  appendTrade = require('./journalWriter').appendTrade;
  console.log('[JOURNAL] journalWriter loaded OK');
} catch (e) {
  console.log('[JOURNAL] journalWriter not found — journal disabled (Railway mode)');
}

app.post('/journal/trade', async (req, res) => {
  if (!appendTrade) return res.status(503).json({ error: 'Journal not available on this server (local only)' });
  const trade = req.body;
  if (!trade || !trade.ticket || !trade.symbol) return res.status(400).json({ error: 'Invalid trade payload' });
  console.log(`[JOURNAL] ${trade.symbol} ${trade.direction} | P/L: $${trade.totalPL} | Ticket: ${trade.ticket}`);
  try {
    const result = await appendTrade(trade);
    broadcast('journal_update', { ticket: trade.ticket, symbol: trade.symbol, direction: trade.direction, totalPL: trade.totalPL, closeTime: trade.closeTime, row: result.row });
    res.status(201).json({ success: true, row: result.row });
  } catch (err) {
    console.error('[JOURNAL ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/journal/status', (req, res) => {
  if (!appendTrade) return res.json({ journalFound: false, note: 'Journal runs locally only' });
  const fs = require('fs');
  const p  = path.join(__dirname, 'TradingJournal.xlsx');
  const exists = fs.existsSync(p);
  const stat   = exists ? fs.statSync(p) : null;
  res.json({ journalFound: exists, lastModified: stat ? stat.mtime : null, sizeKB: stat ? Math.round(stat.size / 1024) : null });
});

// ════════════════════════════════════════════════════════════════
// MATH DASHBOARD ROUTES
// ════════════════════════════════════════════════════════════════

const MATH_TRADES_FILE = path.join(__dirname, 'math_trades.json');

function loadMathTrades() {
  try {
    if (fs.existsSync(MATH_TRADES_FILE)) {
      return JSON.parse(fs.readFileSync(MATH_TRADES_FILE, 'utf8'));
    }
  } catch (e) { console.error('[MATH] Load error:', e.message); }
  return { account: {}, closed_trades: [], open_trades: [], stats: {}, last_update: null };
}

function saveMathTrades(data) {
  const tmp = MATH_TRADES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, MATH_TRADES_FILE);
}

function computeR(trade) {
  try {
    const open  = parseFloat(trade.open_price);
    const close = parseFloat(trade.close_price);
    const sl    = parseFloat(trade.sl);
    if (!sl || !open || !close) return null;
    const riskPips = Math.abs(open - sl);
    const gainPips = (trade.type === 'BUY') ? (close - open) : (open - close);
    if (riskPips === 0) return null;
    return parseFloat((gainPips / riskPips).toFixed(3));
  } catch(e) { return null; }
}

function recalcMathStats(closed) {
  if (!closed || closed.length === 0) return {};
  const wins   = closed.filter(t => t.profit > 0);
  const losses = closed.filter(t => t.profit <= 0);
  const winRate = closed.length > 0 ? wins.length / closed.length : 0;

  const rVals   = closed.map(t => t.r_multiple).filter(r => r !== null && r !== undefined);
  const winRs   = rVals.filter(r => r > 0);
  const lossRs  = rVals.filter(r => r <= 0);
  const avgWinR  = winRs.length  > 0 ? winRs.reduce((s,r)=>s+r,0)/winRs.length   : 0;
  const avgLossR = lossRs.length > 0 ? Math.abs(lossRs.reduce((s,r)=>s+r,0)/lossRs.length) : 0;

  const totalProfit  = closed.reduce((s,t) => s + (t.profit||0), 0);
  const now = Date.now();
  const dayMs  = 86400000, weekMs = 7 * dayMs;
  const dailyProfit  = closed.filter(t => now - new Date(t.close_time).getTime() < dayMs).reduce((s,t) => s+(t.profit||0), 0);
  const weeklyProfit = closed.filter(t => now - new Date(t.close_time).getTime() < weekMs).reduce((s,t) => s+(t.profit||0), 0);

  const lossRate   = 1 - winRate;
  const spreadCost = 0.08;
  const paperExp   = (winRate * avgWinR) - (lossRate * (avgLossR || 1));
  const realExp    = paperExp - spreadCost;

  let streak = 0, streakType = 'none';
  if (closed.length > 0) {
    const last = closed[closed.length - 1];
    streakType = last.profit > 0 ? 'win' : 'loss';
    for (let i = closed.length - 1; i >= 0; i--) {
      if ((streakType === 'win') === (closed[i].profit > 0)) streak++;
      else break;
    }
  }

  return {
    total_trades: closed.length, wins: wins.length, losses: losses.length,
    win_rate:     parseFloat((winRate * 100).toFixed(2)),
    avg_win_r:    parseFloat(avgWinR.toFixed(3)),
    avg_loss_r:   parseFloat(avgLossR.toFixed(3)),
    paper_expectancy: parseFloat(paperExp.toFixed(4)),
    real_expectancy:  parseFloat(realExp.toFixed(4)),
    total_profit:   parseFloat(totalProfit.toFixed(2)),
    daily_profit:   parseFloat(dailyProfit.toFixed(2)),
    weekly_profit:  parseFloat(weeklyProfit.toFixed(2)),
    current_streak: streak, streak_type: streakType
  };
}

// POST /api/math-trades — MathReporter EA sends full history here
app.post('/api/math-trades', (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.status(400).json({ error: 'No body' });

    const existing = loadMathTrades();
    const existingTickets = new Set((existing.closed_trades || []).map(t => String(t.ticket)));
    const incoming  = (body.closed_trades || []).map(t => ({ ...t, r_multiple: computeR(t) }));
    const newTrades = incoming.filter(t => !existingTickets.has(String(t.ticket)));
    const allClosed = [...(existing.closed_trades || []), ...newTrades]
      .sort((a, b) => new Date(a.close_time) - new Date(b.close_time));

    const data = {
      account:       body.account       || existing.account,
      open_trades:   body.open_trades   || [],
      closed_trades: allClosed,
      stats:         recalcMathStats(allClosed),
      last_update:   new Date().toISOString()
    };
    saveMathTrades(data);
    console.log(`[MATH] Updated: ${allClosed.length} closed, ${(body.open_trades||[]).length} open, ${newTrades.length} new`);
    res.json({ ok: true, closed: allClosed.length, new_trades: newTrades.length });
  } catch(e) {
    console.error('[MATH] POST error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/math-data — dashboard polls this every 30s
app.get('/api/math-data', (req, res) => {
  try {
    const math = loadMathTrades();

    // Merge live account from main state (always freshest source)
    if (s.accountInfo && s.accountInfo.balance) {
      math.account = {
        balance:     s.accountInfo.balance,
        equity:      s.accountInfo.equity,
        margin:      s.accountInfo.margin,
        free_margin: s.accountInfo.freeMargin || s.accountInfo.free_margin,
        currency:    s.accountInfo.currency || 'USD',
        leverage:    s.accountInfo.leverage,
        profit:      s.accountInfo.profit,
        server:      s.accountInfo.server || ''
      };
    }

    // Merge live open trades from main state
    if (s.openTrades && s.openTrades.length > 0) {
      math.open_trades = s.openTrades;
    }

    // Merge closed trades from s.closedTrades if MathReporter hasn't run yet
    if ((!math.closed_trades || math.closed_trades.length === 0) && s.closedTrades && s.closedTrades.length > 0) {
      const mapped = s.closedTrades.map((t, i) => ({
        ticket:      t.ticket || i + 1,
        symbol:      t.symbol || '—',
        type:        t.type   || '—',
        lots:        t.volume || t.lots || 0,
        open_price:  t.openPrice  || t.open_price  || 0,
        close_price: t.closePrice || t.close_price || 0,
        sl:          t.sl || 0,
        tp:          t.tp || 0,
        profit:      parseFloat(t.profit || 0),
        pips:        t.pips || 0,
        close_time:  t.closeTime || t.close_time || new Date().toISOString(),
        r_multiple:  computeR({ open_price: t.openPrice||t.open_price, close_price: t.closePrice||t.close_price, sl: t.sl, type: t.type })
      }));
      math.closed_trades = mapped;
      math.stats = recalcMathStats(mapped);
    }

    // Enrich agent session data
    let agentData = {};
    try {
      const sessionFile = path.join(__dirname, 'agent_session.json');
      if (fs.existsSync(sessionFile)) {
        const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        agentData = {
          agent_enabled: session.agent_enabled,
          mode:          session.mode,
          trades_today:  session.trades_today,
          daily_loss:    session.daily_loss,
          last_decision: session.last_decision
        };

        // Also pull executed orders as closed trades if nothing else available
        if ((!math.closed_trades || math.closed_trades.length === 0) && session.executed_orders && session.executed_orders.length > 0) {
          const mapped = session.executed_orders.filter(o => o.profit !== undefined).map((o, i) => ({
            ticket:      i + 1,
            symbol:      o.symbol || '—',
            type:        o.action || '—',
            lots:        o.lots   || 0,
            open_price:  o.open_price  || 0,
            close_price: o.close_price || 0,
            sl:          o.sl || 0,
            tp:          o.tp || 0,
            profit:      parseFloat(o.profit || 0),
            pips:        o.pips || 0,
            close_time:  o.close_time || new Date().toISOString(),
            r_multiple:  computeR(o)
          }));
          math.closed_trades = mapped;
          math.stats = recalcMathStats(mapped);
        }
      }
    } catch(e) {}

    res.json({
      account:       math.account       || {},
      open_trades:   math.open_trades   || [],
      closed_trades: math.closed_trades || [],
      stats:         math.stats         || {},
      agent:         agentData,
      last_update:   math.last_update,
      server_time:   new Date().toISOString()
    });
  } catch(e) {
    console.error('[MATH] GET error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/math-trades/reset — clear history
app.delete('/api/math-trades/reset', (req, res) => {
  try {
    saveMathTrades({ account: {}, closed_trades: [], open_trades: [], stats: {}, last_update: new Date().toISOString() });
    res.json({ ok: true, message: 'Math trade history cleared' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
// END MATH DASHBOARD ROUTES
// ════════════════════════════════════════════════════════════════

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.listen(3000, '0.0.0.0', () => {
  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║   MT5 Assistant Server                           ║
  ║   Port: ${PORT}                                 
  ║   Pattern detection : H1 + H4 active             ║
  ║   Telegram          : commands + 70% filter      ║
  ║   SMC Confluence    : active                     ║
  ║   Pattern Detector  : /patterns dashboard        ║
  ║   Candles API       : /api/candles (v3.4)        ║
  ║   AI Brain          : /brain + /api/analyse      ║
  ║   Autonomous Agent  : /agent dashboard           ║
  ║   Trading Math      : /math dashboard            ║
  ╚══════════════════════════════════════════════════╝
  `);
  startAgentLoop(() => s, smcStore, candlesStore);
});
