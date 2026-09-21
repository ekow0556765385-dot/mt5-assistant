/* ═══════════════════════════════════════════════════════════════════
   BLACKWOOD ARBITER — the engine (Phase 2)

   Pure computation. No DOM, no fetch, no database, no clock of its own —
   `now` is passed in. It takes a WORLD (what every module can see at this
   moment) and returns a judgement. That is deliberate: everything here can
   be tested against a fixture, and the same code runs in a browser tab or
   on the server without changing.

   TWO ENTRY POINTS
     judgeSetup(world, opts)          — the hunting state, one pair
     judgePosition(world, position, opts) — the live state, one open trade

   THREE RULES THIS FILE ENFORCES
     1. A condition with no data is `unknown`. It is never counted as a
        pass and never as a fail — it leaves the score, and says so. A
        missing feed must not look like evidence.
     2. Risk Radar is a TRUST DISCOUNT, applied last. It pulls the score
        toward the middle. It can never push it toward a direction.
     3. Nothing is invented. Every number returned carries where it came
        from, and a level that was not quoted reads "not quoted".
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

/* ── WHICH CONDITIONS ARE GATES ──────────────────────────────────────
   A gate failing caps the score, because a setup missing one of these is
   not a weaker setup — it is a different thing wearing the name.
   THIS IS A TRADING JUDGEMENT, NOT A TECHNICAL ONE. Change this list and
   GATE_CAP and the whole engine follows; nothing else needs editing. */
const GATES = ['structure', 'location', 'trigger'];
/* A gate is a VETO: one failing condition overrides thirteen passing ones.
   That is deliberate — a setup with no trigger is not a weaker setup, it is
   one you are still waiting on. But one gate down and all three down are not
   the same thing, so the cap tightens with each: 1 -> 45, 2 -> 30, 3 -> 15.
   `rawScore` always carries what it would have scored uncapped, so a veto
   can be seen and argued with rather than just obeyed. */
const GATE_CAP = 45;
const GATE_CAPS = [45, 30, 15];

/* Core conditions carry the score. Adjusters shade it. */
const CORE      = ['zone_trust', 'liquidity', 'pullback', 'room', 'own_edge'];
const ADJUSTERS = ['reach', 'session', 'news', 'radar', 'correlation', 'spread'];

const WEIGHTS = {
  structure: 20, location: 18, trigger: 16,          // gates also carry weight
  zone_trust: 10, liquidity: 10, pullback: 8, room: 8, own_edge: 14,
  reach: 4, session: 4, news: 4, correlation: 4, spread: 3
  // `radar` deliberately has no weight — it is applied as a discount below.
};

/* own_edge is the only condition whose weight depends on its evidence: no
   weight at all until the sample is real. A hit rate from 6 trades must not
   move a score. */
const EDGE_MIN_SAMPLE = 30;

const PASS = 'pass', WARN = 'warn', FAIL = 'fail', UNKNOWN = 'unknown';
const VALUE = { pass: 1, warn: 0.5, fail: 0 };

/* ── tolerant readers ────────────────────────────────────────────────
   STANDING RULE in this codebase: never read a pattern's direction or
   confidence directly. The EA sends type/confidence_pct; getEAPatterns
   maps them to direction/confidence. Both shapes coexist. */
function patDir(p) {
  const raw = String((p && (p.direction || p.type)) || '').toLowerCase();
  if (raw.indexOf('bull') === 0 || raw === 'buy') return 'bull';
  if (raw.indexOf('bear') === 0 || raw === 'sell') return 'bear';
  return 'neutral';
}
function patConf(p) {
  const v = parseFloat((p && (p.confidence !== undefined ? p.confidence : p.confidence_pct)));
  return Number.isFinite(v) ? v : 0;
}
function patAge(p) {
  const v = parseFloat((p && (p.barsAgo !== undefined ? p.barsAgo : p.bar_index)));
  return Number.isFinite(v) ? v : 99;
}
const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const dirOf = side => (String(side || '').toLowerCase().indexOf('sell') >= 0 ? 'bear' : 'bull');

function pipSizeFor(sym) {
  sym = String(sym || '').toUpperCase();
  if (/JPY$/.test(sym)) return 0.01;
  if (/^XAU/.test(sym)) return 0.1;
  if (/^XAG/.test(sym)) return 0.01;
  if (/^(BTC|ETH)/.test(sym)) return 1;
  return 0.0001;
}
const pips = (a, b, sym) => (a - b) / pipSizeFor(sym);

function res(state, detail, source, metric) {
  return { state, detail, source: source || null, metric: metric || null };
}

/* ═══════════════════════════════════════════════════════════════════
   THE FOURTEEN CONDITIONS
   Each returns {state, detail, source, metric}. `want` is the direction
   being judged: 'bull' or 'bear'. For a setup it is the direction the
   evidence points; for a position it is the direction the trader is in.
   ═══════════════════════════════════════════════════════════════════ */
