// test-review.js — the daily-review fixes: what Claude is given, in what time, in what units.
'use strict';
const assert = require('assert');
const fs = require('fs');
const R = require('./arbiter-route.js');
const PG = R.progress, RP = R.reports;
let pass = 0, fail = 0;
function check(id, name, fn) { try { fn(); pass++; console.log('  ok   ' + id.padEnd(5) + name); }
  catch (e) { fail++; console.log('  FAIL ' + id.padEnd(5) + name + '\n       ' + e.message); } }
const GMT3 = 3 * 3600;
const DAY = { start: Date.UTC(2026, 8, 21), end: Date.UTC(2026, 8, 22) };       // 21 Sep, 00:00-24:00 UTC
const jt = (ticket, sym, closeBroker, extra) => Object.assign({ ticket, account_number: '1001', symbol: sym, direction: 'buy',
  open_price: 1.08, close_price: 1.083, sl: 1.078, total_pl: 30, open_time: closeBroker, close_time: closeBroker }, extra || {});

console.log('\n1 — JOURNAL TIMES ARE BROKER TIME');
check('T-1', '00:30 broker (GMT+3) on the 22nd is 21:30 UTC on the 21st', () =>
  assert.strictEqual(PG.brokerToUtc('2026.09.22 00:30:00', GMT3), '2026-09-21T21:30:00.000Z'));
check('T-1', 'already ISO with a zone: left alone', () =>
  assert.strictEqual(PG.brokerToUtc('2026-09-21T22:15:04.000Z', GMT3), '2026-09-21T22:15:04.000Z'));
check('T-2', 'THE BUG: a trade closed at 21:30 UTC lands in the 21st\'s review, not the 22nd\'s', () => {
  const rows = PG.journalUTC([jt('1', 'EURUSD', '2026.09.22 00:30:00')], () => GMT3);
  const day21 = RP.buildFacts('daily', DAY, [], [], [], rows);
  const day22 = RP.buildFacts('daily', { start: DAY.end, end: DAY.end + 86400e3 }, [], [], [], rows);
  assert.strictEqual(day21.trades.closed, 1, 'in the right day'); assert.strictEqual(day22.trades.closed, 0, 'not the next');
});
check('T-2', '...and the raw broker reading is kept beside it', () =>
  assert.strictEqual(PG.journalUTC([jt('1', 'EURUSD', '2026.09.22 00:30:00')], () => GMT3)[0].close_time_broker, '2026.09.22 00:30:00'));
check('T-3', 'each ACCOUNT uses its own broker\'s offset', () => {
  const rows = PG.journalUTC([jt('1', 'EURUSD', '2026.09.21 12:00:00'), Object.assign(jt('2', 'EURUSD', '2026.09.21 12:00:00'), { account_number: '2002' })],
    acct => acct === '1001' ? GMT3 : 2 * 3600);
  assert.strictEqual(rows[0].close_time, '2026-09-21T09:00:00.000Z'); assert.strictEqual(rows[1].close_time, '2026-09-21T10:00:00.000Z');
});
check('T-4', 'the broker offset is learned only while the broker clock MOVES (a frozen weekend clock keeps the last good one)', () => {
  const app = fs.readFileSync(__dirname + '/out/app.js', 'utf8');
  const a = app.indexOf("  if (Number.isFinite(Number(d.timestamp))) {\n    const ts = Number(d.timestamp);");
  const b = app.indexOf('\n  }', a) + 4;
  const fn = new Function('s', 'd', 'Date', app.slice(a, b));
  // THE REALISTIC CASE: the market closes Friday 21:00 UTC; the weekly report runs
  // Saturday 02:00 UTC — only 5 hours later, so the frozen clock reads as about -2h,
  // well INSIDE the 14-hour sanity guard. (A 29-hour gap would be caught by that guard
  // anyway, which is why a first version of this test proved nothing.)
  let nowMs = Date.UTC(2026, 8, 18, 20, 59, 50); const D = { now: () => nowMs };
  const s = {};
  const brokerNow = () => Math.floor(nowMs / 1000) + GMT3;
  fn(s, { timestamp: brokerNow() }, D);                          // first reading: nothing to compare yet
  nowMs += 5000; fn(s, { timestamp: brokerNow() }, D);           // moving: learned
  assert.strictEqual(s.brokerOffsetSec, GMT3);
  const frozen = brokerNow();                                    // the last tick before the close: the clock freezes
  nowMs = Date.UTC(2026, 8, 19, 2, 0, 0); fn(s, { timestamp: frozen }, D);    // Saturday 02:00 UTC
  nowMs += 5000; fn(s, { timestamp: frozen }, D);
  assert.strictEqual(s.brokerOffsetSec, GMT3, 'the frozen clock must not overwrite it (it would read as -2h)');
});

