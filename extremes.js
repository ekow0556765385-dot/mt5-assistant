/* extremes.js — GENERATED from patterns.html by build-host.js. Do not edit by hand:
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
function bwBarHourUTC(c){ const t=bwBarMs(c); return isFinite(t)&&t?new Date(t).getUTCHours():null; }
function riskLv(r){
  if(!r) return 0;
  const l=String(r.level||'').toLowerCase();
  if(l) return l==='standdown'?2:l==='elevated'?1:0;
  const s=+r.score||0; return s>=75?2:s>=50?1:0;      /* old snapshot with no level */
}
(function(root){
'use strict';
const H=c=>+(c.h!==undefined?c.h:c.high);
const L=c=>+(c.l!==undefined?c.l:c.low);
const C=c=>+(c.c!==undefined?c.c:c.close);
const O=c=>+(c.o!==undefined?c.o:c.open);
const V=c=>+(c.v!==undefined?c.v:(c.volume!==undefined?c.volume:0));

function atr(cd,n){
  let s=0,k=0;
  for(let i=Math.max(1,cd.length-n);i<cd.length;i++){
    s+=Math.max(H(cd[i])-L(cd[i]),Math.abs(H(cd[i])-C(cd[i-1])),Math.abs(L(cd[i])-C(cd[i-1]))); k++;
  }
  return k?s/k:0;
}

/* How unusual is this bar's size? Measured against the bars BEFORE it,
   so the outlier cannot inflate its own baseline. */
function sizeZ(cd){
  const prev=cd.slice(-31,-1);
  if(prev.length<10) return null;
  const rs=prev.map(c=>H(c)-L(c));
  const m=rs.reduce((a,b)=>a+b,0)/rs.length;
  const sd=Math.sqrt(rs.reduce((a,b)=>a+(b-m)*(b-m),0)/rs.length)||1e-9;
  const c=cd[cd.length-1];
  return {mult:(H(c)-L(c))/(m||1e-9), z:((H(c)-L(c))-m)/sd, avg:m};
}

/* Volume against the SAME HOUR on previous days — a big bar at the
   London open is ordinary; the same bar at 3am is not. Falls back to a
   plain recent average when there is not enough history. */
function volRatio(cd){
  const c=cd[cd.length-1];
  if(!V(c)) return null;
  const hr=bwBarHourUTC(c);
  const same=[];
  for(let i=0;i<cd.length-1;i++){
    const b=cd[i];
    if(!V(b)) continue;
    if(hr!==null && bwBarHourUTC(b)===hr) same.push(V(b));
  }
  const pool = same.length>=5 ? same : cd.slice(-31,-1).map(V).filter(v=>v>0);
  if(pool.length<5) return null;
  const m=pool.reduce((a,b)=>a+b,0)/pool.length;
  return m>0?V(c)/m:null;
}

/* ── MAIN ─────────────────────────────────────────────────────────
   `struct` is the structure engine's reading (dir, and the last
   protected pivot). `risk` is the live Risk Radar entry for this pair. */
function read(cd,opts){
  opts=opts||{};
  if(!cd||cd.length<32) return {ok:false,reason:'needs at least 32 bars'};
  const c=cd[cd.length-1], prev=cd[cd.length-2];
  const a=atr(cd,14), sz=sizeZ(cd), vr=volRatio(cd);
  if(!sz) return {ok:false,reason:'not enough history to judge size'};

  const range=H(c)-L(c);
  const body=Math.abs(C(c)-O(c));
  const bodyShare = range>0 ? body/range : 0;
  const dirBar = C(c)>=O(c) ? 1 : -1;
  const trendDir = opts.trendDir || 0;
  const against = trendDir!==0 && dirBar===-trendDir;

  /* Not extreme at all — say so and stop. Most bars are ordinary and
     this layer should be silent for them. */
  const EXTREME_MULT = 2.0;
  if(sz.mult < EXTREME_MULT){
    return {ok:true, extreme:false, mult:sz.mult, volRatio:vr,
            verdict:'ordinary', headline:'Nothing unusual about this bar',
            plain:'This bar is '+sz.mult.toFixed(1)+'x the recent average range — ordinary. '+
                  'Nothing here needs a decision.', factors:[]};
  }

  const F=[]; const add=(w,label,detail)=>F.push({w,label,detail});

  /* 1. STRUCTURE — the only thing that actually ends a trend. */
  const level = opts.protectedLevel;    // last HL in an uptrend, last LH in a downtrend
  let brokeStructure=false, reachedOnly=false;
  if(level!=null && trendDir!==0){
    const closedBeyond = trendDir>0 ? C(c)<level : C(c)>level;
    const wickedBeyond = trendDir>0 ? L(c)<level : H(c)>level;
    brokeStructure = closedBeyond;
    reachedOnly = wickedBeyond && !closedBeyond;
    if(closedBeyond) add(28,'Closed through structure',
      'The bar closed beyond '+level.toFixed(5)+', the '+(trendDir>0?'higher low':'lower high')+
      ' the trend was built on. That is the one thing that genuinely ends a trend.');
    else if(wickedBeyond) add(-22,'Reached structure and failed',
      'It traded through '+level.toFixed(5)+' but closed back inside. Reaching a level and taking it are '+
      'different events — this is what a stop run looks like.');
    else add(-14,'Structure untouched',
      'For all its size the bar did not even reach '+level.toFixed(5)+'. The trend structure is intact.');
  }

  /* 2. SHAPE — a drive closes where it went; a trap gives it back. */
  if(bodyShare>=0.7) add(16,'Closed at its extreme',
    Math.round(bodyShare*100)+'% of the bar is body. It kept what it took, which is what real '+
    'participation looks like.');
  else if(bodyShare<=0.35) add(-20,'Gave most of it back',
    'Only '+Math.round(bodyShare*100)+'% of the bar is body — the rest is wick. Price went there and was '+
    'rejected, which is the signature of a sweep rather than a move.');
  else add(-4,'Mixed shape','Body is '+Math.round(bodyShare*100)+'% of the range — no clear message.');

  /* 3. VOLUME — a violent bar on ordinary volume is one participant. */
  if(vr!=null){
    if(vr>=2.0) add(14,'Volume behind it',
      vr.toFixed(1)+'x the volume this hour normally sees. Something real happened.');
    else if(vr<=1.2) add(-18,'No volume behind it',
      'Only '+vr.toFixed(1)+'x normal volume for this hour. A move that size on volume that ordinary is '+
      'usually thin-book, not a change of mind.');
    else add(-2,'Volume unremarkable',vr.toFixed(1)+'x normal for this hour.');
  }

  /* 4. SIZE ITSELF — very large bars mean-revert more often than not. */
  if(sz.mult>=4) add(-10,'Extreme size',
    sz.mult.toFixed(1)+'x the average range. Bars this size are usually events, and events tend to be '+
    'given back at least partly.');
  else add(6,'Large but not freakish',sz.mult.toFixed(1)+'x the average range.');

  /* 5. RISK RADAR — the reason this layer exists. Abnormal conditions
     do not change the direction, they change how much the candle can be
     trusted as evidence of anything. */
  const risk=opts.risk||null;
  let trust=1;
  if(riskLv(risk)>=2){ trust=0.5;
    add(18,'Risk Radar: '+(risk.name||'flagged')+' ('+risk.score+')',
      'Conditions on this pair are abnormal right now. A violent candle inside a flagged window is the '+
      'textbook setting for a trap — it is exactly when moves happen that are not about direction.');
  } else if(riskLv(risk)>=1){ trust=0.72;
    add(9,'Risk Radar: '+(risk.name||'elevated')+' ('+risk.score+')',
      'Conditions are elevated. Treat this candle as weaker evidence than it looks.');
  } else if(risk){
    add(-8,'Risk Radar clear ('+risk.score+')',
      'Nothing abnormal flagged on this pair, so the candle can be read at face value.');
  }

  /* ── VERDICT ──────────────────────────────────────────────────── */
  const raw=F.reduce((x,f)=>x+f.w,0);
  let score=Math.max(0,Math.min(100,50+raw));      // 100 = real break, 0 = trap
  /* Flagged conditions pull the reading toward "undecided" rather than
     toward either answer — the same rule the pullback engine uses. */
  score=Math.round(50+(score-50)*trust);

  const verdict = score>=70?'likely-real' : score>=45?'undecided' : 'likely-trap';

  /* WHAT WOULD SETTLE IT. This is the part a trader can act on: not a
     prediction, but the specific thing to wait for. */
  const CONFIRM=2;
  const settle = brokeStructure
    ? 'Two more closes holding beyond '+(level!=null?level.toFixed(5):'that level')+
      ' and the break is real. A close back inside and it was a sweep.'
    : reachedOnly
    ? 'It already failed to close beyond '+(level!=null?level.toFixed(5):'the level')+
      '. It has to close through and hold to mean anything.'
    : 'Structure has not been touched. Until price closes beyond '+
      (level!=null?level.toFixed(5):'the protected level')+' this is a candle, not a reversal.';

  const headline = verdict==='likely-trap' ? 'Looks like a trap — do not chase it'
                 : verdict==='likely-real' ? 'This one has the marks of a real break'
                 : 'Not enough in this bar to call it';

  return {ok:true, extreme:true, mult:sz.mult, bodyShare, volRatio:vr, against,
          brokeStructure, reachedOnly, risk, trust, score, verdict, headline,
          factors:F.sort((x,y)=>Math.abs(y.w)-Math.abs(x.w)),
          settle, confirmBars:CONFIRM,
          plain:(against?'A bar against the trend, ':'A bar ')+sz.mult.toFixed(1)+
                'x normal size'+(vr!=null?' on '+vr.toFixed(1)+'x volume':'')+'. '+settle};
}

root.BWExtremes={read,atr,sizeZ,volRatio};
})(typeof window!=='undefined'?window:globalThis);
