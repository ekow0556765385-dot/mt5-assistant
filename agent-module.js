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
  // Lot sizing — calculated from account balance, not hardcoded
  riskPercentPerTrade: 1.0,      // risk 1% of account balance per trade
  maxLotSize:          1.0,      // hard ceiling regardless of calculation
  minLotSize:          0.01,     // minimum lot size

  // Session limits
  maxTradesPerSession: 3,        // max NEW trades the agent can open per session (server restart resets)

  // Daily loss caps — set per pair based on volatility and typical daily range
  //
  // LOW VOLATILITY  (tight pairs, small daily range ~50-80 pips)  → $600
  //   EURUSD, USDCHF — predictable, lower spread, tighter moves
  //
  // MEDIUM VOLATILITY (moderate pairs, daily range ~80-130 pips)  → $750
  //   GBPUSD, USDJPY — active but not extreme
  //
  // HIGH VOLATILITY  (wide-ranging pairs and commodities)          → $900
  //   GBPJPY  — can move 150-200 pips/day easily
  //   XAUUSD  — Gold swings $10-$30/day regularly
  //   BTCUSD  — crypto, can move hundreds of dollars in minutes
  //
  // Any unrecognised pair defaults to $600 (conservative)
  dailyLossBySym: {
    EURUSD: 600,
    USDCHF: 600,
    GBPUSD: 750,
    USDJPY: 750,
    GBPJPY: 900,
    XAUUSD: 900,
    BTCUSD: 900,
  },
  dailyLossDefault: 600,  // fallback for any unknown pair

  // Entry quality
  minConfidence:       'Medium', // Low confidence = no trade
  maxOpenAgentTrades:  1,        // only 1 open agent trade at a time

  // Direction conflict — agent will NEVER open a buy while a sell is open and vice versa
  preventConflictingDirections: true,

  allowedSymbols: [
    'EURUSD','EURUSDc','GBPUSD','GBPUSDc',
    'USDJPY','USDJPYc','USDCHF','USDCHFc',
    'GBPJPY','GBPJPYc','XAUUSD','XAUUSDc',
    'BTCUSD','BTCUSDc'
  ],

  // Pip values per lot (used for lot size calculation)
  // For JPY pairs pip = 0.01, for others pip = 0.0001
  pipValuePerLot: {
    EURUSD: 10, GBPUSD: 10, USDCHF: 10,
    USDJPY: 10, GBPJPY: 10,
    XAUUSD: 10, BTCUSD: 1
  },
  defaultPipValue: 10,
};

// ── Session trade counter ────────────────────────────────────────────────────
// Resets on server restart OR manually via /api/agent-session-reset
// Also auto-decrements when agent detects a manually closed trade
let sessionTradeCount = 0;

// Tracks tickets of trades the agent opened this session
// Used to detect when you manually close a trade outside the agent
const agentOpenTickets = new Set();

// ── Lot size calculator ───────────────────────────────────────────────────────
// Sizes the trade based on 1% account risk and SL distance
// e.g. $10,000 account, 1% risk = $100, 20 pip SL, $10/pip = 0.5 lot
function calculateLotSize(symbol, accountBalance, slPrice, entryPrice) {
  if (!accountBalance || accountBalance <= 0) return 0.10; // fallback

  const riskAmount = accountBalance * (RISK.riskPercentPerTrade / 100);

  // Calculate SL distance in pips
  let slPips = 0;
  if (slPrice && entryPrice && slPrice > 0) {
    const symClean = (symbol || '').replace(/c$/i,'').toUpperCase();
    const isJPY    = symClean.includes('JPY');
    const isGold   = symClean === 'XAUUSD';
    const isBTC    = symClean === 'BTCUSD';

    const rawDiff = Math.abs(entryPrice - slPrice);
    if (isJPY)       slPips = rawDiff / 0.01;
    else if (isGold) slPips = rawDiff / 0.1;
    else if (isBTC)  slPips = rawDiff / 1.0;
    else             slPips = rawDiff / 0.0001;
  }

  // Fallback to default if SL not provided or too small
  if (slPips < 2) slPips = RISK.defaultSLPips || 20;

  const symClean   = (symbol || '').replace(/c$/i,'').toUpperCase();
  const pipValue   = RISK.pipValuePerLot[symClean] || RISK.defaultPipValue;
  const lotSize    = riskAmount / (slPips * pipValue);

  // Round to nearest 0.01, clamp between min and max
  const rounded = Math.round(lotSize / 0.01) * 0.01;
  const clamped = Math.min(RISK.maxLotSize, Math.max(RISK.minLotSize, rounded));

  console.log(`[AGENT] Lot calc: balance=$${accountBalance} risk=${RISK.riskPercentPerTrade}% ($${riskAmount.toFixed(2)}) SL=${slPips.toFixed(1)}pips pipVal=$${pipValue} → ${clamped} lots`);
  return clamped;
}



