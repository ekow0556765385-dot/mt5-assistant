// ─────────────────────────────────────────────────────────────────────────────
// agent-module.js  —  Autonomous AI Trading Agent  (v1.1 — fixes)
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// ── Persistence file — survives Railway restarts ──────────────────────────────
const PERSIST_FILE = path.join(__dirname, 'agent_session.json');

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
  riskPercentPerTrade: 1.0,
  maxLotSize:          1.0,
  minLotSize:          0.01,
  maxTradesPerSession: 3,
  dailyLossBySym: {
    EURUSD: 600, USDCHF: 600,
    GBPUSD: 750, USDJPY: 750,
    GBPJPY: 900, XAUUSD: 900, BTCUSD: 900,
  },
  dailyLossDefault: 600,
  newsPauseMinsBeforeEvent: 5,
  newsPauseMinsAfterEvent:  5,
  newsCurrencies: ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'],
  pairCurrencies: {
    EURUSD: ['EUR', 'USD'], GBPUSD: ['GBP', 'USD'],
    USDJPY: ['USD', 'JPY'], USDCHF: ['USD', 'CHF'],
    GBPJPY: ['GBP', 'JPY'], XAUUSD: ['USD'],
    BTCUSD: ['USD']
  },
  minConfidence:       'Medium',
  maxOpenAgentTrades:  1,
  preventConflictingDirections: true,
  allowedSymbols: [
    'EURUSD','EURUSDc','GBPUSD','GBPUSDc',
    'USDJPY','USDJPYc','USDCHF','USDCHFc',
    'GBPJPY','GBPJPYc','XAUUSD','XAUUSDc',
    'BTCUSD','BTCUSDc'
  ],
  pipValuePerLot: {
    EURUSD: 10, GBPUSD: 10, USDCHF: 10,
    USDJPY: 10, GBPJPY: 10,
    XAUUSD: 10, BTCUSD: 1
  },
  defaultPipValue: 10,
};

let sessionTradeCount = 0;
const agentOpenTickets = new Set();

function checkNewsPause(symbol, newsEvents) {
  if (!newsEvents || !newsEvents.length) return { paused: false };
  const symClean   = (symbol || '').replace(/c$/i,'').toUpperCase();
  const pairCurrs  = RISK.pairCurrencies[symClean] || ['USD'];
  const nowSecs    = Math.floor(Date.now() / 1000);
  const pauseBefore= RISK.newsPauseMinsBeforeEvent * 60;
  const pauseAfter = RISK.newsPauseMinsAfterEvent  * 60;
  for (const event of newsEvents) {
    if (!event.timestamp) continue;
    if (event.impact !== 'high') continue;
    const eventCurr = (event.country || '').toUpperCase();
    if (!pairCurrs.includes(eventCurr)) continue;
    const secsToEvent    = event.timestamp - nowSecs;
    const secsSinceEvent = nowSecs - event.timestamp;
    if (secsToEvent > 0 && secsToEvent <= pauseBefore) {
      const minsLeft = Math.ceil(secsToEvent / 60);
      return { paused: true, reason: `News pause — ${event.title} (${eventCurr}) in ${minsLeft} min. No new entries within ${RISK.newsPauseMinsBeforeEvent} min of high impact news.`, event: event.title, currency: eventCurr, minsToEvent: minsLeft };
    }
    if (secsSinceEvent >= 0 && secsSinceEvent <= pauseAfter) {
      const minsAgo  = Math.floor(secsSinceEvent / 60);
      const minsLeft = Math.ceil((pauseAfter - secsSinceEvent) / 60);
      return { paused: true, reason: `News pause — ${event.title} (${eventCurr}) released ${minsAgo} min ago. Waiting ${minsLeft} more min for market to stabilise.`, event: event.title, currency: eventCurr, minsAgo, minsLeft };
    }
  }
  return { paused: false };
}

