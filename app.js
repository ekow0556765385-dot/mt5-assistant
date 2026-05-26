const express = require('express');
const app = express();
const http = require('http').createServer(app);
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server: http });
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const { detectPatterns } = require('./patternDetector');
const smcRoute = require('./smc-route');
app.use(smcRoute);
app.use(requireconst PORT = process.env.PORT || 3000;('cors')());
app.use(express.json({ limit: '10mb' }));

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
        console.log('[TELEGRAM] Alerts paused via bot command');

      } else if (text === '/resume') {
        TELEGRAM_PAUSED = false;
        reply = '🔔 Pattern alerts resumed.';
        console.log('[TELEGRAM] Alerts resumed via bot command');

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
  } catch (e) {
    // Silent fail
  }
}

setInterval(pollTelegramCommands, 3000);

// ── Serve dashboards ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/smc-panel', (req, res) => {
  res.sendFile(path.join(__dirname, 'smc-panel.html'));
});

app.get('/patterns', (req, res) => {
  res.sendFile(path.join(__dirname, 'patterns.html'));
});

// ── State ─────────────────────────────────────────────────────────
let s = {
  watchlist: [], candles: {}, patterns: {}, indicators: {},
  openTrades: [], closedTrades: [], accountInfo: {}, newsEvents: [],
  patternAlerts: [],
  livePatterns: {}
};

const lastAlerted = {};

// ── WebSocket ─────────────────────────────────────────────────────
wss.on('connection', ws => {
  console.log('Dashboard connected');
  ws.send(JSON.stringify({ type: 'FULL_STATE', data: s }));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// ── Pattern detection + alert logic ──────────────────────────────
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
    id:         Date.now(),
    symbol,
    timeframe,
    name:       latest.name,
    direction:  latest.direction,
    type:       latest.type,
    confidence: latest.confidence,
    desc:       latest.desc,
    price:      candleArray[candleArray.length - 1].c,
    time:       new Date().toISOString()
  };

  s.patternAlerts.unshift(alert);
  if (s.patternAlerts.length > 50) s.patternAlerts.pop();

  console.log(`[PATTERN] ${symbol} ${timeframe} — ${latest.name} (${latest.direction}, ${latest.confidence}%)`);

  if (latest.confidence >= TELEGRAM_MIN_CONF) {
    const dirIcon   = latest.direction === 'bullish' ? '🟢' : latest.direction === 'bearish' ? '🔴' : '🟡';
    const typeLabel = latest.type === 'reversal' ? '⚡ Reversal' : '➡️ Continuation';
    const teleMsg   =
      `${dirIcon} <b>${latest.name}</b>\n` +
      `📊 ${symbol} · ${timeframe}\n` +
      `💰 Price: ${parseFloat(alert.price).toFixed(5)}\n` +
      `${typeLabel} · Confidence: ${latest.confidence}%\n` +
      `📝 ${latest.desc}`;
    sendTelegram(teleMsg);
  } else {
    console.log(`[TELEGRAM] Skipped — confidence ${latest.confidence}% below ${TELEGRAM_MIN_CONF}% threshold`);
  }

  broadcast('PATTERN_ALERT', alert);

  // ── Feed into SMC confluence engine ──────────────────────────
  try {
    const allPatterns = Object.values(s.patterns[symbol] || {}).flat();
    if (allPatterns.length) {
      const patternsWithPrice = allPatterns.map(p => ({
        ...p,
        price: candleArray[candleArray.length - 1].c,
        timeframe
      }));
      axios.post(`http://localhost:${PORT}/smc/patterns`, {
        symbol,
        patterns: patternsWithPrice
      }).catch(() => {});
    }
  } catch(e) {}

  return detected;
}

// ── Receive MT5 data ──────────────────────────────────────────────
app.post('/api/update', (req, res) => {
  const d = req.body;

  if (d.watchlist)                              s.watchlist    = d.watchlist;
  if (d.indicators)                             s.indicators   = d.indicators;
  if (d.openTrades)                             s.openTrades   = d.openTrades;
  if (d.closedTrades && d.closedTrades.length)  s.closedTrades = d.closedTrades;
  if (d.accountInfo  && d.accountInfo.balance)  s.accountInfo  = d.accountInfo;

  if (d.candles && d.symbol && d.timeframe) {
    const sym = d.symbol;
    const tf  = d.timeframe;

    if (!s.candles[sym])  s.candles[sym]  = {};
    if (!s.patterns[sym]) s.patterns[sym] = {};

    s.candles[sym][tf]  = d.candles;
    const pats          = runPatternDetection(sym, tf, d.candles);
    s.patterns[sym][tf] = pats;

    s.candlesList    = d.candles;
    s.activePatterns = pats;
    s.symbol         = sym;
    s.timeframe      = tf;
  }

  if (d.candles && !d.symbol) s.candlesList    = d.candles;
  if (d.patterns)              s.activePatterns = d.patterns;

  broadcast('TICK', {
    watchlist:     s.watchlist,
    candles:       s.candlesList    || [],
    patterns:      s.activePatterns || [],
    indicators:    s.indicators,
    openTrades:    s.openTrades,
    closedTrades:  s.closedTrades,
    accountInfo:   s.accountInfo,
    newsEvents:    s.newsEvents,
    symbol:        s.symbol    || d.symbol    || '',
    timeframe:     s.timeframe || d.timeframe || '',
    patternAlerts: s.patternAlerts
  });

  res.json({ ok: true });
});

