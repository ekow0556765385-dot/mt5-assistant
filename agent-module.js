// ─────────────────────────────────────────────────────────────────────────────
// agent-module.js  —  Autonomous AI Trading Agent  (v1.1 — fixes)
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');

// ── Agent state ───────────────────────────────────────────────────────────────
const agentState = {
  enabled:        false,
  demoMode:       true,
  lastDecision:   null,
  lastAction:     'NONE',
  lastReason:     '',
  lastConfidence: '',
  pendingOrders:  [],
  executedOrders: [],
  decisionLog:    [],
  activeTicket:   null,
  lastRunAt:      null,
  runCount:       0,
  errors:         []
};

// ── Risk parameters ───────────────────────────────────────────────────────────
const RISK = {
  maxLotSize:         1.0,
  maxOpenAgentTrades: 1,
  minConfidence:      'Medium',
  allowedSymbols: [
    'EURUSD','EURUSDc','GBPUSD','GBPUSDc',
    'USDJPY','USDJPYc','USDCHF','USDCHFc',
    'GBPJPY','GBPJPYc','XAUUSD','XAUUSDc',
    'BTCUSD','BTCUSDc'
  ],
  maxDailyLoss:   200,
  defaultSLPips:  20,
  defaultTPPips:  40,
};

const CONF_RANK = { Low: 0, Medium: 1, High: 2 };

const TELEGRAM_TOKEN   = '8591020831:AAF7m22h7gwmuDWklvbRvnXtpPlNolScwZw';
const TELEGRAM_CHAT_ID = '770749859';

async function tg(msg) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML'
    });
  } catch(e) { /* silent */ }
}

// ── Parse Claude's structured response ───────────────────────────────────────
function parseAgentResponse(text) {
  const clean = text.replace(/\*\*/g, '');

  let action = 'WAIT';
  const actionMatch = clean.match(/^ACTION:\s*(BUY|SELL|CLOSE|HOLD|WAIT)/im);
  if (actionMatch) action = actionMatch[1].toUpperCase();

  let symbol = '';
  const symMatch = clean.match(/^SYMBOL:\s*(\S+)/im);
  if (symMatch) symbol = symMatch[1].toUpperCase();

  let lot = 0.10;
  const lotMatch = clean.match(/^LOT(?:_SIZE)?:\s*([\d.]+)/im);
  if (lotMatch) lot = Math.min(parseFloat(lotMatch[1]) || 0.10, RISK.maxLotSize);

  let sl = 0;
  const slMatch = clean.match(/^SL(?:_PRICE)?:\s*([\d.]+)/im);
  if (slMatch) sl = parseFloat(slMatch[1]);

  let tp = 0;
  const tpMatch = clean.match(/^TP(?:_PRICE)?:\s*([\d.]+)/im);
  if (tpMatch) tp = parseFloat(tpMatch[1]);

  let confidence = 'Medium';
  const confMatch = clean.match(/^CONFIDENCE:\s*(Low|Medium|High)/im);
  if (confMatch) confidence = confMatch[1];

  let reason = '';
  const reasonMatch = clean.match(/^REASON:\s*(.+)/im);
  if (reasonMatch) reason = reasonMatch[1].trim();

  return { action, symbol, lot, sl, tp, confidence, reason, rawText: text };
}

// ── Risk gate ─────────────────────────────────────────────────────────────────
function riskGate(decision, appState) {
  const { action, symbol, lot, confidence } = decision;
  if (action === 'HOLD' || action === 'WAIT') return { pass: true };

  if (action === 'BUY' || action === 'SELL') {
    if (CONF_RANK[confidence] < CONF_RANK[RISK.minConfidence])
      return { pass: false, reason: `Confidence ${confidence} below minimum ${RISK.minConfidence}` };
  }

  const symClean = (symbol || '').replace(/c$/i,'').toUpperCase();
  const allowed  = RISK.allowedSymbols.map(s => s.replace(/c$/i,'').toUpperCase());
  if (symClean && !allowed.includes(symClean))
    return { pass: false, reason: `Symbol ${symbol} not in allowed list` };

  if (lot > RISK.maxLotSize)
    return { pass: false, reason: `Lot ${lot} exceeds max ${RISK.maxLotSize}` };

  // Only block new entry trades if there's an active ticket — allow CLOSE always
  if ((action === 'BUY' || action === 'SELL') && agentState.activeTicket)
    return { pass: false, reason: `Agent already has active trade #${agentState.activeTicket} — CLOSE it first` };

  const closedToday = (appState.closedTrades || []).filter(t => {
    const d = new Date(t.closeTime || t.time || 0);
    const today = new Date();
    return d.getDate() === today.getDate() && d.getMonth() === today.getMonth();
  });
  const dailyPL = closedToday.reduce((sum, t) => sum + parseFloat(t.profit || t.totalPL || 0), 0);
  if (dailyPL < -RISK.maxDailyLoss)
    return { pass: false, reason: `Daily loss cap hit ($${Math.abs(dailyPL).toFixed(2)}) — agent paused` };

  return { pass: true };
}

