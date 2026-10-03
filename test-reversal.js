// test-reversal.js — PHASE B: the foundations, item by item against the checklist.
'use strict';
const assert = require('assert');
const fs = require('fs');
const R = require('./arbiter-reversal.js');
let pass = 0, fail = 0;
function check(id, name, fn) { try { fn(); pass++; console.log('  ok   ' + id.padEnd(6) + name); }
  catch (e) { fail++; console.log('  FAIL ' + id.padEnd(6) + name + '\n       ' + e.message); } }

// A LONG on EUR/USD; decisive level 1.0850; ATR 12 pips. "Against" = below the level.
// T0 is chosen so the breaking bar (the 13th) lands at 09:00 UTC on a Tuesday — London, liquid.
// (Starting at 09:00 put it at 21:00, inside the rollover window, so it was rightly read as thin.)
const ATR = 0.0012, LEVEL = 1.0850, T0 = Date.UTC(2026, 8, 21, 21, 0, 0) / 1000;
const bar = (k, o, h, l, c, t) => ({ t: t != null ? t : T0 + k * 3600, o, h, l, c });
// calm bars sitting above the level, then whatever the test appends
function above(n) { const out = []; for (let k = 0; k < n; k++) out.push(bar(k, 1.0862, 1.0866, 1.0858, 1.0861 + (k % 2) * 0.0002)); return out; }
const ctx = (extra) => Object.assign({ level: LEVEL, dir: 1, atr: ATR, tfMin: 60, sym: 'EURUSD', news: [], liq: 'healthy', spread: 0.00008 }, extra || {});
const at = (cd, extra) => R.classifyBreak(cd, cd.length - 1, ctx(extra));
const STRONG = k => bar(k, 1.0858, 1.0859, 1.0837, 1.0838);       // body 20, range 22, closes 12 pips through

console.log('\nB-1 / Q — THE WEIGHT OF THE BREAKING BAR');
check('Q-1', 'strong body, closes well through, normal size = 1.0', () => {
  const cd = above(12); cd.push(STRONG(12)); const q = at(cd);
  assert.strictEqual(q.kind, 'strong'); assert.strictEqual(q.weight, 1.0);
});
check('Q-2', 'long wick through the level, closes only just beyond = 0.5', () => {
  const cd = above(12); cd.push(bar(12, 1.0855, 1.0856, 1.0832, 1.0848));   // closes 2 pips through, 16-pip wick below
  const q = at(cd); assert.strictEqual(q.kind, 'wick'); assert.strictEqual(q.weight, 0.5);
});
check('Q-3', 'strong/huge bar during a high-impact release on either currency = 0.5', () => {
  const cd = above(12); cd.push(STRONG(12));
  const q = at(cd, { news: [{ title: 'US CPI', impact: 'high', currency: 'USD', timestamp: T0 + 12 * 3600 + 600 }] });
  assert.strictEqual(q.kind, 'news'); assert.strictEqual(q.weight, 0.5); assert.strictEqual(q.news, 'US CPI');
});
check('Q-4', 'huge body (range >= 2x ATR), no news = uncertain 0.5', () => {
  const cd = above(12); cd.push(bar(12, 1.0866, 1.0868, 1.0834, 1.0836));    // range 34 pips = 2.8x ATR
  const q = at(cd); assert.strictEqual(q.kind, 'huge'); assert.strictEqual(q.weight, 0.5);
});
check('Q-5', 'while liquidity is being swept (manipulation) = 0.25', () => {
  const cd = above(12); cd.push(STRONG(12));
  const q = at(cd, { liq: 'man' }); assert.strictEqual(q.kind, 'sweep'); assert.strictEqual(q.weight, 0.25);
});
check('Q-6', 'during thin liquidity = 0.5 (the liquidity reading says thin or drought)', () => {
  const cd = above(12); cd.push(STRONG(12));
  assert.strictEqual(at(cd, { liq: 'thin' }).kind, 'thin'); assert.strictEqual(at(cd, { liq: 'drought' }).weight, 0.5);
});
check('P6', 'thin liquidity also near rollover, 21:00-22:59 UTC', () => {
  const t = Date.UTC(2026, 8, 22, 21, 0, 0) / 1000;
  const cd = above(12); cd.push(Object.assign(STRONG(12), { t })); assert.strictEqual(at(cd).kind, 'thin');
  cd[12] = Object.assign(STRONG(12), { t: Date.UTC(2026, 8, 22, 23, 0, 0) / 1000 }); assert.strictEqual(at(cd).kind, 'strong');
});
check('P2', 'a bar that is none of the listed kinds = modest 0.5', () => {
  const cd = above(12); cd.push(bar(12, 1.0856, 1.0864, 1.0842, 1.0846));    // body 10 of range 22 = 45%: not strong, no long wick
  const q = at(cd); assert.strictEqual(q.kind, 'modest'); assert.strictEqual(q.weight, 0.5);
});
check('P9', 'several kinds at once: the MOST SCEPTICAL weight wins (sweep + news -> 0.25)', () => {
  const cd = above(12); cd.push(STRONG(12));
  const q = at(cd, { liq: 'man', news: [{ impact: 'high', currency: 'EUR', timestamp: T0 + 12 * 3600 }] });
  assert.strictEqual(q.weight, 0.25); assert.ok(q.all.indexOf('news') >= 0 && q.all.indexOf('sweep') >= 0);
});
check('P8', 'a SMALL bar during news is judged as itself, not discounted as news', () => {
  const cd = above(12); cd.push(bar(12, 1.0856, 1.0864, 1.0842, 1.0846));
  const q = at(cd, { news: [{ impact: 'high', currency: 'USD', timestamp: T0 + 12 * 3600 }] });
  assert.strictEqual(q.kind, 'modest');
});
check('P1', 'a strong bar that closes only 1-2 pips through is NOT "well through" — not strong', () => {
  const cd = above(12); cd.push(bar(12, 1.0868, 1.0869, 1.0847, 1.0849));    // strong shape, closes 1 pip through
  assert.notStrictEqual(at(cd).kind, 'strong');
});