const CONDITIONS = {

  // 1 ── structure alignment. Assan's rule: breaking the LH (or the HL in
  //      an uptrend) is a reversal.
  structure(w, want) {
    const st = w.structure;
    if (!st || !st.regime) return res(UNKNOWN, 'No structure reading available.', 'structure');
    const regime = String(st.regime).toLowerCase();
    const conf = n(st.confidence);
    const bull = regime.indexOf('up') >= 0, bear = regime.indexOf('down') >= 0;
    const label = `${regime}${conf != null ? ', ' + Math.round(conf * (conf <= 1 ? 100 : 1)) + '% confidence' : ''}`;
    if (!bull && !bear) return res(WARN, `Structure is ${regime} — no trend to align with.`, 'structure', { regime });
    const aligned = (want === 'bull' && bull) || (want === 'bear' && bear);
    if (!aligned) return res(FAIL, `Structure is ${label} — the opposite way to this trade.`, 'structure', { regime });
    // A same-direction trend whose own confidence is low is a warn, not a pass.
    const c = conf != null ? (conf <= 1 ? conf : conf / 100) : null;
    if (c != null && c < 0.6) return res(WARN, `Structure is ${label} — agreeing, but weakly held.`, 'structure', { regime, confidence: c });
    return res(PASS, `Structure is ${label}.`, 'structure', { regime, confidence: c });
  },

  // 2 ── location: at a zone, or chasing mid-range
  location(w, want) {
    const z = nearestZone(w, want);
    if (!w.zones) return res(UNKNOWN, 'No zone data.', 'smc');
    if (!z) return res(FAIL, 'No zone in this direction — price is mid-range.', 'smc');
    const sym = w.symbol;
    const d = Math.abs(pips(w.price, z.inside ? w.price : z.edge, sym));
    if (z.inside) return res(PASS, `Price is inside the ${z.kindLabel} ${fmt(z.lo, sym)} – ${fmt(z.hi, sym)}.`, 'smc', { pipsAway: 0 });
    if (d <= (w.nearPips || 15)) return res(PASS, `${d.toFixed(0)} pips from the ${z.kindLabel} ${fmt(z.lo, sym)} – ${fmt(z.hi, sym)}.`, 'smc', { pipsAway: d });
    if (d <= (w.nearPips || 15) * 3) return res(WARN, `${d.toFixed(0)} pips from the nearest ${z.kindLabel} — not there yet.`, 'smc', { pipsAway: d });
    return res(FAIL, `Nearest ${z.kindLabel} is ${d.toFixed(0)} pips away. This would be chasing.`, 'smc', { pipsAway: d });
  },

  // 3 ── zone trust: age, touches, mitigation, strength normalised to the
  //      pair's own median zone height (never raw price height)
  zone_trust(w, want) {
    const z = nearestZone(w, want);
    if (!z) return res(UNKNOWN, 'No zone to judge.', 'smc');
    if (z.spent) return res(FAIL, 'That zone has already been closed through — it is spent.', 'smc', { spent: true });
    const bits = [], metric = { touches: z.touches, ageHours: z.ageHours };
    let state = PASS;
    if (z.touches != null) {
      bits.push(`${z.touches} touch${z.touches === 1 ? '' : 'es'}`);
      if (z.touches >= 3) state = WARN;
    }
    if (z.ageHours != null) {
      bits.push(`${z.ageHours < 48 ? Math.round(z.ageHours) + 'h' : Math.round(z.ageHours / 24) + ' days'} old`);
      if (z.ageHours > 96) state = WARN;
    }
    if (z.height != null && w.medianZoneHeight) {
      const rel = z.height / w.medianZoneHeight;
      metric.relativeHeight = rel;
      bits.push(`${rel.toFixed(1)}x this pair's median zone height`);
      if (rel < 0.5) state = WARN;
    }
    return res(state, `Unmitigated, ${bits.join(', ')}.`, 'smc', metric);
  },

  // 4 ── trigger freshness. bar_index <= 2, or it is not a trigger.
  trigger(w, want) {
    if (!w.patterns) return res(UNKNOWN, 'No pattern feed.', 'patterns');
    const live = w.patterns.filter(p => patAge(p) <= 2 && patDir(p) === want && patConf(p) >= (w.minTriggerConf || 70));
    if (live.length) {
      const best = live.sort((a, b) => patConf(b) - patConf(a))[0];
      return res(PASS, `${best.name || 'Pattern'} on ${best.timeframe || w.timeframe || ''} at ${patConf(best)}%, ${patAge(best)} bar${patAge(best) === 1 ? '' : 's'} ago.`,
        'patterns', { name: best.name, confidence: patConf(best), barsAgo: patAge(best) });
    }
    const stale = w.patterns.filter(p => patDir(p) === want && patAge(p) > 2);
    if (stale.length) {
      const s = stale.sort((a, b) => patAge(a) - patAge(b))[0];
      return res(FAIL, `Nothing fresh. The newest is ${s.name || 'a pattern'} ${patAge(s)} bars ago — taking it now would be a chase.`,
        'patterns', { staleBarsAgo: patAge(s) });
    }
    return res(FAIL, 'No trigger has fired.', 'patterns');
  },

  // 5 ── liquidity: has the hunt already happened
  liquidity(w, want) {
    const sw = w.sweep;
    if (sw === undefined || sw === null) {
      if (!w.restingLiquidity) return res(UNKNOWN, 'No liquidity reading.', 'liquidity');
    }
    const st = String(sw || '').toLowerCase();
    if (st === 'confirmed') return res(PASS, 'Liquidity was taken and price closed back inside the block.', 'smc · brain', { sweep: st });
    if (st === 'swept')     return res(WARN, 'Swept, but price has not closed back inside yet.', 'smc · brain', { sweep: st });
    if (st === 'warning')   return res(WARN, 'The hunt has not happened yet.', 'smc · brain', { sweep: st });
    const rl = w.restingLiquidity;
    if (rl && rl.pipsAway != null) {
      const side = rl.side === 'below' ? 'below' : 'above';
      const against = (want === 'bull' && side === 'below') || (want === 'bear' && side === 'above');
      return res(against ? FAIL : WARN,
        `${rl.label || 'Resting liquidity'} ${rl.pipsAway.toFixed(0)} pips ${side}${against ? ' — price tends to reach for it before turning' : ''}.`,
        'liquidity', { pipsAway: rl.pipsAway, side });
    }
    return res(UNKNOWN, 'No live block to sweep.', 'smc');
  },

  // 6 ── pullback vs reversal, from the retracement engine
  pullback(w) {
    const r = w.retracement;
    if (!r || r.score == null) return res(UNKNOWN, 'No retracement reading.', 'retracement');
    const s = n(r.score);
    if (s <= 35) return res(PASS, `Pullback, score ${s}. ${r.note || ''}`.trim(), 'retracement', { score: s });
    if (s <= 65) return res(WARN, `Undecided, score ${s} — not clearly a pullback.`, 'retracement', { score: s });
    return res(FAIL, `Leaning reversal, score ${s}.`, 'retracement', { score: s });
  },

  // 7 ── room to target: the nearest OPPOSING zone, not the planned target
  room(w, want) {
    const t = n(w.target);
    const opp = opposingZone(w, want);
    if (t == null) return res(UNKNOWN, 'No target to measure against.', 'smc');
    const sym = w.symbol;
    const toTarget = Math.abs(pips(t, w.price, sym));
    if (!opp) return res(PASS, `No opposing zone between price and ${fmt(t, sym)}.`, 'smc', { toTargetPips: toTarget });
    const toOpp = Math.abs(pips(opp.edge, w.price, sym));
    if (toOpp >= toTarget) return res(PASS, `Nearest opposing zone is ${toOpp.toFixed(0)} pips away, beyond the target.`, 'smc', { toTargetPips: toTarget, toOpposingPips: toOpp });
    const share = toOpp / toTarget;
    return res(share < 0.6 ? FAIL : WARN,
      `An opposing zone sits at ${fmt(opp.edge, sym)}, ${toOpp.toFixed(0)} pips away — ${Math.round(share * 100)}% of the way to the target.`,
      'smc', { toTargetPips: toTarget, toOpposingPips: toOpp, share });
  },

  // 8 ── reachability: can the pair travel that far in the time left
  reach(w) {
    const t = n(w.target), atr = n(w.atr), left = n(w.sessionMinutesLeft);
    if (t == null || atr == null) return res(UNKNOWN, 'No ATR or target.', 'atr');
    const need = Math.abs(pips(t, w.price, w.symbol));
    const have = Math.abs(atr / pipSizeFor(w.symbol));
    const metric = { needPips: need, typicalPips: have, minutesLeft: left };
    if (need <= have * 0.6) return res(PASS, `${need.toFixed(0)} pips to target against a typical ${have.toFixed(0)}.`, 'atr · session', metric);
    if (need <= have * 1.2) return res(WARN, `${need.toFixed(0)} pips to target is most of a typical ${have.toFixed(0)} — reachable, but it needs the whole move.`, 'atr · session', metric);
    return res(FAIL, `${need.toFixed(0)} pips to target against a typical ${have.toFixed(0)}. Not in this session.`, 'atr · session', metric);
  },

  // 9 ── session and liquidity depth
  session(w) {
    const d = w.session;
    if (!d || d.depth == null) return res(UNKNOWN, 'No session reading.', 'session');
    const pct = Math.round(n(d.depth) * (n(d.depth) <= 1 ? 100 : 1));
    if (pct >= 70) return res(PASS, `${d.name || 'Session'} — liquidity ${pct}% of the day's deepest.`, 'liquidity', { depth: pct });
    if (pct >= 40) return res(WARN, `${d.name || 'Session'} — liquidity ${pct}%, moderate.`, 'liquidity', { depth: pct });
    return res(FAIL, `${d.name || 'Session'} — liquidity ${pct}%. Thin enough that a move can be started and abandoned.`, 'liquidity', { depth: pct });
  },

  // 10 ── news inside the trade's expected life
  news(w) {
    if (!w.news) return res(UNKNOWN, 'No calendar.', 'calendar');
    const horizon = n(w.expectedMinutes) || 240;
    const soon = w.news.filter(e => e.impact === 'high' && n(e.minutesAway) != null && n(e.minutesAway) >= 0 && n(e.minutesAway) <= horizon);
    if (!soon.length) return res(PASS, `Nothing high-impact inside the next ${Math.round(horizon / 60)}h.`, 'calendar');
    const e = soon.sort((a, b) => n(a.minutesAway) - n(b.minutesAway))[0];
    const m = n(e.minutesAway);
    return res(m <= 60 ? FAIL : WARN,
      `${e.title} in ${m < 60 ? Math.round(m) + ' min' : (m / 60).toFixed(1) + 'h'} — inside this trade's expected life.`,
      'calendar', { title: e.title, minutesAway: m });
  },

  // 11 ── Risk Radar. NOT a direction — a discount. See applyRadar.
  radar(w) {
    const r = w.radar;
    if (!r || r.score == null) return res(UNKNOWN, 'No Risk Radar reading.', 'risk radar');
    const s = n(r.score), key = String(r.state || '').toLowerCase();
    if (s < 25) return res(PASS, `Clear (${s}). Readings taken at full weight.`, 'risk radar', { score: s, state: key });
    const top = (r.factors || []).slice(0, 2).map(f => f.label || f).join(', ');
    return res(s >= 50 ? FAIL : WARN,
      `${r.stateName || key || 'Flagged'} (${s})${top ? ' — ' + top : ''}. Everything above is less reliable than usual while this holds.`,
      'risk radar', { score: s, state: key });
  },

  // 12 ── correlation with what is already open. Stated even when flat, so
  //       the condition is visible when it passes.
  correlation(w, want) {
    // An absent feed is not the same as an empty book. Without the list we
    // do not know what else is open, and guessing "nothing" would turn a
    // missing feed into a passing condition.
    if (!Array.isArray(w.openPositions)) return res(UNKNOWN, 'No position list available.', 'positions');
    const open = w.openPositions;
    if (!open.length) return res(PASS, 'Nothing else open — this is one position, not a doubled bet.', 'positions', { count: 0 });
    const corr = (w.correlations || []).filter(c => Math.abs(n(c.rho) || 0) >= 0.6);
    const same = corr.filter(c => {
      const other = open.find(p => p.symbol === c.symbol);
      if (!other) return false;
      const otherDir = dirOf(other.side);
      return (n(c.rho) > 0) ? otherDir === want : otherDir !== want;
    });
    if (!same.length) return res(PASS, `${open.length} other position${open.length === 1 ? '' : 's'} open, none strongly correlated.`, 'positions', { count: open.length });
    const names = same.map(c => c.symbol).join(', ');
    return res(same.length > 1 ? FAIL : WARN,
      `Points the same way as ${names}. Together these are one idea at ${(same.length + 1)}x size, not ${same.length + 1} ideas.`,
      'positions', { with: same.map(c => c.symbol) });
  },

  // 13 ── spread against this pair's own median for this session
  spread(w) {
    const s = n(w.spread), med = n(w.medianSpread);
    if (s == null || med == null || med <= 0) return res(UNKNOWN, 'No spread baseline.', 'broker feed');
    const rel = s / med;
    const t = n(w.target);
    const cost = t != null ? (s / Math.abs(pips(t, w.price, w.symbol))) : null;
    const metric = { spread: s, median: med, relative: rel, shareOfMove: cost };
    const costBit = cost != null ? ` — ${Math.round(cost * 100)}% of the intended move paid on entry` : '';
    if (rel <= 1.2) return res(PASS, `Spread ${s} pips, normal for this session.`, 'broker feed', metric);
    if (rel <= 1.8) return res(WARN, `Spread ${s} against a median of ${med} — ${Math.round((rel - 1) * 100)}% wide${costBit}.`, 'broker feed', metric);
    return res(FAIL, `Spread ${s} against a median of ${med} — ${Math.round((rel - 1) * 100)}% wide${costBit}.`, 'broker feed', metric);
  },

  // 14 ── the trader's own edge. NO WEIGHT below the sample floor: a hit
  //       rate from six trades must never move a score.
  own_edge(w) {
    const e = w.edge;
    if (!e || e.sample == null) return res(UNKNOWN, 'No matching trades on file yet.', 'journal');
    const nSample = n(e.sample) || 0;
    if (nSample < EDGE_MIN_SAMPLE) {
      return res(UNKNOWN, `${nSample} of ${EDGE_MIN_SAMPLE} matching trades on file — not enough to carry weight yet.`,
        'journal', { sample: nSample, needed: EDGE_MIN_SAMPLE });
    }
    const rate = n(e.hitRate);
    const base = n(e.baseline);
    const txt = `Your own record here: ${Math.round(rate * 100)}% over ${nSample} trades`
      + (base != null ? `, against ${Math.round(base * 100)}% across all your trades` : '') + '.';
    if (base != null && rate < base * 0.8) return res(FAIL, txt + ' This is one of your weaker setups.', 'journal', { sample: nSample, hitRate: rate });
    if (rate < 0.45) return res(WARN, txt, 'journal', { sample: nSample, hitRate: rate });
    return res(PASS, txt, 'journal', { sample: nSample, hitRate: rate });
  }
};