// ── Build prompt ──────────────────────────────────────────────────────────────
function buildAgentPrompt(appState, smcData, patternData, candleData) {
  const sym = appState.symbol || 'GBPUSD';

  const candleArr = (candleData.candles || []).slice(-8);
  const candleSummary = candleArr.length
    ? candleArr.map((c, i) => {
        const dir  = c.close > c.open ? '▲' : '▼';
        const time = c.time ? new Date(c.time * 1000).toISOString().slice(11,16) : `bar${i}`;
        return `${time} ${dir} O:${parseFloat(c.open).toFixed(5)} H:${parseFloat(c.high).toFixed(5)} L:${parseFloat(c.low).toFixed(5)} C:${parseFloat(c.close).toFixed(5)}`;
      }).join('\n')
    : 'No candle data';

  const openTrades = appState.openTrades || [];
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

  const prompt = buildAgentPrompt(appState, smcData, patternData, candleData);

  let rawText = '';
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: `You are an autonomous Forex, Gold and crypto trading agent managing a live MT5 account.

Supported pairs: EURUSD, GBPUSD, USDJPY, USDCHF, GBPJPY, XAUUSD, BTCUSD.
Trade whichever pair the live data is for — shown in the prompt header.

Rules:
- Max 1 lot per trade. Only 1 open trade at a time.
- Do NOT open a new trade if an agent trade is already open — say HOLD or CLOSE instead.
- CLOSE if structure flipped, TP near, or setup invalidated.
- HOLD if trade is in profit and setup still valid.
- WAIT if no clear setup.
- Only BUY or SELL if: SMC structure supports it AND pattern confidence ≥ 70% AND SSI/EMA bias agrees.

After 2-3 sentence analysis, end with EXACTLY these lines — no markdown, no bold, no extra text:

ACTION: BUY
SYMBOL: GBPUSD
LOT: 0.10
SL: 1.25000
TP: 1.25400
CONFIDENCE: High
REASON: BOS above OB confirmed, FVG filled, H4 bullish bias

Or if no trade:
ACTION: WAIT
SYMBOL: GBPUSD
CONFIDENCE: Low
REASON: No confluence — waiting for OB retest

Valid ACTION: BUY, SELL, CLOSE, HOLD, WAIT
Valid CONFIDENCE: Low, Medium, High`,
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
    console.error(`[AGENT] Claude call failed: ${e.message}`);
    agentState.errors.unshift({ time: new Date().toISOString(), msg: e.message });
    if (agentState.errors.length > 10) agentState.errors.pop();
    return;
  }

  const decision   = parseAgentResponse(rawText);
  const riskResult = riskGate(decision, appState);

  // FIX: always use active symbol if Claude didn't return one
  if (!decision.symbol) decision.symbol = sym;

  const logEntry = {
    id:         Date.now(),
    time:       new Date().toISOString(),
    symbol:     decision.symbol || sym,
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

  // FIX: always update lastDecision so dashboard shows current state
  agentState.lastDecision  = logEntry;
  agentState.lastAction    = decision.action;
  agentState.lastReason    = decision.reason;
  agentState.lastConfidence= decision.confidence;
  agentState.decisionLog.unshift(logEntry);
  if (agentState.decisionLog.length > 100) agentState.decisionLog.pop();

  console.log(`[AGENT] Symbol=${decision.symbol} Action=${decision.action} Conf=${decision.confidence} Demo=${agentState.demoMode} RiskPass=${riskResult.pass}`);

  if (!riskResult.pass) {
    console.log(`[AGENT] Risk gate blocked: ${riskResult.reason}`);
    await tg(`⚠️ <b>Agent Risk Gate Blocked</b>\nAction: ${decision.action} on ${decision.symbol}\nReason: ${riskResult.reason}`);
    return;
  }

  if (decision.action === 'WAIT' || decision.action === 'HOLD') return;

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
      // FIX: status is determined at order creation time based on current demoMode
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
      `📝 ${decision.reason}\n` +
      (agentState.demoMode ? `\n🔵 <i>DEMO — no real trade placed</i>` : `\n⚡ <i>LIVE — Executor EA will execute</i>`)
    );
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
    if (!agentState.demoMode) agentState.activeTicket = null;
  }
}

