/* ═══════════════════════════════════════════════════════════════════
   BLACKWOOD — SMC PANEL : UI
   Renders the approved prototype layout from real engine data.
   Every repaint is guarded by a content comparison, so nothing is
   rewritten on the 5s poll unless it actually changed.
   ═══════════════════════════════════════════════════════════════════ */
(function boot(){
'use strict';
const S=window.BWSMC;
if(!S){ if(boot.t===undefined)boot.t=0; if(++boot.t>80){console.error('[SMC] engine missing');return;}
        setTimeout(boot,150); return; }

const $=id=>document.getElementById(id);
const esc=x=>String(x==null?'':x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const setHTML=(el,html)=>{ if(el&&el.innerHTML!==html) el.innerHTML=html; };
const setTxt=(el,t)=>{ if(el&&el.textContent!==t) el.textContent=t; };

let activeTF='H1', activePair=null, zoneFilter='live', view=null;

/* ── OPENING ANOTHER MODULE ─────────────────────────────────────
   This panel runs inside the dashboard's iframe, so it ASKS the shell
   to switch rather than navigating itself — replacing the iframe's
   location would leave the shell's sidebar pointing at the wrong
   module, and window.top would reload the whole dashboard.
   The shell needs one listener:
     window.addEventListener('message', e => {
       if (e.data && e.data.bw === 'open') openModule(e.data.module, e.data.view);
     });
   Until that exists, the fallback still gets the user there. */
function openModule(module,viewName){
  const msg={bw:'open',module,view:viewName||null,pair:activePair,timeframe:activeTF};
  let asked=false;
  try{ if(window.parent&&window.parent!==window){ window.parent.postMessage(msg,'*'); asked=true; } }catch(e){}
  if(!asked){
    const path={assistant:'/',brain:'/brain'}[module]||'/';
    const q='?pair='+encodeURIComponent(activePair||'')+(viewName?'&view='+viewName:'');
    try{ window.top.location.href=path+q; }catch(e){ window.location.href=path+q; }
  }
}
window.openModule=openModule;

/* ── controls ───────────────────────────────────────────────────── */
window.setTF=function(tf,el){
  if(tf===activeTF) return;
  activeTF=tf;
  el.parentNode.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b===el));
  render();
};
window.setZoneFilter=function(f,el){
  zoneFilter=f;
  el.parentNode.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b===el));
  renderZones();
};
window.pickPair=function(p){
  activePair=p;
  document.querySelectorAll('.pair').forEach(b=>b.classList.toggle('on',b.dataset.s===p));
  render();
};
window.showZone=function(){};

/* ── pair strip ─────────────────────────────────────────────────── */
function pairState(v){
  if(!v.zones.length) return 'var(--border2)';
  const live=v.zones.filter(z=>!z.spent);
  if(!live.length) return 'var(--border2)';
  const near=Math.min(...live.map(z=>S.pipsAway(z,v.price,v.bare)));
  return near===0?'var(--green)':near<=25?'var(--gold-lt)':'var(--border2)';
}
function renderPairs(){
  const list=S.pairs();
  if(!list.length){ setHTML($('pairs'),'<span class="empty" style="padding:4px 2px">Waiting for the SMC feed…</span>'); return; }
  if(!activePair||list.indexOf(activePair)<0) activePair=list[0];
  const html=list.map(p=>{
    const v=S.build(p);
    return '<button class="pair'+(p===activePair?' on':'')+'" data-s="'+p+'" onclick="pickPair(\''+p+'\')">'+
      '<i class="pdot" style="background:'+pairState(v)+'"></i>'+esc(S.label(p))+'</button>';
  }).join('');
  setHTML($('pairs'),html);
}

