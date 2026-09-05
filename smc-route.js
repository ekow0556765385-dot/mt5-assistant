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
const { getChatIdForUser, getWatchPairsForUser, getPlanForUser } = require('./telegram-store');

// ── Config ────────────────────────────────────────────────────────
// Bot credentials come from telegram-config.js. This file previously
// hardcoded its own TELEGRAM_TOKEN, which was left pointing at the OLD
// decommissioned bot after app.js was moved to the current Blackwood bot —
// so every confluence alert went to a dead bot and was swallowed by the
// catch in sendTelegram() below. Never re-declare a token here.
const { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID } = require('./telegram-config');
const CONFLUENCE_PIP_TOLERANCE = 0.0010;

// ── In-memory stores — now keyed by `${userId}::${symbol}` ─────────
// Still exported so app.js can read directly (unchanged from v2.3), but
// callers must now build the same `${userId}::${symbol}` key themselves.
const smcStore        = {};
const confluenceStore = {};

/* How long the same confluence stays quiet after firing. A pattern sits
   inside the same order block for many bars, so without this the alert
   repeats on every payload for as long as price stays there. */
const CONFLUENCE_COOLDOWN_MS = 30 * 60 * 1000;

/* Restart storm guard. lastConfluence lives only in memory, so every
   restart wipes it and the next payload looks like a book of brand-new
   confluences. The FIRST sighting of a key after boot is recorded
   silently; a genuinely new one still alerts on the next cycle. */
const primedConfluence = new Set();
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
  const userId = req.user.id;

  // Use app.js's resolver so this module and /api/state can never disagree
  // about which feed the user is looking at. Duplicating the rule here is
  // what caused the SMC panel to read an empty scope while the MT5 Assistant
  // showed data on the very same account.
  const resolve = globalThis.bwResolveSource;
  if (typeof resolve === 'function') {
    try {
      const sourceId = resolve(req);
      if (sourceId) return scopeOf(userId, sourceId);
    } catch (e) {
      console.warn('[SMC] bwResolveSource failed, falling back:', e.message);
    }
  }

  // Fallback only for an app.js too old to publish the resolver.
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
    // Telegram answers 401 Unauthorized for a revoked/decommissioned bot
    // token and 400 for a bad chat_id. The old message hid which, so a dead
    // bot looked identical to a user who simply hadn't linked their chat.
    // Name the status and the reason so this is diagnosable from the logs.
    const status = e.response && e.response.status;
    const desc   = (e.response && e.response.data && e.response.data.description) || e.message;
    if (status === 401) {
      console.error('[CONFLUENCE TELEGRAM] 401 — bot token rejected. The token in telegram-config.js is invalid or revoked; alerts are NOT being delivered.');
    } else {
      console.warn(`[CONFLUENCE TELEGRAM] Failed (${status || 'no response'}): ${desc}`);
    }
  }
}

// Sends the same confluence alert to the ONE customer whose EA produced it,
// on top of the owner's ops chat above. Silently no-ops if they haven't
// linked Telegram — so unlinked accounts behave exactly as before.
async function sendTelegramToUser(userId, message, symbol) {
  try {
    const chatId = await getChatIdForUser(userId);
    if (!chatId) return;

    // Respect the user's pair selection (the free tier's 3-pair cap lives
    // there). A null list means they never chose - send everything rather
    // than silently muting an account that has made no decision.
    if (symbol) {
      const pairs = await getWatchPairsForUser(userId);
      if (pairs && !pairs.includes(normalisePair(symbol))) return;
    }
    if (String(chatId) === String(TELEGRAM_CHAT_ID)) return; // owner already got it above

    // Label free-tier alerts. An SMC confluence is NOT the combined signal a
    // Pro subscriber gets — no RSI/EMA/trend agreement, no conviction score,
    // no pattern confirmation, no Risk Radar. Sending it unlabelled lets a
    // free user believe they are already receiving the paid product, which
    // is both misleading and the reason they never see a reason to upgrade.
    const plan = await getPlanForUser(userId);
    const body = (plan === 'free')
      ? message +
        '\n\n— — —\n' +
        'FREE TIER · SMC confluence only\n' +
        'This is a structure alert: an order block or FVG lining up with price. ' +
        'It is not a trade signal and carries no conviction score.\n' +
        'Pro adds the combined signal (H4/H1 trend, RSI, EMA 20/50, candlestick ' +
        'patterns, price vs pivot), Risk Radar manipulation warnings, all 6 pairs ' +
        'instead of 3, and the full dashboard.\n' +
        'blackwoodmt5.com/account'
      : message;

    await sendTelegram(body, chatId);
  } catch (e) {
    console.warn('[CONFLUENCE TELEGRAM] Per-user send failed:', e.message);
  }
}

function priceInZone(price, high, low, tolerance) {
  return price >= (low - tolerance) && price <= (high + tolerance);
}

