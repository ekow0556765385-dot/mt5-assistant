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
// ── CORS — explicit whitelist instead of wide-open '*' ──────────────
// The marketing site (blackwoodmt5.com) calls this backend
// (app.blackwoodmt5.com) cross-origin for /api/quotes, /api/contact,
// and /api/pay/initiate. A bare cors() (no options) reflects '*' for
// every origin on the internet, which is looser than this app needs
// given it also handles payments and auth. Locking it to a known list
// still fixes any genuine CORS block and is safer.
const ALLOWED_ORIGINS = [
  'https://blackwoodmt5.com',
  'https://www.blackwoodmt5.com',
  'https://app.blackwoodmt5.com',
];
// ── Admin console ─────────────────────────────────────────────
// Mounted BEFORE cors on purpose. The admin console is same-origin only,
// so it needs no CORS handling — and the allow-list below THROWS on an
// unrecognised origin, which Express turns into a bare 500. Browsers send
// `Origin: null` on some form posts, so routing the login through that
// allow-list made sign-in fail with an unexplained Internal Server Error.
// The router carries its own body parsers, so mounting it early is safe.
//
// Security is unchanged: every /admin route still goes through
// requireAdmin, with its own cookie (bw-admin) and no fallthrough to
// requireAuth or the owner bypass.
const adminRoute = require('./admin-route');
app.use('/admin', adminRoute);

