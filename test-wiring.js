// test-wiring.js — the hunting conditions that reported "no reading":
// retracement (the Pattern Detector's OWN engine), resting liquidity,
// room-to-target and reachability while flat.
'use strict';
const assert = require('assert');
const fs = require('fs');
global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {} };
// the real retracement engine, as the browser loads it
new Function(fs.readFileSync(__dirname + '/retracement.js', 'utf8'))();
require('./arbiter-feeds.js');
const F = window.BWArbiterFeeds._internals;
const E = require('./arbiter-engine.js');

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }

// an impulse up, then a pullback into it — what a retracement reading is for
function pullbackMarket() {
  const out = []; let p = 1.0800, t = 1790000000;
  for (let i = 0; i < 60; i++) { p += 0.0002 * Math.sin(i / 4); out.push(bar(p)); }
  for (let i = 0; i < 25; i++) { p += 0.0009; out.push(bar(p)); }          // the impulse
  for (let i = 0; i < 10; i++) { p -= 0.0004; out.push(bar(p)); }          // the pullback
  function bar(c) { return { t: (t += 3600), o: c - 0.0001, h: c + 0.0004, l: c - 0.0004, c, v: 900 }; }
  return out;
}
// price turning twice off the same level leaves a pool of stops above it
function equalHighs() {
  const out = []; let p = 1.0800, t = 1790000000;
  const push = c => out.push({ t: (t += 3600), o: c - 0.0001, h: c + 0.0004, l: c - 0.0004, c, v: 900 });
  for (let i = 0; i < 40; i++) push(p + 0.0001 * Math.sin(i / 3));
  for (let i = 0; i < 6; i++) push(p + 0.0006 * i);                        // up to the level
  for (let i = 0; i < 6; i++) push(p + 0.0036 - 0.0006 * i);               // and away
  for (let i = 0; i < 6; i++) push(p + 0.0006 * i);                        // back to the SAME level
  for (let i = 0; i < 6; i++) push(p + 0.0036 - 0.0006 * i);               // and away again
  return out;
}

console.log('\nRETRACEMENT — the Pattern Detector\'s own engine, run inside Arbiter');

check('a pullback inside an impulse gets a real reading, on the engine\'s own scale', () => {
  const r = F.retracementFor(pullbackMarket(), 'EURUSD', null);
  assert.ok(r, 'a reading, not "no retracement reading"');
  assert.ok(r.score >= 0 && r.score <= 100, 'score ' + r.score);
  assert.ok(['pullback', 'leaning-pullback', 'leaning-reversal', 'reversal'].indexOf(r.verdict) >= 0, r.verdict);
  assert.strictEqual(r.from, 'the retracement engine');
});

check('it is the SAME answer the Pattern Detector would show', () => {
  const cd = pullbackMarket();
  const direct = window.BWRetracement.assess({ candles: cd, symbol: 'EURUSD', risk: null });
  assert.strictEqual(F.retracementFor(cd, 'EURUSD', null).score, direct.score);
});

check('no trend to retrace from = no reading, never a guessed one', () => {
  const flat = Array.from({ length: 60 }, (_, i) => ({ t: 1790000000 + i * 3600, o: 1.08, h: 1.0801, l: 1.0799, c: 1.08, v: 900 }));
  assert.strictEqual(F.retracementFor(flat, 'EURUSD', null), null);
  assert.strictEqual(F.retracementFor([], 'EURUSD', null), null);
});

check('the pullback condition now READS it instead of saying "no retracement reading"', () => {
  const w = { symbol: 'EURUSD', price: 1.09, retracement: { score: 22, verdict: 'pullback', from: 'the retracement engine' } };
  const c = E._internals.judge(w, 'bull').conditions.find(x => x.id === 'pullback');
  assert.strictEqual(c.state, 'pass');
  assert.ok(!/No retracement reading/.test(c.detail), c.detail);
});

console.log('\nRESTING LIQUIDITY — measured from the candles');

