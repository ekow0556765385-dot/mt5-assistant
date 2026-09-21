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
  const tables = { arbiter_accounts: [], arbiter_errors: [], arbiter_positions: [], arbiter_calls: [] };
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
        // partial unique: one UNRESOLVED call per call_key
        if (q.table === 'arbiter_calls' &&
            t.some(r => r.user_id === row.user_id && r.call_key === row.call_key && !r.resolved_at))
          throw err(409, 'duplicate open call');
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
  const app = { get: (p, ...h) => { routes['GET ' + p] = h[h.length - 1]; },
                post: (p, ...h) => { routes['POST ' + p] = h[h.length - 1]; } };
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
    resolveSource: () => SRC,
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

var U = 'user-1', U2 = 'user-2', SRC = 'key-1', A = '1001', B = '2002';
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

  await check('20 min after a loss: cooldown breach, NOT revenge', async () => {
    const db = makeDb(), h = makeHost(db);
    const s = h.state(U, SRC);
    const nowS = Math.floor(h.now() / 1000);
    s.closedTrades = [{ ticket: 5, symbol: 'EURUSDm', profit: -30, time: nowS - 20 * 60 }];
    s.openTrades = [trade({ ticket: 77, openTime: nowS })];
    await h.beat(U, SRC, A);
    const types = db.tables.arbiter_errors.map(r => r.type);
    assert.deepStrictEqual(types, ['cooldown_breach'], 'softer type, not revenge');
    assert.strictEqual(db.tables.arbiter_errors[0].severity, 'medium');
  });

  await check('9 min after a loss is revenge and is NOT also counted as a cooldown breach', async () => {
    const db = makeDb(), h = makeHost(db);
    const s = h.state(U, SRC);
    const nowS = Math.floor(h.now() / 1000);
    s.closedTrades = [{ ticket: 5, symbol: 'EURUSDm', profit: -30, time: nowS - 9 * 60 }];
    s.openTrades = [trade({ ticket: 78, openTime: nowS })];
    await h.beat(U, SRC, A);
    assert.deepStrictEqual(db.tables.arbiter_errors.map(r => r.type), ['revenge'], 'no double count');
  });

  await check('31 min after a loss is neither', async () => {
    const db = makeDb(), h = makeHost(db);
    const s = h.state(U, SRC);
    const nowS = Math.floor(h.now() / 1000);
    s.closedTrades = [{ ticket: 5, symbol: 'EURUSDm', profit: -30, time: nowS - 31 * 60 }];
    s.openTrades = [trade({ ticket: 79, openTime: nowS })];
    await h.beat(U, SRC, A);
    assert.strictEqual(db.tables.arbiter_errors.length, 0);
  });

  console.log('\nTHE CALL LEDGER — Assan\'s rules, checked literally');
  const L = mount.ledger;

  await check('the 2x2: every combination lands in the right box', () => {
    assert.strictEqual(L.boxOf(true, 'followed'), 'good');
    assert.strictEqual(L.boxOf(true, 'ignored'), 'expensive');
    assert.strictEqual(L.boxOf(true, 'deviated'), 'expensive', 'deviated counts as not followed');
    assert.strictEqual(L.boxOf(false, 'followed'), 'ours');
    assert.strictEqual(L.boxOf(false, 'ignored'), 'luck');
    assert.strictEqual(L.boxOf(null, 'followed'), null, 'an unclear outcome is never boxed');
  });

  await check('a skip that RUNS is Arbiter wrong; a take is right only if it ran', () => {
    assert.strictEqual(L.correctness('skip', 'ran'), false);
    assert.strictEqual(L.correctness('skip', 'failed'), true);
    assert.strictEqual(L.correctness('skip', 'flat'), true);
    assert.strictEqual(L.correctness('take', 'ran'), true);
    assert.strictEqual(L.correctness('take', 'flat'), false);
    assert.strictEqual(L.correctness('take', 'unclear'), null);
  });

  // a host with a live account, a price and enough candles for an ATR
  function ledgerHost() {
    const db = makeDb(), h = makeHost(db);
    const st = h.state(U, SRC);
    const nowS = Math.floor(h.now() / 1000);
    st.accountInfo = { login: 1001, balance: 5000, equity: 5000, margin: 0 };
    st.prices = { EURUSD: 1.1000 };
    // 20 H1 bars, each 20 pips high -> ATR 0.0020
    h.candles(U, SRC).EURUSDm = { candlesByTF: { H1: Array.from({ length: 20 }, (_, i) =>
      ({ t: nowS - (20 - i) * 3600, o: 1.1, h: 1.1010, l: 1.0990, c: 1.1 })) } };
    return { db, h, st, nowS };
  }
  async function post(h, body) {
    let out = null, code = 200;
    const res = { status(c) { code = c; return res; }, json(o) { out = o; return res; } };
    await h.routes['POST /api/arbiter/call']({ user: { id: U }, body, query: {} }, res);
    return { code, body: out };
  }
  const bars = (h, list) => { h.candles(U, SRC).EURUSDm.candlesByTF.H1.push(...list); };

  await check('the SERVER stamps the price and ATR — the browser cannot set either', async () => {
    const { db, h } = ledgerHost();
    const r = await post(h, { kind: 'take', symbol: 'EURUSDm', direction: 'bull', score: 74, price_at: 9.99, atr: 5 });
    assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
    const c = db.tables.arbiter_calls[0];
    assert.strictEqual(c.price_at, 1.1, 'server price, not the 9.99 the browser sent');
    assert.ok(Math.abs(c.atr - 0.0020) < 1e-9, 'server ATR, not the 5 the browser sent: ' + c.atr);
    assert.strictEqual(c.symbol, 'EURUSD');
  });

  await check('a duplicate call inside its life is refused, not double-counted', async () => {
    const { db, h } = ledgerHost();
    await post(h, { kind: 'take', symbol: 'EURUSD', direction: 'bull', score: 74 });
    const r = await post(h, { kind: 'take', symbol: 'EURUSD', direction: 'bull', score: 76 });
    assert.strictEqual(r.body.duplicate, true);
    assert.strictEqual(db.tables.arbiter_calls.length, 1);
  });

  await check('no candles, no call: a call that cannot be graded is not recorded', async () => {
    const { db, h } = ledgerHost();
    h.candles(U, SRC).EURUSDm.candlesByTF.H1 = [];
    const r = await post(h, { kind: 'take', symbol: 'EURUSD', direction: 'bull', score: 74 });
    assert.strictEqual(r.code, 409);
    assert.strictEqual(db.tables.arbiter_calls.length, 0);
  });

  await check('TAKE, you entered the same way 9 min later, it ran → followed, GOOD', async () => {
    const { db, h, st } = ledgerHost();
    await post(h, { kind: 'take', symbol: 'EURUSD', direction: 'bull', score: 74 });
    h.advance(9 * MIN);
    st.openTrades = [trade({ ticket: 70, type: 'buy', openTime: Math.floor(h.now() / 1000) })];
    await h.beat(U, SRC, A);   // note: account key for heartbeat scope
    await h.beat(U, SRC, '1001');
    h.advance(60 * MIN); st.prices = { EURUSD: 1.1025 };       // +25 pips > 1 ATR (20)
    await h.beat(U, SRC, '1001');
    const c = db.tables.arbiter_calls[0];
    assert.strictEqual(c.adherence, 'followed');
    assert.strictEqual(c.matched_ticket, '70');
    assert.strictEqual(c.outcome, 'ran');
    assert.strictEqual(c.box, 'good');
    assert.ok(c.resolved_at);
  });

  await check('TAKE, nothing entered in 20 min, it ran → ignored, EXPENSIVE', async () => {
    const { db, h, st } = ledgerHost();
    await post(h, { kind: 'take', symbol: 'EURUSD', direction: 'bull', score: 74 });
    h.advance(21 * MIN); st.prices = { EURUSD: 1.1022 };
    await h.beat(U, SRC, '1001');
    const c = db.tables.arbiter_calls[0];
    assert.strictEqual(c.adherence, 'ignored');
    assert.strictEqual(c.box, 'expensive');
  });

  await check('an entry on minute 21 is too late — its own trade, not a late follow', async () => {
    const { db, h, st } = ledgerHost();
    await post(h, { kind: 'take', symbol: 'EURUSD', direction: 'bull', score: 74 });
    h.advance(21 * MIN);
    st.openTrades = [trade({ ticket: 71, type: 'buy', openTime: Math.floor(h.now() / 1000) })];
    await h.beat(U, SRC, '1001');
    assert.strictEqual(db.tables.arbiter_calls[0].adherence, 'ignored');
  });

  await check('a trade opened BEFORE the call does not count as following it', async () => {
    const { db, h, st } = ledgerHost();
    st.openTrades = [trade({ ticket: 72, type: 'buy', openTime: Math.floor(h.now() / 1000) - 120 })];
    await post(h, { kind: 'take', symbol: 'EURUSD', direction: 'bull', score: 74 });
    h.advance(5 * MIN); await h.beat(U, SRC, '1001');
    assert.ok(!db.tables.arbiter_calls[0].adherence, 'still undecided — the window is open');
  });

  await check('TAKE long, you went SHORT → deviated (counts as not followed)', async () => {
    const { db, h, st } = ledgerHost();
    await post(h, { kind: 'take', symbol: 'EURUSD', direction: 'bull', score: 74 });
    h.advance(4 * MIN);
    st.openTrades = [trade({ ticket: 73, type: 'sell', openTime: Math.floor(h.now() / 1000) })];
    await h.beat(U, SRC, '1001');
    assert.strictEqual(db.tables.arbiter_calls[0].adherence, 'deviated');
  });

  await check('ASSAN\'S CASE: SKIP, you took it anyway, it ran → Arbiter wrong, LUCK', async () => {
    const { db, h, st } = ledgerHost();
    await post(h, { kind: 'skip', symbol: 'EURUSD', direction: 'bull', score: 58 });
    h.advance(6 * MIN);
    st.openTrades = [trade({ ticket: 74, type: 'buy', openTime: Math.floor(h.now() / 1000) })];
    await h.beat(U, SRC, '1001');
    h.advance(90 * MIN); st.prices = { EURUSD: 1.1030 };
    await h.beat(U, SRC, '1001');
    const c = db.tables.arbiter_calls[0];
    assert.strictEqual(c.adherence, 'ignored');
    assert.strictEqual(c.outcome, 'ran');
    assert.strictEqual(c.correct, false, 'the skip was wrong');
    assert.strictEqual(c.box, 'luck');
  });

  await check('SKIP, you skipped too, it ran → Arbiter wrong, OUR PROBLEM', async () => {
    const { db, h, st } = ledgerHost();
    await post(h, { kind: 'skip', symbol: 'EURUSD', direction: 'bull', score: 58 });
    h.advance(25 * MIN); st.prices = { EURUSD: 1.1030 };
    await h.beat(U, SRC, '1001');
    assert.strictEqual(db.tables.arbiter_calls[0].box, 'ours');
  });

  await check('SKIP, you skipped, it failed → right and followed, GOOD', async () => {
    const { db, h, st } = ledgerHost();
    await post(h, { kind: 'skip', symbol: 'EURUSD', direction: 'bull', score: 58 });
    h.advance(25 * MIN); st.prices = { EURUSD: 1.0975 };
    await h.beat(U, SRC, '1001');
    assert.strictEqual(db.tables.arbiter_calls[0].box, 'good');
  });

  await check('nothing moves 1 ATR in 4 hours → flat', async () => {
    const { db, h, st } = ledgerHost();
    await post(h, { kind: 'take', symbol: 'EURUSD', direction: 'bull', score: 74 });
    h.advance(4 * 60 * MIN + MIN); st.prices = { EURUSD: 1.1005 };
    await h.beat(U, SRC, '1001');
    const c = db.tables.arbiter_calls[0];
    assert.strictEqual(c.outcome, 'flat');
    assert.strictEqual(c.correct, false, 'a take that went nowhere was not right');
  });

  await check('ORDER matters: down 1 ATR first, then up → failed, not ran', async () => {
    const { db, h } = ledgerHost();
    await post(h, { kind: 'take', symbol: 'EURUSD', direction: 'bull', score: 74 });
    const t0 = Math.floor(h.now() / 1000);
    bars(h, [{ t: t0 + 3600, o: 1.1, h: 1.1005, l: 1.0975, c: 1.0978 },     // adverse first
             { t: t0 + 7200, o: 1.0978, h: 1.1030, l: 1.0970, c: 1.1025 }]);  // then favourable
    h.advance(3 * 3600 * 1000);
    await h.beat(U, SRC, '1001');
    assert.strictEqual(db.tables.arbiter_calls[0].outcome, 'failed');
  });

  await check('both thresholds inside ONE bar → unclear, and never graded either way', async () => {
    const { db, h } = ledgerHost();
    await post(h, { kind: 'take', symbol: 'EURUSD', direction: 'bull', score: 74 });
    const t0 = Math.floor(h.now() / 1000);
    bars(h, [{ t: t0 + 3600, o: 1.1, h: 1.1030, l: 1.0970, c: 1.1 }]);
    h.advance(2 * 3600 * 1000 + 25 * MIN);
    await h.beat(U, SRC, '1001');
    const c = db.tables.arbiter_calls[0];
    assert.strictEqual(c.outcome, 'unclear');
    assert.ok(c.correct == null && !c.box, 'excluded, not counted');
  });

  await check('LIVE: cut followed when the position closes; partial when volume drops', async () => {
    const { db, h, st } = ledgerHost();
    const openS = Math.floor(h.now() / 1000) - 3600;
    st.openTrades = [trade({ ticket: 80, type: 'buy', volume: 0.4, openTime: openS }),
                     trade({ ticket: 81, type: 'buy', volume: 0.4, openTime: openS })];
    await post(h, { kind: 'live', symbol: 'EURUSD', direction: 'bull', ticket: 80, action: 'cut', snapshot: { volume: 0.4 } });
    await post(h, { kind: 'live', symbol: 'EURUSD', direction: 'bull', ticket: 81, action: 'partial', snapshot: { volume: 0.4 } });
    h.advance(3 * MIN);
    st.openTrades = [trade({ ticket: 81, type: 'buy', volume: 0.2, openTime: openS })];
    await h.beat(U, SRC, '1001');
    const by = t => db.tables.arbiter_calls.find(c => c.ticket === t);
    assert.strictEqual(by('80').adherence, 'followed');
    assert.strictEqual(by('81').adherence, 'followed');
    assert.strictEqual(by('80').outcome, 'not_graded', 'live calls are recorded, not graded — no rule yet');
    assert.ok(!by('80').box);
  });

  await check('LIVE: a cut you did not act on within 20 min → ignored', async () => {
    const { db, h, st } = ledgerHost();
    st.openTrades = [trade({ ticket: 82, type: 'buy', volume: 0.4, openTime: Math.floor(h.now() / 1000) - 60 })];
    await post(h, { kind: 'live', symbol: 'EURUSD', direction: 'bull', ticket: 82, action: 'cut', snapshot: { volume: 0.4 } });
    h.advance(21 * MIN); await h.beat(U, SRC, '1001');
    assert.strictEqual(db.tables.arbiter_calls[0].adherence, 'ignored');
  });

  await check('a server restart mid-window keeps grading the call', async () => {
    const { db, h, st } = ledgerHost();
    await post(h, { kind: 'take', symbol: 'EURUSD', direction: 'bull', score: 74 });
    const h2 = makeHost(db, { start: h.now() + 8 * MIN });
    const st2 = h2.state(U, SRC);
    st2.accountInfo = st.accountInfo; st2.prices = { EURUSD: 1.1025 };
    h2.candles(U, SRC).EURUSDm = h.candles(U, SRC).EURUSDm;
    st2.openTrades = [trade({ ticket: 90, type: 'buy', openTime: Math.floor(h2.now() / 1000) })];
    await h2.beat(U, SRC, '1001');
    const c = db.tables.arbiter_calls[0];
    assert.strictEqual(c.adherence, 'followed');
    assert.strictEqual(c.box, 'good');
  });

  await check('GET /api/arbiter/calls returns the 2x2 counts', async () => {
    const { db, h, st } = ledgerHost();
    await post(h, { kind: 'skip', symbol: 'EURUSD', direction: 'bull', score: 58 });
    h.advance(25 * MIN); st.prices = { EURUSD: 1.1030 };
    await h.beat(U, SRC, '1001');
    let out; const res = { status() { return res; }, json(o) { out = o; } };
    await h.routes['GET /api/arbiter/calls']({ user: { id: U }, query: { days: '1' } }, res);
    assert.deepStrictEqual(out.quad, { good: 0, expensive: 0, ours: 1, luck: 0 });
    assert.strictEqual(out.resolved, 1);
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
        news: f.news || [], riskRule: null, nowSec: nowS }).map(e => e.type)
        // Arbiter-only, by design: the tab is a live warning panel and does
        // not score the advised cooldown. Covered by its own tests above.
        .filter(t => t !== 'cooldown_breach').sort();
      // Revenge detection is now identical on both sides (15 min).
      assert.deepStrictEqual(srv, tab, f.name + ': server ' + JSON.stringify(srv) + ' vs tab ' + JSON.stringify(tab));
    }
  });

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures ? 1 : 0);
})();