// ── Confluence detection — now per user+symbol+TIMEFRAME ──────────
// v3.2: was H1-only. The SMC store has always been keyed per timeframe
// (`scope::SYMBOL::H4`), but detectConfluence only ever read the default
// H1 key and POST /smc only called it for H1 — so an H4 order block that
// lined up with an H4 pattern produced no alert and no Telegram message.
// Now runs for whichever timeframe the data arrived on.
function detectConfluence(userId, scope, symbol, tf) {
  const key      = storeKey(scope, symbol, tf);
  const smc      = smcStore[key];
  const patterns = global.patternStore && global.patternStore[key];
  if (!smc || !patterns || !patterns.length) return;

  const tfLabel = (tf && tf.toUpperCase()) || 'H1';
  const obs  = smc.orderBlocks || [];
  const fvgs = smc.fvgs        || [];
  const newAlerts = [];
  const candidates = [];

  for (const pattern of patterns) {
    // A pattern carries its own timeframe. Only pair it with SMC zones from
    // the SAME timeframe — an H1 doji sitting inside an H4 order block is
    // not an H4 confluence signal.
    const patTf = (pattern.timeframe || 'H1').toUpperCase();
    if (patTf !== tfLabel) continue;

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
      /* Collected, not sent. Two things have to be decided across the
         WHOLE payload rather than per pattern: whether this exact
         confluence was already sent recently, and whether the payload
         contains contradictory directions. Sending inside the loop made
         both impossible. */
      candidates.push({ pattern, price, direction, matchingOB, matchingFVG });
      continue;
    }
  }

  /* CONTRADICTION GUARD.
     A payload can contain a bullish confluence and a bearish one at the
     same price on the same timeframe — opposing order blocks and gaps
     genuinely do overlap. Sending both tells the trader to buy and sell
     the same candle, which is worse than sending nothing: it is not two
     signals, it is the absence of one. Keep the higher-confidence side
     and say plainly that the other existed. */
  let conflicted = null;
  if (candidates.length > 1) {
    const dirs = new Set(candidates.map(c => c.direction));
    if (dirs.size > 1) {
      candidates.sort((a, b) => (parseFloat(b.pattern.confidence) || 0) - (parseFloat(a.pattern.confidence) || 0));
      const kept = candidates[0];
      conflicted = candidates.filter(c => c.direction !== kept.direction)
                             .map(c => `${c.pattern.name} ${c.direction} ${c.pattern.confidence}%`);
      candidates.length = 0;
      candidates.push(kept);
      console.warn(`[CONFLUENCE] ${symbol} ${tfLabel} — opposing confluences in one payload; ` +
                   `kept ${kept.direction} ${kept.pattern.name} (${kept.pattern.confidence}%), ` +
                   `suppressed: ${conflicted.join(', ')}`);
    }
  }

  for (const cand of candidates) {
    const pattern = cand.pattern, price = cand.price, direction = cand.direction;
    const matchingOB = cand.matchingOB, matchingFVG = cand.matchingFVG;
    {
      /* DEDUPE, per confluence rather than per key.
         This used to be ONE slot per symbol+timeframe holding the last
         key seen. With several patterns in a payload each one differed
         from whatever the previous had stored, so nothing was ever
         deduped and two alternating patterns re-fired each other
         indefinitely. Each distinct confluence now carries its own
         timestamp and a cooldown. */
      const confluenceKey = `${pattern.name}|${pattern.timeframe}|${direction}`;
      if (!lastConfluence[key] || typeof lastConfluence[key] !== 'object') lastConfluence[key] = {};
      const seen = lastConfluence[key];
      const now = Date.now();

      if (seen[confluenceKey] && (now - seen[confluenceKey]) < CONFLUENCE_COOLDOWN_MS) continue;

      // First sighting since boot — record it without alerting, so a
      // restart does not replay the whole book (see primedConfluence).
      if (!primedConfluence.has(key)) {
        primedConfluence.add(key);
        seen[confluenceKey] = now;
        console.log(`[SMC] primed ${key} — no alert, first sighting since restart`);
        continue;
      }
      seen[confluenceKey] = now;

      // Keep the per-key map from growing without bound.
      const keys = Object.keys(seen);
      if (keys.length > 40) {
        keys.sort((a, b) => seen[a] - seen[b]).slice(0, keys.length - 40)
            .forEach(k => { delete seen[k]; });
      }

      const alert = {
        id:        Date.now(), symbol,
        timeframe: pattern.timeframe || tfLabel, pattern: pattern.name,
        direction, confidence: pattern.confidence, price,
        ob: matchingOB, fvg: matchingFVG,
        time:  new Date().toISOString(),
        label: direction === 'bullish' ? '🟢 BULLISH CONFLUENCE' : '🔴 BEARISH CONFLUENCE'
      };

      newAlerts.push(alert);
      if (!confluenceStore[key]) confluenceStore[key] = [];
      confluenceStore[key].unshift(alert);
      if (confluenceStore[key].length > 20) confluenceStore[key].pop();

      console.log(`[CONFLUENCE] scope=${scope} ${symbol} ${tfLabel} ${direction} — ${pattern.name} on OB + FVG @ ${price}`);

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
        `⚡ <b>Pattern + OB + FVG aligned</b>` +
        (conflicted && conflicted.length
          ? `\n\n⚠️ An opposing confluence also fired on this candle (${conflicted.join(', ')}). ` +
            `Both sides being present is itself a reason for caution.`
          : '');

      sendTelegram(confluenceMsg);
      sendTelegramToUser(userId, confluenceMsg, symbol);
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
  // v3.2 — run for whichever timeframe just arrived, not H1 only.
  detectConfluence(userId, scope, data.symbol, data.timeframe);
  res.json({ ok: true, symbol: data.symbol });
});

