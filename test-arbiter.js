// test-arbiter.js — Phase 1 verification. Run: node test-arbiter.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const mount = require('./arbiter-route.js');

let failures = 0, passes = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passes++; console.log('  ok   ' + name); },
    e  => { failures++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  );
}

// ─── a tiny PostgREST: only the query shapes the module uses ─────────
function makeDb() {
  const tables = { arbiter_accounts: [], arbiter_errors: [], arbiter_positions: [] };
  let ids = 1;
  const UNIQUE = {
    arbiter_accounts:  ['user_id', 'account_number'],
    arbiter_positions: ['user_id', 'account_number', 'ticket']
  };
  function parse(url) {
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    const filters = [];
    let order = null, limit = null, onConflict = null;
    for (const [k, v] of u.searchParams) {
      if (k === 'select') continue;
      if (k === 'order') { order = v; continue; }
      if (k === 'limit') { limit = +v; continue; }
      if (k === 'on_conflict') { onConflict = v.split(','); continue; }
      const i = v.indexOf('.'); filters.push([k, v.slice(0, i), v.slice(i + 1)]);
    }
    return { table, filters, order, limit, onConflict };
  }
  const match = (row, f) => f.every(([k, op, v]) => {
    const r = row[k];
    if (op === 'eq')  return String(r) === v;
    if (op === 'is')  return v === 'null' ? (r === null || r === undefined) : false;
    if (op === 'gte') return String(r) >= v;
    throw new Error('unsupported op ' + op);
  });
  const err = (status, msg) => { const e = new Error(msg); e.response = { status, data: { message: msg } }; return e; };
  const clone = o => JSON.parse(JSON.stringify(o));

  return {
    tables,
    http: {
      async get(url) {
        const q = parse(url);
        let rows = tables[q.table].filter(r => match(r, q.filters));
        if (q.order) { const [c, d] = q.order.split('.'); rows.sort((a, b) => (a[c] > b[c] ? 1 : -1) * (d === 'desc' ? -1 : 1)); }
        if (q.limit) rows = rows.slice(0, q.limit);
        return { data: clone(rows) };
      },
      async post(url, body, cfg) {
        const q = parse(url);
        const prefer = (cfg && cfg.headers && cfg.headers.Prefer) || '';
        const t = tables[q.table];
        const row = Object.assign({ id: ids++ }, clone(body));
        // partial unique: one OPEN episode per key
        if (q.table === 'arbiter_errors' &&
            t.some(r => r.user_id === row.user_id && r.account_number === row.account_number &&
                        r.episode_key === row.episode_key && !r.closed_at))
          throw err(409, 'duplicate open episode');
        const uk = UNIQUE[q.table];
        if (uk) {
          const existing = t.find(r => uk.every(k => String(r[k]) === String(row[k])));
          if (existing) {
            if (prefer.includes('ignore-duplicates')) return { data: [] };
            if (prefer.includes('merge-duplicates')) { const id = existing.id; Object.assign(existing, row, { id }); return { data: [clone(existing)] }; }
            throw err(409, 'duplicate key');
          }
        }
        t.push(row);
        return { data: prefer.includes('return=representation') ? [clone(row)] : [] };
      },
      async patch(url, body) {
        const q = parse(url);
        const rows = tables[q.table].filter(r => match(r, q.filters));
        rows.forEach(r => Object.assign(r, clone(body)));
        return { data: [] };
      }
    }
  };
}

