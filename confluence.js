/* confluence.js — GENERATED from patterns.html by build-host.js. Do not edit by hand:
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
function bwBarHourUTC(c){ const t=bwBarMs(c); return isFinite(t)&&t?new Date(t).getUTCHours():null; }
(function(root){
'use strict';

var CONFIRM     = 2;     /* bars a break must hold */
var PRESS_WARN  = 35;    /* calibrated, see header */
var PRESS_LEAN  = 22;
var HORIZON     = 4;     /* bars ahead the track record is scored over */
var AFTER_LOOK  = 150;
var REFRAME_MIN = 22;

/* ── helpers (private; the host has its own atr/pivots and these must
      not collide with them) ─────────────────────────────────────── */
var PIP = 0.0001;
function pips(x){ return x / PIP; }
function cAtr(cd, n){
  n = n || 14;
  var a = cd.slice(-n-1), s = 0, c = 0;
  for(var i=1;i<a.length;i++){
    var tr = Math.max(a[i].h-a[i].l, Math.abs(a[i].h-a[i-1].c), Math.abs(a[i].l-a[i-1].c));
    s += tr; c++;
  }
  return c ? s/c : 0;
}
function cMed(a){
  if(!a.length) return 0;
  var b = a.slice().sort(function(x,y){return x-y;});
  var m = Math.floor(b.length/2);
  return b.length % 2 ? b[m] : (b[m-1]+b[m])/2;
}
function cPivots(cd, k){
  var out = [];
  for(var i=k;i<cd.length-k;i++){
    var hi = true, lo = true;
    for(var j=i-k;j<=i+k;j++){
      if(j===i) continue;
      /* flat pair: the first bar is the pivot (strict left, not right) —
         the same rule every other engine now uses */
      if(j<i ? cd[j].h >= cd[i].h : cd[j].h > cd[i].h) hi = false;
      if(j<i ? cd[j].l <= cd[i].l : cd[j].l < cd[i].l) lo = false;
    }
    if(hi) out.push({i:i, type:'H', p:cd[i].h});
    if(lo) out.push({i:i, type:'L', p:cd[i].l});
  }
  return out;
}

/* ── CLASS 1 — FRAME ─────────────────────────────────────────────
   Own reading, used ONLY when the mandate has no direction. When the
   governor has spoken, its classification wins — one authority. */
function readFrame(cd){
  if(cd.length < 40) return {ok:false, why:'not enough history'};
  var k = cd.length < 60 ? 2 : (cd.length < 150 ? 3 : 4);
  var pv = cPivots(cd, k);
  if(pv.length < 4) return {ok:false, why:'not enough swings yet'};

  var band = cAtr(cd) * 0.25;
  for(var i=0;i<pv.length;i++){
    var prev = null;
    for(var j=i-1;j>=0;j--){ if(pv[j].type === pv[i].type){ prev = pv[j]; break; } }
    if(!prev) continue;
    var d = pv[i].p - prev.p;
    if(Math.abs(d) < band) pv[i].lab = pv[i].type === 'H' ? 'EQ-H' : 'EQ-L';
    else if(pv[i].type === 'H') pv[i].lab = d > 0 ? 'HH' : 'LH';
    else pv[i].lab = d > 0 ? 'HL' : 'LL';
  }
  var seq = [];
  for(var q=0;q<pv.length;q++){ if(pv[q].lab) seq.push(pv[q].lab); }
  var last4 = seq.slice(-4);

  function effOver(n){
    var w = cd.slice(-Math.min(n, cd.length));
    if(w.length < 5) return 0;
    var net = Math.abs(w[w.length-1].c - w[0].c), path = 0;
    for(var z=1;z<w.length;z++) path += Math.abs(w[z].c - w[z-1].c);
    return path ? net/path : 0;
  }
  var effCtx = effOver(140), effNow = effOver(45), eff = effCtx;
  var win = cd.slice(-Math.min(45, cd.length));
  var net140 = win[win.length-1].c - win[0].c;

  var upV = last4.filter(function(l){return l==='HH'||l==='HL';}).length;
  var dnV = last4.filter(function(l){return l==='LH'||l==='LL';}).length;
  var eqAny = last4.some(function(l){return l.indexOf('EQ')===0;});
  var uUp = last4.length === 4 && upV === 4, uDn = last4.length === 4 && dnV === 4;
  var turned = (uUp || uDn) && effNow >= 0.30;

  var dir = 'none', conf = 0.35;
  if(eff < 0.12 && !turned){ dir='none'; conf = 0.85; }
  else if(uUp){ dir='up';   conf = (eff > 0.22 || turned) ? 0.9 : 0.7; }
  else if(uDn){ dir='down'; conf = (eff > 0.22 || turned) ? 0.9 : 0.7; }
  else if(upV >= 3 && !eqAny){ dir='up';   conf = 0.6; }
  else if(dnV >= 3 && !eqAny){ dir='down'; conf = 0.6; }
  else if(eff >= 0.25){ dir = net140 > 0 ? 'up' : 'down'; conf = 0.6; }
  else { dir='none'; conf = eff < 0.18 ? 0.85 : 0.4; }

  var lastH = null, lastL = null;
  for(var a=pv.length-1;a>=0;a--){
    if(!lastH && pv[a].type==='H') lastH = pv[a];
    if(!lastL && pv[a].type==='L') lastL = pv[a];
    if(lastH && lastL) break;
  }
  var decider = null, broken = false, last = cd[cd.length-1];
  if(dir === 'down' && lastH){
    decider = {name:'last lower high', p:lastH.p, dirIfBroken:'up'};
    broken = last.c > lastH.p;
  } else if(dir === 'up' && lastL){
    decider = {name:'last higher low', p:lastL.p, dirIfBroken:'down'};
    broken = last.c < lastL.p;
  }
  return {ok:true, dir:dir, conf:conf, eff:eff, effCtx:effCtx, effNow:effNow,
          seq:seq, last4:last4, pivots:pv, decider:decider, broken:broken, k:k};
}

/* THE MANDATE IS THE AUTHORITY on direction. The retracement engine
   already learned this the hard way — it kept a private trend test and
   ended up contradicting structure on the same screen. */
function applyMandate(frame, m){
  if(!m || !m.ok || !frame.ok) return frame;
  var md = m.dir || m.regime;
  if(md === 'uptrend') md = 'up';
  if(md === 'downtrend') md = 'down';
  if(md !== 'up' && md !== 'down') return frame;
  if(md === frame.dir) return frame;

  /* structure disagrees with our own labels — structure wins, and we
     re-derive the deciding level from our pivots in ITS direction */
  var lastH = null, lastL = null, pv = frame.pivots;
  for(var a=pv.length-1;a>=0;a--){
    if(!lastH && pv[a].type==='H') lastH = pv[a];
    if(!lastL && pv[a].type==='L') lastL = pv[a];
    if(lastH && lastL) break;
  }
  var last = frame.pivots.length ? null : null;
  frame.dir = md;
  frame.conf = Math.max(frame.conf, +m.confidence || 0.7);
  frame.fromMandate = true;
  frame.decider = md === 'down' && lastH ? {name:'last lower high', p:lastH.p, dirIfBroken:'up'}
                : md === 'up'   && lastL ? {name:'last higher low', p:lastL.p, dirIfBroken:'down'}
                : frame.decider;
  return frame;
}

/* ── CLASS 2 — LOCATION ──────────────────────────────────────────── */
function readLocation(cd, frame){
  var last = cd[cd.length-1];
  if(!frame.ok) return {atLevel:false, pipsAway:0, kind:''};
  var a = cAtr(cd), near = null, bestD = 1e9;
  for(var i=0;i<frame.pivots.length;i++){
    var pv = frame.pivots[i];
    if(pv.i > cd.length - 3) continue;
    var d = Math.abs(last.c - pv.p);
    if(d < bestD){ bestD = d; near = pv; }
  }
  if(!near) return {atLevel:false, pipsAway:0, kind:''};
  return {atLevel: bestD <= a * 0.55, level:near.p,
          kind: near.type === 'H' ? 'a level price was rejected from before'
                                  : 'a level price has bounced from before',
          lab: near.lab || '', pipsAway: pips(bestD)};
}

/* ── CLASS 3 — TRIGGER ───────────────────────────────────────────── */
function detectAt(cd, i, aIn){
  var out = [], a = aIn || cAtr(cd.slice(0, i+1));
  if(i < 2 || !a) return out;
  var b = cd[i], p = cd[i-1];
  var body = Math.abs(b.c-b.o), rng = b.h-b.l || 1e-9, up = b.c > b.o;
  if(up && p.c < p.o && b.c > p.o && b.o < p.c)
    out.push({name:'Bullish engulfing', mean:'bullish', dir:'up', conf:Math.min(86, 60+Math.round(body/a*26)), i:i, span:[i-1,i]});
  if(!up && p.c > p.o && b.c < p.o && b.o > p.c)
    out.push({name:'Bearish engulfing', mean:'bearish', dir:'down', conf:Math.min(86, 60+Math.round(body/a*26)), i:i, span:[i-1,i]});
  var lowW = Math.min(b.o,b.c) - b.l, upW = b.h - Math.max(b.o,b.c);
  if(lowW > body*2 && body/rng < 0.36 && lowW/rng > 0.5)
    out.push({name:'Hammer', mean:'bullish', dir:'up', conf:70, i:i, span:[i,i]});
  if(upW > body*2 && body/rng < 0.36 && upW/rng > 0.5)
    out.push({name:'Shooting star', mean:'bearish', dir:'down', conf:72, i:i, span:[i,i]});
  return out;
}

/* Never print a name without its meaning — but never print
   "Bearish engulfing (bearish)" either. */
function patName(p){
  if(!p) return '';
  if(!p.mean) return p.name;
  if(p.name.toLowerCase().indexOf(p.mean) >= 0) return p.name;
  return p.name + ' (' + p.mean + ')';
}