app.use(require('cors')({
  origin: (origin, callback) => {
    // Allow non-browser requests (curl, server-to-server, the EA itself)
    // which send no Origin header at all.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    console.warn('[CORS] Blocked request from origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
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
const { requirePlan, requireFramedByDashboard, requireAuth, getMe, validateKey, regenerateKey, setBrokerType, cancelSubscription, issueTicketRoute, isOwner, getUserCredits, deductCredits, resetUserCredits, accessState, MONTHLY_CREDIT_USD, SUPABASE_URL, supabaseServiceHeaders, verifyAppSession, getUserIdForLicenceKey, resolveLicenceKey, getSourceForLicenceKey } = require('./auth-middleware');

// ── Paystack payment routes ────────────────────────────────────
const paystackRoute = require('./paystack-route');
app.use(paystackRoute);

// ── In-app notices ────────────────────────────────────────────
// User-facing half of the admin messages feature. Mounted here with the
// other /api routes so normal CORS applies — unlike /admin, which is
// same-origin only and sits ahead of the allow-list.
// requireAuth, not requirePlan: a free user needs to see "your access is
// suspended" as much as a Pro user does.
const noticesRoute = require('./notices-route');
app.use(noticesRoute);

// ── Usage heartbeat ───────────────────────────────────────────
// The shell beats every 30s while its tab is VISIBLE, so a forgotten
// tab does not log eight hours. Batched in memory, flushed once a
// minute. This data cannot be backfilled — every day without it is lost.
const usageRoute = require('./usage-route');
app.use(usageRoute);

// ── Diagnostics ───────────────────────────────────────────────
// Collects errors from users' browsers. Deliberately NOT behind
// requireAuth: the most valuable report is from a page that failed
// before the user was authenticated. Rate-limited per IP instead.
const diagnosticsRoute = require('./diagnostics-route');
app.use(diagnosticsRoute);
// Served unauthenticated on purpose — it must load on the sign-in page
// and on any page that failed before auth.
app.get('/bw-error-reporter.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(require('path').join(__dirname, 'bw-error-reporter.js'));
});

// ── Telegram config ───────────────────────────────────────────────
// Bot credentials live in telegram-config.js so app.js and smc-route.js can
// never drift onto different bots again (they had — smc-route was still on
// the decommissioned one). Override via TELEGRAM_BOT_TOKEN in production.
const { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID } = require('./telegram-config');
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
// requireAuth, not requirePlan('pro'): Telegram confluence alerts are a FREE
// tier benefit. Gating this to Pro meant a free user could never connect the
// chat their main benefit is delivered to.
app.get('/api/telegram/link', requireAuth, async (req, res) => {
  try {
    const code = await createLinkCode(req.user.id);
    res.json({ code, deepLink: `https://t.me/Blackwood_Alerts_bot?start=${code}` });
  } catch (err) {
    console.error('[TELEGRAM LINK ERROR]', err.message);
    res.status(500).json({ error: 'Could not generate link code' });
  }
});

// GET /api/telegram/status — dashboard polls this to show connected/not
app.get('/api/telegram/status', requireAuth, async (req, res) => {
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
// ── /health — unauthenticated, for external uptime pingers only ────
// Point UptimeRobot/cron-job.org/etc. at this, every 5 min, to stop
// Railway from sleeping the app between trading sessions. Deliberately
// no requirePlan('pro') gate here — an external pinger has no session
// cookie to send, so an authenticated route would just 401 instead of
// actually keeping the container warm.
app.get('/health', (req, res) => res.status(200).json({ ok: true, ts: new Date().toISOString() }));

// ── /api/quotes ───────────────────────────────────────────────────
// Public, unauthenticated, read-only — feeds the marketing site's
// price ticker. Deliberately has no requirePlan gate. Serves whatever
// is in the in-memory quoteCache, populated by /api/update above.
app.get('/api/quotes', (req, res) => {
  // Demand-driven refresh: a visitor asking for quotes is what triggers a
  // (rate-limited, budget-capped) upstream fetch. Fire-and-forget so the
  // response is never delayed by it - this request serves the cache and the
  // NEXT one gets the fresher numbers.
  if (typeof fetchExternalQuotes === 'function') {
    Promise.resolve(fetchExternalQuotes('visitor')).catch(() => {});
  }

  // Was 5 minutes, which is SHORTER than the refresh interval - every quote
  // would have aged out before the next refresh and the ticker would fall
  // back to static demo numbers. A real price from earlier today beats an
  // invented one, so the window is wide; `ageMs` is included so the client
  // can decide for itself.
  const STALE_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const quotes = TICKER_SYMBOLS
    .map(sym => quoteCache[sym])
    .filter(q => q && (now - q.updatedAt) < STALE_MS)
    .map(q => Object.assign({}, q, { ageMs: now - q.updatedAt }));
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ quotes, serverTime: now });
});

// ── /api/contact ─────────────────────────────────────────────────
// Public, unauthenticated — receives submissions from the marketing
// site's "Send a message" form and emails them via Resend, same as
// the other transactional emails (welcome, licence key, etc).
const CONTACT_TOPICS = new Set([
  'Platform access / licence key',
  'Technical support',
  'Billing / subscription',
  'Prop firm account guidance',
  'Partnership enquiry',
  'Other',
]);

app.post('/api/contact', async (req, res) => {
  try {
    const { firstName, lastName, email, topic, message } = req.body || {};

    if (!email || !message || !String(message).trim()) {
      return res.status(400).json({ error: 'Email and message are required.' });
    }
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
    if (!emailOk) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const safeTopic = CONTACT_TOPICS.has(topic) ? topic : 'General enquiry';
    const name = [firstName, lastName].filter(Boolean).join(' ').trim() || 'Website visitor';

    await axios.post(
      'https://api.resend.com/emails',
      {
        from: 'Blackwood Website <website@blackwoodmt5.com>',
        to: ['hello@blackwoodmt5.com'],
        reply_to: email,
        subject: `[Contact form] ${safeTopic} — ${name}`,
        text: `From: ${name} <${email}>\nTopic: ${safeTopic}\n\n${message}`,
      },
      { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Contact form send failed:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to send message. Please email us directly at hello@blackwoodmt5.com.' });
  }
});

// Shared feed switcher, pulled in by every dashboard. No plan gate: it is
// static JS with no data in it, and gating it would break the page for a
// user whose session is mid-refresh.
app.get('/bw-source.js', (req, res) => res.sendFile(path.join(__dirname, 'bw-source.js')));

// Module pages: requireFramedByDashboard runs BEFORE requirePlan, so the
// "must be opened inside the dashboard" rule applies to everyone -
// including the owner, whose plan bypass would otherwise make the most
// privileged account the one way in. /dashboard itself is deliberately NOT
// gated: it is the top-level page that does the framing.

app.get('/',           requireFramedByDashboard, requirePlan('pro'), (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/smc-panel',  requireFramedByDashboard, requirePlan('pro'), (req, res) => res.sendFile(path.join(__dirname, 'smc-panel.html')));
app.get('/patterns',   requireFramedByDashboard, requirePlan('pro'), (req, res) => res.sendFile(path.join(__dirname, 'patterns.html')));
app.get('/brain',      requireFramedByDashboard, requirePlan('pro'), (req, res) => res.sendFile(path.join(__dirname, 'mt5_trading_brain_v5.html')));
app.get('/agent',      requireFramedByDashboard, requirePlan('pro'), (req, res) => res.sendFile(path.join(__dirname, 'agent-dashboard.html')));
app.get('/math',       requireFramedByDashboard, requirePlan('pro'), (req, res) => res.sendFile(path.join(__dirname, 'blackwood_math_dashboard_v2.html')));

// ── Pro subscriber unified dashboard portal ───────────────────────
// Protected — requires active Pro or Lifetime subscription
app.get('/dashboard', requirePlan('pro'), (req, res) => res.sendFile(path.join(__dirname, 'blackwood_dashboard.html')));

// ── /account — optional fallback only ─────────────────────────────
// account.html normally lives on NETLIFY, alongside the favicons and the
// legal pages it references with root-relative paths. The clean /account
// URL is produced there by a rewrite rule in the _redirects file, not by
// this route. Auth is a Bearer token from sessionStorage, so the page
// works fine cross-origin — there was never a cookie problem to solve by
// moving it. This route only responds if someone has also dropped a copy
// of account.html next to app.js; otherwise it stays out of the way.
app.get('/account', (req, res, next) => {
  const local = path.join(__dirname, 'account.html');
  if (!fs.existsSync(local)) return next();
  res.sendFile(local);
});

// ── Auth API routes ───────────────────────────────────────────────
app.get('/api/me',           getMe);
app.post('/api/ticket',      issueTicketRoute);
app.post('/api/validate-key', validateKey);
app.post('/api/regenerate-key', requireAuth, regenerateKey);
app.post('/api/set-broker-type', requireAuth, setBrokerType);

// ── /api/downloads — gated file delivery for Pro subscribers ──────
// Requires a PRIVATE Supabase Storage bucket named "downloads" containing
// the compiled .ex5 files, bridge watcher, and PDF guides at the paths below.
// NEVER upload .mq5 source files — only compiled .ex5 builds.
const DOWNLOAD_CATALOG = [
  { id: 'ea',               name: 'Blackwood MT5 Assistant (EA)',       path: 'ea/Mt5_tradingassistant_v3.91.ex5',             audience: 'all'    },
  { id: 'structure',        name: 'Structure Signal Indicator',         path: 'indicators/StructureSignal2.ex5',               audience: 'all'    },
  { id: 'smc',              name: 'Smart Money Concepts Indicator',     path: 'indicators/SmartMoneyConceptsIndicator.ex5',    audience: 'all'    },
  { id: 'patterns',         name: 'Pattern Detector v4',                path: 'indicators/PatternDetector_v4.ex5',             audience: 'all'    },
  { id: 'candles',          name: 'Candle Pattern Indicator',           path: 'indicators/CandlePatternIndicator.ex5',         audience: 'all'    },
  { id: 'journal',          name: 'Journal Reporter (EA)',              path: 'ea/JournalReporter.ex5',                        audience: 'all'    },
  { id: 'math',             name: 'Math Reporter (EA)',                 path: 'ea/MathReporter.ex5',                           audience: 'all'    },
  // aliases: other filenames this entry will accept. The bridge was renamed
  // from mt5_bridge_watcher.exe to BlackwoodBridge.exe, and whichever is in
  // the bucket should serve without a code change either way.
  { id: 'bridge-watcher',   name: 'Blackwood Bridge',                  path: 'BlackwoodBridge.exe',                    audience: 'exness',
    aliases: ['mt5_bridge_watcher.exe','blackwood-bridge.exe','BlackwoodBridge.exe','bridge/BlackwoodBridge.exe','bridge/mt5_bridge_watcher.exe'] },
  { id: 'setup-guide',      name: 'Setup Guide',                       path: 'setup-guide.pdf',                          audience: 'all',
    aliases: ['docs/setup-guide.pdf','guides/setup-guide.pdf','Setup-Guide.pdf','setup guide.pdf'] },
  { id: 'dashboard-guide',  name: 'Dashboard Guide',                   path: 'dashboard-guide.pdf',                      audience: 'all',
    aliases: ['docs/dashboard-guide.pdf','guides/dashboard-guide.pdf','Dashboard-Guide.pdf','dashboard guide.pdf'] },
];

// GET /api/downloads — return catalog filtered to this user's broker type.
// Frontend uses this to render the button list; no file content yet.
app.get('/api/downloads', requireAuth, requirePlan('pro'), async (req, res) => {
  try {
    const { data: subRows } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${req.user.id}&select=broker_type`,
      { headers: supabaseServiceHeaders() }
    );
    const brokerType = subRows?.[0]?.broker_type || null;
    const files = DOWNLOAD_CATALOG
      .filter(f => f.audience === 'all' || f.audience === brokerType)
      .map(({ id, name, audience }) => ({ id, name, audience }));
    res.json({ files, broker_type: brokerType });
  } catch (e) {
    console.error('[DOWNLOADS] catalog error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/downloads/_diagnose — owner-only. Reports, for every catalog
// entry, whether the exact path exists in the bucket and what the folder
// actually contains. Use this instead of clicking ten buttons to find out
// which files were never uploaded or were renamed by a version bump.
app.get('/api/downloads/_diagnose', requireAuth, async (req, res) => {
  if (!req.subscription?.owner) return res.status(403).json({ error: 'Owner only' });
  const out = [];
  for (const entry of DOWNLOAD_CATALOG) {
    const folder = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
    let exists = false, folderFiles = [];
    try {
      await axios.head(`${SUPABASE_URL}/storage/v1/object/downloads/${entry.path}`,
                       { headers: supabaseServiceHeaders() });
      exists = true;
    } catch (e) { exists = false; }
    try {
      const { data: listing } = await axios.post(
        `${SUPABASE_URL}/storage/v1/object/list/downloads`,
        { prefix: folder, limit: 200 },
        { headers: supabaseServiceHeaders({ 'Content-Type': 'application/json' }) }
      );
      folderFiles = (listing || []).map(o => o.name);
    } catch (e) { folderFiles = ['<list failed: ' + (e.response?.status || e.message) + '>']; }
    out.push({ id: entry.id, expected: entry.path, exists, folder, folderContains: folderFiles });
  }
  const missing = out.filter(o => !o.exists).map(o => o.id);
  res.json({ missingIds: missing, totalMissing: missing.length, detail: out });
});

// GET /api/downloads/:id — mint a 5-minute signed URL for one file.
// Live subscription check on every click — downgrade takes effect instantly.
app.get('/api/downloads/:id', requireAuth, async (req, res) => {
  const entry = DOWNLOAD_CATALOG.find(f => f.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Unknown file' });

  try {
    // Live plan check — NOT from JWT/session, always from Supabase
    const { data: subRows } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${req.user.id}&select=plan,status,broker_type`,
      { headers: supabaseServiceHeaders() }
    );
    // BUGFIX: this used to demand plan === 'pro' exactly, which rejected
    // LIFETIME subscribers and the owner (who has no subscriptions row at
    // all) with a 403 — that's the "Error — retry" people were seeing on
    // every download button. Downloads are a paid-tier entitlement, so
    // accept any paid plan, and let the owner through unconditionally.
    const sub = subRows?.[0];
    const owner = !!req.subscription?.owner;
    const PAID_PLANS = ['pro', 'lifetime'];
    if (!owner) {
      if (!sub || !PAID_PLANS.includes(sub.plan) || sub.status !== 'active') {
        return res.status(403).json({ error: 'An active paid subscription is required' });
      }
    }
    // Bridge watcher is only for exness users
    if (entry.audience === 'exness' && sub?.broker_type !== 'exness' && !owner) {
      return res.status(403).json({ error: 'This file is only for Exness accounts' });
    }

    // ── STREAM THE FILE, don't hand out a signed URL ───────────────
    // The signed-URL approach kept failing, and the reason was an
    // assumption baked into the old comment here: it claimed
    // signed.signedURL already begins with "/storage/v1". It does NOT —
    // Supabase returns "/object/sign/<bucket>/<path>?token=...". So the
    // URL we built was
    //     https://<proj>.supabase.co/object/sign/...     -> 404
    // instead of
    //     https://<proj>.supabase.co/storage/v1/object/sign/...
    //
    // Rather than patch that one string and hope, this now proxies the
    // bytes. We control the response headers completely, so there is no
    // dependency on Supabase's URL shape, no cross-origin fetch, no
    // reliance on ?download= being honoured, and no 5-minute expiry race.
    // It either streams or it returns a real error — nothing in between.
    // The catalog pins an EXACT filename, including a version number
    // (…v3.91.ex5). Every time a new build is compiled the name changes, and
    // the catalog entry silently goes stale -> 404 -> "Error — retry" on that
    // button while whichever file still matched keeps working. That is the
    // "only one file downloads" symptom: nothing is wrong with the button or
    // the stream, the path just no longer matches what is in the bucket.
    //
    // So: try the exact path first, and if that 404s, list the folder and
    // resolve by stem instead (Mt5_tradingassistant_v3.91.ex5 ->
    // Mt5_tradingassistant_*). Version bumps stop breaking downloads.
    let objectPath = entry.path;
    let upstream;

    async function fetchObject(path) {
      return axios.get(`${SUPABASE_URL}/storage/v1/object/downloads/${path}`, {
        headers: supabaseServiceHeaders(),
        responseType: 'stream',
        maxRedirects: 5,
        // The bridge .exe is ~38MB; don't let axios buffer-cap it.
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
    }

    try {
      upstream = await fetchObject(objectPath);
    } catch (e0) {
      // Try the declared aliases as exact paths first - cheap, and covers a
      // renamed file (mt5_bridge_watcher.exe -> BlackwoodBridge.exe) or a
      // file that lives under docs/ instead of the root.
      let aliasHit = null;
      for (const alt of (entry.aliases || [])) {
        try { upstream = await fetchObject(alt); aliasHit = alt; break; } catch (_) {}
      }
      if (aliasHit) {
        console.warn(`[DOWNLOADS] '${entry.id}' served via alias: ${aliasHit}`);
        objectPath = aliasHit;
      }
    }

    // Still nothing after the exact path and every alias: resolve against
    // what the bucket actually contains.
    //
    // (Supabase Storage answers 400 - not 404 - for a missing object. The
    // original fallback was gated on 404 only, so every miss bailed to a 502
    // and the resolver never ran at all.)
    if (!upstream) {
      console.warn(`[DOWNLOADS] '${entry.id}' not at ${entry.path} — resolving against the bucket…`);

      // Exact miss. Three things actually go wrong in practice, so try all
      // three rather than only the filename:
      //   1. CASE — the bucket folder is "EA" but the catalog says "ea".
      //      Supabase storage paths are case-sensitive, so that 404s.
      //   2. FOLDER — the file sits at the bucket root while the catalog
      //      expects it under bridge/ or docs/.
      //   3. VERSION — the filename gained a new version number on recompile.
      const wanted = entry.path.split('/').pop();
      const ext    = wanted.slice(wanted.lastIndexOf('.'));
      const stem   = wanted.slice(0, wanted.lastIndexOf('.'))
                           .split(/[._-]?v?\d/)[0]
                           .toLowerCase();
      const askedFolder = entry.path.includes('/')
        ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';

      async function listFolder(prefix) {
        try {
          const { data } = await axios.post(
            `${SUPABASE_URL}/storage/v1/object/list/downloads`,
            { prefix, limit: 200, sortBy: { column: 'name', order: 'desc' } },
            { headers: supabaseServiceHeaders({ 'Content-Type': 'application/json' }) }
          );
          return (data || []).map(o => o.name).filter(Boolean);
        } catch (le) {
          console.error('[DOWNLOADS] list failed for prefix "' + prefix + '":',
                        le.response?.status || le.message);
          return [];
        }
      }

      // Folders to try: the one asked for, the same name in whatever casing it
      // really has at the root, then the bucket root itself.
      // Search the WHOLE bucket, not just the folder the catalog names. A
      // file that was uploaded into an unexpected folder (or moved) was
      // previously unfindable - the resolver only ever looked where it was
      // told to look, which is why setup-guide.pdf, dashboard-guide.pdf and
      // the bridge kept failing even with the resolver running.
      const rootEntries = await listFolder('');
      const folders = [];
      if (askedFolder) folders.push(askedFolder);
      folders.push('');                              // bucket root
      // Every root entry without a dot is a folder - walk them all.
      rootEntries.forEach(n => {
        if (!n.includes('.') && !folders.includes(n)) folders.push(n);
      });

      let match = null;
      for (const folder of folders) {
        const names = folder === '' ? rootEntries : await listFolder(folder);
        const aliasNames = (entry.aliases || []).map(a => a.split('/').pop().toLowerCase());
        const pick =
          names.find(n => n === wanted) ||
          names.find(n => n.toLowerCase() === wanted.toLowerCase()) ||
          names.find(n => aliasNames.includes(n.toLowerCase())) ||
          // Bidirectional stem match. One-way (file startsWith stem) misses
          // the case where the real filename is SHORTER than the catalog's -
          // e.g. catalog "CandlePatternIndicator.ex5" vs bucket
          // "CandlePattern.ex5". Compare on the shorter of the two stems.
          names.filter(n => {
            if (!n.toLowerCase().endsWith(ext.toLowerCase())) return false;
            const nStem = n.slice(0, n.lastIndexOf('.'))
                           .split(/[._-]?v?\d/)[0]
                           .toLowerCase();
            if (!nStem || !stem) return false;
            return nStem.startsWith(stem) || stem.startsWith(nStem);
          }).sort().reverse()[0];
        if (pick) { match = (folder ? folder + '/' : '') + pick; break; }
      }

      if (!match) {
        // Print what the bucket actually holds - this is the fastest way to
        // see the real filename when a catalog path has drifted.
        const seen = {};
        for (const f of folders) seen[f || '(root)'] = (f === '' ? rootEntries : await listFolder(f));
        console.error(`[DOWNLOADS] no match for ${entry.path} (stem="${stem}"). Bucket holds:`,
                      JSON.stringify(seen));
        return res.status(404).json({
          error: `Not found in the downloads bucket: ${entry.path}`,
          lookedIn: seen
        });
      }

      console.warn(`[DOWNLOADS] catalog path stale for '${entry.id}': ${entry.path} -> resolved ${match}`);
      objectPath = match;
      try {
        upstream = await fetchObject(objectPath);
      } catch (e2) {
        console.error(`[DOWNLOADS] resolved path also failed: ${objectPath}`);
        return res.status(502).json({ error: 'Could not read the file from storage' });
      }
    }

    const filename = objectPath.split('/').pop();

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Exposed so a cross-origin fetch (account.html on Netlify) can read
    // the filename off the response instead of guessing it.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }

    console.log(`[DOWNLOADS] streaming ${entry.id} (${filename}) to user=${req.user.id}`);

    // If the client aborts mid-download, tear the upstream read down too,
    // otherwise the socket leaks for the life of the process.
    upstream.data.on('error', (err) => {
      console.error('[DOWNLOADS] stream error:', err.message);
      res.destroy();
    });
    res.on('close', () => upstream.data.destroy());

    return upstream.data.pipe(res);
  } catch (e) {
    console.error('[DOWNLOADS] error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Server error' });
  }
});
// ── BILLING HISTORY / INVOICES ─────────────────────────────────
// There is no payments table, so rather than add a schema migration and
// backfill it, this reads the authoritative record straight from Paystack:
// every charge that ever succeeded for this user's email. Paystack is the
// system of record for money, so this can never drift out of sync with what
// was actually charged the way a mirrored local table would.
//
// Env: PAYSTACK_SECRET_KEY (same key paystack-route.js uses). If it is not
// set, the route degrades to an empty list rather than erroring — the
// dashboard just shows "no invoices yet" instead of breaking billing.
app.get('/api/invoices', requireAuth, async (req, res) => {
  const PS_KEY = process.env.PAYSTACK_SECRET_KEY;
  if (!PS_KEY) {
    console.warn('[INVOICES] PAYSTACK_SECRET_KEY not set — returning empty list');
    return res.json({ invoices: [], note: 'Billing history unavailable' });
  }
  const psHeaders = { Authorization: 'Bearer ' + PS_KEY };

  try {
    // Resolve the user's email — the only stable link between our account
    // and the Paystack customer record.
    let email = req.user.email;
    if (!email) {
      const { data: u } = await axios.get(
        `${SUPABASE_URL}/auth/v1/admin/users/${req.user.id}`,
        { headers: supabaseServiceHeaders() }
      );
      email = u?.email;
    }
    if (!email) return res.json({ invoices: [] });

    // Look up the Paystack customer, then that customer's transactions.
    // Filtering the global transaction list by email would page through
    // every customer's charges — this scopes it server-side.
    let customerId = null;
    try {
      const { data: cust } = await axios.get(
        `https://api.paystack.co/customer/${encodeURIComponent(email)}`,
        { headers: psHeaders }
      );
      customerId = cust?.data?.id || null;
    } catch (e) {
      // 404 = this email has never paid. Not an error.
      if (e.response?.status === 404) return res.json({ invoices: [] });
      throw e;
    }
    if (!customerId) return res.json({ invoices: [] });

    const { data: txns } = await axios.get(
      `https://api.paystack.co/transaction?customer=${customerId}&perPage=100`,
      { headers: psHeaders }
    );

    const invoices = (txns?.data || [])
      .filter(t => t.status === 'success')
      .map(t => ({
        reference: t.reference,
        // Paystack returns the SMALLEST currency unit (kobo/pesewa/cents),
        // so this must be divided by 100 — showing t.amount raw would
        // display a $49 charge as $4,900.
        amount:    (t.amount || 0) / 100,
        currency:  t.currency || 'NGN',
        paidAt:    t.paid_at || t.paidAt || t.created_at,
        channel:   t.channel || null,          // card / mobile_money / bank
        plan:      t.plan_object?.name || t.metadata?.plan || t.metadata?.custom_fields?.[0]?.value || null,
        cardLast4: t.authorization?.last4 || null,
        cardBrand: t.authorization?.brand || null,
        receiptUrl: t.receipt_url || null,
      }))
      .sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));

    const totalsByCurrency = invoices.reduce((acc, i) => {
      acc[i.currency] = (acc[i.currency] || 0) + i.amount;
      return acc;
    }, {});

    res.json({ invoices, count: invoices.length, totalsByCurrency });
  } catch (e) {
    console.error('[INVOICES] error:', e.response?.data || e.message);
    res.status(502).json({ error: 'Could not load billing history' });
  }
});


// ── FREE-TIER WATCH PAIRS ───────────────────────────────────────
// Which pairs a user gets alerts for. Free is capped at 3; Pro and
// Lifetime get the full list.
//
// The cap is enforced HERE, not in the UI. A limit that only exists in the
// browser is bypassed with one devtools edit, and this one decides how much
// paid product a free account receives.
//
// Needs one column:
//   alter table subscriptions add column if not exists watch_pairs text[];
// MUST match the EA's WatchPairs default (Mt5_tradingassistant v4.x,
// input string WatchPairs = "EURUSD,GBPUSD,USDJPY,XAUUSD,USDCHF,GBPJPY").
// This list previously carried AUDUSD and USDCAD, which the EA never
// sends, and omitted USDCHF and GBPJPY, which it does. So users could
// select two pairs that could never produce an alert — a free user
// picking both plus one real pair got a third of the alerts they were
// promised — while two genuinely covered pairs were invisible to
// everyone. If the EA's watchlist changes, change it here too.
const BW_ALL_PAIRS  = ['EURUSD','GBPUSD','USDJPY','XAUUSD','USDCHF','GBPJPY'];
const BW_FREE_LIMIT = 3;

function pairLimitFor(plan){
  return (plan === 'pro' || plan === 'lifetime') ? BW_ALL_PAIRS.length : BW_FREE_LIMIT;
}

// True when Postgres/PostgREST is telling us the column is not there yet
// (error 42703). The feature then runs read-only on defaults instead of
// throwing a 500 at the user - "Could not load your pairs" with everything
// dashed is a worse experience than a working picker that cannot save yet.
function isMissingColumn(e){
  const body = e.response?.data;
  const txt  = typeof body === 'string' ? body : JSON.stringify(body || '');
  return e.response?.status === 400 &&
         (txt.includes('42703') || txt.includes('does not exist'));
}

app.get('/api/watch-pairs', requireAuth, async (req, res) => {
  try {
    let data;
    try {
      ({ data } = await axios.get(
        `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${req.user.id}&select=watch_pairs,plan`,
        { headers: supabaseServiceHeaders() }
      ));
    } catch (e) {
      if (!isMissingColumn(e)) throw e;
      // Column not migrated yet: fall back to plan only, defaults for pairs.
      console.warn('[WATCH-PAIRS] watch_pairs column missing — run: alter table subscriptions add column if not exists watch_pairs text[];');
      ({ data } = await axios.get(
        `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${req.user.id}&select=plan`,
        { headers: supabaseServiceHeaders() }
      ));
      const plan0  = ((data && data[0] && data[0].plan) || 'free').toLowerCase();
      const limit0 = pairLimitFor(plan0);
      return res.json({ pairs: BW_ALL_PAIRS.slice(0, limit0), limit: limit0,
                        plan: plan0, available: BW_ALL_PAIRS, readOnly: true,
                        note: 'Pair saving is not enabled yet.' });
    }
    const row  = (data && data[0]) || {};
    const plan = (row.plan || 'free').toLowerCase();
    const limit = pairLimitFor(plan);
    // No selection yet: default a free user to the first 3 rather than
    // sending them nothing at all on day one.
    // Filter against the live list BEFORE slicing. Rows saved while the
    // list wrongly contained AUDUSD/USDCAD still hold those values, and
    // returning them would keep offering pairs the EA never sends. If
    // filtering empties the selection, fall back to the defaults rather
    // than leaving the user with nothing.
    const stored = Array.isArray(row.watch_pairs)
      ? row.watch_pairs.filter(p => BW_ALL_PAIRS.includes(p))
      : [];
    const pairs = stored.length
      ? stored.slice(0, limit)
      : BW_ALL_PAIRS.slice(0, limit);
    res.json({ pairs, limit, plan, available: BW_ALL_PAIRS });
  } catch (e) {
    console.error('[WATCH-PAIRS GET]', e.response?.data || e.message);
    res.status(500).json({ error: 'Could not load your pairs' });
  }
});

app.put('/api/watch-pairs', requireAuth, async (req, res) => {
  try {
    const incoming = Array.isArray(req.body.pairs) ? req.body.pairs : [];
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${req.user.id}&select=plan`,
      { headers: supabaseServiceHeaders() }
    );
    const plan  = ((data && data[0] && data[0].plan) || 'free').toLowerCase();
    const limit = pairLimitFor(plan);

    // Whitelist against the known pairs, drop duplicates, then truncate to
    // the plan's limit. Truncating (rather than rejecting) means a stale or
    // tampered client still ends up in a valid state.
    const clean = [...new Set(incoming.map(x => String(x).toUpperCase()))]
      .filter(x => BW_ALL_PAIRS.includes(x))
      .slice(0, limit);

    if (!clean.length) return res.status(400).json({ error: 'Pick at least one pair' });

    try {
      await axios.patch(
        `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${req.user.id}`,
        { watch_pairs: clean },
        { headers: supabaseServiceHeaders({ 'Content-Type': 'application/json' }) }
      );
    } catch (e) {
      if (!isMissingColumn(e)) throw e;
      console.warn('[WATCH-PAIRS] cannot save — watch_pairs column missing.');
      // User-facing wording: they have done nothing wrong and retrying will
      // not help, so do not imply either. The owner-facing detail is in the
      // console line above.
      return res.status(503).json({
        error: 'Pair selection is not switched on yet — your alerts still cover the default pairs.',
        pairs: clean, limit, plan });
    }
    res.json({ ok: true, pairs: clean, limit, plan, truncated: clean.length < incoming.length });
  } catch (e) {
    console.error('[WATCH-PAIRS PUT]', e.response?.data || e.message);
    res.status(500).json({ error: 'Could not save your pairs' });
  }
});


// ── TRADING BRAIN: VERDICT HISTORY ────────────────────────────────
// A verdict is only worth anything if you can check whether it was right.
// That needs the price at +1h and +4h, which a browser cannot reliably
// sample (it is only running when the user has the tab open) and cannot
// reliably keep (localStorage dies with a cleared cache or an expired
// session). So the rows live in Supabase against the user id, and the
// sampling rides on the EA's own /api/update heartbeat.
//
// Table (already created):
//   brain_verdicts(id, user_id, symbol, timeframe, call, confidence,
//                  price_at, created_at, price_1h, sampled_1h,
//                  price_4h, sampled_4h)
const BRAIN_VERDICTS = `${SUPABASE_URL}/rest/v1/brain_verdicts`;

// Latest price this user's EA has reported for a symbol. Used both when
// recording a verdict and when sampling an outcome, so both ends of the
// measurement come from the same source.
function livePriceFor(userId, sourceId, symbol) {
  try {
    const want = normalisePair(symbol);

    const cs = getCandlesStore(userId, sourceId);
    const key = Object.keys(cs).find(k => normalisePair(k) === want);
    if (key) {
      const node = cs[key] || {};
      const arr = (node.candlesByTF && (node.candlesByTF.H1 || node.candlesByTF.H4))
                || node.candles || [];
      if (Array.isArray(arr) && arr.length) {
        // The store keeps them oldest-first; the last one is current.
        const last = arr[arr.length - 1];
        const c = parseFloat(last.c !== undefined ? last.c : last.close);
        if (isFinite(c) && c > 0) return c;
      }
    }

    const s = getState(userId, sourceId) || {};
    const row = (s.watchlist || []).find(w => normalisePair(w && w.symbol) === want);
    if (row) {
      const bid = parseFloat(row.bid);
      if (isFinite(bid) && bid > 0) return bid;
    }
    if (normalisePair(s.symbol) === want) {
      const p = parseFloat(s.price !== undefined ? s.price : s.bid);
      if (isFinite(p) && p > 0) return p;
    }
  } catch (e) {
    console.warn('[BRAIN-HIST] price lookup failed:', e.message);
  }
  return null;
}

// Record a verdict. The client sends what Claude said; the SERVER decides
// the price, so a browser with an empty candle feed cannot produce a row
// that is impossible to score later.
app.post('/api/brain/verdict', requireAuth, async (req, res) => {
  try {
    const { symbol, timeframe, call, confidence } = req.body || {};
    const CALLS = ['BULLISH', 'BEARISH', 'NEUTRAL'];
    if (!symbol || !CALLS.includes(String(call || '').toUpperCase())) {
      return res.status(400).json({ error: 'Need a symbol and a call of BULLISH|BEARISH|NEUTRAL' });
    }
    const bare = normalisePair(String(symbol)) || String(symbol).toUpperCase();
    const price = livePriceFor(req.user.id, resolveSource(req), bare);

    const row = {
      user_id:    req.user.id,
      symbol:     bare,
      timeframe:  String(timeframe || '').slice(0, 8) || null,
      call:       String(call).toUpperCase(),
      confidence: confidence ? String(confidence).slice(0, 16) : null,
      price_at:   price
    };
    const { data } = await axios.post(BRAIN_VERDICTS, row, {
      headers: { ...supabaseServiceHeaders(), Prefer: 'return=representation' }
    });
    const saved = Array.isArray(data) ? data[0] : data;
    console.log(`[BRAIN-HIST] recorded ${bare} ${row.call} @ ${price === null ? 'no price' : price}`);
    res.json({ ok: true, verdict: saved });
  } catch (err) {
    console.error('[BRAIN-HIST] record failed:', err.response ? JSON.stringify(err.response.data) : err.message);
    res.status(500).json({ error: 'Could not record the verdict' });
  }
});

app.get('/api/brain/verdicts', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 100);
    const url = `${BRAIN_VERDICTS}?user_id=eq.${req.user.id}` +
                `&select=*&order=created_at.desc&limit=${limit}`;
    const { data } = await axios.get(url, { headers: supabaseServiceHeaders() });
    res.json({ ok: true, verdicts: Array.isArray(data) ? data : [] });
  } catch (err) {
    console.error('[BRAIN-HIST] read failed:', err.message);
    res.status(500).json({ error: 'Could not read verdict history' });
  }
});

// Sample the outcomes that have come due. Runs on the EA heartbeat, so it
// happens whether or not a browser is open. `sampled_1h` records WHEN the
// reading was actually taken — if the EA was offline at the 60-minute mark
// the sample is late, and the UI can say so rather than pretending it is a
// clean +1h reading.
let brainResolveBusy = false;
let brainResolveLast = 0;
async function resolveDueVerdicts(userId, sourceId) {
  if (brainResolveBusy) return;
  if (Date.now() - brainResolveLast < 60 * 1000) return;   // at most once a minute
  brainResolveBusy = true;
  brainResolveLast = Date.now();
  try {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const url = `${BRAIN_VERDICTS}?user_id=eq.${userId}` +
                `&price_at=not.is.null&created_at=lt.${cutoff}` +
                `&or=(price_1h.is.null,price_4h.is.null)` +
                `&select=id,symbol,created_at,price_1h,price_4h&limit=50`;
    const { data } = await axios.get(url, { headers: supabaseServiceHeaders() });
    const rows = Array.isArray(data) ? data : [];
    for (const r of rows) {
      const ageMin = (Date.now() - new Date(r.created_at).getTime()) / 60000;
      const patch = {};
      const price = livePriceFor(userId, sourceId, r.symbol);
      if (price === null) continue;                       // no quote yet, try next beat
      if (r.price_1h === null && ageMin >= 60)  { patch.price_1h = price; patch.sampled_1h = new Date().toISOString(); }
      if (r.price_4h === null && ageMin >= 240) { patch.price_4h = price; patch.sampled_4h = new Date().toISOString(); }
      if (!Object.keys(patch).length) continue;
      await axios.patch(`${BRAIN_VERDICTS}?id=eq.${r.id}`, patch,
        { headers: supabaseServiceHeaders() });
      console.log(`[BRAIN-HIST] sampled #${r.id} ${r.symbol} ${Object.keys(patch).join(',')}`);
    }
  } catch (err) {
    console.warn('[BRAIN-HIST] resolve skipped:', err.response ? JSON.stringify(err.response.data) : err.message);
  } finally {
    brainResolveBusy = false;
  }
}

// ── Sign out ──────────────────────────────────────────────────────
// bw-session is httpOnly, so the browser cannot clear it - only the server
// can. Without this it survived sign-out entirely, and the NEXT account to
// use that device inherited it: sign in as account B, still be served
// account A's data. The attributes must match the ones used when setting
// it or the browser keeps the original.
app.post('/api/logout', (req, res) => {
  res.clearCookie('bw-session', { httpOnly: true, secure: true, sameSite: 'none' });
  res.clearCookie('sb-access-token', { httpOnly: true, secure: true, sameSite: 'none' });
  res.json({ ok: true });
});

app.post('/api/cancel-subscription', cancelSubscription);

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
// Scoping by userId alone was NOT enough. One user can hold more than one
// licence key, and both keys resolved to the same user_id — so two
// terminals (one on direct WebRequest, one on the file bridge) wrote into
// the SAME state object and last-writer-won. That is why the bridge
// terminal's data appeared on both dashboards. The scope is now
// user + licence key, so two keys are always two separate feeds.
function scopeOf(userId, sourceId) {
  return `${userId || 'anonymous'}::${sourceId || 'nokey'}`;
}

const states = {};
function getState(userId, sourceId) {
  const scope = scopeOf(userId, sourceId);
  if (!states[scope]) states[scope] = makeEmptyState();
  return states[scope];
}

const candlesStoreByUser = {};
function getCandlesStore(userId, sourceId) {
  const scope = scopeOf(userId, sourceId);
  if (!candlesStoreByUser[scope]) candlesStoreByUser[scope] = {};
  return candlesStoreByUser[scope];
}

// ── Source registry ───────────────────────────────────────────────
// Which feeds each user has, and which was heard from most recently.
// The dashboard uses this to label the feed switcher and to pick a
// sensible default when no source is specified.
const sourcesByUser = {};   // userId -> { sourceId -> meta }
// Published so smc-route.js can resolve the same active feed without a
// circular require back into app.js.
globalThis.bwSourcesByUser = sourcesByUser;
// Publish the RESOLVER too, not just the registry. smc-route was building its
// own "newest feed wins" rule from bwSourcesByUser, while /api/state used
// resolveSource() — ?source= -> remembered preference -> broker type -> newest.
// On any account with two feeds registered (two terminals, or a stale source
// left behind when a renewal minted a new licence key) the two disagreed, so
// the MT5 Assistant read one scope and the SMC panel read an empty one. One
// resolver, one answer.
globalThis.bwResolveSource = resolveSource;

function noteSource(userId, sourceId, meta = {}) {
  if (!userId || !sourceId) return;
  if (!sourcesByUser[userId]) sourcesByUser[userId] = {};
  const prev = sourcesByUser[userId][sourceId] || {};
  sourcesByUser[userId][sourceId] = { ...prev, ...meta, sourceId, lastSeen: Date.now() };
}

function listSources(userId) {
  return Object.values(sourcesByUser[userId] || {})
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

// Which feed should a dashboard request read? An explicit ?source= wins,
// but ONLY if that source really belongs to this user — otherwise anyone
// could read another account's feed by guessing an id. Falls back to the
// most recently active feed.
// Which feed a user has CHOSEN, remembered per user rather than per
// browser. bw-source.js used to keep this in sessionStorage only, so a
// phone (a fresh browser with nothing saved) fell through to "whichever
// terminal posted most recently" — which is how an account page showing a
// file-bridge account ended up beside a dashboard showing the WebRequest
// one. Held in memory here and backed by subscriptions.preferred_source so
// it survives a restart.
//   alter table subscriptions add column if not exists preferred_source text;
const preferredSourceByUser = {};

function resolveSource(req) {
  const owned = sourcesByUser[req.user.id] || {};

  // 1. An explicit ?source= always wins (the switcher, or a scoped fetch).
  const requested = req.query.source;
  if (requested && owned[requested]) return requested;

  // 2. The user's remembered choice — the same answer on every device.
  const preferred = preferredSourceByUser[req.user.id];
  if (preferred && owned[preferred]) return preferred;

  const all = listSources(req.user.id);

  // 3. No stored choice: match the account's own broker type rather than
  //    guessing. A subscription is set to 'exness' (file bridge) or 'prop'
  //    (direct WebRequest), and every feed reports transport 'bridge' or
  //    'direct'. Picking the feed that matches is what makes the dashboard
  //    agree with the account page on a device that has never chosen —
  //    "most recently seen" was a coin flip between two terminals.
  const bt = brokerTypeByUser[req.user.id];
  if (bt) {
    const wantTransport = bt === 'exness' ? 'bridge' : 'direct';
    const match = all.find(s => s.transport === wantTransport);
    if (match) return match.sourceId;
  }

  // 4. Last resort: the most recently seen terminal.
  return all[0] ? all[0].sourceId : null;
}

// Broker type per user, cached so the sync resolveSource above can use it.
const brokerTypeByUser = {};

async function loadBrokerType(userId) {
  if (brokerTypeByUser[userId] !== undefined) return brokerTypeByUser[userId];
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=broker_type`,
      { headers: supabaseServiceHeaders() }
    );
    brokerTypeByUser[userId] = (data && data[0] && data[0].broker_type) || null;
  } catch (e) {
    brokerTypeByUser[userId] = null;
  }
  return brokerTypeByUser[userId];
}

// Hydrate the remembered choice from the database once per process.
async function loadPreferredSource(userId) {
  if (preferredSourceByUser[userId] !== undefined) return preferredSourceByUser[userId];
  try {
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=preferred_source`,
      { headers: supabaseServiceHeaders() }
    );
    const v = data && data[0] ? data[0].preferred_source : null;
    preferredSourceByUser[userId] = v || null;
    return preferredSourceByUser[userId];
  } catch (e) {
    // Column not migrated yet: behave exactly as before rather than 500.
    preferredSourceByUser[userId] = null;
    return null;
  }
}

// ── Public price ticker cache — feeds the marketing site banner ────
// Fed opportunistically off whatever candle ticks come in from any
// connected EA, for a fixed watchlist of symbols. This is intentionally
// separate from the per-user state above: it's public, unauthenticated,
// read-only, and just needs "some recent price", not per-user isolation.
const TICKER_SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'USDCHF', 'GBPJPY'];
const quoteCache = {}; // symbol -> { symbol, price, change, up, updatedAt }

function updateQuoteCache(symbol, price) {
  if (!symbol || !TICKER_SYMBOLS.includes(symbol) || !isFinite(price)) return;
  const prev = quoteCache[symbol];
  const change = prev ? price - prev.price : 0;
  quoteCache[symbol] = {
    symbol,
    price,
    change,
    up: change >= 0,
    updatedAt: Date.now(),
  };
}

// ── External price feed — keeps the ticker live with no EA required ─
// The ticker was previously fed ONLY by whatever EA happened to be
// connected via /api/update — meaning it went stale (falling back to
// static demo values on the frontend) any time no one's terminal was
// live. This pulls real quotes from TwelveData's market-data API on a
// timer, independent of EA activity, so /api/quotes always has
// something genuinely current. Set TWELVEDATA_API_KEY in Railway's
// env vars (free tier: https://twelvedata.com/pricing — enough
// requests for a 6-symbol ticker refreshed every 30s).
//
// Swap the provider by rewriting fetchExternalQuotes() below; nothing
// else needs to change, updateQuoteCache() is provider-agnostic.
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY || '';
const EXTERNAL_QUOTE_SYMBOLS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'XAU/USD', 'USD/CHF', 'GBP/JPY'];

// ── Credit budgeting ──────────────────────────────────────────────
// TwelveData bills per SYMBOL, not per request. The old code polled 6
// symbols every 30s and the comment claimed "8 requests/minute, this uses
// 2" - but that is the RATE limit, not the daily credit limit. The real
// spend was:
//     2,880 calls/day x 6 symbols = 17,280 credits/day
// against a free-tier budget of 800/day - about 21x over, which burns the
// whole day's allowance in roughly an hour. That is the "runs out of
// credits quickly" problem.
//
// Three changes fix it:
//   1. ON DEMAND. Refresh only when /api/quotes is actually called (i.e. a
//      visitor is on the site). An empty site costs nothing.
//   2. HARD DAILY BUDGET. A counter that resets at UTC midnight and simply
//      stops spending. It can no longer run dry mid-day.
//   3. MARKET HOURS. Forex is shut from Fri 22:00 UTC to Sun 22:00 UTC.
//      Polling a frozen price all weekend wasted ~2/7 of the budget.
const TD_DAILY_CREDIT_BUDGET = Number(process.env.TWELVEDATA_DAILY_CREDITS || 700); // 800 tier, 100 spare
const TD_CREDITS_PER_CALL    = EXTERNAL_QUOTE_SYMBOLS.length;
// 15 min: 96 calls/day x 6 symbols = 576 credits, comfortably inside the
// 700 budget even if the site is busy every minute of the day. At 10 min it
// was 864 - the budget cap would have stopped refreshes before midnight, so
// prices would freeze in the evening. The two limits now agree.
const QUOTE_MIN_INTERVAL_MS  = Number(process.env.QUOTES_MIN_INTERVAL_MS || 15 * 60 * 1000);

let tdCreditsUsed = 0;
let tdCreditDay   = new Date().getUTCDate();
let tdLastFetch   = 0;
let tdInFlight    = null;
let tdBackoffUntil = 0;

function tdRollDayIfNeeded() {
  const today = new Date().getUTCDate();
  if (today !== tdCreditDay) { tdCreditDay = today; tdCreditsUsed = 0;
    console.log('[QUOTES] daily credit counter reset'); }
}

// Forex closes Fri ~22:00 UTC and reopens Sun ~22:00 UTC. Prices do not
// move in between, so refreshing is pure waste.
function forexMarketOpen(d = new Date()) {
  const day = d.getUTCDay(), hr = d.getUTCHours();
  if (day === 6) return false;                 // Saturday
  if (day === 5 && hr >= 22) return false;     // Friday close
  if (day === 0 && hr < 22) return false;      // Sunday before open
  return true;
}

function quotesAreFresh() {
  return Date.now() - tdLastFetch < QUOTE_MIN_INTERVAL_MS;
}

async function fetchExternalQuotes(reason = 'scheduled') {
  if (!TWELVEDATA_API_KEY) return;
  tdRollDayIfNeeded();

  if (Date.now() < tdBackoffUntil) return;
  if (quotesAreFresh()) return;
  if (!forexMarketOpen()) return;               // weekend: serve last known
  if (tdCreditsUsed + TD_CREDITS_PER_CALL > TD_DAILY_CREDIT_BUDGET) {
    if (tdCreditsUsed < TD_DAILY_CREDIT_BUDGET + TD_CREDITS_PER_CALL) {
      console.warn(`[QUOTES] daily credit budget reached (${tdCreditsUsed}/${TD_DAILY_CREDIT_BUDGET}) — serving cached prices until UTC midnight`);
      tdCreditsUsed = TD_DAILY_CREDIT_BUDGET + TD_CREDITS_PER_CALL; // log once
    }
    return;
  }
  // Collapse concurrent callers onto one request - ten visitors landing at
  // once must not each spend credits.
  if (tdInFlight) return tdInFlight;

  tdInFlight = (async () => {
    try {
      tdLastFetch  = Date.now();
      tdCreditsUsed += TD_CREDITS_PER_CALL;
      const { data } = await axios.get('https://api.twelvedata.com/quote', {
        params: { symbol: EXTERNAL_QUOTE_SYMBOLS.join(','), apikey: TWELVEDATA_API_KEY },
        timeout: 8000,
      });

      // TwelveData returns a single object for one symbol and an object
      // keyed by symbol for several - normalise both into an array.
      const rows = data && data.symbol ? [data] : Object.values(data || {});
      let stored = 0;
      rows.forEach(row => {
        if (!row || row.status === 'error' || !row.symbol) return;
        const ourSymbol = row.symbol.replace('/', '');
        const price = parseFloat(row.close ?? row.price);
        if (isFinite(price)) { updateQuoteCache(ourSymbol, price); stored++; }
      });
      console.log(`[QUOTES] refreshed ${stored}/${EXTERNAL_QUOTE_SYMBOLS.length} (${reason}) — credits ${tdCreditsUsed}/${TD_DAILY_CREDIT_BUDGET}`);
    } catch (e) {
      const status = e.response?.status;
      // 429 = rate limited, 403/401 = key or plan problem. Back off rather
      // than hammering and burning what is left.
      if (status === 429 || status === 403 || status === 401) {
        tdBackoffUntil = Date.now() + 30 * 60 * 1000;
        console.warn(`[QUOTES] ${status} from TwelveData — backing off 30 min`);
      } else {
        console.warn('[QUOTES] fetch failed:', e.response?.data || e.message);
      }
    } finally {
      tdInFlight = null;
    }
  })();
  return tdInFlight;
}

// One warm-up at boot so the first visitor sees live prices, then nothing
// on a timer - refreshes are triggered by /api/quotes below.
if (TWELVEDATA_API_KEY) {
  fetchExternalQuotes('startup');
} else {
  console.warn('[QUOTES] TWELVEDATA_API_KEY not set — ticker shows EA prices or the static fallback.');
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
  // A dashboard socket is bound to ONE feed. ?source=<id> picks it (the
  // dashboard passes whatever /api/sources gave it); with no parameter we
  // attach to that user's most recently active feed. Binding the socket
  // means a push meant for the bridge terminal never lands on the direct
  // terminal's dashboard.
  const owned = sourcesByUser[ws.userId] || {};
  let wanted = null;
  try { wanted = new URL(req.url, 'http://x').searchParams.get('source'); } catch (e) {}
  ws.sourceId = (wanted && owned[wanted])
    ? wanted
    : (listSources(ws.userId)[0] || {}).sourceId || null;

  ws.send(JSON.stringify({ type: 'FULL_STATE', sourceId: ws.sourceId, data: getState(ws.userId, ws.sourceId) }));
});

// type=null broadcasts to everyone (used for shared data like news);
// otherwise only clients whose ws.userId matches get the message.
// sourceId === undefined means "every feed of this user" (used by
// account-level events). A specific sourceId only reaches sockets watching
// that feed. userId === null stays a true global broadcast (news).
function broadcast(userId, type, data, sourceId) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach(c => {
    if (c.readyState !== 1) return;
    if (userId === null) return c.send(msg);
    if (c.userId !== userId) return;
    if (sourceId !== undefined && c.sourceId !== sourceId) return;
    c.send(msg);
  });
}

