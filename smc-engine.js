/* ═══════════════════════════════════════════════════════════════════
   BLACKWOOD — SMC PANEL : ENGINE
   ───────────────────────────────────────────────────────────────────
   Real data behind the redesigned panel.

   Ported VERBATIM from smc-panel.html (proven, do not rewrite):
     bwDate()      – tolerant MT5/ISO/epoch date parsing
     BW_CCY / BW_BASE / prettyPair()  – broker-suffix stripping
     the endpoints and the 5s poll:  /smc  ·  /smc/tf/H4  ·  /confluence

   New here:
     – both timeframes fetched every cycle, so confluence can be seen
       without switching (the old panel only ever held one)
     – zone strength normalised per pair instead of raw price height
     – spent / mitigated inference
     – sweep states matching the Trading Brain's exactly
     – cross-module reads: news from /api/state, the Brain's last
       verdict and the Assistant's last risk flag from localStorage
   ═══════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

/* ── VERBATIM from smc-panel.html ───────────────────────────────── */
function bwDate(v){
  if(v instanceof Date) return v;
  if(v === null || v === undefined || v === '') return new Date(NaN);
  if(typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v); // sec
  var s = String(v).trim();
  if(/^\d+$/.test(s)){ var n = parseInt(s,10); return new Date(n < 1e12 ? n*1000 : n); }
  s = s.replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3')
       .replace(/^(\d{4}-\d{2}-\d{2})[ ]+(\d{2}:\d{2})/, '$1T$2');
  return new Date(s);
}
const BW_CCY  = ['USD','EUR','GBP','JPY','CHF','AUD','NZD','CAD','SEK','NOK','DKK',
                 'SGD','HKD','ZAR','MXN','TRY','PLN','CZK','HUF','CNH','THB','INR'];
const BW_BASE = BW_CCY.concat(['XAU','XAG','XPT','XPD','BTC','ETH','LTC','XRP','SOL','BNB']);
function prettyPair(sym){
  if (!sym) return '';
  const up = String(sym).toUpperCase().replace(/[._-]/g, '');
  for (let cut = 0; cut <= 3 && up.length - cut >= 6; cut++) {
    const cand = up.slice(0, up.length - cut);
    if (cand.length !== 6) continue;
    if (BW_BASE.includes(cand.slice(0,3)) && BW_CCY.includes(cand.slice(3,6))) return cand;
  }
  return up; // not a recognisable pair (PLATINUM, indices) — leave it alone
}

/* ── display helpers ────────────────────────────────────────────── */
function digitsFor(bare){
  if(/JPY$/.test(bare)) return 3;
  if(/^XA[UG]/.test(bare)) return 2;
  if(/^(BTC|ETH|LTC|XRP|SOL|BNB)/.test(bare)) return 2;
  return 5;
}
/* One "pip" in this pair's own terms — what a trader means by distance. */
function pipSize(bare){
  if(/JPY$/.test(bare)) return 0.01;
  if(/^XAU/.test(bare)) return 0.1;
  if(/^XAG/.test(bare)) return 0.01;
  if(/^(BTC|ETH)/.test(bare)) return 1;
  return 0.0001;
}
function fmt(v,d){ const n=parseFloat(v); return isFinite(n)?n.toFixed(d):'—'; }
function label(pair){ return pair.length===6 ? pair.slice(0,3)+'/'+pair.slice(3) : pair; }

const SMC = window.BWSMC = {
  bwDate, prettyPair, digitsFor, pipSize, fmt, label,
  data:{H1:{},H4:{}}, conf:{}, state:null,
  lastFetch:0, ok:{H1:null,H4:null,conf:null,state:null}
};

/* ── ZONE MODEL ─────────────────────────────────────────────────
   One shape for order blocks and fair value gaps so everything
   downstream — the ladder, the list, confluence, sweep — reads the
   same object. */
