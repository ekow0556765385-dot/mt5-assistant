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

/* THE TREND READING CANDLE BY CANDLE (Nov 2026), for the counter-trend check: for each of the last `back`
   closed bars, the regime this engine reached on that bar and the protected swing (HL in an uptrend, LH in
   a downtrend, the trend that just broke during a transition). Read-only; shares read()'s cache. */
function series(cdAll, opts, back){
  opts=opts||{}; const cd=cdAll.slice(0,-1), fmt=opts.fmt||(p=>(+p).toFixed(bwDG()));
  if(cd.length<LOOK+30 || !root.BWStructure) return [];
  const key=opts.key||'x';
  let M=MEMO[key]; if(!M||M.t0!==cd[0].t||Object.keys(M.sw).length>1500) M=MEMO[key]={t0:cd[0].t, sw:{}, reg:{}};
  const out=[];
  for(let k=Math.max(LOOK+5, cd.length-(back||60)); k<cd.length; k++){
    const g=regimeAt(cd,k,M,fmt), S=M.sw[cd[k].t]||swAt(cd,k,M);
    const r=g.regime==='uptrend'?'u':g.regime==='downtrend'?'d':g.regime==='range'?'r':'t';
    out.push({k, r, d:g.dir, hl:S.lastLow?S.lastLow.p:null, lh:S.lastHigh?S.lastHigh.p:null, e:g.eff});
  }
  return out;
}
root.BWRead2={read, confirmAt, longBar, series};
})(typeof window!=='undefined'?window:globalThis);
})();
/* BWChop, VERBATIM from patterns.html */
(function(root){
'use strict';

const H=c=>+(c.h!==undefined?c.h:c.high);
const L=c=>+(c.l!==undefined?c.l:c.low);
const C=c=>+(c.c!==undefined?c.c:c.close);

/* ── EDGES ────────────────────────────────────────────────────────
   Not the highest high and lowest low — those are single accidents. An
   edge is a level price has come back to and been turned away from more
   than once. Built by clustering the swing extremes: a level earns its
   place by being REVISITED, which is the whole difference between a
   boundary and a spike. */
function pivots(cd, k){
  const out=[];
  for(let i=k;i<cd.length-k;i++){
    let hi=true, lo=true;
    for(let j=i-k;j<=i+k;j++){
      if(j===i) continue;
      if(j<i?H(cd[j])>=H(cd[i]):H(cd[j])>H(cd[i])) hi=false;   /* flat pair: first bar is the pivot */
      if(j<i?L(cd[j])<=L(cd[i]):L(cd[j])<L(cd[i])) lo=false;
    }
    if(hi) out.push({i, p:H(cd[i]), type:'H'});
    if(lo) out.push({i, p:L(cd[i]), type:'L'});
  }
  return out;
}

function cluster(points, tol){
  const groups=[];
  points.slice().sort((a,b)=>a.p-b.p).forEach(pt=>{
    const g=groups.find(g=>Math.abs(g.level-pt.p)<=tol);
    if(g){ g.hits.push(pt); g.level=g.hits.reduce((s,x)=>s+x.p,0)/g.hits.length; }
    else groups.push({level:pt.p, hits:[pt]});
  });
  return groups;
}

function atrOf(cd, n){
  let s=0,k=0;
  for(let i=Math.max(1,cd.length-n); i<cd.length; i++){ s+=H(cd[i])-L(cd[i]); k++; }
  return k? s/k : 0;
}

function read(cd, opts){
  opts=opts||{};
  const n=cd.length;
  if(n<50) return {ok:false, why:'not enough bars to judge'};

  const look = Math.min(n, opts.lookback||140);
  const win  = cd.slice(n-look);
  const atr  = atrOf(cd, 14);
  const px   = C(cd[n-1]);
  const pip  = opts.pip || 0.0001;

  const hi=Math.max.apply(null,win.map(H));
  const lo=Math.min.apply(null,win.map(L));
  const height=hi-lo;
  if(!(height>0)) return {ok:false, why:'no range in the data'};

  /* ── 1. EDGES, and how many times each has held ─────────────── */
  const pv=pivots(win, 3);
  const tol=Math.max(atr*0.55, height*0.045);
  const highs=cluster(pv.filter(p=>p.type==='H'), tol).filter(g=>g.hits.length>=2);
  const lows =cluster(pv.filter(p=>p.type==='L'), tol).filter(g=>g.hits.length>=2);
  const upper = highs.sort((a,b)=>b.hits.length-a.hits.length || b.level-a.level)[0] || null;
  const lower = lows .sort((a,b)=>b.hits.length-a.hits.length || a.level-b.level)[0] || null;

  const edges = {
    upper: upper ? {level:upper.level, held:upper.hits.length} : null,
    lower: lower ? {level:lower.level, held:lower.hits.length} : null
  };

  /* ── 3. REJECTION RATE — the signal that actually separates ────
     An excursion beyond an edge that is given back is the definition of
     a boundary holding. Random data does this ~0% of the time; real chop
     does it ~99%. This is the engine's backbone, not a garnish. */
  const mid=(hi+lo)/2;
  let sweeps=0, rejected=0;
  const traps=[];
  const GIVE_BACK=3;                    // bars allowed to give it back
  for(let i=2;i<win.length-GIVE_BACK;i++){
    const beyondUp = edges.upper && H(win[i])>edges.upper.level+tol*0.3;
    const beyondDn = edges.lower && L(win[i])<edges.lower.level-tol*0.3;
    if(!beyondUp && !beyondDn) continue;
    sweeps++;
    const after=C(win[i+GIVE_BACK]);
    const back = beyondUp ? after < (edges.upper.level) : after > (edges.lower.level);
    if(back){
      rejected++;
      /* ── 5. TRAPS: it went beyond, took the liquidity, and came back.
         This is the specific thing that hurts a trader in chop — the
         breakout that was not one. Worth naming individually. */
      traps.push({
        at: n-look+i,
        side: beyondUp?'upper':'lower',
        level: beyondUp?edges.upper.level:edges.lower.level,
        reachedPips: Math.abs((beyondUp?H(win[i]):L(win[i])) - (beyondUp?edges.upper.level:edges.lower.level))/pip
      });
    }
  }
  const rejectRate = sweeps ? rejected/sweeps : null;

  /* time spent in the middle third — the second separating feature */
  const band=height*0.17;
  const visits = win.filter(c=>Math.abs(C(c)-mid)<band).length/win.length;

  /* ── 4. PHASE: compressing or expanding ──────────────────────────
     Compression precedes expansion, and that is the trade. Measured as
     the recent bar range against the older bar range, plus whether the
     swing extremes are narrowing. */
  const recent=atrOf(cd, 10), older=atrOf(cd.slice(0, Math.max(20, n-10)), 20);
  const ratio = older? recent/older : 1;
  const firstHalf=win.slice(0, Math.floor(win.length/2));
  const lastHalf =win.slice(Math.floor(win.length/2));
  const spanA=Math.max.apply(null,firstHalf.map(H))-Math.min.apply(null,firstHalf.map(L));
  const spanB=Math.max.apply(null,lastHalf.map(H))-Math.min.apply(null,lastHalf.map(L));
  const narrowing = spanA>0 ? spanB/spanA : 1;
  const phase = (ratio<0.75 && narrowing<0.8) ? 'compressing'
              : (ratio>1.3  || narrowing>1.25) ? 'expanding'
              : 'steady';

  /* ── 2. HEADING: which edge is price walking toward ──────────── */
  const back6 = C(cd[Math.max(0,n-6)]);
  const drift = px - back6;
  let heading=null;
  if(edges.upper && edges.lower){
    const toUp=(edges.upper.level-px)/pip, toDn=(px-edges.lower.level)/pip;
    heading = drift>0
      ? {edge:'upper', level:edges.upper.level, pips:Math.round(toUp), held:edges.upper.held}
      : drift<0
      ? {edge:'lower', level:edges.lower.level, pips:Math.round(toDn), held:edges.lower.held}
      : null;
  }

  /* ── 6. WHAT WOULD END IT ────────────────────────────────────────
     Chop ends when an edge is taken AND HELD — not when it is touched.
     The hold requirement is the same three bars the pattern lifecycle
     uses, so the platform speaks with one voice about what a break is. */
  const ending = (edges.upper && edges.lower) ? {
    above: edges.upper.level,
    below: edges.lower.level,
    holdBars: GIVE_BACK,
    note:'A close beyond either edge that holds '+GIVE_BACK+' bars ends this. '+
         'Touching it is not enough — that has happened '+sweeps+' times already and been given back '+
         rejected+' of them.'
  } : null;

  /* ── IS THIS ACTUALLY CHOP? ──────────────────────────────────────
     Only claimed when the separating features say so. Deliberately does
     NOT use efficiency, which was measured as useless for this. */
  const hasEdges = !!(edges.upper && edges.lower);
  const isChop = hasEdges && sweeps>=2 && rejectRate!=null && rejectRate>=0.6 && visits<0.45;
  const confidence = !isChop ? 0
    : Math.min(0.95, 0.45 + (rejectRate-0.6)*0.9 + Math.min(0.2,(sweeps-2)*0.04));

  return {
    ok:true, isChop, confidence:+confidence.toFixed(2),
    edges, heading, phase, ending, traps,
    rejectRate: rejectRate==null?null:+rejectRate.toFixed(2),
    sweeps, visits:+visits.toFixed(2),
    compression:{ratio:+ratio.toFixed(2), narrowing:+narrowing.toFixed(2)},
    height, hi, lo, mid,
    why: !hasEdges ? 'no level has been revisited enough to be an edge'
       : sweeps<2 ? 'the edges have not been tested enough times to judge'
       : rejectRate<0.6 ? 'excursions beyond the edges are not being given back — this is not containment'
       : visits>=0.45 ? 'price is sitting in the middle rather than working the edges'
       : 'edges are holding and excursions are being given back'
  };
}

/* ── CALIBRATION, INSIDE THE ENGINE ───────────────────────────────
   Part of the engine, not a separate test, so a feature that stops
   discriminating is caught here rather than quietly becoming decoration.
   Returns how often this engine claims chop on pure random walks. Any
   number above a few per cent means the thresholds are too loose. */
function calibrate(runs, bars){
  runs=runs||200; bars=bars||220;
  function rnd(seed){let s=seed;return()=>{s^=s<<13;s>>>=0;s^=s>>17;s^=s<<5;s>>>=0;return s/4294967296;};}
  let claimed=0, conf=0;
  for(let k=1;k<=runs;k++){
    const r=rnd(k*97); const F=[]; let px=1.085;
    for(let i=0;i<bars;i++){ px+=(r()-0.5)*0.0016;
      F.push({t:i,o:px-0.0002,h:px+0.0009,l:px-0.0009,c:px,v:900}); }
    const out=read(F,{});
    if(out.ok && out.isChop){ claimed++; conf+=out.confidence; }
  }
  return {runs, claimedChop:claimed, falseRate:+(claimed/runs).toFixed(3),
          avgConfidenceWhenWrong: claimed?+(conf/claimed).toFixed(2):0};
}

root.BWChop={read, calibrate, pivots, cluster};
})(typeof window!=='undefined'?window:globalThis);
/* BWDrift, VERBATIM from patterns.html */
(function(root){
'use strict';

const H=c=>+(c.h!==undefined?c.h:c.high);
const L=c=>+(c.l!==undefined?c.l:c.low);
const C=c=>+(c.c!==undefined?c.c:c.close);

function atr(cd,n){ let s=0,k=0;
  for(let i=Math.max(1,cd.length-n);i<cd.length;i++){ s+=H(cd[i])-L(cd[i]); k++; }
  return k?s/k:0; }

function pivots(cd,k){
  const out=[];
  for(let i=k;i<cd.length-k;i++){
    let hi=true, lo=true;
    for(let j=i-k;j<=i+k;j++){ if(j===i) continue;
      if(j<i?H(cd[j])>=H(cd[i]):H(cd[j])>H(cd[i])) hi=false;   /* flat pair: first bar is the pivot */
      if(j<i?L(cd[j])<=L(cd[i]):L(cd[j])<L(cd[i])) lo=false; }
    if(hi) out.push({i,p:H(cd[i]),type:'H'});
    if(lo) out.push({i,p:L(cd[i]),type:'L'});
  }
  return out;
}

function read(cd, opts){
  opts=opts||{};
  const n=cd.length;
  if(n<60) return {ok:false, why:'not enough bars'};
  const pip=opts.pip||0.0001;
  const look=Math.min(n, opts.lookback||220);
  const win=cd.slice(n-look);
  const px=C(cd[n-1]);
  const a=atr(cd,14);
  const hi=Math.max.apply(null,win.map(H)), lo=Math.min.apply(null,win.map(L));
  const height=hi-lo;
  if(!(height>0)) return {ok:false, why:'no range in the data'};

  /* ── 3. DRIFT: going somewhere slowly, or truly nowhere ──────────
     Net displacement against the distance actually travelled. A market
     with nothing holding can still be drifting — and drifting is worth
     knowing about, because it is the difference between "stand aside"
     and "there is a slow bias here". */
  const c=win.map(C);
  const net=c[c.length-1]-c[0];
  let path=0; for(let i=1;i<c.length;i++) path+=Math.abs(c[i]-c[i-1]);
  const eff = path? net/path : 0;
  const drift = Math.abs(eff)<0.04 ? 'nowhere'
              : eff>0 ? 'drifting up' : 'drifting down';

  /* ── 1. PASS-THROUGH ─────────────────────────────────────────────
     Take every swing level price has made, then count how many of them
     price later walked straight through without turning. A level that
     is passed through is not a level — and when almost all of them are,
     there is nothing in this market being defended. This is the
     measurement that defines the state. */
  const pv=pivots(win,3);
  let respected=0, passed=0;
  const HOLD=3;
  pv.forEach(function(p){
    /* FIRST ATTEMPT WAS WRONG, twice over:
       it broke on the first touch, so most levels were never judged at
       all (it claimed only 1% of random walks); and it counted a trend
       walking away from old levels as "passing through", so it fired on
       a clean uptrend, which is exactly the market it must stay out of.
       The right question is simpler: after this level formed, did price
       close on BOTH sides of it? A level price ends up on both sides of
       was not defended. A level it approached and turned away from was. */
    let above=false, below=false, approached=false, turned=false;
    for(let i=p.i+4;i<win.length;i++){
      const cl=C(win[i]);
      if(cl>p.p+a*0.15) above=true;
      if(cl<p.p-a*0.15) below=true;
      if(!approached && Math.abs(cl-p.p)<a*0.45 && i<win.length-HOLD){
        approached=true;
        const from = C(win[i-1])>p.p ? 1 : -1;
        const after = C(win[i+HOLD]);
        if(from>0 ? after>p.p : after<p.p) turned=true;
      }
    }
    if(above && below) passed++;
    else if(approached && turned) respected++;
  });
  const tested=respected+passed;
  const passRate = tested? passed/tested : null;

  /* ── 2. VOLATILITY, and whether it is unusual for this pair ──────
     An ATR number alone means nothing to a trader. What matters is
     whether today is calm or wild FOR THIS PAIR, so it is expressed as
     a percentile against the pair's own recent history. */
  const ranges=[];
  for(let i=Math.max(1,n-500);i<n;i++) ranges.push(H(cd[i])-L(cd[i]));
  ranges.sort((x,y)=>x-y);
  const pctl = ranges.length ? ranges.filter(r=>r<a).length/ranges.length : 0.5;
  const volWord = pctl>=0.75?'unusually wide' : pctl<=0.25?'unusually quiet' : 'ordinary';

  /* ── 4. WHERE PRICE ACTUALLY SITS ────────────────────────────────
     The band containing most of the closes. In a market with no levels,
     this is the one thing that IS true about where price lives — and it
     tells a trader whether they are buying high or low within it. */
  const sorted=c.slice().sort((x,y)=>x-y);
  const q=(f)=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*f))];
  const vLo=q(0.15), vHi=q(0.85);
  const wherePx = px>vHi ? 'above' : px<vLo ? 'below' : 'inside';

  /* ── 5. IS ANYTHING STARTING TO GET DEFENDED ─────────────────────
     The first sign this state is ending. A level that has been touched
     twice recently and held both times is the seed of a real level.
     Reported early, because the value of this engine is telling a
     trader WHEN to start paying attention again. */
  const recent=pv.filter(p=>p.i>win.length-70);
  const tol=Math.max(a*0.5, height*0.04);
  const groups=[];
  recent.forEach(function(p){
    const g=groups.find(g=>Math.abs(g.level-p.p)<=tol);
    if(g){ g.hits.push(p); g.level=g.hits.reduce((s,x)=>s+x.p,0)/g.hits.length; }
    else groups.push({level:p.p, hits:[p], type:p.type});
  });
  const forming=groups.filter(g=>g.hits.length>=2)
    .sort((x,y)=>y.hits.length-x.hits.length)
    .slice(0,2)
    .map(g=>({level:g.level, touches:g.hits.length, type:g.type,
              pipsAway: Math.round(Math.abs(px-g.level)/pip)}));

  /* ── 6. WHAT WOULD CHANGE THIS ───────────────────────────────────
     Concrete, not philosophical: a level has to be tested and held. The
     same three-bar hold the rest of the platform uses for a break, so
     Blackwood speaks with one voice about what "held" means. */
  const changeIt = forming.length
    ? 'The level at '+forming[0].level.toFixed(opts.dp||5)+' has been touched '+
      forming[0].touches+' times. One more touch that holds '+HOLD+
      ' bars would make it a real level, and this state would be over.'
    : 'No level has been touched twice yet. Until one is, there is nothing here to trade against.';

  /* ── IS THIS THE STATE? ──────────────────────────────────────────
     Claimed only when levels are genuinely being passed through. If
     price is respecting its levels, this is not the engine for it —
     one of the other three is. */
  /* A TREND ALSO WALKS THROUGH ITS OLD LEVELS — that is what a trend
     IS. The difference is that a trend is going somewhere. Requiring the
     market to be directionless is what keeps this engine out of the
     market the pullback engine owns. */
  const directionless = Math.abs(eff) < 0.12;
  const nothingHolding = tested>=3 && passRate!=null && passRate>=0.55 && directionless;

  return {
    ok:true, nothingHolding,
    confidence: nothingHolding ? Math.min(0.92, 0.5+(passRate-0.55)*0.9) : 0,
    levelsTested:tested, passedThrough:passed, respected:respected,
    passRate: passRate==null?null:+passRate.toFixed(2),
    volatility:{atr:a, percentile:+pctl.toFixed(2), word:volWord},
    drift, efficiency:+eff.toFixed(3),
    value:{lo:vLo, hi:vHi, where:wherePx},
    forming, changeIt,
    hi, lo, height,
    why: tested<3 ? 'not enough levels have been tested to judge'
       : passRate<0.55 ? 'price is respecting its levels — another engine owns this'
       : !directionless ? 'levels are being left behind, but price is going somewhere — this is a trend, not drift'
       : 'price is walking straight through '+Math.round(passRate*100)+'% of its own levels'
  };
}