const ORDER = ['structure', 'location', 'zone_trust', 'trigger', 'liquidity', 'pullback',
               'room', 'reach', 'session', 'news', 'radar', 'correlation', 'spread', 'own_edge'];
const LABELS = {
  structure: 'Structure alignment', location: 'Location', zone_trust: 'Zone trust',
  trigger: 'Trigger freshness', liquidity: 'Liquidity state', pullback: 'Pullback, not reversal',
  room: 'Room to target', reach: 'Can it actually get there', session: 'Session and liquidity depth',
  news: 'News proximity', radar: 'Risk Radar', correlation: 'Correlation with what you hold',
  spread: 'Spread and execution', own_edge: 'Your own edge here'
};

/* ── zone helpers ───────────────────────────────────────────────── */
function zonesFor(w) { return Array.isArray(w.zones) ? w.zones : []; }
function nearestZone(w, want) {
  const kind = want === 'bull' ? 'demand' : 'supply';
  const list = zonesFor(w).filter(z => String(z.kind).toLowerCase() === kind);
  if (!list.length) return null;
  return list.map(z => decorate(z, w)).sort((a, b) => a.distance - b.distance)[0];
}
function opposingZone(w, want) {
  const kind = want === 'bull' ? 'supply' : 'demand';
  const t = n(w.target);
  const list = zonesFor(w).filter(z => String(z.kind).toLowerCase() === kind && !z.spent).map(z => decorate(z, w))
    .filter(z => want === 'bull' ? z.edge > w.price : z.edge < w.price)
    .filter(z => t == null ? true : (want === 'bull' ? z.edge < t : z.edge > t));
  if (!list.length) return null;
  return list.sort((a, b) => a.distance - b.distance)[0];
}
function decorate(z, w) {
  const lo = n(z.lo), hi = n(z.hi), p = w.price;
  const inside = lo != null && hi != null && p >= lo && p <= hi;
  const edge = inside ? p : (p < lo ? lo : hi);
  return Object.assign({}, z, {
    lo, hi, inside, edge,
    height: (lo != null && hi != null) ? Math.abs(hi - lo) : null,
    distance: Math.abs(edge - p),
    kindLabel: String(z.kind).toLowerCase() === 'demand' ? 'demand block' : 'supply block'
  });
}
function fmt(v, sym) {
  if (v == null) return 'not quoted';
  const d = pipSizeFor(sym) >= 1 ? 1 : pipSizeFor(sym) >= 0.1 ? 2 : pipSizeFor(sym) >= 0.01 ? 3 : 5;
  return Number(v).toFixed(d);
}