console.log('\n2/3 — NOTHING SILENTLY CUT');
const at = (k) => new Date(DAY.start + 60e3 * (k + 1)).toISOString();
const call = (k, kind) => ({ id: String(k), kind: kind || 'skip', symbol: 'EURUSD', direction: 'bull', score: 60, created_at: at(k) });
check('C-1', 'a busy day: 120 calls -> all 120 in the timeline (it used to stop at 40)', () => {
  const f = RP.buildFacts('daily', DAY, Array.from({ length: 120 }, (_, k) => call(k)), [], [], []);
  assert.strictEqual(f.calls.timeline.length, 120); assert.strictEqual(f.calls.timelineOmitted, 0);
});
check('C-1', 'in TIME ORDER, whatever order the database returned', () => {
  const f = RP.buildFacts('daily', DAY, [call(5), call(1), call(3)], [], [], []);
  assert.deepStrictEqual(f.calls.timeline.map(c => c.at), [at(1), at(3), at(5)]);
});
check('C-2', 'past the request ceiling: Claude is TOLD how many were left out', () => {
  const f = RP.buildFacts('daily', DAY, Array.from({ length: 520 }, (_, k) => call(k % 1300)), [], [], []);
  assert.strictEqual(f.calls.timeline.length, 500); assert.strictEqual(f.calls.timelineOmitted, 20);
});
check('C-3', '35 trades -> all 35 listed (it used to stop at 30)', () => {
  const rows = Array.from({ length: 35 }, (_, k) => jt(String(k), 'EURUSD', new Date(DAY.start + 3600e3 + k * 60e3).toISOString()));
  const f = RP.buildFacts('daily', DAY, [], [], [], rows);
  assert.strictEqual(f.trades.list.length, 35); assert.strictEqual(f.trades.listOmitted, 0);
});

console.log('\n4 — TRADES STILL OPEN AT THE END');
const pos = (ticket, firstSeen, closedAt) => ({ ticket, symbol: 'GBPUSD', side: 'buy', risk_pct: 0.8, mfe_pips: 14, mae_pips: 6,
  first_seen_at: new Date(firstSeen).toISOString(), closed_at: closedAt ? new Date(closedAt).toISOString() : null });
check('O-1', 'opened during the day, still open at midnight: listed', () => {
  const f = RP.buildFacts('daily', DAY, [], [], [pos('a', DAY.start + 10 * 3600e3, null)], []);
  assert.strictEqual(f.trades.openAtEnd.length, 1); assert.strictEqual(f.trades.openAtEnd[0].openedThisPeriod, true);
});
check('O-1', 'opened yesterday and still open: listed, marked as carried in', () => {
  const f = RP.buildFacts('daily', DAY, [], [], [pos('b', DAY.start - 5 * 3600e3, DAY.end + 3600e3)], []);
  assert.strictEqual(f.trades.openAtEnd[0].openedThisPeriod, false);
});
check('O-1', 'closed before midnight: not "still open"', () =>
  assert.strictEqual(RP.buildFacts('daily', DAY, [], [], [pos('c', DAY.start + 3600e3, DAY.start + 7200e3)], []).trades.openAtEnd.length, 0));

console.log('\n5 — PIPS, POINTS AND R');
const tr = (sym, o, c, sl) => ({ symbol: sym, direction: 'buy', open_price: o, close_price: c, sl });
check('P-1', 'pips per instrument: EURUSD 30, USDJPY 30, gold 120, US30 150, oil 90', () => {
  assert.strictEqual(PG.pipsOf(tr('EURUSD', 1.08, 1.083, 1.078)), 30);
  assert.strictEqual(PG.pipsOf(tr('USDJPY', 157.1, 157.4, 157.0)), 30);
  assert.strictEqual(PG.pipsOf(tr('XAUUSD', 2340, 2352, 2335)), 120);
  assert.strictEqual(PG.pipsOf(tr('US30', 42000, 42150, 41950)), 150, 'was 1,500,000 with the forex fallback');
  assert.strictEqual(PG.pipsOf(tr('USOIL', 78.2, 79.1, 77.8)), 90);
});
check('P-2', 'an UNKNOWN instrument: pips null — never a guess', () =>
  assert.strictEqual(PG.pipsOf(tr('ABCXYZ', 10, 11, 9.5)), null));
check('P-3', 'R does not depend on the pip size — right even when pips are unknown', () => {
  assert.strictEqual(PG.rOf(tr('ABCXYZ', 10, 11, 9.5)), 2);
  assert.strictEqual(PG.rOf(tr('US30', 42000, 42150, 41950)), 3);
});
check('P-4', 'pips per SYMBOL in the facts — gold never added to forex', () => {
  const rows = [jt('1', 'XAUUSD', '2026-09-21T10:00:00Z', { open_price: 2340, close_price: 2352, sl: 2335 }),
                jt('2', 'EURUSD', '2026-09-21T11:00:00Z'), jt('3', 'EURUSD', '2026-09-21T12:00:00Z')];
  const f = RP.buildFacts('daily', DAY, [], [], [], rows);
  assert.deepStrictEqual(f.trades.pipsBySymbol, { XAUUSD: { trades: 1, pips: 120, pipsUnknown: false },
                                                  EURUSD: { trades: 2, pips: 60, pipsUnknown: false } });
});
check('P-5', 'the pip table is IDENTICAL in the route, the engine and the feeds', () => {
  const grab = f => { const s = fs.readFileSync(__dirname + '/' + f, 'utf8'); const a = s.indexOf('var PIP_CCY'); return s.slice(a, s.indexOf('\n}\n', s.indexOf('function pipKnown', a)) + 2); };
  assert.strictEqual(grab('arbiter-engine.js'), grab('arbiter-route.js')); assert.strictEqual(grab('arbiter-feeds.js'), grab('arbiter-route.js'));
});
check('P-6', 'Claude is taught: never add pips across symbols; points are not pips; null means unknown', () => {
  const r = RP.REPORT_RULES;
  assert.ok(/NEVER add pips across different symbols/.test(r)); assert.ok(/10 points = 1 pip/.test(r));
  assert.ok(/pips not available/.test(r)); assert.ok(/openAtEnd/.test(r)); assert.ok(/never imply it/.test(r));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
