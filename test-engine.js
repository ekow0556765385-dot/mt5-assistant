// test-engine.js — Phase 2. Run: node test-engine.js
'use strict';
const assert = require('assert');
const E = require('./arbiter-engine.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// A world where every one of the 14 conditions passes. Each test then
// breaks exactly one thing, so a failure points at one cause.
function goodWorld(over = {}) {
  return Object.assign({
    symbol: 'EURUSD', price: 1.0840, timeframe: 'H1', higherTimeframe: 'H4',
    structure: { regime: 'downtrend', confidence: 0.9 },
    zones: [
      { kind: 'supply', lo: 1.0838, hi: 1.08455, touches: 2, ageHours: 72, spent: false },
      { kind: 'demand', lo: 1.0760, hi: 1.0770, touches: 1, ageHours: 40, spent: false }
    ],
    medianZoneHeight: 0.0008,
    patterns: [{ name: 'Bearish Engulfing', type: 'bearish', confidence_pct: 81, bar_index: 1, timeframe: 'H1' }],
    sweep: 'confirmed',
    retracement: { score: 22, note: 'Volume draining.' },
    target: 1.0790,
    atr: 0.0060, sessionMinutesLeft: 180,
    session: { name: 'London', depth: 0.85 },
    news: [{ title: 'US Retail Sales', impact: 'high', minutesAway: 400 }],
    expectedMinutes: 240,
    radar: { score: 14, state: 'clear', stateName: 'Clear' },
    openPositions: [], correlations: [],
    spread: 0.8, medianSpread: 0.9, spreadPoints: 8, medianSpreadPoints: 9,   // the engine judges POINTS now (what the broker reports)
    edge: { sample: 38, hitRate: 0.61, baseline: 0.52 }
  }, over);
}
const byId = (j, id) => j.conditions.find(c => c.id === id);

console.log('\nCONDITIONS');

check('a complete, aligned setup passes all fourteen and scores high', () => {
  const j = E.judgeSetup(goodWorld(), { direction: 'bear' });
  assert.strictEqual(j.counts.fail, 0, JSON.stringify(j.conditions.filter(c => c.state !== 'pass').map(c => [c.id, c.state, c.detail])));
  assert.strictEqual(j.counts.unknown, 0);
  assert.ok(j.score >= 90, 'score ' + j.score);
  assert.strictEqual(j.conditions.length, 14);
});

check('a missing feed is UNKNOWN — never a pass, never a fail', () => {
  const w = goodWorld(); delete w.retracement;
  const j = E.judgeSetup(w, { direction: 'bear' });
  assert.strictEqual(byId(j, 'pullback').state, 'unknown');
  assert.strictEqual(j.counts.fail, 0);
  assert.ok(j.missing.indexOf('pullback') >= 0, 'reported as missing');
  assert.ok(j.score >= 90, 'the rest still scores on its own evidence');
});

check('structure the other way fails and caps the score at the gate', () => {
  const j = E.judgeSetup(goodWorld({ structure: { regime: 'uptrend', confidence: 0.9 } }), { direction: 'bear' });
  assert.strictEqual(byId(j, 'structure').state, 'fail');
  assert.ok(j.gateCapped);
  assert.ok(j.score <= E.GATE_CAP, 'score ' + j.score);
  assert.strictEqual(j.verdict.key, 'not_a_setup');
});

check('a six-hour-old engulfing is a chase, not a trigger', () => {
  const w = goodWorld({ patterns: [{ name: 'Bearish Engulfing', type: 'bearish', confidence_pct: 81, bar_index: 6 }] });
  const j = E.judgeSetup(w, { direction: 'bear' });
  assert.strictEqual(byId(j, 'trigger').state, 'fail');
  assert.ok(/chase/.test(byId(j, 'trigger').detail));
});

check('pattern fields are read in BOTH shapes (type/confidence_pct and direction/confidence)', () => {
  const alt = goodWorld({ patterns: [{ name: 'Bearish Engulfing', direction: 'bear', confidence: 81, barsAgo: 1 }] });
  assert.strictEqual(byId(E.judgeSetup(alt, { direction: 'bear' }), 'trigger').state, 'pass');
});

check('an opposing zone before the target shrinks the real R', () => {
  const w = goodWorld();
  w.zones.push({ kind: 'demand', lo: 1.0818, hi: 1.0822, touches: 1, ageHours: 10, spent: false });
  const j = E.judgeSetup(w, { direction: 'bear' });
  const r = byId(j, 'room');
  assert.notStrictEqual(r.state, 'pass');
  assert.ok(r.metric.toOpposingPips < r.metric.toTargetPips);
});

check('a spent zone is not trusted', () => {
  const w = goodWorld();
  w.zones[0].spent = true;
  assert.strictEqual(byId(E.judgeSetup(w, { direction: 'bear' }), 'zone_trust').state, 'fail');
});

check('an edge from 11 trades carries NO weight, and says so', () => {
  const w = goodWorld({ edge: { sample: 11, hitRate: 0.9, baseline: 0.5 } });
  const j = E.judgeSetup(w, { direction: 'bear' });
  const e = byId(j, 'own_edge');
  assert.strictEqual(e.state, 'unknown');
  assert.ok(/11 of 30/.test(e.detail));
  const strong = E.judgeSetup(goodWorld({ edge: { sample: 11, hitRate: 0.2, baseline: 0.5 } }), { direction: 'bear' });
  assert.strictEqual(j.score, strong.score, 'a thin sample cannot move the score either way');
});

check('reachability: a target beyond the session is flagged', () => {
  const j = E.judgeSetup(goodWorld({ target: 1.0700 }), { direction: 'bear' });
  assert.strictEqual(byId(j, 'reach').state, 'fail');
});

check('spread is judged against this pair\'s own median, with the cost of the move', () => {
  const j = E.judgeSetup(goodWorld({ spread: 3.4, medianSpread: 2.6, spreadPoints: 34, medianSpreadPoints: 26 }), { direction: 'bear' });
  const s = byId(j, 'spread');
  assert.strictEqual(s.state, 'warn');
  assert.ok(/% of the intended move/.test(s.detail));
});

check('correlation is stated even when flat', () => {
  assert.strictEqual(byId(E.judgeSetup(goodWorld(), { direction: 'bear' }), 'correlation').state, 'pass');
  const w = goodWorld({
    openPositions: [{ symbol: 'GBPUSD', side: 'sell' }],
    correlations: [{ symbol: 'GBPUSD', rho: 0.82 }]
  });
  const c = byId(E.judgeSetup(w, { direction: 'bear' }), 'correlation');
  assert.strictEqual(c.state, 'warn');
  assert.ok(/one idea at 2x size/.test(c.detail));
});

check('the cap tightens with each gate lost, and rawScore survives the veto', () => {
  const one = E.judgeSetup(goodWorld({ patterns: [] }), { direction: 'bear' });
  assert.deepStrictEqual(one.gatesFailed, ['trigger']);
  assert.strictEqual(one.gateCap, 45);
  assert.ok(one.score <= 45 && one.rawScore > 45, 'capped, but the raw reading is kept: ' + one.rawScore);

  const two = E.judgeSetup(goodWorld({ patterns: [], price: 1.0700 }), { direction: 'bear' });
  assert.strictEqual(two.gatesFailed.length, 2, JSON.stringify(two.gatesFailed));
  assert.strictEqual(two.gateCap, 30);

  const three = E.judgeSetup(goodWorld({ patterns: [], price: 1.0700, structure: { regime: 'uptrend', confidence: 0.9 } }), { direction: 'bear' });
  assert.strictEqual(three.gatesFailed.length, 3);
  assert.strictEqual(three.gateCap, 15);
  assert.ok(three.score < two.score && two.score < 45, 'three gates down reads worse than one');
});

console.log('\nRISK RADAR IS A DISCOUNT, NOT A DIRECTION');

check('a flagged window pulls a good score DOWN toward the middle', () => {
  const clear = E.judgeSetup(goodWorld(), { direction: 'bear' });
  const flagged = E.judgeSetup(goodWorld({ radar: { score: 58, state: 'elevated', stateName: 'Elevated', factors: [{ label: 'thin liquidity' }] } }), { direction: 'bear' });
  assert.ok(flagged.score < clear.score, 'discounted');
  assert.ok(flagged.score > 50, 'pulled toward the middle, not past it');
  assert.ok(flagged.radarDiscount > 0);
});

check('a flagged window pulls a BAD score UP toward the middle — it never strengthens a case', () => {
  const bad = { structure: { regime: 'uptrend', confidence: 0.9 }, patterns: [], sweep: 'warning',
                retracement: { score: 80 }, spread: 4, medianSpread: 1 };
  const clear = E.judgeSetup(goodWorld(bad), { direction: 'bear' });
  const flagged = E.judgeSetup(goodWorld(Object.assign({}, bad, { radar: { score: 80, state: 'standdown', stateName: 'Stand down' } })), { direction: 'bear' });
  assert.ok(flagged.score >= clear.score, 'a danger flag cannot make the bearish case look stronger');
  assert.ok(flagged.score <= 50);
});

console.log('\nLIVE POSITIONS');

function position(over = {}) {
  return Object.assign({ ticket: '1', side: 'sell', floatingPips: 8, mfePips: 22, maePips: 4, stopPips: 26 }, over);
}

/* THE LIVE RULES AS THEY STAND (Phase C onwards). A changed pillar or a counter-signal RAISES PRESSURE;
   an action needs a ROUTE — a witnessed reversal (the decisive level CLOSED through on H1), the damage
   route, the profit ladder or the floor. These checks describe the engine as it is, so a change to any of
   these rules shows up here. (They replaced the Phase 2 checks, which expected an action from a pillar
   change alone.) */
const baseP = () => { const w = goodWorld(); return { w, frozen: E.freezeEntryCase(w, position()) }; };

check('every pillar standing → HOLD, calm', () => {
  const { w, frozen } = baseP();
  const j = E.judgePosition(w, position({ entryCase: frozen }));
  assert.strictEqual(j.action.key, 'hold');
  assert.strictEqual(j.broken, 0);
  assert.ok(j.pressure.score < E.STAGE.CALM, 'pressure ' + j.pressure.score);
});

check('the zone is closed through → the pillar reads BROKEN and pressure rises (no action without a route)', () => {
  const { w, frozen } = baseP();
  const calm = E.judgePosition(w, position({ entryCase: frozen }));
  const later = goodWorld(); later.zones[0].spent = true;
  const j = E.judgePosition(later, position({ entryCase: frozen }));
  assert.strictEqual(j.pillars.find(p => p.id === 'zone_trust').change, 'broken');
  assert.ok(j.pressure.score > calm.pressure.score, 'pressure rose: ' + calm.pressure.score + ' → ' + j.pressure.score);
});

check('structure turning against the trade → the structure pillar BREAKS and pressure rises', () => {
  const { frozen } = baseP();
  const j = E.judgePosition(goodWorld({ structure: { regime: 'uptrend', confidence: 0.85 } }), position({ entryCase: frozen }));
  assert.strictEqual(j.pillars.find(p => p.id === 'structure').change, 'broken');
  assert.ok(j.pressure.score > 4);
});

check('the decisive level CLOSED through on H1, well beyond it → CUT by the damage route, stop untouched', () => {
  const { frozen } = baseP();
  const t0 = 1.79e9, c = []; let p = 1.0840;
  for (let i = 0; i < 40; i++) c.push({ t: t0 + i * 3600, o: p, h: p + 0.0004, l: p - 0.0004, c: p });
  [[1.0850, 1.0872, 1.0848, 1.0870], [1.0870, 1.0880, 1.0868, 1.0878], [1.0878, 1.0885, 1.0874, 1.0882]]
    .forEach((r, k) => c.push({ t: t0 + (40 + k) * 3600, o: r[0], h: r[1], l: r[2], c: r[3] }));
  c.push({ t: t0 + 43 * 3600, o: 1.0882, h: 1.0884, l: 1.0880, c: 1.0882 });                 // the forming bar
  const w = goodWorld({ price: 1.0882, invalidationLevel: 1.0865, candles: c, atr: 0.0010, patterns: [] });
  const j = E.judgePosition(w, position({ entryCase: frozen, openPrice: 1.0840, floatingPips: -42, mfePips: 5, maePips: -42, stopPips: 60 }));
  assert.strictEqual(j.action.key, 'cut');
  assert.strictEqual(j.action.route, 'damage');
});

check('a live counter-pattern raises pressure; the same pattern stale does not', () => {
  const { w, frozen } = baseP();
  const calm = E.judgePosition(w, position({ entryCase: frozen })).pressure.score;
  const live = goodWorld(); live.patterns = live.patterns.concat([{ name: 'Bullish Engulfing', type: 'bullish', confidence_pct: 79, bar_index: 1 }]);
  const stale = goodWorld(); stale.patterns = stale.patterns.concat([{ name: 'Bullish Engulfing', type: 'bullish', confidence_pct: 79, bar_index: 9 }]);
  assert.ok(E.judgePosition(live, position({ entryCase: frozen })).pressure.score > calm, 'live raises it');
  assert.strictEqual(E.judgePosition(stale, position({ entryCase: frozen })).pressure.score, calm, 'stale is not a live threat');
});

check('a formation escalates its pressure: forming < in reach < broken', () => {
  const { frozen } = baseP();
  const f = (over) => { const world = goodWorld();
    world.formations = [Object.assign({ name: 'Inverse Head and Shoulders', type: 'bullish', completion: 0.6 }, over)];
    return E.judgePosition(world, position({ entryCase: frozen })); };
  const a = f({}), b = f({ necklinePips: 8 }), c = f({ broken: true });
  assert.strictEqual(a.counterSignals[0].severity, 'forming');
  assert.strictEqual(a.action.key, 'hold', 'a forming pattern is a watch, not an action');
  assert.ok(a.pressure.score < b.pressure.score && b.pressure.score < c.pressure.score,
    a.pressure.score + ' < ' + b.pressure.score + ' < ' + c.pressure.score);
});

check('a weakened pillar alone is not an action', () => {
  const { frozen } = baseP();
  const later = goodWorld({ session: { name: 'Tokyo', depth: 0.45 } });
  later.zones[0].touches = 4;
  assert.strictEqual(E.judgePosition(later, position({ entryCase: frozen, floatingPips: 12 })).action.key, 'hold');
});

check('the Combined Read\'s reversal pressure: confirmed = heavy witness, early = medium, building = pressure only', () => {
  const { frozen } = baseP();
  const rp = st => ({ state: st, score: 70, level: { tier: 'major', side: 'support', price: 1.0830 },   // a turn UP: against this sell
                      officialLine: { name: 'LH', price: 1.0890 }, earlyLine: { name: 'LH', price: 1.0850 } });
  const at = st => E.judgePosition(goodWorld({ combinedRead: { read: { reversalPressure: rp(st) } } }), position({ entryCase: frozen }));
  const ws = j => (j.pressure.reversal && j.pressure.reversal.witnesses) || [];
  assert.ok(ws(at('confirmed')).some(w => w.id === 'combined' && w.weight === 'heavy'), 'confirmed is the Combined Read confirming');
  assert.ok(ws(at('early')).some(w => w.id === 'pressure' && w.weight === 'medium'));
  assert.ok(ws(at('live')).every(w => w.weight === 'forming' || w.id !== 'pressure_building'), 'building is never a witness');
  assert.strictEqual(at('live').pressure.reversal.independent, at('none').pressure.reversal.independent);
  const withTrade = { state: 'confirmed', score: 80, level: { tier: 'major', side: 'resistance', price: 1.0850 } };   // a turn DOWN: with this sell
  assert.ok(!ws(E.judgePosition(goodWorld({ combinedRead: { read: { reversalPressure: withTrade } } }), position({ entryCase: frozen })))
    .some(w => w.id === 'combined'), 'a reversal in the trade\'s favour is never counted against it');
});

check('the calm HOLD sentence names a reason that broke', () => {
  const { frozen } = baseP();
  const later = goodWorld(); later.zones[0].spent = true;
  const j = E.judgePosition(later, position({ entryCase: frozen }));
  assert.strictEqual(j.action.key, 'hold');
  assert.ok(!/Everything you entered on is still holding/.test(j.action.reason), j.action.reason);
  assert.ok(/zone trust has changed since you entered/.test(j.action.reason), j.action.reason);
});

console.log('\nLOCATION IS ON THE TRADE\'S SIDE');

check('a demand block ABOVE price (fallen through) gives a buy no location', () => {
  const w = goodWorld({ structure: { regime: 'uptrend', confidence: 0.9 }, price: 1.0750,
    zones: [{ kind: 'demand', lo: 1.0758, hi: 1.0759, touches: 1, ageHours: 5, spent: true }] });
  const l = byId(E.judgeSetup(w, { direction: 'bull' }), 'location');
  assert.strictEqual(l.state, 'fail');
  assert.ok(/no longer underneath/.test(l.detail), l.detail);
});

check('with a demand block below too, location measures to the one below', () => {
  const w = goodWorld({ structure: { regime: 'uptrend', confidence: 0.9 }, price: 1.0750,
    zones: [{ kind: 'demand', lo: 1.0758, hi: 1.0759, touches: 1, ageHours: 5, spent: true },
            { kind: 'demand', lo: 1.0740, hi: 1.0745, touches: 1, ageHours: 5, spent: false }] });
  const l = byId(E.judgeSetup(w, { direction: 'bull' }), 'location');
  assert.strictEqual(l.state, 'pass');
  assert.ok(/1\.07400/.test(l.detail), l.detail);
});

check('price inside its zone is unchanged', () => {
  const l = byId(E.judgeSetup(goodWorld(), { direction: 'bear' }), 'location');
  assert.strictEqual(l.state, 'pass');
  assert.ok(/inside/.test(l.detail));
});

check('excursion and giveback are computed from the water marks', () => {
  const w = goodWorld();
  const j = E.judgePosition(w, position({ entryCase: E.freezeEntryCase(w, position()), mfePips: 22, floatingPips: 8, maePips: 4, stopPips: 26 }));
  assert.ok(Math.abs(j.excursion.givebackShare - (22 - 8) / 22) < 1e-9);
  assert.ok(Math.abs(j.excursion.stopUsedShare - 4 / 26) < 1e-9);
});

check('transitions name real levels in both directions', () => {
  const w = goodWorld({ invalidationLevel: 1.0865 });
  const j = E.judgePosition(w, position({ entryCase: E.freezeEntryCase(w, position()) }));
  assert.ok(j.transitions.some(t => t.toward === 'worse' && /1\.08/.test(t.text)));
  assert.ok(j.transitions.some(t => t.toward === 'better'));
});

console.log('\nADVICE DOES NOT FLICKER');

check('escalation needs 2 cycles, relaxing back needs 3', () => {
  const s = E.createStabiliser();
  const hold = { key: 'hold', label: 'HOLD' }, cut = { key: 'cut', label: 'CUT' };
  assert.strictEqual(s.settle('1', hold).action.key, 'hold');
  assert.strictEqual(s.settle('1', cut).action.key, 'hold', 'first cut is not shown yet');
  assert.strictEqual(s.settle('1', cut).action.key, 'cut', 'shown on the second');
  assert.strictEqual(s.settle('1', hold).action.key, 'cut');
  assert.strictEqual(s.settle('1', hold).action.key, 'cut');
  assert.strictEqual(s.settle('1', hold).action.key, 'hold', 'relaxes only on the third');
});

check('a single spike never reaches the screen; a warning on 2 of the last 3 cycles does', () => {
  const s = E.createStabiliser();
  const hold = { key: 'hold' }, partial = { key: 'partial' };
  s.settle('9', hold);
  assert.strictEqual(s.settle('9', partial).action.key, 'hold', 'one spike: not shown');
  assert.strictEqual(s.settle('9', hold).action.key, 'hold');
  assert.strictEqual(s.settle('9', partial).action.key, 'partial', '2 of the last 3: shown (pressure hovering at the line)');
  const t = E.createStabiliser();
  t.settle('8', hold); t.settle('8', partial); t.settle('8', hold); t.settle('8', hold);
  assert.strictEqual(t.settle('8', partial).action.key, 'hold', '1 of the last 3: not shown');
});

check('positions are tracked separately', () => {
  const s = E.createStabiliser();
  s.settle('a', { key: 'hold' }); s.settle('b', { key: 'hold' });
  s.settle('a', { key: 'cut' }); s.settle('a', { key: 'cut' });
  assert.strictEqual(s.settle('a', { key: 'cut' }).action.key, 'cut');
  assert.strictEqual(s.settle('b', { key: 'hold' }).action.key, 'hold');
});

console.log('\nROBUSTNESS');

check('an empty world produces no score and no invented conditions', () => {
  const j = E.judgeSetup({ symbol: 'EURUSD', price: 1.08 });
  assert.strictEqual(j.score, null);
  assert.strictEqual(j.verdict.key, 'no_data');
  assert.strictEqual(j.counts.pass + j.counts.fail, j.conditions.filter(c => c.state === 'pass' || c.state === 'fail').length);
});

check('a condition that throws is contained, not fatal', () => {
  // attached AFTER construction: the fixture helper itself copies properties,
  // which would otherwise detonate the getter before the engine sees the world
  const w = goodWorld();
  Object.defineProperty(w, 'zones', { get() { throw new Error('feed exploded'); } });
  const j = E.judgeSetup(w, { direction: 'bear' });
  assert.ok(j.conditions.length === 14);
  assert.strictEqual(byId(j, 'location').state, 'unknown');
});

check('gold and JPY use their own pip sizes throughout', () => {
  const g = E.judgeSetup(goodWorld({ symbol: 'XAUUSD', price: 2338.4, target: 2356,
    zones: [{ kind: 'demand', lo: 2336.9, hi: 2339.2, touches: 1, ageHours: 12, spent: false }],
    medianZoneHeight: 2.0, atr: 12, structure: { regime: 'uptrend', confidence: 0.8 },
    patterns: [{ name: 'Hammer', type: 'bullish', confidence_pct: 78, bar_index: 1 }] }), { direction: 'bull' });
  assert.strictEqual(E._internals.pipSizeFor('XAUUSD'), 0.1);
  assert.ok(/2336.90/.test(byId(g, 'location').detail), byId(g, 'location').detail);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
