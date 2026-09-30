// test-combined-read.js — Arbiter's Combined Read must BE the Pattern Detector's.
// The reference is the REAL patterns.html, loaded headless and left to compute
// its own read (window.__cfLast). Arbiter's host runs on identical data and every
// field is compared. Drift guards fail if any copied piece and the page diverge.
'use strict';
const assert = require('assert');
const fs = require('fs');
const { JSDOM } = require('jsdom');
const acorn = require('/home/claude/cr/node_modules/acorn');
const PAGE = '/home/claude/pd/patterns.html';
const HTML = fs.readFileSync(PAGE, 'utf8');

let pass = 0, fail = 0;
async function check(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }

function market(n, seed, start, step) { let s = seed, p = start; const out = [], t0 = 1790000000;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const dp = start > 100 ? 2 : start > 10 ? 3 : 5;
  for (let i = 0; i < n; i++) { const o = p; p += (r() - 0.48) * step; const h = Math.max(o, p) + r() * step * .5, l = Math.min(o, p) - r() * step * .5;
    out.push({ time: t0 + i * 3600, open: +o.toFixed(dp), high: +h.toFixed(dp), low: +l.toFixed(dp), close: +p.toFixed(dp), tick_volume: Math.round(500 + r() * 900) }); }
  return out; }
function routesFor(sym, seed, start, step) {
  const H1 = market(220, seed, start, step), H4 = market(140, seed + 7, start, step * 2);
  return {
    '/api/state': { watchlist: [{ symbol: sym, bid: H1[H1.length - 1].close }], openTrades: [], accountInfo: { login: 1 } },
    '/api/candles': { symbol: sym, candlesByTF: { H1, H4 } },
    '/api/patterns': { patterns: [{ name: 'Bullish Engulfing', type: 'bullish', confidence_pct: 78, bar_index: 2 }] },
    '/api/alerts': [], '/smc': {}, '/api/me': { ok: true, plan: 'pro' } };
}
const mkFetch = routes => (u) => { const path = String(u).replace(/^https?:\/\/[^/]+/, '').split('?')[0], body = routes[path];
  return Promise.resolve({ ok: body !== undefined, status: body !== undefined ? 200 : 404,
    json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) }); };

async function pageRead(routes, risk) {
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://app.blackwoodmt5.com/patterns',
    beforeParse(w) { w.fetch = mkFetch(routes); if (risk) w.localStorage.setItem('bw-risk-now', JSON.stringify(risk));
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({}) });
      w.WebSocket = function () { return { close() {}, send() {} }; };
      w.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} }); } });
  for (let i = 0; i < 60 && !dom.window.__cfLast; i++) await new Promise(r => setTimeout(r, 100));
  return dom.window;
}
function arbiter(routes, risk) {
  const a = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously', url: 'https://app.blackwoodmt5.com/arbiter',
    beforeParse(w) { w.fetch = mkFetch(routes); if (risk) w.localStorage.setItem('bw-risk-now', JSON.stringify(risk)); } });
  ['structure', 'extremes', 'chart-patterns', 'retracement', 'bw-range', 'governor', 'conductor', 'formations', 'pd-liquidity', 'confluence', 'combined-read']
    .forEach(f => a.window.eval(fs.readFileSync(__dirname + '/' + f + '.js', 'utf8')));
  return a.window;
}
const plain = o => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' && !isFinite(v)) ? String(v) : v));
function diff(a, b, path, out) { if (out.length > 8) return out;
  if (typeof a !== typeof b) { out.push(path); return out; }
  if (a && typeof a === 'object') { new Set([...Object.keys(a), ...Object.keys(b || {})]).forEach(k => diff(a[k], (b || {})[k], path + '.' + k, out)); return out; }
  if (a !== b) out.push(path + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b)); return out; }

async function parity(sym, pretty, seed, start, step, risk, runs) {
  const routes = routesFor(sym, seed, start, step);
  const w = await pageRead(routes, risk);
  assert.ok(w.__cfLast, 'the real page produced no read');
  const A = arbiter(routes, risk), host = A.BWCombinedRead.create();
  host.setState(routes['/api/state']);
  await host.load(pretty, 'H1'); host.loadRisk();
  let mine; for (let i = 0; i < (runs || 1); i++) mine = host.run(pretty, 'H1');
  const d = diff(plain(w.__cfLast), plain(mine), 'read', []);
  assert.deepStrictEqual(d, [], 'differs from the real page:\n       ' + d.join('\n       '));
}

