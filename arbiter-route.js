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
// THE MODULE
// ═══════════════════════════════════════════════════════════════════
module.exports = function mountArbiter(app, deps) {
  const {
    requirePlan, getState, getCandlesStore, livePriceFor, normalisePair,
    getNews, getRiskSettings, SUPABASE_URL, supabaseServiceHeaders
  } = deps;
  const http = deps.http || require('axios');
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;

  const T = {
    accounts:  `${SUPABASE_URL}/rest/v1/arbiter_accounts`,
    positions: `${SUPABASE_URL}/rest/v1/arbiter_positions`,
    errors:    `${SUPABASE_URL}/rest/v1/arbiter_errors`
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
      episodes: new Map(), positions: new Map(), accountTouchedAt: 0, accountKnown: false
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
    const [eps, pos, acc] = await Promise.all([
      http.get(`${T.errors}?${q}&closed_at=is.null&select=*`, H()),
      http.get(`${T.positions}?${q}&closed_at=is.null&select=*`, H()),
      http.get(`${T.accounts}?${q}&select=account_number`, H())
    ]);
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

  return { onHeartbeat, _test: { evaluateErrors, excursionFrom, pipSizeFor, RULES, scopes } };
};

module.exports.evaluateErrors = evaluateErrors;
module.exports.excursionFrom = excursionFrom;
module.exports.RULES = RULES;