// ── Pattern detection ─────────────────────────────────────────────
const ALERT_TIMEFRAMES = ['H1', 'H4'];

const lastAlertedByUser = {};

// Restart storm guard.
//
// lastAlertedByUser lives only in memory, so every restart wipes it and
// the next EA payload looks like a brand-new pattern on every pair and
// timeframe — firing the whole book at once. A deploy, a crash loop or a
// changed env var all do this, and users see a burst of Telegram alerts
// for patterns that formed hours ago.
//
// Fix: the FIRST time this process sees a given symbol+timeframe, record
// what is currently there without alerting. A real new pattern still
// alerts on the next cycle, seconds later; the stale backlog does not.
const primedAfterBoot = new Set();

function runPatternDetection(userId, sourceId, symbol, timeframe, candleArray) {
  if (!ALERT_TIMEFRAMES.includes(timeframe)) return [];
  if (!candleArray || candleArray.length < 3) return [];

  const detected = detectPatterns(candleArray, timeframe);
  if (!detected.length) return [];

  const st = getState(userId, sourceId);
  // Dedupe per FEED, not per user — two terminals watching the same pair
  // are two genuine signals and must not silence each other.
  const scope = scopeOf(userId, sourceId);
  if (!lastAlertedByUser[scope]) lastAlertedByUser[scope] = {};
  const lastAlerted = lastAlertedByUser[scope];

  const key    = `${symbol}_${timeframe}`;
  const latest = detected[0];

  if (lastAlerted[key] === latest.name) return detected;

  // First sighting since boot — prime silently, do not alert.
  const primeKey = `${scope}|${key}`;
  if (!primedAfterBoot.has(primeKey)) {
    primedAfterBoot.add(primeKey);
    lastAlerted[key] = latest.name;
    console.log(`[ALERT] primed ${symbol} ${timeframe} (${latest.name}) — no alert, first sighting since restart`);
    return detected;
  }

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
    // behavior). The customer-facing send is now scoped to the ONE user
    // whose EA produced this alert — previously broadcastTelegramToUsers()
    // fanned it out to every linked subscriber, so customer A received
    // customer B's pattern alerts. sendTelegramToUser() resolves that
    // user's own chat_id via telegram-store.js and silently no-ops if they
    // haven't linked Telegram, so nothing breaks for unlinked accounts.
    sendTelegram(patternMsg);
    sendTelegramToUser(userId, patternMsg);
  }

  broadcast(userId, 'PATTERN_ALERT', alert, sourceId);

  try {
    // Only THIS timeframe's patterns — confluence is now timeframe-matched
    // (an H1 pattern must not pair with an H4 order block), so sending the
    // flattened all-timeframes list would be filtered out on the other side.
    const tfPatterns = (st.patterns[symbol] && st.patterns[symbol][timeframe]) || detected;
    if (tfPatterns && tfPatterns.length) {
      // Was: axios.post(`http://localhost:${PORT}/smc/patterns`, {...})
      // with NO licenceKey on the body — so that route's
      // getSourceForLicenceKey() returned null and answered 401 every time.
      // global.patternStore stayed empty, detectConfluence() always bailed,
      // and /confluence returned {} for every user on both transports.
      // We already have the resolved userId + sourceId here, so hand them
      // straight to smc-route instead of posting to ourselves unauthenticated.
      smcRoute.ingestPatterns(
        userId, sourceId, symbol,
        tfPatterns.map(p => ({ ...p, price: candleArray[candleArray.length - 1].c, timeframe })),
        timeframe
      );
    }
  } catch(e) { console.warn('[CONFLUENCE] ingest failed:', e.message); }

  return detected;
}

