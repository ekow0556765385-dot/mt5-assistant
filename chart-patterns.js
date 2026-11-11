/* chart-patterns.js — GENERATED from patterns.html by build-host.js. Do not edit by hand:
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
function digitsOf(p){
  /* READ THE DECIMALS FROM THE PRICES THEMSELVES (Oct 2026). A name rule cannot know
     the broker: Exness quotes gold to 3 decimals, others to 2; indices, crypto and
     suffixed symbols fall outside any list. The most decimals seen across the pair's
     recent candles is what the broker quotes. The name rule is only the fallback. */
  try{
    const S=(typeof SERIES!=='undefined'&&SERIES[p])||null, cd=S&&(S[tf]||S.H1||S.H4);
    if(cd&&cd.length){
      let d=0; const n=Math.min(cd.length,60);
      for(let i=cd.length-n;i<cd.length;i++){ const b=cd[i];
        [b.o,b.h,b.l,b.c,b.open,b.high,b.low,b.close].forEach(v=>{ if(v==null||!isFinite(+v)) return;
          const t=(+v).toFixed(6).replace(/0+$/,''), k=t.indexOf('.'); if(k>=0) d=Math.max(d,t.length-k-1); }); }
      if(d>0) return Math.min(5,d);
    }
  }catch(e){}
  return /JPY/.test(p)?3:/^XAU|^XAG/.test(p)?2:5;
}
function bwDG(){ try{ return (typeof pair!=='undefined' && pair) ? digitsOf(pair) : 5; }catch(e){ return 5; } }
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
      /* Equal highs (or lows) used to disqualify BOTH bars, so a flat top
         printed no swing at all. The first bar of a flat pair is the pivot:
         strictly above the bars before it, not below the ones after. */
      if(j<i ? H(cd[j])>=H(cd[i]) : H(cd[j])>H(cd[i])) hi=false;
      if(j<i ? L(cd[j])<=L(cd[i]) : L(cd[j])<L(cd[i])) lo=false;
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
  /* `trigger` may be a FUNCTION of the bar index — a sloped trendline
     extended forward — so each bar is judged against the line where it
     actually is on that bar, not where the last pivot happened to sit. */
  const trigAt=i=>typeof trigger==='function' ? trigger(fromIdx+1+i) : trigger;
  let breakIdx=-1;
  for(let i=0;i<bars.length;i++){
    const c=C(bars[i]);
    if(dir>0 ? c>trigAt(i) : c<trigAt(i)){ breakIdx=i; break; }
  }
  if(breakIdx<0) return {state:'complete',barsSince:bars.length,broke:false};

  const after=bars.slice(breakIdx+1);
  const held=after.slice(0,grace);
  const backInside=held.some((c,j)=>{ const t=trigAt(breakIdx+1+j); return dir>0 ? C(c)<t : C(c)>t; });
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
        why:'Left shoulder '+a.p.toFixed(bwDG())+', head '+c.p.toFixed(bwDG())+', right shoulder '+e.p.toFixed(bwDG())+
            ' with a neckline at '+neck.toFixed(bwDG())+'.'};
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
        why:'Left shoulder '+a.p.toFixed(bwDG())+', head '+c.p.toFixed(bwDG())+', right shoulder '+e.p.toFixed(bwDG())+
            ' with a neckline at '+neck.toFixed(bwDG())+'.'};
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
          why:'Three highs within '+tol.toFixed(bwDG())+' of each other, support at '+neck.toFixed(bwDG())+'.'};
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
          why:'Three lows within '+tol.toFixed(bwDG())+' of each other, resistance at '+neck.toFixed(bwDG())+'.'};
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
          why:'Two highs at '+h[0].p.toFixed(bwDG())+' and '+h[1].p.toFixed(bwDG())+
              ' rejected the same area; the low between them sits at '+neck.toFixed(bwDG())+'.'};
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
          why:'Two lows at '+l[0].p.toFixed(bwDG())+' and '+l[1].p.toFixed(bwDG())+
              ' held the same area; the high between them sits at '+neck.toFixed(bwDG())+'.'};
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
  /* TIGHTENED (Oct 2026, his call, same as the new channels):
     · THREE TOUCHES on at least one side — the swing before the side's last two
       sits on that side's line (within half a tolerance);
     · a FLAT side is genuinely flat — its two swings within 0.6 of a tolerance;
     · nothing pokes outside the shape — no swing in it beyond either line. */
  {
    const w7=sw.slice(-7);
    const lineThru=(a,b)=>i=>a.p+(b.p-a.p)*(i-a.i)/Math.max(1,b.i-a.i);
    const third=(arr,a)=>arr.filter(x=>x.i<a.i).slice(-1)[0];
    const zh=third(w7.filter(x=>x.type==='H'),hs[0]), zl=third(w7.filter(x=>x.type==='L'),ls[0]);
    const onH=zh && Math.abs(zh.p-lineThru(hs[0],hs[1])(zh.i))<=tol*0.5;
    const onL=zl && Math.abs(zl.p-lineThru(ls[0],ls[1])(zl.i))<=tol*0.5;
    if(!onH && !onL) return null;
    if(Math.abs(hSlope)<flat && Math.abs(hs[1].p-hs[0].p)>tol*0.6) return null;
    if(Math.abs(lSlope)<flat && Math.abs(ls[1].p-ls[0].p)>tol*0.6) return null;
    const uF=lineThru(hs[0],hs[1]), lF=lineThru(ls[0],ls[1]);
    const from=Math.min(hs[0].i,ls[0].i, onH?zh.i:Infinity, onL?zl.i:Infinity);
    if(w7.some(x=>x.i>=from && (x.type==='H' ? x.p>uF(x.i)+tol*0.5 : x.p<lF(x.i)-tol*0.5))) return null;
    if(onH) hs.unshift(zh); if(onL) ls.unshift(zl);   /* the third touch is part of the evidence */
  }
  const HS0=hs[hs.length-2], HS1=hs[hs.length-1], LS0=ls[ls.length-2], LS1=ls[ls.length-1];   /* the two swings each line runs through */
  const endI=Math.max(HS1.i,LS1.i);
  const hFlat=Math.abs(hSlope)<flat, lFlat=Math.abs(lSlope)<flat;
  let name=null,dir=0,kind='continuation',trigger=null,why='';

  if(hFlat&&lSlope>flat){
    name='Ascending Triangle'; dir=1; trigger=HS1.p;
    why='Flat resistance near '+HS1.p.toFixed(bwDG())+' with higher lows pressing into it.';
  } else if(lFlat&&hSlope<-flat){
    name='Descending Triangle'; dir=-1; trigger=LS1.p;
    why='Flat support near '+LS1.p.toFixed(bwDG())+' with lower highs pressing into it.';
  } else if(hSlope<-flat&&lSlope>flat){
    name='Symmetrical Triangle'; dir=0; trigger=HS1.p;
    why='Lower highs and higher lows converging — direction undecided until one side breaks.';
  } else if(hSlope>flat&&lSlope>flat&&hSlope<lSlope){
    name='Rising Wedge'; dir=-1; kind='reversal'; trigger=LS1.p;
    why='Both sides rising but the lows rising faster — momentum compressing against the highs.';
  } else if(hSlope<-flat&&lSlope<-flat&&hSlope<lSlope){
    /* Highs falling FASTER than lows (hSlope more negative) is what makes
       the sides converge. This tested the reverse, so a widening fall was
       named a Falling Wedge with a bullish target and the real wedge was
       never recognised. */
    name='Falling Wedge'; dir=1; kind='reversal'; trigger=HS1.p;
    why='Both sides falling but the highs falling faster — selling losing room.';
  } else if(hFlat&&lFlat){
    name='Rectangle / Range'; dir=0; trigger=HS1.p;
    why='Both sides flat — a range between '+LS1.p.toFixed(bwDG())+' and '+HS1.p.toFixed(bwDG())+'.';
  }
  if(!name) return null;

  const height=Math.abs(HS0.p-LS0.p);
  /* TRENDLINES, NOT LAST-PIVOT PRICES. The trigger was the price of the
     last turning point, held flat. On a sloped side (every wedge, and the
     sloped side of a symmetrical triangle) the real breakout level is the
     line through the two pivots extended to the current bar, and on a
     steep wedge the flat level could be far from it. Each side is now that
     line; flat sides come out flat on their own. */
  const lineOf=(a,b)=>{ const s=(b.p-a.p)/Math.max(1,b.i-a.i); return i=>a.p+s*(i-a.i); };
  const upper=lineOf(HS0,HS1), lower=lineOf(LS0,LS1);
  const nowI=cd.length-1;
  if(trigger===HS1.p) trigger=upper; else if(trigger===LS1.p) trigger=lower;
  let lc, invalid;
  if(dir===0){
    /* A symmetrical triangle or a range has no built-in direction — but it
       does resolve, and the side it breaks decides it. This used to stay
       "complete" for ever, and the invalidation check below then read an
       UPWARD breakout as the shape dying and deleted it at the exact
       moment it mattered. Watch both sides; the first close beyond either
       one sets the direction, trigger, target and invalidation. */
    const up=lifecycle(cd,endI,upper,1), dn=lifecycle(cd,endI,lower,-1);
    const upAt=up.broke?up.barsSince:-1, dnAt=dn.broke?dn.barsSince:-1;
    if(upAt>=0 && (dnAt<0 || upAt>dnAt)){ dir=1; trigger=upper; lc=up; invalid=LS1.p; why+=' Broke upward.'; }
    else if(dnAt>=0){ dir=-1; trigger=lower; lc=dn; invalid=HS1.p; why+=' Broke downward.'; }
    else { lc={state:'complete',barsSince:cd.length-1-endI,broke:false,
               note:'no built-in direction — the side it breaks decides it'};
           invalid=null; }
  } else {
    lc=lifecycle(cd,endI,trigger,dir);
    invalid=dir>0?LS1.p:HS1.p;
  }
  /* Report the line's value: where it was crossed if it has broken, or
     where it sits on the current bar if it has not. Downstream code
     (chart labels, targets, the published reading) expects a number. */
  let trigNum=trigger;
  if(typeof trigger==='function'){
    const atI = (lc && lc.broke) ? (nowI-(lc.barsSince||0)+1) : nowI;
    trigNum=trigger(Math.max(endI,Math.min(nowI,atI)));
  }
  return{key:name.toLowerCase().replace(/[^a-z]+/g,'-'),name,kind,dir,
    trigger:trigNum,target:dir?(dir>0?trigNum+height:trigNum-height):null,
    upperLine:{a:{i:HS0.i,p:HS0.p},b:{i:HS1.i,p:HS1.p}},
    lowerLine:{a:{i:LS0.i,p:LS0.p},b:{i:LS1.i,p:LS1.p}},
    invalid,
    pivots:hs.concat(ls).sort((a,b)=>a.i-b.i),
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
  /* THE FLAG ENDS WHERE IT BREAKS. The box used to run to the last bar,
     so the breakout bar widened the box past the depth limit and the flag
     vanished at the moment it resolved — it could never show as breaking
     or confirmed. The box now stops at the first close beyond it, and the
     bars after that are judged by lifecycle(). */
  let boxEnd=seg.length-1;
  for(let k=poleEnd+4;k<seg.length;k++){
    const box=seg.slice(poleEnd,k);
    const bh=Math.max.apply(null,box.map(H)), bl=Math.min.apply(null,box.map(L));
    if(poleDir>0 ? C(seg[k])>bh : C(seg[k])<bl){ boxEnd=k-1; break; }
  }
  const after=seg.slice(poleEnd,boxEnd+1);
  if(after.length<4) return null;
  const hi=Math.max.apply(null,after.map(H)), lo=Math.min.apply(null,after.map(L));
  if((hi-lo)>poleSize*0.62) return null;            // drift too deep to be a flag
  const drift=C(after[after.length-1])-C(after[0]);
  if(poleDir>0&&drift>0) return null;               // must lean against the pole
  if(poleDir<0&&drift<0) return null;
  const trigger=poleDir>0?hi:lo;
  const baseI=cd.length-look+poleEnd;
  const boxEndI=cd.length-look+boxEnd;
  const lc=lifecycle(cd,boxEndI,trigger,poleDir);
  return{key:poleDir>0?'bullflag':'bearflag',
    name:poleDir>0?'Bull Flag':'Bear Flag',kind:'continuation',dir:poleDir,
    trigger,target:poleDir>0?trigger+poleSize:trigger-poleSize,
    invalid:poleDir>0?lo:hi,
    pivots:[],poleStartI:Math.max(0,baseI-6),poleEndI:baseI,startI:baseI,endI:boxEndI,life:lc,
    why:'A '+(poleDir>0?'rally':'sell-off')+' of '+poleSize.toFixed(bwDG())+
        ' then a shallow drift the other way — this shape looks like a reversal but usually continues.'};
}