console.log('\nB-2 — THE NEWS WINDOW (DEC-1: ±15 minutes, either currency, high impact)');
const cdN = (() => { const cd = above(12); cd.push(STRONG(12)); return cd; })();
const open = T0 + 12 * 3600, close = open + 3600;
check('B-2', '15 minutes before the bar opens: counts', () =>
  assert.strictEqual(at(cdN, { news: [{ impact: 'high', currency: 'USD', timestamp: open - 900 }] }).kind, 'news'));
check('B-2', '16 minutes before: does not', () =>
  assert.strictEqual(at(cdN, { news: [{ impact: 'high', currency: 'USD', timestamp: open - 960 }] }).kind, 'strong'));
check('B-2', '15 minutes after the bar closes: counts; 16: does not', () => {
  assert.strictEqual(at(cdN, { news: [{ impact: 'high', currency: 'EUR', timestamp: close + 900 }] }).kind, 'news');
  assert.strictEqual(at(cdN, { news: [{ impact: 'high', currency: 'EUR', timestamp: close + 960 }] }).kind, 'strong');
});
check('B-2', 'a release on ANOTHER currency does not count', () =>
  assert.strictEqual(at(cdN, { news: [{ impact: 'high', currency: 'JPY', timestamp: open }] }).kind, 'strong'));
check('B-2', 'medium impact does not count', () =>
  assert.strictEqual(at(cdN, { news: [{ impact: 'medium', currency: 'USD', timestamp: open }] }).kind, 'strong'));
check('B-2', 'timestamps in milliseconds are read correctly', () =>
  assert.strictEqual(at(cdN, { news: [{ impact: 'high', currency: 'USD', timestamp: open * 1000 }] }).kind, 'news'));

console.log('\nB-4 / D — DISPLACEMENT OR MANIPULATION');
check('D-1', 'where it closed: a strong break closing near its low is marked as closing near its extreme', () =>
  assert.strictEqual(at(cdN).closeNearExtreme, true));
check('D-1', 'a wick bar that closed back up is not', () => {
  const cd = above(12); cd.push(bar(12, 1.0855, 1.0856, 1.0832, 1.0848)); assert.strictEqual(at(cd).closeNearExtreme, false);
});
check('D-2', 'the bar before ran the stops under EQUAL lows and closed back above: sweep 0.25', () => {
  const cd = above(12);
  cd[4] = bar(4, 1.0858, 1.0860, 1.0852, 1.0856); cd[8] = bar(8, 1.0858, 1.0860, 1.08521, 1.0856);   // two equal lows ~1.0852
  cd[11] = bar(11, 1.0858, 1.0860, 1.0849, 1.0857);          // dips under 1.0852, closes back above: the stop-run
  cd.push(bar(12, 1.0858, 1.0859, 1.0837, 1.0838));          // then the break
  assert.strictEqual(at(cd).kind, 'sweep');
});
check('D-2', 'a bar that CLOSES through the equal lows has broken them, not swept them', () => {
  const cd = above(12);
  cd[4] = bar(4, 1.0858, 1.0860, 1.0852, 1.0856); cd[8] = bar(8, 1.0858, 1.0860, 1.08521, 1.0856);
  cd.push(bar(12, 1.0858, 1.0859, 1.0837, 1.0838));
  assert.strictEqual(at(cd).kind, 'strong');
});
check('D-2', 'no equal lows beneath: not a sweep', () => assert.notStrictEqual(at(cdN).kind, 'sweep'));
check('D-3', 'the liquidity reading "being swept" (man) counts as manipulation', () =>
  assert.strictEqual(at(cdN, { liq: 'man' }).kind, 'sweep'));