const CONF_RANK = { Low: 0, Medium: 1, High: 2 };

// ── Dynamic cooldown tracking ────────────────────────────────────────────────
let lastTradeActionAt   = null;   // when last BUY/SELL was queued
let lastTradeClosedAt   = null;   // when last CLOSE was queued/confirmed
let lastTradedSymbol    = null;   // which symbol was last traded
let lastTradedDirection = null;   // 'BUY' or 'SELL' of last closed trade

// Cooldown durations
const COOLDOWN = {
  NONE:          0,               // different symbol — no wait
  ENTRY:         5  * 60 * 1000, // 5 min — after opening a trade
  SAME_OPPOSITE: 5  * 60 * 1000, // 5 min — same symbol, opposite direction
  SAME_SAME:     30 * 60 * 1000, // 30 min — same symbol, same direction (revenge trade prevention)
};

// Calculate dynamic cooldown based on what just closed and what's being attempted
function getDynamicCooldown(attemptedSymbol, attemptedAction, confidence) {
  if (!lastTradeClosedAt) return { ms: 0, reason: '' };

  const symClean   = (attemptedSymbol || '').replace(/c$/i,'').toUpperCase();
  const lastSym    = (lastTradedSymbol || '').replace(/c$/i,'').toUpperCase();
  const sameSymbol = symClean === lastSym;
  const sameDir    = attemptedAction === lastTradedDirection;

  // Different symbol entirely — no post-close cooldown
  // 3 different pairs can fire simultaneously if conditions are right
  if (!sameSymbol) return { ms: 0, reason: '' };

  // Same symbol, same direction as trade that just closed
  // This is the revenge/re-entry pattern — enforce full 30 min cooldown
  if (sameSymbol && sameDir) {
    const elapsed = Date.now() - lastTradeClosedAt;
    const remaining = COOLDOWN.SAME_SAME - elapsed;
    if (remaining > 0) {
      return {
        ms: remaining,
        reason: `Same symbol + same direction as closed trade — ${Math.ceil(remaining/60000)} min cooldown (revenge trade prevention)`
      };
    }
    return { ms: 0, reason: '' };
  }

  // Same symbol, opposite direction — short cooldown, market may have reversed
  if (sameSymbol && !sameDir) {
    const elapsed = Date.now() - lastTradeClosedAt;
    const remaining = COOLDOWN.SAME_OPPOSITE - elapsed;
    if (remaining > 0) {
      return {
        ms: remaining,
        reason: `Same symbol, reversed direction — ${Math.ceil(remaining/60000)} min cooldown`
      };
    }
    return { ms: 0, reason: '' };
  }

  return { ms: 0, reason: '' };
}

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

  // Claude suggests a lot size but we recalculate it properly from account balance
  // This value is overridden in runAgent() — kept here only as a fallback
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

  // ── Dynamic cooldown — depends on symbol, direction and confidence ──────────
  if (action === 'BUY' || action === 'SELL') {

    // Post-close cooldown — smart, per symbol + direction
    const dynCooldown = getDynamicCooldown(symbol, action, confidence);
    if (dynCooldown.ms > 0) {
      const minsLeft = Math.ceil(dynCooldown.ms / 60000);
      return { pass: false, reason: dynCooldown.reason };
    }

    // Short entry buffer — only applies to same symbol within 5 min of opening
    if (lastTradeActionAt) {
      const symClean  = (symbol || '').replace(/c$/i,'').toUpperCase();
      const lastSym   = (lastTradedSymbol || '').replace(/c$/i,'').toUpperCase();
      const elapsed   = Date.now() - lastTradeActionAt;
      if (symClean === lastSym && elapsed < COOLDOWN.ENTRY) {
        const secsLeft = Math.ceil((COOLDOWN.ENTRY - elapsed) / 1000);
        return { pass: false, reason: `Entry cooldown on ${symClean} — ${secsLeft}s remaining` };
      }
      // Different symbol — no entry cooldown. All 3 trades can fire in same session.
    }
  }

  // ── Market condition gate ─────────────────────────────────────────────────
  // Hard code-level RSI and EMA check — don't rely solely on Claude's judgement
  if (action === 'BUY' || action === 'SELL') {
    const indicators = appState.indicators || {};
    const rsi        = parseFloat(indicators.rsi || indicators.RSI || 0);
    const ema20      = parseFloat(indicators.ema20 || indicators.EMA20 || 0);
    const ema50      = parseFloat(indicators.ema50 || indicators.EMA50 || 0);
    const price      = appState.candlesList?.length
      ? appState.candlesList[appState.candlesList.length - 1].c
      : 0;

    if (rsi > 0) {
      // BUY: RSI must not be overbought (above 70)
      if (action === 'BUY' && rsi > 70)
        return { pass: false, reason: `RSI overbought (${rsi.toFixed(1)}) — not safe to buy into exhausted move` };

      // SELL: RSI must not be oversold (below 30)
      if (action === 'SELL' && rsi < 30)
        return { pass: false, reason: `RSI oversold (${rsi.toFixed(1)}) — not safe to sell into exhausted move` };
    }

    // EMA trend alignment — price must be on the right side of EMAs
    if (ema20 > 0 && ema50 > 0 && price > 0) {
      // BUY: price should be above EMA20 OR EMA20 should be above EMA50 (uptrend)
      const bullishEMA = price > ema20 || ema20 > ema50;
      // SELL: price should be below EMA20 OR EMA20 should be below EMA50 (downtrend)
      const bearishEMA = price < ema20 || ema20 < ema50;

      if (action === 'BUY' && !bullishEMA)
        return { pass: false, reason: `EMA misaligned for BUY — price below both EMAs, trend is bearish` };
      if (action === 'SELL' && !bearishEMA)
        return { pass: false, reason: `EMA misaligned for SELL — price above both EMAs, trend is bullish` };
    }
  }

  // ── Confidence floor ────────────────────────────────────────────────────────
  if (action === 'BUY' || action === 'SELL') {
    if (CONF_RANK[confidence] < CONF_RANK[RISK.minConfidence])
      return { pass: false, reason: `Confidence ${confidence} below minimum ${RISK.minConfidence}` };
  }

  // ── Symbol whitelist ────────────────────────────────────────────────────────
  const symClean = (symbol || '').replace(/c$/i,'').toUpperCase();
  const allowed  = RISK.allowedSymbols.map(s => s.replace(/c$/i,'').toUpperCase());
  if (symClean && !allowed.includes(symClean))
    return { pass: false, reason: `Symbol ${symbol} not in allowed list` };

  // ── Lot size ────────────────────────────────────────────────────────────────
  if (lot > RISK.maxLotSize)
    return { pass: false, reason: `Lot ${lot} exceeds max ${RISK.maxLotSize}` };

  // ── Session trade limit ────────────────────────────────────────────────────
  if (action === 'BUY' || action === 'SELL') {
    if (sessionTradeCount >= RISK.maxTradesPerSession)
      return { pass: false, reason: `Session trade limit reached (${sessionTradeCount}/${RISK.maxTradesPerSession}) — no more entries this session` };
  }

  // ── No duplicate pending orders ─────────────────────────────────────────────
  if (action === 'BUY' || action === 'SELL') {
    const alreadyPending = agentState.pendingOrders.some(o => !o.executed && o.status === 'PENDING');
    if (alreadyPending)
      return { pass: false, reason: 'Already has a PENDING order waiting for Executor EA — no new orders until it executes' };
  }

  // ── Check live open trades by magic number ──────────────────────────────────
  if (action === 'BUY' || action === 'SELL') {
    const agentMagic = 20250603;
    const liveAgentTrades = (appState.openTrades || []).filter(t =>
      parseInt(t.magic || t.magicNumber || 0) === agentMagic
    );

    if (liveAgentTrades.length > 0) {
      const liveAgentTrade = liveAgentTrades[0];

      // Sync activeTicket if out of sync
      if (!agentState.activeTicket) {
        agentState.activeTicket = liveAgentTrade.ticket;
        console.log(`[AGENT] Synced activeTicket from live trades: #${liveAgentTrade.ticket}`);
      }

      const livePL      = parseFloat(liveAgentTrade.profit || 0);
      const liveType    = (liveAgentTrade.type || '').toLowerCase(); // 'buy' or 'sell'

      // ── Direction conflict check ──────────────────────────────────────────
      if (RISK.preventConflictingDirections) {
        if (action === 'BUY'  && (liveType === 'sell' || liveType === 'short'))
          return { pass: false, reason: `Direction conflict — cannot BUY while a SELL is open (#${liveAgentTrade.ticket}, P/L $${livePL.toFixed(2)}) — CLOSE it first` };
        if (action === 'SELL' && (liveType === 'buy'  || liveType === 'long'))
          return { pass: false, reason: `Direction conflict — cannot SELL while a BUY is open (#${liveAgentTrade.ticket}, P/L $${livePL.toFixed(2)}) — CLOSE it first` };
      }

      // ── Same direction — still block (only 1 trade at a time) ────────────
      return { pass: false, reason: `Agent trade already open: #${liveAgentTrade.ticket} ${liveType.toUpperCase()} P/L $${livePL.toFixed(2)} — HOLD or CLOSE first` };
    }

    // Secondary check via activeTicket
    if (agentState.activeTicket)
      return { pass: false, reason: `Agent already has active trade #${agentState.activeTicket} — CLOSE it first` };
  }

  // ── Daily loss cap (per-pair volatility-based) ───────────────────────────────
  const symForCap  = (symbol || appState.symbol || '').replace(/c$/i,'').toUpperCase();
  const dailyCap   = RISK.dailyLossBySym[symForCap] || RISK.dailyLossDefault;

  const closedToday = (appState.closedTrades || []).filter(t => {
    const d = new Date(t.closeTime || t.time || 0);
    const today = new Date();
    return d.getDate() === today.getDate() && d.getMonth() === today.getMonth();
  });
  const dailyPL = closedToday.reduce((sum, t) => sum + parseFloat(t.profit || t.totalPL || 0), 0);
  if (dailyPL < -dailyCap)
    return { pass: false, reason: `Daily loss cap hit for ${symForCap} ($${Math.abs(dailyPL).toFixed(2)} / $${dailyCap}) — agent paused for today` };

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

  // ── Auto-detect manual trade closes ──────────────────────────────────────
  // If a ticket we opened is no longer in openTrades, you closed it manually
  // Decrement session count and clear activeTicket so agent can trade again
  if (agentOpenTickets.size > 0) {
    const liveTickets = new Set((appState.openTrades || []).map(t => String(t.ticket)));
    for (const ticket of [...agentOpenTickets]) {
      if (!liveTickets.has(String(ticket))) {
        console.log(`[AGENT] Ticket #${ticket} no longer in openTrades — manual close detected`);
        agentOpenTickets.delete(ticket);
        if (sessionTradeCount > 0) {
          sessionTradeCount--;
          console.log(`[AGENT] Session count decremented to ${sessionTradeCount} after manual close`);
        }
        if (String(agentState.activeTicket) === String(ticket)) {
          agentState.activeTicket = null;
          lastTradeClosedAt   = Date.now();
          lastTradedSymbol    = sym;
          lastTradedDirection = null; // unknown direction since closed manually
          console.log(`[AGENT] activeTicket cleared — dynamic cooldown started`);
          tg(`📌 <b>Manual close detected</b>
Ticket #${ticket} closed outside agent
Session count: ${sessionTradeCount}/${RISK.maxTradesPerSession}
Cooldown started`);
        }
      }
    }
  }

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
- Lot size is calculated server-side from account balance — just suggest 0.10 as placeholder, the server will override it.
- Max 1 lot per trade. Only 1 open trade at a time.
- Do NOT open a new trade if an agent trade is already open — say HOLD or CLOSE instead.
- CLOSE if structure flipped, TP near, or setup invalidated.
- HOLD if trade is in profit and setup still valid.
- WAIT if no clear setup.
- Only BUY or SELL if ALL of these are true:
  1. SMC structure supports it (BOS/CHoCH in direction, OB or FVG present)
  2. Pattern confidence ≥ 70%
  3. EMA trend is aligned (price on correct side of EMA20/EMA50)
  4. RSI is NOT overbought (>70) for buys, NOT oversold (<30) for sells
  5. No open agent trade exists in any direction
