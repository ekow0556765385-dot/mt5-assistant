const express = require('express');
const app = express();
app.set('trust proxy', 1); // Railway terminates TLS in front of this app — needed for secure cookies
const http = require('http').createServer(app);
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server: http });
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { detectPatterns } = require('./patternDetector');

// ── MIDDLEWARE FIRST (fix: was after smcRoute — broke req.body parsing) ──
app.use(require('cors')());
app.use(cookieParser());
// Capture raw body for Paystack webhook signature verification,
// while still parsing JSON normally for every other route.
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// ── Allow dashboard.html to embed all tools in iframes (same origin) ──
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.removeHeader('X-Frame-Options'); // remove any blocking
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  next();
});

// ── SMC route registered AFTER middleware so req.body is parsed ───
const smcRoute  = require('./smc-route');
const smcStore  = smcRoute.smcStore;
const smcStoreKey = smcRoute.storeKey; // `${userId}::${symbol}` — same helper smc-route.js uses

// agent-module.js (and /api/analyse below) still expect a plain
// {symbol: data} object, not the `${userId}::${symbol}`-keyed store —
// this builds that view for one user without needing to touch
// agent-module.js's own lookup code.
function getSmcStoreForUser(userId) {
  const prefix = `${userId}::`;
  const out = {};
  Object.keys(smcStore).forEach(k => {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = smcStore[k];
  });
  return out;
}

// registerAgentRoutes()/startAgentLoop() only run ONCE at server startup
// and capture whatever object reference they're given inside a closure —
// the original code relied on that captured reference being the SAME
// object smc-route.js kept mutating (so it stayed "live" without ever
// being reassigned). A freshly-built plain object from
// getSmcStoreForUser() at boot time (when primaryUserId is still null)
// would freeze forever as {} — so instead we keep ONE persistent object
// here and refresh its contents in place right before the agent needs
// them, preserving the original live-reference behavior.
const livePrimarySmcView = {};
function refreshPrimarySmcView() {
  const fresh = getSmcStoreForUser(primaryUserId);
  Object.keys(livePrimarySmcView).forEach(k => delete livePrimarySmcView[k]);
  Object.assign(livePrimarySmcView, fresh);
}
app.use(smcRoute);

// ── Agent ─────────────────────────────────────────────────────────
const { registerAgentRoutes, startAgentLoop, triggerAgentOnCandle } = require('./agent-module');

// ── Auth middleware ────────────────────────────────────────────
const { requirePlan, requireAuth, getMe, validateKey, regenerateKey, issueTicketRoute, isOwner, getUserCredits, deductCredits, resetUserCredits, MONTHLY_CREDIT_USD, SUPABASE_URL, supabaseServiceHeaders, verifyAppSession, getUserIdForLicenceKey } = require('./auth-middleware');

// ── Paystack payment routes ────────────────────────────────────
const paystackRoute = require('./paystack-route');
app.use(paystackRoute);

// ── Telegram config ───────────────────────────────────────────────
const TELEGRAM_TOKEN    = '8849142563:AAHOL16YSxzJ_KRgWvU5Fxq8o_bTGO6Ji3A';
const TELEGRAM_CHAT_ID  = '770749859';
const TELEGRAM_MIN_CONF = 70;
let   TELEGRAM_PAUSED   = false;
let   lastUpdateId      = 0;

const { createLinkCode, linkChatIdToCode, getAllLinkedChatIds, getChatIdForUser } = require('./telegram-store');

async function sendTelegramMessage(chatId, message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (e) {
    console.warn('[TELEGRAM] Failed to send to', chatId, ':', e.message);
  }
}

async function sendTelegram(message) {
  if (TELEGRAM_PAUSED) return;
  await sendTelegramMessage(TELEGRAM_CHAT_ID, message);
  console.log('[TELEGRAM] Sent (owner)');
}

// Sends a pattern/news alert to every subscriber who has linked their
// own Telegram chat, in addition to the owner's existing alert above.
async function broadcastTelegramToUsers(message) {
  try {
    const chatIds = await getAllLinkedChatIds();
    await Promise.all(chatIds.map(id => sendTelegramMessage(id, message)));
    if (chatIds.length) console.log(`[TELEGRAM] Broadcast to ${chatIds.length} linked user(s)`);
  } catch (e) {
    console.warn('[TELEGRAM] Broadcast failed:', e.message);
  }
}

// Sends a message to one specific user's linked chat (e.g. their own
// closed-trade journal alert). Silently does nothing if unlinked.
async function sendTelegramToUser(userId, message) {
  try {
    const chatId = await getChatIdForUser(userId);
    if (!chatId) return;
    await sendTelegramMessage(chatId, message);
  } catch (e) {
    console.warn('[TELEGRAM] sendTelegramToUser failed:', e.message);
  }
}

// GET /api/telegram/link — dashboard calls this to get a one-time
// deep link the user taps to connect their own Telegram chat.
app.get('/api/telegram/link', requirePlan('pro'), async (req, res) => {
  try {
    const code = await createLinkCode(req.user.id);
    res.json({ code, deepLink: `https://t.me/Blackwood_Alerts_bot?start=${code}` });
  } catch (err) {
    console.error('[TELEGRAM LINK ERROR]', err.message);
    res.status(500).json({ error: 'Could not generate link code' });
  }
});

