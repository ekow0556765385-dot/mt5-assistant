/* formations.js — GENERATED from patterns.html by build-host.js. Do not edit by hand:
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

  if(p.life.state==='confirmed' || p.life.state==='failed')
    return {ok:false, why:'answered', note:'the trigger has already been '+
      (p.life.state==='confirmed'?'taken':'rejected')};

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
      resolved: lead.life.state==='confirmed' || lead.life.state==='failed',
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
