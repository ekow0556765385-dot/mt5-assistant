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
/* NEWEST first; confidence only breaks a tie. Picking the highest confidence
   let an older 90% alert hide every newer one while it stayed inside its
   2-bar window — the Now tab showed a stale alert the Hunt tab had moved past. */
function newestFirst(a, b) { return (patAge(a) - patAge(b)) || (patConf(b) - patConf(a)); }
/* when an alert fired, in words — minutes, so no time zone can be wrong */
function firedText(p) {
  const m = p && p.minutesAgo != null ? Number(p.minutesAgo) : null;
  if (m == null) return '';
  return m < 1 ? ', fired just now' : m < 90 ? `, fired ${m} min ago` : `, fired ${Math.floor(m / 60)} h ${m % 60} min ago`;
}
function patAge(p) {
  const v = parseFloat((p && (p.barsAgo !== undefined ? p.barsAgo : p.bar_index)));
  return Number.isFinite(v) ? v : 99;
}
const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const dirOf = side => (String(side || '').toLowerCase().indexOf('sell') >= 0 ? 'bear' : 'bull');

/* PIP SIZE — one table, the same in the route, engine and feeds (a test holds
   them identical). Forex is recognised by BOTH halves being real currency codes;
   metals, the major indices, oil and gas by name. Anything else is UNKNOWN: the
   reports say "pips unknown" rather than invent a number — the old fallback gave
   every unrecognised symbol the forex pip (0.0001), so US30 read 1,500,000 pips. */
var PIP_CCY = ['USD','EUR','GBP','JPY','CHF','AUD','NZD','CAD','SEK','NOK','DKK','SGD','HKD','ZAR','MXN','TRY',
               'PLN','CZK','HUF','CNH','CNY','ILS','THB','RUB','INR','KRW'];
