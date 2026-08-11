/* ═══════════════════════════════════════════════════════════════════
   BLACKWOOD — RISK RADAR : UI layer
   Renders the Risk Radar tab, the top-bar chip and the watchlist dots.
   Touches nothing outside its own element ids (all prefixed rr-) plus
   the per-pair dot spans it injects into existing watchlist rows.
   ═══════════════════════════════════════════════════════════════════ */
(function boot(){
'use strict';
const RR = window.BWRiskRadar;
/* Waits for the engine, which itself waits for the host page. Named
   function, not arguments.callee — the latter throws under 'use strict'. */
if(!RR){
  if(boot.tries===undefined) boot.tries=0;
  if(++boot.tries > 160){ console.error('[RiskRadar] engine never loaded'); return; }
  setTimeout(boot, 250);
  return;
}

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function ago(t){ const s=Math.round((Date.now()-t)/1000); return s<60?s+'s':s<3600?Math.round(s/60)+'m':Math.round(s/3600)+'h'; }

/* ── Sparkline + gauge (canvas, no library) ─────────────────────── */
function sparkline(cv, data, color){
  if(!cv || !cv.clientWidth) return;
  const c=cv.getContext('2d'), W=cv.width=cv.clientWidth*2, H=cv.height=cv.clientHeight*2;
  c.clearRect(0,0,W,H);
  [[75,'rgba(226,75,74,0.10)'],[50,'rgba(245,166,35,0.09)'],[25,'rgba(74,158,255,0.07)']]
    .forEach(([v,col])=>{ c.fillStyle=col; c.fillRect(0,0,W,H-(v/100*H)); });
  if(data.length<2) return;
  c.beginPath();
  data.forEach((v,i)=>{ const x=i/(data.length-1)*W, y=H-(v/100*H); i?c.lineTo(x,y):c.moveTo(x,y); });
  c.strokeStyle=color; c.lineWidth=4; c.lineJoin='round'; c.stroke();
  c.lineTo(W,H); c.lineTo(0,H); c.closePath(); c.fillStyle=color+'22'; c.fill();
}
function gauge(cv, score, color){
  if(!cv || !cv.clientWidth) return;
  const c=cv.getContext('2d'), W=cv.width=cv.clientWidth*2, H=cv.height=cv.clientHeight*2;
  c.clearRect(0,0,W,H);
  const cx=W/2, cy=H*0.92, r=Math.min(W/2,H)*0.82;
  c.lineWidth=r*0.16; c.lineCap='round';
  c.beginPath(); c.arc(cx,cy,r,Math.PI,2*Math.PI); c.strokeStyle='rgba(255,255,255,0.06)'; c.stroke();
  c.beginPath(); c.arc(cx,cy,r,Math.PI,Math.PI+(Math.max(score,1)/100)*Math.PI); c.strokeStyle=color; c.stroke();
}

/* ── Watchlist dots — injected once, updated every cycle ─────────── */
function ensureDots(){
  document.querySelectorAll('.pair-row').forEach(row=>{
    const sym = normalisePair(row.dataset.sym||'');
    if(!sym) return;
    const name = row.querySelector('.pair-name');
    if(name && !name.querySelector('.rr-dot')){
      const d=document.createElement('span');
      d.className='rr-dot'; d.id='rr-dot-'+sym;
      name.insertBefore(d, name.firstChild);
    }
  });
}

/* ── Main render ─────────────────────────────────────────────────── */
function render(){
  const sym = normalisePair((typeof activePair!=='undefined'&&activePair)||'');
  const m = RR.for(sym);
  if(!m) return;
  const L = m.level;

  /* top-bar chip — follows the active pair */
  const chip=$('rr-chip');
  if(chip){
    chip.style.color=L.color; chip.style.borderColor=L.color+'55'; chip.style.background=L.color+'14';
    chip.classList.toggle('rr-pulse', L.key==='elevated'||L.key==='standdown');
    const dot=chip.querySelector('.rr-cdot'); if(dot) dot.style.background=L.color;
    const txt=chip.querySelector('.rr-ctext'); if(txt) txt.textContent=sym+' '+L.name+' '+m.score;
  }
  const pill=$('rr-navpill');
  if(pill){ pill.textContent=m.score; pill.style.background=L.color+'22'; pill.style.color=L.color; }

  /* watchlist dots + worst-elsewhere */
  ensureDots();
  const worst = RR.worst();
  (typeof state!=='undefined'&&state.watchlist||[]).forEach(w=>{
    const s=normalisePair(w.symbol), mm=RR.for(s), d=$('rr-dot-'+s);
    if(d && mm){ d.style.background=mm.level.color; d.title=s+' — '+mm.level.name+' '+mm.score; }
  });
  const wh=$('rr-worst');
  if(wh) wh.innerHTML = (worst && worst.sym!==sym && worst.score>=50)
    ? '<span style="color:'+worst.level.color+'">'+worst.sym+' '+worst.level.name+' '+worst.score+'</span>'
    : '<span class="muted">book clear elsewhere</span>';

  /* only paint the tab body when it is visible */
  const tab=$('tab-risk');
  if(!tab || !tab.classList.contains('active')) return;

  const b=$('rr-banner');
  if(b){ b.style.borderColor=L.color+'55'; b.style.background=L.color+'12'; }
  $('rr-score').textContent=m.score; $('rr-score').style.color=L.color;
  $('rr-state').textContent=sym+' — '+L.name; $('rr-state').style.color=L.color;
  $('rr-advice').textContent=L.advice;
  $('rr-since').textContent = m.levelChangedAt ? ('state held '+ago(m.levelChangedAt)) : 'settling…';
  gauge($('rr-gauge'), m.score, L.color);
  sparkline($('rr-spark'), m.history, L.color);

  /* factors */
  let fh = m.factors.map(f=>
    '<div class="rr-factor"><div class="rr-fw" style="color:'+L.color+'">+'+f.weight+'</div>'+
    '<div class="rr-fbody"><div class="rr-flabel">'+esc(f.label)+'<span class="rr-fcat">'+esc(f.cat)+'</span></div>'+
    '<div class="rr-fdetail">'+esc(f.detail)+'</div>'+
    '<div class="rr-fbar"><i style="width:'+Math.min(100,f.weight*2.2)+'%;background:'+L.color+'"></i></div></div></div>').join('');
  const un=[];
  if(m.unavailable && m.unavailable.ob) un.push('Order block interaction');
  if(RR.smcStatus()===false) un.push('Failed break / whipsaw');
  if(un.length) fh += '<div class="rr-factor"><div class="rr-fw muted">n/a</div><div class="rr-fbody">'+
    '<div class="rr-flabel muted">'+un.join(' · ')+'</div>'+
    '<div class="rr-fdetail">SMC feed not reachable — these factors are excluded from the score rather than counted as zero.</div></div></div>';
  $('rr-factors').innerHTML = fh || '<div class="rr-empty">No contributing factors. Conditions are normal for this pair.</div>';
  $('rr-fcount').textContent = m.factors.length+' active';

  /* news window */
  const rows=(m.newsRows||[]).slice(0,4);
  $('rr-news').innerHTML = rows.length ? rows.map(x=>{
    const mm=x.mins, t = mm>0 ? ('T−'+Math.floor(mm)+':'+String(Math.floor((mm%1)*60)).padStart(2,'0')) : ('T+'+Math.floor(-mm)+'m');
    const col = x.mult>0.9?'var(--red)':x.mult>0.5?'var(--amber)':'var(--t2)';
    return '<div class="rr-factor"><div class="rr-fw rr-cd" style="color:'+col+'">'+t+'</div><div class="rr-fbody">'+
      '<div class="rr-flabel">'+esc(x.ev.title)+'<span class="rr-tier rr-tier-'+x.cls.tier+'">'+x.cls.tier+'</span></div>'+
      '<div class="rr-fdetail">'+esc(x.ev.country||'')+' · fcst '+esc(x.ev.forecast||'—')+' · prev '+esc(x.ev.previous||'—')+
      ' · contributing '+Math.round(x.cls.weight*x.mult)+' pts'+(x.cls.matched?'':' · title not in table, fell back to feed impact')+'</div>'+
      '<div class="rr-fbar"><i style="width:'+(x.mult*100)+'%;background:var(--amber)"></i></div></div></div>';
  }).join('') : '<div class="rr-empty">No releases for '+sym+'\u2019s currencies inside the 60-minute window.</div>';

  /* classifier table */
  const evs=(typeof state!=='undefined'&&state.news||[]).slice(0,12);
  $('rr-cls').innerHTML = evs.map(e=>{
    const c=RR.classifyEvent(e);
    return '<tr><td>'+esc(e.title)+'</td><td>'+esc(e.country||'')+'</td>'+
      '<td><span class="rr-tier rr-tier-'+(e.impact==='high'?'high':'medium')+'">'+esc(e.impact||'')+'</span></td>'+
      '<td><span class="rr-tier rr-tier-'+c.tier+'">'+c.tier+'</span></td>'+
      '<td style="font-weight:700">'+c.weight+'</td>'+
      '<td class="muted">'+(c.matched?'title matched':'fallback')+'</td></tr>';
  }).join('') || '<tr><td colspan="6" class="rr-empty">No calendar events loaded.</td></tr>';

  /* outcome log */
  $('rr-log').innerHTML = RR.log.length ? RR.log.slice(0,10).map(l=>{
    const lv=RR.levelFor(l.score);
    const cell=v=> v===null ? '<span class="muted">…</span>' : (v>=0?'+':'')+v.toFixed(1);
    return '<tr><td>'+new Date(l.t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</td>'+
      '<td>'+esc(l.sym)+'</td><td><span style="color:'+lv.color+';font-weight:700">'+esc(l.level)+'</span> '+l.score+'</td>'+
      '<td class="muted">'+esc((l.factors||[]).join(', '))+'</td>'+
      '<td>'+cell(l.after15)+'</td><td>'+cell(l.after60)+'</td></tr>';
  }).join('') : '<tr><td colspan="6" class="rr-empty">No warnings recorded yet. The log fills as pairs escalate.</td></tr>';

  /* whole book */
  $('rr-book').innerHTML = (typeof state!=='undefined'&&state.watchlist||[])
    .map(w=>RR.for(normalisePair(w.symbol)))
    .sort((a,b)=>b.score-a.score)
    .map(q=>'<div class="rr-contrib"><span style="width:62px;font-weight:600">'+esc(q.sym)+'</span>'+
      '<div class="rr-cbar"><i style="width:'+q.score+'%;background:'+q.level.color+'"></i></div>'+
      '<span style="width:74px;text-align:right;color:'+q.level.color+';font-weight:700">'+q.level.name+' '+q.score+'</span></div>').join('');
}

/* ── Tag existing pattern alerts instead of suppressing them ─────── */
function tagAlerts(){
  document.querySelectorAll('#alertFeed .alert-item').forEach(row=>{
    if(row.dataset.rrTagged) return;
    const txt=row.textContent||'';
    const hit=(typeof state!=='undefined'&&state.watchlist||[]).map(w=>normalisePair(w.symbol))
      .find(s=>txt.indexOf(s)>=0 || txt.indexOf(s.slice(0,3)+'/'+s.slice(3))>=0);
    if(!hit) return;
    const m=RR.for(hit);
    if(!m || m.level.key==='clear') return;
    row.dataset.rrTagged='1';
    const name=row.querySelector('.alert-name');
    if(name){
      const tag=document.createElement('span');
      tag.className='rr-tag';
      tag.style.background=m.level.color+'22'; tag.style.color=m.level.color;
      tag.textContent=m.level.name.toUpperCase()+' '+m.score;
      tag.title='This alert fired while '+hit+' was flagged — verify before acting.';
      name.appendChild(tag);
    }
  });
}

/* ── Telegram: only on escalation ────────────────────────────────── */
function pushTelegram(){
  const t=RR.pendingTelegram;
  if(!t) return;
  RR.pendingTelegram=null;
  const box=$('rr-tg');
  if(box) box.innerHTML='<b>⚠️ '+esc(t.sym)+' — '+esc(t.level.name)+'</b><br>Risk score <b>'+t.score+'/100</b><br>'+
    t.factors.map(f=>'• '+esc(f.label)+' (+'+f.weight+')').join('<br>')+
    '<br><span class="muted">'+esc(t.level.advice)+' — '+ago(t.t)+' ago</span>';
  fetch('/api/risk-alert',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({symbol:t.sym, level:t.level.key, score:t.score,
      factors:t.factors.map(f=>({label:f.label,weight:f.weight,detail:f.detail}))})
  }).catch(()=>{});   // silent — the panel is the source of truth if the route isn't live
}

/* ── Loop ────────────────────────────────────────────────────────── */
function tick(){
  try{ RR.cycle(); render(); tagAlerts(); pushTelegram(); }catch(e){ console.warn('[RiskRadar]', e); }
}
setTimeout(tick, 2500);
setInterval(tick, RR.CFG.cycleMs);
window.BWRiskRadarRender = render;
})();
