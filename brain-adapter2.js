/* ═══════════════════════════════════════════════════════════════════
   BLACKWOOD — TRADING BRAIN v5 : ADAPTER
   ───────────────────────────────────────────────────────────────────
   The page is the approved prototype. The original Brain script is
   embedded byte-identical and still owns: fetchAll, runAnalysis,
   showPage, selectBrainPair/TF, buildSnapshot, buildSSIPage,
   renderSweepBanner, renderPatternFilter, renderLog, credits.

   This file fills the panels the prototype has that the host has no
   concept of, and dresses the verdict. It never writes to cachedData
   or ssiResult.
   ═══════════════════════════════════════════════════════════════════ */
(function boot(){
'use strict';
if(typeof showPage!=='function' || typeof normalisePair!=='function'){
  if(boot.tries===undefined) boot.tries=0;
  if(++boot.tries>160){ console.error('[BrainSkin] host never initialised'); return; }
  setTimeout(boot,250); return;
}
console.log('[BrainSkin] ready');

const $=id=>document.getElementById(id);
const esc=x=>String(x==null?'':x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ── tab icons + sliding ink ─────────────────────────────────────── */
function nudge(tab){
  const ic=tab.querySelector('.tab-ico'); if(!ic) return;
  ic.classList.remove('go'); void ic.offsetWidth; ic.classList.add('go');
}
function moveInk(tab){
  const ink=$('navInk'), nav=$('brainNav');
  if(!ink||!nav||!tab||!tab.offsetWidth) return;
  ink.style.left=(tab.offsetLeft-nav.scrollLeft+13)+'px';
  ink.style.width=(tab.offsetWidth-26)+'px';
}
document.querySelectorAll('.nav-tab').forEach(t=>{
  t.addEventListener('click',()=>{ nudge(t); t.classList.remove('has-new'); setTimeout(()=>moveInk(t),0); });
});
const nav=$('brainNav');
if(nav) nav.addEventListener('scroll',()=>moveInk(document.querySelector('.nav-tab.active')),{passive:true});
window.addEventListener('resize',()=>moveInk(document.querySelector('.nav-tab.active')));
[60,400,1200].forEach(d=>setTimeout(()=>moveInk(document.querySelector('.nav-tab.active')),d));

function markNew(page){
  const t=[...document.querySelectorAll('.nav-tab')]
    .find(x=>(x.getAttribute('onclick')||'').indexOf("'"+page+"'")>=0);
  if(t && !t.classList.contains('active')) t.classList.add('has-new');
}
function bump(el){ if(!el) return; el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }

/* ── candle helpers (EA sends {t,o,h,l,c,v}) ─────────────────────── */
const cC=b=>parseFloat(b&&(b.c!==undefined?b.c:b.close));
function candles(){ try{ return (cachedData&&cachedData.candles)||[]; }catch(e){ return []; } }
function priceNow(){ const c=candles(); return c.length?cC(c[c.length-1]):NaN; }

/* ── CAPTURE THE REAL CONFIDENCE ─────────────────────────────────
   /api/analyse returns extractedConfidence as the WORD "High" /
   "Medium" / "Low" (see the server's extractor), not a percentage. The
   host puts the verdict word in the badge but never writes the
   confidence anywhere, so the dial had nothing to read and sat on a
   dash. This wraps fetch read-only to catch it as it arrives. */
let lastConfWord=null;
(function(){
  const orig=window.fetch;
  window.fetch=function(u,opt){
    const pr=orig.apply(this,arguments);
    if(String(u).indexOf('/api/analyse')>=0){
      pr.then(r=>{ try{
        r.clone().json().then(d=>{
          if(d && d.extractedConfidence) lastConfWord=String(d.extractedConfidence);
        }).catch(()=>{});
      }catch(e){} }).catch(()=>{});
    }
    return pr;
  };
})();
const CONF_PCT={high:85,medium:60,low:35};

/* ── VERDICT dressing ────────────────────────────────────────────
   Reads what the host wrote and lifts call / confidence / levels into
   the prototype's header. #verdict-body keeps Claude's full text. */
function paintVerdict(){
  const badge=$('verdict-signal-badge'), body=$('verdict-body');
  if(!badge||!body) return;
  const call=(badge.textContent||'').trim();
  const txt=body.textContent||'';
  if(!call||call==='—'||!txt) return;

  const col = call==='BULLISH'?'var(--green)' : call==='BEARISH'?'var(--red)' : 'var(--gold-lt)';
  const set=(id,v)=>{ const e=$(id); if(e&&v!==undefined&&e.textContent!==v) e.textContent=v; };

  set('vCall', call==='BULLISH'?'Buy bias' : call==='BEARISH'?'Sell bias' : 'No clear bias');
  const c=$('vCall'); if(c) c.style.color=col;

  /* Prefer a literal percentage if Claude printed one; otherwise map the
     server's High/Medium/Low. Never leave it blank when we know the word. */
  const cm=txt.match(/confidence[^0-9]{0,12}(\d{1,3})\s*%/i);
  const word=(lastConfWord||(txt.match(/confidence[^a-z]{0,6}(high|medium|low)/i)||[])[1]||'').toLowerCase();
  const conf = cm ? Math.min(100,+cm[1]) : (CONF_PCT[word]!==undefined?CONF_PCT[word]:null);
  set('vScore', conf===null?'—':String(conf));
  const lbl=document.querySelector('.v-dial > span');
  if(lbl) lbl.textContent = (!cm && word) ? word+' confidence' : 'Confidence';
  const arc=$('vArc');
  if(arc){ arc.setAttribute('stroke',col);
    arc.setAttribute('stroke-dashoffset', String(Math.round(207-((conf||0)/100)*207))); }

  /* Levels are only shown when Claude actually quoted them — a dash is
     honest, an invented number is not. */
  const grab=re=>{ const m=txt.match(re); return m?m[1]:'—'; };
  const entry=grab(/entry[^0-9]{0,24}(\d+\.\d{2,5})/i);
  const stop =grab(/(?:stop|\bsl\b)[^0-9]{0,24}(\d+\.\d{2,5})/i);
  const tgt  =grab(/(?:target|take profit|\btp\b)[^0-9]{0,24}(\d+\.\d{2,5})/i);
  /* Claude does not always quote levels. "not quoted" is honest; a dash
     reads like the page is broken, and an invented number would be worse. */
  const shown=v=>v==='—'?'not quoted':v;
  set('vEntry',shown(entry)); set('vStop',shown(stop)); set('vTgt',shown(tgt));
  if(entry!=='—'&&stop!=='—'&&tgt!=='—'){
    const r=Math.abs(+tgt-+entry)/Math.max(1e-9,Math.abs(+entry-+stop));
    set('vRR', isFinite(r)?r.toFixed(2)+'R':'not quoted');
  } else set('vRR','needs all three');

  /* The one-line summary above the body: first meaningful sentence. */
  const sub=$('vSub');
  if(sub){
    const line=txt.split(/\n/).map(s=>s.trim())
      .filter(s=>s && !/^verdict:/i.test(s) && !/^confidence/i.test(s))[0]||'';
    if(line) sub.textContent=line;
  }
  const vi=$('vInputs');
  if(vi){
    let n=0; try{ ['update','smc','patterns','candles'].forEach(k=>{
      const d=$('dot-'+k); if(d&&/ok/.test(d.className)) n++; }); }catch(e){}
    vi.innerHTML='Inputs <b class="n">'+n+' of 4</b> fresh';
  }
}

/* ── WHAT THE VERDICT IS BUILT ON ────────────────────────────────
   The prototype's checklist, driven by the real SSI reading. */
function paintInputs(){
  const box=$('brain-inputs'); if(!box) return;
  let r={}; try{ r=(typeof ssiResult!=='undefined'&&ssiResult)||{}; }catch(e){}
  if(!r || r.signal===undefined){
    box.innerHTML='<div class="empty">Fetch data to see what the verdict would be built on.</div>';
    return;
  }
  const pats=(r.patterns||[]);
  /* Same correction as paintContradictions(): the host's `aligned` flag
     uses strict equality against 'bull'/'bear' and mislabels 'bullish'
     patterns as misaligned. Compare direction to the bias directly. */
  const _b=biasDir();
  const aligned=_b?pats.filter(p=>patDir(p)===_b).length:pats.length;
  const against=_b?pats.filter(p=>{const d=patDir(p);return d!=='neutral'&&d!==_b;}).length:0;
  const trend=r.htfBull?'bullish':r.htfBear?'bearish':'no clear direction';
  const rows=[
    [r.htfBull||r.htfBear?'y':'w','H4 trend',
     r.htfBull?'Bullish':r.htfBear?'Bearish':'No clear H4 direction right now'],
    [r.structBuy||r.structSell?'y':'n','Market structure',
     r.structBuy?'Structure is bullish':r.structSell?'Structure is bearish':'No structural break either way'],
    [pats.length?'y':'w','Candlestick patterns',
     pats.length?(pats.length+' detected · '+aligned+' with the trend, '+against+' against'):'None detected on this timeframe'],
    [against?'w':'y','Agreement',
     against?(against+' pattern'+(against===1?'':'s')+' point against the '+trend+' trend'):'Nothing contradicts the trend'],
    [isFinite(+r.rsi)?'y':'w','RSI',
     isFinite(+r.rsi)?((+r.rsi).toFixed(1)+((+r.rsi>=70)?' — overbought':(+r.rsi<=30)?' — oversold':'')):'Not available'],
    [r.signal?'y':'n','SSI signal',
     r.signal===1?'BUY (structure + trend)':r.signal===-1?'SELL (structure + trend)':
     r.signal===2?'BUY (pattern)':r.signal===-2?'SELL (pattern)':'No signal — nothing lines up yet']
  ];
  box.innerHTML=rows.map(x=>
    '<div class="chk '+x[0]+'"><i>'+(x[0]==='y'?'✓':x[0]==='n'?'✕':'!')+'</i>'+
    '<div><div class="chk-t">'+esc(x[1])+'</div><div class="chk-s">'+esc(x[2])+'</div></div></div>').join('');
}

/* SSI CONTRADICTIONS
   DO NOT trust the host's `aligned` flag. It is computed as
       p.direction==='bull' && trend.includes('bull')
   with STRICT equality, but patterns from the fallback detector carry
   'bullish' / 'bearish'. `'bullish' === 'bull'` is false, so a bullish
   pattern in a bullish trend was marked aligned:false and shown here as
   a contradiction — "Bull Engulfing is bullish while H4 trend is
   bullish", which is not a contradiction at all.
   Direction is read through the same tolerant helper used elsewhere and
   compared against the bias the host actually used: the EA's
   SAME-TIMEFRAME bias (pats.bias), not H4. The old copy said "H4 trend"
   and that was wrong too. */
function patDir(p){
  const raw=String((p&&(p.direction!==undefined?p.direction:p.type))||'').toLowerCase();
  return raw.indexOf('bull')>=0?'bull' : raw.indexOf('bear')>=0?'bear' : 'neutral';
}
function patConf(p){
  const v=(p&&(p.confidence!==undefined?p.confidence:p.confidence_pct));
  return +v||0;
}
function biasDir(){
  let raw='';
  try{ const pats=(cachedData&&cachedData.patterns)||{};
       raw=String(pats.bias||pats.ema_bias||'').toLowerCase(); }catch(e){}
  return raw.indexOf('bull')>=0?'bull' : raw.indexOf('bear')>=0?'bear' : '';
}
function paintContradictions(){
  const box=$('ssi-contradictions'); if(!box) return;
  const cnt=$('contra-count');
  let r={}; try{ r=(typeof ssiResult!=='undefined'&&ssiResult)||{}; }catch(e){}
  if(!r.patterns){
    box.innerHTML='<div class="empty">Fetch data to check for contradictions.</div>';
    if(cnt) cnt.textContent=''; return;
  }
  const bias=biasDir();
  if(!bias){
    box.innerHTML='<div class="empty">The EA has not published a bias for this timeframe, so there is nothing for a pattern to contradict.</div>';
    if(cnt) cnt.textContent=''; return;
  }
  const trendWord = bias==='bull' ? 'bullish' : 'bearish';
  let minConf=70;
  try{ const el=$('filter-confidence');
       if(el && el.type!=='checkbox') minConf=parseInt(el.value,10)||70; }catch(e){}

  /* A contradiction is a pattern whose DIRECTION IS OPPOSITE the bias.
     Neutral patterns (doji and friends) contradict nothing. */
  const rows=r.patterns.map(p=>({p,dir:patDir(p),conf:patConf(p)}))
    .filter(x=>x.dir!=='neutral' && x.dir!==bias)
    .map(x=>({name:x.p.name||'Pattern', dir:x.dir, conf:x.conf,
      state: x.conf<minConf ? 'excluded - below '+minConf+'%' : 'live'}));

  const live=rows.filter(x=>x.state==='live').length;
  if(cnt) cnt.textContent = rows.length ? rows.length+' found - '+live+' affects this verdict' : 'none';

  box.innerHTML = rows.length ? rows.map(x=>
    '<div class="chk '+(x.state==='live'?'w':'n')+'"><i>'+(x.state==='live'?'!':'\u2715')+'</i><div>'+
    '<div class="chk-t">'+esc(x.name)+(x.conf?' ('+x.conf+'%)':'')+' is '+
      (x.dir==='bull'?'bullish':'bearish')+' while the '+
      ((typeof brainTF!=='undefined'&&brainTF)||'')+' bias is '+trendWord+
    ' <span class="tag '+(x.state==='live'?'t-gold':'t-mute')+'">'+esc(x.state)+'</span></div>'+
    '<div class="chk-s">'+(x.state==='live'
      ? 'This one reached the analysis and is working against the prevailing bias.'
      : 'Below your confidence filter, so it was not sent to Claude - listed so you know it exists.')+
    '</div></div></div>').join('')
   : '<div class="empty">No pattern contradicts the '+trendWord+' bias. '+
     r.patterns.length+' pattern'+(r.patterns.length===1?'':'s')+' detected, all pointing with it or neutral.</div>';
}

/* ── VERDICT HISTORY ─────────────────────────────────────────────── */
const LS='bw-brain-history';
let hist=[];
try{ const j=JSON.parse(localStorage.getItem(LS)||'[]'); if(Array.isArray(j)) hist=j; }catch(e){}
const save=()=>{ try{ localStorage.setItem(LS,JSON.stringify(hist.slice(0,200))); }catch(e){} };

function record(){
  const call=(($('verdict-signal-badge')||{}).textContent||'').trim();
  if(!call||call==='—') return;
  const stamp=(($('verdict-ts')||{}).textContent||'').trim();
  const sym=(typeof brainSym!=='undefined'&&brainSym)||'';
  const tf=(typeof brainTF!=='undefined'&&brainTF)||'';
  if(hist[0] && hist[0].stamp===stamp && hist[0].sym===sym) return;
  const conf=(($('vScore')||{}).textContent||'').trim();
  hist.unshift({t:Date.now(),stamp,sym:normalisePair(sym),tf,call,conf,
    price:priceNow(),h1:null,h4:null});
  if(hist.length>200) hist.pop();
  save(); markNew('history'); renderHist();
}
function outcomes(){
  const p=priceNow(); if(!isFinite(p)) return;
  let ch=false;
  hist.forEach(h=>{
    if(!isFinite(h.price)) return;
    const mins=(Date.now()-h.t)/60000, pips=(p-h.price)/h.price*10000;
    if(h.h1===null&&mins>=60){ h.h1=pips; ch=true; }
    if(h.h4===null&&mins>=240){ h.h4=pips; ch=true; }
  });
  if(ch){ save(); renderHist(); }
}
function verdictOf(h){
  const v=h.h4!==null?h.h4:h.h1;
  if(v===null) return 'pending';
  if(h.call==='BULLISH') return v>0?'correct':'wrong';
  if(h.call==='BEARISH') return v<0?'correct':'wrong';
  return Math.abs(v)<10?'correct':'wrong';
}
let histFilter='all';
function setHistFilter(f,btn){
  histFilter=f;
  if(btn&&btn.parentNode) btn.parentNode.querySelectorAll('button')
    .forEach(x=>x.classList.toggle('on',x===btn));
  renderHist();
}
function renderHist(){
  const tb=$('hist-tbody');
  const done=hist.filter(h=>verdictOf(h)!=='pending');
  const ok=done.filter(h=>verdictOf(h)==='correct').length;
  const b=$('histBadge'); if(b&&b.textContent!==String(hist.length)){ b.textContent=hist.length; bump(b); }
  const set=(id,v)=>{ const e=$(id); if(e) e.textContent=v; };
  set('histTotal',hist.length);
  /* Zeroes, not dashes. "0 of 0 resolved" tells the user the system is
     working and simply has nothing to score yet. */
  set('histCorrect', ok+' of '+done.length);
  set('histAvg', done.length?Math.round(ok/done.length*100)+'%':'awaiting outcomes');
  if(!tb) return;
  const cell=v=> v===null?'<span class="mut">…</span>'
    :'<span class="'+(v>=0?'up':'dn')+'">'+(v>=0?'+':'')+v.toFixed(1)+'</span>';
  const view=hist.filter(h=>histFilter==='all'?true:verdictOf(h)===histFilter);
  tb.innerHTML = view.length ? view.slice(0,40).map(h=>
    '<tr><td class="n mut">'+esc(h.stamp)+'</td><td><b>'+esc(h.sym)+'</b></td>'+
    '<td class="n">'+esc(h.tf)+'</td>'+
    '<td><span class="tag '+(h.call==='BULLISH'?'t-bull':h.call==='BEARISH'?'t-bear':'t-mute')+'">'+esc(h.call)+'</span></td>'+
    '<td class="n">'+esc(h.conf||'—')+'</td>'+
    '<td class="n">'+cell(h.h1)+'</td><td class="n">'+cell(h.h4)+'</td>'+
    '<td><span class="tag '+(verdictOf(h)==='correct'?'t-bull':verdictOf(h)==='wrong'?'t-bear':'t-gold')+'">'+verdictOf(h)+'</span></td>'+
    '<td class="n mut">—</td></tr>').join('')
   : '<tr><td colspan="9" class="empty">'+(hist.length
       ? 'No verdicts in this filter yet.'
       : 'No verdicts recorded yet. Each analysis is logged here with what price did next.')+'</td></tr>';
}

/* ── WHAT CHANGED SINCE LAST ANALYSIS ────────────────────────────── */
function snap(){
  try{
    const r=(typeof ssiResult!=='undefined'&&ssiResult)||{};
    return {signal:r.signal, trend:r.htfBull?'bull':r.htfBear?'bear':'flat',
      rsi:r.rsi, names:(r.patterns||[]).map(p=>p.name).sort().join(',')};
  }catch(e){ return {signal:null,trend:'flat',rsi:null,names:''}; }
}
function diffs(){
  const box=$('brain-diffs'); if(!box) return;
  const key='bw-brain-snap:'+((typeof brainSym!=='undefined'&&brainSym)||'')+':'+((typeof brainTF!=='undefined'&&brainTF)||'');
  let prev=null; try{ prev=JSON.parse(localStorage.getItem(key)||'null'); }catch(e){}
  const now=snap();
  if(!prev){
    box.innerHTML='<div class="empty">First analysis for this pair and timeframe — nothing to compare against yet.</div>';
    try{ localStorage.setItem(key,JSON.stringify(now)); }catch(e){} return;
  }
  const sig=s=>s===1?'BUY':s===-1?'SELL':s===2?'BUY (pattern)':s===-2?'SELL (pattern)':'none';
  const rows=[];
  if(prev.signal!==now.signal) rows.push(['chg','~','SSI signal moved from '+sig(prev.signal)+' to '+sig(now.signal)]);
  if(prev.trend!==now.trend)   rows.push(['chg','~','H4 trend flipped from '+prev.trend+' to '+now.trend]);
  if(isFinite(+prev.rsi)&&isFinite(+now.rsi)&&Math.abs(prev.rsi-now.rsi)>=2)
    rows.push(['chg','~','RSI moved '+(+prev.rsi).toFixed(1)+' → '+(+now.rsi).toFixed(1)]);
  const a=(prev.names||'').split(',').filter(Boolean), b=(now.names||'').split(',').filter(Boolean);
  b.filter(x=>a.indexOf(x)<0).forEach(x=>rows.push(['add','+',x+' appeared since the last run']));
  a.filter(x=>b.indexOf(x)<0).forEach(x=>rows.push(['rem','−',x+' is no longer present']));
  box.innerHTML = rows.length ? rows.map(d=>'<div class="diff '+d[0]+'"><i>'+d[1]+'</i><div>'+esc(d[2])+'</div></div>').join('')
    : '<div class="empty">Nothing meaningful has changed since your last analysis of this pair and timeframe. '+
      'Running again would spend a credit to be told the same thing.</div>';
  try{ localStorage.setItem(key,JSON.stringify(now)); }catch(e){}
}

/* ── HEADER LABELS ───────────────────────────────────────────────── */
function paintHeader(){
  const sym=(typeof brainSym!=='undefined'&&brainSym)||'';
  const tf=(typeof brainTF!=='undefined'&&brainTF)||'';
  const p=normalisePair(sym);
  const pretty=p.length===6?p.slice(0,3)+'/'+p.slice(3):p;
  const a=$('hSym'), b=$('hTf');
  if(a&&pretty&&a.textContent!==pretty) a.textContent=pretty;
  if(b&&tf&&b.textContent!==tf) b.textContent=tf;
}

/* ── NEXT HIGH-IMPACT RELEASE ────────────────────────────────────
   Built from the news the Brain already fetches. The prototype showed a
   Risk Radar state here, but the Brain has no Risk Radar feed — showing
   a state it cannot know would be inventing one. */
function paintNews(){
  const tEl=$('nextNewsTitle'), iEl=$('nextNewsIn');
  if(!tEl||!iEl) return;
  let news=[];
  try{
    const st=(cachedData&&cachedData._state)||{};
    news=st.news||st.newsEvents||[];
  }catch(e){}
  if(!Array.isArray(news)||!news.length){
    tEl.textContent='—'; iEl.textContent='—'; iEl.style.color=''; return;
  }
  const now=Date.now()/1000;
  const next=news.map(e=>({e,dt:(+e.timestamp||0)-now}))
    .filter(x=>x.dt>0 && /high/i.test(x.e.impact||''))
    .sort((a,b)=>a.dt-b.dt)[0];
  if(!next){ tEl.textContent='Nothing high-impact ahead'; iEl.textContent='—'; iEl.style.color=''; return; }
  tEl.textContent=next.e.title||'—';
  const m=Math.floor(next.dt/60);
  iEl.textContent = m<60 ? m+'m' : Math.floor(m/60)+'h '+(m%60)+'m';
  iEl.style.color = m<60 ? 'var(--red)' : '';
  return {mins:m, title:next.e.title||''};
}

/* ── PRE-FLIGHT GATE ─────────────────────────────────────────────
   Real reasons only. If there is nothing worth saying, the gate stays
   hidden — a warning that is always on screen is furniture, not a
   warning. */
let gateDismissed=0;
function paintGate(){
  const g=$('gate'); if(!g) return;
  if(Date.now()-gateDismissed < 5*60*1000){ g.style.display='none'; return; }
  const reasons=[];

  /* 1. a feed that did not come back */
  const stale=['update','smc','patterns','candles'].filter(k=>{
    const d=$('dot-'+k); return d && /err|error/.test(d.className);
  });
  if(stale.length) reasons.push('The '+stale.join(', ')+' feed'+(stale.length>1?'s':'')+
    ' did not return on the last fetch, so the analysis would be built on whatever was cached before that.');

  /* 2. a live sweep warning from the host's own detector */
  const sw=$('sweep-alert-container');
  if(sw && /wait|not happened|approach/i.test(sw.textContent||''))
    reasons.push('The sweep detector is telling you to wait — liquidity above or below has not been taken yet.');

  /* 3. a high-impact release inside the hour */
  const n=paintNews();
  if(n && n.mins<=60) reasons.push(n.title+' lands in '+n.mins+' minutes. A verdict now describes a market that is about to be repriced.');

  /* 4. a pattern actively fighting the trend */
  const cc=($('contra-count')||{}).textContent||'';
  const live=(cc.match(/(\d+)\s+affects/)||[])[1];
  if(live && +live>0) reasons.push(+live===1
    ? 'One pattern currently contradicts the H4 trend, so the read is less clean than the confidence figure will suggest.'
    : live+' patterns currently contradict the H4 trend, so the read is less clean than the confidence figure will suggest.');

  if(!reasons.length){ g.style.display='none'; return; }
  g.style.display='';
  const bad=stale.length>0;
  g.className='gate'+(bad?' bad':'');
  const ti=$('gateTitle'); if(ti) ti.textContent = bad
    ? 'A feed is missing — an analysis now may be built on stale data'
    : 'Worth checking before you spend a credit';
  const tx=$('gateTxt'); if(tx) tx.innerHTML=reasons.map(esc).join('<br>');
}

/* ── loop ────────────────────────────────────────────────────────── */
/* TRADE LOG SYMBOLS
   saveToLog() records `ud.symbol` straight off the payload, so the
   broker's suffix comes through — EURUSDc on one bridge, EURUSDm on
   another. The host already has normalisePair(), which strips ANY suffix
   up to three characters; the log simply never called it. Tidying the
   rendered cells fixes every bridge at once and leaves the stored entry
   untouched (the raw name is kept in the title attribute). */
function tidyLogSymbols(){
  const tb=$('log-tbody'); if(!tb) return;
  tb.querySelectorAll('tr').forEach(tr=>{
    const td=tr.children[1];            // Symbol column
    if(!td || td.dataset.bwTidy) return;
    const raw=(td.textContent||'').trim();
    if(!raw) return;
    const bare=normalisePair(raw);
    td.dataset.bwTidy='1';
    if(bare && bare!==raw){ td.textContent=bare; td.title=raw; }
  });
}

function tick(){
  try{ paintHeader(); paintVerdict(); paintInputs(); paintContradictions();
       paintNews(); paintGate(); outcomes(); tidyLogSymbols(); }
  catch(e){ console.warn('[BrainSkin]',e); }
}
renderHist(); tick();
setInterval(tick,3000);

/* A new verdict has landed when the host's timestamp changes. */
let lastTs='';
setInterval(()=>{
  const ts=(($('verdict-ts')||{}).textContent||'').trim();
  if(ts && ts!=='—' && ts!==lastTs){
    lastTs=ts;
    setTimeout(()=>{ paintVerdict(); record(); diffs(); },150);
    const card=$('verdict-card');
    if(card){ card.classList.add('flash'); setTimeout(()=>card.classList.remove('flash'),1000); }
  }
},700);

function dismissGate(){ gateDismissed=Date.now(); const g=$('gate'); if(g) g.style.display='none'; }
function togglePre(btn){
  const pre=$('raw-preview'); if(!pre) return;
  const hidden=pre.style.display==='none';
  pre.style.display=hidden?'':'none';
  if(btn) btn.textContent=hidden?'Hide':'Show';
}
window.BWBrainSkin={paintVerdict,tidyLogSymbols,paintInputs,paintContradictions,renderHist,record,diffs,moveInk,
  paintHeader,paintNews,paintGate,dismissGate,togglePre,setHistFilter,
  get history(){return hist;}};
})();