/* ONE AUTHORITY ON CANDLESTICK PATTERNS.

   The EA detects these and the Assistant alerts on them; this engine
   must not be a SECOND candlestick detector running to different rules.
   It had been: its own scan covered 4 bars and it admitted alerts up to
   bar_index 6 at any confidence, while the rest of this file — the Live
   tab, the pattern list, the recorder and BWRetracement — all use
   bar_index <= 2 with a confidence floor. Two detectors with different
   freshness windows is how one tab shows a signal another has already
   retired.

   So: the FEED decides. Its own detector runs only when the feed has
   nothing fresh to say, and the reading states which was used. Same
   shape as the mandate, liquidity and the Radar. */
var FRESH_BARS = 2;    /* the page's own definition of recent */
var CONF_FLOOR = 65;   /* the floor the rest of the file already applies */

/* Two different things arrive here and they are NOT the same feed —
   I had claimed they were, and they are not:

     alerts      /api/patterns  {type, confidence_pct, bar_index}
                 the EA's candlestick detections, indexed by BAR. This
                 is what the Live tab's freshness bucket reads.

     raised      /api/alerts    {name, direction, confidence, symbol,
                                 timeframe, price, time, desc}
                 the persisted alert history the MT5 Assistant's Pattern
                 Alerts tab shows. No bar_index at all — it is stamped
                 with a CLOCK TIME, so its freshness has to be resolved
                 against the candles rather than assumed.

   They probably share an origin server-side, but nothing here may
   assume that: an alert is only matched to a detection when it lands
   on the same bar. */
function barOfTime(cd, ms){
  if(!ms || !cd.length) return -1;
  var t = ms > 1e12 ? ms/1000 : ms;               /* seconds, like MT5 sends */
  var best = -1, bd = Infinity;
  for(var i=cd.length-1; i>=0 && cd.length-1-i <= 12; i--){
    var bt = bwBarMs(cd[i]) / 1000; if(!isFinite(bt) || !bt) continue;   /* text times too */
    var d = Math.abs(bt - t);
    if(d < bd){ bd = d; best = i; }
  }
  return best;
}

function readTrigger(cd, formations, alerts, raised){
  var found = [], n = cd.length, source = 'none';

  /* 1. THE FEED FIRST. bar_index counts back from the live bar. */
  if(alerts && alerts.length){
    alerts.forEach(function(q){
      var conf = q.confidence_pct != null ? +q.confidence_pct
               : q.confidence != null ? +q.confidence : 0;
      if(!(conf >= CONF_FLOOR)) return;
      var nm = String(q.type || q.name || q.pattern || '').trim();
      if(!nm) return;
      var low = nm.toLowerCase();
      var up = low.indexOf('bull') >= 0, dn = low.indexOf('bear') >= 0;
      if(!up && !dn) return;
      var bi = q.bar_index != null ? +q.bar_index
             : q.barsAgo != null ? +q.barsAgo : null;
      if(bi == null || !isFinite(bi) || bi > FRESH_BARS) return;
      var i = n - 1 - bi;
      if(i < 1 || i >= n) return;
      found.push({name:nm, mean: up ? 'bullish' : 'bearish', dir: up ? 'up' : 'down',
                  conf: Math.round(conf), i:i, span:[i-1, i], barsAgo:bi, alert:true});
    });
    if(found.length) source = 'feed';
  }

  /* 2. THE ASSISTANT'S RAISED ALERTS. Same freshness rule expressed in
        bars, resolved from the alert's timestamp because the record has
        no bar_index. An alert whose bar cannot be located in the candles
        is dropped rather than guessed at. */
  var raisedHits = 0;
  if(raised && raised.length){
    raised.forEach(function(a){
      var conf = a.confidence != null ? +a.confidence
               : a.confidence_pct != null ? +a.confidence_pct : 0;
      if(!(conf >= CONF_FLOOR)) return;
      var nm = String(a.name || a.type || '').trim();
      if(!nm) return;
      var dd = String(a.direction || '').toLowerCase();
      var up = dd.indexOf('bull') >= 0, dn = dd.indexOf('bear') >= 0;
      if(!up && !dn){
        var low = nm.toLowerCase();
        up = low.indexOf('bull') >= 0; dn = low.indexOf('bear') >= 0;
      }
      if(!up && !dn) return;
      var when = a.time ? bwBarMs({t:a.time}) : (a.ts ? +a.ts : 0);   /* MT5 dotted times parse everywhere */
      if(!isFinite(when)) when = 0;
      var i = barOfTime(cd, when);
      if(i < 1) return;
      var bi = n - 1 - i;
      if(bi > FRESH_BARS) return;
      raisedHits++;
      found.push({name:nm, mean: up ? 'bullish' : 'bearish', dir: up ? 'up' : 'down',
                  conf: Math.round(conf), i:i, span:[i-1, i], barsAgo:bi, raised:true,
                  price: a.price, desc: a.desc});
    });
    if(raisedHits && source === 'none') source = 'alert';
    else if(raisedHits && source === 'feed') source = 'feed+alert';
  }

  /* 2. FALLBACK ONLY. If the feed is empty, stale or not connected, read
        the candles here rather than showing nothing — but say so. */
  if(!found.length){
    for(var back=0; back<=FRESH_BARS && n-1-back>1; back++){
      detectAt(cd, n-1-back).forEach(function(g){ g.barsAgo = back; found.push(g); });
    }
    if(found.length) source = 'local';
  }

  /* THE HOST'S OWN FORMATIONS, not a second chart-pattern engine.
     One row per formation already — they have been collapsed upstream. */
  if(formations && formations.length){
    formations.forEach(function(f){
      var lead = f.lead || f;
      /* The formations engine stores direction as a NUMBER (+1 / -1), and
         effectiveDir flips it when a shape fails. Calling .toLowerCase() on
         the number threw — harmless only because no formation ever arrived
         here (see the call above). Words are still accepted. */
      var dv = (lead.effectiveDir != null ? lead.effectiveDir : (lead.dir != null ? lead.dir : lead.direction));
      var d = typeof dv === 'number' ? (dv > 0 ? 'up' : dv < 0 ? 'down' : '') : String(dv || '').toLowerCase();
      var up = d.indexOf('bull') === 0 || d === 'up';
      var dn = d.indexOf('bear') === 0 || d === 'down';
      if(!up && !dn) return;
      var ei = (lead.endI != null ? lead.endI : n-1);
      var si = (lead.startI != null ? lead.startI : ei);
      found.push({name: lead.name || lead.label || 'Chart pattern',
                  mean: up ? 'bullish' : 'bearish',
                  dir: up ? 'up' : 'down',
                  conf: Math.round(+lead.conf || +lead.confidence || 70),
                  i: ei, span:[si, ei], barsAgo: Math.max(0, n-1-ei), formation:true});
    });
  }
  if(!found.length) return {any:false, groups:[], source:'none'};

  /* COLLAPSE: detections sharing bars are one event seen several ways. */
  var groups = [];
  found.forEach(function(f){
    for(var g=0;g<groups.length;g++){
      var G = groups[g];
      if(!(f.span[1] < G.span[0] || f.span[0] > G.span[1])){
        G.span = [Math.min(G.span[0],f.span[0]), Math.max(G.span[1],f.span[1])];
        G.members.push(f);
        if(f.alert) G.hasAlert = true;
        if(f.raised) G.hasRaised = true;
        if(f.conf > G.conf){ G.conf=f.conf; G.name=f.name; G.mean=f.mean; G.dir=f.dir; G.i=f.i; G.alert=f.alert; }
        return;
      }
    }
    groups.push({span:f.span.slice(), members:[f], conf:f.conf, name:f.name, mean:f.mean,
                 dir:f.dir, i:f.i, barsAgo:f.barsAgo, alert:f.alert, raised:f.raised,
                 hasAlert:!!f.alert, hasRaised:!!f.raised});
  });
  groups.sort(function(x,y){ return y.conf - x.conf; });
  var lead = groups[0];
  return {any:true, groups:groups, lead:lead, source:source,
          duplicated: lead.members.length > 1,
          barsAgo: cd.length-1 - lead.i};
}

/* ── CLASS 4 — TRACK RECORD ──────────────────────────────────────── */
function readReliability(cd, name, dir){
  var hits = 0, n = 0, last = cd.length - 1, a = cAtr(cd);
  for(var i=30; i <= last - HORIZON - 1; i++){
    var got = detectAt(cd, i, a);
    for(var g=0; g<got.length; g++){
      if(got[g].name !== name) continue;
      var moved = cd[i+HORIZON].c - cd[i].c;
      var worked = dir === 'up' ? moved > a*0.5 : moved < -a*0.5;
      n++; if(worked) hits++;
    }
  }
  if(n < 5) return {thin:true, n:n, mult:1,
    note:'Only ' + n + ' of these have fired here before — too few to weigh either way.'};
  var rate = hits/n;
  return {thin:false, n:n, hits:hits, rate:rate, mult:0.55 + rate*0.9,
    note: hits + ' of ' + n + ' worked (' + Math.round(rate*100) + '%), measured ' +
          HORIZON + ' bars out against this pair\u2019s own bar range.'};
}

/* ── CLASS 5 — HIGHER TIMEFRAME ──────────────────────────────────── */
/* Built by TIME, not by counting 4 bars. Four H4 bars are 16 hours, not
   a day, and counting from the first bar in memory put the bucket edges
   at whatever hour the series happened to start. H1 -> H4 uses 4-hour
   UTC blocks, H4 -> D1 uses UTC days. Falls back to fours if bar times
   are unreadable. */
