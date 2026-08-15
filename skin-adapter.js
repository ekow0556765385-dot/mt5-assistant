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
    /* Computed, not read from the feed — see tfIndicators(). This is why
       the bias line was grey in production but coloured in the prototype. */
    const t4=trendSign(tfIndicators(sym,'H4').trend);
    const t1=trendSign(tfIndicators(sym,'H1').trend);
    const tv=t4||t1;
    const bar=$('wlbar-'+sym);
    if(bar){
      bar.style.background = tv>0?'var(--green)' : tv<0?'var(--red)' : 'var(--border2)';
      bar.title = tv>0?'Bullish bias':tv<0?'Bearish bias':'No clear bias';
    }
    const dot=$('wlrisk-'+sym);
    if(dot){
      const m=RR&&RR.for?RR.for(sym):null;
      const col=m?RRlevel(m.score)[1]:'var(--border2)';
      dot.style.background=col;
      if(m) dot.title=sym+' — '+RRlevel(m.score)[0]+' '+m.score;
    }
    const note=row.querySelector('.wl-note-text');
    if(note){
      const t = tv>0?'Bullish' : tv<0?'Bearish' : 'No clear bias';
      if(note.textContent!==t) note.textContent=t;
    }
  });
}

/* ── LOCAL INDICATORS ────────────────────────────────────────────
   `indicatorsByTF` is only populated by CANDLE_UPDATE and usually only
   for the ACTIVE timeframe, so H4 was routinely absent — which is why
   the verdict showed "!" on H1/H4, "Combined signal" said "No H4 data",
   and the watchlist bias line stayed grey. Candles for BOTH timeframes
   ARE always there, so trend and RSI are computed here and the feed's
   own numbers are used only when present. */
function ema(vals,n){
  if(vals.length<n) return NaN;
  const k=2/(n+1);
  let e=vals.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for(let i=n;i<vals.length;i++) e=vals[i]*k+e*(1-k);
  return e;
}
function calcRSI(closes,n){
  if(closes.length<n+1) return NaN;
  let g=0,l=0;
  for(let i=closes.length-n;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    if(d>=0) g+=d; else l-=d;
  }
  if(l===0) return g?100:50;
  const rs=(g/n)/(l/n);
  return 100-100/(1+rs);
}
function tfIndicators(sym,tf){
  const feed=(((typeof dataBySymbol!=='undefined'&&dataBySymbol[sym])||{}).indicatorsByTF||{})[tf]||{};
  const c=candlesOf(sym,tf);
  const closes=c.map(cC).filter(isFinite);
  const e20=isFinite(parseFloat(feed.ema20))?parseFloat(feed.ema20):ema(closes,20);
  const e50=isFinite(parseFloat(feed.ema50))?parseFloat(feed.ema50):ema(closes,50);
  const rsi=isFinite(parseFloat(feed.rsi))?parseFloat(feed.rsi):calcRSI(closes,14);
  let trend=String(feed.trend||'').toLowerCase();
  let derived=false;
  if(!trend && isFinite(e20) && isFinite(e50)){
    trend = e20>e50?'bullish' : e20<e50?'bearish' : 'flat';
    derived=true;
  }
  return {ema20:e20, ema50:e50, rsi, trend, derived,
          have: isFinite(e20)&&isFinite(e50), bars:closes.length};
}
function trendSign(t){ t=String(t||'').toLowerCase();
  return t.indexOf('bull')>=0?1 : t.indexOf('bear')>=0?-1 : 0; }

/* ── SIGNAL VERDICT + WHAT AGREES ────────────────────────────────
   Six signals, each read INDEPENDENTLY from data the dashboard already
   holds. They are allowed to disagree — that disagreement is the point,
   and it is what the "against" tag marks. */
