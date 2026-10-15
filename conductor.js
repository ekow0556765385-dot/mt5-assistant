/* conductor.js — GENERATED from patterns.html by build-host.js. Do not edit by hand:
   it is the engine block from the page, copied VERBATIM. */
/* the page helpers it calls, VERBATIM */
function bwDate(v){
  if(v instanceof Date) return v;
  if(v === null || v === undefined || v === '') return new Date(NaN);
  if(typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v); // secs or ms
  var s = String(v).trim();
  if(/^\d+$/.test(s)){ var n = parseInt(s,10); return new Date(n < 1e12 ? n*1000 : n); }
  // 2026.08.09 -> 2026-08-09
  s = s.replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3');
  // "YYYY-MM-DD HH:MM(:SS)" -> "YYYY-MM-DDTHH:MM(:SS)"  (Safari needs the T)
  s = s.replace(/^(\d{4}-\d{2}-\d{2})[ ]+(\d{2}:\d{2})/, '$1T$2');
  var d = new Date(s);
  if(!isNaN(+d)) return d;
  // Last resort: pull the numbers out and build it explicitly.
  var m = s.match(/(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if(m) return new Date(+m[1], +m[2]-1, +m[3], +(m[4]||0), +(m[5]||0), +(m[6]||0));
  return new Date(NaN);
}
function bwBarMs(c){
  const v=c&&(c.t!=null?c.t:(c.time!=null?c.time:c.timestamp));
  if(v==null||v==='') return NaN;
  if(typeof v==='number'||/^\d+(\.\d+)?$/.test(String(v))){ const n=+v; return n<1e12?n*1000:n; }
  const d=(typeof bwDate==='function')?bwDate(v):new Date(v);
  return +d;
}
(function(root){
'use strict';

const C=c=>+(c.c!==undefined?c.c:c.close);
const barKey=c=>{ const v=(typeof bwBarMs==='function')?bwBarMs(c):+(c&&(c.t||c.time)); return String(isFinite(v)?v:0); };   /* text times no longer collapse to one key */

function Conductor(opts){
  opts=opts||{};
  const S=opts.structure||root.BWStructure;
  const X=opts.extremes ||root.BWExtremes;

  /* Memo, keyed by the LAST CLOSED BAR. While that key is unchanged
     nothing structural can have changed, so nothing is recomputed. */
  let memo={key:null, struct:null};
  const stats={slowRuns:0, fastRuns:0, slowMs:0, fastMs:0, skipped:0};
  const listeners=[];

  function now(){ return (typeof performance!=='undefined'&&performance.now)?performance.now():Date.now(); }

  /* ── SLOW PATH — once per bar ──────────────────────────────────── */
  function slow(cd,ctx){
    /* THE KEY MUST INCLUDE THE INSTRUMENT.
       Keyed on the bar timestamp alone, EURUSD and GBPUSD share a key
       whenever their last bar has the same time — which is always. So
       switching pair returned the PREVIOUS pair's structure from the
       memo, and the marks either vanished or described the wrong chart.
       It only looked right after changing timeframe because that changed
       the bar time and forced a recompute. */
    const key=(ctx&&ctx.key?ctx.key:'?')+'|'+barKey(cd[cd.length-1]);
    if(memo.key===key){ stats.skipped++; return memo.struct; }
    const t0=now();
    const st=S.read(cd);
    stats.slowMs+=now()-t0; stats.slowRuns++;
    memo={key, struct:st};
    return st;
  }

  /* ── FAST PATH — every price update ────────────────────────────── */
  function fast(cd,st,ctx){
    const t0=now();
    const lastLow  = (st.marked||[]).filter(m=>m.type==='L').slice(-1)[0];
    const lastHigh = (st.marked||[]).filter(m=>m.type==='H').slice(-1)[0];
    const level = st.dir>0 ? (lastLow&&lastLow.p) : st.dir<0 ? (lastHigh&&lastHigh.p) : null;
    const ex = X.read(cd,{trendDir:st.dir, protectedLevel:level, risk:ctx.risk});

    /* Distance to the trader's own stop, which must be current to the
       price and therefore belongs here, not on the bar clock. */
    let stop=null;
    if(ctx.trade && ctx.trade.sl){
      const px=C(cd[cd.length-1]);
      const dir=ctx.trade.type==='sell'?-1:1;
      stop={ pips:Math.abs(px-ctx.trade.sl)/(ctx.pip||0.0001),
             through: dir>0 ? px<=ctx.trade.sl : px>=ctx.trade.sl };
    }
    stats.fastMs+=now()-t0; stats.fastRuns++;
    return {ex, level, stop};
  }

  /* ── THE ORDER ─────────────────────────────────────────────────
     One decision about who drives, taken here and nowhere else.
     An extreme bar does NOT change the regime — it suspends acting on
     it. That distinction is the whole point: the structure engine keeps
     its reading, and the conductor tells both engines to hold until the
     bar resolves. Neither engine gets to decide that for itself. */
  function order(st, f){
    /* THE CONDUCTOR NO LONGER DECIDES WHO DRIVES. It reports the extreme
       bar and the stop; the governor is the single authority on control.
       `driver` is kept only so older callers do not break, and nothing
       reads it. */
    let driver = st.driver;
    let hold=false, why=st.why;
    if(f.ex && f.ex.ok && f.ex.extreme){
      if(f.ex.verdict==='likely-trap'){
        hold=true; why='an extreme bar with the marks of a trap — hold until it resolves';
      } else if(f.ex.verdict==='undecided'){
        hold=true; why='an extreme bar that cannot be read yet — hold until it resolves';
      } else if(f.ex.verdict==='likely-real' && f.ex.brokeStructure){
        driver='pullback'; why='an extreme bar closed through structure — read it as directional';
      }
    }
    if(f.stop && f.stop.through) hold=false;   // never suppress a stop being hit
    return {driver, hold, why};
  }

  /* ── PUBLIC ────────────────────────────────────────────────────── */
  function update(cd, ctx){
    ctx=ctx||{};
    if(!cd||cd.length<32) return null;
    const st=slow(cd,ctx);
    if(!st||!st.ok) return {ok:false, reason:(st&&st.reason)||'no structure'};
    const f=fast(cd,st,ctx);
    const o=order(st,f);

    /* ONE frozen snapshot. Both engines get this exact object. */
    const snap=Object.freeze({
      ok:true, at:Date.now(), barKey:memo.key,
      regime:st.regime, dir:st.dir, confidence:st.confidence,
      driver:o.driver, hold:o.hold, why:o.why,
      level:f.level, labels:st.lastLabels,
      /* The chart needs the labelled pivots to draw the short lines. */
      pivots:st.marked||[],
      extreme:f.ex&&f.ex.extreme?f.ex:null,
      stop:f.stop, risk:ctx.risk||null,
      cost:{slow:stats.slowMs/Math.max(1,stats.slowRuns),
            fast:stats.fastMs/Math.max(1,stats.fastRuns),
            slowRuns:stats.slowRuns, fastRuns:stats.fastRuns, skipped:stats.skipped}
    });
    /* Synchronous fan-out: both engines read in this frame, not on their
       own next timer. */
    for(let i=0;i<listeners.length;i++){ try{ listeners[i](snap); }catch(e){} }
    return snap;
  }
  function subscribe(fn){ listeners.push(fn); return ()=>{
    const i=listeners.indexOf(fn); if(i>=0) listeners.splice(i,1); }; }

  return {update, subscribe, stats:()=>stats, reset:()=>{memo={key:null,struct:null};}};
}

root.BWConductor={create:Conductor};
})(typeof window!=='undefined'?window:globalThis);