/* ═══════════════════════════════════════════════════════════════════
   SCORING
   Weighted average over the conditions that HAVE data, so a missing feed
   lowers confidence in the reading rather than silently scoring zero.
   Then: gate cap, then the Risk Radar trust discount, applied last.
   ═══════════════════════════════════════════════════════════════════ */
/* A score is only published when enough evidence is behind it. One passing
   condition out of fourteen is not an 80 — it is "not enough to judge".
   Both tests must hold: the three gates must be readable, and at least half
   the available weight must have data. */
const MIN_COVERAGE_SHARE = 0.5;
const TOTAL_WEIGHT = Object.keys(WEIGHTS).reduce((a, k) => a + WEIGHTS[k], 0);

function score(results) {
  let got = 0, max = 0;
  const missing = [];
  for (const id of ORDER) {
    if (id === 'radar') continue;                 // discount, not a weight
    const r = results[id];
    const wgt = WEIGHTS[id] || 0;
    if (!r || r.state === UNKNOWN) { if (wgt) missing.push(id); continue; }
    got += VALUE[r.state] * wgt;
    max += wgt;
  }
  const gatesReadable = GATES.every(g => results[g] && results[g].state !== UNKNOWN);
  const enough = max >= TOTAL_WEIGHT * MIN_COVERAGE_SHARE && gatesReadable;
  const raw = (max > 0 && enough) ? Math.round((got / max) * 100) : null;
  return { raw, coverage: max, coverageShare: max / TOTAL_WEIGHT, gatesReadable, missing };
}

