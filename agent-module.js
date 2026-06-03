// ─────────────────────────────────────────────────────────────────────────────
// agent-module.js  —  Autonomous AI Trading Agent
// Drop this file into your server/ folder alongside app.js
// Then add ONE line to app.js (see bottom of this file for instructions)
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');

// ── Agent state ───────────────────────────────────────────────────────────────
const agentState = {
  enabled:       false,          // master on/off switch
  demoMode:      true,           // true = decide but don't execute real trades
  lastDecision:  null,           // last full decision object
  lastAction:    'NONE',         // BUY / SELL / CLOSE / HOLD / WAIT
  lastReason:    '',
  lastConfidence:'',
  pendingOrders: [],             // orders waiting for Executor EA to collect
  executedOrders:[],             // history of executed orders (last 50)
  decisionLog:   [],             // full log of every decision (last 100)
  activeTicket:  null,           // ticket of trade the agent opened (if any)
  lastRunAt:     null,
  runCount:      0,
  errors:        []
};

// ── Risk parameters ───────────────────────────────────────────────────────────
const RISK = {
  maxLotSize:         1.0,       // max 1 lot per trade
  maxOpenAgentTrades: 1,         // agent only holds 1 trade at a time
  minConfidence:      'Medium',  // won't trade on Low confidence
  // All pairs supported by the MT5 assistant (Exness 'c' suffix variants included)
  allowedSymbols: [
    'EURUSD','EURUSDc',
    'GBPUSD','GBPUSDc',
    'USDJPY','USDJPYc',
    'USDCHF','USDCHFc',
    'GBPJPY','GBPJPYc',
    'XAUUSD','XAUUSDc',
    'BTCUSD','BTCUSDc'
  ],
  maxDailyLoss:     200,         // USD — agent pauses if daily loss exceeds this
  defaultSLPips:    20,          // fallback SL if Claude doesn't specify
  defaultTPPips:    40,          // fallback TP if Claude doesn't specify
};

const CONF_RANK = { Low: 0, Medium: 1, High: 2 };

// ── Telegram (re-uses same token/chat from app.js scope) ─────────────────────
const TELEGRAM_TOKEN   = '8591020831:AAF7m22h7gwmuDWklvbRvnXtpPlNolScwZw';
const TELEGRAM_CHAT_ID = '770749859';

async function tg(msg) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML'
    });
  } catch(e) { /* silent */ }
}

// ── Parse Claude's agent response ────────────────────────────────────────────
function parseAgentResponse(text) {
  const clean = text.replace(/\*\*/g, '');

  // ACTION
  let action = 'WAIT';
  const actionMatch = clean.match(/^ACTION:\s*(BUY|SELL|CLOSE|HOLD|WAIT)/im);
  if (actionMatch) action = actionMatch[1].toUpperCase();

  // SYMBOL
  let symbol = 'GBPUSD';
  const symMatch = clean.match(/^SYMBOL:\s*(\S+)/im);
  if (symMatch) symbol = symMatch[1].toUpperCase().replace('C','c').replace(/c$/,'');

  // LOT
  let lot = 0.1;
  const lotMatch = clean.match(/^LOT(?:_SIZE)?:\s*([\d.]+)/im);
  if (lotMatch) lot = Math.min(parseFloat(lotMatch[1]) || 0.1, RISK.maxLotSize);

  // SL
  let sl = 0;
  const slMatch = clean.match(/^SL(?:_PRICE)?:\s*([\d.]+)/im);
  if (slMatch) sl = parseFloat(slMatch[1]);

  // TP
  let tp = 0;
  const tpMatch = clean.match(/^TP(?:_PRICE)?:\s*([\d.]+)/im);
  if (tpMatch) tp = parseFloat(tpMatch[1]);

  // CONFIDENCE
  let confidence = 'Medium';
  const confMatch = clean.match(/^CONFIDENCE:\s*(Low|Medium|High)/im);
  if (confMatch) confidence = confMatch[1];

  // REASON
  let reason = '';
  const reasonMatch = clean.match(/^REASON:\s*(.+)/im);
  if (reasonMatch) reason = reasonMatch[1].trim();

  return { action, symbol, lot, sl, tp, confidence, reason, rawText: text };
}

