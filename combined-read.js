/* combined-read.js — GENERATED from patterns.html by build-host.js. Do not edit by hand.
   The Pattern Detector's Combined Read, run inside Arbiter when that page is not publishing.
   Every page function below is copied VERBATIM; test-combined-read.js fails if any drifts.
   Arbiter supplies only the page's STATE (candles, pattern data, risk, open trades, broker
   symbols, the alert cache). publishConfluence runs VERBATIM, so the reading comes out in
   exactly the shape the Pattern Detector publishes — but into PRIVATE storage: Arbiter
   never writes the Pattern Detector's channel. Formations get a SEPARATE instance per pair, because their
   hold state is keyed by start bar, not by pair. */
/* the Combined Read v2 engine, VERBATIM from patterns.html */
(function(){
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
const ENTER=0.22, EXIT=0.46, HOLD=4, LOOK=50, REPLAY=150;
const MEMO={};                       /* key -> {t0, sw:{barT:..}, reg:{barT:..}} */

function atrAt(cd,q,n){ n=n||14; let s=0,k=0; for(let i=Math.max(1,q-n+1);i<=q;i++){ const b=cd[i],p=cd[i-1];
  s+=Math.max(b.h-b.l,Math.abs(b.h-p.c),Math.abs(b.l-p.c)); k++; } return k?s/k:0; }
function effAt(cd,q){ const s=Math.max(0,q-LOOK+1); let p=0; for(let i=s+1;i<=q;i++) p+=Math.abs(cd[i].c-cd[i-1].c);
  return p?Math.abs(cd[q].c-cd[s].c)/p:1; }
function boxOf(cd,q){ let hi=-Infinity,lo=Infinity; for(let i=Math.max(0,q-LOOK+1);i<=q;i++){ hi=Math.max(hi,cd[i].h); lo=Math.min(lo,cd[i].l); } return {hi,lo}; }
function longBar(cd,q,d){ const b=cd[q]; let a=0,k=0; for(let i=Math.max(0,q-30);i<q;i++){ a+=cd[i].h-cd[i].l; k++; } a=k?a/k:0;
  const rg=b.h-b.l; return a>0 && rg>=a*2.0 && Math.abs(b.c-b.o)/rg>=0.6 && (d>0?b.c>b.o:b.c<b.o); }
/* did a break of price p in direction d confirm ON bar q?  'long' | 'two' | null */
function confirmAt(cd,q,p,d){ if(q<3) return null; const buf=atrAt(cd,q)*0.2, bey=i=>d>0?cd[i].c>p+buf:cd[i].c<p-buf;
  if(!bey(q)) return null;
  if(!bey(q-1) && longBar(cd,q,d)) return 'long';
  if(bey(q-1) && !bey(q-2) && !longBar(cd,q-1,d)) return 'two';
  if(!bey(q-1) && bey(q-2) && !bey(q-3) && !longBar(cd,q-2,d)) return 'two';
  return null; }

/* structure at bar q — the page's own structure engine on bars 0..q */
function swAt(cd,q,M){
  const t=cd[q].t; if(M.sw[t]) return M.sw[t];
  let r=null; try{ r=root.BWStructure.read(cd.slice(Math.max(0,q-399),q+1)); }catch(e){ r=null; }
  const off=Math.max(0,q-399), mk=(r&&r.ok&&r.marked)||[], pv=(r&&r.ok&&r.pivots)||[];
  const lab=mk.map(s=>s.label).slice(-6);
  const eq=lab.filter(x=>x.indexOf('EQ')===0).length, up=lab.filter(x=>x==='HH'||x==='HL').length, dn=lab.filter(x=>x==='LH'||x==='LL').length, d=up-dn;
  const hs=pv.filter(s=>s.type==='H'), ls=pv.filter(s=>s.type==='L');
  const H=hs[hs.length-1], L=ls[ls.length-1];
  const hLab=mk.filter(s=>s.type==='H').map(s=>s.label).pop()||null, lLab=mk.filter(s=>s.type==='L').map(s=>s.label).pop()||null;
  return M.sw[t]={lab, d, eq, hLab, lLab, lastHigh:H?{i:H.i+off,p:H.p}:null, lastLow:L?{i:L.i+off,p:L.p}:null,
    rotating:eq>=1||(Math.abs(d)<=1&&lab.length>=4), trendLock:lab.length>=4&&eq===0&&Math.abs(d)>=lab.length-1};
}

function regimeAt(cd,k,M,fmt){
  const t=cd[k].t; if(M.reg[t]) return M.reg[t];
  const q0=Math.max(LOOK+5,k-REPLAY,Math.min(k-20,LOOK+5)), s0=swAt(cd,q0,M), e0=effAt(cd,q0);
  let st = e0<ENTER&&s0.rotating&&!s0.trendLock ? 'range' : s0.d>0?'up':s0.d<0?'down':'transition';
  let at=q0, box= st==='range'?boxOf(cd,q0):null, held=0; const hist=[{st,at:q0}], ctx={};
  const go=(n,q,extra)=>{ st=n; at=q; held=0; Object.assign(ctx,extra||{}); hist.push(Object.assign({st:n,at:q},extra||{})); };
  for(let q=q0+1;q<=k;q++){
    const S=swAt(cd,q,M), e=effAt(cd,q);
    if(st!=='range'){
      if(e<ENTER && S.rotating && !S.trendLock){ if(++held>=HOLD){ box=boxOf(cd,q); go('range',q,{how:'price stopped covering ground and the swings went flat'}); continue; } }
      else held=0;
    }
    if(st==='up'){ const p=S.lastLow&&S.lastLow.p; const cf=p&&confirmAt(cd,q,p,-1);
      if(cf) go('transition',q,{from:'up',lvl:p,how:(cf==='long'?'one long bearish candle':'two closes')+' below the last swing low '+fmt(p)}); }
    else if(st==='down'){ const p=S.lastHigh&&S.lastHigh.p; const cf=p&&confirmAt(cd,q,p,1);
      if(cf) go('transition',q,{from:'down',lvl:p,how:(cf==='long'?'one long bullish candle':'two closes')+' above the last swing high '+fmt(p)}); }
    else if(st==='transition'){
      /* the new trend must be built from swings formed AFTER the break, not old labels still on the chart */
      const newH=S.lastHigh&&S.lastHigh.i>=at-3, newL=S.lastLow&&S.lastLow.i>=at-3;
      if(S.hLab==='LH'&&S.lLab==='LL'&&(newH||newL)&&(ctx.from!=='down'||(newH&&newL))) go('down',q,{how:'a lower high and a lower low printed after the break'});
      else if(S.hLab==='HH'&&S.lLab==='HL'&&(newH||newL)&&(ctx.from!=='up'||(newH&&newL))) go('up',q,{how:'a higher high and a higher low printed after the break'});
    }
    else if(st==='range'){
      if(e>EXIT || S.trendLock){ const out=S.d>0?'up':S.d<0?'down':null;
        if(out){ box=null; go(out,q,{how:S.trendLock?'the swings lined up cleanly':'price started covering ground again'}); continue; } }
      const cu=confirmAt(cd,q,box.hi,1), cdn=confirmAt(cd,q,box.lo,-1);
      if(cu||cdn){ const d=cu?1:-1, lv=d>0?box.hi:box.lo; box=null;
        go('transition',q,{from:'range',dir:d,lvl:lv,how:((cu||cdn)==='long'?'one long candle':'two closes')+' '+(d>0?'above the range top':'below the range bottom')}); }
    }
  }
  const S=swAt(cd,k,M), last=hist[hist.length-1];
  const dir = st==='up'?1:st==='down'?-1:st==='transition'?(last.from==='up'?-1:last.from==='down'?1:(last.dir||0)):0;
  return M.reg[t]={regime:st==='up'?'uptrend':st==='down'?'downtrend':st, eff:effAt(cd,k), box, lab:S.lab, dir,
                   hist:hist.slice(-4), last, barsIn:k-last.at};
}

/* a level broken in the last 3 bars, using the levels as they stood before (the box edges too) */
function breakAt(cd,k,levels,box,atP){
  const A=atrAt(cd,k), lv=levels.map(l=>({p:l.p,tier:l.tier})); if(box) lv.push({p:box.hi,tier:'range'},{p:box.lo,tier:'range'});
  let best=null;
  for(const L of lv) for(const d of [1,-1]){
    for(let q=k-2;q<=k;q++){ const cf=confirmAt(cd,q,L.p,d); if(!cf) continue;
      /* price must have been on the other side before the break — 5 closes in a row. A quick poke through
         and back is a rejection, not a break the other way. */
      const f0=cf==='long'?q:(d>0?(cd[q-1].c>L.p?q-1:q-2):(cd[q-1].c<L.p?q-1:q-2));
      if(f0<6 || cd.slice(f0-5,f0).some(b=>d>0?b.c>L.p:b.c<L.p)) break;
      const buf=A*0.2; if(cd.slice(q,k+1).some(b=>d>0?b.c<=L.p+buf:b.c>=L.p-buf)) break;
      if(atP!=null && Math.abs(atP-L.p)<A*0.5) break;
      let retest=false; for(let z=q+1;z<=k;z++){ const b=cd[z]; if(d>0?(b.l<=L.p+A*0.3&&b.c>L.p):(b.h>=L.p-A*0.3&&b.c<L.p)) retest=true; }
      const rank={major:4,range:3,medium:2,structural:1}[L.tier]||0;
      if(!best||rank>best.rank) best={L,d,j:q,how:cf,retest,rank};
      break; }
  }
  return best;
}

/* daily trend from completed days: close vs EMA20 / EMA50 of daily closes */
function dailyOf(cd,k,ms){
  const D=[]; for(let q=0;q<=k;q++){ const d=Math.floor(ms(cd[q])/86400000), L=D[D.length-1]; if(!L||L.d!==d) D.push({d,c:cd[q].c}); else L.c=cd[q].c; }
  D.pop(); if(D.length<50) return null;
  const ema=(a,n)=>{ const kk=2/(n+1); let e=a[0]; a.forEach((v,i)=>{ e=i?v*kk+e*(1-kk):v; }); return e; };
  const c=D.map(x=>x.c), e20=ema(c,20), e50=ema(c,50), last=c[c.length-1];
  return last>e50&&e20>e50?'up':last<e50&&e20<e50?'down':'no clear trend';
}

/* opts: {key, pip, levels:[{p,lo,hi,role:'S'|'R',tier}], trig (BWConfluence o.trig), rel (o.rel),
          msOf(bar)->ms, hourOf(bar)->UTC hour, fmt(price)->string} */
function read(cdAll, opts){
  opts=opts||{};
  const fmt=opts.fmt||(p=>(+p).toFixed(bwDG())), pip=opts.pip||0.0001, ms=opts.msOf||(b=>(+b.t<1e11?+b.t*1000:+b.t));
  const cd=cdAll.slice(0,-1);                         /* closed bars only */
  /* The feed sends a few hundred bars at most (often under 211), so the history the read replays
     shrinks to fit: up to 150 bars, never fewer than 20. 80 closed bars is the floor. */
  if(cd.length<LOOK+30 || !root.BWStructure) return {ok:false, why:'needs '+(LOOK+30)+' closed bars, has '+cd.length};
  const key=opts.key||'x';
  let M=MEMO[key]; if(!M||M.t0!==cd[0].t||Object.keys(M.sw).length>1500) M=MEMO[key]={t0:cd[0].t, sw:{}, reg:{}};
  const k=cd.length-1, c=cd[k].c, A=atrAt(cd,k);
  /* THE RANGE comes from the Retracement tab's range engine when the page passes it
     (opts.range, Oct 2026 — his call: that engine detects ranges better). Its box replaces
     this read's own, and only its box can make a "range" skip. Without opts.range (the
     Arbiter's server copy) this read behaves exactly as before. */
  const G0=regimeAt(cd,k,M,fmt), RO=opts.range||null;
  const G = !RO ? G0
          : RO.none ? (G0.box ? Object.assign({},G0,{box:null}) : G0)
          : Object.assign({},G0,{box:{hi:+RO.hi, lo:+RO.lo}}, RO.watching ? {} : {regime:'range', dir:0});
  const td=G.dir, isTr=G.regime==='transition';
  const T=G.regime==='range'?'ranging':G.regime;

  /* where price is, against the Levels tab */
  const tol=A*0.25, lv=(opts.levels||[]).filter(l=>isFinite(l.p));
  const above=lv.filter(l=>l.hi+tol>c&&(l.role==='R'||l.lo>c)).sort((a,b)=>a.p-b.p)[0]||null;
  const below=lv.filter(l=>l.lo-tol<c&&(l.role==='S'||l.hi<c)).sort((a,b)=>b.p-a.p)[0]||null;
  const near=l=>l&&Math.abs(c-l.p)/pip<=Math.max(8,A/pip*0.6);
  const atSup=near(below)?below:null, atRes=near(above)?above:null;
  const roomUp=above?Math.max(0,(above.lo-c)/pip):null, roomDn=below?Math.max(0,(c-below.hi)/pip):null;
  const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
  const where=(l,s)=>l?cap(l.tier)+' '+s+' '+fmt(l.p):null;
  const loc = atSup&&atRes ? 'Price is between '+where(atSup,'support')+' and '+where(atRes,'resistance')
            : atSup ? 'Price is AT '+where(atSup,'support') : atRes ? 'Price is AT '+where(atRes,'resistance')
            : 'Price is between levels — '+(below?where(below,'support')+' below':'no support named')+', '+(above?where(above,'resistance')+' above':'no resistance named');

  /* the range box */
  const bx=G.box, edge=bx?(c-bx.lo)/(bx.hi-bx.lo):null;
  const band=bx?(bx.hi-bx.lo)*0.15:0;
  const brk=bx?((cd[k].c>bx.hi+band&&cd[k-1].c>bx.hi+band)?'up':(cd[k].c<bx.lo-band&&cd[k-1].c<bx.lo-band)?'down':null):null;
  const zone=bx?(brk?'outside':edge<=0.25?'bottom':edge>=0.75?'top':'middle'):null;

  /* the trigger: the Combined Read's lead, 70%+, on the last two bars */
  const t=opts.trig||{};
  const sig = t.any && t.lead && (t.barsAgo==null||t.barsAgo<=2) && +t.lead.conf>=70 ? {name:t.lead.name, conf:+t.lead.conf, d:t.lead.dir==='up'?1:-1} : null;
  const sd=sig?sig.d:0, side=sd>0?'BUY':'SELL';
  const lvl = sd>0?atSup:sd<0?atRes:null;              /* a level defending this trade */

  const BK=breakAt(cd,k,lv,G.box,(atSup||atRes)?(atSup||atRes).p:null);
  const bkName=BK?(BK.L.tier==='range'?'the range '+(BK.d>0?'top':'bottom'):BK.L.tier+' level')+' '+fmt(BK.L.p):'';
  const old = x=> x.from==='range'?'range':x.from+'trend';

  let head, sub, tone, kind='';
  if(!sig && BK){
    head='Break confirmed — '+bkName+' broken '+(BK.d>0?'up':'down'); tone=BK.d>0?'up':'dn';
    sub=(BK.how==='long'?'One long candle closed through it':'Two closes beyond it')+(BK.retest?' and a retest that held':'')+'. '+
        (td&&BK.d!==td?'It is against the '+(isTr?'new direction':T)+' — wait for the labels to turn before joining it.'
                      :'Join it on a 70%+ '+(BK.d>0?'bullish':'bearish')+' pattern'+(BK.retest?'.':', ideally after price comes back to test '+fmt(BK.L.p)+'.'));
  } else if(!sig){
    head='Wait — no trigger'; tone='mut'; sub='No 70%+ pattern on the last two bars.';
    if(atSup&&td>=0) sub+=' Price is at '+atSup.tier+' support '+fmt(atSup.p)+' — watch for a bullish reversal here.';
    else if(atRes&&td<=0) sub+=' Price is at '+atRes.tier+' resistance '+fmt(atRes.p)+' — watch for a bearish reversal here.';
  } else {
    kind = (T==='ranging'&&(zone==='top'||zone==='bottom')) ? 'Reversal at the range '+zone+(lvl?' and '+lvl.tier+' '+(sd>0?'support':'resistance')+' '+fmt(lvl.p):'')
         : lvl ? 'Reversal at '+lvl.tier+' '+(sd>0?'support':'resistance')+' '+fmt(lvl.p) : 'Continuation (not at a level)';
    if(td && sd!==td){ head='Skip — '+sig.name+(isTr?' is against the new direction':' is against the '+T); tone='dn';
      sub = isTr ? 'The '+old(G.last)+' broke '+G.barsIn+' bar'+(G.barsIn===1?'':'s')+' ago ('+G.last.how+'). Do not trade back into it until the labels repair it.'
                 : 'A '+sig.name+' ('+sig.conf+'%) fired, but the market is in a '+T+'. Trading '+side.toLowerCase()+'s against the trend is what this read protects you from.'; }
    else if(BK && BK.d===sd){ head=side+' — continuation · '+sig.name+' '+sig.conf+'%'; tone=sd>0?'up':'dn'; kind='continuation';
      sub='Price broke '+bkName+(BK.how==='long'?' with one long candle':' with two closes beyond it')+(BK.retest?', came back to test it and held':'')+
          ', and the '+sig.name+' confirms the move is carrying on. The broken level is now '+(sd>0?'support':'resistance')+' behind the trade.'; }
    else if((sd>0&&atRes&&!atSup&&roomUp!=null&&roomUp<10)||(sd<0&&atSup&&!atRes&&roomDn!=null&&roomDn<10)){ const L=sd>0?atRes:atSup;
      head='Skip — '+sig.name+' is '+(sd>0?'buying into':'selling into')+' '+L.tier+' '+(sd>0?'resistance':'support'); tone='mut';
      sub='Price is sitting on '+where(L,sd>0?'resistance':'support')+'. Wait for a close through it, or a reversal from it.'; }
    else if(brk && sd!==(brk==='up'?1:-1)){ head='Skip — range just broke '+brk; tone='mut';
      sub='Two closes beyond the range '+(brk==='up'?'top':'bottom')+'. A '+sig.name+' against the break is not a range trade any more.'; }
    else if(T==='ranging' && !brk && (zone==='middle'||(sd>0&&zone==='top')||(sd<0&&zone==='bottom'))){
      head='Skip — '+sig.name+(zone==='middle'?' in the middle of the range':' at the wrong edge'); tone='mut';
      sub='Range '+fmt(bx.lo)+' – '+fmt(bx.hi)+'. Buy near the bottom, sell near the top. Price is '+Math.round(edge*100)+'% of the way up the box.'; }
    else if(!td && T!=='ranging' && !lvl){ head='Skip — '+sig.name+' with no clear trend and no level behind it'; tone='mut';
      sub='Labels are mixed and price is not at support or resistance.'; }
    else { head=side+' — '+sig.name+' '+sig.conf+'%'; tone=sd>0?'up':'dn';
      sub=(isTr?'Early — the '+old(G.last)+' just broke, the new trend is not confirmed yet. ':td?'With the '+T+'. ':'')+kind+'.'; }
  }
  const trade=/^(BUY|SELL)/.test(head);

  /* watch-outs, only on a trade */
  const warn=[];
  const daily=dailyOf(cd,k,ms);
  if(trade){
    const room=sd>0?roomUp:roomDn;
    const maj=lv.find(l=>l.tier==='major'&&(sd>0?(l.role==='S'&&l.hi<c&&(c-l.hi)/pip<30):(l.role==='R'&&l.lo>c&&(l.lo-c)/pip<30)));
    if(room!=null&&room<30) warn.push('Only '+Math.round(room)+' pips to the next '+(sd>0?'resistance':'support')+' — a 30-pip target may not fit.');
    if(maj&&!lvl) warn.push('Major '+(sd>0?'support':'resistance')+' '+fmt(maj.p)+' is inside your 30-pip stop — price is often pulled to a major level before it turns.');
    if((sd>0&&daily==='down')||(sd<0&&daily==='up')) warn.push('Daily trend is '+daily+' — this trade goes against it.');
    const hr=opts.hourOf?opts.hourOf(cd[k]):null; if(hr!=null&&hr>=21) warn.push('Late New York — dead hours, moves are thin.');
  }
  /* reversal watch: rejection wick on the last closed bar */
  const b=cd[k]; let avg=0; for(let i=k-20;i<k;i++) avg+=cd[i].h-cd[i].l; avg/=20;
  const rg=b.h-b.l, rv=[];
  if(rg>avg*1.2 && (Math.min(b.o,b.c)-b.l)/rg>0.55) rv.push('The last candle rejected lower prices (long lower wick).');
  if(rg>avg*1.2 && (b.h-Math.max(b.o,b.c))/rg>0.55) rv.push('The last candle rejected higher prices (long upper wick).');

  const nm={up:'Uptrend',down:'Downtrend',range:'Range',transition:'Transition'};
  return {ok:true, regime:G.regime, trend:T, transition:isTr, dir:td, labels:G.lab, eff:G.eff, box:bx, zone, edge, brk,
          phase:G.hist.map(x=>nm[x.st]).join(' → '), barsIn:G.barsIn, last:G.last,
          waiting: isTr ? (G.last.from==='range'?'range broke '+(G.last.dir>0?'up':'down'):old(G.last)+' broken')+' · waiting for '+(td<0?'LH + LL (downtrend)':'HH + HL (uptrend)')+' or a range' : '',
          loc, above, below, atSup, atRes, sig, brk2:BK, head, sub, tone, trade, kind, warn, daily, rv,
          rec: (trade && opts.rel && !opts.rel.thin && opts.rel.n>=20) ? opts.rel : null};
}

root.BWRead2={read, confirmAt, longBar};
})(typeof window!=='undefined'?window:globalThis);
})();
(function(root){
/* NOT strict: the page's own scripts run in sloppy mode, and an exact copy must too */
function makeFormations(){
  var own = {};
  (function(window, globalThis){
(function(root){
'use strict';

/* MEASURED across four markets, not guessed. At 0.55 there were 59
   "weak merges" — pairs grouped together that barely overlapped, i.e.
   two unrelated structures fused and mislabelled as one. 0.75 cuts that
   to 6 for only 0.27 extra rows on average. Better to occasionally show
   two rows for one structure than to silently fuse two structures. */
const OVERLAP_MIN = 0.75;

/* ── WHEN IS A DETECTED PATTERN NO LONGER VALID? ──────────────────
   The engine had NO expiry of any kind. A Descending Triangle that
   finished 34 bars ago — 5.7 days on H4 — was still being presented as a
   current reading, and a list clogged with old shapes is exactly what
   stops a trader noticing the new one. Three separate tests, because
   "no longer valid" has three different meanings:

   1. ANSWERED   confirmed or failed. The question the shape asked has
                 been settled, so there is nothing left to watch.
   2. LEFT BEHIND  price has travelled beyond the pattern's own range by
                 more than its own height. The shape no longer describes
                 where price IS — measured in pattern-heights so it scales
                 to the pair and the timeframe rather than to a pip count.
   3. STALE      too many bars since it ended, expressed in the pattern's
                 OWN span: a 40-bar formation stays relevant longer than
                 an 8-bar one, so a fixed bar count would be wrong for
                 both. An absolute ceiling stops a very long formation
                 living forever. */
const LEFT_BEHIND_H = 1.0;   /* pattern-heights beyond its own range */
const STALE_SPANS   = 1.5;   /* multiples of the pattern's own span */
const STALE_FLOOR   = 20;    /* never expire sooner than this many bars */
const STALE_CEILING = 60;    /* never keep one longer than this */

function validity(p, cd){
  const n = cd.length;
  if(!n) return {ok:true};
  const px = +cd[n-1].c; if(!isFinite(px)) return {ok:true};
  const barsAgo = (n-1) - p.endI;

  if(p.life.state==='confirmed' || p.life.state==='failed' || p.life.state==='target' || p.life.state==='stalledout')
    return {ok:false, why:'answered', note:p.life.state==='target' ? 'it reached its measured target'
      : p.life.state==='stalledout' ? 'it broke the trigger but never followed through'
      : 'the trigger has already been '+(p.life.state==='confirmed'?'taken':'rejected')};

  /* the shape's own price range, which is the yardstick for both tests */
  let hi=-Infinity, lo=Infinity;
  for(let i=Math.max(0,p.startI); i<=Math.min(n-1,p.endI); i++){
    const h=+cd[i].h, l=+cd[i].l;
    if(h>hi) hi=h; if(l<lo) lo=l;
  }
  const H = hi-lo;
  if(H>0){
    const beyond = px>hi ? (px-hi)/H : px<lo ? (lo-px)/H : 0;
    if(beyond >= LEFT_BEHIND_H)
      return {ok:false, why:'left behind', beyond:+beyond.toFixed(2),
        note:'price has moved '+beyond.toFixed(1)+' times the pattern\u2019s own height beyond it'};
  }

  const span = Math.max(1, p.endI-p.startI);
  const limit = Math.max(STALE_FLOOR, Math.min(STALE_CEILING, Math.round(span*STALE_SPANS)));
  if(barsAgo > limit)
    return {ok:false, why:'stale', barsAgo:barsAgo, limit:limit,
      note:'it finished '+barsAgo+' bars ago and nothing has come of it'};

  return {ok:true, barsAgo:barsAgo};
}
/* Bars counted by bar time. The stored series is capped at 600, so
   cd.length stops moving and cannot measure how long anything held. */
function barTick(st,cd){
  const t=(typeof bwBarMs==='function')?bwBarMs(cd[cd.length-1]):NaN;
  const id=isFinite(t)&&t?t:cd.length;
  if(st._bid!==id){ st._bid=id; st._tick=(st._tick||0)+1; }
  return st._tick;
}
const HOLD_BARS   = 2;      /* a lead change must survive this long */

function span(p){ return Math.max(1, p.endI - p.startI); }
function overlapFrac(a,b){
  const ov = Math.min(a.endI,b.endI) - Math.max(a.startI,b.startI);
  if(ov<=0) return 0;
  return ov / Math.min(span(a), span(b));
}

/* Group detections that describe the same price action. */
function group(pats){
  const groups=[];
  pats.slice().sort((a,b)=>a.startI-b.startI).forEach(p=>{
    const hit = groups.find(g => g.members.some(m => overlapFrac(m,p) >= OVERLAP_MIN));
    if(hit){ hit.members.push(p); hit.startI=Math.min(hit.startI,p.startI); hit.endI=Math.max(hit.endI,p.endI); }
    else groups.push({ members:[p], startI:p.startI, endI:p.endI });
  });
  return groups;
}

/* ── WHICH READING IS PRICE HEADING FOR ───────────────────────────
   Distance to the trigger, signed by whether price is moving TOWARD it.
   A trigger price is only meaningful if price can still reach it from
   where it is — a trigger already passed is not something to head for. */
function leadOf(members, px, drift, pip){
  let best=null;
  members.forEach(m=>{
    if(!Number.isFinite(m.trigger)) return;
    const gap = m.trigger - px;                 /* signed */
    const towards = (drift>0 && gap>0) || (drift<0 && gap<0);
    const dist = Math.abs(gap)/(pip||0.0001);
    /* Heading toward it is worth far more than being near it: a trigger
       behind price is not a thing the market is walking into. */
    const score = (towards ? 0 : 1000) + dist;
    if(!best || score<best.score) best={p:m, score, dist, towards};
  });
  /* Nothing has a usable trigger — fall back to the longest-established
     reading rather than picking arbitrarily. */
  if(!best) return {p:members.slice().sort((a,b)=>span(b)-span(a))[0], dist:null, towards:false};
  return best;
}

/* State per formation, so a lead change can be required to HOLD and a
   rename can be remembered rather than re-announced every bar. */
const STATE={};
function keyFor(g){ return 'f'+g.startI; }

function read(pats, cd, opts){
  opts=opts||{};
  /* Expire BEFORE grouping, so a dead shape cannot drag a live formation
     into its own group and take the lead with a reading nobody should be
     acting on. */
  const expired=[];
  pats = (pats||[]).filter(function(p){
    const v = validity(p, cd);
    if(!v.ok){ expired.push({pattern:p, why:v.why, note:v.note}); return false; }
    return true;
  });
  const pip = opts.pip || 0.0001;
  const px  = cd.length ? (+cd[cd.length-1].c || +cd[cd.length-1].close) : 0;
  /* Direction over the last few bars — which way price is walking. */
  const back = cd.length>6 ? (+cd[cd.length-6].c || +cd[cd.length-6].close) : px;
  const drift = px - back;

  const out = group(pats).map(g=>{
    const k = keyFor(g);
    const st = STATE[k] || (STATE[k] = {leadKey:null, pending:null, pendingSince:0, history:[]});
    const cand = leadOf(g.members, px, drift, pip);
    const candKey = cand.p.key || cand.p.name;

    /* A lead change must survive HOLD_BARS. Without this the row
       flickers between names exactly as the raw engine output does. */
    const tick = barTick(st, cd);
    if(st.leadKey === null){ st.leadKey = candKey; st.history.push({name:cand.p.name, at:tick}); }
    else if(candKey !== st.leadKey){
      if(st.pending !== candKey){ st.pending = candKey; st.pendingSince = tick; }
      else if(tick - st.pendingSince >= HOLD_BARS){
        st.leadKey = candKey; st.pending = null;
        const lastName = st.history[st.history.length-1];
        if(!lastName || lastName.name !== cand.p.name){
          st.history.push({name:cand.p.name, at:tick});
        }
      }
    } else { st.pending = null; }

    const lead = g.members.find(m => (m.key||m.name) === st.leadKey) || cand.p;
    const others = g.members.filter(m => m !== lead);

    return {
      key:k, startI:g.startI, endI:g.endI,
      lead, others, members:g.members,
      /* The formation resolves when its LEAD resolves — one lifecycle,
         not one per reading. */
      state: lead.life.state,
      resolved: lead.life.state==='confirmed' || lead.life.state==='failed' || lead.life.state==='target' || lead.life.state==='stalledout',
      headingFor: cand.towards ? Math.round(cand.dist) : null,
      renamed: st.history.length>1,
      history: st.history.slice(),
      alsoReads: others.map(o=>o.name)
    };
  });
  out.expired = expired;
  return out;
}

function reset(){ Object.keys(STATE).forEach(k=>delete STATE[k]); }

root.BWFormations={read, group, overlapFrac, validity, reset, OVERLAP_MIN, HOLD_BARS,
  LEFT_BEHIND_H, STALE_SPANS, STALE_FLOOR, STALE_CEILING};
})(typeof window!=='undefined'?window:globalThis);
  })(own, own);
  return own.BWFormations;
}
function create(opts){
  /* ── the page's STATE, supplied by Arbiter ── */
  var SERIES = {}, DATA = {}, RISK = {}, OPEN = [], brokerSym = {}, PAIRS = [];
  var CPV = {cd:[], pats:[], sel:null, animFrom:0, key:null};
  var CONF_ALERTS = {rows:[], at:0, busy:false, fails:0, downSince:0, gapMs:0, ok:true};
  var BASE = root.location ? root.location.origin : '';
  var pair = '', tf = 'H1', captured = null;
  var STUB = { innerHTML:'', textContent:'' };
  var $ = function(){ return STUB; };                       /* no DOM is drawn — the calculation only */
  var formationsByPair = {};
  var winFor = function(p){                                   /* real engines, this pair's own formations */
    var w = Object.create(root);
    w.BWFormations = formationsByPair[p] || (formationsByPair[p] = makeFormations());
    return w;
  };
  /* PRIVATE storage for the Combined Read's own channel; every other key reads the real storage.
     publishConfluence writes here and NEVER to the real bw-confluence-now. */
  var PRIVATE = {};
  /* BOTH channels the copied code writes are kept PRIVATE: Arbiter must never
     overwrite what the Pattern Detector publishes */
  var OWN = { 'bw-confluence-now': 1, 'bw-formations-now': 1 };
  var localStorage = {
    getItem: function(k){ return OWN[k] ? (PRIVATE[k] || null) : root.localStorage.getItem(k); },
    setItem: function(k, v){ if (OWN[k]) PRIVATE[k] = String(v); },
    removeItem: function(k){ if (OWN[k]) delete PRIVATE[k]; }
  };
  var fetch = (opts && opts.fetch) || (root.fetch ? root.fetch.bind(root) : null);
  var location = root.location;

  /* ── page functions, VERBATIM ── */
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

function bwBarHourUTC(c){ const t=bwBarMs(c); return isFinite(t)&&t?new Date(t).getUTCHours():null; }

function feedOk(id,ok){ const e=$(id); if(e){ e.textContent=ok?'ok':'unreachable'; e.style.color=ok?'':'var(--red)'; } }

let RELLOGRAW=[];

function relJudge(x){ return (x.tf==='H4'||x.tf==='D1') ? x.h4 : x.h1; }

function bwDG(){ try{ return (typeof pair!=='undefined' && pair) ? digitsOf(pair) : 5; }catch(e){ return 5; } }

function cpFastOk(p, cd){
  try{
    if(!window.BWBreakConfirm) return false;
    let liq=null;
    try{
      const raw=JSON.parse(localStorage.getItem('bw-liquidity-now')||'null');
      if(raw && raw.pairs && (Date.now()-(+raw.t||0))<RISK_FRESH_MS){
        const hit = raw.pairs[brokerSym[pair]||pair] || raw.pairs[pair] ||
                    raw.pairs[Object.keys(raw.pairs).find(k=>prettyPair(k)===pair)||''];
        if(hit && hit.tf===tf) liq=hit;
      }
    }catch(e){}
    if(!liq && window.BWLiquidity){ try{ liq=BWLiquidity.liqRead(cd, tf); }catch(e){} }
    const rr = RISK[pair] || null;
    const radarIn = rr ? {level:{key:String(rr.name||'').toLowerCase().replace(/\s+/g,'')}, score:rr.score,
                          factors:(rr.factors||[]).map(x=>({label:x})), vol:rr.vol||[]} : null;
    const last = cd.length ? cd[cd.length-1] : null;
    const openMs = last ? ((+last.t||+last.time||0) < 1e12 ? (+last.t||+last.time||0)*1000 : (+last.t||+last.time||0)) : null;
    const r = BWBreakConfirm.decide({pattern:p, cd:cd, tf:tf, liquidity:BWBreakConfirm.fromLiquidity(liq)||{},
      radar:BWBreakConfirm.fromRadar(radarIn), barOpenMs:openMs, pip:(window.BWRange?BWRange.pipOf(brokerSym[pair]||pair):0.0001)});
    return !!(r && r.gates && r.gates.allTrue);
  }catch(e){ return false; }
}

function cfChip(cls, txt){ return '<span class="cf-chip '+cls+'">'+txt+'</span>'; }

function cfRsiSeries(cd){
  const out = new Array(cd.length).fill(null), n = 14;
  if(cd.length <= n) return out;
  let g=0, l=0;
  for(let i=1;i<=n;i++){ const d=cd[i].c-cd[i-1].c; if(d>=0) g+=d; else l-=d; }
  g/=n; l/=n; out[n] = 100-100/(1+g/Math.max(1e-12,l));
  for(let i=n+1;i<cd.length;i++){ const d=cd[i].c-cd[i-1].c;
    g=(g*(n-1)+Math.max(d,0))/n; l=(l*(n-1)+Math.max(-d,0))/n; out[i]=100-100/(1+g/Math.max(1e-12,l)); }
  return out;
}

const P_CCY  = ['USD','EUR','GBP','JPY','CHF','AUD','NZD','CAD','SEK','NOK','DKK',
                'SGD','HKD','ZAR','MXN','TRY','PLN','CZK','HUF','CNH','THB','INR'];

const P_BASE = P_CCY.concat(['XAU','XAG','XPT','XPD','BTC','ETH','LTC','XRP','SOL','BNB']);

function prettyPair(sym){
  if (!sym) return '';
  const up = String(sym).toUpperCase().replace(/[._-]/g,'');
  for (let cut=0; cut<=3 && up.length-cut>=6; cut++){
    const cand = up.slice(0, up.length-cut);
    if (cand.length!==6) continue;
    if (P_BASE.includes(cand.slice(0,3)) && P_CCY.includes(cand.slice(3,6))) return cand;
  }
  return up;
}

const RISK_FRESH_MS=180000;

function loadRisk(){
  Object.keys(RISK).forEach(k=>delete RISK[k]);
  try{
    const n=JSON.parse(localStorage.getItem('bw-risk-now')||'null');
    if(n&&n.pairs&&(Date.now()-(+n.t||0))<RISK_FRESH_MS){
      Object.keys(n.pairs).forEach(k=>{
        const p=n.pairs[k];
        /* The Assistant has been publishing `factors` all along — the top
           two reasons the radar is flagged — and this reader was
           dropping them on the floor. I had assumed they were missing
           and was about to add them upstream; they were already there.
           Check what the producer sends before changing the producer. */
        RISK[prettyPair(k)]={name:p.name||p.level,score:p.score,level:String(p.level||'').toLowerCase(),
                             factors:p.factors||[],vol:Array.isArray(p.vol)?p.vol:[],fresh:true,t:+n.t||0};
      });
    }
  }catch(e){}
}

async function jget(url){
  /* A hung request used to hold its cycle forever. 12 s, then give up. */
  const ac=(typeof AbortController!=='undefined')?new AbortController():null;
  const to=ac?setTimeout(()=>ac.abort(),12000):null;
  try{
    const r=await fetch(BASE+url,{credentials:'same-origin',signal:ac?ac.signal:undefined});
    if(!r.ok) throw new Error(r.status);
    return await r.json();
  } finally { if(to) clearTimeout(to); }
}

function normOpen(t){
  const sym=String(t.symbol||'').toUpperCase();
  const base=prettyPair(sym);
  if(!base) return null;
  const pip=/JPY$/.test(base)?0.01:/^XAU/.test(base)?0.1:/^XAG/.test(base)?0.01:
            /^BTC|^ETH/.test(base)?1:0.0001;
  const pipVal=/^XAG/.test(base)?50:/JPY$/.test(base)?6.7:/^BTC|^ETH/.test(base)?1:10;
  const entry=parseFloat(t.openPrice??t.open_price??t.entry??0);
  const lots=Math.abs(parseFloat(t.volume??t.lots??0));
  const profit=parseFloat(t.profit??0);
  if(!entry||!lots) return null;
  const dir=String(t.type||'buy').toLowerCase().indexOf('sell')>=0?-1:1;
  let price=parseFloat(t.current_price??t.currentPrice??NaN);
  if(!isFinite(price)||!price){
    const perUnit=lots*(pipVal/pip);
    price=perUnit>0?entry+dir*(profit/perUnit):entry;
  }
  return {ticket:t.ticket??t.id??null,sym:base,type:dir>0?'buy':'sell',lots,entry,price,
          sl:parseFloat(t.sl??0),tp:parseFloat(t.tp??0),pip,pipVal,pl:profit,
          openMs:(function(){ const v=t.openTime??t.open_time??t.time; if(v==null||v==='') return null; const d=bwDate(v); return isFinite(+d)?+d:null; })()};
}

function bwBarMs(c){
  const v=c&&(c.t!=null?c.t:(c.time!=null?c.time:c.timestamp));
  if(v==null||v==='') return NaN;
  if(typeof v==='number'||/^\d+(\.\d+)?$/.test(String(v))){ const n=+v; return n<1e12?n*1000:n; }
  const d=(typeof bwDate==='function')?bwDate(v):new Date(v);
  return +d;
}

async function loadPair(b,t){
  const sym=brokerSym[b]||b;
  DATA[b]=DATA[b]||{}; SERIES[b]=SERIES[b]||{};
  /* THE TWO REQUESTS DO NOT DEPEND ON EACH OTHER, so awaiting them one
     after the other doubled the wait on every pair switch for no reason.
     Fire both and wait once. On a 150 ms link that is 300 ms saved per
     switch, which is most of the lag that was being felt. */
  const [pRes,cRes]=await Promise.all([
    jget('/api/patterns?symbol='+encodeURIComponent(sym)+'&tf='+t).catch(()=>null),
    jget('/api/candles?symbol='+encodeURIComponent(sym)).catch(()=>null)
  ]);
  /* Both failed: the feed is down. Say so — the errors were swallowed
     above, so the Live dot stayed green with the cable pulled. */
  if(!pRes && !cRes) throw new Error('feed unreachable');
  if(pRes) DATA[b][t]=pRes; else DATA[b][t]=DATA[b][t]||{};
  if(cRes){
    /* ── MERGE, DO NOT REPLACE ───────────────────────────────────────
       This overwrote the stored series with whatever the poll returned.
       When a poll came back SHORT — a partial payload, a pair the EA has
       only just started sending, a bundle missing one timeframe — the
       history collapsed from 300 bars to a few dozen. The chart then
       showed `min(n, 110/scale)` bars, so the window appeared to ZOOM
       ITSELF from 110 to 50, and the structure engine lost the history it
       needs for pivots, so the HH/HL/LH/LL/EQ labels vanished with it.
       Both symptoms, one cause. It "came back on its own" because the
       next full poll restored the array.
       Merging by bar time keeps the deepest history seen, updates the
       bar still forming, and appends genuinely new ones. */
    const byTf=cRes.candlesByTF||{};
    SERIES[b].H1=mergeSeries(SERIES[b].H1, byTf.H1||cRes.candles||[]);
    SERIES[b].H4=mergeSeries(SERIES[b].H4, byTf.H4||[]);
  }
}

const SERIES_CAP=600;

function mergeSeries(prev, next){
  prev=Array.isArray(prev)?prev:[];
  next=Array.isArray(next)?next:[];
  if(!next.length) return prev;              // nothing new: keep what we have
  if(!prev.length) return next.slice(-SERIES_CAP);
  const byT=new Map();
  const keyOf=c=>{ const t=bwBarMs(c); return isFinite(t)?t:0; };   /* text times no longer collapse to one key */
  prev.forEach(c=>byT.set(keyOf(c), c));
  next.forEach(c=>byT.set(keyOf(c), c));     // newer wins for the same bar
  return Array.from(byT.keys()).sort((x,y)=>x-y).map(k=>byT.get(k)).slice(-SERIES_CAP);
}

const D=()=>((DATA[pair]||{})[tf])||{};

function pipOf(p){ return /JPY/.test(p)?0.01:/^XAU/.test(p)?0.1:/^XAG/.test(p)?0.01:/^(BTC|ETH)/.test(p)?1:0.0001; }

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

function loadConfAlerts(force){
  if(CONF_ALERTS.busy) return;
  var wait = CONF_ALERTS.ok ? 60000 : 8000;
  if(!force && Date.now() - CONF_ALERTS.at < wait) return;
  CONF_ALERTS.busy = true;
  Promise.resolve()
    .then(function(){ return (typeof jget === 'function') ? jget('/api/alerts') : null; })
    .then(function(d){
      var rows = Array.isArray(d) ? d : (d && Array.isArray(d.alerts) ? d.alerts : []);
      CONF_ALERTS.rows = rows || [];
      CONF_ALERTS.at = Date.now();
      if(!CONF_ALERTS.ok && CONF_ALERTS.downSince){
        /* recovered — remember the window so nothing inside it is lost */
        CONF_ALERTS.gapMs = Date.now() - CONF_ALERTS.downSince;
        CONF_ALERTS.recoveredAt = Date.now();
      }
      CONF_ALERTS.ok = true; CONF_ALERTS.fails = 0; CONF_ALERTS.downSince = 0;
    })
    .catch(function(){
      CONF_ALERTS.fails++;
      if(CONF_ALERTS.ok) CONF_ALERTS.downSince = Date.now();
      CONF_ALERTS.ok = false;
      CONF_ALERTS.at = Date.now();   /* short back-off, not a full cooldown */
    })
    .then(function(){ CONF_ALERTS.busy = false; });
}

function confFeedGap(cd, tf){
  if(!cd || cd.length < 6) return null;
  var step = ({M15:15,M30:30,H1:60,H4:240}[tf] || 60) * 60;
  /* tolerant, because this is also useful on raw SERIES rows */
  var T = function(b){ var v = bwBarMs(b); return isFinite(v) && v ? v/1000 : 0; };   /* text times read too */
  var worst = null;
  for(var i=cd.length-1; i>0 && i>cd.length-160; i--){
    var d = T(cd[i]) - T(cd[i-1]);
    if(d <= step*1.8) continue;
    /* Skip only gaps that actually COVER the weekend. Keying on the
       previous bar's weekday hid genuine Friday outages. */
    var mid = new Date(((T(cd[i-1]) + T(cd[i]))/2)*1000).getUTCDay();
    if(mid===6 || mid===0 || d > 36*3600) continue;
    if(!worst || d > worst.secs) worst = {secs:d, at:i, missed:Math.round(d/step)-1};
  }
  if(!worst) return null;
  return {barsMissed:worst.missed, minutes:Math.round(worst.secs/60),
          endedBarsAgo: cd.length-1-worst.at,
          from:T(cd[worst.at-1]), to:T(cd[worst.at])};
}

function publishFormations(forms, cd){
  try{
    var store = {};
    try{ store = JSON.parse(localStorage.getItem('bw-formations-now')||'{}') || {}; }catch(e){ store = {}; }
    if(!store.reads || typeof store.reads !== 'object') store.reads = {};
    var now = Date.now();
    Object.keys(store.reads).forEach(function(k){                // drop anything not refreshed in 30 minutes
      if(!store.reads[k] || now - (+store.reads[k].t||0) > 30*60000) delete store.reads[k];
    });
    var last = cd && cd.length ? cd[cd.length-1] : null;
    var pip = (window.BWRange ? window.BWRange.pipOf(brokerSym[pair]||pair) : 0.0001);
    var items = (forms||[]).map(function(f){
      var L = f && f.lead; if(!L || !L.life) return null;
      var st = L.life.state;
      /* stalled = held past candle 3 without following through; the old engine dropped a
         held break from here after 3 bars too, so the Arbiter sees the same window as before */
      if(st==='failed' || st==='invalidated' || st==='target' || st==='stalledout' || st==='stalled') return null;
      if(st==='confirmed' && (L.life.barsSince||0) > 3) return null;
      var dir = (L.effectiveDir!=null ? L.effectiveDir : L.dir);
      return { name: L.name, key: L.key || null, dir: dir > 0 ? 'bullish' : 'bearish',
               state: st, completion: L.completion!=null ? L.completion : null,
               trigger: isFinite(+L.trigger) ? +(+L.trigger).toFixed(6) : null,
               target:  isFinite(+L.target)  ? +(+L.target).toFixed(6)  : null,
               invalid: isFinite(+L.invalid) ? +(+L.invalid).toFixed(6) : null,
               barsSince: L.life.barsSince!=null ? L.life.barsSince : null,
               alsoReads: f.alsoReads || [] };
    }).filter(Boolean);
    store.reads[pair + '|' + tf] = { symbol: pair, timeframe: tf, t: now, pip: pip,
      barT: last ? (+last.t||0) : 0, price: last ? (+last.c||+last.close||null) : null, items: items };
    store.t = now;
    localStorage.setItem('bw-formations-now', JSON.stringify(store));
    try{ if(typeof publishPatternAlert==='function') publishPatternAlert(); }catch(e){}
  }catch(e){ /* storage full or disabled — never let this break the chart tab */ }
}

function publishConfluence(o, cd, PRx){   /* PRx: the pressure reading, passed in so a copy run elsewhere (Arbiter) reads its own */
  try{
    if(!o || !o.ok) return;
    var last = cd && cd.length ? cd[cd.length-1] : null;
    var store = {};
    try{ store = JSON.parse(localStorage.getItem('bw-confluence-now')||'{}') || {}; }catch(e){ store = {}; }
    if(!store.reads || typeof store.reads !== 'object') store.reads = {};

    var f = o.frame || {}, p = o.pres || {}, pm = o.perm || {}, tr = o.trust || {};
    var key = pair + '|' + tf;

    store.reads[key] = {
      symbol: pair, timeframe: tf,
      barT: last ? (Math.round((bwBarMs(last)||0)/1000)) : 0,   /* the bar this read describes, in seconds; text times too */
      at: Date.now(),                         /* when THIS pair was last read — store.t moves for any pair */
      /* the headline, in the words on screen */
      state: o.state, word: o.word, line: o.line,
      /* the frame */
      trend: f.dir || null, trendConf: f.conf!=null ? +f.conf.toFixed(2) : null,
      labels: (f.last4||[]).join(' ') || null,
      decides: f.decider ? {name:f.decider.name, price:+f.decider.p.toFixed(6),
                            broken:!!f.broken} : null,
      /* the structural event, which is what the Brain most needs */
      pressure: p.known ? {state:p.state, score:p.score, pipsAway:+(p.pipsAway||0).toFixed(1),
                           run:p.run, tests:p.tests} : null,
      reversal: (o.aft && o.aft.known) ? {stage:o.aft.state, from:o.aft.oldDir, to:o.aft.newDir,
                           level:+o.aft.level.toFixed(6), barsSince:o.aft.since,
                           phase:(o.ph&&o.ph.known)?o.ph.phase:null,
                           givenBackPct:(o.ph&&o.ph.known)?Math.round(o.ph.retracePct):null} : null,
      /* the trigger and where it came from */
      trigger: (o.trig && o.trig.any) ? {name:o.trig.lead.name, dir:o.trig.lead.dir,
                           conf:o.trig.lead.conf, barsAgo:o.trig.barsAgo,
                           source:o.trig.source, alerted:!!o.trig.lead.hasRaised} : null,
      /* the directionless readings */
      participation: {state:pm.state||null, pct:pm.volPct!=null?pm.volPct:null,
                      pctile:pm.pctile!=null?pm.pctile:null, session:pm.sessions||null},
      risk: tr.risk!=null ? tr.risk : null,
      higher: (o.htf && o.htf.known) ? {tf:o.htf.label, dir:o.htf.dir, weight:o.htf.mult} : null,
      support: o.support!=null ? +o.support.toFixed(2) : null,
      /* REVERSAL PRESSURE — the early warning at a major / medium level,
         scored 0-100, in the words on screen. Not a forecast. */
      reversalPressure: (function(P){
        if(!P || !P.level || P.state==='idle' || P.state==='nolevels') return null;
        var F = P.F || function(v){ return (+v).toFixed(bwDG()); };
        return {state:P.state, score:P.score, on:P.trendWord,
                level:{tier:P.level.tier, side:P.bear?'resistance':'support', price:+(+P.level.p).toFixed(6), holds:P.level.prob},
                alert: P.hasAlert ? {name:P.ev.name, conf:P.ev.conf, source:P.ev.src, bothSources:!!P.both} : null, barsSinceTouch:P.after,
                turnedBackBars:+(Math.floor(Math.max(0,P.best||0)*10)/10).toFixed(1), rsiWithTurn:!!(P.rows||[]).find(function(r){return r.lbl==='RSI turning'&&r.on;}), h4Agrees:!!P.h4, likelyNews:!!P.big,
                earlyLine: P.EL!=null ? {name:P.bear?'HL':'LH', price:+(+P.EL).toFixed(6), closesBeyond:P.eBeyond, confirmed:P.state==='early'} : null,
                officialLine: P.HL!=null ? {name:P.bear?'HL':'LH', price:+(+P.HL).toFixed(6), closesBeyond:P.beyond,
                              confirmed:P.state==='confirmed'} : null,
                points:(P.rows||[]).filter(function(r){return r.pts;}).map(function(r){return r.lbl+' '+(r.pts>0?'+':'')+r.pts;})};
      })((function(P){ return P && P.__key===pair+'|'+tf ? P : null; })(PRx || window.__cfPressure)),
      /* the reasoning, capped */
      supports: (o.supports||[]).slice(0,4),
      against:  (o.contradictions||[]).slice(0,4),
      weakens:  (o.weakens||[]).slice(0,3),
      /* honesty the reader must carry through */
      suspended: !!o.suspended,
      feed: o.feed ? {ok:o.feed.ok!==false,
                      gapBars:(o.feed.gap&&o.feed.gap.barsMissed)||0,
                      missed:(o.feed.missed||[]).length} : null,
      caveat: 'These readings sort evidence; on ten years of data the aligned state showed no ' +
              'measured edge over conflicted for what price did next. Describe, do not predict.'
    };
    /* Drop pairs not read for 6 hours, so a reader never takes a
       days-old read as current just because store.t is fresh. */
    Object.keys(store.reads).forEach(function(k){ var r=store.reads[k]; if(!r || !r.at || Date.now()-r.at > 6*3600000) delete store.reads[k]; });
    store.t = Date.now();
    store.v = 1;
    localStorage.setItem('bw-confluence-now', JSON.stringify(store));
  }catch(e){ /* storage full or disabled — never let this break the tab */ }
}

const CF_RSI_HIST = {};

function cfRsi(o, cd, pair, tf){
  const res = {html:'', sup:[], con:[], wk:[], v:null, ready:false, delta:0, tag:null, R:null, div:null, story:''};
  try{
    const d = D() || {};
    let v = parseFloat(d.rsi), src = 'MT5 value';
    const closed = cd.slice(0, -1), R = cfRsiSeries(closed);
    if(!isFinite(v) || v < 0 || v > 100){ v = R[R.length-1]; src = 'from the candles'; }
    if(!isFinite(v)) return res;
    res.v = v; res.R = R;

    /* the Assistant's live direction rule */
    const key = pair+'|'+tf, now = Date.now();
    const h = CF_RSI_HIST[key] || (CF_RSI_HIST[key] = []);
    if(!h.length || Math.abs(h[h.length-1].v - v) > 0.01) h.push({v:v, t:now});
    while(h.length && now - h[0].t > 210000) h.shift();
    if(h.length > 240) h.shift();
    let base = null;
    for(let i=0;i<h.length;i++){ if(now - h[i].t <= 180000){ base = h[i]; break; } }
    const ready = !!(base && base !== h[h.length-1] && now - base.t >= 20000);
    const delta = ready ? v - base.v : 0, span = ready ? now - base.t : 0;
    const tag = !ready ? null : delta > 0.3 ? 'Rising' : delta < -0.3 ? 'Falling' : 'Flat';
    res.ready = ready; res.delta = delta; res.tag = tag;
    res.story = 'RSI '+v.toFixed(0)+(tag ? ' and '+tag.toLowerCase() : '')+
      ' — nothing in momentum backs or works against the move at the level right now. A line appears here the moment it does.';

    /* the meter row */
    const chip = !ready ? cfChip('flat', v>=70?'Overbought':v<=30?'Oversold':'Neutral')
               : cfChip(tag==='Rising'?'up':tag==='Falling'?'dn':'flat', tag);
    const mins = Math.round(span/60000), secs = Math.round(span/1000);
    const spTxt = mins >= 1 ? mins+' min' : secs+'s';
    const dTxt = !ready ? 'direction settling — needs a few seconds on '+tf
               : Math.abs(delta) < 0.05 ? 'holding this level for '+spTxt+' on '+tf
               : (delta>0?'+':'')+delta.toFixed(1)+' over '+spTxt+' on '+tf;
    let m = '<div class="rsi-track">'+
      '<div class="rsi-zone" style="left:0;width:30%;background:var(--green);opacity:.10"></div>'+
      '<div class="rsi-zone" style="left:70%;width:30%;background:var(--red);opacity:.10"></div>';
    [30,50,70].forEach(function(t){ m += '<div class="rsi-zone" style="left:'+t+'%;width:1px;background:var(--border2)"></div>'; });
    if(ready && Math.abs(delta) > 0.05) m += '<div class="rsi-prev" style="left:'+Math.max(0,Math.min(100,base.v))+'%"></div>';
    m += '<div class="rsi-mark" style="left:'+Math.max(0,Math.min(100,v))+'%"></div></div>'+
         '<div class="rsi-scale"><span>0</span><span>30</span><span>50</span><span>70</span><span>100</span></div>';
    res.html = '<div class="cf-cls"><div class="cf-h"><span class="cf-n">Momentum</span>'+
      '<span class="cf-r">RSI 14 · '+src+'</span>'+chip+'</div>'+
      '<div class="cf-b"><div style="display:flex;align-items:baseline;gap:10px;margin:6px 0 8px">'+
      '<span class="cf-rsi-v">'+v.toFixed(1)+'</span><span class="cf-r">'+dTxt+'</span></div>'+m+'</div></div>';

    /* the plain-language lines */
    const f = o.frame || {};
    if(!o.ok || !f.ok || (f.dir !== 'up' && f.dir !== 'down')) return res;
    const up = f.dir === 'up', V = v.toFixed(0);
    const lvl = (f.decider && f.decider.name) || (up ? 'higher low' : 'lower high');
    const pushers = up ? 'sellers' : 'buyers';
    const withPush = ready && (up ? delta < -0.3 : delta > 0.3);
    const againstPush = ready && (up ? delta > 0.3 : delta < -0.3);
    const pushSide = up ? v < 50 : v > 50;

    if(o.state === 'pressing'){
      /* divergence: last two closed swing lows (highs in a downtrend) within 30 bars */
      const sw = [];
      for(let i=2;i<closed.length-1;i++){
        const c = closed[i];
        const isS = up ? (c.l<closed[i-1].l && c.l<closed[i-2].l && c.l<=closed[i+1].l)
                       : (c.h>closed[i-1].h && c.h>closed[i-2].h && c.h>=closed[i+1].h);
        if(isS && i >= closed.length-30) sw.push(i);
      }
      if(sw.length >= 2){
        const a = sw[sw.length-2], b = sw[sw.length-1], dg = /JPY/i.test(pair) ? 3 : 5;
        if(R[a] != null && R[b] != null){
          if((up && closed[b].l < closed[a].l && R[b]-R[a] >= 3) || (!up && closed[b].h > closed[a].h && R[a]-R[b] >= 3))
            res.div = {a:a, b:b, pa: up?closed[a].l:closed[a].h, pb: up?closed[b].l:closed[b].h, ra:R[a], rb:R[b]};
          if(up && closed[b].l < closed[a].l && R[b]-R[a] >= 3)
            res.con.push('Price made a lower low ('+closed[a].l.toFixed(dg)+' → '+closed[b].l.toFixed(dg)+') but RSI made a higher low ('+R[a].toFixed(0)+' → '+R[b].toFixed(0)+') — the second drop had less force. <b>The level will probably hold.</b>');
          if(!up && closed[b].h > closed[a].h && R[a]-R[b] >= 3)
            res.con.push('Price made a higher high ('+closed[a].h.toFixed(dg)+' → '+closed[b].h.toFixed(dg)+') but RSI made a lower high ('+R[a].toFixed(0)+' → '+R[b].toFixed(0)+') — the second push had less force. <b>The level will probably hold.</b>');
        }
      }
      if(withPush && pushSide)
        res.sup.push('RSI '+V+' and still '+(up?'falling':'rising')+' as price presses the '+lvl+' — '+pushers+' still have force. <b>The break is likely.</b>');
      else if(againstPush)
        res.con.push('Price is still pressing the '+lvl+', but RSI has started '+(up?'rising':'falling')+' ('+V+') — '+pushers+' are running out of force. <b>The level will probably hold.</b>');
    }
    if(o.state === 'breaking'){
      if(withPush)
        res.sup.push('Price closed '+(up?'below':'above')+' the '+lvl+' once and RSI ('+V+') is still '+(up?'falling':'rising')+' — '+pushers+' are still pushing. <b>The second close is likely.</b>');
      else if(againstPush)
        res.wk.push('Price closed '+(up?'below':'above')+' the '+lvl+' once, but RSI has already turned back '+(up?'up':'down')+' ('+(delta>0?'+':'')+delta.toFixed(1)+') — '+pushers+' are losing force. <b>This break may fail.</b>');
    }
    /* a reversal trigger as RSI turns its way out of the 30/70 zone */
    const tr = o.trig;
    if(tr && tr.any && tr.lead && tr.barsAgo <= 3 && ready){
      const lows = R.slice(-6).filter(function(x){ return x != null; });
      if(lows.length){
        if(tr.lead.dir === 'up' && delta > 0.3 && Math.min.apply(null, lows) <= 35)
          res.sup.push(tr.lead.name+' fired just as RSI climbed out of the low zone ('+Math.min.apply(null,lows).toFixed(0)+' → '+V+') — <b>the buy signal and momentum agree.</b>');
        if(tr.lead.dir === 'down' && delta < -0.3 && Math.max.apply(null, lows) >= 65)
          res.sup.push(tr.lead.name+' fired just as RSI dropped out of the high zone ('+Math.max.apply(null,lows).toFixed(0)+' → '+V+') — <b>the sell signal and momentum agree.</b>');
      }
    }
    /* after a reversal: a pullback that stalls on its side of 50 */
    if(f.flipped && o.state === 'quiet'){
      if(!up && delta < -0.3 && v <= 52)
        res.sup.push('Price is bouncing, but RSI ('+V+') stays below 50 and is turning down — buyers have no force. <b>This is a pullback in the new downtrend, not the old uptrend coming back.</b>');
      if(up && delta > 0.3 && v >= 48)
        res.sup.push('Price is dipping, but RSI ('+V+') stays above 50 and is turning up — sellers have no force. <b>This is a pullback in the new uptrend, not the old downtrend coming back.</b>');
    }
  }catch(e){ console.warn('[confluence rsi]', e && e.message); }
  const first = res.con[0] || res.sup[0] || res.wk[0];
  if(first) res.story = first;
  return res;
}

const CONF_H4 = {};

const PR_LOCK = {};

const PR_EP = {};

function confH4Levels(){
  if(tf !== 'H1') return null;
  const c = CONF_H4[pair];
  if(!c || Date.now() - c.at > 60000){
    CONF_H4[pair] = {at: Date.now(), levels: c ? c.levels : null};
    const sym = brokerSym[pair] || pair;
    jget('/api/patterns?symbol='+encodeURIComponent(sym)+'&tf=H4')
      .then(d => { CONF_H4[pair] = {at: Date.now(), levels: (d && d.sr_levels) || []}; })
      .catch(() => {});
  }
  return CONF_H4[pair] ? CONF_H4[pair].levels : null;
}

function prRsi(cd){
  const out = new Array(cd.length).fill(null), n = 14; if(cd.length <= n) return out;
  let g=0,l=0; for(let i=1;i<=n;i++){ const d=cd[i].c-cd[i-1].c; if(d>=0) g+=d; else l-=d; } g/=n; l/=n;
  out[n] = 100-100/(1+g/Math.max(1e-12,l));
  for(let i=n+1;i<cd.length;i++){ const d=cd[i].c-cd[i-1].c; g=(g*(n-1)+Math.max(d,0))/n; l=(l*(n-1)+Math.max(-d,0))/n; out[i]=100-100/(1+g/Math.max(1e-12,l)); }
  return out;
}

function prBarOf(cd, ms){            /* the bar a timestamp falls in, or -1 */
  if(!ms) return -1;
  for(let i=cd.length-1;i>=0;i--){ const t = bwBarMs(cd[i]); if(t && t <= ms) return (ms - t) < 6*3600*1000 ? i : -1; }
  return -1;
}

function readRevPressure(cd, o, alerts, raised, RX){
  /* v2 — FOLLOWS PRICE AT THE LEVELS, not the alerts.
     The episode starts when price TOUCHES a major / medium level from
     the Levels tab (support touched from above, resistance from below)
     and is re-read on every refresh while price reacts to it. Alerts
     are evidence inside it, not the gate. RSI is the same live MT5
     reading as the Momentum row (3-minute rule), not a separate one. */
  const out = {state:'idle', score:0, rows:[]};
  const d = D() || {};
  const levels = (d.sr_levels || []).map(l => ({p:+l.price, lo:isFinite(+l.lo)?+l.lo:+l.price, hi:isFinite(+l.hi)?+l.hi:+l.price,
      role:String(l.type||'').toLowerCase().indexOf('res')>=0?'R':'S', tier:String(l.tier||'').toLowerCase(),
      prob:isFinite(+l.prob)?+l.prob:null, tests:+l.tests||0}))
    .filter(l => isFinite(l.p) && (l.tier === 'major' || l.tier === 'medium'));
  if(!levels.length || cd.length < 30){ out.state = levels.length ? 'idle' : 'nolevels'; return out; }
  const n = cd.length, last = n - 2, live = cd[n-1];          /* cd[n-1] forming; last = newest CLOSED bar */
  let ar = 0; for(let i=Math.max(1,n-16);i<n-1;i++) ar += cd[i].h - cd[i].l; ar /= Math.min(15, n-2);
  const tol = ar * 0.35;
  const key = pair+'|'+tf;
  const inZone = (b,l) => b.l <= l.hi + tol && b.h >= l.lo - tol;

  /* 1. THE TOUCH: the most recent bar (closed or forming) that reached a level
        from the right side. Support is touched from above, resistance from below. */
  let touch = null;
  /* AN ATTEMPT IN PROGRESS IS HELD: same level, same visit, however old,
     until it fails, confirms or fades. A new wick inside the zone only
     moves the extreme the turn is measured from. */
  const lock = PR_LOCK[key];
  if(lock && !lock.done){
    const lvL = levels.find(l => Math.abs(l.p - lock.p) < 1e-9 && l.role === lock.role);
    let iT = -1; for(let i=n-1;i>=0;i--) if(bwBarMs(cd[i]) === lock.t0){ iT = i; break; }
    if(lvL && iT >= 0) touch = {i:iT, lv:lvL}; else delete PR_LOCK[key];
  }
  const doneT = lock && lock.done ? lock.doneT : 0;
  for(let i=n-1;i>=Math.max(1,n-1-14) && !touch;i--){
    if(doneT && bwBarMs(cd[i]) <= doneT) break;          /* an ended attempt never comes back */
    const hits = levels.filter(l => inZone(cd[i], l) &&
        (l.role === 'S' ? cd[Math.max(0,i-3)].c > l.hi : cd[Math.max(0,i-3)].c < l.lo))
      .sort((a,b) => (b.tier==='major') - (a.tier==='major') || Math.abs(a.p-cd[i].c) - Math.abs(b.p-cd[i].c));
    /* after an attempt ends, the SAME level needs a fresh visit: price must leave the zone first */
    const fresh = hits.filter(l => !(doneT && Math.abs(l.p - lock.p) < 1e-9 &&
        !cd.some((b,j) => j < i && bwBarMs(b) > doneT && !inZone(b, l))));
    if(fresh.length) touch = {i, lv: fresh[0]};
  }
  if(!touch){ delete PR_EP[key]; return out; }
  const lv = touch.lv, bull = lv.role === 'S', bear = !bull, L = lv.p;
  /* the first bar of this visit to the level (so the turn is measured from the extreme) */
  /* THE VISIT (fixed Oct 2026). This walked back through every bar within the zone's
     tolerance, including bars that had CLOSED on the far side of the level days before
     (price below a support, before it ever came down onto it from above). Those old
     closes were then counted as "two closes below" — a failed reversal the trader could
     not see — and the "touch" band was drawn on that old bar. The walk now stops at the
     first bar that closed beyond the level's far edge: the visit starts after it. */
  const farSide = b => bull ? b.c < lv.lo : b.c > lv.hi;
  const nearSide = b => bull ? b.c > lv.hi : b.c < lv.lo;
  let ti = touch.i, sawNear = nearSide(cd[ti]);
  while(ti-1 >= 1 && inZone(cd[ti-1], lv) && !(doneT && bwBarMs(cd[ti-1]) <= doneT)){
    if(farSide(cd[ti-1]) && sawNear) break;      /* a far-side close from BEFORE price came onto the level's near side */
    ti--; if(nearSide(cd[ti])) sawNear = true;
  }
  /* …and it starts once price is on the APPROACH side (above a support, below a
     resistance) — bars that were still climbing up through a support from below are
     not part of a visit "from above" */
  while(ti < touch.i && !nearSide(cd[ti-1])) ti++;
  /* the bar the chart marks as the TOUCH: the first bar of the visit that actually
     reached the zone (the tolerance widens the visit, not the touch) */
  let touchI = ti; for(let i=ti;i<=n-1;i++){ if(bull ? cd[i].l <= lv.hi : cd[i].h >= lv.lo){ touchI = i; break; } }
  let ext = bull ? Infinity : -Infinity, extI = ti;
  for(let i=ti;i<=n-1;i++){ if(bull ? cd[i].l < ext : cd[i].h > ext){ ext = bull ? cd[i].l : cd[i].h; extI = i; } }

  /* 2. CANCEL: a CLOSE through the far side of the level after the touch */
  /* Two CLOSED bars in a row beyond the zone edge. A wick through, or one close
     that comes back inside, means the level still stands. */
  /* ONE LONG CANDLE IS ENOUGH (Oct 2026, his rule — the same break rule as the Combined Read):
     a closed candle beyond the edge that is >= 2x the average of the 30 bars before it, mostly
     body (>= 60%) and moving through the level, ends the reversal on its own. A level price has
     closed through like that is no longer valid. Ordinary candles still need two closes. */
  const longThru = i => { let a = 0, k = 0; for(let j=Math.max(0,i-30);j<i;j++){ a += cd[j].h - cd[j].l; k++; } a = k ? a/k : 0;
    const rg = cd[i].h - cd[i].l; return a > 0 && rg >= a*2 && Math.abs(cd[i].c - cd[i].o)/rg >= 0.6 && (bull ? cd[i].c < cd[i].o : cd[i].c > cd[i].o); };
  let cancelled = false, thru = 0, cancelBy = 'two';
  for(let i=ti;i<=last;i++){ const beyond = bull ? cd[i].c < lv.lo : cd[i].c > lv.hi; thru = beyond ? thru+1 : 0;
    if(beyond && thru === 1 && longThru(i)){ cancelled = true; cancelBy = 'long'; break; }
    if(thru >= 2){ cancelled = true; break; } }

  /* 3. THE TURN, live: how far price has come back off the extreme, in average bars.
        Closed bars count; the forming bar shows as provisional. */
  const off = b => bull ? (b.c - ext)/ar : (ext - b.c)/ar;
  let best = 0; for(let i=extI;i<=last;i++) best = Math.max(best, off(cd[i]));
  const ftOf = v => v >= 1.5 ? 20 : v >= 1 ? 14 : v >= .5 ? 7 : 0;
  const ft = ftOf(best), liveOff = off(live), prov = Math.max(0, ftOf(Math.max(best, liveOff)) - ft);

  /* 4. ALERTS that agree with the turn, within 3 bars of the touch, 70%+ */
  const evs = [];
  const near = i => i >= ti - 1 && i <= Math.max(extI, ti) + 3;
  (alerts || []).forEach(q => {
    const conf = q.confidence_pct != null ? +q.confidence_pct : q.confidence != null ? +q.confidence : 0;
    if(!(conf >= 70)) return;
    const t = String(q.type || q.direction || '').toLowerCase() + ' ' + String(q.name || '').toLowerCase();
    const dir = t.indexOf('bear') >= 0 ? 'down' : t.indexOf('bull') >= 0 ? 'up' : null;
    if(dir !== (bull ? 'up' : 'down')) return;
    const bi = q.bar_index != null ? +q.bar_index : null; if(bi == null || !(bi >= 1)) return;
    const i = n-1-bi; if(near(i)) evs.push({i, conf:Math.round(conf), name:q.name || q.type, src:'Live tab'});
  });
  (raised || []).forEach(a => {
    const conf = a.confidence != null ? +a.confidence : a.confidence_pct != null ? +a.confidence_pct : 0;
    if(!(conf >= 70)) return;
    const t = String(a.direction || '').toLowerCase() + ' ' + String(a.name || a.type || '').toLowerCase();
    const dir = t.indexOf('bear') >= 0 ? 'down' : t.indexOf('bull') >= 0 ? 'up' : null;
    if(dir !== (bull ? 'up' : 'down')) return;
    const i = prBarOf(cd, a.time ? bwBarMs({t:a.time}) : (+a.ts || 0));
    if(i >= 1 && i <= last && near(i)) evs.push({i, conf:Math.round(conf), name:a.name || a.type, src:'Assistant'});
  });
  evs.sort((a,b) => b.conf - a.conf);
  const ev = evs[0] || null;
  const both = !!ev && evs.some(e => e.src !== ev.src);

  /* 5. RSI — the SAME live reading as the Momentum row */
  const tag = RX && RX.tag ? RX.tag : null;
  const rsiTurn = bull ? tag === 'Rising' : tag === 'Falling';
  const rsiTxt = RX && RX.v != null ? 'RSI '+RX.v.toFixed(0)+' · '+(tag ? tag.toLowerCase() : 'direction settling')+(rsiTurn ? ' — with the turn' : tag && tag !== 'Flat' ? ' — against the turn' : '') : 'no RSI reading';

  /* 6. H4 at the same price */
  let h4 = false; const H4 = confH4Levels();
  if(H4 && H4.length) h4 = H4.some(l => String(l.tier||'').toLowerCase() === 'major' && Math.abs(+l.price - L) <= ar*.5 &&
                                         (String(l.type||'').toLowerCase().indexOf('res') >= 0) === bear);
  let big = false; for(let i=ti;i<=last;i++) if(cd[i].h - cd[i].l > ar*2.2) big = true;

  const dg = digitsOf(pair), F = v => (+v).toFixed(dg);
  const after = last - ti;
  const rows = [], add = (lbl,pts,on,sub,x) => rows.push(Object.assign({lbl,pts,on,sub},x||{}));
  add('At a '+lv.tier+' '+(bull?'support':'resistance'), lv.tier==='major'?25:12, true,
      F(L)+(lv.prob!=null?' · holds '+lv.prob+'%':'')+' · touched '+(touch.i===n-1?'on the forming bar':(last-touch.i)===0?'on the last bar':(last-touch.i)+' bars ago'));
  add('Price turning off it', ft, ft>0, (Math.floor(Math.max(0,best)*10)/10).toFixed(1)+' average bars back from the '+(bull?'low':'high')+' at '+F(ext)+' · ½ = 7, 1 = 14, 1½ = 20', prov?{prov}:null);
  add('Reversal alert 70%+', ev?20:0, !!ev, ev ? ev.name+' '+ev.conf+'% · '+ev.src : 'none at this level yet — '+(bull?'bullish':'bearish')+' patterns of 70%+ only');
  add('Both sources agree', both?5:0, both, both ? 'Live tab and Assistant' : 'one source or none');
  add('RSI turning', rsiTurn?10:0, rsiTurn, rsiTxt);
  add('H4 agrees', h4?15:0, h4, tf!=='H1'?'shown on H1':H4==null?'H4 levels loading':h4?'H4 major at the same price':'no H4 major here');
  add('A proven level', (lv.prob||0)>=70?5:0, (lv.prob||0)>=70, lv.prob!=null?'holds '+lv.prob+'%':'no score sent');
  let score = rows.reduce((a,r) => a + r.pts, 0);
  let state = ft > 0 || ev ? 'live' : 'atlevel';
  const held = PR_LOCK[key] && !PR_LOCK[key].done;
  if(held && state === 'atlevel') state = 'live';      /* a new extreme inside the zone does not end the attempt */
  if(cancelled){ state = 'failed'; rows.push({lbl:'Price closed through the level', pts:-score, on:true, neg:true, sub:(cancelBy==='long'?'one long '+(bull?'bearish':'bullish')+' candle closed ':'two closes ')+(bull?'below':'above')+' the zone edge '+F(bull?lv.lo:lv.hi)+' — the level is no longer valid'}); score = 0; }
  else {
    if(ft === 0 && after > 10){ const cut = Math.min(score, (after-10)*5); rows.push({lbl:'Going stale', pts:-cut, on:true, neg:true, sub:after+' bars at the level with no turn'}); score -= cut; }
    if(big){ const cap = Math.max(0, score-85); rows.push({lbl:'One oversized candle (likely news)', pts:-cap, on:true, neg:cap>0, sub:'treat with care · capped at 85'}); score -= cap; }
  }

  /* 7. THE OFFICIAL LINE: the HL (selling pressure) / LH (buying pressure) */
  const f = (o && o.frame) || {};
  const mem = PR_EP[key] && PR_EP[key].t === bwBarMs(cd[ti]) && PR_EP[key].p === L ? PR_EP[key] : (PR_EP[key] = {t:bwBarMs(cd[ti]), p:L});
  let HL = null;
  if(f.decider && isFinite(f.decider.p) && ((bear && f.dir === 'up') || (bull && f.dir === 'down')) && !f.flipped) HL = f.decider.p;
  if(HL == null && mem.HL != null) HL = mem.HL;
  if(HL == null){ const w = cd.slice(Math.max(0, ti-20), ti); if(w.length) HL = bear ? Math.min.apply(null, w.map(b=>b.l)) : Math.max.apply(null, w.map(b=>b.h)); }
  if(mem.HL == null) mem.HL = HL;
  let tw = bear ? (f.dir==='up' && !f.flipped ? 'uptrend' : null) : (f.dir==='down' && !f.flipped ? 'downtrend' : null);
  if(tw && !mem.tw) mem.tw = tw; if(!tw) tw = mem.tw || (bear ? 'move up' : 'move down');
  let beyond = 0, confirmed = false;
  if(HL != null && !cancelled){
    let run = 0;
    for(let i=ti;i<=last;i++){ run = (bear ? cd[i].c < HL : cd[i].c > HL) ? run+1 : 0; }
    beyond = run;
    if(beyond >= 2 && rsiTurn) confirmed = true;      /* two closes beyond + RSI with it, now */
    if(confirmed) state = 'confirmed'; else if(beyond >= 2) state = 'broken';
  }
  /* 8. THE EARLY LINE: the newest swing the last leg into the level printed
     (the HL on the way up to a resistance / the LH on the way down to a
     support). Two closes beyond it + RSI = early reversal confirmed — long
     before the trend's own HL/LH is reached. */
  let EL = null, elI = null, eBeyond = 0;
  if(!cancelled){
    for(let i=Math.min(extI-1, n-3); i>=Math.max(2, ti-25); i--){
      const v = bear ? cd[i].l : cd[i].h, pv = k => bear ? cd[k].l : cd[k].h;
      const piv = bear ? (v<=pv(i-1)&&v<=pv(i-2)&&v<=pv(i+1)&&v<=pv(i+2)) : (v>=pv(i-1)&&v>=pv(i-2)&&v>=pv(i+1)&&v>=pv(i+2));
      if(!piv) continue;
      if(bear ? (v < ext && (HL==null || v > HL)) : (v > ext && (HL==null || v < HL))){ EL = v; elI = i; break; }
    }
    if(EL == null){ EL = bear ? cd[ti].l : cd[ti].h; elI = ti; if(HL!=null && (bear ? EL <= HL : EL >= HL)) EL = null; }
    if(EL != null){ let run = 0; for(let i=Math.max(extI,ti);i<=last;i++){ run = (bear ? cd[i].c < EL : cd[i].c > EL) ? run+1 : 0; } eBeyond = run;
      if(state === 'live' || state === 'atlevel'){ if(eBeyond >= 2) state = rsiTurn ? 'early' : 'earlybreak'; } }
  }
  /* 9. THE ATTEMPT'S LIFE: held from the first turn until it ends, and the
        ending is shown before the normal verdict takes the floor back. */
  const ACTIVE = {live:1, early:1, earlybreak:1, broken:1, confirmed:1};
  if((!PR_LOCK[key] || PR_LOCK[key].done) && (ACTIVE[state] || state === 'failed')) PR_LOCK[key] = {p:L, role:lv.role, t0:bwBarMs(cd[ti])};
  const lk = PR_LOCK[key];
  let endIn = null;
  if(lk && !lk.done && lk.p === L){
    if(state === 'live' && after >= 20) state = 'faded';
    if(state === 'failed' || state === 'confirmed' || state === 'faded'){
      if(!lk.endT || lk.endState !== state){ lk.endT = bwBarMs(cd[last]); lk.endState = state; }
      let since = 0; for(let i=last;i>=0 && bwBarMs(cd[i]) > lk.endT;i--) since++;
      const hold = state === 'confirmed' ? 5 : 3;
      endIn = hold - since;
      if(since >= hold){ lk.done = true; lk.doneT = bwBarMs(cd[last]); out.state = 'idle'; return out; }
    } else { lk.endT = 0; lk.endState = null; }
  }
  if(state === 'faded'){ rows.push({lbl:'Faded', pts:-score, on:true, neg:true, sub:after+' bars since the touch with neither line broken'}); score = 0; }
  const evOut = ev || {name:'no alert yet', conf:0, src:'—'};
  return Object.assign(out, {__key:key, state, cancelBy, score:Math.max(0,Math.min(100,score)), prov, rows, bear, level:lv, ev:evOut, hasAlert:!!ev, both,
    ft, best, after, h4, big, HL, beyond, rsi:RX&&RX.v, F, trendWord: tw, ext, ti, touchI, extI, cd, EL, elI, eBeyond, endIn});
}

function prHead(P){
  const F = P.F || (v => (+v).toFixed(digitsOf(pair))), conf = P.state === 'confirmed';
  const lv = P.level, lvw = lv.tier+' '+(P.bear?'resistance':'support'), hl = P.bear ? 'HL' : 'LH', tr = P.trendWord;
  const al = P.hasAlert ? P.ev.name+' ('+P.ev.conf+'%'+(P.both?', Live tab and Assistant':', '+P.ev.src)+')' : null;
  let w, l;
  if(P.state==='failed'){ w='Reversal attempt failed — the '+tr+' is back in charge'; l=(P.cancelBy==='long'?'One long candle closed ':'Two candles closed ')+(P.bear?'above':'below')+' the '+lvw+' zone ('+F(P.bear?lv.hi:lv.lo)+') — the level did not hold and the '+tr+' has resumed. The pressure reading is cancelled.'; }
  else if(conf){ w='Reversal confirmed — the '+tr+' has ended'; l='Price closed '+(P.bear?'below':'above')+' the '+hl+' at '+F(P.HL)+' on two bars and RSI agrees. It began as a turn off the '+lvw+' at '+F(lv.p)+(al?' with a '+al:'')+'. A confirmed break is not a forecast.'; }
  else if(P.state==='faded'){ w='Faded — price did not follow through'; l=P.after+' bars since price touched the '+lvw+' at '+F(lv.p)+' and neither the early line nor the full reversal line has broken. The attempt is over.'; }
  else if(P.state==='early'){ w='Early reversal confirmed — not the full reversal yet'; l='Price closed '+(P.bear?'below':'above')+' the last '+(P.bear?'higher low':'lower high')+' of the move into the '+lvw+' ('+F(P.EL)+') on two bars, and RSI is '+(P.bear?'falling':'rising')+' with it. This is the first structure break of the turn. The full reversal needs two closes '+(P.bear?'below':'above')+' the '+hl+' at '+(P.HL!=null?F(P.HL):'—')+'. Early breaks fail more often than full ones.'; }
  else if(P.state==='earlybreak'){ w='Early break — momentum not confirming yet'; l='Two closes '+(P.bear?'below':'above')+' the early line at '+F(P.EL)+', but RSI is not '+(P.bear?'falling':'rising')+' with it. It becomes an early confirmed reversal when RSI turns.'; }
  else if(P.state==='broken'){ w='Structure broken — momentum not confirming yet'; l='Two closes '+(P.bear?'below':'above')+' the '+hl+' at '+F(P.HL)+', but RSI is not '+(P.bear?'falling':'rising')+' with it. It becomes a confirmed reversal when RSI turns.'; }
  else if(P.state==='atlevel'){ w='Price is at the '+lvw+' — watching for the turn'; l='Price has reached the '+lvw+' at '+F(lv.p)+(lv.prob!=null?' (holds '+lv.prob+'%)':'')+' and has not turned off it yet. The reading climbs as price moves back '+(P.bear?'down':'up')+' from the '+(P.bear?'high':'low')+'.'; }
  else { const bits = ['price is turning off the '+lvw+' at '+F(lv.p)];
    if(P.ft) bits.push('it has come back '+(Math.floor(P.best*10)/10).toFixed(1)+' average bars from the '+(P.bear?'high':'low'));
    if(al) bits.push('a '+al+' fired there');
    if(P.rows.find(r => r.lbl==='RSI turning' && r.on)) bits.push('RSI is '+(P.bear?'falling':'rising'));
    if(P.h4) bits.push('H4 has a major level at the same price');
    if(P.big) bits.push('the move came in one oversized candle (likely news)');
    w = 'Reversal building off the '+lvw+' — not confirmed yet';
    l = (/trend$/.test(tr) ? 'The '+tr+' is under pressure. ' : 'There is no clean '+(P.bear?'uptrend':'downtrend')+' behind it, so this is a turn at the level, not yet the end of a trend. ')+bits[0][0].toUpperCase()+bits[0].slice(1)+(bits.length>1?'; '+bits.slice(1).join('; '):'')+'.'+(P.HL!=null?' The '+hl+' at '+F(P.HL)+' has not broken — this is pressure, not a confirmed reversal.':''); }
  if(P.endIn != null && P.endIn > 0) l += ' The normal combined read takes over in '+P.endIn+' bar'+(P.endIn===1?'':'s')+'.';
  return {w, l};
}

function cfPublishRead2(N, RX){
  let store = {}; try{ store = JSON.parse(localStorage.getItem('bw-confluence-now')||'{}') || {}; }catch(e){ store = {}; }
  const key = pair+'|'+tf; if(!store.reads || !store.reads[key]) return;
  const dg = digitsOf(pair), r6 = v => v==null||!isFinite(+v) ? null : +(+v).toFixed(dg);
  store.reads[key].read2 = !N || !N.ok ? {ok:false, why:(N&&N.why)||'not available'} : {
    ok:true, head:N.head, sub:N.sub, tone:N.tone||null, trade:!!N.trade, kind:N.kind||null,
    signal: N.sig ? {name:N.sig.name, conf:N.sig.conf, dir:N.sig.d>0?'up':'down'} : null,
    trend: N.transition ? 'transition' : N.trend, dir:N.dir||0, labels:(N.labels||[]).join(' '),
    phase:N.phase, barsIn:N.barsIn, how:(N.last&&N.last.how)||null, waiting:N.waiting||null,
    range: N.box ? {lo:r6(N.box.lo), hi:r6(N.box.hi), zone:N.zone||null, pctUp:N.edge!=null&&isFinite(N.edge)?Math.round(N.edge*100):null, broken:N.brk||null} : null,
    brk: N.brk2 && N.brk2.L ? {level:r6(N.brk2.L.p), tier:N.brk2.L.tier, dir:N.brk2.d>0?'up':'down', how:N.brk2.how, retest:!!N.brk2.retest} : null,
    location:N.loc||null, nextRes: N.above ? {price:r6(N.above.p), tier:N.above.tier} : null, nextSup: N.below ? {price:r6(N.below.p), tier:N.below.tier} : null,
    warnings:(N.warn||[]).slice(0,6), reversalWatch:(N.rv||[]).slice(0,4),
    rsi: RX && RX.v!=null ? {v:Math.round(RX.v), tag:RX.tag||null} : null
  };
  try{ localStorage.setItem('bw-confluence-now', JSON.stringify(store)); }catch(e){}
}

function cfPublishPullback(F, P){   /* passed in: a copy run elsewhere (Arbiter) reads its own */
  let store = {}; try{ store = JSON.parse(localStorage.getItem('bw-confluence-now')||'{}') || {}; }catch(e){ store = {}; }
  const key = pair+'|'+tf; if(!store.reads || !store.reads[key]) return;
  let r = null;
  if(F && F.key===key) r = {verdict:F.verdict, score:F.score, broken:F.broken, standDown:F.standDown, holder:F.holder, dir:F.dir, note:F.note, from:'final'};
  else if(P && P.key===key && P.a) r = {verdict:P.a.verdict, score:P.a.score, broken:!!P.a.structurallyBroken, standDown:null, holder:null, dir:(P.a.trend&&P.a.trend.dir)||0,
                                         note:(P.a.factors&&P.a.factors[0]&&P.a.factors[0].label)||null, from:'engine'};
  store.reads[key].retracement = r;
  try{ localStorage.setItem('bw-confluence-now', JSON.stringify(store)); }catch(e){}
}

  /* ── the calculation slices, VERBATIM, each given this pair's window ── */
  var makeChart   = function(window){ return (function renderChart(){
  const cd=((SERIES[pair]||{})[tf])||[];
  /* liveLast: the newest bar is still forming — only CLOSED bars decide a state */
  const res=window.BWChartPatterns.detect(cd, {liveLast:true, fastConfirm:function(p){ return cpFastOk(p, cd); }});
  /* Hold the detection and the selection so the chart above the list can
     draw the same objects the rows describe — they must never be two
     separate detections. */
  CPV.cd=cd; CPV.pats=res.patterns||[];
  /* ── ONE FORMATION, SEVERAL READINGS ─────────────────────────────
     Measured on the live engine: 87% of concurrent detections SHARE
     BARS — they are competing readings of the same swings, not separate
     patterns. And the same anchor alternates names bar to bar, which is
     the list flickering rather than a shape morphing.
     Grouping gives one row, one lifecycle, one shape per piece of price
     action. The LEAD reading is the one price is walking toward; the
     others stay visible but faint, because the market has not ruled them
     out. A lead change must hold 2 bars, which is what kills the
     flicker. */
  try{
    CPV.forms = window.BWFormations.read(CPV.pats, cd, {
      pip: (window.BWRange ? window.BWRange.pipOf(brokerSym[pair]||pair) : 0.0001)
    });
  }catch(e){ CPV.forms=[]; }
  /* Published for Arbiter, which judges open trades in its own iframe and
     cannot call BWFormations. Same channel pattern as bw-confluence-now. */
  publishFormations(CPV.forms, cd);
  /* ── RESOLVED FORMATIONS LEAVE THE LIST ──────────────────────────
     A pattern is a live QUESTION: will price do the thing this shape
     implies? `confirmed` means the trigger worked and `failed` means it
     did not — either way the question is ANSWERED, and an answered
     question sitting in the list only makes it longer and less worth
     reading. They move to a short "recently resolved" note instead, so
     nothing disappears silently. */
  /* `read()` has already dropped anything answered, left behind or
     stale — CPV.expired says which and why, so a shape never just
     disappears without the trader being able to see it went. */
  /* ── DISTANCE OR BARS ────────────────────────────────────────────
     A break waits 3 closed bars. On H1 that is 3 hours, and price
     travels a median of 8 pips in that time but 30 at the 90th
     percentile — so on exactly the breaks worth taking, the trader
     watches the whole move from "85% complete".
     When the book is healthy, the bar is genuinely moving, there is time
     left in it, and the radar shows a cause, distance replaces time. A
     radar flag RAISES the distance required rather than lowering it:
     a flag means the move has a driver, but it is also when spreads
     widen and stops get hunted. More proof, not less. */
  try{
    /* ── THE CHANNEL FIRST, THE LOCAL COPY AS A FALLBACK ────────────
       The Assistant now publishes its own liquidity read to
       `bw-liquidity-now`, so there is one definition rather than two
       that drift. But the channel only updates while the Assistant is
       open, so the embedded `liqRead` stays as a fallback — the tab
       keeps working on its own, and says which source it used. */
    let liq=null, liqSource='local';
    try{
      const raw=JSON.parse(localStorage.getItem('bw-liquidity-now')||'null');
      if(raw && raw.pairs && (Date.now()-(+raw.t||0))<RISK_FRESH_MS){
        const hit = raw.pairs[brokerSym[pair]||pair] || raw.pairs[pair] ||
                    raw.pairs[Object.keys(raw.pairs).find(k=>prettyPair(k)===pair)||''];
        if(hit && hit.tf===tf){ liq=hit; liqSource='assistant'; }
      }
    }catch(e){}
    if(!liq && window.BWLiquidity){ try{ liq=BWLiquidity.liqRead(cd, tf); }catch(e){} }
    const rr  = RISK[pair] || null;
    /* `bw-risk-now` carries {name, score} — no factors yet, so the
       reason list is empty until the Assistant writes them. Say so
       rather than implying we know why. */
    const radarIn = rr ? {level:{key:String(rr.name||'').toLowerCase().replace(/\s+/g,'')},
                          score:rr.score,
                          factors:(rr.factors||[]).map(function(x){ return {label:x}; }), vol:rr.vol||[]} : null;
    const lastBar = cd.length? cd[cd.length-1] : null;
    const openMs  = lastBar ? ((+lastBar.t||+lastBar.time||0) < 1e12
                     ? (+lastBar.t||+lastBar.time||0)*1000 : (+lastBar.t||+lastBar.time||0)) : null;
    CPV.confirm = {};
    (CPV.forms||[]).forEach(function(f){
      if(!f.lead || (f.lead.life.state!=='breaking' && f.lead.life.state!=='stalled')) return;
      CPV.confirm[f.key] = BWBreakConfirm.decide({
        pattern:f.lead, cd:cd, tf:tf,
        liquidity: Object.assign(BWBreakConfirm.fromLiquidity(liq)||{}, {source:liqSource}),
        radar: BWBreakConfirm.fromRadar(radarIn),
        barOpenMs: openMs, pip: (window.BWRange?BWRange.pipOf(brokerSym[pair]||pair):0.0001)
      });
    });
  }catch(e){ CPV.confirm={}; }

  CPV.expired  = CPV.forms.expired || [];
  CPV.resolved = CPV.forms.filter(f=>f.resolved);
  CPV.forms    = CPV.forms.filter(f=>!f.resolved);
  /* RECENTLY CONFIRMED stay visible as a full green card for 5 bars
     after they confirm, then drop to the "no longer live" note. Kept
     apart from CPV.forms so nothing that reads CPV.forms changes. */
  const CONF_SHOW=5;
  const recentOk=p=>p&&p.life&&(p.life.state==='confirmed'||p.life.state==='target')&&(p.life.barsSince||0)<=4+CONF_SHOW;
  CPV.recentConf=[];
  CPV.resolved.forEach(f=>{ if(recentOk(f.lead)) CPV.recentConf.push(f); });
  CPV.expired.forEach(e=>{
    if(e.why==='answered'&&recentOk(e.pattern)&&!CPV.recentConf.some(f=>f.lead.name===e.pattern.name)){
      CPV.recentConf.push({key:'conf|'+(e.pattern.key||e.pattern.name)+'|'+e.pattern.endI,
        startI:e.pattern.startI,endI:e.pattern.endI,lead:e.pattern,others:[],members:[e.pattern],
        state:'confirmed',resolved:true,headingFor:null,renamed:false,history:[],alsoReads:[]});
    }
  });
  CPV.resolved=CPV.resolved.filter(f=>CPV.recentConf.indexOf(f)<0);
  CPV.expired=CPV.expired.filter(e=>!CPV.recentConf.some(f=>f.lead===e.pattern));

  /* Selection is by FORMATION now, not by individual pattern. */
  if(CPV.sel && !CPV.forms.concat(CPV.recentConf).find(f=>f.key===CPV.sel)) CPV.sel=null;
  if(!CPV.sel && CPV.forms.length) CPV.sel=CPV.forms[0].key;
}); };
  var makeRetrace = function(window){ return (function renderRetrace(){
  const cd=((SERIES[pair]||{})[tf])||[];
  const d=D();
  const r=RISK[pair];
  /* ── STRUCTURE FIRST, ALWAYS ──────────────────────────────────────
     This comment used to read "the pullback engine runs FIRST and always
     — it is the authority on whether there is a trend". That has not been
     true since the structure engine took over, and the ORDER still
     matched the old belief: assess() ran 38 lines before the mandate
     existed, so it could only ever see the PREVIOUS cycle's structure.
     Structure is read first now, and its classification is handed to the
     pullback engine in the same call. */
  let mandate=null;
  try{ mandate=window.BWGovernor2.govern(cd,{key:pair+'|'+tf}); }catch(e){ mandate=null; }

  const a=window.BWRetracement.assess({
    candles:cd, symbol:brokerSym[pair]||pair, timeframe:tf,
    patterns:(d&&d.patterns)||[],
    levels:(d&&d.sr_levels)||[],
    risk:(r&&r.fresh!==false)?r:null,
    mandate:mandate                       /* the trend comes from structure */
  });
  window.__BWPullback = {key: pair+'|'+tf, a: (a && a.ok) ? a : null};   /* the Combined Read reads the same answer */
  /* ── THE CONDUCTOR ────────────────────────────────────────────────
     One authority decides which engine drives and whether either should
     be acted on at all, and BOTH read the same frozen snapshot in this
     same frame. Neither engine polls the other, so they cannot disagree
     and there is no second cycle of delay between them.
     The slow half (pivots, labels, regime) is memoised against the last
     closed bar, so the cost of calling this on every render is the fast
     half only — measured at about 0.17 ms. */
  let conductor=null;
  try{
    if(!window.__BWC) window.__BWC=window.BWConductor.create();
    const mine=(OPEN||[]).filter(t=>t.sym===pair)[0]||null;
    conductor=window.__BWC.update(cd,{
      key:pair+'|'+tf,                    /* scopes the memo to this chart */
      risk:(r&&r.fresh!==false)?r:null,
      trade:mine, pip:(window.BWRange?window.BWRange.pipOf(brokerSym[pair]||pair):0.0001)
    });
    /* The chart draws in a different closure, so hand it the snapshot
       through an explicit global rather than reaching across scopes —
       the trap that has bitten this codebase five times. */
    window.__BWCLast=conductor;
  }catch(e){ conductor=null; }

  /* ── THE MANDATE ─────────────────────────────────────────────────
     Obtained BEFORE either engine runs, because it decides which of them
     is allowed to conclude anything. Previously both ran unconditionally
     and the structure reading was printed beside them as commentary. */
  try{
    /* Re-run with the evidence that only exists once the other engines
       have reported: the extreme bar, and whether the pullback engine can
       still answer. Same governor, same key, so this is the same running
       delegation rather than a second opinion. */
    mandate=window.BWGovernor2.govern(cd,{
      key: pair+'|'+tf, tf: tf, symbol: pair,
      risk: (RISK[pair] && RISK[pair].fresh!==false) ? RISK[pair] : null,
      news: (window.BW_NEWS && window.BW_NEWS.rows) || [],
      extreme: (conductor && conductor.ok) ? conductor.extreme : null,
      pullback: a && a.ok ? {undecidable:a.undecidable, undecidableCore:a.undecidableCore, score:a.score, verdict:a.verdict} : null
    });
  }catch(e){ mandate=null; }
  window.__BWMandate=mandate;
}); };
  var makeConf    = function(window){ return (function renderConf(){
  const el = $('confBody');
  if(!el) return;

  /* NORMALISE THE CANDLES ONCE, HERE.
     The host stores rows as {time,open,high,low,close,tick_volume} from
     /api/candles, and every host reader accesses them tolerantly
     (+cd[i].h || +cd[i].high). The confluence engine and its chart read
     t/o/h/l/c/v only, so without this every value was undefined -> NaN,
     the chart drew NaN coordinates and the tab looked frozen while the
     feed was perfectly healthy. Normalise at the boundary, once, so
     neither the engine nor the chart has to be tolerant. */
  const rawCd = ((SERIES[pair]||{})[tf])||[];
  const cd = [];
  for(let i=0;i<rawCd.length;i++){
    const r = rawCd[i]; if(!r) continue;
    const o = +r.o, h = +r.h, l = +r.l, c = +r.c;
    const O = isFinite(o)?o:+r.open, H = isFinite(h)?h:+r.high,
          L = isFinite(l)?l:+r.low,  C = isFinite(c)?c:+r.close;
    if(!isFinite(O)||!isFinite(H)||!isFinite(L)||!isFinite(C)) continue;
    let t = +r.t; if(!isFinite(t)||!t) t = +r.time || +r.timestamp || 0;
    let v = +r.v; if(!isFinite(v)) v = +r.tick_volume || +r.volume || 0;
    cd.push({t:t, o:O, h:H, l:L, c:C, v:v});
  }
  if(cd.length < 60){
    el.innerHTML = '<div class="card"><div class="ct">The combined read</div>'+
      '<div class="mut" style="padding:4px 0">Waiting for candles on '+pair+' '+tf+
      ' — '+cd.length+' loaded so far.</div></div>';
    /* Fewer than 60 candles: no reading exists yet, so nothing is published.
       (This branch used to run the debug and publish lines that belong AFTER
       the read below — they used o, raised, missed, feedGap and alerts before
       those were declared, so it threw every time candles were short.) */
  const b=$('cConf'); if(b) b.textContent='—';
    return;
  }

  /* HOST READINGS, fetched here and handed over. The mandate is the
     authority on direction; liquidity and the Radar are read from the
     engines that already own them, so no two tabs can disagree. */
  let mandate=null;
  try{ mandate = (window.__BWMandateKey===pair+'|'+tf) ? (window.__BWMandate || null) : null; }catch(e){}
  let liq=null;
  /* Same source order as the Chart tab: the Assistant's published read
     (its fixed engine, on its longer merged history) when it is fresh and
     for this pair + timeframe; otherwise this page's copy of the same
     engine. It used to call liqRead(cd, pair, tf) — the pair landed in
     the timeframe slot. */
  try{
    const raw=JSON.parse(localStorage.getItem('bw-liquidity-now')||'null');
    if(raw && raw.pairs && (Date.now()-(+raw.t||0))<RISK_FRESH_MS){
      const hit = raw.pairs[brokerSym[pair]||pair] || raw.pairs[pair] ||
                  raw.pairs[Object.keys(raw.pairs).find(k=>prettyPair(k)===pair)||''];
      if(hit && hit.tf===tf && hit.cls!=='learn') liq = hit;
    }
  }catch(e){ liq=null; }
  try{ if(!liq && window.BWLiquidity && window.BWLiquidity.liqRead) liq = window.BWLiquidity.liqRead(cd, tf); }catch(e){ liq=null; }
  let forms=null;
  try{
    /* read() takes (patterns, candles, opts). This used to be called as
       read(candles, {symbol, timeframe}) — arguments in the wrong order —
       which threw on every call; the catch below turned that into null, so
       the combined read never received a single formation. When the chart
       tab is showing this same series its formations are reused, so the
       two tabs can never disagree; otherwise the same two engines run here. */
    if(window.BWFormations && window.BWFormations.read && window.BWChartPatterns){
      /* Compare the RAW series both tabs read. The chart stores SERIES[pair][tf]
         itself in CPV.cd; `cd` here is this tab's normalised COPY, so comparing
         against `cd` could never match — the formations were always computed a
         second time, on the same engine whose 2-bar lead memory both calls then
         moved, and the two tabs could lead with opposite shapes. */
      if(CPV && CPV.cd === rawCd && Array.isArray(CPV.forms)) forms = CPV.forms;
      else {
        const det = window.BWChartPatterns.detect(cd);
        forms = window.BWFormations.read((det && det.patterns) || [], cd, { pip: pipOf(pair) });
      }
      if(!Array.isArray(forms)) forms = null;
    }
  }catch(e){ forms=null; }
  const risk = (RISK && RISK[pair]) ? RISK[pair] : null;

  /* THE ASSISTANT'S PATTERN ALERTS. Same payload cpArrows reads, so a
     pattern the trader was alerted about is in the combined read too. */
  let alerts = null;
  try{
    const dd = (DATA[pair]||{})[tf];
    alerts = (dd && (dd.patterns || dd.candles_patterns)) || null;
    if(alerts && !Array.isArray(alerts)) alerts = null;
  }catch(e){ alerts = null; }

  /* THE ASSISTANT'S PATTERN ALERTS — a different endpoint from the one
     above, with a different shape. Fetched here and cached for 60s: this
     renderer runs every 5 seconds and the alert history changes far more
     slowly than that. Filtered to this pair and timeframe. */
  const raised = (CONF_ALERTS.rows || []).filter(a =>
    prettyPair(String(a.symbol||'')) === String(pair).toUpperCase() &&   /* any broker suffix, not only lowercase ones */
    String(a.timeframe||'').toUpperCase() === String(tf).toUpperCase());
  loadConfAlerts();

  /* Anything the tab could not have seen live: a candle gap, or alerts
     stamped inside an outage window. Reported, never silently dropped. */
  const feedGap = confFeedGap(cd, tf);
  /* Two different windows: bars that never arrived, and the period the
     alert endpoint was unreachable. Take the EARLIEST of them — taking
     the later one discarded the candle gap entirely and reported
     nothing missed. */
  const cands = [];
  if(feedGap && feedGap.from) cands.push(feedGap.from*1000);
  if(CONF_ALERTS.gapMs && CONF_ALERTS.recoveredAt)
    cands.push(CONF_ALERTS.recoveredAt - CONF_ALERTS.gapMs);
  let missedFrom = cands.length ? Math.min.apply(null, cands) : 0;
  /* Never look further back than a day — old history is not "missed".
     Measured from the NEWEST BAR, not the wall clock: when the feed has
     been down the two are not the same, and using the clock would throw
     away exactly the window we are trying to report on. */
  const refNow = (cd.length ? bwBarMs(cd[cd.length-1]) : 0) || Date.now();
  if(missedFrom && refNow - missedFrom > 24*3600*1000) missedFrom = refNow - 24*3600*1000;
  const missed = !missedFrom ? [] : raised.filter(a => {
    const t = a.time ? bwBarMs({t:a.time}) : 0;
    return isFinite(t) && t && t >= missedFrom;
  });

  let o;
  try{
    o = window.BWConfluence.read(cd, {
      pip: pipOf(pair), key: pair+'|'+tf, tf: tf,
      pullback: (window.__BWPullback && window.__BWPullback.key===pair+'|'+tf) ? window.__BWPullback.a : null,
      mandate: mandate, liquidity: liq, formations: forms, risk: risk,
      alerts: alerts, raised: raised,
      record: (function(){ try{ return RELLOGRAW.filter(x=>x.p===pair&&x.tf===tf&&relJudge(x)!=null)
                .map(x=>({n:x.n, dir:x.dir, v:relJudge(x)})); }catch(e){ return null; } })(),
      feedGap: feedGap, missed: missed, feedOk: CONF_ALERTS.ok
    });
  }catch(e){
    console.warn('[confluence]', e && e.message);
    el.innerHTML = '<div class="card"><div class="ct">The combined read</div>'+
      '<div class="mut" style="padding:4px 0">Could not complete the read on this pair.</div></div>';
    return;
  }

  /* the last full reading, for debugging a live screen */
  try{ window.__cfLast = o; window.__cfIn = {raised:raised.length, missed:missed.length,
        missedFrom:missedFrom, gap:!!feedGap, alerts:(alerts||[]).length}; }catch(e){}

  /* the reversal pressure is read BEFORE publishing, so the Brain gets it too */
  let PR = null;
  let RX = null; try{ RX = cfRsi(o, cd, pair, tf); }catch(e){ RX = null; }   /* one live RSI read, shared by the pressure and the Momentum row */
  try{ PR = readRevPressure(cd, o, alerts, raised, RX); window.__cfPressure = PR; }
  catch(e){ console.warn('[pressure]', e && e.message); }

  /* THE PRESSURE READING REPLACES THE OLD REVERSAL SIDE. The engine's
     pressure-led verdict (pressing / breaking / broken) is swapped for
     the level-touch reading; every other verdict is left exactly as is. */
  const prOn = PR && PR.state !== 'idle' && PR.state !== 'nolevels';
  /* TURN-TAKING: while a reversal is building (or has just broken / confirmed),
     the pressure reading has the floor and the other engines wait. */
  const prLead = prOn && (PR.state === 'live' || PR.state === 'early' || PR.state === 'earlybreak' || PR.state === 'broken' || PR.state === 'confirmed' || PR.state === 'failed' || PR.state === 'faded');
  window.__cfPrLead = prLead ? PR : null;
  if(prLead || o.pressureLed){
    if(prOn && (prLead || PR.state === 'atlevel')){ const hd = prHead(PR);
      o = Object.assign({}, o, {word: hd.w, line: hd.l, supports: [], contradictions: [], weakens: [],
        state: PR.state==='faded' ? 'quiet' : PR.state==='confirmed' ? 'broken' : PR.state==='broken'||PR.state==='early'||PR.state==='earlybreak' ? 'breaking' : PR.state==='failed' ? 'quiet' : 'pressing'}); }
    else o = Object.assign({}, o, {state:'quiet', supports:[], contradictions:[], weakens:[],
        word:'No reversal pressure at the levels',
        line:'Price is not at a major or medium level from the Levels tab, so there is nothing to read as a reversal. The '+
             ((o.frame&&o.frame.dir&&o.frame.dir!=='none')?o.frame.dir+'trend':'structure')+' stands as it is.'});
  }

  /* published for the Trading Brain and anything else that wants it */
  publishConfluence(o, cd, PR);
  try{ cfPublishPullback(window.__BWPullbackFinal, window.__BWPullback); }catch(e){}

  /* THE COMBINED READ v2 — what the tab now shows. Display only: everything
     above (and what was published) is unchanged. */
  let NR = null;
  try{
    const lvR = ((D()||{}).sr_levels || []).map(l => ({p:+l.price, lo:isFinite(+l.lo)?+l.lo:+l.price, hi:isFinite(+l.hi)?+l.hi:+l.price,
        role:String(l.type||'').toLowerCase().indexOf('res')>=0?'R':'S', tier:String(l.tier||'').toLowerCase()}))
      .filter(l => isFinite(l.p) && (l.tier==='major' || l.tier==='medium' || l.tier==='structural'));
    /* THE RANGE — detected by the SAME range engine the Retracement tab uses (BWRange).
       This read runs it itself, with the same inputs, so it never depends on the
       Retracement tab having rendered first. When that tab has just read the same pair
       and timeframe, its exact answer is used (the engine caches, so it is the same). */
    let RT = (window.__rtRangeKey===pair+'|'+tf) ? window.__rtRangeOut : undefined;
    if(RT===undefined && window.BWRange){
      try{ RT = window.BWRange.read({ candles:((SERIES[pair]||{})[tf])||[], symbol:brokerSym[pair]||pair, timeframe:tf,
             patterns:((D()||{}).patterns)||[],
             structureRange: !!(mandate && mandate.ok && !mandate.suspended && mandate.holder==='range'),
             pivots:(mandate && mandate.pivots) || null }); }catch(e){ RT = null; }
    }
    const rtOn = RT && RT.range && (RT.driving || RT.regime==='watching' || RT.regime==='range');
    const rangeIn = RT===undefined ? null : (rtOn ? {hi:RT.range.hi, lo:RT.range.lo, watching:RT.regime==='watching'} : {none:true});
    NR = window.BWRead2 ? window.BWRead2.read(cd, {key:pair+'|'+tf, pip:pipOf(pair), levels:lvR, trig:o.trig, rel:o.rel, range:rangeIn,
           msOf:bwBarMs, hourOf:bwBarHourUTC, fmt:p=>(+p).toFixed(digitsOf(pair))}) : null;
  }catch(e){ console.warn('[read2]', e && e.message); NR = null; }
  window.__cfRead2 = NR;
  try{ cfPublishRead2(NR, RX); }catch(e){}
}); };

  return {
    /* the exact statements loadPairs uses to read /api/state */
    setState: function(st){
      OPEN=((st.open_trades||st.openTrades||[])).map(normOpen).filter(Boolean);
      const syms=(st.watchlist||[]).map(w=>typeof w==='string'?w:(w&&w.symbol)).filter(Boolean);
      syms.forEach(sym=>{ const b=prettyPair(sym); brokerSym[b]=sym; if(PAIRS.indexOf(b)<0) PAIRS.push(b); });
    },
    load: function(b, t){ return loadPair(b, t); },
    loadRisk: function(){ loadRisk(); },
    pretty: function(sym){ return prettyPair(sym); },
    run: function(p, t){
      pair = p; tf = t || 'H1';
      var w = winFor(p);
      w.__cfLast = null;
      /* the page's own order each refresh: chart, retracement, Combined Read */
      makeChart(w)();
      makeRetrace(w)();
      makeConf(w)();
      return w.__cfLast || null;
    },
    /* the reading in the Pattern Detector's own published shape, keyed pair|tf */
    channel: function(){ try { return JSON.parse(PRIVATE['bw-confluence-now'] || 'null'); } catch (e) { return null; } },
    /* the formations, exactly as the chart tab publishes them (DEC-14) */
    formations: function(){ try { return JSON.parse(PRIVATE['bw-formations-now'] || 'null'); } catch (e) { return null; } },
    _state: function(){ return { SERIES:SERIES, DATA:DATA, RISK:RISK, OPEN:OPEN, CONF_ALERTS:CONF_ALERTS }; }
  };
}
root.BWCombinedRead = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