// ── /api/update ───────────────────────────────────────────────────
app.post('/api/update', async (req, res) => {
  const d = req.body;

  const src = await getSourceForLicenceKey(d.licenceKey);
  if (!src) {
    console.warn('[UPDATE] Rejected — no valid licenceKey on payload. Update your EA to v3.8+ and make sure a valid licence key is entered.');
    return res.status(401).json({ error: 'Missing or invalid licenceKey. Update your EA and paste your Blackwood licence key into its inputs.' });
  }
  const { userId, sourceId } = src;
  primaryUserId = userId; // agent still follows "whichever account is currently active"
  refreshPrimarySmcView();

  const s  = getState(userId, sourceId);
  const cs = getCandlesStore(userId, sourceId);
  const liveAccountNumber = d.accountInfo ? String(d.accountInfo.login || d.accountInfo.account || d.accountInfo.accountLogin || '') || null : null;

  // Label the feed so the dashboard switcher can name it. `transport`
  // lets a user tell their bridge terminal apart from their direct one
  // even when both are on the same broker.
  noteSource(userId, sourceId, {
    keyTail:   src.keyTail,
    account:   liveAccountNumber,
    server:    d.accountInfo ? (d.accountInfo.server || null) : null,
    transport: d.viaBridge ? 'bridge' : 'direct'
  });

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
      broadcast(userId, 'ACCOUNT_SWITCH', { reason: `login ${oldLogin} -> ${liveAccountNumber}`, old_login: oldLogin, new_login: liveAccountNumber }, sourceId);
      broadcast(userId, 'TICK', {
        watchlist: s.watchlist, candles: [],
        patterns: [], indicators: {},
        openTrades: [], closedTrades: [],
        accountInfo: d.accountInfo,
        newsEvents: newsEvents,
        symbol: '', timeframe: '',
        patternAlerts: []
      }, sourceId);
    }
  }

  if (d.candles && d.symbol && d.timeframe) {
    const sym = d.symbol, tf = d.timeframe;
    if (!s.candles[sym])  s.candles[sym]  = {};
    if (!s.patterns[sym]) s.patterns[sym] = {};
    s.candles[sym][tf]  = d.candles;
    const pats = runPatternDetection(userId, sourceId, sym, tf, d.candles);
    s.patterns[sym][tf] = pats;
    s.candlesList = d.candles; s.activePatterns = pats;
    s.symbol = sym; s.timeframe = tf;

    // Feed the public ticker cache off the latest close, if this symbol
    // is one we publish. Cheap — just reads the last candle already in hand.
    const lastCandle = d.candles[d.candles.length - 1];
    if (lastCandle) {
      const lastClose = parseFloat(lastCandle.close ?? lastCandle.c ?? lastCandle.Close);
      updateQuoteCache(sym.toUpperCase(), lastClose);
    }
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
  }, sourceId);
  res.json({ ok: true });

  // Outcome sampling rides on this heartbeat — see resolveDueVerdicts().
  // Deliberately NOT awaited: the EA must never wait on Supabase, and a
  // failed sample is retried on the next beat.
  resolveDueVerdicts(userId, sourceId);
});

