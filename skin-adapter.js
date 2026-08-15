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
/* History is keyed by PAIR **and TIMEFRAME**. Keying it by pair alone was
   the glitch: switching H1<->H4 fed a completely different RSI series into
   the same history, so the "previous" marker jumped across the track and
   the delta reported a move that never happened. Same on a pair switch.
   A key change RESETS the series rather than diffing across it. */
const rsiHist={};
let rsiKey='';
function drawRSI(){
  const track=$('rsiTrack'); if(!track) return;
  const v=parseFloat((($('rsiVal')||{}).textContent)||'');
  const pair=normalisePair(typeof activePair!=='undefined'?activePair:'');
  const tf=(typeof activeChartTF!=='undefined'&&activeChartTF)||'H1';
  const key=pair+':'+tf;
  const st=$('rsiState'), dl=$('rsiDelta');

  if(!isFinite(v)||v<0||v>100){
    track.innerHTML='';
    if(st){ st.textContent='—'; st.className='tag t-mute'; }
    if(dl) dl.textContent='waiting for indicator data';
    return;
  }
  if(key!==rsiKey){ rsiKey=key; }              // series switched
  const h=rsiHist[key]||(rsiHist[key]=[]);
  if(!h.length || Math.abs(h[h.length-1]-v)>0.01) h.push(v);
  if(h.length>60) h.shift();

  /* Always draw the marker. The PREVIOUS marker only appears once there
     are enough readings from THIS series to mean anything. */
  let html='';
  html+='<div class="rsi-zone" style="left:0;width:30%;background:var(--green);opacity:.10"></div>';
  html+='<div class="rsi-zone" style="left:70%;width:30%;background:var(--red);opacity:.10"></div>';
  [30,50,70].forEach(t=>{ html+='<div class="rsi-zone" style="left:'+t+'%;width:1px;background:var(--border2)"></div>'; });

  const ready = h.length>=4;
  const prev = ready ? h[h.length-4] : null;
  const delta = ready ? v-prev : 0;
  if(ready && Math.abs(delta)>0.05)
    html+='<div class="rsi-prev" style="left:'+Math.max(0,Math.min(100,prev))+'%"></div>';
  html+='<div class="rsi-mark" style="left:'+Math.max(0,Math.min(100,v))+'%"></div>';
  track.innerHTML=html;

  if(st){
    if(!ready){ st.textContent=v>=70?'Overbought':v<=30?'Oversold':'Neutral'; st.className='tag t-mute'; }
    else{
      const rising=delta>0.3, falling=delta<-0.3;
      st.textContent=rising?'Rising':falling?'Falling':'Flat';
      st.className='tag '+(rising?'t-bull':falling?'t-bear':'t-mute');
    }
  }
  if(dl){
    dl.textContent = !ready ? ('reading '+h.length+' of 4 — direction settling')
      : Math.abs(delta)<0.05 ? 'holding this level on '+tf
      : (delta>0?'+':'')+delta.toFixed(1)+' over the last 3 readings on '+tf;
  }
}

/* ── KEY LEVELS + SESSION ────────────────────────────────────────
   These ids existed in the markup with nothing writing to them, so they
   sat on a dash forever. Both come from candles already on the page. */
