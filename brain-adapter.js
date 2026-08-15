/* ═══════════════════════════════════════════════════════════════════
   BLACKWOOD — TRADING BRAIN : SKIN ADAPTER
   ───────────────────────────────────────────────────────────────────
   Everything the redesign adds on top of the original Brain logic.
   The original script is embedded byte-identical: all 44 wired ids,
   the dot-/lbl-/page- prefixes, .nav-tab, .page, #brainPairTabs and
   #brainTfToggle all still behave exactly as before.

   This file only:
     - animates the tab icons and the sliding underline
     - marks tabs that hold something new
     - builds the structured verdict header around the host's own
       #verdict-body text (never replacing it)
     - records verdict history with +1h / +4h outcomes
     - shows what changed since the previous analysis
     - flags pattern/trend contradictions on the SSI page
   It never writes to cachedData or ssiResult.
   ═══════════════════════════════════════════════════════════════════ */
(function boot(){
'use strict';
if(typeof showPage!=='function' || typeof normalisePair!=='function'){
  if(boot.tries===undefined) boot.tries=0;
  if(++boot.tries>160){ console.error('[BrainSkin] host never initialised'); return; }
  setTimeout(boot,250); return;
}
console.log('[BrainSkin] ready after',(boot.tries||0)*250,'ms');

const $=id=>document.getElementById(id);
const esc=x=>String(x==null?'':x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ── TAB ICONS: react on click, settle after ─────────────────────
   Each icon gets a one-shot animation class on activation. They are
   one-shot on purpose — an icon that animates forever competes with
   the data for attention. */
function nudgeIcon(tab){
  const ic=tab.querySelector('.tab-ico');
  if(!ic) return;
  ic.classList.remove('go');
  void ic.offsetWidth;          // restart the animation
  ic.classList.add('go');
}
function moveInk(tab){
  const ink=$('navInk'), nav=$('brainNav');
  if(!ink||!nav||!tab) return;
  ink.style.left=(tab.offsetLeft-nav.scrollLeft+12)+'px';
  ink.style.width=(tab.offsetWidth-24)+'px';
}
document.querySelectorAll('.nav-tab').forEach(t=>{
  t.addEventListener('click',()=>{
    nudgeIcon(t);
    t.classList.remove('has-new');
    setTimeout(()=>moveInk(t),0);
  });
});
const navEl=$('brainNav');
if(navEl) navEl.addEventListener('scroll',()=>moveInk(document.querySelector('.nav-tab.active')),{passive:true});
window.addEventListener('resize',()=>moveInk(document.querySelector('.nav-tab.active')));
setTimeout(()=>moveInk(document.querySelector('.nav-tab.active')),80);

function markNew(page){
  const t=[...document.querySelectorAll('.nav-tab')]
    .find(x=>(x.getAttribute('onclick')||'').indexOf("'"+page+"'")>=0);
  if(t && !t.classList.contains('active')) t.classList.add('has-new');
}
function bump(el){ if(!el) return; el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }

/* ── VERDICT HISTORY ─────────────────────────────────────────────
   The only honest way to know whether the Brain earns its credits.
   Every verdict is stored with the price at the time, then what price
   did an hour and four hours later. Local to this device. */
const LSKEY='bw-brain-history';
let history=[];
try{ const j=JSON.parse(localStorage.getItem(LSKEY)||'[]'); if(Array.isArray(j)) history=j; }catch(e){}
function saveHistory(){ try{ localStorage.setItem(LSKEY,JSON.stringify(history.slice(0,200))); }catch(e){} }

function priceNow(){
  try{
    const c=(cachedData&&cachedData.candles)||[];
    if(c.length){ const l=c[c.length-1]; return parseFloat(l.c!==undefined?l.c:l.close); }
  }catch(e){}
  return NaN;
}
function recordVerdict(){
  const badge=$('verdict-signal-badge');
  const call=badge?badge.textContent.trim():'';
  if(!call||call==='—') return;
  const sym=(typeof brainSym!=='undefined'&&brainSym)||'';
  const tf=(typeof brainTF!=='undefined'&&brainTF)||'';
  const stamp=($('verdict-ts')||{}).textContent||'';
  if(history[0] && history[0].stamp===stamp && history[0].sym===sym) return;   // already logged
  history.unshift({t:Date.now(), stamp, sym, tf, call,
    price:priceNow(), h1:null, h4:null});
  if(history.length>200) history.pop();
  saveHistory();
  markNew('history');
  renderHistory();
}
function updateOutcomes(){
  const p=priceNow(); if(!isFinite(p)) return;
  let changed=false;
  history.forEach(h=>{
    if(!isFinite(h.price)) return;
    const mins=(Date.now()-h.t)/60000;
    const pips=(p-h.price)/h.price*10000;
    if(h.h1===null && mins>=60){ h.h1=pips; changed=true; }
    if(h.h4===null && mins>=240){ h.h4=pips; changed=true; }
  });
  if(changed){ saveHistory(); renderHistory(); }
}
function outcomeOf(h){
  const v=h.h4!==null?h.h4:h.h1;
  if(v===null) return 'pending';
  if(h.call==='BULLISH') return v>0?'correct':'wrong';
  if(h.call==='BEARISH') return v<0?'correct':'wrong';
  return Math.abs(v)<10?'correct':'wrong';       // NEUTRAL: right if it stayed quiet
}
function renderHistory(){
  const tb=$('hist-tbody'); if(!tb) return;
  const done=history.filter(h=>outcomeOf(h)!=='pending');
  const ok=done.filter(h=>outcomeOf(h)==='correct').length;
  if($('hist-total')) $('hist-total').textContent=history.length;
  if($('hist-correct')) $('hist-correct').textContent=done.length?ok+' of '+done.length:'—';
  if($('hist-rate')) $('hist-rate').textContent=done.length?Math.round(ok/done.length*100)+'%':'—';
  const cell=v=> v===null?'<span class="mut">…</span>'
    :'<span class="'+(v>=0?'up':'dn')+'">'+(v>=0?'+':'')+v.toFixed(1)+'</span>';
  tb.innerHTML = history.length ? history.slice(0,40).map(h=>{
    const o=outcomeOf(h);
    return '<tr><td class="n mut">'+esc(h.stamp||'')+'</td><td><b>'+esc(h.sym)+'</b></td>'+
      '<td class="n">'+esc(h.tf)+'</td>'+
      '<td><span class="tag '+(h.call==='BULLISH'?'t-bull':h.call==='BEARISH'?'t-bear':'t-mute')+'">'+esc(h.call)+'</span></td>'+
      '<td class="n">'+cell(h.h1)+'</td><td class="n">'+cell(h.h4)+'</td>'+
      '<td><span class="tag '+(o==='correct'?'t-bull':o==='wrong'?'t-bear':'t-gold')+'">'+o+'</span></td></tr>';
  }).join('')
   : '<tr><td colspan="7" class="empty">No verdicts recorded yet. Each analysis is logged here with what price did next.</td></tr>';
}

/* ── WHAT CHANGED SINCE THE LAST ANALYSIS ────────────────────────
   A snapshot of the inputs is kept per pair+timeframe and diffed on
   the next run, so a credit spent on an unchanged question is
   visible before it is spent again. */
const SNAP='bw-brain-snap';
function snapshot(){
  /* Never returns null — a missing ssiResult just means an empty reading,
     and the user should still get "first analysis for this pair" rather
     than a vague "nothing to compare". */
  try{
    const r=(typeof ssiResult!=='undefined'&&ssiResult)||{};
    const pats=((cachedData&&cachedData.patterns)||{});
    return {signal:r.signal, trend:(r.htfBull?'bull':r.htfBear?'bear':'flat'),
      conf:r.confidence, rsi:r.rsi,
      names:(normaliseServerPatterns?normaliseServerPatterns(pats):[]).map(p=>p.name).sort().join(',')};
  }catch(e){ return {signal:null,trend:'flat',conf:null,rsi:null,names:''}; }
}
function diffAgainstLast(){
  const box=$('brain-diffs'); if(!box) return;
  const key=SNAP+':'+((typeof brainSym!=='undefined'&&brainSym)||'')+':'+((typeof brainTF!=='undefined'&&brainTF)||'');
  let prev=null;
  try{ prev=JSON.parse(localStorage.getItem(key)||'null'); }catch(e){}
  const now=snapshot();
  if(!prev){
    box.innerHTML='<div class="empty">First analysis for this pair and timeframe — nothing to compare against yet.</div>';
    try{ localStorage.setItem(key,JSON.stringify(now)); }catch(e){}
    return;
  }
  const rows=[];
  if(prev.signal!==now.signal)
    rows.push(['chg','~','SSI signal moved from '+shortSig(prev.signal)+' to '+shortSig(now.signal)]);
  if(prev.trend!==now.trend)
    rows.push(['chg','~','H4 trend flipped from '+prev.trend+' to '+now.trend]);
  if(isFinite(prev.rsi)&&isFinite(now.rsi)&&Math.abs(prev.rsi-now.rsi)>=2)
    rows.push(['chg','~','RSI moved '+(+prev.rsi).toFixed(1)+' → '+(+now.rsi).toFixed(1)]);
  const a=(prev.names||'').split(',').filter(Boolean), b=(now.names||'').split(',').filter(Boolean);
  b.filter(x=>a.indexOf(x)<0).forEach(x=>rows.push(['add','+',x+' appeared since the last run']));
  a.filter(x=>b.indexOf(x)<0).forEach(x=>rows.push(['rem','−',x+' is no longer present']));
  box.innerHTML = rows.length ? rows.map(d=>
      '<div class="diff '+d[0]+'"><i>'+d[1]+'</i><div>'+esc(d[2])+'</div></div>').join('')
    : '<div class="empty">Nothing meaningful has changed since your last analysis of this pair and timeframe. '+
      'Running again would spend a credit to be told the same thing.</div>';
  try{ localStorage.setItem(key,JSON.stringify(now)); }catch(e){}
}
function shortSig(s){ return s===1?'BUY':s===-1?'SELL':s===2?'BUY (pattern)':s===-2?'SELL (pattern)':'none'; }

/* ── SSI CONTRADICTIONS ──────────────────────────────────────────
   A pattern pointing against the prevailing trend is the commonest
   reason a confident-looking setup fails. Each one is labelled with
   whether it actually reached the analysis or was filtered out. */
function renderContradictions(){
  const box=$('ssi-contradictions'); if(!box) return;
  let pats=[], bull=false, bear=false, minConf=70, maxAge=2;
  try{
    const r=(typeof ssiResult!=='undefined'&&ssiResult)||{};
    bull=!!r.htfBull; bear=!!r.htfBear;
    pats=(typeof getEAPatterns==='function'?getEAPatterns():[])||[];
    minConf=parseInt(($('filter-confidence')||{}).value,10)||70;
  }catch(e){}
  if(!bull&&!bear){
    box.innerHTML='<div class="empty">No clear H4 trend right now, so nothing can contradict it.</div>';
    if($('contra-count')) $('contra-count').textContent='';
    return;
  }
  const trendWord=bull?'bullish':'bearish';
  const rows=[];
  pats.forEach(p=>{
    const dir=/bull/i.test(p.direction||p.dir||'')?'bull':/bear/i.test(p.direction||p.dir||'')?'bear':'';
    if(!dir) return;
    const against=(bull&&dir==='bear')||(bear&&dir==='bull');
    if(!against) return;
    const conf=+p.confidence||0;
    const age=(p.bar_index===undefined||p.bar_index===null)?null:+p.bar_index;
    const excluded = conf<minConf ? 'excluded · below '+minConf+'%'
                   : (age!==null&&age>maxAge) ? 'excluded · stale at bar '+age : 'live';
    rows.push([p.name||'Pattern', dir, conf, age, excluded]);
  });
  const live=rows.filter(r=>r[4]==='live').length;
  if($('contra-count')) $('contra-count').textContent=rows.length+' found · '+live+' affects this verdict';
  box.innerHTML = rows.length ? rows.map(r=>
    '<div class="chk '+(r[4]==='live'?'w':'n')+'"><i>'+(r[4]==='live'?'!':'✕')+'</i><div>'+
    '<div class="chk-t">'+esc(r[0])+' ('+r[2]+'%) is '+(r[1]==='bull'?'bullish':'bearish')+
    ' while H4 trend is '+trendWord+
    ' <span class="tag '+(r[4]==='live'?'t-gold':'t-mute')+'">'+esc(r[4])+'</span></div>'+
    '<div class="chk-s">'+(r[4]==='live'
      ? 'This one reached the analysis and is actively working against the trend.'
      : 'Filtered out before the analysis — listed so you know it exists.')+'</div></div></div>').join('')
   : '<div class="empty">No pattern currently contradicts the '+trendWord+' H4 trend.</div>';
}

/* ── VERDICT HEADER ──────────────────────────────────────────────
   Reads what the host already wrote and lifts the call, confidence
   and levels into the structured header. #verdict-body keeps the
   full text underneath, untouched. */
function paintVerdictHeader(){
  const badge=$('verdict-signal-badge'), body=$('verdict-body');
  if(!badge||!body) return;
  const call=badge.textContent.trim();
  const txt=body.textContent||'';
  const el=(id,v)=>{ const e=$(id); if(e&&v!==undefined&&e.textContent!==v) e.textContent=v; };
  if(!call||call==='—'||!txt){ if($('vHead')) $('vHead').style.display='none'; return; }
  if($('vHead')) $('vHead').style.display='';

  const col = call==='BULLISH'?'var(--green)' : call==='BEARISH'?'var(--red)' : 'var(--gold-lt)';
  el('vCall', call==='BULLISH'?'Buy bias':call==='BEARISH'?'Sell bias':'No clear bias');
  const c=$('vCall'); if(c) c.style.color=col;

  const cm=txt.match(/confidence[^0-9]{0,12}(\d{1,3})\s*%/i);
  const conf=cm?Math.min(100,+cm[1]):null;
  el('vScore', conf===null?'—':String(conf));
  const arc=$('vArc');
  if(arc){ arc.setAttribute('stroke',col);
    arc.setAttribute('stroke-dashoffset', String(Math.round(207-((conf||0)/100)*207))); }

  /* Levels, if Claude quoted any. Never invented — a blank is honest. */
  const nums=(txt.match(/\d+\.\d{2,5}/g)||[]);
  const grab=re=>{ const m=txt.match(re); return m?m[1]:'—'; };
  el('vEntry', grab(/entry[^0-9]{0,20}(\d+\.\d{2,5})/i));
  el('vStop',  grab(/(?:stop|sl)\b[^0-9]{0,20}(\d+\.\d{2,5})/i));
  el('vTgt',   grab(/(?:target|take profit|tp)\b[^0-9]{0,20}(\d+\.\d{2,5})/i));
}

/* ── loop ────────────────────────────────────────────────────────── */
function tick(){
  try{
    paintVerdictHeader(); renderContradictions(); updateOutcomes();
    const b=$('log-count-badge'); if(b&&b.dataset.last!==b.textContent){ bump(b); b.dataset.last=b.textContent; }
  }catch(e){ console.warn('[BrainSkin]',e); }
}
renderHistory(); tick();
setInterval(tick,3000);

/* Hook the host's own analysis completion: when the timestamp changes,
   a fresh verdict has landed. */
let lastTs='';
setInterval(()=>{
  const ts=($('verdict-ts')||{}).textContent||'';
  if(ts && ts!==lastTs){
    lastTs=ts;
    setTimeout(()=>{ paintVerdictHeader(); recordVerdict(); diffAgainstLast(); },120);
    const card=$('verdict-card');
    if(card){ card.classList.add('flash'); setTimeout(()=>card.classList.remove('flash'),1000); }
  }
},700);

window.BWBrainSkin={renderHistory,diffAgainstLast,renderContradictions,paintVerdictHeader,
  recordVerdict,markNew,moveInk,get history(){return history;}};
})();