// ── /api/candles ──────────────────────────────────────────────────
app.post('/api/candles', async (req, res) => {
  const d = req.body;
  if (!d || !d.symbol) return res.status(400).json({ error: 'symbol required' });

  const src = await getSourceForLicenceKey(d.licenceKey);
  if (!src) return res.status(401).json({ error: 'Missing or invalid licenceKey' });
  const { userId, sourceId } = src;
  noteSource(userId, sourceId, { keyTail: src.keyTail });

  const s  = getState(userId, sourceId);
  const cs = getCandlesStore(userId, sourceId);
  const sym = d.symbol;
  if (!s.candles[sym])  s.candles[sym]  = {};
  if (!s.patterns[sym]) s.patterns[sym] = {};

  if (Array.isArray(d.candles) && d.timeframe) {
    const tf = d.timeframe;
    s.candles[sym][tf]  = d.candles;
    s.patterns[sym][tf] = runPatternDetection(userId, sourceId, sym, tf, d.candles);
    // Merge, don't replace. /api/multi-candles stores a candlesByTF bundle
    // here; this handler used to overwrite the whole entry with a single
    // timeframe, wiping the H1/H4 bundle for that symbol on every send until
    // the next multi-send rebuilt it. Preserve what's already there and add
    // this timeframe alongside it.
    const prevEntry = cs[sym] || {};
    cs[sym] = {
      ...prevEntry,
      symbol: sym, timeframe: tf, candles: d.candles,
      candlesByTF: { ...(prevEntry.candlesByTF || {}), [tf]: d.candles },
      timestamp: d.timestamp || new Date().toISOString(),
      received_at: new Date().toISOString()
    };
    console.log(`[Candles] user=${userId} ${sym} ${tf} — ${d.candles.length} bars stored`);
    broadcast(userId, 'CANDLE_UPDATE', { symbol: sym, timeframe: tf, candles: d.candles }, sourceId);
    if (userId === primaryUserId) { refreshPrimarySmcView(); triggerAgentOnCandle(s, livePrimarySmcView, cs, tf); }
    return res.json({ ok: true, symbol: sym, timeframe: tf, bars: d.candles.length });
  }

  if (d.candles && typeof d.candles === 'object' && !Array.isArray(d.candles)) {
    const allPatterns = {};
    Object.entries(d.candles).forEach(([tf, arr]) => {
      s.candles[sym][tf]  = arr;
      allPatterns[tf]      = runPatternDetection(userId, sourceId, sym, tf, arr);
      s.patterns[sym][tf] = allPatterns[tf];
      if (userId === primaryUserId) { refreshPrimarySmcView(); triggerAgentOnCandle(s, livePrimarySmcView, cs, tf); }
    });
    broadcast(userId, 'CANDLE_UPDATE', { symbol: sym, candles: s.candles[sym], patterns: allPatterns }, sourceId);
    return res.json({ ok: true, patternsDetected: Object.values(allPatterns).flat().length });
  }

  return res.status(400).json({ error: 'invalid candles format' });
});