function toHigher(cd, tfName){
  var span = tfName === 'H4' ? 86400000 : 14400000, out = [], cur = null, curK = null;
  for(var i=0;i<cd.length;i++){
    var b = cd[i], ms = bwBarMs(b);
    var k = isFinite(ms) && ms ? Math.floor(ms / span) : Math.floor(i / 4) - 1e9;
    if(k !== curK){ if(cur) out.push(cur); curK = k; cur = {t:b.t, o:b.o, h:b.h, l:b.l, c:b.c, v:b.v||0}; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v||0; }
  }
  if(cur) out.push(cur);
  return out;
}
function readHigher(cd, dir, tfName){
  var up = toHigher(cd, tfName);
  var label = tfName === 'H4' ? 'D1' : 'H4';
  if(up.length < 40) return {known:false, mult:1, label:label,
    note:'Not enough ' + label + ' history yet to check agreement.'};
  var f = readFrame(up);
  if(!f.ok || f.dir === 'none')
    return {known:true, dir:'none', conf:f.ok?f.conf:0, mult:1, label:label,
            note: label + ' has no clear direction, so it neither supports nor argues against this.'};
  if(f.dir === dir)
    return {known:true, dir:f.dir, conf:f.conf, mult:1.15, label:label,
            note: label + ' reads ' + f.dir + ' at ' + Math.round(f.conf*100) + '% — the higher timeframe is behind this.'};
  return {known:true, dir:f.dir, conf:f.conf, mult:0.55, label:label,
          note: label + ' reads ' + f.dir + ' at ' + Math.round(f.conf*100) +
                '% while this fires ' + dir + '. It is not forbidden, but it is worth roughly half of what it would be with ' +
                label + ' behind it.'};
}

/* ── CLASS 6 — PARTICIPATION ─────────────────────────────────────
   Uses BWLiquidity when the host has it; the local read is a fallback
   only, so the two surfaces cannot disagree about the session. */
var SESS = [{n:'Sydney',a:21,b:6},{n:'Tokyo',a:0,b:9},{n:'London',a:7,b:16},{n:'New York',a:12,b:21}];
function sessionsNow(){
  var h = new Date().getUTCHours();
  return SESS.filter(function(s){
    return s.a < s.b ? (h >= s.a && h < s.b) : (h >= s.a || h < s.b);
  }).map(function(s){return s.n;});
}
/* PARTICIPATION, measured rather than scored.

   A bare score says "44" and means nothing to anyone. What a trader
   actually wants to know is: how busy is this market RIGHT NOW compared
   with how busy it normally is, and how much of that is just the clock?
   So this reports three real quantities and derives the score from them,
   instead of reporting only the score:

     volPct     the last three bars' volume as a PERCENTAGE of the
                recent median. 100% is an ordinary market.
     pctile     how many of the last 60 bars this one is busier than.
                Immune to the baseline being skewed by one spike.
     sessionPct what the open sessions are worth, on their own. The
                clock is not participation, but it caps it. */
function volPercentile(cd, n){
  n = n || 60;
  /* The live bar is only PART of a bar, so measuring its partial volume
     against completed bars reported "125% of normal" and "busier than
     10% of the last 60" on the same screen. Compare closed against
     closed. */
  var w = cd.slice(-n-2, -2).map(function(b){return +b.v||0;});
  var prev = cd[cd.length-2];
  var now = prev ? (+prev.v||0) : 0;   /* coercing the BAR to a number gave NaN */
  if(!w.length || !now) return null;
  var below = 0;
  for(var i=0;i<w.length;i++) if(w[i] < now) below++;
  return Math.round(100*below/w.length);
}
/* liq.sess is not guaranteed to be a string — the Liquidity engine may
   hand back an array or a flags object, and printing it raw produced
   "[object Object] open" on the panel. Coerce, or fall back to the
   local clock. */
function sessLabel(liq, open){
  var v = liq && liq.sess;
  var fallback = open.length ? open.join(' and ') : 'between sessions';
  if(typeof v === 'string' && v.trim()) return v.trim();
  if(Array.isArray(v) && v.length) return v.filter(Boolean).join(' and ');
  if(v && typeof v === 'object'){
    if(typeof v.name === 'string' && v.name) return v.name;
    if(typeof v.label === 'string' && v.label) return v.label;
    var on = Object.keys(v).filter(function(k){ return v[k] === true; });
    if(on.length) return on.map(function(k){ return k.charAt(0).toUpperCase()+k.slice(1); }).join(' and ');
  }
  return fallback;
}

function readPermission(cd, liq){
  var open = sessionsNow();
  var w = 0.3;
  if(open.indexOf('London')>=0 && open.indexOf('New York')>=0) w=1.0;
  else if(open.indexOf('London')>=0) w=0.9;
  else if(open.indexOf('New York')>=0) w=0.85;
  else if(open.indexOf('Tokyo')>=0) w=0.58;
  else if(open.indexOf('Sydney')>=0) w=0.42;

  var recent = cd.slice(-3).map(function(b){return +b.v||0;});
  var base = cMed(cd.slice(-24,-3).map(function(b){return +b.v||0;})) || 0;
  var ratio = base ? recent.reduce(function(s,v){return s+v;},0)/recent.length/base : 1;
  var pctile = volPercentile(cd, 60);
  var nowV = +cd[cd.length-1].v || 0;

  /* the host's Liquidity engine owns the headline number when present,
     so the two tabs cannot disagree — but the measured quantities below
     are computed here either way, because it does not publish them. */
  var score, state, fromHost = false;
  if(liq && typeof liq.score === 'number'){
    fromHost = true;
    score = Math.round(liq.score);
    state = liq.state || (score>=78?'healthy':score>=44?'thin':'drought');
    if(liq.ratio != null && isFinite(+liq.ratio)) ratio = +liq.ratio;
  } else {
    score = Math.round(Math.min(140, ratio*w*100));
    state = score>=78?'healthy':score>=44?'thin':'drought';
  }

  return {fromHost:fromHost, score:score, state:state,
          volRatio:ratio, volPct:Math.round(ratio*100),
          pctile:pctile, nowVol:nowV, baseVol:Math.round(base),
          sessionPct:Math.round(w*100), sessionList:open,
          sessions: sessLabel(liq, open),
          ok: state!=='drought' && ratio>=0.7,
          plain: (liq && liq.plain) || ''};
}

/* ── CLASS 7 — TRUST. Only ever reduces, never points a way. ─────── */
function readTrust(cd, risk){
  if(risk && typeof risk.score === 'number' && risk.fresh){
    var r = risk.score;
    return {fromRadar:true, risk:r, mult: r>=75?0.5 : r>=50?0.75 : 1,
            note: r>=75 ? 'Risk Radar is at ' + r + ' (' + (risk.name||'flagged') + ') — treat every reading here as less reliable'
                : r>=50 ? 'Risk Radar is at ' + r + ', so the evidence is worth a little less'
                : 'Risk Radar is at ' + r + ' — nothing there argues for distrusting these readings',
            factors: risk.factors || []};
  }
  var b = cd[cd.length-1], a = cAtr(cd.slice(0,-1));
  var rng = b.h-b.l, body = Math.abs(b.c-b.o);
  var size = a ? rng/a : 1, bodyShare = rng ? body/rng : 0, rr;
  if(size > 2.0 && bodyShare < 0.35) rr = 80;
  else if(size > 2.0 && bodyShare > 0.7) rr = 20;
  else if(bodyShare < 0.2) rr = 46;
  else rr = 14 + Math.round(size*10);
  rr = Math.max(0, Math.min(100, rr));
  return {fromRadar:false, risk:rr, mult: rr>=75?0.5 : rr>=50?0.75 : 1, size:size, bodyShare:bodyShare,
          note: rr>=75 ? 'The last bar reached and gave it back — treat every reading here as less reliable'
              : rr>=50 ? 'The last bar is indecisive, so the evidence is worth a little less'
              : 'Nothing about the last bar argues for distrusting the readings',
          factors: []};
}

/* ── ORDER BLOCKS near current price ─────────────────────────────── */
function readBlocks(cd){
  var a = cAtr(cd), blocks = [], last = cd[cd.length-1];
  for(var i=20;i<cd.length-2;i++){
    var move = cd[i+1].c - cd[i].c;
    if(Math.abs(move) < a*1.15) continue;
    var bull = move > 0;
    if(bull && cd[i].c < cd[i].o) blocks.push({dir:'up', top:cd[i].h, bot:cd[i].l, i:i});
    if(!bull && cd[i].c > cd[i].o) blocks.push({dir:'down', top:cd[i].h, bot:cd[i].l, i:i});
  }
  if(!blocks.length) return {any:false, mult:1, note:'No order block near this price.'};
  var here=null, bestD=1e9;
  blocks.forEach(function(b){
    var d = Math.abs(last.c - (b.top+b.bot)/2);
    if(d < bestD){ bestD=d; here=b; }
  });
  if(bestD > a*0.9) return {any:false, mult:1,
    note:'Nearest order block is ' + pips(bestD).toFixed(0) + ' pips away — not a factor here.'};
  var spent = false;
  for(var k=here.i+2;k<cd.length;k++){
    if(here.dir==='up'   && cd[k].c < here.bot) spent = true;
    if(here.dir==='down' && cd[k].c > here.top) spent = true;
  }
  return {any:true, dir:here.dir, spent:spent, pipsAway:pips(bestD), mult: spent?0.8:1.25,
    note: spent ? 'Price is at an order block that has already been traded through — it has been spent and is worth less the second time.'
                : 'Price is at an unspent ' + here.dir + ' order block, ' + pips(bestD).toFixed(1) + ' pips away.'};
}


/* ── LEVEL WATCH — runs whether or not there is a trend ───────────
   readPressure only ever ran when structure had a DIRECTION, so with
   a directionless market there was no deciding level, nothing watched
   the swing highs and lows, and a close through the last lower high
   went unnoticed. That is the one moment the tab most needed to speak.

   This watches the last LH and the last HL at all times, reports how
   far price is from each, and — the part that was missing entirely —
   notices when one has been CLOSED THROUGH and how long ago. It makes
   no claim about a trend, because there isn't one; it reports the
   structural fact and what it would take to mean something. */