// ── Risk gate — validates a parsed decision ───────────────────────────────────
function riskGate(decision, appState) {
  const { action, symbol, lot, confidence } = decision;

  if (action === 'HOLD' || action === 'WAIT') return { pass: true };

  // Confidence floor
  if (action === 'BUY' || action === 'SELL') {
    if (CONF_RANK[confidence] < CONF_RANK[RISK.minConfidence]) {
      return { pass: false, reason: `Confidence ${confidence} below minimum ${RISK.minConfidence}` };
    }
  }

  // Symbol check
  const symClean = symbol.replace('c','').toUpperCase();
  const allowed  = RISK.allowedSymbols.map(s => s.replace('c','').toUpperCase());
  if (!allowed.includes(symClean)) {
    return { pass: false, reason: `Symbol ${symbol} not in allowed list` };
  }

  // Lot size
  if (lot > RISK.maxLotSize) {
    return { pass: false, reason: `Lot ${lot} exceeds max ${RISK.maxLotSize}` };
  }

  // Only 1 active agent trade at a time
  if ((action === 'BUY' || action === 'SELL') && agentState.activeTicket) {
    return { pass: false, reason: `Agent already has active trade #${agentState.activeTicket} — use CLOSE first` };
  }

  // Daily loss cap
  const closedToday = (appState.closedTrades || []).filter(t => {
    const d = new Date(t.closeTime || t.time || 0);
    const today = new Date();
    return d.getDate() === today.getDate() && d.getMonth() === today.getMonth();
  });
  const dailyPL = closedToday.reduce((sum, t) => sum + parseFloat(t.profit || t.totalPL || 0), 0);
  if (dailyPL < -RISK.maxDailyLoss) {
    return { pass: false, reason: `Daily loss cap hit ($${Math.abs(dailyPL).toFixed(2)}) — agent paused` };
  }

  return { pass: true };
}

// ── Build the agent prompt ────────────────────────────────────────────────────
function buildAgentPrompt(appState, smcData, patternData, candleData, ssiData) {
  const sym = appState.symbol || 'GBPUSD';

  const candleArr = (candleData.candles || []).slice(-8);
  const candleSummary = candleArr.length
    ? candleArr.map((c, i) => {
        const dir  = c.close > c.open ? '▲' : '▼';
        const time = c.time ? new Date(c.time * 1000).toISOString().slice(11,16) : `bar${i}`;
        return `${time} ${dir} O:${parseFloat(c.open).toFixed(5)} H:${parseFloat(c.high).toFixed(5)} L:${parseFloat(c.low).toFixed(5)} C:${parseFloat(c.close).toFixed(5)}`;
      }).join('\n')
    : 'No candle data';

  const openTrades = (appState.openTrades || []);
  const agentTrade = agentState.activeTicket
    ? openTrades.find(t => String(t.ticket) === String(agentState.activeTicket))
    : null;

  return [
    `AUTONOMOUS AGENT DECISION REQUEST — ${sym} — ${new Date().toUTCString()}`,
    `\n=== PRICE + INDICATORS ===`,
    JSON.stringify({ symbol: sym, timeframe: appState.timeframe, price: appState.candlesList?.length ? appState.candlesList[appState.candlesList.length-1].c : 0, ...appState.indicators }, null, 2),
    `\n=== SMC DATA ===`,
    JSON.stringify(smcData, null, 2),
    `\n=== PATTERN DETECTOR ===`,
    JSON.stringify(patternData, null, 2),
    `\n=== SSI ENGINE ===`,
    JSON.stringify(ssiData || {}, null, 2),
    `\n=== RECENT M15 CANDLES (last 8) ===`,
    candleSummary,
    `\n=== AGENT TRADE STATUS ===`,
    agentTrade
      ? `Agent has open trade: Ticket #${agentTrade.ticket} ${agentTrade.type} ${agentTrade.volume} lots @ ${agentTrade.openPrice} | P/L: $${parseFloat(agentTrade.profit).toFixed(2)} | SL: ${agentTrade.sl} | TP: ${agentTrade.tp}`
      : `No active agent trade — agent is flat`,
    `\n=== ACCOUNT ===`,
    JSON.stringify(appState.accountInfo, null, 2),
    `\nMake your autonomous trading decision now.`
  ].join('\n');
}

