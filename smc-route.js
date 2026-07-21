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
const { requirePlan, getUserIdForLicenceKey } = require('./auth-middleware');

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

function storeKey(userId, symbol) { return `${userId}::${symbol}`; }

// ── Helpers ───────────────────────────────────────────────────────
async function sendTelegram(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (e) {
    console.warn('[CONFLUENCE TELEGRAM] Failed:', e.message);
  }
}

function priceInZone(price, high, low, tolerance) {
  return price >= (low - tolerance) && price <= (high + tolerance);
}

// ── Confluence detection — now per user+symbol ─────────────────────
function detectConfluence(userId, symbol) {
  const key      = storeKey(userId, symbol);
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

      console.log(`[CONFLUENCE] user=${userId} ${symbol} ${direction} — ${pattern.name} on OB + FVG @ ${price}`);

      // Owner's ops bot still gets everything (unchanged, single chat).
      // Per-customer Telegram alerts for confluence aren't wired up yet —
      // same gap flagged earlier for pattern alerts in app.js; needs
      // telegram-store.js's per-user chat-id lookup to close properly.
      const dirIcon = direction === 'bullish' ? '🟢' : '🔴';
      sendTelegram(
        `${dirIcon} <b>SMC CONFLUENCE ALERT</b>\n` +
        `📊 <b>${symbol}</b> · ${pattern.timeframe}\n` +
        `💰 Price: ${price.toFixed(5)}\n\n` +
        `📐 Pattern: <b>${pattern.name}</b> (${pattern.confidence}%)\n` +
        `🧱 Order Block: ${parseFloat(matchingOB.high).toFixed(5)} – ${parseFloat(matchingOB.low).toFixed(5)}\n` +
        `⬜ Fair Value Gap: ${parseFloat(matchingFVG.high).toFixed(5)} – ${parseFloat(matchingFVG.low).toFixed(5)}\n\n` +
        `⚡ <b>Pattern + OB + FVG aligned — high probability setup</b>`
      );
    }
  }
  return newAlerts;
}

// ── POST /smc ─────────────────────────────────────────────────────
// No inline express.json() — global middleware in app.js handles it
router.post('/smc', async (req, res) => {
  const data = req.body;
  if (!data || !data.symbol) return res.status(400).json({ error: 'Missing symbol' });

  const userId = await getUserIdForLicenceKey(data.licenceKey);
  if (!userId) {
    console.warn('[SMC] Rejected — no valid licenceKey. Update EA to v3.8+.');
    return res.status(401).json({ error: 'Missing or invalid licenceKey' });
  }

  const key = storeKey(userId, data.symbol);
  smcStore[key] = { ...data, receivedAt: new Date().toISOString() };
  console.log(`[SMC] user=${userId} updated ${data.symbol} — structure: ${(data.structure||[]).length} OBs: ${(data.orderBlocks||[]).length} FVGs: ${(data.fvgs||[]).length}`);
  detectConfluence(userId, data.symbol);
  res.json({ ok: true, symbol: data.symbol });
});

// ── POST /smc/patterns ────────────────────────────────────────────
// No inline express.json() — global middleware in app.js handles it
router.post('/smc/patterns', async (req, res) => {
  const { symbol, patterns, licenceKey } = req.body;
  if (!symbol || !patterns) return res.status(400).json({ error: 'Missing fields' });

  const userId = await getUserIdForLicenceKey(licenceKey);
  if (!userId) return res.status(401).json({ error: 'Missing or invalid licenceKey' });

  if (!global.patternStore) global.patternStore = {};
  const key = storeKey(userId, symbol);
  global.patternStore[key] = patterns;
  const alerts = detectConfluence(userId, symbol);
  res.json({ ok: true, confluenceFound: (alerts && alerts.length > 0) });
});

// ── GET /smc — only this user's own symbols, prefix stripped ──────
router.get('/smc', requirePlan('pro'), (req, res) => {
  const prefix = `${req.user.id}::`;
  const out = {};
  Object.keys(smcStore).forEach(k => {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = smcStore[k];
  });
  res.json(out);
});

// ── GET /smc/:symbol ──────────────────────────────────────────────
// v2.3 fix retained: tries exact → uppercase → strip Exness 'c' suffix
// so GBPUSDc, GBPUSDC, and GBPUSD all resolve correctly — now scoped to
// the logged-in user's own data only.
router.get('/smc/:symbol', requirePlan('pro'), (req, res) => {
  const raw  = req.params.symbol;
  const up   = raw.toUpperCase();
  const uid  = req.user.id;
  const data = smcStore[storeKey(uid, raw)]
            || smcStore[storeKey(uid, up)]
            || smcStore[storeKey(uid, up.replace(/C$/, ''))]
            || null;
  if (!data) return res.status(404).json({ error: `No SMC data for ${raw}` });
  res.json(data);
});

// ── GET /confluence ───────────────────────────────────────────────
router.get('/confluence', requirePlan('pro'), (req, res) => {
  const prefix = `${req.user.id}::`;
  const out = {};
  Object.keys(confluenceStore).forEach(k => {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = confluenceStore[k];
  });
  res.json(out);
});
router.get('/confluence/:symbol', requirePlan('pro'), (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  res.json(confluenceStore[storeKey(req.user.id, sym)] || []);
});

// ── EXPORT router AND smcStore ────────────────────────────────────
// smcStore exported so app.js /api/analyse can read it directly —
// app.js now builds the same `${userId}::${symbol}` key itself (updated
// alongside this file) instead of the old plain-symbol key.
module.exports          = router;
module.exports.smcStore = smcStore;
module.exports.storeKey = storeKey;
