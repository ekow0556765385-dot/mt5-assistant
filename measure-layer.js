/* ══════════════════════════════════════════════════════════════════
   MEASUREMENT — the ruler, the lock, and fitting the setup

   Behaviour lifted from the approved prototype without change. The
   prototype drew its own chart; the real tab already has one, so this
   takes the chart's coordinate functions instead of carrying a second
   renderer.

   WHY FITTING MATTERS — found in real history, not invented
   Running the shipped pattern engine over real bars turned up XAU/USD H4
   where a Rising Wedge formed after the market had already run 1,263
   pips up. The chart spanned 1,839 pips; the trigger-to-target move was
   62 — THREE POINT FOUR PER CENT of the chart height. Fully on screen
   and completely unreadable, because the trend leading in owned the
   price range. Fitting drops the approach: the move becomes 15% of the
   chart, 4.4x bigger.

   This decides nothing about the market. It measures what the trader
   points at and reports the distance.

   g must provide: y(price) py(pixel) W padL padR padT pip dp
   ══════════════════════════════════════════════════════════════════ */
(function(root){
'use strict';

const S = {
  M:null,                      /* the band: {a,b,x0,x1,anchorX,kind,closeBox} */
  KEPT:{reward:null,risk:null},/* the trader's own finished legs */
  grab:null, locked:false, fit:false, mode:'both', anim:null
};
function reset(){ S.M=null; S.KEPT.reward=null; S.KEPT.risk=null; S.grab=null; }

/* ── WHICH LEG, BY DIRECTION NOT BY SNAPPING ───────────────────────
   Keyed on snapping to a named level, the measurement became "free" the
   instant the trader dragged PAST the target — the colour went neutral
   and the ratio vanished, which made the target feel like the end of the
   ruler. Direction from the start point holds 1 pip out and 500 out. */
function kindOf(pat,pip){
  if(!S.M) return 'free';
  const moved=S.M.b.price-S.M.a.price;
  if(Math.abs(moved)/pip<0.05) return 'free';
  return (pat.dir>0)?(moved>0?'reward':'risk'):(moved<0?'reward':'risk');
}
/* The other leg always exists, so a ratio is always available: the
   trader's own measurement if they have made one, else the pattern's
   level. Never left without a number. */
function otherLeg(kind,pat,pip){
  const mine=S.KEPT[kind==='reward'?'risk':'reward'];
  if(mine) return mine.pips;
  return kind==='reward'?Math.abs(pat.invalid-pat.trigger)/pip
                        :Math.abs(pat.target -pat.trigger)/pip;
}
function snap(price,g,pat){
  let best=null;
  [['trigger',pat.trigger],['target',pat.target],['invalidation',pat.invalid]].forEach(function(t){
    if(!Number.isFinite(t[1])) return;
    const d=Math.abs(g.y(price)-g.y(t[1]));
    /* 5px, not 9 — a wide radius felt like the ruler was being HELD at a
       level rather than helped onto it. */
    if(d<5&&(!best||d<best.d)) best={d:d,name:t[0],price:t[1]};
  });
  return best?{price:best.price,snapped:best.name}:{price:price,snapped:null};
}
function seed(mode,pat,g){
  const L=g.padL+30, R=g.W-g.padR-30, mid=(L+R)/2;
  if(mode==='reward'||mode==='both')
    S.KEPT.reward={pips:Math.abs(pat.target-pat.trigger)/g.pip,a:pat.trigger,b:pat.target};
  if(mode==='risk'||mode==='both')
    S.KEPT.risk={pips:Math.abs(pat.invalid-pat.trigger)/g.pip,a:pat.trigger,b:pat.invalid};
  if(mode==='risk') S.M={a:{price:pat.trigger,snapped:'trigger'},b:{price:pat.invalid,snapped:'invalidation'},x0:L,x1:R,anchorX:mid};
  else if(mode==='reward'||mode==='both') S.M={a:{price:pat.trigger,snapped:'trigger'},b:{price:pat.target,snapped:'target'},x0:L,x1:R,anchorX:mid};
  else S.M=null;
  S.mode=mode;
}

/* ── FITTING CROPS THE BARS, not just the price scale ──────────────
   Touching only the vertical scale changed nothing measurable: the
   levels were already inside the window. The trend leading in owns the
   range, so fitting drops it. 3 bars of context — more and the approach
   sets the range again. */
function barRange(total,pat,fitted){
  if(!fitted||!Number.isFinite(pat.startI)) return {from:0,to:total};
  const pad=3;
  return {from:Math.max(0,pat.startI-pad), to:Math.min(total,pat.endI+pad)};
}
function scaleFor(cd,pat,fitted){
  const r=barRange(cd.length,pat,fitted);
  const v=cd.slice(r.from,r.to);
  if(!v.length) return null;
  let hi=Math.max.apply(null,v.map(c=>+c.h||+c.high)), lo=Math.min.apply(null,v.map(c=>+c.l||+c.low));
  if(fitted){
    [pat.trigger,pat.target,pat.invalid].forEach(function(x){
      if(Number.isFinite(x)){hi=Math.max(hi,x);lo=Math.min(lo,x);} });
  } else {
    const sh=hi-lo;
    [pat.trigger,pat.invalid].forEach(function(x){ if(Number.isFinite(x)){hi=Math.max(hi,x);lo=Math.min(lo,x);} });
    if(Number.isFinite(pat.target)&&pat.target<=hi+sh*0.35&&pat.target>=lo-sh*0.35){
      hi=Math.max(hi,pat.target); lo=Math.min(lo,pat.target); }
  }
  const pd=(hi-lo)*0.07;
  return {hi:hi+pd,lo:lo-pd,from:r.from,to:r.to};
}
/* eased over 380ms so the reframe reads as a movement, not a jump cut */
function animated(target,redraw){
  if(!S.anim||!target) return target;
  const k=Math.min(1,(performance.now()-S.anim.t0)/380);
  if(k>=1){ S.anim=null; return target; }
  const e=k<0.5?2*k*k:1-Math.pow(-2*k+2,2)/2;
  if(redraw) requestAnimationFrame(redraw);
  return {hi:S.anim.fromHi+(target.hi-S.anim.fromHi)*e,
          lo:S.anim.fromLo+(target.lo-S.anim.fromLo)*e,
          from:target.from,to:target.to};
}
function toggleFit(cd,pat,redraw){
  const from=scaleFor(cd,pat,S.fit);
  S.fit=!S.fit;
  if(from) S.anim={fromHi:from.hi,fromLo:from.lo,t0:performance.now()};
  if(redraw) redraw();
  return S.fit;
}

function draw(c,g,pat){
  if(!S.M||!pat) return;
  const M=S.M, y1=g.y(M.a.price), y2=g.y(M.b.price);
  /* COLOUR BY MEANING, NEVER BY DIRECTION. Keyed on b>a, a bearish
     pattern's reward came out RED and its risk GREEN — backwards on
     every top. */
  const kind=kindOf(pat,g.pip); M.kind=kind;
  const col = kind==='reward'?'#17a97a':kind==='risk'?'#e0504f':'#5b87c9';
  const L=Math.min(M.x0,M.x1), R=Math.max(M.x0,M.x1);
  c.fillStyle = kind==='reward'?'rgba(23,169,122,.11)':kind==='risk'?'rgba(224,80,79,.11)':'rgba(91,135,201,.10)';
  c.fillRect(L,Math.min(y1,y2),R-L,Math.abs(y2-y1));
  c.strokeStyle=col; c.lineWidth=1.5;
  c.beginPath(); c.moveTo(L,y1); c.lineTo(R,y1); c.moveTo(L,y2); c.lineTo(R,y2); c.stroke();
  const mx=(L+R)/2;
  c.beginPath(); c.moveTo(mx,y1); c.lineTo(mx,y2); c.stroke();
  [[y1,y2],[y2,y1]].forEach(function(pr){ const d=pr[0]<pr[1]?1:-1;
    c.beginPath(); c.moveTo(mx,pr[0]); c.lineTo(mx-4.5,pr[0]+d*8); c.lineTo(mx+4.5,pr[0]+d*8);
    c.closePath(); c.fillStyle=col; c.fill(); });
  [[L,y1],[R,y1],[L,y2],[R,y2]].forEach(function(pt){
    c.fillStyle='#14141c'; c.strokeStyle=col; c.lineWidth=1.4;
    c.beginPath(); c.arc(pt[0],pt[1],3.6,0,Math.PI*2); c.fill(); c.stroke(); });

  const span=Math.abs(M.b.price-M.a.price)/g.pip;
  const from=M.a.snapped||M.a.price.toFixed(g.dp);
  const to  =M.b.snapped||M.b.price.toFixed(g.dp);
  let label=span.toFixed(1)+' pips   '+from+' \u2192 '+to;
  if(kind!=='free'){
    const o=otherLeg(kind,pat,g.pip);
    if(o>0) label+='     '+((kind==='reward')?span/o:o/span).toFixed(2)+' : 1';
  }
  const ax=(M.anchorX!=null?M.anchorX:mx), ay=y1;
  c.font='700 10.5px Archivo,-apple-system,sans-serif';
  const w=c.measureText(label).width+18, h=20;
  let bx=Math.max(g.padL+2, Math.min(ax-w/2, g.W-g.padR-w-11));
  let by=ay-h-11; if(by<g.padT+9) by=ay+11;
  c.fillStyle='#14141c'; c.strokeStyle=col; c.lineWidth=1; c.globalAlpha=.97;
  if(c.roundRect){ c.beginPath(); c.roundRect(bx,by,w,h,6); c.fill(); c.stroke(); }
  else { c.fillRect(bx,by,w,h); c.strokeRect(bx,by,w,h); }
  c.globalAlpha=1; c.fillStyle=col; c.textAlign='left';
  c.fillText(label,bx+8,by+h/2+3.5);
  /* the × OUTSIDE the pill, on its upper-right corner, in its own
     circle so it does not eat into the label */
  const cxx=bx+w+2, cyy=by-2;
  M.closeBox={x:cxx-8,y:cyy-8,w:17,h:17};
  c.fillStyle='#14141c'; c.strokeStyle=col; c.lineWidth=1;
  c.beginPath(); c.arc(cxx,cyy,7,0,Math.PI*2); c.fill(); c.stroke();
  c.lineWidth=1.3; c.globalAlpha=.75; c.beginPath();
  c.moveTo(cxx-3.2,cyy-3.2); c.lineTo(cxx+3.2,cyy+3.2);
  c.moveTo(cxx+3.2,cyy-3.2); c.lineTo(cxx-3.2,cyy+3.2);
  c.stroke(); c.globalAlpha=1;
}

function hit(pt,g){
  if(!S.M) return null;
  const y1=g.y(S.M.a.price), y2=g.y(S.M.b.price);
  const L=Math.min(S.M.x0,S.M.x1), R=Math.max(S.M.x0,S.M.x1);
  if(Math.abs(pt.y-y1)<11) return 'a';
  if(Math.abs(pt.y-y2)<11) return 'b';
  if(pt.y>Math.min(y1,y2)&&pt.y<Math.max(y1,y2)&&pt.x>L-14&&pt.x<R+14) return 'move';
  return null;
}
function recordLeg(g){
  /* recorded DURING the drag so the numbers move with the band rather
     than lagging a gesture behind */
  if(S.M&&S.M.kind&&S.M.kind!=='free')
    S.KEPT[S.M.kind]={pips:Math.abs(S.M.b.price-S.M.a.price)/g.pip,a:S.M.a.price,b:S.M.b.price};
}
function down(pt,g,pat){
  /* the × wins over every other gesture and works even when locked —
     clearing is not editing */
  if(S.M&&S.M.closeBox){ const b=S.M.closeBox;
    if(pt.x>=b.x&&pt.x<=b.x+b.w&&pt.y>=b.y&&pt.y<=b.y+b.h){ reset(); S.mode='free'; return 'cleared'; } }
  if(S.locked) return null;
  const h=hit(pt,g);
  if(h){ S.grab={what:h,startY:pt.y,startX:pt.x,a:S.M.a.price,b:S.M.b.price,x0:S.M.x0,x1:S.M.x1}; return 'grab'; }
  const p=snap(g.py(pt.y),g,pat);
  S.M={a:p,b:p,x0:pt.x-70,x1:pt.x+70,anchorX:pt.x}; S.mode='free';
  S.grab={what:'b',startY:pt.y,startX:pt.x,a:p.price,b:p.price,x0:S.M.x0,x1:S.M.x1};
  return 'new';
}
function move(pt,g,pat){
  if(!S.grab||!S.M) return false;
  const dy=pt.y-S.grab.startY, dx=pt.x-S.grab.startX;
  if(S.grab.what==='a') S.M.a=snap(g.py(g.y(S.grab.a)+dy),g,pat);
  else if(S.grab.what==='b') S.M.b=snap(g.py(g.y(S.grab.b)+dy),g,pat);
  else { S.M.a={price:g.py(g.y(S.grab.a)+dy),snapped:null};
         S.M.b={price:g.py(g.y(S.grab.b)+dy),snapped:null};
         S.M.x0=S.grab.x0+dx; S.M.x1=S.grab.x1+dx; }
  S.M.kind=kindOf(pat,g.pip); recordLeg(g);
  return true;
}
function up(g){ if(S.grab){ recordLeg(g); S.grab=null; return true; } return false; }

root.BWMeasure={state:S,reset,seed,draw,down,move,up,hit,toggleFit,scaleFor,animated,barRange,kindOf,otherLeg};
})(typeof window!=='undefined'?window:globalThis);
