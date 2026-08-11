/* ═══════════════════════════════════════════════════════════════════
   BLACKWOOD — RISK RADAR  (per-pair manipulation-risk scoring)
   ───────────────────────────────────────────────────────────────────
   Self-contained. Reads ONLY what index.html already holds:
     state.watchlist   bid / ask / spread / change per pair
     dataBySymbol      candlesByTF {H1,H4}, patternsByTF, indicatorsByTF
     state.news        calendar events (impact / country / timestamp)
     activePair        currently viewed pair (BARE, already normalised)

   It does not modify updateAll(), handleCandleUpdate(), the pair-switch
   logic, or any existing render function. It polls the state object on
   its own timer, so nothing in the existing data path changes.

   Symbol handling follows the house rule: normalisePair() on every
   lookup, bare pair as the key, pretty pair in the UI.
   ═══════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

/* Guard: if the host page hasn't defined its helpers yet, wait for it. */
if(typeof normalisePair!=='function'){ setTimeout(arguments.callee,500); return; }

const RR = window.BWRiskRadar = {};

/* ── Configuration ───────────────────────────────────────────────
   Every weight lives here so tuning never means touching logic. */
const CFG = {
  cycleMs: 5000,          // recompute cadence
  histLen: 120,           // sparkline points
  spreadSamples: 120,     // rolling window for the median spread
  promoteCycles: 2,       // cycles a higher state must hold before it shows
  demoteCycles: 3,        // cycles a lower state must hold
  demoteMargin: 8,        // and it must be this far below the band
  smcUrlH1: '/smc',       // GET /smc  -> default (H1) entries
  smcUrlH4: '/smc/tf/H4', // GET /smc/tf/H4 -> H4 entries
  smcMaxAgeMin: 20,       // ignore SMC data staler than this
  weights: {
    obH4: 30, obH1: 18, obCounterBias: 8,
    spread15: 7, spread20: 14, spread30: 22,
    sweep: 18, failbreak: 20, conflict: 10,
    vol18: 9, vol25: 15,
    magnet: 8,
    sessLondon: 6, sessNY: 6, sessRollover: 10, sessAsia: 5,
    newsDecay: [1, 0.35, 0.15]   // 1st, 2nd, 3rd+ overlapping event
  }
};

/* ── The gap fix: EXTREME tier for the calendar ──────────────────
   The feed only supplies impact = high|medium|low, which puts NFP in
   the same bucket as a second-tier print. Titles are matched here and
   promoted. Editable data, not code. */
const EVENT_TIERS = [
  {tier:'extreme', w:40, patterns:[
    /non[- ]?farm|\bnfp\b/i,
    /\bcpi\b|consumer price index/i,
    /\bfomc\b|federal funds|fed (interest )?rate/i,
    /interest rate decision|rate statement|monetary policy (decision|statement)/i,
    /press conference|powell|lagarde|bailey|ueda/i,
    /\bgdp\b.*(advance|prelim|q\/q)|advance gdp/i,
    /unemployment rate/i,
    /\bppi\b|producer price index/i
  ]},
  {tier:'high', w:22, patterns:[
    /retail sales/i, /\bpmi\b/i, /\bism\b/i, /jobless claims/i,
    /trade balance/i, /consumer confidence/i, /\badp\b/i
  ]},
  {tier:'medium', w:8, patterns:[
    /housing|building permits|inventories|sentiment|orders/i
  ]}
];
const FALLBACK = {high:{tier:'high',w:20}, medium:{tier:'medium',w:8}, low:{tier:'low',w:2}};

RR.classifyEvent = function(ev){
  const title = String(ev && ev.title || '');
  for(const t of EVENT_TIERS)
    if(t.patterns.some(p=>p.test(title))) return {tier:t.tier, weight:t.w, matched:true};
  const f = FALLBACK[(ev&&ev.impact)||'low'] || FALLBACK.low;
  return {tier:f.tier, weight:f.w, matched:false};
};

/* Time weighting around a release. Peak T−5 → T+15 (the spike-and-
   reverse window), then a decay tail out to T+60. */
function newsTimeMultiplier(mins){
  if(mins >  60) return 0;
  if(mins >  30) return 0.25;
  if(mins >   5) return 0.60;
  if(mins > -15) return 1.00;
  if(mins > -35) return 0.65;
  if(mins > -60) return 0.30;
  return 0;
}