// ── Multi-timeframe endpoint ──────────────────────────────────────
app.post('/api/candles', (req, res) => {
  const { symbol, candles } = req.body;
  if (!symbol || !candles) return res.status(400).json({ error: 'symbol and candles required' });

  if (!s.candles[symbol])  s.candles[symbol]  = {};
  if (!s.patterns[symbol]) s.patterns[symbol] = {};

  const allPatterns = {};
  Object.entries(candles).forEach(([tf, arr]) => {
    s.candles[symbol][tf]  = arr;
    allPatterns[tf]        = runPatternDetection(symbol, tf, arr);
    s.patterns[symbol][tf] = allPatterns[tf];
  });

  broadcast('CANDLE_UPDATE', { symbol, candles: s.candles[symbol], patterns: allPatterns });
  res.json({ ok: true, patternsDetected: Object.values(allPatterns).flat().length });
});

app.get('/api/news',   (req, res) => res.json(s.newsEvents));
app.get('/api/state',  (req, res) => res.json(s));
app.get('/api/alerts', (req, res) => res.json(s.patternAlerts));

// ── Pattern Detector live feed (from PatternDetector.mq5) ────────
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

// ── News Fetcher ──────────────────────────────────────────────────
const HIGH_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];

async function fetchNews() {
  console.log('Fetching forex news...');
  const mapEvents = data => data
    .filter(e => e.impact === 'High' && HIGH_CURRENCIES.includes(e.country))
    .map(e => ({
      title:     e.title,
      country:   e.country,
      impact:    'high',
      timestamp: Math.floor(new Date(e.date).getTime() / 1000),
      forecast:  e.forecast || '—',
      previous:  e.previous || '—',
      actual:    e.actual   || null,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  try {
    const { data } = await axios.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const events = mapEvents(data);
    if (events.length > 0) {
      s.newsEvents = events;
      broadcast('NEWS_UPDATE', events);
      console.log(`✓ Fetched ${events.length} HIGH impact events this week`);
      return;
    }
  } catch (e) { console.warn('This week fetch failed:', e.message); }

  try {
    const { data } = await axios.get('https://nfs.faireconomy.media/ff_calendar_nextweek.json', { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const events = mapEvents(data);
    s.newsEvents = events;
    broadcast('NEWS_UPDATE', events);
    console.log(`✓ Fetched ${events.length} HIGH impact events next week`);
  } catch (e) {
    console.warn('Next week fetch also failed:', e.message);
    s.newsEvents = getPlaceholderNews();
    broadcast('NEWS_UPDATE', s.newsEvents);
  }
}

cron.schedule('* * * * *', () => {
  const now = Date.now() / 1000;
  s.newsEvents.forEach(e => {
    const mins = (e.timestamp - now) / 60;
    if (mins > 14 && mins <= 15) {
      const newsMsg =
        `⚡ <b>HIGH IMPACT NEWS</b>\n` +
        `📰 ${e.title} (${e.country})\n` +
        `⏰ Releasing in 15 minutes!\n` +
        `Forecast: ${e.forecast} · Previous: ${e.previous}`;
      sendTelegram(newsMsg);
      broadcast('NEWS_ALERT', { message: `⚡ HIGH IMPACT: ${e.title} (${e.country}) in 15 minutes!`, event: e });
      console.log('News alert:', e.title);
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
  if (!trade || !trade.ticket || !trade.symbol)
    return res.status(400).json({ error: 'Invalid trade payload' });
  console.log(`[JOURNAL] ${trade.symbol} ${trade.direction} | P/L: $${trade.totalPL} | Ticket: ${trade.ticket}`);
  try {
    const result = await appendTrade(trade);
    broadcast('journal_update', {
      ticket:    trade.ticket,
      symbol:    trade.symbol,
      direction: trade.direction,
      totalPL:   trade.totalPL,
      closeTime: trade.closeTime,
      row:       result.row
    });
    res.status(201).json({ success: true, row: result.row });
  } catch (err) {
    console.error('[JOURNAL ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/journal/status', (req, res) => {
  if (!appendTrade) return res.json({ journalFound: false, note: 'Journal runs locally only' });
  const fs     = require('fs');
  const p      = path.join(__dirname, 'TradingJournal.xlsx');
  const exists = fs.existsSync(p);
  const stat   = exists ? fs.statSync(p) : null;
  res.json({
    journalFound:  exists,
    lastModified:  stat ? stat.mtime : null,
    sizeKB:        stat ? Math.round(stat.size / 1024) : null
  });
});

// ── Start ─────────────────────────────────────────────────────────
// PORT must be defined before http.listen AND before the SMC axios call above
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║   MT5 Assistant Server                       ║
  ║   Port: ${PORT}                               
  ║   Pattern detection : H1 + H4 active         ║
  ║   Telegram          : commands + 70% filter  ║
  ║   SMC Confluence    : active                 ║
  ║   Pattern Detector  : /patterns dashboard    ║
  ╚══════════════════════════════════════════════╝
  `);
});
