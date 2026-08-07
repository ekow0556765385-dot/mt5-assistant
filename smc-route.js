// smc-route.js v3.0
// CHANGE FROM v2.3: smcStore, confluenceStore, and global.patternStore are
// now keyed by `${userId}::${symbol}` instead of just `${symbol}` — so one
// customer's SMC data (order blocks, FVGs, structure) no longer bleeds into
// another customer's dashboard. userId is resolved from the licenceKey the
// EA now sends on every /smc and /smc/patterns POST (v3.8+ EA required).
//
// GET routes now require login (requirePlan('pro')) and only return the
// logged-in user's own data — matching the pattern already used for
// /api/state, /api/math-data, etc. in app.js.
const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { requirePlan, getUserIdForLicenceKey, getSourceForLicenceKey } = require('./auth-middleware');
const { getChatIdForUser } = require('./telegram-store');

// ── Config ────────────────────────────────────────────────────────
const TELEGRAM_TOKEN           = '8591020831:AAF7m22h7gwmuDWklvbRvnXtpPlNolScwZw';
const TELEGRAM_CHAT_ID         = '770749859';
const CONFLUENCE_PIP_TOLERANCE = 0.0010;

// ── In-memory stores — now keyed by `${userId}::${symbol}` ─────────
// Still exported so app.js can read directly (unchanged from v2.3), but
// callers must now build the same `${userId}::${symbol}` key themselves.
const smcStore        = {};
const confluenceStore = {};
const lastConfluence  = {};

// v3.1: the scope is now user + LICENCE KEY, not user alone. One user can
// hold two keys (a direct terminal and a bridge terminal), and both used to
// resolve to the same user_id — so the second terminal overwrote the first.
function storeKey(scope, symbol, tf) {
  if (!tf || tf.toUpperCase() === 'H1') return `${scope}::${symbol}`;
  return `${scope}::${symbol}::${tf.toUpperCase()}`;
}

// app.js owns the source registry; smc-route just needs to build the same
// scope string. Kept identical to app.js's scopeOf().
function scopeOf(userId, sourceId) {
  return `${userId || 'anonymous'}::${sourceId || 'nokey'}`;
}

// Which feed a dashboard GET should read. app.js publishes the active
// source per user on globalThis so both modules agree without a circular
// require; falls back to any scope this user owns.
function scopeForRequest(req) {
  const userId    = req.user.id;
  const requested = req.query.source;
  const owned     = (globalThis.bwSourcesByUser || {})[userId] || {};
  if (requested && owned[requested]) return scopeOf(userId, requested);
  const newest = Object.values(owned).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0];
  return scopeOf(userId, newest ? newest.sourceId : null);
}

// ── Helpers ───────────────────────────────────────────────────────
async function sendTelegram(message, chatId = TELEGRAM_CHAT_ID) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (e) {
    console.warn('[CONFLUENCE TELEGRAM] Failed:', e.message);
  }
}

// Sends the same confluence alert to the ONE customer whose EA produced it,
// on top of the owner's ops chat above. Silently no-ops if they haven't
// linked Telegram — so unlinked accounts behave exactly as before.
async function sendTelegramToUser(userId, message) {
  try {
    const chatId = await getChatIdForUser(userId);
    if (!chatId) return;
    if (String(chatId) === String(TELEGRAM_CHAT_ID)) return; // owner already got it above
    await sendTelegram(message, chatId);
  } catch (e) {
    console.warn('[CONFLUENCE TELEGRAM] Per-user send failed:', e.message);
  }
}

function priceInZone(price, high, low, tolerance) {
  return price >= (low - tolerance) && price <= (high + tolerance);
}