check('two turns off the same level is a pool, with its distance and touches', () => {
  const cd = equalHighs();
  const r = F.restingFor(cd, 'EURUSD', cd[cd.length - 1].c);
  assert.ok(r, 'found a pool');
  assert.ok(r.touches >= 2, 'touches ' + r.touches);
  assert.ok(r.pipsAway > 0);
  assert.ok(/highs|lows/.test(r.label), r.label);
});

check('a market that never turns twice at one level has no pool', () => {
  const trend = Array.from({ length: 80 }, (_, i) => { const c = 1.08 + i * 0.0006;
    return { t: 1790000000 + i * 3600, o: c, h: c + 0.0004, l: c - 0.0004, c, v: 900 }; });
  assert.strictEqual(F.restingFor(trend, 'EURUSD', 1.08 + 80 * 0.0006), null);
});

check('the liquidity condition reads the pool', () => {
  const w = { symbol: 'EURUSD', price: 1.0800,
    restingLiquidity: { level: 1.0830, pipsAway: 30, touches: 3, side: 'above', label: 'Equal highs at 1.08300' } };
  const c = E._internals.judge(w, 'bull').conditions.find(x => x.id === 'liquidity');
  assert.ok(c.state !== 'unknown', c.detail);
  assert.ok(!/No liquidity reading/.test(c.detail), c.detail);
});

console.log('\nWHILE FLAT: room to target and reachability');

const huntWorld = {
  symbol: 'EURUSD', price: 1.0800, atr: 0.0015, timeframe: 'H1',
  structure: { regime: 'uptrend', confidence: 0.8 },
  zones: [{ kind: 'supply', low: 1.0860, high: 1.0875, ageBars: 20, touches: 0, mitigated: false, strength: 1.2 }],
  session: { name: 'London', minutesLeft: 240, cls: 'healthy', state: 'Healthy', score: 44 },
  patterns: [], news: [], openPositions: []
};

check('with no take profit, it measures against an IMPLIED target and says so', () => {
  const j = E.judgeSetup(huntWorld, { direction: 'bull' });
  const room = j.conditions.find(c => c.id === 'room');
  const reach = j.conditions.find(c => c.id === 'reach');
  assert.notStrictEqual(room.state, 'unknown', room.detail);
  assert.notStrictEqual(reach.state, 'unknown', reach.detail);
  assert.ok(!/No target to measure against/.test(room.detail), room.detail);
  assert.ok(!/No ATR or target/.test(reach.detail), reach.detail);
  assert.ok(j.target && j.target.implied !== false, 'the judgement says the target is implied');
});

check('a real take profit is still preferred over the implied one', () => {
  const j = E.judgeSetup(Object.assign({}, huntWorld, { target: 1.0900 }), { direction: 'bull' });
  assert.strictEqual(j.target.price, 1.0900);
  assert.strictEqual(j.target.implied, false);
});

check('nothing to imply a target from: still honestly unknown', () => {
  const bare = { symbol: 'EURUSD', price: 1.08, structure: { regime: 'uptrend', confidence: 0.8 }, zones: [], patterns: [] };
  const j = E.judgeSetup(bare, { direction: 'bull' });
  assert.strictEqual(j.conditions.find(c => c.id === 'room').state, 'unknown');
});

console.log('\nARBITER\'S OWN ZONES — the EA\'s SMC_DetectOBs(), ported exactly');
function base(n, p) { const out = []; let t = 1790000000;
  for (let i = 0; i < n; i++) out.push({ t: (t += 3600), o: p, h: p + 0.0003, l: p - 0.0003, c: p + 0.00005 });
  return out; }