/* ── NEW PATTERNS (Oct 2026) — channels, broadening, pennants, cup & handle, rounding.
   Tested on 12 pairs x 4 years before they were added; same contract as the
   matchers above, and the same confirmation rules apply to all of them. */
const nLine=(a,b)=>{ const s=(b.p-a.p)/Math.max(1,b.i-a.i); return i=>a.p+s*(i-a.i); };

/* both-sides watcher, as the symmetrical triangle does: the first side closed through decides */
function eitherWay(cd,endI,upper,lower,LC){
  const up=LC(cd,endI,upper,1), dn=LC(cd,endI,lower,-1);
  const upAt=up.broke?up.barsSince:-1, dnAt=dn.broke?dn.barsSince:-1;
  if(upAt>=0 && (dnAt<0||upAt>dnAt)) return {dir:1,lc:up,trig:upper};
  if(dnAt>=0) return {dir:-1,lc:dn,trig:lower};
  return {dir:0,lc:{state:'complete',barsSince:cd.length-1-endI,broke:false},trig:null};
}
function valAt(f,lc,cd,endI){ if(typeof f!=='function') return f; const nowI=cd.length-1; const atI=lc&&lc.broke?(nowI-(lc.barsSince||0)+1):nowI; return f(Math.max(endI,Math.min(nowI,atI))); }