function readWatch(cd){
  var n = cd.length, a = cAtr(cd);
  if(n < 40 || !a) return {known:false};
  var k = n < 60 ? 2 : (n < 150 ? 3 : 4);
  var pv = cPivots(cd, k);
  if(pv.length < 3) return {known:false};

  var band = a * 0.25;
  for(var i=0;i<pv.length;i++){
    var prev = null;
    for(var j=i-1;j>=0;j--){ if(pv[j].type===pv[i].type){ prev=pv[j]; break; } }
    if(!prev) continue;
    var d = pv[i].p - prev.p;
    if(Math.abs(d) < band) pv[i].lab = pv[i].type==='H' ? 'EQ-H' : 'EQ-L';
    else if(pv[i].type==='H') pv[i].lab = d>0 ? 'HH' : 'LH';
    else pv[i].lab = d>0 ? 'HL' : 'LL';
  }
  var lh=null, hl=null;
  for(var q=pv.length-1;q>=0;q--){
    if(!lh && pv[q].type==='H' && pv[q].lab==='LH') lh=pv[q];
    if(!hl && pv[q].type==='L' && pv[q].lab==='HL') hl=pv[q];
    if(lh && hl) break;
  }
  if(!lh && !hl) return {known:false};

  var last = cd[n-1].c;
  function crossing(p, above){
    /* how many bars since price CLOSED through it the relevant way */
    if(!p) return null;
    for(var z=n-1; z>p.i && z>=n-40; z--){
      var thru = above ? cd[z].c > p.p : cd[z].c < p.p;
      var prevIn = above ? cd[z-1].c <= p.p : cd[z-1].c >= p.p;
      if(thru && prevIn) return {barsAgo:n-1-z, at:z};
    }
    return null;
  }
  var lhBreak = lh ? crossing(lh, true)  : null;   /* closed ABOVE the lower high */
  var hlBreak = hl ? crossing(hl, false) : null;   /* closed BELOW the higher low */

  var events = [];
  if(lhBreak) events.push({which:'last lower high', p:lh.p, dir:'up',
    barsAgo:lhBreak.barsAgo, held:(last>lh.p)});
  if(hlBreak) events.push({which:'last higher low', p:hl.p, dir:'down',
    barsAgo:hlBreak.barsAgo, held:(last<hl.p)});
  events.sort(function(x,y){ return x.barsAgo-y.barsAgo; });

  return {known:true,
    lh: lh ? {p:lh.p, pips:pips(Math.abs(last-lh.p)), above:last>lh.p} : null,
    hl: hl ? {p:hl.p, pips:pips(Math.abs(last-hl.p)), above:last>hl.p} : null,
    events:events, latest:events[0]||null};
}

/* ── PRESSURE — runs every bar, waits for no pattern ─────────────── */
function readPressure(cd, frame){
  if(!frame.ok || !frame.decider || frame.dir === 'none')
    return {known:false, state:'none', score:0, note:'No deciding level while there is no trend.'};

  var lvl = frame.decider.p, a = cAtr(cd), n = cd.length;
  var upTrend = frame.dir === 'up', threatUp = !upTrend;
  var beyond = function(b){ return threatUp ? b.c > lvl : b.c < lvl; };
  var toward = function(b){ return threatUp ? b.c > b.o : b.c < b.o; };

  /* CLOSED BARS ONLY. The bar still forming counted as a close, so one
     closed bar plus a live one read as the two-bar hold. */
  var nC = n - 1;
  var firstBreach = -1;
  for(var i=Math.max(0,nC-25); i<nC; i++){ if(beyond(cd[i])){ firstBreach=i; break; } }
  var heldBars = 0, gaveBack = false;
  if(firstBreach >= 0){
    for(var k=firstBreach;k<nC;k++){
      if(beyond(cd[k])) heldBars++; else { gaveBack = true; heldBars = 0; }
    }
  }

  var run=0, runBody=0, runMove=0;
  for(var r=n-1; r>=0 && r>n-14; r--){
    if(!toward(cd[r])) break;
    run++; runBody += Math.abs(cd[r].c-cd[r].o);
  }
  if(run) runMove = Math.abs(cd[n-1].c - cd[n-run].o);
  var runWeight = a ? runMove/a : 0;

  var dist = Math.abs(cd[n-1].c - lvl), distA = a ? dist/a : 9;

  var tests=0, was=false;
  for(var q=Math.max(0,n-60); q<n; q++){
    var near = Math.abs(cd[q].h-lvl) < a*0.35 || Math.abs(cd[q].l-lvl) < a*0.35;
    if(near && !was) tests++;
    was = near;
  }

  var rv=0, bv=0, rc=0, bc=0;
  for(var v1=Math.max(0,n-5); v1<n; v1++){ rv += cd[v1].v||0; rc++; }
  for(var v2=Math.max(0,n-30); v2<n-5; v2++){ bv += cd[v2].v||0; bc++; }
  var volR = (bc && rc && bv) ? (rv/rc)/(bv/bc) : 1;

  /* DECAY is what gives the warning any lead. Proximity alone was a
     one-bar lead: it only happens once the break is arriving. */
  var decay = null;
  (function(){
    var pv = frame.pivots, legs=[], pulls=[];
    for(var z=1;z<pv.length;z++){
      var A=pv[z-1], B=pv[z];
      if(A.type===B.type) continue;
      var d=(B.p-A.p)/PIP;
      ((upTrend ? d>0 : d<0) ? legs : pulls).push(Math.abs(d));
    }
    if(legs.length<3 || pulls.length<2) return;
    var legMed=cMed(legs.slice(0,-1)), lastLeg=legs[legs.length-1];
    var pullMed=cMed(pulls.slice(0,-1)), lastPull=pulls[pulls.length-1];
    decay = {legRatio: legMed?lastLeg/legMed:1, pullRatio: pullMed?lastPull/pullMed:1};
  })();

  var score = 0;
  score += distA < 0.4 ? 14 : distA < 1.0 ? 9 : 0;
  score += run >= 5 ? 18 : run >= 3 ? 12 : run >= 2 ? 5 : 0;
  score += runWeight >= 1.5 ? 12 : runWeight >= 0.8 ? 7 : 0;
  score += tests >= 3 ? 14 : tests === 2 ? 8 : 0;
  score += volR >= 1.3 ? 8 : volR <= 0.7 ? -6 : 0;
  if(decay){
    score += decay.legRatio  < 0.55 ? 18 : decay.legRatio  < 0.8 ? 11 : 0;
    score += decay.pullRatio > 1.6  ? 16 : decay.pullRatio > 1.2 ? 9  : 0;
  }
  score = Math.max(0, Math.min(100, score));

  var state, note;
  if(firstBreach >= 0 && heldBars >= CONFIRM){
    state='broken';
    note='Price closed beyond the ' + frame.decider.name + ' at ' + lvl.toFixed(5) +
         ' and has held it for ' + heldBars + ' bars. By the 1-to-3 bar rule that is a reversal, not a pullback.';
  } else if(firstBreach >= 0 && heldBars > 0){
    state='breaking';
    note='Price has closed through the ' + frame.decider.name + ' at ' + lvl.toFixed(5) +
         ' but has only held it ' + heldBars + ' bar' + (heldBars===1?'':'s') + '. ' +
         (CONFIRM-heldBars) + ' more closing beyond it confirms the break.';
  } else if(firstBreach >= 0 && gaveBack){
    state='rejected';
    note='Price reached beyond the ' + frame.decider.name + ' and closed back inside. The level was defended — that is evidence FOR the trend, not against it.';
  } else if(score >= PRESS_WARN){
    state='pressing';
    note='The ' + frame.decider.name + ' at ' + lvl.toFixed(5) + ' is under real pressure: ' +
         run + ' straight ' + (threatUp?'bullish':'bearish') + ' closes, ' + tests + ' tests, price ' +
         pips(dist).toFixed(0) + ' pips away' +
         (decay ? ', impulses now ' + Math.round(decay.legRatio*100) + '% of their usual size and pullbacks ' +
                  Math.round(decay.pullRatio*100) + '%' : '') + '.';
  } else if(score >= PRESS_LEAN){
    state='leaning';
    note='Some pressure on the ' + frame.decider.name + ' — ' + run + ' straight closes toward it, ' +
         pips(dist).toFixed(0) + ' pips away. Not yet a threat to the trend.';
  } else {
    state='intact';
    note='The ' + frame.decider.name + ' at ' + lvl.toFixed(5) + ' is ' + pips(dist).toFixed(0) +
         ' pips away and under no real pressure.';
  }
  return {known:true, state:state, score:score, note:note, level:lvl, pipsAway:pips(dist),
          run:run, runWeight:runWeight, tests:tests, volR:volR, heldBars:heldBars, decay:decay,
          threatDir: threatUp?'up':'down', name:frame.decider.name};
}

/* ── ROTATION — what to say when there is no trend ───────────────── */
function readRotation(cd){
  var n = cd.length, a = cAtr(cd), look = Math.min(80, n), w = cd.slice(-look);
  var hi=-1e9, lo=1e9;
  w.forEach(function(b){ hi=Math.max(hi,b.h); lo=Math.min(lo,b.l); });
  var last = cd[n-1].c, width = hi-lo, pos = width ? (last-lo)/width : 0.5;
  var tHi=0, tLo=0, wH=false, wL=false;
  w.forEach(function(b){
    var nH = Math.abs(b.h-hi) < a*0.4, nL = Math.abs(b.l-lo) < a*0.4;
    if(nH && !wH) tHi++; if(nL && !wL) tLo++; wH=nH; wL=nL;
  });
  var lost = null;
  for(var back=4; back<=28; back+=4){
    if(n-back < 60) break;
    var f = readFrame(cd.slice(0, n-back));
    if(f.ok && f.dir !== 'none' && f.conf >= 0.6){
      lost = {dir:f.dir, barsAgo:back, level:f.decider?f.decider.p:null, name:f.decider?f.decider.name:null};
      break;
    }
  }
  return {ok:true, hi:hi, lo:lo, width:width, widthPips:pips(width), pos:pos,
          touches:tHi+tLo, tHi:tHi, tLo:tLo,
          near: pos>0.72?'the top':pos<0.28?'the bottom':'the middle',
          edgePips: pos>0.5 ? pips(hi-last) : pips(last-lo),
          alternating: tHi>=2 && tLo>=2, lost:lost};
}