check('a bearish candle then a bullish impulse closing above its high, body > 1.5x = a BULLISH block', () => {
  const cd = base(40, 1.0800);
  cd[20] = { t: cd[20].t, o: 1.0810, h: 1.0812, l: 1.0798, c: 1.0800 };   // bearish, body 10 pips
  cd[21] = { t: cd[21].t, o: 1.0800, h: 1.0830, l: 1.0799, c: 1.0828 };   // bullish, closes ABOVE 1.0812, body 28
  for (let k = 22; k < 40; k++) cd[k] = { t: cd[k].t, o: 1.0840, h: 1.0845, l: 1.0835, c: 1.0842 };  // never returns
  const r = F.ownOrderBlocks(cd);
  const b = r.orderBlocks.find(x => x.direction === 'Bullish');
  assert.ok(b, 'found');
  assert.strictEqual(b.high, 1.0810, 'from the bearish candle\'s OPEN');
  assert.strictEqual(b.low, 1.0800, 'to its CLOSE — exactly as the EA stores it');
  assert.strictEqual(r.own, true);
});

check('the mirror image is a BEARISH block, stored close-to-open like the EA', () => {
  const cd = base(40, 1.0800);
  cd[20] = { t: cd[20].t, o: 1.0800, h: 1.0812, l: 1.0798, c: 1.0810 };   // bullish
  cd[21] = { t: cd[21].t, o: 1.0810, h: 1.0811, l: 1.0780, c: 1.0782 };   // bearish, closes BELOW 1.0798
  for (let k = 22; k < 40; k++) cd[k] = { t: cd[k].t, o: 1.0760, h: 1.0765, l: 1.0755, c: 1.0758 };
  const b = F.ownOrderBlocks(cd).orderBlocks.find(x => x.direction === 'Bearish');
  assert.ok(b);
  assert.strictEqual(b.high, 1.0810); assert.strictEqual(b.low, 1.0800);
});

check('NOT a block when the impulse fails to close beyond the high, or its body is too small', () => {
  const cd = base(40, 1.0800);
  cd[20] = { t: cd[20].t, o: 1.0810, h: 1.0812, l: 1.0798, c: 1.0800 };
  cd[21] = { t: cd[21].t, o: 1.0800, h: 1.0815, l: 1.0799, c: 1.0811 };   // closes BELOW 1.0812
  assert.ok(!F.ownOrderBlocks(cd).orderBlocks.some(x => x.direction === 'Bullish' && x.high === 1.0810));
});

check('a MITIGATED block (price came back inside it within 20 candles) is not sent — same as the EA', () => {
  const cd = base(40, 1.0800);
  cd[20] = { t: cd[20].t, o: 1.0810, h: 1.0812, l: 1.0798, c: 1.0800 };
  cd[21] = { t: cd[21].t, o: 1.0800, h: 1.0830, l: 1.0799, c: 1.0828 };
  for (let k = 22; k < 40; k++) cd[k] = { t: cd[k].t, o: 1.0840, h: 1.0845, l: 1.0835, c: 1.0842 };
  cd[25] = { t: cd[25].t, o: 1.0820, h: 1.0822, l: 1.0805, c: 1.0815 };   // low 1.0805 is inside 1.0800-1.0810
  assert.ok(!F.ownOrderBlocks(cd).orderBlocks.some(x => x.high === 1.0810));
});

check('at most 5 blocks, the most recent first — the EA\'s own selection', () => {
  const cd = base(120, 1.0800);
  for (let i = 5; i < 110; i += 12) {
    cd[i] = { t: cd[i].t, o: 1.0810 + i * 1e-5, h: 1.0812 + i * 1e-5, l: 1.0798, c: 1.0800 };
    cd[i + 1] = { t: cd[i + 1].t, o: 1.0800, h: 1.0840 + i * 1e-5, l: 1.0799, c: 1.0838 + i * 1e-5 };
  }
  const out = F.ownOrderBlocks(cd).orderBlocks;
  assert.ok(out.length <= 5, 'got ' + out.length);
  for (let k = 1; k < out.length; k++) assert.ok(out[k - 1].timeStart >= out[k].timeStart, 'most recent first');
});

check('fewer than the EA\'s minimum of 35 candles: no own read at all', () => {
  assert.strictEqual(F.ownOrderBlocks(base(30, 1.08)), null);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