// ── Confluence detection — now per user+symbol ─────────────────────
function detectConfluence(userId, scope, symbol) {
  const key      = storeKey(scope, symbol);
  const smc      = smcStore[key];
  const patterns = global.patternStore && global.patternStore[key];
  if (!smc || !patterns || !patterns.length) return;

  const obs  = smc.orderBlocks || [];
  const fvgs = smc.fvgs        || [];
  const newAlerts = [];

  for (const pattern of patterns) {
    const price     = parseFloat(pattern.price);
    const direction = pattern.direction;

    const matchingOB = obs.find(ob => {
      const obDir = ob.direction.toLowerCase();
      return obDir === direction &&
             priceInZone(price, parseFloat(ob.high), parseFloat(ob.low), CONFLUENCE_PIP_TOLERANCE);
    });

    const matchingFVG = fvgs.find(fvg => {
      const fvgDir = fvg.direction.toLowerCase();
      return fvgDir === direction &&
             priceInZone(price, parseFloat(fvg.high), parseFloat(fvg.low), CONFLUENCE_PIP_TOLERANCE);
    });

    if (matchingOB && matchingFVG) {
      const confluenceKey = `${key}_${pattern.name}_${pattern.timeframe}`;
      if (lastConfluence[key] === confluenceKey) continue;
      lastConfluence[key] = confluenceKey;

      const alert = {
        id:        Date.now(), symbol,
        timeframe: pattern.timeframe, pattern: pattern.name,
        direction, confidence: pattern.confidence, price,
        ob: matchingOB, fvg: matchingFVG,
        time:  new Date().toISOString(),
        label: direction === 'bullish' ? '🟢 BULLISH CONFLUENCE' : '🔴 BEARISH CONFLUENCE'
      };

      newAlerts.push(alert);
      if (!confluenceStore[key]) confluenceStore[key] = [];
      confluenceStore[key].unshift(alert);
      if (confluenceStore[key].length > 20) confluenceStore[key].pop();

      console.log(`[CONFLUENCE] scope=${scope} ${symbol} ${direction} — ${pattern.name} on OB + FVG @ ${price}`);

      // Owner's ops bot still gets everything (unchanged, single chat), and
      // the alert now also goes to this specific customer's own linked chat
      // via sendTelegramToUser() below — closing the gap flagged here before.
      const dirIcon = direction === 'bullish' ? '🟢' : '🔴';
      const confluenceMsg =
        `${dirIcon} <b>SMC CONFLUENCE ALERT</b>\n` +
        `📊 <b>${symbol}</b> · ${pattern.timeframe}\n` +
        `💰 Price: ${price.toFixed(5)}\n\n` +
        `📐 Pattern: <b>${pattern.name}</b> (${pattern.confidence}%)\n` +
        `🧱 Order Block: ${parseFloat(matchingOB.high).toFixed(5)} – ${parseFloat(matchingOB.low).toFixed(5)}\n` +
        `⬜ Fair Value Gap: ${parseFloat(matchingFVG.high).toFixed(5)} – ${parseFloat(matchingFVG.low).toFixed(5)}\n\n` +
        `⚡ <b>Pattern + OB + FVG aligned — high probability setup</b>`;

      sendTelegram(confluenceMsg);
      sendTelegramToUser(userId, confluenceMsg);
    }
  }
  return newAlerts;
}

// ── POST /smc ─────────────────────────────────────────────────────
// No inline express.json() — global middleware in app.js handles it
router.post('/smc', async (req, res) => {
  const data = req.body;
  if (!data || !data.symbol) return res.status(400).json({ error: 'Missing symbol' });

  const src = await getSourceForLicenceKey(data.licenceKey);
  if (!src) {
    console.warn('[SMC] Rejected — no valid licenceKey. Update EA to v3.8+.');
    return res.status(401).json({ error: 'Missing or invalid licenceKey' });
  }
  const { userId, sourceId } = src;
  const scope = scopeOf(userId, sourceId);

  const key = storeKey(scope, data.symbol, data.timeframe);
  smcStore[key] = { ...data, receivedAt: new Date().toISOString() };
  console.log(`[SMC] scope=${scope} updated ${data.symbol} ${data.timeframe||'H1'} — structure: ${(data.structure||[]).length} OBs: ${(data.orderBlocks||[]).length} FVGs: ${(data.fvgs||[]).length}`);
  // Confluence detection stays scoped to the default (H1) timeframe only for
  // now — not part of this change, so left exactly as it worked before.
  if (!data.timeframe || data.timeframe.toUpperCase() === 'H1') {
    detectConfluence(userId, scope, data.symbol);
  }
  res.json({ ok: true, symbol: data.symbol });
});

// ── POST /smc/patterns ────────────────────────────────────────────
// No inline express.json() — global middleware in app.js handles it
router.post('/smc/patterns', async (req, res) => {
  const { symbol, patterns, licenceKey } = req.body;
  if (!symbol || !patterns) return res.status(400).json({ error: 'Missing fields' });

  const src = await getSourceForLicenceKey(licenceKey);
  if (!src) return res.status(401).json({ error: 'Missing or invalid licenceKey' });
  const scope = scopeOf(src.userId, src.sourceId);

  if (!global.patternStore) global.patternStore = {};
  const key = storeKey(scope, symbol);
  global.patternStore[key] = patterns;
  const alerts = detectConfluence(src.userId, scope, symbol);
  res.json({ ok: true, confluenceFound: (alerts && alerts.length > 0) });
});

