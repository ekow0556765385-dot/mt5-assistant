/* pd-liquidity.js — GENERATED from patterns.html by build-host.js. Do not edit by hand. */
(function(){
function bwBarMs(c){
  const v=c&&(c.t!=null?c.t:(c.time!=null?c.time:c.timestamp));
  if(v==null||v==='') return NaN;
  if(typeof v==='number'||/^\d+(\.\d+)?$/.test(String(v))){ const n=+v; return n<1e12?n*1000:n; }
  const d=(typeof bwDate==='function')?bwDate(v):new Date(v);
  return +d;
}
function bwBarHourUTC(c){ const t=bwBarMs(c); return isFinite(t)&&t?new Date(t).getUTCHours():null; }
const LIQ_TF_MIN={M15:15,M30:30,H1:60,H4:240};
function liqHourOf(c){ return bwBarHourUTC(c); }
const liqV=c=>+(c.v!=null?c.v:c.volume!=null?c.volume:c.tick_volume!=null?c.tick_volume:
               c.tickVolume!=null?c.tickVolume:c.tv!=null?c.tv:c.real_volume)||0;
const liqH=c=>+(c.h!=null?c.h:c.high), liqL=c=>+(c.l!=null?c.l:c.low);
const liqO=c=>+(c.o!=null?c.o:c.open),  liqC=c=>+(c.c!=null?c.c:c.close);
const liqMed=a=>{ if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
const liqAvg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const liqClamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function liqSlot(c,tf){
  const hr=liqHourOf(c); if(hr===null) return null;
  return (LIQ_TF_MIN[tf]||60)>=240 ? Math.floor(hr/4)*4 : hr;
}
function liqBaseline(cd,tf){
  const slots={};
  for(const c of cd){
    const k=liqSlot(c,tf); if(k===null) continue;
    const v=liqV(c); if(!v) continue;
    (slots[k]=slots[k]||[]).push(v);
  }
  const out={}, n={}; let minN=Infinity, withVol=0;
  for(const k in slots){ out[k]=liqMed(slots[k]); n[k]=slots[k].length; withVol+=slots[k].length; minN=Math.min(minN,slots[k].length); }
  return {slots:out, n, perSlot:isFinite(minN)?minN:0, count:Object.keys(slots).length, withVol, bars:cd.length};
}
function liqBaseFor(BL,c,tf){ const k=liqSlot(c,tf); return (BL&&k!==null&&BL.slots[k])||null; }
function liqAtr(cd,n){
  const s=cd.slice(-n-1); let sum=0,k=0;
  for(let i=1;i<s.length;i++){
    sum+=Math.max(liqH(s[i])-liqL(s[i]),Math.abs(liqH(s[i])-liqC(s[i-1])),Math.abs(liqL(s[i])-liqC(s[i-1]))); k++;
  }
  return k?sum/k:0;
}
const BW_SESS=[{n:'Sydney',a:21,b:6},{n:'Tokyo',a:0,b:9},
               {n:'London',a:7,b:16},{n:'New York',a:12,b:21}];
function bwSessionsOpen(h){
  return BW_SESS.filter(x=> x.a<x.b ? (h>=x.a&&h<x.b) : (h>=x.a||h<x.b));
}
function liqSession(){
  const d=new Date();
  const h=d.getUTCHours()+d.getUTCMinutes()/60;
  const open=bwSessionsOpen(h);
  const has=n=>open.some(x=>x.n===n);
  const londonNY=has('London')&&has('New York');
  if(!open.length) return {name:'Between sessions',deep:false,open:[]};
  return {name: londonNY?'London / New York overlap':open.map(x=>x.n).join(' · '),
          deep: londonNY||open.length>=2||has('London')||has('New York'),
          open: open.map(x=>x.n)};
}
function liqRead(cd,tf){
  if(!cd||cd.length<20) return null;
  /* CLOSED CANDLES ONLY (Nov 2026). The feed's last candle is the one still forming. Every row here
     used to include it, so "Being swept" and "Swept inside the bar" could be read off a candle that
     was minutes old (a young candle is nearly all wick) and gone by the close. Now every reading is
     made on candles that have closed, as the rest of Blackwood decides. */
  /* ONE HISTORY FOR EVERY PAGE (Nov 2026). 'Normal volume' is the median of the same hour on earlier days,
     so it changed with how much history a page happened to hold: the Assistant keeps merging bars while
     it is open, the Pattern Detector and the Arbiter get the server's 300. Same engine, different answers
     (Healthy here, Being swept there). Every copy now reads only the last 299 closed candles. */
  cd = cd.slice(0, -1).slice(-299);
  const liqTimeOf=c=>{ const v=c&&(c.time!=null?c.time:c.t); if(v==null) return null; const ms=(typeof v==='number'?v:Date.parse(v)); return ms<1e12?ms*1000:ms; };
  const liqWhen=c=>{ const ms=liqTimeOf(c); if(!ms||!isFinite(ms)) return '?'; const d=new Date(ms).toISOString(); return d.slice(8,10)+'/'+d.slice(5,7)+' '+d.slice(11,16); };
  const liqPx=v=>(+v).toFixed(v>=1000?2:v>=50?3:5);
  const BL=liqBaseline(cd,tf);
  /* Synced with the Assistant's fixed engine: only the hours being read
     need history, not all twenty-four. The old rule waited for EVERY hour
     to have three bars, so the reading sat on "Learning". */
  const noVolume = !!(BL && BL.withVol===0 && cd.length>=20);
  const usedSlots = cd.slice(-4).map(c=>liqSlot(c,tf)).filter(k=>k!==null);
  const weak = !BL || noVolume || !usedSlots.length || usedSlots.some(k=>(BL.n[k]||0)<3);
  const last=cd[cd.length-1];
  const hr=liqHourOf(last);
  if(hr===null) return null;
  const sess=liqSession();
  const recent=cd.slice(-4);

  const nowV=liqAvg(recent.map(liqV));
  const bases=recent.map(c=>liqBaseFor(BL,c,tf)).filter(Boolean);
  const baseV=bases.length?liqAvg(bases):null;
  const ratio=(baseV&&!weak)?nowV/baseV:1;

  const F=[];
  F.push({name:'Participation vs this slot',
    detail: weak ? 'not enough history yet to know what is normal here'
      : (ratio*100).toFixed(0)+'% of what this '+((LIQ_TF_MIN[tf]||60)>=240?'4-hour block':'hour')+
        ' normally does — '+(ratio<0.45?'far below':ratio<0.75?'below':ratio>1.4?'well above':'about normal'),
    pts: weak?0:Math.round(liqClamp((ratio-1)*45,-30,30))});

  const aNow=liqAtr(cd,4), aRef=liqAtr(cd.slice(0,-4),14);
  const rangeR=aRef?aNow/aRef:1;
  F.push({name:'Candle size',
    detail:(rangeR*100).toFixed(0)+'% of recent average range — '+
      (rangeR<0.55?'candles have shrunk sharply':rangeR<0.8?'candles are smaller':rangeR>1.5?'candles are expanding':'normal'),
    pts:Math.round(liqClamp((rangeR-1)*30,-20,20))});

  const emptyBook=!weak&&ratio<0.6&&rangeR<0.75&&sess.deep;
  F.push({name:'Book depth for this session',
    detail: emptyBook ? 'thin and still during '+sess.name+' — the hours when it should be busiest'
      : sess.deep ? 'normal for '+sess.name : sess.name+' is naturally quieter',
    pts: emptyBook?-26:0});

  let wickShare=0;
  for(const c of recent){ const r=liqH(c)-liqL(c);
    if(r>0) wickShare+=(r-Math.abs(liqC(c)-liqO(c)))/r; }
  wickShare/=recent.length;
  F.push({name:'Wick to body',
    detail:(wickShare*100).toFixed(0)+'% of the candle is wick — '+
      (wickShare>0.72?'price is being pushed and rejected, not traded through'
       :wickShare>0.55?'plenty of rejection':'bodies are doing the work'),
    pts:Math.round(liqClamp((0.5-wickShare)*40,-20,14))});

  /* INTRA-CANDLE SWEEP — H1 and above only.
     On a higher timeframe the whole manipulation fits inside one bar.
     On M15 a sweep spans several bars and normal noise routinely
     produces small bodies with wicks both sides, so running it there
     produces false alarms in healthy conditions. */
  const rng0=liqH(last)-liqL(last), body0=Math.abs(liqC(last)-liqO(last));
  const bodyShare=rng0>0?body0/rng0:1;
  const upW=rng0>0?(liqH(last)-Math.max(liqO(last),liqC(last)))/rng0:0;
  const dnW=rng0>0?(Math.min(liqO(last),liqC(last))-liqL(last))/rng0:0;
  const bothSides=Math.min(upW,dnW)>0.22;
  const medRange=liqMed(cd.slice(-21,-1).map(c=>liqH(c)-liqL(c)).filter(x=>x>0));
  const rangeMult=medRange>0?rng0/medRange:1;
  const canChurn=(LIQ_TF_MIN[tf]||60)>=60;
  const churned=canChurn&&!weak&&rangeMult>=1.8&&bodyShare<0.35&&bothSides&&ratio>=0.9;
  F.push({name:'Movement inside this candle',
    detail: !canChurn ? 'a sweep on '+tf+' spans several candles, so there is nothing hidden inside one'
      : weak ? 'needs a baseline first'
      : churned ? 'swept inside this bar — '+rangeMult.toFixed(1)+'x the usual range but only '+
          (bodyShare*100).toFixed(0)+'% of it kept, rejected on both sides'
      : bothSides ? 'wicks both sides but the range is ordinary'
      : (bodyShare*100).toFixed(0)+'% of the range is body — one direction, not churn',
    pts:(!canChurn||weak)?0:(churned?-22:(bodyShare>0.6?8:0))});

  const net=Math.abs(liqC(last)-liqC(cd[cd.length-6]||cd[0]));
  const path=cd.slice(-6).reduce((a,c)=>a+(liqH(c)-liqL(c)),0);
  const eff=path?net/path:0;
  F.push({name:'Progress for the activity',
    detail:(eff*100).toFixed(0)+'% of the ground covered was kept — '+
      (eff<0.15&&ratio>1.2?'heavy activity going nowhere':eff<0.2?'churning':'price is travelling'),
    pts:(eff<0.15&&ratio>1.2)?-18:(eff>0.35?10:0)});

  const score=Math.round(liqClamp(50+F.reduce((a,f)=>a+f.pts,0),2,98));

  /* the swing the sweep is measured against: a high with two lower highs either side (or the reverse), the
     most recent one no candle has traded beyond since — resting stops you can see on the chart */
  function liqSwing(k, side){
    for(let i=k-3;i>=Math.max(2,k-40);i--){
      const v = side>0 ? liqH(cd[i]) : liqL(cd[i]);
      let piv = true;
      for(let j=1;j<=2&&piv;j++){ const a=side>0?liqH(cd[i-j]):liqL(cd[i-j]), b=side>0?liqH(cd[i+j]):liqL(cd[i+j]);
        if(side>0 ? !(v>a&&v>b) : !(v<a&&v<b)) piv=false; }
      if(!piv) continue;
      for(let j=i+1;j<k;j++){ if(side>0 ? liqH(cd[j])>v : liqL(cd[j])<v) return null; }
      return {i, level:v};
    }
    return null;
  }
  let sweep=null;
  if(!weak){
    for(let k=cd.length-1;k>=Math.max(5,cd.length-2)&&!sweep;k--){         /* the last two closed candles */
      const c=cd[k];
      for(const side of [1,-1]){
        const s=liqSwing(k, side); if(!s) continue;
        if(side>0 ? (liqH(c)>s.level && liqC(c)<s.level) : (liqL(c)<s.level && liqC(c)>s.level)){
          const b=liqBaseFor(BL,c,tf);
          sweep={k, side, level:s.level, si:s.i, volR: b ? liqV(c)/b : 0}; break;
        }
      }
    }
  }

  let state,cls,plain;
  if(noVolume){
    state='No volume data'; cls='learn';
    plain='The candles for '+tf+' are arriving without any volume figure, so participation cannot be measured at all. '+
      'This is a feed problem, not something more history will fix \u2014 check that the EA is sending tick volume with its candles.';
  } else if(weak){
    state='Learning'; cls='learn';
    plain='Not enough history on '+tf+' yet to know what normal participation looks like at this '+
      'time of day. The reading is withheld rather than guessed — it needs a few bars in each slot first.';
  } else if(churned){
    state='Swept inside the bar'; cls='man';
    plain='The candle that opened '+liqWhen(last)+' (server time) covered '+rangeMult.toFixed(1)+'x the usual range and kept only '+
      (bodyShare*100).toFixed(0)+'% of it, with rejection on both sides. Price was pushed up and down '+
      'inside this single bar rather than trending through it. Drop to a lower timeframe to see the order.';
  } else if(ratio<0.4&&sess.deep){
    state='Liquidity drought'; cls='drought';
    plain='Participation is at '+(ratio*100).toFixed(0)+'% of normal for '+sess.name+'. In a book this '+
      'thin a small order moves price further than it should, and stops resting at obvious levels are '+
      'cheap to reach.';
  } else if(ratio<0.7){
    state='Thin'; cls='thin';
    plain='Fewer participants than this hour usually has. Moves can overshoot and reverse without '+
      'anything meaningful having happened.';
  } else if(sweep && sweep.volR>=1.1){
    /* A REAL SWEEP (Nov 2026): a closed candle wicked through a swing high or low and closed back
       inside, on above-normal volume for its hour. It used to be "most of the last 4 candles is wick
       and volume is up" with no level at all, while the words claimed price was pushed into one. */
    state='Being swept'; cls='man';
    plain='The candle that opened '+liqWhen(cd[sweep.k])+' (server time) wicked '+(sweep.side>0?'above':'below')+' the swing '+
      (sweep.side>0?'high':'low')+' at '+liqPx(sweep.level)+' (from the '+liqWhen(cd[sweep.si])+' candle) and closed back '+
      (sweep.side>0?'below':'above')+' it, on '+(sweep.volR*100).toFixed(0)+'% of the normal volume for that hour. '+
      'Stops beyond that swing were likely taken.';
  } else if(wickShare>0.72&&ratio>1.1){
    /* the old condition, under its honest name: lots of wick and activity, but no swing was taken */
    state='Choppy'; cls='chop';
    plain='Heavy activity, but most of the last few candles is wick: price is going back and forth rather than '+
      'being traded through. No swing high or low was swept, so this is chop, not a sweep.';
  } else {
    state='Healthy'; cls='healthy';
    plain='Participation is in line with what this hour normally sees.';
  }

  let phase,pConf,pText;
  const win=cd.slice(-14);
  const hi=Math.max(...win.map(liqH)), lo=Math.min(...win.map(liqL));
  const boxed=aRef?(hi-lo)/aRef<4.2:false;
  if(weak){ phase='—'; pConf='no read'; pText='Waiting on baseline history.'; }
  else if(churned){ phase='Manipulation'; pConf='within this candle';
    pText='The sweep is inside this bar rather than across several. On '+tf+' that is the usual shape.'; }
  else if(boxed&&ratio<0.75){ phase='Accumulation'; pConf='likely';
    pText='Price held in a tight band on below-normal participation. Ranges built like this are often '+
      'where positions are filled quietly — but a quiet range is also just a quiet range, and only what '+
      'follows will tell you which.'; }
  else if(ratio>1.3&&eff<0.18){ phase='Distribution'; pConf='likely';
    pText='Activity well above normal but price making no ground.'; }
  else if(eff>0.3&&ratio>0.8){ phase='Trending'; pConf='clear';
    pText='Price is covering ground with participation to match.'; }
  else { phase='Quiet'; pConf='no read'; pText='Nothing distinctive in the participation pattern.'; }

  return {score,state,cls,plain,factors:F,sweep:sweep&&sweep.volR>=1.1?{side:sweep.side,level:sweep.level,at:liqTimeOf(cd[sweep.k]),swingAt:liqTimeOf(cd[sweep.si]),volR:sweep.volR}:null,ratio,sess,phase,pConf,pText,
          weak,noVolume,samples:BL?Math.min.apply(null,usedSlots.map(k=>BL.n[k]||0).concat([99])):0,nowV,baseV,tf};
}
window.BWLiquidity={liqRead};
})();