console.log('\nQ-7..Q-10 — FOLLOW-THROUGH AND FAKEOUTS (trackBreak)');
const track = (cd, extra) => R.trackBreak(cd, ctx(Object.assign({ from: 1 }, extra || {})));
check('Q-7/8', 'news bar 0.5, then two bars closing further beyond: 0.5 + 1.0 + 1.0 = 2.5', () => {
  const cd = above(12); cd.push(STRONG(12)); cd.push(bar(13, 1.0838, 1.0840, 1.0826, 1.0828)); cd.push(bar(14, 1.0828, 1.0830, 1.0815, 1.0817));
  const st = track(cd, { news: [{ impact: 'high', currency: 'USD', timestamp: T0 + 12 * 3600 }] });
  assert.strictEqual(st.breakTag.kind, 'news'); assert.strictEqual(st.total, 2.5);
});
check('Q-7', 'the discount applies ONLY to the breaking bar', () => {
  const cd = above(12); cd.push(STRONG(12)); cd.push(bar(13, 1.0838, 1.0840, 1.0826, 1.0828));
  const st = track(cd, { liq: 'man' });
  assert.deepStrictEqual(st.conv.map(c => c.v), [0.25, 1.0]);
});
check('P4', 'a later bar beyond but NOT further beyond adds nothing and resets nothing', () => {
  const cd = above(12); cd.push(STRONG(12)); cd.push(bar(13, 1.0838, 1.0846, 1.0836, 1.0842));
  const st = track(cd); assert.strictEqual(st.total, 1.0); assert.strictEqual(st.breakAt, 12);
});
check('Q-9', 'a bar closing back inside: a fakeout — the case resets', () => {
  const cd = above(12); cd.push(STRONG(12)); cd.push(bar(13, 1.0838, 1.0862, 1.0836, 1.0860));
  const st = track(cd);
  assert.strictEqual(st.breakAt, null); assert.strictEqual(st.total, 0); assert.strictEqual(st.fakeouts.length, 1);
});
check('Q-10', 'the breaking bar keeps its quality after a fakeout (for the card and the chart)', () => {
  const cd = above(12); cd.push(STRONG(12)); cd.push(bar(13, 1.0838, 1.0862, 1.0836, 1.0860));
  const st = track(cd, { liq: 'man' });
  assert.strictEqual(st.fakeouts[0].tag.kind, 'sweep'); assert.strictEqual(st.fakeouts[0].brokeAt, 12);
});
check('Q-9', 'a NEW break after a fakeout starts a new case', () => {
  const cd = above(12); cd.push(STRONG(12)); cd.push(bar(13, 1.0838, 1.0862, 1.0836, 1.0860)); cd.push(bar(14, 1.0860, 1.0861, 1.0838, 1.0839));
  const st = track(cd); assert.strictEqual(st.breakAt, 14); assert.strictEqual(st.fakeouts.length, 1);
});

console.log('\nB-5 — THE RETEST (DEC-6)');
check('B-5', 'back within 1/4 ATR of the level from the far side, then the next bar closes further away', () => {
  const cd = above(12); cd.push(STRONG(12));
  cd.push(bar(13, 1.0838, 1.0848, 1.0835, 1.0840));     // high 1.0848: 2 pips under the level (inside 3)
  cd.push(bar(14, 1.0840, 1.0841, 1.0826, 1.0828));     // the next closes further away
  const st = track(cd); assert.ok(st.retest, 'retest found'); assert.strictEqual(st.retest.at, 13);
});
check('B-5', 'not near enough the level: no retest', () => {
  const cd = above(12); cd.push(STRONG(12)); cd.push(bar(13, 1.0838, 1.0843, 1.0835, 1.0840)); cd.push(bar(14, 1.0840, 1.0841, 1.0826, 1.0828));
  assert.strictEqual(track(cd).retest, null);
});
check('B-5', 'never tighter than 2x the spread', () => {
  const cd = above(12); cd.push(STRONG(12)); cd.push(bar(13, 1.0838, 1.0843, 1.0835, 1.0840)); cd.push(bar(14, 1.0840, 1.0841, 1.0826, 1.0828));
  assert.ok(track(cd, { spread: 0.0004 }).retest, 'with a 4-pip spread the zone is 8 pips');
});