function zonesFrom(node, tf, bare){
  const out=[];
  if(!node) return out;
  (node.orderBlocks||node.order_blocks||[]).forEach(o=>{
    const hi=parseFloat(o.high), lo=parseFloat(o.low);
    if(!isFinite(hi)||!isFinite(lo)) return;
    out.push({kind:'ob', tf,
      hi:Math.max(hi,lo), lo:Math.min(hi,lo),
      dir: String(o.direction||o.type||'').toLowerCase().indexOf('bear')>=0?'bear':'bull',
      at: o.timeStart||o.time||null,
      mitigated: !!(o.mitigated||o.filled||o.tested)});
  });
  (node.fvgs||node.fvg||[]).forEach(f=>{
    const hi=parseFloat(f.high), lo=parseFloat(f.low);
    if(!isFinite(hi)||!isFinite(lo)) return;
    out.push({kind:'fvg', tf,
      hi:Math.max(hi,lo), lo:Math.min(hi,lo),
      dir: String(f.direction||f.type||'').toLowerCase().indexOf('bear')>=0?'bear':'bull',
      at: f.timeStart||f.time||null,
      mitigated: !!(f.filled||f.mitigated)});
  });
  return out;
}

/* ── STRENGTH, NORMALISED ───────────────────────────────────────
   The old panel graded a zone by RAW price height:
       if (r > 0.0015) 'High'; else if (r > 0.0008) 'Medium'
   which only makes sense for a 5-decimal FX pair. On XAU/USD every
   zone scored High; on USD/JPY almost every zone scored Low.
   Height is now measured against the SPREAD OF THIS PAIR'S OWN
   ZONES, so "big" means big for this instrument. A zone that is a
   large share of the local range is a stronger level than a thin
   one, whatever the instrument's price scale. */
function scoreStrength(zone, all, price){
  const heights=all.map(z=>z.hi-z.lo).filter(h=>h>0).sort((a,b)=>a-b);
  const med=heights.length?heights[Math.floor(heights.length/2)]:(zone.hi-zone.lo);
  const h=zone.hi-zone.lo;
  let pct = med>0 ? Math.round(Math.min(100, (h/med)*45)) : 50;
  /* Untouched zones hold better than ones price has already worked. */
  if(zone.touches>=4) pct=Math.round(pct*0.6);
  else if(zone.touches>=2) pct=Math.round(pct*0.8);
  /* An older block that has survived is not weaker for being old, but a
     very old one is more likely to be stale data than a live level. */
  const days=zone.ageMs?zone.ageMs/86400000:0;
  if(days>4) pct=Math.round(pct*0.75);
  return Math.max(6, Math.min(100, pct));
}

/* ── SPENT / MITIGATED ──────────────────────────────────────────
   The EA marks a block mitigated only if price broke it within 20
   bars of forming, so a zone breached later still arrives as live.
   Structure levels tell us what price has since traded through. */
function markSpent(zones, price){
  /* A zone is spent when price has traded DECISIVELY THROUGH it — past the
     far side by more than the zone's own height. Nothing else is reliable
     from this feed.

     An earlier version also treated "a structure level sits beyond this
     zone" as proof it was spent. That was wrong and it marked almost
     everything spent: a break of structure BELOW a demand block is the
     normal case — it is often the very move that CREATED the block. Only
     price position is used now. */
  zones.forEach(z=>{
    const h=Math.max(z.hi-z.lo, 1e-9);
    if(z.mitigated){ z.spent=true; z.spentWhy='the feed marked it mitigated'; return; }
    /* Only ORDER BLOCKS are judged by price position. A fair value gap
       sitting above price is a target, not a spent level — it is only
       done when the feed says it is filled. Judging gaps by position
       marked every unfilled gap above price as spent. */
    if(z.kind==='ob' && isFinite(price)){
      if(z.dir==='bull' && price < z.lo - h){ z.spent=true; z.spentWhy='price has traded well below it'; return; }
      if(z.dir==='bear' && price > z.hi + h){ z.spent=true; z.spentWhy='price has traded well above it'; return; }
    }
    z.spent=false;
  });
}

/* ── CONFLUENCE ─────────────────────────────────────────────────
   A zone on one timeframe overlapping a same-direction zone on the
   other. The H4 block says where the size sits; the H1 block inside
   it says where to enter. */
function overlaps(a,b){ return a.lo<=b.hi && b.lo<=a.hi; }
SMC.confluenceOf=function(z, allBothTF){
  const other = z.tf==='H1' ? 'H4' : 'H1';
  return allBothTF.find(x=>x.tf===other && !x.spent && x.dir===z.dir && overlaps(x,z)) || null;
};