function readSignals(sym){
  const h1=tfIndicators(sym,'H1'), h4=tfIndicators(sym,'H4');
  const out=[];

  const s4=trendSign(h4.trend);
  out.push({k:'H4 trend', v:s4,
    txt: s4>0?'Bullish':s4<0?'Bearish':(h4.bars<50?'Needs '+(50-h4.bars)+' more H4 bars':'Flat'),
    note: h4.derived?'from H4 candles':''});

  const s1=trendSign(h1.trend);
  out.push({k:'H1 trend', v:s1,
    txt: s1>0?'Bullish':s1<0?'Bearish':(h1.bars<50?'Needs '+(50-h1.bars)+' more H1 bars':'Flat'),
    note: h1.derived?'from H1 candles':''});

  const rsi=h1.rsi;
  const rv=!isFinite(rsi)?0 : rsi>55?1 : rsi<45?-1 : 0;
  out.push({k:'RSI momentum', v:rv,
    txt: !isFinite(rsi)?'—' : rsi>=70?'Overbought '+rsi.toFixed(0)
       : rsi<=30?'Oversold '+rsi.toFixed(0) : rsi.toFixed(0)});

  const ev=(isFinite(h1.ema20)&&isFinite(h1.ema50))?(h1.ema20>h1.ema50?1:h1.ema20<h1.ema50?-1:0):0;
  out.push({k:'EMA 20 vs 50', v:ev, txt: ev>0?'Above':ev<0?'Below':'—'});

  const dbs=(typeof dataBySymbol!=='undefined'&&dataBySymbol[sym])||{};
  const pats=((dbs.patternsByTF||{}).H1||[]).concat((dbs.patternsByTF||{}).H4||[])
    .filter(p=>(+p.confidence||0)>=70);
  const bull=pats.filter(p=>/bull/i.test(p.direction||'')).length;
  const bear=pats.filter(p=>/bear/i.test(p.direction||'')).length;
  const pv=bull>bear?1:bear>bull?-1:0;
  out.push({k:'Candlestick patterns', v:pv,
    txt: !pats.length?'None above 70%' : bull+' bull · '+bear+' bear'});

  const px=lastClose(sym), c=candlesOf(sym,'H1');
  let piv=NaN;
  if(c.length>1){
    const d=c.slice(-24);
    piv=(Math.max.apply(null,d.map(cH))+Math.min.apply(null,d.map(cL))+cC(d[d.length-1]))/3;
  }
  const pvv=(isFinite(piv)&&px)?(px>piv?1:-1):0;
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
        (s.note?' <span class="rr-fcat" style="margin-left:5px">'+s.note+'</span>':'')+
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

/* ── TIMEFRAME TOGGLES + LIVE COUNTS ─────────────────────────────
   Patterns and Pattern Alerts each get All / H1 / H4. "All" is rendered
   by us from dataBySymbol into our own container, so we never fight the
   host's renderPatterns() for #patternList. The tab badges count what is
   ACTUALLY VISIBLE under the current toggle. */
let patFilter='All', alertFilter='All';

function setPatFilter(f,btn){
  patFilter=f;
  if(btn) btn.parentNode.querySelectorAll('.seg-btn').forEach(x=>x.classList.toggle('on',x===btn));
  renderPatFilter();
}
function renderPatFilter(){
  /* IMPORTANT: this must NEVER touch the chart timeframe.
     The first version called switchChartTF() for the H1/H4 filters, and
     paintBadges() runs it on every 4s tick — so choosing H4 here silently
     dragged the candlestick chart back to H4 a few seconds after the user
     had switched it to H1, and the RSI series reset on each forced flip.
     The Patterns list is rendered here for ALL three modes from
     dataBySymbol (which holds both timeframes), so the filter and the
     chart are completely independent. */
  const host=$('patternList'), mine=$('patternListAll');
  if(!mine) return 0;
  if(host) host.style.display='none';
  mine.style.display='';

  const sym=normalisePair(typeof activePair!=='undefined'?activePair:'');
  const dbs=(typeof dataBySymbol!=='undefined'&&dataBySymbol[sym])||{};
  const rows=[];
  ['H1','H4'].forEach(tf=>{
    if(patFilter!=='All' && patFilter!==tf) return;
    ((dbs.patternsByTF||{})[tf]||[]).forEach(p=>rows.push({...p,tf}));
  });
  rows.sort((a,b)=>(+b.confidence||0)-(+a.confidence||0));

  mine.innerHTML = rows.length ? rows.map(p=>{
    const d=/bull/i.test(p.direction||'')?'bull':/bear/i.test(p.direction||'')?'bear':'neutral';
    const conf=+p.confidence||0;
    const age=(p.bar_index===undefined||p.bar_index===null)?null:+p.bar_index;
    const ageTxt = age===null?'' : age<=2?' · bar '+age+', recent'
                 : age<=8?' · bar '+age+', context only' : ' · bar '+age+', stale';
    return '<div class="pattern-row"><div style="flex:1">'+
      '<div class="pname">'+esc(p.name||'')+' <span class="tag t-tf">'+p.tf+'</span> '+
      '<span class="tag '+(d==='bull'?'t-bull':d==='bear'?'t-bear':'t-mute')+'">'+d+'</span></div>'+
      '<div class="pmeta">'+(p.price?'at '+esc(p.price):'')+
      (conf>=70?' · alertable':' · below the 70% alert threshold')+ageTxt+'</div></div>'+
      '<span class="pconf" style="color:'+(conf>=70?'var(--text)':'var(--muted)')+'">'+conf+'%</span></div>';
  }).join('')
   : '<div class="rr-empty">No '+(patFilter==='All'?'':patFilter+' ')+
     'patterns detected on '+sym+' yet.</div>';
  return rows.length;
}

function setAlertFilter(f,btn){
  alertFilter=f;
  if(btn) btn.parentNode.querySelectorAll('.seg-btn').forEach(x=>x.classList.toggle('on',x===btn));
  decorateAlerts();
}

/* Each alert gets its own direction tag, and — when it fired while its
   pair was flagged — the Risk Radar state plus the reason underneath. */
function decorateAlerts(){
  const feed=$('alertFeed'); if(!feed) return 0;
  const RR=window.BWRiskRadar;
  let shown=0;
  feed.querySelectorAll('.alert-item').forEach(it=>{
    const txt=it.textContent||'';
    const tf=/\bH4\b/.test(txt)?'H4':/\bH1\b/.test(txt)?'H1':'';
    const show = alertFilter==='All' || tf===alertFilter;
    it.style.display = show?'':'none';
    if(show) shown++;
    if(it.dataset.bwTagged) return;
    it.dataset.bwTagged='1';
    const name=it.querySelector('.alert-name'); if(!name) return;

    const dot=it.querySelector('.alert-dot');
    const dir = dot&&/bull/.test(dot.className)?'bull'
              : dot&&/bear/.test(dot.className)?'bear' : 'neutral';
    const dt=document.createElement('span');
    dt.className='tag '+(dir==='bull'?'t-bull':dir==='bear'?'t-bear':'t-mute');
    dt.style.marginLeft='6px'; dt.textContent=dir;
    name.appendChild(dt);

    const sym=((typeof state!=='undefined'&&state.watchlist)||[])
      .map(w=>normalisePair(w.symbol)).find(x=>txt.indexOf(x)>=0
        || txt.indexOf(x.slice(0,3)+'/'+x.slice(3))>=0);
    if(!sym||!RR||!RR.for) return;
    const m=RR.for(sym); if(!m) return;
    const L=RRlevel(m.score);
    if(m.score<50) return;                      // only flag Elevated / Stand down
    const rt=document.createElement('span');
    rt.className='tag'; rt.style.marginLeft='6px';
    rt.style.color=L[1]; rt.style.borderColor=L[1];
    rt.textContent=L[0]+' '+m.score;
    name.appendChild(rt);

    const why=(m.factors||[]).slice(0,2)
      .map(f=>String(f.detail||f.label||'').replace(/^\[H\d\]\s*/,''))
      .join(' · ');
    const body=it.querySelector('.alert-body')||it;
    const r=document.createElement('div');
    r.className='alert-desc';
    r.style.color=L[1];
    r.textContent='Fired while '+sym+' was '+L[0].toLowerCase()+' — '+
      (why||'several risk conditions were stacked')+'. Verify before acting.';
    body.appendChild(r);
  });
  return shown;
}

function esc(x){ return String(x==null?'':x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

/* Tab badges — counts follow the toggles, and Trade Errors shows a red
   dot only while there is something to fix. */
function paintBadges(){
  const pc=$('badgePatterns');
  if(pc){ const n=renderPatFilter()||0; pc.textContent=n; }
  const ac=$('badgeAlerts');
  if(ac){ const n=decorateAlerts()||0; ac.textContent=n; }
  const ed=$('badgeErrors');
  if(ed){
    const n=parseInt((($('errCount')||{}).textContent)||'0',10)||0;
    ed.style.display = n>0?'inline-block':'none';
    ed.title = n+' trade error'+(n===1?'':'s')+' needing attention';
  }
}

/* ── NEWS: countdowns and day labels ─────────────────────────────── */
function paintNews(){
  const box=$('newsUpcoming'); if(!box) return;
  const now=Date.now()/1000;
  const evs=((typeof state!=='undefined'&&state.news)||[])
    .map(e=>({e, t:(+e.timestamp||0)-now, ts:+e.timestamp||0}))
    .filter(x=>x.ts && x.t>-3600)
    .sort((a,b)=>a.t-b.t).slice(0,12);
  if(!evs.length){ box.innerHTML='<div class="rr-empty">No scheduled releases in the feed.</div>'; return; }
  const today=new Date(); const dayOf=d=>d.getUTCFullYear()+'-'+d.getUTCMonth()+'-'+d.getUTCDate();
  box.innerHTML=evs.map(x=>{
    const d=new Date(x.ts*1000);
    const hhmm=String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0');
    const dd=Math.round((new Date(dayOf(d))-new Date(dayOf(today)))/864e5);
    let when;
    if(x.t<0) when='<span class="muted">released '+Math.round(-x.t/60)+'m ago</span>';
    else if(dd>=2) when='in '+dd+' days · '+hhmm;
    else if(dd===1) when='tomorrow '+hhmm;
    else if(x.t<3600) when='<b>'+Math.floor(x.t/60)+'m '+String(Math.floor(x.t%60)).padStart(2,'0')+'s</b>';
    else when='in '+Math.floor(x.t/3600)+'h '+Math.round((x.t%3600)/60)+'m · '+hhmm;
    const cls=window.BWRiskRadar&&window.BWRiskRadar.classifyEvent
      ? window.BWRiskRadar.classifyEvent(x.e) : {tier:(x.e.impact||'low')};
    const soon = x.t>0 && x.t<3600 && cls.tier==='extreme';
    return '<div class="news-item"><div style="display:flex;gap:10px;align-items:flex-start">'+
      '<div style="flex:1"><div class="news-title">'+esc(x.e.title||'')+
      ' <span class="rr-tier rr-tier-'+cls.tier+'">'+cls.tier+'</span></div>'+
      '<div class="news-meta">'+esc(x.e.country||'')+' · forecast '+esc(x.e.forecast||'—')+
      ' · previous '+esc(x.e.previous||'—')+(x.e.actual?' · actual '+esc(x.e.actual):'')+'</div></div>'+
      '<div class="news-time" style="text-align:right;'+(soon?'color:var(--red)':'')+'">'+when+
      '<div style="margin-top:3px;color:var(--muted)">'+hhmm+' UTC</div></div></div></div>';
  }).join('');
}

/* ── TRADE ERRORS: the deeper analysis from the prototype ────────── */
function paintErrors(){
  const box=$('errDetail'); if(!box) return;
  const tr=((typeof state!=='undefined'&&state.openTrades)||[]);
  if(!tr.length){ box.innerHTML='<div class="rr-empty">No open trades to analyse.</div>'; return; }
  const lots=tr.map(t=>Math.abs(+t.lots||+t.volume||0)).filter(x=>x>0).sort((a,b)=>a-b);
  const med=lots.length?lots[Math.floor(lots.length/2)]:0;
  const rows=[];
  tr.forEach(t=>{
    const sym=normalisePair(t.symbol||'');
    const lot=Math.abs(+t.lots||+t.volume||0);
    const sl=+t.sl||0;
    if(!sl){
      rows.push(['t-bear','Act now', sym+' has no stop loss',
        lot.toFixed(2)+' lots open with nothing protecting it. One bad print can take the account with it — set a stop now.']);
    }
    if(med && lot>med*1.8){
      rows.push(['t-gold','Check', sym+' is '+(lot/med).toFixed(1)+'× your usual size',
        'Your median open position is '+med.toFixed(2)+' lots. This one is '+lot.toFixed(2)+
        '. Oversized trades turn one bad read into a drawdown you have to trade back.']);
    }
    const RR=window.BWRiskRadar, m=RR&&RR.for?RR.for(sym):null;
    if(m && m.score>=75){
      rows.push(['t-bear','Act now', sym+' is open in a stand-down window',
        'Risk Radar has '+sym+' at '+m.score+'. Conditions associated with erratic price behaviour — consider reducing or protecting this position.']);
    }
  });
  box.innerHTML = rows.length ? rows.map(r=>
    '<div class="error-item"><div style="flex:1">'+
    '<div class="etitle">'+esc(r[2])+' <span class="tag '+r[0]+'">'+r[1]+'</span></div>'+
    '<div class="edesc">'+esc(r[3])+'</div></div></div>').join('')
    : '<div class="rr-empty">Nothing flagged. All '+tr.length+' open trade'+(tr.length===1?'':'s')+
      ' have stops and sit within your usual size.</div>';
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
  try{ drawTape(); drawRSI(); paintLevels(); paintWatchlist(); paintNow(); paintVerdict();
       paintBadges(); paintNews(); paintErrors(); paintMiniAlerts(); }
  catch(e){ console.warn('[Skin]',e); }
}
tick();
setInterval(tick,4000);
setInterval(drawTape,30000);
window.BWSkinTick=tick;
window.setPatFilter=setPatFilter;
window.setAlertFilter=setAlertFilter;
/* news countdown ticks every second so the last hour reads live */
setInterval(paintNews,1000);
})();
