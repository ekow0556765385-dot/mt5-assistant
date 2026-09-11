/* ══════════════════════════════════════════════════════════════════
   THE HISTORIAN

   THE GAP THIS FILLS — measured, not assumed
   Fed 200 real bars one at a time, the governor passed through
   transition -> range -> uptrend -> downtrend and kept NONE of it:

       heldFor : 0        (even after 200 bars)
       events  : 0
       brief   : every field is about the CURRENT window only

   So the governor re-reads a window each bar and forms a fresh opinion.
   It cannot tell a first pullback from the third failed reversal in the
   same downtrend, because it has no memory that the first two happened.
   That is exactly the sequence he described: downtrend, chop, range,
   resume, pullback, near-reversal, resume — every stage of which the
   governor sees as an unrelated snapshot.

   THE CLOCK IS THE BAR, NOT THE WALL
   He proposed a seconds timer. Market structure changes on BAR CLOSE;
   a wall-clock timer would re-report identical information or race the
   bar update. `observe()` is called once per closed bar, and
   `peek()` may be called any time for the bar still forming.

   WHAT IT RECORDS
     1. the regime SEQUENCE, with the bar range each one occupied
     2. every DECISIVE LEVEL, and how many times it has been tested and
        held — this is the number that answers "is this a real reversal"
     3. FAILED REVERSALS inside the current trend
     4. how long the current state has actually lasted

   WHAT IT DOES NOT DO
   It does not decide anything. It hands the governor a context object
   and the governor decides with both: what the market looks like now,
   and what it has been doing.
   ══════════════════════════════════════════════════════════════════ */
