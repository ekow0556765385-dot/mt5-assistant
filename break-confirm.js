/* break-confirm.js — GENERATED from patterns.html by build-host.js. Do not edit by hand:
   it is the engine block from the page, copied VERBATIM. */
/* the page helpers it calls, VERBATIM */
function digitsOf(p){
  /* READ THE DECIMALS FROM THE PRICES THEMSELVES (Oct 2026). A name rule cannot know
     the broker: Exness quotes gold to 3 decimals, others to 2; indices, crypto and
     suffixed symbols fall outside any list. The most decimals seen across the pair's
     recent candles is what the broker quotes. The name rule is only the fallback. */
  try{
    const S=(typeof SERIES!=='undefined'&&SERIES[p])||null, cd=S&&(S[tf]||S.H1||S.H4);
    if(cd&&cd.length){
      let d=0; const n=Math.min(cd.length,60);
      for(let i=cd.length-n;i<cd.length;i++){ const b=cd[i];
        [b.o,b.h,b.l,b.c,b.open,b.high,b.low,b.close].forEach(v=>{ if(v==null||!isFinite(+v)) return;
          const t=(+v).toFixed(6).replace(/0+$/,''), k=t.indexOf('.'); if(k>=0) d=Math.max(d,t.length-k-1); }); }
      if(d>0) return Math.min(5,d);
    }
  }catch(e){}
  return /JPY/.test(p)?3:/^XAU|^XAG/.test(p)?2:5;
}
function bwDG(){ try{ return (typeof pair!=='undefined' && pair) ? digitsOf(pair) : 5; }catch(e){ return 5; } }
(function(root){
'use strict';

/* how far past the trigger counts as committed, in pattern heights */
const DIST_CALM    = 0.35;   /* clean conditions */
const DIST_FLAGGED = 0.55;   /* radar flagged — demand more, not less */
const MIN_MINUTES  = 5;      /* if the bar closes sooner than this, just wait */
const FAST_ATR     = 0.9;    /* bar range already this much of ATR = fast */
const PARTICIPATION= 90;     /* liquidity health floor, his number */

function tfMinutes(tf){ return {M15:15,M30:30,H1:60,H4:240,D1:1440}[tf]||60; }

/* ── minutesLeft: how long until this bar closes ────────────────── */
function minutesLeft(barOpenMs, tf, nowMs){
  const span=tfMinutes(tf)*60000;
  const elapsed=(nowMs||Date.now())-barOpenMs;
  return Math.max(0, (span-elapsed)/60000);
}

/* ══ THE DECISION ══════════════════════════════════════════════════
   Returns which method is being used, why, and what is still missing.
   It never says "enter" — it says how this break is being confirmed. */
/* ── GATE 5 · THE MEASURED MOVE HAS EFFECTIVELY BEEN DELIVERED ─────
   His rule, and a different question from the other four. Those ask
   "is this break real yet?". This asks "has the pattern already done
   what it promised?" — and if it has, there is nothing left to
   confirm. Three conditions, all required:

     · price is within NEAR_TARGET_PIPS of the measured target
     · price has travelled at least MOVED_PIPS since the trigger broke
       (displacement, not distance from the target)
     · the 2-3 bar confirmation has already been met

   SIZING, his call: essentially fixed for FX, ATR-scaled for gold and
   indices. 20 pips on EURUSD is an ordinary move; on XAUUSD it is
   noise, so a fixed figure would fire on gold almost immediately and
   almost never on a quiet FX pair. The pair's own ATR does the
   scaling, clamped tightly for FX so his numbers stand there, and
   loosely for everything else. */
var NEAR_TARGET_PIPS = 20;   /* how close to the target counts as arrived */
var MOVED_PIPS       = 15;   /* displacement since the break */
var FX_ATR_REF       = 12;   /* a typical H1 ATR on a major, in pips */

function sizeFor(pip, atrPips){
  var isFX = !!pip && pip <= 0.01 + 1e-9;      /* 0.0001, and 0.01 on JPY */
  if(!atrPips || !isFinite(atrPips) || atrPips <= 0)
    return {near:NEAR_TARGET_PIPS, moved:MOVED_PIPS, scale:1, fx:isFX};
  var raw = atrPips / FX_ATR_REF;
  var scale = isFX ? Math.min(1.25, Math.max(0.8, raw))   /* stays near his numbers */
                   : Math.min(8,    Math.max(0.5, raw));  /* gold, indices */
  return {near:+(NEAR_TARGET_PIPS*scale).toFixed(1),
          moved:+(MOVED_PIPS*scale).toFixed(1),
          scale:+scale.toFixed(2), fx:isFX};
}

function decide(o){
  o=o||{};
  const {pattern, cd, tf, liquidity, radar, nowMs} = o;
  const out={method:'bars', barsNeeded:3, why:[], gates:{}, ok:false};
  if(!pattern || !cd || !cd.length) { out.why.push('no pattern or candles'); return out; }

  const last=cd[cd.length-1];
  const H=+last.h||+last.high, L=+last.l||+last.low, C=+last.c||+last.close;
  const trigger=+pattern.trigger;
  if(!Number.isFinite(trigger)){ out.why.push('this pattern has no trigger level'); return out; }

  /* the pattern's own height — the yardstick */
  let hi=-Infinity, lo=Infinity;
  for(let i=Math.max(0,pattern.startI); i<=Math.min(cd.length-1,pattern.endI); i++){
    const h=+cd[i].h, l=+cd[i].l; if(h>hi)hi=h; if(l<lo)lo=l;
  }
  const height=hi-lo;
  let atr=0,k=0;
  for(let i=Math.max(1,cd.length-14);i<cd.length;i++){ atr+=(+cd[i].h)-(+cd[i].l); k++; }
  atr=k?atr/k:0;

  const dir = pattern.dir>0?1:-1;
  const past = dir>0 ? (C-trigger) : (trigger-C);
  out.pipsPast = o.pip? past/o.pip : null;
  out.heightsPast = height>0 ? past/height : 0;

  /* ── GATE 1 · is there enough time left to be worth it? ──────────
     His gate, and the right one. If the bar closes in under five
     minutes, waiting for the close costs almost nothing and gives a
     definitive answer. Distance is for when waiting is expensive. */
  const mins = (o.barOpenMs!=null) ? minutesLeft(o.barOpenMs, tf, nowMs) : tfMinutes(tf);
  out.gates.minutesLeft = Math.round(mins);
  out.gates.timeWorthIt = mins > MIN_MINUTES;

  /* ── GATE 2 · is this bar actually moving? ───────────────────────
     A bar creeping past the trigger is not a committed break however
     healthy the book is. Range against ATR is the honest measure. */
  const barRange=H-L;
  out.gates.speed = atr>0 ? +(barRange/atr).toFixed(2) : 0;
  out.gates.fast = atr>0 && (barRange/atr) >= FAST_ATR;

  /* ── GATE 3 · is the market healthy enough to trust a break? ─────
     His number: participation at 90% or better. A break into a thin
     book is the one that gets given straight back. */
  const part = liquidity && liquidity.participation!=null ? +liquidity.participation : null;
  out.gates.participation = part;
  out.gates.participationIsRatio = !!(liquidity && liquidity.participationIsRatio);
  out.gates.liquidityState = (liquidity && liquidity.state) || null;
  /* The Liquidity tab's own verdict is a veto. If it has already called
     the book thin, or is still learning what normal looks like, no score
     should talk us past that — it knows more than the number does. */
  out.gates.liquidityVeto = !!(liquidity && liquidity.veto);
  out.gates.healthy = !out.gates.liquidityVeto && part!=null && part>=PARTICIPATION;

  /* ── GATE 4 · does the move have a cause? ────────────────────────
     A radar flag means something is driving this. Required — but it
     makes the distance bar HIGHER, for the reasons at the top. */
  const flag = radar && radar.state ? String(radar.state).toLowerCase() : null;
  const flagged = flag==='caution'||flag==='elevated'||flag==='standdown'||flag==='stand-down';
  out.gates.radar = flag;
  out.gates.radarReasons = (radar && radar.reasons) || [];
  /* HIS RULE (Oct 2026): a volatility spike counts as a cause even while the
     radar overall reads clear — its volatility factor fires on a bar 1.8x or
     more its 20-bar average, on H1 or H4, before the total score moves. */
  out.gates.radarVol = (radar && radar.vol) || [];
  out.gates.hasCause = flagged || out.gates.radarVol.length>0;

  const allGates = out.gates.timeWorthIt && out.gates.fast && out.gates.healthy && out.gates.hasCause;
  out.gates.allTrue = allGates;

  /* GATE 5 runs BEFORE the others can send this back to waiting on bars:
     once the move has been delivered, how it would have been confirmed
     is no longer the question. */
  const atrPips = o.pip ? atr/o.pip : 0;
  const sz = sizeFor(o.pip||0.0001, atrPips);
  out.gates.sizing = sz;
  const tgt = +pattern.target;
  const life = pattern.life || {};
  const grace = o.grace || 3;
  const barsConfirmed = life.state==='confirmed' ||
                        (!!life.broke && (life.barsSince||0) >= grace);
  out.gates.barsConfirmed = barsConfirmed;

  if(Number.isFinite(tgt) && o.pip){
    const toTarget = Math.abs(tgt - C) / o.pip;
    const movedPips = past / o.pip;
    out.gates.toTargetPips = +toTarget.toFixed(1);
    out.gates.movedPips    = +movedPips.toFixed(1);
    out.gates.nearTarget   = toTarget <= sz.near;
    out.gates.travelled    = movedPips >= sz.moved;

    if(out.gates.nearTarget && out.gates.travelled && barsConfirmed){
      out.method='target';
      out.ok=true;
      out.fullyConfirmed=true;
      out.completion=100;
      out.say='Fully confirmed — price is '+toTarget.toFixed(1)+' pips from the measured target at '+
              tgt.toFixed(bwDG())+', having travelled '+movedPips.toFixed(1)+' pips since the break, with the '+
              grace+'-bar confirmation already met. The pattern has done what it measured.';
      out.why.push('within '+sz.near+' pips of the target and '+sz.moved+
                   ' pips of travel required'+(sz.fx?'':' (scaled '+sz.scale+'x by this instrument\u2019s ATR)')+
                   ' — both met, and the break already held '+grace+' bars');
      return out;
    }
  }

  if(!allGates){
    out.method='bars'; out.barsNeeded=2;
    out.why.push('confirms when a candle closes 70% or more of the way to the target, on candle 2 or later after the break');
    if(!out.gates.timeWorthIt) out.why.push('this bar closes in '+Math.round(mins)+' min — waiting for the close is cheaper than measuring distance');
    if(!out.gates.fast)        out.why.push('the bar is not moving fast enough to call this committed ('+out.gates.speed+'x ATR)');
    if(!out.gates.healthy) out.why.push(
        out.gates.liquidityVeto ? 'Liquidity has called the book "'+out.gates.liquidityState+'" — its own verdict overrides the score'
      : part==null ? 'no participation reading from Liquidity'
      : (liquidity && liquidity.participationIsRatio===false
          ? 'participation reading is only the liquidity score ('+part+'), below '+PARTICIPATION+' \u2014 this payload carries no volume ratio'
          : 'participation is '+part+'% of what this block normally does, below '+PARTICIPATION+'%'));
    if(!out.gates.hasCause)    out.why.push('Risk Radar is clear and its volatility factor has not fired — no driver behind this move, so a normal break is the safer read');
    return out;
  }

  /* all four true: distance replaces bars — confirmed by a close at 70%+ of
     the way from the trigger to the measured target (his rule), not by
     pattern heights. */
  const tgt2 = +pattern.target, span2 = Math.abs(tgt2 - trigger);
  const prog = (Number.isFinite(tgt2) && span2>0) ? past/span2 : 0;
  out.method='distance';
  out.progress = +prog.toFixed(2);
  out.needPips = (o.pip && span2>0) ? +((0.7*span2)/o.pip).toFixed(1) : null;
  out.ok = prog >= 0.7;
  out.why.push('participation '+part+'%, bar moving '+out.gates.speed+'x ATR, '+
               Math.round(mins)+' min left in the bar, and '+(flagged ? 'Risk Radar is '+flag
               : 'Risk Radar\u2019s volatility factor has fired ('+out.gates.radarVol.join('; ')+')'));
  out.why.push('confirming by distance instead of waiting for candle 2 \u2014 a close at 70% or more of the way to the target confirms it at once');
  if(out.gates.radarReasons.length)
    out.why.push('the radar is flagged because: '+out.gates.radarReasons.join('; '));
  out.say = out.ok
    ? 'Break confirmed by distance \u2014 price has closed '+Math.round(prog*100)+'% of the way to the target.'
    : 'Confirming by distance. Needs a close at 70% of the way to the target'+
      (out.needPips?' (about '+out.needPips+' pips past the trigger)':'')+'; it is at '+Math.round(Math.max(0,prog)*100)+'% now.';
  return out;
}

/* ── READING THE REAL SOURCES ─────────────────────────────────────
   Both feeds exist in the MT5 Assistant and neither is shaped the way
   this engine wants, so the translation lives here rather than making
   either side change:

   LIQUIDITY — `liqRead(cd, tf)` returns `{score, state, cls, ...}`.
   `score` is 2-98 and `cls` is one of learn / man / thin / healthy.
   Participation is not a separate percentage, so `score` IS the
   participation reading, and `cls==='thin'` is an explicit veto: the
   Liquidity tab has already concluded the book is below normal, and no
   score should override its own verdict.

   RISK RADAR — `RR` carries `m.level.key` (clear / caution / elevated /
   standdown), `m.score`, and `m.factors` sorted by weight with `.label`
   on each. The factors are exactly the "why is it flagged" he asked for,
   already ranked, so the top three are taken in order. */
function fromLiquidity(liq){
  if(!liq) return null;
  /* PARTICIPATION IS A PERCENTAGE OF NORMAL, NOT THE LIQUIDITY SCORE.
     This passed liq.score, which the gate then compared against 90 and
     printed as "participation is N%, below 90%" — labelling a composite
     0-140 score as a percentage of anything. liqRead already computes
     the real quantity: ratio = this block's volume / what this block
     normally does. 100% is an ordinary market, so the 90% floor finally
     means what the sentence always claimed it meant.
     The score is still carried, for the panel and as a fallback when an
     older payload has no ratio. */
  const pct = (liq.ratio!=null && isFinite(+liq.ratio)) ? Math.round(+liq.ratio*100) : null;
  return {
    participation: pct!=null ? pct : ((liq.score!=null) ? +liq.score : null),
    participationIsRatio: pct!=null,
    score: (liq.score!=null) ? +liq.score : null,
    /* the tab's own verdict beats its own number */
    veto: liq.cls==='thin' || liq.cls==='learn',
    state: liq.state||null, cls: liq.cls||null
  };
}
function fromRadar(m){
  if(!m || !m.level) return null;
  return {
    state: m.level.key,
    score: m.score,
    advice: m.level.advice||null,
    reasons: (m.factors||[]).slice(0,3).map(function(x){ return x.label; }),
    vol: Array.isArray(m.vol) ? m.vol : []      /* Risk Radar's volatility factor, even while it reads clear */
  };
}

root.BWBreakConfirm={decide, minutesLeft, fromLiquidity, fromRadar, sizeFor,
  DIST_CALM, DIST_FLAGGED, MIN_MINUTES, FAST_ATR, PARTICIPATION,
  NEAR_TARGET_PIPS, MOVED_PIPS, FX_ATR_REF};
})(typeof window!=='undefined'?window:globalThis);
