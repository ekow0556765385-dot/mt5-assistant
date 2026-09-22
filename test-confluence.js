// test-confluence.js — the Combined Read tab and formations, on the REAL engines
// lifted from patterns.html: the original crashes on a real formation, the fix does not.
'use strict';
const assert = require('assert');
const fs = require('fs');
function lift(path, marker) {
  const h = fs.readFileSync(path, 'utf8').replace(/[^\x09\x0a\x20-\x7e]/g, '');
  const e = h.indexOf(marker), b = h.lastIndexOf('(function(root){', e);
  let end = h.indexOf('})(', e); end = h.indexOf(';', end) + 1;
  return h.slice(b, end);
}
function engines(path) {
  const g = {}; g.window = g;
  new Function('window', 'globalThis', lift(path, 'root.BWChartPatterns').replace(/typeof window!=='undefined'\?window:globalThis/g, 'window'))(g, g);
  new Function('window', 'globalThis', lift(path, 'root.BWFormations={read').replace(/typeof window!=='undefined'\?window:globalThis/g, 'window'))(g, g);
  new Function('window', 'globalThis', lift(path, 'root.BWConfluence').replace(/typeof window!=='undefined'\?window:globalThis/g, 'window'))(g, g);
  return g;
}
const ORIG = '/mnt/user-data/uploads/patterns.html', FIXED = __dirname + '/out/patterns.html';

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }

// 60 bars of quiet lead-in first: the Combined Read needs ~100 candles
// before it forms a read at all, and with fewer it returns early — which
// would make every test below pass or fail for the wrong reason.
function doubleTop() {
  const px = []; let p = 1.0700;
  for (let i = 0; i < 60; i++) { p += 0.0001 * Math.sin(i / 5); px.push(p); }
  for (let i = 0; i < 30; i++) { p += 0.0006; px.push(p); }
  for (let i = 0; i < 10; i++) { p -= 0.0005; px.push(p); }
  for (let i = 0; i < 10; i++) { p += 0.0005; px.push(p); }
  for (let i = 0; i < 14; i++) { p -= 0.0004; px.push(p); }
  return px.map((c, i) => ({ t: 1790000000 + i * 3600, o: c - 0.0001, h: c + 0.0004, l: c - 0.0004, c }));
}
const opts = f => ({ pip: 0.0001, key: 'EURUSD|H1', tf: 'H1', formations: f });

check('the fixture is long enough for the Combined Read to reach its trigger reading', () => {
  const g = engines(FIXED), o = g.BWConfluence.read(doubleTop(), opts(null));
  assert.ok(o && o.ok && o.trig, 'too short a fixture proves nothing');
});

console.log('\nTHE BUG — your original patterns.html');
check('reproduced: a REAL formation crashes the Combined Read', () => {
  const g = engines(ORIG), cd = doubleTop();
  const forms = g.BWFormations.read(g.BWChartPatterns.detect(cd).patterns, cd, { pip: 0.0001 });
  assert.ok(forms.length >= 1, 'the fixture really contains a formation');
  assert.throws(() => g.BWConfluence.read(cd, opts(forms)), /toLowerCase is not a function/);
});

console.log('\nTHE FIX');
check('the same real formation no longer crashes it', () => {
  const g = engines(FIXED), cd = doubleTop();
  const forms = g.BWFormations.read(g.BWChartPatterns.detect(cd).patterns, cd, { pip: 0.0001 });
  g.BWConfluence.read(cd, opts(forms));
});

check('and the Combined Read now SEES it — a Double Top, pointing down', () => {
  const g = engines(FIXED), cd = doubleTop();
  const forms = g.BWFormations.read(g.BWChartPatterns.detect(cd).patterns, cd, { pip: 0.0001 });
  const o = g.BWConfluence.read(cd, opts(forms));
  const all = [].concat(...(o.trig && o.trig.groups || []).map(gr => gr.members || [gr]));
  const hit = all.find(m => m.formation) || (o.trig && o.trig.lead && o.trig.lead.formation ? o.trig.lead : null);
  assert.ok(hit, 'a formation reached the trigger reading: ' + JSON.stringify(o.trig && o.trig.lead));
  assert.strictEqual(hit.name, 'Double Top');
  assert.strictEqual(hit.dir, 'down');
});

check('a FAILED shape reads its flipped direction (effectiveDir), not its original one', () => {
  const g = engines(FIXED), cd = doubleTop();
  const o = g.BWConfluence.read(cd, opts([{ lead: { name: 'Double Top', dir: -1, effectiveDir: 1, startI: 40, endI: 60 } }]));
  const all = [].concat(...(o.trig && o.trig.groups || []).map(gr => gr.members || [gr]));
  const hit = all.find(m => m.formation) || o.trig.lead;
  assert.strictEqual(hit.dir, 'up');
});

check('older callers passing words still work', () => {
  const g = engines(FIXED), cd = doubleTop();
  g.BWConfluence.read(cd, opts([{ lead: { name: 'X', direction: 'bearish', startI: 40, endI: 60 } }]));
});

check('no formations at all still behaves exactly as before', () => {
  const g = engines(FIXED), cd = doubleTop();
  g.BWConfluence.read(cd, opts(null)); g.BWConfluence.read(cd, opts([]));
});

check('the call site: read() is given (patterns, candles, opts), and reuses the chart tab\'s formations', () => {
  const h = fs.readFileSync(FIXED, 'utf8');
  assert.ok(!/BWFormations\.read\(cd, \{symbol:pair, timeframe:tf\}\)/.test(h), 'the broken call is gone');
  assert.ok(/CPV\.cd === cd && Array\.isArray\(CPV\.forms\)\) forms = CPV\.forms/.test(h), 'same series -> same formations as the chart');
  assert.ok(/BWFormations\.read\(\(det && det\.patterns\) \|\| \[\], cd, \{ pip: pipOf\(pair\) \}\)/.test(h));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