// ── POST /smc/patterns ────────────────────────────────────────────
// No inline express.json() — global middleware in app.js handles it
router.post('/smc/patterns', async (req, res) => {
  const { symbol, patterns, licenceKey, timeframe } = req.body;
  if (!symbol || !patterns) return res.status(400).json({ error: 'Missing fields' });

  const src = await getSourceForLicenceKey(licenceKey);
  if (!src) return res.status(401).json({ error: 'Missing or invalid licenceKey' });
  const scope = scopeOf(src.userId, src.sourceId);

  if (!global.patternStore) global.patternStore = {};
  const tf  = timeframe || (patterns[0] && patterns[0].timeframe) || 'H1';
  const key = storeKey(scope, symbol, tf);
  global.patternStore[key] = patterns;
  const alerts = detectConfluence(src.userId, scope, symbol, tf);
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
// confluenceStore is keyed per timeframe now (`scope::SYMBOL::H4`), so H1
// and H4 alerts for the same pair no longer overwrite each other. Callers
// (SMC panel, Brain) do Object.values(confData).flat() and read alert.symbol
// / alert.timeframe off each alert, so merge the timeframes back under one
// symbol key here — the response shape is unchanged from their point of view.
router.get('/confluence', requirePlan('pro'), (req, res) => {
  const prefix = `${scopeForRequest(req)}::`;
  const out = {};
  Object.keys(confluenceStore).forEach(k => {
    if (!k.startsWith(prefix)) return;
    const rest = k.slice(prefix.length);
    const sym  = rest.includes('::') ? rest.slice(0, rest.indexOf('::')) : rest;
    if (!out[sym]) out[sym] = [];
    out[sym] = out[sym].concat(confluenceStore[k] || []);
  });
  // Newest first across the merged timeframes.
  Object.keys(out).forEach(sym => out[sym].sort((a, b) => new Date(b.time) - new Date(a.time)));
  res.json(out);
});
router.get('/confluence/:symbol', requirePlan('pro'), (req, res) => {
  const sym   = req.params.symbol.toUpperCase();
  const scope = scopeForRequest(req);
  // Optional ?tf=H4; without it, every timeframe for this symbol.
  if (req.query.tf) return res.json(confluenceStore[storeKey(scope, sym, req.query.tf)] || []);
  const prefix = `${scope}::${sym}`;
  let out = [];
  Object.keys(confluenceStore).forEach(k => {
    if (k === prefix || k.startsWith(`${prefix}::`)) out = out.concat(confluenceStore[k] || []);
  });
  out.sort((a, b) => new Date(b.time) - new Date(a.time));
  res.json(out);
});

// ── EXPORT router AND smcStore ────────────────────────────────────
// smcStore exported so app.js /api/analyse can read it directly —
// app.js now builds the same `${userId}::${symbol}` key itself (updated
// alongside this file) instead of the old plain-symbol key.
module.exports          = router;
module.exports.smcStore = smcStore;
module.exports.storeKey = storeKey;
module.exports.scopeOf  = scopeOf;

// In-process pattern ingest — replaces app.js's self-POST to
// /smc/patterns. That call sent NO licenceKey, so getSourceForLicenceKey()
// returned null and the route answered 401 every single time: patternStore
// was never populated, detectConfluence() always bailed at its
// `!patterns` guard, and /confluence therefore returned {} for EVERY user
// on BOTH transports. The SMC panel's confluence alert list has been dead
// since the licence-scoping change.
//
// Calling in-process also removes an HTTP round-trip to ourselves and the
// need for the caller to know a licence key it never had — app.js already
// holds the resolved userId + sourceId at that point.
module.exports.ingestPatterns = function ingestPatterns(userId, sourceId, symbol, patterns, timeframe) {
  if (!symbol || !patterns || !patterns.length) return null;
  const scope = scopeOf(userId, sourceId);
  if (!global.patternStore) global.patternStore = {};
  const tf = timeframe || (patterns[0] && patterns[0].timeframe) || 'H1';
  global.patternStore[storeKey(scope, symbol, tf)] = patterns;
  return detectConfluence(userId, scope, symbol, tf);
};