(async () => {
  console.log('\nPARITY — Arbiter\'s Combined Read vs the REAL Pattern Detector');
  const RISK = p => ({ t: Date.now(), pairs: { [p]: { name: 'Elevated', level: 'elevated', score: 61, factors: [{ name: 'Spread' }] } } });
  const cases = [
    ['EUR/USD, market 1', 'EURUSDm', 'EURUSD', 11, 1.08, 0.0012],
    ['EUR/USD, market 2', 'EURUSDm', 'EURUSD', 47, 1.08, 0.0012],
    ['EUR/USD, market 3', 'EURUSDm', 'EURUSD', 101, 1.08, 0.0012],
    ['GBP/JPY — a JPY pair', 'GBPJPYm', 'GBPJPY', 23, 193.4, 0.18],
    ['XAU/USD — gold', 'XAUUSDc', 'XAUUSD', 67, 2340, 3.0]
  ];
  for (const [name, sym, pretty, seed, start, step] of cases)
    await check(name + ' — identical, field by field', () => parity(sym, pretty, seed, start, step));
  await check('with Risk Radar published by the Assistant — identical', () =>
    parity('EURUSDm', 'EURUSD', 11, 1.08, 0.0012, RISK('EURUSD')));
  await check('run five times in a row (the governor\'s memory) — still identical', () =>
    parity('EURUSDm', 'EURUSD', 47, 1.08, 0.0012, null, 5));

  await check('the PUBLISHED reading (the channel Arbiter consumes) — identical to the page\'s own', async () => {
    const routes = routesFor('EURUSDm', 47, 1.08, 0.0012);
    const w = await pageRead(routes);
    const pagePub = JSON.parse(w.localStorage.getItem('bw-confluence-now') || 'null');
    assert.ok(pagePub, 'the real page published nothing');
    const A = arbiter(routes), host = A.BWCombinedRead.create();
    host.setState(routes['/api/state']); await host.load('EURUSD', 'H1'); host.loadRisk(); host.run('EURUSD', 'H1');
    // only the write-time stamps may differ: each copy is stamped when it was written
    const noStamp = o => JSON.parse(JSON.stringify(o, (k, v) => (k === 't' || k === 'at' || k === 'ts') ? undefined : v));
    const d = diff(noStamp(pagePub), noStamp(host.channel()), 'published', []);
    assert.deepStrictEqual(d, [], d.join('\n       '));
  });

  console.log('\nNO DRIFT — every copied piece is the page\'s own code');
  const blocks = []; const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m;
  const H = HTML.replace(/\r\n/g, '\n');
  while ((m = re.exec(H))) blocks.push(m[1]);
  function statementWith(marker) { for (const b of blocks) { const k = b.indexOf(marker); if (k < 0) continue;
    const ast = acorn.parse(b, { ecmaVersion: 2022 }); const st = ast.body.find(s => s.start <= k && s.end >= k); return b.slice(st.start, st.end); } }
  const body = f => fs.readFileSync(__dirname + '/' + f, 'utf8').replace(/^\/\*[^\n]*\*\/\n/, '').trim();
  const ENG = { 'structure.js': 'root.BWStructure={read', 'extremes.js': 'root.BWExtremes={read', 'chart-patterns.js': 'root.BWChartPatterns={detect',
    'retracement.js': 'root.BWRetracement={assess', 'bw-range.js': 'root.BWRange', 'governor.js': 'root.BWGovernor2',
    'conductor.js': 'root.BWConductor={create', 'formations.js': 'root.BWFormations={read', 'confluence.js': 'root.BWConfluence' };
  for (const [f, mk] of Object.entries(ENG)) await check(f.padEnd(17) + ' == its statement in patterns.html', () =>
    assert.strictEqual(body(f), statementWith(mk).trim()));
  await check('combined-read.js regenerates byte for byte from THIS patterns.html', () => {
    const host = fs.readFileSync(__dirname + '/combined-read.js', 'utf8');
    require('child_process').execSync('node /home/claude/cr/build-host.js', { cwd: '/home/claude/cr', stdio: 'pipe' });
    assert.strictEqual(fs.readFileSync('/home/claude/cr/combined-read.js', 'utf8'), host, 'regenerating from patterns.html changes the file');
  });

  console.log('\nARBITER NEVER WRITES THE PATTERN DETECTOR\'S CHANNEL');
  await check('running the Combined Read in Arbiter publishes nothing', async () => {
    const routes = routesFor('EURUSDm', 11, 1.08, 0.0012);
    const A = arbiter(routes), host = A.BWCombinedRead.create();
    host.setState(routes['/api/state']); await host.load('EURUSD', 'H1'); host.run('EURUSD', 'H1');
    assert.strictEqual(A.localStorage.getItem('bw-confluence-now'), null, 'the REAL channel must stay untouched');
    assert.ok(host.channel(), 'the reading lives in the host\'s private copy instead');
  });
  await check('each pair gets its OWN formations instance', () => {
    const src = fs.readFileSync(__dirname + '/combined-read.js', 'utf8');
    assert.ok(/formationsByPair\[p\] \|\| \(formationsByPair\[p\] = makeFormations\(\)\)/.test(src));
  });
  await check('fewer than 60 candles: no read, and no error (the fixed page branch)', async () => {
    const routes = routesFor('EURUSDm', 11, 1.08, 0.0012);
    routes['/api/candles'] = { symbol: 'EURUSDm', candlesByTF: { H1: market(40, 3, 1.08, 0.0012), H4: [] } };
    const A = arbiter(routes), host = A.BWCombinedRead.create();
    host.setState(routes['/api/state']); await host.load('EURUSD', 'H1');
    assert.strictEqual(host.run('EURUSD', 'H1'), null);
  });

  console.log('\nIN ARBITER — the world is the same whichever Combined Read it came from');
  function arbiterFull(routes, channel) {
    const a = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously', url: 'https://app.blackwoodmt5.com/arbiter',
      beforeParse(w) { w.fetch = mkFetch(routes); if (channel) w.localStorage.setItem('bw-confluence-now', channel); } });
    ['structure', 'extremes', 'chart-patterns', 'retracement', 'bw-range', 'governor', 'conductor', 'formations', 'pd-liquidity',
     'confluence', 'combined-read', 'arbiter-engine', 'arbiter-feeds'].forEach(f => a.window.eval(fs.readFileSync(__dirname + '/' + f + '.js', 'utf8')));
    return a.window;
  }
  const pick = w => JSON.parse(JSON.stringify({ structure: w.structure, invalidation: w.invalidation, patterns: w.patterns }));
  const routesA = routesFor('EURUSDm', 47, 1.08, 0.0012);
  const realPage = await pageRead(routesA);
  const published = realPage.localStorage.getItem('bw-confluence-now');

  await check('Pattern Detector publishing: Arbiter uses ITS read (A-6)', async () => {
    const W = arbiterFull(routesA, published);
    const w = await W.BWArbiterFeeds.buildWorld('EURUSDm', 'H1');
    assert.strictEqual(w.provenance.structure, 'channel');
  });
  await check('Pattern Detector closed: Arbiter runs the same Combined Read itself, and says so', async () => {
    const W = arbiterFull(routesA, null);
    const w = await W.BWArbiterFeeds.buildWorld('EURUSDm', 'H1');
    assert.strictEqual(w.provenance.structure, 'combined-read-arbiter');
  });
  await check('...and the structure, decisive level and trigger it gives Arbiter are IDENTICAL either way', async () => {
    const a = await arbiterFull(routesA, published).BWArbiterFeeds.buildWorld('EURUSDm', 'H1');
    const b = await arbiterFull(routesA, null).BWArbiterFeeds.buildWorld('EURUSDm', 'H1');
    // not vacuous: both must actually carry a reading
    assert.ok(a.structure && a.structure.regime, 'the published read gave Arbiter no structure');
    assert.ok(b.structure && b.structure.regime, 'Arbiter\'s own run gave no structure');
    const d = diff(pick(a), pick(b), 'world', []);
    assert.deepStrictEqual(d, [], d.join('\n       '));
  });
  await check('a STALE published read (over 5 minutes) is not used — Arbiter runs its own', async () => {
    const old = JSON.parse(published); old.t = Date.now() - 6 * 60 * 1000;
    const w = await arbiterFull(routesA, JSON.stringify(old)).BWArbiterFeeds.buildWorld('EURUSDm', 'H1');
    assert.strictEqual(w.provenance.structure, 'combined-read-arbiter');
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