app.get('/api/candles', requirePlan('pro'), (req, res) => {
  const cs = getCandlesStore(req.user.id, resolveSource(req));
  const { symbol } = req.query;
  if (symbol) {
    // Same bare-pair vs broker-symbol mismatch as /api/patterns above:
    // the store is keyed EURUSDc, dashboards ask for EURUSD.
    let data = cs[symbol];
    if (!data) {
      const want = normalisePair(symbol);
      const hit  = Object.keys(cs).find(k => normalisePair(k) === want);
      if (hit) data = cs[hit];
    }
    if (!data) return res.json({ symbol, candles: [], note: 'No candle data yet' });
    return res.json(data);
  }
  const all = Object.values(cs);
  if (!all.length) return res.json({ candles: [], note: 'No candle data yet' });
  all.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
  res.json(all[0]);
});

// ── /api/multi-candles ──────────────────────────────────────────────
// NEW — lets the EA send candles+patterns+indicators for MULTIPLE
// symbols in one bundled payload (built by SendMultiSymbolCandles() in
// the EA), so the dashboard can switch pairs instantly using data
// already cached here, without needing the EA attached to that chart.
// Reuses the exact same per-symbol storage + pattern detection +
// broadcast logic /api/candles already uses — just looped over the
// "symbols" object instead of a single top-level symbol.
app.post('/api/multi-candles', async (req, res) => {
  const d = req.body;
  if (!d || !d.symbols || typeof d.symbols !== 'object') {
    console.warn('[Multi] Rejected — malformed payload. Body keys:', d ? Object.keys(d) : 'none');
    return res.status(400).json({ error: 'symbols object required' });
  }

  const src = await getSourceForLicenceKey(d.licenceKey);
  if (!src) {
    console.warn('[Multi] Rejected — no valid licenceKey. licenceKey present:', !!d.licenceKey);
    return res.status(401).json({ error: 'Missing or invalid licenceKey' });
  }
  const { userId, sourceId } = src;
  noteSource(userId, sourceId, { keyTail: src.keyTail });

  const s  = getState(userId, sourceId);
  const cs = getCandlesStore(userId, sourceId);
  const summary = {};
  if (!s.indicatorsBySymbol) s.indicatorsBySymbol = {}; // per-symbol, per-timeframe now: s.indicatorsBySymbol[sym][tf]

  Object.entries(d.symbols).forEach(([sym, tfBundle]) => {
    if (!tfBundle || typeof tfBundle !== 'object') return;

    if (!s.candles[sym])  s.candles[sym]  = {};
    if (!s.patterns[sym]) s.patterns[sym] = {};
    if (!s.indicatorsBySymbol[sym]) s.indicatorsBySymbol[sym] = {};

    const candlesByTF = {}, patternsByTF = {}, indicatorsByTF = {};

    Object.entries(tfBundle).forEach(([tf, payload]) => {
      if (!payload || !Array.isArray(payload.candles)) return;

      s.candles[sym][tf]  = payload.candles;
      s.patterns[sym][tf] = runPatternDetection(userId, sourceId, sym, tf, payload.candles);
      if (payload.indicators) s.indicatorsBySymbol[sym][tf] = payload.indicators;

      candlesByTF[tf]  = payload.candles;
      patternsByTF[tf] = s.patterns[sym][tf];
      if (payload.indicators) indicatorsByTF[tf] = payload.indicators;
    });

    cs[sym] = {
      symbol: sym, candlesByTF,
      candles: candlesByTF['H1'] || candlesByTF['H4'] || [], // backward-compat flat field — old consumers expecting .candles directly still get something sensible
      timestamp: d.timestamp || new Date().toISOString(),
      received_at: new Date().toISOString()
    };

    broadcast(userId, 'CANDLE_UPDATE', { symbol: sym, candles: candlesByTF, patterns: patternsByTF, indicators: indicatorsByTF }, sourceId);
    summary[sym] = Object.keys(candlesByTF);
  });

  console.log(`[Multi] user=${userId} stored ${Object.keys(summary).length} symbols:`, summary);
  res.json({ ok: true, symbols: summary });
});

// News is genuinely shared market data — same for every user — so this
// one stays a plain global list, not per-user.
app.get('/api/news',   requirePlan('pro'), (req, res) => res.json(newsEvents));
// ── /api/sources — the feeds this user has ────────────────────────
// One entry per licence key that has sent data. The dashboard renders a
// switcher from this and passes ?source=<id> on every subsequent call.
// Never exposes a whole licence key — only its last 4 characters.
app.get('/api/sources', requirePlan('pro'), async (req, res) => {
  // Load the remembered choice BEFORE resolving, so the `active` value a
  // fresh device receives is the user's own pick and not "most recent".
  // Both hydrated before resolving: the stored choice, and the account's
  // broker type used as the default when there is no choice yet.
  await loadPreferredSource(req.user.id);
  await loadBrokerType(req.user.id);
  res.json({
    sources: listSources(req.user.id),
    active:  resolveSource(req),
    preferred: preferredSourceByUser[req.user.id] || null
  });
});