console.log('\nB-6 — THE GAP');
check('B-6', 'the bar opens beyond the level after a weekend: a gap', () => {
  const cd = above(12); const fri = cd[11].t; cd.push(bar(0, 1.0840, 1.0842, 1.0834, 1.0836, fri + 64 * 3600));
  const st = track(cd); assert.strictEqual(st.gap, true); assert.strictEqual(st.breakTag.kind, 'gap');
});
check('B-6', 'an ordinary next bar opening beyond is not a gap', () => {
  const cd = above(12); cd.push(bar(12, 1.0849, 1.0850, 1.0836, 1.0838));
  assert.strictEqual(track(cd).gap, false);
});

console.log('\nB-7 — THE GRIND');
check('B-7', 'small closes, each a little further beyond: 4 bars and 0.75 ATR -> met', () => {
  const cd = above(12); let p = 1.0852;
  for (let k = 12; k < 17; k++) { const o = p; p -= 0.0003; cd.push(bar(k, o, o + 0.0001, p - 0.0001, p)); }
  const st = track(cd); assert.strictEqual(st.grind.met, true, JSON.stringify(st.grind));
});
check('B-7', 'too few bars, or not far enough: not met', () => {
  const cd = above(12); let p = 1.0852;
  for (let k = 12; k < 15; k++) { const o = p; p -= 0.0001; cd.push(bar(k, o, o + 0.0001, p - 0.0001, p)); }
  assert.strictEqual(track(cd).grind.met, false);
});

console.log('\nTHE SAME RULES MIRRORED — A SHORT');
check('mirror', 'a strong break ABOVE the level against a short = strong 1.0', () => {
  const cd = []; for (let k = 0; k < 12; k++) cd.push(bar(k, 1.0838, 1.0842, 1.0834, 1.0839));
  cd.push(bar(12, 1.0842, 1.0863, 1.0841, 1.0862));
  const q = R.classifyBreak(cd, 12, ctx({ dir: -1 })); assert.strictEqual(q.kind, 'strong'); assert.strictEqual(q.closeNearExtreme, true);
});
check('mirror', 'a short\'s fakeout: back below the level', () => {
  const cd = []; for (let k = 0; k < 12; k++) cd.push(bar(k, 1.0838, 1.0842, 1.0834, 1.0839));
  cd.push(bar(12, 1.0842, 1.0863, 1.0841, 1.0862)); cd.push(bar(13, 1.0862, 1.0863, 1.0838, 1.0840));
  assert.strictEqual(R.trackBreak(cd, ctx({ dir: -1, from: 1 })).fakeouts.length, 1);
});

console.log('\nTHE FORMING CANDLE IS NEVER JUDGED');
check('B', 'the last, still-forming bar is excluded when flagged', () => {
  const cd = above(12); cd.push(STRONG(12));
  assert.strictEqual(track(cd, { lastIsForming: true }).breakAt, null);
});

console.log('\nB-8 — NOTHING A TRADER SEES CHANGES IN PHASE B');
check('B-8', 'the engine is byte-for-byte the one already deployed', () =>
  assert.strictEqual(fs.readFileSync(__dirname + '/arbiter-engine.js', 'utf8'),
                     fs.readFileSync('/mnt/user-data/outputs/arbiter-phase1/arbiter-engine.js', 'utf8')));
check('B-8', 'nothing loads or calls the new module yet', () => {
  ['arbiter.html', 'arbiter-feeds.js', 'arbiter-engine.js', 'arbiter-route.js'].forEach(f =>
    assert.ok(!/arbiter-reversal|BWReversal/.test(fs.readFileSync(__dirname + '/' + f, 'utf8')), f + ' already uses it'));
});

console.log('\nPROVISIONAL VALUES — awaiting Assan (each pinned so a change is deliberate)');
check('P1-9', 'the provisional values are exactly those listed for confirmation', () => {
  const c = R.CFG;
  assert.deepStrictEqual([c.WELL_THROUGH_ATR, c.W_MODEST, c.WICK_TO_BODY, c.W_FLAT_FOLLOW, c.GRIND_BARS, c.GRIND_ATR,
    c.ROLLOVER_UTC.join('-'), c.POOL_TOL_ATR, c.POOL_LOOKBACK, c.NEWS_NEEDS_SIZE, c.GAP_TF_MULT],
    [0.25, 0.5, 1.0, 0, 4, 0.75, '21-23', 0.1, 30, true, 2]);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
