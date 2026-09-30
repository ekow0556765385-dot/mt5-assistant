/* retracement.js — EXTRACTED EXACTLY from patterns.html, the copy that actually runs.
   Do not edit here alone: test-engines.js fails if this and patterns.html drift. */
(function(root){
'use strict';

const H=c=>+(c.h!==undefined?c.h:c.high);
const L=c=>+(c.l!==undefined?c.l:c.low);
const C=c=>+(c.c!==undefined?c.c:c.close);
const O=c=>+(c.o!==undefined?c.o:c.open);
const V=c=>+(c.v!==undefined?c.v:(c.volume!==undefined?c.volume:0));
const T=c=>+(c.t!==undefined?c.t:c.time);

function pipSize(sym){
  const b=String(sym||'').replace(/[^A-Za-z]/g,'').slice(0,6).toUpperCase();
  if(/JPY$/.test(b)) return 0.01;
  if(/^XAU/.test(b)) return 0.1;
  if(/^XAG/.test(b)) return 0.01;
  if(/^BTC|^ETH/.test(b)) return 1;
  return 0.0001;
}

/* ── SWINGS ───────────────────────────────────────────────────────
   Same fractal method the chart-pattern engine uses, so both features
   agree about where the swings are. Disagreeing on that would make the
   two tabs contradict each other on the same screen. */
function swings(cd,k){
  k=k||2;
  const out=[];
  for(let i=k;i<cd.length-k;i++){
    let hi=true,lo=true;
    for(let j=i-k;j<=i+k;j++){
      if(j===i) continue;
      if(H(cd[j])>=H(cd[i])) hi=false;
      if(L(cd[j])<=L(cd[i])) lo=false;
    }
    if(hi) out.push({i,type:'H',p:H(cd[i])});
    else if(lo) out.push({i,type:'L',p:L(cd[i])});
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

const ema=(vals,n)=>{
  if(vals.length<n) return NaN;
  const k=2/(n+1);
  let e=vals.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for(let i=n;i<vals.length;i++) e=vals[i]*k+e*(1-k);
  return e;
};

/* ── TREND ────────────────────────────────────────────────────────
   Structure decides, EMA only confirms. A sequence of higher highs and
   higher lows IS an uptrend regardless of where a moving average sits,
   and the structural break is the thing that actually ends it. */
function trendOf(cd,sw){
  const highs=sw.filter(s=>s.type==='H').slice(-3);
  const lows =sw.filter(s=>s.type==='L').slice(-3);
  const closes=cd.map(C);
  const e20=ema(closes,20), e50=ema(closes,50);
  let struct=0;
  if(highs.length>=2&&lows.length>=2){
    const hh=highs[highs.length-1].p>highs[highs.length-2].p;
    const hl=lows [lows.length-1].p >lows [lows.length-2].p;
    const lh=highs[highs.length-1].p<highs[highs.length-2].p;
    const ll=lows [lows.length-1].p <lows [lows.length-2].p;
    if(hh&&hl) struct=1; else if(lh&&ll) struct=-1;
  }
  /* EMA ALONE IS NOT A TREND.
     Falling back to the EMA whenever structure was unclear meant a
     RANGING or CHOPPY market always produced a direction — the two
     averages are never exactly equal — and the engine then reported a
     comfortable "pullback, trend intact" in a market that had no trend
     to pull back from. That is false reassurance in precisely the
     conditions that hurt people. Batch testing showed it on 94% of
     random ranges.
     So the EMA may only stand in for structure when the two averages
     are genuinely separated, and price is on the right side of them.
     Otherwise there is no trend and the engine says so. */
  /* EFFICIENCY RATIO — the test that actually separates a trend from a
     range, and the one thing pivot ordering cannot do on its own. A
     sine-wave range will, by chance, print two higher lows often enough
     to look structural; what it will never do is COVER GROUND. So
     measure net displacement against the total distance travelled
     (Kaufman's ratio): a trend moves in one direction relative to its
     own path, chop retraces almost everything it does.
     Below the floor there is no trend, whatever the pivots say. */
  /* WINDOW LENGTH MATTERS. Measured over 60 bars, a trend that has just
     reversed nets out to nearly zero and the ratio reports "no trend" —
     which silenced the engine in exactly the case it exists for. The
     window has to be long enough that one turn does not erase the trend
     that preceded it, so it spans several legs rather than the last few. */
  const look=Math.min(140,cd.length-1);
  let path=0;
  for(let i=cd.length-look;i<cd.length;i++) path+=Math.abs(C(cd[i])-C(cd[i-1]));
  const net=Math.abs(C(cd[cd.length-1])-C(cd[cd.length-1-look]));
  const er=path>0?net/path:0;
  const ER_MIN=0.18;
  if(er<ER_MIN) return {dir:0,struct:0,emaDir:0,e20,e50,sep:0,er,
    basis:'none',agree:false,
    why:'Price covered only '+(er*100).toFixed(0)+'% of the ground it travelled over the last '+
        look+' bars. That is a range or chop, not a trend.'};

  const ref=closes.length?closes[closes.length-1]:NaN;
  const sep=(isFinite(e20)&&isFinite(e50)&&isFinite(ref)&&ref)
            ? Math.abs(e20-e50)/ref : 0;
  const EMA_MIN_SEP=0.0012;
  let emaDir=0;
  if(sep>=EMA_MIN_SEP&&isFinite(ref)){
    const up=e20>e50, priceSide=up?ref>e50:ref<e50;
    if(priceSide) emaDir=up?1:-1;
  }
  return {dir:struct||emaDir, struct, emaDir, e20, e50, sep, er,
          basis: struct?'structure':(emaDir?'moving averages':'none'),
          agree: struct!==0 && struct===emaDir};
}


/* ── THE CURRENT LEG AND ITS PULLBACK ─────────────────────────────
   In an uptrend: find the highest high since the swing low that started
   the leg (the impulse), then measure how far price has come back down
   from it. Depth is expressed three ways because each answers a
   different question — pips (how far), percent of the impulse (which
   Fibonacci zone), and percentile against this pair's own history (is
   this normal for this instrument). */
function currentLeg(cd,sw,dir){
  if(!dir||sw.length<2) return null;
  const wantStart=dir>0?'L':'H';
  let start=null;
  for(let i=sw.length-1;i>=0;i--){ if(sw[i].type===wantStart){ start=sw[i]; break; } }
  if(!start) return null;
  let extIdx=start.i, extP=dir>0?H(cd[start.i]):L(cd[start.i]);
  for(let i=start.i;i<cd.length;i++){
    const v=dir>0?H(cd[i]):L(cd[i]);
    if(dir>0?v>extP:v<extP){ extP=v; extIdx=i; }
  }
  const impulse=Math.abs(extP-start.p);
  if(!(impulse>0)) return null;
  const now=C(cd[cd.length-1]);
  const back=dir>0?(extP-now):(now-extP);
  return {startI:start.i,startP:start.p,extI:extIdx,extP,impulse,
          back:Math.max(0,back), pct:Math.max(0,back)/impulse,
          barsSinceExt:(cd.length-1)-extIdx};
}

/* ── PULLBACK ORIGIN — THE STATIC LINE ────────────────────────────
   `leg.extP` is the live extreme and it MOVES. It has to: when a trend
   resumes and prints a new high, that new high is the leg. But it moves
   for a second reason too, and that one is a flaw. currentLeg() anchors
   itself to the last swing pivot of the trend-side type, so once a
   pullback is deep enough to print its own swing low (in an uptrend),
   the anchor jumps forward and the "high of the leg" is recomputed from
   inside the pullback. The line then drifts down with the retracement —
   the exact behaviour the user described as the line "following the
   pullback and interpreting it as something else".

   So we freeze the price the pullback actually began from. One EPISODE
   per pullback, opened when the retracement becomes meaningful, holding
   a static origin that does not move for as long as the pullback lasts.

   What the frozen line then answers, which nothing else could:
     RESUMED  — price traded back through the origin in the trend's own
                direction. The trend did what a trend does; the structure
                held. The episode closes and the next pullback opens a
                fresh one.
     EXTENDED — price keeps moving away from the origin. The existing
                scoring decides pullback versus reversal; the episode
                simply supplies how far and how long.
     TESTED   — price returns to the origin, fails to break it, and turns
                away again. Once that has happened repeatedly the market
                is rotating around a level rather than trending, and the
                range engine is the better description. This is the
                handoff the user spotted.

   State lives per symbol+timeframe and only advances on a NEW BAR, so
   the same episode cannot be opened twice by two renders of one candle. */
const RT_EP={};
const EP_OPEN_PCT   = 0.12;   /* retracement deep enough to call a pullback */
const EP_TEST_ATR   = 0.35;   /* within this much of origin counts as a test */
const EP_RANGE_HINT = 3;      /* tests before the range engine fits better  */
const EP_CONFIRM    = 2;      /* closes beyond the origin before it counts   */
const EP_REJECT_RANGE = 2;    /* wick-and-bounce rejections before it reads as rotation */

function epKey(sym,tf){ return String(sym||'')+'|'+String(tf||''); }

function pullbackEpisode(cd,sym,tf,dir,leg,pipSz){
  const key=epKey(sym,tf);
  const barT=+ (cd[cd.length-1].t||cd[cd.length-1].time||0) || cd.length;
  let e=RT_EP[key];

  /* A trend flip invalidates the episode — but only a REAL one. Trend
     detection can wobble for a bar or two inside a deep pullback, and
     discarding the episode on every wobble re-froze the origin partway
     down the retracement, which is the drift this whole mechanism exists
     to prevent. Require the opposite direction to hold for two
     consecutive bars before letting go of the level. */
  if(e && dir && e.dir!==dir){
    if(e.flipBar!==barT){ e.flipBar=barT; e.flips=(e.flips||0)+1; }
    if(e.flips>=2){ delete RT_EP[key]; e=null; }
  } else if(e){ e.flips=0; }

  const now=C(cd[cd.length-1]);
  const atr=(function(){ let s2=0,n=0;
    for(let i=Math.max(1,cd.length-14);i<cd.length;i++){ s2+=Math.abs(H(cd[i])-L(cd[i])); n++; }
    return n?s2/n:0; })();
  const tol=atr*EP_TEST_ATR;

  /* OPEN — the retracement has become meaningful and nothing is open. */
  if(!e && leg && leg.pct>=EP_OPEN_PCT){
    e={dir, origin:leg.extP, originBar:barT, bars:0, tests:0,
       deepest:leg.back, state:'open', lastBar:barT, resolved:null};
    RT_EP[key]=e;
  }
  if(!e) return null;

  /* Advance once per bar only. */
  if(barT!==e.lastBar){
    e.lastBar=barT;
    e.bars++;
  }
  e.deepest=Math.max(e.deepest, dir>0?(e.origin-now):(now-e.origin));

  /* ── REACHING THE LEVEL IS NOT RECLAIMING IT ──────────────────────
     The first version closed the episode as soon as the bar's HIGH
     touched the origin. That is wrong, and it is wrong in the most
     expensive direction: a wick through a level followed by a close back
     underneath is a REJECTION — the market went there, found sellers,
     and left. Calling that "trend resumed" would have told a trader the
     structure held at the exact moment it was being defended against
     them.
     So the two are now separated, and neither closes the episode on its
     own:
       WICK   — the extreme crossed but the close did not. That is a test
                of the level, and a failed one. It counts toward the
                rotation case rather than toward resumption.
       CLOSE  — the bar closed beyond the origin in the trend's own
                direction. Only this counts as reclaiming, and it must
                HOLD for EP_CONFIRM bars before the episode closes. A
                single close beyond that is immediately given back is
                the same trap one bar later.
     The episode therefore survives a wick-and-bounce, which is exactly
     the case that produces a range. */
  const lastC=cd[cd.length-1];
  const wickThrough = dir>0 ? H(lastC)>=e.origin : L(lastC)<=e.origin;
  const closeBeyond = dir>0 ? C(lastC)>=e.origin : C(lastC)<=e.origin;

  if(closeBeyond){
    if(e.reclaimBar!==barT){ e.reclaimBar=barT; e.reclaimBars=(e.reclaimBars||0)+1; }
    if(e.reclaimBars>=EP_CONFIRM){
      e.state='resumed'; e.resolved=barT;
      delete RT_EP[key];                       /* next pullback gets a fresh origin */
      return {...e, tol, distance:0, resumedNow:true, rejectedNow:false};
    }
    e.state='reclaiming';
    return {...e, tol, distance:0, resumedNow:false, rejectedNow:false,
            needs:EP_CONFIRM-e.reclaimBars};
  }

  /* Closed back inside after trading through — a rejection at the level. */
  let rejectedNow=false;
  if(wickThrough){
    if(e.rejectBar!==barT){
      e.rejectBar=barT;
      e.rejections=(e.rejections||0)+1;
      e.tests=(e.tests||0)+1;
      rejectedNow=true;
    }
    e.reclaimBars=0;                           /* any progress toward reclaim is undone */
  } else if(e.reclaimBars && !closeBeyond){
    e.reclaimBars=0;                           /* gave the level straight back */
  }

  /* TEST — came close, did not trade through, and is turning away. */
  const distance = dir>0 ? (e.origin-now) : (now-e.origin);
  if(!wickThrough && distance<=tol && !e.touchedThisBar){ e.tests++; e.touchedThisBar=true; }
  if(distance>tol*1.6) e.touchedThisBar=false;

  /* ROTATION — the level has been reached and refused repeatedly. That is
     no longer a trend pulling back; it is price rotating around a level,
     and the range engine describes it properly. */
  e.state = (e.rejections||0)>=EP_REJECT_RANGE ? 'rotating'
          : e.tests>=EP_RANGE_HINT             ? 'rotating'
          : 'extended';
  e.suggestRange = e.state==='rotating';
  return {...e, tol, distance, resumedNow:false, rejectedNow};
}

/* ── STATISTICAL BASELINE ─────────────────────────────────────────
   What this pair's pullbacks normally look like, measured from its own
   history on this timeframe. For every completed impulse leg in the
   window, record how deep the following pullback went before the trend
   either resumed or ended. The percentiles then answer the question the
   trader actually asks: "is THIS one unusual?"
   Fewer than six samples is not a distribution, and the caller is told
   so rather than being handed a confident-looking number. */
function baseline(cd,dir,pip){
  const sw=swings(cd,2);
  const depths=[];
  for(let i=0;i<sw.length-2;i++){
    const a=sw[i],b=sw[i+1],c=sw[i+2];
    if(dir>0){ if(!(a.type==='L'&&b.type==='H'&&c.type==='L')) continue; }
    else     { if(!(a.type==='H'&&b.type==='L'&&c.type==='H')) continue; }
    const imp=Math.abs(b.p-a.p), rtr=Math.abs(b.p-c.p);
    if(imp>0&&rtr>=0&&rtr<imp*1.6) depths.push({pips:rtr/pip,pct:rtr/imp});
  }
  /* Six samples is the minimum that can be called a distribution. Below
     that the caller is told how many were found rather than handed a
     confident-looking number — or, worse, a bare dash that looks like
     broken code. The usual reason for a low count is the EA's
     CandleHistory / MultiCandleHistory inputs being small; those are
     `input` parameters and can be raised in the EA's properties dialog
     without recompiling. */
  if(depths.length<6) return {n:depths.length,thin:true,need:6};
  const byPips=depths.map(d=>d.pips).sort((a,b)=>a-b);
  const byPct =depths.map(d=>d.pct ).sort((a,b)=>a-b);
  const q=(arr,p)=>arr[Math.min(arr.length-1,Math.max(0,Math.round((arr.length-1)*p)))];
  return {n:depths.length,thin:false,
    medPips:q(byPips,.5), p75Pips:q(byPips,.75), p90Pips:q(byPips,.9),
    medPct :q(byPct ,.5), p75Pct :q(byPct ,.75), p90Pct :q(byPct ,.9)};
}

/* Where does the current depth sit in that distribution? */
function percentileOf(base,pips){
  if(!base||base.thin) return null;
  if(pips<=base.medPips) return 50*(pips/Math.max(1e-9,base.medPips));
  if(pips<=base.p75Pips) return 50+25*((pips-base.medPips)/Math.max(1e-9,base.p75Pips-base.medPips));
  if(pips<=base.p90Pips) return 75+15*((pips-base.p75Pips)/Math.max(1e-9,base.p90Pips-base.p75Pips));
  return Math.min(99,90+9*((pips-base.p90Pips)/Math.max(1e-9,base.p90Pips)));
}

/* ── VOLUME BEHIND THE MOVE ───────────────────────────────────────
   A pullback on shrinking volume is profit-taking. A pullback on volume
   equal to or greater than the impulse that created it is a different
   set of participants, and that is what a real reversal looks like. */
function volumeRatio(cd,leg){
  if(!leg) return null;
  const imp=cd.slice(leg.startI,leg.extI+1).map(V).filter(v=>v>0);
  const rtr=cd.slice(leg.extI+1).map(V).filter(v=>v>0);
  if(imp.length<2||rtr.length<1) return null;
  const avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
  return avg(rtr)/Math.max(1e-9,avg(imp));
}

/* ── STRUCTURE BREAK ──────────────────────────────────────────────
   The single most decisive input. While the last higher low holds, an
   uptrend is intact by definition however ugly the candles look. Once
   it closes below it, the sequence that defined the trend is gone. */
function structureBreak(cd,sw,dir,leg){
  /* The level that matters is the pivot that STARTED the current leg —
     the higher low the impulse launched from. Taking `slice(-2)[0]` off
     the pivot list picked an older pivot that price had long since left
     behind, so a retracement of more than 100% of its own impulse could
     still report "structure intact", which is a contradiction the user
     would rightly not trust. */
  let level=null;
  if(leg&&isFinite(leg.startP)) level=leg.startP;
  else{
    const wantPivot=dir>0?'L':'H';
    const piv=sw.filter(s=>s.type===wantPivot).slice(-1)[0];
    if(piv) level=piv.p;
  }
  if(level==null) return {broken:false,level:null,dist:null};
  const now=C(cd[cd.length-1]);
  const broken=dir>0?now<level:now>level;
  return {broken,level,dist:Math.abs(now-level)};
}

/* ── SUPPORT / RESISTANCE ─────────────────────────────────────────
   A pullback landing ON a level the market has already respected is the
   normal place for a trend to resume. One slicing THROUGH that level is
   the opposite signal. */
function srContext(levels,price,dir,pip){
  if(!levels||!levels.length) return null;
  let best=null;
  levels.forEach(l=>{
    const p=parseFloat(l.price!=null?l.price:l);
    if(!isFinite(p)) return;
    const d=Math.abs(price-p)/pip;
    const kind=String(l.type||'').toLowerCase();
    const helpful=dir>0?kind.indexOf('sup')>=0:kind.indexOf('res')>=0;
    if(!best||d<best.dist) best={price:p,dist:d,kind:kind||'level',helpful,
                                 touches:+l.touches||1};
  });
  return best;
}

function rsi14(cd){
  if(cd.length<15) return null;
  let g=0,l=0;
  for(let i=cd.length-14;i<cd.length;i++){
    const d=C(cd[i])-C(cd[i-1]);
    if(d>=0) g+=d; else l-=d;
  }
  if(g+l===0) return 50;
  const rs=(g/14)/Math.max(1e-9,l/14);
  return 100-100/(1+rs);
}

/* ══ MAIN ═════════════════════════════════════════════════════════ */
function assess(opts){
  const cd=(opts.candles||[]).filter(c=>isFinite(C(c)));
  const sym=opts.symbol||'', pip=pipSize(sym);
  if(cd.length<40) return {ok:false,reason:'needs at least 40 bars on this timeframe'};

  const sw=swings(cd,2);
  /* ── ONE DEFINITION OF A TREND ────────────────────────────────────
     This engine had its OWN trend test, written before the structure
     engine existed, with a hard efficiency floor and no unanimity rule.
     So the governor could hand it a market that structure had classified
     a downtrend from LH LL LH LL LH, and it would immediately answer
     "that is a range or chop, not a trend" — delegated to analyse a
     trend it did not believe in.
     The mandate is now authoritative. When structure has classified the
     market, this engine ACCEPTS that classification and gets on with the
     question it was actually asked. Its own test is kept only as the
     fallback for when no mandate exists (a direct call, or structure
     having too little history). */
  let tr=trendOf(cd,sw);
  const gm=opts.mandate||root.__BWMandate||null;
  if(gm && gm.ok && (gm.regime==='uptrend'||gm.regime==='downtrend')){
    const gdir = gm.regime==='uptrend'?1:-1;
    if(tr.dir!==gdir){
      tr={...tr, dir:gdir, struct:gdir, basis:'structure engine',
          agree:true,
          why:'trend taken from the structure engine ('+gm.regime+', '+
               Math.round((gm.confidence||0)*100)+'% confident, '+
               (gm.labels||[]).slice(-4).join(' ')+')'};
    }
  }
  if(!tr.dir) return {ok:false,reason:tr.why||'no established trend to retrace from',trend:tr};

  const leg=currentLeg(cd,sw,tr.dir);
  if(!leg) return {ok:false,reason:'no measurable impulse leg yet',trend:tr};

  /* The frozen origin of the current pullback. Must be computed before
     the factors, because two of them read it. */
  const ep=pullbackEpisode(cd,opts.symbol,opts.timeframe,tr.dir,leg,pip);

  const base=baseline(cd,tr.dir,pip);
  const pipsBack=leg.back/pip;
  const pctile=percentileOf(base,pipsBack);
  const vol=volumeRatio(cd,leg);
  const brk=structureBreak(cd,sw,tr.dir,leg);
  const sr=srContext(opts.levels,C(cd[cd.length-1]),tr.dir,pip);
  const rsi=rsi14(cd);

  /* Counter-trend candlestick evidence, using the SAME bar_index
     freshness rule the pattern detector already applies — only the last
     three bars count, because a reversal candle from ten bars ago has
     already been answered by the market. */
  const pats=(opts.patterns||[]).filter(p=>{
    const bi=p.bar_index!=null?p.bar_index:(p.barsAgo!=null?p.barsAgo:99);
    const conf=p.confidence_pct!=null?p.confidence_pct:(p.confidence||0);
    return bi<=2 && conf>=65;
  });
  const dirOf=p=>{
    const t=String(p.type||p.direction||'').toLowerCase();
    return t.indexOf('bull')>=0?1:t.indexOf('bear')>=0?-1:0;
  };
  const against=pats.filter(p=>dirOf(p)===-tr.dir);
  const withTrend=pats.filter(p=>dirOf(p)===tr.dir);

  /* Chart patterns forming inside the pullback, from the engine already
     in this module. A FAILED counter-trend break is the strongest
     "this was a pullback" evidence there is — the market tried to turn
     and could not. */
  let chart=null, chartFailed=false, chartAgainst=false;
  if(root.BWChartPatterns&&root.BWChartPatterns.detect){
    try{
      const r=root.BWChartPatterns.detect(cd);
      const live=(r.patterns||[]).filter(p=>p.life&&p.life.state!=='forming');
      chart=live[0]||null;
      live.forEach(p=>{
        if(p.faked&&p.dir===-tr.dir) chartFailed=true;
        if(!p.faked&&p.effectiveDir===-tr.dir&&
           (p.life.state==='confirmed'||p.life.state==='breaking')) chartAgainst=true;
      });
    }catch(e){ chart=null; }
  }

  /* ── SCORING ────────────────────────────────────────────────────
     0 = certainly just a pullback, 100 = certainly a reversal.
     Every factor carries its own weight and its own sentence, so the
     score is always explainable and never a black box. */
  const F=[];
  const add=(w,label,detail)=>F.push({w,label,detail});

  /* THE STATIC LINE AS EVIDENCE.
     Trading back through the price the pullback began from is the
     clearest confirmation a trend can give: it did exactly what a trend
     does. Nothing else in this list observes that, because everything
     else looks at the pullback itself rather than at whether it ended. */
  if(ep && ep.resumedNow){
    add(-26,'Pullback origin reclaimed',
      'Price has traded back through '+ep.origin.toFixed(5)+', the level this pullback began from. '+
      'The trend resumed on its own terms and the structure held.');
  } else if(ep && ep.state==='reclaiming'){
    add(-14,'Reclaiming the origin',
      'Price has closed back beyond '+ep.origin.toFixed(5)+', the level this pullback began from. '+
      'One more close holding above it confirms the trend resumed; until then it could still be given back.');
  } else if(ep && ep.rejectedNow){
    /* Reaching the level and being refused is the OPPOSITE of resuming,
       and it used to be scored as a resumption. */
    add(12,'Rejected at the origin',
      'Price traded through '+ep.origin.toFixed(5)+' and closed back inside — the '+
      (ep.rejections===1?'first time':ep.rejections===2?'second time':ep.rejections+'th time')+
      ' it has been refused there. A level that turns price away is no longer a level the trend is reclaiming.');
  } else if(ep && ep.state==='rotating'){
    add(6,'Rotating around the origin',
      'Price has reached '+ep.origin.toFixed(5)+' and been refused '+(ep.rejections||ep.tests)+' times. '+
      'That is rotation around a level rather than a trend pulling back — the range view describes it better.');
  } else if(ep && ep.bars>=6 && ep.state==='extended'){
    add(8,'Pullback is not ending',
      ep.bars+' bars since it began and price has not come back to '+ep.origin.toFixed(5)+'. '+
      'The longer a pullback refuses to resume, the less it behaves like one.');
  }

  if(brk.broken) add(30,'Structure broken',
      'Price has closed beyond the last '+(tr.dir>0?'higher low':'lower high')+
      ' at '+brk.level.toFixed(5)+'. The sequence that defined this trend is gone.');
  else add(-22,'Structure intact',
      'The last '+(tr.dir>0?'higher low':'lower high')+' at '+brk.level.toFixed(5)+
      ' is still holding, '+(brk.dist/pip).toFixed(1)+' pips away. By definition the trend has not ended.');

  if(pctile!=null){
    if(pctile>=90) add(20,'Unusually deep',
      pipsBack.toFixed(1)+' pips is deeper than about '+Math.round(pctile)+'% of this pair\u2019s pullbacks on this timeframe.');
    else if(pctile>=75) add(9,'Deeper than usual',
      pipsBack.toFixed(1)+' pips sits in the top quarter of normal pullbacks here (median '+base.medPips.toFixed(1)+').');
    else add(-15,'Ordinary depth',
      pipsBack.toFixed(1)+' pips against a median of '+base.medPips.toFixed(1)+
      ' — a completely routine pullback for this pair on this timeframe.');
  } else add(0,'No depth baseline',
      'Not enough completed legs on this timeframe yet to say what is normal here'+
      (base?' ('+base.n+' samples, need 6)':'')+'.');

  if(leg.pct>=1) add(18,'Impulse fully given back',
      'Price has retraced '+(leg.pct*100).toFixed(0)+'% — the entire leg and more. There is no pullback left to be; this leg is over.');
  else if(leg.pct>=0.786) add(12,'Beyond the 78.6% level',
      'Retraced '+(leg.pct*100).toFixed(0)+'% of the impulse. Past this depth the leg is usually not treated as a pullback.');
  else if(leg.pct>=0.618) add(4,'Into the deep zone',
      'Retraced '+(leg.pct*100).toFixed(0)+'% — the 61.8-78.6% band, where pullbacks and reversals overlap most.');
  else if(leg.pct>=0.382) add(-10,'Classic pullback zone',
      'Retraced '+(leg.pct*100).toFixed(0)+'% — the 38.2-61.8% band where trends most often resume.');
  else add(-14,'Shallow',
      'Only '+(leg.pct*100).toFixed(0)+'% of the impulse given back so far.');

  if(vol!=null){
    if(vol>=1.15) add(16,'Volume behind it',
      'The pullback is trading at '+vol.toFixed(2)+'x the volume of the impulse that created it. Different participants, not profit-taking.');
    else if(vol<=0.7) add(-16,'Volume draining',
      'Pullback volume is '+vol.toFixed(2)+'x the impulse. Falling volume into a pullback is the signature of profit-taking.');
    else add(-3,'Volume neutral',
      'Pullback volume is '+vol.toFixed(2)+'x the impulse — no strong message either way.');
  }

  if(against.length) add(Math.min(14,7*against.length),'Counter-trend candles',
      against.map(p=>p.name).join(', ')+' on the last '+
      (Math.min.apply(null,against.map(p=>p.bar_index!=null?p.bar_index:p.barsAgo||0))===0?'current bar':'few bars')+'.');
  if(withTrend.length) add(-8,'Trend-side candles',
      withTrend.map(p=>p.name).join(', ')+' printing WITH the trend during the pullback.');

  if(chartFailed) add(-24,'Counter-trend pattern failed',
      'A '+(chart?chart.name:'reversal')+' against the trend broke its level and closed back inside. '+
      'The market tried to turn here and could not — that failure usually resolves back into the trend.');
  else if(chartAgainst&&chart) add(18,'Reversal pattern live',
      chart.name+' is '+chart.life.state+' against the trend, with its trigger at '+
      (chart.trigger!=null?chart.trigger.toFixed(5):'—')+'.');

  if(sr){
    if(sr.helpful&&sr.dist<=12) add(-18,'Landing on '+(tr.dir>0?'support':'resistance'),
      'Price is '+sr.dist.toFixed(1)+' pips from a '+sr.kind+' at '+sr.price.toFixed(5)+
      ' the market has respected '+sr.touches+' time'+(sr.touches===1?'':'s')+'. This is where trends resume.');
    else if(!sr.helpful&&sr.dist<=12) add(8,'No level underneath',
      'The nearest level is a '+sr.kind+' at '+sr.price.toFixed(5)+', which does not support the trend here.');
  }

  if(rsi!=null){
    if(tr.dir>0&&rsi<=32) add(-6,'Oversold inside an uptrend',
      'RSI '+rsi.toFixed(0)+'. Deep pullbacks in a live uptrend often end near here.');
    if(tr.dir<0&&rsi>=68) add(-6,'Overbought inside a downtrend',
      'RSI '+rsi.toFixed(0)+'. Deep pullbacks in a live downtrend often end near here.');
  }

  /* MANIPULATION DISCOUNT. This does not push the score either way — a
     flagged window means the EVIDENCE is less trustworthy, not that the
     move is more or less likely to reverse. It reduces confidence. */
  const risk=opts.risk||null;
  let trust=1;
  if(risk&&risk.score>=75) trust=0.55;
  else if(risk&&risk.score>=50) trust=0.75;

  const evidenceThin = F.filter(f=>f.w!==0).length < 5;
  const raw=F.reduce((a,f)=>a+f.w,0);
  let score=Math.max(0,Math.min(100,50+raw));
  /* Pull the score toward "undecided" when the conditions around it are
     flagged, rather than letting a manipulated move read as conviction. */
  score=Math.round(50+(score-50)*trust);

  /* ── WHAT A REVERSAL IS ───────────────────────────────────────────
     It used to be "score >= 70", which is the pullback engine grading
     its own homework: a pile of soft evidence could announce a reversal
     while the trend structure was completely intact, and the labels on
     the chart still read HH HL. That helps nobody.
     A reversal is a STRUCTURAL event. The trend was defined by a
     sequence of higher lows (or lower highs); when price CLOSES beyond
     the last one, that sequence is over. Nothing else is a reversal —
     everything short of it is a pullback of some depth, and the score's
     job is to say how worrying that pullback is, not to promote itself
     to a structural verdict.
     So `brk.broken` is the gate. Without it the engine cannot say
     "reversal" no matter how high the score climbs; with it, it cannot
     say "pullback" no matter how low. */
  const structurallyBroken = !!(brk && brk.broken);
  const verdict = structurallyBroken
        ? (score>=55 ? 'reversal' : 'reversal-unconfirmed')
        : (score>=70 ? 'reversal-warning'
         : score>=55 ? 'leaning-reversal'
         : score>=35 ? 'leaning-pullback'
         : 'pullback');

  /* CAN THIS ENGINE ANSWER AT ALL?
     Its whole purpose is to separate a pullback from a reversal. When
     the evidence is thin AND the score sits in the middle, it cannot do
     that — and saying so is the honest outcome. The governor reads this
     and hands the market back to structure rather than leaving a
     specialist in charge of a question it cannot answer. */
  /* EXHAUSTED, NOT UNDECIDED.
     This was gated on `evidenceThin` — fewer than five contributing
     factors — and the engine almost always has six or more, so it never
     fired and the pullback engine kept the market while saying it did
     not know. The test was never about how many factors it counted. It
     is about whether the ANSWER is still usable: a score sitting in the
     middle with the structure unbroken means it is no longer separating
     a pullback from a reversal, which is the only question it exists to
     answer. */
  /* ── UNDECIDED IS WHATEVER THE PANEL CALLS UNDECIDED ──────────────
     I kept inventing a separate numeric window for this — first "thin
     evidence", then 38-62 — and both times it disagreed with the words
     the trader was actually reading. The panel says "Leaning pullback"
     or "Leaning reversal" from score 35 upward while the structure is
     intact, and LEANING IS HEDGING. If the engine is hedging it is not
     separating a pullback from a reversal, which is the only thing it
     exists to do.
     So the test is now tied to the SAME threshold the verdict wording
     uses. There is one number, not two, and they cannot drift apart
     again: a clear 'pullback' keeps the task; anything above that, with
     the structure unbroken, hands the market back to structure. */
  const DECISIVE_BELOW = 35;              // the same 35 the verdict bands use
  const undecidable = !structurallyBroken && score >= DECISIVE_BELOW;

  return {ok:true,trend:tr,leg,base,pipsBack,pctile,vol,brk,sr,rsi,episode:ep,
    patternsAgainst:against,patternsWith:withTrend,chart,chartFailed,
    risk,trust,factors:F.sort((a,b)=>Math.abs(b.w)-Math.abs(a.w)),
    score,verdict,pip,structurallyBroken,undecidable,evidenceThin,
    evidence:Math.min(1,F.filter(f=>f.w!==0).length/7)};
}

/* ── STOP EXPOSURE ────────────────────────────────────────────────
   For an open trade: is the stop inside the range this pair's pullbacks
   normally reach? A stop sitting inside the ordinary noise band is the
   real reason traders get stopped out of correct ideas. */
function stopExposure(a,trade){
  if(!a||!a.ok||!trade||!trade.sl) return null;
  const pip=a.pip;
  const dir=trade.type==='buy'?1:-1;
  const left=Math.abs(trade.price-trade.sl)/pip;
  const aligned=dir===a.trend.dir;
  const b=a.base;
  if(!b||b.thin) return {left,aligned,zone:'unknown',
    note:'Not enough completed legs on this timeframe to say how far pullbacks here normally run.'};

  /* How much FURTHER a typical and a deep pullback would travel from
     where price already is. Once the current pullback has passed the
     typical depth there is no "typical" distance left to run, and that
     is itself the useful message — the ordinary case has already been
     exceeded, so reaching the stop now takes an unusual continuation. */
  const moreTypical=Math.max(0,b.medPips-a.pipsBack);
  const moreDeep   =Math.max(0,b.p90Pips-a.pipsBack);
  const spent=a.pipsBack>=b.medPips;

  let zone,note;
  if(!aligned){
    zone='against';
    note='This position is against the prevailing '+(a.trend.dir>0?'uptrend':'downtrend')+
         ', so a resuming trend moves toward your stop, not away from it.';
  } else if(left<=moreTypical){
    zone='reachable-normal';
    note='Your stop is '+left.toFixed(1)+' pips away and an ORDINARY pullback here still has about '+
         moreTypical.toFixed(1)+' pips left to run. A completely normal pullback would take you out.';
  } else if(left<=moreDeep){
    zone='reachable-deep';
    note='Your stop is '+left.toFixed(1)+' pips away. A normal pullback would not reach it, but a deep '+
         'one (the worst 10% here) still has around '+moreDeep.toFixed(1)+' pips in it.';
  } else {
    zone='beyond-normal';
    note='Your stop is '+left.toFixed(1)+' pips away, past where even the deepest 10% of pullbacks on '+
         'this pair reach from here'+(spent?' — and this pullback has already run past its usual depth':'')+
         '. Ordinary noise should not reach it.';
  }
  return {left,typical:b.medPips,deep:b.p90Pips,moreTypical,moreDeep,spent,zone,aligned,note};
}

root.BWRetracement={assess,stopExposure,swings,baseline};
})(typeof window!=='undefined'?window:globalThis);