// ── Register routes ───────────────────────────────────────────────────────────
function registerAgentRoutes(app, getAppState, smcStore, candlesStore) {

  // Executor EA polls this — only returns PENDING (not DEMO_PENDING)
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

    if (order.action === 'BUY' || order.action === 'SELL') agentState.activeTicket = ticket;
    if (order.action === 'CLOSE') agentState.activeTicket = null;

    console.log(`[AGENT] Order #${orderId} confirmed — Ticket #${ticket} @ ${executedPrice}`);
    tg(`✅ <b>Agent Order Executed</b>\n${order.action} ${order.symbol} ${order.lot||''} lot\nTicket: #${ticket}\nPrice: ${executedPrice}`);
    res.json({ ok: true });
  });

  // FIX: clear stale DEMO_PENDING orders when switching to live
  // Also adds flush endpoint for the dashboard "Clear Pending" button
  app.post('/api/agent-flush', (req, res) => {
    const before = agentState.pendingOrders.length;
    agentState.pendingOrders = agentState.pendingOrders.filter(o => o.executed);
    const flushed = before - agentState.pendingOrders.length;
    console.log(`[AGENT] Flushed ${flushed} pending orders`);
    tg(`🗑️ <b>Agent orders flushed</b>\n${flushed} pending orders cleared`);
    res.json({ ok: true, flushed });
  });

  // Dashboard status — FIX: include lastDecision in response
  app.get('/api/agent-status', (req, res) => {
    res.json({
      enabled:         agentState.enabled,
      demoMode:        agentState.demoMode,
      lastAction:      agentState.lastAction,
      lastReason:      agentState.lastReason,
      lastConfidence:  agentState.lastConfidence,
      lastRunAt:       agentState.lastRunAt,
      runCount:        agentState.runCount,
      activeTicket:    agentState.activeTicket,
      pendingCount:    agentState.pendingOrders.filter(o => !o.executed).length,
      recentDecisions: agentState.decisionLog.slice(0, 50),   // FIX: was 10, now 50
      executedOrders:  agentState.executedOrders.slice(0, 20),
      lastDecision:    agentState.lastDecision,                // FIX: was missing
      errors:          agentState.errors
    });
  });

  // Enable / disable — FIX: auto-flush DEMO_PENDING orders when switching to live
  app.post('/api/agent-control', (req, res) => {
    const { enabled, demoMode } = req.body;
    const wasDemo = agentState.demoMode;

    if (typeof enabled  === 'boolean') agentState.enabled  = enabled;
    if (typeof demoMode === 'boolean') agentState.demoMode = demoMode;

    // If switching from DEMO → LIVE, flush all stale DEMO_PENDING orders
    // so the EA doesn't receive old signals
    if (wasDemo && !agentState.demoMode) {
      const before = agentState.pendingOrders.length;
      agentState.pendingOrders = agentState.pendingOrders.filter(o => o.executed);
      const flushed = before - agentState.pendingOrders.length;
      if (flushed > 0) {
        console.log(`[AGENT] Mode switched DEMO→LIVE — auto-flushed ${flushed} stale orders`);
        tg(`🔄 <b>Switched to LIVE mode</b>\n${flushed} stale DEMO orders cleared automatically\nNext agent decision will create fresh LIVE orders`);
      }
    }

    console.log(`[AGENT] Control — enabled=${agentState.enabled} demoMode=${agentState.demoMode}`);
    if (!wasDemo || agentState.demoMode !== wasDemo) {
      tg(`🤖 <b>Agent ${agentState.enabled ? 'ENABLED' : 'DISABLED'}</b>\nMode: ${agentState.demoMode ? '🔵 DEMO (no real trades)' : '⚡ LIVE (real trades active)'}`);
    }
    res.json({ ok: true, enabled: agentState.enabled, demoMode: agentState.demoMode });
  });

  // Manual run trigger
  app.post('/api/agent-run', async (req, res) => {
    if (!agentState.enabled) return res.status(400).json({ error: 'Agent is disabled — enable it first' });
    const appState = getAppState();
    res.json({ ok: true, message: 'Agent run triggered' });
    runAgent(appState, smcStore, candlesStore).catch(console.error);
  });

  // Full log
  app.get('/api/agent-log', (req, res) => {
    res.json({ decisions: agentState.decisionLog, executedOrders: agentState.executedOrders });
  });

  console.log('[AGENT] Routes registered: /api/agent-orders, /api/agent-status, /api/agent-control, /api/agent-run, /api/agent-flush, /api/agent-log');
}

// ── Decision loop ─────────────────────────────────────────────────────────────
function startAgentLoop(getAppState, smcStore, candlesStore) {
  setInterval(() => {
    if (!agentState.enabled) return;
    runAgent(getAppState(), smcStore, candlesStore).catch(console.error);
  }, 60 * 1000);
  console.log('[AGENT] Decision loop started — runs every 60s when enabled');
}

// Triggered on H1/H4 candle close from /api/candles
async function triggerAgentOnCandle(appState, smcStore, candlesStore, timeframe) {
  if (!agentState.enabled) return;
  if (!['H1', 'H4'].includes(timeframe)) return;
  console.log(`[AGENT] Candle trigger — ${timeframe} closed, running agent...`);
  runAgent(appState, smcStore, candlesStore).catch(console.error);
}

module.exports = { registerAgentRoutes, startAgentLoop, triggerAgentOnCandle, agentState };
