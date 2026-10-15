/* bw-range.js — GENERATED from patterns.html by build-host.js. Do not edit by hand:
   it is the engine block from the page, copied VERBATIM. */
/* the page helpers it calls, VERBATIM */
function bwDate(v){
  if(v instanceof Date) return v;
  if(v === null || v === undefined || v === '') return new Date(NaN);
  if(typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v); // secs or ms
  var s = String(v).trim();
  if(/^\d+$/.test(s)){ var n = parseInt(s,10); return new Date(n < 1e12 ? n*1000 : n); }
  // 2026.08.09 -> 2026-08-09
  s = s.replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3');
  // "YYYY-MM-DD HH:MM(:SS)" -> "YYYY-MM-DDTHH:MM(:SS)"  (Safari needs the T)
  s = s.replace(/^(\d{4}-\d{2}-\d{2})[ ]+(\d{2}:\d{2})/, '$1T$2');
  var d = new Date(s);
  if(!isNaN(+d)) return d;
  // Last resort: pull the numbers out and build it explicitly.
  var m = s.match(/(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if(m) return new Date(+m[1], +m[2]-1, +m[3], +(m[4]||0), +(m[5]||0), +(m[6]||0));
  return new Date(NaN);
}
function bwBarMs(c){
  const v=c&&(c.t!=null?c.t:(c.time!=null?c.time:c.timestamp));
  if(v==null||v==='') return NaN;
  if(typeof v==='number'||/^\d+(\.\d+)?$/.test(String(v))){ const n=+v; return n<1e12?n*1000:n; }
  const d=(typeof bwDate==='function')?bwDate(v):new Date(v);
  return +d;
}
(function (root) {
  'use strict';

  /* Field accessors. The EA emits {t,o,h,l,c,v}; other shapes have
     turned up before, and a consumer that guesses field names is how
     four factors silently became NaN once already. */
  const O = c => +(c.o != null ? c.o : c.open);
  const H = c => +(c.h != null ? c.h : c.high);
  const L = c => +(c.l != null ? c.l : c.low);
  const C = c => +(c.c != null ? c.c : c.close);
  const V = c => +(c.v != null ? c.v : (c.volume != null ? c.volume : c.tick_volume)) || 0;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

  function pipOf(symbol) {
    const s = String(symbol || '').toUpperCase();
    if (s.indexOf('XAU') >= 0) return 0.1;
    if (s.indexOf('JPY') >= 0) return 0.01;
    return 0.0001;
  }

  function atr(cd, n) {
    const s = cd.slice(-n - 1);
    let sum = 0, k = 0;
    for (let i = 1; i < s.length; i++) {
      sum += Math.max(H(s[i]) - L(s[i]), Math.abs(H(s[i]) - C(s[i - 1])), Math.abs(L(s[i]) - C(s[i - 1])));
      k++;
    }
    return k ? sum / k : 0;
  }

  /* Distinct VISITS, not bars. Ten bars parked at the high is one test,
     not ten — counting bars is what once produced "tapped 60 times". */
  function visits(win, pred) {
    let n = 0, inside = false;
    for (const c of win) { const now = pred(c); if (now && !inside) n++; inside = now; }
    return n;
  }

  /* ── REGIME ────────────────────────────────────────────────────
     Efficiency = net travel ÷ ground actually covered. Near 1 is a
     trend; near 0 is rotation. Hysteresis matters more than the
     threshold: without a gap between entering and leaving, the display
     would swap engines every few bars and be unusable. A regime has to
     earn its place and then earn its exit. */
  /* ENTERING A RANGE IS HARDER THAN STAYING IN ONE.
     ENTER was 0.34, which a perfectly healthy trend reaches on its own:
     a leg that runs 100 pips and gives back 40 has covered 140 pips of
     ground for 60 net — 0.43 — and two such pullbacks drag it under
     0.34. The range engine then took over a plainly trending market,
     which is exactly what was being seen.
     ENTER is now 0.22 and EXIT stays 0.46. The gap between them is the
     hysteresis: once a range is established it is allowed to persist
     through a bit of directional movement, but claiming one in the first
     place takes real rotation. */
  const ENTER = 0.22, EXIT = 0.46, HOLD = 4, LOOK = 50;

  /* STRUCTURAL EVIDENCE — efficiency alone is not enough.
     A real range prints EQUAL highs and EQUAL lows: price returns to the
     same ceiling and the same floor. A trending pullback does not — it
     prints higher lows or lower highs, which is a different shape with a
     similar efficiency number. So the engine now asks the structure
     engine what the pivots actually look like before it will call a
     range, and refuses to call one on efficiency by itself. */
  const EQ_NEEDED = 1;        // at least one equal high or equal low
  function structureAgrees(cd){
    try{
      /* THE GOVERNED DOES NOT INTERPRET THE LAW.
         This used to call the structure engine directly, so the range
         engine was deciding for itself whether it was allowed to act.
         It now reads the MANDATE the governor already issued this cycle.
         If there is no mandate it declines rather than granting itself
         permission — safer default, and it keeps the hierarchy honest. */
      const m=root.__BWMandate;
      if(m && m.ok){
        return {known:true, eq:m.eq, labels:m.labels, regime:m.regime,
                confidence:m.confidence, dir:m.dir,
                rotating: m.permits.range,
                trendLock: !m.permits.range && m.regime!=='transition'};
      }
      if(!root.BWStructure) return {known:false};
      const r=root.BWStructure.read(cd);
      if(!r||!r.ok) return {known:false};
      const lab=(r.marked||[]).slice(-6).map(x=>x.label||'');
      const eq=lab.filter(x=>x.indexOf('EQ')===0).length;
      const dir=lab.filter(x=>x==='HH'||x==='HL').length -
                lab.filter(x=>x==='LH'||x==='LL').length;
      return {known:true, eq, labels:lab, regime:r.regime,
              confidence:r.confidence, dir:r.dir,
              /* Rotation looks like equal levels, or at least a mix with
                 no clear direction in the last few pivots. */
              rotating: eq>=EQ_NEEDED || (Math.abs(dir)<=1 && lab.length>=4),
              /* 3. A CONFIDENT TREND OVERRIDES EVERYTHING. The conductor
                 already knows this; the range engine simply was not
                 asking. */
              trendLock: (r.regime==='uptrend'||r.regime==='downtrend') && r.confidence>=0.85};
    }catch(e){ return {known:false}; }
  }
  /* Closes beyond the frozen break level before a breakout is confirmed.
     Same rule and the same reasoning as the pullback origin: one close
     can be given straight back. */
  const RANGE_CONFIRM = 2;
  /* Bars the turn back must hold before the level it retraced FROM is
     frozen. Same 1-to-3 band as the break confirmation. */
  const RANGE_TURN = 2;
  /* A breakout that never pulls back. The retrace-then-push rule can
     never fire on one, so it is also confirmed by DISTANCE (a close a
     full range-height beyond the wall) or TIME (this many closes outside
     without coming back in), whichever comes first. */
  const RANGE_OUT_BARS = 6;

  function efficiency(cd, look) {
    const win = cd.slice(-(look || LOOK));
    if (win.length < 24) return null;
    const net = Math.abs(C(win[win.length - 1]) - C(win[0]));
    let path = 0;
    for (let i = 1; i < win.length; i++) path += Math.abs(C(win[i]) - C(win[i - 1]));
    return path ? net / path : 1;
  }

  /* State is kept per symbol+timeframe. One shared slot would let a pair
     switch carry the previous pair's regime across, which is the same
     class of bug as the shared lastBarTime that broke H1/H4 dedupe. */
  const regimes = Object.create(null);

  function regimeFor(key, cd, look) {
    const eff = efficiency(cd, look);
    if (eff === null) return { regime: 'none', efficiency: null, bars: 0 };

    let st = regimes[key];
    if (!st) st = regimes[key] = { state: 'none', pending: null, held: 0, bars: 0, lastLen: 0, confirmed: false };

    // Only advance on a NEW bar. render() may run many times per bar
    // (pair switch, resize, poll) and counting those would inflate the
    // regime's age and trip the maturity factor early.
    const fresh = lastKey(cd) !== st.lastLen;
    st.lastLen = lastKey(cd);

    /* The efficiency reading is the FIRST gate, not the only one. */
    const sAg = structureAgrees(cd);
    let want = st.state === 'range' ? (eff > EXIT ? 'trend' : 'range')
                                    : (eff < ENTER ? 'range' : 'trend');
    /* Refuse to ENTER a range without structural agreement. Leaving one
       is deliberately not gated the same way — getting OUT of a range
       when price starts covering ground should stay easy, because being
       wrong in that direction costs a missed move rather than a trade
       taken against a trend. */
    if (want === 'range' && st.state !== 'range') {
      if (sAg.known && sAg.trendLock) want = 'trend';
      else if (sAg.known && !sAg.rotating) want = st.state;   // hold, do not claim a range
    }
    /* And never sit in a range while structure is confidently trending. */
    if (st.state === 'range' && sAg.known && sAg.trendLock) want = 'trend';

    /* COLD START. Hysteresis exists to damp CHANGES, not to delay the
       first answer. Requiring four new bars before classifying anything
       meant a page load on H1 showed nothing for four hours — the tab
       sat on "no trend" while the market plainly rotated, which is the
       exact situation this engine was built for. The first classification
       is immediate; every change after it still has to be earned.

       `bars` is seeded from the window rather than 0, because on a cold
       start the range has demonstrably been holding for the bars we can
       see — reporting "0 bars held" would understate it and trip the
       "young, likely to keep rotating" branch on a mature range. */
    if (st.state === 'none') {
      /* A cold start must not claim a range on efficiency alone either —
         that was the fastest route to the wrong answer, because it
         bypassed every gate above on the very first render. */
      if (want === 'range' && sAg.known && (sAg.trendLock || !sAg.rotating)) want = 'trend';
      st.state = want;
      st.pending = null; st.held = 0;
      st.bars = Math.min(cd.length, look || LOOK);
      st.confirmed = false;
      return { regime: st.state, efficiency: eff, bars: st.bars, pending: null, st, coldStart: true };
    }

    if (fresh) {
      if (want === st.state) { st.pending = null; st.held++; st.bars++; }
      else if (st.pending === want) {
        if (++st.held >= HOLD) {
          st.state = want; st.pending = null; st.held = 0; st.bars = 0;
          st.confirmed = false;      // a new episode must earn confirmation again
        }
        else st.bars++;
      } else { st.pending = want; st.held = 1; st.bars++; }
    }
    return { regime: st.state, efficiency: eff, bars: st.bars, pending: st.pending, st };
  }

  function resetRegime(key) { if (key) delete regimes[key]; else for (const k in regimes) delete regimes[k]; }

  /* ── THE BOX ───────────────────────────────────────────────────
     Levels are FROZEN when the range is confirmed, then watched.

     They used to be recomputed every bar from a sliding window, which
     made a break impossible to detect: the edges were derived from the
     same bars price was making, so price could never close outside its
     own box. On a breakout the low simply tracked price down and the
     box grew — 12 pips to 138 in one move — while the panel still said
     "range in force" and the trader held on. A level that moves is not
     a level.

     Up to two levels a side. The first is where the range was found;
     the second is added when price wicks beyond and closes back inside,
     because a false break widens the range rather than ending it. A
     third breach is not a wider range, it is a different market. */
  const ranges = Object.create(null);
  const releasedAt = Object.create(null);

  function seedRange(key, cd, look) {
    const win = cd.slice(-(look || LOOK));
    if (win.length < 24) return null;
    const hi = Math.max(...win.map(H)), lo = Math.min(...win.map(L));
    if (!(hi > lo)) return null;
    return {
      r1: hi, r2: null, s1: lo, s2: null,
      bornAt: cd.length,
      lastTouch: null,        // 'hi' | 'lo' — for the alternation test
      alternations: 0,        // edge -> other edge -> back = confirmed
      broke: null,            // 'up' | 'down' once genuinely RELEASED
      falseBreaks: 0,
      /* watch state — see updateRange */
      phase: 'holding', breakSide: null, breakExtreme: null, turnBars: 0,
      breakOrigin: null, holdBars: 0
    };
  }

  /* Watch the frozen levels against each new bar. */
  function updateRange(st, cd, atr14) {
    const c = cd[cd.length - 1];
    const hi = st.r2 !== null ? Math.max(st.r1, st.r2) : st.r1;
    const lo = st.s2 !== null ? Math.min(st.s1, st.s2) : st.s1;
    const height = hi - lo;
    const band = height * 0.15;

    // A break is a CLOSE beyond the level by more than noise, not a wick.
    // Wicks through a level are how ranges are defended, not how they end.
    const tol = Math.max(height * 0.04, (atr14 || 0) * 0.25);

    /* ── THE WALLS NEVER MOVE ────────────────────────────────────────
       This used to widen the box on the first close outside it. Widening
       is chasing price: the moment a range starts following the market
       it has stopped being a range and become a trailing channel. The
       walls stay exactly where they were seeded, always.

       A close outside no longer ENDS the range either. It moves the
       range from DECIDING to WATCHING: the pullback engine takes over
       the reading, and the box stays on the chart while we find out
       whether price is coming back.
         broken   — closed outside; watching, box still drawn
         retraced — price turned back; the extreme it turned FROM is
                    frozen as a static level outside the box
         holding  — closed back inside the ORIGINAL walls: the break was
                    false, and there is nothing to undo because nothing
                    was widened
         released — turned again and closed through the frozen level and
                    HELD it: a genuine breakout. Only here is the box
                    dropped and the range finished. */
    const phase = st.phase || 'holding';

    if (phase === 'holding') {
      if (C(c) > hi + tol)      { st.phase='broken'; st.breakSide='up';   st.breakExtreme=H(c); st.breakOrigin=null; st.holdBars=0; st.turnBars=0; st.outBars=1; }
      else if (C(c) < lo - tol) { st.phase='broken'; st.breakSide='down'; st.breakExtreme=L(c); st.breakOrigin=null; st.holdBars=0; st.turnBars=0; st.outBars=1; }
      if (st.phase === 'broken' && Math.abs(C(c) - (st.breakSide==='up'?hi:lo)) >= height){ st.broke = st.breakSide; st.releasedBy='distance'; }   /* one-bar blow-out */
    } else {
      const up = st.breakSide === 'up';

      /* THROUGH THE OTHER WALL. A move that breaks one side and then
         closes beyond the OTHER wall (a gap or a collapse straight through
         the box) left the old code stuck watching the first side forever.
         The first break was false; this is a new break on the other side. */
      if (up ? C(c) < lo - tol : C(c) > hi + tol) {
        st.falseBreaks++;
        st.breakSide = up ? 'down' : 'up'; st.phase = 'broken';
        st.breakExtreme = up ? L(c) : H(c); st.breakOrigin = null; st.holdBars = 0; st.turnBars = 0; st.outBars = 1;
        if (Math.abs(C(c) - (up ? lo : hi)) >= height){ st.broke = st.breakSide; st.releasedBy='distance'; }
      }
      /* BACK INSIDE BEFORE THE TURN HAD FROZEN ANYTHING. A close inside
         the original walls is the false break itself — waiting for two
         turn bars first left the range stuck in "broken" while price sat
         back in the box. */
      else if (st.phase === 'broken' && C(c) <= hi && C(c) >= lo) {
        st.phase='holding'; st.breakSide=null; st.breakOrigin=null;
        st.breakExtreme=null; st.holdBars=0; st.turnBars=0; st.falseBreaks++;
      }
      /* STILL OUTSIDE: distance or time confirms it, whichever is first. */
      else if ((up ? C(c) > hi : C(c) < lo) &&
               ((up ? C(c) - hi : lo - C(c)) >= height || (st.outBars = (st.outBars || 0) + 1) >= RANGE_OUT_BARS)) {
        st.broke = st.breakSide;
        st.releasedBy = (up ? C(c) - hi : lo - C(c)) >= height ? 'distance' : 'time';
      }
      else if (st.phase === 'broken') {
        const ext = up ? H(c) : L(c);
        if (up ? ext > st.breakExtreme : ext < st.breakExtreme) {
          st.breakExtreme = ext;                       // still pushing away
        } else if (cd.length > 1 && (up ? C(c) < C(cd[cd.length-2]) : C(c) > C(cd[cd.length-2]))) {
          /* THE TURN HAS TO HOLD BEFORE THE LEVEL IS FROZEN.
             Freezing on a single bar that closed the other way meant one
             soft candle inside a strong break stamped the level almost at
             the break itself — and the breakout then "confirmed" against a
             price that never meant anything. Same rule as everywhere else
             in these two engines: it has to survive a bar or two. */
          st.turnBars = (st.turnBars || 0) + 1;
          if (st.turnBars >= RANGE_TURN) {
            st.phase='retraced';
            st.breakOrigin=st.breakExtreme;            // frozen from here on
          }
        } else {
          st.turnBars = 0;                             // pushed on again
        }
      } else if (st.phase === 'retraced') {
        if (C(c) <= hi && C(c) >= lo) {
          /* Back inside the original walls — false break. */
          st.phase='holding'; st.breakSide=null; st.breakOrigin=null;
          st.breakExtreme=null; st.holdBars=0; st.turnBars=0; st.falseBreaks++;
        } else if (st.breakOrigin !== null &&
                   (up ? C(c) > st.breakOrigin : C(c) < st.breakOrigin)) {
          st.holdBars = (st.holdBars || 0) + 1;
          if (st.holdBars >= RANGE_CONFIRM){ st.broke = st.breakSide; st.releasedBy='origin'; }   // released
        } else {
          st.holdBars = 0;
        }
      }
    }

    // Alternation: touched one edge, then the other, then back.
    // That is what makes a range a range rather than two coincidences.
    if (H(c) >= hi - band) {
      if (st.lastTouch === 'lo') st.alternations++;
      st.lastTouch = 'hi';
    } else if (L(c) <= lo + band) {
      if (st.lastTouch === 'hi') st.alternations++;
      st.lastTouch = 'lo';
    }
    return st;
  }

  function boxOf(st, cd, bars) {
    const hi = st.r2 !== null ? Math.max(st.r1, st.r2) : st.r1;
    const lo = st.s2 !== null ? Math.min(st.s1, st.s2) : st.s1;
    const height = hi - lo;
    const band = height * 0.15;
    const win = cd.slice(-(LOOK));
    return {
      hi, lo, height, mid: (hi + lo) / 2,
      r1: st.r1, r2: st.r2, s1: st.s1, s2: st.s2,
      touchHi: visits(win, c => H(c) >= hi - band),
      touchLo: visits(win, c => L(c) <= lo + band),
      alternations: st.alternations,
      confirmed: st.alternations >= 2,
      falseBreaks: st.falseBreaks,
      age: bars || 0,
      band
    };
  }

  /* ── SCORE ─────────────────────────────────────────────────────
     0-100. Above 50 leans break of the edge price is at; below 50 leans
     rotation back across. Symmetric: the same arithmetic runs whether
     price is at the top or the bottom, so an upside break and a downside
     break are read identically. */
  const KIND_LABEL = {
    'bull-rev': 'bullish reversal', 'bear-rev': 'bearish reversal',
    'bull-cont': 'bullish continuation', 'bear-cont': 'bearish continuation',
    'neutral': 'indecision'
  };

  // Maps the detector's pattern names onto families. Anything unknown is
  // treated as indecision rather than guessed at — a wrong family is
  // worse than no family, because it would score with confidence.
  const FAMILY = {
    'hammer': 'bull-rev', 'inverted hammer': 'bull-rev', 'bullish engulfing': 'bull-rev',
    'piercing line': 'bull-rev', 'piercing': 'bull-rev', 'morning star': 'bull-rev',
    'three white soldiers': 'bull-rev', 'bullish harami': 'bull-rev', 'tweezer bottom': 'bull-rev',
    'dragonfly doji': 'bull-rev', 'bullish counterattack': 'bull-rev',
    'shooting star': 'bear-rev', 'hanging man': 'bear-rev', 'bearish engulfing': 'bear-rev',
    'dark cloud cover': 'bear-rev', 'dark cloud': 'bear-rev', 'evening star': 'bear-rev',
    'three black crows': 'bear-rev', 'bearish harami': 'bear-rev', 'tweezer top': 'bear-rev',
    'gravestone doji': 'bear-rev', 'bearish counterattack': 'bear-rev',
    'rising three methods': 'bull-cont', 'bullish marubozu': 'bull-cont', 'upside tasuki gap': 'bull-cont',
    'falling three methods': 'bear-cont', 'bearish marubozu': 'bear-cont', 'downside tasuki gap': 'bear-cont',
    'doji': 'neutral', 'spinning top': 'neutral', 'high wave': 'neutral', 'long-legged doji': 'neutral'
  };

  function familyOf(p) {
    if (!p) return 'neutral';
    if (p.kind && KIND_LABEL[p.kind]) return p.kind;
    const n = String(p.name || p.pattern || '').toLowerCase().trim();
    if (FAMILY[n]) return FAMILY[n];
    for (const key in FAMILY) if (n.indexOf(key) >= 0) return FAMILY[key];
    // Fall back to a stated direction if the detector gave one.
    const d = p.direction || p.bias || p.type;
    if (/bull/i.test(d || '')) return 'bull-rev';
    if (/bear/i.test(d || '')) return 'bear-rev';
    return 'neutral';
  }
  const dirOf = k => (k === 'bull-rev' || k === 'bull-cont') ? 1
                   : (k === 'bear-rev' || k === 'bear-cont') ? -1 : 0;

  function confOf(p) {
    // confidence_pct ?? confidence, NOT || — a genuine 0 is a reading.
    return p.confidence_pct != null ? +p.confidence_pct
         : p.confidence != null ? +p.confidence : 0;
  }

  function score(cd, r, pats) {
    const px = C(cd[cd.length - 1]);
    const pos = (px - r.lo) / r.height;              // 0 at support, 1 at resistance
    const atTop = pos > 0.5;
    const near = atTop ? 'resistance' : 'support';
    const edgeness = Math.abs(pos - 0.5) * 2;
    const F = [];

    const aNow = atr(cd, 14), aThen = atr(cd.slice(0, -14), 14);
    const squeeze = aThen ? 1 - aNow / aThen : 0;
    F.push({ name: 'Volatility compression',
      detail: squeeze > 0.12 ? 'range is tightening — energy building'
            : squeeze < -0.12 ? 'range is widening — already expanding' : 'volatility steady',
      pts: Math.round(clamp(squeeze * 70, -14, 20)) });

    const vR = avg(cd.slice(-6).map(V)), vP = avg(cd.slice(-20, -6).map(V));
    const vr = vP ? vR / vP : 1;
    F.push({ name: 'Volume on approach',
      detail: !vP ? 'no volume data on this feed'
            : vr > 1.25 ? 'volume rising into the edge'
            : vr < 0.8 ? 'volume falling away — drifting, not pushing' : 'volume unremarkable',
      pts: !vP ? 0 : Math.round(clamp((vr - 1) * 40, -16, 22)) });

    const tests = atTop ? r.touchHi : r.touchLo;
    F.push({ name: 'Times this edge tested',
      detail: tests + ' visit' + (tests === 1 ? '' : 's') + ' — ' +
        (tests >= 4 ? 'orders there are getting used up' : tests >= 3 ? 'starting to wear' : 'still well defended'),
      pts: tests >= 4 ? 18 : tests >= 3 ? 9 : -8 });

    F.push({ name: 'Position in range',
      detail: edgeness > 0.7 ? 'pressed against ' + near
            : edgeness > 0.35 ? 'drifting toward ' + near
            : 'middle of the range — neither side is close',
      pts: Math.round(clamp((edgeness - 0.4) * 30, -12, 14)) });

    const atEdgeBars = cd.slice(-5).filter(c => atTop ? H(c) >= r.hi - r.band : L(c) <= r.lo + r.band);
    let rej = 0;
    for (const c of atEdgeBars) {
      const rng = H(c) - L(c);
      if (rng > 0) rej += (atTop ? (H(c) - Math.max(O(c), C(c))) : (Math.min(O(c), C(c)) - L(c))) / rng;
    }
    rej = atEdgeBars.length ? rej / atEdgeBars.length : 0;
    F.push({ name: 'Rejection at the edge',
      detail: !atEdgeBars.length ? 'not at an edge yet'
            : rej > 0.45 ? 'long wicks — the edge is being defended'
            : rej < 0.2 ? 'closing at the edge, not rejecting' : 'mixed',
      pts: !atEdgeBars.length ? 0 : Math.round(clamp((0.32 - rej) * 60, -18, 16)) });

    F.push({ name: 'Range age',
      detail: r.age + ' bars held — ' + (r.age > 45 ? 'mature, resolution overdue'
            : r.age > 25 ? 'established' : 'young, likely to keep rotating'),
      pts: r.age > 45 ? 10 : r.age > 25 ? 3 : -9 });

    const hAtr = aNow ? r.height / aNow : 0;
    F.push({ name: 'Range height vs volatility',
      detail: hAtr.toFixed(1) + '× ATR — ' + (hAtr < 2.5 ? 'tight enough that noise alone can break it'
            : hAtr > 6 ? 'wide, both edges genuinely defended' : 'normal'),
      pts: hAtr < 2.5 ? 12 : hAtr > 6 ? -10 : 0 });

    const edgePat = recentEdgePattern(cd, r, pats);
    if (edgePat) {
      const k = familyOf(edgePat), d = dirOf(k);
      const towardBreak = (atTop && d > 0) || (!atTop && d < 0);
      let pts, why;
      if (k === 'neutral') { pts = 0; why = 'indecision — says nothing about which side wins'; }
      else if (k === 'bull-cont' || k === 'bear-cont') {
        pts = towardBreak ? 20 : -8;
        why = towardBreak ? 'continuation pushing into the edge' : 'continuation pointing back across the range';
      } else {
        pts = towardBreak ? 16 : -16;
        why = towardBreak ? 'reversal pointing through the edge' : 'reversal pointing back into the range';
      }
      F.push({ name: 'Pattern at the edge',
        detail: (edgePat.name || 'pattern') + ' (' + KIND_LABEL[k] + ') at ' + confOf(edgePat) + '% — ' + why, pts });
    } else {
      F.push({ name: 'Pattern at the edge', detail: 'none at 80%+ in the last few bars', pts: 0 });
    }

    /* A call is only as strong as price's proximity to the edge being
       called. Without this, mild factors at mid-range produce a
       confident-looking number about an event that is not close. */
    const raw = F.reduce((a, f) => a + f.pts, 0);
    const conviction = clamp((edgeness - 0.3) / 0.6, 0, 1);
    const s = Math.round(clamp(50 + raw * conviction, 2, 98));

    let state, plain;
    if (edgeness < 0.35) {
      state = 'watch';
      plain = 'Price is mid-range, so neither edge is in play. Resistance is at ' + r.hi.toFixed(5) +
              ' and support at ' + r.lo.toFixed(5) + '.';
    } else if (s >= 62) {
      state = 'break';
      plain = 'The evidence leans toward a break of ' + near + '. ' + topReason(F, 1);
    } else if (s <= 38) {
      state = 'rotate';
      plain = 'The evidence leans toward this edge holding and price rotating back across the range. ' + topReason(F, -1);
    } else {
      state = 'watch';
      plain = 'Price is at ' + near + ' but the evidence is split — this is the state where a range is ' +
              'genuinely undecided rather than quietly favouring one side.';
    }

    return { score: s, state, plain, factors: F, pos, near, atTop, edgeness, edgePattern: edgePat };
  }

  function topReason(F, sign) {
    const f = F.filter(x => sign > 0 ? x.pts > 0 : x.pts < 0).sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))[0];
    return f ? 'Mostly because ' + f.name.toLowerCase() + ': ' + f.detail + '.' : '';
  }

  function recentEdgePattern(cd, r, pats) {
    if (!pats || !pats.length) return null;
    const lastT = bwBarMs(cd[cd.length - 1]) || 0;
    const px = C(cd[cd.length - 1]);
    const atTop = px > r.mid;
    const hits = pats.filter(p => {
      if (confOf(p) < 80) return null;
      // "Recent" by time where a timestamp exists, otherwise trust the
      // detector's own ordering rather than inventing an index.
      const t = bwBarMs({ t: p.time || p.t || p.detected_at }) || 0;
      if (lastT && t) {
        const bars = (lastT - t) / barMs(cd);
        if (bars < -1 || bars > 4) return false;
      }
      return true;
    });
    if (!hits.length) return null;
    // Only counts if it fired AT the edge price is testing.
    const near = hits.filter(p => {
      const lvl = +(p.price != null ? p.price : px);
      return atTop ? lvl >= r.hi - r.height * 0.18 : lvl <= r.lo + r.height * 0.18;
    });
    return (near.length ? near : hits).pop();
  }

  /* Identity of the newest bar. Array length stops changing once the
     stored series reaches its cap, so length cannot be used to spot a
     new bar. */
  function lastKey(cd) {
    const t = bwBarMs(cd[cd.length - 1]);
    return isFinite(t) && t ? t : cd.length;
  }
  function barMs(cd) {
    if (cd.length < 2) return 3600000;
    const a = bwBarMs(cd[cd.length - 1]) || 0;
    const b = bwBarMs(cd[cd.length - 2]) || 0;
    const d = Math.abs(a - b);
    return d > 0 ? d : 3600000;
  }

  /* ── WHAT THE RANGE IS OFFERING ────────────────────────────────
     Describes a situation. Never instructs. Software that says "sell
     here" has taken a decision that was not its to take, and deserves
     the blame when it is wrong — so this reports what fired, where, what
     the range's own levels are, and what usually follows. */
  function edgeRead(cd, r, v, symbol) {
    const p = v.edgePattern;
    if (!p) return null;
    const pip = pipOf(symbol);
    const atTop = v.atTop;
    const edge = atTop ? 'resistance' : 'support';
    const edgePx = atTop ? r.hi : r.lo, farPx = atTop ? r.lo : r.hi;
    const px = C(cd[cd.length - 1]);
    const k = familyOf(p), d = dirOf(k);
    const name = p.name || 'Pattern';
    const base = { pattern: p, name, kind: k, family: KIND_LABEL[k], conf: confOf(p), edge, edgePx, farPx, price: px, atTop };

    if (k === 'neutral') {
      return Object.assign(base, { read: 'indecision',
        headline: 'Indecision at ' + edge,
        line: name + ' is an indecision candle and it fired while price was testing ' + edge + ' at ' +
              edgePx.toFixed(5) + '. Neither side won that test. Ranges produce these at the edges and often ' +
              'keep rotating, but on its own it says less about what comes next than a reversal or a ' +
              'continuation would.' });
    }

    if (k === 'bull-cont' || k === 'bear-cont') {
      const toward = (atTop && d > 0) || (!atTop && d < 0);
      return Object.assign(base, { read: toward ? 'pressure' : 'rotation-weak',
        headline: toward ? 'Pressure on ' + edge : 'Continuation against ' + edge,
        line: toward
          ? name + ' is a continuation pattern and it fired pushing into ' + edge + ' at ' + edgePx.toFixed(5) +
            '. Continuation into an edge is the shape ranges tend to end on rather than rotate from, and it is ' +
            'the situation where fading an edge has historically gone worst.'
          : name + ' points away from ' + edge + ', back across the range. It leans the same way a rotation ' +
            'would, though a continuation pattern says more about the move it continues than about the edge ' +
            'it is leaving.' });
    }

    const pointsBack = (atTop && d < 0) || (!atTop && d > 0);
    if (pointsBack) {
      const nearFar = atTop ? farPx + r.height * 0.12 : farPx - r.height * 0.12;
      const beyond  = atTop ? edgePx + r.height * 0.10 : edgePx - r.height * 0.10;
      const across  = Math.abs(nearFar - px) / pip;
      const toInval = Math.abs(px - beyond) / pip;
      return Object.assign(base, { read: 'rotation',
        headline: 'The range is offering a rotation from ' + edge,
        nearFar, beyond, across, toInval, ratio: toInval > 0 ? across / toInval : 0,
        line: name + ' fired at ' + edge + ' while the range is still holding. When that happens inside a ' +
              'range, price more often rotates back across it than breaks — which is why a trader watching a ' +
              'chop has something to weigh rather than only a reason to wait. It stops being that situation ' +
              'the moment price closes beyond ' + edgePx.toFixed(5) + '.' });
    }

    return Object.assign(base, { read: 'pressure',
      headline: edge.charAt(0).toUpperCase() + edge.slice(1) + ' under pressure',
      line: name + ' fired at ' + edge + ' but points through it, not back into the range. A strong reversal ' +
            'in the direction of the break is one of the ways ranges end, and fading the edge here is the ' +
            'read that loses when a range is finishing rather than continuing.' });
  }

  /* ── PUBLIC ────────────────────────────────────────────────────
     One call. Returns regime 'trend' and nothing else when the pullback
     engine should be driving — the caller keeps rendering that engine
     exactly as it does now. */
  /* One answer per bar. read() advances state, so calling it twice for
     the same bar used to give two different answers — the first call
     consumed the break and cleared the state, the second saw a trend.
     The page renders on polls, tab switches, zooms and resizes, so the
     break notice would appear once and then vanish while price was
     still outside the range. The result is now computed once per bar
     and replayed for every other caller. */
  const lastRead = Object.create(null);

  function read(opts) {
    const cd = (opts && opts.candles) || [];
    const key = (opts.symbol || '?') + '|' + (opts.timeframe || '?');
    if (cd.length < 30) return { regime: 'none', reason: 'needs at least 30 bars on this timeframe' };

    const cached = lastRead[key];
    if (cached && cached.len === lastKey(cd) && cached.pats === ((opts.patterns || []).length) && cached.sr === !!opts.structureRange) {
      return cached.out;
    }
    const out = compute(opts, cd, key);
    lastRead[key] = { len: lastKey(cd), pats: (opts.patterns || []).length, sr: !!opts.structureRange, out };
    return out;
  }

  function compute(opts, cd, key) {
    const DG = /JPY/.test(String(opts.symbol||'').toUpperCase()) ? 3 : /XAU|XAG/.test(String(opts.symbol||'').toUpperCase()) ? 2 : 5;   /* 154.748, not 154.74800 */

    const rg = regimeFor(key, cd, opts.look || LOOK);
    /* STRUCTURE HAS ALREADY CALLED IT A RANGE. The governor hands the
       market to this engine only when the pivots themselves show
       rotation, and that is the structural agreement this engine's own
       entry gate waits for. Refusing the hand-over left the screen saying
       "range engine driving" with no box drawn and every position told
       "no confirmed range". So the box is marked when structure says so;
       nothing else about it changes — it is still seeded once and frozen. */
    /* Not straight after a breakout: structure lags a few bars, and a new
       box drawn around the breakout it just confirmed would undo it. */
    const relT = releasedAt[key], nowT = bwBarMs(cd[cd.length - 1]);
    const cooling = relT && isFinite(nowT) && (nowT - relT) < RANGE_OUT_BARS * barMs(cd);
    if (opts.structureRange && !cooling && rg.regime !== 'range' && !(ranges[key] && ranges[key].broke)) {
      const rs = regimes[key];
      if (rs) { rs.state = 'range'; rs.pending = null; rs.held = 0; }
      rg.regime = 'range';
    }

    /* THE BOX IS FROZEN UNTIL IT IS RESOLVED. A range already marked
       (confirmed, or broken and being watched) used to be DELETED the
       moment the efficiency reading left 'range' — which a breakout does
       within a few bars — so the box vanished mid-break, before the break
       was confirmed or shown false, and the next range was seeded
       somewhere else. It now stays until the engine itself resolves it:
       released (genuine breakout) or back inside and holding (false break).
       Only a range that never got past FORMING is dropped. */
    const held = ranges[key];
    const committed = held && (held.phase !== 'holding' || held.alternations >= 2);
    if (rg.regime !== 'range' && !committed) {
      delete ranges[key];                      // a new episode starts clean
      return { regime: rg.regime, efficiency: rg.efficiency, bars: rg.bars,
               reason: rg.regime === 'trend' ? 'price is travelling, not rotating' : 'reading market' };
    }

    // Seed the levels ONCE, at the moment the range is found. From here
    // they are watched, not recomputed.
    /* CLOSED BARS ONLY, EVERY ONE, IN ORDER.
       This used to judge the NEWEST bar once, the moment it appeared —
       which is the bar that has only just opened, so its "close" was its
       opening tick and its high/low a few points wide. Breaks, turns and
       edge touches were all read off a bar with nothing in it yet. And it
       looked at one bar per render, so any bars that closed while the page
       was on another pair, another tab or asleep were never examined: a
       break that happened then was simply missed.
       Now each bar is judged once, when it has CLOSED, and on return every
       closed bar since the last one seen is replayed in order. */
    const closed = cd.length > 1 ? cd.slice(0, -1) : cd;
    let st = ranges[key];
    if (!st) {
      st = seedRange(key, closed, opts.look || LOOK);
      /* Handed over by structure: the walls are the swing highs and lows
         structure marked for the rotation, not the whole 50-bar window,
         which on a fresh range still holds the tail of the trend before it. */
      if (st && opts.structureRange && Array.isArray(opts.pivots) && opts.pivots.length >= 4) {
        const pv = opts.pivots.slice(-4);
        const hs = pv.filter(q => q.type === 'H').map(q => +q.p), ls = pv.filter(q => q.type === 'L').map(q => +q.p);
        if (hs.length && ls.length) {
          const h2 = Math.max.apply(null, hs), l2 = Math.min.apply(null, ls);
          if (h2 > l2) { st.r1 = h2; st.s1 = l2; st.alternations = Math.max(st.alternations, 2); }
        }
      }
      if (!st) return { regime: 'none', reason: 'not enough bars to mark a range' };
      ranges[key] = st;
      st.lastT = bwBarMs(closed[closed.length - 1]) || 0;
      st.lastN = closed.length;
    } else {
      const lt = bwBarMs(closed[closed.length - 1]);
      if (isFinite(lt) && lt) {
        if (lt > (st.lastT || 0)) {
          let i0 = closed.length - 1;
          while (i0 > 0 && (bwBarMs(closed[i0 - 1]) || 0) > (st.lastT || 0)) i0--;
          for (let i = i0; i < closed.length && !st.broke; i++) {
            const sub = closed.slice(0, i + 1);
            updateRange(st, sub, atr(sub, 14));
          }
          st.lastT = lt;
        }
      } else if (closed.length !== st.lastN) {        /* no readable times: newest closed bar only */
        updateRange(st, closed, atr(closed, 14));
      }
      st.lastN = closed.length;
    }

    /* BROKEN. Hand back immediately — do not wait for the trend reading
       to catch up. Efficiency is measured over 50 bars, so during the
       first bars of a breakout most of that window is still the old
       chop and the meter keeps reporting "no trend". That lag is
       precisely when a trader needs to be told the range is over. */
    /* RELEASED — the break survived. Only now is the range finished and
       the box taken off the chart. */
    if (st.broke) {
      const box = boxOf(st, cd, rg.bars);
      const origin = st.breakOrigin;
      delete ranges[key];
      forceTrend(key);
      const by = st.releasedBy || 'origin';
      releasedAt[key] = bwBarMs(cd[cd.length - 1]) || 0;
      return { regime: 'released', brokeSide: st.broke, range: box, watch: null, releasedBy: by,
               efficiency: rg.efficiency, bars: rg.bars,
               reason: by === 'distance' ? 'price closed a full range-height beyond the wall — the breakout is genuine, so the range is done'
                     : by === 'time' ? 'price closed outside the walls for ' + RANGE_OUT_BARS + ' bars without coming back in — the breakout is genuine, so the range is done'
                     : 'price closed through ' + (origin!=null?origin.toFixed(DG):'the break level') +
                       ' and held it — the breakout is genuine, so the range is done' };
    }

    /* WATCHING — closed outside, but not finished. The pullback engine
       takes over the reading; the box stays drawn and we watch for the
       return. Handing the reading over immediately matters: efficiency
       is measured over 50 bars, so during the first bars of a break most
       of that window is still the old chop. */
    if (st.phase === 'broken' || st.phase === 'retraced') {
      const box = boxOf(st, cd, rg.bars);
      return { regime: 'watching', brokeSide: st.breakSide, range: box,
               efficiency: rg.efficiency, bars: rg.bars,
               watch: { phase: st.phase, side: st.breakSide,
                        origin: st.breakOrigin, holdBars: st.holdBars || 0,
                        needs: Math.max(0, RANGE_CONFIRM - (st.holdBars || 0)) },
               reason: st.phase === 'broken'
                 ? 'price closed ' + (st.breakSide === 'up' ? 'above ' + box.hi.toFixed(DG)
                                                            : 'below ' + box.lo.toFixed(DG)) +
                   ' — the pullback engine has the reading; the range is watching for a return'
                 : 'price turned back from ' + (st.breakOrigin!=null?st.breakOrigin.toFixed(DG):'the extreme') +
                   ' — back inside the walls and the break was false, through that level and it is genuine' };
    }

    const r = boxOf(st, cd, rg.bars);

    /* Not yet a confirmed range. Price has to visit one edge, reach the
       other, and come back before two levels become a range rather than
       two prices that happen to bound some bars. */
    if (!r.confirmed && r.touchHi < 2 && r.touchLo < 2 && !opts.structureRange) {
      return { regime: 'forming', range: r, efficiency: rg.efficiency, bars: rg.bars,
               reason: 'watching ' + r.lo.toFixed(DG) + ' and ' + r.hi.toFixed(DG) +
                       ' — price has not yet crossed between them enough to call it a range' };
    }

    const v = score(cd, r, opts.patterns || []);
    const offer = edgeRead(cd, r, v, opts.symbol);
    const pip = pipOf(opts.symbol);
    return {
      regime: 'range', range: r, verdict: v, offer,
      efficiency: rg.efficiency, bars: rg.bars,
      heightPips: r.height / pip, pip
    };
  }

  /* Push the regime machine to 'trend' at once. Without this the range
     state would be re-seeded on the very next bar and the box would
     reappear around the breakout it just failed to survive. */
  function forceTrend(key) {
    const st = regimes[key];
    if (st) { st.state = 'trend'; st.pending = null; st.held = 0; st.bars = 0; st.confirmed = false; }
  }

  root.BWRange = { read, resetRegime, familyOf, KIND_LABEL, efficiency, score, edgeRead, pipOf, seedRange, updateRange, boxOf };

})(typeof window !== 'undefined' ? window : globalThis);