function applyGates(raw, results) {
  const failed = GATES.filter(g => results[g] && results[g].state === FAIL);
  if (!failed.length || raw == null) return { value: raw, capped: false, failed: [], cap: null };
  const cap = GATE_CAPS[Math.min(failed.length, GATE_CAPS.length) - 1];
  return { value: Math.min(raw, cap), capped: raw > cap, failed, cap };
}

/* Risk Radar pulls the score toward 50 — it weakens evidence, it never
   strengthens a direction. A flagged window cannot make a bad setup look
   good, and cannot make a good one look bad either. */
function applyRadar(value, radarResult) {
  if (value == null || !radarResult || radarResult.state === UNKNOWN) return { value, discount: 0 };
  const s = radarResult.metric && n(radarResult.metric.score);
  if (s == null || s < 25) return { value, discount: 0 };
  const pull = s >= 75 ? 0.45 : s >= 50 ? 0.30 : 0.15;
  const out = Math.round(value + (50 - value) * pull);
  return { value: out, discount: Math.abs(out - value), pull };
}

function judge(world, want, opts = {}) {
  // Read the world directly. Object.assign would INVOKE every getter here,
  // outside the per-condition try/catch — one exploding feed would then take
  // the whole judgement down instead of showing up as one unknown condition.
  // Nothing below mutates it.
  const w = world || {};
  const results = {};
  for (const id of ORDER) {
    try { results[id] = CONDITIONS[id](w, want); }
    catch (e) { results[id] = res(UNKNOWN, 'Could not be evaluated: ' + e.message, id); }
  }
  const s = score(results);
  const g = applyGates(s.raw, results);
  const r = applyRadar(g.value, results.radar);
  const conditions = ORDER.map(id => Object.assign({
    id, label: LABELS[id], tier: GATES.indexOf(id) >= 0 ? 'gate' : (CORE.indexOf(id) >= 0 ? 'core' : 'adjuster')
  }, results[id]));
  return {
    direction: want,
    score: r.value,
    rawScore: s.raw,
    gateCapped: g.capped,
    gateCap: g.cap,
    gatesFailed: g.failed,
    radarDiscount: r.discount || 0,
    missing: s.missing,
    coverageShare: s.coverageShare,
    gatesReadable: s.gatesReadable,
    conditions,
    counts: {
      pass: conditions.filter(c => c.state === PASS).length,
      warn: conditions.filter(c => c.state === WARN).length,
      fail: conditions.filter(c => c.state === FAIL).length,
      unknown: conditions.filter(c => c.state === UNKNOWN).length
    }
  };
}