// GET /api/telegram/status — dashboard polls this to show connected/not
app.get('/api/telegram/status', requirePlan('pro'), async (req, res) => {
  try {
    const chatId = await getChatIdForUser(req.user.id);
    res.json({ connected: !!chatId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Telegram command polling ──────────────────────────────────────
async function pollTelegramCommands() {
  try {
    const { data } = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`,
      { timeout: 8000 }
    );
    for (const update of data.result || []) {
      lastUpdateId = update.update_id;
      const rawText = (update.message?.text || '').trim();
      const text    = rawText.toLowerCase();
      const chatId  = update.message?.chat?.id;

      // ── /start <code> — any user's chat, not just the owner's ──
      // Matches the one-time code from /api/telegram/link and saves
      // this chat_id against their account.
      if (chatId && text.startsWith('/start ')) {
        const code = rawText.split(' ')[1]?.trim();
        const userId = code ? await linkChatIdToCode(code, chatId) : null;
        await sendTelegramMessage(
          chatId,
          userId
            ? '✅ <b>Connected!</b>\nYou\'ll now receive your pattern alerts, news alerts, and trade journal updates here.'
            : '❌ That link code is invalid or expired. Go back to the Pro dashboard and click "Connect Telegram" again.'
        );
        continue;
      }

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
        const st     = getState(primaryUserId);
        const a      = st.accountInfo;
        const uptime = Math.floor(process.uptime() / 60);
        reply =
          `📡 <b>Server Status</b>\n` +
          `✅ Online · Uptime: ${uptime} min\n\n` +
          `💼 <b>Account</b>\n` +
          `Balance: $${parseFloat(a.balance  || 0).toFixed(2)}\n` +
          `Equity:  $${parseFloat(a.equity   || 0).toFixed(2)}\n` +
          `Open P&amp;L: $${parseFloat(a.profit || 0).toFixed(2)}\n\n` +
          `📊 Open trades: ${st.openTrades.length}\n` +
          `🔔 Alerts this session: ${st.patternAlerts.length}\n` +
          `🔕 Alerts paused: ${TELEGRAM_PAUSED ? 'YES' : 'No'}\n` +
          `⚙️ Min confidence: ${TELEGRAM_MIN_CONF}%`;

      } else if (text === '/trades') {
        const st = getState(primaryUserId);
        if (!st.openTrades.length) {
          reply = '📭 No open trades right now.';
        } else {
          reply = `📂 <b>Open Trades (${st.openTrades.length})</b>\n\n`;
          st.openTrades.forEach(t => {
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
        const st = getState(primaryUserId);
        if (!st.patternAlerts.length) {
          reply = '📭 No pattern alerts yet this session.';
        } else {
          const last = st.patternAlerts.slice(0, 10);
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
// ── Protected Pro tool routes ──────────────────────────────────
// Every dashboard page now requires an active Pro/Lifetime plan.
// Owners (see OWNER_EMAILS in auth-middleware.js) bypass this
// automatically and always get in for free.
app.get('/',           requirePlan('pro'), (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/smc-panel',  requirePlan('pro'), (req, res) => res.sendFile(path.join(__dirname, 'smc-panel.html')));
app.get('/patterns',   requirePlan('pro'), (req, res) => res.sendFile(path.join(__dirname, 'patterns.html')));
app.get('/brain',      requirePlan('pro'), (req, res) => res.sendFile(path.join(__dirname, 'mt5_trading_brain_v4.html')));
app.get('/agent',      requirePlan('pro'), (req, res) => res.sendFile(path.join(__dirname, 'agent-dashboard.html')));
app.get('/math',       requirePlan('pro'), (req, res) => res.sendFile(path.join(__dirname, 'blackwood_math_dashboard_v2.html')));

// ── Pro subscriber unified dashboard portal ───────────────────────
// Protected — requires active Pro or Lifetime subscription
app.get('/dashboard', requirePlan('pro'), (req, res) => res.sendFile(path.join(__dirname, 'blackwood_dashboard.html')));

// ── Auth API routes ───────────────────────────────────────────────
app.get('/api/me',           getMe);
app.post('/api/ticket',      issueTicketRoute);
app.post('/api/validate-key', validateKey);
app.post('/api/regenerate-key', regenerateKey);

// ── State — now per-user instead of one shared object ──────────────
// Every paying customer's EA reports through the same Railway app, so
// this used to be a single global `s` that silently mixed everyone's
// trades/candles/patterns together. `states[userId]` gives each
// customer their own isolated copy; `getState(userId)` creates one on
// first contact. News events stay in one shared list below — market
// news is genuinely the same for everyone, not per-account data.
function makeEmptyState() {
  return {
    watchlist: [], candles: {}, patterns: {}, indicators: {},
    openTrades: [], closedTrades: [], accountInfo: {},
    patternAlerts: [], livePatterns: {},
    candlesList: [], activePatterns: [], symbol: '', timeframe: ''
  };
}
const states = {};
function getState(userId) {
  if (!userId) userId = 'anonymous'; // shouldn't happen once EAs are all on licenceKey-tagged builds
  if (!states[userId]) states[userId] = makeEmptyState();
  return states[userId];
}

// candlesStore used to be a single global object keyed by symbol —
// now keyed by userId first, symbol second.
const candlesStoreByUser = {};
function getCandlesStore(userId) {
  if (!userId) userId = 'anonymous';
  if (!candlesStoreByUser[userId]) candlesStoreByUser[userId] = {};
  return candlesStoreByUser[userId];
}

// The autonomous agent (agent-module.js) is still single-account by
// design — one agentState, one RISK config, one order-execution flow.
// Reworking that to be genuinely multi-tenant (per-user risk settings,
// per-user execution routing) is a separate, deliberately careful pass
// given real money is involved. Until then, it stays wired to whichever
// account most recently sent data — matching exactly how it behaved
// before this change (there was only ever one account's data anyway).
let primaryUserId = null;
const lastLiveLoginByUser = {}; // tracks the main EA's account per user, only to know when to clear live UI state

// (candlesStore is now always accessed via getCandlesStore(userId) — see above)

// ── Shared, genuinely global data (not per-user) ───────────────────
let newsEvents = [];

// openTradeSnapshots is now per-user — see getOpenSnapshots()/setOpenSnapshots()/
// saveOpenSnapshots() defined next to loadMathTrades()/saveMathTrades() below.

// ── Register agent routes — still single-account under the hood ───
registerAgentRoutes(app, () => getState(primaryUserId), livePrimarySmcView, getCandlesStore(primaryUserId));

// ── WebSocket — now identifies which account each browser tab belongs
// to via the same signed session cookie HTTP routes use, and only
// sends that account's own data to it. ──────────────────────────────
function parseCookieHeader(header) {
  const out = {};
  (header || '').split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

wss.on('connection', (ws, req) => {
  const cookies = parseCookieHeader(req.headers.cookie);
  const session = verifyAppSession(cookies['bw-session']);
  if (!session || !session.uid) {
    console.log('[WS] Connection rejected — no valid session cookie');
    ws.close(4001, 'Not authenticated');
    return;
  }
  ws.userId = session.uid;
  console.log(`[WS] Dashboard connected — user=${ws.userId}`);
  ws.send(JSON.stringify({ type: 'FULL_STATE', data: getState(ws.userId) }));
});

// type=null broadcasts to everyone (used for shared data like news);
// otherwise only clients whose ws.userId matches get the message.
function broadcast(userId, type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach(c => {
    if (c.readyState !== 1) return;
    if (userId === null || c.userId === userId) c.send(msg);
  });
}

// ── Pattern detection ─────────────────────────────────────────────
const ALERT_TIMEFRAMES = ['H1', 'H4'];

const lastAlertedByUser = {};

function runPatternDetection(userId, symbol, timeframe, candleArray) {
  if (!ALERT_TIMEFRAMES.includes(timeframe)) return [];
  if (!candleArray || candleArray.length < 3) return [];

  const detected = detectPatterns(candleArray, timeframe);
  if (!detected.length) return [];

  const st = getState(userId);
  if (!lastAlertedByUser[userId]) lastAlertedByUser[userId] = {};
  const lastAlerted = lastAlertedByUser[userId];

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

  st.patternAlerts.unshift(alert);
  if (st.patternAlerts.length > 50) st.patternAlerts.pop();

  console.log(`[PATTERN] user=${userId} ${symbol} ${timeframe} — ${latest.name} (${latest.direction}, ${latest.confidence}%)`);

  if (latest.confidence >= TELEGRAM_MIN_CONF) {
    const dirIcon   = latest.direction === 'bullish' ? '🟢' : latest.direction === 'bearish' ? '🔴' : '🟡';
    const typeLabel = latest.type === 'reversal' ? '⚡ Reversal' : '➡️ Continuation';
    const patternMsg =
      `${dirIcon} <b>${latest.name}</b>\n` +
      `📊 ${symbol} · ${timeframe}\n` +
      `💰 Price: ${parseFloat(alert.price).toFixed(5)}\n` +
      `${typeLabel} · Confidence: ${latest.confidence}%\n` +
      `📝 ${latest.desc}`;
    // Owner's personal ops bot still gets everything (single chat, unchanged
    // behavior). broadcastTelegramToUsers() currently sends this pattern
    // alert to EVERY linked customer regardless of whose account it came
    // from — I haven't seen telegram-store.js's implementation, so I'm not
    // changing its call signature blind. This is a real per-user leak
    // (customer A gets customer B's pattern alerts) that needs telegram-store.js
    // to scope alerts by userId once I can see how chat-id linking works there.
    sendTelegram(patternMsg);
    broadcastTelegramToUsers(patternMsg);
  }

  broadcast(userId, 'PATTERN_ALERT', alert);

  try {
    const allPatterns = Object.values(st.patterns[symbol] || {}).flat();
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
app.post('/api/update', async (req, res) => {
  const d = req.body;

  const userId = await getUserIdForLicenceKey(d.licenceKey);
  if (!userId) {
    console.warn('[UPDATE] Rejected — no valid licenceKey on payload. Update your EA to v3.8+ and make sure a valid licence key is entered.');
    return res.status(401).json({ error: 'Missing or invalid licenceKey. Update your EA and paste your Blackwood licence key into its inputs.' });
  }
  primaryUserId = userId; // agent still follows "whichever account is currently active"
  refreshPrimarySmcView();

  const s  = getState(userId);
  const cs = getCandlesStore(userId);
  const liveAccountNumber = d.accountInfo ? String(d.accountInfo.login || d.accountInfo.account || d.accountInfo.accountLogin || '') || null : null;

  if (d.watchlist)                             s.watchlist    = d.watchlist;
  if (d.indicators)                            s.indicators   = d.indicators;
  if (d.openTrades) {
    s.openTrades = d.openTrades;
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
      const snapshots = getOpenSnapshots(userId, liveAccountNumber);
      if (openPx > 0 && (!snapshots[ticket] || snapshots[ticket].open_price !== openPx)) {
        snapshots[ticket] = { ticket, symbol, type, lots, open_price: openPx, sl, tp };
        snapshotChanged = true;
      }
    });
    if (snapshotChanged) saveOpenSnapshots(userId, liveAccountNumber);
  }
  if (d.closedTrades && d.closedTrades.length) s.closedTrades = d.closedTrades;
  if (d.accountInfo  && d.accountInfo.balance) s.accountInfo  = d.accountInfo;
  if (d.openTrades && d.openTrades.length === 0) s.openTrades = [];

  // Live-state account-switch check — this ONLY clears the transient live
  // ticking display (candles/patterns/indicators for the dashboard UI).
  // It no longer touches math-trades history at all: that's now owned
  // entirely by /api/math-trades' per-account bucketing (see storage
  // functions above), which never wipes anything — it just tracks which
  // account is "current". This check purely prevents stale live UI state
  // (e.g. candles from the old account) from lingering on screen.
  if (liveAccountNumber) {
    if (!lastLiveLoginByUser[userId]) lastLiveLoginByUser[userId] = liveAccountNumber;
    else if (lastLiveLoginByUser[userId] !== liveAccountNumber) {
      const oldLogin = lastLiveLoginByUser[userId];
      lastLiveLoginByUser[userId] = liveAccountNumber;
      console.log(`[MAIN] user=${userId} live account changed (${oldLogin} -> ${liveAccountNumber}) — clearing live UI state only, math-trades history is unaffected`);

      s.openTrades   = [];
      s.closedTrades = [];
      s.candles      = {};
      s.patterns     = {};
      s.livePatterns = {};
      s.indicators   = {};
      s.patternAlerts= [];
      broadcast(userId, 'ACCOUNT_SWITCH', { reason: `login ${oldLogin} -> ${liveAccountNumber}`, old_login: oldLogin, new_login: liveAccountNumber });
      broadcast(userId, 'TICK', {
        watchlist: s.watchlist, candles: [],
        patterns: [], indicators: {},
        openTrades: [], closedTrades: [],
        accountInfo: d.accountInfo,
        newsEvents: newsEvents,
        symbol: '', timeframe: '',
        patternAlerts: []
      });
    }
  }

  if (d.candles && d.symbol && d.timeframe) {
    const sym = d.symbol, tf = d.timeframe;
    if (!s.candles[sym])  s.candles[sym]  = {};
    if (!s.patterns[sym]) s.patterns[sym] = {};
    s.candles[sym][tf]  = d.candles;
    const pats = runPatternDetection(userId, sym, tf, d.candles);
    s.patterns[sym][tf] = pats;
    s.candlesList = d.candles; s.activePatterns = pats;
    s.symbol = sym; s.timeframe = tf;
  }
  if (d.candles && !d.symbol) s.candlesList    = d.candles;
  if (d.patterns)              s.activePatterns = d.patterns;

  broadcast(userId, 'TICK', {
    watchlist: s.watchlist, candles: s.candlesList || [],
    patterns: s.activePatterns || [], indicators: s.indicators,
    openTrades: s.openTrades, closedTrades: s.closedTrades,
    accountInfo: s.accountInfo, newsEvents: newsEvents,
    symbol: s.symbol || d.symbol || '', timeframe: s.timeframe || d.timeframe || '',
    patternAlerts: s.patternAlerts
  });
  res.json({ ok: true });
});

// ── /api/candles ──────────────────────────────────────────────────
app.post('/api/candles', async (req, res) => {
  const d = req.body;
  if (!d || !d.symbol) return res.status(400).json({ error: 'symbol required' });

  const userId = await getUserIdForLicenceKey(d.licenceKey);
  if (!userId) return res.status(401).json({ error: 'Missing or invalid licenceKey' });

  const s  = getState(userId);
  const cs = getCandlesStore(userId);
  const sym = d.symbol;
  if (!s.candles[sym])  s.candles[sym]  = {};
  if (!s.patterns[sym]) s.patterns[sym] = {};

  if (Array.isArray(d.candles) && d.timeframe) {
    const tf = d.timeframe;
    s.candles[sym][tf]  = d.candles;
    s.patterns[sym][tf] = runPatternDetection(userId, sym, tf, d.candles);
    cs[sym] = {
      symbol: sym, timeframe: tf, candles: d.candles,
      timestamp: d.timestamp || new Date().toISOString(),
      received_at: new Date().toISOString()
    };
    console.log(`[Candles] user=${userId} ${sym} ${tf} — ${d.candles.length} bars stored`);
    broadcast(userId, 'CANDLE_UPDATE', { symbol: sym, timeframe: tf, candles: d.candles });
    if (userId === primaryUserId) { refreshPrimarySmcView(); triggerAgentOnCandle(s, livePrimarySmcView, cs, tf); }
    return res.json({ ok: true, symbol: sym, timeframe: tf, bars: d.candles.length });
  }

  if (d.candles && typeof d.candles === 'object' && !Array.isArray(d.candles)) {
    const allPatterns = {};
    Object.entries(d.candles).forEach(([tf, arr]) => {
      s.candles[sym][tf]  = arr;
      allPatterns[tf]      = runPatternDetection(userId, sym, tf, arr);
      s.patterns[sym][tf] = allPatterns[tf];
      if (userId === primaryUserId) { refreshPrimarySmcView(); triggerAgentOnCandle(s, livePrimarySmcView, cs, tf); }
    });
    broadcast(userId, 'CANDLE_UPDATE', { symbol: sym, candles: s.candles[sym], patterns: allPatterns });
    return res.json({ ok: true, patternsDetected: Object.values(allPatterns).flat().length });
  }

  return res.status(400).json({ error: 'invalid candles format' });
});

app.get('/api/candles', requirePlan('pro'), (req, res) => {
  const cs = getCandlesStore(req.user.id);
  const { symbol } = req.query;
  if (symbol) {
    const data = cs[symbol];
    if (!data) return res.json({ symbol, candles: [], note: 'No candle data yet' });
    return res.json(data);
  }
  const all = Object.values(cs);
  if (!all.length) return res.json({ candles: [], note: 'No candle data yet' });
  all.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
  res.json(all[0]);
});

// News is genuinely shared market data — same for every user — so this
// one stays a plain global list, not per-user.
app.get('/api/news',   requirePlan('pro'), (req, res) => res.json(newsEvents));
app.get('/api/state',  requirePlan('pro'), (req, res) => res.json(getState(req.user.id)));
app.get('/api/alerts', requirePlan('pro'), (req, res) => res.json(getState(req.user.id).patternAlerts));

// ── /api/patterns ─────────────────────────────────────────────────
app.post('/api/patterns', async (req, res) => {
  const data = req.body;
  if (!data || !data.symbol) return res.status(400).json({ error: 'Missing symbol' });

  const userId = await getUserIdForLicenceKey(data.licenceKey);
  if (!userId) return res.status(401).json({ error: 'Missing or invalid licenceKey' });

  const s   = getState(userId);
  const key = `${data.symbol}_${data.timeframe}`;
  s.livePatterns[key] = { ...data, received_at: new Date().toISOString() };
  console.log(`[PatternDetector] user=${userId} ${data.symbol} ${data.timeframe} | bias: ${data.bias} | score: ${data.bias_score} | patterns: ${(data.patterns || []).length}`);
  broadcast(userId, 'LIVE_PATTERNS', s.livePatterns[key]);
  res.json({ status: 'ok', key });
});

app.get('/api/patterns/latest', requirePlan('pro'), (req, res) => {
  const all = Object.values(getState(req.user.id).livePatterns);
  if (!all.length) return res.json({});
  all.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
  res.json(all[0]);
});

app.get('/api/patterns', requirePlan('pro'), (req, res) => {
  const s = getState(req.user.id);
  const { symbol, tf } = req.query;
  if (symbol && tf) return res.json(s.livePatterns[`${symbol}_${tf}`] || {});
  res.json(s.livePatterns);
});

// ── Pattern filter helper ─────────────────────────────────────────
function buildFilteredPatternData(patternData) {
  const bias    = (patternData.bias || 'neutral').toLowerCase();
  const allPats = patternData.patterns || [];
  const candles = patternData.candles || patternData.m15_candles || [];

  const recentPatterns = allPats.filter(p => (p.bar_index ?? 99) <= 2);
  const midPatterns    = allPats.filter(p => (p.bar_index ?? 99) >= 3 && (p.bar_index ?? 99) <= 8);
  const stalePatterns  = allPats.filter(p => (p.bar_index ?? 99) > 8);

  let sorted = [...candles];
  if (sorted[0] && sorted[0].time) {
    sorted.sort((a, b) => new Date(b.time) - new Date(a.time));
  }

  let alignedCandles;
  if (bias === 'bullish') {
    alignedCandles = sorted.filter(c => parseFloat(c.close) > parseFloat(c.open)).slice(0, 5);
  } else if (bias === 'bearish') {
    alignedCandles = sorted.filter(c => parseFloat(c.close) < parseFloat(c.open)).slice(0, 5);
  } else {
    alignedCandles = sorted.slice(0, 5);
  }

  return {
    symbol:               patternData.symbol,
    timeframe:            patternData.timeframe,
    bias,
    bias_score:           patternData.bias_score,
    rsi:                  patternData.rsi,
    ema_bias:             patternData.ema_bias,
    sr_levels:            patternData.sr_levels || [],
    recent_patterns:      recentPatterns,
    mid_patterns_count:   midPatterns.length,
    stale_patterns_count: stalePatterns.length,
    aligned_candles:      alignedCandles,
    aligned_candles_note: bias !== 'neutral'
      ? `Only ${bias} candles shown — ${alignedCandles.length} of ${candles.length} total confirm ${bias} direction`
      : `Neutral bias — showing last ${alignedCandles.length} candles`,
    has_recent_confirmation: recentPatterns.length > 0,
    has_candle_alignment:    alignedCandles.length > 0,
    pattern_bias_conflict:   recentPatterns.length > 0 &&
      recentPatterns.some(p =>
        (bias === 'bullish' && p.type === 'bear') ||
        (bias === 'bearish' && p.type === 'bull')
      )
  };
}

// ── /api/credits — current balance for the credit widget ───────────
app.get('/api/credits', requirePlan('pro'), async (req, res) => {
  if (req.subscription?.owner) {
    return res.json({ balance: MONTHLY_CREDIT_USD, monthly: MONTHLY_CREDIT_USD, resetAt: null, unlimited: true });
  }
  const { balance, resetAt } = await getUserCredits(req.user.id);
  res.json({ balance, monthly: MONTHLY_CREDIT_USD, resetAt, unlimited: false });
});

// ── /api/analyse ──────────────────────────────────────────────────
app.post('/api/analyse', requirePlan('pro'), async (req, res) => {
  const { ssi, smc: smcPayloadFromBrain, maxTokens } = req.body;
  const resolvedMaxTokens = Math.min(Math.max(parseInt(maxTokens) || 1500, 300), 4096);

  const owner = !!req.subscription?.owner;
  let credits = { balance: MONTHLY_CREDIT_USD, resetAt: null };
  if (!owner) {
    credits = await getUserCredits(req.user.id);
    if (credits.balance <= 0) {
      return res.status(402).json({
        error: 'Out of analysis credits for this cycle',
        balance: 0,
        resetAt: credits.resetAt
      });
    }
  }

  const s   = getState(req.user.id);
  const cs  = getCandlesStore(req.user.id);
  const usc = getSmcStoreForUser(req.user.id); // this user's own SMC data, plain symbol-keyed

  const sym = s.symbol
    || Object.keys(cs)[0]
    || (Object.keys(s.livePatterns)[0] || '').split('_')[0]
    || Object.keys(usc)[0]
    || '';

  if (!sym) {
    return res.status(400).json({ error: 'No live data yet — make sure EA is running and sending data' });
  }
  console.log(`[ANALYSE] user=${req.user.id} active symbol resolved: ${sym}`);

  const updateData = {
    symbol:    sym,
    timeframe: s.timeframe,
    price:     s.candlesList?.length ? s.candlesList[s.candlesList.length - 1].c : 0,
    ...s.indicators,
    openTrades:  s.openTrades,
    accountInfo: s.accountInfo
  };

  const smcData = usc[sym]
    || usc[sym.replace('c','')]
    || Object.values(usc)[0]
    || {};

  const patKey      = Object.keys(s.livePatterns).find(k => k.startsWith(sym)) || Object.keys(s.livePatterns)[0] || '';
  const patternRaw  = s.livePatterns[patKey] || {};
  const filteredPatterns = buildFilteredPatternData(patternRaw);

  const candleData  = cs[sym] || Object.values(cs)[0] || {};
  const candleArr   = (candleData.candles || []).slice(-8);
  const candleSummary = candleArr.length
    ? candleArr.map((c, i) => {
        const dir  = c.close > c.open ? '▲' : '▼';
        const body = Math.abs(c.close - c.open).toFixed(2);
        const time = c.time ? new Date(c.time * 1000).toISOString().slice(11,16) : `bar${i}`;
        return `${time} ${dir} O:${parseFloat(c.open).toFixed(2)} H:${parseFloat(c.high).toFixed(2)} L:${parseFloat(c.low).toFixed(2)} C:${parseFloat(c.close).toFixed(2)} body:${body}`;
      }).join('\n')
    : 'No candle data available';

  const prompt = [
    `Live MT5 market data for ${sym} (${s.timeframe || 'unknown TF'}) — ${new Date().toUTCString()}:\n`,
    '=== SOURCE 1: Price + Indicators ===',
    JSON.stringify(updateData, null, 2),
    '\n=== SOURCE 2: SMC (Smart Money Concepts) ===',
    JSON.stringify(smcData, null, 2),
    '\n=== SOURCE 3: SSI Engine (Structure Signal Indicator) ===',
    JSON.stringify(ssi || {}, null, 2),
    '\n=== SOURCE 4: Recent M15 Candles (last 8 bars, all directions) ===',
    candleSummary,
    '\n=== SOURCE 5: Pattern Detector (pre-filtered) ===',
    JSON.stringify(filteredPatterns, null, 2),
    '\nAnalyse all sources and give your verdict.'
  ].join('\n');

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-haiku-4-5-20251001',
        max_tokens: resolvedMaxTokens,
        system: `You are an expert Forex, Gold and crypto market analyst. You work across all pairs — Forex (EURUSD, GBPUSD, USDJPY, USDCHF, GBPJPY), Gold (XAUUSD), and crypto (BTCUSD etc).

You receive data from 5 sources:
1. Price + Indicators — live price, RSI, EMA20/EMA50, bias_score, open trades
2. SMC — CHoCH, BOS, Order Blocks, FVGs, HTF bias
3. SSI Engine — signal codes +1/-1 (Structure+Trend), +2/-2 (Pattern+Trend), 0 (no signal); trendBuy/trendSell, session, momentum
4. Recent M15 Candles — last 8 bars (all directions, unfiltered raw view)
5. Pattern Detector — pre-filtered pattern data. Read the rules below carefully.

=== SOURCE 5 PATTERN RULES — follow exactly ===
1. RECENT PATTERNS ONLY: Only treat patterns in "recent_patterns" (bar_index 0–2) as valid signals.
2. CANDLE ALIGNMENT: "aligned_candles" contains only candles matching the current bias direction.
3. PATTERN-BIAS CONFLICT: If "pattern_bias_conflict" is true, lean toward NEUTRAL.
4. HARD GATE: If "has_recent_confirmation" is false, confidence must be Low.
5. S/R only: Use sr_levels for key levels.
=== END SOURCE 5 RULES ===

Structure your response as:
📊 MARKET STRUCTURE
📈 CONFLUENCE ANALYSIS
🎯 TRADE SETUP
⚠️ KEY RISK

IMPORTANT — finish with EXACTLY:
VERDICT: BULLISH
CONFIDENCE: Medium`,
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

    const text  = (response.data.content || []).map(c => c.text || '').join('');
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

    let remainingBalance = credits.balance;
    if (!owner) {
      const usage = response.data.usage || {};
      const inputTokens  = usage.input_tokens  || 0;
      const outputTokens = usage.output_tokens || 0;
      // claude-haiku-4-5: $1/M input tokens, $5/M output tokens
      const cost = (inputTokens / 1e6) * 1 + (outputTokens / 1e6) * 5;
      remainingBalance = await deductCredits(req.user.id, cost);
      console.log(`[CREDITS] user=${req.user.id} cost=$${cost.toFixed(4)} remaining=$${remainingBalance.toFixed(4)}`);
    }

    res.json({ ok: true, verdict: text, extractedVerdict: verdict, extractedConfidence: confidence, creditBalance: remainingBalance });

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
      newsEvents = events; broadcast(null, 'NEWS_UPDATE', events);
      console.log(`✓ Fetched ${events.length} HIGH impact events this week`); return;
    }
  } catch (e) { console.warn('This week fetch failed:', e.message); }

  try {
    const { data } = await axios.get('https://nfs.faireconomy.media/ff_calendar_nextweek.json', { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const events = mapEvents(data);
    newsEvents = events; broadcast(null, 'NEWS_UPDATE', events);
    console.log(`✓ Fetched ${events.length} HIGH impact events next week`);
  } catch (e) {
    console.warn('Next week fetch also failed:', e.message);
    newsEvents = getPlaceholderNews(); broadcast(null, 'NEWS_UPDATE', newsEvents);
  }
}

cron.schedule('* * * * *', () => {
  const now = Date.now() / 1000;
  newsEvents.forEach(e => {
    const mins = (e.timestamp - now) / 60;
    if (mins > 14 && mins <= 15) {
      const newsMsg = `⚡ <b>HIGH IMPACT NEWS</b>\n📰 ${e.title} (${e.country})\n⏰ Releasing in 15 minutes!\nForecast: ${e.forecast} · Previous: ${e.previous}`;
      sendTelegram(newsMsg);
      broadcastTelegramToUsers(newsMsg);
      broadcast(null, 'NEWS_ALERT', { message: `⚡ HIGH IMPACT: ${e.title} (${e.country}) in 15 minutes!`, event: e });
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

// ── Credit reset safety-net ─────────────────────────────────────────
// Paystack's charge.success resets credits on renewal, which covers
// monthly-pro users naturally. Yearly and lifetime users don't renew
// monthly though, so this daily sweep independently resets anyone
// whose credit_reset_at has passed, keeping everyone on a ~30-day cycle
// regardless of billing frequency.
async function resetDueCredits() {
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?credit_reset_at=lt.${new Date().toISOString()}&select=user_id`,
      { headers: supabaseServiceHeaders() }
    );
    for (const row of data || []) {
      await resetUserCredits(row.user_id);
      console.log(`[CREDITS] Safety-net reset for user=${row.user_id}`);
    }
  } catch (e) {
    console.error('[CREDITS] resetDueCredits sweep failed:', e.response?.data || e.message);
  }
}
cron.schedule('0 0 * * *', resetDueCredits); // once daily at midnight UTC

// ── Journal (Supabase-backed — works on Railway for every user) ───
const { insertTrade, getTradesForUser, getMostRecentAccount, getAccountsForUser } = require('./journal-store');

// ── Math Dashboard settings (Supabase-backed, same pattern as journal) ──
const { getSettingsForUser, saveSettingsForUser } = require('./settings-store');

app.post('/journal/trade', async (req, res) => {
  const trade = req.body;
  if (!trade || !trade.ticket || !trade.symbol) return res.status(400).json({ error: 'Invalid trade payload' });
  if (!trade.licenceKey) return res.status(401).json({ error: 'Missing licence key' });
  if (!trade.accountNumber) return res.status(400).json({ error: 'Missing account number' });

  try {
    const userId = await getUserIdForLicenceKey(trade.licenceKey);
    if (!userId) return res.status(401).json({ error: 'Invalid licence key' });

    console.log(`[JOURNAL] acct=${trade.accountNumber} ${trade.symbol} ${trade.direction} | P/L: $${trade.totalPL} | Ticket: ${trade.ticket}`);
    const row = await insertTrade(trade, userId);
    broadcast(userId, 'journal_update', { ticket: trade.ticket, accountNumber: trade.accountNumber, symbol: trade.symbol, direction: trade.direction, totalPL: trade.totalPL, closeTime: trade.closeTime });

    const plIcon = (trade.totalPL || 0) >= 0 ? '🟢' : '🔴';
    sendTelegramToUser(
      userId,
      `${plIcon} <b>Trade Closed</b>\n` +
      `${trade.symbol} ${trade.direction} · ${trade.volume} lots\n` +
      `P&amp;L: $${Number(trade.totalPL).toFixed(2)} (${trade.pips} pips)`
    );
    res.status(201).json({ success: true, row });
  } catch (err) {
    console.error('[JOURNAL ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Used by the Pro dashboard's Trading Journal table. Auto-focuses on
// whichever MT5 account most recently sent a trade, so switching
// accounts in MT5 is reflected here without any manual action —
// pass ?account=<number> to explicitly view a different one instead.
app.get('/api/journal', requirePlan('pro'), async (req, res) => {
  try {
    let accountNumber = req.query.account ? Number(req.query.account) : null;
    let activeAccount = null;

    if (!accountNumber) {
      activeAccount = await getMostRecentAccount(req.user.id);
      accountNumber = activeAccount ? activeAccount.account_number : null;
    }

    const [entries, accounts] = await Promise.all([
      getTradesForUser(req.user.id, { accountNumber }),
      getAccountsForUser(req.user.id),
    ]);

    res.json({ entries, accountNumber, accounts });
  } catch (err) {
    console.error('[JOURNAL ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// MATH DASHBOARD ROUTES
// ════════════════════════════════════════════════════════════════

// Storage: keyed by (userId, accountNumber) — same model journal-store.js
// already uses successfully (unique(user_id, account_number, ticket), never
// wiped, just switch which account is "current"). Each real MT5 account
// number gets its own permanent bucket; nothing is ever deleted when you
// switch accounts — the dashboard just starts pointing at a different
// bucket. This replaces the earlier "does this look like an account
// switch, if so wipe everything" heuristic, which was fragile and could
// silently keep merging two accounts' trades when the heuristic didn't
// fire (exactly what happened with the math-trades history mixing bug).
const USER_DATA_DIR = path.join(__dirname, 'user_data');
try { if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true }); } catch(e) {}

function safeAcct(accountNumber) { return String(accountNumber || 'unknown').replace(/[^a-zA-Z0-9_-]/g, ''); }

function mathTradesFilePath(userId, accountNumber) {
  return path.join(USER_DATA_DIR, `math_trades_${userId}_${safeAcct(accountNumber)}.json`);
}
function openSnapshotFilePath(userId, accountNumber) {
  return path.join(USER_DATA_DIR, `open_trade_snapshots_${userId}_${safeAcct(accountNumber)}.json`);
}
function currentAccountFilePath(userId) {
  return path.join(USER_DATA_DIR, `math_current_account_${userId}.json`);
}

// Which account's bucket should the dashboard show right now? Whichever
// account most recently sent math-trades data — set on every POST,
// mirroring journal-store's getMostRecentAccount(), just cached to a
// small pointer file instead of a Supabase query.
function getCurrentAccountForUser(userId) {
  try {
    const f = currentAccountFilePath(userId);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')).accountNumber || null;
  } catch(e) {}
  return null;
}
function setCurrentAccountForUser(userId, accountNumber) {
  try {
    fs.writeFileSync(currentAccountFilePath(userId), JSON.stringify({ accountNumber: String(accountNumber), updated_at: new Date().toISOString() }));
  } catch(e) {}
}

const snapshotsByKey = {};
function snapKey(userId, accountNumber) { return `${userId}::${safeAcct(accountNumber)}`; }
function getOpenSnapshots(userId, accountNumber) {
  const key = snapKey(userId, accountNumber);
  if (!snapshotsByKey[key]) {
    let loaded = {};
    try {
      const f = openSnapshotFilePath(userId, accountNumber);
      if (fs.existsSync(f)) {
        loaded = JSON.parse(fs.readFileSync(f, 'utf8'));
        console.log(`[MATH] user=${userId} account=${accountNumber} loaded ${Object.keys(loaded).length} open trade snapshots`);
      }
    } catch(e) {}
    snapshotsByKey[key] = loaded;
  }
  return snapshotsByKey[key];
}
function setOpenSnapshots(userId, accountNumber, obj) { snapshotsByKey[snapKey(userId, accountNumber)] = obj; }
function saveOpenSnapshots(userId, accountNumber) {
  try { fs.writeFileSync(openSnapshotFilePath(userId, accountNumber), JSON.stringify(getOpenSnapshots(userId, accountNumber), null, 2)); } catch(e) {}
}

function loadMathTrades(userId, accountNumber) {
  try {
    const f = mathTradesFilePath(userId, accountNumber);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { console.error(`[MATH] user=${userId} account=${accountNumber} load error:`, e.message); }
  return { account: {}, closed_trades: [], open_trades: [], stats: {}, last_update: null };
}

function saveMathTrades(userId, accountNumber, data) {
  const target = mathTradesFilePath(userId, accountNumber);
  const tmp    = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

function computeR(trade) {
  try {
    const open   = parseFloat(trade.open_price  || 0);
    const close  = parseFloat(trade.close_price || 0);
    const sl     = parseFloat(trade.sl          || 0);
    const profit = parseFloat(trade.profit      || 0);
    const type   = (trade.type || trade.action  || '').toUpperCase();

    if (sl && open && close) {
      const riskPips = Math.abs(open - sl);
      const gainPips = (type === 'BUY') ? (close - open) : (open - close);
      if (riskPips > 0) return parseFloat((gainPips / riskPips).toFixed(3));
    }
    const pips = parseFloat(trade.pips || 0);
    if (pips !== 0) return parseFloat((pips / 30).toFixed(3));
    const riskAmt = parseFloat(trade.risk_amount || 100);
    if (profit !== 0 && riskAmt > 0) return parseFloat((profit / riskAmt).toFixed(3));
    return null;
  } catch(e) { return null; }
}

function recalcMathStats(closed) {
  if (!closed || closed.length === 0) return {};
  const wins    = closed.filter(t => t.profit > 0);
  const losses  = closed.filter(t => t.profit <= 0);
  const winRate = closed.length > 0 ? wins.length / closed.length : 0;

  const rVals    = closed.map(t => t.r_multiple).filter(r => r !== null && r !== undefined);
  const winRs    = rVals.filter(r => r > 0);
  const lossRs   = rVals.filter(r => r <= 0);
  const avgWinR  = winRs.length  > 0 ? winRs.reduce((s,r)=>s+r,0)/winRs.length   : 0;
  const avgLossR = lossRs.length > 0 ? Math.abs(lossRs.reduce((s,r)=>s+r,0)/lossRs.length) : 0;

  const totalProfit  = closed.reduce((s,t) => s + (t.profit||0), 0);
  const now = Date.now();
  const dayMs  = 86400000, weekMs = 7 * dayMs;
  const dailyProfit  = closed.filter(t => now - new Date(t.close_time).getTime() < dayMs).reduce((s,t)=>s+(t.profit||0),0);
  const weeklyProfit = closed.filter(t => now - new Date(t.close_time).getTime() < weekMs).reduce((s,t)=>s+(t.profit||0),0);

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

function normaliseAccount(a) {
  if (!a) return {};
  return {
    balance:      parseFloat(a.balance     || a.account_balance  || 0),
    equity:       parseFloat(a.equity      || a.account_equity   || 0),
    margin:       parseFloat(a.margin      || a.account_margin   || 0),
    free_margin:  parseFloat(a.freeMargin  || a.free_margin      || a.account_free_margin || 0),
    margin_level: parseFloat(a.margin_level || 0),
    currency:     a.currency  || a.account_currency  || 'USD',
    leverage:     a.leverage  || a.account_leverage  || 0,
    profit:       parseFloat(a.profit      || a.account_profit   || 0),
    server:       a.server    || a.account_server    || '',
    login:        String(a.login || a.account_login || a.accountLogin || a.account || ''),
    risk_amount:  parseFloat(a.risk_amount || 0)
  };
}

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

function normaliseClosedTrade(userId, accountNumber, t, idx) {
  if (!t) return null;
  const open_price  = parseFloat(t.open_price  || t.openPrice  || t.entry_price || t.open  || 0) || null;
  const close_price = parseFloat(t.close_price || t.closePrice || t.exit_price  || t.close || 0) || null;
  const sl          = parseFloat(t.sl          || t.stopLoss   || t.stop_loss   || 0);
  const tp          = parseFloat(t.tp          || t.takeProfit || t.take_profit || 0);
  const lots        = parseFloat(t.lots        || t.volume     || t.vol         || 0);

  let rawType = String(t.type || t.action || t.direction || t.trade_type || '').toUpperCase().trim();
  if (rawType === '0') rawType = 'BUY';
  if (rawType === '1') rawType = 'SELL';
  if (rawType === 'BUY_STOP'  || rawType === 'BUY_LIMIT')  rawType = 'BUY';
  if (rawType === 'SELL_STOP' || rawType === 'SELL_LIMIT') rawType = 'SELL';
  let type_corrected = false;
  if (t._source === 'bridge') {
    if      (rawType === 'BUY')  { rawType = 'SELL'; type_corrected = true; }
    else if (rawType === 'SELL') { rawType = 'BUY';  type_corrected = true; }
  }
  const type   = rawType || '—';
  const profit = parseFloat(t.profit || t.net_profit || 0);
  const pips   = t.pips != null ? parseFloat(t.pips) : null;

  const rawCloseTime = t.close_time || t.closeTime || t.exit_time || t.time || '';
  const close_time   = rawCloseTime
    ? (String(rawCloseTime).length <= 10
        ? new Date(parseInt(rawCloseTime) * 1000).toISOString()
        : String(rawCloseTime))
    : '';
  const rawOpenTime = t.open_time || t.openTime || t.entry_time || '';
  const open_time   = rawOpenTime
    ? (String(rawOpenTime).length <= 10
        ? new Date(parseInt(rawOpenTime) * 1000).toISOString()
        : String(rawOpenTime))
    : '';
  const ticket = t.ticket || t.position_id || t.id || (idx + 1);

  let enriched_open  = (open_price  && open_price  !== 0) ? open_price  : null;
  let enriched_close = (close_price && close_price !== 0) ? close_price : null;
  let enriched_sl    = sl;
  let enriched_tp    = tp;
  let enriched_lots  = (lots && lots > 0) ? lots : null;
  let enriched_type  = (type && type !== '—') ? type : null;
  let enriched_flag  = false;

  const snap = getOpenSnapshots(userId, accountNumber)[String(ticket)];
  if (snap) {
    if (!enriched_open  && snap.open_price > 0) { enriched_open  = snap.open_price; enriched_flag = true; }
    if (!enriched_sl    && snap.sl         > 0)   enriched_sl    = snap.sl;
    if (!enriched_tp    && snap.tp         > 0)   enriched_tp    = snap.tp;
    if (!enriched_lots  && snap.lots       > 0)   enriched_lots  = snap.lots;
    if (!enriched_type  && snap.type)             enriched_type  = snap.type;
  }

  const symUpper = String(t.symbol || '').toUpperCase();
  let pipSize = 0.0001;
  if (symUpper.includes('JPY'))                                      pipSize = 0.01;
  else if (symUpper.includes('XAU') || symUpper.includes('GOLD'))   pipSize = 0.1;
  else if (symUpper.includes('BTC') || symUpper.includes('ETH'))    pipSize = 1.0;
  else if (symUpper.includes('XAG') || symUpper.includes('SILVER')) pipSize = 0.01;

  const effectiveLots = enriched_lots || 1.0;
  const effectiveType = enriched_type || type || 'BUY';

  if (!enriched_close && enriched_open && pips != null && pips !== 0) {
    enriched_close = effectiveType === 'BUY'
      ? enriched_open + (pips * pipSize)
      : enriched_open - (pips * pipSize);
    enriched_close = parseFloat(enriched_close.toFixed(symUpper.includes('JPY') ? 3 : symUpper.includes('XAU') ? 2 : 5));
    enriched_flag  = true;
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
    symbol:      t.symbol         || '—',
    type:        enriched_type    || type || '—',
    lots:        enriched_lots    || lots || 0,
    open_price:  enriched_open    || null,
    close_price: enriched_close   || null,
    sl:          enriched_sl      || 0,
    tp:          enriched_tp      || 0,
    profit, pips,
    gross_profit:    parseFloat(t.gross_profit || profit),
    commission:      parseFloat(t.commission   || 0),
    swap:            parseFloat(t.swap         || 0),
    close_time, open_time,
    r_multiple, r_method,
    _source:         t._source || 'math_reporter',
    _type_corrected: type_corrected,
    _enriched:       enriched_flag
  };
}

app.post('/api/math-trades', async (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.status(400).json({ error: 'No body' });

    const userId = await getUserIdForLicenceKey(body.licenceKey);
    if (!userId) {
      console.warn('[MATH] Rejected — no valid licenceKey. Update MathReporter.mq5 to v1.4+ and paste a valid licence key.');
      return res.status(401).json({ error: 'Missing or invalid licenceKey' });
    }

    const accountNumber = body.account && body.account.login ? String(body.account.login) : null;
    if (!accountNumber) {
      console.warn(`[MATH] user=${userId} rejected — no account.login in payload, can't bucket this data safely.`);
      return res.status(400).json({ error: 'account.login required' });
    }

    // Bucketed by (userId, accountNumber) — same permanent-per-account
    // model as journal-store.js. No "does this look like a switch"
    // heuristic anymore: this account's own history just lives in its
    // own file, forever, and never gets touched by any other account's
    // data. Switching accounts just means the "current account" pointer
    // (set below) starts pointing somewhere else — nothing is wiped.
    const existing        = loadMathTrades(userId, accountNumber);
    const existingTickets = new Set((existing.closed_trades || []).map(t => String(t.ticket)));

    const incoming  = (body.closed_trades || [])
      .map((t, i) => normaliseClosedTrade(userId, accountNumber, t, i))
      .filter(t => t !== null);
    const newTrades = incoming.filter(t => !existingTickets.has(String(t.ticket)));
    const allClosed = [...(existing.closed_trades || []), ...newTrades]
      .sort((a, b) => new Date(a.close_time) - new Date(b.close_time));

    const data = {
      account:       normaliseAccount(body.account),
      open_trades:   (body.open_trades || []).map(normaliseOpenTrade),
      closed_trades: allClosed,
      stats:         recalcMathStats(allClosed),
      last_update:   new Date().toISOString()
    };
    saveMathTrades(userId, accountNumber, data);
    setCurrentAccountForUser(userId, accountNumber);
    console.log(`[MATH] user=${userId} account=${accountNumber} received: ${allClosed.length} total closed, ${newTrades.length} new, ${(body.open_trades||[]).length} open`);
    res.set('Access-Control-Allow-Origin', '*');
    res.json({ ok: true, closed: allClosed.length, new_trades: newTrades.length, account: accountNumber });
  } catch(e) {
    console.error('[MATH] POST error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/math-data', requirePlan('pro'), (req, res) => {
  try {
    const userId = req.user.id;
    const accountNumber = getCurrentAccountForUser(userId);
    const math   = accountNumber ? loadMathTrades(userId, accountNumber) : { account: {}, closed_trades: [], open_trades: [], stats: {}, last_update: null };
    const st     = getState(userId);

    const liveAccount = (st.accountInfo && st.accountInfo.balance)
      ? normaliseAccount(st.accountInfo)
      : (math.account || {});

    // The live feed (main EA) never includes float_r at all — only
    // MathReporter's feed does. Previously, whenever the live feed had
    // any open trades, it was used exclusively and float_r was silently
    // lost even when MathReporter had it. Now we take the live feed as
    // the base (it's more current) but backfill float_r by ticket from
    // MathReporter's feed when the live entry is missing it.
    const mathOpenByTicket = {};
    (math.open_trades || []).forEach(t => { if (t && t.ticket) mathOpenByTicket[String(t.ticket)] = t; });

    const liveOpen = (st.openTrades && st.openTrades.length > 0)
      ? st.openTrades.map(t => {
          const n = normaliseOpenTrade(t);
          if (n.float_r == null) {
            const match = mathOpenByTicket[String(n.ticket)];
            if (match && match.float_r != null) n.float_r = parseFloat(match.float_r);
          }
          return n;
        })
      : (math.open_trades || []).map(normaliseOpenTrade);

    let mathClosed   = math.closed_trades || [];
    let bridgeClosed = (st.closedTrades || []).map((t, i) => normaliseClosedTrade(userId, accountNumber, {
      ...t,
      open_price:  t.openPrice  || t.open_price  || null,
      close_price: t.closePrice || t.close_price || null,
      _source:     'bridge'
    }, i)).filter(t => t !== null);

    let closedTrades, stats, dataSource;

    if (mathClosed.length > 0) {
      const mathByTicket = {};
      mathClosed.forEach(t => {
        if (!t.open_price || t.open_price === 0) {
          const re = normaliseClosedTrade(userId, accountNumber, { ...t }, 0);
          mathByTicket[String(t.ticket)] = (re && re.ticket) ? re : t;
        } else {
          mathByTicket[String(t.ticket)] = t;
        }
      });

      bridgeClosed.forEach(b => {
        const key = String(b.ticket);
        if (mathByTicket[key]) {
          if (!mathByTicket[key].profit    && b.profit)      mathByTicket[key].profit      = b.profit;
          if (!mathByTicket[key].open_price  && b.open_price)  mathByTicket[key].open_price  = b.open_price;
          if (!mathByTicket[key].close_price && b.close_price) mathByTicket[key].close_price = b.close_price;
          if (!mathByTicket[key].pips        && b.pips)        mathByTicket[key].pips        = b.pips;
        } else {
          mathByTicket[key] = b;
        }
      });

      closedTrades = Object.values(mathByTicket)
        .sort((a, b) => new Date(a.close_time || 0) - new Date(b.close_time || 0));
      stats        = recalcMathStats(closedTrades);
      dataSource   = 'math_reporter';

    } else if (bridgeClosed.length > 0) {
      closedTrades = bridgeClosed;
      stats        = recalcMathStats(closedTrades);
      dataSource   = 'bridge';

    } else {
      closedTrades = [];
      stats        = {};
      dataSource   = 'none';
    }

    // agent_session.json is still single-account (agent-module.js hasn't
    // been rebuilt as multi-tenant yet — deliberately deferred, see earlier
    // discussion). Only show agent-derived data to whichever account the
    // agent is actually currently wired to, so other users don't see
    // someone else's agent activity mislabeled as their own.
    const agentDataAppliesToThisUser = (userId === primaryUserId);

    if (closedTrades.length === 0 && agentDataAppliesToThisUser) {
      try {
        const sessionFile = path.join(__dirname, 'agent_session.json');
        if (fs.existsSync(sessionFile)) {
          const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
          const orders  = (session.executed_orders || []).filter(o => o.profit !== undefined);
          if (orders.length > 0) {
            closedTrades = orders.map((o, i) => normaliseClosedTrade(userId, accountNumber, { ...o, type: o.action || o.type, _source: 'agent_session' }, i)).filter(t => t !== null);
            stats      = recalcMathStats(closedTrades);
            dataSource = 'agent_session';
          }
        }
      } catch(e) {}
    }

    let agentData = {};
    if (agentDataAppliesToThisUser) {
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
    }

    res.set('Access-Control-Allow-Origin', '*');
    res.json({
      account:        liveAccount,
      account_number: accountNumber,
      open_trades:    liveOpen,
      closed_trades:  closedTrades,
      stats,
      agent:          agentData,
      data_source:    dataSource,
      last_update:    math.last_update || new Date().toISOString(),
      server_time:    new Date().toISOString()
    });
  } catch(e) {
    console.error('[MATH] GET error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/math-trades/reset', requirePlan('pro'), (req, res) => {
  try {
    const accountNumber = getCurrentAccountForUser(req.user.id);
    if (!accountNumber) return res.json({ ok: true, message: 'No account data to clear' });
    saveMathTrades(req.user.id, accountNumber, { account: {}, closed_trades: [], open_trades: [], stats: {}, last_update: new Date().toISOString() });
    setOpenSnapshots(req.user.id, accountNumber, {});
    saveOpenSnapshots(req.user.id, accountNumber);
    res.json({ ok: true, message: `Math trade history cleared for account ${accountNumber}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Math Dashboard settings — ties Tools 01/02/03/06 to the logged-in
// account so they follow the user across devices/browsers. Same gate as
// /math itself (requirePlan('pro')), since these settings only matter to
// someone who can actually reach the dashboard. Frontend calls these with
// credentials:'include' and falls back to localStorage-only if either
// route 401s or is unreachable — no behavior change for anyone until this
// ships.
app.get('/api/settings', requirePlan('pro'), async (req, res) => {
  try {
    const settings = await getSettingsForUser(req.user.id);
    res.json({ settings });
  } catch (err) {
    console.error('[SETTINGS] GET error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', requirePlan('pro'), async (req, res) => {
  try {
    const { settings } = req.body || {};
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'settings object required' });
    }
    await saveSettingsForUser(req.user.id, settings);
    res.json({ ok: true });
  } catch (err) {
    console.error('[SETTINGS] POST error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// END MATH DASHBOARD ROUTES
// ════════════════════════════════════════════════════════════════

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
  ║   Pro Dashboard     : /dashboard (pro only)      ║
  ║   Auth API          : /api/me + /api/validate-key ║
  ║   Paystack          : /api/pay/* routes           ║
  ║   Email (Resend)    : Auto-sent on payment        ║
  ╚══════════════════════════════════════════════════╝
  `);
  startAgentLoop(() => getState(primaryUserId), livePrimarySmcView, getCandlesStore(primaryUserId));
});