function paintLevels(){
  const sym=normalisePair(typeof activePair!=='undefined'?activePair:'');
  const c=candlesOf(sym,'H1');
  const hi=$('keyHigh'), lo=$('keyLow');
  if(c.length>2){
    const d=c.slice(-24);
    const H=Math.max.apply(null,d.map(cH)), L=Math.min.apply(null,d.map(cL));
    const dg=/JPY$/.test(sym)?3:/^XA[UG]/.test(sym)?2:5;
    if(hi) hi.textContent=H.toFixed(dg);
    if(lo) lo.textContent=L.toFixed(dg);
  }else{
    if(hi) hi.textContent='—';
    if(lo) lo.textContent='—';
  }
  const el=$('sessNow'); if(!el) return;
  const h=new Date().getUTCHours();
  const live=[];
  if(h>=21||h<6) live.push('Sydney');
  if(h<9) live.push('Tokyo');
  if(h>=7&&h<16) live.push('London');
  if(h>=12&&h<21) live.push('New York');
  el.textContent = live.length?live.join(' · '):'Between sessions';
  const sub=el.nextElementSibling;
  if(sub&&sub.classList.contains('metric-sub'))
    sub.textContent = (h>=12&&h<16) ? 'London–New York overlap — deepest liquidity'
      : live.length ? 'Open now, '+String(h).padStart(2,'0')+':00 UTC'
      : 'Thin book between sessions';
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

/* ── SIGNAL VERDICT + WHAT AGREES ────────────────────────────────
   Six signals, each read INDEPENDENTLY from data the dashboard already
   holds. They are allowed to disagree — that disagreement is the point,
   and it is what the "against" tag marks. */
function readSignals(sym){
  const dbs = (typeof dataBySymbol!=='undefined' && dataBySymbol[sym]) || {};
  const ind = dbs.indicatorsByTF || {};
  const h1 = ind.H1 || {}, h4 = ind.H4 || {};
  const sgn = t => { t=String(t||'').toLowerCase();
    return t.indexOf('bull')>=0?1 : t.indexOf('bear')>=0?-1 : 0; };
  const out=[];

  out.push({k:'H4 trend', v:sgn(h4.trend),
            txt: sgn(h4.trend)>0?'Bullish':sgn(h4.trend)<0?'Bearish':'No H4 data'});
  out.push({k:'H1 trend', v:sgn(h1.trend),
            txt: sgn(h1.trend)>0?'Bullish':sgn(h1.trend)<0?'Bearish':'Flat'});

  const rsi=parseFloat(h1.rsi);
  const rv = !isFinite(rsi)?0 : rsi>55?1 : rsi<45?-1 : 0;
  out.push({k:'RSI momentum', v:rv,
            txt: !isFinite(rsi)?'—' : rsi>70?'Overbought '+rsi.toFixed(0)
               : rsi<30?'Oversold '+rsi.toFixed(0) : rsi.toFixed(0)});

  const e20=parseFloat(h1.ema20), e50=parseFloat(h1.ema50);
  const ev = (isFinite(e20)&&isFinite(e50)) ? (e20>e50?1:e20<e50?-1:0) : 0;
  out.push({k:'EMA 20 vs 50', v:ev, txt: ev>0?'Above':ev<0?'Below':'—'});

  const pats = ((dbs.patternsByTF||{}).H1||[]).concat((dbs.patternsByTF||{}).H4||[])
    .filter(p=>(+p.confidence||0)>=70);
  const bull=pats.filter(p=>/bull/i.test(p.direction||'')).length;
  const bear=pats.filter(p=>/bear/i.test(p.direction||'')).length;
  const pv = bull>bear?1 : bear>bull?-1 : 0;
  out.push({k:'Candlestick patterns', v:pv,
            txt: !pats.length?'None above 70%' : bull+' bull · '+bear+' bear'});

  const px=lastClose(sym), c=candlesOf(sym,'H1');
  let piv=NaN;
  if(c.length>1){
    const d=c.slice(-24);
    const hi=Math.max.apply(null,d.map(cH)), lo=Math.min.apply(null,d.map(cL));
    piv=(hi+lo+cC(d[d.length-1]))/3;
  }
  const pvv = (isFinite(piv)&&px) ? (px>piv?1:-1) : 0;
  out.push({k:'Price vs pivot', v:pvv, txt: pvv>0?'Above':pvv<0?'Below':'—'});
  return out;
}
function cH(b){ return parseFloat(b&&(b.h!==undefined?b.h:b.high)); }
function cL(b){ return parseFloat(b&&(b.l!==undefined?b.l:b.low)); }
function cC(b){ return parseFloat(b&&(b.c!==undefined?b.c:b.close)); }
function candlesOf(sym,tf){
  const d=(typeof dataBySymbol!=='undefined'&&dataBySymbol[sym])||{};
  return (d.candlesByTF&&d.candlesByTF[tf])||[];
}
function lastClose(sym){
  const c=candlesOf(sym,'H1');
  return c.length?cC(c[c.length-1]):0;
}

function paintVerdict(){
  const sym=normalisePair(typeof activePair!=='undefined'?activePair:'');
  if(!sym) return;
  const sigs=readSignals(sym);
  const known=sigs.filter(s=>s.v!==0).length;
  const score=Math.round(sigs.reduce((a,s)=>a+s.v,0)/6*50+50);
  const dir = score>58?1 : score<42?-1 : 0;
  const agree=sigs.filter(s=>s.v===dir&&s.v!==0).length;

  const word=$('verdictWord'), line=$('verdictLine'), arc=$('verdictArc'),
        sc=$('verdictScore'), chk=$('verdictChecks'), parts=$('signalParts'), ac=$('agreeCount');

  if(!known){
    if(word){ word.textContent='Waiting for data'; word.style.color='var(--muted)'; }
    if(sc) sc.textContent='—';
    if(parts) parts.innerHTML='<div class="rr-empty">No indicator data for '+sym+' yet.</div>';
    return;
  }

  const conf=Math.abs(score-50)*2;
  const col = dir>0?'var(--green)' : dir<0?'var(--red)' : 'var(--gold-lt)';
  if(sc){ sc.textContent=conf; sc.style.color=col; }
  if(arc){ arc.setAttribute('stroke',col);
           arc.setAttribute('stroke-dashoffset', String(Math.round(188-(conf/100)*188))); }
  if(word){
    word.textContent = dir>0?'Buy setup forming' : dir<0?'Sell setup forming' : 'No setup — wait';
    word.style.color = col;
  }
  /* Risk Radar has the final say on whether to act at all. */
  const RR=window.BWRiskRadar, m=RR&&RR.for?RR.for(sym):null;
  if(line){
    const rl=m?RRlevel(m.score):null;
    line.textContent = (dir?agree+' of 6 signals point '+(dir>0?'up':'down')+'. '
                          :'Signals are split, with no clear direction. ')
      + (m&&m.score>=50
          ? 'Risk Radar has '+sym+' at '+rl[0]+' ('+m.score+') — size down or wait for the window to pass.'
          : 'Conditions are normal for '+sym+'.');
  }
  if(chk){
    const rows=[];
    sigs.slice(0,3).forEach(s=>{
      rows.push('<div class="chk '+(s.v===dir&&s.v!==0?'y':s.v===0?'w':'n')+'"><i>'+
        (s.v===dir&&s.v!==0?'✓':s.v===0?'!':'✕')+'</i>'+s.k+'</div>');
    });
    if(m&&m.score>=50) rows.push('<div class="chk w"><i>!</i>Risk '+RRlevel(m.score)[0]+'</div>');
    else rows.push('<div class="chk y"><i>✓</i>Risk clear</div>');
    chk.innerHTML=rows.join('');
  }
  if(ac) ac.textContent = dir? (agree+' of 6 agree') : (known+' of 6 readable');
  if(parts){
    parts.innerHTML=sigs.map(s=>{
      const against = dir && s.v!==0 && s.v!==dir;
      return '<div class="kv"><span>'+s.k+'</span>'+
        '<b class="'+(s.v>0?'green':s.v<0?'red':'muted')+'">'+s.txt+
        (against?' <span class="rr-fcat" style="margin-left:5px">against</span>':'')+'</b></div>';
    }).join('');
  }
}

/* ── LATEST ALERTS mirror in the right rail ─────────────────────── */
function paintMiniAlerts(){
  const box=$('miniAlerts'), feed=$('alertFeed');
  if(!box||!feed) return;
  const items=[...feed.querySelectorAll('.alert-item')].slice(0,5);
  if(!items.length){ box.innerHTML='<div class="note">No alerts yet.</div>'; return; }
  box.innerHTML=items.map(it=>{
    const nm=(it.querySelector('.alert-name')||{}).textContent||'';
    const mt=(it.querySelector('.alert-meta')||{}).textContent||'';
    const tm=(it.querySelector('.alert-time')||{}).textContent||'';
    const dot=it.querySelector('.alert-dot');
    const cls=dot?dot.className.replace('alert-dot','').trim():'';
    const col=cls==='bull'?'var(--green)':cls==='bear'?'var(--red)':'var(--muted)';
    return '<div class="row" style="gap:9px">'+
      '<span class="alert-time" style="padding-top:2px">'+tm+'</span>'+
      '<div style="flex:1;min-width:0"><div class="row-t" style="font-size:11.5px">'+nm+'</div>'+
      '<div class="row-s">'+mt+'</div></div>'+
      '<span style="width:2px;align-self:stretch;background:'+col+'"></span></div>';
  }).join('');
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
/* A timeframe change swaps the RSI series — redraw so the previous-marker
   resets instead of diffing H4 against H1. */
document.querySelectorAll('.tf-tab').forEach(b=>{
  b.addEventListener('click',()=>{ setTimeout(()=>{ drawRSI(); paintLevels(); nudgeChart(); },80); });
});
/* Switching pair while the Signal tab is open must redraw the chart.
   applyCachedSymbolData() already does that; this only makes sure the
   canvas is measured correctly if the tab was hidden a moment ago. */
document.querySelectorAll('.pair-row').forEach(r=>{
  r.addEventListener('click',()=>{ setTimeout(()=>{ nudgeChart(); drawRSI(); paintLevels(); paintWatchlist(); paintVerdict(); },80); });
});

/* ── loop ────────────────────────────────────────────────────────── */
decorateWatchlist();
function tick(){
  try{ drawTape(); drawRSI(); paintLevels(); paintWatchlist(); paintNow(); paintVerdict(); paintMiniAlerts(); }
  catch(e){ console.warn('[Skin]',e); }
}
tick();
setInterval(tick,4000);
setInterval(drawTape,30000);
window.BWSkinTick=tick;
})();