/* ═══════════════════════════════════════════════════════════════════
   HUNTING STATE
   ═══════════════════════════════════════════════════════════════════ */
function judgeSetup(world, opts = {}) {
  const want = opts.direction || impliedDirection(world);
  const j = judge(world, want, opts);
  j.symbol = world.symbol;
  j.verdict = verdictFor(j);
  j.missingIngredients = j.conditions.filter(c => c.state === FAIL).map(c => c.label);
  j.waitingFor = waitingFor(j);
  return j;
}
function impliedDirection(w) {
  const st = w.structure && String(w.structure.regime || '').toLowerCase();
  if (st && st.indexOf('up') >= 0) return 'bull';
  if (st && st.indexOf('down') >= 0) return 'bear';
  const pats = (w.patterns || []).filter(p => patAge(p) <= 2);
  const bull = pats.filter(p => patDir(p) === 'bull').length;
  const bear = pats.filter(p => patDir(p) === 'bear').length;
  return bear > bull ? 'bear' : 'bull';
}
function verdictFor(j) {
  if (j.score == null) {
    const why = !j.gatesReadable
      ? 'structure, location or the trigger feed is not reporting'
      : `only ${Math.round((j.coverageShare || 0) * 100)}% of the evidence is available`;
    return { key: 'no_data', text: `Not enough is reaching Arbiter to judge this — ${why}.` };
  }
  if (j.gatesFailed.length)
    return { key: 'not_a_setup', text: `Not a setup yet — ${j.gatesFailed.map(g => LABELS[g].toLowerCase()).join(' and ')} ${j.gatesFailed.length > 1 ? 'are' : 'is'} missing.` };
  if (j.score >= 70) return { key: 'worth_taking', text: 'Everything Arbiter can see points the same way.' };
  if (j.score >= 55) return { key: 'close', text: 'Close, but something is missing.' };
  return { key: 'not_worth', text: 'Not worth taking right now.' };
}
function waitingFor(j) {
  return j.conditions.filter(c => c.state === FAIL || c.state === WARN)
    .map(c => ({ id: c.id, label: c.label, detail: c.detail }));
}

/* ═══════════════════════════════════════════════════════════════════
   LIVE STATE — the entry case, frozen, re-evaluated now.
   The pillars are the conditions the entry rested on. A pillar that was
   true at entry and is false now is BROKEN — that is the line worth the
   whole build: "the reason you entered no longer exists".
   ═══════════════════════════════════════════════════════════════════ */
