/* combined-read.js — GENERATED from patterns.html by build-host.js. Do not edit by hand.
   The Pattern Detector's Combined Read, run inside Arbiter when that page is not publishing.
   Every page function below is copied VERBATIM; test-combined-read.js fails if any drifts.
   Arbiter supplies only the page's STATE (candles, pattern data, risk, open trades, broker
   symbols, the alert cache). publishConfluence runs VERBATIM, so the reading comes out in
   exactly the shape the Pattern Detector publishes — but into PRIVATE storage: Arbiter
   never writes the Pattern Detector's channel. Formations get a SEPARATE instance per pair, because their
   hold state is keyed by start bar, not by pair. */
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
    if(st.leadKey === null){ st.leadKey = candKey; st.history.push({name:cand.p.name, at:cd.length}); }
    else if(candKey !== st.leadKey){
      if(st.pending !== candKey){ st.pending = candKey; st.pendingSince = cd.length; }
      else if(cd.length - st.pendingSince >= HOLD_BARS){
        st.leadKey = candKey; st.pending = null;
        const lastName = st.history[st.history.length-1];
        if(!lastName || lastName.name !== cand.p.name){
          st.history.push({name:cand.p.name, at:cd.length});
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
  var localStorage = {
    getItem: function(k){ return k === 'bw-confluence-now' ? (PRIVATE[k] || null) : root.localStorage.getItem(k); },
    setItem: function(k, v){ if (k === 'bw-confluence-now') PRIVATE[k] = String(v); },
    removeItem: function(k){ if (k === 'bw-confluence-now') delete PRIVATE[k]; }
  };
  var fetch = (opts && opts.fetch) || (root.fetch ? root.fetch.bind(root) : null);
  var location = root.location;

  /* ── page functions, VERBATIM ── */
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
        RISK[prettyPair(k)]={name:p.name||p.level,score:p.score,
                             factors:p.factors||[],fresh:true};
      });
    }
  }catch(e){}
}

async function jget(url){
  const r=await fetch(BASE+url,{credentials:'same-origin'});
  if(!r.ok) throw new Error(r.status);
  return r.json();
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
  return {sym:base,type:dir>0?'buy':'sell',lots,entry,price,
          sl:parseFloat(t.sl??0),tp:parseFloat(t.tp??0),pip,pipVal,pl:profit};
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
  const keyOf=c=>{ const t=+c.t||+c.time||0; return t<1e12?t*1000:t; };
  prev.forEach(c=>byT.set(keyOf(c), c));
  next.forEach(c=>byT.set(keyOf(c), c));     // newer wins for the same bar
  return Array.from(byT.keys()).sort((x,y)=>x-y).map(k=>byT.get(k)).slice(-SERIES_CAP);
}

const D=()=>((DATA[pair]||{})[tf])||{};

function pipOf(p){ return /JPY/.test(p)?0.01:/^XAU/.test(p)?0.1:/^XAG/.test(p)?0.01:0.0001; }

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
  var T = function(b){ var v = +b.t; if(!isFinite(v)||!v) v = +b.time || +b.timestamp || 0;
                       return v > 1e12 ? v/1000 : v; };
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

function publishConfluence(o, cd){
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
      barT: last ? (+last.t||0) : 0,          /* the bar this read describes */
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
    store.t = Date.now();
    store.v = 1;
    localStorage.setItem('bw-confluence-now', JSON.stringify(store));
  }catch(e){ /* storage full or disabled — never let this break the tab */ }
}

  /* ── the two calculation slices, VERBATIM, each given this pair's window ── */
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
      key: pair+'|'+tf,
      extreme: (conductor && conductor.ok) ? conductor.extreme : null,
      pullback: a && a.ok ? {undecidable:a.undecidable, score:a.score, verdict:a.verdict} : null
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
  try{ mandate = window.__BWMandate || null; }catch(e){}
  let liq=null;
  try{ if(window.BWLiquidity && window.BWLiquidity.liqRead) liq = window.BWLiquidity.liqRead(cd, pair, tf); }catch(e){ liq=null; }
  let forms=null;
  try{
    /* read() takes (patterns, candles, opts). This used to be called as
       read(candles, {symbol, timeframe}) — arguments in the wrong order —
       which threw on every call; the catch below turned that into null, so
       the combined read never received a single formation. When the chart
       tab is showing this same series its formations are reused, so the
       two tabs can never disagree; otherwise the same two engines run here. */
    if(window.BWFormations && window.BWFormations.read && window.BWChartPatterns){
      if(CPV && CPV.cd === cd && Array.isArray(CPV.forms)) forms = CPV.forms;
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
    String(a.symbol||'').replace(/[a-z.]+$/,'').toUpperCase() === String(pair).toUpperCase() &&
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
  const refNow = (cd.length ? (cd[cd.length-1].t||0)*1000 : 0) || Date.now();
  if(missedFrom && refNow - missedFrom > 24*3600*1000) missedFrom = refNow - 24*3600*1000;
  const missed = !missedFrom ? [] : raised.filter(a => {
    const t = a.time ? Date.parse(a.time) : 0;
    return t && t >= missedFrom;
  });

  let o;
  try{
    o = window.BWConfluence.read(cd, {
      pip: pipOf(pair), key: pair+'|'+tf, tf: tf,
      mandate: mandate, liquidity: liq, formations: forms, risk: risk,
      alerts: alerts, raised: raised,
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

  /* published for the Trading Brain and anything else that wants it */
  publishConfluence(o, cd);
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
      makeRetrace(w)();
      makeConf(w)();
      return w.__cfLast || null;
    },
    /* the reading in the Pattern Detector's own published shape, keyed pair|tf */
    channel: function(){ try { return JSON.parse(PRIVATE['bw-confluence-now'] || 'null'); } catch (e) { return null; } },
    _state: function(){ return { SERIES:SERIES, DATA:DATA, RISK:RISK, OPEN:OPEN, CONF_ALERTS:CONF_ALERTS }; }
  };
}
root.BWCombinedRead = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
