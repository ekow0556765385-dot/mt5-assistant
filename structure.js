/* structure.js — EXTRACTED EXACTLY from patterns.html, the copy that actually runs.
   Do not edit here alone: test-engines.js fails if this and patterns.html drift. */
(function(root){
'use strict';
const H=c=>+(c.h!==undefined?c.h:c.high);
const L=c=>+(c.l!==undefined?c.l:c.low);
const C=c=>+(c.c!==undefined?c.c:c.close);
const T=c=>+(c.t!==undefined?c.t:c.time);

/* ── ADAPTIVE PIVOT WIDTH ─────────────────────────────────────────
   A fixed lookback is wrong at both ends: k=2 on a quiet pair prints a
   pivot on every wiggle, k=5 on a volatile one misses the turn that
   mattered. Scale it to how much history there is, and clamp it. */
function pivotK(n){
  if(n<60)  return 2;
  if(n<150) return 3;
  return 4;
}

function atr(cd,n){
  let s=0,k=0;
  for(let i=Math.max(1,cd.length-n);i<cd.length;i++){
    s+=Math.max(H(cd[i])-L(cd[i]),
        Math.abs(H(cd[i])-C(cd[i-1])),
        Math.abs(L(cd[i])-C(cd[i-1]))); k++;
  }
  return k?s/k:0;
}

/* ── PIVOTS ───────────────────────────────────────────────────────
   A high with k lower highs each side, and the mirror for lows.
   Consecutive same-type pivots collapse to the extreme one, so a
   stair-step does not leave three "highs" in a row. */
function pivots(cd,k){
  k=k||pivotK(cd.length);
  const out=[];
  for(let i=k;i<cd.length-k;i++){
    let hi=true,lo=true;
    for(let j=i-k;j<=i+k;j++){
      if(j===i) continue;
      if(H(cd[j])>=H(cd[i])) hi=false;
      if(L(cd[j])<=L(cd[i])) lo=false;
    }
    if(hi) out.push({i,type:'H',p:H(cd[i]),t:T(cd[i])});
    else if(lo) out.push({i,type:'L',p:L(cd[i]),t:T(cd[i])});
  }
  const z=[];
  out.forEach(s=>{
    const last=z[z.length-1];
    if(last&&last.type===s.type){
      if((s.type==='H'&&s.p>last.p)||(s.type==='L'&&s.p<last.p)) z[z.length-1]=s;
    } else z.push(s);
  });
  return z;
}

/* ── LABELS ───────────────────────────────────────────────────────
   Each pivot compared to the previous one of the SAME type. A high
   above the last high is a Higher High; below it, a Lower High.
   A NEUTRAL BAND matters here: two highs within a fraction of ATR are
   EQUAL, not "higher by a hair". Without it, noise at a double top
   reads as a continuing uptrend, which is exactly backwards. */
function label(cd,pv,tolAtr){
  const tol=atr(cd,14)*(tolAtr==null?0.25:tolAtr);
  let lastH=null,lastL=null;
  return pv.map(s=>{
    let lab=null,ref=null;
    if(s.type==='H'){
      if(lastH){ ref=lastH.p;
        lab = s.p>lastH.p+tol ? 'HH' : s.p<lastH.p-tol ? 'LH' : 'EQ-H'; }
      lastH=s;
    } else {
      if(lastL){ ref=lastL.p;
        lab = s.p>lastL.p+tol ? 'HL' : s.p<lastL.p-tol ? 'LL' : 'EQ-L'; }
      lastL=s;
    }
    return {...s, label:lab, ref};
  });
}

/* ── EFFICIENCY ───────────────────────────────────────────────────
   Net displacement over total path. A trend covers ground; chop gives
   back almost everything it does. Window is long enough that one turn
   cannot erase the trend that preceded it. */
function efficiency(cd,look){
  const n=Math.min(look||140,cd.length-1);
  if(n<10) return null;
  let path=0;
  for(let i=cd.length-n;i<cd.length;i++) path+=Math.abs(C(cd[i])-C(cd[i-1]));
  const net=Math.abs(C(cd[cd.length-1])-C(cd[cd.length-1-n]));
  return path>0?net/path:0;
}

/* ── READ ─────────────────────────────────────────────────────────
   Two independent witnesses — the label sequence and the efficiency
   ratio — and the confidence is how much they agree. One of them being
   wrong on its own should not produce a confident answer. */
function read(cd,opts){
  opts=opts||{};
  if(!cd || cd.length<30) return {ok:false,reason:'needs at least 30 bars'};
  const k=opts.k||pivotK(cd.length);
  const pv=label(cd,pivots(cd,k),opts.tolAtr);
  const marked=pv.filter(s=>s.label);
  /* TWO WINDOWS, NOT ONE.
     Over 140 bars a market that has just reversed nets to nearly zero,
     so the long window calls a clean reversal "rotation" — the trend
     that preceded it cancels the one replacing it. And a range that
     drifted slightly reads as trending on that same window.
     Long window = context. Short window = now. When they disagree, now
     wins, because the trader is trading now. */
  const eff  = efficiency(cd,opts.look);
  const effN = efficiency(cd,opts.lookNow||45);

  const recent=marked.slice(-4);
  const ups=recent.filter(s=>s.label==='HH'||s.label==='HL').length;
  const dns=recent.filter(s=>s.label==='LH'||s.label==='LL').length;
  const eqs=recent.filter(s=>s.label==='EQ-H'||s.label==='EQ-L').length;

  /* Unanimity: every one of the recent labels points the same way, and
     none of them is an equal level. */
  const unanimous = recent.length>=3 && (ups===recent.length || dns===recent.length);

  let structure='unclear', dir=0;
  if(recent.length>=3){
    if(ups>=3 && dns===0){ structure='uptrend';   dir=1; }
    else if(dns>=3 && ups===0){ structure='downtrend'; dir=-1; }
    /* A RANGE IS MADE OF EQUAL HIGHS AND EQUAL LOWS.
       `ups>=1 && dns>=1` accepted ANY mixed sequence as rotation, so
       LL HH HL LH HL — five directional labels, not one equal — was
       classified 'rotating' and then reported as "range, 90% confident".
       That directly contradicted the governor's own EVIDENCE law, which
       forbids the range engine without at least one EQ. Two definitions
       of "range" in one file, disagreeing: the badge said range while no
       range engine was allowed to run, which is exactly the contradiction
       he saw on screen.
       Mixed directional labels with NO equal levels are not a range. They
       are an unresolved structure — 'choppy' — which is an honest third
       answer rather than borrowing a name the evidence does not support. */
    else if(eqs>=1) structure='rotating';
    else if(ups>=1 && dns>=1) structure='choppy';
  }

  /* The two witnesses. */
  const rate=v=>v==null?'unknown':v>=0.34?'trending':v<0.18?'rotating':'mixed';
  const effLong=rate(eff), effNow=rate(effN);
  const effSays = (effNow!=='unknown'&&effNow!=='mixed') ? effNow
                : (effLong!=='unknown' ? effLong : 'unknown');
  /* 'choppy' is deliberately NOT 'rotating': it means the pivots have not
     resolved, which is a reason to keep structure in charge rather than
     to hand the market to the range engine. */
  const strSays = dir!==0?'trending':structure==='rotating'?'rotating':'unclear';

  let regime, confidence, why;
  if(strSays==='trending' && effSays==='trending'){
    regime = dir>0?'uptrend':'downtrend'; confidence=0.9;
    why='structure and ground-covered agree';
  } else if(strSays==='rotating' && effSays==='rotating'){
    regime='range'; confidence=0.9;
    why='structure is rotating and price is not covering ground';
  } else if(effSays==='rotating' && strSays==='trending'){
    /* A UNANIMOUS LABEL SEQUENCE OUTVOTES EFFICIENCY.
       A trend with deep pullbacks covers little net ground — a leg that
       runs and gives back half of itself repeatedly can read 0.12 — so
       efficiency called it rotation while the pivots said HH HL HH HL HH.
       But equal highs and equal lows are what a range is MADE of, and
       there were none: every pivot was directional and they all agreed.
       When the last four labels are unanimous and not one of them is an
       EQ, the shape is a trend that is simply retracing deeply, and the
       labels are the better witness. Confidence stays below the
       both-agree case, because one witness dissenting is a real reason
       to be less certain. */
    if(unanimous && eqs===0){
      regime = dir>0?'uptrend':'downtrend'; confidence=0.7;
      why='every recent pivot is directional and none are equal — a trend retracing deeply, '+
          'not rotation, even though it is covering little ground';
    } else {
      regime='range'; confidence=0.55;
      why='the pivots look directional but price is not covering ground right now — treat as rotation';
    }
  } else if(strSays==='rotating' && effSays==='trending'){
    regime = dir>0?'uptrend':dir<0?'downtrend':'transition'; confidence=0.5;
    why='price is covering ground but the pivots have not lined up yet';
  } else if(unanimous && eqs===0 && dir!==0){
    /* THE SAME RULE, IN THE MIDDLE CASE.
       Unanimity already outvoted efficiency when efficiency said
       "rotating". But when efficiency is merely AMBIGUOUS — which is
       exactly what a deep retracement inside a trend produces — this
       fell through to `transition`, and a downtrend that had started
       retracing ended up with NO engine assigned. That retracement is
       the pullback engine's whole reason for existing. Unanimous
       directional pivots with no equal levels are a trend, and the
       ambiguity belongs in the confidence, not in refusing to answer. */
    regime = dir>0?'uptrend':'downtrend'; confidence=0.6;
    why='every recent pivot is directional and none are equal — a trend, though price is '+
        'covering ground unevenly, so read it with less certainty';
  } else {
    regime='transition'; confidence=0.35;
    why='the two readings disagree — no confident call';
  }

  /* WHICH ENGINE SHOULD DRIVE. This is the whole point: one authority,
     so the two engines cannot both think they are in charge. */
  const driver = (regime==='uptrend'||regime==='downtrend') ? 'pullback'
               : regime==='range' ? 'range'
               : 'neither';

  return {ok:true, k, pivots:pv, marked, eff, effNow:effN, effLong, effNowLbl:effNow, structure, dir,
          regime, confidence, why, driver,
          lastLabels: marked.slice(-5).map(s=>s.label)};
}

root.BWStructure={read,pivots,label,efficiency,pivotK,atr};
})(typeof window!=='undefined'?window:globalThis);
