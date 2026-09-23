/* ═══════════════════════════════════════════════════════════════════
   ARBITER — FEEDS (Phase 3)

   Builds the WORLD the engine judges. Nothing here decides anything; it
   only gathers, normalises and labels.

   WHERE EACH READING COMES FROM, AND WHY
   Arbiter runs in its own iframe, so it cannot call BWStructure,
   BWRetracement or BWFormations — those live inside patterns.html. Two
   modules describing the same market differently is the worst outcome
   here, so the order is always:

     1. the OTHER MODULE'S OWN PUBLISHED READ, if it is fresh
        `bw-confluence-now`  (patterns.html — trend, trigger, the decisive
                              level, participation, higher timeframe)
        `bw-risk-now`        (index.html — Risk Radar per pair)
        `bw-liquidity-now`   (index.html — participation per pair)
     2. ARBITER'S OWN read from candles, clearly labelled as such
     3. nothing — the condition reports `unknown`, which the engine
        handles honestly rather than scoring as a pass

   Every reading carries `.from` so the UI can always say which it is
   showing. A number whose origin cannot be named does not belong here.
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
'use strict';

var CHANNEL_MAX_AGE = 5 * 60 * 1000;   // a published read older than this is not used
var SPREAD_KEY = 'bw-arb-spread';      // Arbiter's own rolling spread baseline

var n = function (v) { var x = parseFloat(v); return isFinite(x) ? x : null; };
var norm = function (s) {
  s = String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
  return s.length > 6 ? s.slice(0, 6) : s;
};
function pipSizeFor(sym) {
  sym = String(sym || '').toUpperCase();
  if (/JPY$/.test(sym)) return 0.01;
  if (/^XAU/.test(sym)) return 0.1;
  if (/^XAG/.test(sym)) return 0.01;
  if (/^(BTC|ETH)/.test(sym)) return 1;
  return 0.0001;
}
var cH = function (c) { return n(c.h !== undefined ? c.h : c.high); };
var cL = function (c) { return n(c.l !== undefined ? c.l : c.low); };
var cC = function (c) { return n(c.c !== undefined ? c.c : c.close); };
var cT = function (c) { return n(c.t !== undefined ? c.t : c.time) || 0; };

function readChannel(key) {
  try {
    var raw = JSON.parse(localStorage.getItem(key) || 'null');
    if (!raw || !raw.t) return null;
    if (Date.now() - raw.t > CHANNEL_MAX_AGE) return null;
    return raw;
  } catch (e) { return null; }
}

async function getJSON(url) {
  try {
    var r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

/* ── ARBITER'S OWN STRUCTURE READ ────────────────────────────────────
   The fallback only. Swing pivots from candles, then the sequence of
   highs and lows. Assan's rule: in an uptrend the HL breaking is the
   reversal; in a downtrend it is the LH. The decisive level returned is
   exactly that pivot, because it is what would invalidate the read.
   Deliberately simple, and always labelled "Arbiter's own read" so it is
   never mistaken for the structure engine. */
function structureFromCandles(cd) {
  if (!cd || cd.length < 25) return null;
  var piv = [], L = 2;
  for (var i = L; i < cd.length - L; i++) {
    var hi = true, lo = true;
    for (var j = i - L; j <= i + L; j++) {
      if (j === i) continue;
      if (cH(cd[j]) >= cH(cd[i])) hi = false;
      if (cL(cd[j]) <= cL(cd[i])) lo = false;
    }
    if (hi) piv.push({ k: 'H', p: cH(cd[i]), i: i });
    if (lo) piv.push({ k: 'L', p: cL(cd[i]), i: i });
  }
  if (piv.length < 4) return null;
  var last = piv.slice(-6);
  var highs = last.filter(function (x) { return x.k === 'H'; });
  var lows  = last.filter(function (x) { return x.k === 'L'; });
  if (highs.length < 2 || lows.length < 2) return null;
  var hh = highs[highs.length - 1].p > highs[highs.length - 2].p;
  var hl = lows[lows.length - 1].p > lows[lows.length - 2].p;
  var lh = highs[highs.length - 1].p < highs[highs.length - 2].p;
  var ll = lows[lows.length - 1].p < lows[lows.length - 2].p;
  var regime = (hh && hl) ? 'uptrend' : (lh && ll) ? 'downtrend' : 'range';
  var labels = last.map(function (x, k) {
    if (k === 0) return null;
    var prev = last.slice(0, k).filter(function (y) { return y.k === x.k; }).pop();
    if (!prev) return null;
    return (x.k === 'H' ? (x.p > prev.p ? 'HH' : 'LH') : (x.p > prev.p ? 'HL' : 'LL'));
  }).filter(Boolean);
  // the pivot whose break would end this read
  var decisive = regime === 'uptrend' ? lows[lows.length - 1].p
               : regime === 'downtrend' ? highs[highs.length - 1].p : null;
  return {
    regime: regime,
    confidence: regime === 'range' ? 0.4 : (hh && hl) || (lh && ll) ? 0.7 : 0.5,
    labels: labels.slice(-4).join(' '),
    decisive: decisive,
    from: "Arbiter's own read from candles"
  };
}

function atrFrom(cd, look) {
  if (!cd || cd.length < 5) return null;
  look = look || 14;
  var s = 0, k = 0;
  for (var i = Math.max(1, cd.length - look); i < cd.length; i++) {
    var h = cH(cd[i]), l = cL(cd[i]);
    if (h != null && l != null) { s += (h - l); k++; }
  }
  return k ? s / k : null;
}