// Remember which feed this account should use, for every device.
app.put('/api/preferred-source', requirePlan('pro'), async (req, res) => {
  const wanted = req.body && req.body.source;
  const owned  = sourcesByUser[req.user.id] || {};
  if (!wanted || !owned[wanted]) {
    return res.status(400).json({ error: 'Unknown feed for this account' });
  }
  preferredSourceByUser[req.user.id] = wanted;
  try {
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${req.user.id}`,
      { preferred_source: wanted },
      { headers: supabaseServiceHeaders({ 'Content-Type': 'application/json' }) }
    );
  } catch (e) {
    // Not migrated yet — the in-memory pin still fixes the current session.
    console.warn('[SOURCE] could not persist preferred_source:', e.response?.status || e.message);
  }
  res.json({ ok: true, source: wanted });
});

app.get('/api/state',  requirePlan('pro'), (req, res) => res.json(getState(req.user.id, resolveSource(req))));
app.get('/api/alerts', requirePlan('pro'), (req, res) => res.json(getState(req.user.id, resolveSource(req)).patternAlerts));

// ── /api/patterns ─────────────────────────────────────────────────
app.post('/api/patterns', async (req, res) => {
  const data = req.body;
  if (!data || !data.symbol) return res.status(400).json({ error: 'Missing symbol' });

  const src = await getSourceForLicenceKey(data.licenceKey);
  if (!src) return res.status(401).json({ error: 'Missing or invalid licenceKey' });
  const { userId, sourceId } = src;
  noteSource(userId, sourceId, { keyTail: src.keyTail });

  const s   = getState(userId, sourceId);
  const key = `${data.symbol}_${data.timeframe}`;
  s.livePatterns[key] = { ...data, received_at: new Date().toISOString() };
  console.log(`[PatternDetector] user=${userId} src=${sourceId} ${data.symbol} ${data.timeframe} | bias: ${data.bias} | score: ${data.bias_score} | patterns: ${(data.patterns || []).length}`);
  broadcast(userId, 'LIVE_PATTERNS', s.livePatterns[key], sourceId);
  res.json({ status: 'ok', key });
});

app.get('/api/patterns/latest', requirePlan('pro'), (req, res) => {
  const all = Object.values(getState(req.user.id, resolveSource(req)).livePatterns);
  if (!all.length) return res.json({});
  all.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
  res.json(all[0]);
});

// Broker symbol suffixes: the EA stores patterns under the BROKER's symbol
// (EURUSDc / EURUSDm / EURUSD.z), but every dashboard asks for the bare pair
// (EURUSD) because that's what its pair buttons emit. The exact-key lookup
// below therefore missed on every suffixed account — patterns.html showed
// "Connected – no data yet" and the Brain showed 0 patterns, which read as
// "file-bridge users have no pattern detector" when the data was there all
// along under a different key.
//
// Same normaliser as smc-route.js: only strip when what remains is a real
// pair, so PLATINUM isn't mangled into PLATIN.
const BW_CCY  = ['USD','EUR','GBP','JPY','CHF','AUD','NZD','CAD','SEK','NOK','DKK',
                 'SGD','HKD','ZAR','MXN','TRY','PLN','CZK','HUF','CNH','THB','INR'];
const BW_BASE = BW_CCY.concat(['XAU','XAG','XPT','XPD','BTC','ETH','LTC','XRP','SOL','BNB']);

function normalisePair(sym) {
  if (!sym) return '';
  const up = String(sym).toUpperCase().replace(/[._-]/g, '');
  for (let cut = 0; cut <= 3 && up.length - cut >= 6; cut++) {
    const cand = up.slice(0, up.length - cut);
    if (cand.length !== 6) continue;
    if (BW_BASE.includes(cand.slice(0, 3)) && BW_CCY.includes(cand.slice(3, 6))) return cand;
  }
  return up;
}

// Finds `${symbol}_${tf}` in a symbol_tf-keyed store, tolerating whatever
// suffix and casing the broker uses.
function findByPairTf(store, symbol, tf) {
  const exact = store[`${symbol}_${tf}`];
  if (exact) return exact;
  const wantSym = normalisePair(symbol);
  const wantTf  = String(tf || '').toUpperCase();
  const hit = Object.keys(store).find(k => {
    const idx = k.lastIndexOf('_');
    if (idx < 0) return false;
    return normalisePair(k.slice(0, idx)) === wantSym &&
           k.slice(idx + 1).toUpperCase() === wantTf;
  });
  return hit ? store[hit] : null;
}

app.get('/api/patterns', requirePlan('pro'), (req, res) => {
  const s = getState(req.user.id, resolveSource(req));
  const { symbol, tf } = req.query;
  if (symbol && tf) return res.json(findByPairTf(s.livePatterns, symbol, tf) || {});
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
  const { balance, resetAt, known } = await getUserCredits(req.user.id);
  /* Say "unknown" out loud rather than inventing a full balance. The
     dashboard keeps whatever it was already showing instead of being
     told the wallet is full. */
  if (!known || balance == null) {
    return res.status(503).json({ error: 'credit balance unavailable', monthly: MONTHLY_CREDIT_USD, unlimited: false });
  }
  res.json({ balance, monthly: MONTHLY_CREDIT_USD, resetAt, unlimited: false });
});

// ── /api/analyse ──────────────────────────────────────────────────
app.post('/api/analyse', requirePlan('pro'), async (req, res) => {
  const { ssi, smc: smcPayloadFromBrain, maxTokens, symbol, timeframe } = req.body;
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

  const src = resolveSource(req);
  const s   = getState(req.user.id, src);
  const cs  = getCandlesStore(req.user.id, src);

  // The Trading Brain's own pair/timeframe selector now sends these
  // explicitly — no more guessing via state.symbol (the EA's attached
  // chart), "first key in an object", or "whatever updated most recently".
  // Every data source below is built from THIS exact symbol+timeframe.
  const sym = symbol;
  const tf  = timeframe || 'H1';

  if (!sym) {
    return res.status(400).json({ error: 'No pair selected — pick a pair on the Trading Brain first' });
  }
  console.log(`[ANALYSE] user=${req.user.id} analysing ${sym} ${tf}`);

  // Suffix-tolerant, like /api/patterns and /api/candles. The Brain sends
  // whichever name its pair buttons carry; the store is keyed by the
  // BROKER's symbol (EURUSDc / EURUSDm / EURUSD.z). An exact lookup missed
  // on every suffixed account, so the analysis ran on no candles at all -
  // which is why Analyse failed "on all angles" rather than for one pair.
  let candleStoreEntry = cs[sym];
  if (!candleStoreEntry) {
    const wantSym = normalisePair(sym);
    const hit = Object.keys(cs).find(k => normalisePair(k) === wantSym);
    if (hit) {
      console.log(`[ANALYSE] resolved ${sym} -> ${hit}`);
      candleStoreEntry = cs[hit];
    }
  }
  candleStoreEntry = candleStoreEntry || {};
  // candlesByTF entries use short keys (t/o/h/l/c) from the multi-symbol
  // sender; the older flat .candles field uses long keys (time/open/high/
  // low/close) from the single-symbol sender — normalized below.
  const candleArrRaw = (candleStoreEntry.candlesByTF && candleStoreEntry.candlesByTF[tf])
    ? candleStoreEntry.candlesByTF[tf]
    : (candleStoreEntry.candles || []);
  const candleArr = candleArrRaw.slice(-8).map(c => ({
    time:  c.time !== undefined ? c.time : c.t,
    open:  parseFloat(c.open  !== undefined ? c.open  : c.o),
    high:  parseFloat(c.high  !== undefined ? c.high  : c.h),
    low:   parseFloat(c.low   !== undefined ? c.low   : c.l),
    close: parseFloat(c.close !== undefined ? c.close : c.c)
  }));

  const updateData = {
    symbol: sym,
    timeframe: tf,
    price: candleArr.length ? candleArr[candleArr.length - 1].close : 0,
    openTrades:  s.openTrades,
    accountInfo: s.accountInfo
  };

  // Exact key for this symbol+timeframe — smcStoreKey already handles the
  // H1-vs-non-default-format distinction (see smc-route.js).
  const smcData = smcStore[smcStoreKey(req.user.id, sym, tf)] || {};

  // s.livePatterns is keyed exactly "{symbol}_{timeframe}" — match exactly,
  // not "starts with sym" (which could ambiguously match either H1 or H4).
  const patKey      = `${sym}_${tf}`;
  const patternRaw  = s.livePatterns[patKey] || {};
  const filteredPatterns = buildFilteredPatternData(patternRaw);

  // Refuse to analyse nothing. Without this the route ran on price 0 and an
  // empty candle summary, and the failure surfaced as a vague error with no
  // hint of the cause. Name the symbol we looked for and what we do have.
  if (!candleArr.length) {
    const available = Object.keys(cs);
    console.warn(`[ANALYSE] no candles for ${sym} ${tf}; store holds: ${JSON.stringify(available)}`);
    return res.status(400).json({
      error: `No candle data for ${sym} on ${tf} yet. Check the EA is running and this pair is in WatchPairs.`,
      symbol: sym, timeframe: tf, availableSymbols: available
    });
  }

  const candleSummary = candleArr.length
    ? candleArr.map((c, i) => {
        const dir  = c.close > c.open ? '▲' : '▼';
        const body = Math.abs(c.close - c.open).toFixed(2);
        const time = c.time ? new Date(c.time * 1000).toISOString().slice(11,16) : `bar${i}`;
        return `${time} ${dir} O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)} body:${body}`;
      }).join('\n')
    : 'No candle data available';

  /* UNITS, COMPUTED HERE RATHER THAN INFERRED BY THE MODEL.
     The PIPS VS POINTS rules in the system prompt were already correct and
     detailed, but every number in the data below arrives as bare JSON with
     no unit attached, so the model still had to WORK OUT the convention
     from the symbol string on every call — and broker suffixes (EURUSDc,
     XAUUSDm, GBPJPY.z) make that guess unreliable. State it as a fact for
     this specific symbol instead, with a worked example in this pair's own
     prices, so there is nothing left to infer. */
  const unitBlock = (() => {
    /* Broker suffixes must be stripped BEFORE testing the quote currency.
       `GBPJPY.z` -> stripping non-letters gives "GBPJPYZ", which fails a
       /JPY$/ test and would have handed a JPY pair the 5-digit pip size —
       a 100x error in every distance. Take the first six letters, which is
       the pair itself, and test that. */
    const letters = String(sym || '').toUpperCase().replace(/[^A-Z]/g, '');
    const base = letters.slice(0, 6);
    const isJPY  = /JPY$/.test(base);
    const isGold = /^XAU/.test(base);
    const isSilv = /^XAG/.test(base);
    const isCrypto = /^(BTC|ETH|LTC|XRP|SOL|DOGE)/.test(base);
    if (isCrypto) return [
      `=== UNITS FOR ${sym} — USE THESE EXACT UNITS ===`,
      `${sym} is CRYPTO. Do NOT use pips or points anywhere in your answer.`,
      `Express every distance in raw dollars, e.g. "stop $450 below entry".`,
      '=== END UNITS ==='].join('\n');
    if (isGold || isSilv) return [
      `=== UNITS FOR ${sym} — USE THESE EXACT UNITS ===`,
      `${sym} is a METAL. Pip conventions differ between brokers, so do NOT`,
      `use pips or points. Express every distance in raw dollars, e.g.`,
      `"stop $2.50 below entry", "target at $2,415.30".`,
      '=== END UNITS ==='].join('\n');
    const pip   = isJPY ? 0.01 : 0.0001;
    const point = pip / 10;
    const ex    = isJPY ? ['145.234', '145.244'] : ['1.08453', '1.08463'];
    return [
      `=== UNITS FOR ${sym} — USE THESE EXACT UNITS ===`,
      `${sym} is a FOREX pair${isJPY ? ' quoted in JPY' : ''}.`,
      `1 pip   = ${pip}   (the ${isJPY ? '2nd' : '4th'} decimal place)`,
      `1 point = ${point}  (the ${isJPY ? '3rd' : '5th'} decimal place, = 1/10 pip)`,
      `Worked example for this pair: ${ex[0]} -> ${ex[1]} is 10 points = 1 pip.`,
      `To convert a raw price difference D into pips: pips = D / ${pip}.`,
      `Always write the unit after the number ("18 pips", never "18").`,
      `The prices in the data below are RAW PRICES, not pips and not points.`,
      '=== END UNITS ==='].join('\n');
  })();

  const prompt = [
    `Live MT5 market data for ${sym} (${tf}) — ${new Date().toUTCString()}:\n`,
    unitBlock,
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

=== PIPS VS POINTS — follow exactly, never mix these up ===
A "pip" and a "point" are NOT the same unit. Getting this wrong makes stop-loss and take-profit distances meaningless to the trader, so be precise:
1. PIP: the standard forex unit of price movement — the 4th decimal place for most pairs (e.g. EURUSD, GBPUSD, USDCHF: 0.0001 = 1 pip) and the 2nd decimal place for JPY pairs (e.g. USDJPY, GBPJPY: 0.01 = 1 pip).
2. POINT (a.k.a. "pipette"): the smallest price increment shown on 5-digit/3-digit broker pricing — 1/10th of a pip. E.g. on EURUSD, a move from 1.08453 to 1.08463 is 10 points = 1 pip. On USDJPY, a move from 145.234 to 145.244 is also 10 points = 1 pip.
3. NEVER use "pips" and "points" interchangeably in the same verdict, and never state a distance without its unit (e.g. always "20 pips" or "200 points", never just "20").
4. GOLD (XAUUSD): pip/point conventions vary by broker. State price distances in raw dollar terms instead (e.g. "$2.50 move", "SL at $2,415.30") rather than converting to pips or points, unless the data explicitly gives a pip convention for gold.
5. CRYPTO (BTCUSD etc.): always use raw price differences in dollar terms (e.g. "$450 move"), never pips or points — those units don't apply to crypto.
6. When you compute a stop-loss or take-profit distance from the given price levels, do the arithmetic carefully in raw price terms first, THEN convert to pips/points (for forex) using the rules above — don't estimate pip/point distances directly from eyeballing price levels.
=== END PIPS VS POINTS RULES ===

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
  const mapEvents = data => (Array.isArray(data) ? data : [])
    .filter(e => e.impact === 'High' && HIGH_CURRENCIES.includes(e.country))
    .map(e => ({
      title: e.title, country: e.country, impact: 'high',
      timestamp: Math.floor(new Date(e.date).getTime() / 1000),
      forecast: e.forecast || '—', previous: e.previous || '—', actual: e.actual || null,
    }))
    .filter(e => Number.isFinite(e.timestamp));

  // BOTH WEEKS, MERGED.
  // The old version returned as soon as THIS week produced any events, so
  // next week's releases were never loaded — on a Friday, Monday's events
  // were simply missing from the dashboard, and the "next week" URL was
  // only ever reached when this week's fetch FAILED. Nothing about the
  // calendar makes those mutually exclusive: fetch both, merge, dedupe.
  // One week succeeding is still enough to serve; only a total failure
  // falls through to placeholders.
  const grab = async (url, label) => {
    try {
      const { data } = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const ev = mapEvents(data);
      console.log(`✓ ${label}: ${ev.length} HIGH impact events`);
      return ev;
    } catch (e) {
      console.warn(`${label} fetch failed:`, e.message);
      return null;
    }
  };

  const [thisWeek, nextWeek] = await Promise.all([
    grab('https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'This week'),
    grab('https://nfs.faireconomy.media/ff_calendar_nextweek.json', 'Next week'),
  ]);

  if (thisWeek === null && nextWeek === null) {
    console.warn('Both calendar fetches failed — using placeholders');
    newsEvents = getPlaceholderNews();
    broadcast(null, 'NEWS_UPDATE', newsEvents);
    return;
  }

  // Dedupe on title+country+timestamp: the two feeds overlap at the week
  // boundary and would otherwise produce two countdowns for one release.
  const seen = new Set();
  const merged = [...(thisWeek || []), ...(nextWeek || [])]
    .filter(e => {
      const k = `${e.country}|${e.title}|${e.timestamp}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.timestamp - b.timestamp);

  if (!merged.length) {
    console.warn('Calendar reachable but returned no HIGH impact events — keeping previous list');
    return;                       // don't wipe a good list with an empty one
  }

  newsEvents = merged;
  broadcast(null, 'NEWS_UPDATE', merged);
  console.log(`✓ Calendar: ${merged.length} HIGH impact events across both weeks`);
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
    /* THE BUG THIS FIXES.
       The sweep selected EVERY row whose credit_reset_at had passed and
       granted a fresh month, with no check on whether the account was
       entitled to one. An account in GRACE has a lapsed date like anyone
       else — grace is precisely the state where the date has passed and
       the renewal has NOT — so the safety net was refilling exactly the
       group it should have skipped. Credits were being granted by the
       calendar rather than by a payment.
       A user in grace keeps the balance they already had. When the
       renewal actually lands, Paystack's charge.success resets them and
       the new cycle starts from the PAYMENT, which is the only event
       that should ever start one. */
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?credit_reset_at=lt.${new Date().toISOString()}` +
      `&select=user_id,plan,status,expires_at,access_status,access_reason,grace_until`,
      { headers: supabaseServiceHeaders() }
    );
    let granted = 0, held = 0;
    for (const row of data || []) {
      /* One definition of entitlement, the same one the rest of the
         platform uses — not a second opinion written here. */
      const access = accessState(row);
      if (access.state !== 'active') {
        held++;
        console.log(`[CREDITS] Held (${access.state}) — balance kept for user=${row.user_id}`);
        continue;
      }
      await resetUserCredits(row.user_id);
      granted++;
      console.log(`[CREDITS] Safety-net reset for user=${row.user_id}`);
    }
    if (granted || held) console.log(`[CREDITS] sweep: ${granted} reset, ${held} held`);
  } catch (e) {
    console.error('[CREDITS] resetDueCredits sweep failed:', e.response?.data || e.message);
  }
}
cron.schedule('0 0 * * *', resetDueCredits); // once daily at midnight UTC

// ── Scheduled plan changes (downgrades) ─────────────────────────────
// A downgrade takes effect at the END of the period the customer has
// already paid for, never immediately — they bought that time. So the
// request only writes an intention (pending_plan / pending_plan_key) and
// this sweep applies it once expires_at has passed.
//
// Needs three columns:
//   alter table subscriptions
//     add column if not exists pending_plan     text,
//     add column if not exists pending_plan_key text,
//     add column if not exists pending_plan_at  timestamptz;
//
// Renewals are manual here (no stored recurring mandate), so a
// yearly -> monthly downgrade is simply "change what they renew into":
// swapping plan_key is enough, and the next renewal charges monthly.
const BW_FREE_PAIRS = BW_ALL_PAIRS.slice(0, BW_FREE_LIMIT);

async function applyPendingPlanChanges() {
  try {
    const nowIso = new Date().toISOString();
    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions` +
      `?select=user_id,plan,plan_key,expires_at,watch_pairs,licence_key,pending_plan,pending_plan_key,pending_plan_at` +
      `&expires_at=not.is.null&expires_at=lte.${nowIso}` +
      `&or=(pending_plan.not.is.null,pending_plan_key.not.is.null)`,
      { headers: supabaseServiceHeaders() }
    );

    for (const row of data || []) {
      const patch = {
        pending_plan: null, pending_plan_key: null, pending_plan_at: null,
        updated_at: new Date().toISOString()
      };

      if (row.pending_plan === 'free') {
        patch.plan     = 'free';
        patch.plan_key = null;
        patch.status   = 'active';   // an active free account, not a dead pro one
        // Free entitlement is 3 pairs. GET /api/watch-pairs already slices
        // on read, but the stored array is what the alert senders see, so
        // it is trimmed here too rather than trusting every future caller
        // to remember the cap.
        patch.watch_pairs = Array.isArray(row.watch_pairs) && row.watch_pairs.length
          ? row.watch_pairs.slice(0, BW_FREE_LIMIT)
          : BW_FREE_PAIRS;
        // The compiled EA and indicators are not part of the free plan.
        // Leaving the key on the row would keep them running: validateKey
        // checks status and expiry, and a free row is neither expired nor
        // inactive.
        patch.licence_key = null;
      } else if (row.pending_plan_key) {
        // Tier change within Pro. Plan stays 'pro'; only what they renew
        // into changes.
        patch.plan_key = row.pending_plan_key;
      }

      await axios.patch(
        `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${row.user_id}`,
        patch,
        { headers: supabaseServiceHeaders({ 'Content-Type': 'application/json' }) }
      );
      console.log(`[PLAN] Applied scheduled change for user=${row.user_id} -> ` +
                  (row.pending_plan === 'free' ? 'free' : `plan_key=${row.pending_plan_key}`));
    }
  } catch (e) {
    console.error('[PLAN] applyPendingPlanChanges sweep failed:', e.response?.data || e.message);
  }
}
cron.schedule('5 0 * * *', applyPendingPlanChanges); // daily, just after the credit reset