root.BWDrift={read, pivots};
})(typeof window!=='undefined'?window:globalThis);
/* BWHistorian, VERBATIM from patterns.html */
(function(){
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
    /* Once per bar, not once per render. The page redraws on every poll,
       zoom and pan; counting those aged trends, levels and claims many
       times faster than the market. */
    const bk=(typeof bwBarMs==='function'?bwBarMs(cd[cd.length-1]):NaN);
    const barId=isFinite(bk)&&bk?bk:cd.length;
    if(S.lastBarId===barId) return context();
    S.lastBarId=barId;
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
    /* ── THE EXTREME DOES NOT NEED A LIVE TREND SPELL ───────────────
       This was gated on `S.trend`, which only exists while the regime
       reads uptrend or downtrend. Measured on real data: across six
       windows of EUR/USD H4, five read `transition` and produced NO
       frozen line at all. Open the tab during a transition — which is
       most of the time — and the line simply never appeared. That is why
       he could not see it after two attempts at drawing it.
       The LL that defines a downtrend is a fact about the swing labels,
       and those exist whatever the regime is called this bar. A pullback
       reads as `transition`, and a pullback is precisely when the trader
       needs to see the level the trend is defending. So the direction
       comes from the trend spell when there is one, and from the
       structure's own reading when there is not. */
    /* `read.dir` is also 0 in a transition, so falling back to it changed
       nothing — still one window in eight. The labels themselves carry
       the answer: the most recent LL or HH IS the extreme in question,
       and which of the two came last tells you which side the market has
       been working. That exists whatever the regime is called. */
    let fdir = S.trend ? S.trend.dir : (read.dir || 0);
    if(fdir===0){
      for(let i=marked.length-1; i>=0; i--){
        if(marked[i].label==='LL'){ fdir=-1; break; }
        if(marked[i].label==='HH'){ fdir= 1; break; }
      }
    }
    if(fdir!==0){
      const want = fdir<0 ? 'LL' : 'HH';
      const ext = marked.filter(q=>q.label===want).slice(-1)[0];
      if(ext && (!S.frozen || S.frozen.dir!==fdir ||
                 (fdir<0 ? ext.p < S.frozen.price - tol*0.2
                         : ext.p > S.frozen.price + tol*0.2))){
        /* a NEW extreme replaces the frozen one and resets the sequence —
           the trend went further, so the old question is void */
        S.frozen = {price:ext.p, label:want, dir:fdir, at:S.bars,
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
          /* Two CLOSED bars beyond, not the bar that has just opened. A
             single tick through the level stamped "reversed" for good and
             overrode the pullback verdict on a break that had not held. */
          const n=cd.length, c1=n>2?C(cd[n-2]):NaN, c2=n>3?C(cd[n-3]):NaN;
          const beyond=v=> S.frozen.dir<0 ? v > dec.priceRaw : v < dec.priceRaw;
          const brokeIt = isFinite(c1) && isFinite(c2) && beyond(c1) && beyond(c2);
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
          say:'Price retraced from the '+S.frozen.label+' at '+S.frozen.price.toFixed(bwDG())+
              ', then broke the '+dec.kind+' at '+dec.price.toFixed(bwDG())+
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
        if(dec) s+='. The level that would end it is '+dec.price.toFixed(bwDG())+
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
  var winByPair = {};
  var winFor = function(p){                                   /* real engines, this pair's own formations; the window is KEPT per pair (Nov 2026) so the historian remembers between runs, as on the page */
    var w = winByPair[p] || (winByPair[p] = Object.create(root));
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

let bwRenewAsked=0, lastGood=Date.now();

function bwAskRenew(){
  if(Date.now()-bwRenewAsked<60000) return; bwRenewAsked=Date.now();
  try{ if(window.parent && window.parent!==window) window.parent.postMessage({bw:'renew'}, location.origin); }catch(e){}
}

let RELLOGRAW=[];

function relJudge(x){ return (x.tf==='H4'||x.tf==='D1') ? x.h4 : x.h1; }

function bwDG(){ try{ return (typeof pair!=='undefined' && pair) ? digitsOf(pair) : 5; }catch(e){ return 5; } }

function liqBarMs(c){
  if(!c) return null; const v=c.t!=null?c.t:(c.time!=null?c.time:c.timestamp); if(v==null) return null;
  if(typeof v==='number'||/^\d+(\.\d+)?$/.test(String(v))){ const n=+v; return n<1e12?n*1000:n; }
  const m=Date.parse(String(v).replace(/\./g,'-').replace(' ','T')+(/Z|[+-]\d\d:?\d\d$/.test(String(v))?'':'Z')); return isFinite(m)?m:null; }

function liqFromAssistant(pr, tfx, cd){
  const raw=JSON.parse(localStorage.getItem('bw-liquidity-now')||'null');
  if(!raw || !raw.pairs || (Date.now()-(+raw.t||0))>=RISK_FRESH_MS) return null;
  const hit = raw.pairs[brokerSym[pr]||pr] || raw.pairs[pr] || raw.pairs[Object.keys(raw.pairs).find(k=>prettyPair(k)===pr)||''];
  if(!hit) return null;
  const r = (hit.byTf && hit.byTf[tfx]) || (hit.tf===tfx ? hit : null);
  if(!r) return null;
  const mine = cd && cd.length>1 ? liqBarMs(cd[cd.length-2]) : null;     /* this page's last closed candle */
  if(r.barT!=null && mine!=null && r.barT < mine) return null;            /* we are ahead: read our own */
  return r;
}

function cpFastOk(p, cd){
  try{
    if(!window.BWBreakConfirm) return false;
    let liq=null;
    try{ liq=liqFromAssistant(pair, tf, cd); }catch(e){}
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

function prMemLoad(part){
  try{ const m = JSON.parse(localStorage.getItem('bw-pr-mem')||'null'); const o = m && m[part];
    if(!o || typeof o !== 'object') return {};
    Object.keys(o).forEach(k => { const v = o[k]; const t = v && (v.doneT || v.endT || v.t0 || v.t); if(!t || Date.now() - t > 3*864e5) delete o[k]; });
    return o; }catch(e){ return {}; }
}

function prMemSave(){ try{ localStorage.setItem('bw-pr-mem', JSON.stringify({lock:PR_LOCK, ep:PR_EP, t:Date.now()})); }catch(e){} }

function bwLadder(cd, k, last, lv, dir, X){
  /* X: { tol, dom(j) -> {side, share, w}, pats(j) -> [{name,dir,conf}], rsi[], forming:{o,h,l,c,p} } */
  const beyond = c => dir > 0 ? c.c < lv.lo : c.c > lv.hi;            /* closed through the level */
  const inZone = c => dir > 0 ? c.l <= lv.hi + X.tol : c.h >= lv.lo - X.tol;
  const SHIFT = dir > 0 ? ['Sellers easing off', 'Buyers stepping in'] : ['Buyers easing off', 'Sellers stepping in'];
  const against = c => dir > 0 ? c.c < c.o : c.c > c.o;
  const rsiWith = j => X.rsi && X.rsi[j] != null && X.rsi[j-3] != null && (dir > 0 ? X.rsi[j] > X.rsi[j-3] : X.rsi[j] < X.rsi[j-3]);
  /* the lines: the last two swing highs (lows for a turn down) before the touch, 2 candles each side */
  const sw = []; for(let j = k-2; j >= Math.max(2, k-80) && sw.length < 6; j--){ const x = cd[j];
    const isSw = dir > 0 ? (x.h > cd[j-1].h && x.h > cd[j-2].h && x.h >= cd[j+1].h && x.h >= cd[j+2].h)
                         : (x.l < cd[j-1].l && x.l < cd[j-2].l && x.l <= cd[j+1].l && x.l <= cd[j+2].l);
    if(isSw) sw.push({j, p: dir > 0 ? x.h : x.l}); }
  const EL = sw[0] ? sw[0].p : null, ELj = sw[0] ? sw[0].j : -1;
  const fs_ = sw.find(s => dir > 0 ? s.p > EL : s.p < EL) || {}, FL = fs_.p ?? null, FLj = fs_.j ?? -1;
  const d0 = X.dom(k-1);
  const L = { step:2, coming:d0, classic: !!d0 && d0.side === -dir, log:[], EL, FL, ELj, FLj, reclaimed:false, reclaimAt:-1,
              pending:false, trig:-1, trigP:null, fol:-1, missed:null, shiftAt:-1, early:false, full:false, ended:null, at:{} };
  const log = (j, s, w) => L.log.push({j, s, w});
  log(k, 2, 'touch');
  let eB = 0, fB = 0;
  for(let j = k; j <= last && !L.ended; j++){ const c = cd[j];
    /* Step 2's break rule applies at every step */
    if(beyond(c)){
      if(L.pending){ L.ended = 'broken'; log(j, 2, 'broken'); break; }
      L.pending = true; L.step = 2; L.trig = -1; L.trigP = null; log(j, 2, 'closed through'); continue; }
    if(L.pending){ L.pending = false; L.reclaimed = true; L.reclaimAt = j; L.step = 3; log(j, 3, 'reclaimed'); }
    if(L.step === 2){ L.step = 3; }
    if(L.step === 3){ const d = X.dom(j); if(d && SHIFT.includes(d.w)){ L.step = 4; L.shiftAt = j; L.shiftW = d.w; log(j, 4, 'shift'); } }
    if(L.step === 4){
      const p = (X.pats(j) || []).filter(q => q.dir === dir && q.conf >= 70).sort((a,b) => b.conf - a.conf)[0];
      if(p){ L.step = 5; L.trig = j; L.trigP = p; L.log.push({j, s:5, w:'trigger', p}); continue; }
      if(j > L.shiftAt){ const d = X.dom(j); if(against(c) || !(d && SHIFT.includes(d.w))){ L.step = 3; log(j, 3, against(c) ? 'weak close' : 'pill changed'); } }
      continue; }
    if(L.step === 5 && j === L.trig + 1){
      if((dir > 0 ? c.c > cd[L.trig].c : c.c < cd[L.trig].c) && !inZone(c)){ L.step = 6; L.fol = j; log(j, 6, 'follow-through'); }
      else { L.missed = {j, p: L.trigP}; L.trig = -1; L.trigP = null; L.step = 4; log(j, 4, 'no follow-through (retest)'); }
      continue; }
    if(L.step === 6){
      const pastE = EL != null && (dir > 0 ? c.c > EL : c.c < EL), pastF = FL != null && (dir > 0 ? c.c > FL : c.c < FL);
      eB = pastE ? eB + 1 : 0; fB = pastF ? fB + 1 : 0;
      if(!L.early && eB >= 2 && rsiWith(j)){ L.early = true; L.at.early = j; log(j, 6, 'early'); }
      if(!L.full && fB >= 2 && rsiWith(j)){ L.full = true; L.at.full = j; L.ended = 'confirmed'; log(j, 6, 'confirmed'); break; }
    }
    if(j - k >= 24 && !L.early){ L.ended = 'faded'; log(j, L.step, 'faded'); break; }
    if(j - k >= 48){ L.ended = 'early only'; log(j, L.step, 'early only'); break; }
  }
  return L;
}

function prDomPush(b,a){ const r=b.h-b.l; if(!(r>0)||!(a>0)) return {b:0,s:0,dir:0,size:0}; const body=Math.abs(b.c-b.o),dir=b.c>b.o?1:b.c<b.o?-1:0,lw=Math.min(b.o,b.c)-b.l,uw=b.h-Math.max(b.o,b.c);
  let B=0.3*lw/a,S=0.3*uw/a; const size=body/a; if(body>=0.1*r){ if(dir>0) B+=size*(0.5+0.5*(b.c-b.l)/r); else S+=size*(0.5+0.5*(b.h-b.c)/r); } return {b:B,s:S,dir:body>=0.1*r?dir:0,size}; }

function prDomShare(cd,f,t,a,w){ let B=0,S=0; const m=t-f+1; for(let i=f;i<=t;i++){ const p=prDomPush(cd[i],a), ww=w?0.5+0.5*(i-f)/Math.max(1,m-1):1; B+=p.b*ww; S+=p.s*ww; } return B+S>0?B/(B+S):0.5; }

function prDomAt(cd,e){ const s=e-23; if(s<1||e>=cd.length) return null; let a=0; for(let i=Math.max(1,e-13);i<=e;i++) a+=Math.max(cd[i].h-cd[i].l,Math.abs(cd[i].h-cd[i-1].c),Math.abs(cd[i].l-cd[i-1].c)); a/=Math.min(14,e);
  const sh=prDomShare(cd,s,e,a,true), shE=prDomShare(cd,s,e-6,a,false), shR=prDomShare(cd,e-5,e,a,false);
  const avg=x=>x.length?x.reduce((p,q)=>p+q,0)/x.length:0, bE=[],bR=[],sE=[],sR=[];
  for(let i=s;i<=e;i++){ const p=prDomPush(cd[i],a); if(p.dir>0)(i>e-6?bR:bE).push(p.size); else if(p.dir<0)(i>e-6?sR:sE).push(p.size); }
  const side=sh>=0.58?1:sh<=0.42?-1:0, lead=side||(shE>=0.55?1:shE<=0.45?-1:0); let w;
  if(lead===1) w=1-shR>=0.55?'Sellers stepping in':(shR<=shE-0.12||(avg(bE)>0&&bR.length&&avg(bR)<0.7*avg(bE)))?'Buyers easing off':shR>=shE+0.10?'Buyers pressing harder':'Buyers holding';
  else if(lead===-1) w=shR>=0.55?'Buyers stepping in':((1-shR)<=(1-shE)-0.12||(avg(sE)>0&&sR.length&&avg(sR)<0.7*avg(sE)))?'Sellers easing off':(1-shR)>=(1-shE)+0.10?'Sellers pressing harder':'Sellers holding';
  else w=shR>=0.62?'Buyers stepping in':shR<=0.38?'Sellers stepping in':'Neither side pressing';
  return {side,share:sh,w}; }

function prPatMap(cd, alerts, raised){ const n=cd.length, m={}, add=(i,name,dir,conf)=>{ if(i<1||i>n-2||!dir||!(conf>=70)) return; const L=(m[i]=m[i]||[]); if(!L.some(x=>x.name===name&&x.dir===dir)) L.push({name,dir,conf:Math.round(conf)}); };
  const dirOf=q=>{ const t=String(q.type||q.direction||'').toLowerCase()+' '+String(q.name||'').toLowerCase(); return t.indexOf('bear')>=0?-1:t.indexOf('bull')>=0?1:0; };
  const confOf=q=>q.confidence_pct!=null?+q.confidence_pct:q.confidence!=null?+q.confidence:0;
  (alerts||[]).forEach(q=>{ const bi=q.bar_index!=null?+q.bar_index:null; if(bi>=1) add(n-1-bi, q.full_name||q.name||q.type, dirOf(q), confOf(q)); });
  try{ ((D()||{}).patterns||[]).forEach(q=>{ const bi=q.bar_index!=null?+q.bar_index:null; if(bi>=1) add(n-1-bi, q.full_name||q.name, dirOf(q), confOf(q)); }); }catch(e){}
  (raised||[]).forEach(a=>{ const i=prBarOf(cd, a.time?bwBarMs({t:a.time}):(+a.ts||0)); add(i, a.name||a.type, dirOf(a), confOf(a)); });
  return m; }

function prTrack(P, alerts, raised){
  const cd=P.cd, n=cd.length, last=n-2, f=cd[n-1], bull=!P.bear, dir=bull?1:-1, lv=P.level, F=P.F;
  let ar=0; for(let i=Math.max(1,n-16);i<n-1;i++) ar+=cd[i].h-cd[i].l; ar/=Math.min(15,n-2); const tol=ar*0.35;
  const pip=pipOf(pair), lw=lv.trend?(bull?'low':'high'):(bull?'support':'resistance');
  const ti=P.touchI!=null?P.touchI:P.ti; if(ti==null||ti>last) return null;
  const atLv=b=>bull?b.l<=lv.hi+tol:b.h>=lv.lo-tol, beyond=b=>bull?b.c<lv.lo:b.c>lv.hi, fromLv=b=>bull?(b.c-lv.hi)/ar:(lv.lo-b.c)/ar;
  const path=[{i:ti,c:'touch',w:'Touched the '+lw+' at '+F(lv.p)}];
  let ext=bull?Infinity:-Infinity, best=0, bestI=null, away=false, everAway=false, ret=0, thru=0, broke=false, reclaimed=false, reclaimI=-1, far=0, farI=null;
  for(let i=ti;i<=last;i++){ const b=cd[i];
    if(bull?b.l<ext:b.h>ext){ ext=bull?b.l:b.h; if(i>ti) path.push({i,c:'one',w:'New '+(bull?'low':'high')+' inside the zone at '+F(ext)}); }
    const d=(b.c-lv.p)*dir; if(d>far){ far=d; farI=i; }
    const was=thru; thru=beyond(b)?thru+1:0;
    if(thru>=2){ broke=true; path.push({i,c:'brk',w:'Second close '+(bull?'below':'above')+' in a row · the '+lw+' has broken'}); break; }
    if(thru===1){ away=false; path.push({i,c:'one',w:'Closed '+(bull?'below':'above')+' the '+lw+' · <b>watching for the reclaim</b>'}); continue; }
    if(was===1){ reclaimed=true; reclaimI=i; path.push({i,c:'ret',w:'<b>Reclaimed</b> · closed back '+(bull?'above':'below')+' it (a sweep)'}); }
    const off=bull?(b.c-ext)/ar:(ext-b.c)/ar, lvOff=fromLv(b);
    if(away&&lvOff<0.25&&atLv(b)){ ret++; away=false; path.push({i,c:'ret',w:'<b>Back at the '+lw+'</b> · retest '+ret+' · closed '+(bull?'above':'below')+' it, still standing'}); continue; }
    if(off>best+0.05&&off>=0.5){ best=off; bestI=i; }
    if(lvOff>=0.5&&off>=0.5&&bestI===i){ const prev=path[path.length-1];
      if(!away){ away=true; everAway=true; path.push({i,c:'away',w:(ret||reclaimed?'Moving away again':'Moved away')+' · '+off.toFixed(1)+' average candles'}); }
      else if(prev.c==='far'){ prev.i=i; prev.w='Furthest so far · '+off.toFixed(1)+' average candles'; }
      else path.push({i,c:'far',w:'Furthest so far · '+off.toFixed(1)+' average candles'}); }
    else if(lvOff>=0.5&&!away){ away=true; everAway=true; path.push({i,c:'away',w:(ret||reclaimed?'Moving away again':'Moved away')+' · '+off.toFixed(1)+' average candles'}); } }
  const lb=cd[last], cur=fromLv(lb), fOff=fromLv(f), pending=thru===1&&!broke, retest=!pending&&ret>=1&&atLv(lb)&&cur<0.25;
  let fw; if(beyond(f)) fw=(bull?'Closing below':'Closing above')+' the '+lw+' so far · one close would not be a break';
  else if(fOff<0.3) fw='At the '+lw+' · '+(retest?'still testing it':everAway?'coming back to it':'not turned off it yet');
  else fw=(retest?'Pulling away again':'Moving away')+' · '+fOff.toFixed(1)+' average candles '+(bull?'above':'below')+' the '+lw;
  /* the ladder, on the closed candles */
  let L=null; try{ const closed=cd.slice(0,n-1), pm=prPatMap(cd,alerts,raised);
    L=bwLadder(closed, ti, last, lv, dir, {tol, dom:j=>prDomAt(closed,j), pats:j=>pm[j]||[], rsi:prRsi(closed)}); }catch(e){ console.warn('[ladder]', e && e.message); }
  /* the forming candle's live patterns, as the live candle watch reads them (EA live read, Assistant back-up) */
  let formPats=[]; try{ const prim=(alerts||[]).filter(a=>a&&a.bar_index!=null&&+a.bar_index===0), back=((((DATA[pair]||{})[tf]||{}).forming_patterns)||[]);
    formPats=(prim.length?prim:back).map(q=>{ const t=String(q.type||q.direction||'').toLowerCase()+' '+String(q.name||'').toLowerCase();
      return {name:q.full_name||q.name||q.type, dir:t.indexOf('bear')>=0?-1:t.indexOf('bull')>=0?1:0, conf:Math.round(q.confidence_pct!=null?+q.confidence_pct:+q.confidence||0)}; }); }catch(e){}
  return {formPats, ti, last, f, ar, tol, pip, lw, path, best, bestI, far, farI, cur, fOff, fw, ret, pending, retest, reclaimed, reclaimI, everAway, L,
          pipsOf:v=>Math.abs(v)/pip}; }

var CX_ENDED = ['resumed','resumed1','lapsed','confirmed','repaired','ranged','faded'];

function cxEnded(ep){ return !!ep && CX_ENDED.indexOf(ep.state) >= 0; }

var CX_MEM = null;

function cxMemLoad(){ try{ return JSON.parse(localStorage.getItem('bw-cx-mem')||'null') || {}; }catch(e){ return {}; } }

function cxMem(){ if(!CX_MEM) CX_MEM = cxMemLoad(); return CX_MEM; }

function cxRec(){ const m = cxMem(), k = pair+'|'+tf; return m[k] || (m[k] = {cands:{}, eng:{}, watch:null, out:null, alerts:[], seen:0}); }

function cxOffset(){
  let st = null; try{ st = JSON.parse(localStorage.getItem('bw-srv-offset')||'null'); }catch(e){}
  try{
    const h1 = ((SERIES[pair]||{}).H1) || [], last = h1[h1.length-1], t = last ? bwBarMs(last) : NaN;
    if(isFinite(t)){
      const now = Date.now(), hr = Math.floor(now/36e5)*36e5, off = Math.round((t - hr)/36e5);
      if(off >= -12 && off <= 14 && Math.abs(t - (hr + off*36e5)) < 1000){
        /* a new value has to be seen twice, 10 minutes apart, so one stale feed cannot move it */
        if(!st || st.h === off){ st = {h:off, at:now}; }
        else if(st.cand === off && now - st.candAt >= 6e5){ st = {h:off, at:now}; }
        else if(st.cand !== off){ st.cand = off; st.candAt = now; }
        localStorage.setItem('bw-srv-offset', JSON.stringify(st));
      }
    }
  }catch(e){}
  return st && isFinite(st.h) ? st.h : null;
}

var CX_REV = ['hammer','inverted hammer','bullish engulfing','piercing','morning star','three white soldiers','bullish harami','tweezer bottom',
  'dragonfly doji','bullish counterattack','shooting star','hanging man','bearish engulfing','dark cloud','evening star','three black crows',
  'bearish harami','tweezer top','gravestone doji','bearish counterattack','engulfing','harami','tweezer','counterattack','star','soldiers','crows'];

var CX_NOT = ['marubozu','methods','tasuki','spinning','high wave','long-legged'];

function cxRevDir(a){
  const nm = String(a.name || a.pattern || a.type || '').toLowerCase().replace(/\bbull\b/g,'bullish').replace(/\bbear\b/g,'bearish');
  if(!nm || CX_NOT.some(k => nm.indexOf(k) >= 0)) return 0;
  if(nm === 'doji') return 0;
  const ty = String(a.type || a.direction || '').toLowerCase() + ' ' + nm;
  const d = ty.indexOf('bull') >= 0 ? 1 : ty.indexOf('bear') >= 0 ? -1 :
            /hammer|morning|piercing|soldiers|dragonfly/.test(nm) && !/inverted|hanging/.test(nm) ? 1 :
            /shooting|evening|dark cloud|crows|gravestone|hanging/.test(nm) ? -1 : /inverted hammer/.test(nm) ? 1 : 0;
  if(!d) return 0;
  return CX_REV.some(k => nm.indexOf(k) >= 0) || /bullish|bearish/.test(nm) ? d : 0;
}

function cxConf(a){ const c = a.confidence_pct != null ? +a.confidence_pct : a.confidence != null ? +a.confidence : 0; return isFinite(c) ? c : 0; }

function cxCollect(cd, alerts, raised){
  const rec = cxRec(), n = cd.length;
  const put = (i, a, src) => { if(i < 1 || i >= n-1) return; const c = cxConf(a), d = cxRevDir(a); if(!(c >= 70) || !d) return;
    const t = bwBarMs(cd[i]); if(!isFinite(t)) return; const nm = String(a.name || a.pattern || a.type);
    const old = rec.cands[t]; if(!old || c > old.c) rec.cands[t] = {n: nm, c: Math.round(c), d: d, s: src}; };
  (alerts || []).forEach(a => { const bi = a.bar_index != null ? +a.bar_index : null; if(bi != null && bi >= 1) put(n-1-bi, a, 'Live tab'); });
  (raised || []).forEach(a => { const ms = a.time ? bwBarMs({t:a.time}) : (+a.ts || 0); const i = prBarOf(cd, ms); put(i, a, 'Assistant'); });
  const keep = bwBarMs(cd[Math.max(0, n-90)]);
  Object.keys(rec.cands).forEach(k => { if(+k < keep) delete rec.cands[k]; });
  Object.keys(rec.eng).forEach(k => { if(+k < keep) delete rec.eng[k]; });
}

function cxEma(cd, n){ const k = 2/(n+1), o = []; let e = cd[0] ? cd[0].c : 0; for(let i=0;i<cd.length;i++){ e = i ? cd[i].c*k + e*(1-k) : cd[i].c; o.push(e); } return o; }

function cxAtr(cd, n){ n = n || 14; const o = new Array(cd.length).fill(null); let s = 0;
  for(let i=1;i<cd.length;i++){ const b = cd[i], p = cd[i-1], tr = Math.max(b.h-b.l, Math.abs(b.h-p.c), Math.abs(b.l-p.c));
    if(i <= n){ s += tr; if(i === n) o[i] = s/n; } else o[i] = (o[i-1]*(n-1) + tr)/n; } return o; }

function cxDi(cd, n){ n = n || 14; const o = new Array(cd.length).fill(null); let tr = 0, pd = 0, md = 0;
  for(let i=1;i<cd.length;i++){ const b = cd[i], p = cd[i-1], t = Math.max(b.h-b.l, Math.abs(b.h-p.c), Math.abs(b.l-p.c));
    const up = b.h - p.h, dn = p.l - b.l, P = up > dn && up > 0 ? up : 0, M = dn > up && dn > 0 ? dn : 0;
    if(i <= n){ tr += t; pd += P; md += M; } else { tr = tr - tr/n + t; pd = pd - pd/n + P; md = md - md/n + M; }
    if(i >= n && tr > 0) o[i] = {p: 100*pd/tr, m: 100*md/tr}; } return o; }

function cxBars(cd){
  const C = cd.slice(0, -1), E20 = cxEma(C, 20), E50 = cxEma(C, 50), A = cxAtr(C, 14), DI = cxDi(C, 14), RS = prRsi(C);
  let S = []; try{ S = window.BWRead2 && window.BWRead2.series ? window.BWRead2.series(cd, {key: pair+'|'+tf, fmt: p => (+p).toFixed(digitsOf(pair))}, 70) : []; }catch(e){ S = []; }
  const reg = {}; S.forEach(x => reg[x.k] = x);
  const rec = cxRec();
  return C.map((b, i) => ({t: bwBarMs(b), o:b.o, h:b.h, l:b.l, c:b.c, e20:E20[i], e50:E50[i], atr:A[i], di:DI[i], rsi:RS[i], reg:reg[i] || null,
    pat: rec.cands[bwBarMs(b)] || null}));
}

function cxDirOf(r){ return !r ? 0 : r.r === 'u' ? 1 : r.r === 'd' ? -1 : 0; }

var CX_STRONG = 2.5, CX_AMBER = 1.0, CX_RED = 1.5, CX_WIN = 6, CX_FADE = 24;

function cxStrength(b, td){
  const stack = td > 0 ? (b.c > b.e20 && b.e20 > b.e50) : (b.c < b.e20 && b.e20 < b.e50);
  const di = b.di ? (td > 0 ? b.di.p > b.di.m : b.di.m > b.di.p) : false;
  const dist = b.atr ? (b.c - b.e50)/b.atr*td : 0;
  return {stack, di, dist, strong: stack && di && dist >= CX_STRONG, b};
}

function cxEpisode(B, eng){
  let ep = null; const first = B.findIndex(b => b.reg);
  if(first < 0) return null;
  for(let k = Math.max(first+1, 3); k < B.length; k++){
    const td = cxDirOf(B[k-1].reg), p = B[k].pat;
    if(!ep || ep.end != null){
      if(ep && ep.end != null && k > ep.end + 3) ep = null;
      if(td && p && p.d === -td && B[k-1].atr){
        let peak = td > 0 ? -1e9 : 1e9; for(let j=Math.max(0,k-21);j<=k-1;j++) peak = td > 0 ? Math.max(peak, B[j].h) : Math.min(peak, B[j].l);
        const r0 = B[k].reg || B[k-1].reg;
        ep = {td, first:k, cands:[{k, p}], peak, st: cxStrength(B[k-1], td), atr: B[k-1].atr, line: td > 0 ? r0.hl : r0.lh, state:'one', end:null};
      }
      continue;
    }
    const b = B[k], r = b.reg;
    if(ep.state !== 'broken' && (ep.td > 0 ? b.c > ep.peak : b.c < ep.peak)){ ep.state = ep.cands.length >= 2 ? 'resumed' : 'resumed1'; ep.end = k; continue; }
    if(ep.state === 'one' || ep.state === 'two'){
      if(r && (r.r === 'u' || r.r === 'd') && cxDirOf(r) === ep.td) ep.line = ep.td > 0 ? r.hl : r.lh;
      if(p && p.d === -ep.td){
        if(k <= ep.first + CX_WIN && ep.cands.length < 4) ep.cands.push({k, p});
        else if(ep.cands.length >= 2) (ep.more = ep.more || []).push({k, p});
      }
      if(ep.cands.length >= 2) ep.state = 'two';
      /* KEEPING UP (Nov 2026). There was no way out of 'two' except a new high/low or a break, so in a market that
         went sideways the check stayed open for dozens of candles, still showing the old trend's strength while the
         Combined Read said range. It now closes when the trend engine reads a range, or after CX_FADE candles
         with neither a new extreme nor a break. */
      if(r && r.r === 'r'){ ep.state = 'ranged'; ep.end = k; }
      else if(r && (r.r === 't' || cxDirOf(r) === -ep.td)){ ep.state = 'broken'; ep.brokeAt = k; }
      else if(ep.state === 'one' && k > ep.first + CX_WIN){ ep.state = 'lapsed'; ep.end = k; }
      else if(ep.state === 'two' && k > ep.first + CX_FADE){ ep.state = 'faded'; ep.end = k; }
    }
    if(ep.state === 'broken'){
      const c1 = B[k], c0 = B[k-1], beyond = x => ep.td > 0 ? x.c < ep.line : x.c > ep.line;
      const rsiWith = B[k-2] && c1.rsi != null && B[k-2].rsi != null && (ep.td > 0 ? c1.rsi < B[k-2].rsi : c1.rsi > B[k-2].rsi);
      const eg = eng && eng[b.t];
      if(eg && eg.d === -ep.td){ ep.state = 'confirmed'; ep.confAt = k; ep.confBy = 'engine'; ep.confLv = eg.lv; ep.end = k + 2; }
      else if(ep.line != null && beyond(c1) && beyond(c0) && rsiWith){ ep.state = 'confirmed'; ep.confAt = k; ep.confBy = 'rule'; ep.end = k + 2; }
      else if(r && cxDirOf(r) === ep.td){ ep.state = 'repaired'; ep.end = k; }
      else if(r && r.r === 'r'){ ep.state = 'ranged'; ep.end = k; }      /* the break settled into a range, not a reversal */
    }
  }
  if(ep){ let ext = ep.td > 0 ? 1e9 : -1e9; for(let j=ep.first;j<B.length;j++) ext = ep.td > 0 ? Math.min(ext, B[j].l) : Math.max(ext, B[j].h);
    ep.depth = (ep.td > 0 ? ep.peak - ext : ext - ep.peak)/ep.atr; ep.ext = ext; ep.N = B.length; }
  return ep;
}

function cxTrendLevel(ep, B){
  if(!ep || ep.cands.length < 2 || ['resumed','resumed1','lapsed','repaired','ranged','faded'].includes(ep.state)) return null;
  if(ep.end != null && B.length - 1 > ep.end + 3) return null;
  const up = ep.td > 0, a = B[ep.cands[1].k].atr || ep.atr; let x = up ? -1e9 : 1e9;
  for(let j=Math.max(0, ep.first-5); j<=ep.cands[1].k; j++) x = up ? Math.max(x, B[j].h) : Math.min(x, B[j].l);
  return {price:x, lo: up ? x - a*0.25 : x, hi: up ? x : x + a*0.25, type: up ? 'resistance' : 'support', tier:'medium', trend:true};
}

function cxClosedTrig(t, cd){
  if(!t || !t.any || !Array.isArray(t.groups)) return t;
  const n = cd.length, g = t.groups.filter(G => n-1-G.i >= 1).sort((x,y) => y.conf - x.conf);
  if(!g.length) return {any:false, groups:[], source:t.source};
  return Object.assign({}, t, {groups:g, lead:g[0], barsAgo: n-1-g[0].i});
}

function cxPad(v){ return String(v).padStart(2,'0'); }

function cxSrv(ms){ const d = new Date(ms); return cxPad(d.getUTCHours())+':'+cxPad(d.getUTCMinutes()); }

function cxEngEarly(ep, P, TL){
  return !!(ep && P && P.level && P.bear === (ep.td > 0) && P.state === 'early' &&
    (Math.abs(P.level.p - ep.peak) <= ep.atr || (TL && Math.abs(P.level.p - TL.price) <= ep.atr)));
}

var CX_ODDSR = {strong:{rej:58, nei:45, prs:33}, weak:{rej:51, nei:39, prs:30}};

function cxVoice(N, ep, W, P, TL, RG, B){
  const V = {head:N.head, sub:N.sub, tone:N.tone, trade:N.trade, note:'', live:'', press:false, suppressed:false};
  if(ep && RG && cxEnded(ep)) ep = null;          /* a closed check in a range: the range speaks (Nov 2026) */
  if(!ep){
    /* IN A RANGE: a candle that closed pressed against an edge (no wick) switches off a trade fading that edge */
    const t = RG && RG.last;
    if(RG && !RG.broke && t && B && t.k === B.length-1 && t.kind === 'prs'){ const nmE = t.side > 0 ? 'top' : 'bottom', o = CX_ODDSR[RG.strong ? 'strong' : 'weak'].prs;
      if(/^(BUY|SELL)/.test(N.head || '') && N.sig && N.sig.d === -t.side){ V.suppressed = true; V.press = true; V.trade = false; V.tone = 'mut'; V.head = 'Wait. The range '+nmE+' is being pressed.';
        V.sub = 'The last candle closed against the '+nmE+' with no wick. In the past an edge pressed like this held back to the middle only '+o+' times in 100. Do not fade it.';
        V.note = 'A '+N.sig.name+' '+N.sig.conf+'% printed, but fading the range '+nmE+' is switched off while it is being pressed.'; }
      else V.note = 'The last candle closed pressed against the range '+nmE+' with no wick. In the past this edge broke before price got back to the middle about '+(100-o)+' times in 100.'; }
    if(RG && RG.broke && B){ V.note = 'The range broke '+(RG.broke.side > 0 ? 'up' : 'down')+' on the candle that opened '+cxSrv(B[RG.broke.at].t)+' server.'; }
    V.changed = V.head !== N.head;
    return V;
  }
  const up = ep.td > 0, trW = up ? 'uptrend' : 'downtrend', cw = up ? 'bearish' : 'bullish', nm = up ? 'HL' : 'LH', side = up ? 'sell' : 'buy', own = up ? 'buy' : 'sell';
  const isTrade = /^(BUY|SELL)/.test(N.head || ''), F = v => (+v).toFixed(digitsOf(pair)), early = cxEngEarly(ep, P, TL);
  const off = () => { V.press = true; V.suppressed = isTrade; V.trade = false; V.tone = 'mut'; };
  if(ep.state === 'two' && ep.st.strong && early){
    off(); V.head = 'Wait. Strong '+trW+' losing ground.';
    V.sub = 'The reversal engine’s early line broke. No '+own+'s while that stands. A '+side+' still needs the '+nm+' at '+F(ep.line)+' to break on closed candles and the reversal engine to confirm it.';
  } else if(ep.state === 'two' && !ep.st.strong){
    off(); V.head = 'Wait. Weak '+trW+' under pressure.';
    V.sub = 'No '+own+'s here. A '+side+' needs the '+nm+' at '+F(ep.line)+' to break on closed candles and the reversal engine to confirm it.';
  } else if(ep.state === 'two' && ep.st.strong){
    V.note = 'Strong '+trW+': two '+cw+' reversals are not enough to turn it. Do not trust this '+cw+' turn yet.';
  } else if(ep.state === 'broken'){
    off(); V.head = 'Wait. The '+nm+' is broken, the reversal is not confirmed yet.';
    V.sub = 'The '+nm+' at '+F(ep.line)+' broke on closed candles. A '+side+' setup opens once the reversal engine confirms: two closes beyond the line with RSI agreeing.';
  } else if(ep.state === 'confirmed' && !isTrade){
    V.head = 'Reversal confirmed. Waiting for a '+side+' trigger.'; V.sub = 'The '+trW+' has ended. A '+cw+' pattern of 70% or more is the trigger.'; V.tone = up ? 'dn' : 'up';
  }
  if(V.suppressed && N.sig) V.note = 'A '+N.sig.name+' '+N.sig.conf+'% printed, but '+own+' setups are switched off while '+(ep.state === 'broken' ? 'the break is unconfirmed.' : early ? 'the early reversal stands.' : 'a weak '+trW+' is under pressure.');
  V.changed = V.head !== N.head;     /* the verdict now comes from the check (decided on the latest close), not from the trigger */
  if(W && W.lines.some(x => x.k === 'line') && (ep.state === 'one' || ep.state === 'two'))
    V.live = 'The '+nm+' is breaking on the forming candle. If this candle closes '+(up ? 'below' : 'above')+' it, this changes to "'+nm+' broken". Not final until then.';
  return V;
}

var CX_TICKS = {};

function cxRangeWatch(cd, B, RG){
  const f = cd[cd.length-1], a = B[B.length-1].atr, lines = [], F = v => (+v).toFixed(digitsOf(pair));
  if(!RG || RG.broke || !a) return lines;
  const band = RG.ht*0.17, buf = 0.2*a, rng = f.h - f.l, elapsed = (Date.now() - (CX_TICKS[pair+'|'+tf] || [{t:Date.now()}])[0].t)/6e4;
  for(const side of [1,-1]){ const edge = side > 0 ? RG.hi : RG.lo, nmE = side > 0 ? 'top' : 'bottom';
    if(side > 0 ? f.c > edge + buf : f.c < edge - buf) lines.push({l:'red', k:'range', d:side, t:'Price is <b>'+(side > 0 ? 'above the range top' : 'below the range bottom')+' at '+F(edge)+'</b> on the forming candle. '+((side > 0 ? B[B.length-1].c > edge + buf : B[B.length-1].c < edge - buf) ? 'The last candle already closed there, so a close here would be the second and <b>break the range</b>.' : 'A break needs one long candle or two closes beyond it.')});
    else { const wick = rng > 0 ? (side > 0 ? f.h - Math.max(f.o, f.c) : Math.min(f.o, f.c) - f.l)/rng : 0;
      if((side > 0 ? f.c >= edge - band : f.c <= edge + band) && wick < 0.18 && rng > a*0.15)
        lines.push({l:'amber', k:'press', d:side, t:'<b>Pressing the range '+nmE+'</b> at '+F(edge)+' with no wick. If it closes like this, history says this edge breaks about 2 times in 3. Counted only at the close.'}); } }
  return lines;
}

function cxEsc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }

function cxLive(cd, B, ep, W, RG, forming){
  const n = cd.length, f = cd[n-1], last = B[B.length-1], a = last && last.atr, rows = [], F1 = v => v.toFixed(1), F = v => (+v).toFixed(digitsOf(pair));
  if(!a || !f) return rows;
  let avg = 0, cnt = 0; for(let j=Math.max(0,B.length-30); j<B.length; j++){ avg += B[j].h - B[j].l; cnt++; } avg = cnt ? avg/cnt : a;
  const rng = f.h - f.l, body = Math.abs(f.c - f.o), up = f.c >= f.o, uw = f.h - Math.max(f.o, f.c), lw = Math.min(f.o, f.c) - f.l, bp = rng > 0 ? body/rng : 0, at = rng > 0 ? (f.c - f.l)/rng : 0.5;
  const shape = rng < avg*0.25 ? 'Small so far' : bp < 0.25 ? 'Undecided, small body' : (up ? 'Bullish' : 'Bearish')+(bp >= 0.6 ? ', strong body' : '');
  rows.push(['The candle so far', shape+' · '+F1(rng/avg)+'x an average candle · closing '+(at >= 0.75 ? 'near its high' : at <= 0.25 ? 'near its low' : 'mid-candle')+
    (rng > 0 && uw/rng >= 0.4 ? ' · long upper wick (selling into it)' : '')+(rng > 0 && lw/rng >= 0.4 ? ' · long lower wick (buying into it)' : '')]);
  const td = cxDirOf(last.reg), mv = (f.c - last.c)/a, inR = RG && !RG.broke && !td;
  rows.push(['Since the last close', (mv >= 0 ? '+' : '−')+F1(Math.abs(mv))+' average candles '+(mv >= 0 ? 'up' : 'down')+' · '+(W.dir ? (mv*W.dir >= 0 ? 'with ' : 'against ')+W.what : inR ? (mv >= 0 ? 'toward the top' : 'toward the bottom') : 'no trend to compare with')]);
  const h = CX_TICKS[pair+'|'+tf] || [], now = Date.now(), base = h.find(x => now - x.t <= 15*6e4 && x.bar === bwBarMs(f));
  if(base && now - base.t >= 5*6e4){ const sp = (f.c - base.p)/a; rows.push(['Last '+Math.round((now - base.t)/6e4)+' minutes', (Math.abs(sp) < 0.1 ? 'barely moving' : (sp >= 0 ? 'up ' : 'down ')+F1(Math.abs(sp))+' average candles')+(Math.abs(sp) >= 0.6 ? ' · fast' : '')]); }
  const ext = td ? (td > 0 ? Math.max.apply(null, B.slice(-20).map(b => b.h)) : Math.min.apply(null, B.slice(-20).map(b => b.l))) : null;
  const line = td ? (W.line != null ? W.line : (td > 0 ? last.reg.hl : last.reg.lh)) : null, nm = td > 0 ? 'HL' : 'LH';
  if(td){ const toExt = (td > 0 ? ext - f.c : f.c - ext)/a, toLine = line != null ? (td > 0 ? f.c - line : line - f.c)/a : null;
    rows.push(['Where it is', (toExt <= 0 ? '<b>making a new '+(td > 0 ? 'high' : 'low')+'</b> beyond '+F(ext) : F1(toExt)+' average candles from the trend '+(td > 0 ? 'high ' : 'low ')+F(ext))+
      (toLine != null ? ' · '+(toLine < 0 ? '<b>beyond the '+nm+'</b> '+F(line) : F1(toLine)+' average candles '+(td > 0 ? 'above' : 'below')+' the '+nm+' '+F(line)) : '')]); }
  else if(inR){ const pos = (f.c - RG.lo)/RG.ht;
    rows.push(['Where it is', pos > 1 ? '<b>above the range top</b> '+F(RG.hi) : pos < 0 ? '<b>below the range bottom</b> '+F(RG.lo) :
      Math.round(pos*100)+'% up the box · '+(pos >= 0.8 ? 'top fifth' : pos <= 0.2 ? 'bottom fifth' : 'middle')+' · '+F1((RG.hi - f.c)/a)+' to the top, '+F1((f.c - RG.lo)/a)+' to the bottom (average candles)']); }
  else { const lv = (((D()||{}).sr_levels) || []).map(l => ({l, p:+l.price, d:(+l.price - f.c)/a})).filter(x => isFinite(x.p)).sort((x,y) => Math.abs(x.d) - Math.abs(y.d))[0];
    rows.push(['Where it is', lv ? 'nearest level: '+String(lv.l.tier||'')+' '+String(lv.l.type||'')+' '+F(lv.p)+', '+F1(Math.abs(lv.d))+' average candles '+(lv.d > 0 ? 'above' : 'below') : 'no level nearby']); }
  const fp = (forming || []).filter(p => cxConf(p) >= 70).sort((x,y) => cxConf(y) - cxConf(x))[0], fd = fp ? cxRevDir(fp) : 0;
  rows.push(['Pattern forming', fp ? cxEsc(String(fp.name || fp.pattern || fp.type))+' '+Math.round(cxConf(fp))+'%'+(fp.__src ? ' ('+fp.__src+')' : '')+
    (W.dir && fd ? (fd === W.dir ? ' · with ' : ' · against ')+W.what : fd ? (fd > 0 ? ' · bullish' : ' · bearish') : '')+' · counted only at the close' : 'none so far']);
  let ifc; const longC = rng >= avg*2 && bp >= 0.6;
  if(td){
    if(line != null && (td > 0 ? f.c < line : f.c > line)) ifc = longC && (up ? 1 : -1) === -td ? '<b>one long candle through the '+nm+'</b>: that breaks it on its own' : (td > 0 ? last.c < line : last.c > line) ? '<b>a second close beyond the '+nm+'</b>: that breaks it' : '<b>1 close beyond the '+nm+'</b>. A break needs a second close, or one long candle';
    else if(td > 0 ? f.c > ext : f.c < ext) ifc = ep && (ep.state === 'one' || ep.state === 'two') ? 'a close at a new '+(td > 0 ? 'high' : 'low')+': <b>the counter-trend check would end, the trend resumed</b>' : 'a close at a new '+(td > 0 ? 'high' : 'low')+': <b>the '+(td > 0 ? 'uptrend' : 'downtrend')+' carrying on</b>';
    else if(fp && fd === -td) ifc = 'a '+cxEsc(String(fp.name || fp.type))+' against the '+(td > 0 ? 'uptrend' : 'downtrend')+(ep && ep.state === 'one' ? ': <b>the second counter candle</b>, the check would warn' : ep && ep.state === 'two' ? ': another counter candle on the list' : ': <b>the counter-trend check would open</b>');
    else if(longC && (up ? 1 : -1) === td) ifc = 'a long candle with the '+(td > 0 ? 'uptrend' : 'downtrend')+': the trend pushing on';
    else ifc = 'nothing changes: the '+(td > 0 ? 'uptrend' : 'downtrend')+' stands as it is';
  } else if(inR){ const pos = (f.c - RG.lo)/RG.ht, side = pos >= 0.5 ? 1 : -1, edge = side > 0 ? RG.hi : RG.lo, nmE = side > 0 ? 'top' : 'bottom', buf = 0.2*a;
    const atEdge = side > 0 ? f.h >= RG.hi - RG.ht*0.2 : f.l <= RG.lo + RG.ht*0.2;
    if(side > 0 ? f.c > edge + buf : f.c < edge - buf) ifc = longC && (up ? 1 : -1) === side ? '<b>one long candle through the range '+nmE+'</b>: that breaks it on its own' : (side > 0 ? last.c > edge + buf : last.c < edge - buf) ? '<b>a second close beyond the range '+nmE+'</b>: that breaks the range' : '<b>1 close beyond the range '+nmE+'</b>. A break needs a second close, or one long candle';
    else if(atEdge){ const wick = rng > 0 ? (side > 0 ? uw : lw)/rng : 0, cl = side > 0 ? pos : 1 - pos, o = CX_ODDSR[RG.strong ? 'strong' : 'weak'];
      const k = (cl <= 0.78 || wick >= 0.39 || (fp && fd === -side)) ? 'rej' : (cl > 0.83 && wick < 0.18) ? 'prs' : 'nei';
      ifc = 'the '+nmE+' would read as <b>'+({rej:'rejected', prs:'pressed, no wick', nei:'no clear reaction'})[k]+'</b>: in a '+(RG.strong ? 'strong' : 'weak')+' range that held back to the middle '+o[k]+' times in 100'; }
    else ifc = 'the middle of the box: no edge to read';
  } else ifc = 'no trend and no range: nothing would be decided';
  rows.push(['If it closed now', ifc]);
  return rows;
}

function cxWatch(cd, B, ep, V, N, extraForming, RG){
  const n = cd.length, f = cd[n-1], last = B[B.length-1], a = last && last.atr, lines = [];
  if(!a || !f) return {lvl:'none', lines:[], dir:0, rows:[]};
  { const key = pair+'|'+tf, now = Date.now(), h = CX_TICKS[key] || (CX_TICKS[key] = []);        /* the forming candle's path, kept in every market */
    if(!h.length || h[h.length-1].bar !== bwBarMs(f) || Math.abs(h[h.length-1].p - f.c) > 0) h.push({t:now, p:f.c, bar:bwBarMs(f)});
    while(h.length && now - h[0].t > 20*6e4) h.shift(); }
  const lr = last.reg, trade = V && V.trade && N && N.sig;
  const dir = trade ? N.sig.d : cxDirOf(lr);
  if(!dir){
    const inR = RG && !RG.broke, rl = inR ? cxRangeWatch(cd, B, RG) : [], W0 = {lvl: rl.some(x => x.l === 'red') ? 'red' : rl.length ? 'amber' : 'none', lines: rl, dir:0, what: inR ? 'the range' : '', line:null, f, a};
    const rr = rl.find(x => x.k === 'range'); if(rr) W0.rg = {side: f.c > RG.hi ? 1 : -1, edge: f.c > RG.hi ? RG.hi : RG.lo};
    W0.rows = cxLive(cd, B, ep, W0, RG, extraForming);
    if(!inR) W0.quiet = 'No trend, no range and no trade read, so there is nothing to warn against. The reading above still follows the candle.';
    return W0;
  }
  const what = trade ? (dir > 0 ? 'the BUY' : 'the SELL') : (dir > 0 ? 'the uptrend' : 'the downtrend'), F = v => (+v).toFixed(digitsOf(pair));
  const against = (last.c - f.c)*dir/a;
  if(against >= CX_RED) lines.push({l:'red', k:'move', t:'Price is <b>'+against.toFixed(1)+' average candles</b> against '+what+' since the last close.'});
  else if(against >= CX_AMBER) lines.push({l:'amber', k:'move', t:'Price is <b>'+against.toFixed(1)+' average candles</b> against '+what+' since the last close.'});
  const line = ep && ep.line != null && (ep.state === 'one' || ep.state === 'two') ? ep.line : (lr ? (dir > 0 ? lr.hl : lr.lh) : null), nm = dir > 0 ? 'HL' : 'LH';
  const thru = line != null && (dir > 0 ? f.c < line : f.c > line);
  if(thru) lines.push({l:'red', k:'line', t:'Price is <b>'+(dir > 0 ? 'below' : 'above')+' the '+nm+' at '+F(line)+'</b> on the forming candle. It only counts if the candle closes there.'});
  let avg = 0, cnt = 0; for(let j=Math.max(0,B.length-30); j<B.length; j++){ avg += B[j].h - B[j].l; cnt++; } avg = cnt ? avg/cnt : 0;
  const rng = f.h - f.l, body = Math.abs(f.c - f.o);
  if(avg > 0 && rng >= avg*2 && rng > 0 && body/rng >= 0.6 && (f.c - f.o)*dir < 0)
    lines.push({l:'red', k:'long', t:'A <b>long '+(dir > 0 ? 'bearish' : 'bullish')+' candle</b> is forming ('+(rng/avg).toFixed(1)+'x the average). If it closes like this'+(thru ? ', it breaks the '+nm+' on its own.' : ', it counts as one long candle against '+what+'.')});
  /* a reversal pattern forming on this candle: the EA's live read first, the Assistant's forming-candle read as back-up */
  const fp = (extraForming || []).filter(p => cxConf(p) >= 70 && cxRevDir(p) === -dir).sort((x,y) => cxConf(y) - cxConf(x))[0];
  if(fp) lines.push({l:'amber', k:'pat', t:'<b>'+String(fp.name || fp.pattern || fp.type)+' forming ('+Math.round(cxConf(fp))+'%)</b>'+(fp.__src ? ' · '+fp.__src : '')+'. Counted only when the candle closes.'});
  const now = Date.now(), h = CX_TICKS[pair+'|'+tf] || [];
  const base = h.find(x => now - x.t <= 15*6e4 && x.bar === bwBarMs(f));
  if(base && now - base.t >= 5*6e4){ const sp = (base.p - f.c)*dir/a; if(sp >= 0.6) lines.push({l:'amber', k:'fast', t:'Fast move: <b>'+sp.toFixed(1)+' average candles in '+Math.round((now-base.t)/6e4)+' minutes</b> against '+what+'.'}); }
  const lvl = lines.some(x => x.l === 'red') ? 'red' : lines.length ? 'amber' : 'none';
  lines.forEach(x => { if(x.d == null) x.d = -dir; });            /* each warning's threat: the move against the read */
  const W1 = {lvl, lines, dir, what, line, against, f, a};
  W1.rows = cxLive(cd, B, ep, W1, RG, extraForming);
  return W1;
}

const pretty=s=>s.length===6?s.slice(0,3)+'/'+s.slice(3):s;

var CX_TFMS = {M15:9e5, M30:18e5, H1:36e5, H4:144e5};

function cxLoc(ms, off){ if(off == null) return null; try{ return new Date(ms - off*36e5).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false}); }catch(e){ return null; } }

function cxBothTxt(ms, off){ const l = cxLoc(ms, off); return cxSrv(ms)+' server'+(l ? ' / '+l+' your time' : ''); }

function cxAlerts(cd, W, off){
  const rec = cxRec(), n = cd.length, f = cd[n-1], bar = bwBarMs(f), tfms = CX_TFMS[tf] || 36e5;
  /* the candle that just closed: how did its warning end? */
  if(rec.watch && rec.watch.bar !== bar && rec.watch.reds && rec.watch.reds.length){
    const w = rec.watch, i = cd.findIndex(b => bwBarMs(b) === w.bar);
    if(i >= 0 && i < n-1){
      const b = cd[i], F = v => (+v).toFixed(digitsOf(pair));
      const thru = w.line != null && (w.dir > 0 ? b.c < w.line : b.c > w.line), far = w.a ? (w.ref - b.c)*w.dir/w.a : 0, nm = w.dir > 0 ? 'HL' : 'LH';
      const rgo = w.rg && (w.rg.side > 0 ? b.c > w.rg.edge : b.c < w.rg.edge);
      const why = w.rg ? (rgo ? 'the candle closed '+(w.rg.side > 0 ? 'above the range top' : 'below the range bottom')+' at '+F(w.rg.edge) : '') : thru ? 'the candle closed '+(w.dir > 0 ? 'below' : 'above')+' the '+nm+' at '+F(w.line)+(far >= CX_RED ? ', '+far.toFixed(1)+' average candles against the read' : '')
                : far >= CX_RED ? 'the candle closed '+far.toFixed(1)+' average candles against the read' : '';
      rec.out = {bar: bar, text: 'The '+cxSrv(w.reds[0].bt)+' warning '+(why ? '<b style="color:var(--red)">held at the '+cxSrv(w.bar + tfms)+' close</b>: '+why+'.' : '<b style="color:var(--green)">did not hold</b>: price came back by the '+cxSrv(w.bar + tfms)+' close.')};
    }
  }
  if(!rec.watch || rec.watch.bar !== bar) rec.watch = {bar, reds:[], sent:{}, dir:W.dir, line:W.line, ref: cd[n-2] ? cd[n-2].c : null, a: W.a || null};
  rec.watch.dir = W.dir; rec.watch.line = W.line; if(W.a) rec.watch.a = W.a; if(W.rg) rec.watch.rg = W.rg;
  const red = W.lines.filter(x => x.l === 'red');
  if(red.length){
    const txt = red.map(x => x.t.replace(/<[^>]+>/g,'')).join(' ');
    const realNow = Date.now(), closeReal = off != null ? bar - off*36e5 + tfms : realNow + 30*6e4;
    try{ localStorage.setItem('bw-candle-watch', JSON.stringify({t: realNow, until: closeReal, text: pretty(pair)+' '+tf+' — forming candle: '+red[0].t.replace(/<[^>]+>/g,'')})); }catch(e){}
    try{ publishPatternAlert(); }catch(e){}
    const kinds = red.some(x => x.k === 'long') ? ['any','long'] : ['any'];
    kinds.forEach(kind => {
      if(rec.watch.sent[kind]) return;
      rec.watch.sent[kind] = realNow;
      const srvNow = off != null ? realNow + off*36e5 : bar;
      const item = {at: realNow, bt: srvNow, bar, kind, text: kind === 'long' ? red.find(x => x.k === 'long').t.replace(/<[^>]+>/g,'') : txt, close: bar + tfms};
      if(!rec.watch.reds.length) rec.watch.reds.push(item);
      rec.alerts.unshift(item); rec.alerts = rec.alerts.slice(0, 12);
      try{
        fetch(BASE+'/api/candle-watch-alert', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({pair: pair, tf: tf, kind: kind, barTime: Math.round(bar/1000), text: item.text, closeAt: cxBothTxt(bar + tfms, off)})}).catch(function(){});
      }catch(e){}
    });
  }
  /* the dot clears at the candle close (or straight away once nothing on this candle is red any more and the close has passed) */
  try{ const cw = JSON.parse(localStorage.getItem('bw-candle-watch')||'null'); if(cw && cw.until < Date.now()){ localStorage.removeItem('bw-candle-watch'); publishPatternAlert(); } }catch(e){}
}

function cxLongAt(B, q, d){ let a = 0, k = 0; for(let i=Math.max(0,q-30); i<q; i++){ a += B[i].h - B[i].l; k++; } a = k ? a/k : 0;
  const b = B[q], rg = b.h - b.l; return a > 0 && rg >= a*2 && Math.abs(b.c - b.o)/rg >= 0.6 && (d > 0 ? b.c > b.o : b.c < b.o); }

function cxReact(B, k, side, hi, lo, ht){
  const b = B[k], rng = b.h - b.l, wick = rng > 0 ? (side > 0 ? b.h - Math.max(b.o, b.c) : Math.min(b.o, b.c) - b.l)/rng : 0;
  const cl = side > 0 ? (b.c - lo)/ht : 1 - (b.c - lo)/ht, p = b.pat && b.pat.d === -side ? b.pat : null;
  const kind = (cl <= 0.78 || wick >= 0.39 || p) ? 'rej' : (cl > 0.83 && wick < 0.18) ? 'prs' : 'nei';
  const eff = b.reg && b.reg.e != null ? b.reg.e : null, htA = b.atr ? ht/b.atr : null;
  return {k, side, wick, cl, p, kind, eff, htA};
}

function cxRange(cd, B, N){
  if(!B || B.length < 30) return null;
  const rec = cxRec(), lastT = B[B.length-1].t;
  let hi, lo;
  if(N && N.ok && N.trend === 'ranging' && N.box && isFinite(+N.box.hi) && isFinite(+N.box.lo)){ hi = +N.box.hi; lo = +N.box.lo; rec.range = {hi, lo, t: lastT}; }
  else if(rec.range){ const i = B.findIndex(b => b.t === rec.range.t); if(i < 0 || B.length - 1 - i > 4){ rec.range = null; return null; } hi = rec.range.hi; lo = rec.range.lo; }
  else return null;
  const ht = hi - lo; if(!(ht > 0)) return null;
  /* how long price has been in this box: back from the last close while closes stay inside (a fifth of an average candle of slack) */
  const inBox = b => { const s = (b.atr || 0)*0.2; return b.c <= hi + s && b.c >= lo - s; };
  let e = B.length - 1; while(e > 0 && B.length - 1 - e < 10 && !inBox(B[e])) e--;      /* the last close inside the box (price may already have left it) */
  if(!inBox(B[e])){ rec.range = null; return null; }
  let start = e;
  while(start - 1 >= 0 && B.length - start < 150 && inBox(B[start-1])) start--;
  const touches = []; let inHi = false, inLo = false, broke = null;
  for(let k=start; k<B.length; k++){ const b = B[k], band = ht*0.2, atH = b.h >= hi - band, atL = b.l <= lo + band, nH = atH && !inHi, nL = atL && !inLo;
    if(nH && nL) touches.push(cxReact(B, k, (hi - b.c) <= (b.c - lo) ? 1 : -1, hi, lo, ht));      /* one very long candle: read at the edge it closed nearer to */
    else { if(nH) touches.push(cxReact(B, k, 1, hi, lo, ht)); if(nL) touches.push(cxReact(B, k, -1, hi, lo, ht)); }
    inHi = atH; inLo = atL; }
  touches.forEach(t => { t.out = 'pending'; const a = B[t.k].atr || 0, mid = lo + ht/2, buf = 0.2*a;
    for(let j=t.k+1; j<B.length; j++){ const c = B[j];
      if(t.side > 0 ? c.c <= mid : c.c >= mid){ t.out = 'held'; t.outAt = j; break; }
      const bey = x => t.side > 0 ? B[x].c > hi + buf : B[x].c < lo - buf;
      if(bey(j) && (cxLongAt(B, j, t.side) || bey(j-1))){ t.out = 'broke'; t.outAt = j; if(!broke) broke = {side: t.side, at: j}; break; } } });
  /* a close beyond an edge without a touch inside the box (a gap) also ends it */
  if(!broke){ const a = B[B.length-1].atr || 0; for(let j=Math.max(start+1, e+1); j<B.length; j++){ for(const sd of [1,-1]){ const bey = x => sd > 0 ? B[x].c > hi + 0.2*a : B[x].c < lo - 0.2*a; if(bey(j) && (cxLongAt(B, j, sd) || bey(j-1))){ broke = {side: sd, at: j}; break; } } if(broke) break; } }
  if(broke && B.length - 1 - broke.at > 3){ rec.range = null; return null; }      /* the ending stays on screen for 3 candles */
  const lt = touches[touches.length-1], lb = B[B.length-1];
  const eff = lt && lt.eff != null ? lt.eff : (lb.reg && lb.reg.e != null ? lb.reg.e : null), htA = lt && lt.htA != null ? lt.htA : (lb.atr ? ht/lb.atr : null);
  return {hi, lo, ht, eff, htA, strong: eff != null && htA != null && eff <= 0.12 && htA <= 8, start, touches, pos: (lb.c - lo)/ht, broke, last: lt || null, measuredAt: lt ? lt.k : B.length-1};
}

function cxBoth(ms, off){ const l = cxLoc(ms, off); return '<span class="n">'+cxSrv(ms)+'</span> server'+(l ? ' · <span class="n">'+l+'</span> your time' : ''); }

function cxChk(on, t, s, v, bad){ return '<div class="cx-chk '+(on?'on':'off')+(bad?' bad':'')+'"><span class="m">'+(on?'✓':'')+'</span><span>'+t+'<small>'+s+'</small></span><span class="v">'+v+'</span></div>'; }

function cxRangeCard(RG, B, off){
  const o = CX_ODDSR[RG.strong ? 'strong' : 'weak'], t = RG.last, N = B.length, fresh = t && t.k === N-1 && !RG.broke, F = v => (+v).toFixed(digitsOf(pair));
  const nmS = s => s > 0 ? 'top' : 'bottom', KN = {rej:'Rejected', prs:'Pressed, no wick', nei:'No clear reaction'};
  let head, cls, line;
  if(RG.broke){ const upB = RG.broke.side > 0; head = 'The range broke '+(upB ? 'up' : 'down')+'.'; cls = 'bad';
    line = (cxLongAt(B, RG.broke.at, RG.broke.side) ? 'One long candle' : 'Two closes')+' '+(upB ? 'above the top' : 'below the bottom')+' at '+F(upB ? RG.hi : RG.lo)+', on the candle that opened '+cxBoth(B[RG.broke.at].t, off)+'. The box is finished.'; }
  else if(B[N-1].c > RG.hi + 0.2*(B[N-1].atr || 0) || B[N-1].c < RG.lo - 0.2*(B[N-1].atr || 0)){ const upB = B[N-1].c > RG.hi; cls = 'bad';
    head = 'One close '+(upB ? 'above the range top' : 'below the range bottom')+'. Not a break yet.';
    line = 'The last candle closed beyond '+F(upB ? RG.hi : RG.lo)+'. A break needs a second close beyond it, or one long candle. Until then the box still stands, but do not fade this edge.'; }
  else if(fresh && t.kind === 'prs'){ head = 'The range '+nmS(t.side)+' is being pressed. Do not fade it.'; cls = 'bad';
    line = 'The last candle closed against the '+nmS(t.side)+' at '+F(t.side > 0 ? RG.hi : RG.lo)+' with no wick. In a '+(RG.strong ? 'strong' : 'weak')+' range, an edge pressed like this held back to the middle only <b>'+o.prs+' times in 100</b>; the rest broke first.'; }
  else if(fresh && t.kind === 'rej'){ head = 'The range '+nmS(t.side)+' is holding: the edge was rejected.'; cls = 'ok';
    line = (t.p ? 'A '+cxEsc(t.p.n)+' '+t.p.c+'% pointing back into the box' : t.wick >= 0.39 ? 'A long wick at the '+nmS(t.side) : 'The candle closed back off the '+nmS(t.side))+'. In a '+(RG.strong ? 'strong' : 'weak')+' range, a rejected edge held back to the middle <b>'+o.rej+' times in 100</b>.'; }
  else if(fresh){ head = 'At the range '+nmS(t.side)+', no clear reaction yet.'; cls = 'warn'; line = 'Neither a rejection nor a press. In a '+(RG.strong ? 'strong' : 'weak')+' range this held back to the middle <b>'+o.nei+' times in 100</b>.'; }
  else { const p = Math.round(RG.pos*100); head = p >= 80 ? 'Near the range top.' : p <= 20 ? 'Near the range bottom.' : 'Price is in the middle of the range.'; cls = 'mutd';
    line = 'Price is '+Math.max(0, Math.min(100, p))+'% of the way up the box. The read of an edge starts when a candle reaches the top or bottom fifth.'; }
  let h = '<div class="card cx-ctc'+(RG.broke ? ' past' : '')+'"><div class="ct">Range check <span class="r">'+(RG.broke ? '<span class="cx-age past">PAST</span>' : '<span class="cx-age cur">CURRENT</span>')+'</span></div>';
  h += '<div class="cx-big '+cls+'">'+head+'</div><div class="cx-note">'+line+'</div>';
  const pc = Math.max(0, Math.min(100, RG.pos*100));
  h += '<div class="cx-sec">The box · '+F(RG.lo)+' to '+F(RG.hi)+' · price inside it for '+(N-RG.start)+' candles (since '+cxSrv(B[RG.start].t)+' server)</div>'+
       '<div class="cx-dm"><div class="cx-dm-bar" style="background:linear-gradient(90deg,rgba(23,169,122,.28) 0 20%,rgba(255,255,255,.06) 20% 80%,rgba(224,80,79,.28) 80% 100%)"><div style="position:absolute;top:-3px;bottom:-3px;width:3px;border-radius:2px;background:var(--text);left:calc('+pc+'% - 1px)"></div></div>'+
       '<div class="cx-dm-lab"><span style="width:20%">bottom fifth</span><span style="width:60%;text-align:center">middle</span><span style="width:20%;text-align:right">top fifth</span></div></div>';
  h += '<div class="cx-sec">Range strength · measured '+(RG.last ? 'at the last edge touch ('+cxSrv(B[RG.measuredAt].t)+' server)' : 'on the last closed candle')+'</div>';
  h += cxChk(RG.eff != null && RG.eff <= 0.12, 'Tight rotation', 'Price is going back and forth, not covering ground. Efficiency 0.12 or less.', RG.eff != null ? RG.eff.toFixed(2) : '—');
  h += cxChk(RG.htA != null && RG.htA <= 8, 'A box no taller than 8 average candles', 'Tall boxes break more often before price reaches the middle.', RG.htA != null ? RG.htA.toFixed(1)+' candles' : '—');
  h += '<div class="cx-small" style="margin-top:6px">'+(RG.strong ? 'Both pass: <b style="color:var(--green)">strong range</b>. Its edges held back to the middle 50 times in 100, against 42 in weak ranges.' :
       'Not both pass: <b style="color:var(--gold-lt)">weak range</b>. Its edges held back to the middle 42 times in 100, against 50 in strong ranges.')+'</div>';
  if(RG.touches.length){ h += '<div class="cx-sec">Edge touches in this range</div><div class="cx-cands">'+RG.touches.slice(-5).map(x => {
      const out = x.out === 'held' ? '<span style="color:var(--green)">held, back to the middle at '+cxSrv(B[x.outAt].t)+'</span>' : x.out === 'broke' ? '<span style="color:var(--red)">broke at '+cxSrv(B[x.outAt].t)+'</span>' : '<span class="mut">no result yet</span>';
      return '<div class="cx-cand'+(x.side < 0 ? ' bull' : '')+'"><span class="k">'+(x.side > 0 ? 'T' : 'B')+'</span><span class="nm">'+KN[x.kind]+'<span class="cx-small" style="display:block;font-weight:400">'+out+'</span></span><span class="tm">'+cxBoth(B[x.k].t, off)+'<br>'+(N-1-x.k === 0 ? 'last closed candle' : (N-1-x.k)+' candles ago')+'</span></div>'; }).join('')+'</div>'; }
  h += '<div class="cx-sec">What the odds mean</div><div class="cx-small">Held = price got back to the middle of the box before a break was confirmed (one long candle or two closes beyond the edge). Strong range: rejected '+CX_ODDSR.strong.rej+', no clear reaction '+CX_ODDSR.strong.nei+', pressed '+CX_ODDSR.strong.prs+'. Weak range: '+CX_ODDSR.weak.rej+' / '+CX_ODDSR.weak.nei+' / '+CX_ODDSR.weak.prs+'. <span class="mut">This is about the edge surviving, not a forecast of the next move.</span></div>';
  return h+'</div>';
}

function cxTxt(x){ return String(x == null ? '' : x).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/\s+/g, ' ').trim(); }

function cxPack(cd, N, V, ep, RG, W, B, off, cardH){
  if(!N || !N.ok) return null;
  if(ep && RG && !RG.broke && cxEnded(ep)) ep = null;     /* the Range check is what shows (Nov 2026) */
  const n = cd.length, fb = bwBarMs(cd[n-1]), tfms = CX_TFMS[tf] || 36e5, V0 = V || {};
  const td = B && B.length ? cxDirOf(B[B.length-1].reg) : 0;
  const st = ep && (ep.state === 'one' || ep.state === 'two') ? ep.st : (td && B ? cxStrength(B[B.length-1], td) : null);
  /* written as a string, not a /regex/ with quote marks: the Arbiter's build reads quote marks as strings */
  const m = new RegExp('class=.cx-big[^>]*>([\\s\\S]*?)</div><div class=.cx-note.>([\\s\\S]*?)</div>').exec(cardH || '');
  const past = /cx-age past/.test(cardH || '');
  const rowOf = nm => { const r = W && W.rows ? W.rows.find(x => x[0] === nm) : null; return r ? cxTxt(r[1]) : null; };
  return {
    decidedAt: cxBothTxt(fb, off), nextAt: cxBothTxt(fb + tfms, off),
    older: !!(N.sig && N.sigAgo === 2 && !V0.suppressed && !V0.changed),
    strength: td && st ? {of: td > 0 ? 'uptrend' : 'downtrend', strong: !!st.strong} : (!td && RG && !RG.broke ? {of:'range', strong: !!RG.strong} : null),
    press: !!V0.press, suppressed: !!V0.suppressed, note: V0.note ? cxTxt(V0.note) : null, liveNote: V0.live ? cxTxt(V0.live) : null,
    check: m ? {kind: ep ? 'counter-trend' : 'range', state: ep ? ep.state : (RG && RG.broke ? 'broke' : RG && RG.last && RG.last.k === B.length-1 ? RG.last.kind : 'inside'),
                past: past, head: cxTxt(m[1]), line: cxTxt(m[2]),
                /* the move it warns about (+1 up, -1 down), and for a range the edge in question */
                threat: ep ? -ep.td : RG && RG.broke ? RG.broke.side : RG && RG.last ? RG.last.side : 0,
                edge: !ep && RG ? (RG.broke ? (RG.broke.side > 0 ? RG.hi : RG.lo) : RG.last ? (RG.last.side > 0 ? RG.hi : RG.lo) : null) : null} : null,
    live: W ? {level: W.lvl, against: W.what || null, warnings: (W.lines || []).filter(x => x.l !== 'none').map(x => ({level: x.l, dir: x.d || 0, text: cxTxt(x.t)})),
               candle: rowOf('The candle so far'), where: rowOf('Where it is'), forming: rowOf('Pattern forming'), ifClosed: rowOf('If it closed now')} : null
  };
}

var CX_ODDS = {H1:{strong:[85,65,47],weak:[79,65,43]}, H4:{strong:[85,75,49],weak:[89,67,41]}};

var CX_EARLY = {strong:[53,31], weak:[59,47]};

function cxOverlap(ms, off){
  if(off == null) return false;
  const u = new Date(ms - off*36e5), y = u.getUTCFullYear(), t = +u;
  const lastSun = m => { const d = new Date(Date.UTC(y, m+1, 0)); return d.getUTCDate() - d.getUTCDay(); };
  const nthSun = (m,k) => { const d = new Date(Date.UTC(y, m, 1)); return 1 + ((7 - d.getUTCDay()) % 7) + 7*(k-1); };
  const uk = t >= Date.UTC(y,2,lastSun(2),1) && t < Date.UTC(y,9,lastSun(9),1);
  const us = t >= Date.UTC(y,2,nthSun(2,2),7) && t < Date.UTC(y,10,nthSun(10,1),6);
  const h = u.getUTCHours(), lo = uk ? 7 : 8, lc = uk ? 16 : 17, no = us ? 12 : 13;
  return h >= Math.max(lo, no) && h < lc;
}

function cxCheckCard(ep, B, W, P, TL, off){
  if(!ep) return '<div class="card"><div class="ct">Counter-trend check</div><div class="cx-small">No reversal candle of 70% or more against the trend right now. This check opens when one prints.</div></div>';
  const up = ep.td > 0, trW = up ? 'uptrend' : 'downtrend', cw = up ? 'bearish' : 'bullish', nm = up ? 'HL' : 'LH', F = v => (+v).toFixed(digitsOf(pair));
  const s = ep.st, strong = s.strong, od = (CX_ODDS[tf] || CX_ODDS.H1)[strong ? 'strong' : 'weak'], nC = ep.cands.length, N = B.length;
  const early = cxEngEarly(ep, P, TL), at = k => cxBoth(B[k].t, off);
  let head, cls, line;
  if(ep.state === 'resumed' || ep.state === 'resumed1'){ head = 'The '+trW+' carried on. The '+cw+' candles were a pullback.'; cls = 'ok';
    line = 'Price closed '+(up?'above':'below')+' the trend’s '+(up?'high':'low')+' at '+F(ep.peak)+' on the candle that opened '+at(ep.end)+', before the '+nm+' broke.'; }
  else if(ep.state === 'lapsed'){ head = 'One '+cw+' candle, no second one followed.'; cls = 'mutd'; line = 'The check closes. The '+trW+' stands as it was.'; }
  else if(ep.state === 'ranged'){ head = 'The '+trW+' has gone sideways. The check closes.'; cls = 'mutd'; line = 'The trend engine read a range on the candle that opened '+at(ep.end)+'. The trend checks no longer apply; the Range check takes over.'; }
  else if(ep.state === 'faded'){ head = 'No new '+(up?'high':'low')+' and no break in '+CX_FADE+' candles. The check closes.'; cls = 'mutd'; line = 'The '+cw+' candles neither ended the '+trW+' nor were followed by a new '+(up?'high':'low')+'. A new check opens with the next '+cw+' reversal candle.'; }
  else if(ep.state === 'confirmed'){ head = 'Reversal confirmed. This warning no longer applies.'; cls = 'bad';
    line = 'The '+nm+' at '+F(ep.line)+' broke and the reversal was confirmed on the candle that opened '+at(ep.confAt)+': two closes '+(up?'below':'above')+' it with RSI '+(up?'falling':'rising')+'. The '+cw+' candles were the start of a real turn.'; }
  else if(ep.state === 'repaired'){ head = 'The break did not hold. The '+trW+' is back.'; cls = 'ok'; line = 'The trend engine is reading an '+trW+' again.'; }
  else if(ep.state === 'broken'){ head = 'The '+nm+' is broken. The warning is suspended.'; cls = 'bad';
    line = 'The '+trW+'’s '+nm+' at '+F(ep.line)+' broke on the candle that opened '+at(ep.brokeAt)+'. It becomes a confirmed reversal when the reversal engine agrees: two closes '+(up?'below':'above')+' the line with RSI '+(up?'falling':'rising')+'.'; }
  else if(nC >= 2 && early){ head = 'The '+cw+' turn is gaining ground.'; cls = 'bad'; const e = CX_EARLY[strong ? 'strong' : 'weak'];
    line = 'The reversal engine’s early line broke on two closes with RSI agreeing. On 10 years of data, after this in a '+(strong?'strong':'weak')+' '+trW+', the '+nm+' broke before a new '+(up?'high':'low')+' <b>'+e[0]+' times in 100</b> (before it: '+e[1]+'). It is still not a reversal until the '+nm+' breaks and the engine confirms.'; }
  else if(strong && nC >= 2){ head = 'Do not trust this '+cw+' turn yet.'; cls = 'warn';
    line = 'The '+trW+' was strong before these candles, and two '+cw+' reversals of 70% or more are not enough to end it on their own. Entering a '+(up?'sell':'buy')+' on them means trading against the trend.'; }
  else if(!strong && nC >= 2){ head = 'Take this '+cw+' turn seriously.'; cls = 'bad';
    line = 'The '+trW+' was already weak before these candles, and two '+cw+' reversals of 70% or more have printed against it. Weak trends give way more easily.'; }
  else { head = 'One '+cw+' reversal against a '+(strong?'strong':'weak')+' '+trW+'. Watching for a second.'; cls = 'mutd';
    line = 'A single counter candle is common inside a trend. The check becomes a warning if a second one prints within '+CX_WIN+' candles.'; }
  const ended = cxEnded(ep);
  let h = '<div class="card cx-ctc'+(ended?' past':'')+'"><div class="ct">Counter-trend check <span class="r">'+(ended ? '<span class="cx-age past">PAST</span>' : '<span class="cx-age cur">CURRENT</span>')+'</span></div>';
  if(ended) h += '<div class="cx-small" style="margin-bottom:6px">Past decision, not current. Kept on screen for 3 candles so the trader sees how it ended.</div>';
  h += '<div class="cx-big '+cls+'">'+head+'</div><div class="cx-note">'+line+'</div>';
  h += '<div class="cx-cands">'+ep.cands.map((c, j) => '<div class="cx-cand'+(c.p.d > 0 ? ' bull' : '')+'"><span class="k">'+(j+1)+'</span><span class="nm">'+cxEsc(c.p.n)+' '+c.p.c+'%'+
       (cxOverlap(B[c.k].t, off) ? '<span class="cx-tag">LDN-NY OVERLAP</span>' : '')+'</span><span class="tm">'+at(c.k)+'<br>'+(N-1-c.k === 0 ? 'last closed candle' : (N-1-c.k)+' candles ago')+'</span></div>').join('')+'</div>';
  if(ep.more && ep.more.length && !ended) h += '<div class="cx-small" style="margin:-4px 0 8px">Since then: '+ep.more.slice(-3).map(c => cxEsc(c.p.n)+' '+c.p.c+'% ('+cxSrv(B[c.k].t)+' server)').join(', ')+'.</div>';
  if(!ended && nC >= 2 && ep.cands.some(c => cxOverlap(B[c.k].t, off)))
    h += '<div class="cx-ovl"><b>During the London and New York overlap.</b> Sharp moves against a trend at this time can be institutions trapping traders on the wrong side, or buying at a discount, rather than a change of direction.</div>';
  h += '<div class="cx-sec">Trend strength · measured on the candle before the first '+cw+' candle ('+cxSrv(s.b.t)+' server)</div>';
  h += cxChk(s.stack, 'Price '+(up?'above':'below')+' the EMA20, EMA20 '+(up?'above':'below')+' the EMA50', 'The trend is lined up.', F(s.b.c)+' / '+F(s.b.e20)+' / '+F(s.b.e50));
  h += cxChk(s.di, (up?'Buyers':'Sellers')+' in control over the last 14 candles', 'The ADX direction lines: '+(up?'DI+ above DI−':'DI− above DI+')+'.', s.b.di ? '+'+s.b.di.p.toFixed(1)+' / −'+s.b.di.m.toFixed(1) : '—');
  h += cxChk(s.dist >= CX_STRONG, 'Stretched away from the EMA50', 'At least '+CX_STRONG+' average candles. Shows the trend has been moving, not drifting.', s.dist.toFixed(1)+' candles');
  h += '<div class="cx-small" style="margin-top:6px">'+(strong ? 'All three pass: <b style="color:var(--green)">strong '+trW+'</b>.' : 'Not all three pass: <b style="color:var(--gold-lt)">weak '+trW+'</b>.')+'</div>';
  if(!ended || ep.state === 'resumed'){
    const f = W && W.f, live = f && W.dir === ep.td ? ((ep.td > 0 ? ep.peak - Math.min(ep.ext, f.l) : Math.max(ep.ext, f.h) - ep.peak)/ep.atr) : ep.depth;
    const pct = v => Math.max(0, Math.min(100, v/5*100));
    h += '<div class="cx-sec">How far the '+cw+' candles have pulled back</div><div class="cx-dm"><div class="cx-dm-bar"><div class="cx-dm-fill" style="width:'+pct(ep.depth)+'%"></div>'+
         (live > ep.depth + 0.05 ? '<div class="cx-dm-prov" style="left:'+pct(ep.depth)+'%;width:'+(pct(live) - pct(ep.depth))+'%"></div>' : '')+
         '</div><div class="cx-dm-lab"><span style="width:30%">under 1.5</span><span style="width:20%">1.5 to 2.5</span><span>2.5+ average candles</span></div></div>';
    h += '<div class="cx-small"><b class="n" style="color:var(--text)">'+ep.depth.toFixed(1)+'</b> average candles back from the '+(up?'high':'low')+' at <span class="n">'+F(ep.peak)+'</span> on closed candles'+
         (live > ep.depth + 0.05 ? ', <b class="n" style="color:var(--text)">'+live.toFixed(1)+'</b> with the forming candle (dashed, not final)' : '')+'.</div>';
    if(nC >= 2 && !ended && !early){ const o = od[ep.depth < 1.5 ? 0 : ep.depth < 2.5 ? 1 : 2];
      h += '<div class="cx-odds"><span class="pct">'+o+'%</span><span>On 10 years of '+tf+' candles, after two '+cw+' reversals against a '+(strong?'strong':'weak')+' '+trW+' that had pulled back this far, the '+trW+' made a new '+(up?'high':'low')+' before its '+nm+' broke <b>'+o+' times in 100</b>. '+
           (o >= 60 ? '' : 'At this depth it is close to a coin flip, so the warning carries less weight. ')+'<span class="mut">This is about the trend surviving, not a forecast of the next move.</span></span></div>'; }
  }
  if(!['resumed','resumed1','lapsed'].includes(ep.state)){
    const br = ['broken','confirmed'].includes(ep.state), cf = ep.state === 'confirmed';
    h += '<div class="cx-sec">What would make the '+cw+' turn real</div>';
    h += cxChk(br, 'The '+nm+' at '+(ep.line != null ? F(ep.line) : '—')+' is broken', 'One long candle or two closes beyond it.', br ? 'broken' : 'holding', true);
    h += cxChk(cf, 'The reversal engine confirms it', cf ? (ep.confBy === 'engine' ? 'Confirmed by the reversal engine'+(ep.confLv != null ? ' at '+F(ep.confLv) : '')+'.' : 'Its official rule decided: two closes '+(up?'below':'above')+' the line with RSI '+(up?'falling':'rising')+' on closed candles.')
              : 'Two closes '+(up?'below':'above')+' the line with RSI '+(up?'falling':'rising')+'.', cf ? 'confirmed' : 'not yet', true);
    h += '<div class="cx-small" style="margin-top:6px">Until both are ticked, the warning stands. When both are ticked, it no longer applies.</div>';
  }
  return h+'</div>';
}

function cxFrame(o, B){
  const r = B && B.length ? B[B.length-1].reg : null;
  if(!r) return o;                                    /* no trend history yet: exactly as before */
  const td = r.r === 'u' ? 1 : r.r === 'd' ? -1 : r.r === 't' ? -r.d : 0;   /* in a transition, the trend that just broke */
  const fr = td ? {dir: td > 0 ? 'up' : 'down', decider: {p: td > 0 ? r.hl : r.lh}, flipped: false} : {dir: 'none', decider: null, flipped: false};
  return Object.assign({}, o, {frame: Object.assign({}, o.frame || {}, fr)});
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
    if(r.status===401) bwAskRenew();          /* the login expired while the page sat open: ask the dashboard for a fresh one */
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
        return {state:P.state==='expired'?'faded':P.state, score:P.score, on:P.trendWord,   /* "expired" (Nov 2026) is new; readers that know only "faded" show it as that */
                level: P.level.trend ? {tier:'turn', side:P.bear?'high':'low', price:+(+P.level.p).toFixed(6), holds:null}   /* the high/low the turn started from (Nov 2026) */
                                     : {tier:P.level.tier, side:P.bear?'resistance':'support', price:+(+P.level.p).toFixed(6), holds:P.level.prob},
                alert: P.hasAlert ? {name:P.ev.name, conf:P.ev.conf, source:P.ev.src, bothSources:!!P.both} : null, barsSinceTouch:P.after,
                turnedBackBars:+(Math.floor(Math.max(0,P.best||0)*10)/10).toFixed(1), rsiWithTurn:!!(P.rows||[]).find(function(r){return r.lbl==='RSI turning'&&r.on;}), h4Agrees:!!P.h4, likelyNews:!!P.big,
                earlyLine: P.EL!=null ? {name:P.bear?'HL':'LH', price:+(+P.EL).toFixed(6), closesBeyond:P.eBeyond, confirmed:P.state==='early'} : null,
                officialLine: P.HL!=null ? {name:P.bear?'HL':'LH', price:+(+P.HL).toFixed(6), closesBeyond:P.beyond,
                              confirmed:P.state==='confirmed'} : null,
                points:(P.rows||[]).filter(function(r){return r.pts;}).map(function(r){return r.lbl+' '+(r.pts>0?'+':'')+r.pts;}),
                ladder: (function(T){ if(!T||!T.L) return null; var L=T.L; return {step:L.ended==='broken'?'broken':L.pending?'watching for the reclaim':L.step===3?'waiting for the shift':L.step===4?'waiting for the trigger':L.step===5?'waiting for the follow-through':'the turn',
                          classic:!!L.classic, reclaimed:!!L.reclaimed, retests:T.ret, backAtLevel:!!T.retest, furthestPips:+T.pipsOf(T.far).toFixed(1)}; })(P.track)};
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
    const closed = cd.slice(0, -1), R = cfRsiSeries(closed);
    /* LIVE RSI (Oct 2026). The value used to be the RSI field of the EA's PATTERN payload, which only
       changes when that payload is re-sent — so between sends it never moved, Rising/Falling could not
       settle, and the lines below (which need a direction) almost never appeared: the banner read the
       same "nothing in momentum…" for weeks. RSI 14 is now worked out from the candles INCLUDING the
       forming one (Wilder's method, as MT5 does), so it moves with price on every refresh. */
    const RL = cfRsiSeries(cd);
    let v = RL[RL.length-1], src = 'live, from the candles';
    if(!isFinite(v)){ v = parseFloat(d.rsi); src = 'MT5 value'; }
    if(!isFinite(v) || v < 0 || v > 100) v = R[R.length-1];
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

const PR_LOCK = prMemLoad('lock');

const PR_EP = prMemLoad('ep');

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

function readRevPressure(cd, o, alerts, raised, RX, extraLv){
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
      prob:isFinite(+l.prob)?+l.prob:null, tests:+l.tests||0, trend:!!l.trend}))
    .filter(l => isFinite(l.p) && (l.tier === 'major' || l.tier === 'medium'))
    /* THE TURN'S OWN HIGH / LOW (Nov 2026): while the counter-trend check is open, the extreme the
       counter candles turned from is read as a level too. Strong trends turn at fresh highs where no
       level exists, so without it the engine read only 23% of those turns (91% with it, tested on
       10 years with no rise in misreadings). Scored as a medium level, labelled as what it is. */
    .concat((extraLv || []).filter(l => l && isFinite(+l.price)).map(l => ({p:+l.price, lo:+l.lo, hi:+l.hi,
      role:String(l.type||'').toLowerCase().indexOf('res')>=0?'R':'S', tier:'medium', prob:null, tests:0, trend:true})));
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
    /* FIX (Nov 2026): follow the attempt's level within a small tolerance. An exact price match lost
       the attempt (and restarted it) whenever the level moved by a fraction of a pip. */
    const lvL = levels.filter(l => l.role === lock.role && Math.abs(l.p - lock.p) <= tol)
                      .sort((a,b) => Math.abs(a.p - lock.p) - Math.abs(b.p - lock.p))[0];
    if(lvL) lock.p = lvL.p;
    let iT = -1; for(let i=n-1;i>=0;i--) if(bwBarMs(cd[i]) === lock.t0){ iT = i; break; }
    if(lvL && iT >= 0) touch = {i:iT, lv:lvL};
    /* FIX (Nov 2026): a lost attempt is closed, not forgotten, so the same visit cannot restart on a
       neighbouring level from the same old candles. */
    else { lock.done = true; lock.doneT = bwBarMs(cd[n-2]); }
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
  add(lv.trend ? 'At the '+(bull?'low':'high')+' the turn started from (no prior level)' : 'At a '+lv.tier+' '+(bull?'support':'resistance'), lv.tier==='major'?25:12, true,
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
  const mem = PR_EP[key] && PR_EP[key].t === bwBarMs(cd[ti]) && Math.abs(PR_EP[key].p - L) <= tol ? PR_EP[key] : (PR_EP[key] = {t:bwBarMs(cd[ti]), p:L});
  let HL = null;
  if(f.decider && isFinite(f.decider.p) && ((bear && f.dir === 'up') || (bull && f.dir === 'down')) && !f.flipped) HL = f.decider.p;
  if(HL == null && mem.HL != null) HL = mem.HL;
  if(HL == null){ const w = cd.slice(Math.max(0, ti-20), ti); if(w.length) HL = bear ? Math.min.apply(null, w.map(b=>b.l)) : Math.max.apply(null, w.map(b=>b.h)); }
  if(mem.HL == null || (f.decider && HL === f.decider.p)) mem.HL = HL;   /* FIX (Nov 2026): follow the trend engine's latest HL, the same line the Combined Read uses */
  let tw = bear ? (f.dir==='up' && !f.flipped ? 'uptrend' : null) : (f.dir==='down' && !f.flipped ? 'downtrend' : null);
  if(tw && !mem.tw) mem.tw = tw; if(!tw) tw = mem.tw || (bear ? 'move up' : 'move down');
  /* FIX (Nov 2026): RSI agreement is read from CLOSED candles at the close that completes the
     break (RSI over the two break candles), and a confirmation, once made, stays made. It used to
     need the live 3-minute RSI direction to agree at every refresh, so "confirmed" fell back to
     "broken" whenever RSI paused, which also restarted the attempt's end timer. */
  const CR = prRsi(cd.slice(0, -1));
  const rsiWithAt = i => i >= 2 && CR[i] != null && CR[i-2] != null && (bull ? CR[i] > CR[i-2] : CR[i] < CR[i-2]);
  let beyond = 0, confirmed = false, confAt = -1;
  if(HL != null && !cancelled){
    let run = 0;
    for(let i=ti;i<=last;i++){ run = (bear ? cd[i].c < HL : cd[i].c > HL) ? run+1 : 0; if(run >= 2 && confAt < 0 && rsiWithAt(i)) confAt = i; }
    beyond = run;
    if(confAt >= 0) confirmed = true;
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
    if(EL != null){ let run = 0, eConf = -1; for(let i=Math.max(extI,ti);i<=last;i++){ run = (bear ? cd[i].c < EL : cd[i].c > EL) ? run+1 : 0; if(run >= 2 && eConf < 0 && rsiWithAt(i)) eConf = i; } eBeyond = run;
      if(state === 'live' || state === 'atlevel'){ if(eConf >= 0) state = 'early'; else if(eBeyond >= 2) state = 'earlybreak'; } }
  }
  /* 9. THE ATTEMPT'S LIFE: held from the first turn until it ends, and the
        ending is shown before the normal verdict takes the floor back. */
  const ACTIVE = {live:1, early:1, earlybreak:1, broken:1, confirmed:1};
  if((!PR_LOCK[key] || PR_LOCK[key].done) && (ACTIVE[state] || state === 'failed')) PR_LOCK[key] = {p:L, role:lv.role, t0:bwBarMs(cd[ti])};
  const lk = PR_LOCK[key];
  let endIn = null;
  /* FIX (Nov 2026): an early confirmation, once made, is kept (a new extreme used to drop it). */
  if(lk && !lk.done && Math.abs(lk.p - L) <= tol){
    if(state === 'early' && !lk.earlyT) lk.earlyT = bwBarMs(cd[last]);
    if(lk.earlyT && (state === 'live' || state === 'atlevel' || state === 'earlybreak')) state = 'early';
    /* FIX (Nov 2026): every attempt ends. 20 candles after the touch without a full confirmation:
       a turn that never broke anything has faded; a break RSI never backed has expired. */
    if(after >= 20 && (state === 'live' || state === 'atlevel')) state = 'faded';
    if(after >= 20 && (state === 'early' || state === 'earlybreak' || state === 'broken')) state = 'expired';
    /* FIX (Nov 2026): an ending, once reached, is kept for its hold and never restarted. */
    if(lk.endState) state = lk.endState;
    if(state === 'failed' || state === 'confirmed' || state === 'faded' || state === 'expired'){
      if(!lk.endT){ lk.endT = bwBarMs(cd[last]); lk.endState = state; }
      let since = 0; for(let i=last;i>=0 && bwBarMs(cd[i]) > lk.endT;i--) since++;
      const hold = state === 'confirmed' ? 5 : 3;
      endIn = hold - since;
      if(since >= hold){ lk.done = true; lk.doneT = bwBarMs(cd[last]); out.state = 'idle'; return out; }
    }
  }
  if(state === 'expired'){ rows.push({lbl:'Ended without confirmation', pts:-score, on:true, neg:true, sub:'20 bars since the touch; the break was never backed by RSI'}); score = 0; }
  if(state === 'faded'){ rows.push({lbl:'Faded', pts:-score, on:true, neg:true, sub:after+' bars since the touch with neither line broken'}); score = 0; }
  const evOut = ev || {name:'no alert yet', conf:0, src:'—'};
  const RR = Object.assign(out, {__key:key, state, cancelBy, score:Math.max(0,Math.min(100,score)), prov, rows, bear, level:lv, ev:evOut, hasAlert:!!ev, both,
    ft, best, after, h4, big, HL, beyond, rsi:RX&&RX.v, F, trendWord: tw, ext, ti, touchI, extI, cd, EL, elI, eBeyond, endIn});
  /* the ladder, where price is now and the path since the touch (Nov 2026): added, never changes the above */
  try{ RR.track = prTrack(RR, alerts, raised); }catch(e){ console.warn('[pressure track]', e && e.message); RR.track = null; }
  return RR;
}

function prHead(P){
  const F = P.F || (v => (+v).toFixed(digitsOf(pair))), conf = P.state === 'confirmed';
  const lv = P.level, lvw = lv.trend ? (P.bear?'high':'low')+' the turn started from' : lv.tier+' '+(P.bear?'resistance':'support'), hl = P.bear ? 'HL' : 'LH', tr = P.trendWord;
  const al = P.hasAlert ? P.ev.name+' ('+P.ev.conf+'%'+(P.both?', Live tab and Assistant':', '+P.ev.src)+')' : null;
  let w, l;
  if(P.state==='failed'){ w='Reversal attempt failed — the '+tr+' is back in charge'; l=(P.cancelBy==='long'?'One long candle closed ':'Two candles closed ')+(P.bear?'above':'below')+' the '+lvw+' zone ('+F(P.bear?lv.hi:lv.lo)+') — the level did not hold and the '+tr+' has resumed. The pressure reading is cancelled.'; }
  else if(conf){ w='Reversal confirmed — the '+tr+' has ended'; l='Price closed '+(P.bear?'below':'above')+' the '+hl+' at '+F(P.HL)+' on two bars and RSI agrees. It began as a turn off the '+lvw+' at '+F(lv.p)+(al?' with a '+al:'')+'. A confirmed break is not a forecast.'; }
  else if(P.state==='expired'){ w='Ended unconfirmed — the break was never backed'; l=P.after+' bars since price touched the '+lvw+' at '+F(lv.p)+'. A line broke, but RSI never confirmed it on closed candles, so the attempt has ended without a reversal.'; }
  else if(P.state==='faded'){ w='Faded — price did not follow through'; l=P.after+' bars since price touched the '+lvw+' at '+F(lv.p)+' and neither the early line nor the full reversal line has broken. The attempt is over.'; }
  else if(P.state==='early'){ w='Early reversal confirmed — not the full reversal yet'; l='Price closed '+(P.bear?'below':'above')+' the last '+(P.bear?'higher low':'lower high')+' of the move into the '+lvw+' ('+F(P.EL)+') on two bars, and RSI is '+(P.bear?'falling':'rising')+' with it. This is the first structure break of the turn. The full reversal needs two closes '+(P.bear?'below':'above')+' the '+hl+' at '+(P.HL!=null?F(P.HL):'—')+'. Early breaks fail more often than full ones.'; }
  else if(P.state==='earlybreak'){ w='Early break — momentum not confirming yet'; l='Two closes '+(P.bear?'below':'above')+' the early line at '+F(P.EL)+', but RSI is not '+(P.bear?'falling':'rising')+' with it. It becomes an early confirmed reversal when RSI turns.'; }
  else if(P.state==='broken'){ w='Structure broken — momentum not confirming yet'; l='Two closes '+(P.bear?'below':'above')+' the '+hl+' at '+F(P.HL)+', but RSI is not '+(P.bear?'falling':'rising')+' with it. It becomes a confirmed reversal when RSI turns.'; }
  else if((P.state==='live'||P.state==='atlevel') && P.track && P.track.pending){ w='Closed '+(P.bear?'above':'below')+' the '+lvw+' — watching for the reclaim'; l='One candle closed '+(P.bear?'above':'below')+' it. The next close back '+(P.bear?'below':'above')+' it reclaims it (a sweep); a second close '+(P.bear?'above':'below')+' means it has broken.'; }
  else if((P.state==='live'||P.state==='atlevel') && P.track && P.track.retest){ const T=P.track; w='Back at the '+lvw+' — testing it again, not broken';
    l='Price turned off the '+lvw+' at '+F(lv.p)+', got '+(Math.floor(T.best*10)/10).toFixed(1)+' average candles away ('+T.pipsOf(T.far).toFixed(1)+' pips), and has come back to it'+(T.ret>1?' for the '+(T.ret===2?'second':T.ret+'th')+' time':'')+'. No two closes '+(P.bear?'above':'below')+' it, so the level still stands. A return to the level did not change how often the turn carried on (10 years of tests), so the score is unchanged.'; }
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
    rsi: RX && RX.v!=null ? {v:Math.round(RX.v), tag:RX.tag||null} : null,
    cx: N.cx || null
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
  else if(P && P.key===key) r = {verdict:null, score:null, broken:false, standDown:true, holder:null, dir:0, note:P.why||null, from:'engine'};
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
    try{ liq=liqFromAssistant(pair, tf, cd); if(liq) liqSource='assistant'; }catch(e){}
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
  window.__BWPullback = {key: pair+'|'+tf, a: (a && a.ok) ? a : null, why: (a && !a.ok && a.reason) || null};   /* the Combined Read reads the same answer */
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
  window.__BWMandateKey=pair+'|'+tf;   /* so a reader can tell it is for THIS pair */

  /* LAW 2 ENFORCED: the range engine does not even run while structure
     reads directional pivots. It used to run every cycle and could seed
     a box in the middle of a trend's retracement — the exact failure. */
  /* ── THE HISTORIAN AND THE TWO NEW ENGINES ───────────────────────
     Order matters and mirrors the hierarchy:
       1. structure has already read the market (inside govern)
       2. the watchers run and REPORT — they cannot decide anything
       3. the historian records, marks its lines, and builds the context
       4. the governor is handed that context alongside the live reading
     A watcher reports to the HISTORIAN, never to the governor directly,
     so nothing can sneak itself the market. */
  /* ONE HISTORIAN PER PAIR AND TIMEFRAME.
     A single shared instance was observing every chart the trader
     opened, so EUR/USD H1 bars and XAU/USD H4 bars went into the same
     record — the regime sequence, the level register and the frozen
     extreme were all built from a blend of unrelated markets. Keyed now,
     and created with that pair's own pip so the distances mean
     something. */
  var HKEY = pair+'|'+tf;
  var HBOOK = (window.__BWHistAll = window.__BWHistAll || {});
  var HIST = HBOOK[HKEY] || (HBOOK[HKEY] = (window.BWHistorian
    ? window.BWHistorian.create({pip:(window.BWRange?BWRange.pipOf(brokerSym[pair]||pair):0.0001)})
    : null));
  window.__BWHist = HIST;          /* the console handle follows the chart */
  var CTX = null, chopRead = null, driftRead = null;
  if(HIST){
    try{ chopRead  = window.BWChop  && BWChop.read(cd,{pip:(window.BWRange?BWRange.pipOf(brokerSym[pair]||pair):0.0001)}); }catch(e){}
    try{ driftRead = window.BWDrift && BWDrift.read(cd,{pip:(window.BWRange?BWRange.pipOf(brokerSym[pair]||pair):0.0001),dp:digitsOf(pair)}); }catch(e){}
    try{ HIST.report('chop',  chopRead  ? {claims:!!chopRead.isChop,        confidence:chopRead.confidence,  why:chopRead.why } : null); }catch(e){}
    try{ HIST.report('drift', driftRead ? {claims:!!driftRead.nothingHolding,confidence:driftRead.confidence,why:driftRead.why} : null); }catch(e){}
    try{ CTX = HIST.observe(cd, (mandate && mandate.ok) ? {ok:true, regime:mandate.regime,
             confidence:mandate.confidence, marked:(mandate.pivots||[])} : null); }catch(e){}
  }
  /* The governor now has the map and the past. It still decides alone. */
  if(mandate && mandate.ok && CTX) mandate.context = CTX;

  const rangeAllowed = !mandate || !mandate.ok || mandate.permits.range;
  /* Declared here, beside the mandate, because BOTH the verdict card and
     the open-position action line need it. It was previously declared
     inside the verdict block and referenced earlier — a ReferenceError
     that killed the rest of the render, taking the pivot marks and the
     stop lines with it. */
  const govOK = !mandate || !mandate.ok || mandate.permits.pullback;
  /* Dim the pullback engine's own output when it has no mandate, so it
     reads as reference rather than as instruction. Shown, not hidden —
     the trader still needs to see what it was weighing. */
  /* ── STAND THE PULLBACK VIEW DOWN, DO NOT JUST DIM IT ─────────────
     Dimming the verdict was not enough: the card still HEADED itself
     "Is this a pullback or a reversal?" and still showed the
     pullback / undecided / reversal meter, so the whole panel read as
     the pullback engine working — which is what he kept seeing. When it
     has no mandate the card says so in its own title, the meter and its
     scale are hidden entirely (there is no score to place on them), and
     the remaining detail is dimmed to reference. */
  /* THE RETRACEMENT TAB'S FINAL ANSWER, worked out BEFORE it is drawn (Nov 2026), so the Arbiter's copy of
     this page (combined-read.js, which stops before the drawing) publishes the same answer the tab shows. */
  /* THE TITLE SAID "structure is holding" WHENEVER PULLBACK WAS NOT
     PERMITTED — including when the RANGE engine was driving. So on a
     real EUR/USD window the pill read "Range — range engine driving"
     and this read "structure is holding", three inches apart.
     `govOK` only knows whether PULLBACK may speak. Who actually holds
     the market is `mandate.holder`, and that is what the title has to
     name — same source as the pill and the badge. */
  /* ── THE GOVERNOR OVERRULES A MISSED REVERSAL ────────────────────
     His instruction: the governor knows what each engine is for, and
     it knows from the historian where every marked level sits and how
     many times each has held. So when price BREAKS the level that
     defined the trend, the governor tells the pullback engine "this is
     a reversal — show it to the trader", even if the pullback engine
     has not called it yet.
     The pullback engine reads a window; the historian remembers that
     this exact level held three times before. Only the second of those
     can tell a break from a wobble, which is why the prompt comes from
     here and not from inside the engine. */
  const RP = (mandate && mandate.context && mandate.context.reversalPrompt) || null;
  /* STRUCTURE IS THE ARBITER. Once the sequence is complete — price
     retraced from the frozen extreme and then broke the other side —
     the meter is no longer answering a live question, so it is ditched
     rather than left showing a score beside a settled verdict. */
  const FZ = (mandate && mandate.context && mandate.context.frozen) || null;
  if(FZ && FZ.stage==='reversed' && a && a.ok){
    a.meterOff = true;
  }
  if(RP && RP.fire && a && a.ok && !/reversal/.test(a.verdict||'')){
    a.verdict = 'reversal-by-structure';
    a.governorPrompt = RP.say;
    a.score = Math.max(a.score||0, 70);
    (a.factors=a.factors||[]).unshift({w:+28, label:'Decisive level broken',
      detail: RP.say});
  }
  const who = (mandate && mandate.ok && !mandate.suspended) ? mandate.holder : 'structure';
  /* THE FINAL ANSWER THIS TAB SHOWS — after the governor's override and the
     stand-down — kept so the Combined Read can publish it for Arbiter. */
  window.__BWPullbackFinal = (a && a.ok) ? {key:pair+'|'+tf, verdict:a.verdict, score:a.score,
    broken:!!a.structurallyBroken, standDown:!(govOK && who==='pullback'), holder:who, dir:(a.trend&&a.trend.dir)||0,
    note:(a.factors&&a.factors[0]&&a.factors[0].label)||null}
    : {key:pair+'|'+tf, verdict:null, score:null, broken:false, standDown:true, holder:who, dir:0,
       note:(a&&a.reason)||null};
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
    try{ const lb=$('cxLive'), ab=$('cxAlerts'); if(lb) lb.innerHTML=''; if(ab) ab.innerHTML=''; }catch(e){}
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
  try{ liq=liqFromAssistant(pair, tf, cd); if(liq && liq.cls==='learn') liq=null; }catch(e){ liq=null; }
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
  /* THE COUNTER-TREND CHECK (Nov 2026), read before the reversal engine: while it is open, the engine also
     reads the high/low the turn started from, and both use the trend engine's HL/LH (one line, not two). */
  let CXB = null, CXE = null, CXTL = null, CXoff = null;
  try{ CXoff = cxOffset(); cxCollect(cd, alerts, raised); CXB = cxBars(cd); CXE = cxEpisode(CXB, cxRec().eng); CXTL = cxTrendLevel(CXE, CXB); }
  catch(e){ console.warn('[counter-trend]', e && e.message); CXB = null; CXE = null; CXTL = null; }
  try{ PR = readRevPressure(cd, cxFrame(o, CXB), alerts, raised, RX, CXTL ? [CXTL] : null); window.__cfPressure = PR; prMemSave(); }
  catch(e){ console.warn('[pressure]', e && e.message); }
  /* the engine's confirmation, remembered on the bar it was made, so the check can tick its box */
  try{ if(CXB && CXB.length && PR && PR.state === 'confirmed' && PR.level){
         const eng = cxRec().eng, lt = CXB[CXB.length-1].t; if(!eng[lt]) eng[lt] = {d: PR.bear ? -1 : 1, lv: PR.level.p};
         CXE = cxEpisode(CXB, eng); } }catch(e){}

  /* THE PRESSURE READING REPLACES THE OLD REVERSAL SIDE. The engine's
     pressure-led verdict (pressing / breaking / broken) is swapped for
     the level-touch reading; every other verdict is left exactly as is. */
  const prOn = PR && PR.state !== 'idle' && PR.state !== 'nolevels';
  /* TURN-TAKING: while a reversal is building (or has just broken / confirmed),
     the pressure reading has the floor and the other engines wait. */
  const prLead = prOn && (PR.state === 'live' || PR.state === 'early' || PR.state === 'earlybreak' || PR.state === 'broken' || PR.state === 'confirmed' || PR.state === 'failed' || PR.state === 'faded' || PR.state === 'expired');
  window.__cfPrLead = prLead ? PR : null;
  if(prLead || o.pressureLed){
    if(prOn && (prLead || PR.state === 'atlevel')){ const hd = prHead(PR);
      o = Object.assign({}, o, {word: hd.w, line: hd.l, supports: [], contradictions: [], weakens: [],
        state: PR.state==='faded'||PR.state==='expired' ? 'quiet' : PR.state==='confirmed' ? 'broken' : PR.state==='broken'||PR.state==='early'||PR.state==='earlybreak' ? 'breaking' : PR.state==='failed' ? 'quiet' : 'pressing'}); }
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
    /* CLOSED CANDLES ONLY (Nov 2026): a pattern on the still-forming candle could become the trigger;
       the verdict now takes its trigger from the last two CLOSED candles. */
    const CTR = cxClosedTrig(o.trig, cd);
    NR = window.BWRead2 ? window.BWRead2.read(cd, {key:pair+'|'+tf, pip:pipOf(pair), levels:lvR, trig:CTR, rel:o.rel, range:rangeIn,
           msOf:bwBarMs, hourOf:bwBarHourUTC, fmt:p=>(+p).toFixed(digitsOf(pair))}) : null;
    if(NR && NR.ok && NR.sig && CTR) NR.sigAgo = CTR.barsAgo;
  }catch(e){ console.warn('[read2]', e && e.message); NR = null; }
  /* ONE VOICE + THE LIVE CANDLE WATCH (Nov 2026): the counter-trend check feeds the verdict, so the card, the
     check and what the Trading Brain reads all say the same thing; the forming candle is watched against it. */
  let CXV = null, CXW = null, CXR = null;
  try{ if(NR && NR.ok && CXB){
    const prim = (alerts || []).filter(a => a && a.bar_index != null && +a.bar_index === 0).map(a => Object.assign({}, a, {__src:'EA live read'}));
    const back = ((((DATA[pair]||{})[tf]||{}).forming_patterns) || []).map(a => Object.assign({}, a, {__src:'Assistant read (back-up)'}));
    const ef = prim.length ? prim : back;
    try{ CXR = cxRange(cd, CXB, NR); }catch(e){ console.warn('[range check]', e && e.message); CXR = null; }
    /* ONE READING OF THE MARKET (Nov 2026). The check follows the trend engine candle by candle, but the Combined
       Read can call a range from the Retracement tab's range engine while that per-candle trend still says up or
       down. Then the Range card was hidden behind a counter-trend card showing "uptrend". When the Combined Read
       says range, an open counter-trend check is closed and the Range check is what shows. */
    if(CXR && !CXR.broke && CXE && !cxEnded(CXE)){ CXE = Object.assign({}, CXE, {state:'ranged', end: CXB.length-1}); CXTL = null; }
    /* ...and the last candle reads as a range for the live watch, the live reading and what is published, which
       all took "the trend" from that per-candle reading (so they could talk about an uptrend inside a range). */
    if(CXR && !CXR.broke && CXB.length){ const L = CXB[CXB.length-1]; if(cxDirOf(L.reg)) CXB[CXB.length-1] = Object.assign({}, L, {reg: Object.assign({}, L.reg, {r:'r'})}); }
    CXV = cxVoice(NR, CXE, null, PR, CXTL, CXR, CXB);
    CXW = cxWatch(cd, CXB, CXE, CXV, NR, ef, CXR);
    CXV = cxVoice(NR, CXE, CXW, PR, CXTL, CXR, CXB);
    NR = Object.assign({}, NR, {head:CXV.head, sub:CXV.sub, tone:CXV.tone, trade:CXV.trade, voice:{press:CXV.press, suppressed:CXV.suppressed}});
    if(document.getElementById('confBody')) cxAlerts(cd, CXW, CXoff);   /* the page only: the Arbiter's copy never raises the dot or Telegram */
  } }catch(e){ console.warn('[candle watch]', e && e.message); CXW = null; CXV = null; }
  window.__cfRead2 = NR;
  try{ window.__cxLast = {ep: CXE, tl: CXTL, voice: CXV, watch: CXW, range: CXR}; }catch(e){}   /* the last check reading, for debugging a live screen */
  let CXK = null;
  try{ if(NR && NR.ok && CXB){ CXK = ((!CXE || cxEnded(CXE)) && CXR) ? cxRangeCard(CXR, CXB, CXoff) : cxCheckCard(CXE, CXB, CXW, PR, CXTL, CXoff);
         NR = Object.assign({}, NR, {cx: cxPack(cd, NR, CXV, CXE, CXR, CXW, CXB, CXoff, CXK)}); } }catch(e){ console.warn('[read publish]', e && e.message); }
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
      /* the engine files' copied helpers (digitsOf, bwDG) read the page's pair, tf and SERIES as GLOBALS; Arbiter has
         none, so they fell back to 5 decimals. Lent for this run only and put back after (Nov 2026). */
      var LENT = ['pair', 'tf', 'SERIES'], had = LENT.map(function(k){ return Object.prototype.hasOwnProperty.call(root, k) ? [true, root[k]] : [false]; });
      root.pair = pair; root.tf = tf; root.SERIES = SERIES;
      try{
        /* the page's own order each refresh: chart, retracement, Combined Read */
        makeChart(w)();
        makeRetrace(w)();
        makeConf(w)();
      } finally {
        LENT.forEach(function(k, i){ if(had[i][0]) root[k] = had[i][1]; else { try{ delete root[k]; }catch(e){ root[k] = undefined; } } });
      }
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
