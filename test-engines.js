// test-engines.js — the engines Arbiter runs itself must BE the engines the
// pages run. Each file is extracted from its page; if anyone edits one side
// only, these fail. (Drift between copies is what made Arbiter's retracement
// verdict disagree with the Pattern Detector's.)
'use strict';
const assert = require('assert');
const fs = require('fs');
const PATTERNS = '/mnt/user-data/uploads/patterns.html';
const INDEX = '/home/claude/ix/index.html';          // the Assistant, with the broker-time fix
const read = f => fs.readFileSync(f, 'utf8');
const body = f => read(f).replace(/^\/\*[\s\S]*?\*\/\n/, '').trim();   // the file minus its header comment

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }
function iifeFrom(page, marker) {
  const a = page.indexOf(marker), b = page.lastIndexOf('(function(root){', a);
  let e = page.indexOf('})(', a); e = page.indexOf(';', e) + 1;
  return page.slice(b, e).trim();
}

console.log('\nNO DRIFT — each engine file is the code its page runs');
const P = read(PATTERNS), I = read(INDEX);
check('retracement.js  == the retracement engine inside patterns.html', () =>
  assert.strictEqual(body(__dirname + '/retracement.js'), iifeFrom(P, 'root.BWRetracement={assess,stopExposure,swings,baseline};')));
check('structure.js    == the structure engine inside patterns.html', () =>
  assert.strictEqual(body(__dirname + '/structure.js'), iifeFrom(P, 'root.BWStructure={read,pivots,label,efficiency,pivotK,atr};')));
check('chart-patterns.js == the chart-pattern engine inside patterns.html', () =>
  assert.strictEqual(body(__dirname + '/chart-patterns.js'), iifeFrom(P, 'root.BWChartPatterns={detect,swings,lifecycle};')));
check('risk-radar.js   == Risk Radar inside index.html', () => {
  const a = I.indexOf('const RR = window.BWRiskRadar = {};'), b = I.lastIndexOf('(function boot(){', a);
  const m = 'RR.CFG = CFG;\n\n})();', e = I.indexOf(m, a) + m.length;
  assert.strictEqual(body(__dirname + '/risk-radar.js'), I.slice(b, e).trim());
});
check("the host's normalisePair and currency tables == the Assistant's", () => {
  const html = read(__dirname + '/arbiter.html');
  const host = html.slice(html.indexOf('<script data-host="risk-radar">'), html.indexOf('</script>', html.indexOf('<script data-host="risk-radar">')));
  ['function normalisePair(', 'var BW_CCY', 'var BW_BASE'].forEach(k => {
    const grab = src => { const i = src.indexOf(k); return src.slice(i, src.indexOf(k.startsWith('function') ? '\n}' : ';', i) + 2); };
    assert.strictEqual(grab(host), grab(I), k + ' drifted');
  });
});

console.log('\nTHE BUG THIS FIXES — the old retracement.js was an older engine');
function engines(files) {
  const g = { console }; g.window = g; g.globalThis = g;
  files.forEach(f => new Function('window', 'globalThis', read(f))(g, g));
  return g;
}
const market = (() => { const out = []; let p = 1.08, t = 1790000000;
  const bar = c => out.push({ t: (t += 3600), o: c - 0.0001, h: c + 0.0004, l: c - 0.0004, c, v: 900 });
  for (let i = 0; i < 60; i++) { p += 0.0002 * Math.sin(i / 4); bar(p); }
  for (let i = 0; i < 25; i++) { p += 0.0009; bar(p); }
  for (let i = 0; i < 10; i++) { p -= 0.0004; bar(p); }
  return out; })();

check("Arbiter's retracement now gives the Pattern Detector's answer", () => {
  // the page's engines, in the page's order, vs Arbiter's files in Arbiter's order
  const page = engines([]);
  new Function('window', 'globalThis', iifeFrom(P, 'root.BWChartPatterns={detect,swings,lifecycle};'))(page, page);
  new Function('window', 'globalThis', iifeFrom(P, 'root.BWRetracement={assess,stopExposure,swings,baseline};'))(page, page);
  const arb = engines([__dirname + '/chart-patterns.js', __dirname + '/retracement.js']);
  const a = page.BWRetracement.assess({ candles: market, symbol: 'EURUSD' });
  const b = arb.BWRetracement.assess({ candles: market, symbol: 'EURUSD' });
  assert.strictEqual(b.score, a.score); assert.strictEqual(b.verdict, a.verdict);
});

check('THE BUG: the old retracement.js disagreed with the Pattern Detector on real-looking markets', () => {
  const old = engines(['/mnt/user-data/uploads/retracement.js']);
  const page = engines([]);
  new Function('window', 'globalThis', iifeFrom(P, 'root.BWChartPatterns={detect,swings,lifecycle};'))(page, page);
  new Function('window', 'globalThis', iifeFrom(P, 'root.BWRetracement={assess,stopExposure,swings,baseline};'))(page, page);
  const arb = engines([__dirname + '/chart-patterns.js', __dirname + '/retracement.js']);
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let oldDiff = 0, arbDiff = 0, total = 0;
  for (let k = 0; k < 60; k++) {
    const out = []; let p = 1.08, t = 1790000000;
    const bar = (c, w) => out.push({ t: (t += 3600), o: c - 0.0001 * (rnd() - .5), h: c + w * rnd(), l: c - w * rnd(), c, v: 500 + 900 * rnd() });
    const up = rnd() < .5 ? 1 : -1;
    for (let i = 0; i < 50; i++) { p += 0.0003 * (rnd() - .5); bar(p, .0006); }
    for (let i = 0; i < 20 + Math.floor(rnd() * 20); i++) { p += up * 0.0007 * rnd() + 0.0002 * (rnd() - .5); bar(p, .0008); }
    for (let i = 0; i < 5 + Math.floor(rnd() * 25); i++) { p -= up * 0.0006 * rnd(); bar(p, .0008 + .0006 * rnd()); }
    const key = e => { const r = e.BWRetracement.assess({ candles: out, symbol: 'EURUSD' }); return r.ok ? r.score + ' ' + r.verdict : 'none'; };
    const pg = key(page); if (pg === 'none' && key(old) === 'none') continue;
    total++; if (key(old) !== pg) oldDiff++; if (key(arb) !== pg) arbDiff++;
  }
  assert.ok(oldDiff > total / 4, 'the old file disagreed on ' + oldDiff + ' of ' + total);
  assert.strictEqual(arbDiff, 0, 'Arbiter now agrees on every one of ' + total);
});

check('without the chart-pattern engine the score can differ — so it is loaded first', () => {
  const html = read(__dirname + '/arbiter.html');
  assert.ok(html.indexOf('src="/chart-patterns.js"') < html.indexOf('src="/retracement.js"'), 'load order');
});

console.log('\nRISK RADAR IN ARBITER — read-only');
check('the host blocks the Assistant\'s log and nothing else', () => {
  const html = read(__dirname + '/arbiter.html');
  const i = html.indexOf('<script data-host="risk-radar">'), host = html.slice(html.indexOf('>', i) + 1, html.indexOf('</script>', i));
  const writes = [];
  function Storage() {} Storage.prototype.setItem = function (k) { writes.push(k); };
  const g = { Storage, console }; g.window = g;
  new Function('Storage', 'window', host)(Storage, g);
  const s = new Storage();
  s.setItem('bw-risk-log', '[]'); s.setItem('bw-arbiter-now', '{}');
  assert.deepStrictEqual(writes, ['bw-arbiter-now']);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