(function(root){
'use strict';

const H=c=>+(c.h!==undefined?c.h:c.high);
const L=c=>+(c.l!==undefined?c.l:c.low);
const C=c=>+(c.c!==undefined?c.c:c.close);

const MAX_ERAS   = 40;    /* regime spells kept */
const MAX_LEVELS = 24;    /* decisive levels tracked */
const HOLD_BARS  = 3;     /* the platform-wide definition of "held" */

function create(opts){
  opts=opts||{};
  const pip = opts.pip || 0.0001;
  const S = {
    bars: 0,
    eras: [],          /* [{regime, from, to, bars}] */
    levels: [],        /* [{price, kind, born, tests, holds, breaks, lastTest}] */
    trend: null,       /* {dir, from, failedReversals, deepest} */
    lastRegime: null,
    brokeThisBar: null,
    frozen: null,
    claims: {}       /* what each watching engine has been reporting */
  };

  function near(a,b,tol){ return Math.abs(a-b)<=tol; }

  /* ── A LEVEL EARNS ITS PLACE BY BEING TESTED, NOT BY EXISTING ──
     Any pivot is a price. A DECISIVE level is one price has come back to
     and been turned away from — and the count of those is the thing the
     governor has never had. */
  function trackLevel(price, kind, cd, tol){
    let lv = S.levels.find(x => x.kind===kind && near(x.price, price, tol));
    if(!lv){
      lv = {price, kind, born:S.bars, tests:0, holds:0, breaks:0, lastTest:null};
      S.levels.push(lv);
      if(S.levels.length>MAX_LEVELS) S.levels.shift();
    } else {
      /* drift the level toward where it is actually being defended */
      lv.price = (lv.price*lv.tests + price)/(lv.tests+1) || price;
    }
    return lv;
  }

  function testLevels(cd, tol){
    const n=cd.length; if(n<HOLD_BARS+2) return;
    const i=n-1-HOLD_BARS;                 /* the bar we can now judge */
    if(i<1) return;
    const bar=cd[i], after=C(cd[n-1]);
    S.levels.forEach(function(lv){
      const touched = (H(bar)>=lv.price-tol && L(bar)<=lv.price+tol);
      if(!touched) return;
      if(lv.lastTest!=null && S.bars-lv.lastTest < HOLD_BARS) return;  /* one test per episode */
      lv.tests++; lv.lastTest=S.bars;
      const approachedFromAbove = C(cd[i-1]) > lv.price;
      const heldIt = approachedFromAbove ? after > lv.price : after < lv.price;
      if(heldIt){ lv.holds++; }
      else { lv.breaks++; S.brokeThisBar = lv; }
    });
  }

  /* ── observe(): once per CLOSED bar ───────────────────────────── */
  function observe(cd, read){
    if(!cd||!cd.length||!read||!read.ok) return context();
    S.bars++;
    S.brokeThisBar = null;      /* an event, cleared every bar */
    const atr = (function(){ let s=0,k=0;
      for(let i=Math.max(1,cd.length-14);i<cd.length;i++){ s+=H(cd[i])-L(cd[i]); k++; }
      return k?s/k:0; })();
    const tol = Math.max(atr*0.45, pip*8);

    /* 1. the regime sequence */
    if(read.regime !== S.lastRegime){
      if(S.eras.length) S.eras[S.eras.length-1].to = S.bars-1;
      S.eras.push({regime:read.regime, from:S.bars, to:S.bars});
      if(S.eras.length>MAX_ERAS) S.eras.shift();
      S.lastRegime = read.regime;
    } else if(S.eras.length){
      S.eras[S.eras.length-1].to = S.bars;
    }

    /* 2. the trend spell, and failed reversals inside it */
    /* A TREND SPELL MUST BE CLOSED WHEN THE TREND ENDS.
       My first version only OPENED a spell and never ended one, so
       `barsRunning` kept counting through every transition and range in
       between — it reported a 246-bar downtrend when the eras showed
       spells of 5 and 10 bars. A spell that never closes is not history,
       it is a counter.
       A trend survives a transition (that is what a pullback looks like),
       but it does NOT survive the opposite trend or a confirmed range.
       So: same direction continues it, a gap is tolerated, and anything
       structurally contradictory ends it. */
    const dir = read.regime==='uptrend'?1 : read.regime==='downtrend'?-1 : 0;
    /* HIS CALL: a trend spell SURVIVES a range. His scenario was a
       downtrend that went through a range and then resumed — and if the
       range ended the spell, the resumption would start fresh and lose
       the memory that it is the same trend, which is precisely the
       context the historian exists to keep. Only the OPPOSITE trend
       genuinely contradicts it. A range is an interruption, not an end. */
    const contradicts = (S.trend && dir!==0 && dir!==S.trend.dir);
    if(contradicts) S.trend=null;
    /* Count the range as ONE interruption when it BEGINS, not every bar.
       My first version tested `S.lastRegime==='range'` — but the era
       block above has already advanced lastRegime by this point, so the
       test was always true and the counter never moved. `startedRange`
       is computed from the era list, which is the thing that actually
       knows a new spell just began. */
    const lastEra = S.eras[S.eras.length-1];
    const startedRange = !!(lastEra && lastEra.regime==='range' && lastEra.from===S.bars);
    if(S.trend && startedRange) S.trend.interruptions = (S.trend.interruptions||0)+1;
    if(dir!==0){
      if(!S.trend || S.trend.dir!==dir){
        S.trend={dir, from:S.bars, lastSeen:S.bars, failedReversals:0, deepest:0};
      } else {
        /* the trend is showing itself again — keep the spell alive */
        S.trend.lastSeen=S.bars;
      }
    } else if(S.trend && (S.bars-S.trend.lastSeen) > 60){
      /* gone quiet for too long to still call it the same spell */
      S.trend=null;
    }

    /* 3. THE DECISIVE LEVEL — the one that must break for a reversal.
       In a downtrend that is the last lower high; in an uptrend the last
       higher low. This is the level he asked to be drawn and counted. */
    const marked = read.marked||[];
    let decisive=null;
    if(dir<0){ const lh=marked.filter(q=>q.label==='LH').slice(-1)[0]; if(lh) decisive={price:lh.p, kind:'lower-high'}; }
    if(dir>0){ const hl=marked.filter(q=>q.label==='HL').slice(-1)[0]; if(hl) decisive={price:hl.p, kind:'higher-low'}; }
    /* ── MARK EVERY LEVEL THE STRUCTURE ENGINE MARKS ────────────────
       His instruction: the historian looks at every level structure has
       labelled, puts a line on it, and keeps that register for the
       governor. Marking only the decisive one was too narrow — the
       governor needs the whole map to know what a break would mean.
       Each label becomes a tracked line with its own test/hold/break
       count, and `decisive` simply points at the one that would end the
       current trend. */
    const KIND={HH:'higher-high',HL:'higher-low',LH:'lower-high',LL:'lower-low',
                'EQ-H':'equal-high','EQ-L':'equal-low'};
    marked.slice(-12).forEach(function(q){
      const k=KIND[q.label]; if(!k) return;
      const lv=trackLevel(q.p, k, cd, tol);
      lv.label=q.label; lv.barIndex=q.i;
    });
    if(decisive) trackLevel(decisive.price, decisive.kind, cd, tol);

    /* `dec` must exist BEFORE the frozen block reads it. My first pass
       declared it after, so `var` hoisting left it undefined and the
       break step could never fire — zero prompts across 2,400 bars. */
    const dec = decisive ? {priceRaw:decisive.price, kind:decisive.kind} : null;

    /* ── THE FROZEN EXTREME ──────────────────────────────────────────
       His mechanism, and it is the sound one. In a downtrend the LL is
       where the move ran out; in an uptrend the HH is. That price gets
       FROZEN — it does not drift with later pivots — because the whole
       question is whether the retracement that began there goes far
       enough to break the other side.
       Two events, in order, and the order is what makes it a reversal
       rather than a bounce:
         1. price turns away from the frozen extreme  -> retracing FROM it
         2. price then closes beyond the LH (down) or HL (up) -> reversed
       Neither alone is enough. A break with no retracement from the
       extreme is a continuation that overshot; a retracement that never
       breaks is a pullback. */
    if(S.trend){
      const want = S.trend.dir<0 ? 'LL' : 'HH';
      const ext = marked.filter(q=>q.label===want).slice(-1)[0];
      if(ext && (!S.frozen || S.frozen.dir!==S.trend.dir ||
                 (S.trend.dir<0 ? ext.p < S.frozen.price - tol*0.2
                                : ext.p > S.frozen.price + tol*0.2))){
        /* a NEW extreme replaces the frozen one and resets the sequence —
           the trend went further, so the old question is void */
        S.frozen = {price:ext.p, label:want, dir:S.trend.dir, at:S.bars,
                    retraced:false, retracedAt:null, broke:false};
      }
      if(S.frozen){
        const px = C(cd[cd.length-1]);
        /* 1. has price turned away from the frozen extreme? */
        if(!S.frozen.retraced){
          const away = S.frozen.dir<0 ? (px - S.frozen.price) : (S.frozen.price - px);
          if(away > tol*1.2){ S.frozen.retraced=true; S.frozen.retracedAt=S.bars; }
        }
        /* 2. and has it then broken the other side? */
        if(S.frozen.retraced && !S.frozen.broke && dec){
          const brokeIt = S.frozen.dir<0 ? px > dec.priceRaw : px < dec.priceRaw;
          if(brokeIt){ S.frozen.broke=true; S.frozen.brokeAt=S.bars; }
        }
      }
    }

    testLevels(cd, tol);

    /* 4. a failed reversal: the decisive level was tested and HELD while
       a trend was running. That is the trend surviving an attempt on it. */
    if(S.trend && decisive){
      const lv=S.levels.find(x=>near(x.price,decisive.price,tol));
      if(lv && lv.lastTest===S.bars && lv.holds>0){
        S.trend.failedReversals = S.levels
          .filter(x=>x.kind===decisive.kind && x.born>=S.trend.from)
          .reduce((s,x)=>s+x.holds,0);
      }
    }

    return context(decisive, tol);
  }

  /* ── WATCHERS REPORT HERE ─────────────────────────────────────────
     Every engine runs every bar, including the ones not driving. What
     they see is context the governor should have — but a watcher must
     never be able to hand itself the market, so it reports HERE rather
     than to the governor directly. The historian records what each one
     claimed and how long it has been claiming it; the governor reads
     that as evidence, and still decides alone.
     `claim` is what the engine believes it could own, with a confidence.
     Nothing in this function can change who holds the market. */
  function report(name, claim){
    if(!name) return;
    S.claims[name] = S.claims[name] || {name, since:S.bars, bars:0, last:null};
    const c=S.claims[name];
    const claiming = !!(claim && claim.claims);
    if(claiming){
      if(c.last===null || !c.lastClaiming) c.since=S.bars;
      c.bars = S.bars - c.since + 1;
      c.lastClaiming = true;
    } else { c.bars = 0; c.lastClaiming = false; }
    c.last = claim ? {claims:claiming, confidence:claim.confidence||0, why:claim.why||''} : null;
  }

  /* ── peek(): safe to call any time, for the forming bar ────────── */
  function peek(){ return context(); }

  function context(decisive, tol){
    const eras=S.eras.slice(-8).map(e=>({regime:e.regime, bars:(e.to-e.from+1), from:e.from, to:e.to}));
    const path=eras.map(e=>e.regime).join(' → ');
    const tracked=S.levels
      .filter(l=>l.tests>0)
      .sort((a,b)=>(b.holds-a.holds)||(b.tests-a.tests))
      .slice(0,4)
      .map(l=>({price:l.price, kind:l.kind, tests:l.tests, holds:l.holds, breaks:l.breaks,
                barsKnown:S.bars-l.born}));
    let dec=null;
    if(decisive){
      const lv=S.levels.find(x=>Math.abs(x.price-decisive.price)<=(tol||pip*8));
      dec={price:decisive.price, kind:decisive.kind,
           tests: lv?lv.tests:0, holds: lv?lv.holds:0, breaks: lv?lv.breaks:0};
    }
    return {
      ok:true, bars:S.bars,
      path, eras,
      trend: S.trend ? {dir:S.trend.dir,
                        interruptions:S.trend.interruptions||0,
                        barsRunning:S.bars-S.trend.from,
                        barsSinceSeen:S.bars-S.trend.lastSeen,
                        failedReversals:S.trend.failedReversals} : null,
      decisive: dec,
      levels: tracked,
      /* THE MAP. Every level structure has marked, with its line and its
         record. The governor reads this to know what a break would mean
         before it happens. */
      lines: S.levels.filter(l=>l.label).slice(-12).map(function(l){
        return {price:l.price, label:l.label, kind:l.kind, bar:l.barIndex,
                tests:l.tests, holds:l.holds, breaks:l.breaks}; }),
      /* what the watchers have been reporting, and for how long — the
         governor reads this as evidence. It is never permission. */
      watchers: Object.keys(S.claims).map(function(k){
        const c=S.claims[k];
        return {engine:k, claiming:!!c.lastClaiming, barsClaiming:c.bars,
                confidence:(c.last&&c.last.confidence)||0, why:(c.last&&c.last.why)||''};
      }).sort(function(a,b){ return b.barsClaiming-a.barsClaiming; }),
      /* ── THE REVERSAL PROMPT ──────────────────────────────────────
         His instruction: if price breaks the decisive level, the governor
         should tell the pullback engine "this is a reversal, show it to
         the trader" — even if the pullback engine has not called it.
         The historian raises the flag because it is the only thing that
         knows the level was marked, how many times it held, and that it
         has now gone. */
      /* The frozen extreme and where the sequence has got to. */
      frozen: S.frozen ? {price:S.frozen.price, label:S.frozen.label,
                          dir:S.frozen.dir, at:S.frozen.at,
                          retraced:S.frozen.retraced, retracedAt:S.frozen.retracedAt,
                          broke:S.frozen.broke, brokeAt:S.frozen.brokeAt||null,
                          stage: S.frozen.broke ? 'reversed'
                               : S.frozen.retraced ? 'retracing from the extreme'
                               : 'extreme set, no retracement yet'} : null,
      reversalPrompt: (function(){
        /* FIRES ON A NEW BREAK, NOT ON A HISTORY OF ONE.
           My first version checked `breaks > 0`, which stays true forever
           once a level has ever been broken — it raised 322 prompts in
           2,400 bars, about one bar in eight. A prompt that fires all the
           time is noise, and the trader stops reading it.
           `brokeThisBar` is set only when a test resolved as a break on
           this bar, so the prompt is an EVENT. */
        /* THE SEQUENCE, NOT JUST THE BREAK.
           A break on its own can be a continuation overshooting. What
           makes it a reversal is that price first retraced FROM the
           frozen extreme and THEN broke the other side. Requiring both,
           in that order, is what separates the two. */
        if(!dec || !S.trend) return null;
        if(!S.frozen || !S.frozen.retraced || !S.frozen.broke) return null;
        if(S.frozen.brokeAt !== S.bars) return null;   /* fire once, on the bar it happens */
        return {
          fire:true, level:dec.price, kind:dec.kind,
          heldBefore:dec.holds, brokeNow:dec.breaks,
          from:S.frozen.price, retracedAt:S.frozen.retracedAt,
          say:'Price retraced from the '+S.frozen.label+' at '+S.frozen.price.toFixed(5)+
              ', then broke the '+dec.kind+' at '+dec.price.toFixed(5)+
              ' that defined this '+(S.trend.dir>0?'uptrend':'downtrend')+
              '. That level held '+dec.holds+' time'+(dec.holds===1?'':'s')+' before this. '+
              'The sequence is complete — treat this as a '+(S.frozen.dir<0?'bullish':'bearish')+
              ' reversal until it is reclaimed.'
        };
      })(),
      /* the sentence the governor could not previously say */
      says: (function(){
        if(!S.trend) return 'No trend spell recorded yet.';
        const d=S.trend.dir>0?'uptrend':'downtrend';
        let s='This '+d+' has been in play '+(S.bars-S.trend.from)+' bars';
        if(S.trend.interruptions) s+=', interrupted '+S.trend.interruptions+' time'+
          (S.trend.interruptions===1?'':'s')+' by a range and resumed';
        if(S.bars-S.trend.lastSeen>3) s+=' (last read as a trend '+(S.bars-S.trend.lastSeen)+' bars ago)';
        if(S.trend.failedReversals>0)
          s+=' and has survived '+S.trend.failedReversals+' attempt'+
             (S.trend.failedReversals===1?'':'s')+' on its decisive level';
        if(dec) s+='. The level that would end it is '+dec.price.toFixed(5)+
          ' — tested '+dec.tests+' time'+(dec.tests===1?'':'s')+', held '+dec.holds+
          ', broken '+dec.breaks;
        return s+'.';
      })()
    };
  }

  function reset(){ S.bars=0; S.eras=[]; S.levels=[]; S.trend=null; S.lastRegime=null; S.claims={}; S.frozen=null; }
  return {observe, report, peek, reset, state:S};
}

root.BWHistorian={create, HOLD_BARS};
})(typeof window!=='undefined'?window:globalThis);