const PILLARS = ['structure', 'location', 'zone_trust', 'trigger', 'liquidity', 'room'];

function freezeEntryCase(world, position) {
  const want = dirOf(position.side);
  const j = judge(world, want);
  const out = {};
  PILLARS.forEach(id => {
    const c = j.conditions.find(x => x.id === id);
    out[id] = { state: c.state, detail: c.detail, source: c.source, label: LABELS[id] };
  });
  return { at: world.now || null, direction: want, score: j.score, pillars: out };
}

function judgePosition(world, position, opts = {}) {
  const want = dirOf(position.side);
  const live = judge(world, want, opts);
  const frozen = (position.entryCase && position.entryCase.pillars) || null;

  const pillars = PILLARS.map(id => {
    const c = live.conditions.find(x => x.id === id);
    const was = frozen ? frozen[id] : null;
    let change = 'same';
    if (was && was.state !== c.state) {
      const rank = { pass: 3, warn: 2, fail: 1, unknown: 0 };
      change = (rank[c.state] < rank[was.state]) ? (c.state === FAIL ? 'broken' : 'weakened') : 'recovered';
    }
    return { id, label: LABELS[id], now: c.state, was: was ? was.state : null, change, detail: c.detail, source: c.source };
  });

  const broken = pillars.filter(p => p.change === 'broken');
  const weakened = pillars.filter(p => p.change === 'weakened');
  const structureFailed = live.conditions.find(c => c.id === 'structure').state === FAIL;
  const invalidated = isInvalidated(world, position, want);
  const counter = counterSignals(world, want);

  const action = decideAction({
    structureFailed, invalidated, broken, weakened, counter,
    inProfit: n(position.floatingPips) != null ? n(position.floatingPips) > 0 : (n(position.profit) || 0) > 0
  });

  return {
    ticket: position.ticket, symbol: world.symbol, direction: want,
    score: live.score, entryScore: position.entryCase ? position.entryCase.score : null,
    action, pillars, broken: broken.length, weakened: weakened.length,
    counterSignals: counter, invalidation: invalidated,
    excursion: excursionRead(position, world),
    conditions: live.conditions, missing: live.missing,
    transitions: transitionsFor({ world, position, want, action, invalidated })
  };
}

/* The structural level that would make the trade wrong — NOT the stop.
   The two are often different, and this one decides cut vs partial. */
function isInvalidated(world, position, want) {
  const lvl = n(world.invalidationLevel);
  if (lvl == null) return { level: null, brokenNow: false, pipsAway: null, note: 'No structural level quoted.' };
  const broken = want === 'bull' ? world.price < lvl : world.price > lvl;
  return {
    level: lvl, brokenNow: broken,
    pipsAway: Math.abs(pips(world.price, lvl, world.symbol)),
    note: broken ? 'The structural level the trade rested on has gone.' : null
  };
}

function counterSignals(world, want) {
  const against = want === 'bull' ? 'bear' : 'bull';
  const out = [];
  (world.patterns || []).forEach(p => {
    if (patDir(p) !== against) return;
    if (patAge(p) > 2) return;                                  // stale is not a live threat
    if (patConf(p) < (world.minCounterConf || 70)) return;
    out.push({ kind: 'pattern', name: p.name, confidence: patConf(p), barsAgo: patAge(p),
      detail: `${p.name} on ${p.timeframe || ''} at ${patConf(p)}%, ${patAge(p)} bar${patAge(p) === 1 ? '' : 's'} ago.` });
  });
  (world.formations || []).forEach(f => {
    if (patDir(f) !== against) return;
    const done = n(f.completion);
    if (done == null || done < (world.minFormation || 0.5)) return;
    const necklinePips = n(f.necklinePips);
    out.push({ kind: 'formation', name: f.name, completion: done, necklinePips,
      severity: f.broken ? 'broken' : (necklinePips != null && necklinePips <= 15 ? 'in_reach' : 'forming'),
      detail: f.broken ? `${f.name} neckline broken and held.`
        : `${f.name}, ${Math.round(done * 100)}% complete${necklinePips != null ? `, neckline ${necklinePips.toFixed(0)} pips away` : ''}.` });
  });
  return out;
}

/* THE FOUR ACTIONS. Cut is reserved for the structural case failing — not
   for discomfort, and not for a drawdown that is inside normal. */
