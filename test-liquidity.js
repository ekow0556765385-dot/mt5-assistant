// test-liquidity.js — Arbiter's liquidity is the Assistant's OWN function.
// index.html's copy is lifted at runtime and run beside Arbiter's on the same
// candles; any drift between them fails here.
'use strict';
const assert = require('assert');
const fs = require('fs');

// the Assistant's copy, straight out of index.html
const idx = fs.readFileSync('/mnt/user-data/uploads/index.html', 'utf8').replace(/[^\x09\x0a\x20-\x7e]/g, '');
const lines = idx.split('\n');
const constLine = lines.find(l => /^const LIQ_TF_MIN=/.test(l));
const start = lines.findIndex(l => /^function liqHourOf\(c\)\{/.test(l));
// through the END OF liqRead, not the end of the first function
let end = lines.findIndex(l => /^function liqRead\(cd,tf\)\{/.test(l));
while (!/^\}/.test(lines[end])) end++;
const assistantSrc = constLine + '\n' + lines.slice(start, end + 1).join('\n');
const assistantLiqRead = new Function(assistantSrc + '; return liqRead;')();

// Arbiter's copy
global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {} };
require('./arbiter-feeds.js');
const F = window.BWArbiterFeeds._internals;

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }

function market(n, opt = {}) {
  const out = []; let p = opt.start || 1.0800;
  for (let i = 0; i < n; i++) {
    const vol = opt.vol ? opt.vol(i) : 900 + 300 * Math.sin(i / 3);
    const rng = opt.rng ? opt.rng(i) : 0.0012;
    p += (opt.drift || 0);
    out.push({ t: 1790000000 + i * 3600, o: p, h: p + rng * 0.6, l: p - rng * 0.4, c: p + 0.0001, v: Math.max(1, Math.round(vol)) });
  }
  return out;
}

console.log('\nLIQUIDITY — Arbiter vs the Assistant, same function');

const cases = {
  'normal participation': market(200),
  'a volume drought': market(200, { vol: i => (i > 180 ? 30 : 900) }),
  'a volume burst': market(200, { vol: i => (i > 190 ? 9000 : 800) }),
  'wide bars, thin volume': market(200, { vol: () => 60, rng: () => 0.0060 }),
  'a trending market': market(200, { drift: 0.0004 }),
  'barely enough bars': market(45)
};
Object.keys(cases).forEach(name => {
  check('identical reading — ' + name, () => {
    const a = assistantLiqRead(cases[name], 'H1');
    const b = F.liqRead(cases[name], 'H1');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)));
  });
});

console.log('\nWHAT ARBITER DOES WITH IT');

check('the VERDICT drives it, not the raw score (the low 40s is NORMAL)', () => {
  const r = F.liquidityFor(market(200));
  assert.strictEqual(r.cls, 'healthy');
  assert.ok(r.score < 60, 'score ' + r.score + ' — a percentage reading would call this thin');
  assert.strictEqual(r.depth, 0.8);
});

check('a drought is recognised as a drought', () => {
  const r = F.liquidityFor(market(200, { vol: i => (i > 180 ? 25 : 900) }));
  assert.ok(['drought', 'thin'].indexOf(r.cls) >= 0, 'cls ' + r.cls + ' (' + r.state + ')');
  assert.ok(r.depth <= 0.3);
});

check('too few candles: no reading at all, never a guess', () => {
  assert.strictEqual(F.liquidityFor(market(20)), null);
  assert.strictEqual(F.liquidityFor(null), null);
});

check('the engine reads the verdict: healthy passes, thin fails, learning is unknown', () => {
  const E = require('./arbiter-engine.js');
  const world = cls => ({ symbol: 'EURUSD', price: 1.08, session: { name: 'London', cls, state: cls, score: 42, plain: 'x.' } });
  const st = cls => E._internals.judge(world(cls), 'bull').conditions.find(c => c.id === 'session').state;
  assert.strictEqual(st('healthy'), 'pass');
  assert.strictEqual(st('thin'), 'fail');
  assert.strictEqual(st('drought'), 'fail');
  assert.strictEqual(st('man'), 'warn', 'being swept is a warning, not a failure');
  assert.strictEqual(st('learn'), 'unknown');
});

check('thin liquidity adds pressure against an open trade; healthy adds none', () => {
  const E = require('./arbiter-engine.js');
  const pos = { ticket: '1', side: 'buy', openPrice: 1.08, tp: 1.09, floatingPips: 5, mfePips: 6, stopPips: 30 };
  const f = cls => E.judgePosition({ symbol: 'EURUSD', price: 1.0805, session: { name: 'Tokyo', cls, state: cls, score: 12, plain: 'thin.' },
    patterns: [], zones: [] }, pos).pressure.factors.map(x => x.id);
  assert.ok(f('thin').indexOf('liquidity') >= 0);
  assert.ok(f('healthy').indexOf('liquidity') < 0);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
