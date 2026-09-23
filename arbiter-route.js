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
   followed — Assan's rule. And (his later rule) ONLY calls on pairs the
   trader actually traded are counted: which pairs to trade is the trader's
   choice, so a call on a pair they never opened is 'not_traded' — still
   listed, still graded for Arbiter's own accuracy, never boxed. */
function boxOf(correct, adherence) {
  if (correct == null || !adherence || adherence === 'pending' || adherence === 'not_traded') return null;
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
  // Nothing opened on this pair inside the window: the trader did not trade it.
  // Not "ignored", not "followed" — choosing pairs is theirs (Assan's rule).
  if (nowMs > end) return { adherence: 'not_traded', ticket: null, at: end };
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
  flagged_hold: 'Held while Risk Radar was flagged',
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

/* How much history Arbiter has = the DAYS IT HAS DATA FOR, not the clock
   gap since the account appeared. Measuring calendar time said "0 days of
   your history" to a trader on his second day, because the first day was
   under 24 hours old. Days with activity is what a baseline is actually
   made of. `history` is either that count, or (older callers) a timestamp. */
function activeDaysFrom(history, rows, nowMs) {
  if (history && typeof history === 'object' && history.activeDays != null)
    return Math.min(HABIT.BASELINE_DAYS, history.activeDays);
  if (typeof history === 'number') {                       // a timestamp: fall back to calendar days
    const todayStart = Date.parse(dayOf(nowMs) + 'T00:00:00Z');
    return Math.min(HABIT.BASELINE_DAYS, Math.max(0, Math.round((todayStart - history) / DAY)));
  }
  return 0;
}
function habitsSummary(rows, nowMs, historyStartMs) {
  const today = dayOf(nowMs);
  const todayStart = Date.parse(today + 'T00:00:00Z');
  const historyDays = activeDaysFrom(historyStartMs, rows, nowMs);
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

WHAT YOU MAY SAY
1. Use ONLY numbers present in the facts. Never estimate, extrapolate or invent a figure. If something is not in the facts, do not mention it.
2. You describe what happened. You NEVER recommend a trade, a pair, an entry, a direction or a position size.
3. Separate what the trader controls (following calls, habits, stops, sizing) from what the market did. A losing day with good behaviour is a good day; say so.
4. Look for ONE cause behind several symptoms before listing symptoms. If several errors share a trigger (for example a loss closing just before them), name the trigger.
5. Report good habits as plainly as bad ones.
6. If the facts say the sample is too small (sampleTooSmall, or fewer than ~10 graded calls), say that nothing can be concluded about the trader or about Blackwood yet.
7. End with exactly one concrete thing to try, framed as a measurement, not a rule.

HOW TO READ THE FACTS — these rules matter as much as the ones above
8. WHOSE FAULT IS WHAT. calls.quad is the only thing that judges the TRADER: good = Blackwood right and followed; expensive = Blackwood right and ignored; ours = Blackwood wrong and followed; luck = Blackwood wrong and ignored. calls.quadPL (weekly) is the money behind each box.
9. PAIRS THE TRADER DID NOT TRADE. adherence "not_traded" means no trade was opened on that pair inside the 20-minute window. Choosing which pairs to trade is the trader's own choice: NEVER call this ignoring, disobeying or a mistake, and never put it in the quad. calls.untraded (takeRight/takeWrong/skipRight/skipWrong) is Blackwood answering for ITSELF on those pairs — use it to judge Arbiter, never the trader.
10. calls.blackwoodRight / blackwoodGraded is ARBITER'S accuracy (it includes untraded pairs). calls.youFollowed / youActedOn is the TRADER'S adherence (only pairs they traded). Never mix the two.
11. LIVE CALLS (hold, break-even, partial, cut) are never "right" or "wrong" — Arbiter cannot see the future. Once the trade closes, worth.worthR is what FOLLOWING it would have been worth in R: positive means following was better. calls.liveWorthR is the total. "R" is the trade's risk (its stop), so it is comparable across accounts and pairs — never convert R into money, and never present R as a percentage.
12. unactionedWarnings counts break-even/partial/cut calls the trader did not act on. Say what it cost only if the facts show it.
13. HABITS are episodes with a DURATION. habits.raised carries count, minutesExposed, longestMinutes, putRight, stillOpen, isRecurringHabit and versusUsual. Only call something a habit when isRecurringHabit is true; otherwise it is one episode. versusUsual compares the trader against THEIR OWN 20-day normal — if habits.tooEarlyToCompare is true, say nothing is comparable yet. habits.cleanOnUsual lists things they usually do and did not today: say so.
14. A habit's context (when present) may carry riskX (a multiple of the trader's own median RISK, not lots), the CALL Arbiter had made on that pair before the entry, and the trade's result. Use them to join the story; never invent the links yourself.
15. WEEKLY ONLY. week.onlyStrongCallsPL is what the trader's OWN FILLED trades from 70+ calls returned — it is NOT a backtest, and you must never present it as profit they would have made on trades they never took. week.bestSession / worstSession / avgHoldWinners / avgHoldLosers are plain facts. habitsWeek has a per-day column: if one day carries most of the week's episodes, say it is one bad session rather than many bad habits.
16. excursions are MFE/MAE in pips (best and worst the trade reached). Use them for giving back profit or nearly hitting a stop — never to claim what "would have" happened with a different exit.
17. "unclear" outcomes and calls still inside their window are excluded from right/wrong. Never count them.

HOW TO WRITE IT
18. Plain language. No hype, no emojis, no bold. Short paragraphs. Use these markdown headings only: "## What went well", "## What cost you", "## The pattern", "## One thing to try".`;

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
  /* Which trades did the trader follow Arbiter on? A setup call points at the
     trade it was matched to; a LIVE call points at the trade it was about —
     and live calls were left out entirely, which is why both figures read
     +0.00 for a trader whose calls are nearly all live. When one trade has
     several live calls, the LAST one decides: that is where the trade was
     finally left. */
  const verdictByTicket = new Map();
  cs.filter(c => c.adherence && c.adherence !== 'not_traded' && c.adherence !== 'pending')
    .map(c => ({ ticket: c.kind === 'live' ? c.ticket : c.matched_ticket, at: Date.parse(c.created_at), adherence: c.adherence }))
    .filter(x => x.ticket)
    .sort((a, b) => a.at - b.at)
    .forEach(x => verdictByTicket.set(String(x.ticket), x.adherence));
  const followedSet = new Set(Array.from(verdictByTicket).filter(([, v]) => v === 'followed').map(([k]) => k));
  const ignoredSet = new Set(Array.from(verdictByTicket).filter(([, v]) => v === 'ignored' || v === 'deviated').map(([k]) => k));
  const findT = tradeLookup(journal, positions);
  // P/L of the trades behind a set of POSITION tickets, found by the one matcher
  const plOf = set => Array.from(set).map(k => findT(k)).filter(Boolean)
    .filter(t => { const x = Date.parse(t.close_time); return x >= range.start && x < range.end; })
    .reduce((a, t) => a + (Number(t.total_pl) || 0), 0);
  const closedPos = (positions || []).filter(p => p.closed_at && inR(p.closed_at));
  const hs = habitsSummary(enrichEpisodes((episodes || []).filter(e => Date.parse(e.opened_at) < range.end),
    calls, journal, positions), range.end - 1, historyStartMs);

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
      // Blackwood's own accuracy today: setup calls graded right/wrong, plus live
      // advice on closed trades by the sign of what following it was worth
      blackwoodRight: cs.filter(c => (c.kind !== 'live' && c.correct === true) ||
        (c.kind === 'live' && c.worth && c.worth.state === 'graded' && c.worth.worthR > 0)).length,
      blackwoodGraded: cs.filter(c => (c.kind !== 'live' && c.correct != null) ||
        (c.kind === 'live' && c.worth && c.worth.state === 'graded' && c.worth.worthR !== 0)).length,
      // "you followed": only calls on pairs you traded (never not_traded)
      youFollowed: cs.filter(c => c.adherence === 'followed').length,
      youActedOn: cs.filter(c => c.adherence === 'followed' || c.adherence === 'ignored' || c.adherence === 'deviated').length,
      // a warning to act on (break-even / partial / cut) that you did not act on
      unactionedWarnings: cs.filter(c => c.kind === 'live' && c.action && c.action !== 'hold' && c.adherence === 'ignored').length,
      // The pairs you left alone: no "you" to judge, so it is what Arbiter
      // SAID against what the market DID.
      untraded: (() => {
        const u = cs.filter(c => c.kind !== 'live' && c.adherence === 'not_traded' && c.correct != null);
        return { takeRight: u.filter(c => c.kind === 'take' && c.correct).length,
                 takeWrong: u.filter(c => c.kind === 'take' && !c.correct).length,
                 skipRight: u.filter(c => c.kind === 'skip' && c.correct).length,
                 skipWrong: u.filter(c => c.kind === 'skip' && !c.correct).length,
                 total: cs.filter(c => c.adherence === 'not_traded').length };
      })(),
      liveGraded: cs.filter(c => c.kind === 'live' && c.worth && c.worth.state === 'graded').length,
      liveWorthR: r2(cs.filter(c => c.kind === 'live' && c.worth && c.worth.state === 'graded')
        .reduce((a, c) => a + c.worth.worthR, 0)),
      avgScoreTaken: avg(cs.filter(c => c.kind !== 'live' && c.adherence === (c.kind === 'take' ? 'followed' : 'ignored')).map(c => c.score)),
      // "passed on" = a TAKE call on a pair you did not trade
      avgScoreSkipped: avg(cs.filter(c => c.kind === 'take' && c.adherence === 'not_traded').map(c => c.score)),
      notTraded: cs.filter(c => c.kind !== 'live' && c.adherence === 'not_traded').length,
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
    // ── WEEKLY ONLY ────────────────────────────────────────────────
    // money behind each box: the trades behind the calls in it
    quadPL: kind !== 'weekly' ? null : (() => {
      const out = { good: 0, expensive: 0, ours: 0, luck: 0 };
      cs.filter(c => c.box).forEach(c => {
        const t = findT(c.kind === 'live' ? c.ticket : c.matched_ticket);
        if (t) out[c.box] = round2(out[c.box] + (Number(t.total_pl) || 0));
      });
      return out;
    })(),
    // where the week went — all from the trader's OWN filled trades
    week: kind !== 'weekly' ? null : (() => {
      const held = trades.filter(t => t.open_time && t.close_time)
        .map(t => ({ mins: (Date.parse(t.close_time) - Date.parse(t.open_time)) / 60000, pl: Number(t.total_pl) || 0 }))
        .filter(x => x.mins > 0);
      const avg2 = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
      const bySession = {};
      trades.forEach(t => { const k = t.session || 'unknown';
        bySession[k] = round2((bySession[k] || 0) + (Number(t.total_pl) || 0)); });
      const sessions = Object.keys(bySession).filter(k => k !== 'unknown')
        .map(k => ({ session: k, pl: bySession[k] })).sort((a, b) => b.pl - a.pl);
      // "if you had taken only 70+ calls": the trades you DID fill that came
      // from a call of 70 or better. Never a backtest of trades never taken.
      const strongTickets = new Set(cs.filter(c => c.kind !== 'live' && c.score >= 70 && c.matched_ticket)
        .map(c => String(c.matched_ticket)));
      const strongPL = round2(Array.from(strongTickets).map(k => findT(k)).filter(Boolean)
        .filter(t => inR(t.close_time)).reduce((a, t) => a + (Number(t.total_pl) || 0), 0));
      return {
        trades: trades.length, netPL: round2(pl), onlyStrongCallsPL: strongPL, strongCallTrades: strongTickets.size,
        bestSession: sessions[0] || null, worstSession: sessions.length > 1 ? sessions[sessions.length - 1] : null,
        avgHoldWinners: avg2(held.filter(x => x.pl > 0).map(x => x.mins)),
        avgHoldLosers: avg2(held.filter(x => x.pl < 0).map(x => x.mins))
      };
    })(),
    // habits across the week: one row per error type, a column per day
    habitsWeek: kind !== 'weekly' ? null : (() => {
      const days = Array.from({ length: Math.round((range.end - range.start) / DAY) }, (_, i) => dayOf(range.start + i * DAY));
      const prev = { start: range.start - 7 * DAY, end: range.start };
      const mins = e => Math.max(0, ((e.closed_at ? Date.parse(e.closed_at) : range.end) - Date.parse(e.opened_at)) / 60000);
      return Object.keys(HABIT_LABELS).map(type => {
        const all = (episodes || []).filter(e => e.type === type);
        const inWeek = all.filter(e => inR(e.opened_at));
        const last = all.filter(e => { const t = Date.parse(e.opened_at); return t >= prev.start && t < prev.end; });
        if (!inWeek.length && !last.length) return null;
        const counted = COUNTED.indexOf(type) >= 0;
        const nowV = counted ? inWeek.length : Math.round(inWeek.reduce((a, e) => a + mins(e), 0));
        const wasV = counted ? last.length : Math.round(last.reduce((a, e) => a + mins(e), 0));
        return { type, label: HABIT_LABELS[type], counted,
          perDay: days.map(d => inWeek.filter(e => dayOf(Date.parse(e.opened_at)) === d).length),
          count: inWeek.length, exposedMinutes: counted ? null : Math.round(inWeek.reduce((a, e) => a + mins(e), 0)),
          lastWeek: last.length, now: nowV, before: wasV,
          direction: !last.length && !inWeek.length ? 'flat'
            : wasV === 0 ? (nowV > 0 ? 'worse' : 'flat')
            : nowV > wasV * 1.25 ? 'worse' : nowV < wasV * 0.75 ? 'better' : 'flat' };
      }).filter(Boolean);
    })(),
    days: kind !== 'weekly' ? null : Array.from({ length: Math.round((range.end - range.start) / DAY) }, (_, i) => dayOf(range.start + i * DAY)),
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
      // totals across every Trade Errors episode raised today
      totalRaised: hs.types.reduce((a, h) => a + h.today.count, 0),
      totalFixed: hs.types.reduce((a, h) => a + h.today.fixed, 0),
      totalOpen: hs.types.reduce((a, h) => a + h.today.open, 0),
      unprotectedMinutes: (hs.types.find(h => h.type === 'no_sl') || { today: { minutes: 0 } }).today.minutes,
      raised: hs.types.filter(h => h.today.count).map(h => ({ what: h.label, count: h.today.count,
        minutesExposed: h.counted ? null : h.today.minutes, longestMinutes: h.counted ? null : h.today.longest,
        putRight: h.today.fixed, stillOpen: h.today.open, isRecurringHabit: h.habit, versusUsual: h.trend,
        example: h.worstToday && h.worstToday.context && h.worstToday.context.first ? h.worstToday.context.first.detail : null,
        context: h.worstToday && h.worstToday.context ? h.worstToday.context.link || null : null })),
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
function weeklyRows(calls, episodes, journal, nowMs, positions) {
  const findW = tradeLookup(journal, positions);
  const rows = [];
  const thisWeek = weekOf(nowMs);
  for (let i = PROG.WEEKS - 1; i >= 0; i--) {
    const w = weekOf(thisWeek.start - i * 7 * DAY + DAY);
    const inW = t => { const x = Date.parse(t); return x >= w.start && x < w.end; };
    const cs = (calls || []).filter(c => c.kind !== 'live' && inW(c.created_at) && c.adherence);
    // only calls on pairs the trader actually traded — the same rule as the grid
    const acted = cs.filter(c => c.adherence === 'followed' || c.adherence === 'ignored' || c.adherence === 'deviated');
    const followed = acted.filter(c => c.adherence === 'followed').length;
    const trades = (journal || []).filter(t => t.close_time && inW(t.close_time));
    const rs = trades.map(rOf).filter(x => x != null);
    const ownWay = new Set(cs.filter(c => (c.adherence === 'ignored' || c.adherence === 'deviated') && c.matched_ticket).map(c => String(c.matched_ticket)));
    const ownR = Array.from(ownWay).map(k => findW(k)).filter(t => t && inW(t.close_time)).map(rOf).filter(x => x != null);
    const eps = (episodes || []).filter(e => inW(e.opened_at));
    const noSl = eps.filter(e => e.type === 'no_sl');
    const mins = e => Math.max(0, ((e.closed_at ? Date.parse(e.closed_at) : nowMs) - Date.parse(e.opened_at)) / 60000);
    const fixed = noSl.filter(e => e.close_reason === 'resolved');
    const takenScores = cs.filter(c => (c.kind === 'take' && c.adherence === 'followed') || (c.kind === 'skip' && c.adherence === 'ignored')).map(c => c.score);
    const gradedW = (calls || []).filter(c => (c.kind === 'take' || c.kind === 'skip') && inW(c.created_at) && c.correct != null);
    rows.push({
      week: w.key, start: new Date(w.start).toISOString(),
      calls: acted.length, trades: trades.length,
      graded: gradedW.length, right: gradedW.filter(c => c.correct === true).length,   // the record of Arbiter itself
      adherence: acted.length ? followed / acted.length : null,
      overrideR: ownR.length ? ownR.reduce((a, b) => a + b, 0) : 0,       // what going your own way returned, in R
      expensive: cs.filter(c => c.box === 'expensive').length,
      unprotectedMinutes: Math.round(noSl.reduce((a, e) => a + mins(e), 0)),
      fixMinutes: fixed.length ? Math.round(fixed.reduce((a, e) => a + mins(e), 0) / fixed.length) : null,
      revenge: eps.filter(e => e.type === 'revenge').length,
      avgScoreTaken: takenScores.length ? Math.round(takenScores.reduce((a, b) => a + b, 0) / takenScores.length) : null,
      avgScorePassed: (() => {
        const p = cs.filter(c => c.kind === 'take' && c.adherence === 'not_traded').map(c => c.score).filter(x => x != null);
        return p.length ? Math.round(p.reduce((a, b) => a + b, 0) / p.length) : null;
      })(),
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
  { id: 'avgScoreTaken', label: 'Average score of what you took', better: 'up', fmt: 'n' },
  // shown with the others, but NEVER counted in the verdict: this is the market's
  // share of the result, and the verdict is built on behaviour alone.
  { id: 'expectancyR', label: 'R expectancy per trade', better: 'up', fmt: 'R', context: true }
];
/* ── YOUR ACCOUNTS ─────────────────────────────────────────────────
   One history across every account. Each account's suffix is read from
   the positions Arbiter recorded on it (raw broker symbol vs the pair it
   was normalised to). Sizing is compared in RISK, not lots: lots grow with
   the account, and judging them would flag a trader for oversizing every
   day after an upgrade. The note is honest both ways — if risk per trade
   DID rise, it says so. */
function accountsDetail(accounts, positions) {
  const list = (accounts || []).slice().sort((a, b) => Date.parse(a.first_seen_at) - Date.parse(b.first_seen_at));
  const pos = positions || [];
  const detail = list.map(a => {
    const mine = pos.filter(p => String(p.account_number) === String(a.account_number));
    const suffixes = {};
    mine.forEach(p => {
      const raw = String(p.raw_symbol || ''), sym = String(p.symbol || '');
      if (!raw || !sym) return;
      const i = raw.toUpperCase().indexOf(sym.toUpperCase());
      const suf = i >= 0 ? raw.slice(i + sym.length) : '';
      suffixes[suf] = (suffixes[suf] || 0) + 1;
    });
    const top = Object.keys(suffixes).sort((x, y) => suffixes[y] - suffixes[x])[0];
    return {
      account: a.account_number, firstSeen: a.first_seen_at, week: weekOf(Date.parse(a.first_seen_at)).key,
      currency: a.currency || null, startingBalance: a.starting_balance != null ? Number(a.starting_balance) : null,
      kind: a.kind || 'unknown',
      suffix: top === undefined ? null : top,          // null = no positions seen yet; '' = no suffix
      positions: mine.length,
      medianLots: median(mine.map(p => Number(p.volume)).filter(x => x > 0)),
      medianRiskPct: median(mine.map(p => Number(p.risk_pct)).filter(x => x > 0)),
      pairs: Array.from(new Set(mine.map(p => p.symbol).filter(Boolean)))
    };
  });
  // sizing: the first account against the latest, each with enough positions to mean something
  let sizing = null;
  const usable = detail.filter(d => d.positions >= 5 && d.medianLots != null && d.medianRiskPct != null);
  if (usable.length >= 2) {
    const a = usable[0], b = usable[usable.length - 1];
    const lotsX = b.medianLots / a.medianLots, riskX = b.medianRiskPct / a.medianRiskPct;
    const key = riskX > 1.3 ? 'risk_up' : riskX < 0.77 ? 'risk_down' : 'risk_steady';
    sizing = { from: { account: a.account, lots: a.medianLots, riskPct: a.medianRiskPct },
               to: { account: b.account, lots: b.medianLots, riskPct: b.medianRiskPct }, lotsX, riskX, key };
  }
  const shared = detail.length >= 2
    ? detail[0].pairs.filter(p => detail.slice(1).some(d => d.pairs.indexOf(p) >= 0)) : [];
  return { list: detail, sizing, sharedPairs: shared };
}

/* The line under each metric. Every one is computed; where the numbers do
   not support a remark, there is none. */
function metricNote(m, rows, active, before, now, sofar) {
  const vals = active.map(r => r[m.id]).filter(x => x != null);
  if (m.id === 'adherence') {
    let up = 0, pairs = 0;
    for (let i = 1; i < vals.length; i++) { pairs++; if (vals[i] >= vals[i - 1]) up++; }
    return 'The cleanest signal there is — entirely under your control, unaffected by what the market did.' +
      (pairs >= 3 ? ` ${up} of the last ${pairs} weeks moved up.` : '');
  }
  if (m.id === 'overrideR')
    return 'Shown in R, so it holds across a change of account. Dollar figures are never compared across accounts.';
  if (m.id === 'unprotectedMinutes') {
    const fix = active.map(r => r.fixMinutes).filter(x => x != null);
    if (fix.length >= 2) {
      const a = median(fix.slice(0, Math.ceil(fix.length / 2))), b = median(fix.slice(-Math.ceil(fix.length / 2)));
      if (a != null && b != null && a !== b)
        return `The time to put a stop on went from ${Math.round(a)} minutes to ${Math.round(b)}.` +
          (b < a ? ' That number usually moves first — noticing comes before not doing it.' : '');
    }
    return null;
  }
  if (m.id === 'avgScoreTaken') {
    const gap = r => (r.avgScorePassed != null && r.avgScoreTaken != null) ? r.avgScorePassed - r.avgScoreTaken : null;
    const gaps = active.map(gap).filter(x => x != null);
    if (gaps.length >= 2) {
      const a = gaps[0], b = gaps[gaps.length - 1];
      if (a !== b) return `The gap to what you passed on has ${b < a ? 'closed' : 'widened'} from ${Math.round(a)} points to ${Math.round(b)}.`;
    }
    return null;
  }
  if (m.id === 'expectancyR') {
    if (before != null && now != null && before < 0 && now >= 0)
      return 'Just crossed into positive on the four-week median. One week above water is not a trend — three would be.';
    if (before != null && now != null && before >= 0 && now < 0) return 'Slipped below water on the four-week median.';
    return 'The market\'s share of the result. Shown here, never counted in the verdict.';
  }
  return null;
}
/* Something flat while everything else improves is worth naming. */
function revengeNote(m, metrics) {
  const others = metrics.filter(x => x.id !== m.id && !x.context);
  const improving = others.filter(x => x.direction === 'better').length;
  if (m.direction === 'flat' && improving >= 2 && (m.now || 0) > 0)
    return `The one thing that has not moved. ${improving} of the others have improved around it, which makes this the one left to work on rather than one of several.`;
  return null;
}

function progressSummary(calls, episodes, journal, accounts, nowMs, positions) {
  const rows = weeklyRows(calls, episodes, journal, nowMs, positions);
  const active = rows.filter(r => r.calls || r.trades);
  const out = { rows, activeWeeks: active.length, minWeeks: PROG.MIN_WEEKS, metrics: [], verdict: null,
                tradesOnFile: (journal || []).length, accountCount: (accounts || []).length,
                accountsDetail: accountsDetail(accounts, positions) };

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
      if (!m.context) { if (dir === 'better') up++; else if (dir === 'worse') down++; }
      out.metrics.push({ id: m.id, label: m.label, fmt: m.fmt, before: a, now: b, direction: dir,
                         context: !!m.context, series: rows.map(r => r[m.id]),
                         note: metricNote(m, rows, active, a, b, out.metrics) });
    });
    const money = { before: median(earlier.map(r => r.expectancyR)), now: median(recent.map(r => r.expectancyR)) };
    out.money = money;
    out.metrics.forEach(x => { if (x.id === 'revenge') x.note = revengeNote(x, out.metrics); });
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

  /* One line per week, written from that week's own figures — and the row
     that matters: behaviour improved while the money went backwards, which
     a P/L-based view would have called a failure. */
  const act = out.rows.filter(r => r.calls || r.trades);
  act.forEach((r, i) => {
    const prev = act[i - 1];
    const notes = [];
    if (r.adherence != null && r.adherence >= 0.7 && (!prev || prev.adherence == null || prev.adherence < 0.7))
      notes.push('First week above 70% adherence.');
    if (prev && prev.unprotectedMinutes > 0 && r.unprotectedMinutes === 0) notes.push('Every trade had a stop.');
    else if (prev && r.unprotectedMinutes < prev.unprotectedMinutes * 0.6 && prev.unprotectedMinutes >= 30)
      notes.push('Stops went on much faster.');
    if (prev && r.adherence != null && prev.adherence != null && r.adherence > prev.adherence &&
        r.expectancyR != null && prev.expectancyR != null && r.expectancyR < prev.expectancyR)
      notes.push('Behaviour held through a worse week.');
    if (r.revenge > 0 && r.revenge >= Math.max(2, ...act.map(x => x.revenge))) notes.push(`${r.revenge} revenge entries — the most of any week.`);
    // strictly better than every other week: a tie is not a best week, and
    // four identical weeks must not all be called "best"
    if (r.trades && r.netPL != null && act.length > 2 &&
        act.every(x => x === r || x.netPL == null || x.netPL < r.netPL))
      notes.push('Best week for money.');
    r.note = notes.slice(0, 2).join(' ') || null;
  });
  const matters = act.map((r, i) => {
    const prev = act[i - 1]; if (!prev) return null;
    const better = ['adherence', 'avgScoreTaken'].filter(k => r[k] != null && prev[k] != null && r[k] > prev[k]).length +
      (r.unprotectedMinutes < prev.unprotectedMinutes ? 1 : 0) + (r.revenge < prev.revenge ? 1 : 0);
    const moneyDown = r.expectancyR != null && prev.expectancyR != null && r.expectancyR < prev.expectancyR;
    return (better >= 2 && moneyDown) ? { week: r.week, better } : null;
  }).filter(Boolean).pop();
  out.rowThatMatters = matters || null;

  // account changes, marked on the week they happened — so a step in the
  // numbers caused by a new account is never read as a change in the trader
  out.accounts = (accounts || []).map(a => ({ account: a.account_number, kind: a.kind || 'unknown',
    week: weekOf(Date.parse(a.first_seen_at)).key, firstSeen: a.first_seen_at }));

  // milestones — nine weeks of small gains are hard to feel from the inside
  const ms = [];
  const firstAt = th => rows.find(r => r.calls >= 5 && r.adherence != null && r.adherence >= th);
  const bestAdh = Math.max.apply(null, rows.filter(r => r.calls >= 5 && r.adherence != null).map(r => r.adherence).concat([0]));
  [0.7, 0.8].forEach(th => { const r = firstAt(th);
    ms.push({ id: 'adherence_' + th * 100, label: `First week following ${th * 100}%+ of calls`, done: !!r, when: r ? r.week : null,
      short: r ? null : (bestAdh > 0 ? `${Math.round(bestAdh * 100)}%, ${Math.round((th - bestAdh) * 100)} point${Math.round((th - bestAdh) * 100) === 1 ? '' : 's'} away` : null) }); });
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
  // the week each fingerprint reached its 30th trade
  const fpWeek = {};
  Object.keys(fp).forEach(k => {
    const list = (journal || []).filter(t => t.close_time && [normSym(t.symbol),
      String(t.direction || '').toLowerCase().indexOf('sell') >= 0 ? 'short' : 'long', t.session || 'any'].join(' · ') === k)
      .sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
    if (list.length >= PROG.EDGE_SAMPLE) fpWeek[k] = weekOf(Date.parse(list[PROG.EDGE_SAMPLE - 1].close_time)).key;
  });
  out.fingerprints.forEach(f => { f.unlockedWeek = fpWeek[f.fingerprint] || null; });
  out.fingerprints.filter(f => f.unlocked).forEach(f =>
    ms.push({ id: 'fp_' + f.fingerprint, label: `${f.fingerprint} reached ${PROG.EDGE_SAMPLE} trades — your own odds are real now`,
      done: true, when: fpWeek[f.fingerprint] || null }));
  out.milestones = ms;
  return out;
}

/* ═══ WHAT AN EPISODE LOOKED LIKE IN CONTEXT ════════════════════════════
   The prototype's habit lines cross-referenced things nothing computed:
     "Arbiter had rated that setup 38 … closed -18 pips"  (a revenge entry
     against the call on that pair and the trade's own result)
     "3.2x your median size"                              (sizing)
   Both are real once the pieces are joined. Sizing is a multiple of the
   trader's own median RISK (his rule: judged on risk, not lots), with the
   lots shown alongside because that is what the terminal shows. */
function enrichEpisodes(episodes, calls, journal, positions) {
  const find = tradeLookup(journal, positions);
  const risks = (positions || []).map(p => Number(p.risk_pct)).filter(x => x > 0).sort((a, b) => a - b);
  const medRisk = risks.length >= 5 ? risks[Math.floor(risks.length / 2)] : null;
  const lots = (positions || []).map(p => Number(p.volume)).filter(x => x > 0).sort((a, b) => a - b);
  const medLots = lots.length >= 5 ? lots[Math.floor(lots.length / 2)] : null;
  const posBy = {}; (positions || []).forEach(p => { posBy[String(p.ticket)] = p; });

  (episodes || []).forEach(e => {
    if (!e.ticket) return;
    const pos = posBy[String(e.ticket)];
    const ctx = e.context = e.context || {};
    const link = {};
    if (pos) {
      link.volume = Number(pos.volume) || null;
      link.riskPct = Number(pos.risk_pct) || null;
      if (medRisk && link.riskPct) link.riskX = Math.round((link.riskPct / medRisk) * 10) / 10;
      if (medLots && link.volume) link.lotsX = Math.round((link.volume / medLots) * 10) / 10;
      link.medianRiskPct = medRisk; link.medianLots = medLots;
      const t = find(e.ticket);
      if (t) { link.resultPL = Number(t.total_pl) || 0; link.resultPips = t.pips != null ? Number(t.pips) : null;
               link.closedAt = t.close_time; }
      // the call Arbiter made on that pair, in the 20 minutes before the trade opened
      const opened = pos.open_time_s ? pos.open_time_s * 1000 : Date.parse(e.opened_at);
      const sym = normSym(pos.symbol);
      const c = (calls || []).filter(x => x.kind !== 'live' && normSym(x.symbol) === sym && x.score != null &&
          Date.parse(x.created_at) <= opened && opened - Date.parse(x.created_at) <= WINDOW_MS)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
      if (c) link.call = { kind: c.kind, score: c.score, direction: c.direction, outcome: c.outcome || null };
    }
    if (Object.keys(link).length) ctx.link = link;
  });
  return episodes;
}

/* ═══ CALIBRATION ════════════════════════════════════════════════════
   1. THE SETUP SCORE — higher scores should run more often. If 80+ runs
      less than 55-69, the score is lying and the weights are wrong.
   2. THE PRESSURE THRESHOLDS — the ledger stamped the price at the moment
      Arbiter said CUT or MOVE TO BREAK-EVEN. The journal knows how the
      trade finished. The gap, in R, is what acting would have saved or
      cost. That is the evidence for whether 45 and 20 are right. */
/* ═══ FINDING A POSITION'S CLOSED TRADE ═════════════════════════════════
   Arbiter records everything against the POSITION ticket (the EA's
   PositionGetTicket). The EA's closed trades carry the closing DEAL ticket,
   and the journal is written by a separate program whose ticket choice is
   not visible here. In MT5 those are different numbers for the same trade,
   so matching on ticket alone can find NOTHING — which left the grids empty.
   So: the ticket first; if that fails, the trade itself — same pair, same
   direction, same entry price (within 0.2 pip). Several journal rows for one
   position (partial closes) are one trade: the last close, P/L summed.
   ONE function, used by every place that needs a closed trade. */
function normSym(s) { return String(s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6); }
function tradeLookup(journal, positions) {
  const j = journal || [];
  const byTicket = {}; j.forEach(t => { if (t && t.ticket != null) byTicket[String(t.ticket)] = t; });
  const posByTicket = {}; (positions || []).forEach(p => { if (p && p.ticket != null) posByTicket[String(p.ticket)] = p; });
  const cache = {};
  return function (ticket) {
    const k = String(ticket);
    if (k in cache) return cache[k];
    if (byTicket[k]) return (cache[k] = byTicket[k]);
    const p = posByTicket[k];
    if (!p || !(Number(p.open_price) > 0)) return (cache[k] = null);
    const tol = pipOf(p.symbol) * 0.2;
    const side = String(p.side || '').toLowerCase().indexOf('sell') >= 0 ? 'sell' : 'buy';
    const firstSeen = p.first_seen_at ? Date.parse(p.first_seen_at) - 86400000 : 0;
    const cands = j.filter(t => t && t.close_time &&
      normSym(t.symbol) === normSym(p.symbol) &&
      (String(t.direction || '').toLowerCase().indexOf('sell') >= 0 ? 'sell' : 'buy') === side &&
      Math.abs(Number(t.open_price) - Number(p.open_price)) <= tol &&
      Date.parse(t.close_time) >= firstSeen)
      .sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
    if (!cands.length) return (cache[k] = null);
    const last = cands[cands.length - 1];
    return (cache[k] = Object.assign({}, last, {
      ticket: k, matchedBy: 'identity', rows: cands.length,
      total_pl: Math.round(cands.reduce((a, t) => a + (Number(t.total_pl) || 0), 0) * 100) / 100 }));
  };
}

/* ═══ WHAT FOLLOWING A LIVE CALL WAS WORTH ══════════════════════════════
   Assan's point: Arbiter cannot know the future, so a live call is never
   "right" or "wrong". But once the trade has CLOSED, what following it was
   worth is a measurement, not a prediction: the server stamped the price at
   the moment of the call, and the journal knows how the trade finished.
     CUT          following = closing at the call's price
     BREAK-EVEN   following = the loss capped at 0R
     PARTIAL      following = banking HALF at the call's price
     HOLD         following = staying in, versus closing at the call
   Positive = following was better than not. In R, so it is the same on any
   account size. Graded whether or not the trader followed. ONE function:
   calibration's cut / break-even evidence uses this same arithmetic, so the
   two places can never disagree. */
function liveWorth(call, trade) {
  if (!call || call.kind !== 'live' || !call.price_at) return { state: 'n/a' };
  if (!trade || !trade.close_price) return { state: 'open' };           // not closed yet
  const final = rOf(trade);
  const open = Number(trade.open_price), sl = Number(trade.sl);
  if (final == null || !(sl > 0) || !(open > 0)) return { state: 'no_stop' };   // no stop, no R
  const pip = pipOf(trade.symbol), stop = Math.abs(open - sl) / pip;
  const sell = String(trade.direction || '').toLowerCase().indexOf('sell') >= 0;
  const atCall = Math.round((((sell ? open - call.price_at : call.price_at - open) / pip) / stop) * 1e4) / 1e4;
  let worth;
  if (call.action === 'cut') worth = atCall - final;
  else if (call.action === 'be') worth = Math.max(0, final) - final;
  else if (call.action === 'partial') worth = 0.5 * (atCall - final);
  else if (call.action === 'hold') worth = final - atCall;
  else return { state: 'n/a' };
  return { state: 'graded', atCallR: r2(atCall), finalR: r2(final), worthR: r2(worth) };
}

/* Live calls ARE on pairs the trader traded — they are advice about an
   open position — so they belong in "is it you, or is it Blackwood?".
   They were never boxed: only take/skip calls were, which left the grid
   empty for exactly the trades it is meant to judge. Boxed by the sign of
   what following was worth: + = Blackwood right, − = Blackwood wrong;
   followed / ignored decides the column. Worth 0 (e.g. break-even on a
   trade that then won) tells nothing either way and stays out. Only once
   the trade has closed. */
function liveBox(c) {
  if (!c || c.kind !== 'live' || !c.worth || c.worth.state !== 'graded' || !c.worth.worthR) return null;
  const followed = c.adherence === 'followed', ignored = c.adherence === 'ignored';
  if (!followed && !ignored) return null;
  const right = c.worth.worthR > 0;
  return right ? (followed ? 'good' : 'expensive') : (followed ? 'ours' : 'luck');
}
/* THE function both Today's calls and the Daily/Weekly summary use, so the
   two tabs can never show different grids for the same day. */
function attachLive(rows, journal, positions) {
  const find = tradeLookup(journal, positions);
  (rows || []).forEach(r => {
    if (r.kind !== 'live') return;
    r.worth = liveWorth(r, find(r.ticket));
    const b = liveBox(r);
    if (b) r.box = b;
  });
  return rows;
}

const SCORE_BANDS = [[0, 44, 'under 45 (gated)'], [45, 54, '45–54'], [55, 69, '55–69'], [70, 79, '70–79'], [80, 100, '80+']];
function calibrationSummary(calls, journal, stage, positions) {
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
  const find = tradeLookup(journal, positions);
  function evidence(action) {
    const rows = [];
    (calls || []).filter(c => c.kind === 'live' && c.action === action && c.ticket && c.price_at).forEach(c => {
      const w = liveWorth(c, find(c.ticket));                          // the SAME arithmetic as each call's grade
      if (w.state !== 'graded') return;                              // not closed yet, or no stop
      rows.push({ ticket: c.ticket, pressure: c.score, adherence: c.adherence || null, atCallR: w.atCallR, finalR: w.finalR,
                  savedR: w.worthR });
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
const CLAIM_STALE_MS = 10 * 60 * 1000;
const EXTERNAL_STALE_MS = 3 * 60 * 1000;   // a page-reported episode ends 3 min after the last report   // a "writing" claim older than this was abandoned

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
      first: r.context && r.context.first || null,
      external: r.type === 'flagged_hold'
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
      // Episodes reported by a page (Risk Radar, which the server cannot see)
      // are not the server's to raise — they end when the page stops reporting.
      if (ep.external) {
        if (t - ep.lastTrueAt < EXTERNAL_STALE_MS) continue;
        sc.episodes.delete(key);
        jobs.push(http.patch(`${T.errors}?id=eq.${ep.id}`, { closed_at: iso(ep.lastTrueAt),
          last_true_at: iso(ep.lastTrueAt), close_reason: 'resolved' }, H()).catch(() => {}));
        continue;
      }
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
      // TODAY means today, not the last 24 hours: at 9am a rolling window
      // still showed yesterday afternoon's calls as today's. The day starts
      // at 00:00 UTC and the list empties there.
      const since = days === 1 ? iso(dayRange(dayOf(now())).start) : iso(now() - days * DAY);
      const { data } = await http.get(
        `${T.calls}?user_id=eq.${req.user.id}&created_at=gte.${since}&select=*&order=created_at.desc&limit=500`, H());
      const rows = data || [];
      // live calls get what following them was worth, and their box, once their trade has closed
      if (rows.some(r => r.kind === 'live') && getJournal) {
        const [jr, pos] = await Promise.all([
          getJournal(req.user.id).catch(() => []),
          http.get(`${T.positions}?user_id=eq.${req.user.id}&first_seen_at=gte.${iso(now() - (days + 7) * DAY)}&select=ticket,symbol,side,open_price,first_seen_at&limit=2000`, H())
            .then(r => r.data || []).catch(() => [])
        ]);
        attachLive(rows, jr, pos);
      }
      const q = { good: 0, expensive: 0, ours: 0, luck: 0 };
      rows.forEach(r => { if (r.box && q[r.box] != null) q[r.box]++; });
      res.json({ ok: true, days, day: days === 1 ? dayOf(now()) : null, since, calls: rows, quad: q,
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
      const [eps, acc, cls, pos, jr] = await Promise.all([
        http.get(`${T.errors}?user_id=eq.${uid}&opened_at=gte.${since}&select=*&order=opened_at.desc&limit=3000`, H()),
        http.get(`${T.accounts}?user_id=eq.${uid}&select=first_seen_at&order=first_seen_at.asc&limit=1`, H()),
        http.get(`${T.calls}?user_id=eq.${uid}&created_at=gte.${since}&select=*&limit=2000`, H()),
        http.get(`${T.positions}?user_id=eq.${uid}&select=ticket,symbol,side,open_price,open_time_s,volume,risk_pct,first_seen_at&order=first_seen_at.desc&limit=200`, H()),
        getJournal ? getJournal(uid).catch(() => []) : Promise.resolve([])
      ]);
      const eeps = enrichEpisodes(eps.data || [], cls.data || [], jr || [], pos.data || []);
      const first = acc.data && acc.data[0] ? Date.parse(acc.data[0].first_seen_at) : null;
      res.json(Object.assign({ ok: true },
        habitsSummary(eeps, t, { activeDays: activeDays(t, first, eeps, pos.data, cls.data, jr) })));
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
  /* The days Arbiter has data for, BEFORE today: any day with an episode, a
     position, a call or a closed trade. The account's first sighting bounds
     it, so a long-dormant account cannot claim more history than it has. */
  function activeDays(nowMs, firstSeenMs, ...sets) {
    const days = new Set();
    const todayStart = Date.parse(dayOf(nowMs) + 'T00:00:00Z');
    const add = ms => { if (ms && ms < todayStart && (!firstSeenMs || ms >= firstSeenMs - DAY)) days.add(dayOf(ms)); };
    (sets || []).forEach(list => (list || []).forEach(r => {
      if (!r) return;
      add(Date.parse(r.opened_at || r.created_at || r.close_time || r.first_seen_at || 0) || null);
    }));
    return Math.min(HABIT.BASELINE_DAYS, days.size);
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
    // the SAME live grading as Today's calls, before the facts are built
    return buildFacts(kind, period, attachLive(cls.data || [], jr || [], pos.data || []), eps.data || [], pos.data || [], jr || [],
      { activeDays: activeDays(period.end - 1, first, eps.data, pos.data, cls.data, jr) });
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

  /* Risk Radar runs in the Assistant's page, so the server never sees it.
     Arbiter's page reports a position held while its pair is flagged, and the
     server keeps it as an episode like any other — opened once, refreshed
     while it is still true, closed at the last moment it was seen. The honest
     limit: only recorded while a Blackwood page is open. */
  app.post('/api/arbiter/flagged', gate, async (req, res) => {
    try {
      const uid = req.user.id, b = req.body || {};
      const acct = b.account != null ? String(b.account) : null;
      if (!acct || !b.ticket) return res.status(400).json({ ok: false, error: 'account and ticket are required' });
      const sc = getScope(uid, acct);
      if (!sc.hydrated) await hydrate(sc);
      const key = 'flagged:' + b.ticket;
      const t = now();
      const ep = sc.episodes.get(key);
      if (!ep) {
        const { data } = await http.post(T.errors, {
          user_id: uid, account_number: acct, episode_key: key, type: 'flagged_hold',
          severity: num(b.score) >= 75 ? 'high' : 'medium', ticket: String(b.ticket), symbol: norm(b.symbol),
          opened_at: iso(t), last_true_at: iso(t),
          context: { first: { title: `${norm(b.symbol)} held while Risk Radar was ${b.state || 'flagged'}`,
                              detail: `Risk Radar was at ${Math.round(num(b.score))} on ${norm(b.symbol)} while this position was open.`,
                              metric: { score: num(b.score) } },
                     peak: { score: num(b.score) } }
        }, H({ 'Content-Type': 'application/json', Prefer: 'return=representation' }));
        const row = Array.isArray(data) ? data[0] : data;
        if (row && row.id != null) sc.episodes.set(key, { id: row.id, key, type: 'flagged_hold',
          severity: row.severity, openedAt: t, lastTrueAt: t, touchedAt: t, peak: { score: num(b.score) },
          first: row.context && row.context.first, external: true });
      } else {
        ep.lastTrueAt = t; ep.external = true;
        ep.peak = widenPeak(ep.peak, { score: num(b.score) });
        if (t - ep.touchedAt >= TOUCH_MS) {
          ep.touchedAt = t;
          await http.patch(`${T.errors}?id=eq.${ep.id}`, { last_true_at: iso(t),
            context: { first: ep.first || null, last: null, peak: ep.peak } }, H()).catch(() => {});
        }
      }
      res.json({ ok: true });
    } catch (e) {
      log.warn('[ARBITER] flagged report failed:', e.message);
      res.status(500).json({ ok: false });
    }
  });

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
    const [cls, eps, acc, jr, pos] = await Promise.all([
      http.get(`${T.calls}?user_id=eq.${uid}&created_at=gte.${since}&select=*&order=created_at.asc&limit=5000`, H()),
      http.get(`${T.errors}?user_id=eq.${uid}&opened_at=gte.${since}&select=*&limit=5000`, H()),
      http.get(`${T.accounts}?user_id=eq.${uid}&select=*&order=first_seen_at.asc`, H()),
      getJournal ? getJournal(uid).catch(() => []) : Promise.resolve([]),
      http.get(`${T.positions}?user_id=eq.${uid}&select=ticket,account_number,symbol,raw_symbol,side,open_price,volume,risk_pct,first_seen_at&limit=5000`, H())
    ]);
    return { calls: cls.data || [], episodes: eps.data || [], accounts: acc.data || [], journal: jr || [], positions: pos.data || [] };
  }
  app.get('/api/arbiter/progress', gate, async (req, res) => {
    try {
      const h = await history(req.user.id, PROG.WEEKS);
      res.json(Object.assign({ ok: true }, progressSummary(h.calls, h.episodes, h.journal, h.accounts, now(), h.positions)));
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
      res.json(Object.assign({ ok: true }, calibrationSummary(h.calls, h.journal, require('./arbiter-engine.js').STAGE, h.positions)));
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
module.exports.progress = { tradeLookup, liveWorth, liveBox, attachLive, progressSummary, accountsDetail, calibrationSummary, weeklyRows, rOf, median, PROG, METRICS };
module.exports.reports = { buildFacts, weekOf, dayRange, REPORT_RULES, MODEL, CONSENT_VERSION, CONSENT_TEXT };
module.exports.habits = { habitsSummary, activeDaysFrom, enrichEpisodes, HABIT, HABIT_LABELS, COUNTED };
module.exports.ledger = { atrOf, firstCrossings, outcomeOf, correctness, boxOf, adherenceFor, liveAdherence,
                          WINDOW_MS, HORIZON_MS };
