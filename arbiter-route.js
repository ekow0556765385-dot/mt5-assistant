// ═══════════════════════════════════════════════════════════════════
// arbiter-route.js — BLACKWOOD ARBITER, Phase 1: the foundations
//
// No UI. Three things, all recorded on the SERVER off the EA heartbeat so
// they are true whether or not any browser tab is open:
//
//   1. TRADE ERRORS AS EPISODES. The Assistant computes its errors in the
//      browser (analyzeErrors in index.html), so they only exist while that
//      tab is open. The rules are ported here VERBATIM — same thresholds,
//      same conditions — and each one is tracked as an episode with an open
//      and a close time. Duration is the point: a stop set in 90 seconds is
//      an oversight, a stop set after two hours is a way of trading.
//
//   2. MFE / MAE for every open position — the best and worst the trade has
//      been. Tracked from candle highs/lows since entry plus the live price
//      on every beat, and from the EA's own floating profit. Water marks
//      only ever widen, so a restart or an account switch cannot shrink them.
//
//   3. THE ACCOUNT TIMELINE. Arbiter belongs to the trader, not the account.
//      Everything is keyed on user_id; account_number is a column, never a
//      partition — the same model trade_journal already uses successfully.
//
// Mount (app.js):
//   const arbiter = require('./arbiter-route')(app, { ...deps });
//   ...and inside /api/update, after resolveDueVerdicts:
//   arbiter.onHeartbeat(userId, sourceId, liveAccountNumber);
//
// Tables: arbiter-schema.sql (run once in the Supabase SQL editor).
// ═══════════════════════════════════════════════════════════════════
'use strict';

// ── Tunables ────────────────────────────────────────────────────────
// Every threshold below is copied from index.html's analyzeErrors /
// exposureErrors. If one changes there it must change here, or the
// Assistant tab and Arbiter will describe the same trade differently.
const RULES = {
  OVERSIZE_PCT:      2.5,    // single position riskPct > 2.5
  PLATFORM_TOTAL:    2,      // cumulative risk across positions > 2
  CUMULATIVE_HIGH:   4,      // ...high severity above 4
  REVENGE_WINDOW_S:  900,    // re-entry within 15 min of a closed loss — IDENTICAL to the tab
  // The tab's fix line advises a 30-minute cooldown but only DETECTS 15, by
  // design: it is a live warning panel, not a scorekeeper. Arbiter is the
  // analytics engine, so it also records the softer breach — a re-entry
  // between 16 and 30 minutes. Separate type, lower severity: it is not
  // revenge, it is entering inside the cooldown Blackwood advises.
  COOLDOWN_S:        1800,
  LOSS_LOOKBACK_S:   3600,   // losses considered: closed in the last hour
  RAPID_WINDOW_S:    300,    // 3+ positions opened inside 5 minutes
  RAPID_COUNT:       3,
  OVERTRADE_LIMIT:   6,      // trades opened today (closed + open)
  NEWS_WINDOW_S:     900,    // +/- 15 min around a HIGH impact release
  MARGIN_LEVEL_WARN: 200,    // margin level % below this
  MARGIN_LEVEL_HIGH: 150,
  MARGIN_USED_WARN:  0.30    // share of equity tied up as margin
};

const STALE_MS        = 15 * 60 * 1000; // no beat for 15 min = stop the clock
const TOUCH_MS        = 60 * 1000;      // persist last_true_at at most once a minute
const POSITION_SAVE_MS= 60 * 1000;      // persist water marks at most once a minute
const ACCOUNT_TOUCH_MS= 10 * 60 * 1000; // bump accounts.last_seen at most every 10 min
const RULE_CACHE_MS   = 5 * 60 * 1000;  // re-read the trader's risk rule every 5 min

// ── The call ledger (Phase 5) — Assan's rules ─────────────────────
const WINDOW_MS  = 20 * 60 * 1000;     // execution window: decide within 20 min
const HORIZON_MS = 4 * 60 * 60 * 1000; // outcome horizon: the trade's expected life
const ATR_BARS   = 14;                 // "it ran" = 1 ATR in the call's direction first

// ── Pip size — identical to brain-adapter2.js pipSizeFor ───────────
function pipSizeFor(sym) {
  if (/JPY$/.test(sym)) return 0.01;
  if (/^XAU/.test(sym)) return 0.1;
  if (/^XAG/.test(sym)) return 0.01;
  if (/^(BTC|ETH)/.test(sym)) return 1;
  return 0.0001;
}

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const int = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
const iso = ms => new Date(ms).toISOString();
const utcDay = sec => new Date(sec * 1000).toISOString().slice(0, 10);

// Candle accessors — the store holds {t,o,h,l,c}, older feeds {time,...}.
const cT = c => int(c.t !== undefined ? c.t : c.time);
const cH = c => num(c.h !== undefined ? c.h : c.high);
const cL = c => num(c.l !== undefined ? c.l : c.low);