/* 1. CHANNEL — two parallel sloping sides (rising or falling). Breaks either way; target = channel width. */
function channel(cd,sw,tol){ const LC=lifecycle;
  /* TIGHTENED: the last 3 highs and 3 lows; one side must have THREE touches on its line
     (the middle pivot within half a tolerance of the line through the outer two), the other
     side at least two, the sides parallel, and no swing poking outside the channel. */
  const p=sw.slice(-7), hs=p.filter(x=>x.type==='H').slice(-3), ls=p.filter(x=>x.type==='L').slice(-3);
  if(hs.length<2||ls.length<2||(hs.length<3&&ls.length<3)) return null;
  const fit=a=>nLine(a[0],a[a.length-1]);
  const up=fit(hs), lo=fit(ls);
  const hS=(hs[hs.length-1].p-hs[0].p)/Math.max(1,hs[hs.length-1].i-hs[0].i), lS=(ls[ls.length-1].p-ls[0].p)/Math.max(1,ls[ls.length-1].i-ls[0].i);
  const flat=tol/25;
  if(Math.sign(hS)!==Math.sign(lS) || Math.abs(hS)<flat || Math.abs(lS)<flat) return null;
  if(Math.abs(hS-lS) > Math.max(Math.abs(hS),Math.abs(lS))*0.35) return null;
  const touch3=a=>a.length===3 && Math.abs(a[1].p-nLine(a[0],a[2])(a[1].i))<=tol*0.5;
  if(!touch3(hs) && !touch3(ls)) return null;
  if(hs.some(x=>x.p>up(x.i)+tol*0.5) || ls.some(x=>x.p<lo(x.i)-tol*0.5)) return null;
  const endI=Math.max(hs[hs.length-1].i,ls[ls.length-1].i);
  const width=up(endI)-lo(endI); if(!(width>0)) return null;
  const e=eitherWay(cd,endI,up,lo,LC); const rising=hS>0;
  const trig=e.dir?valAt(e.trig,e.lc,cd,endI):null;
  const all=hs.concat(ls).sort((a,b)=>a.i-b.i);
  return {key:rising?'chup':'chdn', name:rising?'Ascending Channel':'Descending Channel', kind:'either', dir:e.dir,
    trigger:trig, target:e.dir?trig+e.dir*width:null, invalid:e.dir>0?ls[ls.length-1].p:e.dir<0?hs[hs.length-1].p:null,
    pivots:all, startI:all[0].i, endI, life:e.lc,
    why:(rising?'Higher highs and higher lows':'Lower highs and lower lows')+' in parallel, with three touches on one side — the side it closes through decides.'};
}