- If the trend has recently changed and RSI is extreme, say WAIT even if structure looks good.

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
    // ── Recalculate lot size from account balance ────────────────────────────
    const accountBalance = parseFloat((appState.accountInfo || {}).balance || 0);
    const currentPrice   = appState.candlesList?.length
      ? appState.candlesList[appState.candlesList.length - 1].c
      : 0;
    const calculatedLot  = calculateLotSize(decision.symbol, accountBalance, decision.sl, currentPrice);

    const order = {
      id:         Date.now(),
      action:     decision.action,
      symbol:     decision.symbol,
      lot:        calculatedLot,    // ← proper risk-based sizing, not hardcoded 0.1
      sl:         decision.sl,
      tp:         decision.tp,
      confidence: decision.confidence,
      reason:     decision.reason,
      time:       new Date().toISOString(),
      status:     agentState.demoMode ? 'DEMO_PENDING' : 'PENDING',
      executed:   false
    };

    sessionTradeCount++; // ← count this trade against session limit
    agentState.pendingOrders.push(order);
    if (agentState.pendingOrders.length > 20) agentState.pendingOrders.shift();

    // Track what was just traded for dynamic cooldown calculation
    lastTradeActionAt   = Date.now();
    lastTradedSymbol    = decision.symbol;
    // direction tracked on close, not open
    // Ticket gets added to agentOpenTickets when Executor EA confirms execution

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
    lastTradeClosedAt   = Date.now();    // dynamic post-close cooldown starts now
    lastTradedDirection = decision.action === 'CLOSE'
      ? (agentState.lastAction === 'BUY' ? 'BUY' : 'SELL')  // direction of the trade being closed
      : null;
    lastTradedSymbol    = decision.symbol;
    lastTradeActionAt   = null;

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

    if (order.action === 'BUY' || order.action === 'SELL') {
      agentState.activeTicket = ticket;
      agentOpenTickets.add(String(ticket)); // track for manual close detection
    }
    if (order.action === 'CLOSE') {
      agentState.activeTicket = null;
      agentOpenTickets.delete(String(ticket)); // remove from tracking
      lastTradeClosedAt   = Date.now();
      lastTradedSymbol    = order.symbol;
      const closedTrade = agentState.executedOrders.find(o =>
        (o.action === 'BUY' || o.action === 'SELL') &&
        String(o.ticket) === String(ticket)
      );
      lastTradedDirection = closedTrade ? closedTrade.action : null;
      console.log(`[AGENT] Trade closed by agent — symbol=${lastTradedSymbol} direction=${lastTradedDirection} — dynamic cooldown started`);
    }

    console.log(`[AGENT] Order #${orderId} confirmed — Ticket #${ticket} @ ${executedPrice}`);
    tg(`✅ <b>Agent Order Executed</b>\n${order.action} ${order.symbol} ${order.lot||''} lot\nTicket: #${ticket}\nPrice: ${executedPrice}`);
    res.json({ ok: true });
  });

  // Session reset — call this after manually closing trades
  // Resets session trade count so agent can place new trades
  app.post('/api/agent-session-reset', (req, res) => {
    const before = sessionTradeCount;
    sessionTradeCount = 0;
    agentOpenTickets.clear();
    agentState.activeTicket  = null;
    lastTradeActionAt        = null;
    lastTradeClosedAt        = null;
    lastTradedSymbol         = null;
    lastTradedDirection      = null;
    console.log(`[AGENT] Session reset — count was ${before}, now 0. All cooldowns cleared.`);
    tg(`🔄 <b>Agent Session Reset</b>
Session count reset from ${before} to 0
All cooldowns cleared
Agent ready for new trades`);
    res.json({ ok: true, previousCount: before, sessionTradeCount: 0 });
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
      lastDecision:    agentState.lastDecision,
      cooldownActive:    (lastTradeClosedAt && (Date.now() - lastTradeClosedAt) < POST_CLOSE_COOLDOWN_MS) ||
                         (lastTradeActionAt && (Date.now() - lastTradeActionAt) < ENTRY_COOLDOWN_MS),
      cooldownType:      (lastTradeClosedAt && (Date.now() - lastTradeClosedAt) < POST_CLOSE_COOLDOWN_MS)
                           ? 'post-close' : 'entry',
      cooldownSecsLeft:  (lastTradeClosedAt && (Date.now() - lastTradeClosedAt) < POST_CLOSE_COOLDOWN_MS)
                           ? Math.max(0, Math.ceil((POST_CLOSE_COOLDOWN_MS - (Date.now() - lastTradeClosedAt)) / 1000))
                           : lastTradeActionAt
                             ? Math.max(0, Math.ceil((ENTRY_COOLDOWN_MS - (Date.now() - lastTradeActionAt)) / 1000))
                             : 0,
      sessionTradeCount:   sessionTradeCount,
      maxTradesPerSession: RISK.maxTradesPerSession,
      trackedTickets:      [...agentOpenTickets],
      riskPercentPerTrade:RISK.riskPercentPerTrade,
      dailyLossCaps:      RISK.dailyLossBySym,
      dailyLossDefault:   RISK.dailyLossDefault,
      errors:             agentState.errors
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
