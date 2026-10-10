/* arbiter-group.js — how open positions become BOXES and VERDICTS, and how each verdict is judged.
   SHARED by the page (arbiter.html) and the server (server-side judging, SJ-2), so both group and judge
   the same way. Every function below was MOVED here word for word from arbiter.html; judgeBoxes is the
   page's own judging loop. Nothing about the grouping changed in the move. */
(function (root) {
'use strict';
/* the engine, found WHEN USED (not once at load): in the page and the server's sandbox it is the global;
   under Node it is loaded directly — never a silent fallback to the wrong answer */
function eng(){ var e = root.BWArbiterEngine || (typeof module !== 'undefined' && typeof require === 'function' ? require('./arbiter-engine.js') : null);
  if(!e) throw new Error('arbiter-group.js: the engine is not loaded'); return e; }

function lvlKey(p){
  var r = function(x){ return x == null ? 'none' : Number(x).toFixed(5); };
  return r(p.sl)+'|'+r(p.tp);
}
function boxKey(r){
  var p = r.position;
  /* ONE box per pair and direction, WHATEVER the lot sizes (Assan: 10 lots + 5 lots on one pair are one box —
     "it will make things simple"). Inside the box, legs still group by their LEVELS (books and own-level legs). */
  return r.world.symbol+'|'+p.side;
}
function bookPosition(legs){
  var vol = legs.reduce(function(a,r){ return a + (Number(r.position.volume)||0); }, 0);
  var wsum = legs.reduce(function(a,r){ return a + (Number(r.position.openPrice)||0) * (Number(r.position.volume)||0); }, 0);
  var first = legs[0].position;
  var entry = vol ? wsum / vol : first.openPrice;
  /* the PAIR's pip (the engine's own lookup: 0.01 on JPY pairs, 0.1 on gold, index points…). It read
     legs[0].world.pip — which no world has — so EVERY book fell back to 0.0001: right on EURUSD by luck,
     100x wrong on GBPJPY (Assan: -1.2 pips read as -120 → "100% of the stop used", "6416% handed back",
     a false CUT), 1000x on gold. */
  var pip = eng().pipSizeFor(legs[0].world.symbol);
  var price = legs[0].world.price;
  var sign = first.side === 'buy' ? 1 : -1;
  return Object.assign({}, first, {
    ticket: first.ticket, volume: Math.round(vol * 100) / 100, openPrice: entry,
    floatingPips: price != null ? sign * (price - entry) / pip : first.floatingPips,
    profit: legs.reduce(function(a,r){ return a + (Number(r.position.profit)||0); }, 0),
    // null when no leg has an excursion — Math.max of nothing is -Infinity,
    // which would poison the "where it has been" meter
    mfePips: (function(){ var v = legs.map(function(r){ return r.position.mfePips; }).filter(function(x){ return x != null; });
      return v.length ? Math.max.apply(null, v) : null; })(),
    maePips: (function(){ var v = legs.map(function(r){ return r.position.maePips; }).filter(function(x){ return x != null; });
      return v.length ? Math.min.apply(null, v) : null; })(),
    riskPct: legs.reduce(function(a,r){ return a + (Number(r.raw && r.raw.riskPct)||0); }, 0)
  });
}
function groupPositions(out){
  var boxes = {}, order = [];
  out.forEach(function(r){
    var k = boxKey(r);
    if(!boxes[k]){ boxes[k] = { key:k, sym:r.world.symbol, side:r.position.side,
      volume:r.position.volume, legs:[], world:r.world }; order.push(k); }
    boxes[k].legs.push(r);
  });
  /* the box's lots: the TOTAL, and each leg's size (they can differ now) */
  order.forEach(function(k){ var b = boxes[k];
    b.lots = b.legs.map(function(r){ return Number(r.position.volume) || 0; });
    b.volume = Math.round(b.lots.reduce(function(a, v){ return a + v; }, 0) * 100) / 100; });
  return order.map(function(k){
    var b = boxes[k];
    var sets = {}, sorder = [];
    b.legs.forEach(function(r){ var lk = lvlKey(r.position);
      if(!sets[lk]){ sets[lk] = []; sorder.push(lk); } sets[lk].push(r); });
    b.verdicts = sorder.map(function(lk, i){
      var legs = sets[lk];
      return { legs: legs, levels: lk, own: sorder.length > 1,
               // one leg, or a book of legs sharing levels — judged the same way either way
               lead: legs[0], position: legs.length > 1 ? bookPosition(legs) : legs[0].position,
               judgement: legs.length > 1 ? null : legs[0].judgement };
    });
    b.mixed = b.verdicts.length > 1;
    return b;
  });
}
function markSameEvents(boxes){
  var items = [], byId = {};
  boxes.forEach(function(b, bi){ b.verdicts.forEach(function(v, vi){
    var j = v.judgement; if(!j) return; j.sameEvent = null;
    var w = v.legs[0].world, rc = j.pressure && j.pressure.reversal, bc = rc && rc.breakCase;
    var bar = bc && bc.breakAt != null ? (w.candles || [])[bc.breakAt] : null;
    var id = bi + ':' + vi; byId[id] = j;
    items.push({ id: id, symbol: w.symbol, dir: j.direction, breakT: bar ? bar.t : null, closes: w.closes || [],
      risk: v.legs.reduce(function(a, r){ return a + (Number(r.raw && r.raw.riskPct) || 0); }, 0) });
  }); });
  var ev = eng().sameEvents(items, function(A, B){ return pearson(A.closes, B.closes); });
  Object.keys(ev).forEach(function(id){ byId[id].sameEvent = ev[id]; });
}
function pearson(a, b){
  var n = Math.min(a.length, b.length);
  if(n < 30) return null;
  var x = [], y = [];
  for(var i = a.length - n + 1; i < a.length; i++) x.push(Math.log(a[i] / a[i-1]));
  for(var j = b.length - n + 1; j < b.length; j++) y.push(Math.log(b[j] / b[j-1]));
  var m = Math.min(x.length, y.length); x = x.slice(-m); y = y.slice(-m);
  var mx = x.reduce(function(p,q){return p+q;},0)/m, my = y.reduce(function(p,q){return p+q;},0)/m;
  var sxy = 0, sxx = 0, syy = 0;
  for(var k = 0; k < m; k++){ var dx = x[k]-mx, dy = y[k]-my; sxy += dx*dy; sxx += dx*dx; syy += dy*dy; }
  if(!sxx || !syy) return null;
  return { r: sxy / Math.sqrt(sxx * syy), bars: m };
}

/* the page's judging loop (DEC-18, CX-14): each VERDICT judged ONCE — a lone leg as itself, a book of legs
   sharing levels as one — through the same anti-flicker, keyed exactly as before; every leg then carries
   its verdict's judgement. Then the same-event links (DEC-15). */
function judgeBoxes(boxes, stabiliser){
  boxes.forEach(function(b){
    b.verdicts.forEach(function(v, vi){
      if(v.legs.length === 1){
        var r1 = v.legs[0];
        var j = eng().judgePosition(r1.world, r1.position);
        j.settled = stabiliser.settle(r1.key, j.action);
        v.judgement = j;
      } else {
        var lead = v.lead;
        var bj = eng().judgePosition(lead.world, Object.assign({}, v.position, { entryCase: lead.position.entryCase }));
        bj.settled = stabiliser.settle('box:'+b.key+':'+vi, bj.action);
        v.judgement = bj;
      }
      v.legs.forEach(function(r){ r.judgement = v.judgement; });
    });
  });
  markSameEvents(boxes);
  return boxes;
}

/* SJ-3: WHAT to record for a leg — the page's proposeLive rules, moved here so the page and the server
   decide identically. A call only when the leg's SETTLED action changes; never a HOLD at first sight.
   `shown` is the caller's memory of the last action shown per leg (the page's, or the server's). */
function liveProposal(key, res, shown){
  var a = res.judgement.settled.action.key, prev = shown[key];
  shown[key] = a;
  if(prev === a) return null;
  if(prev === undefined && a === 'hold') return null;
  var p = res.position;
  return { key: 'live:'+key+':'+a, body: { kind:'live', symbol:p.rawSymbol || p.symbol, direction:res.judgement.direction,
    ticket:p.ticket, action:a, score:res.judgement.settled.action.pressure,
    snapshot:{ volume:p.volume, openPrice:p.openPrice, sl:p.sl,
               pillars:res.judgement.pillars.map(function(x){ return { id:x.id, now:x.now, change:x.change }; }),
               pressure:res.judgement.pressure, impliedTarget:!!(res.judgement.target&&res.judgement.target.implied),
               event: res.judgement.sameEvent ? res.judgement.sameEvent.key : null,
               // R-2 / G-2: which route decided — read from the LIVE judgement when it agrees with the settled call
               route: (res.judgement.action && res.judgement.action.key === a) ? (res.judgement.action.route || null)
                      : (res.judgement.settled.action.route || null),
               stage: (res.judgement.action && res.judgement.action.key === a) ? (res.judgement.action.stage || null)
                      : (res.judgement.settled.action.stage || null) } } };
}

root.BWArbiterGroup = { liveProposal: liveProposal, lvlKey: lvlKey, boxKey: boxKey, bookPosition: bookPosition, groupPositions: groupPositions,
                        markSameEvents: markSameEvents, pearson: pearson, judgeBoxes: judgeBoxes };
if (typeof module !== 'undefined' && module.exports) module.exports = root.BWArbiterGroup;
})(typeof window !== 'undefined' ? window : globalThis);