const FACTOR_META = {
  news:      {label:'Scheduled news window',   cat:'Event'},
  ob:        {label:'Order block interaction', cat:'Structure'},
  spread:    {label:'Spread expansion',        cat:'Execution'},
  sweep:     {label:'Liquidity sweep',         cat:'Structure'},
  failbreak: {label:'Failed break / whipsaw',  cat:'Structure'},
  vol:       {label:'Volatility spike',        cat:'Execution'},
  session:   {label:'Session boundary',        cat:'Timing'},
  conflict:  {label:'Contradictory patterns',  cat:'Signal'},
  magnet:    {label:'Liquidity magnet nearby', cat:'Structure'}
};

const LEVELS = [
  {key:'clear',     name:'Clear',      min:0,  color:'#00c896', advice:'Normal conditions. Trade your plan.'},
  {key:'caution',   name:'Caution',    min:25, color:'#4a9eff', advice:'One risk factor live. Confirm before entry.'},
  {key:'elevated',  name:'Elevated',   min:50, color:'#f5a623', advice:'Stacked conditions. Reduce size, widen stops.'},
  {key:'standdown', name:'Stand down', min:75, color:'#e24b4a', advice:'Engineered-move window. Avoid fresh entries.'}
];
function levelFor(s){ let l=LEVELS[0]; for(const x of LEVELS) if(s>=x.min) l=x; return l; }
RR.LEVELS = LEVELS;

/* ── Per-pair rolling memory ─────────────────────────────────────
   Everything the score needs that a single snapshot cannot provide:
   spread history, previous swing points, recent structure events. */
const mem = {};   // bare pair -> record
function memFor(sym){
  if(!mem[sym]) mem[sym] = {
    sym, spreads:[], score:0, rawScore:0, factors:[],
    level:LEVELS[0], pendingLevel:null, pendingCount:0,
    history:[], events:[], cool:{}, lastBarTime:null,
    lastStruct:null, levelChangedAt:null, prevLevel:null,
    unavailable:{}
  };
  return mem[sym];
}
RR.mem = mem;

/* ── Data accessors — read the host page, never mutate it ────────── */
function watchRow(sym){
  const list = (window.state && state.watchlist) || [];
  const want = normalisePair(sym);
  return list.find(w=>normalisePair(w.symbol)===want) || null;
}
function candles(sym, tf){
  const c = dataBySymbol[normalisePair(sym)];
  return (c && c.candlesByTF && c.candlesByTF[tf]) || [];
}
function patternsOf(sym, tf){
  const c = dataBySymbol[normalisePair(sym)];
  return (c && c.patternsByTF && c.patternsByTF[tf]) || [];
}
function pairList(){
  const list = (window.state && state.watchlist) || [];
  return list.map(w=>normalisePair(w.symbol)).filter((v,i,a)=>v&&a.indexOf(v)===i);
}
function ccyOf(sym){
  const s = normalisePair(sym);
  return s.length===6 ? [s.slice(0,3), s.slice(3,6)] : [s];
}
function digitsOf(sym){
  const b = candles(sym,'H1'); const px = b.length? +b[b.length-1].close : 0;
  if(/JPY$/.test(sym)) return 3;
  if(/^XAU|^XAG/.test(sym)) return 2;
  return px && px>50 ? 2 : 5;
}
function lastPrice(sym){
  const w = watchRow(sym);
  if(w && w.bid) return +w.bid;
  const b = candles(sym,'H1');
  return b.length ? +b[b.length-1].close : 0;
}

/* ── SMC adapter ────────────────────────────────────────────────
   index.html carries no SMC data of its own — order blocks live in
   the separate SMC module. This fetches them if the endpoint answers
   and marks the factor UNAVAILABLE if it does not, so a missing feed
   is visible in the UI rather than silently scoring zero. */