/* ── the ladder ─────────────────────────────────────────────────── */
function tfZones(v){ return v.zones.filter(z=>z.tf===activeTF); }
function renderLadder(v){
  const z=tfZones(v), d=v.digits;
  if(!z.length||!isFinite(v.price)){
    setHTML($('ladder'),'<div class="empty" style="padding:20px">'+
      (isFinite(v.price)?('No '+activeTF+' zones on '+esc(v.label)+' right now. Switch timeframe, or watch for the next block to form.')
        :'Waiting for a price on this pair.')+'</div>');
    setTxt($('mapRange'),''); return;
  }
  const lo=Math.min(v.price,...z.map(x=>x.lo)), hi=Math.max(v.price,...z.map(x=>x.hi));
  const pad=(hi-lo)*0.12||v.price*0.001;
  const top=hi+pad, bot=lo-pad, span=top-bot;
  const y=q=>((top-q)/span)*100;
  let h='<div class="axis"></div>';
  for(let i=0;i<=4;i++){
    h+='<span style="top:'+(i*25)+'%;position:absolute;right:calc(100% - 66px);font-size:9px;'+
       'color:var(--muted);font-family:\'IBM Plex Mono\',monospace;transform:translateY(-50%)">'+
       S.fmt(top-(span*i/4),d)+'</span>';
  }
  z.slice().sort((a,b)=>b.hi-a.hi).forEach(x=>{
    const t=y(x.hi), hgt=Math.max(y(x.lo)-y(x.hi),3.2);
    const cf=x.spent?null:S.confluenceOf(x,v.zones);
    const cls=x.spent?'spent':x.kind==='fvg'?'fvg':(x.dir==='bull'?'bull':'bear');
    const nm=(x.kind==='ob'?(x.dir==='bull'?'Demand':'Supply'):'Gap')+' · '+x.tf+(cf?' ✦':'');
    const away=S.pipsAway(x,v.price,v.bare);
    const st=x.spent?'spent':away===0?'price inside':away.toFixed(1)+' pips';
    h+='<div class="zone '+cls+(cf?' conf':'')+'" style="top:'+t+'%;height:'+hgt+'%" '+
       'title="'+esc(nm+' '+S.fmt(x.lo,d)+'–'+S.fmt(x.hi,d))+(cf?' — confluence with '+cf.tf:'')+'" '+
       'onclick="showZone()">'+esc(nm)+'<span class="zt">'+st+'</span></div>';
  });
  h+='<div class="price-line" style="top:'+y(v.price)+'%" data-p="'+S.fmt(v.price,d)+'"></div>';
  setHTML($('ladder'),h);
  setTxt($('mapRange'),S.fmt(bot,d)+' – '+S.fmt(top,d));
}

/* ── zone list ──────────────────────────────────────────────────── */
function renderZones(){
  const v=S.build(activePair||''), d=v.digits;
  let z=tfZones(v).slice();
  if(zoneFilter==='live') z=z.filter(x=>!x.spent);
  if(zoneFilter==='ob')   z=z.filter(x=>x.kind==='ob');
  if(zoneFilter==='fvg')  z=z.filter(x=>x.kind==='fvg');
  z.sort((a,b)=>S.pipsAway(a,v.price,v.bare)-S.pipsAway(b,v.price,v.bare));

  const html = z.length ? z.map(x=>{
    const away=S.pipsAway(x,v.price,v.bare), inside=away===0;
    const cf=x.spent?null:S.confluenceOf(x,v.zones);
    const kind=x.kind==='ob'?(x.dir==='bull'?'Demand block':'Supply block')
                            :(x.dir==='bull'?'Bullish gap':'Bearish gap');
    const age=x.ageMs?(x.ageMs<3600000?Math.round(x.ageMs/60000)+'m'
      :x.ageMs<86400000?Math.round(x.ageMs/3600000)+'h':Math.round(x.ageMs/86400000)+'d'):null;
    return '<div class="row"><div style="flex:1">'+
      '<div class="row-t">'+kind+
        ' <span class="tag t-tf">'+x.tf+'</span>'+
        ' <span class="tag '+(x.dir==='bull'?'t-bull':'t-bear')+'">'+x.dir+'</span>'+
        (cf?' <span class="tag t-conf">H1 + H4</span>':'')+
        (x.spent?' <span class="tag t-mute">spent</span>':inside?' <span class="tag t-gold">price inside</span>':'')+
      '</div>'+
      '<div class="row-s">'+S.fmt(x.lo,d)+' – '+S.fmt(x.hi,d)+
        (age?' · formed '+age+' ago':'')+
        (x.spent&&x.spentWhy?' · '+esc(x.spentWhy):'')+
        ' · strength '+x.strength+'/100</div>'+
      (cf?'<div class="conf-note">Sits inside the '+cf.tf+' '+(cf.dir==='bull'?'demand':'supply')+
          ' zone '+S.fmt(cf.lo,d)+' – '+S.fmt(cf.hi,d)+'. Both timeframes want the same thing here.</div>':'')+
      '<div class="meter"><i style="width:'+x.strength+'%;background:'+
        (x.spent?'var(--border2)':x.dir==='bull'?'var(--green)':'var(--red)')+'"></i></div>'+
      '</div>'+
      '<div class="dist'+(inside?' gd':'')+'">'+(inside?'here':isFinite(away)?away.toFixed(1):'—')+
      '<small>'+(inside?'in the zone':'pips away')+'</small></div></div>';
  }).join('') : '<div class="empty">No zones match this filter on '+activeTF+'.</div>';
  setHTML($('zoneList'),html);
  setTxt($('cZones'),String(tfZones(v).filter(x=>!x.spent).length));
}

