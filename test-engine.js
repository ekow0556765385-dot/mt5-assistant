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
    spread: 0.8, medianSpread: 0.9,
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
  const j = E.judgeSetup(goodWorld({ spread: 3.4, medianSpread: 2.6 }), { direction: 'bear' });
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

check('every pillar standing → HOLD', () => {
  const w = goodWorld();
  const frozen = E.freezeEntryCase(w, position());
  const j = E.judgePosition(w, position({ entryCase: frozen }));
  assert.strictEqual(j.action.key, 'hold');
  assert.strictEqual(j.broken, 0);
  assert.ok(/still standing/.test(j.action.reason));
});

check('the zone is closed through → pillar BROKEN → TAKE PARTIAL, not cut', () => {
  const w = goodWorld();
  const frozen = E.freezeEntryCase(w, position());
  const later = goodWorld();
  later.zones[0].spent = true;                       // the reason for entry is gone
  const j = E.judgePosition(later, position({ entryCase: frozen }));
  assert.strictEqual(j.action.key, 'partial');
  assert.ok(j.pillars.find(p => p.id === 'zone_trust').change === 'broken');
  assert.ok(/structural case still holds/.test(j.action.reason));
});

check('structure turning against the trade → CUT', () => {
  const w = goodWorld();
  const frozen = E.freezeEntryCase(w, position());
  const later = goodWorld({ structure: { regime: 'uptrend', confidence: 0.85 } });
  const j = E.judgePosition(later, position({ entryCase: frozen }));
  assert.strictEqual(j.action.key, 'cut');
});

check('the structural level breaking is a CUT even while the stop is untouched', () => {
  const w = goodWorld();
  const frozen = E.freezeEntryCase(w, position());
  const later = goodWorld({ price: 1.0869, invalidationLevel: 1.0865 });
  const j = E.judgePosition(later, position({ entryCase: frozen }));
  assert.strictEqual(j.action.key, 'cut');
  assert.ok(j.invalidation.brokenNow);
});

check('a live counter-pattern → TAKE PARTIAL; the same pattern stale → no change', () => {
  const w = goodWorld();
  const frozen = E.freezeEntryCase(w, position());
  const live = goodWorld(); live.patterns = live.patterns.concat([{ name: 'Bullish Engulfing', type: 'bullish', confidence_pct: 79, bar_index: 1 }]);
  assert.strictEqual(E.judgePosition(live, position({ entryCase: frozen })).action.key, 'partial');
  const stale = goodWorld(); stale.patterns = stale.patterns.concat([{ name: 'Bullish Engulfing', type: 'bullish', confidence_pct: 79, bar_index: 9 }]);
  assert.strictEqual(E.judgePosition(stale, position({ entryCase: frozen })).action.key, 'hold', 'stale is not a live threat');
});

check('a formation escalates: forming → in reach → broken is a cut', () => {
  const w = goodWorld();
  const frozen = E.freezeEntryCase(w, position());
  const f = (over) => {
    const world = goodWorld();
    world.formations = [Object.assign({ name: 'Inverse Head and Shoulders', type: 'bullish', completion: 0.6 }, over)];
    return E.judgePosition(world, position({ entryCase: frozen }));
  };
  assert.strictEqual(f({}).counterSignals[0].severity, 'forming');
  assert.strictEqual(f({}).action.key, 'hold', 'a forming pattern is a watch, not an action');
  assert.strictEqual(f({ necklinePips: 8 }).action.key, 'partial');
  assert.strictEqual(f({ broken: true }).action.key, 'cut');
});

check('a weakened pillar in profit → MOVE TO BREAK-EVEN', () => {
  const w = goodWorld();
  const frozen = E.freezeEntryCase(w, position());
  const later = goodWorld({ session: { name: 'Tokyo', depth: 0.45 } });
  later.zones[0].touches = 4;                        // trust weakens, nothing breaks
  const j = E.judgePosition(later, position({ entryCase: frozen, floatingPips: 12 }));
  assert.strictEqual(j.action.key, 'be');
  const losing = E.judgePosition(later, position({ entryCase: frozen, floatingPips: -6 }));
  assert.strictEqual(losing.action.key, 'hold', 'nothing to protect yet');
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

check('a single flickering cycle never reaches the screen', () => {
  const s = E.createStabiliser();
  const hold = { key: 'hold' }, partial = { key: 'partial' };
  s.settle('9', hold);
  assert.strictEqual(s.settle('9', partial).action.key, 'hold');
  assert.strictEqual(s.settle('9', hold).action.key, 'hold');
  assert.strictEqual(s.settle('9', partial).action.key, 'hold', 'the count restarts, it does not accumulate');
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