// ── Core agent run ────────────────────────────────────────────────────────────
async function runAgent(appState, smcStore, candlesStore) {
  if (!agentState.enabled) return;

  agentState.runCount++;
  agentState.lastRunAt = new Date().toISOString();

  const sym = appState.symbol
    || Object.keys(candlesStore)[0]
    || Object.keys(smcStore)[0]
    || 'GBPUSD';

  const smcData     = smcStore[sym] || smcStore[sym + 'c'] || Object.values(smcStore)[0] || {};
  const patKey      = Object.keys(appState.livePatterns || {}).find(k => k.startsWith(sym)) || '';
  const patternData = (appState.livePatterns || {})[patKey] || {};
  const candleData  = candlesStore[sym] || candlesStore[sym + 'c'] || Object.values(candlesStore)[0] || {};

  const prompt = buildAgentPrompt(appState, smcData, patternData, candleData, {});

  let rawText = '';
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: `You are an autonomous Forex, Gold and crypto trading agent managing a live MT5 account.

Supported pairs: EURUSD, GBPUSD, USDJPY, USDCHF, GBPJPY, XAUUSD, BTCUSD.
You will trade whichever pair the live data is for — identified in the prompt header.

You receive live market data from 5 sources: Price+Indicators, SMC (BOS/CHoCH/OB/FVG), Pattern Detector, SSI Engine, and recent candles.

Your job is to make ONE clear trading decision right now. Be decisive. Only trade high-probability SMC confluences.

Rules:
- Trade the active symbol shown in the prompt header
- Max 1 lot per trade
- Only 1 open trade at a time
- Do NOT open a new trade if an agent trade is already open — say HOLD or CLOSE instead
- CLOSE the trade if structure has flipped against the position, TP is near, or the setup is invalidated
- HOLD if the trade is in profit and the setup is still valid
- WAIT if there is no clear setup
- Only BUY or SELL if: SMC structure supports it AND pattern confidence ≥ 70% AND SSI bias agrees

After your analysis (2-3 sentences max), respond with EXACTLY these lines — no markdown, no bold:

ACTION: BUY
SYMBOL: GBPUSD
LOT: 0.10
SL: 1.25000
TP: 1.25400
CONFIDENCE: High
REASON: BOS above OB confirmed, FVG filled, H4 bullish bias, pattern 78% confidence

Or if no trade:
ACTION: WAIT
SYMBOL: GBPUSD
CONFIDENCE: Low
REASON: No confluence — waiting for OB retest

Valid ACTION values: BUY, SELL, CLOSE, HOLD, WAIT
Valid CONFIDENCE values: Low, Medium, High
These structured lines MUST be the last lines of your response.`,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        timeout: 30000
      }
    );
    rawText = (response.data.content || []).map(c => c.text || '').join('');
  } catch(e) {
    const err = `[AGENT] Claude call failed: ${e.message}`;
    console.error(err);
    agentState.errors.unshift({ time: new Date().toISOString(), msg: e.message });
    if (agentState.errors.length > 10) agentState.errors.pop();
    return;
  }

  const decision   = parseAgentResponse(rawText);
  const riskResult = riskGate(decision, appState);

  const logEntry = {
    id:         Date.now(),
    time:       new Date().toISOString(),
    symbol:     sym,
    action:     decision.action,
    lot:        decision.lot,
    sl:         decision.sl,
    tp:         decision.tp,
    confidence: decision.confidence,
    reason:     decision.reason,
    riskPassed: riskResult.pass,
    riskReason: riskResult.reason || '',
    demoMode:   agentState.demoMode,
    rawText
  };

  agentState.lastDecision  = logEntry;
  agentState.lastAction    = decision.action;
  agentState.lastReason    = decision.reason;
  agentState.lastConfidence= decision.confidence;
  agentState.decisionLog.unshift(logEntry);
  if (agentState.decisionLog.length > 100) agentState.decisionLog.pop();

  console.log(`[AGENT] Action=${decision.action} Conf=${decision.confidence} RiskPass=${riskResult.pass} Reason="${decision.reason}"`);

  // ── Act on decision ───────────────────────────────────────────
  if (!riskResult.pass) {
    console.log(`[AGENT] Risk gate blocked: ${riskResult.reason}`);
    await tg(`⚠️ <b>Agent Risk Gate</b>\nDecision: ${decision.action} blocked\nReason: ${riskResult.reason}`);
    return;
  }

  if (decision.action === 'WAIT' || decision.action === 'HOLD') {
    // Silent — no Telegram spam on every hold
    return;
  }

  const modeTag = agentState.demoMode ? '[DEMO]' : '[LIVE]';

  if (decision.action === 'BUY' || decision.action === 'SELL') {
    const order = {
      id:         Date.now(),
      action:     decision.action,
      symbol:     decision.symbol,
      lot:        decision.lot,
      sl:         decision.sl,
      tp:         decision.tp,
      confidence: decision.confidence,
      reason:     decision.reason,
      time:       new Date().toISOString(),
      status:     agentState.demoMode ? 'DEMO_PENDING' : 'PENDING',
      executed:   false
    };

    agentState.pendingOrders.push(order);
    if (agentState.pendingOrders.length > 20) agentState.pendingOrders.shift();

    const dirIcon = decision.action === 'BUY' ? '🟢' : '🔴';
    await tg(
      `${dirIcon} <b>Agent ${modeTag} ${decision.action}</b>\n` +
      `📊 ${decision.symbol} · ${decision.lot} lot\n` +
      `🎯 SL: ${decision.sl} · TP: ${decision.tp}\n` +
      `💡 Confidence: ${decision.confidence}\n` +
      `📝 ${decision.reason}`
    );

    if (!agentState.demoMode) {
      console.log(`[AGENT] LIVE order queued → Executor EA will collect via /api/agent-orders`);
    } else {
      console.log(`[AGENT] DEMO order logged — not sent to MT5`);
    }
  }

  if (decision.action === 'CLOSE') {
    const closeOrder = {
      id:       Date.now(),
      action:   'CLOSE',
      symbol:   decision.symbol,
      ticket:   agentState.activeTicket,
      reason:   decision.reason,
      time:     new Date().toISOString(),
      status:   agentState.demoMode ? 'DEMO_PENDING' : 'PENDING',
      executed: false
    };

    agentState.pendingOrders.push(closeOrder);

    await tg(
      `⬛ <b>Agent ${modeTag} CLOSE</b>\n` +
      `📊 ${decision.symbol} · Ticket #${agentState.activeTicket || 'unknown'}\n` +
      `📝 ${decision.reason}`
    );

    if (!agentState.demoMode) {
      agentState.activeTicket = null;
    }
  }
}

