/* ═══════════════════════════════════════════════════════════════════
   BLACKWOOD — MT5 ASSISTANT : SKIN ADAPTER
   ───────────────────────────────────────────────────────────────────
   Everything the REDESIGN adds on top of the original dashboard logic.
   The original script is untouched: all 56 wired ids, switchTab,
   switchToPair, applyCachedSymbolData, updateCandlestickChart and the
   .pair-row click binding still do exactly what they did before.

   This file only:
     - draws the session tape
     - draws the RSI momentum track from the existing rsiVal
     - mirrors bias + risk state onto the watchlist rows
     - keeps the "Now" rail in sync
     - resizes the price chart when a tab becomes visible again
   It never writes to `state` or `dataBySymbol`.
   ═══════════════════════════════════════════════════════════════════ */
(function boot(){
'use strict';
/* The host page's main script is `defer`, so it runs AFTER this inline
   script. Wait for its globals by BARE name — they are declared with
   `let`, which never creates a window property. */
if(typeof normalisePair!=='function' || typeof state==='undefined' || typeof dataBySymbol==='undefined'){
  if(boot.tries===undefined) boot.tries=0;
  if(++boot.tries>160){ console.error('[Skin] host page never initialised'); return; }
  setTimeout(boot,250); return;
}
console.log('[Skin] ready after',(boot.tries||0)*250,'ms');

function $(id){ return document.getElementById(id); }
const RRlevel = s => s>=75?['Stand down','var(--red)'] : s>=50?['Elevated','var(--gold-lt)']
                    : s>=25?['Caution','var(--blue)'] : ['Clear','var(--green)'];

/* ── SESSION TAPE ────────────────────────────────────────────────
   Sessions are fixed UTC windows. News markers come from the SAME
   state.news the old news feed uses — no new data source. */
const SESS=[{n:'Sydney',a:21,b:6},{n:'Tokyo',a:0,b:9},{n:'London',a:7,b:16},{n:'New York',a:12,b:21}];
function drawTape(){
  const tape=$('sessionTape'); if(!tape) return;
  const d=new Date(), nowH=d.getUTCHours()+d.getUTCMinutes()/60;
  const today=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())/1000;
  const evs=((typeof state!=='undefined'&&state.news)||[]).map(e=>{
    const ts=+e.timestamp||0; if(!ts) return null;
    const h=(ts-today)/3600;
    if(h<0||h>24) return null;
    const hi=/high/i.test(e.impact||'');
    return {h, hi, t:(e.title||'').split(/\s+/).slice(0,3).join(' ')};
  }).filter(Boolean).slice(0,8);

  let html='';
  SESS.forEach(s=>{
    (s.a<s.b?[[s.a,s.b]]:[[s.a,24],[0,s.b]]).forEach((g,i)=>{
      html+='<div class="sess" style="left:'+(g[0]/24*100)+'%;width:'+((g[1]-g[0])/24*100)+'%">'+
            (i?'':'<i>'+s.n+'</i>')+'</div>';
    });
  });
  html+='<div class="sess ov" style="left:50%;width:'+(4/24*100)+'%"></div>';
  html+='<div class="rband">'+Array.from({length:48},function(_,i){
    const t=i/2;
    const near=evs.some(e=>e.hi&&Math.abs(t-e.h)<0.75);
    const ov=t>=12&&t<16;
    const col=near?'var(--red)':ov?'var(--gold)':(t>=7&&t<21?'var(--border2)':'var(--border)');
    return '<i style="width:'+(100/48)+'%;background:'+col+'"></i>';
  }).join('')+'</div>';
  evs.forEach(e=>{ html+='<div class="ev '+(e.hi?'':'m')+'" style="left:'+(e.h/24*100)+'%" data-t="'+
    e.t.replace(/"/g,'')+'"></div>'; });
  html+='<div class="now" style="left:'+(nowH/24*100)+'%"></div>';
  tape.innerHTML=html;
  const hrs=$('tapeHours');
  if(hrs && !hrs.dataset.done){
    hrs.innerHTML=[0,3,6,9,12,15,18,21,24].map(x=>'<span>'+String(x).padStart(2,'0')+'</span>').join('');
    hrs.dataset.done='1';
  }
}

/* ── RSI MOMENTUM ────────────────────────────────────────────────
   Reads the value the original script already puts in #rsiVal and
   keeps a short history per pair so DIRECTION is visible, not just
   level. Three bars back is the comparison point. */
const rsiHist={};
function drawRSI(){
  const track=$('rsiTrack'); if(!track) return;
  const raw=($('rsiVal')&&$('rsiVal').textContent)||'';
  const v=parseFloat(raw);
  const pair=normalisePair(typeof activePair!=='undefined'?activePair:'');
  if(!isFinite(v)){ track.innerHTML=''; if($('rsiState')) $('rsiState').textContent='—'; return; }

  const h=rsiHist[pair]||(rsiHist[pair]=[]);
  if(!h.length || Math.abs(h[h.length-1]-v)>0.01) h.push(v);
  if(h.length>40) h.shift();
  const prev = h.length>3 ? h[h.length-4] : h[0];
  const delta = v-prev;

  let html='';
  html+='<div class="rsi-zone" style="left:0;width:30%;background:var(--green);opacity:.10"></div>';
  html+='<div class="rsi-zone" style="left:70%;width:30%;background:var(--red);opacity:.10"></div>';
  [30,50,70].forEach(t=>{ html+='<div class="rsi-zone" style="left:'+t+'%;width:1px;background:var(--border2)"></div>'; });
  if(Math.abs(delta)>0.05) html+='<div class="rsi-prev" style="left:'+Math.max(0,Math.min(100,prev))+'%"></div>';
  html+='<div class="rsi-mark" style="left:'+Math.max(0,Math.min(100,v))+'%"></div>';
  track.innerHTML=html;

  const st=$('rsiState'), dl=$('rsiDelta');
  if(st){
    const rising=delta>0.3, falling=delta<-0.3;
    st.textContent = rising?'Rising' : falling?'Falling' : 'Flat';
    st.className = 'tag '+(rising?'t-bull':falling?'t-bear':'t-mute');
  }
  if(dl) dl.textContent = Math.abs(delta)<0.05 ? 'holding this level'
        : (delta>0?'+':'')+delta.toFixed(1)+' over the last 3 readings';
}

/* ── WATCHLIST: bias bar + risk dot ──────────────────────────────
   Injected into the existing .pair-row markup. The original click
   binding and updateWatchlist() are untouched. */
function decorateWatchlist(){
  document.querySelectorAll('.pair-row').forEach(row=>{
    const sym=normalisePair(row.dataset.sym||''); if(!sym) return;
    if(!row.querySelector('.wl-bar')){
      const b=document.createElement('span');
      b.className='wl-bar'; b.id='wlbar-'+sym;
      row.insertBefore(b,row.firstChild);
    }
    const note=row.querySelector('.wl-note');
    if(note && !note.querySelector('.wl-risk')){
      const d=document.createElement('i');
      d.className='wl-risk'; d.id='wlrisk-'+sym;
      note.insertBefore(d,note.firstChild);
    }
  });
}
function paintWatchlist(){
  const RR=window.BWRiskRadar;
  document.querySelectorAll('.pair-row').forEach(row=>{
    const sym=normalisePair(row.dataset.sym||''); if(!sym) return;
    /* bias from the cached H4/H1 indicators the dashboard already holds */
    const ind=((dataBySymbol[sym]||{}).indicatorsByTF)||{};
    const tr=String((ind.H4&&ind.H4.trend)||(ind.H1&&ind.H1.trend)||'').toLowerCase();
    const bar=$('wlbar-'+sym);
    if(bar) bar.style.background = tr.indexOf('bull')>=0?'var(--green)'
      : tr.indexOf('bear')>=0?'var(--red)' : 'var(--border2)';
    const dot=$('wlrisk-'+sym);
    if(dot){
      const m=RR&&RR.for?RR.for(sym):null;
      const col=m?RRlevel(m.score)[1]:'var(--border2)';
      dot.style.background=col;
      if(m) dot.title=sym+' — '+RRlevel(m.score)[0]+' '+m.score;
    }
    const note=row.querySelector('.wl-note-text');
    if(note){
      const t = tr.indexOf('bull')>=0?'Bullish' : tr.indexOf('bear')>=0?'Bearish' : 'No clear bias';
      if(note.textContent!==t) note.textContent=t;
    }
  });
}

/* ── "NOW" RAIL ─────────────────────────────────────────────────── */
function paintNow(){
  const RR=window.BWRiskRadar;
  const sym=normalisePair(typeof activePair!=='undefined'?activePair:'');
  const m=RR&&RR.for?RR.for(sym):null;
  const rs=$('nowRisk');
  if(rs){
    if(m){ const L=RRlevel(m.score); rs.textContent=L[0]+' · '+m.score; rs.style.color=L[1]; }
    else { rs.textContent='—'; rs.style.color='var(--muted)'; }
  }
  const nr=$('nowNews');
  if(nr){
    const now=Date.now()/1000;
    const next=((typeof state!=='undefined'&&state.news)||[])
      .map(e=>({t:(+e.timestamp||0)-now, hi:/high/i.test(e.impact||'')}))
      .filter(x=>x.t>0).sort((a,b)=>a.t-b.t)[0];
    if(next){
      const mins=Math.round(next.t/60);
      nr.textContent = mins<60?mins+'m' : Math.floor(mins/60)+'h '+(mins%60)+'m';
      nr.style.color = next.hi&&mins<60?'var(--red)':'var(--text)';
    } else { nr.textContent='—'; nr.style.color='var(--muted)'; }
  }
  const ot=$('nowTrades');
  if(ot) ot.textContent=((typeof state!=='undefined'&&state.openTrades)||[]).length;
  const al=$('nowAlerts');
  if(al){
    const b=parseInt(($('cntBull')||{}).textContent||0)||0;
    const r=parseInt(($('cntBear')||{}).textContent||0)||0;
    const n=parseInt(($('cntNeut')||{}).textContent||0)||0;
    al.textContent=b+r+n;
  }
}

/* ── CHART VISIBILITY ────────────────────────────────────────────
   Chart.js measures the canvas when it draws. A canvas inside a
   hidden tab measures zero, so the chart comes back blank when the
   tab is shown again — resize it once it is visible. The original
   switchTab is left alone; this just listens on the buttons. */
function nudgeChart(){
  try{
    if(typeof priceChartObj!=='undefined' && priceChartObj && priceChartObj.resize){
      priceChartObj.resize();
      priceChartObj.update('none');
    }
  }catch(e){}
}
document.querySelectorAll('.nav-btn').forEach(b=>{
  b.addEventListener('click',()=>{ setTimeout(nudgeChart,60); });
});
/* Switching pair while the Signal tab is open must redraw the chart.
   applyCachedSymbolData() already does that; this only makes sure the
   canvas is measured correctly if the tab was hidden a moment ago. */
document.querySelectorAll('.pair-row').forEach(r=>{
  r.addEventListener('click',()=>{ setTimeout(()=>{ nudgeChart(); drawRSI(); paintWatchlist(); },80); });
});

/* ── loop ────────────────────────────────────────────────────────── */
decorateWatchlist();
function tick(){
  try{ drawTape(); drawRSI(); paintWatchlist(); paintNow(); }
  catch(e){ console.warn('[Skin]',e); }
}
tick();
setInterval(tick,4000);
setInterval(drawTape,30000);
window.BWSkinTick=tick;
})();