/* 2. BROADENING (megaphone) — highs rising, lows falling. Breaks either way; target = width at the break. */
function broadening(cd,sw,tol){ const LC=lifecycle;
  const p=sw.slice(-5), hs=p.filter(x=>x.type==='H').slice(-2), ls=p.filter(x=>x.type==='L').slice(-2);
  if(hs.length<2||ls.length<2) return null;
  const hS=(hs[1].p-hs[0].p)/Math.max(1,hs[1].i-hs[0].i), lS=(ls[1].p-ls[0].p)/Math.max(1,ls[1].i-ls[0].i);
  const flat=tol/25; if(!(hS>flat && lS<-flat)) return null;
  const up=nLine(hs[0],hs[1]), lo=nLine(ls[0],ls[1]), endI=Math.max(hs[1].i,ls[1].i);
  const width=up(endI)-lo(endI);
  const e=eitherWay(cd,endI,up,lo,LC); const trig=e.dir?valAt(e.trig,e.lc,cd,endI):null;
  return {key:'broad', name:'Broadening (Megaphone)', kind:'either', dir:e.dir,
    trigger:trig, target:e.dir?trig+e.dir*width:null, invalid:e.dir>0?ls[1].p:e.dir<0?hs[1].p:null,
    pivots:[hs[0],ls[0],hs[1],ls[1]].sort((a,b)=>a.i-b.i), startI:Math.min(hs[0].i,ls[0].i), endI, life:e.lc,
    why:'Higher highs and lower lows — swings widening, the market losing agreement.'};
}

/* 3. PENNANT — REBUILT: found the way the engine finds flags (a pole, then the consolidation
   after it up to the first close beyond it), but the consolidation's highs must FALL and its lows
   RISE — fitted on the bars themselves, so it does not need four separate swing points. */
function regress(xs,ys){ const n=xs.length, mx=xs.reduce((a,b)=>a+b,0)/n, my=ys.reduce((a,b)=>a+b,0)/n;
  let sxy=0,sxx=0; for(let k=0;k<n;k++){ sxy+=(xs[k]-mx)*(ys[k]-my); sxx+=(xs[k]-mx)**2; } const m=sxx?sxy/sxx:0; return {m, at:x=>my+m*(x-mx)}; }
function pennant(cd,sw,tol){ const LC=lifecycle;
  if(cd.length<30) return null;
  const look=Math.min(60,cd.length-1), base=cd.length-look, seg=cd.slice(base);
  let poleEnd=-1,dir=0,poleSize=0,poleStart=0;
  for(let i=6;i<seg.length-5;i++){ const mv=C(seg[i])-C(seg[i-6]); if(Math.abs(mv)>tol*4&&Math.abs(mv)>poleSize){ poleSize=Math.abs(mv); poleEnd=i; poleStart=i-6; dir=mv>0?1:-1; } }
  if(poleEnd<0) return null;
  let boxEnd=seg.length-1;
  for(let k=poleEnd+4;k<seg.length;k++){ const box=seg.slice(poleEnd,k), bh=Math.max(...box.map(H)), bl=Math.min(...box.map(L));
    if(dir>0?C(seg[k])>bh:C(seg[k])<bl){ boxEnd=k-1; break; } }
  const box=seg.slice(poleEnd,boxEnd+1); if(box.length<5||box.length>25) return null;
  const hi=Math.max(...box.map(H)), lo=Math.min(...box.map(L)); if(hi-lo>poleSize*0.5) return null;
  const xs=box.map((_,k)=>base+poleEnd+k), uh=regress(xs,box.map(H)), ul=regress(xs,box.map(L));
  if(!(uh.m<-tol/60 && ul.m>tol/60)) return null;                                  // converging, not a flag
  const endI=base+boxEnd, trigF=dir>0?(i=>uh.at(i)):(i=>ul.at(i)), lc=LC(cd,endI,trigF,dir), trig=valAt(trigF,lc,cd,endI);
  return {key:dir>0?'bullpen':'bearpen', name:dir>0?'Bull Pennant':'Bear Pennant', kind:'continuation', dir,
    trigger:trig, target:trig+dir*poleSize, invalid:dir>0?lo:hi,
    pivots:[{i:base+poleStart,p:C(seg[poleStart])},{i:base+poleEnd,p:C(seg[poleEnd])},{i:endI,p:C(seg[boxEnd])}],
    poleStartI:base+poleStart, poleEndI:base+poleEnd, startI:base+poleStart, endI, life:lc, why:'A sharp '+(dir>0?'rally':'drop')+' then a small tightening triangle — usually continues.'};
}