var PIP_NAMED = [
  [/^XAU/, 0.1], [/^XAG/, 0.01], [/^(XPT|XPD)/, 0.1],
  [/^(US30|DJ30|DJI|WS30|US100|NAS100|USTEC|NDX|US500|SPX500|SP500|US2000|GER40|GER30|DE40|DE30|DAX|UK100|FTSE|FRA40|CAC|JP225|JPN225|NIK|AUS200|HK50|HSI|EU50|STOXX|ESP35|IT40|SWI20)/, 1],
  [/^(USOIL|UKOIL|WTI|BRENT|XTI|XBR|OIL|CL)/, 0.01], [/^(NGAS|XNG|NATGAS)/, 0.001],
  [/^(BTC|ETH)/, 1]
];
function pipKnown(sym) {
  var s = String(sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (var i = 0; i < PIP_NAMED.length; i++) if (PIP_NAMED[i][0].test(s)) return PIP_NAMED[i][1];
  var a = s.slice(0, 3), b = s.slice(3, 6);
  if (PIP_CCY.indexOf(a) >= 0 && PIP_CCY.indexOf(b) >= 0) return b === 'JPY' ? 0.01 : 0.0001;
  return null;
}
function pipSizeFor(sym) { return pipKnown(sym) || 0.0001; }
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
/* Where a zone came from: the EA's SMC feed, or Arbiter's own read of the
   candles when nothing arrived for the pair. Always shown, never blurred. */
function zsrc(w) { return w && w.zoneSource === 'own' ? "Arbiter's own read from candles" : 'smc'; }

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
    /* PHASE F (H-2, H-3). TRANSITION is the structure engine's own state: "the two
       readings disagree — no confident call". It used to reach Arbiter as "range"
       (a mild warning). Now it is its own state, and lowers the setup by 15 (no cap). */
    const TRANS = 'Structure is changing; wait for the break or the failure.';
    const eng = w.structureEngine, engTrans = !!(eng && eng.regime === 'transition');
    // either the structure itself reads transition, or it has no direction while the
    // structure engine sees transition (the Combined Read can give no direction where the
    // engine sees the change of character — that must not fall through to a plain "range")
    if (regime === 'transition' || (!bull && !bear && engTrans))
      return res(WARN, `Structure is in transition — the readings disagree. ${TRANS}`, 'structure', { regime, transition: true });
    if (!bull && !bear) return res(WARN, `Structure is ${regime} — no trend to align with.`, 'structure', { regime });
    const aligned = (want === 'bull' && bull) || (want === 'bear' && bear);
    // H-1: clearly against still fails the gate — transition never softens that
    if (!aligned) return res(FAIL, `Structure is ${label} — the opposite way to this trade.`, 'structure', { regime });
    if (engTrans)
      return res(WARN, `Structure reads ${label}, but the structure engine sees it in transition. ${TRANS}`, 'structure',
        { regime, confidence: conf, transition: true });
    // A same-direction trend whose own confidence is low is a warn, not a pass.
    const c = conf != null ? (conf <= 1 ? conf : conf / 100) : null;
    if (c != null && c < 0.6) return res(WARN, `Structure is ${label} — agreeing, but weakly held.`, 'structure', { regime, confidence: c });
    return res(PASS, `Structure is ${label}.`, 'structure', { regime, confidence: c });
  },

  // 2 ── location: at a zone, or chasing mid-range
  location(w, want) {
    const z = nearestZone(w, want);
    // CORRECTED: zones are NOT one chart at a time. The EA's
    // SendMultiSymbolSMC() sends H1 and H4 zones for EVERY watch pair, the
    // bridge forwards mt5_smc_* files, and the server stores them per symbol.
    // So missing zones mean the data has not arrived — say that, and where
    // to look, rather than blame an indicator that does not exist.
    if (!w.zones) return res(UNKNOWN,
      `No SMC data for ${w.symbol} has reached the server yet. The EA sends zones for every watch pair — ` +
      `check ${w.symbol} is in the EA's WatchPairs and that the bridge is running.`, zsrc(w));
    if (!z) return res(FAIL, 'No zone in this direction — price is mid-range.', zsrc(w));
    const sym = w.symbol;
    const d = Math.abs(pips(w.price, z.inside ? w.price : z.edge, sym));
    if (z.inside) return res(PASS, `Price is inside the ${z.kindLabel} ${fmt(z.lo, sym)} – ${fmt(z.hi, sym)}.`, zsrc(w), { pipsAway: 0 });
    if (d <= (w.nearPips || 15)) return res(PASS, `${d.toFixed(0)} pips from the ${z.kindLabel} ${fmt(z.lo, sym)} – ${fmt(z.hi, sym)}.`, zsrc(w), { pipsAway: d });
    if (d <= (w.nearPips || 15) * 3) return res(WARN, `${d.toFixed(0)} pips from the nearest ${z.kindLabel} — not there yet.`, zsrc(w), { pipsAway: d });
    return res(FAIL, `Nearest ${z.kindLabel} is ${d.toFixed(0)} pips away. This would be chasing.`, zsrc(w), { pipsAway: d });
  },

  // 3 ── zone trust: age, touches, mitigation, strength normalised to the
  //      pair's own median zone height (never raw price height)
  zone_trust(w, want) {
    const z = nearestZone(w, want);
    if (!z) return res(UNKNOWN, w.zones
      ? 'Price is not at a zone, so there is no zone to judge.'
      : `No SMC data for ${w.symbol} has reached the server yet.`, zsrc(w));
    if (z.spent) return res(FAIL, 'That zone has already been closed through — it is spent.', zsrc(w), { spent: true });
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
    // BOTH pattern windows: the Pattern Detector's live tab AND the Assistant's
    // Pattern Alerts tab. Only the live tab was read, so a trigger that fired
    // as an alert was invisible here. Alerts are tagged so their source shows.
    const alerts = (w.alerts || []).map(a => Object.assign({}, a, { fromAlerts: true }));
    const feed = (w.patterns || []).concat(alerts);
    if (!w.patterns && !alerts.length) return res(UNKNOWN, 'No pattern feed.', 'patterns');
    const w2 = Object.assign({}, w, { patterns: feed });
    w = w2;
    const live = feed.filter(p => patAge(p) <= 2 && patDir(p) === want && patConf(p) >= (w.minTriggerConf || 70));
    if (live.length) {
      const best = live.sort(newestFirst)[0];
      return res(PASS, `${best.name || 'Pattern'} on ${best.timeframe || w.timeframe || ''} at ${patConf(best)}%, ${patAge(best)} bar${patAge(best) === 1 ? '' : 's'} ago${firedText(best)}.`,
        best.fromAlerts ? 'pattern alerts' : 'patterns',
        { name: best.name, confidence: patConf(best), barsAgo: patAge(best), fromAlerts: !!best.fromAlerts });
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
      if (!w.restingLiquidity) return res(UNKNOWN,
        'No sweep from the zone feed, and no equal highs or lows near price in the candles.', 'liquidity');
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
    return res(UNKNOWN, 'No live block to sweep.', zsrc(w));
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
    if (t == null) return res(UNKNOWN, 'No target to measure against.', zsrc(w));
    const sym = w.symbol;
    const toTarget = Math.abs(pips(t, w.price, sym));
    if (!opp) return res(PASS, `No opposing zone between price and ${fmt(t, sym)}.`, zsrc(w), { toTargetPips: toTarget });
    const toOpp = Math.abs(pips(opp.edge, w.price, sym));
    if (toOpp >= toTarget) return res(PASS, `Nearest opposing zone is ${toOpp.toFixed(0)} pips away, beyond the target.`, zsrc(w), { toTargetPips: toTarget, toOpposingPips: toOpp });
    const share = toOpp / toTarget;
    return res(share < 0.6 ? FAIL : WARN,
      `An opposing zone sits at ${fmt(opp.edge, sym)}, ${toOpp.toFixed(0)} pips away — ${Math.round(share * 100)}% of the way to the target.`,
      zsrc(w), { toTargetPips: toTarget, toOpposingPips: toOpp, share });
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
    // The liquidity function's own verdict, when Arbiter has one for this pair
    if (d && d.cls) {
      const txt = `${d.name ? d.name + ' — ' : ''}liquidity ${String(d.state || d.cls).toLowerCase()}` +
        (d.score != null ? ` (${d.score})` : '') + (d.plain ? `. ${d.plain}` : '.');
      if (d.cls === 'learn') return res(UNKNOWN, 'Liquidity is still learning what normal looks like for this hour.', 'liquidity');
      if (d.cls === 'healthy') return res(PASS, txt, 'liquidity', { cls: d.cls, score: d.score });
      if (d.cls === 'thin' || d.cls === 'drought') return res(FAIL, txt, 'liquidity', { cls: d.cls, score: d.score });
      return res(WARN, txt, 'liquidity', { cls: d.cls, score: d.score });       // being swept
    }
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
    // POINTS are what the broker and the Assistant report (12 pts); pips are
    // used only to work out the share of the intended move.
    const pts = n(w.spreadPoints), medPts = n(w.medianSpreadPoints);
    const s = n(w.spread), med = n(w.medianSpread);
    if (pts == null || medPts == null || medPts <= 0) return res(UNKNOWN, 'No spread baseline yet.', 'broker feed');
    const rel = pts / medPts;
    const t = n(w.target);
    const cost = (t != null && s != null) ? (s / Math.abs(pips(t, w.price, w.symbol))) : null;
    const metric = { points: pts, medianPoints: medPts, pips: s, relative: rel, shareOfMove: cost };
    const costBit = cost != null ? ` — ${Math.round(cost * 100)}% of the intended move paid on entry` : '';
    /* The EXECUTION half of "spread and execution", which was never judged:
       a normal spread is no comfort if the session is about to close or the
       book is thin — that is when fills slip and spreads jump. */
    const left = n(w.session && w.session.minutesLeft);
    const cls = w.session && w.session.cls;
    const exec = [];
    if (left != null && left <= 30) exec.push(`the ${w.session.name || 'session'} closes in ${Math.round(left)} minutes`);
    if (cls === 'thin' || cls === 'drought') exec.push('the book is thin');
    else if (cls === 'man') exec.push('liquidity is being swept');
    metric.minutesLeft = left; metric.liquidity = cls || null;
    const execBit = exec.length ? ` Execution: ${exec.join(', ')} — expect the spread to move against you on entry.` : '';

    if (rel <= 1.2 && !exec.length) return res(PASS, `Spread ${pts} points, normal for this session.`, 'broker feed', metric);
    if (rel <= 1.2) return res(WARN, `Spread ${pts} points, normal for now.${execBit}`, 'broker feed', metric);
    const wide = `Spread ${pts} points against a median of ${medPts} — ${Math.round((rel - 1) * 100)}% wide${costBit}.${execBit}`;
    return res(rel <= 1.8 ? WARN : FAIL, wide, 'broker feed', metric);
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
const TRANSITION_PENALTY = 15;     // DEC-3: structure in transition lowers a setup by 15, no cap
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
  // H-2: a structure in TRANSITION lowers the score by 15 — a deduction, not a cap (DEC-3),
  // after the gates and before the Risk Radar discount. Never on a failed structure gate (H-1).
  const st = results.structure, trans = !!(st && st.state !== FAIL && st.metric && st.metric.transition);
  const afterTrans = (trans && g.value != null) ? Math.max(0, g.value - TRANSITION_PENALTY) : g.value;
  const r = applyRadar(afterTrans, results.radar);
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
    transitionPenalty: (trans && g.value != null) ? g.value - afterTrans : 0,
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
  // While flat there is no take profit, so room-to-target and reachability
  // read "no target" — two of fourteen conditions permanently blank. Measure
  // against the same IMPLIED target the live state uses (the nearest opposing
  // zone, else 2x ATR) and say it is implied.
  let w = world;
  if (n(world.target) == null) {
    // while flat the reference point is the current price — there is no entry yet
    const t = targetFor(world, { openPrice: n(world.price) }, want);
    if (t) w = Object.assign({}, world, { target: t.price, impliedTarget: t });
  }
  const j = judge(w, want, opts);
  j.target = w.impliedTarget || (n(world.target) != null ? { price: n(world.target), implied: false } : null);
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

/* The weekly close: 17:00 New York — 21:00 UTC while New York is on daylight
   saving (second Sunday of March to first Sunday of November), 22:00 UTC otherwise.
   A fixed UTC hour would be wrong for half the year. */
function nyDST(d) {
  const y = d.getUTCFullYear();
  const nthSunday = (m, k) => { const f = new Date(Date.UTC(y, m, 1)); return 1 + ((7 - f.getUTCDay()) % 7) + 7 * (k - 1); };
  const start = Date.UTC(y, 2, nthSunday(2, 2), 7), end = Date.UTC(y, 10, nthSunday(10, 1), 6);   // 2am New York
  return d.getTime() >= start && d.getTime() < end;
}
function lastHourBeforeWeeklyClose(ms) {
  const d = new Date(ms); if (d.getUTCDay() !== 5) return false;            // Friday
  const close = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), nyDST(d) ? 21 : 22);
  return ms >= close - 3600000 && ms < close;
}