/* Sessions by UTC hour. Arbiter's own, and labelled — the Assistant's
   liquidity read is preferred whenever it is publishing. */
function sessionFromClock(d) {
  var h = d.getUTCHours();
  var london = h >= 7 && h < 16, ny = h >= 12 && h < 21, tokyo = h >= 23 || h < 8;
  var name = london && ny ? 'London / New York overlap'
    : london ? 'London' : ny ? 'New York' : tokyo ? 'Tokyo' : 'Between sessions';
  var depth = london && ny ? 1.0 : london ? 0.75 : ny ? 0.7 : tokyo ? 0.45 : 0.15;
  var endH = london && ny ? 16 : london ? 16 : ny ? 21 : tokyo ? 8 : 7;
  var mins = ((endH - h + 24) % 24) * 60 - d.getUTCMinutes();
  return { name: name, depth: depth, minutesLeft: mins, from: "Arbiter's own read from the clock" };
}

/* A spread baseline Arbiter builds for itself, per pair and session hour,
   because no module publishes one. Until there are enough samples the
   condition stays unknown rather than being judged against a guess. */
/* Sampled at most ONCE A MINUTE per pair, whatever the scan speed.
   Otherwise the baseline's time span shrinks as the scan gets faster: at a
   5s scan, 200 samples would cover 17 minutes instead of over three hours,
   and "normal spread" would just mean "the spread lately". */
var SPREAD_SAMPLE_MS = 60000;
var spreadLastSample = {};
function spreadBaseline(sym, spread) {
  try {
    var all = JSON.parse(localStorage.getItem(SPREAD_KEY) || '{}');
    var hour = new Date().getUTCHours();
    var key = sym + '|' + hour;
    var arr = all[key] || [];
    var due = !spreadLastSample[sym] || Date.now() - spreadLastSample[sym] >= SPREAD_SAMPLE_MS;
    if (spread != null && due) {
      spreadLastSample[sym] = Date.now();
      arr.push(spread); if (arr.length > 200) arr = arr.slice(-200); all[key] = arr;
      localStorage.setItem(SPREAD_KEY, JSON.stringify(all));
    }
    if (arr.length < 20) return { median: null, samples: arr.length };
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return { median: s[Math.floor(s.length / 2)], samples: arr.length };
  } catch (e) { return { median: null, samples: 0 }; }
}

/* ── zones from the SMC feed ─────────────────────────────────────────
   Order blocks are zones with high/low as STRINGS and a timeStart. The
   feed carries no mitigation flag, so `spent` is inferred the same way
   the SMC panel does it: a demand block is spent once a candle has
   CLOSED below its low (and the reverse for supply). */
function zonesFrom(smcNode, cd, sym) {
  if (!smcNode) return null;
  var out = [];
  var blocks = smcNode.orderBlocks || smcNode.order_blocks || smcNode.obs || [];
  var heights = [];
  blocks.forEach(function (b) {
    var hi = n(b.high !== undefined ? b.high : b.hi);
    var lo = n(b.low !== undefined ? b.low : b.lo);
    if (hi == null || lo == null) return;
    if (hi < lo) { var t = hi; hi = lo; lo = t; }
    var kindRaw = String(b.type || b.kind || b.direction || '').toLowerCase();
    var kind = /bull|demand|buy/.test(kindRaw) ? 'demand' : /bear|supply|sell/.test(kindRaw) ? 'supply' : null;
    if (!kind) return;
    var startMs = n(b.timeStart || b.time || b.timestamp);
    if (startMs != null && startMs < 1e12) startMs *= 1000;      // seconds -> ms
    var spent = false, touches = 0;
    (cd || []).forEach(function (c) {
      var close = cC(c), h = cH(c), l = cL(c);
      if (close == null) return;
      if (startMs != null && cT(c) * 1000 < startMs) return;
      if (h >= lo && l <= hi) touches++;
      if (kind === 'demand' && close < lo) spent = true;
      if (kind === 'supply' && close > hi) spent = true;
    });
    heights.push(hi - lo);
    out.push({ kind: kind, lo: lo, hi: hi, spent: spent, touches: touches,
      ageHours: startMs != null ? (Date.now() - startMs) / 3600000 : null });
  });
  heights.sort(function (a, b) { return a - b; });
  return { zones: out, medianHeight: heights.length ? heights[Math.floor(heights.length / 2)] : null };
}

function pickNode(bag, sym) {
  if (!bag) return null;
  if (bag.orderBlocks || bag.order_blocks) return bag;          // already a node
  var key = Object.keys(bag).find(function (k) { return norm(k) === norm(sym); });
  return key ? bag[key] : null;
}

/* ── the Assistant's pattern alerts, for one pair ─────────────────────
   Alerts carry a TIMESTAMP, not a bar index (app.js builds them with
   `time: new Date().toISOString()`). Freshness is therefore computed from
   time: bars elapsed = minutes since the alert / the bar length. Without
   this every alert would read as 99 bars old and score nothing. */
function alertsFor(state, sym) {
  var tfMin = { M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };
  return ((state && state.patternAlerts) || []).filter(function (a) {
    return norm(a.symbol) === sym;
  }).map(function (a) {
    var at = Date.parse(a.time || '') || n(a.id) || null;
    var len = tfMin[a.timeframe] || 60;
    return { name: a.name, direction: a.direction, confidence: n(a.confidence), timeframe: a.timeframe,
             barsAgo: at ? Math.floor((Date.now() - at) / 60000 / len) : 99, source: 'assistant' };
  });
}

