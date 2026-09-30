/* chart-patterns.js — EXTRACTED EXACTLY from patterns.html, the copy that actually runs.
   Needed by the retracement engine: a failed or confirmed chart pattern moves its score.
   Do not edit here alone: test-engines.js fails if this and patterns.html drift. */
(function(root){
'use strict';

const H=c=>+(c.h!==undefined?c.h:c.high);
const L=c=>+(c.l!==undefined?c.l:c.low);
const C=c=>+(c.c!==undefined?c.c:c.close);
const O=c=>+(c.o!==undefined?c.o:c.open);
const T=c=>+(c.t!==undefined?c.t:c.time);

/* ── SWINGS ───────────────────────────────────────────────────────
   Fractal pivots: a high with `k` lower highs each side. k scales the
   sensitivity — too small and every wiggle is a swing, too large and a
   real head & shoulders is invisible. 3 suits H1/H4. */
function swings(cd,k){
  k=k||3;
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
  /* Collapse consecutive same-type pivots, keeping the extreme one —
     otherwise a stair-step leaves three "highs" in a row and every
     shape matcher below has to special-case it. */
  const z=[];
  out.forEach(s=>{
    const last=z[z.length-1];
    if(last&&last.type===s.type){
      if((s.type==='H'&&s.p>last.p)||(s.type==='L'&&s.p<last.p)) z[z.length-1]=s;
    } else z.push(s);
  });
  return z;
}

const near=(a,b,tol)=>Math.abs(a-b)<=tol;
const avgRange=cd=>{
  if(!cd.length) return 0;
  const n=Math.min(cd.length,50);
  let s=0; for(let i=cd.length-n;i<cd.length;i++) s+=H(cd[i])-L(cd[i]);
  return s/n;
};

/* ── LIFECYCLE ────────────────────────────────────────────────────
   Given a trigger level and the direction a confirmed break should
   take, walk the bars AFTER the pattern completed and decide which of
   the four states applies.

   GRACE: a break needs to survive this many bars to count as
   confirmed. Without it, one spike through the neckline reads as a
   confirmation and then unwinds — which is the exact trap.
   A break that closes back inside within the grace window is a FAILED
   break, and failed breaks tend to run the other way, so we say so. */
function lifecycle(cd,fromIdx,trigger,dir,grace){
  grace=grace||3;
  const bars=cd.slice(fromIdx+1);
  if(!bars.length) return {state:'complete',barsSince:0,broke:false};
  let breakIdx=-1;
  for(let i=0;i<bars.length;i++){
    const c=C(bars[i]);
    if(dir>0 ? c>trigger : c<trigger){ breakIdx=i; break; }
  }
  if(breakIdx<0) return {state:'complete',barsSince:bars.length,broke:false};

  const after=bars.slice(breakIdx+1);
  const held=after.slice(0,grace);
  const backInside=held.some(c=>dir>0 ? C(c)<trigger : C(c)>trigger);
  if(backInside){
    return {state:'failed',barsSince:bars.length-breakIdx,broke:true,
      failedAt:breakIdx, note:'broke the level then closed back inside within '+grace+' bars'};
  }
  if(after.length<grace){
    return {state:'breaking',barsSince:bars.length-breakIdx,broke:true,
      note:'broken '+(bars.length-breakIdx)+' of '+grace+' bars ago — not yet confirmed'};
  }
  return {state:'confirmed',barsSince:bars.length-breakIdx,broke:true};
}

/* ── SHAPE MATCHERS ───────────────────────────────────────────────
   Each returns a pattern object or null. They read the LAST few
   pivots, because an older shape has already resolved and is history.
   Every matcher states its own trigger (the level that decides it),
   its target (the measured move) and its invalidation. */

function headShoulders(cd,sw,tol){
  // need L S L H L S (…or the inverse) — five pivots plus a shoulder low
  if(sw.length<5) return null;
  const p=sw.slice(-5);
  const [a,b,c,d,e]=p;
  // TOP: H L H L H with the middle high the tallest and shoulders similar
  if(a.type==='H'&&b.type==='L'&&c.type==='H'&&d.type==='L'&&e.type==='H'){
    if(c.p>a.p&&c.p>e.p&&near(a.p,e.p,tol*1.6)){
      const neck=(b.p+d.p)/2;
      const lc=lifecycle(cd,e.i,neck,-1);
      return{key:'hs',name:'Head & Shoulders',kind:'reversal',dir:-1,
        trigger:neck,target:neck-(c.p-neck),invalid:c.p,
        pivots:p,startI:a.i,endI:e.i,life:lc,
        why:'Left shoulder '+a.p.toFixed(5)+', head '+c.p.toFixed(5)+', right shoulder '+e.p.toFixed(5)+
            ' with a neckline at '+neck.toFixed(5)+'.'};
    }
  }
  // BOTTOM (inverse)
  if(a.type==='L'&&b.type==='H'&&c.type==='L'&&d.type==='H'&&e.type==='L'){
    if(c.p<a.p&&c.p<e.p&&near(a.p,e.p,tol*1.6)){
      const neck=(b.p+d.p)/2;
      const lc=lifecycle(cd,e.i,neck,1);
      return{key:'ihs',name:'Inverse Head & Shoulders',kind:'reversal',dir:1,
        trigger:neck,target:neck+(neck-c.p),invalid:c.p,
        pivots:p,startI:a.i,endI:e.i,life:lc,
        why:'Left shoulder '+a.p.toFixed(5)+', head '+c.p.toFixed(5)+', right shoulder '+e.p.toFixed(5)+
            ' with a neckline at '+neck.toFixed(5)+'.'};
    }
  }
  return null;
}

function doubleTriple(cd,sw,tol){
  if(sw.length<3) return null;
  const p=sw.slice(-5);
  const highs=p.filter(x=>x.type==='H'), lows=p.filter(x=>x.type==='L');
  // TRIPLE first — it is a double that kept going, so test the stronger claim first
  if(highs.length>=3){
    const h=highs.slice(-3);
    if(near(h[0].p,h[1].p,tol)&&near(h[1].p,h[2].p,tol)){
      const between=lows.filter(x=>x.i>h[0].i&&x.i<h[2].i);
      if(between.length){
        const neck=Math.min.apply(null,between.map(x=>x.p));
        const lc=lifecycle(cd,h[2].i,neck,-1);
        return{key:'ttop',name:'Triple Top',kind:'reversal',dir:-1,trigger:neck,
          target:neck-(h[1].p-neck),invalid:Math.max(h[0].p,h[1].p,h[2].p),
          pivots:h,startI:h[0].i,endI:h[2].i,life:lc,
          why:'Three highs within '+tol.toFixed(5)+' of each other, support at '+neck.toFixed(5)+'.'};
      }
    }
  }
  if(lows.length>=3){
    const l=lows.slice(-3);
    if(near(l[0].p,l[1].p,tol)&&near(l[1].p,l[2].p,tol)){
      const between=highs.filter(x=>x.i>l[0].i&&x.i<l[2].i);
      if(between.length){
        const neck=Math.max.apply(null,between.map(x=>x.p));
        const lc=lifecycle(cd,l[2].i,neck,1);
        return{key:'tbot',name:'Triple Bottom',kind:'reversal',dir:1,trigger:neck,
          target:neck+(neck-l[1].p),invalid:Math.min(l[0].p,l[1].p,l[2].p),
          pivots:l,startI:l[0].i,endI:l[2].i,life:lc,
          why:'Three lows within '+tol.toFixed(5)+' of each other, resistance at '+neck.toFixed(5)+'.'};
      }
    }
  }
  if(highs.length>=2){
    const h=highs.slice(-2);
    if(near(h[0].p,h[1].p,tol)){
      const between=lows.filter(x=>x.i>h[0].i&&x.i<h[1].i);
      if(between.length){
        const neck=Math.min.apply(null,between.map(x=>x.p));
        const lc=lifecycle(cd,h[1].i,neck,-1);
        return{key:'dtop',name:'Double Top',kind:'reversal',dir:-1,trigger:neck,
          target:neck-(h[1].p-neck),invalid:Math.max(h[0].p,h[1].p),
          pivots:h,startI:h[0].i,endI:h[1].i,life:lc,
          why:'Two highs at '+h[0].p.toFixed(5)+' and '+h[1].p.toFixed(5)+
              ' rejected the same area; the low between them sits at '+neck.toFixed(5)+'.'};
      }
    }
  }
  if(lows.length>=2){
    const l=lows.slice(-2);
    if(near(l[0].p,l[1].p,tol)){
      const between=highs.filter(x=>x.i>l[0].i&&x.i<l[1].i);
      if(between.length){
        const neck=Math.max.apply(null,between.map(x=>x.p));
        const lc=lifecycle(cd,l[1].i,neck,1);
        return{key:'dbot',name:'Double Bottom',kind:'reversal',dir:1,trigger:neck,
          target:neck+(neck-l[1].p),invalid:Math.min(l[0].p,l[1].p),
          pivots:l,startI:l[0].i,endI:l[1].i,life:lc,
          why:'Two lows at '+l[0].p.toFixed(5)+' and '+l[1].p.toFixed(5)+
              ' held the same area; the high between them sits at '+neck.toFixed(5)+'.'};
      }
    }
  }
  return null;
}

/* Triangles and wedges are both "converging trendlines"; what separates
   them is the SLOPE of each side, so one matcher handles all of them and
   names the result from the slopes. */
function converging(cd,sw,tol){
  if(sw.length<4) return null;
  const p=sw.slice(-5);
  const hs=p.filter(x=>x.type==='H').slice(-2);
  const ls=p.filter(x=>x.type==='L').slice(-2);
  if(hs.length<2||ls.length<2) return null;
  const hSlope=(hs[1].p-hs[0].p)/Math.max(1,hs[1].i-hs[0].i);
  const lSlope=(ls[1].p-ls[0].p)/Math.max(1,ls[1].i-ls[0].i);
  const flat=tol/25;                        // slope small enough to call level
  const endI=Math.max(hs[1].i,ls[1].i);
  const hFlat=Math.abs(hSlope)<flat, lFlat=Math.abs(lSlope)<flat;
  let name=null,dir=0,kind='continuation',trigger=null,why='';

  if(hFlat&&lSlope>flat){
    name='Ascending Triangle'; dir=1; trigger=hs[1].p;
    why='Flat resistance near '+hs[1].p.toFixed(5)+' with higher lows pressing into it.';
  } else if(lFlat&&hSlope<-flat){
    name='Descending Triangle'; dir=-1; trigger=ls[1].p;
    why='Flat support near '+ls[1].p.toFixed(5)+' with lower highs pressing into it.';
  } else if(hSlope<-flat&&lSlope>flat){
    name='Symmetrical Triangle'; dir=0; trigger=hs[1].p;
    why='Lower highs and higher lows converging — direction undecided until one side breaks.';
  } else if(hSlope>flat&&lSlope>flat&&hSlope<lSlope){
    name='Rising Wedge'; dir=-1; kind='reversal'; trigger=ls[1].p;
    why='Both sides rising but the lows rising faster — momentum compressing against the highs.';
  } else if(hSlope<-flat&&lSlope<-flat&&lSlope<hSlope){
    name='Falling Wedge'; dir=1; kind='reversal'; trigger=hs[1].p;
    why='Both sides falling but the highs falling faster — selling losing room.';
  } else if(hFlat&&lFlat){
    name='Rectangle / Range'; dir=0; trigger=hs[1].p;
    why='Both sides flat — a range between '+ls[1].p.toFixed(5)+' and '+hs[1].p.toFixed(5)+'.';
  }
  if(!name) return null;

  const lc = dir===0
    ? {state:'complete',barsSince:cd.length-1-endI,broke:false,
       note:'a symmetrical shape has no built-in direction — wait for the break'}
    : lifecycle(cd,endI,trigger,dir);
  const height=Math.abs(hs[0].p-ls[0].p);
  return{key:name.toLowerCase().replace(/[^a-z]+/g,'-'),name,kind,dir,
    trigger,target:dir?(dir>0?trigger+height:trigger-height):null,
    invalid:dir>0?ls[1].p:hs[1].p,
    pivots:[hs[0],ls[0],hs[1],ls[1]].sort((a,b)=>a.i-b.i),
    startI:Math.min(hs[0].i,ls[0].i),endI,life:lc,why};
}

/* Flags: a strong impulse (the pole) followed by a shallow drift the
   other way. Continuation, and the one most often mistaken for a
   reversal — which is the user's point exactly. */
function flag(cd,sw,tol){
  if(cd.length<25) return null;
  const look=Math.min(60,cd.length-1);
  const seg=cd.slice(cd.length-look);
  let poleEnd=-1,poleDir=0,poleSize=0;
  for(let i=6;i<seg.length-5;i++){
    const move=C(seg[i])-C(seg[i-6]);
    if(Math.abs(move)>tol*4&&Math.abs(move)>poleSize){
      poleSize=Math.abs(move); poleEnd=i; poleDir=move>0?1:-1;
    }
  }
  if(poleEnd<0) return null;
  const after=seg.slice(poleEnd);
  if(after.length<4) return null;
  const hi=Math.max.apply(null,after.map(H)), lo=Math.min.apply(null,after.map(L));
  if((hi-lo)>poleSize*0.62) return null;            // drift too deep to be a flag
  const drift=C(after[after.length-1])-C(after[0]);
  if(poleDir>0&&drift>0) return null;               // must lean against the pole
  if(poleDir<0&&drift<0) return null;
  const trigger=poleDir>0?hi:lo;
  const baseI=cd.length-look+poleEnd;
  const lc=lifecycle(cd,cd.length-2,trigger,poleDir);
  return{key:poleDir>0?'bullflag':'bearflag',
    name:poleDir>0?'Bull Flag':'Bear Flag',kind:'continuation',dir:poleDir,
    trigger,target:poleDir>0?trigger+poleSize:trigger-poleSize,
    invalid:poleDir>0?lo:hi,
    pivots:[],startI:baseI,endI:cd.length-1,life:lc,
    why:'A '+(poleDir>0?'rally':'sell-off')+' of '+poleSize.toFixed(5)+
        ' then a shallow drift the other way — this shape looks like a reversal but usually continues.'};
}

/* ── PUBLIC ───────────────────────────────────────────────────────── */
function detect(candles,opts){
  opts=opts||{};
  const cd=(candles||[]).filter(c=>isFinite(H(c))&&isFinite(L(c))&&isFinite(C(c)));
  if(cd.length<30) return {patterns:[],swings:[],reason:'need at least 30 bars'};
  const tol=(opts.tol||avgRange(cd)*0.85);
  const sw=swings(cd,opts.k||3);

  /* SLIDING PIVOT WINDOW — this matters more than it looks.
     Each matcher reads the LAST few pivots. But the moment a pattern's
     break FAILS, price runs the other way and prints NEW pivots, which
     push the shape out of that window — so the exact case the user cares
     about (a reversal that got faked) became invisible the moment it
     happened. Retry each matcher with the window ending a few pivots
     back, so a shape stays visible while its aftermath plays out. */
  const found=[];
  const byKey={};
  for(let back=0;back<=4;back++){
    const win = back===0 ? sw : sw.slice(0, sw.length-back);
    if(win.length<3) break;
    [headShoulders,doubleTriple,converging,flag].forEach(fn=>{
      let r=null;
      try{ r=fn(cd,win,tol); }catch(e){ r=null; }
      if(!r) return;
      /* Keep the most INFORMATIVE version of each shape. A pattern seen
         from an older window has more aftermath to judge, so it can be
         'failed' or 'confirmed' where the newest window still says
         'complete'. Prefer whichever has actually resolved. */
      const rank={breaking:0,failed:1,confirmed:2,complete:3,forming:4};
      const prev=byKey[r.key];
      if(!prev||rank[r.life.state]<rank[prev.life.state]) byKey[r.key]=r;
    });
  }
  Object.keys(byKey).forEach(k=>found.push(byKey[k]));

  /* SIGNIFICANCE GATE — without this, noise names everything.
     A flat, directionless series produced six "patterns" because the
     matchers only check SHAPE, never SCALE: two highs three pips apart
     on a five-pip range technically satisfy a double top and mean
     nothing. Two requirements, both relative to the pair's own recent
     range so they work on gold and JPY as well as EURUSD:
       height — the distance from trigger to invalidation must be a real
                move, not a wiggle
       span   — the shape must take enough bars to represent actual
                accumulation rather than three adjacent candles */
  const bodyRange=avgRange(cd);
  const MIN_HEIGHT=bodyRange*2.2;
  const MIN_SPAN=12;
  const sized=found.filter(p=>{
    /* Height = the pattern's FULL price span, not trigger-to-invalidation.
       For a triangle the invalidation is the most recent opposite pivot,
       which sits close to the trigger by construction, so the narrower
       measure filtered out perfectly good triangles. The span across all
       of a shape's pivots is the honest size of the structure. */
    const ps=(p.pivots||[]).map(x=>x.p).filter(isFinite);
    const span = ps.length>=2 ? Math.max.apply(null,ps)-Math.min.apply(null,ps) : 0;
    /* Take the LARGER of the two measures. A double bottom's pivots are
       equal by definition, so its pivot span is ~0 and only the
       trigger-to-invalidation distance describes it; a triangle is the
       opposite. Neither measure alone covers both shapes. */
    const h = Math.max(span, Math.abs((p.invalid==null?p.trigger:p.invalid)-p.trigger));
    p.height=h;
    p.span=(p.endI-p.startI);
    return h>=MIN_HEIGHT && p.span>=MIN_SPAN;
  });
  const keep = sized.length ? sized : [];

  /* A failed break flips the expected direction. This is the single most
     useful thing here: the shape said one way, the market rejected it,
     and the rejection is itself the signal. */
  /* INVALIDATION BEATS COMPLETION.
     lifecycle() only ever watched the TRIGGER, so a shape whose
     invalidation had already been closed through went on sitting in the
     list at "complete, 70%" waiting for a break that should never have
     counted. Price had answered the question and the scan was still
     asking it.

     The pattern object carries its own invalidation, so the check is
     done once here rather than at eight matcher call sites. Whichever
     level price reached FIRST decides: if the invalidation was closed
     through before the trigger, the shape is dead. */
  keep.forEach(p=>{
    if(p.life && isFinite(+p.invalid) && p.endI!=null){
      const bars=cd.slice(p.endI+1);
      let invIdx=-1;
      for(let i=0;i<bars.length;i++){
        const c=C(bars[i]);
        if(p.dir>0 ? c<p.invalid : c>p.invalid){ invIdx=i; break; }
      }
      /* lifecycle reports barsSince from the end, so the bar the trigger
         broke on is bars.length - barsSince. */
      const brkIdx = p.life.broke ? (bars.length-(p.life.barsSince||0)) : Infinity;
      if(invIdx>=0 && invIdx < brkIdx){
        p.life={state:'invalidated', barsSince:bars.length-invIdx, broke:false,
          invalidatedAt:invIdx,
          note:'price closed beyond the invalidation at '+(+p.invalid).toFixed(5)+
               ' before the level was ever broken \u2014 the shape is dead'};
        p.invalidated=true;
      }
    }
    p.effectiveDir = (p.life.state==='failed') ? -p.dir : p.dir;
    p.faked = p.life.state==='failed';
    /* Stamp it from the BAR it happened on, not from Date.now(). A wall
       clock reads "just now" for a shape that completed hours ago the
       first time the tab is opened. */
    const bar = cd[Math.max(0, cd.length-1-(p.life.barsSince||0))];
    /* MT5 sends bar times in SECONDS. Reading them as milliseconds put
       every pattern in 1970, which is where "20605 days ago" came from.
       Anything below 1e12 is seconds and needs scaling. */
    p.atMs = bar ? (function(){
      var raw = bar.t || bar.time || 0;
      var n = (raw instanceof Date) ? +raw : (typeof raw==='number' ? raw : +new Date(raw));
      if(!isFinite(n) || !n) return null;
      return n < 1e12 ? n*1000 : n;
    })() : null;
    p.completion = p.life.state==='invalidated'?0
                 : p.life.state==='confirmed'?100
                 : p.life.state==='breaking'?85
                 : p.life.state==='failed'?100
                 : p.life.state==='complete'?70:40;
  });
  /* Rank: something breaking right now matters more than an old shape. */
  /* NEWEST FIRST. This used to sort by lifecycle state, so a shape that
     broke twenty bars ago outranked one completing on the current bar
     purely because 'breaking' sorts before 'forming'. What a trader
     needs at the top is what is happening NOW; state is the tiebreak,
     not the primary key. */
  const order={breaking:0,failed:1,confirmed:2,complete:3,forming:4};
  /* URGENCY, NOT JUST RECENCY.
     Sorting on barsSince alone buried a shape still FORMING at the right
     edge underneath one that merely completed a bar earlier — but a
     forming pattern at the live edge is the one a trader can still act
     on, and it is the one that needs their attention now.
     So: anything touching the last few bars is "live" and sorts to the
     top as a group, ordered by how close to the current bar it reaches.
     Everything older falls below, newest first, exactly as before. */
  /* Dead shapes leave the list entirely. Keeping them would be the same
     mistake in a quieter form: a row on screen implies a reading worth
     having, and an invalidated pattern has none. Dropping them also
     frees the four-row cap for shapes that are still genuine. */
  const dead = keep.filter(p=>p.life.state==='invalidated').length;
  const alive = keep.filter(p=>p.life.state!=='invalidated');

  const LIVE_BARS=3;
  const liveness=p=>{
    const reach = (p.life && p.life.barsSince!=null) ? p.life.barsSince : 99;
    const edge  = (p.endI!=null) ? (cd.length-1-p.endI) : reach;
    return Math.min(reach, edge);       // how close it gets to the live edge
  };
  alive.forEach(p=>{ p._live=liveness(p); p._isLive=p._live<=LIVE_BARS; });
  alive.sort((a,b)=>(b._isLive-a._isLive)          // live group first
                 ||(a._live-b._live)              // then nearest the current bar
                 ||(order[a.life.state]-order[b.life.state])
                 ||(b.height-a.height)||(b.endI-a.endI));
  /* Cap the list. Beyond about four, overlapping reads of the same
     structure stop informing and start competing. */
  return {patterns:alive.slice(0,4),swings:sw,tol,invalidated:dead,
          suppressed:Math.max(0,found.length-Math.min(alive.length,4))};
}

root.BWChartPatterns={detect,swings,lifecycle};
})(typeof window!=='undefined'?window:globalThis);
