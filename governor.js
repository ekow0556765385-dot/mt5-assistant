/* governor.js — GENERATED from patterns.html by build-host.js. Do not edit by hand:
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
(function(root){
'use strict';

/* ── SCOPES ───────────────────────────────────────────────────────
   What each engine was BUILT FOR, written as conditions rather than as
   a preference. `admits` is the bar to be handed the market; `retains`
   is the looser bar to keep it. The gap between them is the hysteresis
   that stops control flapping bar to bar. */
const SCOPES={
  pullback:{
    label:'Pullback engine',
    built:'judging whether a retracement inside an identified trend is a pullback or a reversal',
    /* Needs a trend to retrace FROM. That is the whole precondition. */
    admits(v){ return v.trending && v.confidence>=0.6 && v.eq===0 && !v.pullbackStuck; },
    /* Keeps it while the trend structure survives at all. Losing a little
       confidence is not grounds to remove the specialist mid-question. */
    /* An engine that cannot answer its own question is out of scope, no
       matter how well the market matches it on paper. If the pullback
       engine says "undecidable", the market goes back to structure —
       leaving a specialist nominally in charge of a question it has just
       admitted it cannot answer is the worst of both. */
    retains(v){ return v.trending && v.confidence>=0.45 && !v.pullbackStuckCore; },   /* narrower band to lose it than to be refused it */
    outOfScope(v){
      if(v.pullbackStuckCore || v.pullbackStuck) return 'the pullback engine cannot separate a pullback from a reversal here, '+
        'so structure takes the market back rather than leaving it with a question it cannot answer';
      if(!v.trending) return 'the pivots are no longer directional — there is no trend to retrace from';
      if(v.eq>0)      return 'equal levels have appeared, which is not a shape this engine was built for';
      return 'confidence in the trend has fallen below what this engine needs';
    }
  },
  range:{
    label:'Range engine',
    built:'finding and watching the walls of a market that is rotating between two levels',
    admits(v){ return v.eq>=1 && !v.trending && v.confidence>=0.6; },
    /* HYSTERESIS LOOSENS A THRESHOLD, IT DOES NOT DROP THE EVIDENCE.
       This dropped `eq>=1` on retain, so once the range engine had the
       market it kept it after every equal high and low had aged out —
       measured: holder still 'range' at bar 320 while structure had moved
       to 'transition'. Confidence may sag (that is what hysteresis is
       for), but the thing that MAKES it a range has to still be there. */
    retains(v){ return v.eq>=1 && !v.trending && v.confidence>=0.45; },
    outOfScope(v){
      if(v.trending) return 'the pivots have turned directional — this is a trend, not rotation';
      if(v.eq===0)   return 'the equal levels are gone, so there are no walls to watch';
      return 'confidence in the rotation has fallen below what this engine needs';
    }
  }
};

/* ── THE BRIEFING ─────────────────────────────────────────────────
   Structure's running analysis, updated EVERY cycle regardless of who
   holds the market. This is what an engine receives on appointment, so
   it resumes from structure's work rather than starting cold. */
function briefing(r, cd){
  const marked=r.marked||[];
  const lows =marked.filter(p=>p.type==='L');
  const highs=marked.filter(p=>p.type==='H');
  return {
    at:cd.length,
    regime:r.regime, dir:r.dir, confidence:r.confidence,
    labels:r.lastLabels||[],
    pivots:marked.slice(-8),
    /* The levels structure has already identified, so a delegated engine
       does not have to re-derive them and cannot disagree about them. */
    lastHigherLow: r.dir>0 && lows.length  ? lows[lows.length-1].p  : null,
    lastLowerHigh: r.dir<0 && highs.length ? highs[highs.length-1].p: null,
    equalHighs: marked.filter(p=>p.label==='EQ-H').map(p=>p.p).slice(-3),
    equalLows:  marked.filter(p=>p.label==='EQ-L').map(p=>p.p).slice(-3),
    efficiencyNow:r.effNow, efficiencyLong:r.eff
  };
}

/* Per symbol+timeframe, because control is a property of a chart. */
const STATE={};

