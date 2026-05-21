// smc-route.js v2 — with confluence detection
const express = require('express');
const router  = express.Router();
const axios   = require('axios');

// ── Config ────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = '8591020831:AAF7m22h7gwmuDWklvbRvnXtpPlNolScwZw';
const TELEGRAM_CHAT_ID = '770749859';
const CONFLUENCE_PIP_TOLERANCE = 0.0010; // Price must be within this range of OB/FVG

// ── In-memory stores ──────────────────────────────────────────────
const smcStore        = {};   // Latest SMC data per symbol
const confluenceStore = {};   // Latest confluence alerts per symbol
const lastConfluence  = {};   // Dedup: last alerted confluence key per symbol

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
// Called whenever new SMC data arrives AND whenever new pattern arrives
function detectConfluence(symbol) {
  const smc      = smcStore[symbol];
  const patterns = global.patternStore && global.patternStore[symbol];

  if (!smc || !patterns || !patterns.length) return;

  const obs  = smc.orderBlocks || [];
  const fvgs = smc.fvgs        || [];

  const newAlerts = [];

  for (const pattern of patterns) {
    const price     = parseFloat(pattern.price);
    const direction = pattern.direction; // 'bullish' or 'bearish'

    // Find matching OB (same direction, price in zone)
    const matchingOB = obs.find(ob => {
      const obDir = ob.direction.toLowerCase();
      return obDir === direction &&
             priceInZone(price, parseFloat(ob.high), parseFloat(ob.low), CONFLUENCE_PIP_TOLERANCE);
    });

    // Find matching FVG (same direction, price in zone)
    const matchingFVG = fvgs.find(fvg => {
      const fvgDir = fvg.direction.toLowerCase();
      return fvgDir === direction &&
             priceInZone(price, parseFloat(fvg.high), parseFloat(fvg.low), CONFLUENCE_PIP_TOLERANCE);
    });

    // Only flag if BOTH OB and FVG match — strongest signal
    if (matchingOB && matchingFVG) {
      const confluenceKey = `${symbol}_${pattern.name}_${pattern.timeframe}`;

      // Deduplicate
      if (lastConfluence[symbol] === confluenceKey) continue;
      lastConfluence[symbol] = confluenceKey;

      const alert = {
        id:          Date.now(),
        symbol,
        timeframe:   pattern.timeframe,
        pattern:     pattern.name,
        direction,
        confidence:  pattern.confidence,
        price,
        ob:          matchingOB,
        fvg:         matchingFVG,
        time:        new Date().toISOString(),
        label:       direction === 'bullish' ? '🟢 BULLISH CONFLUENCE' : '🔴 BEARISH CONFLUENCE'
      };

      newAlerts.push(alert);

      // Store
      if (!confluenceStore[symbol]) confluenceStore[symbol] = [];
      confluenceStore[symbol].unshift(alert);
      if (confluenceStore[symbol].length > 20) confluenceStore[symbol].pop();

      console.log(`[CONFLUENCE] ${symbol} ${direction} — ${pattern.name} on OB + FVG @ ${price}`);

      // Telegram
      const dirIcon = direction === 'bullish' ? '🟢' : '🔴';
      const msg =
        `${dirIcon} <b>SMC CONFLUENCE ALERT</b>\n` +
        `📊 <b>${symbol}</b> · ${pattern.timeframe}\n` +
        `💰 Price: ${price.toFixed(5)}\n\n` +
        `📐 Pattern: <b>${pattern.name}</b> (${pattern.confidence}%)\n` +
        `🧱 Order Block: ${parseFloat(matchingOB.high).toFixed(5)} – ${parseFloat(matchingOB.low).toFixed(5)}\n` +
        `⬜ Fair Value Gap: ${parseFloat(matchingFVG.high).toFixed(5)} – ${parseFloat(matchingFVG.low).toFixed(5)}\n\n` +
        `⚡ <b>Pattern + OB + FVG aligned — high probability setup</b>`;

      sendTelegram(msg);
    }
  }

  return newAlerts;
}

// ── POST /smc  (MT5 EA sends SMC data) ───────────────────────────
router.post('/smc', express.json(), (req, res) => {
  const data = req.body;
  if (!data || !data.symbol) return res.status(400).json({ error: 'Missing symbol' });

  smcStore[data.symbol] = { ...data, receivedAt: new Date().toISOString() };
  console.log(`[SMC] Updated ${data.symbol}`);

  // Run confluence check with latest patterns
  detectConfluence(data.symbol);

  res.json({ ok: true, symbol: data.symbol });
});

// ── POST /smc/patterns  (called from app.js when pattern fires) ──
router.post('/smc/patterns', express.json(), (req, res) => {
  const { symbol, patterns } = req.body;
  if (!symbol || !patterns) return res.status(400).json({ error: 'Missing fields' });

  if (!global.patternStore) global.patternStore = {};
  global.patternStore[symbol] = patterns;

  // Run confluence check
  const alerts = detectConfluence(symbol);
  res.json({ ok: true, confluenceFound: (alerts && alerts.length > 0) });
});

// ── GET /smc ──────────────────────────────────────────────────────
router.get('/smc', (req, res) => res.json(smcStore));

// ── GET /smc/:symbol ──────────────────────────────────────────────
router.get('/smc/:symbol', (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  if (!smcStore[sym]) return res.status(404).json({ error: `No SMC data for ${sym}` });
  res.json(smcStore[sym]);
});

// ── GET /confluence ───────────────────────────────────────────────
router.get('/confluence', (req, res) => res.json(confluenceStore));

// ── GET /confluence/:symbol ───────────────────────────────────────
router.get('/confluence/:symbol', (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  res.json(confluenceStore[sym] || []);
});

module.exports = router;