/* DEC-15 (CX-11): two positions are ONE market event when their pairs move
   together (|correlation| >= 0.8 on H1), they face that move the SAME way
   (positively correlated and the same direction, or negatively correlated and
   opposite directions), and both had their decisive level close through within
   ONE H1 candle of each other. Lots and stops do not decide it — the currency
   moving them does. Each position is still judged and cut on its own levels;
   this only explains it, and lets the ledger count Arbiter's accuracy once.
   items: [{ id, symbol, dir: 'bull'|'bear', breakT (s), risk }]; corr(a, b) -> r. */
function sameEvents(items, corr) {
  const out = {}, sec = t => (t > 1e12 ? t / 1000 : t);
  for (let i = 0; i < items.length; i++) for (let k = i + 1; k < items.length; k++) {
    const A = items[i], B = items[k];
    if (A.symbol === B.symbol || A.breakT == null || B.breakT == null) continue;
    if (Math.abs(sec(A.breakT) - sec(B.breakT)) > 3600) continue;
    const r = corr(A, B); if (r == null || Math.abs(r) < 0.8) continue;
    const sameFacing = (r > 0 && A.dir === B.dir) || (r < 0 && A.dir !== B.dir);
    if (!sameFacing) continue;                                   // a hedge: judged separately
    const a3 = [A.symbol.slice(0, 3), A.symbol.slice(3, 6)], b3 = [B.symbol.slice(0, 3), B.symbol.slice(3, 6)];
    const ccy = a3.filter(x => b3.indexOf(x) >= 0)[0] || null;
    const key = 'evt:' + [A.symbol, B.symbol].sort().join('+') + ':' + Math.min(sec(A.breakT), sec(B.breakT));
    const risk = (n(A.risk) || 0) + (n(B.risk) || 0);
    out[A.id] = { with: B.symbol, ccy, risk, key, r };
    out[B.id] = { with: A.symbol, ccy, risk, key, r };
  }
  return out;
}

/* ROUTE 3 — PROTECTION, for a trade in profit (P-1..P-7, DEC-4, DEC-7, S-15..17).
   "Given back" is measured from the BEST the trade reached (its MFE), so it scales
   to any winner. Evidence decides how STRONG the action is; the profit given back
   decides WHEN. TAKE PARTIAL needs one witness (gentle). MOVE TO BREAK-EVEN needs
   strong evidence: two independent witnesses, or one heavy one (a decisive close,
   the Combined Read confirming, a formation broken), because break-even can stop a
   good trade out on noise. High volatility (Risk Radar's `vol` factor: the bar
   1.8x+ its average) brings both steps in sooner. */
function ladderOf(world, position, rc) {
  const pip = pipSizeFor(world.symbol), atr = n(world.atr);
  const now = n(position.floatingPips), peak = n(position.mfePips);
  if (now == null || peak == null || now <= 0 || peak <= 0 || !atr) return null;           // P-7: in profit only
  const spreadPips = n(world.spreadPoints) != null ? n(world.spreadPoints) / 10 : 0;
  const minPips = Math.max(RW.LADDER_MIN_ATR * atr / pip, RW.LADDER_MIN_SPREADS * spreadPips);
  if (peak + 1e-9 < minPips) return { active: false, peak, now, minPips };                   // DEC-4
  const radar = world.radar || {};
  const hv = (radar.factors || []).some(f => f && (f.id === 'vol' || /volatil/i.test(f.name || f.label || '')));
  const W = (rc && rc.witnesses || []).filter(w => w.weight !== 'forming');                  // C-7: forming is not a witness
  const heavy = W.some(w => w.weight === 'heavy');
  const strong = (rc && rc.independent >= 2) || heavy;
  return { active: true, peak, now, given: 1 - now / peak, hv,
    partialAt: hv ? RW.LADDER_PARTIAL_HV : RW.LADDER_PARTIAL, beAt: hv ? RW.LADDER_BE_HV : RW.LADDER_BE,
    witnesses: W.length, strong, labels: W.map(w => w.label.toLowerCase()) };
}

/* DEC-20 — THE PROFIT FLOOR. A winner that was clearly working must not slide back
   to a loss unnoticed just because nothing Arbiter recognises flagged the turn.
   Price only — no witness. ADDED alongside the evidence-based break-even (DEC-7),
   never replacing it. "Clearly working" scales with the trader's take profit:
   the bar is max(2x ATR, a third of the way to the target), capped at two-thirds
   of the way so a tight target is still covered (the implied target when no TP).
   Once the best profit reached the bar, price back within 1/4 ATR of entry ->
   MOVE TO BREAK-EVEN. A gap straight through entry is the loss side's job. */
function profitFloor(world, position, target) {
  const pip = pipSizeFor(world.symbol), atr = n(world.atr), open = n(position.openPrice);
  const now = n(position.floatingPips), peak = n(position.mfePips);
  if (!atr || now == null || peak == null || now < 0) return null;                      // PF-5: never on a loser
  const atrPips = atr / pip;
  const tpPips = target && n(target.price) != null && open != null ? Math.abs(n(target.price) - open) / pip : null;
  let bar = RW.FLOOR_ATR * atrPips, why = 'twice the ATR';
  if (tpPips) {
    const third = RW.FLOOR_TP_SHARE * tpPips, cap = RW.FLOOR_TP_CAP * tpPips;
    const tpWord = target.implied ? 'the implied target' : 'your take profit';
    if (third > bar) { bar = third; why = 'a third of the way to ' + tpWord; }
    if (bar > cap) { bar = cap; why = 'two-thirds of the way to ' + tpWord + ' — a tight target'; }
  }
  const near = RW.FLOOR_NEAR_ATR * atrPips;
  return { bar, why, near, peak, now, tpPips, implied: !!(target && target.implied),
           reached: peak + 1e-9 >= bar, trigger: peak + 1e-9 >= bar && now <= near + 1e-9 };
}