// ── Register all agent endpoints onto an Express app ─────────────────────────
function registerAgentRoutes(app, getAppState, smcStore, candlesStore) {

  // Executor EA polls this to get pending orders
  app.get('/api/agent-orders', (req, res) => {
    const pending = agentState.pendingOrders.filter(o => !o.executed && o.status === 'PENDING');
    res.json({ orders: pending, agentEnabled: agentState.enabled, demoMode: agentState.demoMode });
  });

  // Executor EA confirms execution
  app.post('/api/agent-orders/confirm', (req, res) => {
    const { orderId, ticket, executedPrice } = req.body;
    const order = agentState.pendingOrders.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    order.executed      = true;
    order.status        = 'EXECUTED';
    order.ticket        = ticket;
    order.executedPrice = executedPrice;
    order.executedAt    = new Date().toISOString();

    agentState.executedOrders.unshift(order);
    if (agentState.executedOrders.length > 50) agentState.executedOrders.pop();

    if (order.action === 'BUY' || order.action === 'SELL') {
      agentState.activeTicket = ticket;
    }
    if (order.action === 'CLOSE') {
      agentState.activeTicket = null;
    }

    console.log(`[AGENT] Order #${orderId} confirmed — Ticket #${ticket} @ ${executedPrice}`);
    tg(`✅ <b>Agent Order Executed</b>\n${order.action} ${order.symbol} ${order.lot || ''} lot\nTicket: #${ticket}\nPrice: ${executedPrice}`);

    res.json({ ok: true });
  });

  // Dashboard status panel
  app.get('/api/agent-status', (req, res) => {
    res.json({
      enabled:        agentState.enabled,
      demoMode:       agentState.demoMode,
      lastAction:     agentState.lastAction,
      lastReason:     agentState.lastReason,
      lastConfidence: agentState.lastConfidence,
      lastRunAt:      agentState.lastRunAt,
      runCount:       agentState.runCount,
      activeTicket:   agentState.activeTicket,
      pendingCount:   agentState.pendingOrders.filter(o => !o.executed).length,
      recentDecisions:agentState.decisionLog.slice(0, 10),
      executedOrders: agentState.executedOrders.slice(0, 10),
      errors:         agentState.errors
    });
  });

  // Enable / disable agent
  app.post('/api/agent-control', (req, res) => {
    const { enabled, demoMode } = req.body;
    if (typeof enabled  === 'boolean') agentState.enabled  = enabled;
    if (typeof demoMode === 'boolean') agentState.demoMode = demoMode;
    console.log(`[AGENT] Control update — enabled=${agentState.enabled} demoMode=${agentState.demoMode}`);
    tg(`🤖 <b>Agent ${agentState.enabled ? 'ENABLED' : 'DISABLED'}</b>\nMode: ${agentState.demoMode ? 'DEMO (no real trades)' : '⚡ LIVE'}`);
    res.json({ ok: true, enabled: agentState.enabled, demoMode: agentState.demoMode });
  });

  // Manual agent run trigger
  app.post('/api/agent-run', async (req, res) => {
    if (!agentState.enabled) return res.status(400).json({ error: 'Agent is disabled' });
    const appState = getAppState();
    res.json({ ok: true, message: 'Agent run triggered' });
    runAgent(appState, smcStore, candlesStore).catch(console.error);
  });

  // Full decision log
  app.get('/api/agent-log', (req, res) => {
    res.json({ decisions: agentState.decisionLog, executedOrders: agentState.executedOrders });
  });

  console.log('[AGENT] Routes registered: /api/agent-orders, /api/agent-status, /api/agent-control, /api/agent-run, /api/agent-log');
}

