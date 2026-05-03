/**
 * MT5 Trading Assistant — Backend Server
 * ----------------------------------------
 * Receives live data from MT5 EA via POST /api/update
 * Fetches high-impact forex news (ForexFactory calendar)
 * Analyzes trade errors & performance
 * Pushes real-time updates to dashboard via WebSocket
 *
 * Run: node server.js
 * Then open dashboard.html in your browser
 */

const express   = require("express");
const cors      = require("cors");
const http      = require("http");
const WebSocket = require("ws");
const axios     = require("axios");
const cron      = require("node-cron");
const path      = require("path");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "../dashboard")));

// ─── In-memory state ──────────────────────────────────────────────
let state = {
  latestTick:    null,   // most recent MT5 payload
  candles:       [],     // rolling candle history
  patterns:      [],     // detected patterns
  openTrades:    [],     // current open positions
  closedTrades:  [],     // historical trade log (from MT5 history)
  accountInfo:   {},
  newsEvents:    [],     // forex calendar events
  tradeErrors:   [],     // error analysis results
  performance:   {},     // computed stats
  lastUpdated:   null,
};

// ─── WebSocket broadcast ─────────────────────────────────────────
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on("connection", ws => {
  console.log("Dashboard connected via WebSocket");
  // Send current state immediately on connect
  ws.send(JSON.stringify({ type: "FULL_STATE", data: state }));
});

// ─── Route: Receive MT5 EA data ──────────────────────────────────
app.post("/api/update", (req, res) => {
  const payload = req.body;
  if (!payload || !payload.symbol) return res.status(400).json({ error: "Invalid payload" });

  state.latestTick  = payload;
  state.lastUpdated = new Date().toISOString();

  // Update candles — rolling 200-bar buffer per symbol+timeframe
  if (payload.candles && Array.isArray(payload.candles)) {
    state.candles = payload.candles; // latest 50 bars from EA
  }

  // Update patterns
  if (payload.patterns && Array.isArray(payload.patterns)) {
    state.patterns = payload.patterns.map(p => ({
      ...p,
      symbol:    payload.symbol,
      timeframe: payload.timeframe,
      detectedAt: Date.now(),
    }));
  }

  // Update open trades
  if (payload.openTrades) {
    state.openTrades = payload.openTrades;
    analyzeTradeErrors(payload.openTrades);
  }

  // Update account info
  if (payload.accountInfo) {
    state.accountInfo = payload.accountInfo;
    computePerformance();
  }

  // Broadcast update to all connected dashboard clients
  broadcast("TICK", {
    symbol:      payload.symbol,
    timeframe:   payload.timeframe,
    bid:         payload.bid,
    ask:         payload.ask,
    spread:      payload.spread,
    patterns:    state.patterns,
    openTrades:  state.openTrades,
    accountInfo: state.accountInfo,
    candles:     state.candles,
    tradeErrors: state.tradeErrors,
    performance: state.performance,
  });

  res.json({ ok: true, patternsDetected: state.patterns.length });
});

// ─── Route: Get full state (REST fallback) ───────────────────────
app.get("/api/state", (req, res) => res.json(state));

// ─── Route: Get news ─────────────────────────────────────────────
app.get("/api/news", (req, res) => res.json(state.newsEvents));

// ─── Route: Get performance ──────────────────────────────────────
app.get("/api/performance", (req, res) => res.json(state.performance));

// ─── Route: Get trade errors ─────────────────────────────────────
app.get("/api/errors", (req, res) => res.json(state.tradeErrors));

// ─── Route: Receive closed trade history from EA (optional push) ─
app.post("/api/history", (req, res) => {
  const { trades } = req.body;
  if (Array.isArray(trades)) {
    state.closedTrades = trades;
    computePerformance();
    broadcast("PERFORMANCE_UPDATE", state.performance);
  }
  res.json({ ok: true });
});