// ── GET /smc — only this user's own symbols, prefix stripped ──────
// Only returns default-timeframe (H1) entries — excludes the newer
// `${userId}::${symbol}::${tf}` keys (e.g. H4) so they don't show up
// here as bogus symbols like "EURUSD::H4". Unchanged behavior for
// every existing caller (dashboard, agent-module.js via app.js).
router.get('/smc', requirePlan('pro'), (req, res) => {
  const prefix = `${scopeForRequest(req)}::`;
  const out = {};
  Object.keys(smcStore).forEach(k => {
    if (!k.startsWith(prefix)) return;
    const rest = k.slice(prefix.length);
    if (rest.includes('::')) return; // skip non-default-timeframe entries
    out[rest] = smcStore[k];
  });
  res.json(out);
});

// ── GET /smc/tf/:tf — NEW — same shape as GET /smc above, but for a
// specific non-default timeframe (e.g. /smc/tf/H4). Used by the
// SMC panel's own H1/H4 toggle — doesn't affect the default /smc route,
// the dashboard, or agent-module.js at all.
router.get('/smc/tf/:tf', requirePlan('pro'), (req, res) => {
  const tf     = req.params.tf.toUpperCase();
  const prefix = `${scopeForRequest(req)}::`;
  const suffix = `::${tf}`;
  const out = {};
  Object.keys(smcStore).forEach(k => {
    if (k.startsWith(prefix) && k.endsWith(suffix)) {
      const sym = k.slice(prefix.length, k.length - suffix.length);
      out[sym] = smcStore[k];
    }
  });
  res.json(out);
});

// ── GET /smc/:symbol ──────────────────────────────────────────────
// v2.3 fix retained: tries exact → uppercase → strip Exness 'c' suffix
// so GBPUSDc, GBPUSDC, and GBPUSD all resolve correctly — now scoped to
// the logged-in user's own data only.
// Broker symbol suffixes: Exness uses GBPUSDc on cent accounts and
// GBPUSDm on dollar accounts, plus .z / e / k elsewhere. Stripping a
// trailing "C" only (as this did) meant every dollar-account symbol
// missed. Same guard as the dashboards: only strip when what's left is a
// real pair, so PLATINUM isn't mangled into PLATIN.
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

router.get('/smc/:symbol', requirePlan('pro'), (req, res) => {
  const raw  = req.params.symbol;
  const up   = raw.toUpperCase();
  const sc   = scopeForRequest(req);
  let data = smcStore[storeKey(sc, raw)]
          || smcStore[storeKey(sc, up)]
          || null;

  // Nothing under the literal symbol — match on the normalised pair, so a
  // request for GBPUSD finds data the EA stored as GBPUSDm or GBPUSDc.
  if (!data) {
    const want   = normalisePair(raw);
    const prefix = `${sc}::`;
    const hit = Object.keys(smcStore).find(k => {
      if (!k.startsWith(prefix)) return false;
      const rest = k.slice(prefix.length);
      if (rest.includes('::')) return false;
      return normalisePair(rest) === want;
    });
    if (hit) data = smcStore[hit];
  }
  if (!data) return res.status(404).json({ error: `No SMC data for ${raw}` });
  res.json(data);
});

// ── GET /confluence ───────────────────────────────────────────────
router.get('/confluence', requirePlan('pro'), (req, res) => {
  const prefix = `${scopeForRequest(req)}::`;
  const out = {};
  Object.keys(confluenceStore).forEach(k => {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = confluenceStore[k];
  });
  res.json(out);
});
router.get('/confluence/:symbol', requirePlan('pro'), (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  res.json(confluenceStore[storeKey(scopeForRequest(req), sym)] || []);
});

// ── EXPORT router AND smcStore ────────────────────────────────────
// smcStore exported so app.js /api/analyse can read it directly —
// app.js now builds the same `${userId}::${symbol}` key itself (updated
// alongside this file) instead of the old plain-symbol key.
module.exports          = router;
module.exports.smcStore = smcStore;
module.exports.storeKey = storeKey;