// ── Licence sharing: graduated two-strike response ──────────────────
// Warn at 2 confirmed MT5 accounts, block the dashboard at 3. Both
// reversible from the admin console. See licence-sharing.js.
const licenceSharing = require('./licence-sharing');
licenceSharing.start();

// ── POST /api/plan/downgrade ────────────────────────────────────────
// Schedules a downgrade for the end of the current paid period.
// Nothing changes today: the customer keeps everything they paid for
// until expires_at, and applyPendingPlanChanges() does the work later.
app.post('/api/plan/downgrade', requireAuth, async (req, res) => {
  try {
    const target = String(req.body.target || '').toLowerCase();
    if (!['free', 'pro_monthly'].includes(target)) {
      return res.status(400).json({ error: 'Unknown downgrade target' });
    }

    const { data } = await axios.get(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${req.user.id}` +
      `&select=plan,plan_key,status,expires_at`,
      { headers: supabaseServiceHeaders() }
    );
    const sub = (data && data[0]) || {};
    const plan = (sub.plan || 'free').toLowerCase();

    if (isOwner(req.user.email)) return res.status(403).json({ error: 'Owner accounts cannot be downgraded' });
    if (plan === 'free')     return res.status(400).json({ error: 'You are already on the free plan' });
    // Lifetime was a one-time purchase with no recurring period to end, so
    // there is no "end of period" for a downgrade to land on. Dropping it
    // to free would also be taking away something already paid for
    // permanently — that is a cancellation decision, not a downgrade.
    if (plan === 'lifetime') return res.status(400).json({ error: 'Lifetime plans cannot be downgraded. Contact support if you need to close your account.' });

    if (target === 'pro_monthly') {
      if (sub.plan_key === 'pro_monthly') {
        return res.status(400).json({ error: 'You are already on Pro Monthly' });
      }
      if (sub.plan_key !== 'pro_yearly') {
        return res.status(400).json({ error: 'Only Pro Yearly can switch down to Pro Monthly' });
      }
    }

    if (!sub.expires_at) {
      return res.status(400).json({ error: 'This subscription has no end date to schedule against. Contact support.' });
    }

    await axios.patch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${req.user.id}`,
      {
        pending_plan:     target === 'free' ? 'free' : null,
        pending_plan_key: target === 'pro_monthly' ? 'pro_monthly' : null,
        pending_plan_at:  sub.expires_at,
        updated_at:       new Date().toISOString()
      },
      { headers: supabaseServiceHeaders({ 'Content-Type': 'application/json' }) }
    );

    console.log(`[PLAN] Downgrade scheduled — user=${req.user.id} -> ${target} at ${sub.expires_at}`);
    res.json({ ok: true, target, effectiveAt: sub.expires_at });
  } catch (e) {
    console.error('[PLAN] downgrade failed:', e.response?.data || e.message);
    res.status(500).json({ error: 'Could not schedule the change' });
  }
});

// ── POST /api/plan/downgrade/cancel ─────────────────────────────────
// Undo a scheduled downgrade, any time before it lands.
app.post('/api/plan/downgrade/cancel', requireAuth, async (req, res) => {
  try {
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${req.user.id}`,
      { pending_plan: null, pending_plan_key: null, pending_plan_at: null,
        updated_at: new Date().toISOString() },
      { headers: supabaseServiceHeaders({ 'Content-Type': 'application/json' }) }
    );
    console.log(`[PLAN] Scheduled downgrade cancelled — user=${req.user.id}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[PLAN] downgrade cancel failed:', e.response?.data || e.message);
    res.status(500).json({ error: 'Could not cancel the scheduled change' });
  }
});

// ── Automatic subscription reminders ──────────────────────────
// Renewal 3 days out, and a warning when the saved card expires before
// the next charge. Idempotent per renewal cycle, so restarts and repeat
// deploys cannot double-send.
const reminders = require('./reminders');
reminders.start({ sendTelegramToUser });

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
    const licJ = await resolveLicenceKey(trade.licenceKey);
    const userId = licJ.userId;
    if (!userId) console.warn(`[JOURNAL] Rejected — ${licJ.reason}`);
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

    // Report WHY. The old line here blamed the EA version ("update to
    // v1.4+"), which named the one thing that is almost never the cause —
    // every shipped MathReporter sends licenceKey. That message sent us
    // looking at the terminal while the real fault was on the server.
    const lic = await resolveLicenceKey(body.licenceKey);
    const userId = lic.userId;
    if (!userId) {
      console.warn(`[MATH] Rejected — ${lic.reason}`);
      return res.status(401).json({ error: 'Missing or invalid licenceKey: ' + lic.reason });
    }
    if (lic.graceState === 'grace') {
      console.log(`[MATH] user=${userId} accepted during grace period`);
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
    const st     = getState(userId, resolveSource(req));

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
      // MathReporter uses MT5's position ID as "ticket"; the bridge
      // fallback (main EA) uses the closing DEAL ticket — a DIFFERENT
      // number for the exact same trade. Merging them by ticket used to
      // silently double-count every trade both sources reported (each
      // showing up once with real prices from MathReporter, once with
      // dashes from the bridge). Now that MathReporter is confirmed
      // working, its data alone is used — no merge, no duplicates.
      closedTrades = mathClosed
        .map(t => (!t.open_price || t.open_price === 0) ? (normaliseClosedTrade(userId, accountNumber, { ...t }, 0) || t) : t)
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