/* ── AFTERMATH — what the reversal did next ──────────────────────── */
var AFT_MEMO = {};
function readAftermath(cd, key){
  var k = (key||'') + '|' + cd.length + '|' + (cd[cd.length-1].t||0);
  if(AFT_MEMO.k === k) return AFT_MEMO.v;
  var out = computeAftermath(cd);
  AFT_MEMO = {k:k, v:out};
  return out;
}
function computeAftermath(cd){
  var n = cd.length;
  if(n < 120) return {known:false};
  var old = null;
  for(var back=3; back<=AFTER_LOOK && n-back>=90; back+=3){
    var f = readFrame(cd.slice(0, n-back));
    if(f.ok && f.dir !== 'none' && f.conf >= 0.6 && f.decider){
      old = {dir:f.dir, level:f.decider.p, name:f.decider.name, at:n-back};
      break;
    }
  }
  if(!old) return {known:false};
  var threat = old.dir === 'up' ? 'down' : 'up';
  var beyond = function(b){ return threat==='up' ? b.c > old.level : b.c < old.level; };
  var inside = function(b){ return threat==='up' ? b.c < old.level : b.c > old.level; };

  var brokeAt=-1, held=0;
  for(var i=old.at;i<n;i++){
    if(beyond(cd[i])){ held++; if(held>=CONFIRM && brokeAt<0) brokeAt=i; }
    else held=0;
  }
  if(brokeAt<0) return {known:false};

  var since = n-1-brokeAt, a = cAtr(cd), ext = 0;
  for(var k2=brokeAt;k2<n;k2++){
    var d = threat==='up' ? cd[k2].h-old.level : old.level-cd[k2].l;
    if(d>ext) ext=d;
  }
  var nowBeyond = beyond(cd[n-1]);
  var backBars=0;
  for(var q=brokeAt;q<n;q++){ if(inside(cd[q])) backBars++; else backBars=0; }
  var resumed = backBars >= CONFIRM;

  var now = readFrame(cd);
  var newTrend = (now.ok && now.dir === threat  && now.conf >= 0.6);
  var oldTrend = (now.ok && now.dir === old.dir && now.conf >= 0.6);

  var state, note;
  if(resumed && oldTrend){
    state='failed';
    note='The reversal failed. Price closed back through ' + old.level.toFixed(5) + ' and structure reads ' +
         old.dir + ' again — the original ' + old.dir + 'trend is back in charge, ' + since + ' bars after it was supposedly broken.';
  } else if(resumed){
    state='givenback';
    note='The break has been given back. Price closed beyond ' + old.level.toFixed(5) +
         ' and has since closed back inside it, so the reversal did not hold. Structure has not re-established the old ' +
         old.dir + 'trend either — this is unresolved.';
  } else if(newTrend){
    state='established';
    note='The reversal has become a real ' + threat + 'trend. ' + since + ' bars since the break of ' +
         old.level.toFixed(5) + ', structure now reads ' + threat + ' at ' + Math.round(now.conf*100) + '% in its own right.';
  } else if(nowBeyond && ext > a*2){
    state='extending';
    note='The reversal is travelling — ' + pips(ext).toFixed(0) + ' pips beyond ' + old.level.toFixed(5) +
         ' in ' + since + ' bars, but structure has not yet printed enough swings the new way to call it a ' + threat + 'trend.';
  } else {
    state='stalled';
    note='The reversal has stalled. ' + since + ' bars since the break of ' + old.level.toFixed(5) +
         ' and price has gone ' + pips(ext).toFixed(0) + ' pips at best without building structure.';
  }
  return {known:true, state:state, note:note, oldDir:old.dir, newDir:threat,
          level:old.level, name:old.name, since:since, extPips:pips(ext), brokeAt:brokeAt,
          resumed:resumed, newTrend:newTrend, oldTrend:oldTrend};
}

/* ── REVERSAL PHASE — the reversal is a regime, not an event ─────── */
function readReversalPhase(cd, aft){
  if(!aft || !aft.known || aft.brokeAt == null) return {known:false};
  var start = Math.max(0, aft.brokeAt - 4), seg = cd.slice(start);
  if(seg.length < 10) return {known:false};
  var down = aft.newDir === 'down', a = cAtr(cd), n = seg.length, last = seg[n-1];

  var ext = down ? 1e9 : -1e9, extAt = 0;
  for(var i=0;i<n;i++){
    var v = down ? seg[i].l : seg[i].h;
    if(down ? v<ext : v>ext){ ext=v; extAt=i; }
  }
  var moved = Math.abs(ext - aft.level);
  var retracePct = moved ? (Math.abs(last.c-ext)/moved)*100 : 0;
  var barsSinceExt = n-1-extAt;

  var k = seg.length < 60 ? 2 : 3, pv = cPivots(seg, k), labs = [], band = a*0.25;
  for(var j=0;j<pv.length;j++){
    var prev=null;
    for(var q=j-1;q>=0;q--){ if(pv[q].type===pv[j].type){ prev=pv[q]; break; } }
    if(!prev) continue;
    var d = pv[j].p - prev.p;
    if(Math.abs(d) < band) labs.push(pv[j].type==='H'?'EQ-H':'EQ-L');
    else if(pv[j].type==='H') labs.push(d>0?'HH':'LH');
    else labs.push(d>0?'HL':'LL');
  }
  var agreeing = labs.filter(function(l){
    return down ? (l==='LL'||l==='LH') : (l==='HH'||l==='HL'); }).length;

  var net = Math.abs(last.c - seg[0].c), path = 0;
  for(var w=1;w<n;w++) path += Math.abs(seg[w].c - seg[w-1].c);
  var eff = path ? net/path : 0;

  var hi=-1e9, lo=1e9;
  seg.forEach(function(b){ hi=Math.max(hi,b.h); lo=Math.min(lo,b.l); });
  var tH=0, tL=0, wH=false, wL=false;
  seg.forEach(function(b){
    var nH=Math.abs(b.h-hi)<a*0.4, nL=Math.abs(b.l-lo)<a*0.4;
    if(nH&&!wH) tH++; if(nL&&!wL) tL++; wH=nH; wL=nL;
  });
  var alternating = tH>=2 && tL>=2, atExtreme = barsSinceExt <= 2;

  var phase, note;
  if(retracePct >= 62 && moved > a){
    phase='retracing deeply';
    note='The reversal has given back ' + Math.round(retracePct) + '% of its ' + pips(moved).toFixed(0) +
         ' pip move. Past about two thirds the move stops looking like a pullback inside the reversal.';
  } else if(retracePct >= 25 && moved > a*0.5){
    phase='retracing';
    note='The reversal is pulling back — ' + Math.round(retracePct) + '% of its ' + pips(moved).toFixed(0) +
         ' pip move given back over ' + barsSinceExt + ' bars. This is a retracement INSIDE the reversal, not the end of it.';
  } else if(atExtreme && eff >= 0.22){
    phase='travelling';
    note='The reversal is travelling — ' + pips(moved).toFixed(0) + ' pips from ' + aft.level.toFixed(5) +
         ', at its extreme now, covering ' + Math.round(eff*100) + '% of the ground it walks.';
  } else if(eff < 0.15 && alternating){
    phase='ranging';
    note='The reversal has gone sideways — price is rotating between ' + lo.toFixed(5) + ' and ' + hi.toFixed(5) +
         ' (' + tH + ' visits above, ' + tL + ' below) having moved ' + pips(moved).toFixed(0) +
         ' pips. Still the reversal, just resting inside it.';
  } else if(eff < 0.15){
    phase='chopping';
    note='The reversal is chopping — ' + Math.round(eff*100) + '% efficiency over ' + n +
         ' bars with no clean rotation. The move is still on, but nothing here is worth reading closely.';
  } else {
    phase='travelling';
    note='The reversal is working its way ' + aft.newDir + ' — ' + pips(moved).toFixed(0) +
         ' pips from ' + aft.level.toFixed(5) + ', ' + barsSinceExt + ' bars off its extreme.';
  }
  return {known:true, phase:phase, note:note, dir:aft.newDir, labels:labs.slice(-5),
          agreeing:agreeing, swings:labs.length, movedPips:pips(moved), retracePct:retracePct,
          eff:eff, alternating:alternating, hi:hi, lo:lo, barsSinceExt:barsSinceExt, bars:n, ext:ext};
}