let smcH1 = null, smcH4 = null, smcOk = null, smcLastTry = 0;
function loadSMC(){
  if(Date.now()-smcLastTry < 30000) return;
  smcLastTry = Date.now();
  const get = url => fetch(url, {credentials:'same-origin', headers:{'Accept':'application/json'}})
    .then(r=>r.ok?r.json():Promise.reject(r.status));
  // Both timeframes: GET /smc returns default (H1) entries only; H4 lives
  // behind /smc/tf/H4. Both are requirePlan('pro') and cookie-authenticated,
  // so credentials must be sent.
  Promise.all([ get(CFG.smcUrlH1).catch(()=>null), get(CFG.smcUrlH4).catch(()=>null) ])
    .then(([h1,h4])=>{
      if(h1===null && h4===null){ smcOk=false; return; }
      smcH1 = h1 || {}; smcH4 = h4 || {}; smcOk = true;
    })
    .catch(()=>{ smcOk=false; });
}

/* Real payload shape, confirmed against smc-route.js:
     GET /smc -> { "<BROKER SYMBOL>": { symbol, timeframe, orderBlocks:[],
                   fvgs:[], structure:[], receivedAt } }
   Order blocks are ZONES with high/low, not single prices, and the keys are
   the broker's own symbols (EURUSDc), so every lookup is normalised. */
function smcNodeFor(bag, sym){
  if(!bag) return null;
  const want = normalisePair(sym);
  for(const k of Object.keys(bag)) if(normalisePair(k)===want) return bag[k];
  return null;
}
function freshEnough(node){
  if(!node || !node.receivedAt) return true;   // no stamp -> don't discard
  const t = (typeof bwDate==='function' ? bwDate(node.receivedAt) : new Date(node.receivedAt));
  if(isNaN(+t)) return true;
  return (Date.now()-t.getTime())/60000 <= CFG.smcMaxAgeMin;
}
function zonesFor(sym){
  const out = {obs:[], structure:[], stale:false, any:false};
  [['H1',smcH1],['H4',smcH4]].forEach(([tf,bag])=>{
    const node = smcNodeFor(bag, sym);
    if(!node) return;
    out.any = true;
    if(!freshEnough(node)){ out.stale = true; return; }
    (node.orderBlocks||[]).forEach(o=>{
      const hi=parseFloat(o.high), lo=parseFloat(o.low);
      if(!isFinite(hi)||!isFinite(lo)) return;
      out.obs.push({
        tf, high:Math.max(hi,lo), low:Math.min(hi,lo),
        dir: String(o.direction||'').toLowerCase().indexOf('bear')>=0?'bearish':'bullish',
        mitigated: !!(o.mitigated||o.filled||o.tested)
      });
    });
    (node.structure||[]).forEach(st=>{
      const label = String(st.type||st.name||st.event||st.label||'').toUpperCase();
      const kind = /CHOCH|CHANGE OF CHARACTER/.test(label) ? 'CHOCH'
                 : /BOS|BREAK OF STRUCTURE/.test(label)    ? 'BOS' : null;
      if(!kind) return;
      out.structure.push({
        tf, kind,
        dir: String(st.direction||st.dir||'').toLowerCase().indexOf('bear')>=0?'bearish':'bullish',
        idx: +(st.bar_index ?? st.index ?? st.bar ?? 0),
        time: st.time || st.timestamp || null
      });
    });
  });
  return out;
}

/* ── Candle-derived detectors ───────────────────────────────────── */
function atr(sym, tf, n){
  const c = candles(sym, tf); if(c.length<3) return 0;
  const s = c.slice(-(n||20));
  return s.reduce((a,b)=>a+Math.abs(+b.high - +b.low),0)/s.length;
}
function swings(sym, tf, look){
  const c = candles(sym, tf); if(c.length < 10) return null;
  const s = c.slice(-(look||20), -1);
  return {
    hi: Math.max.apply(null, s.map(b=>+b.high)),
    lo: Math.min.apply(null, s.map(b=>+b.low))
  };
}
/* A sweep is a wick beyond the prior swing that closes back inside. */
function detectSweep(sym, tf){
  const c = candles(sym, tf); if(c.length < 12) return null;
  const last = c[c.length-1], sw = swings(sym, tf, 20);
  if(!sw) return null;
  const hi=+last.high, lo=+last.low, cl=+last.close;
  if(hi > sw.hi && cl < sw.hi) return {side:'high', level:sw.hi};
  if(lo < sw.lo && cl > sw.lo) return {side:'low',  level:sw.lo};
  return null;
}

