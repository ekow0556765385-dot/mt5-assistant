// smc-route.js
// Add this to your existing server.js (or require it there)
// Usage in server.js:
//   const smcRoute = require('./smc-route');
//   app.use(smcRoute);

const express = require('express');
const router  = express.Router();

// In-memory store — last SMC payload per symbol
const smcStore = {};

// ── POST /smc  (called by MT5 indicator every N seconds)
router.post('/smc', express.json(), (req, res) => {
  const data = req.body;
  if (!data || !data.symbol) {
    return res.status(400).json({ error: 'Missing symbol field' });
  }

  smcStore[data.symbol] = {
    ...data,
    receivedAt: new Date().toISOString(),
  };

  console.log(`[SMC] Received update for ${data.symbol} at ${smcStore[data.symbol].receivedAt}`);
  res.json({ ok: true, symbol: data.symbol });
});

// ── GET /smc  (called by dashboard to fetch all symbols)
router.get('/smc', (req, res) => {
  res.json(smcStore);
});

// ── GET /smc/:symbol  (fetch one symbol)
router.get('/smc/:symbol', (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  if (!smcStore[sym]) {
    return res.status(404).json({ error: `No SMC data for ${sym}` });
  }
  res.json(smcStore[sym]);
});

module.exports = router;
