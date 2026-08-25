/* ═══════════════════════════════════════════════════════════════
   range-engine.js — the choppy-market half of the Retracement tab.

   Load AFTER retracement.js and before the page script.
   NOTE: no literal script tags in this comment. An HTML parser ends the
   surrounding block at the first closing script tag it sees, even inside
   a JavaScript comment — which silently truncates the file at that
   point and leaves half an engine on the page.

   WHY THIS EXISTS
   The pullback engine answers "is this a pullback or a reversal?", which
   is the right question in a trend and the wrong one in a chop — there
   is no trend to retrace from, so it correctly reports "no established
   trend" and then sits there while price rotates between two levels the
   trader can plainly see. This fills that gap.

   WHAT IT DOES NOT DO
   It does not replace, wrap or modify BWRetracement. When the market is
   trending, this module returns regime 'trend' and gets out of the way.
   The pullback engine keeps doing exactly what it does today, including
   its pullback-versus-reversal call — that distinction is the whole
   value of that engine and nothing here touches it.

   DIRECTION-NEUTRAL BY CONSTRUCTION
   A range can form after an uptrend or a downtrend, and can break either
   way from either. Nothing below assumes a direction: edges are the
   session's own high and low, and every read is expressed relative to
   the edge price is AT, not relative to "up" or "down".
   ═══════════════════════════════════════════════════════════════ */
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
  const ENTER = 0.34, EXIT = 0.46, HOLD = 4, LOOK = 50;

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
    const fresh = cd.length !== st.lastLen;
    st.lastLen = cd.length;

    const want = st.state === 'range' ? (eff > EXIT ? 'trend' : 'range')
                                      : (eff < ENTER ? 'range' : 'trend');
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
     Edges are the session's own extremes over the window. Deliberately
     not "day high/low from the daily candle": on H4 a day is six bars,
     and the level traders are actually reacting to is the one this
     rotation has been respecting. */
  function markRange(cd, look, bars) {
    const win = cd.slice(-(look || LOOK));
    if (win.length < 24) return null;
    const hi = Math.max(...win.map(H)), lo = Math.min(...win.map(L));
    const height = hi - lo;
    if (!(height > 0)) return null;
    const band = height * 0.15;
    return {
      hi, lo, height, mid: (hi + lo) / 2,
      touchHi: visits(win, c => H(c) >= hi - band),
      touchLo: visits(win, c => L(c) <= lo + band),
      // Age is how long the RANGE REGIME has held. Measuring how far
      // back the edges survive cannot work: the edges are derived from
      // this very window, so that number can never fall below the window
      // size and the "young range" branch would be unreachable.
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
    const lastT = +new Date(cd[cd.length - 1].t || cd[cd.length - 1].time || 0) || 0;
    const px = C(cd[cd.length - 1]);
    const atTop = px > r.mid;
    const hits = pats.filter(p => {
      if (confOf(p) < 80) return null;
      // "Recent" by time where a timestamp exists, otherwise trust the
      // detector's own ordering rather than inventing an index.
      const t = +new Date(p.time || p.t || p.detected_at || 0) || 0;
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

  function barMs(cd) {
    if (cd.length < 2) return 3600000;
    const a = +new Date(cd[cd.length - 1].t || cd[cd.length - 1].time || 0);
    const b = +new Date(cd[cd.length - 2].t || cd[cd.length - 2].time || 0);
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
  function read(opts) {
    const cd = (opts && opts.candles) || [];
    const key = (opts.symbol || '?') + '|' + (opts.timeframe || '?');
    if (cd.length < 30) return { regime: 'none', reason: 'needs at least 30 bars on this timeframe' };

    const rg = regimeFor(key, cd, opts.look || LOOK);
    if (rg.regime !== 'range') {
      return { regime: rg.regime, efficiency: rg.efficiency, bars: rg.bars,
               reason: rg.regime === 'trend' ? 'price is travelling, not rotating' : 'reading market' };
    }

    const r = markRange(cd, opts.look || LOOK, rg.bars);
    if (!r) return { regime: 'none', reason: 'not enough bars to mark a range' };

    /* Two visits each side or it is not a level, it is a coincidence.
       But once an episode has earned that, it KEEPS it until the regime
       itself changes: the touch count is measured over a sliding window,
       so an unchanged range dips back under the threshold as old visits
       fall off the back — and the box would flicker in and out while the
       market did nothing at all. */
    if (!rg.st.confirmed) {
      if (r.touchHi < 2 || r.touchLo < 2) {
        return { regime: 'forming', range: r, efficiency: rg.efficiency, bars: rg.bars,
                 reason: 'edges not tested enough yet — ' + r.touchHi + ' above, ' + r.touchLo + ' below' };
      }
      rg.st.confirmed = true;
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

  root.BWRange = { read, resetRegime, familyOf, KIND_LABEL, efficiency, markRange, score, edgeRead, pipOf };

})(typeof window !== 'undefined' ? window : globalThis);