/* ── Session clock (server/UTC) ─────────────────────────────────── */
function sessionFactor(){
  const h = new Date().getUTCHours();
  const W = CFG.weights;
  if(h===7||h===8)   return {w:W.sessLondon,   why:'London open — first-hour stop runs are routine'};
  if(h===12||h===13) return {w:W.sessNY,       why:'New York open — session overlap volatility'};
  if(h===21)         return {w:W.sessRollover, why:'Daily rollover — thin book, spreads widen'};
  if(h>=0 && h<6)    return {w:W.sessAsia,     why:'Asian session — thin liquidity, range fakeouts'};
  return null;
}

/* ── Scoring ─────────────────────────────────────────────────────── */
function scorePair(sym){
  const m = memFor(sym), W = CFG.weights, f = [];
  const push=(id,weight,detail)=>{ if(weight>0.5) f.push(Object.assign({id,weight:Math.round(weight),detail}, FACTOR_META[id])); };
  const px = lastPrice(sym);
  if(!px){ m.factors=[]; m.rawScore=0; return m; }
  const dg = digitsOf(sym);
  const fmt = v => (+v).toFixed(dg);

  /* 1 — NEWS, with the EXTREME tier and diminishing overlap weights */
  const ccy = ccyOf(sym), now = Date.now()/1000;
  const evs = ((window.state && state.news) || [])
    .map(ev=>{
      const cls = RR.classifyEvent(ev);
      const mins = ((+ev.timestamp||0) - now)/60;
      const mult = newsTimeMultiplier(mins);
      return {ev, cls, mins, mult, score: ccy.indexOf(ev.country)>=0 ? cls.weight*mult : 0};
    })
    .filter(x=>x.score>0.5)
    .sort((a,b)=>b.score-a.score);
  evs.forEach((e,i)=>{
    const dec = W.newsDecay[Math.min(i, W.newsDecay.length-1)];
    const when = e.mins>=0 ? ('in '+(e.mins<1?'<1':Math.round(e.mins))+'m') : (Math.round(-e.mins)+'m ago');
    push('news', e.score*dec,
      e.cls.tier.toUpperCase()+' · '+e.ev.title+' ('+e.ev.country+') '+when +
      (e.cls.matched ? '' : ' · tier from feed impact, title not in table') +
      (i>0 ? ' · overlapping, weighted down' : ''));
  });
  m.newsRows = evs;

  /* Queue for events detected before addEv() is defined below. */
  const _q = m._deferred || (m._deferred = []);
  const addEvLater=(id,w,life,detail)=>_q.push([id,w,life,detail]);

  /* 2 — ORDER BLOCKS, and 5 — FAILED BREAK, both from the SMC store */
  const z = (smcOk === true) ? zonesFor(sym) : null;
  if(!z || (!z.any && smcOk!==true)){
    m.unavailable.ob = true; m.unavailable.failbreak = true;
  }else{
    m.unavailable.ob = z.stale ? 'stale' : false;
    m.unavailable.failbreak = z.stale ? 'stale' : false;
    const bias = ((dataBySymbol[sym]||{}).indicatorsByTF||{}).H4;
    const htf = bias && bias.trend ? String(bias.trend).toLowerCase() : '';
    // Proximity is measured against the zone itself, with a tolerance
    // proportional to the zone's own height — a wide block should not need
    // pinpoint accuracy to count as "price is in it".
    z.obs.forEach(ob=>{
      if(ob.mitigated) return;
      const tol = Math.max((ob.high-ob.low)*0.25, px*0.00008);
      if(px >= ob.low-tol && px <= ob.high+tol){
        let w = ob.tf==='H4' ? W.obH4 : W.obH1;
        const counter = (ob.dir==='bearish' && htf.indexOf('bull')>=0) ||
                        (ob.dir==='bullish' && htf.indexOf('bear')>=0);
        if(counter) w += W.obCounterBias;
        push('ob', w, 'Price inside unmitigated '+ob.tf+' '+ob.dir+' order block '+
          fmt(ob.low)+' – '+fmt(ob.high) +
          (counter ? ' — sits against H4 bias, classic trap location' : ''));
      }
    });
    // A CHoCH printing shortly after a BOS in the OPPOSITE direction is a
    // failed break by definition — the move that broke structure reversed.
    ['H1','H4'].forEach(tf=>{
      // bar_index counts BACKWARDS (0 = current bar), so descending index
      // is chronological order: oldest event first.
      const st = z.structure.filter(x=>x.tf===tf).sort((a,b)=>b.idx-a.idx);
      for(let i=1;i<st.length;i++){
        const prev=st[i-1], cur=st[i];
        if(prev.kind==='BOS' && cur.kind==='CHOCH' && prev.dir!==cur.dir &&
           Math.abs(cur.idx-prev.idx) <= 5 && cur.idx <= 6){
          addEvLater('failbreak', W.failbreak, 60*60*1000,
            tf+' CHoCH ('+cur.dir+') printed '+Math.abs(cur.idx-prev.idx)+
            ' bars after a BOS ('+prev.dir+') — the break failed');
          break;
        }
      }
    });
  }

  /* 3 — SPREAD expansion vs this pair's own rolling median */
  const wr = watchRow(sym);
  if(wr && wr.spread != null){
    const sp = +wr.spread;
    if(sp > 0){
      m.spreads.push(sp);
      if(m.spreads.length > CFG.spreadSamples) m.spreads.shift();
      if(m.spreads.length >= 12){
        const sorted = m.spreads.slice().sort((a,b)=>a-b);
        const med = sorted[Math.floor(sorted.length/2)] || sp;
        const ratio = sp/med;
        if(ratio >= 1.5){
          const w = ratio>=3 ? W.spread30 : ratio>=2 ? W.spread20 : W.spread15;
          push('spread', w, 'Spread '+sp.toFixed(1)+'pt vs '+med.toFixed(1)+'pt normal — '+ratio.toFixed(1)+'× wider');
        }
      }
    }
  }

  /* Transient structure events: one live instance per id, then a
     cooldown, so a re-detecting condition can't sit on permanently. */
  const deferred = m._deferred || (m._deferred = []);
  m.events = m.events.filter(e=>e.until > Date.now());
  const addEv=(id,w,lifeMs,detail)=>{
    if(m.events.some(e=>e.id===id)) return;
    if((m.cool[id]||0) > Date.now()) return;
    m.events.push({id,w,until:Date.now()+lifeMs,detail});
    m.cool[id] = Date.now() + lifeMs + 20*60*1000;
  };
  while(deferred.length){ const d=deferred.shift(); addEv(d[0],d[1],d[2],d[3]); }

  /* 4 — LIQUIDITY SWEEP, evaluated once per new bar */
  ['H1','H4'].forEach(tf=>{
    const c = candles(sym, tf); if(!c.length) return;
    const t = c[c.length-1].time;
    const key = tf+':'+t;
    if(m.lastBarTime === key) return;
    m.lastBarTime = key;
    const sw = detectSweep(sym, tf);
    if(sw) addEv('sweep', W.sweep, 45*60*1000,
      tf+' wick took out the prior swing '+sw.side+' at '+fmt(sw.level)+' and closed back inside — stops harvested');
  });

  /* 6 — VOLATILITY spike */
  const c1 = candles(sym,'H1');
  if(c1.length > 21){
    const last = c1[c1.length-1];
    const rng = Math.abs(+last.high - +last.low);
    const a = atr(sym,'H1',20);
    if(a>0){
      const vr = rng/a;
      if(vr >= 1.8) push('vol', vr>=2.5?W.vol25:W.vol18, 'Current H1 bar range is '+vr.toFixed(1)+'× the 20-bar average');
    }
  }

  /* 7 — SESSION boundary */
  const s = sessionFactor();
  if(s) push('session', s.w, s.why + ' · ' + String(new Date().getUTCHours()).padStart(2,'0') + ':00 UTC');

  /* 8 — CONTRADICTORY PATTERNS on the same pair within a few bars */
  ['H1','H4'].forEach(tf=>{
    const ps = patternsOf(sym, tf).filter(p=>(+p.confidence||0) >= 70);
    const bull = ps.filter(p=>/bull/i.test(p.direction||''));
    const bear = ps.filter(p=>/bear/i.test(p.direction||''));
    if(bull.length && bear.length){
      const b = bull[0], r = bear[0];
      if(Math.abs((+b.bar_index||0) - (+r.bar_index||0)) <= 3)
        addEv('conflict', W.conflict, 40*60*1000,
          b.name+' ('+b.confidence+'%) and '+r.name+' ('+r.confidence+'%) within 3 bars on '+tf);
    }
  });

  m.events.forEach(e=>push(e.id, e.w, e.detail));

  /* 9 — LIQUIDITY MAGNET: round numbers and the prior day extremes */
  const step = dg>=5 ? 0.0050 : dg===3 ? 0.500 : 10;
  const nearest = Math.round(px/step)*step;
  if(Math.abs(px-nearest)/px < 0.00035)
    push('magnet', W.magnet, 'Price '+fmt(px)+' is sitting on the '+fmt(nearest)+' round level — resting orders cluster here');

  /* Total, smoothed so the number doesn't strobe */
  const raw = Math.min(100, f.reduce((a,b)=>a+b.weight,0));
  m.rawScore = raw;
  m.score = Math.round(m.score*0.45 + raw*0.55);
  m.factors = f.sort((a,b)=>b.weight-a.weight);
  m.history.push(m.score);
  if(m.history.length > CFG.histLen) m.history.shift();

  /* Persistence + decay */
  const want = levelFor(m.score);
  if(want.key !== m.level.key){
    const promoting = LEVELS.indexOf(want) > LEVELS.indexOf(m.level);
    const need = promoting ? CFG.promoteCycles : CFG.demoteCycles;
    const ok = promoting ? true : (m.score < m.level.min - CFG.demoteMargin);
    if(m.pendingLevel && m.pendingLevel.key===want.key && ok) m.pendingCount++;
    else { m.pendingLevel = want; m.pendingCount = 1; }
    if(m.pendingCount >= need && ok){
      m.prevLevel = m.level; m.level = want;
      m.levelChangedAt = Date.now(); m.pendingCount = 0;
      onLevelChange(m);
    }
  }else{ m.pendingLevel=null; m.pendingCount=0; }

  return m;
}