// ═══════════════════════════════════════════════════════════════════
// THE RULES — a pure function. Same inputs as analyzeErrors, returns the
// set of conditions that are TRUE right now, each with a stable key so the
// same condition on the next beat is recognised as the same episode.
//
// Two deliberate differences from the tab, both about identity rather than
// judgement:
//   • "Over your own limit" is one row per trade in the tab (grouped for
//     reading) but one episode PER TICKET here, because each position's
//     breach starts and ends at its own moment.
//   • "No risk rule set" is not recorded. It is a nudge about settings, not
//     something the trader did, and it would pollute habit statistics.
// ═══════════════════════════════════════════════════════════════════
function evaluateErrors({ openTrades, closedTrades, accountInfo, news, riskRule, nowSec, normalise }) {
  const out = [];
  const trades = Array.isArray(openTrades) ? openTrades : [];
  const norm = normalise || (s => String(s || '').toUpperCase());

  // ── per-trade: no stop loss, oversize ────────────────────────────
  trades.forEach(t => {
    const ticket = String(t.ticket || '');
    if (!ticket) return;
    const sym = norm(t.symbol);
    if (!t.sl || num(t.sl) === 0) {
      out.push({ key: 'no_sl:' + ticket, type: 'no_sl', severity: 'high', ticket, symbol: sym,
        title: `No Stop Loss — ${t.symbol} #${t.ticket}`,
        detail: `Trade on ${t.symbol} has no stop loss set.`,
        metric: { volume: num(t.volume || t.lots), riskPct: num(t.riskPct) } });
    }
    const r = num(t.riskPct);
    if (r > RULES.OVERSIZE_PCT) {
      out.push({ key: 'oversize:' + ticket, type: 'oversize', severity: 'medium', ticket, symbol: sym,
        title: `Oversize Position — ${t.symbol} (${r.toFixed(1)}% risk)`,
        detail: `Risks ${r.toFixed(1)}% of account — above 2% rule.`,
        metric: { riskPct: r, volume: num(t.volume || t.lots) } });
    }
  });

  // ── revenge: a closed LOSS in the last hour, re-entered within 15 min ──
  const closed = (Array.isArray(closedTrades) ? closedTrades : [])
    .map(t => ({ sym: t.symbol, p: num(t.profit), t: int(t.time) }))
    .filter(t => t.t > 0);
  const losses = closed.filter(t => t.p < 0 && (nowSec - t.t) < RULES.LOSS_LOOKBACK_S);
  let revenge = null;
  losses.forEach(L => {
    trades.forEach(t => {
      const ot = int(t.openTime); if (!ot) return;
      const gap = ot - L.t;
      if (gap >= 0 && gap <= RULES.REVENGE_WINDOW_S) {
        if (!revenge || gap < revenge.gap)
          revenge = { gap, mins: Math.max(1, Math.round(gap / 60)), ticket: String(t.ticket || ''),
                      sym: t.symbol, lost: L.sym, amt: Math.abs(L.p), lossAt: L.t };
      }
    });
  });
  // Cooldown breach — Arbiter only. Uses the same pairing as revenge, but the
  // wider window, and never double-counts: a gap already flagged as revenge
  // is not also a cooldown breach.
  let cooldown = null;
  losses.forEach(L => {
    trades.forEach(t => {
      const ot = int(t.openTime); if (!ot) return;
      const gap = ot - L.t;
      if (gap > RULES.REVENGE_WINDOW_S && gap <= RULES.COOLDOWN_S) {
        if (!cooldown || gap < cooldown.gap)
          cooldown = { gap, mins: Math.max(1, Math.round(gap / 60)), ticket: String(t.ticket || ''),
                       sym: t.symbol, lost: L.sym, amt: Math.abs(L.p), lossAt: L.t };
      }
    });
  });
  if (cooldown && cooldown.ticket && !(revenge && revenge.ticket === cooldown.ticket)) {
    out.push({ key: 'cooldown:' + cooldown.ticket, type: 'cooldown_breach', severity: 'medium',
      ticket: cooldown.ticket, symbol: norm(cooldown.sym),
      title: `Re-entered ${cooldown.mins} min after a loss — inside the 30-minute cooldown`,
      detail: `A losing trade on ${cooldown.lost} closed down ${cooldown.amt.toFixed(2)}, then ${cooldown.sym} was opened ${cooldown.mins} minutes later. Not fast enough to call revenge, but inside the cooldown Blackwood advises.`,
      metric: { gapSeconds: cooldown.gap, lossAmount: cooldown.amt, lossClosedAt: cooldown.lossAt } });
  }

  if (revenge && revenge.ticket) {
    out.push({ key: 'revenge:' + revenge.ticket, type: 'revenge', severity: 'high',
      ticket: revenge.ticket, symbol: norm(revenge.sym),
      title: `Possible Revenge Trading — re-entered ${revenge.mins} min after a loss`,
      detail: `A losing trade on ${revenge.lost} closed down ${revenge.amt.toFixed(2)}, then ${revenge.sym} was opened ${revenge.mins} minute${revenge.mins === 1 ? '' : 's'} later.`,
      metric: { gapSeconds: revenge.gap, lossAmount: revenge.amt, lossClosedAt: revenge.lossAt } });
  }

  // ── rapid entries: 3+ opened in 5 min ────────────────────────────
  const recent = trades.filter(t => (nowSec - int(t.openTime)) < RULES.RAPID_WINDOW_S && int(t.openTime) > 0);
  if (recent.length >= RULES.RAPID_COUNT) {
    const first = recent.slice().sort((a, b) => int(a.openTime) - int(b.openTime))[0];
    out.push({ key: 'rapid:' + String(first.ticket || int(first.openTime)), type: 'rapid', severity: 'high',
      ticket: null, symbol: null,
      title: `Rapid Entries — ${recent.length} trades opened in 5 min`,
      detail: `${recent.length} positions were opened inside five minutes.`,
      metric: { count: recent.length, tickets: recent.map(t => String(t.ticket)) } });
  }

  // ── overtrading: today's total against the daily ceiling ────────
  // UTC day. The tab uses the browser's local midnight; on the server there
  // is no local timezone to use. For a GMT trader the two are identical.
  const dayStart = Math.floor(Date.UTC(
    new Date(nowSec * 1000).getUTCFullYear(),
    new Date(nowSec * 1000).getUTCMonth(),
    new Date(nowSec * 1000).getUTCDate()) / 1000);
  const todayClosed = closed.filter(t => t.t >= dayStart).length;
  const todayOpen = trades.filter(t => int(t.openTime) >= dayStart).length;
  const todayTotal = todayClosed + todayOpen;
  if (todayTotal >= RULES.OVERTRADE_LIMIT) {
    const dayLoss = closed.filter(t => t.t >= dayStart).reduce((a, b) => a + b.p, 0);
    out.push({ key: 'overtrade:' + utcDay(nowSec), type: 'overtrade', severity: dayLoss < 0 ? 'high' : 'medium',
      ticket: null, symbol: null,
      title: `Overtrading — ${todayTotal} trades today`,
      detail: `${todayTotal} trades placed today (limit ${RULES.OVERTRADE_LIMIT}): ${todayClosed} closed, ${todayOpen} still open.`,
      metric: { count: todayTotal, dayPL: dayLoss } });
  }

  // ── high-impact news within +/- 15 min while positions are open ──
  const nearHigh = (Array.isArray(news) ? news : []).filter(n => {
    const diff = int(n.timestamp) - nowSec;
    return n.impact === 'high' && diff > -RULES.NEWS_WINDOW_S && diff < RULES.NEWS_WINDOW_S;
  });
  if (nearHigh.length > 0 && trades.length > 0) {
    const ev = nearHigh[0];
    out.push({ key: 'news:' + String(ev.title || '') + '|' + int(ev.timestamp), type: 'news_exposure', severity: 'medium',
      ticket: null, symbol: null,
      title: `Positions open through ${ev.title}`,
      detail: `${trades.length} position${trades.length === 1 ? '' : 's'} open within 15 minutes of a high-impact release.`,
      metric: { event: ev.title, country: ev.country || null, releaseAt: int(ev.timestamp), positions: trades.length } });
  }

  // ── exposure: cumulative, own rule, leverage ─────────────────────
  const risks = trades.map(t => num(t.riskPct)).filter(v => v > 0);
  const total = risks.reduce((a, b) => a + b, 0);
  const n = risks.length;

  if (total > RULES.PLATFORM_TOTAL && n > 1) {
    out.push({ key: 'cumulative', type: 'cumulative', severity: total > RULES.CUMULATIVE_HIGH ? 'high' : 'medium',
      ticket: null, symbol: null,
      title: `Cumulative exposure — ${n} positions risking ${total.toFixed(1)}% together`,
      detail: `No single one breaks the 2% rule, but together they risk ${total.toFixed(1)}% of the account.`,
      metric: { totalRiskPct: total, positions: n } });
  }

  if (riskRule && riskRule > 0) {
    const lim = riskRule;
    trades.forEach(t => {
      const r = num(t.riskPct);
      if (r > lim && r <= RULES.OVERSIZE_PCT) {
        out.push({ key: 'own_rule:' + String(t.ticket), type: 'own_rule', severity: 'medium',
          ticket: String(t.ticket), symbol: norm(t.symbol),
          title: `Over your own limit — ${t.symbol} at ${r.toFixed(2)}%`,
          detail: `Your Trading Math rule is ${lim}% per trade. This risks ${r.toFixed(2)}% — ${(r / lim).toFixed(1)}x your rule.`,
          metric: { riskPct: r, rule: lim } });
      }
    });
    if (total > lim && n > 1) {
      out.push({ key: 'own_total', type: 'own_total', severity: total > lim * 3 ? 'high' : 'medium',
        ticket: null, symbol: null,
        title: `Total risk ${total.toFixed(1)}% against your ${lim}% rule`,
        detail: `Across ${n} positions you are risking ${total.toFixed(1)}% of the account.`,
        metric: { totalRiskPct: total, rule: lim, positions: n } });
    }
  }

  const eq = num((accountInfo || {}).equity), mar = num((accountInfo || {}).margin);
  if (eq > 0 && mar > 0) {
    const used = mar / eq, level = (eq / mar) * 100;
    if (level < RULES.MARGIN_LEVEL_WARN) {
      out.push({ key: 'margin_level', type: 'margin_level', severity: level < RULES.MARGIN_LEVEL_HIGH ? 'high' : 'medium',
        ticket: null, symbol: null,
        title: `Margin level ${level.toFixed(0)}% — over-leveraged`,
        detail: `${(used * 100).toFixed(0)}% of equity is tied up as margin.`,
        metric: { marginLevel: level, usedShare: used } });
    } else if (used > RULES.MARGIN_USED_WARN) {
      out.push({ key: 'margin_used', type: 'margin_used', severity: 'medium',
        ticket: null, symbol: null,
        title: `${(used * 100).toFixed(0)}% of equity committed as margin`,
        detail: `Margin level is ${level.toFixed(0)}% — not yet dangerous, but a third of the account is committed.`,
        metric: { marginLevel: level, usedShare: used } });
    }
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════
// MFE / MAE — pure. Returns the widest favourable and adverse price seen
// since entry, from candles that OPENED AT OR AFTER the entry (the entry
// bar itself is excluded: its high/low may predate the fill, which would
// overstate the excursion — understating is the honest error) plus the
// current live price. Combined with previous water marks by the caller.
// ═══════════════════════════════════════════════════════════════════
function excursionFrom({ side, openPrice, openTime, candles, livePrice }) {
  let hi = -Infinity, lo = Infinity;
  (Array.isArray(candles) ? candles : []).forEach(c => {
    if (cT(c) < openTime) return;
    const h = cH(c), l = cL(c);
    if (h > 0) hi = Math.max(hi, h);
    if (l > 0) lo = Math.min(lo, l);
  });
  if (livePrice > 0) { hi = Math.max(hi, livePrice); lo = Math.min(lo, livePrice); }
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  const buy = side === 'buy';
  return {
    bestPrice:  buy ? hi : lo,   // most favourable
    worstPrice: buy ? lo : hi    // most adverse
  };
}

// ═══════════════════════════════════════════════════════════════════
// THE CALL LEDGER — pure pieces, tested on their own.
// ═══════════════════════════════════════════════════════════════════
function atrOf(bars) {
  const b = (bars || []).slice(-ATR_BARS);
  if (b.length < 5) return null;
  const s = b.reduce((a, c) => a + Math.max(0, cH(c) - cL(c)), 0);
  return s / b.length > 0 ? s / b.length : null;
}

/* Walk the price path since the call, in time order, and record the FIRST
   moment each threshold was crossed. Bars that opened before the call are
   skipped — their high/low may predate it. If both thresholds are first
   crossed inside the same bar, the order is unknowable from the candle,
   and the outcome is `unclear` rather than guessed either way. */
function firstCrossings(call, bars, livePrice, nowMs) {
  const up = call.direction === 'bull';
  const fav = up ? call.price_at + call.atr : call.price_at - call.atr;
  const adv = up ? call.price_at - call.atr : call.price_at + call.atr;
  let favAt = call.fav_hit_at ? Date.parse(call.fav_hit_at) : null;
  let advAt = call.adv_hit_at ? Date.parse(call.adv_hit_at) : null;
  let sameBar = !!call.same_bar;
  const created = Date.parse(call.created_at);
  const horizonEnd = created + HORIZON_MS;
  (bars || []).slice().sort((a, b) => cT(a) - cT(b)).forEach(c => {
    const t = cT(c) * 1000;
    if (t < created || t > horizonEnd) return;
    const hitFav = up ? cH(c) >= fav : cL(c) <= fav;
    const hitAdv = up ? cL(c) <= adv : cH(c) >= adv;
    if (hitFav && hitAdv && favAt == null && advAt == null) sameBar = true;
    if (hitFav && favAt == null) favAt = t;
    if (hitAdv && advAt == null) advAt = t;
  });
  if (livePrice > 0 && nowMs <= horizonEnd) {
    if ((up ? livePrice >= fav : livePrice <= fav) && favAt == null) favAt = nowMs;
    if ((up ? livePrice <= adv : livePrice >= adv) && advAt == null) advAt = nowMs;
  }
  return { favAt, advAt, sameBar };
}

function outcomeOf(x, nowMs, created) {
  if (x.sameBar) return 'unclear';
  if (x.favAt != null && (x.advAt == null || x.favAt < x.advAt)) return 'ran';
  if (x.advAt != null && (x.favAt == null || x.advAt < x.favAt)) return 'failed';
  if (x.favAt != null && x.favAt === x.advAt) return 'unclear';
  return nowMs >= created + HORIZON_MS ? 'flat' : null;       // null = still running
}

/* Assan's rule for SKIPS: if a skipped setup ran, Arbiter was wrong. A take
   is right only if it ran. An unclear outcome is excluded, never counted. */
function correctness(kind, outcome) {
  if (!outcome || outcome === 'unclear') return null;
  if (kind === 'take') return outcome === 'ran';
  if (kind === 'skip') return outcome !== 'ran';
  return null;
}

/* The 2x2 that answers "is it me or the software". Deviated counts as not
   followed — Assan's rule. */
function boxOf(correct, adherence) {
  if (correct == null || !adherence || adherence === 'pending') return null;
  const followed = adherence === 'followed';
  if (correct && followed)  return 'good';        // Blackwood right, you followed
  if (correct && !followed) return 'expensive';   // Blackwood right, you ignored
  if (!correct && followed) return 'ours';        // Blackwood wrong, you followed
  return 'luck';                                  // Blackwood wrong, you ignored
}

/* Match a SETUP call to the trader's trades inside the 20-minute window.
   Same pair + same direction = the call was acted on. Opposite direction =
   deviated. Nothing by the end of the window = the call was passed over.
   What "acted on" means depends on the call: taking a TAKE is following it;
   taking a SKIP is ignoring it. */
function adherenceFor(call, openTrades, nowMs, norm) {
  const created = Date.parse(call.created_at);
  const end = created + WINDOW_MS;
  const hits = (openTrades || []).filter(t => {
    const ot = int(t.openTime) * 1000;
    return norm(t.symbol) === call.symbol && ot >= created && ot <= end;
  }).sort((a, b) => int(a.openTime) - int(b.openTime));
  if (hits.length) {
    const t = hits[0];
    const dir = String(t.type || '').toLowerCase().indexOf('sell') >= 0 ? 'bear' : 'bull';
    if (dir !== call.direction) return { adherence: 'deviated', ticket: String(t.ticket), at: int(t.openTime) * 1000 };
    return { adherence: call.kind === 'take' ? 'followed' : 'ignored', ticket: String(t.ticket), at: int(t.openTime) * 1000 };
  }
  if (nowMs > end) return { adherence: call.kind === 'take' ? 'ignored' : 'followed', ticket: null, at: end };
  return null;                                                 // window still open
}

/* LIVE calls: did the trader do what the action asked, inside the window?
   Recorded, NOT graded for right/wrong — that needs its own rule, which has
   not been decided. A full close on a partial or break-even call is counted
   as followed: it did at least what was asked. */
function liveAdherence(call, openTrades, nowMs) {
  const created = Date.parse(call.created_at);
  const end = created + WINDOW_MS;
  const snap = call.snapshot || {};
  const pos = (openTrades || []).find(t => String(t.ticket) === String(call.ticket));
  const act = call.action;
  if (!pos) {                                                  // the position is gone
    if (act === 'hold') return nowMs <= end ? { adherence: 'ignored', at: nowMs } : null;
    return { adherence: 'followed', at: nowMs };
  }
  if (act === 'partial' && num(pos.volume) < num(snap.volume) - 1e-9) return { adherence: 'followed', at: nowMs };
  if (act === 'be') {
    const sl = num(pos.sl), open = num(snap.openPrice);
    const moved = sl > 0 && (call.direction === 'bull' ? sl >= open : sl <= open);
    if (moved) return { adherence: 'followed', at: nowMs };
  }
  if (nowMs > end) return { adherence: act === 'hold' ? 'followed' : 'ignored', at: end };
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// HABITS (Phase 6) — episodes turned into patterns. Pure, tested alone.
//
// An EPISODE is one stretch of time a condition was true. A HABIT is an
// episode that keeps coming back. The roadmap rule is "only report a habit
// when it recurs"; the definition below is mine and PROVISIONAL:
//   3+ episodes of the same kind, on 2+ different days, in the last 7 days.
// Everything is compared against the trader's OWN last 20 days, and no
// better/worse verdict is given before 5 days of history exist.
// ═══════════════════════════════════════════════════════════════════
const HABIT = { BASELINE_DAYS: 20, MIN_HISTORY_DAYS: 5, RECUR_WINDOW_DAYS: 7,
                RECUR_COUNT: 3, RECUR_DISTINCT_DAYS: 2, WORSE: 1.25, BETTER: 0.75 };
const HABIT_LABELS = {
  no_sl: 'No stop loss', oversize: 'Oversized position', revenge: 'Revenge entry',
  cooldown_breach: 'Inside the 30-minute cooldown', rapid: 'Rapid entries', overtrade: 'Overtrading',
  news_exposure: 'Open through high-impact news', cumulative: 'Cumulative risk too high',
  own_rule: 'Over your own risk rule', own_total: 'Total risk over your rule',
  margin_level: 'Margin level low', margin_used: 'Heavy margin use'
};
/* Some habits are about HOW LONG (a missing stop), others about HOW OFTEN
   (a revenge entry is an event, its "duration" is meaningless). */
const COUNTED = ['revenge', 'cooldown_breach', 'rapid', 'overtrade'];

const DAY = 86400000;
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
function minutesOf(r, nowMs) {
  const end = r.closed_at ? Date.parse(r.closed_at) : nowMs;
  return Math.max(0, (end - Date.parse(r.opened_at)) / 60000);
}

function habitsSummary(rows, nowMs, historyStartMs) {
  const today = dayOf(nowMs);
  const todayStart = Date.parse(today + 'T00:00:00Z');
  const historyDays = historyStartMs
    ? Math.min(HABIT.BASELINE_DAYS, Math.max(0, Math.floor((todayStart - historyStartMs) / DAY)))
    : 0;
  const types = {};
  (rows || []).forEach(r => { (types[r.type] = types[r.type] || []).push(r); });

  const out = Object.keys(HABIT_LABELS).map(type => {
    const all = types[type] || [];
    const counted = COUNTED.indexOf(type) >= 0;
    const td = all.filter(r => Date.parse(r.opened_at) >= todayStart);
    const base = all.filter(r => { const t = Date.parse(r.opened_at);
      return t < todayStart && t >= todayStart - HABIT.BASELINE_DAYS * DAY; });
    const recent = all.filter(r => Date.parse(r.opened_at) >= nowMs - HABIT.RECUR_WINDOW_DAYS * DAY);

    const mins = td.map(r => minutesOf(r, nowMs));
    const today_ = {
      count: td.length,
      minutes: Math.round(mins.reduce((a, b) => a + b, 0)),
      longest: mins.length ? Math.round(Math.max.apply(null, mins)) : 0,
      fixed: td.filter(r => r.close_reason === 'resolved').length,
      open: td.filter(r => !r.closed_at).length
    };
    const baseline = historyDays > 0 ? {
      perDay: +(base.length / historyDays).toFixed(2),
      minutesPerDay: Math.round(base.reduce((a, r) => a + minutesOf(r, nowMs), 0) / historyDays),
      days: historyDays
    } : null;

    // better / worse — only with enough history, and only against the trader's own normal
    let trend = 'too_early';
    if (historyDays >= HABIT.MIN_HISTORY_DAYS) {
      const now = counted ? today_.count : today_.minutes;
      const usual = counted ? baseline.perDay : baseline.minutesPerDay;
      if (usual === 0) trend = now > 0 ? 'worse' : 'clean';
      else if (now > usual * HABIT.WORSE) trend = 'worse';
      else if (now < usual * HABIT.BETTER) trend = 'better';
      else trend = 'usual';
    }

    const recentDays = new Set(recent.map(r => dayOf(Date.parse(r.opened_at))));
    const isHabit = recent.length >= HABIT.RECUR_COUNT && recentDays.size >= HABIT.RECUR_DISTINCT_DAYS;

    // time-to-fix: how long, on average, it took to put right (resolved ones only)
    const fixedAll = all.filter(r => r.close_reason === 'resolved' && Date.parse(r.opened_at) >= todayStart - HABIT.BASELINE_DAYS * DAY);
    const meanFix = fixedAll.length ? Math.round(fixedAll.reduce((a, r) => a + minutesOf(r, nowMs), 0) / fixedAll.length) : null;

    return { type, label: HABIT_LABELS[type], counted, today: today_, baseline, trend,
             habit: isHabit, last7: { count: recent.length, days: recentDays.size },
             meanFixMinutes: counted ? null : meanFix,
             worstToday: td.slice().sort((a, b) => minutesOf(b, nowMs) - minutesOf(a, nowMs))[0] || null };
  });

  // Order: today's problems first (worst first), then habits, then things done well
  const rank = x => (x.today.count ? 3 : 0) + (x.habit ? 2 : 0);
  out.sort((a, b) => rank(b) - rank(a) || (b.today.minutes - a.today.minutes) || (b.today.count - a.today.count));
  return {
    day: today, historyDays, tooEarly: historyDays < HABIT.MIN_HISTORY_DAYS,
    types: out,
    // Good habits are reported too: a clean day on something you usually do
    goodToday: historyDays < HABIT.MIN_HISTORY_DAYS ? []
      : out.filter(x => x.today.count === 0 && x.baseline && x.baseline.perDay > 0).map(x => x.type)
  };
}

// ═══════════════════════════════════════════════════════════════════
// REPORTS (Phase 7) — the facts are assembled HERE, on the server, from
// Arbiter's own tables. Claude only ever sees these facts, never anything
// the browser sends, and its rules forbid inventing a number or
// recommending a trade.
// ═══════════════════════════════════════════════════════════════════
const MODEL = 'claude-haiku-4-5-20251001';            // same model and pricing as /api/analyse
const PRICE_IN = 1, PRICE_OUT = 5;                    // $ per million tokens
const REPORT_TOKENS = { daily: 1400, weekly: 2200 };

const REPORT_RULES = `You are Arbiter, the performance reviewer inside Blackwood, a trading tool for retail forex traders.
You write the trader's review from FACTS supplied as JSON. Your rules, which you never break:
1. Use ONLY numbers present in the facts. Never estimate, extrapolate or invent a figure. If something is not in the facts, do not mention it.
2. You describe what happened. You NEVER recommend a trade, a pair, an entry, a direction or a position size.
3. Separate what the trader controls (following calls, habits, stops, sizing) from what the market did. A losing day with good behaviour is a good day; say so.
4. Look for ONE cause behind several symptoms before listing symptoms. If several errors share a trigger (for example a loss closing just before them), name the trigger.
5. Report good habits as plainly as bad ones.
6. If the facts say the sample is too small, say that nothing can be concluded about the trader or about Blackwood yet. Do not draw conclusions from a handful of calls.
7. "unclear" outcomes and ungraded live calls are excluded from right/wrong. Never count them.
8. End with exactly one concrete thing to try, framed as a measurement, not a rule.
9. Plain language. No hype, no emojis, no bold. Short paragraphs. Use these markdown headings only: "## What went well", "## What cost you", "## The pattern", "## One thing to try".`;

function dayRange(dateStr) {
  const start = Date.parse(dateStr + 'T00:00:00Z');
  return { start, end: start + DAY };
}
/* ISO week: Monday 00:00 UTC to the next Monday. */
function weekOf(ms) {
  const d = new Date(ms); const dow = (d.getUTCDay() + 6) % 7;
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY;
  const thu = new Date(start + 3 * DAY);
  const jan4 = Date.UTC(thu.getUTCFullYear(), 0, 4);
  const week = 1 + Math.round(((start - jan4) / DAY - 3 + ((new Date(jan4).getUTCDay() + 6) % 7)) / 7);
  return { start, end: start + 7 * DAY, key: thu.getUTCFullYear() + '-W' + String(week).padStart(2, '0') };
}

/* The facts for one period — pure, so it can be tested without a database. */
function buildFacts(kind, range, calls, episodes, positions, journal, historyStartMs) {
  const inR = t => { const x = Date.parse(t); return x >= range.start && x < range.end; };
  const cs = (calls || []).filter(c => inR(c.created_at));
  const quad = { good: 0, expensive: 0, ours: 0, luck: 0 };
  cs.forEach(c => { if (c.box && quad[c.box] != null) quad[c.box]++; });
  const graded = quad.good + quad.expensive + quad.ours + quad.luck;
  const trades = (journal || []).filter(t => t.close_time && inR(t.close_time));
  const pl = trades.reduce((a, t) => a + (Number(t.total_pl) || 0), 0);
  const followedSet = new Set(cs.filter(c => c.adherence === 'followed' && c.matched_ticket).map(c => String(c.matched_ticket)));
  const ignoredSet = new Set(cs.filter(c => (c.adherence === 'ignored' || c.adherence === 'deviated') && c.matched_ticket).map(c => String(c.matched_ticket)));
  const plOf = set => trades.filter(t => set.has(String(t.ticket))).reduce((a, t) => a + (Number(t.total_pl) || 0), 0);
  const closedPos = (positions || []).filter(p => p.closed_at && inR(p.closed_at));
  const hs = habitsSummary((episodes || []).filter(e => Date.parse(e.opened_at) < range.end), range.end - 1, historyStartMs);

  return {
    kind, from: new Date(range.start).toISOString(), to: new Date(range.end).toISOString(),
    sampleTooSmall: graded < 10,
    calls: {
      total: cs.length,
      takes: cs.filter(c => c.kind === 'take').length,
      skips: cs.filter(c => c.kind === 'skip').length,
      live: cs.filter(c => c.kind === 'live').length,
      graded, quad,
      stillRunning: cs.filter(c => !c.resolved_at).length,
      excludedUnclear: cs.filter(c => c.outcome === 'unclear').length,
      avgScoreTaken: avg(cs.filter(c => c.kind !== 'live' && c.adherence === (c.kind === 'take' ? 'followed' : 'ignored')).map(c => c.score)),
      avgScoreSkipped: avg(cs.filter(c => c.kind !== 'live' && c.adherence === (c.kind === 'take' ? 'ignored' : 'followed')).map(c => c.score)),
      liveFollowed: cs.filter(c => c.kind === 'live' && c.adherence === 'followed').length,
      liveIgnored: cs.filter(c => c.kind === 'live' && c.adherence === 'ignored').length,
      timeline: cs.slice(0, 40).map(c => ({ at: c.created_at, kind: c.kind, symbol: c.symbol, direction: c.direction,
        score: c.score, action: c.action, adherence: c.adherence || null, outcome: c.outcome || null, box: c.box || null }))
    },
    trades: {
      closed: trades.length,
      netPL: round2(pl),
      plOnFollowed: round2(plOf(followedSet)),
      plOnIgnored: round2(plOf(ignoredSet)),
      list: trades.slice(0, 30).map(t => ({ symbol: t.symbol, direction: t.direction, pl: round2(Number(t.total_pl) || 0),
        pips: t.pips != null ? Number(t.pips) : null, opened: t.open_time, closed: t.close_time, session: t.session || null }))
    },
    // Weekly only: the same facts per day, so a bad day can be seen as ONE
    // bad day rather than read as five bad habits.
    perDay: kind !== 'weekly' ? null : Array.from({ length: Math.round((range.end - range.start) / DAY) }, (_, i) => {
      const ds = range.start + i * DAY, de = ds + DAY;
      const inD = t => { const x = Date.parse(t); return x >= ds && x < de; };
      const dc = cs.filter(c => inD(c.created_at));
      const q = { good: 0, expensive: 0, ours: 0, luck: 0 };
      dc.forEach(c => { if (c.box && q[c.box] != null) q[c.box]++; });
      const dt = trades.filter(t => inD(t.close_time));
      const de_ = (episodes || []).filter(e => inD(e.opened_at));
      return { day: dayOf(ds), calls: dc.length, quad: q,
        followed: dc.filter(c => c.adherence === 'followed').length,
        graded: q.good + q.expensive + q.ours + q.luck,
        trades: dt.length, pl: round2(dt.reduce((a, t) => a + (Number(t.total_pl) || 0), 0)),
        errors: de_.length, errorTypes: Array.from(new Set(de_.map(e => e.type))) };
    }),
    excursions: closedPos.slice(0, 30).map(p => ({ symbol: p.symbol, side: p.side,
      mfePips: p.mfe_pips != null ? Number(p.mfe_pips) : null, maePips: p.mae_pips != null ? Number(p.mae_pips) : null })),
    habits: {
      tooEarlyToCompare: hs.tooEarly, historyDays: hs.historyDays,
      raised: hs.types.filter(h => h.today.count).map(h => ({ what: h.label, count: h.today.count,
        minutesExposed: h.counted ? null : h.today.minutes, longestMinutes: h.counted ? null : h.today.longest,
        putRight: h.today.fixed, isRecurringHabit: h.habit, versusUsual: h.trend,
        example: h.worstToday && h.worstToday.context && h.worstToday.context.first ? h.worstToday.context.first.detail : null })),
      cleanOnUsual: hs.goodToday.map(t => (hs.types.find(h => h.type === t) || {}).label)
    }
  };
}
/* ═══════════════════════════════════════════════════════════════════
   PROGRESS (Phase 7b) and CALIBRATION (Phase 8) — pure, tested alone.

   Everything longitudinal is in R, never money: R = pips won or lost ÷
   the stop distance, from the journal's own entry, stop and close. The
   same on a $500 account and a $50,000 one, so an account change cannot
   bend the line. Dollars are shown only as context, never judged.
   ═══════════════════════════════════════════════════════════════════ */
const PROG = { WEEKS: 12, MIN_WEEKS: 3, WINDOW: 4, CHANGE: 0.10, MIN_BAND: 20, EDGE_SAMPLE: 30 };

function pipOf(sym) {
  sym = String(sym || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
  if (/JPY$/.test(sym)) return 0.01;
  if (/^XAU/.test(sym)) return 0.1;
  if (/^XAG/.test(sym)) return 0.01;
  if (/^(BTC|ETH)/.test(sym)) return 1;
  return 0.0001;
}
/* A trade's result in R. Null when there was no stop — a trade with no
   stop has no defined risk, and inventing one would bend every average. */
function rOf(t) {
  const open = Number(t.open_price), sl = Number(t.sl), close = Number(t.close_price);
  if (!(open > 0) || !(sl > 0) || !(close > 0) || open === sl) return null;
  const pip = pipOf(t.symbol), stop = Math.abs(open - sl) / pip;
  const sell = String(t.direction || '').toLowerCase().indexOf('sell') >= 0;
  // rounded to 4 decimals: float arithmetic otherwise turns an exact 2R into 1.99999
  return Math.round((((sell ? open - close : close - open) / pip) / stop) * 1e4) / 1e4;
}
function median(a) {
  a = (a || []).filter(x => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const r2 = x => x == null ? null : Math.round(x * 100) / 100;

/* One row per ISO week, for the last PROG.WEEKS weeks. */
function weeklyRows(calls, episodes, journal, nowMs) {
  const rows = [];
  const thisWeek = weekOf(nowMs);
  for (let i = PROG.WEEKS - 1; i >= 0; i--) {
    const w = weekOf(thisWeek.start - i * 7 * DAY + DAY);
    const inW = t => { const x = Date.parse(t); return x >= w.start && x < w.end; };
    const cs = (calls || []).filter(c => c.kind !== 'live' && inW(c.created_at) && c.adherence);
    const acted = cs.filter(c => c.adherence);
    const followed = acted.filter(c => c.adherence === 'followed').length;
    const trades = (journal || []).filter(t => t.close_time && inW(t.close_time));
    const rs = trades.map(rOf).filter(x => x != null);
    const ownWay = new Set(cs.filter(c => (c.adherence === 'ignored' || c.adherence === 'deviated') && c.matched_ticket).map(c => String(c.matched_ticket)));
    const ownR = trades.filter(t => ownWay.has(String(t.ticket))).map(rOf).filter(x => x != null);
    const eps = (episodes || []).filter(e => inW(e.opened_at));
    const noSl = eps.filter(e => e.type === 'no_sl');
    const mins = e => Math.max(0, ((e.closed_at ? Date.parse(e.closed_at) : nowMs) - Date.parse(e.opened_at)) / 60000);
    const fixed = noSl.filter(e => e.close_reason === 'resolved');
    const takenScores = cs.filter(c => (c.kind === 'take' && c.adherence === 'followed') || (c.kind === 'skip' && c.adherence === 'ignored')).map(c => c.score);
    rows.push({
      week: w.key, start: new Date(w.start).toISOString(),
      calls: acted.length, trades: trades.length,
      adherence: acted.length ? followed / acted.length : null,
      overrideR: ownR.length ? ownR.reduce((a, b) => a + b, 0) : 0,       // what going your own way returned, in R
      expensive: cs.filter(c => c.box === 'expensive').length,
      unprotectedMinutes: Math.round(noSl.reduce((a, e) => a + mins(e), 0)),
      fixMinutes: fixed.length ? Math.round(fixed.reduce((a, e) => a + mins(e), 0) / fixed.length) : null,
      revenge: eps.filter(e => e.type === 'revenge').length,
      avgScoreTaken: takenScores.length ? Math.round(takenScores.reduce((a, b) => a + b, 0) / takenScores.length) : null,
      expectancyR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
      tradesWithoutR: trades.length - rs.length,
      netPL: r2(trades.reduce((a, t) => a + (Number(t.total_pl) || 0), 0))
    });
  }
  return rows;
}

/* Behaviour decides the verdict; money is context. Each metric knows
   which way is better. */
const METRICS = [
  { id: 'adherence', label: 'Calls you followed', better: 'up', fmt: 'pct' },
  { id: 'overrideR', label: 'What going your own way returned', better: 'up', fmt: 'R' },
  { id: 'unprotectedMinutes', label: 'Minutes with no stop loss', better: 'down', fmt: 'min' },
  { id: 'revenge', label: 'Revenge entries', better: 'down', fmt: 'n' },
  { id: 'avgScoreTaken', label: 'Average score of what you took', better: 'up', fmt: 'n' }
];
function progressSummary(calls, episodes, journal, accounts, nowMs) {
  const rows = weeklyRows(calls, episodes, journal, nowMs);
  const active = rows.filter(r => r.calls || r.trades);
  const out = { rows, activeWeeks: active.length, minWeeks: PROG.MIN_WEEKS, metrics: [], verdict: null };

  if (active.length < PROG.MIN_WEEKS) {
    out.verdict = { key: 'too_early', text: `Not enough weeks yet. Arbiter has ${active.length} week${active.length === 1 ? '' : 's'} of your trading and will not call a direction on fewer than ${PROG.MIN_WEEKS} — two points is a line through noise.` };
  } else {
    // rolling medians: the latest weeks against the ones before them
    const nRecent = Math.min(PROG.WINDOW, Math.ceil(active.length / 2));
    const recent = active.slice(-nRecent), earlier = active.slice(-nRecent - PROG.WINDOW, -nRecent);
    let up = 0, down = 0;
    METRICS.forEach(m => {
      const a = median(earlier.map(r => r[m.id])), b = median(recent.map(r => r[m.id]));
      let dir = 'flat';
      if (a != null && b != null) {
        const diff = b - a, scale = Math.max(Math.abs(a), m.fmt === 'pct' ? 0.1 : m.fmt === 'R' ? 0.5 : 1);
        if (Math.abs(diff) / scale >= PROG.CHANGE) dir = (diff > 0) === (m.better === 'up') ? 'better' : 'worse';
      } else dir = 'unknown';
      if (dir === 'better') up++; else if (dir === 'worse') down++;
      out.metrics.push({ id: m.id, label: m.label, fmt: m.fmt, before: a, now: b, direction: dir,
                         series: rows.map(r => r[m.id]) });
    });
    const money = { before: median(earlier.map(r => r.expectancyR)), now: median(recent.map(r => r.expectancyR)) };
    out.money = money;
    const key = up - down >= 2 ? 'better' : down - up >= 2 ? 'worse' : 'flat';
    const names = d => out.metrics.filter(x => x.direction === d).map(x => x.label.toLowerCase());
    const moneyNote = (money.before != null && money.now != null)
      ? (money.now < money.before && key === 'better'
          ? ' Your results in R went the other way over the same weeks — that is the market, and it is why this verdict is built on behaviour, not money.'
          : '') : '';
    out.verdict = {
      key,
      text: key === 'better' ? `Getting better. Improving: ${names('better').join(', ')}.` + (names('worse').length ? ` Still to work on: ${names('worse').join(', ')}.` : '') + moneyNote
          : key === 'worse' ? `Getting worse. Slipping: ${names('worse').join(', ')}.` + (names('better').length ? ` Holding up: ${names('better').join(', ')}.` : '')
          : `Flat. ${names('better').length ? 'Improving: ' + names('better').join(', ') + '. ' : ''}${names('worse').length ? 'Slipping: ' + names('worse').join(', ') + '. ' : ''}Nothing has moved enough to call.`,
      recentWeeks: recent.map(r => r.week), earlierWeeks: earlier.map(r => r.week)
    };
  }

  // account changes, marked on the week they happened — so a step in the
  // numbers caused by a new account is never read as a change in the trader
  out.accounts = (accounts || []).map(a => ({ account: a.account_number, kind: a.kind || 'unknown',
    week: weekOf(Date.parse(a.first_seen_at)).key, firstSeen: a.first_seen_at }));

  // milestones — nine weeks of small gains are hard to feel from the inside
  const ms = [];
  const firstAt = th => rows.find(r => r.calls >= 5 && r.adherence != null && r.adherence >= th);
  [0.7, 0.8].forEach(th => { const r = firstAt(th);
    ms.push({ id: 'adherence_' + th * 100, label: `First week following ${th * 100}%+ of calls`, done: !!r, when: r ? r.week : null }); });
  const noRev = rows.find(r => r.trades >= 3 && r.revenge === 0);
  ms.push({ id: 'no_revenge', label: 'First week with no revenge entry', done: !!noRev, when: noRev ? noRev.week : null });
  // longest run of days without a missing stop, ending today if still running
  const slDays = new Set((episodes || []).filter(e => e.type === 'no_sl').map(e => dayOf(Date.parse(e.opened_at))));
  const tradeDays = Array.from(new Set((journal || []).filter(t => t.close_time).map(t => dayOf(Date.parse(t.close_time))))).sort();
  let run = 0, best = 0, current = 0;
  tradeDays.forEach(d => { if (slDays.has(d)) run = 0; else { run++; best = Math.max(best, run); } });
  current = run;
  ms.push({ id: 'stop_streak', label: 'Trading days in a row with a stop on every trade', done: best >= 5,
            value: best, current, ongoing: current > 0 && current === best });
  // fingerprints reaching the sample where personal odds become real
  const fp = {};
  (journal || []).forEach(t => { const k = [String(t.symbol || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6),
    String(t.direction || '').toLowerCase().indexOf('sell') >= 0 ? 'short' : 'long', t.session || 'any'].join(' · ');
    fp[k] = (fp[k] || 0) + 1; });
  out.fingerprints = Object.keys(fp).map(k => ({ fingerprint: k, trades: fp[k], unlocked: fp[k] >= PROG.EDGE_SAMPLE }))
    .sort((a, b) => b.trades - a.trades).slice(0, 12);
  out.fingerprints.filter(f => f.unlocked).forEach(f =>
    ms.push({ id: 'fp_' + f.fingerprint, label: `${f.fingerprint} reached ${PROG.EDGE_SAMPLE} trades — your own odds are real now`, done: true }));
  out.milestones = ms;
  return out;
}

/* ═══ CALIBRATION ════════════════════════════════════════════════════
   1. THE SETUP SCORE — higher scores should run more often. If 80+ runs
      less than 55-69, the score is lying and the weights are wrong.
   2. THE PRESSURE THRESHOLDS — the ledger stamped the price at the moment
      Arbiter said CUT or MOVE TO BREAK-EVEN. The journal knows how the
      trade finished. The gap, in R, is what acting would have saved or
      cost. That is the evidence for whether 45 and 20 are right. */
const SCORE_BANDS = [[0, 44, 'under 45 (gated)'], [45, 54, '45–54'], [55, 69, '55–69'], [70, 79, '70–79'], [80, 100, '80+']];
function calibrationSummary(calls, journal, stage) {
  const graded = (calls || []).filter(c => (c.kind === 'take' || c.kind === 'skip') && c.outcome && c.outcome !== 'unclear' && c.score != null);
  const bands = SCORE_BANDS.map(([lo, hi, label]) => {
    const inb = graded.filter(c => c.score >= lo && c.score <= hi);
    const ran = inb.filter(c => c.outcome === 'ran').length;
    return { label, lo, hi, n: inb.length, ran, rate: inb.length ? ran / inb.length : null, enough: inb.length >= PROG.MIN_BAND };
  });
  const solid = bands.filter(b => b.enough);
  let scoreVerdict;
  if (solid.length < 2) scoreVerdict = { key: 'too_early', text: `Not enough graded calls yet. Each score band needs ${PROG.MIN_BAND} before it means anything; ${bands.filter(b => b.n).map(b => b.label + ': ' + b.n).join(', ') || 'none so far'}.` };
  else {
    const inverted = solid.some((b, i) => i > 0 && b.rate < solid[i - 1].rate - 0.10);
    scoreVerdict = inverted
      ? { key: 'inverted', text: 'Higher scores are NOT running more often than lower ones. The score is not honest yet — the weights need changing, and this is the evidence.' }
      : { key: 'honest', text: 'Higher scores run more often than lower ones. The score is doing its job.' };
  }

  // the thresholds — trade by trade, from the ledger's own stamped prices
  const byTicket = {};
  (journal || []).forEach(t => { byTicket[String(t.ticket)] = t; });
  function evidence(action) {
    const rows = [];
    (calls || []).filter(c => c.kind === 'live' && c.action === action && c.ticket && c.price_at).forEach(c => {
      const t = byTicket[String(c.ticket)];
      if (!t) return;                                              // trade not closed yet
      const final = rOf(t);
      const open = Number(t.open_price), sl = Number(t.sl);
      if (final == null || !(sl > 0)) return;
      const pip = pipOf(t.symbol), stop = Math.abs(open - sl) / pip;
      const sell = String(t.direction || '').toLowerCase().indexOf('sell') >= 0;
      const atCall = ((sell ? open - c.price_at : c.price_at - open) / pip) / stop;
      // for a CUT: acting takes the result at the call. For BREAK-EVEN: acting caps the loss at 0R.
      const acting = action === 'cut' ? atCall : Math.max(0, final);
      rows.push({ ticket: c.ticket, pressure: c.score, adherence: c.adherence || null, atCallR: r2(atCall), finalR: r2(final),
                  savedR: r2(acting - final) });
    });
    const held = rows.filter(r => r.adherence !== 'followed');
    const saved = held.map(r => r.savedR);
    return { action, threshold: action === 'cut' ? stage.LOSING_CUT : stage.BE_PRESSURE, calls: rows.length, heldAfter: held.length,
      avgSavedR: saved.length ? r2(saved.reduce((a, b) => a + b, 0) / saved.length) : null,
      wouldHaveHelped: held.filter(r => r.savedR > 0).length,
      enough: held.length >= PROG.MIN_BAND, rows: rows.slice(0, 50) };
  }
  const cut = evidence('cut'), be = evidence('be');
  const read = e => !e.enough
    ? `${e.heldAfter} trade${e.heldAfter === 1 ? '' : 's'} held on after this call so far — ${PROG.MIN_BAND} are needed before the threshold of ${e.threshold} can be judged.`
    : e.avgSavedR > 0 ? `When you held on anyway, acting would have been better by ${e.avgSavedR}R on average (${e.wouldHaveHelped} of ${e.heldAfter}). The threshold of ${e.threshold} is earning its place.`
    : `When you held on anyway, holding did better by ${Math.abs(e.avgSavedR)}R on average. The threshold of ${e.threshold} may be too eager — this is the evidence to move it.`;
  cut.text = read(cut); be.text = read(be);
  return { scoreBands: bands, scoreVerdict, cut, breakEven: be, gradedCalls: graded.length,
           excludedUnclear: (calls || []).filter(c => c.outcome === 'unclear').length };
}

/* ── Automatic reports: consent ──────────────────────────────────────
   The server keeps its OWN copy of the words the trader agreed to, with a
   version, so the record never depends on what a browser claimed it showed.
   Change the wording => bump the version; old consents keep their text. */
const CONSENT_VERSION = 'auto-reports-v1';
const CONSENT_TEXT = {
  auto_daily: 'I want Arbiter to write my daily review automatically, every day, for the day that has just ended. ' +
    'I understand each automatic review is charged to my analysis credits by its length, the same as if I had asked for it, ' +
    'that nothing is charged on a day with nothing to review or if I have no credits left, and that I can turn this off at any time.',
  auto_weekly: 'I want Arbiter to write my weekly review automatically, every Saturday, for the trading week that has just ended. ' +
    'I understand each automatic review is charged to my analysis credits by its length, the same as if I had asked for it, ' +
    'that nothing is charged in a week with nothing to review or if I have no credits left, and that I can turn this off at any time.'
};
const CLAIM_STALE_MS = 10 * 60 * 1000;   // a "writing" claim older than this was abandoned

const avg = a => { a = (a || []).filter(x => x != null); return a.length ? Math.round(a.reduce((p, q) => p + Number(q), 0) / a.length) : null; };
const round2 = x => Math.round(x * 100) / 100;

// ═══════════════════════════════════════════════════════════════════
// THE MODULE
// ═══════════════════════════════════════════════════════════════════
module.exports = function mountArbiter(app, deps) {
  const {
    requirePlan, getState, getCandlesStore, livePriceFor, normalisePair,
    getNews, getRiskSettings, SUPABASE_URL, supabaseServiceHeaders, resolveSource,
    getUserCredits, deductCredits, getJournal,
    cron, getUserPlan, accessState, planRank, sharingBlocked
  } = deps;
  const http = deps.http || require('axios');
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;

  const T = {
    accounts:  `${SUPABASE_URL}/rest/v1/arbiter_accounts`,
    positions: `${SUPABASE_URL}/rest/v1/arbiter_positions`,
    errors:    `${SUPABASE_URL}/rest/v1/arbiter_errors`,
    calls:     `${SUPABASE_URL}/rest/v1/arbiter_calls`,
    reports:   `${SUPABASE_URL}/rest/v1/arbiter_reports`,
    settings:  `${SUPABASE_URL}/rest/v1/arbiter_settings`,
    consent:   `${SUPABASE_URL}/rest/v1/arbiter_consent_log`
  };
  const H = (extra = {}) => ({ headers: supabaseServiceHeaders(extra) });
  const norm = s => (normalisePair && normalisePair(String(s || ''))) || String(s || '').toUpperCase();

  // In-memory state, per user+account. Everything here can be rebuilt from
  // the database, which is what `hydrate` does after a restart.
  //   scope -> { hydrated, busy, lastBeatAt, episodes: Map(key -> ep),
  //              positions: Map(ticket -> pos), accountTouchedAt }
  const scopes = new Map();
  const ruleCache = new Map();   // userId -> { value, at }

  function scopeKey(userId, acct) { return userId + '::' + acct; }
  function getScope(userId, acct) {
    const k = scopeKey(userId, acct);
    if (!scopes.has(k)) scopes.set(k, {
      userId, acct, hydrated: false, busy: false, lastBeatAt: 0,
      episodes: new Map(), positions: new Map(), accountTouchedAt: 0, accountKnown: false,
      calls: new Map()                    // id -> unresolved call row
    });
    return scopes.get(k);
  }

  // ── the trader's own risk rule, from Trading Math (server-side copy) ──
  // Same priority as publishRiskRules in the math dashboard: rorRisk, then psRisk.
  async function riskRuleFor(userId) {
    const c = ruleCache.get(userId);
    if (c && now() - c.at < RULE_CACHE_MS) return c.value;
    let value = null;
    try {
      const s = getRiskSettings ? (await getRiskSettings(userId)) || {} : {};
      const v = num(s.rorRisk) || num(s.psRisk);
      value = v > 0 ? v : null;
    } catch (e) { value = c ? c.value : null; }
    ruleCache.set(userId, { value, at: now() });
    return value;
  }

  // ── rebuild in-memory state from the database after a restart ─────
  // Without this, a restart would open a SECOND episode for a condition
  // that was already open, and double every duration downstream.
  async function hydrate(sc) {
    const q = `user_id=eq.${sc.userId}&account_number=eq.${encodeURIComponent(sc.acct)}`;
    const [eps, pos, acc, cls] = await Promise.all([
      http.get(`${T.errors}?${q}&closed_at=is.null&select=*`, H()),
      http.get(`${T.positions}?${q}&closed_at=is.null&select=*`, H()),
      http.get(`${T.accounts}?${q}&select=account_number`, H()),
      http.get(`${T.calls}?${q}&resolved_at=is.null&select=*`, H())
    ]);
    (cls.data || []).forEach(r => sc.calls.set(String(r.id), r));
    (eps.data || []).forEach(r => sc.episodes.set(r.episode_key, {
      id: r.id, key: r.episode_key, type: r.type, severity: r.severity,
      openedAt: Date.parse(r.opened_at), lastTrueAt: Date.parse(r.last_true_at || r.opened_at),
      touchedAt: Date.parse(r.last_true_at || r.opened_at), peak: r.context && r.context.peak || null,
      first: r.context && r.context.first || null
    }));
    (pos.data || []).forEach(r => sc.positions.set(String(r.ticket), {
      ticket: String(r.ticket), symbol: r.symbol, side: r.side,
      openPrice: num(r.open_price), openTime: int(r.open_time_s),
      best: r.best_price != null ? num(r.best_price) : null,
      worst: r.worst_price != null ? num(r.worst_price) : null,
      bestPL: r.best_pl != null ? num(r.best_pl) : null,
      worstPL: r.worst_pl != null ? num(r.worst_pl) : null,
      lastSeenAt: Date.parse(r.last_seen_at || r.first_seen_at), savedAt: now(), dirty: false, persisted: true
    }));
    sc.accountKnown = (acc.data || []).length > 0;
    sc.hydrated = true;
  }

  // ── close everything left open for a scope that stopped reporting ──
  // The clock stops at the LAST TIME the condition was seen true, not at the
  // moment we noticed the silence — an EA that went offline for six hours
  // did not leave a stop off for six hours that anyone observed.
  async function closeStale(sc, reason) {
    const jobs = [];
    for (const ep of sc.episodes.values()) {
      jobs.push(http.patch(`${T.errors}?id=eq.${ep.id}`, {
        closed_at: iso(ep.lastTrueAt), last_true_at: iso(ep.lastTrueAt), close_reason: reason
      }, H()).catch(e => log.warn('[ARBITER] stale close failed:', e.message)));
    }
    sc.episodes.clear();
    for (const p of sc.positions.values()) {
      jobs.push(http.patch(`${T.positions}?user_id=eq.${sc.userId}&account_number=eq.${encodeURIComponent(sc.acct)}&ticket=eq.${p.ticket}`, {
        ...positionPatch(p), closed_at: iso(p.lastSeenAt), close_reason: reason
      }, H()).catch(e => log.warn('[ARBITER] stale position close failed:', e.message)));
    }
    sc.positions.clear();
    await Promise.all(jobs);
  }

  function positionPatch(p) {
    const pip = pipSizeFor(p.symbol);
    const buy = p.side === 'buy';
    const mfePips = p.best  != null ? (buy ? p.best - p.openPrice : p.openPrice - p.best) / pip : null;
    const maePips = p.worst != null ? (buy ? p.openPrice - p.worst : p.worst - p.openPrice) / pip : null;
    return {
      best_price: p.best, worst_price: p.worst,
      // Pips normalised at WRITE time (spec §9b.3), never at read time.
      mfe_pips: mfePips != null ? +Math.max(0, mfePips).toFixed(1) : null,
      mae_pips: maePips != null ? +Math.max(0, maePips).toFixed(1) : null,
      best_pl: p.bestPL, worst_pl: p.worstPL,
      last_seen_at: iso(p.lastSeenAt)
    };
  }

  // ── account timeline ──────────────────────────────────────────────
  async function touchAccount(sc, accountInfo, sourceId) {
    const t = now();
    if (sc.accountKnown && t - sc.accountTouchedAt < ACCOUNT_TOUCH_MS) return;
    sc.accountTouchedAt = t;
    const ai = accountInfo || {};
    if (!sc.accountKnown) {
      // First sighting: record the STARTING balance. Never overwritten
      // afterwards — it is what R and percent figures are anchored to.
      await http.post(`${T.accounts}?on_conflict=user_id,account_number`, {
        user_id: sc.userId, account_number: sc.acct,
        currency: ai.currency || null, server: ai.server || null,
        starting_balance: num(ai.balance) || null,
        // The EA sends no demo/live flag, so kind is NOT guessed.
        kind: 'unknown', source_id: sourceId || null,
        first_seen_at: iso(t), last_seen_at: iso(t)
      }, H({ 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }));
      sc.accountKnown = true;
    } else {
      await http.patch(`${T.accounts}?user_id=eq.${sc.userId}&account_number=eq.${encodeURIComponent(sc.acct)}`, {
        last_seen_at: iso(t), last_balance: num(ai.balance) || null
      }, H());
    }
  }

  // ── error episodes ────────────────────────────────────────────────
  async function syncEpisodes(sc, current) {
    const t = now();
    const seen = new Set();
    const jobs = [];

    for (const c of current) {
      seen.add(c.key);
      const ep = sc.episodes.get(c.key);
      if (!ep) {
        // A new episode. Inserted before it is added to memory so a failed
        // insert simply retries on the next beat rather than being lost.
        jobs.push((async () => {
          try {
            const { data } = await http.post(T.errors, {
              user_id: sc.userId, account_number: sc.acct, episode_key: c.key,
              type: c.type, severity: c.severity, ticket: c.ticket, symbol: c.symbol,
              opened_at: iso(t), last_true_at: iso(t),
              context: { first: { title: c.title, detail: c.detail, metric: c.metric },
                         last:  { title: c.title, detail: c.detail, metric: c.metric },
                         peak: c.metric || null }
            }, H({ 'Content-Type': 'application/json', Prefer: 'return=representation' }));
            const row = Array.isArray(data) ? data[0] : data;
            if (row && row.id != null) sc.episodes.set(c.key, {
              id: row.id, key: c.key, type: c.type, severity: c.severity,
              openedAt: t, lastTrueAt: t, touchedAt: t, peak: c.metric || null, last: c,
              first: { title: c.title, detail: c.detail, metric: c.metric }
            });
          } catch (e) {
            // 409 = the partial unique index caught a duplicate open episode
            // (two beats racing). Harmless: the next hydrate picks it up.
            if (!(e.response && e.response.status === 409))
              log.warn('[ARBITER] episode open failed:', e.response ? JSON.stringify(e.response.data) : e.message);
            else sc.hydrated = false;
          }
        })());
      } else {
        ep.lastTrueAt = t;
        ep.last = c;
        const escalated = rank(c.severity) > rank(ep.severity);
        if (escalated) ep.severity = c.severity;
        ep.peak = widenPeak(ep.peak, c.metric);
        if (escalated || t - ep.touchedAt >= TOUCH_MS) {
          ep.touchedAt = t;
          jobs.push(http.patch(`${T.errors}?id=eq.${ep.id}`, {
            last_true_at: iso(t), severity: ep.severity,
            // jsonb is replaced wholesale, so `first` must be sent back unchanged
            context: { first: ep.first || null, last: { title: c.title, detail: c.detail, metric: c.metric }, peak: ep.peak }
          }, H()).catch(e => log.warn('[ARBITER] episode touch failed:', e.message)));
        }
      }
    }

    // Conditions that were true and no longer are: the episode ends NOW.
    for (const [key, ep] of sc.episodes) {
      if (seen.has(key)) continue;
      sc.episodes.delete(key);
      jobs.push(http.patch(`${T.errors}?id=eq.${ep.id}`, {
        closed_at: iso(t), last_true_at: iso(ep.lastTrueAt), close_reason: 'resolved'
      }, H()).catch(e => {
        sc.episodes.set(key, ep);   // put it back — retry on the next beat
        log.warn('[ARBITER] episode close failed:', e.message);
      }));
    }
    await Promise.all(jobs);
  }

  function rank(s) { return s === 'high' ? 3 : s === 'medium' ? 2 : 1; }
  function widenPeak(prev, m) {
    if (!m) return prev || null;
    const p = Object.assign({}, prev || {});
    Object.keys(m).forEach(k => {
      const v = m[k];
      if (typeof v === 'number') p[k] = (typeof p[k] === 'number') ? Math.max(p[k], v) : v;
      else if (p[k] === undefined) p[k] = v;
    });
    return p;
  }

  // ── positions and water marks ─────────────────────────────────────
  async function syncPositions(sc, userId, sourceId, openTrades) {
    const t = now();
    const cs = getCandlesStore(userId, sourceId) || {};
    const seen = new Set();
    const jobs = [];

    for (const tr of (openTrades || [])) {
      const ticket = String(tr.ticket || '');
      const openPrice = num(tr.openPrice || tr.open_price);
      if (!ticket || !(openPrice > 0)) continue;
      seen.add(ticket);
      const raw = String(tr.symbol || '');
      const symbol = norm(raw);
      const side = String(tr.type || '').toLowerCase().indexOf('sell') >= 0 ? 'sell' : 'buy';
      const openTime = int(tr.openTime);
      const profit = num(tr.profit);

      let p = sc.positions.get(ticket);
      const isNew = !p;
      if (isNew) {
        p = { ticket, symbol, rawSymbol: raw, side, openPrice, openTime,
              best: null, worst: null, bestPL: null, worstPL: null,
              lastSeenAt: t, savedAt: 0, dirty: true, persisted: false,
              sl: num(tr.sl), tp: num(tr.tp), volume: num(tr.volume || tr.lots), riskPct: num(tr.riskPct) };
        sc.positions.set(ticket, p);
      }
      p.lastSeenAt = t;

      // candles for this symbol from the store (keys are broker symbols)
      const key = Object.keys(cs).find(k => norm(k) === symbol);
      const node = key ? cs[key] || {} : {};
      const bars = (node.candlesByTF && (node.candlesByTF.H1 || node.candlesByTF.H4)) || node.candles || [];
      const live = livePriceFor(userId, sourceId, symbol);
      const ex = excursionFrom({ side, openPrice, openTime, candles: bars, livePrice: live || 0 });

      if (ex) {
        const buy = side === 'buy';
        const better = v => p.best == null || (buy ? v > p.best : v < p.best);
        const worse  = v => p.worst == null || (buy ? v < p.worst : v > p.worst);
        if (better(ex.bestPrice))  { p.best = ex.bestPrice;  p.dirty = true; }
        if (worse(ex.worstPrice))  { p.worst = ex.worstPrice; p.dirty = true; }
      }
      // The EA's own floating profit — exact at beat resolution, in account money.
      if (p.bestPL == null || profit > p.bestPL)   { p.bestPL = profit;  p.dirty = true; }
      if (p.worstPL == null || profit < p.worstPL) { p.worstPL = profit; p.dirty = true; }

      if (!p.persisted) {
        jobs.push(http.post(`${T.positions}?on_conflict=user_id,account_number,ticket`, {
          user_id: sc.userId, account_number: sc.acct, ticket,
          symbol, raw_symbol: raw, side, open_price: openPrice, open_time_s: openTime || null,
          volume: p.volume, risk_pct: p.riskPct || null, sl: p.sl || null, tp: p.tp || null,
          first_seen_at: iso(t), ...positionPatch(p)
        }, H({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }))
          .then(() => { p.persisted = true; p.dirty = false; p.savedAt = t; })
          .catch(e => log.warn('[ARBITER] position insert failed:', e.response ? JSON.stringify(e.response.data) : e.message)));
      } else if (p.dirty && t - p.savedAt >= POSITION_SAVE_MS) {
        p.savedAt = t;
        jobs.push(http.patch(`${T.positions}?user_id=eq.${sc.userId}&account_number=eq.${encodeURIComponent(sc.acct)}&ticket=eq.${ticket}`,
          positionPatch(p), H())
          .then(() => { p.dirty = false; })
          .catch(e => log.warn('[ARBITER] position save failed:', e.message)));
      }
    }

    // Tickets that were open on this account and no longer are: closed.
    for (const [ticket, p] of sc.positions) {
      if (seen.has(ticket)) continue;
      sc.positions.delete(ticket);
      jobs.push(http.patch(`${T.positions}?user_id=eq.${sc.userId}&account_number=eq.${encodeURIComponent(sc.acct)}&ticket=eq.${ticket}`, {
        ...positionPatch(p), closed_at: iso(t), close_reason: 'closed'
      }, H()).catch(e => {
        sc.positions.set(ticket, p);
        log.warn('[ARBITER] position close failed:', e.message);
      }));
    }
    await Promise.all(jobs);
  }

  // ── the ledger, advanced on every beat ─────────────────────────────
  async function syncCalls(sc, userId, sourceId, s) {
    if (!sc.calls.size) return;
    const t = now();
    const cs = getCandlesStore(userId, sourceId) || {};
    const jobs = [];
    for (const [id, call] of sc.calls) {
      const patch = {};
      // adherence, until decided
      if (!call.adherence) {
        const a = call.kind === 'live'
          ? liveAdherence(call, s.openTrades, t)
          : adherenceFor(call, s.openTrades, t, norm);
        if (a) {
          patch.adherence = a.adherence; patch.adherence_at = iso(a.at);
          if (a.ticket !== undefined) patch.matched_ticket = a.ticket;
        }
      }
      // outcome, for setup calls only
      let outcome = call.outcome || null;
      if (call.kind !== 'live' && !outcome && call.atr > 0) {
        const key = Object.keys(cs).find(k => norm(k) === call.symbol);
        const node = key ? cs[key] || {} : {};
        const bars = (node.candlesByTF && node.candlesByTF.H1) || node.candles || [];
        const x = firstCrossings(call, bars, livePriceFor(userId, sourceId, call.symbol) || 0, t);
        if (x.favAt && !call.fav_hit_at) patch.fav_hit_at = iso(x.favAt);
        if (x.advAt && !call.adv_hit_at) patch.adv_hit_at = iso(x.advAt);
        if (x.sameBar && !call.same_bar) patch.same_bar = true;
        outcome = outcomeOf(x, t, Date.parse(call.created_at));
        if (outcome) patch.outcome = outcome;
      }
      if (call.kind === 'live' && !call.outcome) { patch.outcome = 'not_graded'; outcome = 'not_graded'; }

      const merged = Object.assign({}, call, patch);
      const correct = correctness(merged.kind, merged.outcome);
      const box = boxOf(correct, merged.adherence);
      if (correct !== null && merged.correct !== correct) patch.correct = correct;
      if (box && merged.box !== box) patch.box = box;
      const done = merged.adherence && merged.outcome;
      if (done) patch.resolved_at = iso(t);

      if (!Object.keys(patch).length) continue;
      Object.assign(call, patch);
      if (done) sc.calls.delete(id);
      jobs.push(http.patch(`${T.calls}?id=eq.${id}`, patch, H())
        .catch(e => { sc.hydrated = false; log.warn('[ARBITER] call update failed:', e.message); }));
    }
    await Promise.all(jobs);
  }

  // ═════════════════════════════════════════════════════════════════
  // THE HEARTBEAT. Called from /api/update, NOT awaited — the EA must never
  // wait on Supabase. Throttling is PER USER+ACCOUNT, never global: one
  // global timer would let one busy trader starve every other.
  // ═════════════════════════════════════════════════════════════════
  async function onHeartbeat(userId, sourceId, accountNumber) {
    if (!userId || !accountNumber) return;          // no account, nothing to key on
    const acct = String(accountNumber);
    const sc = getScope(userId, acct);
    if (sc.busy) return;                             // previous beat still writing
    sc.busy = true;
    const t = now();
    try {
      if (!sc.hydrated) await hydrate(sc);

      // A gap longer than STALE since the last beat means the clock stopped
      // while we were not watching. Close what was open at its last-seen
      // moment, then start fresh from this beat.
      const lastSeen = sc.lastBeatAt || maxLastTrue(sc);
      if (lastSeen && t - lastSeen > STALE_MS) await closeStale(sc, 'unobserved');
      sc.lastBeatAt = t;

      // Sweep this user's OTHER accounts: switching account in MT5 means
      // the old one stops beating. Its open episodes end where they were
      // last seen rather than running on forever.
      for (const other of scopes.values()) {
        if (other.userId !== userId || other.acct === acct || other.busy) continue;
        if (other.lastBeatAt && t - other.lastBeatAt > STALE_MS && (other.episodes.size || other.positions.size)) {
          other.busy = true;
          closeStale(other, 'unobserved').finally(() => { other.busy = false; });
        }
      }

      const s = getState(userId, sourceId) || {};
      await touchAccount(sc, s.accountInfo, sourceId);

      const current = evaluateErrors({
        openTrades: s.openTrades, closedTrades: s.closedTrades, accountInfo: s.accountInfo,
        news: getNews ? getNews() : [], riskRule: await riskRuleFor(userId),
        nowSec: Math.floor(t / 1000), normalise: norm
      });
      await syncEpisodes(sc, current);
      await syncPositions(sc, userId, sourceId, s.openTrades);
      await syncCalls(sc, userId, sourceId, s);
    } catch (e) {
      log.warn('[ARBITER] heartbeat skipped:', e.response ? JSON.stringify(e.response.data) : e.message);
      sc.hydrated = false;   // re-read from the database next time rather than trust memory
    } finally {
      sc.busy = false;
    }
  }
  function maxLastTrue(sc) {
    let m = 0;
    for (const ep of sc.episodes.values()) m = Math.max(m, ep.lastTrueAt || 0);
    for (const p of sc.positions.values()) m = Math.max(m, p.lastSeenAt || 0);
    return m;
  }

  // ═════════════════════════════════════════════════════════════════
  // READ ROUTES — so Phase 1 can be verified on a live account before any
  // UI exists. Open /api/arbiter/status in a signed-in browser tab.
  // ═════════════════════════════════════════════════════════════════
  const gate = requirePlan('pro');

  app.get('/api/arbiter/status', gate, async (req, res) => {
    try {
      const uid = req.user.id;
      const [acc, eps, pos] = await Promise.all([
        http.get(`${T.accounts}?user_id=eq.${uid}&select=*&order=first_seen_at.asc`, H()),
        http.get(`${T.errors}?user_id=eq.${uid}&closed_at=is.null&select=*&order=opened_at.desc`, H()),
        http.get(`${T.positions}?user_id=eq.${uid}&closed_at=is.null&select=*&order=first_seen_at.desc`, H())
      ]);
      const t = now();
      res.json({
        ok: true,
        accounts: acc.data || [],
        openEpisodes: (eps.data || []).map(r => ({
          ...r, open_for_minutes: Math.round((t - Date.parse(r.opened_at)) / 60000)
        })),
        openPositions: pos.data || [],
        riskRule: await riskRuleFor(uid)
      });
    } catch (e) {
      log.error('[ARBITER] status failed:', e.message);
      res.status(500).json({ error: 'Could not read Arbiter status' });
    }
  });

  app.get('/api/arbiter/errors', gate, async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
      const since = iso(now() - days * 86400000);
      const { data } = await http.get(
        `${T.errors}?user_id=eq.${req.user.id}&opened_at=gte.${since}&select=*&order=opened_at.desc&limit=500`, H());
      const rows = (data || []).map(r => {
        const end = r.closed_at ? Date.parse(r.closed_at) : now();
        return { ...r, duration_minutes: Math.max(0, Math.round((end - Date.parse(r.opened_at)) / 60000)) };
      });
      res.json({ ok: true, days, episodes: rows });
    } catch (e) {
      log.error('[ARBITER] errors read failed:', e.message);
      res.status(500).json({ error: 'Could not read error episodes' });
    }
  });

  app.get('/api/arbiter/positions', gate, async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
      const since = iso(now() - days * 86400000);
      const { data } = await http.get(
        `${T.positions}?user_id=eq.${req.user.id}&first_seen_at=gte.${since}&select=*&order=first_seen_at.desc&limit=500`, H());
      res.json({ ok: true, days, positions: data || [] });
    } catch (e) {
      log.error('[ARBITER] positions read failed:', e.message);
      res.status(500).json({ error: 'Could not read positions' });
    }
  });

  // ═════════════════════════════════════════════════════════════════
  // POST /api/arbiter/call — the page PROPOSES; the server decides what is
  // recorded. It stamps the price itself (never trusting the browser),
  // computes the ATR itself (it grades the outcome, so the browser must not
  // be able to set it), and refuses a duplicate of a call still in its window.
  // ═════════════════════════════════════════════════════════════════
  app.post('/api/arbiter/call', gate, async (req, res) => {
    try {
      const uid = req.user.id;
      const b = req.body || {};
      const kind = ['take', 'skip', 'live'].indexOf(b.kind) >= 0 ? b.kind : null;
      const direction = b.direction === 'bull' || b.direction === 'bear' ? b.direction : null;
      if (!kind || !direction || !b.symbol) return res.status(400).json({ ok: false, error: 'kind, direction and symbol are required' });
      if (kind === 'live' && !b.ticket) return res.status(400).json({ ok: false, error: 'live calls need a ticket' });

      const sourceId = resolveSource ? resolveSource(req) : null;
      const st = getState(uid, sourceId) || {};
      const acct = st.accountInfo && (st.accountInfo.login || st.accountInfo.account);
      if (!acct) return res.status(409).json({ ok: false, error: 'no account is reporting' });
      const symbol = norm(b.symbol);

      const price = livePriceFor(uid, sourceId, symbol);
      if (!(price > 0)) return res.status(409).json({ ok: false, error: 'no live price for ' + symbol });

      const cs = getCandlesStore(uid, sourceId) || {};
      const key = Object.keys(cs).find(k => norm(k) === symbol);
      const node = key ? cs[key] || {} : {};
      const atr = atrOf((node.candlesByTF && node.candlesByTF.H1) || node.candles || []);
      if (kind !== 'live' && !atr) return res.status(409).json({ ok: false, error: 'not enough candles to grade a call on ' + symbol });

      const t = now();
      const callKey = kind === 'live' ? `live:${acct}:${b.ticket}:${b.action}` : `setup:${symbol}:${direction}`;
      const row = {
        user_id: uid, account_number: String(acct), call_key: callKey,
        kind, symbol, direction,
        score: b.score != null ? Math.round(num(b.score)) : null,
        raw_score: b.rawScore != null ? Math.round(num(b.rawScore)) : null,
        action: b.action || null, ticket: b.ticket ? String(b.ticket) : null,
        price_at: price, atr: atr || null,
        // The frozen reasoning. Size-capped: a snapshot is evidence, not a dump.
        snapshot: JSON.stringify(b.snapshot || {}).length < 20000 ? (b.snapshot || {}) : { truncated: true },
        created_at: iso(t),
        window_ends_at: iso(t + WINDOW_MS),
        horizon_ends_at: kind === 'live' ? null : iso(t + HORIZON_MS)
      };
      let inserted;
      try {
        const { data } = await http.post(T.calls, row,
          H({ 'Content-Type': 'application/json', Prefer: 'return=representation' }));
        inserted = Array.isArray(data) ? data[0] : data;
      } catch (e) {
        if (e.response && e.response.status === 409) return res.json({ ok: true, duplicate: true });
        throw e;
      }
      const sc = getScope(uid, String(acct));
      if (inserted && inserted.id != null) sc.calls.set(String(inserted.id), inserted);
      res.json({ ok: true, id: inserted && inserted.id, price_at: price, window_ends_at: row.window_ends_at });
    } catch (e) {
      log.error('[ARBITER] call record failed:', e.response ? JSON.stringify(e.response.data) : e.message);
      res.status(500).json({ ok: false, error: 'Could not record the call' });
    }
  });

  app.get('/api/arbiter/calls', gate, async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 1));
      const since = iso(now() - days * 86400000);
      const { data } = await http.get(
        `${T.calls}?user_id=eq.${req.user.id}&created_at=gte.${since}&select=*&order=created_at.desc&limit=500`, H());
      const rows = data || [];
      const q = { good: 0, expensive: 0, ours: 0, luck: 0 };
      rows.forEach(r => { if (r.box && q[r.box] != null) q[r.box]++; });
      res.json({ ok: true, days, calls: rows, quad: q,
        resolved: rows.filter(r => r.resolved_at).length,
        pending: rows.filter(r => !r.resolved_at).length });
    } catch (e) {
      log.error('[ARBITER] calls read failed:', e.message);
      res.status(500).json({ ok: false, error: 'Could not read calls' });
    }
  });

  // ═════════════════════════════════════════════════════════════════
  // GET /api/arbiter/habits — today's episodes against the trader's own
  // last 20 days. History is dated from the FIRST account ever seen, so an
  // account change does not restart the baseline (spec 9b).
  // ═════════════════════════════════════════════════════════════════
  app.get('/api/arbiter/habits', gate, async (req, res) => {
    try {
      const uid = req.user.id;
      const t = now();
      const since = iso(t - (HABIT.BASELINE_DAYS + 1) * DAY);
      const [eps, acc] = await Promise.all([
        http.get(`${T.errors}?user_id=eq.${uid}&opened_at=gte.${since}&select=*&order=opened_at.desc&limit=3000`, H()),
        http.get(`${T.accounts}?user_id=eq.${uid}&select=first_seen_at&order=first_seen_at.asc&limit=1`, H())
      ]);
      const first = acc.data && acc.data[0] ? Date.parse(acc.data[0].first_seen_at) : null;
      res.json(Object.assign({ ok: true }, habitsSummary(eps.data || [], t, first)));
    } catch (e) {
      log.error('[ARBITER] habits read failed:', e.message);
      res.status(500).json({ ok: false, error: 'Could not read habits' });
    }
  });

  // ═════════════════════════════════════════════════════════════════
  // REPORTS. GET returns the facts (free) and any stored report. POST
  // writes the Claude report — ONCE per period: a second POST for the same
  // day or week returns the stored report and charges nothing.
  // Billing is the Brain's own: refuse at zero credits, then deduct by the
  // tokens actually used, owners exempt. A failed Claude call charges nothing.
  // ═════════════════════════════════════════════════════════════════
  function periodFor(kind, q) {
    if (kind === 'daily') {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(q || '') ? q : dayOf(now());
      return Object.assign({ key: d }, dayRange(d));
    }
    const base = /^\d{4}-\d{2}-\d{2}$/.test(q || '') ? Date.parse(q + 'T12:00:00Z') : now();
    return weekOf(base);
  }
  async function factsFor(uid, kind, period) {
    const since = iso(period.start - HABIT.BASELINE_DAYS * DAY);
    const until = iso(period.end);
    const [cls, eps, pos, acc, jr] = await Promise.all([
      http.get(`${T.calls}?user_id=eq.${uid}&created_at=gte.${iso(period.start)}&created_at=lt.${until}&select=*&order=created_at.desc&limit=1000`, H()),
      http.get(`${T.errors}?user_id=eq.${uid}&opened_at=gte.${since}&select=*&order=opened_at.desc&limit=3000`, H()),
      http.get(`${T.positions}?user_id=eq.${uid}&first_seen_at=gte.${iso(period.start - 7 * DAY)}&select=*&limit=1000`, H()),
      http.get(`${T.accounts}?user_id=eq.${uid}&select=first_seen_at&order=first_seen_at.asc&limit=1`, H()),
      getJournal ? getJournal(uid).catch(() => []) : Promise.resolve([])
    ]);
    const first = acc.data && acc.data[0] ? Date.parse(acc.data[0].first_seen_at) : null;
    return buildFacts(kind, period, cls.data || [], eps.data || [], pos.data || [], jr || [], first);
  }
  async function storedReport(uid, kind, key) {
    const { data } = await http.get(`${T.reports}?user_id=eq.${uid}&kind=eq.${kind}&period=eq.${key}&select=*&limit=1`, H());
    return data && data[0] ? data[0] : null;
  }
  async function finishedReport(uid, kind, key) {
    const r = await storedReport(uid, kind, key);
    return r && r.status !== 'writing' ? r : null;
  }

  ['daily', 'weekly'].forEach(kind => {
    app.get(`/api/arbiter/report/${kind}`, gate, async (req, res) => {
      try {
        const period = periodFor(kind, req.query.date);
        const [facts, report] = await Promise.all([factsFor(req.user.id, kind, period), finishedReport(req.user.id, kind, period.key)]);
        res.json({ ok: true, period: period.key, facts, report });
      } catch (e) {
        log.error('[ARBITER] report read failed:', e.message);
        res.status(500).json({ ok: false, error: 'Could not read the report' });
      }
    });

    app.post(`/api/arbiter/report/${kind}`, gate, async (req, res) => {
      const out = await writeReport(req.user.id, kind, periodFor(kind, req.body && req.body.date),
        { trigger: 'manual', owner: !!(req.subscription && req.subscription.owner) });
      res.status(out.code || 200).json(out.body);
    });
  });

  /* ═════════════════════════════════════════════════════════════════
     THE ONE PLACE A REPORT IS WRITTEN — used by the button AND the
     schedule, so there is exactly one billing path.
       1. already written for this period -> return it, no charge
       2. out of credits -> refuse BEFORE Claude is called
       3. nothing happened -> refuse, no charge
       4. CLAIM the period (unique row, status 'writing'). If another
          process holds the claim, stop: two server copies firing the same
          schedule must never charge the trader twice.
       5. call Claude. If it fails, RELEASE the claim — nothing charged,
          nothing stored, the period can be tried again.
       6. charge the tokens used, then fill in the claimed row.
     ═════════════════════════════════════════════════════════════════ */
  async function writeReport(uid, kind, period, opts) {
    const trigger = opts.trigger || 'manual', owner = !!opts.owner;
    try {
      let existing = await storedReport(uid, kind, period.key);
      if (existing && existing.status === 'writing' && now() - Date.parse(existing.created_at) > CLAIM_STALE_MS) {
        await http.delete(`${T.reports}?id=eq.${existing.id}&status=eq.writing`, H()).catch(() => {});
        existing = null;
      }
      if (existing && existing.status !== 'writing') return { body: { ok: true, period: period.key, report: existing, cached: true } };
      if (existing) return { code: 409, body: { ok: false, busy: true, error: 'This review is already being written.' } };

      if (!owner && getUserCredits) {
        const c = await getUserCredits(uid);
        if (!(c && c.balance > 0)) return { code: 402, body: { ok: false, reason: 'no_credits', error: 'Out of analysis credits for this cycle', resetAt: c && c.resetAt } };
      }
      const facts = await factsFor(uid, kind, period);
      if (!facts.calls.total && !facts.trades.closed && !facts.habits.raised.length)
        return { code: 409, body: { ok: false, reason: 'nothing', error: 'Nothing happened in this period to write about.' } };

      // 4. claim
      let claim;
      try {
        const { data } = await http.post(T.reports, {
          user_id: uid, kind, period: period.key, facts, report_md: '', model: MODEL,
          status: 'writing', trigger, created_at: iso(now())
        }, H({ 'Content-Type': 'application/json', Prefer: 'return=representation' }));
        claim = Array.isArray(data) ? data[0] : data;
      } catch (e) {
        if (e.response && e.response.status === 409) return { code: 409, body: { ok: false, busy: true, error: 'This review is already being written.' } };
        throw e;
      }
      const release = () => claim && claim.id != null
        ? http.delete(`${T.reports}?id=eq.${claim.id}`, H()).catch(() => {}) : Promise.resolve();

      // 5. Claude
      let text = '', usage = {};
      try {
        const r = await http.post('https://api.anthropic.com/v1/messages', {
          model: MODEL, max_tokens: REPORT_TOKENS[kind], system: REPORT_RULES,
          messages: [{ role: 'user', content: `Write the trader's ${kind === 'daily' ? 'daily' : 'weekly'} review from these facts.\n\n` + JSON.stringify(facts) }]
        }, { headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY,
                        'anthropic-version': '2023-06-01' }, timeout: 60000 });
        text = ((r.data && r.data.content) || []).map(c => c.text || '').join('').replace(/\*\*/g, '').trim();
        usage = (r.data && r.data.usage) || {};
      } catch (e) {
        await release();
        log.error('[ARBITER] Claude failed, nothing charged:', e.response ? JSON.stringify(e.response.data) : e.message);
        return { code: 500, body: { ok: false, reason: 'claude', error: 'Could not write the report' } };
      }
      if (!text) { await release(); return { code: 502, body: { ok: false, reason: 'claude', error: 'Claude returned nothing' } }; }

      // 6. charge, then complete the claimed row
      const cost = ((usage.input_tokens || 0) / 1e6) * PRICE_IN + ((usage.output_tokens || 0) / 1e6) * PRICE_OUT;
      let balance = null;
      if (!owner && deductCredits) balance = await deductCredits(uid, cost);
      const done = { report_md: text, cost: +cost.toFixed(6), status: 'done' };
      await http.patch(`${T.reports}?id=eq.${claim.id}`, done, H())
        .catch(e => log.warn('[ARBITER] report save failed (report still returned):', e.message));
      log.log && log.log(`[ARBITER] ${kind} report (${trigger}) user=${uid} cost=$${cost.toFixed(4)}`);
      return { body: { ok: true, period: period.key, report: Object.assign({}, claim, done), cost, creditBalance: balance } };
    } catch (e) {
      log.error('[ARBITER] report write failed:', e.response ? JSON.stringify(e.response.data) : e.message);
      return { code: 500, body: { ok: false, error: 'Could not write the report' } };
    }
  }

  /* ═════════════════════════════════════════════════════════════════
     SETTINGS — automatic reports are OFF unless the trader turns them on.
     Turning one ON requires accepting the server's own consent wording;
     every change, on or off, is appended to a log that is never edited.
     ═════════════════════════════════════════════════════════════════ */
  const SETTING_KEYS = ['auto_daily', 'auto_weekly'];
  async function settingsOf(uid) {
    const { data } = await http.get(`${T.settings}?user_id=eq.${uid}&select=*&limit=1`, H());
    return (data && data[0]) || { user_id: uid, auto_daily: false, auto_weekly: false };
  }

  app.get('/api/arbiter/settings', gate, async (req, res) => {
    try {
      const uid = req.user.id;
      const [st, reps, log_] = await Promise.all([
        settingsOf(uid),
        http.get(`${T.reports}?user_id=eq.${uid}&status=eq.done&select=kind,period,trigger,cost,created_at&order=created_at.desc&limit=30`, H()),
        http.get(`${T.consent}?user_id=eq.${uid}&select=setting,value,consent_version,at&order=at.desc&limit=10`, H())
      ]);
      res.json({ ok: true, settings: st, consentVersion: CONSENT_VERSION, consentText: CONSENT_TEXT,
                 charges: reps.data || [], history: log_.data || [] });
    } catch (e) {
      log.error('[ARBITER] settings read failed:', e.message);
      res.status(500).json({ ok: false, error: 'Could not read settings' });
    }
  });

  app.put('/api/arbiter/settings', gate, async (req, res) => {
    try {
      const uid = req.user.id;
      const b = req.body || {};
      if (SETTING_KEYS.indexOf(b.setting) < 0 || typeof b.value !== 'boolean')
        return res.status(400).json({ ok: false, error: 'setting and a true/false value are required' });
      if (b.value === true && (b.consentAccepted !== true || b.consentVersion !== CONSENT_VERSION))
        return res.status(400).json({ ok: false, error: 'Automatic reports can only be turned on by accepting the charge statement.' });

      const t = iso(now());
      const cur = await settingsOf(uid);
      const next = Object.assign({ user_id: uid, auto_daily: !!cur.auto_daily, auto_weekly: !!cur.auto_weekly },
        { [b.setting]: b.value, updated_at: t,
          // who owns the account is decided by the SERVER, from the session
          owner: !!(req.subscription && req.subscription.owner) });
      await http.post(`${T.settings}?on_conflict=user_id`, next,
        H({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }));
      // the permanent record: what was agreed (in the SERVER'S words), and when
      await http.post(T.consent, {
        user_id: uid, setting: b.setting, value: b.value, at: t,
        consent_version: b.value ? CONSENT_VERSION : null,
        consent_text: b.value ? CONSENT_TEXT[b.setting] : null
      }, H({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }));
      res.json({ ok: true, settings: next });
    } catch (e) {
      log.error('[ARBITER] settings save failed:', e.message);
      res.status(500).json({ ok: false, error: 'Could not save the setting' });
    }
  });

  /* ═════════════════════════════════════════════════════════════════
     THE SCHEDULE. Timed around app.js's own jobs: credits reset at 00:00
     UTC and plan changes apply at 00:05, so the daily run is at 00:20 and
     covers the day that has just ENDED. The weekly run is Saturday 02:00,
     after Friday's close. Each trader is re-checked for entitlement with
     the same test requirePlan uses — a lapsed subscription is never
     charged by a schedule it set months ago.
     ═════════════════════════════════════════════════════════════════ */
  async function entitled(uid, settings) {
    if (settings && settings.owner) return { ok: true, owner: true };
    if (!getUserPlan || !accessState || !planRank) return { ok: false, why: 'entitlement check unavailable' };
    const sub = await getUserPlan(uid);
    const access = accessState(sub);
    if (!(access && access.ok)) return { ok: false, why: 'access ' + ((access && access.state) || 'not active') };
    if (sub.status !== 'active') return { ok: false, why: 'subscription ' + sub.status };
    if (planRank(sub.plan) < planRank('pro')) return { ok: false, why: 'plan ' + sub.plan };
    if (sharingBlocked && sharingBlocked(sub)) return { ok: false, why: 'licence sharing block' };
    return { ok: true, owner: false };
  }

  async function runAuto(kind) {
    const col = kind === 'daily' ? 'auto_daily' : 'auto_weekly';
    const t = now();
    // daily: the UTC day that just ended. weekly: the ISO week containing yesterday (Friday).
    const period = kind === 'daily' ? Object.assign({ key: dayOf(t - DAY) }, dayRange(dayOf(t - DAY))) : weekOf(t - DAY);
    const { data } = await http.get(`${T.settings}?${col}=eq.true&select=*`, H());
    const results = [];
    for (const st of (data || [])) {                     // one at a time: no burst of Claude calls
      const uid = st.user_id;
      let outcome;
      try {
        const e = await entitled(uid, st);
        if (!e.ok) outcome = { outcome: 'skipped', why: e.why };
        else {
          const r = await writeReport(uid, kind, period, { trigger: 'auto', owner: e.owner });
          outcome = r.body.ok ? { outcome: r.body.cached ? 'already written' : 'written', cost: r.body.cost || 0 }
            : { outcome: 'skipped', why: r.body.reason === 'no_credits' ? 'no credits left — nothing charged'
                : r.body.reason === 'nothing' ? 'nothing to review — nothing charged'
                : r.body.busy ? 'already being written' : 'could not be written — nothing charged' };
        }
      } catch (err) { outcome = { outcome: 'skipped', why: 'error — nothing charged' }; }
      const record = Object.assign({ at: iso(now()), period: period.key }, outcome);
      results.push(Object.assign({ user_id: uid }, record));
      await http.patch(`${T.settings}?user_id=eq.${uid}`, { ['last_' + kind + '_run']: record }, H()).catch(() => {});
    }
    return results;
  }
  if (cron && typeof cron.schedule === 'function') {
    cron.schedule('20 0 * * *', () => { runAuto('daily').catch(e => log.error('[ARBITER] auto daily failed:', e.message)); }, { timezone: 'UTC' });
    cron.schedule('0 2 * * 6',  () => { runAuto('weekly').catch(e => log.error('[ARBITER] auto weekly failed:', e.message)); }, { timezone: 'UTC' });
  }

  // ═════════════════════════════════════════════════════════════════
  // PROGRESS and CALIBRATION — read-only, free, all history of the trader
  // across every account they have used.
  // ═════════════════════════════════════════════════════════════════
  async function history(uid, weeks) {
    const since = iso(now() - (weeks * 7 + 7) * DAY);
    const [cls, eps, acc, jr] = await Promise.all([
      http.get(`${T.calls}?user_id=eq.${uid}&created_at=gte.${since}&select=*&order=created_at.asc&limit=5000`, H()),
      http.get(`${T.errors}?user_id=eq.${uid}&opened_at=gte.${since}&select=*&limit=5000`, H()),
      http.get(`${T.accounts}?user_id=eq.${uid}&select=*&order=first_seen_at.asc`, H()),
      getJournal ? getJournal(uid).catch(() => []) : Promise.resolve([])
    ]);
    return { calls: cls.data || [], episodes: eps.data || [], accounts: acc.data || [], journal: jr || [] };
  }
  app.get('/api/arbiter/progress', gate, async (req, res) => {
    try {
      const h = await history(req.user.id, PROG.WEEKS);
      res.json(Object.assign({ ok: true }, progressSummary(h.calls, h.episodes, h.journal, h.accounts, now())));
    } catch (e) {
      log.error('[ARBITER] progress failed:', e.message);
      res.status(500).json({ ok: false, error: 'Could not read progress' });
    }
  });
  app.get('/api/arbiter/calibration', gate, async (req, res) => {
    try {
      const h = await history(req.user.id, 52);
      // the thresholds come from the ENGINE, the one place they are defined —
      // change one there and calibration judges the new number, never a stale copy
      res.json(Object.assign({ ok: true }, calibrationSummary(h.calls, h.journal, require('./arbiter-engine.js').STAGE)));
    } catch (e) {
      log.error('[ARBITER] calibration failed:', e.message);
      res.status(500).json({ ok: false, error: 'Could not read calibration' });
    }
  });

  return { onHeartbeat, runAuto, writeReport, _test: { evaluateErrors, excursionFrom, pipSizeFor, RULES, scopes } };
};

module.exports.evaluateErrors = evaluateErrors;
module.exports.excursionFrom = excursionFrom;
module.exports.RULES = RULES;
module.exports.progress = { progressSummary, calibrationSummary, weeklyRows, rOf, median, PROG, METRICS };
module.exports.reports = { buildFacts, weekOf, dayRange, REPORT_RULES, MODEL, CONSENT_VERSION, CONSENT_TEXT };
module.exports.habits = { habitsSummary, HABIT, HABIT_LABELS, COUNTED };
module.exports.ledger = { atrOf, firstCrossings, outcomeOf, correctness, boxOf, adherenceFor, liveAdherence,
                          WINDOW_MS, HORIZON_MS };
