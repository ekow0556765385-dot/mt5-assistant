// test-formations.js — the whole chain on REAL code: the chart patterns tab's
// detector finds a formation, publishFormations writes it, Arbiter's feeds
// read it, and the engine turns it into pressure against an open trade.
'use strict';
const assert = require('assert');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/out/patterns.html', 'utf8').replace(/[^\x09\x0a\x20-\x7e]/g, '');
function iife(marker) {
  const e = html.indexOf(marker), b = html.lastIndexOf('(function(root){', e);
  let end = html.indexOf('})(', e); end = html.indexOf(';', end) + 1;
  return html.slice(b, end);
}
const store = {};
global.window = global;
global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
new Function(iife('root.BWChartPatterns'))();
new Function(iife('root.BWFormations={read'))();
global.pair = 'EURUSD'; global.tf = 'H1'; global.brokerSym = { EURUSD: 'EURUSDm' };
window.BWRange = { pipOf: () => 0.0001 };
const pubSrc = html.slice(html.indexOf('function publishFormations(forms, cd){'), html.indexOf('function publishConfluence(o, cd){'));
global.publishFormations = new Function(pubSrc + '; return publishFormations;')();
require('./arbiter-feeds.js');
const F = window.BWArbiterFeeds, E = require('./arbiter-engine.js');

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }

// candles with a clear DOUBLE TOP, falling back toward its neckline
function doubleTop() {
  const px = []; let p = 1.0700;
  for (let i = 0; i < 30; i++) { p += 0.0006; px.push(p); }
  for (let i = 0; i < 10; i++) { p -= 0.0005; px.push(p); }
  for (let i = 0; i < 10; i++) { p += 0.0005; px.push(p); }
  for (let i = 0; i < 14; i++) { p -= 0.0004; px.push(p); }
  return px.map((c, i) => ({ t: 1790000000 + i * 3600, o: c - 0.0001, h: c + 0.0004, l: c - 0.0004, c }));
}
function publish(cd) {
  const res = BWChartPatterns.detect(cd);
  publishFormations(BWFormations.read(res.patterns || [], cd, { pip: 0.0001 }), cd);
  return cd[cd.length - 1].c;
}

console.log('\nFORMATIONS — chart tab to Arbiter, on real code');

check('the chart tab publishes what it sees, in its own words', () => {
  publish(doubleTop());
  const r = JSON.parse(store['bw-formations-now']).reads['EURUSD|H1'];
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].name, 'Double Top');
  assert.strictEqual(r.items[0].dir, 'bearish');
});

check('Arbiter reads it, with the neckline distance measured from ITS current price', () => {
  const price = publish(doubleTop());
  const fm = F._internals.formationsFor('EURUSD', 'H1', price);
  assert.strictEqual(fm.length, 1);
  assert.strictEqual(fm[0].direction, 'bearish');
  assert.ok(fm[0].completion >= 0.5, 'completion ' + fm[0].completion);
  assert.ok(fm[0].necklinePips != null && fm[0].necklinePips < 15, 'neckline in reach: ' + fm[0].necklinePips);
});

check('a double top against an open LONG becomes pressure — "Opposing formation"', () => {
  const price = publish(doubleTop());
  const world = { symbol: 'EURUSD', price, atr: 0.0012, structure: { regime: 'uptrend', confidence: 0.8 },
    formations: F._internals.formationsFor('EURUSD', 'H1', price), patterns: [], zones: [], news: [], openPositions: [] };
  const pos = { ticket: '1', side: 'buy', openPrice: price - 0.0010, tp: price + 0.0060, floatingPips: 10, mfePips: 14, stopPips: 30 };
  pos.entryCase = E.freezeEntryCase(world, pos);
  const j = E.judgePosition(world, pos);
  const f = j.pressure.factors.find(x => x.id === 'formation');
  assert.ok(f, 'factors: ' + j.pressure.factors.map(x => x.id).join(','));
  assert.strictEqual(f.points, 10, 'neckline in reach = 10 points');
  assert.ok(/Double Top/.test(f.detail));
});

check('the SAME formation against a SHORT adds nothing — it agrees with the trade', () => {
  const price = publish(doubleTop());
  const world = { symbol: 'EURUSD', price, formations: F._internals.formationsFor('EURUSD', 'H1', price), patterns: [], zones: [] };
  const pos = { ticket: '2', side: 'sell', openPrice: price + 0.0010, tp: price - 0.0060, floatingPips: 10, mfePips: 12, stopPips: 30 };
  const j = E.judgePosition(world, pos);
  assert.ok(!j.pressure.factors.some(x => x.id === 'formation'));
});

check('another pair or timeframe is never mixed in', () => {
  publish(doubleTop());
  assert.strictEqual(F._internals.formationsFor('GBPUSD', 'H1', 1.27), null);
  assert.strictEqual(F._internals.formationsFor('EURUSD', 'H4', 1.08), null);
});

check('a stale read (chart tab closed 10 minutes ago) is not used', () => {
  publish(doubleTop());
  const ch = JSON.parse(store['bw-formations-now']);
  ch.t -= 10 * 60000; ch.reads['EURUSD|H1'].t -= 10 * 60000;
  store['bw-formations-now'] = JSON.stringify(ch);
  assert.strictEqual(F._internals.formationsFor('EURUSD', 'H1', 1.08), null);
});

check('failed and invalidated shapes are never published — answered questions', () => {
  publishFormations([{ lead: { name: 'Double Top', dir: -1, effectiveDir: 1, life: { state: 'failed' }, completion: 100 } },
                     { lead: { name: 'Triple Top', dir: -1, life: { state: 'invalidated' }, completion: 0 } }], doubleTop());
  assert.strictEqual(JSON.parse(store['bw-formations-now']).reads['EURUSD|H1'].items.length, 0);
});

check('a neckline broken and held in the last 3 bars is published as BROKEN — a cut signal', () => {
  publishFormations([{ lead: { name: 'Head & Shoulders', dir: -1, trigger: 1.08, life: { state: 'confirmed', barsSince: 2 }, completion: 100 } }], doubleTop());
  const fm = F._internals.formationsFor('EURUSD', 'H1', 1.078);
  assert.strictEqual(fm[0].broken, true);
});

check('the publisher never throws on junk — it must not break the chart tab', () => {
  publishFormations(null, null); publishFormations([{}, { lead: null }], []);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