function calculateLotSize(symbol, accountBalance, slPrice, entryPrice) {
  if (!accountBalance || accountBalance <= 0) return 0.10;
  const riskAmount = accountBalance * (RISK.riskPercentPerTrade / 100);
  let slPips = 0;
  if (slPrice && entryPrice && slPrice > 0) {
    const symClean = (symbol || '').replace(/c$/i,'').toUpperCase();
    const isJPY    = symClean.includes('JPY');
    const isGold   = symClean === 'XAUUSD';
    const isBTC    = symClean === 'BTCUSD';
    const rawDiff  = Math.abs(entryPrice - slPrice);
    if (isJPY)       slPips = rawDiff / 0.01;
    else if (isGold) slPips = rawDiff / 0.1;
    else if (isBTC)  slPips = rawDiff / 1.0;
    else             slPips = rawDiff / 0.0001;
  }
  if (slPips < 2) slPips = RISK.defaultSLPips || 20;
  const symClean = (symbol || '').replace(/c$/i,'').toUpperCase();
  const pipValue = RISK.pipValuePerLot[symClean] || RISK.defaultPipValue;
  const lotSize  = riskAmount / (slPips * pipValue);
  const rounded  = Math.round(lotSize / 0.01) * 0.01;
  const clamped  = Math.min(RISK.maxLotSize, Math.max(RISK.minLotSize, rounded));
  console.log(`[AGENT] Lot calc: balance=$${accountBalance} risk=${RISK.riskPercentPerTrade}% ($${riskAmount.toFixed(2)}) SL=${slPips.toFixed(1)}pips pipVal=$${pipValue} → ${clamped} lots`);
  return clamped;
}

const CONF_RANK = { Low: 0, Medium: 1, High: 2 };

function saveSession() {
  try {
    const data = {
      sessionTradeCount,
      agentOpenTickets:   [...agentOpenTickets],
      lastTradeActionAt,
      lastTradeClosedAt,
      lastTradedSymbol,
      lastTradedDirection,
      agentEnabled:       agentState.enabled,
      demoMode:           agentState.demoMode,
      activeTicket:       agentState.activeTicket,
      executedOrders:     agentState.executedOrders,
      decisionLog:        agentState.decisionLog.slice(0, 50),
      savedAt:            new Date().toISOString()
    };
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(data, null, 2));
  } catch(e) {
    console.warn('[AGENT] Could not save session:', e.message);
  }
}

function loadSession() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) { console.log('[AGENT] No saved session found — starting fresh'); return; }
    const raw  = fs.readFileSync(PERSIST_FILE, 'utf8');
    const data = JSON.parse(raw);
    const savedDate = new Date(data.savedAt || 0);
    const today     = new Date();
    const sameDay   = savedDate.getDate()  === today.getDate() &&
                      savedDate.getMonth() === today.getMonth() &&
                      savedDate.getFullYear() === today.getFullYear();
    if (sameDay) {
      sessionTradeCount   = data.sessionTradeCount   || 0;
      lastTradeActionAt   = data.lastTradeActionAt   || null;
      lastTradeClosedAt   = data.lastTradeClosedAt   || null;
      lastTradedSymbol    = data.lastTradedSymbol    || null;
      lastTradedDirection = data.lastTradedDirection || null;
      if (data.agentOpenTickets) data.agentOpenTickets.forEach(t => agentOpenTickets.add(t));
      if (data.activeTicket)     agentState.activeTicket   = data.activeTicket;
      if (data.executedOrders)   agentState.executedOrders = data.executedOrders;
      if (data.decisionLog)      agentState.decisionLog    = data.decisionLog;
      agentState.enabled  = data.agentEnabled !== undefined ? data.agentEnabled : false;
      agentState.demoMode = data.demoMode      !== undefined ? data.demoMode     : true;
      console.log(`[AGENT] Session restored — trades: ${sessionTradeCount}/${RISK.maxTradesPerSession} activeTicket: ${agentState.activeTicket || 'none'}`);
    } else {
      sessionTradeCount = 0;
      agentOpenTickets.clear();
      agentState.enabled  = data.agentEnabled !== undefined ? data.agentEnabled : false;
      agentState.demoMode = data.demoMode      !== undefined ? data.demoMode     : true;
      console.log('[AGENT] New day detected — session count reset, settings preserved');
      saveSession();
    }
  } catch(e) {
    console.warn('[AGENT] Could not load session:', e.message);
  }
}