/* Bars counted by bar time. The stored series is capped at 600, so
   cd.length stops moving and cannot measure how long anything held. */
function barTick(st,cd){
  const t=(typeof bwBarMs==='function')?bwBarMs(cd[cd.length-1]):NaN;
  const id=isFinite(t)&&t?t:cd.length;
  if(st._bid!==id){ st._bid=id; st._tick=(st._tick||0)+1; }
  return st._tick;
}
/* ── SUSPENSION RULES (his design, Oct 2026) ─────────────────────────
   The worse the conditions, the less the market has to do before the
   engines are suspended. Every number lives here.
     Stand down on Risk Radar        -> suspend at once
     High-impact news, either ccy,
       5 min before to 30 min after  -> candle >= NEWS x avg range, or fast
     Elevated                        -> candle >= ELEVATED x, or fast
     Caution / Clear                 -> the extreme-candle rule (trap or undecided)
   H4 is less sensitive: bigger candles, and Caution counts as Clear.
   "Fast" = the forming bar covering ground at FAST_X its normal pace
   (and at least MIN_COVER of a normal bar, so one twitchy minute is not it).
   Lifting: Stand down when the Radar drops; news when its window ends;
   candle triggers after the trigger bar and one more have closed (1-to-3
   bar rule), never longer than MAX_BARS. Suspension dims the reading; it
   never hides it and never stops alerts. */
const SUSPEND = {
  H1: { news:1.5, elevated:2.0, extreme:2.0, cautionCounts:true  },
  H4: { news:2.0, elevated:2.5, extreme:2.5, cautionCounts:false },
  FAST_X: 3.0, MIN_COVER: 0.5,
  NEWS_BEFORE_MIN: 5, NEWS_AFTER_MIN: 30,
  CANDLE_BARS: 2, MAX_BARS: 3
};
const CCY_OF = {US:'USD',USA:'USD','UNITED STATES':'USD',EU:'EUR',EMU:'EUR',EZ:'EUR','EURO AREA':'EUR',EUROZONE:'EUR',
  GB:'GBP',UK:'GBP','UNITED KINGDOM':'GBP',JP:'JPY',JAPAN:'JPY',CH:'CHF',SWITZERLAND:'CHF',CA:'CAD',CANADA:'CAD',
  AU:'AUD',AUSTRALIA:'AUD',NZ:'NZD','NEW ZEALAND':'NZD',CN:'CNY',CHINA:'CNY'};
function newsCcy(e){
  const raw=String(e.currency||e.country||'').toUpperCase().trim();
  return CCY_OF[raw] || raw.slice(0,3);
}
/* Candle size and speed of the bar still forming, against the 30 closed bars before it. */
function liveBar(cd, tfMin, nowMs){
  if(!cd || cd.length<12) return null;
  const c=cd[cd.length-1], prev=cd.slice(-31,-1);
  const rs=prev.map(b=>(+b.h||+b.high)-(+b.l||+b.low)).filter(isFinite);
  const avg=rs.length?rs.reduce((x,y)=>x+y,0)/rs.length:0;
  if(!(avg>0)) return null;
  const range=(+c.h||+c.high)-(+c.l||+c.low);
  const openMs=(typeof bwBarMs==='function')?bwBarMs(c):NaN;
  const mins=isFinite(openMs)&&openMs ? Math.max(1,(nowMs-openMs)/60000) : null;
  const speedX = mins && mins<tfMin ? (range/mins)/(avg/tfMin) : null;
  return {mult:range/avg, speedX, cover:range/avg, mins, avg};
}