/* ── Warning outcome log (self-validation) ─────────────────────── */
RR.log = [];
function onLevelChange(m){
  const up = LEVELS.indexOf(m.level) > LEVELS.indexOf(m.prevLevel||LEVELS[0]);
  if(!up) return;
  if(m.level.key!=='elevated' && m.level.key!=='standdown') return;
  RR.log.unshift({
    t: Date.now(), sym: m.sym, level: m.level.key, score: m.score,
    priceAt: lastPrice(m.sym), digits: digitsOf(m.sym),
    factors: m.factors.slice(0,3).map(x=>x.label),
    after15: null, after60: null
  });
  if(RR.log.length > 60) RR.log.pop();
  RR.pendingTelegram = {sym:m.sym, level:m.level, score:m.score, factors:m.factors.slice(0,3), t:Date.now()};
  try{ localStorage.setItem('bw-risk-log', JSON.stringify(RR.log.slice(0,60))); }catch(e){}
}
function updateLog(){
  RR.log.forEach(e=>{
    const mins = (Date.now()-e.t)/60000;
    const px = lastPrice(e.sym);
    if(!px || !e.priceAt) return;
    const pips = (px-e.priceAt)/e.priceAt*10000;
    if(e.after15===null && mins>=15) e.after15 = pips;
    if(e.after60===null && mins>=60) e.after60 = pips;
  });
  try{ localStorage.setItem('bw-risk-log', JSON.stringify(RR.log.slice(0,60))); }catch(e){}
}
try{
  const saved = JSON.parse(localStorage.getItem('bw-risk-log')||'[]');
  if(Array.isArray(saved)) RR.log = saved;
}catch(e){}

/* ── Public API used by the UI layer ────────────────────────────── */
RR.cycle = function(){
  loadSMC();
  const pairs = pairList();
  if(!pairs.length) return;
  pairs.forEach(scorePair);
  updateLog();
};
RR.for = function(sym){ return memFor(normalisePair(sym)); };
RR.worst = function(){
  const p = pairList().map(memFor);
  return p.length ? p.reduce((a,b)=>b.score>a.score?b:a) : null;
};
RR.smcStatus = function(){ return smcOk; };
RR.levelFor = levelFor;
RR.newsTimeMultiplier = newsTimeMultiplier;
RR.CFG = CFG;

})();