/* ── structure ──────────────────────────────────────────────────── */
function renderStructure(v){
  const s=v.structure[activeTF]||[], d=v.digits;
  const html = s.length ? s.slice(0,12).map(x=>{
    const t=S.bwDate(x.at), ago=isNaN(+t)?'':timeAgo(t);
    return '<div class="row"><div style="flex:1">'+
      '<div class="row-t">'+(x.kind==='BOS'?'Break of structure':x.kind==='CHoCH'?'Change of character':esc(x.kind))+
      ' <span class="tag t-tf">'+activeTF+'</span>'+
      ' <span class="tag '+(x.dir==='bull'?'t-bull':'t-bear')+'">'+x.dir+'</span></div>'+
      '<div class="row-s">'+(x.kind==='BOS'
        ?'Broke the prior swing and held past it'
        :'First break against the run — the earliest warning the move is done')+
      ' · level '+S.fmt(x.level,d)+'</div></div>'+
      '<div class="dist mut" style="font-weight:500">'+ago+'</div></div>';
  }).join('') : '<div class="empty">No '+activeTF+' structure events yet.</div>';
  setHTML($('structList'),html);
  setTxt($('cStruct'),String(s.length));

  const last=s[0];
  const bos=s.filter(x=>x.kind==='BOS').length, ch=s.filter(x=>x.kind==='CHoCH').length;
  setHTML($('biasBox'),
    '<div class="kv"><span>Most recent event</span><b class="'+(last?(last.dir==='bull'?'up':'dn'):'mut')+'">'+
      (last?last.kind+' '+last.dir:'—')+'</b></div>'+
    '<div class="kv"><span>Breaks vs reversals</span><b class="n">'+bos+' BOS · '+ch+' CHoCH</b></div>'+
    '<div class="kv"><span>Reading</span><b class="'+(!s.length?'mut':ch?'gd':'up')+'">'+
      (!s.length?'Nothing to read yet':ch?'Trend intact but warned':'Trend intact')+'</b></div>');
  setTxt($('structVal'), last?last.kind+' '+last.dir:'—');
  setTxt($('structNote'), last?('level '+S.fmt(last.level,d)):'No structure on this timeframe');
  setTxt($('rStruct'), last?last.kind+' '+last.dir:'—');
}
function timeAgo(t){
  const ms=Date.now()-t.getTime();
  if(ms<0) return 'just now';
  if(ms<3600000) return Math.round(ms/60000)+'m ago';
  if(ms<86400000) return Math.round(ms/3600000)+'h ago';
  return Math.round(ms/86400000)+'d ago';
}