/* ── CAUSE — the bar that turned the move ────────────────────────── */
function readCause(cd, ph, aft){
  if(!ph || !ph.known || !aft || !aft.known) return {known:false};
  var down = aft.newDir === 'down', n = cd.length;
  var ext = down ? 1e9 : -1e9, extI = -1;
  for(var i=Math.max(0,aft.brokeAt-4); i<n; i++){
    var v = down ? cd[i].l : cd[i].h;
    if(down ? v<ext : v>ext){ ext=v; extI=i; }
  }
  if(extI < 0 || extI >= n-1) return {known:false};

  var pre = cAtr(cd.slice(0, extI+1));
  var impI=-1, impMove=0;
  for(var k=extI; k<Math.min(n, extI+12); k++){
    var mv = down ? cd[k].c-cd[k].o : cd[k].o-cd[k].c;
    if(mv > impMove){ impMove=mv; impI=k; }
  }
  if(impI < 0 || !pre) return {known:false};

  var b = cd[impI], rng = b.h-b.l, body = Math.abs(b.c-b.o);
  var size = rng/pre, bodyShare = rng ? body/rng : 0;

  var hr = bwBarHourUTC(b), sameHour = [];
  if(hr != null) for(var q=Math.max(0,impI-240); q<impI; q++)
    if(bwBarHourUTC(cd[q]) === hr) sameHour.push(cd[q].v||0);
  var baseV = sameHour.length >= 4 ? cMed(sameHour)
            : cMed(cd.slice(Math.max(0,impI-30), impI).map(function(x){return x.v||0;}));
  var volR = baseV ? (b.v||0)/baseV : 1;

  var closedThrough = down ? b.c > aft.level : b.c < aft.level;
  var reachedOnly = !closedThrough && (down ? b.h > aft.level : b.l < aft.level);

  var obI=-1;
  for(var z=impI; z>=Math.max(0,impI-4); z--){
    var bull = cd[z].c > cd[z].o;
    if(down ? !bull : bull){ obI=z; break; }
  }
  var ob = null;
  if(obI >= 0){
    var last = cd[n-1].c, top = cd[obI].h, bot = cd[obI].l, spent = false;
    for(var y=impI+1; y<n; y++){
      if(down ? cd[y].c < bot : cd[y].c > top) spent = true;
    }
    ob = {top:top, bot:bot, at:obI, spent:spent, inside:last<=top&&last>=bot,
          pipsAway: pips(Math.min(Math.abs(last-top), Math.abs(last-bot))), barsAgo:n-1-obI};
  }

  var kind, note;
  if(size >= 1.8 && bodyShare >= 0.62 && volR >= 1.2){
    kind='displacement';
    note='The pullback was started by a real displacement bar — ' + size.toFixed(1) + '\u00d7 normal size, ' +
         Math.round(bodyShare*100) + '% body, ' + volR.toFixed(1) + '\u00d7 the volume that hour usually carries. ' +
         'A bar that closes where it went, on volume, is participation rather than noise.';
  } else if(size >= 1.8 && bodyShare < 0.4){
    kind='liquidity grab';
    note='The pullback was started by a large bar that gave most of its range back — ' + size.toFixed(1) +
         '\u00d7 normal size but only ' + Math.round(bodyShare*100) + '% body' +
         (volR>=1.3 ? ' on ' + volR.toFixed(1) + '\u00d7 volume' : '') +
         '. That shape reaches for orders and leaves; it is the least trustworthy way for a pullback to begin.';
  } else if(size >= 1.3 && volR < 0.8){
    kind='thin push';
    note='The pullback was started by a sizeable bar on ' + volR.toFixed(1) +
         '\u00d7 the usual volume for that hour. Size without participation tends not to carry.';
  } else {
    kind='drift';
    note='No single bar started this pullback — price drifted back over several ordinary candles (largest was ' +
         size.toFixed(1) + '\u00d7 normal). Drift retracements rarely mark a turn on their own.';
  }
  if(closedThrough) note += ' It closed back through ' + aft.level.toFixed(5) + ', the level the reversal broke.';
  else if(reachedOnly) note += ' It reached ' + aft.level.toFixed(5) + ' but closed back inside — the level held.';

  return {known:true, kind:kind, note:note, size:size, bodyShare:bodyShare, volR:volR,
          closedThrough:closedThrough, reachedOnly:reachedOnly, ob:ob,
          barsAgo:n-1-impI, hour:hr, at:impI};
}

