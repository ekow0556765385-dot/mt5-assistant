/* ══════════════════════════════════════════════════════════════════
   BREAK CONFIRMATION — bars, or distance

   THE PROBLEM, MEASURED
   Confirmation is 3 closed bars. On H1 that is 3 hours; on H4 it is 12.
   Meanwhile on EURUSD H1 price travels a median of 8 pips over 3 bars,
   but 30 at the 90th percentile. So on the fast breaks — the ones worth
   taking — the trader spends the whole move watching a pattern sit at
   "85% complete", and by the time it reads 100% the setup is gone.

   THE IDEA
   When a break is clearly committed, prove it with DISTANCE instead of
   time. A break that has travelled a long way from the trigger has shown
   more conviction than one that merely survived three quiet bars.

   ONE THING I ARGUE WITH
   He proposed that a Risk Radar flag (caution / elevated / stand-down)
   is evidence the break will hold. The reasoning is sound — a flag means
   something real is driving the move rather than noise. But a flag is
   also exactly when spreads widen, slippage bites, and stop hunts run.
   Using a DANGER signal to enter FASTER is the wrong direction.
   So the flag is kept as a REQUIRED CONDITION — it says the move has a
   cause — but it RAISES the distance required rather than lowering it.
   Dangerous conditions demand more proof, not less. The trader still
   gets in early; they just have to see more commitment first.

   DISTANCE IS MEASURED IN THE PATTERN'S OWN HEIGHT, NOT PIPS
   A fixed pip count means one thing on EURUSD and something else on
   gold, and something else again on H4. The pattern's own height is the
   yardstick every other part of this platform already uses.
   ══════════════════════════════════════════════════════════════════ */
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
  out.gates.hasCause = flagged;

  const allGates = out.gates.timeWorthIt && out.gates.fast && out.gates.healthy && out.gates.hasCause;
  out.gates.allTrue = allGates;

  if(!allGates){
    out.method='bars'; out.barsNeeded=3;
    if(!out.gates.timeWorthIt) out.why.push('this bar closes in '+Math.round(mins)+' min — waiting for the close is cheaper than measuring distance');
    if(!out.gates.fast)        out.why.push('the bar is not moving fast enough to call this committed ('+out.gates.speed+'x ATR)');
    if(!out.gates.healthy) out.why.push(
        out.gates.liquidityVeto ? 'Liquidity has called the book "'+out.gates.liquidityState+'" — its own verdict overrides the score'
      : part==null ? 'no participation reading from Liquidity'
      : 'participation is '+part+'%, below '+PARTICIPATION+'%');
    if(!out.gates.hasCause)    out.why.push('Risk Radar is clear — no driver behind this move, so a normal break is the safer read');
    return out;
  }

  /* all four true: distance replaces bars */
  const need = flagged ? DIST_FLAGGED : DIST_CALM;
  out.method='distance';
  out.needHeights=need;
  out.needPips = o.pip? +(need*height/o.pip).toFixed(1) : null;
  out.ok = out.heightsPast >= need;
  out.why.push('participation '+part+'%, bar moving '+out.gates.speed+'x ATR, '+
               Math.round(mins)+' min left in the bar, and Risk Radar is '+flag);
  out.why.push('confirming by distance instead of waiting 3 bars — but because the radar is '+flag+
               ', the bar is set HIGHER at '+need+' pattern heights, not lower. Dangerous conditions '+
               'need more proof, not less.');
  if(out.gates.radarReasons.length)
    out.why.push('the radar is flagged because: '+out.gates.radarReasons.join('; '));
  out.say = out.ok
    ? 'Break confirmed by distance — price is '+out.heightsPast.toFixed(2)+
      ' pattern heights past the trigger'+(out.pipsPast?' ('+out.pipsPast.toFixed(1)+' pips)':'')+'.'
    : 'Confirming by distance. Needs '+need+' pattern heights past the trigger'+
      (out.needPips?' (about '+out.needPips+' pips)':'')+'; it is at '+out.heightsPast.toFixed(2)+' now.';
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
  return {
    participation: (liq.score!=null) ? +liq.score : null,
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
    reasons: (m.factors||[]).slice(0,3).map(function(x){ return x.label; })
  };
}

root.BWBreakConfirm={decide, minutesLeft, fromLiquidity, fromRadar,
  DIST_CALM, DIST_FLAGGED, MIN_MINUTES, FAST_ATR, PARTICIPATION};
})(typeof window!=='undefined'?window:globalThis);