/* ── alerts + sweep ─────────────────────────────────────────────── */
function renderAlerts(v){
  const d=v.digits;
  const a=S.alertsFor(v.bare).slice(0,6);
  const html = a.length ? a.map(x=>{
    const bull=String(x.direction||'').toLowerCase().indexOf('bull')>=0;
    const t=S.bwDate(x.time);
    return '<div class="banner '+(bull?'bull':'bear')+'" style="margin-bottom:11px"><div style="flex:1">'+
      '<div class="b-t '+(bull?'up':'dn')+'">'+(bull?'Bullish':'Bearish')+' confluence — '+
        esc(x.confidence)+'% confidence</div>'+
      '<div class="b-s">'+esc(x.pattern||'Pattern')+' on '+esc(x.timeframe||'')+
        ' aligns with the order block at '+S.fmt(x.ob&&x.ob.low,d)+' – '+S.fmt(x.ob&&x.ob.high,d)+
        '. Pattern, zone and gap point the same way.</div>'+
      '<div class="row-s" style="margin-top:6px">'+(isNaN(+t)?'':t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))+
        ' · '+esc(x.timeframe||'')+'</div></div></div>';
  }).join('') : '<div class="empty">No confluence detected on '+esc(v.label)+' right now.</div>';
  setHTML($('alertList'),html);
  setTxt($('cAlerts'),String(a.length));

  const sw=S.sweepFor(tfZones(v), v.price, v.bare);
  const L=S.sweepLabel(sw);
  const cls=L.cls==='up'?'bull':L.cls==='dn'?'bear':L.cls==='bl'?'info':L.cls==='gd'?'warn':'info';
  setHTML($('sweepList'),
    '<div class="banner '+cls+'"><div style="flex:1">'+
    '<div class="b-t '+L.cls+'">'+L.text+'</div>'+
    '<div class="b-s">'+esc(L.note)+'</div></div></div>');
}

/* ── all pairs ──────────────────────────────────────────────────── */
function renderGrid(){
  const html=S.pairs().map(p=>{
    const v=S.build(p);
    const live=v.zones.filter(z=>!z.spent && z.tf===activeTF);
    const near=live.length?Math.min(...live.map(z=>S.pipsAway(z,v.price,v.bare))):Infinity;
    const col=near===0?'var(--green)':near<=25?'var(--gold-lt)':'var(--border2)';
    return '<div class="gcard" onclick="pickPair(\''+p+'\')">'+
      '<div class="gname"><i class="pdot" style="background:'+col+'"></i>'+esc(v.label)+'</div>'+
      '<div class="gpx">'+S.fmt(v.price,v.digits)+'</div>'+
      '<div class="meter" style="margin:9px 0 7px"><i style="width:'+
        (isFinite(near)?Math.max(6,100-Math.min(near,50)*2):4)+'%;background:'+col+'"></i></div>'+
      '<div class="mini"><span>Live zones</span><b class="n">'+live.length+'</b></div>'+
      '<div class="mini"><span>Nearest</span><b class="n">'+
        (near===0?'in a zone':isFinite(near)?near.toFixed(1)+' pips':'—')+'</b></div></div>';
  }).join('');
  setHTML($('grid'),html||'<div class="empty">No pairs in the SMC feed yet.</div>');
}