/* is the stretch between i0 and i1 a U (rounded), not a V? share of bars in the bottom 30% of the depth */
function uShape(cd,i0,i1,bottomIsLow){
  const seg=cd.slice(i0,i1+1); if(seg.length<12) return false;
  const hi=Math.max(...seg.map(H)), lo=Math.min(...seg.map(L)), d=hi-lo; if(!(d>0)) return false;
  const inBase=seg.filter(b=>bottomIsLow ? L(b)<=lo+d*0.3 : H(b)>=hi-d*0.3).length;
  const ext=bottomIsLow?seg.findIndex(b=>L(b)===lo):seg.findIndex(b=>H(b)===hi);
  return inBase/seg.length>=0.25 && ext>seg.length*0.2 && ext<seg.length*0.8;
}

/* a parabola fitted to the closes from rim to rim must explain most of the path (R2 >= 0.7),
   open the right way, and have its turning point in the middle 60% */
function curved(cd,i0,i1,bull){
  const ys=[],xs=[]; for(let i=i0;i<=i1;i++){ xs.push((i-i0)/(i1-i0)); ys.push(C(cd[i])); }
  const n=xs.length; let S=[0,0,0,0,0],T=[0,0,0];
  for(let k=0;k<n;k++){ const x=xs[k],y=ys[k]; let p=1; for(let e=0;e<5;e++){ S[e]+=p; p*=x; } T[0]+=y; T[1]+=x*y; T[2]+=x*x*y; }
  const A=[[S[4],S[3],S[2]],[S[3],S[2],S[1]],[S[2],S[1],S[0]]], B=[T[2],T[1],T[0]];
  const det=m=>m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])-m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])+m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
  const D=det(A); if(!D) return false;
  const col=(c)=>A.map((r,k)=>r.map((v,j)=>j===c?B[k]:v));
  const a=det(col(0))/D, b=det(col(1))/D, c=det(col(2))/D;
  if(bull? a<=0 : a>=0) return false;
  const vx=-b/(2*a); if(vx<0.2||vx>0.8) return false;
  const my=ys.reduce((s,v)=>s+v,0)/n; let ss=0,se=0; for(let k=0;k<n;k++){ const f=a*xs[k]*xs[k]+b*xs[k]+c; ss+=(ys[k]-my)**2; se+=(ys[k]-f)**2; }
  if(!(ss>0 && 1-se/ss>=0.7)) return false;
  const curve=[]; for(let k=0;k<=20;k++){ const x=k/20; curve.push([i0+(i1-i0)*x, a*x*x+b*x+c]); }
  return {curve};
}

/* 4. CUP & HANDLE (and inverse) — two rims at about the same level, a rounded base between, a shallow handle. */
function cupHandle(cd,sw,tol){ const LC=lifecycle;
  for(const bull of [true,false]){
    const T=bull?'H':'L', B=bull?'L':'H';
    const rims=sw.filter(x=>x.type===T); if(rims.length<2) continue;
    const r2=rims[rims.length-1];
    const after=sw.filter(x=>x.i>r2.i&&x.type===B); if(after.length!==1) continue;    // exactly one handle pivot
    const hnd=after[0];
    for(let q=rims.length-2;q>=Math.max(0,rims.length-4);q--){
      const r1=rims[q]; if(r2.i-r1.i<15) continue;
      if(Math.abs(r1.p-r2.p)>tol*1.2) continue;
      const seg=cd.slice(r1.i,r2.i+1), base=bull?Math.min(...seg.map(L)):Math.max(...seg.map(H));
      const depth=Math.abs((bull?Math.max(r1.p,r2.p):Math.min(r1.p,r2.p))-base);
      if(depth<tol*2.5) continue;
      const hDepth=Math.abs(r2.p-hnd.p); if(hDepth>depth*0.5 || hDepth<tol*0.3) continue;
      if(hnd.i-r2.i>(r2.i-r1.i)*0.5) continue;
      if(!uShape(cd,r1.i,r2.i,bull)) continue;
      const cv=curved(cd,r1.i,r2.i,bull); if(!cv) continue;                   /* the cup must be a real curve too */
      const rim=bull?Math.max(r1.p,r2.p):Math.min(r1.p,r2.p), dir=bull?1:-1, lc=LC(cd,hnd.i,rim,dir);
      return {key:bull?'cup':'icup', name:bull?'Cup & Handle':'Inverse Cup & Handle', kind:'continuation', dir,
        trigger:rim, target:rim+dir*depth, invalid:hnd.p, pivots:[r1,r2,hnd], curve:cv.curve, startI:r1.i, endI:hnd.i, life:lc,
        why:'A rounded '+(bull?'base':'top')+' between two rims near '+rim.toFixed(bwDG())+', then a shallow handle.'};
    }
  }
  return null;
}