/* R-1 / R-2: which ROUTE made each decision — on the card, and in the ledger. */
function routeOf(action, pressure) {
  if (!action) return null;
  if (pressure && pressure.route === 'damage') return 'damage';
  if (pressure && pressure.route === 'confirmation') return 'confirmation';
  if (/^protect_/.test(action.stage || '') && action.key !== 'hold') return 'protection';
  if (action.key === 'cut')
    return pressure && pressure.reversal && pressure.reversal.tier >= 2 ? 'confirmation' : 'pressure';
  if (action.key === 'partial') return 'milestone';
  return null;
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

  const target = targetFor(world, position, want);
  const now = n(position.floatingPips), mfe = n(position.mfePips);
  const toTarget = target && n(position.openPrice) != null ? Math.abs(pips(target.price, position.openPrice, world.symbol)) : null;
  const progress = toTarget ? (now != null ? now / toTarget : null) : null;
  const peakProgress = toTarget && mfe != null ? mfe / toTarget : null;
  const atrPips = n(world.atr) ? n(world.atr) / pipSizeFor(world.symbol) : null;
  const partialPips = MAJORS.indexOf(world.symbol) >= 0 ? STAGE.PARTIAL_PIPS_MAJOR
    : (atrPips ? STAGE.PARTIAL_ATR_X * atrPips : null);
  const pressure = pressureOf({ world, position, want, pillars, invalidated,
    conditions: live.conditions, target, progress });
  const losing = now != null ? now < 0 : (n(position.profit) || 0) < 0;
  const stopUsed = (now != null && now < 0 && n(position.stopPips)) ? Math.min(1, Math.abs(now) / n(position.stopPips)) : null;
  const ladder = losing ? null : ladderOf(world, position, pressure.reversal);
  const floor = losing ? null : profitFloor(world, position, target);
  const action = stageAction({ pressure, losing, progress, peakProgress, travelledPips: now,
    partialPips, partialTaken: !!position.partialTaken, target,
    stopUsed, pullback: world.pullbackExposure || null, ladder, floor });
  action.route = routeOf(action, pressure);
  /* NO DATA: no live price for this pair (the EA is not sending it) — so NO verdict. It used to say "HOLD —
     nothing is working against it beyond a normal pullback": an all-clear with no basis at all. A
     NO DATA action is never recorded as a call and never alerted (arbiter-group.js liveProposal). */
  if (n(world.price) == null) {
    const sym = String(world.symbol || position.symbol || 'this pair');
    Object.keys(action).forEach(k => { delete action[k]; });
    Object.assign(action, { key: 'hold', label: 'NO DATA', word: 'NO DATA', blind: true, pressure: null, route: null, stage: 'blind',
      factors: [], reason: `Arbiter cannot see ${sym}: the EA is not sending its prices, so this trade cannot be judged. Add ${sym} to the EA's watch pairs to have it judged.` });
  }
  // DEC-16 (CX-12): at a CUT, the spread now vs normal — it INFORMS, it never changes the decision
  const sp = n(world.spreadPoints), med = n(world.medianSpreadPoints);
  if (action.key === 'cut' && sp != null)
    action.spreadNote = `Spread is ${Math.round(sp)} points now` + (med != null ? `, normally ${Math.round(med)}.` : '.');
  // DEC-17 (CX-13): a reversal at Tier 2, not yet Tier 3, in the last hour before the weekly close
  const rv = pressure.reversal;
  if (rv && rv.tier === 2 && lastHourBeforeWeeklyClose(n(world.nowMs) || Date.now()))
    action.weekendNote = 'A reversal is developing into the weekend — a gap on Monday can skip straight past your stop.';

  return {
    ticket: position.ticket, symbol: world.symbol, direction: want,
    score: live.score, entryScore: position.entryCase ? position.entryCase.score : null,
    action, pressure, target, progress, peakProgress, partialPips,
    pillars, broken: broken.length, weakened: weakened.length,
    counterSignals: counter, invalidation: invalidated,
    excursion: excursionRead(position, world),
    conditions: live.conditions, missing: live.missing,
    transitions: transitionsFor({ world, position, want, action, invalidated }),
    // for the reasoning chart: the protection route's own numbers, so the chart
    // draws exactly what the engine decided on — never a recomputation
    ladder: ladder || null, floor: floor || null
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
   PRESSURE — how the live action is chosen (Assan's design)

   The action is not a flat word. Evidence against the trade adds up as
   PRESSURE, 0-100, like Risk Radar; the action comes from that number and
   from the STAGE of the trade, and is shown WITH its number, so "CUT · 82"
   and "CUT · 71" read differently. Individual live calls are therefore
   not graded right/wrong — Arbiter cannot know the future. The SCALE is
   graded instead: do trades held at high pressure end worse than trades
   held at low pressure? If not, these weights are wrong.

   Every number below is Assan's or was approved by him, except where
   marked PROVISIONAL — those move on evidence from his own trades.
   ═══════════════════════════════════════════════════════════════════ */
const P = {
  FORMING_AGAINST: 6,
  PILLAR_BROKEN: 12, PILLAR_BROKEN_MAX: 24,
  PILLAR_WEAK: 4, PILLAR_WEAK_MAX: 8,
  INVALIDATION_MAX: 12,                 // from 50% of the distance used
  PATTERN_MIN_CONF: 70, PATTERN_AT_MIN: 9, PATTERN_AT_90: 15,   // Assan: 90% contributes 15
  BOTH_SOURCES: 8,                      // Assan: +6 then +2
  FORMATION: { forming: 4, in_reach: 10, broken: 18 },
  RETRACEMENT_MAX: 8,
  OPPOSING_ZONE_MAX: 8, UNREACHABLE: 6,
  GIVEBACK_MAX: 10, GIVEBACK_FROM: 0.4,
  // Was 8: a trade at 95% of its stop scored ~23 pressure and stayed on HOLD
  // with "nothing beyond a normal pullback". Depth into the stop IS evidence.
  // From 50% used it now rises to 36 at the stop: about 7 at 60%, 18 at 75%,
  // 29 at 90% — so with the usual give-back it reaches CUT (45) by ~85-90%.
  STOP_USED_MAX: 36,                    // losing trades only
  PAST_PULLBACK: 10,                    // the pullback has run past this pair's usual depth
  STALLED: 4,
  RADAR: { elevated: 6, standdown: 10 },
  LIQUIDITY_THIN: 5, VOLATILITY: 5, VOLATILITY_X: 1.8,
  NEWS_SOON: 6, NEWS_LATER: 3, CORRELATION: 3
};
const STAGE = {
  LOSING_CUT: 45,             // PROVISIONAL — Assan: "it has to be accurate"; it moves on his data
  LOSING_WATCH: 25,
  STOP_DEEP_CUT: 0.75,        // a LOSER with 3/4 of its stop gone is CUT on stop depth alone (Assan: never HOLD it into the stop)
  CALM: 30,                   // below this, "all the factors still hold"
  WIN_CUT_BASE: 70, WIN_CUT_SPAN: 20,   // winner's cut bar = 70 + 20 x reward still left
  BE_REACHED: 0.60, BE_REVERSE: 0.10,   // reached 60% of the way, then gave back 10% of the path
  BE_PRESSURE: 20,            // PROVISIONAL. The reversal IS the signal (Assan's rule); pressure only
                              // confirms it is real. 30 (CALM) was too high: a trade back from 65% to
                              // 45% with an 85% opposing pattern scored 22 and was left on HOLD.
  NEAR_TARGET: 0.65,
  PARTIAL_PIPS_MAJOR: 20,     // Assan: 20-25 pips; the territory starts at 20
  PARTIAL_ATR_X: 1.7,         // non-majors: the same significance, scaled by the pair's own ATR
  IMPLIED_TARGET_ATR: 2
};
const MAJORS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'NZDUSD', 'USDCAD'];

function patternPoints(conf) {
  if (conf < P.PATTERN_MIN_CONF) return 0;
  const k = Math.min(1, (conf - P.PATTERN_MIN_CONF) / (90 - P.PATTERN_MIN_CONF));
  return Math.round(P.PATTERN_AT_MIN + k * (P.PATTERN_AT_90 - P.PATTERN_AT_MIN));
}

/* The target the whole live model measures against. The trader's own TP
   when set; otherwise an IMPLIED one — the nearest opposing zone ahead, or
   2x ATR — and it is always labelled as implied. */
function targetFor(world, position, want) {
  const tp = n(position.tp);
  if (tp) return { price: tp, implied: false, why: 'your take profit' };
  const opp = opposingZone(Object.assign({}, world, { target: null }), want);
  if (opp) return { price: opp.edge, implied: true, why: 'implied — the nearest opposing zone, because no take profit is set' };
  const atr = n(world.atr), open = n(position.openPrice);
  if (atr && open) return { price: want === 'bull' ? open + STAGE.IMPLIED_TARGET_ATR * atr : open - STAGE.IMPLIED_TARGET_ATR * atr,
                            implied: true, why: 'implied — 2x ATR from entry, because no take profit is set' };
  return null;
}

/* ═══ THE REVERSAL CASE — Route 1, Confirmation (Phase C) ═══════════════
   A reversal must be WITNESSED, not declared (reversal-rules-v2 + DEC-8..18).
   No single reading forces CUT 100 any more. Witnesses, three tiers, and the
   ONLY override: the decisive level CLOSED through on H1, with 2 bars' worth of
   conviction (or a retest, or a grind), AND the Combined Read confirming or a
   formation having broken its trigger — unless H4 is still intact (DEC-12). */
const REV = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
  ? require('./arbiter-reversal.js') : (typeof window !== 'undefined' ? window.BWReversal : null);
const RW = {
  HEAVY: 25, MEDIUM: 15, LOW: 8, FORMING: 5,     // DEC-11
  LOSER_FLOOR: 45,                               // DEC-11: two independent witnesses on a loser
  FAILED_BREAK: 10, FAILED_BARS: 6,              // DEC-13
  H4_EXPIRY_ATR: 1,                              // DEC-12
  APPROACH_ATR: 1,                               // a formation "approaching" = neckline within 1x ATR
  SAME_LEVEL_ATR: 0.25,                          // DEC-10: the same level, within 1/4 ATR
  DAMAGE_ATR: 1,                                 // DEC-5: Route 2 — 1x ATR beyond the decisive level
  // ROUTE 3 — protection (P-1..P-7, DEC-4, DEC-7)
  LADDER_PARTIAL: 0.50, LADDER_BE: 0.75,         // of the BEST profit given back
  LADDER_PARTIAL_HV: 0.40, LADDER_BE_HV: 0.60,   // sooner when Risk Radar reads high volatility
  LADDER_MIN_ATR: 1, LADDER_MIN_SPREADS: 3,      // DEC-4: only once >= 1x ATR AND >= 3x spread in profit
  // DEC-20 — the profit floor (price only, added alongside DEC-7)
  FLOOR_ATR: 2, FLOOR_TP_SHARE: 1 / 3, FLOOR_TP_CAP: 2 / 3, FLOOR_NEAR_ATR: 0.25
};
function reversalCase(world, position, want) {
  const dir = want === 'bull' ? 1 : -1, against = want === 'bull' ? 'bear' : 'bull';
  const atr = n(world.atr), pip = pipSizeFor(world.symbol), level = n(world.invalidationLevel);
  const W = [], forTrade = [];
  const add = (id, label, weight, points, detail, key) => W.push({ id, label, weight, points, detail, key: key || id });

  // C-1 the decisive level, on CLOSED H1 bars only (DEC-8, CX-3)
  let brk = null;
  if (REV && level != null && atr && (world.candles || []).length > 3) {
    const cd = world.candles, openT = n(position.openTime);
    let from = 1; if (openT) { const k = cd.findIndex(b => (b.t > 1e12 ? b.t / 1000 : b.t) >= openT); from = k > 0 ? k : 1; }
    const now = Date.now() / 1000;
    const news = (world.news || []).filter(e => e.minutesAway != null).map(e => ({ title: e.title, impact: e.impact,
      currency: e.country || e.currency, timestamp: now + e.minutesAway * 60 }));
    const ses = world.session || {};
    brk = REV.trackBreak(cd, { level, dir, atr, tfMin: 60, sym: world.symbol, news, from,
      liq: ses.cls || null, spread: n(world.spreadPrice) || 0, lastIsForming: true });
    if (brk.breakAt != null) {
      const conv = brk.total, full = conv >= 2 || !!brk.retest || brk.grind.met;
      add('decisive', 'Decisive level closed through', 'heavy', RW.HEAVY,
        `${fmt(level, world.symbol)} closed through on H1 — breaking bar ${brk.breakTag.regraded
          ? 'huge, re-graded from 0.5 to 1.0 when the next bar held (displacement, not a trap)'
          : brk.breakTag.kind + ' ' + brk.breakTag.weight}, ` +
        `conviction ${conv.toFixed(2)} of 2${brk.retest ? ', retest held' : ''}${brk.grind.met ? ', grind confirmed' : ''}.`, 'level');
      brk.full = full;
    }
    const lastBar = cd.length - 2;                                       // last CLOSED bar
    const fk = (brk.fakeouts || []).filter(f => lastBar - f.i < RW.FAILED_BARS).pop();
    if (fk) forTrade.push({ id: 'failed_break', bar: fk.i, tag: fk.tag,
      text: 'A break against this trade failed — that counts for it.' });
  }

  // C-2 the Combined Read's reversal block (DEC-9), against the trade only
  const cr = world.combinedRead && world.combinedRead.read, rv = cr && cr.reversal;
  if (rv && rv.to) {
    const toDir = /down|bear|short/i.test(rv.to) ? 'bear' : /up|bull|long/i.test(rv.to) ? 'bull' : null;
    if (toDir === against) {
      const sameLevel = level != null && atr && n(rv.level) != null && Math.abs(n(rv.level) - level) <= RW.SAME_LEVEL_ATR * atr;
      if (rv.stage === 'established' || rv.stage === 'extending')
        add('combined', 'Combined Read: reversal ' + rv.stage, 'heavy', RW.HEAVY,
          `The Combined Read says the reversal has ${rv.stage === 'established' ? 'become a real trend' : 'travelled beyond the level'}.`, 'combined');
      else if (rv.stage === 'stalled')
        // DEC-10: while stalled, the same break as the decisive level is ONE event
        add('combined', 'Combined Read: reversal developing (stalled)', 'medium', RW.MEDIUM,
          'The Combined Read sees a reversal that has stalled.', sameLevel && brk && brk.breakAt != null ? 'level' : 'combined');
      else if (rv.stage === 'failed' || rv.stage === 'givenback')
        forTrade.push({ id: 'failed_break', text: 'A break against this trade failed — that counts for it.', from: 'combined' });
    }
  }

  // C-3 / C-4 formations against the trade
  (world.formations || []).filter(x => patDir(x) === against).forEach(x => {
    if (x.state === 'breaking' || x.state === 'confirmed' || x.broken)
      add('formation', 'Formation broke its trigger', 'heavy', RW.HEAVY, `${x.name}: neckline broken.`, 'formation');
    else if (n(x.completion) >= 0.5 && n(x.necklinePips) != null && atr && n(x.necklinePips) <= RW.APPROACH_ATR * atr / pip)
      add('formation', 'Formation approaching its trigger', 'medium', RW.MEDIUM,
        `${x.name}: ${Math.round(n(x.necklinePips))} pips from its neckline.`, 'formation');
  });

  // C-5 the structure label — a judgement that can flip back (medium)
  const reg = world.structure && world.structure.regime;
  if ((want === 'bull' && reg === 'downtrend') || (want === 'bear' && reg === 'uptrend'))
    add('label', 'Structure label turned', 'medium', RW.MEDIUM, `Structure now reads ${reg}.`, 'label');

  // C-6 closed reversal candles (one witness, whichever source) · C-7 forming (pressure only)
  /* The SAME rule as the Hunt tab's trigger: patterns and alerts MERGED, newest first, within 2 candles,
     at the same minimum confidence. It used to take the detector's patterns FIRST (an older one beat a
     newer alert) and accept any confidence — so the Now tab judged patterns differently from Hunt. */
  const minC = world.minTriggerConf || 70;
  const best = list => (list || []).filter(p => patDir(p) === against && patAge(p) <= 2 && patConf(p) >= minC).sort(newestFirst)[0] || null;
  const closed = best((world.patterns || []).concat((world.alerts || []).map(a => Object.assign({}, a, { fromAlerts: true }))));
  if (closed) add('candle', 'Reversal candle', 'low', RW.LOW, `${closed.name}${closed.timeframe ? ' on ' + closed.timeframe : ''} at ${patConf(closed)}%, ${patAge(closed)} bar(s) ago${firedText(closed)}.`, 'candle');
  const forming = best(world.forming);
  if (forming) add('forming', 'Reversal forming on this candle', 'forming', RW.FORMING,
    `${forming.name} at ${patConf(forming)}% — this candle has not closed, so it may not finish this way.`, 'forming');

  // C-8 retracement: shown, weight 0
  const rs = world.retracement && n(world.retracement.score);
  const shown = rs != null ? { id: 'retracement', label: 'Retracement engine', points: 0,
    detail: `Score ${rs} (${world.retracement.verdict || ''}) — shown, not counted until it is fixed.` } : null;

  /* ROUTE 2 — DAMAGE (DEC-5, M-1, M-3). "It does not matter why — it is costing
     too much." Price 1x ATR beyond the decisive level, against the trade, on the
     LIVE price: the route exists so a run-away move is not waited on. One spike
     tick cannot cut on its own — the stabiliser makes a CUT hold 40 s first.
     It needs no confirmation and is never affected by H4 (DEC-12). */
  let damage = null;
  if (level != null && atr && n(world.price) != null) {
    const past = dir > 0 ? level - world.price : world.price - level;
    // a hundredth of a pip of tolerance: 1.0850 - 1.0838 is 0.00119999... in floating point,
    // and "exactly on the damage line" must count as on it
    if (past + pip * 0.01 >= RW.DAMAGE_ATR * atr)
      damage = { pips: past / pip, atrs: past / atr, level,
        text: `Price is ${(past / pip).toFixed(0)} pips beyond the decisive level ${fmt(level, world.symbol)} — ` +
              `${(past / atr).toFixed(1)}x ATR. Whatever caused it, waiting would cost too much.` };
  }

  // DEC-12 H4 intact: all three, or it does not hold anything back
  const s4 = world.structureH4, atr4 = n(world.atrH4);
  let h4 = { intact: false, why: 'H4 cannot be read.' };
  if (s4 && s4.regime && atr4) {
    const agrees = (want === 'bull' && s4.regime === 'uptrend') || (want === 'bear' && s4.regime === 'downtrend');
    const d4 = n(s4.decisive && s4.decisive.price != null ? s4.decisive.price : s4.decisive);
    const c4 = (world.candlesH4 || []).slice(0, -1);                      // CLOSED H4 bars only
    // only H4 bars that CLOSED after the H4 decisive pivot formed
    const sec = t => (t > 1e12 ? t / 1000 : t), pivT = n(s4.decisiveAt) != null ? sec(n(s4.decisiveAt)) : null;
    const closedThrough = d4 != null && c4.some(b => (pivT == null || sec(b.t) > pivT) && (dir > 0 ? b.c < d4 : b.c > d4));
    const travelled = level != null && n(world.price) != null ? Math.max(0, dir > 0 ? level - world.price : world.price - level) : 0;
    const expired = travelled + pip * 0.01 >= RW.H4_EXPIRY_ATR * atr4;   // same floating-point tolerance as damage
    h4 = { intact: agrees && !closedThrough && !expired,
      why: !agrees ? 'H4 structure does not agree with the trade.' : closedThrough ? 'An H4 candle closed through the H4 decisive level.'
         : expired ? `Price has travelled ${(travelled / pip).toFixed(0)} pips against — over 1x H4 ATR — so H4 no longer holds anything back.`
         : 'H4 still agrees with the trade.' };
  }
  if (h4.intact) W.forEach(w => { w.points = w.points / 2; w.halved = true; });     // DEC-12: each H1 witness counts half

  // independence (DEC-10): one per key; forming adds pressure but is not a witness
  const keys = [...new Set(W.filter(w => w.weight !== 'forming').map(w => w.key))];
  const independent = keys.length;
  const second = W.some(w => w.id === 'combined' && w.weight === 'heavy') || W.some(w => w.id === 'formation' && w.weight === 'heavy');
  const confirmedH1 = !!(brk && brk.breakAt != null && brk.full && second);
  const heldByH4 = confirmedH1 && h4.intact;
  const tier = confirmedH1 && !heldByH4 ? 3 : independent >= 2 ? 2 : independent === 1 ? 1 : 0;
  return { witnesses: W, shown, forTrade, independent, tier, confirmed: tier === 3, heldByH4, h4, breakCase: brk, damage };
}

function pressureOf(ctx) {
  const { world, position, want, pillars, invalidated, conditions, target, progress } = ctx;
  const f = [];
  const add = (id, label, points, detail) => { if (points > 0) f.push({ id, label, points: Math.round(points), detail }); };
  const cond = id => conditions.find(c => c.id === id) || {};

  /* DEC-8: no single reading forces CUT 100 any more. The structure label
     flipping, and price crossing the decisive level (which was judged on the
     LIVE price, so one wick mid-hour forced a cut), are both WITNESSES now.
     Only a confirmed reversal — Tier 3 — overrides. */
  const rc = reversalCase(world, position, want);

  // the structure pillar is the structure-label WITNESS now (DEC-11) — not counted twice
  const broken = pillars.filter(p => p.change === 'broken' && p.id !== 'structure');
  const weak = pillars.filter(p => p.change === 'weakened' && p.id !== 'structure');
  add('pillars_broken', 'Reasons you entered on are gone', Math.min(P.PILLAR_BROKEN_MAX, broken.length * P.PILLAR_BROKEN),
      broken.map(p => p.label).join(', '));
  add('pillars_weak', 'Reasons you entered on have weakened', Math.min(P.PILLAR_WEAK_MAX, weak.length * P.PILLAR_WEAK),
      weak.map(p => p.label).join(', '));

  if (invalidated && invalidated.level != null && n(position.openPrice) != null) {
    const whole = Math.abs(pips(position.openPrice, invalidated.level, world.symbol));
    const used = whole > 0 ? 1 - invalidated.pipsAway / whole : 0;
    if (used > 0.5) add('invalidation', 'Close to the structural level', ((used - 0.5) / 0.5) * P.INVALIDATION_MAX,
      `${Math.round(used * 100)}% of the distance to ${fmt(invalidated.level, world.symbol)} used.`);
  }

  // opposing reversal patterns, from EACH source, and more when both agree
  const against = want === 'bull' ? 'bear' : 'bull';
  /* The reversal WITNESSES (DEC-11) replace the old opposing-pattern,
     both-sources, forming, formation and retracement scores, so nothing is
     counted twice. Retracement is shown with 0 weight until it is fixed. */
  rc.witnesses.forEach(w => add('w_' + w.id, w.label + (w.halved ? ' (H4 intact — half)' : ''), w.points, w.detail));

  if (target && n(world.price) != null) {
    const opp = opposingZone(Object.assign({}, world, { target: target.price }), want);
    const toT = Math.abs(pips(target.price, world.price, world.symbol));
    if (opp && toT > 0) {
      const share = Math.abs(pips(opp.edge, world.price, world.symbol)) / toT;
      add('opposing_zone', 'Opposing zone before the target', (1 - Math.min(1, share)) * P.OPPOSING_ZONE_MAX,
        `${opp.kindLabel} at ${fmt(opp.edge, world.symbol)} sits ${Math.round(share * 100)}% of the way to the target.`);
    }
    const atr = n(world.atr), left = n(world.sessionMinutesLeft);
    if (atr && toT > 1.2 * (atr / pipSizeFor(world.symbol)) * Math.max(1, (left || 60) / 60) * 0.5)
      add('reach', 'Target out of reach this session', P.UNREACHABLE,
        `${toT.toFixed(0)} pips left against what this pair usually travels in the time remaining.`);
  }

  const mfe = n(position.mfePips), now = n(position.floatingPips);
  if (mfe != null && mfe > 0 && now != null) {
    const g = (mfe - now) / mfe;
    if (g > P.GIVEBACK_FROM) add('giveback', 'Given back from its best', Math.min(1, (g - P.GIVEBACK_FROM) / (1 - P.GIVEBACK_FROM)) * P.GIVEBACK_MAX,
      `${Math.round(g * 100)}% of the best (+${mfe.toFixed(1)}) handed back.`);
  }
  const stopPips = n(position.stopPips);
  if (now != null && now < 0 && stopPips) {
    const used = Math.min(1, Math.abs(now) / stopPips);
    if (used > 0.5) add('stop_used', 'Deep into the stop', ((used - 0.5) / 0.5) * P.STOP_USED_MAX,
      `${Math.round(used * 100)}% of the stop distance used.`);
    // 2. "beyond a normal pullback" — MEASURED by the retracement engine: this
    //    pullback has already run further than pullbacks on this pair usually do
    const ex = world.pullbackExposure;
    if (ex && ex.spent) add('past_pullback', 'Past a normal pullback', P.PAST_PULLBACK,
      'This pullback has already run further than pullbacks on this pair usually go.');
  }
  const age = n(position.ageMinutes), avgWin = n(world.avgWinMinutes);
  if (age && avgWin && age > avgWin * 2) add('stalled', 'Stalled against your average winner', P.STALLED,
    `${Math.round(age / 60)}h open; your winners average ${Math.round(avgWin / 60 * 10) / 10}h.`);

  const radar = world.radar && n(world.radar.score);
  if (radar != null && radar >= 50) add('radar', 'Risk Radar', radar >= 75 ? P.RADAR.standdown : P.RADAR.elevated,
    `${world.radar.stateName || ''} (${radar}).`.trim());
  const ses = world.session || {};
  if (ses.cls === 'thin' || ses.cls === 'drought')
    add('liquidity', 'Liquidity ' + (ses.cls === 'drought' ? 'drought' : 'thin'), P.LIQUIDITY_THIN, ses.plain || String(ses.state || ''));
  else if (!ses.cls) {
    const depth = n(ses.depth);
    if (depth != null && depth < 0.4) add('liquidity', 'Liquidity thin', P.LIQUIDITY_THIN, `${Math.round(depth * 100)}% of the day's deepest.`);
  }
  const rx = n(world.rangeAtr);
  if (rx != null && rx > P.VOLATILITY_X) add('volatility', 'Volatility expanding', P.VOLATILITY, `Current bar is ${rx.toFixed(1)}x ATR.`);
  const news = (world.news || []).filter(e => e.impact === 'high' && n(e.minutesAway) != null && n(e.minutesAway) >= 0)
    .sort((a, b) => n(a.minutesAway) - n(b.minutesAway))[0];
  if (news) {
    const m = n(news.minutesAway), life = n(world.expectedMinutes) || 240;
    if (m <= 60) add('news', 'High-impact news', P.NEWS_SOON, `${news.title} in ${Math.round(m)} min.`);
    else if (m <= life) add('news', 'High-impact news', P.NEWS_LATER, `${news.title} in ${(m / 60).toFixed(1)}h, inside the trade's life.`);
  }
  if (cond('correlation').state === FAIL || cond('correlation').state === WARN)
    add('correlation', 'Doubled through another position', P.CORRELATION, cond('correlation').detail);

  f.sort((a, b) => b.points - a.points);
  // DEC-13: a failed break against the trade counts FOR it — 10 off, for 6 H1 bars
  const failed = rc.forTrade.find(x => x.id === 'failed_break');
  let score = f.reduce((a, x) => a + x.points, 0);
  if (failed) { score -= RW.FAILED_BREAK;
    f.push({ id: 'failed_break', label: 'A failed break', points: -RW.FAILED_BREAK, detail: failed.text }); }
  score = Math.max(0, Math.min(100, score));
  const losingNow = n(position.floatingPips) != null ? n(position.floatingPips) < 0 : (n(position.profit) || 0) < 0;
  // ROUTE 2 — damage: CUT without waiting for confirmation, winners included
  if (rc.damage) {
    f.push({ id: 'damage', label: 'Damage — 1x ATR beyond the level', points: 0, detail: rc.damage.text });
    return { score: 100, override: rc.damage.text, route: 'damage', factors: f, reversal: rc };
  }
  // Tier 3 — the ONLY confirmation override (T-3, T-4: winners too)
  if (rc.tier === 3)
    return { score: 100, override: 'A confirmed reversal: the decisive level closed through with two bars\' worth of conviction, ' +
      'and ' + (rc.witnesses.some(w => w.id === 'combined' && w.weight === 'heavy') ? 'the Combined Read confirms it.' : 'a formation has broken its trigger.'),
      factors: f, reversal: rc, route: 'confirmation' };
  /* Tier 2 is ALWAYS named on the card (G-1) — the trader must be told a reversal
     has been witnessed even when the witnesses already carried the pressure past 45.
     It only ADDS points to lift a LOSING trade to the 45 floor (DEC-11). */
  if (rc.tier >= 2) {
    const lift = (losingNow && score < RW.LOSER_FLOOR) ? RW.LOSER_FLOOR - score : 0;
    f.push({ id: 'tier2_floor', label: 'Two independent witnesses', points: lift,
      detail: rc.witnesses.filter(w => w.weight !== 'forming').map(w => w.label).join(' + ') + ' — a reversal is developing.' });
    score += lift;
  }
  return { score, override: null, factors: f, reversal: rc };
}

/* Assan's stages. The action follows the LIFE of the trade; pressure
   decides between them. HOLD is the default at every stage, and gives way
   only when the things that turn a winner into a loser start appearing. */
function stageAction(ctx) {
  const { pressure, losing, progress, peakProgress, travelledPips, partialPips, partialTaken, target, stopUsed, pullback, ladder, floor } = ctx;
  const p = pressure.score;
  const top = pressure.factors.slice(0, 3).map(x => x.label.toLowerCase()).join(', ');
  const tag = (key, label, reason, stage) => ({ key, label, pressure: p, reason, stage, top: pressure.factors.slice(0, 3) });

  if (pressure.override) return tag('cut', 'CUT', pressure.override, 'structural');

  if (losing) {
    if (p >= STAGE.LOSING_CUT) return tag('cut', 'CUT', `The trade is losing and the evidence against it has stacked up — ${top}. Cutting a loser short is cheaper than hoping.`, 'losing');
    /* DEEP IN THE STOP: three-quarters of the stop gone on a loser is CUT, whatever else is (not) seen.
       It used to be "watch it" until pressure from stop depth alone reached the cut line at about 90% —
       too late to save anything — and a HOLD there reads as if Arbiter expected a recovery. */
    if (stopUsed != null && stopUsed >= STAGE.STOP_DEEP_CUT)
      return tag('cut', 'CUT', `Losing, ${Math.round(stopUsed * 100)}% of the stop already used. The market has mostly disproved this trade, and nothing on the chart says it is turning back — cut it here rather than give up the last of the stop.`, 'losing_deep');
    if (p >= STAGE.LOSING_WATCH) return tag('hold', 'HOLD', `Losing, and pressure is building — ${top}. Not enough to cut yet; watch it. This is not a forecast that it comes back — your stop is the limit.`, 'losing_watch');
    // Never call it "a normal pullback" unless that was actually measured.
    // Past half the stop, say how deep it is and what is (not) known.
    if (stopUsed != null && stopUsed >= 0.5) {
      const pct = Math.round(stopUsed * 100);
      if (pullback && pullback.zone !== 'unknown' && !pullback.spent)
        return tag('hold', 'HOLD', `Losing, ${pct}% of the stop used — still within how far pullbacks on this pair usually run, and nothing else is against it. This is not a forecast that it comes back — your stop is the limit.`, 'losing');
      return tag('hold', 'HOLD', `Losing, ${pct}% of the stop used. Nothing else is against it yet, but this is deep — watch it. This is not a forecast that it comes back — your stop is the limit.`, 'losing_watch');
    }
    return tag('hold', 'HOLD', 'Losing, but nothing is working against it beyond a normal pullback. This is not a forecast that it comes back — your stop is the limit.', 'losing');
  }

  const left = progress == null ? 1 : Math.max(0, Math.min(1, 1 - progress));
  const cutBar = STAGE.WIN_CUT_BASE + STAGE.WIN_CUT_SPAN * left;
  if (p >= cutBar) return tag('cut', 'CUT', `In profit, but the case against it (${top}) now outweighs the ${Math.round(left * 100)}% of the move still left to the target.`, 'winning');

  /* ROUTE 3 — the protection ladder. It REPLACES the older break-even rule (reached
     60% of the way to target, came back 10%, pressure 20+), which moved to
     break-even without strong reversal evidence — what DEC-7 rules out. */
  const rv = pressure.reversal;
  if (ladder && ladder.active) {
    const pct = Math.round(ladder.given * 100), from = `+${ladder.peak.toFixed(1)} → +${ladder.now.toFixed(1)}`;
    const hvNote = ladder.hv ? ' Volatility is high, so the steps come in sooner.' : '';
    // S-11: H4 held a confirmed H1 reversal back — protect rather than cut
    if (rv && rv.heldByH4)
      return partialTaken
        ? tag('be', 'MOVE TO BREAK-EVEN', `The reversal is confirmed on H1 but H4 still agrees with the trade — so not a cut. The partial is banked; move the stop to entry to protect the rest.`, 'protect_be')
        : tag('partial', 'TAKE PARTIAL', `The reversal is confirmed on H1 but H4 still agrees with the trade — so not a cut. Bank part of it while it is still there.`, 'protect_partial');
    if (ladder.given >= ladder.beAt && ladder.strong)
      return tag('be', 'MOVE TO BREAK-EVEN', `${pct}% of the best profit is gone (${from}), and the evidence is strong — ${ladder.labels.join(', ')}. ` +
        (partialTaken ? 'The partial is banked; move the stop to entry to protect the rest.' : 'Move the stop to entry so this winner cannot become a loser.') + hvNote, 'protect_be');
    if (ladder.given >= ladder.partialAt && ladder.witnesses >= 1 && !partialTaken)
      return tag('partial', 'TAKE PARTIAL', `It has given back ${pct}% of its best (${from}), and ${ladder.labels.join(', ')}. Bank part of it while it is still there.` + hvNote, 'protect_partial');
    if (ladder.given >= ladder.beAt && !ladder.strong && ladder.witnesses >= 1 && !(floor && floor.trigger))
      return tag('hold', 'HOLD', `${pct}% of the best profit is gone, but the only sign is ${ladder.labels.join(', ')} — not enough to move to break-even.`, 'protect_watch');
  }
  // DEC-20: the price-only floor — when the evidence never said break-even, price still can
  if (floor && floor.trigger)
    return tag('be', 'MOVE TO BREAK-EVEN', `It was up ${floor.peak.toFixed(1)} pips and is now back to ${floor.now.toFixed(1)} — ` +
      `within a few pips of entry. Nothing Arbiter recognises flagged this turn, but it cleared this trade's ` +
      `${floor.bar.toFixed(0)}-pip bar (${floor.why}), and a winner like that must not become a loser. ` +
      `Move the stop to entry.` + (partialTaken ? ' The partial is banked; this protects the rest.' : ''), 'protect_floor');

  if (progress != null && progress >= STAGE.NEAR_TARGET && p < STAGE.CALM)
    return tag('hold', 'HOLD', `${Math.round(progress * 100)}% of the way to the target with everything still holding. Nearly there — do not close early.`, 'near_target');

  if (!partialTaken && travelledPips != null && partialPips != null && travelledPips >= partialPips && p < STAGE.CALM)
    return tag('partial', 'TAKE PARTIAL', `Up ${travelledPips.toFixed(1)} pips with everything still holding. A good place to bank part of it.`, 'partial');

  return tag('hold', 'HOLD', p < STAGE.CALM ? 'Everything you entered on is still holding.' : `In profit, with some pressure building — ${top}.`, 'winning');
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
      if (!s) { s = { shown: proposed, candidate: proposed.key, count: 0, recent: [proposed.key] }; state.set(key, s); return { action: proposed, changed: true, held: 0 }; }
      s.recent = (s.recent || []).concat(proposed.key).slice(-3);
      /* ESCALATION on 2 of the LAST 3 cycles. It used to need 2 IN A ROW, and any cycle proposing the shown
         action reset the count — so pressure hovering around the cut line (46, 44, 46, 44…) proposed CUT,
         HOLD, CUT, HOLD and the CUT was NEVER shown while the trade slid to its stop. A single spike still
         is not enough (1 of 3); a CUT proposed on 2 of the last 3 cycles is shown. */
      if (SEVERITY[proposed.key] < SEVERITY[s.shown.key] || proposed.key === s.shown.key) {
        const worse = Object.keys(SEVERITY).filter(k => SEVERITY[k] > SEVERITY[s.shown.key] && s.recent.filter(x => x === k).length >= up)
          .sort((a, b) => SEVERITY[b] - SEVERITY[a])[0];
        if (worse && s.lastWorse && s.lastWorse.key === worse) { s.shown = s.lastWorse; s.count = 0; s.candidate = worse; return { action: s.shown, changed: true, held: 0 }; }
      }
      if (SEVERITY[proposed.key] > SEVERITY[s.shown.key]) s.lastWorse = proposed;
      if (proposed.key === s.shown.key) { s.candidate = proposed.key; s.count = 0; s.shown = proposed; return { action: s.shown, changed: false, held: 0 }; }
      if (proposed.key !== s.candidate) { s.candidate = proposed.key; s.count = 1; }
      else s.count++;
      const worseNow = SEVERITY[proposed.key] > SEVERITY[s.shown.key];
      const need = worseNow ? up : down;
      if (s.count >= need || (worseNow && s.recent.filter(x => x === proposed.key).length >= up)) { s.shown = proposed; s.count = 0; return { action: proposed, changed: true, held: 0 }; }
      return { action: s.shown, changed: false, held: s.count, pending: proposed.key, needs: need - s.count };
    },
    forget(ticket) { state.delete(String(ticket)); },
    size() { return state.size; }
  };
}

/* Browser AND server from one file: the page loads it with a <script> tag,
   the server requires it. No build step, same code both sides. */
const API = {
  judgeSetup, judgePosition, freezeEntryCase, createStabiliser, P, STAGE, RW, MAJORS, lastHourBeforeWeeklyClose, nyDST, sameEvents, routeOf,
  pipSizeFor,   // public: the grouping (arbiter-group.js) sizes a BOOK's pips with it — never 0.0001 by default
  CONDITIONS, GATES, GATE_CAP, GATE_CAPS, WEIGHTS, CORE, ADJUSTERS, ORDER, LABELS,
  PILLARS, EDGE_MIN_SAMPLE,
  _internals: { judge, score, applyGates, applyRadar, decideAction, counterSignals,
                pressureOf, stageAction, targetFor, patternPoints,
                patDir, patConf, patAge, pipSizeFor, nearestZone, opposingZone }
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.BWArbiterEngine = API;