function govern(cd, opts){
  opts=opts||{};
  const S=root.BWStructure;
  const key=(opts.key||'?');
  if(!S) return {ok:false, reason:'structure engine unavailable'};

  const r=S.read(cd, opts.structOpts);
  if(!r||!r.ok) return {ok:false, reason:(r&&r.reason)||'structure has too little to work with',
                        holder:'structure', state:'holding'};

  const marked=(r.marked||[]).slice(-6);
  const labels=marked.map(p=>p.label||'').filter(Boolean);
  const v={
    /* Reported by the pullback engine itself, passed in by the caller. */
    pullbackStuck: !!(opts.pullback && opts.pullback.undecidable),
    pullbackStuckCore: !!(opts.pullback && (opts.pullback.undecidableCore!=null ? opts.pullback.undecidableCore : opts.pullback.undecidable)),
    trending:(r.regime==='uptrend'||r.regime==='downtrend'),
    confidence:r.confidence,
    eq:labels.filter(x=>x.indexOf('EQ')===0).length,
    labels
  };
  const brief=briefing(r,cd);

  let st=STATE[key]||(STATE[key]={holder:'structure', since:0, log:[]});
  const tick=barTick(st,cd); if(!st.since) st.since=tick;
  const events=[];

  /* ── 0. AN UNREADABLE BAR SUSPENDS, IT DOES NOT REVOKE.
        The extremes reading arrives here as EVIDENCE rather than as a
        second opinion issued beside the mandate. A violent bar does not
        change who the market belongs to — it means nobody should act on
        it until the bar resolves. Keeping this inside the governor is
        what stops two panels printing different words. */
  let suspended=false, suspendWhy=null, suspendLift=null, suspendCause=null;
  const ex=opts.extreme||null;
  const tfName = opts.tf==='H4' ? 'H4' : 'H1';
  const R = SUSPEND[tfName], tfMin = tfName==='H4' ? 240 : 60;
  const nowMs = opts.now || Date.now();
  const lb = liveBar(cd, tfMin, nowMs);
  const fast = !!(lb && lb.speedX!=null && lb.speedX>=SUSPEND.FAST_X && lb.cover>=SUSPEND.MIN_COVER);
  const rl = (function(){ const r=opts.risk; if(!r) return 'clear';
    const l=String(r.level||'').toLowerCase(); if(l) return l;
    const sc=+r.score||0; return sc>=75?'standdown':sc>=50?'elevated':'clear'; })();
  const lvl = (rl==='caution' && !R.cautionCounts) ? 'clear' : rl;
  const pairCcy = String(opts.symbol||'').toUpperCase().replace(/[^A-Z]/g,'').slice(0,6);
  const hot = (opts.news||[]).filter(e=>{
    if(!/high/i.test(String(e.impact||''))) return false;
    const t=(+e.timestamp||0)*1000; if(!t) return false;
    const d=(nowMs-t)/60000;
    if(d < -SUSPEND.NEWS_BEFORE_MIN || d > SUSPEND.NEWS_AFTER_MIN) return false;
    const c=newsCcy(e); return c && pairCcy.indexOf(c)>=0;
  }).sort((a,b)=>(+a.timestamp)-(+b.timestamp))[0] || null;
  const sizeTxt = lb ? lb.mult.toFixed(1)+'x the recent average range' : '';
  const fastTxt = lb && lb.speedX!=null ? 'moving '+lb.speedX.toFixed(1)+'x its normal pace' : '';
  const barId = (typeof bwBarMs==='function') ? (bwBarMs(cd[cd.length-1])||cd.length) : cd.length;

  /* Fresh triggers on this bar, strongest first. */
  let trig=null;
  if(lvl==='standdown')
    trig={cause:'radar', why:'Risk Radar is on Stand down for this pair', lift:'lifts when the Radar drops below Stand down'};
  else if(hot && lb && (lb.mult>=R.news || fast))
    trig={cause:'news', untilMs:(+hot.timestamp)*1000+SUSPEND.NEWS_AFTER_MIN*60000,
          why:'High-impact news ('+(hot.title||'release')+', '+newsCcy(hot)+') and this bar is '+(lb.mult>=R.news?sizeTxt:fastTxt),
          lift:'lifts '+SUSPEND.NEWS_AFTER_MIN+' min after the release'};
  else if(lvl==='elevated' && lb && (lb.mult>=R.elevated || fast))
    trig={cause:'candle', why:'Risk Radar is Elevated and this bar is '+(lb.mult>=R.elevated?sizeTxt:fastTxt),
          lift:'lifts once this bar and the next have closed'};
  else if(ex && ex.ok && ex.extreme && (ex.verdict==='likely-trap' || ex.verdict==='undecided') && (!lb || lb.mult>=R.extreme))
    trig={cause:'candle', why:ex.headline+' — '+(ex.settle||'wait for it to resolve'),
          lift:'lifts once this bar and the next have closed'};

  /* Keep or lift an existing suspension by its own rule. */
  const prevS = (STATE[key] && STATE[key].susp) || null;
  let cur = null;
  if(trig){
    cur = (prevS && prevS.cause===trig.cause) ? Object.assign(prevS, trig) : Object.assign({startBar:barId, bars:0}, trig);
  } else if(prevS){
    if(prevS.lastBar!==barId){ prevS.bars=(prevS.bars||0)+1; }
    const keep = prevS.cause==='radar' ? false
               : prevS.cause==='news'  ? nowMs < (prevS.untilMs||0) && prevS.bars < SUSPEND.MAX_BARS
               : prevS.bars < SUSPEND.CANDLE_BARS;
    cur = keep ? prevS : null;
  }
  if(cur){ cur.lastBar=barId; suspended=true; suspendWhy=cur.why; suspendLift=cur.lift; suspendCause=cur.cause; }
  st.susp = cur || null;

  /* ── 1. REVOKE FIRST. An engine outside its scope loses the market
        immediately; structure does not wait to be asked for it back. */
  if(st.holder!=='structure'){
    const sc=SCOPES[st.holder];
    if(!sc || !sc.retains(v)){
      events.push({type:'revoked', engine:st.holder,
        why:sc?sc.outOfScope(v):'scope unknown'});
      st.holder='structure'; st.since=tick;
    }
  }

  /* ── 2. DELEGATE ONLY ON A MATCH. Structure keeps the market when
        nothing matches — that is an answer, not a gap. */
  if(st.holder==='structure'){
    const match=Object.keys(SCOPES).find(k=>SCOPES[k].admits(v));
    if(match){
      events.push({type:'delegated', engine:match,
        why:'conditions match what the '+SCOPES[match].label.toLowerCase()+' was built for: '+
            SCOPES[match].built});
      st.holder=match; st.since=tick;
      st.handover=brief;          /* the engine picks up from here */
    }
  }

  st.brief=brief;                 /* structure updates it either way */
  if(events.length) st.log=(st.log||[]).concat(events).slice(-20);

  const holder=st.holder;
  return {
    ok:true, key,
    state: suspended ? 'suspended' : (holder==='structure'?'holding':'delegated'),
    suspended, suspendWhy, suspendLift, suspendCause,
    holder, heldFor: tick-st.since,
    regime:r.regime, confidence:r.confidence, dir:r.dir,
    labels:r.lastLabels||labels, pivots:r.marked||[],
    eq:v.eq, trending:v.trending,
    brief, handover:st.handover||null, events, log:st.log||[],
    scopes:Object.keys(SCOPES).map(k=>({
      key:k, label:SCOPES[k].label, built:SCOPES[k].built,
      admits:SCOPES[k].admits(v), retains:SCOPES[k].retains(v),
      holding:holder===k
    })),
    /* Suspension withholds the right to ACT from whoever holds the
       market; it does not take the market from them. LAW 4 stands: the
       stop distance is a fact and is never withheld. */
    permits:{ pullback:!suspended && holder==='pullback',
              range:   !suspended && holder==='range',
              stop:    true },
    why: suspended ? suspendWhy : holder==='structure'
      ? 'Structure is holding this market. '+
        (v.trending? 'The pivots are directional but not settled enough to hand over yet.'
         : v.eq>0  ? 'There are equal levels but not enough agreement to hand over yet.'
                   : 'Nothing here matches what either engine was built for.')
      : 'Delegated to the '+SCOPES[holder].label.toLowerCase()+' — '+SCOPES[holder].built+'.'
  };
}

function reset(key){ if(key) delete STATE[key]; else Object.keys(STATE).forEach(k=>delete STATE[k]); }

root.BWGovernor2={govern, reset, SCOPES};
})(typeof window!=='undefined'?window:globalThis);