/* 5. ROUNDING BOTTOM / TOP (saucer) — a long U between two rims, no handle needed; breaks the rim. */
function rounding(cd,sw,tol){ const LC=lifecycle;
  for(const bull of [true,false]){
    const T=bull?'H':'L';
    const rims=sw.filter(x=>x.type===T); if(rims.length<2) continue;
    const r2=rims[rims.length-1];
    if(sw[sw.length-1].i!==r2.i) continue;                                    // the rim is the newest swing
    for(let q=rims.length-2;q>=Math.max(0,rims.length-5);q--){
      const r1=rims[q]; if(r2.i-r1.i<25) continue;
      if(Math.abs(r1.p-r2.p)>tol*1.5) continue;
      const seg=cd.slice(r1.i,r2.i+1), base=bull?Math.min(...seg.map(L)):Math.max(...seg.map(H));
      const depth=Math.abs(r2.p-base); if(depth<tol*3) continue;
      if(!uShape(cd,r1.i,r2.i,bull)) continue;
      const cv=curved(cd,r1.i,r2.i,bull); if(!cv) continue;                   /* TIGHTENED: a real curve */
      const between=sw.filter(x=>x.i>r1.i&&x.i<r2.i&&x.type===T);
      if(between.some(x=>bull?x.p>Math.max(r1.p,r2.p):x.p<Math.min(r1.p,r2.p))) continue;   // nothing pokes above the rim
      const rim=bull?Math.max(r1.p,r2.p):Math.min(r1.p,r2.p), dir=bull?1:-1, lc=LC(cd,r2.i,rim,dir);
      return {key:bull?'rbot':'rtop', name:bull?'Rounding Bottom':'Rounding Top', kind:'reversal', dir,
        trigger:rim, target:rim+dir*depth, invalid:base, pivots:[r1,r2], curve:cv.curve, startI:r1.i, endI:r2.i, life:lc,
        why:'A slow, rounded '+(bull?'bottom':'top')+' over '+(r2.i-r1.i)+' bars back up to the rim at '+rim.toFixed(bwDG())+'.'};
    }
  }
  return null;
}