/* ── rail, summaries and the conditional banner ─────────────────── */
function renderRail(v){
  const d=v.digits;
  const live=tfZones(v).filter(z=>!z.spent);
  const near=live.map(z=>({z,a:S.pipsAway(z,v.price,v.bare)})).sort((a,b)=>a.a-b.a)[0];

  setTxt($('hPx'),S.fmt(v.price,d));
  setTxt($('rPx'),S.fmt(v.price,d));
  setTxt($('rZones'),String(live.length));
  setTxt($('rNear'),near?(near.a===0?'in a zone':near.a.toFixed(1)+' pips'):'—');
  const cf=live.filter(z=>S.confluenceOf(z,v.zones)).length;
  const rc=$('rConf'); if(rc){ setTxt(rc,cf?String(cf):'none'); rc.className=cf?'gd':'mut'; }
  const age=v.receivedAt?S.bwDate(v.receivedAt):null;
  setTxt($('rAge'), age&&!isNaN(+age)?Math.max(0,Math.round((Date.now()-age.getTime())/1000))+'s':'—');

  const hd=$('hDelta'); if(hd){ setTxt(hd,''); hd.className='hdelta n'; }

  if(near){
    const ncf=S.confluenceOf(near.z,v.zones);
    setHTML($('nearName'),(near.z.kind==='ob'?(near.z.dir==='bull'?'Demand':'Supply'):'Gap')+
      (ncf?' <span class="tag t-conf" style="vertical-align:middle">H1 + H4</span>':''));
    setTxt($('nearDist'),(near.a===0?'Price is inside it':near.a.toFixed(1)+' pips away')+
      ' · '+near.z.tf+(ncf?' · backed by '+ncf.tf:''));
    const nb=$('nearBar'); if(nb) nb.style.width=Math.max(5,100-Math.min(near.a,40)*2.5)+'%';
  }else{
    setHTML($('nearName'),'—'); setTxt($('nearDist'),'No live zone on '+activeTF);
    const nb=$('nearBar'); if(nb) nb.style.width='0%';
  }

  const bull=live.filter(z=>z.dir==='bull').length, bear=live.filter(z=>z.dir==='bear').length;
  setTxt($('balVal'),bull+' demand · '+bear+' supply');
  const bb=$('balBar'); if(bb) bb.style.width=((bull+bear)?bull/(bull+bear)*100:50)+'%';
  setTxt($('balNote'), bull>bear?'More demand below than supply above'
    :bear>bull?'More supply above than demand below'
    :(bull+bear)?'Evenly balanced':'No live zones to weigh');

  /* cross-module — pair-specific, read-only, honest about gaps */
  const x=S.crossFor(v.bare);
  const rows=[];
  if(x.risk){
    const rl=String(x.risk.level||'').toLowerCase();
    const col=rl.indexOf('stand')>=0?'dn':rl.indexOf('elev')>=0?'gd':rl.indexOf('caut')>=0?'bl':'up';
    rows.push(['assistant','risk','Risk Radar',esc(v.label)+' · last flagged '+timeAgo(new Date(x.risk.t)),
      col, esc(x.risk.level)+' · '+x.risk.score]);
  }else{
    rows.push(['assistant','risk','Risk Radar',esc(v.label)+' · Assistant','mut','no flag recorded']);
  }
  if(x.verdict){
    const c=String(x.verdict.call||'').toUpperCase();
    rows.push(['brain',null,'Brain verdict',esc(v.label)+' · '+esc(x.verdict.tf||'')+' · '+esc(x.verdict.when||''),
      c==='BULLISH'?'up':c==='BEARISH'?'dn':'mut',
      esc(x.verdict.call)+(x.verdict.conf?' · '+esc(x.verdict.conf):'')]);
  }else{
    rows.push(['brain',null,'Brain verdict',esc(v.label)+' · not analysed yet','mut','—']);
  }
  if(x.news){
    const inTxt=x.news.mins>=60?Math.floor(x.news.mins/60)+'h '+(x.news.mins%60)+'m':x.news.mins+'m';
    rows.push(['assistant','news','Next release',esc(x.news.title)+' · '+esc(x.news.ccy),
      x.news.mins<60?'dn':'',inTxt]);
  }else{
    rows.push(['assistant','news','Next release','Nothing high-impact ahead','mut','—']);
  }
  setHTML($('crossList'),rows.map(r=>
    '<button class="xrow" onclick="openModule(\''+r[0]+'\''+(r[1]?',\''+r[1]+'\'':'')+')">'+
    '<span>'+r[2]+'<small>'+r[3]+'</small></span>'+
    '<b class="'+r[4]+'">'+r[5]+'</b><i class="chev"></i></button>').join(''));

  /* The banner fires ONLY when a live zone is in reach AND this pair is
     actually flagged. No zone nearby, or nothing flagged, and it stays
     away — a warning that is always on screen is furniture. */
  const b=$('topBanner');
  const inReach = near && near.a<=25;
  const risky = x.risk && x.risk.score>=50;
  if(inReach && risky){
    const stand=x.risk.score>=75;
    setHTML(b,'<div class="banner '+(stand?'bear':'warn')+'"><div style="flex:1">'+
      '<div class="b-t '+(stand?'dn':'gd')+'">'+(stand?'Stand down — do not take this zone yet':'Zone is valid, the timing is not')+'</div>'+
      '<div class="b-s">Price is '+(near.a===0?'inside':near.a.toFixed(1)+' pips from')+' a '+
        (near.z.dir==='bull'?'demand':'supply')+' zone on '+near.z.tf+
        ', and the Assistant last flagged '+esc(v.label)+' at <b>'+esc(x.risk.level)+' ('+x.risk.score+')</b>'+
        (x.news?' with '+esc(x.news.title)+' in '+(x.news.mins<60?x.news.mins+'m':Math.floor(x.news.mins/60)+'h')+'':'')+
        '. The level is real; this is the wrong moment to act on it.</div>'+
      '<div style="margin-top:8px;display:flex;gap:7px;flex-wrap:wrap">'+
        '<button class="xbtn" onclick="openModule(\'assistant\',\'risk\')">Open Risk Radar</button>'+
        '<button class="xbtn" onclick="openModule(\'brain\')">Ask the Brain</button></div>'+
      '</div></div>');
  }else if(inReach){
    setHTML(b,'<div class="banner bull"><div style="flex:1">'+
      '<div class="b-t up">Zone in reach, nothing flagged against it</div>'+
      '<div class="b-s">Price is '+(near.a===0?'inside':near.a.toFixed(1)+' pips from')+' a '+
        (near.z.dir==='bull'?'demand':'supply')+' zone on '+near.z.tf+
        '. No risk flag is recorded for '+esc(v.label)+'.</div></div></div>');
  }else{
    setHTML(b,'');
  }
}