/* ═══ LIQUIDITY — the Assistant's OWN function, copied word for word ═══
   Lines 3776-3968 of index.html. The Assistant only publishes liquidity
   for the ONE pair it is showing, and only while open, so for every other
   pair Arbiter was guessing from the clock. Arbiter now runs the same
   function on the candles it already has, for every pair, every cycle.
   test-liquidity.js runs index.html's copy beside this one and fails if
   they ever disagree — keep them identical. */
const LIQ_TF_MIN={M15:15,M30:30,H1:60,H4:240};
function liqHourOf(c){
  const t=+new Date(c.t||c.time||c.timestamp||0);
  return isFinite(t)&&t? new Date(t).getUTCHours() : null;
}
const liqV=c=>+(c.v!=null?c.v:(c.volume!=null?c.volume:c.tick_volume))||0;
const liqH=c=>+(c.h!=null?c.h:c.high), liqL=c=>+(c.l!=null?c.l:c.low);
const liqO=c=>+(c.o!=null?c.o:c.open),  liqC=c=>+(c.c!=null?c.c:c.close);
const liqMed=a=>{ if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
const liqAvg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const liqClamp=(v,a,b)=>Math.max(a,Math.min(b,v));

function liqSlot(c,tf){
  const hr=liqHourOf(c); if(hr===null) return null;
  return (LIQ_TF_MIN[tf]||60)>=240 ? Math.floor(hr/4)*4 : hr;
}

/* NORMAL FOR THIS SLOT  learned from the trader's own candles.
   Median, not mean: one news spike would otherwise raise "normal" for
   that hour permanently and hide every drought after it. */
function liqBaseline(cd,tf){
  const slots={};
  for(const c of cd){
    const k=liqSlot(c,tf); if(k===null) continue;
    const v=liqV(c); if(!v) continue;
    (slots[k]=slots[k]||[]).push(v);
  }
  const out={}; let minN=Infinity;
  for(const k in slots){ out[k]=liqMed(slots[k]); minN=Math.min(minN,slots[k].length); }
  return {slots:out, perSlot:isFinite(minN)?minN:0, count:Object.keys(slots).length};
}
function liqBaseFor(BL,c,tf){ const k=liqSlot(c,tf); return (BL&&k!==null&&BL.slots[k])||null; }

function liqAtr(cd,n){
  const s=cd.slice(-n-1); let sum=0,k=0;
  for(let i=1;i<s.length;i++){
    sum+=Math.max(liqH(s[i])-liqL(s[i]),Math.abs(liqH(s[i])-liqC(s[i-1])),Math.abs(liqL(s[i])-liqC(s[i-1]))); k++;
  }
  return k?sum/k:0;
}
/* ONE session table for the whole file. This tab used to carry its own,
   with NO Sydney session, so it disagreed with the session tape on
   eleven of the twenty-four hours. */
const BW_SESS=[{n:'Sydney',a:21,b:6},{n:'Tokyo',a:0,b:9},
               {n:'London',a:7,b:16},{n:'New York',a:12,b:21}];
function bwSessionsOpen(h){
  return BW_SESS.filter(x=> x.a<x.b ? (h>=x.a&&h<x.b) : (h>=x.a||h<x.b));
}
/* Which session it is NOW is a question about the CLOCK. This used to
   read the hour off the last candle's timestamp  broker server time,
   commonly UTC+2/+3, and on H4 up to four hours stale as well. Both
   errors push the reading later in the day, which is why it sat on
   New York. The candle hour is still right for the per-slot baseline,
   where a consistent broker offset cancels out. */
function liqSession(){
  const d=new Date();
  const h=d.getUTCHours()+d.getUTCMinutes()/60;
  const open=bwSessionsOpen(h);
  const has=n=>open.some(x=>x.n===n);
  const londonNY=has('London')&&has('New York');
  if(!open.length) return {name:'Between sessions',deep:false,open:[]};
  return {name: londonNY?'London / New York overlap':open.map(x=>x.n).join('  '),
          deep: londonNY||open.length>=2||has('London')||has('New York'),
          open: open.map(x=>x.n)};
}

function liqRead(cd,tf){
  if(!cd||cd.length<20) return null;
  const BL=liqBaseline(cd,tf);
  const weak=!BL||BL.perSlot<3;
  const last=cd[cd.length-1];
  const hr=liqHourOf(last);
  if(hr===null) return null;
  const sess=liqSession();
  const recent=cd.slice(-4);

  const nowV=liqAvg(recent.map(liqV));
  const bases=recent.map(c=>liqBaseFor(BL,c,tf)).filter(Boolean);
  const baseV=bases.length?liqAvg(bases):null;
  const ratio=(baseV&&!weak)?nowV/baseV:1;

  const F=[];
  F.push({name:'Participation vs this slot',
    detail: weak ? 'not enough history yet to know what is normal here'
      : (ratio*100).toFixed(0)+'% of what this '+((LIQ_TF_MIN[tf]||60)>=240?'4-hour block':'hour')+
        ' normally does  '+(ratio<0.45?'far below':ratio<0.75?'below':ratio>1.4?'well above':'about normal'),
    pts: weak?0:Math.round(liqClamp((ratio-1)*45,-30,30))});

  const aNow=liqAtr(cd,4), aRef=liqAtr(cd.slice(0,-4),14);
  const rangeR=aRef?aNow/aRef:1;
  F.push({name:'Candle size',
    detail:(rangeR*100).toFixed(0)+'% of recent average range  '+
      (rangeR<0.55?'candles have shrunk sharply':rangeR<0.8?'candles are smaller':rangeR>1.5?'candles are expanding':'normal'),
    pts:Math.round(liqClamp((rangeR-1)*30,-20,20))});

  const emptyBook=!weak&&ratio<0.6&&rangeR<0.75&&sess.deep;
  F.push({name:'Book depth for this session',
    detail: emptyBook ? 'thin and still during '+sess.name+'  the hours when it should be busiest'
      : sess.deep ? 'normal for '+sess.name : sess.name+' is naturally quieter',
    pts: emptyBook?-26:0});

  let wickShare=0;
  for(const c of recent){ const r=liqH(c)-liqL(c);
    if(r>0) wickShare+=(r-Math.abs(liqC(c)-liqO(c)))/r; }
  wickShare/=recent.length;
  F.push({name:'Wick to body',
    detail:(wickShare*100).toFixed(0)+'% of the candle is wick  '+
      (wickShare>0.72?'price is being pushed and rejected, not traded through'
       :wickShare>0.55?'plenty of rejection':'bodies are doing the work'),
    pts:Math.round(liqClamp((0.5-wickShare)*40,-20,14))});

  /* INTRA-CANDLE SWEEP  H1 and above only.
     On a higher timeframe the whole manipulation fits inside one bar.
     On M15 a sweep spans several bars and normal noise routinely
     produces small bodies with wicks both sides, so running it there
     produces false alarms in healthy conditions. */
  const rng0=liqH(last)-liqL(last), body0=Math.abs(liqC(last)-liqO(last));
  const bodyShare=rng0>0?body0/rng0:1;
  const upW=rng0>0?(liqH(last)-Math.max(liqO(last),liqC(last)))/rng0:0;
  const dnW=rng0>0?(Math.min(liqO(last),liqC(last))-liqL(last))/rng0:0;
  const bothSides=Math.min(upW,dnW)>0.22;
  const medRange=liqMed(cd.slice(-21,-1).map(c=>liqH(c)-liqL(c)).filter(x=>x>0));
  const rangeMult=medRange>0?rng0/medRange:1;
  const canChurn=(LIQ_TF_MIN[tf]||60)>=60;
  const churned=canChurn&&!weak&&rangeMult>=1.8&&bodyShare<0.35&&bothSides&&ratio>=0.9;
  F.push({name:'Movement inside this candle',
    detail: !canChurn ? 'a sweep on '+tf+' spans several candles, so there is nothing hidden inside one'
      : weak ? 'needs a baseline first'
      : churned ? 'swept inside this bar  '+rangeMult.toFixed(1)+'x the usual range but only '+
          (bodyShare*100).toFixed(0)+'% of it kept, rejected on both sides'
      : bothSides ? 'wicks both sides but the range is ordinary'
      : (bodyShare*100).toFixed(0)+'% of the range is body  one direction, not churn',
    pts:(!canChurn||weak)?0:(churned?-22:(bodyShare>0.6?8:0))});

  const net=Math.abs(liqC(last)-liqC(cd[cd.length-6]||cd[0]));
  const path=cd.slice(-6).reduce((a,c)=>a+(liqH(c)-liqL(c)),0);
  const eff=path?net/path:0;
  F.push({name:'Progress for the activity',
    detail:(eff*100).toFixed(0)+'% of the ground covered was kept  '+
      (eff<0.15&&ratio>1.2?'heavy activity going nowhere':eff<0.2?'churning':'price is travelling'),
    pts:(eff<0.15&&ratio>1.2)?-18:(eff>0.35?10:0)});

  const score=Math.round(liqClamp(50+F.reduce((a,f)=>a+f.pts,0),2,98));

  let state,cls,plain;
  if(weak){
    state='Learning'; cls='learn';
    plain='Not enough history on '+tf+' yet to know what normal participation looks like at this '+
      'time of day. The reading is withheld rather than guessed  it needs a few bars in each slot first.';
  } else if(churned){
    state='Swept inside the bar'; cls='man';
    plain='This candle covered '+rangeMult.toFixed(1)+'x the usual range and kept only '+
      (bodyShare*100).toFixed(0)+'% of it, with rejection on both sides. Price was pushed up and down '+
      'inside this single bar rather than trending through it. Drop to a lower timeframe to see the order.';
  } else if(ratio<0.4&&sess.deep){
    state='Liquidity drought'; cls='drought';
    plain='Participation is at '+(ratio*100).toFixed(0)+'% of normal for '+sess.name+'. In a book this '+
      'thin a small order moves price further than it should, and stops resting at obvious levels are '+
      'cheap to reach.';
  } else if(ratio<0.7){
    state='Thin'; cls='thin';
    plain='Fewer participants than this hour usually has. Moves can overshoot and reverse without '+
      'anything meaningful having happened.';
  } else if(wickShare>0.72&&ratio>1.1){
    state='Being swept'; cls='man';
    plain='Heavy activity that is almost all wick  price is being pushed into a level and rejected '+
      'rather than traded through.';
  } else {
    state='Healthy'; cls='healthy';
    plain='Participation is in line with what this hour normally sees.';
  }

  let phase,pConf,pText;
  const win=cd.slice(-14);
  const hi=Math.max(...win.map(liqH)), lo=Math.min(...win.map(liqL));
  const boxed=aRef?(hi-lo)/aRef<4.2:false;
  if(weak){ phase=''; pConf='no read'; pText='Waiting on baseline history.'; }
  else if(churned){ phase='Manipulation'; pConf='within this candle';
    pText='The sweep is inside this bar rather than across several. On '+tf+' that is the usual shape.'; }
  else if(boxed&&ratio<0.75){ phase='Accumulation'; pConf='likely';
    pText='Price held in a tight band on below-normal participation. Ranges built like this are often '+
      'where positions are filled quietly  but a quiet range is also just a quiet range, and only what '+
      'follows will tell you which.'; }
  else if(ratio>1.3&&eff<0.18){ phase='Distribution'; pConf='likely';
    pText='Activity well above normal but price making no ground.'; }
  else if(eff>0.3&&ratio>0.8){ phase='Trending'; pConf='clear';
    pText='Price is covering ground with participation to match.'; }
  else { phase='Quiet'; pConf='no read'; pText='Nothing distinctive in the participation pattern.'; }

  return {score,state,cls,plain,factors:F,ratio,sess,phase,pConf,pText,
          weak,samples:BL?BL.perSlot:0,nowV,baseV,tf};
}


/* The liquidity function's own VERDICT drives the judgement, not its raw
   score: the score is participation (the low 40s is NORMAL), not a share
   of the day's deepest — reading 42 as "42% depth" would call a healthy
   market thin. */
var LIQ_DEPTH = { healthy: 0.8, man: 0.5, drought: 0.2, thin: 0.3, learn: null };
function liquidityFor(cd) {
  if (!cd || cd.length < 40) return null;                 // the Assistant's own minimum
  var r = null; try { r = liqRead(cd, 'H1'); } catch (e) { r = null; }
  if (!r) return null;
  return { score: r.score, state: r.state, cls: r.cls, plain: r.plain,
           depth: LIQ_DEPTH.hasOwnProperty(r.cls) ? LIQ_DEPTH[r.cls] : null };
}

/* Live patterns on the candle that has not closed yet. Only the chart
   symbol has them: the multi-symbol bundle is detected server-side from
   CLOSED candles, so for any other pair this is null, not an empty list —
   "nothing forming" and "not watching this pair" are different answers. */
function formingFor(state, sym) {
  if (!state || norm(state.symbol) !== sym) return null;
  var live = state.patterns || state.activePatterns || [];
  if (!Array.isArray(live)) return null;
  return live.filter(function (p) { return n(p.barsAgo) === 0 || p.barsAgo == null; })
    .map(function (p) {
      return { name: p.name, direction: p.direction, confidence: n(p.confidence),
               barsAgo: 0, forming: true, timeframe: state.timeframe || null,
               from: 'the Assistant\'s Patterns tab — this candle is still open' };
    });
}

/* ── the retracement engine, run here ───────────────────────────────── */
function retracementFor(cd, sym, riskPair) {
  if (!root.BWRetracement || !root.BWRetracement.assess || !cd || cd.length < 40) return null;
  try {
    var a = root.BWRetracement.assess({ candles: cd, symbol: sym,
      risk: riskPair && riskPair.score != null ? { score: n(riskPair.score) } : null });
    if (!a || !a.ok) return null;                       // "no trend to retrace from" is not a reading
    return { score: a.score, verdict: a.verdict, note: (a.factors && a.factors[0] && a.factors[0].label) || null,
             from: 'the retracement engine' };
  } catch (e) { return null; }
}

/* ── resting liquidity: equal highs and lows near price ─────────────
   Pools of stops sit where price has turned at the SAME level more than
   once. Measured from the candles Arbiter already has, so the liquidity
   condition has something to read even when no module is publishing. */
function restingFor(cd, sym, price) {
  if (!cd || cd.length < 40 || !(price > 0)) return null;
  var pip = pipSizeFor(sym), tol = pip * 3, look = cd.slice(-120);
  function pools(getter, isHigh) {
    var piv = [];
    for (var i = 2; i < look.length - 2; i++) {
      var v = getter(look[i]), ok = true;
      for (var k = i - 2; k <= i + 2; k++) { if (k === i) continue;
        if (isHigh ? getter(look[k]) >= v : getter(look[k]) <= v) { ok = false; break; } }
      if (ok) piv.push(v);
    }
    var best = null;
    piv.forEach(function (v) {
      var n2 = piv.filter(function (w) { return Math.abs(w - v) <= tol; }).length;
      if (n2 >= 2 && (isHigh ? v > price : v < price)) {
        var d = Math.abs(v - price) / pip;
        if (!best || d < best.pipsAway) best = { level: v, pipsAway: d, touches: n2 };
      }
    });
    return best;
  }
  var above = pools(cH, true), below = pools(cL, false);
  var pick = !above ? below : !below ? above : (above.pipsAway <= below.pipsAway ? above : below);
  if (!pick) return null;
  pick.side = (pick === above) ? 'above' : 'below';
  pick.label = (pick.touches >= 3 ? 'Equal ' : 'Matched ') + (pick.side === 'above' ? 'highs' : 'lows') +
    ' at ' + pick.level.toFixed(pip >= 1 ? 1 : pip >= 0.01 ? 3 : 5);
  return pick;
}

/* ── formations from the chart patterns tab ─────────────────────────
   Published by patterns.html as bw-formations-now. Only fresh reads are
   used (5 minutes), and only for the pair+timeframe being judged. The
   neckline distance is measured against the price Arbiter is using NOW,
   not the price when the chart tab last drew. */
function formationsFor(sym, tf, price) {
  var ch = readChannel('bw-formations-now');
  if (!ch || !ch.reads) return null;                        // channel absent = unknown, not "none"
  var key = Object.keys(ch.reads).find(function (k) {
    var p = k.split('|'); return norm(p[0]) === sym && p[1] === tf;
  });
  var r = key ? ch.reads[key] : null;
  if (!r || !r.t || Date.now() - r.t > CHANNEL_MAX_AGE) return null;
  var pip = n(r.pip) || pipSizeFor(sym);
  return (r.items || []).map(function (x) {
    var neck = n(x.trigger), px = n(price) != null ? n(price) : n(r.price);
    return { name: x.name, direction: x.dir, state: x.state,
             completion: n(x.completion) != null ? n(x.completion) / 100 : null,
             necklinePips: (neck != null && px != null) ? Math.abs(px - neck) / pip : null,
             broken: x.state === 'confirmed',
             from: 'the chart patterns tab' };
  });
}

/* Average time a WINNING trade of yours stays open, for the "stalled"
   factor. Null until there are enough closed winners to mean anything. */
function avgWinMinutes(journal) {
  var rows = ((journal && journal.entries) || []).filter(function (r) {
    return n(r.total_pl) > 0 && r.open_time && r.close_time;
  });
  if (rows.length < 10) return null;
  var m = rows.map(function (r) { return (Date.parse(r.close_time) - Date.parse(r.open_time)) / 60000; })
              .filter(function (x) { return x > 0; });
  return m.length ? m.reduce(function (a, b) { return a + b; }, 0) / m.length : null;
}

/* ── edge: the trader's own record on this pair + direction + session ── */
function edgeFrom(journal, sym, want, sessionName) {
  if (!journal || !journal.entries) return null;
  var rows = journal.entries.filter(function (r) { return norm(r.symbol) === norm(sym); });
  var dirWord = want === 'bull' ? 'buy' : 'sell';
  var matching = rows.filter(function (r) {
    var d = String(r.direction || '').toLowerCase();
    return d.indexOf(dirWord) >= 0 && (!sessionName || !r.session || String(r.session).toLowerCase() === String(sessionName).toLowerCase());
  });
  var wins = function (list) { return list.filter(function (r) { return n(r.total_pl) > 0; }).length; };
  var all = journal.entries;
  return {
    sample: matching.length,
    hitRate: matching.length ? wins(matching) / matching.length : null,
    baseline: all.length ? wins(all) / all.length : null,
    from: 'your closed trades'
  };
}

/* ═══════════════════════════════════════════════════════════════════
   BUILD THE WORLD
   ═══════════════════════════════════════════════════════════════════ */
async function buildWorld(symbol, timeframe, opts) {
  opts = opts || {};
  var sym = norm(symbol), tf = timeframe || 'H1';
  var provenance = {};

  // Account-wide data can be passed in via opts.shared so a six-pair scan
  // fetches it ONCE per cycle instead of six times. Only the per-pair reads
  // (candles, patterns) are always fetched here.
  var sh = opts.shared || {};
  var smcKey = tf === 'H4' ? 'smcH4' : 'smc';
  // SMC zones exist ONLY for H1 and H4. Any other timeframe asked /smc — the
  // H1 zones — and would show them under the wrong label. No zones instead.
  var hasSMC = (tf === 'H1' || tf === 'H4');
  var results = await Promise.all([
    'state' in sh ? sh.state : getJSON('/api/state'),
    getJSON('/api/candles?symbol=' + encodeURIComponent(symbol)),
    !hasSMC ? null : (smcKey in sh ? sh[smcKey] : getJSON(tf === 'H4' ? '/smc/tf/H4' : '/smc')),
    getJSON('/api/patterns?symbol=' + encodeURIComponent(symbol) + '&tf=' + encodeURIComponent(tf)),
    'status' in sh ? sh.status : getJSON('/api/arbiter/status'),
    opts.journal === false ? null : ('journal' in sh ? sh.journal : getJSON('/api/journal'))
  ]);
  var state = results[0] || {}, candleNode = results[1] || {}, smc = results[2],
      pats = results[3], status = results[4] || {}, journal = results[5];

  // Only H1 may fall back to the flat `candles` array. Asked for H4 and none
  // have arrived, the answer is NO candles — never H1 data under an H4 label.
  var byTF = candleNode.candlesByTF || {};
  var cd = byTF[tf] || (tf === 'H1' ? (candleNode.candles || []) : []);
  var last = cd.length ? cd[cd.length - 1] : null;
  var price = last ? cC(last) : null;

  var wl = (state.watchlist || []).find(function (w) { return norm(w.symbol) === sym; }) || {};
  if (price == null) price = n(wl.bid);

  // ── the other modules' own reads, preferred ───────────────────────
  var conf = readChannel('bw-confluence-now');
  var confRead = null;
  if (conf && conf.reads) {
    var key = Object.keys(conf.reads).find(function (k) {
      var parts = k.split('|'); return norm(parts[0]) === sym && (parts[1] === tf || !parts[1]);
    });
    confRead = key ? conf.reads[key] : null;
  }
  var riskCh = readChannel('bw-risk-now');
  var liqCh = readChannel('bw-liquidity-now');
  var riskPair = riskCh && riskCh.pairs ? (riskCh.pairs[sym] || riskCh.pairs[symbol]) : null;
  var liqPair = liqCh && liqCh.pairs ? (liqCh.pairs[sym] || liqCh.pairs[symbol]) : null;

  // structure
  var structure = null, invalidation = null;
  if (confRead && confRead.trend) {
    structure = { regime: /up|bull/i.test(confRead.trend) ? 'uptrend' : /down|bear/i.test(confRead.trend) ? 'downtrend' : 'range',
                  confidence: n(confRead.trendConf), labels: confRead.labels,
                  from: 'the structure engine (Pattern Detector)' };
    if (confRead.decides) invalidation = n(confRead.decides.price);
    provenance.structure = 'channel';
  } else {
    var own = structureFromCandles(cd);
    if (own) { structure = own; invalidation = own.decisive; provenance.structure = 'own'; }
  }

  // session and depth — the liquidity function itself, on this pair's H1 candles
  var session;
  var h1 = (candleNode.candlesByTF && candleNode.candlesByTF.H1) || (tf === 'H1' ? cd : null);
  var liq = liquidityFor(h1);
  if (liq) {
    var clk = sessionFromClock(new Date());
    session = { name: clk.name, minutesLeft: clk.minutesLeft, depth: liq.depth, cls: liq.cls,
                state: liq.state, score: liq.score, plain: liq.plain, from: 'liquidity — the Assistant\'s own function' };
    provenance.session = 'liquidity';
  } else if (liqPair && (liqPair.pct != null || liqPair.score != null)) {
    var pct = n(liqPair.pct != null ? liqPair.pct : liqPair.score);
    session = { name: liqPair.session || (confRead && confRead.participation && confRead.participation.session) || 'Live',
                depth: pct > 1 ? pct / 100 : pct, from: 'the Assistant\'s liquidity read' };
    provenance.session = 'channel';
  } else {
    session = sessionFromClock(new Date());
    provenance.session = 'own';
  }

  // zones
  var node = pickNode(smc, symbol);
  var z = zonesFrom(node, cd, sym);

  // patterns — tolerant to both shapes, handled inside the engine
  var patterns = null;
  if (pats) patterns = pats.patterns || pats.list || (Array.isArray(pats) ? pats : null);
  if (!patterns && confRead && confRead.trigger) {
    patterns = [{ name: confRead.trigger.name, direction: confRead.trigger.dir,
                  confidence: confRead.trigger.conf, barsAgo: confRead.trigger.barsAgo, timeframe: tf }];
    provenance.patterns = 'channel';
  }

  // news, in minutes away
  var news = (state.news || state.newsEvents || []).map(function (e) {
    var ts = n(e.timestamp);
    if (ts != null && ts < 1e12) ts *= 1000;
    return { title: e.title, impact: e.impact, country: e.country,
             minutesAway: ts != null ? (ts - Date.now()) / 60000 : null };
  }).filter(function (e) { return e.minutesAway != null && e.minutesAway > -30; });

  var spreadPts = n(wl.spread);
  var spreadPips = spreadPts != null ? spreadPts * (pipSizeFor(sym) === 0.01 ? 0.1 : pipSizeFor(sym) === 0.1 ? 0.1 : 0.1) : null;
  // MT5 spread arrives in POINTS. One pip is ten points on a 5-digit pair
  // and on 3-digit JPY, which is the case for every pair in the watchlist.
  // The Assistant reports the broker's POINTS (12 pts). Arbiter showed the
  // same spread as "1.2" and still called it points — the same number in two
  // different units. Points stay the number shown; pips are used only where a
  // share of the move is being worked out.
  if (spreadPts != null) spreadPips = spreadPts / 10;
  var base = spreadBaseline(sym, spreadPts);

  var want = opts.direction || null;
  var world = {
    symbol: sym, rawSymbol: wl.symbol || symbol, timeframe: tf, higherTimeframe: tf === 'H4' ? 'D1' : 'H4',
    now: Date.now(), price: price,
    structure: structure,
    invalidationLevel: invalidation,
    zones: z ? z.zones : null,
    medianZoneHeight: z ? z.medianHeight : null,
    patterns: patterns,
    // The chart patterns tab's OWN formations (patterns.html publishes them
    // as bw-formations-now), in the shape the pressure model reads.
    formations: formationsFor(sym, tf, price),
    alerts: alertsFor(state, sym),
    // The EA detects on the CURRENT, still-open candle (CopyRates from 0,
    // r[n-1]) — that is what the Assistant's Patterns tab shows. The alerts
    // tab only fires once a candle has CLOSED, so a reversal building against
    // an open trade was invisible until it was too late to act on.
    forming: formingFor(state, sym),
    rangeAtr: (last && atrFrom(cd)) ? (cH(last) - cL(last)) / atrFrom(cd) : null,
    // the last closes, so two open positions can be compared for real
    // (correlation is computed from these, never assumed from the pair names)
    closes: cd.slice(-120).map(cC).filter(function (x) { return x != null; }),
    barsPerCandle: tf,
    avgWinMinutes: avgWinMinutes(journal),
    sweep: node ? (node.sweepStatus || node.sweep || null) : null,
    restingLiquidity: restingFor(cd, sym, price),
    // NOT the confluence channel's givenBackPct: that is how much of a move
    // has retraced (a healthy pullback can be 60%), not the retracement
    // engine's pullback-vs-reversal SCORE. Mapping one onto the other made a
    // normal pullback read as "leaning reversal" and add pressure against the
    // trade. No module publishes the real score yet, so the condition is
    // honestly unknown until one does.
    // The Pattern Detector's OWN engine (BWRetracement.assess), run on the
    // same candles. Its score is 0 = certainly a pullback, 100 = certainly a
    // reversal — the scale the pullback condition already expects.
    retracement: retracementFor(cd, sym, riskPair),
    atr: atrFrom(cd),
    session: { name: session.name, depth: session.depth, cls: session.cls || null, state: session.state || null,
               score: session.score != null ? session.score : null, plain: session.plain || null },
    sessionMinutesLeft: session.minutesLeft != null ? session.minutesLeft : null,
    news: news,
    expectedMinutes: opts.expectedMinutes || 240,
    radar: riskPair ? { score: n(riskPair.score), state: riskPair.state || riskPair.level,
                        stateName: riskPair.name || riskPair.stateName,
                        factors: riskPair.factors || [] } : null,
    openPositions: (state.openTrades || []).map(function (t) {
      return { ticket: String(t.ticket), symbol: norm(t.symbol), side: t.type, volume: n(t.volume), riskPct: n(t.riskPct) };
    }),
    correlations: opts.correlations || [],
    spread: spreadPips, spreadPoints: spreadPts, medianSpread: base.median != null ? base.median / 10 : null,
    medianSpreadPoints: base.median,
    edge: want ? edgeFrom(journal, sym, want, session.name) : null,
    _journal: journal, _sessionName: session.name,
    target: opts.target != null ? n(opts.target) : null,
    accountInfo: state.accountInfo || {},
    provenance: provenance,
    sources: {
      structure: structure ? structure.from : null,
      session: session.from || 'the Assistant\'s liquidity read',
      spreadSamples: base.samples
    },
    arbiter: status
  };
  return world;
}

/* For an OPEN position: the world plus the trade's own numbers, including
   the water marks Phase 1 has been recording server-side. */
async function buildPositionWorld(trade, opts) {
  opts = opts || {};
  var want = String(trade.type || trade.side || '').toLowerCase().indexOf('sell') >= 0 ? 'bear' : 'bull';
  var w = await buildWorld(trade.symbol, opts.timeframe || 'H1',
    { direction: want, target: n(trade.tp) || null, journal: opts.journal, shared: opts.shared });

  var rec = ((w.arbiter && w.arbiter.openPositions) || []).find(function (p) {
    return String(p.ticket) === String(trade.ticket);
  }) || {};
  var pip = pipSizeFor(w.symbol);
  var openPrice = n(trade.openPrice || trade.open_price);
  var sl = n(trade.sl), tp = n(trade.tp);
  var live = w.price;
  var sign = want === 'bull' ? 1 : -1;

  var position = {
    ticket: String(trade.ticket), side: want === 'bull' ? 'buy' : 'sell',
    symbol: w.symbol, rawSymbol: trade.symbol,
    openPrice: openPrice, sl: sl, tp: tp, volume: n(trade.volume),
    openTime: n(trade.openTime),
    profit: n(trade.profit),
    floatingPips: (live != null && openPrice != null) ? sign * (live - openPrice) / pip : null,
    mfePips: n(rec.mfe_pips), maePips: n(rec.mae_pips),
    bestPL: n(rec.best_pl), worstPL: n(rec.worst_pl),
    stopPips: (sl && openPrice) ? Math.abs(openPrice - sl) / pip : null,
    ageMinutes: n(trade.openTime) ? (Date.now() - n(trade.openTime) * 1000) / 60000 : null,
    // A partial has been taken once the volume is below what it was when
    // Arbiter first froze this trade. Assan: partial disappears once followed.
    partialTaken: (opts.entryVolume != null && n(trade.volume) != null && n(trade.volume) < opts.entryVolume - 1e-9),
    entryCase: opts.entryCase || null
  };
  return { world: w, position: position };
}

/* The account-wide reads, fetched once per cycle and handed to every
   buildWorld call in a scan. */
/* The page rescans every 5 seconds, but only the MARKET reads need that
   speed. /api/arbiter/status and /api/journal are Supabase queries whose
   answers change a few times an hour — reading them every 5s would be 24
   database round trips a minute per trader for no new information. They
   are cached for SLOW_MS; the market reads are always fresh. */
var SLOW_MS = 60000;
var slowCache = { at: 0, status: null, journal: null };
async function fetchShared(tf, opts) {
  opts = opts || {};
  var slowDue = opts.force || (Date.now() - slowCache.at > SLOW_MS);
  var r = await Promise.all([
    getJSON('/api/state'),
    getJSON(tf === 'H4' ? '/smc/tf/H4' : '/smc'),
    slowDue ? getJSON('/api/arbiter/status') : slowCache.status,
    slowDue ? getJSON('/api/journal') : slowCache.journal
  ]);
  if (slowDue) slowCache = { at: Date.now(), status: r[2], journal: r[3] };
  var out = { state: r[0], status: r[2], journal: r[3] };
  out[tf === 'H4' ? 'smcH4' : 'smc'] = r[1];
  return out;
}

root.BWArbiterFeeds = {
  buildWorld: buildWorld,
  fetchShared: fetchShared,
  buildPositionWorld: buildPositionWorld,
  _internals: { structureFromCandles: structureFromCandles, zonesFrom: zonesFrom, atrFrom: atrFrom,
                sessionFromClock: sessionFromClock, edgeFrom: edgeFrom, readChannel: readChannel,
                pipSizeFor: pipSizeFor, spreadBaseline: spreadBaseline, alertsFor: alertsFor, avgWinMinutes: avgWinMinutes,
                formationsFor: formationsFor, liqRead: liqRead, liquidityFor: liquidityFor,
                retracementFor: retracementFor, restingFor: restingFor,
                resetCaches: function () { slowCache = { at: 0, status: null, journal: null }; spreadLastSample = {}; } }
};
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = (typeof window !== 'undefined' ? window : globalThis).BWArbiterFeeds;