/* ── DISTANCE ───────────────────────────────────────────────────── */
SMC.pipsAway=function(z, price, bare){
  if(!isFinite(price)) return Infinity;
  if(price>=z.lo && price<=z.hi) return 0;
  const raw = price>z.hi ? price-z.hi : z.lo-price;
  return raw / pipSize(bare);
};

/* ── SWEEP, in the Trading Brain's own four states ──────────────
   Wait   – price approaching, the liquidity beyond has NOT been taken
   Watch  – it has been swept, waiting for price to come back in
   Enter  – swept and reclaimed
   null   – no live block to sweep (the Brain shows this as "Expired") */
SMC.sweepFor=function(zones, price, bare){
  if(!isFinite(price)) return null;
  const live=zones.filter(z=>!z.spent && z.kind==='ob');
  if(!live.length) return null;
  let best=null;
  live.forEach(z=>{
    const height=z.hi-z.lo;
    const buf=height*3;
    const away=SMC.pipsAway(z,price,bare);
    let status=null,msg='';
    if(z.dir==='bull'){
      if(price>z.lo && price<z.lo+buf && price>z.hi){
        status='warning';
        msg='Price is approaching the demand block at '+fmt(z.lo,digitsFor(bare))+
            ' but the low has not been swept yet. Entering before the sweep is the commonest way this setup fails.';
      }else if(price>=z.lo && price<=z.hi){
        status='swept';
        msg='Price is inside the demand block. The low has been taken — watch for it to reclaim before committing.';
      }else if(price>z.hi && price<z.hi+buf){
        status='confirmed';
        msg='Price swept the demand block and has reclaimed above it.';
      }
    }else{
      if(price<z.hi && price>z.hi-buf && price<z.lo){
        status='warning';
        msg='Price is approaching the supply block at '+fmt(z.hi,digitsFor(bare))+
            ' but the high has not been swept yet.';
      }else if(price>=z.lo && price<=z.hi){
        status='swept';
        msg='Price is inside the supply block. The high has been taken — watch for rejection before committing.';
      }else if(price<z.lo && price>z.lo-buf){
        status='confirmed';
        msg='Price swept the supply block and has rejected below it.';
      }
    }
    if(status && (!best || away<best.away)) best={status,msg,zone:z,away};
  });
  return best;
};
SMC.sweepLabel=function(s){
  if(!s) return {text:'No live block', cls:'mut',
    note:'No unmitigated order block is in play on this timeframe — the same state the Trading Brain shows as "Expired".'};
  if(s.status==='confirmed') return {text:'Enter now', cls:'up', note:s.msg};
  if(s.status==='swept')     return {text:'Watch',     cls:'bl', note:s.msg};
  return {text:'Wait', cls:'gd', note:s.msg};
};

/* ── STRUCTURE ──────────────────────────────────────────────────── */
SMC.structureFrom=function(node){
  return ((node&&node.structure)||[]).map(s=>{
    const t=String(s.type||'').toUpperCase();
    return {
      kind: t.indexOf('CHOCH')>=0?'CHoCH' : t.indexOf('BOS')>=0?'BOS' : t||'—',
      dir:  t.indexOf('BEAR')>=0?'bear':'bull',
      level: parseFloat(s.level),
      breach: parseFloat(s.breach),
      at: s.time||null
    };
  }).filter(x=>isFinite(x.level)).sort((a,b)=>bwDate(b.at)-bwDate(a.at));
};

/* ── CROSS-MODULE READS ─────────────────────────────────────────
   All three are honest reads of what the other modules actually
   produced. Nothing here is computed by this panel.
     news    – /api/state, the same feed the Brain uses
     verdict – the Brain writes bw-brain-history to localStorage
     risk    – the Assistant writes bw-risk-log on every escalation
   localStorage is shared because every module is same-origin. */