// ─── a fake host: state, candle store, clock ────────────────────────
function makeHost(db, opts = {}) {
  const states = {}, candles = {};
  let clock = opts.start || Date.UTC(2026, 8, 21, 9, 0, 0);
  const routes = {};
  const app = { get: (p, ...h) => { routes[p] = h[h.length - 1]; } };
  const normalisePair = s => String(s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
  const scope = (u, s) => u + '::' + s;
  const deps = {
    http: db.http, now: () => clock, log: { warn() {}, error() {} },
    requirePlan: () => (req, res, next) => next && next(),
    getState: (u, s) => (states[scope(u, s)] = states[scope(u, s)] || { openTrades: [], closedTrades: [], accountInfo: {} }),
    getCandlesStore: (u, s) => (candles[scope(u, s)] = candles[scope(u, s)] || {}),
    livePriceFor: (u, s, sym) => {
      const st = states[scope(u, s)] || {};
      return (st.prices && st.prices[sym]) || null;
    },
    normalisePair,
    getNews: () => opts.news || [],
    getRiskSettings: async () => opts.rule ? { rorRisk: String(opts.rule) } : {},
    SUPABASE_URL: 'https://db.test', supabaseServiceHeaders: (x = {}) => x
  };
  const arb = mount(app, deps);
  return {
    arb, routes, deps,
    advance: ms => { clock += ms; },
    now: () => clock,
    state: (u, s) => deps.getState(u, s),
    candles: (u, s) => deps.getCandlesStore(u, s),
    beat: (u, s, a) => arb.onHeartbeat(u, s, a)
  };
}

const U = 'user-1', U2 = 'user-2', SRC = 'key-1', A = '1001', B = '2002';
const MIN = 60000;
const trade = (o) => Object.assign({ ticket: 11, symbol: 'EURUSDm', type: 'buy', volume: 0.2,
  openPrice: 1.1000, sl: 1.0950, tp: 1.1100, profit: 0, riskPct: 1.0, openTime: 0 }, o);

(async () => {
  console.log('\nERROR EPISODES');

  await check('no-SL opens an episode, closes when the stop is set, duration is exact', async () => {
    const db = makeDb(), h = makeHost(db);
    const s = h.state(U, SRC);
    s.openTrades = [trade({ sl: 0, openTime: Math.floor(h.now() / 1000) })];
    await h.beat(U, SRC, A);
    let eps = db.tables.arbiter_errors.filter(r => r.type === 'no_sl');
    assert.strictEqual(eps.length, 1, 'one episode');
    assert.strictEqual(eps[0].closed_at, undefined);
    for (let i = 0; i < 41; i++) { h.advance(MIN); await h.beat(U, SRC, A); }   // 41 minutes, still no stop
    s.openTrades = [trade({ sl: 1.0950, openTime: s.openTrades[0].openTime })];
    h.advance(MIN); await h.beat(U, SRC, A);
    eps = db.tables.arbiter_errors.filter(r => r.type === 'no_sl');
    assert.strictEqual(eps.length, 1, 'still one row, no twins');
    assert.strictEqual(eps[0].close_reason, 'resolved');
    const mins = (Date.parse(eps[0].closed_at) - Date.parse(eps[0].opened_at)) / MIN;
    assert.strictEqual(mins, 42, 'closed on the beat the stop appeared: 42 min');
  });

  await check('the episode keeps its "first" record after many touches', async () => {
    const db = makeDb(), h = makeHost(db);
    const s = h.state(U, SRC);
    s.openTrades = [trade({ sl: 0, openTime: Math.floor(h.now() / 1000) })];
    await h.beat(U, SRC, A);
    for (let i = 0; i < 5; i++) { h.advance(2 * MIN); await h.beat(U, SRC, A); }
    const ep = db.tables.arbiter_errors[0];
    assert.ok(ep.context.first && ep.context.first.title, 'first survives');
    assert.ok(/No Stop Loss/.test(ep.context.first.title));
  });

  await check('a server restart does NOT open a duplicate episode', async () => {
    const db = makeDb();
    let h = makeHost(db);
    const t0 = h.now();
    h.state(U, SRC).openTrades = [trade({ sl: 0, openTime: Math.floor(t0 / 1000) })];
    await h.beat(U, SRC, A);
    // "restart": fresh module, empty memory, same database, same clock
    const h2 = makeHost(db, { start: t0 + 2 * MIN });
    h2.state(U, SRC).openTrades = [trade({ sl: 0, openTime: Math.floor(t0 / 1000) })];
    await h2.beat(U, SRC, A);
    const open = db.tables.arbiter_errors.filter(r => r.type === 'no_sl' && !r.closed_at);
    assert.strictEqual(open.length, 1, 'still exactly one open episode');
  });

  await check('an EA offline for 30 min: clock stops at last-seen, not at return', async () => {
    const db = makeDb(), h = makeHost(db);
    const s = h.state(U, SRC);
    s.openTrades = [trade({ sl: 0, openTime: Math.floor(h.now() / 1000) })];
    await h.beat(U, SRC, A);
    h.advance(5 * MIN); await h.beat(U, SRC, A);          // seen true at +5
    h.advance(30 * MIN); await h.beat(U, SRC, A);         // back at +35, still no stop
    const rows = db.tables.arbiter_errors.filter(r => r.type === 'no_sl');
    assert.strictEqual(rows.length, 2, 'old closed, new opened');
    const old = rows.find(r => r.closed_at);
    assert.strictEqual(old.close_reason, 'unobserved');
    assert.strictEqual((Date.parse(old.closed_at) - Date.parse(old.opened_at)) / MIN, 5, 'counted 5, not 35');
  });

  await check('switching MT5 account: old account\'s episodes close where last seen', async () => {
    const db = makeDb(), h = makeHost(db);
    const s = h.state(U, SRC);
    s.openTrades = [trade({ sl: 0, openTime: Math.floor(h.now() / 1000) })];
    await h.beat(U, SRC, A);
    h.advance(3 * MIN); await h.beat(U, SRC, A);          // last seen on A at +3
    s.openTrades = [];                                     // now on account B, flat
    for (let i = 0; i < 20; i++) { h.advance(MIN); await h.beat(U, SRC, B); }
    await new Promise(r => setTimeout(r, 5));              // let the sweep finish
    const ep = db.tables.arbiter_errors.find(r => r.account_number === A);
    assert.strictEqual(ep.close_reason, 'unobserved');
    assert.strictEqual((Date.parse(ep.closed_at) - Date.parse(ep.opened_at)) / MIN, 3);
    assert.strictEqual(db.tables.arbiter_accounts.length, 2, 'both accounts on the timeline');
  });

  await check('revenge: entry 9 min after a closed loss, keyed to the new ticket', async () => {
    const db = makeDb(), h = makeHost(db);
    const s = h.state(U, SRC);
    const nowS = Math.floor(h.now() / 1000);
    s.closedTrades = [{ ticket: 5, symbol: 'GBPUSDm', profit: -42, time: nowS - 9 * 60 }];
    s.openTrades = [trade({ ticket: 12, symbol: 'GBPUSDm', openTime: nowS })];
    await h.beat(U, SRC, A);
    const ep = db.tables.arbiter_errors.find(r => r.type === 'revenge');
    assert.ok(ep, 'revenge recorded');
    assert.strictEqual(ep.episode_key, 'revenge:12');
    assert.strictEqual(ep.symbol, 'GBPUSD', 'symbol normalised — suffix stripped');
    assert.strictEqual(ep.context.first.metric.gapSeconds, 540);
  });

  await check('oversize at 3%, own-rule breach at 1.8% against a 1% rule, and total', async () => {
    const db = makeDb(), h = makeHost(db, { rule: 1 });
    const s = h.state(U, SRC);
    const nowS = Math.floor(h.now() / 1000) - 3600;
    s.openTrades = [trade({ ticket: 21, riskPct: 3.0, openTime: nowS }), trade({ ticket: 22, riskPct: 1.8, openTime: nowS })];
    await h.beat(U, SRC, A);
    const types = db.tables.arbiter_errors.map(r => r.episode_key).sort();
    assert.deepStrictEqual(types, ['cumulative', 'oversize:21', 'own_rule:22', 'own_total']);
  });

  await check('severity escalation is persisted and peak metrics only widen', async () => {
    const db = makeDb(), h = makeHost(db);
    const s = h.state(U, SRC);
    const t0 = Math.floor(h.now() / 1000) - 3600;
    s.openTrades = [trade({ ticket: 31, riskPct: 1.5, openTime: t0 }), trade({ ticket: 32, riskPct: 1.0, openTime: t0 })];
    await h.beat(U, SRC, A);                                          // 2.5% total → medium
    s.openTrades = [trade({ ticket: 31, riskPct: 3.0, openTime: t0 }), trade({ ticket: 32, riskPct: 1.5, openTime: t0 })];
    h.advance(10000); await h.beat(U, SRC, A);                        // 4.5% → high, inside the touch throttle
    s.openTrades = [trade({ ticket: 31, riskPct: 1.5, openTime: t0 }), trade({ ticket: 32, riskPct: 1.0, openTime: t0 })];
    h.advance(2 * MIN); await h.beat(U, SRC, A);
    const ep = db.tables.arbiter_errors.find(r => r.episode_key === 'cumulative');
    assert.strictEqual(ep.severity, 'high', 'escalation written immediately, not on the next minute');
    assert.strictEqual(ep.context.peak.totalRiskPct, 4.5, 'peak kept even after it came back down');
  });

  await check('two users are throttled independently (no global lock)', async () => {
    const db = makeDb(), h = makeHost(db);
    const nowS = Math.floor(h.now() / 1000);
    h.state(U, SRC).openTrades = [trade({ sl: 0, openTime: nowS })];
    h.state(U2, SRC).openTrades = [trade({ sl: 0, ticket: 99, openTime: nowS })];
    await Promise.all([h.beat(U, SRC, A), h.beat(U2, SRC, B)]);
    assert.strictEqual(db.tables.arbiter_errors.filter(r => r.type === 'no_sl').length, 2);
  });

  console.log('\nMFE / MAE');

  await check('buy: entry bar excluded, later bars and live price counted', async () => {
    const db = makeDb(), h = makeHost(db);
    const s = h.state(U, SRC);
    const openS = Math.floor(h.now() / 1000);
    h.candles(U, SRC).EURUSDm = { candlesByTF: { H1: [
      { t: openS - 1800, o: 1.1000, h: 1.1100, l: 1.0900, c: 1.1000 },   // entry bar: must NOT count
      { t: openS + 1800, o: 1.1000, h: 1.1025, l: 1.0990, c: 1.1010 }
    ] } };
    s.prices = { EURUSD: 1.1010 };
    s.openTrades = [trade({ openTime: openS, profit: 4 })];
    await h.beat(U, SRC, A);
    const p = db.tables.arbiter_positions[0];
    assert.strictEqual(p.mfe_pips, 25);
    assert.strictEqual(p.mae_pips, 10);
    assert.strictEqual(p.symbol, 'EURUSD'); assert.strictEqual(p.raw_symbol, 'EURUSDm');
  });

  await check('water marks never shrink, even when the candle store is wiped', async () => {
    const db = makeDb(), h = makeHost(db);
    const s = h.state(U, SRC);
    const openS = Math.floor(h.now() / 1000);
    h.candles(U, SRC).EURUSDm = { candlesByTF: { H1: [{ t: openS + 60, o: 1.1, h: 1.1025, l: 1.0980, c: 1.1 }] } };
    s.openTrades = [trade({ openTime: openS })];
    await h.beat(U, SRC, A);
    delete h.candles(U, SRC).EURUSDm;                      // account-switch style wipe
    s.prices = { EURUSD: 1.1005 };
    h.advance(2 * MIN); await h.beat(U, SRC, A);
    const p = db.tables.arbiter_positions[0];
    assert.strictEqual(p.mfe_pips, 25, 'best kept');
    assert.strictEqual(p.mae_pips, 20, 'worst kept');
  });

  await check('sell side mirrors, gold uses its own pip size', async () => {
    const db = makeDb(), h = makeHost(db);
    const s = h.state(U, SRC);
    const openS = Math.floor(h.now() / 1000);
    h.candles(U, SRC).XAUUSDc = { candlesByTF: { H1: [{ t: openS + 60, o: 2340, h: 2342.5, l: 2331.0, c: 2335 }] } };
    s.openTrades = [trade({ ticket: 41, symbol: 'XAUUSDc', type: 'sell', openPrice: 2340.0, openTime: openS })];
    await h.beat(U, SRC, A);
    const p = db.tables.arbiter_positions[0];
    assert.strictEqual(p.mfe_pips, 90, 'sell: 2340 - 2331 = 9.0 = 90 gold pips');
    assert.strictEqual(p.mae_pips, 25, 'sell: 2342.5 - 2340 = 2.5 = 25 gold pips');
  });

  await check('floating-profit water marks come straight from the EA', async () => {
    const db = makeDb(), h = makeHost(db);
    const s = h.state(U, SRC);
    const openS = Math.floor(h.now() / 1000);
    for (const pl of [5, 31, -12, 8]) {
      s.openTrades = [trade({ openTime: openS, profit: pl })];
      await h.beat(U, SRC, A); h.advance(2 * MIN);
    }
    const p = db.tables.arbiter_positions[0];
    assert.strictEqual(p.best_pl, 31); assert.strictEqual(p.worst_pl, -12);
  });

  await check('a closed position is stamped closed, and a restart does not reopen it', async () => {
    const db = makeDb(), h = makeHost(db);
    const s = h.state(U, SRC);
    s.openTrades = [trade({ openTime: Math.floor(h.now() / 1000) })];
    await h.beat(U, SRC, A);
    s.openTrades = []; h.advance(MIN); await h.beat(U, SRC, A);
    assert.strictEqual(db.tables.arbiter_positions[0].close_reason, 'closed');
    const h2 = makeHost(db, { start: h.now() + MIN });
    await h2.beat(U, SRC, A);
    assert.strictEqual(db.tables.arbiter_positions.length, 1);
  });

  console.log('\nACCOUNTS');

  await check('starting balance is written once and never overwritten', async () => {
    const db = makeDb(), h = makeHost(db);
    const s = h.state(U, SRC);
    s.accountInfo = { balance: 2000, currency: 'USD', equity: 2000, margin: 0 };
    await h.beat(U, SRC, A);
    s.accountInfo = { balance: 2450, currency: 'USD', equity: 2450, margin: 0 };
    h.advance(11 * MIN); await h.beat(U, SRC, A);
    const a = db.tables.arbiter_accounts[0];
    assert.strictEqual(a.starting_balance, 2000);
    assert.strictEqual(a.last_balance, 2450);
    assert.strictEqual(a.kind, 'unknown', 'not guessed');
  });

  await check('revenge is detected across the full 30-minute cooldown', async () => {
    const db = makeDb(), h = makeHost(db);
    const s = h.state(U, SRC);
    const nowS = Math.floor(h.now() / 1000);
    s.closedTrades = [{ ticket: 5, symbol: 'EURUSDm', profit: -30, time: nowS - 20 * 60 }];
    s.openTrades = [trade({ ticket: 77, openTime: nowS })];   // 20 min after the loss
    await h.beat(U, SRC, A);
    const ep = db.tables.arbiter_errors.find(r => r.type === 'revenge');
    assert.ok(ep, 'a 20-minute re-entry breaks a 30-minute cooldown and is flagged');
    assert.strictEqual(ep.context.first.metric.gapSeconds, 1200);
  });

  console.log('\nPARITY WITH THE ASSISTANT TAB (real index.html code)');

  await check('server rules raise the same conditions as analyzeErrors in index.html', async () => {
    const html = fs.readFileSync('/mnt/user-data/uploads/index.html', 'utf8');
    const grab = (start, end) => { const i = html.indexOf(start); const j = html.indexOf(end, i); return html.slice(i, j); };
    const src = 'const OVERTRADE_LIMIT = 6;\n' +
      grab('function readRiskRule(){', '/* ── FOLLOW THE RULE') +
      grab('function analyzeErrors(){', "document.getElementById('errCount')") + ' return errors; }';
    const nowS = Math.floor(Date.UTC(2026, 8, 21, 12, 0, 0) / 1000);
    const fixtures = [
      { name: 'clean', open: [trade({ openTime: nowS - 7200 })], closed: [], acct: { equity: 5000, margin: 100 } },
      { name: 'no stop', open: [trade({ sl: 0, openTime: nowS - 7200 })], closed: [], acct: {} },
      { name: 'oversize', open: [trade({ riskPct: 3.1, openTime: nowS - 7200 })], closed: [], acct: {} },
      { name: 'revenge', open: [trade({ ticket: 9, openTime: nowS - 60 })], closed: [{ symbol: 'EURUSD', profit: -20, time: nowS - 600 }], acct: {} },
      { name: 'rapid', open: [1, 2, 3].map(i => trade({ ticket: i, openTime: nowS - 60 * i })), closed: [], acct: {} },
      { name: 'overtrade', open: [trade({ openTime: nowS - 60 * 60 })], closed: [1, 2, 3, 4, 5].map(i => ({ symbol: 'EURUSD', profit: -5, time: nowS - 3600 * i })), acct: {} },
      { name: 'cumulative', open: [trade({ ticket: 1, riskPct: 1.5, openTime: nowS - 7200 }), trade({ ticket: 2, riskPct: 1.5, openTime: nowS - 7200 })], closed: [], acct: {} },
      { name: 'margin', open: [trade({ openTime: nowS - 7200 })], closed: [], acct: { equity: 1000, margin: 600 } },
      { name: 'margin used', open: [trade({ openTime: nowS - 7200 })], closed: [], acct: { equity: 1000, margin: 350 } },
      { name: 'news', open: [trade({ openTime: nowS - 7200 })], closed: [], acct: {}, news: [{ title: 'CPI', impact: 'high', timestamp: nowS + 300 }] }
    ];
    // Map the tab's titles to the server's types, by the condition each describes.
    const tabType = t => /^No Stop Loss/.test(t) ? 'no_sl' : /^Oversize/.test(t) ? 'oversize'
      : /Revenge/.test(t) ? 'revenge' : /^Rapid/.test(t) ? 'rapid' : /^Overtrading/.test(t) ? 'overtrade'
      : /HIGH Impact News/.test(t) ? 'news_exposure' : /^Cumulative/.test(t) ? 'cumulative'
      : /^Margin level/.test(t) ? 'margin_level' : /committed as margin/.test(t) ? 'margin_used'
      : /No risk rule set/.test(t) ? 'no_rule' : 'UNMAPPED:' + t;
    for (const f of fixtures) {
      const ctx = { state: { openTrades: f.open, closedTrades: f.closed, accountInfo: f.acct, news: f.news || [] },
        Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(nowS * 1000); } static now() { return nowS * 1000; } },
        localStorage: { getItem: () => null }, Math, parseFloat, parseInt, isFinite, JSON, console };
      vm.createContext(ctx);
      vm.runInContext(src, ctx);
      // JSON round-trip: arrays built inside a vm context have a different Array prototype
      const tab = JSON.parse(JSON.stringify(vm.runInContext('analyzeErrors()', ctx))).map(e => tabType(e.title))
        .filter(t => t !== 'no_rule')                       // deliberately not recorded server-side
        .sort();
      const srv = mount.evaluateErrors({ openTrades: f.open, closedTrades: f.closed, accountInfo: f.acct,
        news: f.news || [], riskRule: null, nowSec: nowS }).map(e => e.type).sort();
      // Every fixture keeps its revenge gap inside 15 min, where the two
      // agree. The ONE intended divergence (16-30 min, where Arbiter flags
      // and the tab does not) is covered by its own test above, and goes
      // away if the tab's window is widened to match — see revenge-window.patch.
      assert.deepStrictEqual(srv, tab, f.name + ': server ' + JSON.stringify(srv) + ' vs tab ' + JSON.stringify(tab));
    }
  });

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures ? 1 : 0);
})();
