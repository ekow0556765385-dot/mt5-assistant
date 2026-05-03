const express = require('express');
const app = express();
const http = require('http').createServer(app);
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server: http });
const axios = require('axios');
const cron = require('node-cron');

app.use(require('cors')());
app.use(express.json({ limit: '10mb' }));

// ── Serve dashboard ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile('index.html.html', {
    root: 'C:\\Users\\USER\\Downloads\\mt5- assistant\\dashboard'
  });
});

// ── State ─────────────────────────────────────────────────────────
let s = {
  watchlist: [], candles: [], patterns: [], indicators: {},
  openTrades: [], closedTrades: [], accountInfo: {}, newsEvents: []
};

// ── WebSocket ─────────────────────────────────────────────────────
wss.on('connection', ws => {
  console.log('Dashboard connected');
  ws.send(JSON.stringify({ type: 'FULL_STATE', data: s }));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// ── Receive MT5 data ──────────────────────────────────────────────
app.post('/api/update', (req, res) => {
  const d = req.body;
  if (d.watchlist) s.watchlist = d.watchlist;
  if (d.candles) s.candles = d.candles;
  if (d.patterns) s.patterns = d.patterns;
  if (d.indicators) s.indicators = d.indicators;
  if (d.openTrades) s.openTrades = d.openTrades;
  if (d.closedTrades && d.closedTrades.length) s.closedTrades = d.closedTrades;
  if (d.accountInfo && d.accountInfo.balance) s.accountInfo = d.accountInfo;
  s.newsEvents = s.newsEvents; // keep existing news
  broadcast('TICK', s);
  res.json({ ok: true });
});

app.get('/api/news', (req, res) => res.json(s.newsEvents));
app.get('/api/state', (req, res) => res.json(s));

// ── News Fetcher ──────────────────────────────────────────────────
const HIGH_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];

async function fetchNews() {
  console.log('Fetching forex news...');

  // Try ForexFactory this week
  try {
    const { data } = await axios.get(
      'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
      { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );

    const events = data
      .filter(e => e.impact === 'High' && HIGH_CURRENCIES.includes(e.country))
      .map(e => ({
        title:     e.title,
        country:   e.country,
        impact:    'high',
        timestamp: Math.floor(new Date(e.date).getTime() / 1000),
        forecast:  e.forecast  || '—',
        previous:  e.previous  || '—',
        actual:    e.actual    || null,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (events.length > 0) {
      s.newsEvents = events;
      broadcast('NEWS_UPDATE', events);
      console.log(`✓ Fetched ${events.length} HIGH impact events this week`);
      return;
    }
  } catch (e) {
    console.warn('This week fetch failed:', e.message);
  }

  // Try next week too
  try {
    const { data } = await axios.get(
      'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
      { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );

    const events = data
      .filter(e => e.impact === 'High' && HIGH_CURRENCIES.includes(e.country))
      .map(e => ({
        title:     e.title,
        country:   e.country,
        impact:    'high',
        timestamp: Math.floor(new Date(e.date).getTime() / 1000),
        forecast:  e.forecast  || '—',
        previous:  e.previous  || '—',
        actual:    e.actual    || null,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    s.newsEvents = events;
    broadcast('NEWS_UPDATE', events);
    console.log(`✓ Fetched ${events.length} HIGH impact events next week`);
  } catch (e) {
    console.warn('Next week fetch also failed:', e.message);
    // Use hardcoded placeholder so dashboard is not empty
    s.newsEvents = getPlaceholderNews();
    broadcast('NEWS_UPDATE', s.newsEvents);
  }
}

// ── News alert 15 min before event ────────────────────────────────
cron.schedule('* * * * *', () => {
  const now = Date.now() / 1000;
  s.newsEvents.forEach(e => {
    const mins = (e.timestamp - now) / 60;
    if (mins > 14 && mins <= 15) {
      broadcast('NEWS_ALERT', {
        message: `⚡ HIGH IMPACT: ${e.title} (${e.country}) in 15 minutes!`,
        event: e
      });
      console.log('News alert:', e.title);
    }
  });
});

// ── Placeholder news if all fetches fail ──────────────────────────
function getPlaceholderNews() {
  const now = Math.floor(Date.now() / 1000);
  return [
    { title: 'Non-Farm Payrolls', country: 'USD', impact: 'high', timestamp: now + 3600, forecast: '—', previous: '—', actual: null },
    { title: 'CPI y/y', country: 'USD', impact: 'high', timestamp: now + 7200, forecast: '—', previous: '—', actual: null },
    { title: 'Interest Rate Decision', country: 'EUR', impact: 'high', timestamp: now + 10800, forecast: '—', previous: '—', actual: null },
    { title: 'GDP q/q', country: 'GBP', impact: 'high', timestamp: now + 14400, forecast: '—', previous: '—', actual: null },
  ];
}

// Fetch on startup and every 30 minutes
fetchNews();
cron.schedule('*/30 * * * *', fetchNews);

// ── Start ─────────────────────────────────────────────────────────
http.listen(3000, '0.0.0.0', () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   MT5 Assistant Server               ║
  ║   Running on http://localhost:3000   ║
  ╚══════════════════════════════════════╝
  `);
});