let lastTradeActionAt   = null;
let lastTradeClosedAt   = null;
let lastTradedSymbol    = null;
let lastTradedDirection = null;

const COOLDOWN = {
  NONE:          0,
  ENTRY:         5  * 60 * 1000,
  SAME_OPPOSITE: 5  * 60 * 1000,
  SAME_SAME:     30 * 60 * 1000,
};

function getDynamicCooldown(attemptedSymbol, attemptedAction, confidence) {
  if (!lastTradeClosedAt) return { ms: 0, reason: '' };
  const symClean   = (attemptedSymbol || '').replace(/c$/i,'').toUpperCase();
  const lastSym    = (lastTradedSymbol || '').replace(/c$/i,'').toUpperCase();
  const sameSymbol = symClean === lastSym;
  const sameDir    = attemptedAction === lastTradedDirection;
  if (!sameSymbol) return { ms: 0, reason: '' };
  if (sameSymbol && sameDir) {
    const elapsed   = Date.now() - lastTradeClosedAt;
    const remaining = COOLDOWN.SAME_SAME - elapsed;
    if (remaining > 0) return { ms: remaining, reason: `Same symbol + same direction as closed trade — ${Math.ceil(remaining/60000)} min cooldown (revenge trade prevention)` };
    return { ms: 0, reason: '' };
  }
  if (sameSymbol && !sameDir) {
    const elapsed   = Date.now() - lastTradeClosedAt;
    const remaining = COOLDOWN.SAME_OPPOSITE - elapsed;
    if (remaining > 0) return { ms: remaining, reason: `Same symbol, reversed direction — ${Math.ceil(remaining/60000)} min cooldown` };
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

function riskGate(decision, appState) {
  const { action, symbol, lot, confidence } = decision;
  if (action === 'HOLD' || action === 'WAIT') return { pass: true };

  if (action === 'BUY' || action === 'SELL') {
    const dynCooldown = getDynamicCooldown(symbol, action, confidence);
    if (dynCooldown.ms > 0) return { pass: false, reason: dynCooldown.reason };

    if (lastTradeActionAt) {
      const symClean = (symbol || '').replace(/c$/i,'').toUpperCase();
      const lastSym  = (lastTradedSymbol || '').replace(/c$/i,'').toUpperCase();
      const elapsed  = Date.now() - lastTradeActionAt;
      if (symClean === lastSym && elapsed < COOLDOWN.ENTRY) {
        const secsLeft = Math.ceil((COOLDOWN.ENTRY - elapsed) / 1000);
        return { pass: false, reason: `Entry cooldown on ${symClean} — ${secsLeft}s remaining` };
      }
    }
  }

  if (action === 'BUY' || action === 'SELL') {
    const indicators = appState.indicators || {};
    const rsi   = parseFloat(indicators.rsi || indicators.RSI || 0);
    const ema20 = parseFloat(indicators.ema20 || indicators.EMA20 || 0);
    const ema50 = parseFloat(indicators.ema50 || indicators.EMA50 || 0);
    const price = appState.candlesList?.length ? appState.candlesList[appState.candlesList.length - 1].c : 0;
    if (rsi > 0) {
      if (action === 'BUY'  && rsi > 70) return { pass: false, reason: `RSI overbought (${rsi.toFixed(1)}) — not safe to buy into exhausted move` };
      if (action === 'SELL' && rsi < 30) return { pass: false, reason: `RSI oversold (${rsi.toFixed(1)}) — not safe to sell into exhausted move` };
    }
    if (ema20 > 0 && ema50 > 0 && price > 0) {
      const bullishEMA = price > ema20 || ema20 > ema50;
      const bearishEMA = price < ema20 || ema20 < ema50;
      if (action === 'BUY'  && !bullishEMA) return { pass: false, reason: `EMA misaligned for BUY — price below both EMAs, trend is bearish` };
      if (action === 'SELL' && !bearishEMA) return { pass: false, reason: `EMA misaligned for SELL — price above both EMAs, trend is bullish` };
    }
  }

  if (action === 'BUY' || action === 'SELL') {
    if (CONF_RANK[confidence] < CONF_RANK[RISK.minConfidence])
      return { pass: false, reason: `Confidence ${confidence} below minimum ${RISK.minConfidence}` };
  }

  if (action === 'BUY' || action === 'SELL') {
    const newsCheck = checkNewsPause(symbol, appState.newsEvents);
    if (newsCheck.paused) return { pass: false, reason: newsCheck.reason };
  }

  const symClean = (symbol || '').replace(/c$/i,'').toUpperCase();
  const allowed  = RISK.allowedSymbols.map(s => s.replace(/c$/i,'').toUpperCase());
  if (symClean && !allowed.includes(symClean))
    return { pass: false, reason: `Symbol ${symbol} not in allowed list` };

  if (lot > RISK.maxLotSize)
    return { pass: false, reason: `Lot ${lot} exceeds max ${RISK.maxLotSize}` };

  if (action === 'BUY' || action === 'SELL') {
    if (sessionTradeCount >= RISK.maxTradesPerSession)
      return { pass: false, reason: `Session trade limit reached (${sessionTradeCount}/${RISK.maxTradesPerSession}) — no more entries this session` };
  }

  if (action === 'BUY' || action === 'SELL') {
    const alreadyPending = agentState.pendingOrders.some(o => !o.executed && o.status === 'PENDING');
    if (alreadyPending)
      return { pass: false, reason: 'Already has a PENDING order waiting for Executor EA — no new orders until it executes' };
  }

  if (action === 'BUY' || action === 'SELL') {
    const agentMagic     = 20250603;
    const liveAgentTrades = (appState.openTrades || []).filter(t => parseInt(t.magic || t.magicNumber || 0) === agentMagic);
    if (liveAgentTrades.length > 0) {
      const liveAgentTrade = liveAgentTrades[0];
      if (!agentState.activeTicket) {
        agentState.activeTicket = liveAgentTrade.ticket;
        console.log(`[AGENT] Synced activeTicket from live trades: #${liveAgentTrade.ticket}`);
      }
      const livePL   = parseFloat(liveAgentTrade.profit || 0);
      const liveType = (liveAgentTrade.type || '').toLowerCase();
      if (RISK.preventConflictingDirections) {
        if (action === 'BUY'  && (liveType === 'sell' || liveType === 'short'))
          return { pass: false, reason: `Direction conflict — cannot BUY while a SELL is open (#${liveAgentTrade.ticket}, P/L $${livePL.toFixed(2)}) — CLOSE it first` };
        if (action === 'SELL' && (liveType === 'buy'  || liveType === 'long'))
          return { pass: false, reason: `Direction conflict — cannot SELL while a BUY is open (#${liveAgentTrade.ticket}, P/L $${livePL.toFixed(2)}) — CLOSE it first` };
      }
      return { pass: false, reason: `Agent trade already open: #${liveAgentTrade.ticket} ${liveType.toUpperCase()} P/L $${livePL.toFixed(2)} — HOLD or CLOSE first` };
    }
    if (agentState.activeTicket)
      return { pass: false, reason: `Agent already has active trade #${agentState.activeTicket} — CLOSE it first` };
  }

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

// ── Pattern data filter — applied before sending to Haiku ─────────────────────
// Separates patterns by age and filters candles to trend-aligned only.
// This ensures Haiku only acts on fresh, confirmed signals.
function buildFilteredPatternData(patternData) {
  const bias     = (patternData.bias || 'neutral').toLowerCase();
  const allPats  = patternData.patterns || [];
  const candles  = patternData.candles || patternData.m15_candles || [];

  // ── 1. Split patterns by bar_index age ──────────────────────────────────
  // recent  = bar_index 0–2  → valid, act on these
  // mid     = bar_index 3–8  → informational only, weak signal
  // stale   = bar_index 9+   → ignore entirely, do not trade on these
  const recentPatterns = allPats.filter(p => (p.bar_index ?? 99) <= 2);
  const midPatterns    = allPats.filter(p => (p.bar_index ?? 99) >= 3 && (p.bar_index ?? 99) <= 8);
  const stalePatterns  = allPats.filter(p => (p.bar_index ?? 99) > 8);

  // ── 2. Filter candles to trend-aligned only ───────────────────────────────
  // Sort newest first so slice(0,5) gets the most recent
  let sortedCandles = [...candles];
  if (sortedCandles[0] && sortedCandles[0].time) {
    sortedCandles.sort((a, b) => new Date(b.time) - new Date(a.time));
  }

  let alignedCandles;
  if (bias === 'bullish') {
    // Only show green candles (close > open) — confirms upward momentum
    alignedCandles = sortedCandles.filter(c => parseFloat(c.close) > parseFloat(c.open)).slice(0, 5);
  } else if (bias === 'bearish') {
    // Only show red candles (close < open) — confirms downward momentum
    alignedCandles = sortedCandles.filter(c => parseFloat(c.close) < parseFloat(c.open)).slice(0, 5);
  } else {
    // Neutral — send last 5 candles regardless
    alignedCandles = sortedCandles.slice(0, 5);
  }

  // ── 3. Build clean payload — no demand/supply zones ──────────────────────
  return {
    symbol:               patternData.symbol,
    timeframe:            patternData.timeframe,
    bias,
    bias_score:           patternData.bias_score,
    rsi:                  patternData.rsi,
    ema_bias:             patternData.ema_bias,
    sr_levels:            patternData.sr_levels || [],          // S/R only, no demand/supply

    // Patterns split by age — Haiku told to only act on recent_patterns
    recent_patterns:      recentPatterns,                       // bar_index 0–2 — TRADE ON THESE
    mid_patterns_count:   midPatterns.length,                   // 3–8 bars ago — count only
    stale_patterns_count: stalePatterns.length,                 // 9+ bars ago — ignored

    // Candles filtered to match bias direction
    aligned_candles:      alignedCandles,
    aligned_candles_note: bias !== 'neutral'
      ? `Only ${bias} candles shown — ${alignedCandles.length} of ${candles.length} total confirm ${bias} direction`
      : `Neutral bias — showing last ${alignedCandles.length} candles`,

    // Hard flags for Haiku's decision logic
    has_recent_confirmation: recentPatterns.length > 0,
    has_candle_alignment:    alignedCandles.length > 0,
    pattern_bias_conflict:   recentPatterns.length > 0 &&
      recentPatterns.some(p =>
        (bias === 'bullish' && p.type === 'bear') ||
        (bias === 'bearish' && p.type === 'bull')
      )
  };
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

  // ── Filter pattern data before it reaches Haiku ───────────────────────────
  const filteredPatterns = buildFilteredPatternData(patternData);

  return [
    `AUTONOMOUS AGENT DECISION REQUEST — ${sym} — ${new Date().toUTCString()}`,
    `\n=== SOURCE 1: PRICE + INDICATORS ===`,
    JSON.stringify({ symbol: sym, timeframe: appState.timeframe, price: appState.candlesList?.length ? appState.candlesList[appState.candlesList.length-1].c : 0, ...appState.indicators }, null, 2),
    `\n=== SOURCE 2: SMC DATA ===`,
    JSON.stringify(smcData, null, 2),
    `\n=== SOURCE 3: AGENT TRADE STATUS ===`,
    agentTrade
      ? `Agent has open trade: Ticket #${agentTrade.ticket} ${agentTrade.type} ${agentTrade.volume} lots @ ${agentTrade.openPrice} | P/L: $${parseFloat(agentTrade.profit).toFixed(2)} | SL: ${agentTrade.sl} | TP: ${agentTrade.tp}`
      : `No active agent trade — agent is flat`,
    `\n=== SOURCE 4: RECENT M15 CANDLES (last 8, all directions) ===`,
    candleSummary,
    `\n=== SOURCE 5: PATTERN DETECTOR (pre-filtered) ===`,
    JSON.stringify(filteredPatterns, null, 2),
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
          lastTradedDirection = null;
          console.log(`[AGENT] activeTicket cleared — dynamic cooldown started`);
          tg(`📌 <b>Manual close detected</b>\nTicket #${ticket} closed outside agent\nSession count: ${sessionTradeCount}/${RISK.maxTradesPerSession}\nCooldown started`);
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
- Lot size is calculated server-side from account balance — suggest 0.10 as placeholder only.
- Max 1 lot per trade. Only 1 open trade at a time.
- Do NOT open a new trade if an agent trade is already open — say HOLD or CLOSE instead.
- CLOSE if structure flipped, TP near, or setup invalidated.
- HOLD if trade is in profit and setup still valid.
- WAIT if no clear setup.

=== SOURCE 5 PATTERN RULES (critical — read carefully) ===
The pattern data you receive in SOURCE 5 has already been pre-filtered. You must follow these rules:

1. RECENT PATTERNS ONLY: Only act on patterns in "recent_patterns" (bar_index 0–2, current candle area).
   - "mid_patterns_count" tells you how many patterns are 3–8 bars old — treat as background context only, do NOT trade on them alone.
   - "stale_patterns_count" tells you how many patterns are 9+ bars old — these are EXPIRED. Ignore completely.

2. CANDLE ALIGNMENT: "aligned_candles" contains ONLY candles that match the current bias direction.
   - If "has_candle_alignment" is false (no aligned candles), candle structure does NOT confirm the bias.
   - Treat empty aligned_candles as a WEAK signal — do not enter if this is the only concern.

3. PATTERN-BIAS CONFLICT: If "pattern_bias_conflict" is true, recent patterns are pointing AGAINST the bias.
   - This is a contradiction — return WAIT, do not force an entry.

4. ENTRY GATE — ALL of the following must be true to BUY or SELL:
   - SOURCE 1: EMA trend aligned, RSI not extreme (not >70 for buys, not <30 for sells)
   - SOURCE 2: SMC structure supports it (BOS/CHoCH in direction, valid OB or FVG present)
   - SOURCE 5: has_recent_confirmation = true (at least 1 pattern in last 2 bars)
   - SOURCE 5: has_candle_alignment = true (recent candles confirm the direction)
   - SOURCE 5: pattern_bias_conflict = false (no contradiction)
   - If ANY of these fail → return WAIT

5. If recent_patterns is empty (has_recent_confirmation = false) → return WAIT regardless of other sources.
   Other sources can agree perfectly — without fresh pattern confirmation, no trade.

6. S/R only: Use sr_levels for support/resistance context. There are no demand/supply zones in this system.

After 2-3 sentence analysis, end with EXACTLY these lines — no markdown, no bold, no extra text:

ACTION: BUY
SYMBOL: GBPUSD
LOT: 0.10
SL: 1.25000
TP: 1.25400
CONFIDENCE: High
REASON: BOS above OB confirmed, FVG filled, H4 bullish bias, recent engulfing pattern bar_index 1

Or if no trade:
ACTION: WAIT
SYMBOL: GBPUSD
CONFIDENCE: Low
REASON: No recent pattern confirmation — stale patterns only, waiting for fresh signal

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

  agentState.lastDecision   = logEntry;
  agentState.lastAction     = decision.action;
  agentState.lastReason     = decision.reason;
  agentState.lastConfidence = decision.confidence;
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
    const accountBalance = parseFloat((appState.accountInfo || {}).balance || 0);
    const currentPrice   = appState.candlesList?.length
      ? appState.candlesList[appState.candlesList.length - 1].c
      : 0;
    const calculatedLot  = calculateLotSize(decision.symbol, accountBalance, decision.sl, currentPrice);

    const order = {
      id:         Date.now(),
      action:     decision.action,
      symbol:     decision.symbol,
      lot:        calculatedLot,
      sl:         decision.sl,
      tp:         decision.tp,
      confidence: decision.confidence,
      reason:     decision.reason,
      time:       new Date().toISOString(),
      status:     agentState.demoMode ? 'DEMO_PENDING' : 'PENDING',
      executed:   false
    };

    sessionTradeCount++;
    agentState.pendingOrders.push(order);
    if (agentState.pendingOrders.length > 20) agentState.pendingOrders.shift();

    lastTradeActionAt = Date.now();
    lastTradedSymbol  = decision.symbol;
    saveSession();

    const dirIcon = decision.action === 'BUY' ? '🟢' : '🔴';
    await tg(
      `${dirIcon} <b>Agent ${modeTag} ${decision.action}</b>\n` +
      `📊 ${decision.symbol} · ${calculatedLot} lot\n` +
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
    lastTradeClosedAt   = Date.now();
    lastTradedDirection = (agentState.lastAction === 'BUY' ? 'BUY' : 'SELL');
    lastTradedSymbol    = decision.symbol;
    lastTradeActionAt   = null;
    saveSession();

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

  app.get('/api/agent-orders', (req, res) => {
    const pending = agentState.pendingOrders.filter(o => !o.executed && o.status === 'PENDING');
    res.json({ orders: pending, agentEnabled: agentState.enabled, demoMode: agentState.demoMode });
  });

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
      agentOpenTickets.add(String(ticket));
    }
    if (order.action === 'CLOSE') {
      agentState.activeTicket = null;
      agentOpenTickets.delete(String(ticket));
      lastTradeClosedAt   = Date.now();
      lastTradedSymbol    = order.symbol;
      const closedTrade   = agentState.executedOrders.find(o =>
        (o.action === 'BUY' || o.action === 'SELL') && String(o.ticket) === String(ticket)
      );
      lastTradedDirection = closedTrade ? closedTrade.action : null;
      console.log(`[AGENT] Trade closed by agent — symbol=${lastTradedSymbol} direction=${lastTradedDirection} — dynamic cooldown started`);
    }
    console.log(`[AGENT] Order #${orderId} confirmed — Ticket #${ticket} @ ${executedPrice}`);
    tg(`✅ <b>Agent Order Executed</b>\n${order.action} ${order.symbol} ${order.lot||''} lot\nTicket: #${ticket}\nPrice: ${executedPrice}`);
    saveSession();
    res.json({ ok: true });
  });

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
    saveSession();
    tg(`🔄 <b>Agent Session Reset</b>\nSession count reset from ${before} to 0\nAll cooldowns cleared\nAgent ready for new trades`);
    res.json({ ok: true, previousCount: before, sessionTradeCount: 0 });
  });

  app.post('/api/agent-flush', (req, res) => {
    const before  = agentState.pendingOrders.length;
    agentState.pendingOrders = agentState.pendingOrders.filter(o => o.executed);
    const flushed = before - agentState.pendingOrders.length;
    console.log(`[AGENT] Flushed ${flushed} pending orders`);
    tg(`🗑️ <b>Agent orders flushed</b>\n${flushed} pending orders cleared`);
    res.json({ ok: true, flushed });
  });

  app.get('/api/agent-status', (req, res) => {
    res.json({
      enabled:             agentState.enabled,
      demoMode:            agentState.demoMode,
      lastAction:          agentState.lastAction,
      lastReason:          agentState.lastReason,
      lastConfidence:      agentState.lastConfidence,
      lastRunAt:           agentState.lastRunAt,
      runCount:            agentState.runCount,
      activeTicket:        agentState.activeTicket,
      pendingCount:        agentState.pendingOrders.filter(o => !o.executed).length,
      recentDecisions:     agentState.decisionLog.slice(0, 50),
      executedOrders:      agentState.executedOrders.slice(0, 20),
      lastDecision:        agentState.lastDecision,
      cooldownActive:      (lastTradeClosedAt && (Date.now() - lastTradeClosedAt) < COOLDOWN.SAME_SAME) ||
                           (lastTradeActionAt && (Date.now() - lastTradeActionAt) < COOLDOWN.ENTRY),
      cooldownSecsLeft:    lastTradeClosedAt
                             ? Math.max(0, Math.ceil((COOLDOWN.SAME_SAME - (Date.now() - lastTradeClosedAt)) / 1000))
                             : lastTradeActionAt
                               ? Math.max(0, Math.ceil((COOLDOWN.ENTRY - (Date.now() - lastTradeActionAt)) / 1000))
                               : 0,
      sessionTradeCount,
      maxTradesPerSession: RISK.maxTradesPerSession,
      trackedTickets:      [...agentOpenTickets],
      riskPercentPerTrade: RISK.riskPercentPerTrade,
      dailyLossCaps:       RISK.dailyLossBySym,
      dailyLossDefault:    RISK.dailyLossDefault,
      newsPauseMins:       { before: RISK.newsPauseMinsBeforeEvent, after: RISK.newsPauseMinsAfterEvent },
      errors:              agentState.errors
    });
  });

  app.post('/api/agent-control', (req, res) => {
    const { enabled, demoMode } = req.body;
    const wasDemo = agentState.demoMode;
    if (typeof enabled  === 'boolean') agentState.enabled  = enabled;
    if (typeof demoMode === 'boolean') agentState.demoMode = demoMode;
    if (wasDemo && !agentState.demoMode) {
      const before  = agentState.pendingOrders.length;
      agentState.pendingOrders = agentState.pendingOrders.filter(o => o.executed);
      const flushed = before - agentState.pendingOrders.length;
      if (flushed > 0) {
        console.log(`[AGENT] Mode switched DEMO→LIVE — auto-flushed ${flushed} stale orders`);
        tg(`🔄 <b>Switched to LIVE mode</b>\n${flushed} stale DEMO orders cleared automatically\nNext agent decision will create fresh LIVE orders`);
      }
    }
    console.log(`[AGENT] Control — enabled=${agentState.enabled} demoMode=${agentState.demoMode}`);
    saveSession();
    if (!wasDemo || agentState.demoMode !== wasDemo) {
      tg(`🤖 <b>Agent ${agentState.enabled ? 'ENABLED' : 'DISABLED'}</b>\nMode: ${agentState.demoMode ? '🔵 DEMO (no real trades)' : '⚡ LIVE (real trades active)'}`);
    }
    res.json({ ok: true, enabled: agentState.enabled, demoMode: agentState.demoMode });
  });

  app.post('/api/agent-run', async (req, res) => {
    if (!agentState.enabled) return res.status(400).json({ error: 'Agent is disabled — enable it first' });
    const appState = getAppState();
    res.json({ ok: true, message: 'Agent run triggered' });
    runAgent(appState, smcStore, candlesStore).catch(console.error);
  });

  app.get('/api/agent-log', (req, res) => {
    res.json({ decisions: agentState.decisionLog, executedOrders: agentState.executedOrders });
  });

  app.post('/api/agent-clear-executed', (req, res) => {
    const count = agentState.executedOrders.length;
    agentState.executedOrders = [];
    saveSession();
    console.log(`[AGENT] Cleared ${count} executed orders`);
    res.json({ ok: true, cleared: count });
  });

  app.post('/api/agent-clear-log', (req, res) => {
    const count = agentState.decisionLog.length;
    agentState.decisionLog  = [];
    agentState.lastDecision = null;
    saveSession();
    console.log(`[AGENT] Cleared ${count} decision log entries`);
    res.json({ ok: true, cleared: count });
  });

  console.log('[AGENT] Routes registered: /api/agent-orders, /api/agent-status, /api/agent-control, /api/agent-run, /api/agent-flush, /api/agent-clear-executed, /api/agent-clear-log, /api/agent-log');
}

// ── Decision loop ─────────────────────────────────────────────────────────────
function startAgentLoop(getAppState, smcStore, candlesStore) {
  loadSession();
  setInterval(() => {
    if (!agentState.enabled) return;
    runAgent(getAppState(), smcStore, candlesStore).catch(console.error);
  }, 60 * 1000);
  setInterval(saveSession, 5 * 60 * 1000);
  console.log('[AGENT] Decision loop started — runs every 60s when enabled');
  console.log('[AGENT] Session persistence active —', PERSIST_FILE);
}

async function triggerAgentOnCandle(appState, smcStore, candlesStore, timeframe) {
  if (!agentState.enabled) return;
  if (!['H1', 'H4'].includes(timeframe)) return;
  console.log(`[AGENT] Candle trigger — ${timeframe} closed, running agent...`);
  runAgent(appState, smcStore, candlesStore).catch(console.error);
}

module.exports = { registerAgentRoutes, startAgentLoop, triggerAgentOnCandle, agentState };