SMC.crossFor=function(bare){
  const out={news:null, verdict:null, risk:null};

  const st=SMC.state||{};
  const news=st.news||st.newsEvents||[];
  if(Array.isArray(news)&&news.length){
    const now=Date.now()/1000;
    const ccy=[bare.slice(0,3), bare.slice(3,6)];
    const next=news.map(e=>({e, dt:(+e.timestamp||0)-now}))
      .filter(x=>x.dt>0 && ccy.indexOf(x.e.country)>=0 && /high/i.test(x.e.impact||''))
      .sort((a,b)=>a.dt-b.dt)[0];
    if(next) out.news={title:next.e.title||'—', mins:Math.round(next.dt/60), ccy:next.e.country};
  }

  try{
    const h=JSON.parse(localStorage.getItem('bw-brain-history')||'[]');
    const hit=(h||[]).find(x=>prettyPair(x.sym)===bare);
    if(hit) out.verdict={call:hit.call, conf:hit.conf, tf:hit.tf, when:hit.stamp};
  }catch(e){}

  try{
    const r=JSON.parse(localStorage.getItem('bw-risk-log')||'[]');
    const hit=(r||[]).find(x=>prettyPair(x.sym)===bare);
    if(hit) out.risk={level:hit.level, score:hit.score, t:hit.t,
      factors:(hit.factors||[]).slice(0,2)};
  }catch(e){}

  return out;
};

/* ── FETCH ──────────────────────────────────────────────────────
   Both timeframes every cycle so confluence is always available.
   Same endpoints and cadence as the original panel. */
function get(url){
  return fetch(url,{credentials:'same-origin',headers:{Accept:'application/json'}})
    .then(r=>r.ok?r.json():Promise.reject(r.status));
}
SMC.refresh=function(){
  return Promise.all([
    get('/smc').then(j=>{SMC.data.H1=j||{};SMC.ok.H1=true;}).catch(()=>{SMC.ok.H1=false;}),
    get('/smc/tf/H4').then(j=>{SMC.data.H4=j||{};SMC.ok.H4=true;}).catch(()=>{SMC.ok.H4=false;}),
    get('/confluence').then(j=>{SMC.conf=j||{};SMC.ok.conf=true;}).catch(()=>{SMC.ok.conf=false;}),
    get('/api/state').then(j=>{SMC.state=j||null;SMC.ok.state=true;}).catch(()=>{SMC.ok.state=false;})
  ]).then(()=>{ SMC.lastFetch=Date.now(); return SMC; });
};

/* ── ASSEMBLE one pair ──────────────────────────────────────────── */
SMC.nodeFor=function(tf, bare){
  const bag=SMC.data[tf]||{};
  for(const k of Object.keys(bag)) if(prettyPair(k)===bare) return bag[k];
  return null;
};
SMC.pairs=function(){
  const set=new Set();
  ['H1','H4'].forEach(tf=>Object.keys(SMC.data[tf]||{}).forEach(k=>{
    const p=prettyPair(k); if(p) set.add(p);
  }));
  return [...set].sort();
};
SMC.build=function(bare){
  const n1=SMC.nodeFor('H1',bare), n4=SMC.nodeFor('H4',bare);
  const node=n1||n4;
  const price=parseFloat((node&&(node.price||node.currentPrice))||NaN);
  const struct1=SMC.structureFrom(n1), struct4=SMC.structureFrom(n4);
  const all=[].concat(zonesFrom(n1,'H1',bare), zonesFrom(n4,'H4',bare));

  all.forEach(z=>{
    const t=bwDate(z.at);
    z.ageMs = isNaN(+t)?0:(Date.now()-t.getTime());
    z.touches = 0;   /* the feed carries no touch count; left at 0 rather
                        than invented, and the UI simply omits it */
  });
  markSpent(all, price);
  all.forEach(z=>{ z.strength=scoreStrength(z, all, price); });

  return {bare, label:label(bare), price, digits:digitsFor(bare),
          zones:all, structure:{H1:struct1,H4:struct4},
          receivedAt:(node&&node.receivedAt)||null};
};

/* Confluence alerts for a pair — VERBATIM matching rule from the old
   panel: compare on the normalised pair, not the raw broker symbol. */
SMC.alertsFor=function(bare){
  return Object.values(SMC.conf||{}).flat()
    .filter(a=>prettyPair(a.symbol)===bare)
    .sort((a,b)=>bwDate(b.time)-bwDate(a.time));
};
})();