/* ── render all ─────────────────────────────────────────────────── */
function render(){
  renderPairs();
  if(!activePair) return;
  const v=S.build(activePair);
  renderLadder(v); renderZones(); renderStructure(v); renderAlerts(v); renderGrid(); renderRail(v);
  const t=new Date();
  setTxt($('upd'),'Updated '+t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}));
  const dot=$('liveDot');
  if(dot){ const ok=S.ok.H1!==false||S.ok.H4!==false;
    dot.style.background=ok?'var(--green)':'var(--red)';
    dot.className='dot'+(ok?' live':''); }
  const lbl=$('liveLbl'); if(lbl) setTxt(lbl, (S.ok.H1===false&&S.ok.H4===false)?'Feed down':'Live');
}

/* ── nav ────────────────────────────────────────────────────────── */
function moveInk(t){
  const n=$('nav'), ink=$('ink');
  if(!n||!ink||!t||!t.offsetWidth) return;
  ink.style.left=(t.offsetLeft-n.scrollLeft+13)+'px';
  ink.style.width=(t.offsetWidth-26)+'px';
}
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
  t.classList.add('on');
  const ic=t.querySelector('.ico');
  if(ic){ ic.classList.remove('go'); void ic.offsetWidth; ic.classList.add('go'); }
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('on'));
  const pg=$('p-'+t.dataset.p); if(pg) pg.classList.add('on');
  view=t.dataset.p;
  moveInk(t);
});
$('nav')&&$('nav').addEventListener('scroll',()=>moveInk(document.querySelector('.tab.on')),{passive:true});
window.addEventListener('resize',()=>moveInk(document.querySelector('.tab.on')));
[60,400,1200].forEach(ms=>setTimeout(()=>moveInk(document.querySelector('.tab.on')),ms));

/* ── poll — same 5s cadence as the original panel ───────────────── */
function cycle(){ S.refresh().then(render).catch(()=>{}); }
cycle();
setInterval(cycle,5000);
window.BWSMCUI={render,cycle,openModule};
})();