// ─── Trade Error Analysis ─────────────────────────────────────────
function analyzeTradeErrors(openTrades) {
  const errors = [];
  const now = Date.now() / 1000; // unix seconds

  openTrades.forEach(trade => {
    // 1. Check if trade opened during a high-impact news window (±15 min)
    const upcomingNews = state.newsEvents.filter(e => e.impact === "high");
    upcomingNews.forEach(news => {
      const diff = Math.abs(news.timestamp - trade.openTime);
      if (diff < 900) { // 15 minutes
        errors.push({
          type:    "news_trading",
          ticket:  trade.ticket,
          symbol:  trade.symbol,
          message: `Trade #${trade.ticket} (${trade.symbol}) opened within 15 min of ${news.title}`,
          fix:     "Avoid entering trades within 15 minutes of HIGH impact news events.",
          severity:"high",
        });
      }
    });

    // 2. Check for missing stop loss
    if (!trade.sl || trade.sl === 0) {
      errors.push({
        type:    "no_stoploss",
        ticket:  trade.ticket,
        symbol:  trade.symbol,
        message: `Trade #${trade.ticket} (${trade.symbol}) has no stop loss set.`,
        fix:     "Always set a stop loss before entering a trade. Aim for 1-2% max account risk.",
        severity:"high",
      });
    }

    // 3. Check risk % per trade vs account balance
    if (state.accountInfo.balance && trade.sl && trade.openPrice) {
      const slPips = Math.abs(trade.openPrice - trade.sl) * 10000;
      const pipValue = 10 * trade.volume; // approx for major pairs
      const riskAmount = slPips * pipValue;
      const riskPct = (riskAmount / state.accountInfo.balance) * 100;
      if (riskPct > 2.5) {
        errors.push({
          type:     "oversize",
          ticket:   trade.ticket,
          symbol:   trade.symbol,
          message:  `Trade #${trade.ticket} risks ${riskPct.toFixed(1)}% of account — above the 2% rule.`,
          fix:      "Reduce position size. Use the position calculator to stay within 1-2% risk per trade.",
          severity: "medium",
        });
      }
    }
  });

  // 4. Revenge trading detection — multiple trades opened within 5 minutes
  const recentTrades = openTrades.filter(t => (now - t.openTime) < 300);
  if (recentTrades.length >= 3) {
    errors.push({
      type:    "revenge_trading",
      ticket:  null,
      symbol:  "ALL",
      message: `${recentTrades.length} trades opened in the last 5 minutes — possible revenge trading.`,
      fix:     "Step away for 30 minutes. Do not open new trades when emotional.",
      severity:"high",
    });
  }

  state.tradeErrors = errors;
}

// ─── Performance Stats Computation ───────────────────────────────
function computePerformance() {
  const trades = state.closedTrades;
  if (!trades.length) {
    state.performance = { winRate: 0, totalPnl: 0, avgRR: 0, totalTrades: 0, byPair: {} };
    return;
  }

  let wins = 0, totalPnl = 0, totalRR = 0, rrCount = 0;
  const byPair = {};

  trades.forEach(t => {
    const pnl = t.profit || 0;
    totalPnl += pnl;
    if (pnl > 0) wins++;

    // Risk:Reward
    if (t.sl && t.tp && t.openPrice) {
      const risk   = Math.abs(t.openPrice - t.sl);
      const reward = Math.abs(t.tp - t.openPrice);
      if (risk > 0) { totalRR += reward / risk; rrCount++; }
    }

    // By pair
    if (!byPair[t.symbol]) byPair[t.symbol] = { pnl: 0, wins: 0, total: 0 };
    byPair[t.symbol].pnl   += pnl;
    byPair[t.symbol].total += 1;
    if (pnl > 0) byPair[t.symbol].wins++;
  });

  state.performance = {
    winRate:     Math.round((wins / trades.length) * 100),
    totalPnl:    +totalPnl.toFixed(2),
    avgRR:       rrCount > 0 ? +(totalRR / rrCount).toFixed(2) : 0,
    totalTrades: trades.length,
    byPair,
  };
}

// ─── Forex News Fetcher (ForexFactory-style scrape) ──────────────
// Uses investing.com public calendar endpoint — no API key needed
async function fetchForexNews() {
  try {
    const today = new Date().toISOString().split("T")[0];
    // ForexFactory provides a JSON-friendly calendar via their site
    // In production replace with a paid calendar API (TradingEconomics, etc.)
    const url = `https://nfs.faireconomy.media/ff_calendar_thisweek.json`;
    const { data } = await axios.get(url, { timeout: 8000 });

    const highImpact = data
      .filter(e => e.impact === "High" && ["USD","EUR","GBP","JPY","CHF","AUD","CAD","NZD"].includes(e.country))
      .map(e => ({
        title:     e.title,
        country:   e.country,
        impact:    "high",
        timestamp: new Date(e.date).getTime() / 1000,
        forecast:  e.forecast || "—",
        previous:  e.previous || "—",
        actual:    e.actual   || null,
      }));

    state.newsEvents = highImpact;
    broadcast("NEWS_UPDATE", highImpact);
    console.log(`Fetched ${highImpact.length} high-impact news events`);
  } catch (err) {
    console.warn("News fetch failed:", err.message, "— using cached data");
  }
}

// Fetch news on startup and every 30 minutes
fetchForexNews();
cron.schedule("*/30 * * * *", fetchForexNews);

// ─── Notify dashboard 15 min before HIGH impact news ─────────────
cron.schedule("* * * * *", () => {
  const nowSec = Date.now() / 1000;
  state.newsEvents.forEach(e => {
    const mins = (e.timestamp - nowSec) / 60;
    if (mins > 14 && mins <= 15) {
      broadcast("NEWS_ALERT", {
        message: `HIGH IMPACT: ${e.title} (${e.country}) in 15 minutes!`,
        event: e,
      });
      console.log("⚡ News alert broadcast:", e.title);
    }
  });
});

// ─── Start server ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   MT5 Trading Assistant Server        ║
  ║   Listening on http://localhost:${PORT}  ║
  ╚═══════════════════════════════════════╝
  
  MT5 EA → POST http://localhost:${PORT}/api/update
  Dashboard → open dashboard/index.html
  `);
});
