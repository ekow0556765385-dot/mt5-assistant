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
  if (d.openTrades) {
    s.openTrades = d.openTrades;
    // Snapshot every open trade's price/sl/tp by ticket for later enrichment
    let snapshotChanged = false;
    d.openTrades.forEach(t => {
      const ticket = String(t.ticket || '');
      if (!ticket) return;
      const openPx = parseFloat(t.openPrice || t.open_price || 0);
      const sl     = parseFloat(t.sl || 0);
      const tp     = parseFloat(t.tp || 0);
      const symbol = t.symbol || '';
      const type   = (t.type || '').toUpperCase();
      const lots   = parseFloat(t.volume || t.lots || 0);
      if (openPx > 0 && (!openTradeSnapshots[ticket] || openTradeSnapshots[ticket].open_price !== openPx)) {
        openTradeSnapshots[ticket] = { ticket, symbol, type, lots, open_price: openPx, sl, tp };
        snapshotChanged = true;
      }
    });
    if (snapshotChanged) saveOpenSnapshots();
  }
  if (d.closedTrades && d.closedTrades.length) s.closedTrades = d.closedTrades;
  if (d.accountInfo  && d.accountInfo.balance) s.accountInfo  = d.accountInfo;

  // If EA explicitly sends empty openTrades (account switch), honour it
  if (d.openTrades && d.openTrades.length === 0) s.openTrades = [];

  // ── Mirror live account + open trades into mathStore (normalised) ──
  // Also detect account switch — clear trade history when login changes
  if (d.accountInfo && d.accountInfo.balance) {
    try {
      const mf          = loadMathTrades();
      // Build account fingerprint — use login if available, else currency+leverage combo
      const newLogin     = String(d.accountInfo.login || d.accountInfo.account || d.accountInfo.accountLogin || '');
      const newCurrency  = String(d.accountInfo.currency || d.accountInfo.account_currency || 'USD');
      const newLeverage  = String(d.accountInfo.leverage || d.accountInfo.account_leverage || '');
      const newBalance   = parseFloat(d.accountInfo.balance || 0);
      const newFingerprint = newLogin || (newCurrency + '_' + newLeverage);

      const storedLogin       = String(mf.account && mf.account.login    ? mf.account.login    : '');
      const storedCurrency    = String(mf.account && mf.account.currency ? mf.account.currency : 'USD');
      const storedLeverage    = String(mf.account && mf.account.leverage ? mf.account.leverage : '');
      const storedFingerprint = storedLogin || (storedCurrency + '_' + storedLeverage);
      const storedBalance     = parseFloat(mf.account && mf.account.balance ? mf.account.balance : 0);

      // Detect account switch:
      // 1. Login number changed (most reliable)
      // 2. Currency changed (e.g. USD account → GBP account)
      // 3. Balance jumped by more than 20% suddenly (switched to different sized account)
      const loginChanged    = newLogin && storedLogin && newLogin !== storedLogin;
      const currencyChanged = storedCurrency && newCurrency && newCurrency !== storedCurrency;
      const balanceJumped   = storedBalance > 0 && newBalance > 0 &&
                              Math.abs(newBalance - storedBalance) / storedBalance > 0.20 &&
                              mf.closed_trades && mf.closed_trades.length > 0;

      if (loginChanged || currencyChanged || balanceJumped) {
        const reason = loginChanged    ? ('login '    + storedLogin    + ' -> ' + newLogin)
                     : currencyChanged ? ('currency ' + storedCurrency + ' -> ' + newCurrency)
                     : ('balance $' + storedBalance.toFixed(0) + ' -> $' + newBalance.toFixed(0));
        console.log('[MATH] Account switched (' + reason + ') — clearing all state');

        // Clear math trades file
        mf.closed_trades = [];
        mf.open_trades   = [];
        mf.stats         = {};

        // Clear open trade snapshots — stale prices from old account
        openTradeSnapshots = {};
        saveOpenSnapshots();

        // ── Also clear main server state so MT5 assistant dashboard
        //    shows fresh data immediately, not old account's trades ──
        s.openTrades   = [];
        s.closedTrades = [];
        s.candles      = {};
        s.patterns     = {};
        s.livePatterns = {};
        s.indicators   = {};
        s.patternAlerts= [];
        // Keep accountInfo — it's being updated right now with new account
        // Broadcast the cleared state to all dashboards immediately
        broadcast('ACCOUNT_SWITCH', {
          reason,
          old_login: storedLogin,
          new_login: newLogin
        });
        broadcast('TICK', {
          watchlist: s.watchlist, candles: [],
          patterns: [], indicators: {},
          openTrades: [], closedTrades: [],
          accountInfo: d.accountInfo,
          newsEvents: s.newsEvents,
          symbol: '', timeframe: '',
          patternAlerts: []
        });
        console.log('[MAIN] Broadcast account switch + cleared state to all dashboards');
      }

      mf.account     = normaliseAccount(d.accountInfo);
      mf.open_trades = d.openTrades ? d.openTrades.map(normaliseOpenTrade) : (mf.open_trades || []);
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

const MATH_TRADES_FILE    = path.join(__dirname, 'math_trades.json');
const OPEN_SNAPSHOT_FILE  = path.join(__dirname, 'open_trade_snapshots.json');

// ── Open trade snapshot store — persists entry price/sl/tp by ticket ──
// Populated every time bridge sends openTrades. Used to enrich closed trades.
let openTradeSnapshots = {};
try {
  if (fs.existsSync(OPEN_SNAPSHOT_FILE)) {
    openTradeSnapshots = JSON.parse(fs.readFileSync(OPEN_SNAPSHOT_FILE, 'utf8'));
    console.log('[MATH] Loaded ' + Object.keys(openTradeSnapshots).length + ' open trade snapshots');
  }
} catch(e) {}

function saveOpenSnapshots() {
  try {
    fs.writeFileSync(OPEN_SNAPSHOT_FILE, JSON.stringify(openTradeSnapshots, null, 2));
  } catch(e) {}
}

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
    const open   = parseFloat(trade.open_price  || 0);
    const close  = parseFloat(trade.close_price || 0);
    const sl     = parseFloat(trade.sl          || 0);
    const profit = parseFloat(trade.profit      || 0);
    const type   = (trade.type || trade.action  || '').toUpperCase();

    // Method 1: price-based — most accurate, needs SL + open + close
    if (sl && open && close) {
      const riskPips = Math.abs(open - sl);
      const gainPips = (type === 'BUY') ? (close - open) : (open - close);
      if (riskPips > 0) return parseFloat((gainPips / riskPips).toFixed(3));
    }

    // Method 2: pip-based — needs pips field (sent by MathReporter)
    const pips = parseFloat(trade.pips || 0);
    if (pips !== 0) {
      return parseFloat((pips / 30).toFixed(3)); // assume 30 pip SL
    }

    // Method 3: dollar-based — profit / assumed risk (1% of typical $10k = $100)
    // risk_amount sent by EA is most accurate; fallback to $100
    const riskAmt = parseFloat(trade.risk_amount || 100);
    if (profit !== 0 && riskAmt > 0) {
      return parseFloat((profit / riskAmt).toFixed(3));
    }

    return null;
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

// ═══════════════════════════════════════════════════════════════
// MATH DASHBOARD ROUTES
// Data flows in from TWO channels simultaneously — both are valid:
//   Channel A: MathReporter WebRequest → POST /api/math-trades (direct, prop firm)
//   Channel B: MathReporter → math_bridge_data.json → math_bridge_watcher.js
//              → POST /api/math-trades (Exness file bridge)
// Both channels hit the same endpoint. app.js deduplicates by ticket number.
// /api/math-data then merges: math_trades.json + live s.accountInfo + s.openTrades
// ═══════════════════════════════════════════════════════════════

// ── Normalise account object (handles camelCase from bridge + snake_case from EA) ──
function normaliseAccount(a) {
  if (!a) return {};
  return {
    balance:     parseFloat(a.balance     || a.account_balance  || 0),
    equity:      parseFloat(a.equity      || a.account_equity   || 0),
    margin:      parseFloat(a.margin      || a.account_margin   || 0),
    free_margin: parseFloat(a.freeMargin  || a.free_margin      || a.account_free_margin || 0),
    margin_level:parseFloat(a.margin_level || 0),
    currency:    a.currency  || a.account_currency  || 'USD',
    leverage:    a.leverage  || a.account_leverage  || 0,
    profit:      parseFloat(a.profit      || a.account_profit   || 0),
    server:      a.server    || a.account_server    || '',
    // login: try every possible field name the bridge EA might send
    login:       String(a.login || a.account_login || a.accountLogin || a.account || ''),
    risk_amount: parseFloat(a.risk_amount || 0)
  };
}

// ── Normalise open trade (handles camelCase from bridge + snake_case from EA) ──
function normaliseOpenTrade(t) {
  if (!t) return {};
  return {
    ticket:        t.ticket      || 0,
    symbol:        t.symbol      || '—',
    type:         (t.type        || '').toUpperCase(),
    lots:          parseFloat(t.lots   || t.volume || 0),
    open_price:    parseFloat(t.open_price  || t.openPrice  || t.entry_price || 0),
    current_price: parseFloat(t.current_price || t.currentPrice || 0),
    sl:            parseFloat(t.sl     || t.stopLoss   || 0),
    tp:            parseFloat(t.tp     || t.takeProfit || 0),
    profit:        parseFloat(t.profit || 0),
    swap:          parseFloat(t.swap   || 0),
    float_r:       t.float_r != null ? parseFloat(t.float_r) : null,
    open_time:     t.open_time   || t.openTime || '',
    magic:         t.magic       || 0
  };
}

// ── Normalise closed trade (handles all field name variants) ──
function normaliseClosedTrade(t, idx) {
  if (!t) return null;
  const open_price  = parseFloat(t.open_price  || t.openPrice  || t.entry_price || t.open  || 0) || null;
  const close_price = parseFloat(t.close_price || t.closePrice || t.exit_price  || t.close || 0) || null;
  const sl          = parseFloat(t.sl          || t.stopLoss   || t.stop_loss   || 0);
  const tp          = parseFloat(t.tp          || t.takeProfit || t.take_profit || 0);
  const lots        = parseFloat(t.lots        || t.volume     || t.vol         || 0);

  // ── TYPE: resolve trade direction ─────────────────────────────
  // Bridge closedTrades come from MT5 deal history (HistoryDealsTotal).
  // In MT5 a BUY trade CLOSES with a SELL deal — so the closing deal type
  // is always the OPPOSITE of the actual trade direction.
  // MathReporter reads the OPENING deal type → already correct, no inversion.
  // Agent session uses 'action' field (BUY/SELL) → correct, no inversion.
  let rawType = String(t.type || t.action || t.direction || t.trade_type || '').toUpperCase().trim();
  // Numeric MQL5 position types
  if (rawType === '0') rawType = 'BUY';
  if (rawType === '1') rawType = 'SELL';
  // Pending order names
  if (rawType === 'BUY_STOP'  || rawType === 'BUY_LIMIT')  rawType = 'BUY';
  if (rawType === 'SELL_STOP' || rawType === 'SELL_LIMIT') rawType = 'SELL';
  // Invert for bridge — closing deal type is opposite of trade direction
  let type_corrected = false;
  if (t._source === 'bridge') {
    if      (rawType === 'BUY')  { rawType = 'SELL'; type_corrected = true; }
    else if (rawType === 'SELL') { rawType = 'BUY';  type_corrected = true; }
  }
  const type = rawType || '—';
  const profit      = parseFloat(t.profit      || t.net_profit || 0);
  const pips        = t.pips != null ? parseFloat(t.pips) : null;
  // Bridge sends unix timestamp in 'time' field — convert to ISO string
  const rawCloseTime = t.close_time || t.closeTime || t.exit_time || t.time || '';
  const close_time   = rawCloseTime
    ? (String(rawCloseTime).length <= 10
        ? new Date(parseInt(rawCloseTime) * 1000).toISOString()  // unix seconds
        : String(rawCloseTime))
    : '';
  const rawOpenTime = t.open_time || t.openTime || t.entry_time || '';
  const open_time   = rawOpenTime
    ? (String(rawOpenTime).length <= 10
        ? new Date(parseInt(rawOpenTime) * 1000).toISOString()
        : String(rawOpenTime))
    : '';
  const ticket      = t.ticket || t.position_id || t.id || (idx + 1);

  // Trust R from EA first, compute server-side only if missing
  // ── Enrich with open trade snapshot if prices are missing ──────
  // Bridge doesn't send open_price/close_price in closed trades.
  // But we snapshot all open trades as they come in, so we can
  // look up the entry price/sl/tp by ticket when the trade closes.
  let enriched_open  = open_price;
  let enriched_sl    = sl;
  let enriched_tp    = tp;
  let enriched_lots  = lots;
  let enriched_type  = type;

  if (!enriched_open || enriched_open === 0) {
    const snap = openTradeSnapshots[String(ticket)];
    if (snap) {
      enriched_open = snap.open_price || enriched_open;
      enriched_sl   = snap.sl   > 0 ? snap.sl   : enriched_sl;
      enriched_tp   = snap.tp   > 0 ? snap.tp   : enriched_tp;
      enriched_lots = snap.lots > 0 ? snap.lots : enriched_lots;
      // Only use snapshot type if current type is unknown
      if (!enriched_type || enriched_type === '—') enriched_type = snap.type || enriched_type;
    }
  }

  // close_price: bridge doesn't send it directly, but we can estimate from profit
  // For major pairs: profit ≈ lots × pips × pipValue
  // This is an estimate — MathReporter gives exact value
  let enriched_close = close_price;
  if ((!enriched_close || enriched_close === 0) && enriched_open && enriched_lots > 0 && pips != null && pips !== 0) {
    const pipSize = enriched_open > 100 ? 0.01 : 0.0001; // JPY/Gold vs Forex
    enriched_close = enriched_type === 'BUY'
      ? enriched_open + (pips * pipSize)
      : enriched_open - (pips * pipSize);
    enriched_close = parseFloat(enriched_close.toFixed(5));
  }

  let r_multiple = null;
  let r_method   = t.r_method || 'unknown';
  if (t.r_multiple != null && t.r_multiple !== 0) {
    r_multiple = parseFloat(t.r_multiple);
    r_method   = t.r_method || 'price';
  } else {
    r_multiple = computeR({ open_price: enriched_open, close_price: enriched_close, sl: enriched_sl, type: enriched_type, profit, pips });
    if (r_multiple !== null) {
      r_method = (enriched_sl && enriched_open && enriched_close) ? 'price'
               : pips ? 'pip_estimate'
               : 'dollar';
    }
  }

  return {
    ticket,
    symbol:      t.symbol   || '—',
    type:        enriched_type,
    lots:        enriched_lots || lots,
    open_price:  enriched_open  || null,
    close_price: enriched_close || null,
    sl:          enriched_sl,
    tp:          enriched_tp,
    profit, pips,
    gross_profit:    parseFloat(t.gross_profit || profit),
    commission:      parseFloat(t.commission   || 0),
    swap:            parseFloat(t.swap         || 0),
    close_time, open_time,
    r_multiple, r_method,
    _source:         t._source || 'math_reporter',
    _type_corrected: type_corrected,
    _enriched:       (!open_price && enriched_open) ? true : false
  };
}

// POST /api/math-trades — receives from MathReporter (both WebRequest AND bridge watcher)
app.post('/api/math-trades', (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.status(400).json({ error: 'No body' });

    const existing        = loadMathTrades();
    const existingTickets = new Set((existing.closed_trades || []).map(t => String(t.ticket)));

    // Normalise + deduplicate incoming trades
    const incoming  = (body.closed_trades || [])
      .map((t, i) => normaliseClosedTrade(t, i))
      .filter(t => t !== null);
    const newTrades = incoming.filter(t => !existingTickets.has(String(t.ticket)));
    const allClosed = [...(existing.closed_trades || []), ...newTrades]
      .sort((a, b) => new Date(a.close_time) - new Date(b.close_time));

    const data = {
      account:       body.account ? normaliseAccount(body.account) : (existing.account || {}),
      open_trades:   (body.open_trades || []).map(normaliseOpenTrade),
      closed_trades: allClosed,
      stats:         recalcMathStats(allClosed),
      last_update:   new Date().toISOString()
    };
    saveMathTrades(data);
    console.log(`[MATH] Received: ${allClosed.length} total closed, ${newTrades.length} new, ${(body.open_trades||[]).length} open`);
    res.set('Access-Control-Allow-Origin', '*');
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

    // ── ACCOUNT: always use freshest source ──
    // Priority: s.accountInfo (live from bridge, updates every tick) > math_trades.json
    const liveAccount = (s.accountInfo && s.accountInfo.balance)
      ? normaliseAccount(s.accountInfo)
      : (math.account || {});

    // ── OPEN TRADES: live from s.openTrades (bridge updates every tick) ──
    // Normalise camelCase fields from bridge
    const liveOpen = (s.openTrades && s.openTrades.length > 0)
      ? s.openTrades.map(normaliseOpenTrade)
      : (math.open_trades || []).map(normaliseOpenTrade);

    // ── CLOSED TRADES: MathReporter is gold standard, bridge is live fallback ──
    // Priority 1: math_trades.json populated by MathReporter (has full price data)
    // Priority 2: s.closedTrades from bridge (profit/volume/type only — no prices)
    // Priority 3: agent_session executed_orders
    let mathClosed   = math.closed_trades || [];
    let bridgeClosed = (s.closedTrades || []).map((t, i) => normaliseClosedTrade({
      ...t,
      open_price:  t.openPrice  || t.open_price  || null,
      close_price: t.closePrice || t.close_price || null,
      _source:     'bridge'
    }, i)).filter(t => t !== null);

    let closedTrades, stats, dataSource;

    if (mathClosed.length > 0) {
      // MathReporter data exists — merge with bridge to fill any gaps
      // Bridge trades may have profit updates not yet in MathReporter file
      const mathByTicket = {};
      mathClosed.forEach(t => { mathByTicket[String(t.ticket)] = t; });

      bridgeClosed.forEach(b => {
        const key = String(b.ticket);
        if (mathByTicket[key]) {
          // Enrich MathReporter trade with bridge profit if missing
          if (!mathByTicket[key].profit && b.profit) {
            mathByTicket[key].profit = b.profit;
          }
        } else {
          // New trade in bridge not yet in MathReporter — add it
          mathByTicket[key] = b;
        }
      });

      closedTrades = Object.values(mathByTicket)
        .sort((a, b) => new Date(a.close_time || 0) - new Date(b.close_time || 0));
      stats        = recalcMathStats(closedTrades);
      dataSource   = 'math_reporter';

    } else if (bridgeClosed.length > 0) {
      // No MathReporter data yet — use bridge trades (profit only, no prices)
      closedTrades = bridgeClosed;
      stats        = recalcMathStats(closedTrades);
      dataSource   = 'bridge';

    } else {
      closedTrades = [];
      stats        = {};
      dataSource   = 'none';
    }

    if (closedTrades.length === 0) {
      // Last resort: agent session executed_orders
      try {
        const sessionFile = path.join(__dirname, 'agent_session.json');
        if (fs.existsSync(sessionFile)) {
          const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
          const orders  = (session.executed_orders || []).filter(o => o.profit !== undefined);
          if (orders.length > 0) {
            closedTrades = orders.map((o, i) => normaliseClosedTrade({
              ...o,
              type:   o.action || o.type,
              _source: 'agent_session'
            }, i)).filter(t => t !== null);
            stats      = recalcMathStats(closedTrades);
            dataSource = 'agent_session';
          }
        }
      } catch(e) {}
    }

    // Agent session info (for agent panel)
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
      }
    } catch(e) {}

    res.set('Access-Control-Allow-Origin', '*');
    res.json({
      account:       liveAccount,
      open_trades:   liveOpen,
      closed_trades: closedTrades,
      stats,
      agent:         agentData,
      data_source:   dataSource,
      last_update:   math.last_update || new Date().toISOString(),
      server_time:   new Date().toISOString()
    });
  } catch(e) {
    console.error('[MATH] GET error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/math-trades/reset
app.delete('/api/math-trades/reset', (req, res) => {
  try {
    saveMathTrades({ account: {}, closed_trades: [], open_trades: [], stats: {}, last_update: new Date().toISOString() });
    res.json({ ok: true, message: 'Math trade history cleared' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
// END MATH DASHBOARD ROUTES
// ════════════════════════════════════════════════════════════════



// ── Math Bridge Watcher (reads math_bridge_data.json from MT5 common files) ──
// Runs inline — no separate process needed
try {
  const mathBridge = require('./math_bridge_watcher');
  console.log('[MathBridge] Watcher started — watching for math_bridge_data.json');
} catch(e) {
  console.log('[MathBridge] Watcher not found — bridge file mode disabled (Railway uses direct WebRequest)');
}

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