function decideAction(ctx) {
  const { structureFailed, invalidated, broken, weakened, counter, inProfit } = ctx;
  const hardCounter = counter.some(c => c.kind === 'formation' && c.severity === 'broken');
  if (structureFailed || (invalidated && invalidated.brokenNow) || hardCounter) {
    return { key: 'cut', label: 'CUT', reason: structureFailed
      ? 'The structure the trade rested on has turned against it.'
      : hardCounter ? 'A formation pointing the other way has broken and held.'
      : 'The structural level the trade rested on has gone.' };
  }
  const liveCounter = counter.some(c => c.kind === 'pattern') || counter.some(c => c.severity === 'in_reach');
  if (broken.length || liveCounter) {
    return { key: 'partial', label: 'TAKE PARTIAL', reason: broken.length
      ? `${broken.length} of the reasons you entered on ${broken.length === 1 ? 'is' : 'are'} gone, but the structural case still holds.`
      : 'A live signal has fired against you while the structural case still holds.' };
  }
  if (weakened.length && inProfit) {
    return { key: 'be', label: 'MOVE TO BREAK-EVEN', reason: 'One reason has weakened and the trade is in profit.' };
  }
  if (weakened.length) {
    return { key: 'hold', label: 'HOLD', reason: 'One reason has weakened, but nothing has broken and the trade is not yet in profit to protect.' };
  }
  return { key: 'hold', label: 'HOLD', reason: 'Every reason you entered on is still standing.' };
}

function excursionRead(position, world) {
  const mfe = n(position.mfePips), mae = n(position.maePips), now = n(position.floatingPips);
  if (mfe == null && mae == null) return null;
  const giveback = (mfe != null && now != null && mfe > 0) ? (mfe - now) / mfe : null;
  return {
    mfePips: mfe, maePips: mae, nowPips: now,
    givebackShare: giveback,
    stopUsedShare: (mae != null && n(position.stopPips)) ? mae / n(position.stopPips) : null
  };
}

/* What would move this call, in both directions, as named levels. */
function transitionsFor({ world, position, want, action, invalidated }) {
  const out = [];
  const z = nearestZone(world, want);
  if (z && z.lo != null && z.hi != null) {
    const edge = want === 'bull' ? z.lo : z.hi;
    out.push({ toward: 'worse', text: `A close ${want === 'bull' ? 'below' : 'above'} ${fmt(edge, world.symbol)} breaks the zone the entry rested on.` });
    out.push({ toward: 'better', text: `A close back inside ${fmt(z.lo, world.symbol)} – ${fmt(z.hi, world.symbol)} restores it.` });
  }
  if (invalidated && invalidated.level != null && !invalidated.brokenNow)
    out.push({ toward: 'worse', text: `A ${world.higherTimeframe || 'higher timeframe'} close ${want === 'bull' ? 'below' : 'above'} ${fmt(invalidated.level, world.symbol)} is the structural failure — that is a cut.` });
  (world.formations || []).filter(f => patDir(f) !== want && n(f.completion) >= 0.5 && !f.broken).forEach(f => {
    out.push({ toward: 'worse', text: `${f.name}: its neckline breaking and holding would be a cut.` });
  });
  if (action.key !== 'hold')
    out.push({ toward: 'better', text: 'A fresh trigger in your direction at 70%+ moves this back toward hold.' });
  return out;
}

/* ═══════════════════════════════════════════════════════════════════
   HYSTERESIS — advice must not flicker. An action change must hold N
   cycles before it is shown. Escalating toward cut is faster (2) than
   relaxing back (3): being slow to warn is worse than being slow to calm.
   State is held by the caller, so the engine itself stays pure.
   ═══════════════════════════════════════════════════════════════════ */
const SEVERITY = { hold: 0, be: 1, partial: 2, cut: 3 };
function createStabiliser(opts = {}) {
  const up = opts.up || 2, down = opts.down || 3;
  const state = new Map();     // ticket -> {shown, candidate, count}
  return {
    settle(ticket, proposed) {
      const key = String(ticket);
      let s = state.get(key);
      if (!s) { s = { shown: proposed, candidate: proposed.key, count: 0 }; state.set(key, s); return { action: proposed, changed: true, held: 0 }; }
      if (proposed.key === s.shown.key) { s.candidate = proposed.key; s.count = 0; s.shown = proposed; return { action: s.shown, changed: false, held: 0 }; }
      if (proposed.key !== s.candidate) { s.candidate = proposed.key; s.count = 1; }
      else s.count++;
      const need = SEVERITY[proposed.key] > SEVERITY[s.shown.key] ? up : down;
      if (s.count >= need) { s.shown = proposed; s.count = 0; return { action: proposed, changed: true, held: 0 }; }
      return { action: s.shown, changed: false, held: s.count, pending: proposed.key, needs: need - s.count };
    },
    forget(ticket) { state.delete(String(ticket)); },
    size() { return state.size; }
  };
}

module.exports = {
  judgeSetup, judgePosition, freezeEntryCase, createStabiliser,
  CONDITIONS, GATES, GATE_CAP, GATE_CAPS, WEIGHTS, CORE, ADJUSTERS, ORDER, LABELS,
  PILLARS, EDGE_MIN_SAMPLE,
  _internals: { judge, score, applyGates, applyRadar, decideAction, counterSignals,
                patDir, patConf, patAge, pipSizeFor, nearestZone, opposingZone }
};
