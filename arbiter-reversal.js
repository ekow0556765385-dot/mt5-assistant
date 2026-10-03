/* arbiter-reversal.js — PHASE B: the foundations of the reversal rules.
   Pure measurement. Nothing here decides an action; Phase C wires it into the
   engine. Loaded by the page and by the server (dual-load), like the engine.

   Source of truth: reversal-rules-v2.html + reversal-build-checklist.md.
   Every threshold the prototype names is here. Values the prototype did NOT pin
   down are marked PROVISIONAL and listed for Assan to confirm (P1..P9). */
(function (root) {
'use strict';

var CFG = {
  // ── Assan's decisions ──────────────────────────────────────────────
  NEWS_WINDOW_MIN: 15,        // DEC-1: a release within ±15 min of the bar, either currency
  STRONG_BODY: 0.60,          // DEC-2: body >= 60% of the bar's range
  STRONG_RANGE_ATR: 0.8,      // DEC-2: and range >= 0.8x ATR
  HUGE_RANGE_ATR: 2.0,        // DEC-2: huge = range >= 2x ATR
  RETEST_ATR: 0.25,           // DEC-6: back within 1/4 ATR of the level ...
  RETEST_MIN_SPREADS: 2,      // DEC-6: ... never less than 2x the spread
  // ── the weights of the breaking bar (Q-1..Q-6) ─────────────────────
  W_STRONG: 1.0, W_WICK: 0.5, W_NEWS: 0.5, W_HUGE: 0.5, W_THIN: 0.5, W_SWEEP: 0.25,
  W_FOLLOW: 1.0,              // Q-8: each later bar closing further beyond
  // ── PROVISIONAL — the prototype did not pin these down ─────────────
  WELL_THROUGH_ATR: 0.25,     // P1: "closes WELL through" = at least 1/4 ATR beyond the level
  W_MODEST: 0.5,              // P2: a breaking bar that is none of the listed kinds
  WICK_TO_BODY: 1.0,          // P3: "long wick" = the wick beyond the level at least as long as the body
  W_FLAT_FOLLOW: 0,           // P4: a later bar beyond, but NOT further beyond: adds nothing, resets nothing
  GRIND_BARS: 4,              // P5: a grind = this many consecutive closes beyond ...
  GRIND_ATR: 0.75,            // P5: ... having travelled at least this far beyond the level
  ROLLOVER_UTC: [21, 23],     // P6: thin liquidity also 21:00-22:59 UTC (rollover), besides the liquidity reading
  POOL_TOL_ATR: 0.1,          // P7: "equal" highs/lows = within 0.1 ATR ...
  POOL_LOOKBACK: 30,          // P7: ... among the last 30 bars; swept by this bar or the one before
  NEWS_NEEDS_SIZE: true,      // P8: the news discount applies to a strong or huge bar; a small bar is judged as itself
  GAP_TF_MULT: 2              // P9: a gap = the bar opens beyond the level after a pause of 2+ bar lengths
  // P9 (precedence): when several kinds apply, the MOST SCEPTICAL weight wins
};

function n(x) { x = +x; return isFinite(x) ? x : null; }
var O = function (c) { return n(c.o !== undefined ? c.o : c.open); };
var H = function (c) { return n(c.h !== undefined ? c.h : c.high); };
var L = function (c) { return n(c.l !== undefined ? c.l : c.low); };
var C = function (c) { return n(c.c !== undefined ? c.c : c.close); };
var T = function (c) { var t = n(c.t !== undefined ? c.t : c.time) || 0; return t > 1e12 ? t / 1000 : t; };   // seconds

/* dir = the TRADE's direction: +1 long, -1 short. "Against" is the other way.
   beyond(price) = price is on the far side of the level, against the trade. */
function beyond(price, level, dir) { return dir > 0 ? price < level : price > level; }
function past(price, level, dir) { return dir > 0 ? level - price : price - level; }   // how far beyond, in price

/* ── B: the shape of one bar ───────────────────────────────────────── */
function shape(bar, atr) {
  var o = O(bar), h = H(bar), l = L(bar), c = C(bar);
  var range = h - l, body = Math.abs(c - o);
  return { o: o, h: h, l: l, c: c, range: range, body: body,
    bodyPct: range > 0 ? body / range : 0,
    closeLoc: range > 0 ? (c - l) / range : 0.5,          // 0 = closed on its low, 1 = on its high
    strong: range > 0 && body / range >= CFG.STRONG_BODY && atr > 0 && range >= CFG.STRONG_RANGE_ATR * atr,
    huge: atr > 0 && range >= CFG.HUGE_RANGE_ATR * atr };
}

/* ── B-2: the news window (DEC-1) ──────────────────────────────────── */
function ccysOf(sym) { var s = String(sym || '').toUpperCase().replace(/[^A-Z]/g, ''); return [s.slice(0, 3), s.slice(3, 6)]; }
function newsAt(bar, tfMin, news, sym) {
  var open = T(bar), close = open + (tfMin || 60) * 60, w = CFG.NEWS_WINDOW_MIN * 60, cc = ccysOf(sym);
  return (news || []).find(function (e) {
    if (String(e.impact || '').toLowerCase() !== 'high') return false;
    var ts = n(e.timestamp); if (ts == null) return false; if (ts > 1e12) ts /= 1000;
    var cur = String(e.currency || e.country || '').toUpperCase();
    if (cur && cc.indexOf(cur) < 0) return false;
    return ts >= open - w && ts <= close + w;
  }) || null;
}

/* ── B-3: thin liquidity at this bar ──────────────────────────────── */
function thinAt(bar, liqVerdict) {
  if (liqVerdict === 'thin' || liqVerdict === 'drought') return true;
  var hr = new Date(T(bar) * 1000).getUTCHours();
  return hr >= CFG.ROLLOVER_UTC[0] && hr < CFG.ROLLOVER_UTC[1];
}

/* ── B-4 (D-2): did this bar, or the one before, sweep a pool of equal highs/lows? ── */
function sweptPool(cd, i, dir, atr) {
  var tol = CFG.POOL_TOL_ATR * atr;
  function pools(end) {                           // equal highs and equal lows before `end`
    var hs = [], ls = [], from = Math.max(1, end - CFG.POOL_LOOKBACK);
    for (var k = from; k < end - 1; k++) {
      if (H(cd[k]) >= H(cd[k - 1]) && H(cd[k]) >= H(cd[k + 1])) hs.push(H(cd[k]));
      if (L(cd[k]) <= L(cd[k - 1]) && L(cd[k]) <= L(cd[k + 1])) ls.push(L(cd[k]));
    }
    var eq = function (a) { var out = []; for (var x = 0; x < a.length; x++) for (var y = x + 1; y < a.length; y++)
      if (Math.abs(a[x] - a[y]) <= tol) out.push((a[x] + a[y]) / 2); return out; };   // the pool sits at their average
    return { highs: eq(hs), lows: eq(ls) };
  }
  /* A SWEEP is a stop-run: price trades THROUGH the pool of stops and CLOSES BACK
     on the other side of it. A bar that closes beyond the pool has not swept it —
     it has broken it, and is judged on its own shape. (Counting every break of the
     lows as a sweep would mark nearly every break as manipulation.) */
  for (var j = Math.max(1, i - 1); j <= i; j++) {
    var p = pools(j), b = cd[j];
    var hit = dir > 0 ? p.lows.some(function (lv) { return L(b) < lv && C(b) > lv; })    // long: under equal lows, closed back above
                      : p.highs.some(function (hv) { return H(b) > hv && C(b) < hv; });  // short: over equal highs, closed back below
    if (hit) return true;
  }
  return false;
}

/* ── B-1: the weight of the BREAKING bar (Q-1..Q-6), most sceptical wins ── */
function classifyBreak(cd, i, ctx) {
  var b = cd[i], s = shape(b, ctx.atr), level = ctx.level, dir = ctx.dir;
  var farExtreme = dir > 0 ? s.l : s.h;                     // how far the bar reached beyond the level
  var closePast = past(s.c, level, dir), reachPast = past(farExtreme, level, dir);
  var wickBeyond = reachPast - Math.max(0, closePast);      // wick beyond the close, on the far side
  var wellThrough = closePast >= CFG.WELL_THROUGH_ATR * ctx.atr;
  var ev = newsAt(b, ctx.tfMin, ctx.news, ctx.sym);
  var kinds = [];
  if (ctx.liq === 'man' || sweptPool(cd, i, dir, ctx.atr)) kinds.push(['sweep', CFG.W_SWEEP]);
  if (ev && (!CFG.NEWS_NEEDS_SIZE || s.strong || s.huge)) kinds.push(['news', CFG.W_NEWS]);
  if (thinAt(b, ctx.liq)) kinds.push(['thin', CFG.W_THIN]);
  if (s.huge && !ev) kinds.push(['huge', CFG.W_HUGE]);
  if (!wellThrough && wickBeyond >= CFG.WICK_TO_BODY * s.body) kinds.push(['wick', CFG.W_WICK]);
  if (!kinds.length) kinds.push(s.strong && wellThrough ? ['strong', CFG.W_STRONG] : ['modest', CFG.W_MODEST]);
  kinds.sort(function (a, b2) { return a[1] - b2[1]; });    // P9: the most sceptical weight wins
  return { kind: kinds[0][0], weight: kinds[0][1], all: kinds.map(function (k) { return k[0]; }),
           news: ev ? (ev.title || ev.event || 'high-impact release') : null,
           // D-1: where it closed — near its extreme in the break's direction, or back inside with a wick
           closeNearExtreme: dir > 0 ? s.closeLoc <= 0.25 : s.closeLoc >= 0.75,
           shape: s };
}

/* ── B-6: a gap — the bar OPENS beyond the level after a pause ─────── */
function gapAt(cd, i, ctx) {
  if (i < 1) return false;
  var prev = cd[i - 1], pause = T(cd[i]) - T(prev), bar = (ctx.tfMin || 60) * 60;
  return pause >= CFG.GAP_TF_MULT * bar && !beyond(C(prev), ctx.level, ctx.dir) && beyond(O(cd[i]), ctx.level, ctx.dir);
}

/* ── The whole reversal case against a level, bar by bar (Q-7..Q-10, B-5, B-6, B-7) ──
   Scans from ctx.from (usually the entry bar) to the last CLOSED bar.
   Returns everything Phase C needs; decides nothing. */
function trackBreak(cd, ctx) {
  var dir = ctx.dir, level = ctx.level, atr = ctx.atr;
  var tol = Math.max(CFG.RETEST_ATR * atr, CFG.RETEST_MIN_SPREADS * (ctx.spread || 0));
  var st = { breakAt: null, breakTag: null, conv: [], total: 0, fakeouts: [], retest: null, gap: false,
             grind: { bars: 0, distanceAtr: 0, met: false }, farthest: 0 };
  var last = cd.length - 1 - (ctx.lastIsForming ? 1 : 0);
  for (var i = Math.max(1, ctx.from || 1); i <= last; i++) {
    var c = C(cd[i]), isBeyond = beyond(c, level, dir);
    if (st.breakAt == null) {
      if (isBeyond && !beyond(C(cd[i - 1]), level, dir)) {            // the breaking bar
        var q = classifyBreak(cd, i, ctx);
        st.gap = gapAt(cd, i, ctx);
        st.breakAt = i;
        st.breakTag = { i: i, kind: st.gap ? 'gap' : q.kind, weight: q.weight, all: q.all, news: q.news,
                        closeNearExtreme: q.closeNearExtreme };      // Q-10: kept even after a fakeout
        st.conv = [{ i: i, v: q.weight, t: (st.gap ? 'gap' : q.kind) + ' ' + q.weight }];
        st.grind = { bars: 1, distanceAtr: past(c, level, dir) / atr, met: false };
      }
      continue;
    }
    if (!isBeyond) {                                                   // Q-9: back inside — a fakeout
      st.fakeouts.push({ i: i, brokeAt: st.breakAt, tag: st.breakTag });
      st.breakAt = null; st.conv = []; st.retest = null; st.gap = false;
      st.grind = { bars: 0, distanceAtr: 0, met: false };
      continue;
    }
    var prevC = C(cd[i - 1]);
    var further = dir > 0 ? c < prevC : c > prevC;
    st.conv.push(further ? { i: i, v: CFG.W_FOLLOW, t: '+' + CFG.W_FOLLOW.toFixed(1) }       // Q-8
                         : { i: i, v: CFG.W_FLAT_FOLLOW, t: '+' + CFG.W_FLAT_FOLLOW });      // P4
    // B-5: a retest — back within tol of the level from the far side, then the NEXT bar closes further away
    var nearLevel = dir > 0 ? H(cd[i]) >= level - tol : L(cd[i]) <= level + tol;
    if (!st.retest && nearLevel && i + 1 <= last && beyond(C(cd[i + 1]), level, dir) &&
        past(C(cd[i + 1]), level, dir) > past(c, level, dir))
      st.retest = { at: i, heldAt: i + 1 };
    // B-7: the grind — consecutive closes beyond, and the distance travelled
    st.grind.bars++; st.grind.distanceAtr = past(c, level, dir) / atr;
    st.grind.met = st.grind.bars >= CFG.GRIND_BARS && st.grind.distanceAtr >= CFG.GRIND_ATR;
  }
  st.total = st.conv.reduce(function (a, x) { return a + x.v; }, 0);
  if (st.breakAt != null) st.farthest = past(C(cd[last]), level, dir) / atr;
  return st;
}

var API = { CFG: CFG, shape: shape, newsAt: newsAt, thinAt: thinAt, sweptPool: sweptPool,
            classifyBreak: classifyBreak, gapAt: gapAt, trackBreak: trackBreak, beyond: beyond };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.BWReversal = API;
})(typeof window !== 'undefined' ? window : globalThis);
