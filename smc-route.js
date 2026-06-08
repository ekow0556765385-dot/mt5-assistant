// smc-route.js v2.3
// Fix: GET /smc/:symbol now tries exact match, then uppercase, then strips
//      trailing 'c' (Exness suffix) so GBPUSDc resolves correctly.
//      v2.2 fix retained: no inline express.json() on POST handlers.
const express = require('express');
const router  = express.Router();
const axios   = require('axios');

// ── Config ────────────────────────────────────────────────────────
const TELEGRAM_TOKEN           = '8591020831:AAF7m22h7gwmuDWklvbRvnXtpPlNolScwZw';
const TELEGRAM_CHAT_ID         = '770749859';
const CONFLUENCE_PIP_TOLERANCE = 0.0010;

// ── In-memory stores (exported so app.js can access directly) ─────
const smcStore        = {};
const confluenceStore = {};
const lastConfluence  = {};

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

// ── Confluence detection ──────────────────────────────────────────
function detectConfluence(symbol) {
  const smc      = smcStore[symbol];
  const patterns = global.patternStore && global.patternStore[symbol];
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
      const confluenceKey = `${symbol}_${pattern.name}_${pattern.timeframe}`;
      if (lastConfluence[symbol] === confluenceKey) continue;
      lastConfluence[symbol] = confluenceKey;

      const alert = {
        id:        Date.now(), symbol,
        timeframe: pattern.timeframe, pattern: pattern.name,
        direction, confidence: pattern.confidence, price,
        ob: matchingOB, fvg: matchingFVG,
        time:  new Date().toISOString(),
        label: direction === 'bullish' ? '🟢 BULLISH CONFLUENCE' : '🔴 BEARISH CONFLUENCE'
      };

      newAlerts.push(alert);
      if (!confluenceStore[symbol]) confluenceStore[symbol] = [];
      confluenceStore[symbol].unshift(alert);
      if (confluenceStore[symbol].length > 20) confluenceStore[symbol].pop();

      console.log(`[CONFLUENCE] ${symbol} ${direction} — ${pattern.name} on OB + FVG @ ${price}`);

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
router.post('/smc', (req, res) => {
  const data = req.body;
  if (!data || !data.symbol) return res.status(400).json({ error: 'Missing symbol' });
  smcStore[data.symbol] = { ...data, receivedAt: new Date().toISOString() };
  console.log(`[SMC] Updated ${data.symbol} — structure: ${(data.structure||[]).length} OBs: ${(data.orderBlocks||[]).length} FVGs: ${(data.fvgs||[]).length}`);
  detectConfluence(data.symbol);
  res.json({ ok: true, symbol: data.symbol });
});

// ── POST /smc/patterns ────────────────────────────────────────────
// No inline express.json() — global middleware in app.js handles it
router.post('/smc/patterns', (req, res) => {
  const { symbol, patterns } = req.body;
  if (!symbol || !patterns) return res.status(400).json({ error: 'Missing fields' });
  if (!global.patternStore) global.patternStore = {};
  global.patternStore[symbol] = patterns;
  const alerts = detectConfluence(symbol);
  res.json({ ok: true, confluenceFound: (alerts && alerts.length > 0) });
});

// ── GET /smc ──────────────────────────────────────────────────────
router.get('/smc', (req, res) => res.json(smcStore));

// ── GET /smc/:symbol ──────────────────────────────────────────────
// v2.3 fix: tries exact → uppercase → strip Exness 'c' suffix
// so GBPUSDc, GBPUSDC, and GBPUSD all resolve correctly
router.get('/smc/:symbol', (req, res) => {
  const raw  = req.params.symbol;
  const up   = raw.toUpperCase();
  const data = smcStore[raw]
            || smcStore[up]
            || smcStore[up.replace(/C$/, '')]
            || null;
  if (!data) return res.status(404).json({ error: `No SMC data for ${raw}` });
  res.json(data);
});

// ── GET /confluence ───────────────────────────────────────────────
router.get('/confluence',         (req, res) => res.json(confluenceStore));
router.get('/confluence/:symbol', (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  res.json(confluenceStore[sym] || []);
});

// ── EXPORT router AND smcStore ────────────────────────────────────
// smcStore exported so app.js /api/analyse can read it directly
// without making an internal HTTP call
module.exports          = router;
module.exports.smcStore = smcStore;