/* ── THE COMBINED READ ───────────────────────────────────────────── */
function read(cd, opts){
  opts = opts || {};
  PIP = opts.pip || 0.0001;
  /* What the tab could not have watched live. Attached to every reading
     so no branch can quietly drop it. */
  var feed = {gap: opts.feedGap || null,
              missed: (opts.missed || []).slice(0, 8),
              ok: opts.feedOk !== false};
  if(!cd || cd.length < 60) return {ok:false, state:'unreadable', word:'Not enough history',
    line:'Only ' + ((cd&&cd.length)||0) + ' bars loaded so far. This is a limit of the data, not a reading of the market.'};

  var mandate = opts.mandate || null;
  var frame = applyMandate(readFrame(cd), mandate);
  /* ONE LEVEL, ONE DIRECTION, ACROSS BOTH TABS. The pullback engine
     already measures from structure's labelled higher low / lower high
     and switches to the new trend the moment a reversal is confirmed.
     This tab had its own copies of both — the most recent swing low on
     its own pivots (so a low inside a pullback became "the higher low"),
     and structure's direction, which lags a confirmed reversal by
     several bars. It now reads the pullback engine's answer when it has
     one for this pair and timeframe. */
  var pb = opts.pullback || null;
  if(pb && pb.ok && frame.ok && pb.trend && pb.brk && isFinite(pb.brk.level)){
    var pdir = pb.trend.dir > 0 ? 'up' : 'down';
    frame.dir = pdir;
    frame.conf = Math.max(frame.conf, 0.7);
    frame.fromPullback = true;
    frame.flipped = !!pb.trend.flipped;
    frame.decider = pdir === 'up'
      ? {name: 'last higher low', p: +pb.brk.level, dirIfBroken: 'down'}
      : {name: 'last lower high', p: +pb.brk.level, dirIfBroken: 'up'};
  }

  /* LAW: a suspended mandate withholds the right to ACT without
     taking the market from anyone. The readings still render. */
  var suspended = !!(mandate && mandate.suspended);

  /* ---- no trend: rotation / reversal aftermath ---- */
  if(!frame.ok || (frame.dir === 'none' && frame.conf >= 0.7)){
    if(!frame.ok) return {ok:false, state:'unreadable', word:'Not enough history', frame:frame,
      line:'Only ' + cd.length + ' bars so far — ' + (frame.why||'') + '. This is a limit of the data, not a reading of the market.'};

    var rot = readRotation(cd);
    var aft = readAftermath(cd, opts.key);
    var ph  = readReversalPhase(cd, aft);
    var cse = readCause(cd, ph, aft);
    var t2  = readTrigger(cd, opts.formations, opts.alerts, opts.raised);
    var pm2 = readPermission(cd, opts.liquidity);
    var tr2 = readTrust(cd, opts.risk);
    var w2, l2, sup2=[], con2=[], wk2=[];

    if(aft.known){
      w2 = aft.state==='failed'      ? 'Reversal failed — ' + aft.oldDir + 'trend resumed'
         : aft.state==='givenback'   ? 'Reversal given back'
         : aft.state==='established' ? 'Reversal became a ' + aft.newDir + 'trend'
         : ph.known                  ? 'Reversal — ' + ph.phase
         :                             'Reversal stalled';
      var episode = aft.state==='established' ? 'Structure now reads ' + aft.newDir + ' in its own right.'
                  : aft.state==='failed'      ? 'The original ' + aft.oldDir + 'trend is back in charge.'
                  : aft.state==='givenback'   ? 'Price has closed back inside ' + aft.level.toFixed(5) + ', so the break did not hold.'
                  : 'The break of ' + aft.level.toFixed(5) + ' was ' + aft.since + ' bars ago and has not been given back.';
      l2 = (ph.known ? ph.note + ' ' : '') + episode;
      if(cse.known) l2 += ' ' + cse.note;
      if(ph.known && ph.swings)
        sup2.push('The reversal has printed ' + ph.swings + ' swing' + (ph.swings===1?'':'s') +
          ' of its own — ' + ph.labels.join(' ') + ' — and ' + ph.agreeing + ' of them agree with the ' +
          ph.dir + ' direction. That is its structure, measured from the break rather than from the trend it replaced.');
      sup2.push('The broken level at ' + aft.level.toFixed(5) + ' is still the one that matters — it decides whether this becomes a ' +
        aft.newDir + 'trend or hands the market back to the ' + aft.oldDir + 'trend.');
    } else if(rot.lost){
      w2 = 'Reversed — the ' + rot.lost.dir + 'trend has gone';
      l2 = 'Structure read ' + rot.lost.dir + ' as recently as ' + rot.lost.barsAgo + ' bars ago' +
           (rot.lost.level ? ' with its ' + rot.lost.name + ' at ' + rot.lost.level.toFixed(5) : '') +
           ', and no longer does. Price is now rotating in a ' + rot.widthPips.toFixed(0) + ' pip band between ' +
           rot.lo.toFixed(5) + ' and ' + rot.hi.toFixed(5) + ', sitting near ' + rot.near +
           ' of it. Nothing built on that old ' + rot.lost.dir + 'trend is still true.';
    } else {
      w2 = 'Rotating, no trend';
      l2 = 'Price covered ' + Math.round(frame.effNow*100) + '% of the ground it travelled over the last 45 bars. ' +
           'It is rotating in a ' + rot.widthPips.toFixed(0) + ' pip band between ' + rot.lo.toFixed(5) +
           ' and ' + rot.hi.toFixed(5) + ', currently near ' + rot.near + ', ' + rot.edgePips.toFixed(0) + ' pips from that edge.';
    }

    if(rot.alternating)
      sup2.push('Both edges have been visited more than once (' + rot.tHi + ' at the top, ' + rot.tLo +
        ' at the bottom) — price is genuinely rotating, not drifting through.');
    else
      wk2.push('Only ' + rot.touches + ' edge visits so far, so treat these walls as provisional rather than established.');
    sup2.push('What would end this: a close beyond ' +
      (rot.pos > 0.5 ? rot.hi.toFixed(5) : rot.lo.toFixed(5)) + ' that holds for ' + CONFIRM + ' bars.');
    if(!pm2.ok) wk2.push('Participation is ' + pm2.state + ' during ' + pm2.sessions + '.');
    if(t2.any && t2.lead.hasRaised)
      sup2.push('The MT5 Assistant raised an alert on this one, on the same bar.');
    else if(t2.source === 'feed' || t2.source === 'feed+alert')
      sup2.push('This came from the EA\u2019s candlestick feed, the same one the Live tab reads.');
    else if(t2.source === 'local')
      wk2.push('The pattern feed had nothing fresh, so this was read from the candles here as a fallback \u2014 no alert was raised for it.');

    if(t2.any && t2.duplicated)
      wk2.push('Counted once, not ' + t2.lead.members.length + ' times: ' +
        t2.lead.members.map(function(m){return patName(m);}).join(', ') + ' are the same swings read several ways.');

    /* THE COMPARISON DOES NOT STOP BECAUSE THE TREND DID. */
    var ref2 = aft.known ? aft.newDir : null;
    var rel2=null, htf2=null, obl2=readBlocks(cd), sup2x=0, agrees=false;
    if(t2.any && ref2){
      rel2 = readReliability(cd, t2.lead.name, t2.lead.dir);
      htf2 = readHigher(cd, t2.lead.dir, opts.tf);
      agrees = t2.lead.dir === ref2;
      var lvlNear = Math.abs(cd[cd.length-1].c - (t2.lead.dir==='up' ? rot.lo : rot.hi)) < cAtr(cd)*0.6;
      sup2x = (t2.lead.conf/100) * (lvlNear?1.6:0.7) * rel2.mult * htf2.mult * obl2.mult * tr2.mult;

      if(agrees) sup2.push(patName(t2.lead) + ' points ' + t2.lead.dir +
        ', the same way as the move that broke the old ' + aft.oldDir + 'trend — it argues the reversal carries on.');
      else con2.push(patName(t2.lead) + ' points ' + t2.lead.dir +
        ', back toward the old ' + aft.oldDir + 'trend — it argues the reversal is being given back.');

      if(lvlNear) sup2.push('It fired at the ' + (t2.lead.dir==='up'?'bottom':'top') +
        ' of the band, which is where a rotation either turns or breaks.');
      else wk2.push('It fired in the middle of the band, away from either edge.');

      if(!rel2.thin && rel2.rate < 0.4) wk2.push('This pattern has a poor record here — ' + rel2.hits + ' of ' + rel2.n + '.');
      else if(!rel2.thin && rel2.rate >= 0.6) sup2.push('This pattern has worked ' + rel2.hits + ' of ' + rel2.n + ' times here.');
      if(htf2.known && htf2.mult < 1) con2.push(htf2.note);
      else if(htf2.known && htf2.mult > 1) sup2.push(htf2.note);
      if(obl2.any) (obl2.spent ? wk2 : sup2).push(obl2.note);

      if(cse.known && cse.ob){
        var o1 = cse.ob;
        if(o1.spent) wk2.push('The order block left by that bar (' + o1.bot.toFixed(5) + '\u2013' + o1.top.toFixed(5) +
          ') has already been traded through — it has been spent and is worth less now.');
        else if(o1.inside) sup2.push('Price is INSIDE the order block left by the bar that started this pullback (' +
          o1.bot.toFixed(5) + '\u2013' + o1.top.toFixed(5) + ', ' + o1.barsAgo + ' bars ago). This is where that move would be defended if it is going to be.');
        else sup2.push('The bar that started this pullback left an unspent order block at ' +
          o1.bot.toFixed(5) + '\u2013' + o1.top.toFixed(5) + ', ' + o1.pipsAway.toFixed(0) + ' pips away.');
        if(cse.kind === 'liquidity grab')
          con2.push('That order block came from a bar that reached and gave its range back, so treat the zone as a place orders were hunted rather than a place they were committed.');
      }

      l2 += ' ' + patName(t2.lead) + ' has fired pointing ' + t2.lead.dir + ', which ' +
            (agrees ? 'agrees with the reversal' : 'argues the reversal is being given back') +
            ', and carries ' + (sup2x*100).toFixed(0) + '% of the weight it would need — measured against the reversal, since there is no trend to measure it against.';
    }

    return {ok:true, feed:feed, state:'rotating', word:w2, line:l2, frame:frame, rot:rot, trig:t2,
            perm:pm2, trust:tr2, loc:null, pres:null, rel:rel2, htf:htf2, obl:obl2,
            support:sup2x, dir:(t2.any?t2.lead.dir:null), aft:aft, ph:ph, cse:cse, watch:readWatch(cd),
            suspended:suspended, supports:sup2, contradictions:con2, weakens:wk2};
  }

  /* ---- there is a trend ---- */
  var loc   = readLocation(cd, frame);
  var trig  = readTrigger(cd, opts.formations, opts.alerts, opts.raised);
  var perm  = readPermission(cd, opts.liquidity);
  var trust = readTrust(cd, opts.risk);
  var pres  = readPressure(cd, frame);
  var aft2  = readAftermath(cd, opts.key);
  var watch = readWatch(cd);
  var frameDir = frame.broken ? (frame.decider ? frame.decider.dirIfBroken : frame.dir) : frame.dir;

  /* THE STRUCTURAL EVENT OUTRANKS ANY CANDLE. */
  if(pres.known && (pres.state==='broken' || pres.state==='breaking' || pres.state==='pressing')){
    var threat = pres.threatDir, sup=[], con=[];
    if(pres.run >= 3) sup.push(pres.run + ' straight ' + (threat==='up'?'bullish':'bearish') +
      ' closes into the level, worth ' + pres.runWeight.toFixed(1) + '\u00d7 a normal bar range — no pattern name, but it is the clearest thing on the chart.');
    if(pres.tests >= 2) sup.push('The level has been tested ' + pres.tests +
      ' times in the last 60 bars. A level tested repeatedly is being worn down, not defended.');
    if(pres.volR >= 1.2) sup.push('Volume behind the push is ' + pres.volR.toFixed(2) + '\u00d7 recent.');
    else if(pres.volR <= 0.8) con.push('Volume behind the push is only ' + pres.volR.toFixed(2) + '\u00d7 recent — the move lacks participation.');
    if(!perm.ok) con.push('Participation is ' + perm.state + ' during ' + perm.sessions + '.');
    if(trust.mult < 1) con.push(trust.note + '.');
    if(trig.any && trig.lead.dir !== threat)
      con.push(patName(trig.lead) + ' has fired ' + trig.lead.dir + ', agreeing with the ' + frame.dir +
        'trend that is under pressure. That is the trap this reading exists for: the signal looks right, but the trend it agrees with is the thing being questioned.');
    else if(trig.any) sup.push(patName(trig.lead) + ' fired the same way as the pressure.');

    var pw, pl, pstate;
    if(pres.state === 'broken'){
      pstate='broken';
      pw='Reversal confirmed — the ' + frame.dir + 'trend has ended';
      pl=pres.note + ' The move against the old ' + frame.dir + 'trend is now the reading that counts, and anything built on that ' +
         frame.dir + 'trend is out of date. A confirmed break is not a forecast: measured on ten years of data, price continued in the break direction about a third of the time over the following eight bars.';
    } else if(pres.state === 'breaking'){
      pstate='breaking';
      pw='Reversal underway — not yet confirmed';
      pl=pres.note + ' Until it holds, this is still the kind of break that gets given back.';
    } else {
      pstate='pressing';
      pw='Reversal risk — the ' + frame.dir + 'trend is under pressure';
      pl=pres.note + ' Nothing has reversed yet. Measured on ten years across four pairs, a warning like this precedes a confirmed reversal about a third of the time — it is a reason to watch the level, not a reason to act.';
    }
    return {ok:true, feed:feed, state:pstate, word:pw, line:pl, frame:frame, loc:loc, trig:trig, perm:perm,
            trust:trust, pres:pres, aft:aft2, rel:null, htf:readHigher(cd, threat, opts.tf),
            obl:readBlocks(cd), watch:watch, dir:threat, supports:sup, contradictions:con, weakens:[],
            suspended:suspended, pressureLed:true};
  }

  if(!trig.any){
    /* NO TRIGGER IS NOT NOTHING. There is always a structural fact, a
       nearest level, a book and a clock. Report them. */
    var wq = readWatch(cd);
    var obq = readBlocks(cd);
    var sq = [], wkq = [];
    var head, body;

    /* A SWING INSIDE A PULLBACK IS NOT THE TREND'S LEVEL. With a known
       trend, crossing one of the smaller swings printed inside the
       pullback was announced as "the last higher low has been broken —
       structure has no confident direction" while the level that actually
       defines the trend was still holding. Say what it is. */
    /* Only a crossing AGAINST the trend is a pullback event; a close below a
       swing low in a downtrend is the trend continuing. */
    var againstTrend = wq.known && wq.latest && ((frame.dir==='up' && wq.latest.dir==='down') || (frame.dir==='down' && wq.latest.dir==='up'));
    var withTrendEv = wq.known && wq.latest && wq.latest.barsAgo <= 12 && frame.dir !== 'none' && !againstTrend;
    var minorEv = againstTrend && wq.latest.barsAgo <= 12 && frame.decider &&
                  Math.abs(wq.latest.p - frame.decider.p) > cAtr(cd) * 0.15;
    if(minorEv){
      var mv = wq.latest, dg = PIP < 0.001 ? 5 : PIP < 0.05 ? 3 : 2;
      head = 'Pullback inside the ' + frame.dir + 'trend';
      body = 'Price closed ' + (mv.dir==='up'?'above':'below') + ' a swing ' + (mv.dir==='up'?'high':'low') + ' at ' + mv.p.toFixed(dg) +
             ' that formed inside this pullback. The ' + frame.decider.name + ' that defines the ' + frame.dir + 'trend is ' +
             frame.decider.p.toFixed(dg) + ', ' + pips(Math.abs(cd[cd.length-1].c - frame.decider.p)).toFixed(0) +
             ' pips away, and it is still holding \u2014 so nothing has reversed.';
      sq.push('The level that decides it is ' + frame.decider.p.toFixed(dg) + ': two closes beyond it would be the reversal.');
    } else if(wq.known && wq.latest && wq.latest.barsAgo <= 12 && !withTrendEv){
      var ev = wq.latest;
      head = 'The ' + ev.which + ' has been broken';
      body = 'Price closed ' + (ev.dir==='up'?'above':'below') + ' the ' + ev.which + ' at ' +
             ev.p.toFixed(5) + ' ' + (ev.barsAgo===0?'on this bar':ev.barsAgo + ' bars ago') +
             (ev.held ? ' and is still beyond it' : ' and has since closed back inside it') +
             '. Structure has no confident direction' +
             (frame.last4 && frame.last4.length ? ' — the swings read ' + frame.last4.join(' ') : '') +
             ', so this is a structural event without a trend behind it yet. ' +
             (ev.held ? 'What would settle it: swings printing ' + (ev.dir==='up'?'HH and HL':'LH and LL') +
                        ' from here, which is what turns a break into a trend.'
                      : 'A break given straight back is the level being defended, not lost.');
      sq.push('The level that broke is ' + ev.p.toFixed(5) + ' — it is the reference for everything that follows.');
    } else if(frame.dir === 'none'){
      head = 'No trend — watching the levels';
      body = 'Structure has no confident direction' +
             (frame.last4 && frame.last4.length ? ' (swings read ' + frame.last4.join(' ') + ')' : '') +
             ' and no trigger has printed in the last four bars. ' +
             (wq.known
               ? 'The levels that decide the next move are ' +
                 (wq.lh ? 'the last lower high at ' + wq.lh.p.toFixed(5) + ' (' + wq.lh.pips.toFixed(0) + ' pips ' + (wq.lh.above?'below':'above') + ')' : '') +
                 (wq.lh && wq.hl ? ' and ' : '') +
                 (wq.hl ? 'the last higher low at ' + wq.hl.p.toFixed(5) + ' (' + wq.hl.pips.toFixed(0) + ' pips ' + (wq.hl.above?'below':'above') + ')' : '') +
                 '. A close through either is the next thing worth knowing.'
               : 'Not enough swings yet to name the levels that matter.');
    } else {
      head = (pres.known && pres.state==='leaning') ? 'Watching the level' : 'Nothing has fired';
      body = (frame.flipped ? 'The trend reversed to ' + frame.dir + ' and is being measured as a ' + frame.dir + 'trend (structure relabels once its new swing forms)'
                            : 'Structure reads ' + frameDir + ' at ' + Math.round(frame.conf*100) + '%') + ' and no trigger has printed in the last four bars. ' +
             (pres.known ? pres.note + ' ' : '') +
             (frame.decider ? 'The ' + frame.decider.name + ' at ' + frame.decider.p.toFixed(5) +
                ' is what to watch — a close through it changes the frame itself.' : '');
    }

    if(loc && loc.atLevel) sq.push('Price is sitting at ' + loc.kind + ', ' + loc.pipsAway.toFixed(1) +
      ' pips away — whatever fires here counts for more than the same thing in open space.');
    if(obq.any && !obq.spent) sq.push(obq.note);
    else if(obq.any && obq.spent) wkq.push(obq.note);
    if(!perm.ok) wkq.push('Participation is ' + perm.state + ' during ' + perm.sessions + '.');
    else sq.push('Participation is ' + perm.state + ' during ' + perm.sessions + ' — a move from here has something behind it.');
    if(trust.mult < 1) wkq.push(trust.note + '.');

    return {ok:true, feed:feed, state:'quiet', frame:frame, loc:loc, trig:trig, perm:perm, trust:trust,
      rel:null, htf:readHigher(cd, frameDir, opts.tf), obl:obq, pres:pres, aft:aft2, watch:wq,
      suspended:suspended, supports:sq, contradictions:[], weakens:wkq,
      word: head, line: body};
  }

  var dir = trig.lead.dir, withFrame = (dir === frameDir), burden = withFrame ? 1 : 3;
  var contradictions=[], supports=[], weakens=[];
  var rel = readReliability(cd, trig.lead.name, dir);
  var htf = readHigher(cd, dir, opts.tf);
  var obl = readBlocks(cd);

  if(frame.broken){
    burden = 1;
    supports.push('Price closed beyond the ' + frame.decider.name + ' — the frame itself has changed, so this is no longer a signal against the trend.');
  }
  var locMult = loc.atLevel ? 1.7 : 0.65;
  var support = ((trig.lead.conf/100) * locMult * rel.mult * htf.mult * obl.mult / burden) * trust.mult;

  if(withFrame) supports.push('The trigger points the same way as structure on this timeframe.');
  else if(!frame.broken && frame.dir === 'none')
    weakens.push('Structure has no direction here, so there is no trend for this to agree or disagree with — it stands on its own.');
  else if(!frame.broken)
    contradictions.push('Structure still reads ' + frame.dir + ' — the ' + (frame.decider?frame.decider.name:'deciding level') +
      ' has not been closed through, so this trigger is arguing against the market it sits in.');

  if(aft2.known && aft2.state==='established' && aft2.newDir===frame.dir)
    supports.push('This ' + frame.dir + 'trend is itself the reversal of an earlier ' + aft2.oldDir + 'trend, ' +
      aft2.since + ' bars ago at ' + aft2.level.toFixed(5) + '. It has earned its own structure since.');
  if(aft2.known && aft2.state==='failed' && aft2.oldDir===frame.dir)
    supports.push('This ' + frame.dir + 'trend survived a break ' + aft2.since + ' bars ago at ' +
      aft2.level.toFixed(5) + ' that did not hold — a level that failed to reverse it is evidence it is strong.');

  if(loc.atLevel) supports.push('It fired at ' + loc.kind + ', ' + loc.pipsAway.toFixed(1) + ' pips away.');
  else weakens.push('It fired in open space, ' + loc.pipsAway.toFixed(1) + ' pips from the nearest level — nothing structural is defending it.');

  if(trig.lead.hasRaised)
    supports.push('The MT5 Assistant raised an alert on this one, on the same bar — so the trader has already been told. It is the same event, not a second confirmation.');
  else if(trig.source === 'feed' || trig.source === 'feed+alert')
    supports.push('This came from the EA\u2019s candlestick feed (/api/patterns), the same one the Live tab reads \u2014 so this tab and the pattern list cannot disagree about what fired. No Assistant alert is recorded on this bar.');
  else if(trig.source === 'alert')
    supports.push('This came from the Assistant\u2019s alert history, matched to the bar by its timestamp.');
  else if(trig.source === 'local')
    weakens.push('The pattern feed had nothing fresh, so this was read from the candles here as a fallback. It is a real detection, but it did not come from the EA and no alert was raised for it.');

  if(trig.duplicated)
    weakens.push('Counted once, not ' + trig.lead.members.length + ' times: ' +
      trig.lead.members.map(function(m){return patName(m);}).join(', ') +
      ' are the same swings read several ways, not separate confirmations.');

  if(!rel.thin){
    if(rel.rate < 0.4) weakens.push('This pattern has a poor record here — ' + rel.hits + ' of ' + rel.n + '.');
    else if(rel.rate >= 0.6) supports.push('This pattern has worked ' + rel.hits + ' of ' + rel.n + ' times here.');
  }
  if(htf.known && htf.mult < 1) contradictions.push(htf.note);
  else if(htf.known && htf.mult > 1) supports.push(htf.note);
  if(obl.any && !obl.spent) supports.push(obl.note);
  else if(obl.any && obl.spent) weakens.push(obl.note);
  if(!perm.ok) weakens.push('Participation is ' + perm.state + ' at ' + perm.score +
    ' during ' + perm.sessions + ' — a move from here has little behind it.');
  else supports.push('Participation is ' + perm.state + ' during ' + perm.sessions + '.');
  if(trust.mult < 1) weakens.push(trust.note + '.');

  var travel = travelStats(cd, frame, dir);
  var state, word, line, opposed = contradictions.length;

  if(!perm.ok && support >= 0.55){
    state='nopermission'; word='Direction yes, fuel no';
    line='The evidence points ' + dir + ' and structure does not fight it, but participation is ' +
         perm.state + '. Moves that start here usually stall.';
  } else if(opposed === 0 && support >= 0.8){
    state='aligned'; word = dir==='up' ? 'Everything points up' : 'Everything points down';
    line='Nothing reads against this. ' +
         (weakens.length ? weakens.length + ' reading' + (weakens.length===1?'':'s') +
           ' below make it less emphatic, but none of them point the other way. ' : '') +
         (frame.decider ? 'This stops being true if price closes back through ' + frame.decider.p.toFixed(5) + '.' : '');
  } else if(opposed === 0){
    state='thin';
    word = withFrame ? 'With the trend, but thin' : 'Nothing against it, but thin';
    line = patName(trig.lead) + ' points ' + dir + (withFrame ? ', the same way as the ' + frame.dir + 'trend' : '') +
           ', and NOTHING reads against it. It carries ' + (support*100).toFixed(0) +
           '% of the weight it would need to stand on its own — the readings below weaken it, they do not contradict it.';
  } else {
    state='conflicted';
    /* SAY WHAT IT SUPPORTS FIRST. */
    word = opposed >= 2 ? (withFrame ? 'With the trend, but do not trust it' : 'Do not trust this')
                        : (withFrame ? 'With the trend, but something reads against it' : 'Something reads against it');
    var opened = patName(trig.lead) + ' has fired ' +
                 (trig.barsAgo===0 ? 'on this bar' : trig.barsAgo + ' bars ago') + ' pointing ' + dir + '. ';
    if(withFrame)
      opened += 'That agrees with the ' + frame.dir + 'trend' +
        (frame.decider ? ', whose ' + frame.decider.name + ' at ' + frame.decider.p.toFixed(5) + ' is still holding' : '') + ', and ';
    else
      opened += 'Structure reads ' + frame.dir + ', so it is arguing against the market it sits in, and ';
    line = opened + opposed + ' reading' + (opposed===1?'':'s') + ' below point' + (opposed===1?'s':'') +
           ' the other way. It carries ' + (support*100).toFixed(0) + '% of the weight it would need' +
           (withFrame ? ' — the agreement is real, the objection is what stops it being enough.' : '.');
  }

  return {ok:true, feed:feed, state:state, word:word, line:line, frame:frame, loc:loc, trig:trig, perm:perm,
          trust:trust, rel:rel, htf:htf, obl:obl, pres:pres, aft:aft2, watch:watch, dir:dir, withFrame:withFrame,
          burden:burden, support:support, suspended:suspended,
          contradictions:contradictions, weakens:weakens, supports:supports, travel:travel, frameDir:frameDir};
}

function travelStats(cd, frame, dir){
  if(!frame.ok) return null;
  var pv = frame.pivots, legs = [];
  for(var i=1;i<pv.length;i++){
    var a=pv[i-1], b=pv[i];
    if(a.type===b.type) continue;
    var d = pips(b.p-a.p);
    if(dir==='up' && d>0) legs.push(d);
    if(dir==='down' && d<0) legs.push(-d);
  }
  if(legs.length < 4) return {thin:true, n:legs.length};
  var s = legs.slice().sort(function(a,b){return a-b;});
  return {thin:false, n:legs.length, med:cMed(legs),
          p25:s[Math.floor(s.length*0.25)], p75:s[Math.floor(s.length*0.75)]};
}

root.BWConfluence = {read:read, patName:patName, CONFIRM:CONFIRM, PRESS_WARN:PRESS_WARN};
})(typeof window!=='undefined'?window:this);