/* ── PUBLIC ───────────────────────────────────────────────────────── */
const CONF_PCT=0.70, CONF_STALL_LIMIT=10;   /* his confirmation rule — see CONFIRMATION BY THE CLOSE */
function detect(candles,opts){
  opts=opts||{};
  let cd=(candles||[]).filter(c=>isFinite(H(c))&&isFinite(L(c))&&isFinite(C(c)));
  /* CLOSED BARS ONLY (his rule): when the caller says the newest bar is still
     forming, it plays no part in any state — a break, a failure or a
     confirmation counts when its bar has closed. */
  if(opts.liveLast && cd.length>30) cd=cd.slice(0,-1);
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
    [headShoulders,doubleTriple,converging,flag,channel,broadening,pennant,cupHandle,rounding].forEach(fn=>{
      let r=null;
      try{ r=fn(cd,win,tol); }catch(e){ r=null; }
      if(!r) return;
      /* Keep the most INFORMATIVE version of each shape. A pattern seen
         from an older window has more aftermath to judge, so it can be
         'failed' or 'confirmed' where the newest window still says
         'complete'. Prefer whichever has actually resolved. */
      const rank={breaking:0,stalled:0,failed:1,target:1,confirmed:2,stalledout:2,complete:3,forming:4};
      /* One slot per SHAPE, not per shape TYPE. Keyed on type alone, an old
         resolved double top took the slot and a new one forming at the
         current bar was thrown away. Two windows that see the same shape
         (same end bar) still collapse to the more informative read. */
      const slot=r.key+'@'+r.endI;
      const prev=byKey[slot];
      if(!prev||rank[r.life.state]<rank[prev.life.state]) byKey[slot]=r;
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
  /* A REVERSAL NEEDS SOMETHING TO REVERSE. Two equal highs in the middle
     of a downtrend were being called a double top. Head & shoulders and
     double / triple tops and bottoms now need a real prior move INTO the
     shape: over the 20 bars before it starts, price must have travelled at
     least 2x the pair's average bar range in the direction being reversed
     (up into a top, down into a bottom). Measured on the pair's own range,
     so it works the same on gold, JPY and EURUSD. */
  const REVERSALS={hs:1,ihs:1,dtop:1,dbot:1,ttop:1,tbot:1};
  const PRIOR_BARS=20;
  let noPriorTrend=0;
  const trendOK=p=>{
    if(!REVERSALS[p.key]) return true;
    const s=p.startI, from=Math.max(0,s-PRIOR_BARS);
    if(s-from<8) return false;                       // not enough history before it to judge
    /* The move INTO the shape: from the lowest low of the window up to the
       start (for a top), or from the highest high down (for a bottom).
       Comparing two endpoints let an earlier move the other way cancel a
       clear rally into the shape. */
    const win=cd.slice(from,s+1), need=avgRange(cd)*2;
    if(p.dir<0){ const lo=Math.min.apply(null,win.map(L)); return C(cd[s])-lo>=need; }
    const hi=Math.max.apply(null,win.map(H)); return hi-C(cd[s])>=need;
  };
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
    if(!(h>=MIN_HEIGHT && p.span>=MIN_SPAN)) return false;
    if(!trendOK(p)){ noPriorTrend++; return false; }
    return true;
  });
  const keep = sized.slice();

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
          note:'price closed beyond the invalidation at '+(+p.invalid).toFixed(bwDG())+
               ' before the level was ever broken \u2014 the shape is dead'};
        p.invalidated=true;
      }
    }
    /* ── CONFIRMATION BY THE CLOSE (Oct 2026, his rules) ─────────────
       "Held for 3 bars" called 48% of breaks confirmed that then hit the
       invalidation first (12 pairs, 4 years). Now, closes only, wicks never:
         BAR      a close at >=70% of the way from the trigger to the measured
                  target, on candle 2 or later after the break -> confirmed.
                  A 70% close on candle 1 waits for candle 2.
         DISTANCE when the page says the conditions are there (opts.fastConfirm:
                  time left in the bar, a fast bar, participation, and Risk Radar
                  flagged or its volatility factor firing), a 70% close confirms
                  at once, even on the break candle.
         STALLED  still beyond the trigger at candle 3 without a 70% close; it can
                  still confirm up to candle 10, then it is STALLED OUT.
         FAILED   a close back inside the trigger before confirming, or — after
                  confirming — a close beyond the invalidation line.
         TARGET   after confirming, a close at or beyond the measured target. */
    if(p.life && p.life.broke) p.breakI = cd.length-(p.life.barsSince||0);     /* the bar it broke on — the chart draws to it */
    /* ── CONFIRMED EARLY BY THE SIDE IN CONTROL (Nov 2026, his rule; prototype chart_pattern_early_confirm) ──
       The 70% rule confirmed about one break in five, with most of the move already gone. When the page supplies
       opts.earlyConfirm (the Liquidity tab's "who's dominant" pill on the CLOSED break candle), a break whose own
       side is dominant and pressing is CONFIRMED EARLY at the break close. It is a flag on a live break
       (life.early), not a new state, so everything that reads `state` behaves as before:
         - the state stays breaking / stalled until the full 70% confirmation, the target or a failure;
         - a close back inside the trigger does NOT fail it (life.inside says so); only a close beyond the
           invalidation does, which is the rule a confirmed pattern always had;
         - it does not stall out.
       A break made against the dominant side is flagged life.against (a warning, nothing else changes).
       Without opts.earlyConfirm (the Arbiter's copy) nothing here runs. */
    let EC=null;
    if(p.life && p.life.broke && p.dir && typeof opts.earlyConfirm==='function' && isFinite(+p.target) && isFinite(+p.trigger)){
      const b0=cd.length-(p.life.barsSince||0);
      if(b0>=1 && b0<=cd.length-1){ try{ EC=opts.earlyConfirm(p, cd, b0)||null; }catch(e){ EC=null; } }
    }
    const EARLY=!!(EC&&EC.early);
    if(p.life && p.life.broke && (p.life.state!=='failed' || EARLY) && p.dir && isFinite(+p.target) && isFinite(+p.trigger)){
      const lastI = cd.length-1;
      const bAbs  = cd.length-(p.life.barsSince||0);
      const trig=+p.trigger, dist=Math.abs(+p.target-trig), d=p.dir;
      if(bAbs>lastI){
        p.life = {state:'complete', barsSince:0, broke:false,
                  note:'crossing the trigger on the bar still forming \u2014 it counts when that bar closes'};
      } else if(dist>0 && bAbs>=1){
        const prog=c=>(c-trig)*d/dist;
        const inv=+p.invalid, invOK=isFinite(inv);
        let st=null, at=null, how='', confAt=null;
        for(let j=0; bAbs+j<=lastI; j++){
          const c=C(cd[bAbs+j]);
          if(st===null && EARLY){
            if(invOK && (d>0 ? c<inv : c>inv)){ st='failed'; at=j; how='confirmed early, then closed beyond the invalidation at '+inv.toFixed(bwDG())+' \u2014 it did not deliver'; break; }
            if(prog(c)>=1){ st='target'; at=j; how='closed at or beyond the measured target'; break; }
            if(prog(c)>=CONF_PCT && j<=CONF_STALL_LIMIT){
              if(j>=2){ st='confirmed'; at=j; confAt=j; how='bars'; }
              else { let fast=false; try{ fast=!!(opts.fastConfirm && opts.fastConfirm(p, cd, bAbs+j)); }catch(e){ fast=false; }
                     if(fast){ st='confirmed'; at=j; confAt=j; how='distance'; } }
            }
          } else if(st===null){
            if(j>CONF_STALL_LIMIT) break;
            if(j>0 && prog(c)<0){ st='failed'; at=j; how='closed back inside the trigger before reaching '+Math.round(CONF_PCT*100)+'% of the target'; break; }
            if(prog(c)>=CONF_PCT){
              if(j>=2){ st='confirmed'; at=j; confAt=j; how='bars'; }
              else { let fast=false; try{ fast=!!(opts.fastConfirm && opts.fastConfirm(p, cd, bAbs+j)); }catch(e){ fast=false; }
                     if(fast){ st='confirmed'; at=j; confAt=j; how='distance'; } }
            }
          } else if(st==='confirmed'){
            if(invOK && (d>0 ? c<inv : c>inv)){ st='failed'; at=j; how='confirmed, then closed beyond the invalidation at '+inv.toFixed(bwDG())+' \u2014 it did not deliver'; break; }
            if(prog(c)>=1){ st='target'; at=j; how='closed at or beyond the measured target'; break; }
          }
        }
        const liveEarly = EARLY && st===null, sideW = d>0 ? 'buyers' : 'sellers';
        const inside = liveEarly && prog(C(cd[lastI]))<0;
        if(st===null){ const k=lastI-bAbs; st = k<3 ? 'breaking' : (k<=CONF_STALL_LIMIT || EARLY) ? 'stalled' : 'stalledout'; at=null; }
        const evAbs = at!=null ? bAbs+at : bAbs;
        p.life = {state:st, barsSince:cd.length-evAbs, broke:true, breakBarsSince:cd.length-bAbs,
                  method:(confAt!=null?how:null), confirmedAt:confAt, afterConfirm:(st==='failed'&&(confAt!=null||EARLY))||st==='target',
                  early:EARLY, earlyLive:liveEarly, inside:inside, against:!!(EC&&EC.against&&!EARLY), pill:EC?EC.w:null, domSide:EC?EC.side:null,
                  note: liveEarly ? (inside
                          ? 'price has closed back inside the trigger \u2014 the early confirmation stands until a close beyond the invalidation'+(invOK?' at '+inv.toFixed(bwDG()):'')
                          : 'the break candle closed past the trigger with '+sideW+' dominant'+(EC&&EC.w?' and the pill reading \u201c'+String(EC.w).toLowerCase()+'\u201d':'')+' \u2014 the side in control agrees with the break')
                      : st==='breaking' ? 'broken '+(lastI-bAbs+1)+' bar(s) ago \u2014 waiting for a close at '+Math.round(CONF_PCT*100)+'% of the way to the target'
                      : st==='stalled' ? 'held beyond the trigger for '+(lastI-bAbs)+' bars without a close at '+Math.round(CONF_PCT*100)+'% of the way to the target \u2014 can still confirm until candle '+CONF_STALL_LIMIT
                      : st==='stalledout' ? 'no close at '+Math.round(CONF_PCT*100)+'% of the way to the target within '+CONF_STALL_LIMIT+' candles of the break'
                      : st==='confirmed' ? (how==='distance' ? 'confirmed by distance \u2014 a '+Math.round(CONF_PCT*100)+'%+ close with the fast-break conditions present'
                                                             : 'confirmed on candle '+confAt+' after the break \u2014 a close at '+Math.round(CONF_PCT*100)+'%+ of the way to the target')
                      : how};
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
      var n = (raw instanceof Date) ? +raw : (typeof bwBarMs==='function' ? bwBarMs(bar) : (typeof raw==='number' ? raw : +new Date(raw)));
      if(!isFinite(n) || !n) return null;
      return n < 1e12 ? n*1000 : n;
    })() : null;
    p.completion = p.life.state==='invalidated'?0
                 : p.life.state==='confirmed'?100
                 : p.life.state==='target'?100
                 : p.life.state==='stalled'?85
                 : p.life.state==='stalledout'?0
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
  const alive = [];
  /* Two windows can see the SAME shape with a pivot more or less at one
     end, so it arrived twice under different end bars. Shapes of one type
     whose bar ranges mostly overlap are one shape: keep the better read.
     Shapes that do not overlap (an old double top and a new one) both stay.
     Run AFTER the dead-shape check, so a view that is dead never wins. */
  const rk={breaking:0,failed:1,confirmed:2,complete:3,forming:4};
  keep.filter(p=>p.life.state!=='invalidated').sort((a,b)=>b.endI-a.endI).forEach(r=>{
    const shared=(f)=>{ const a=new Set((f.pivots||[]).map(x=>x.i)); return (r.pivots||[]).filter(x=>a.has(x.i)).length; };
    const dup=alive.find(f=>f.key===r.key && (shared(f)>=1 ||
      Math.min(f.endI,r.endI)-Math.max(f.startI,r.startI) > 0.5*Math.min(f.endI-f.startI||1, r.endI-r.startI||1)));
    if(!dup){ alive.push(r); return; }
    if(rk[r.life.state]<rk[dup.life.state]) alive[alive.indexOf(dup)]=r;
  });

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
  return {patterns:alive.slice(0,4),swings:sw,tol,invalidated:dead,noPriorTrend,
          suppressed:Math.max(0,found.length-Math.min(alive.length,4))};
}

root.BWChartPatterns={detect,swings,lifecycle};
})(typeof window!=='undefined'?window:globalThis);