// ── Start the agent decision loop ─────────────────────────────────────────────
// Runs every 60 seconds when enabled. Triggered immediately on new candle data
// via triggerAgentOnCandle() exported below.
function startAgentLoop(getAppState, smcStore, candlesStore) {
  setInterval(() => {
    if (!agentState.enabled) return;
    const appState = getAppState();
    runAgent(appState, smcStore, candlesStore).catch(console.error);
  }, 60 * 1000);

  console.log('[AGENT] Decision loop started — runs every 60s when enabled');
}

// Call this from /api/candles or /api/update when new candle arrives
async function triggerAgentOnCandle(appState, smcStore, candlesStore, timeframe) {
  if (!agentState.enabled) return;
  // Only trigger on H1 or H4 candle close for quality signals
  if (!['H1', 'H4'].includes(timeframe)) return;
  console.log(`[AGENT] Candle trigger — ${timeframe} closed, running agent...`);
  runAgent(appState, smcStore, candlesStore).catch(console.error);
}

module.exports = { registerAgentRoutes, startAgentLoop, triggerAgentOnCandle, agentState };

// ─────────────────────────────────────────────────────────────────────────────
// HOW TO WIRE INTO app.js — add these lines in the right places:
//
// 1. At the top with other requires:
//    const { registerAgentRoutes, startAgentLoop, triggerAgentOnCandle } = require('./agent-module');
//
// 2. After the state `let s = {...}` block:
//    registerAgentRoutes(app, () => s, smcStore, candlesStore);
//
// 3. Inside /api/candles, after runPatternDetection, add:
//    triggerAgentOnCandle(s, smcStore, candlesStore, tf);
//
// 4. After http.listen(...) starts:
//    startAgentLoop(() => s, smcStore, candlesStore);
// ─────────────────────────────────────────────────────────────────────────────
