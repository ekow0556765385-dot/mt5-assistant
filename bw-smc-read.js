/* bw-smc-read.js — THE ONE SMC READER for the SMC Panel and the Trading Brain.
   Both modules load this file and draw every SMC answer from it, so they can
   never disagree. It does not detect anything: the EA's shared SMC engine
   (BLACKWOOD SMC ENGINE v3, identical in the EA and the SMC indicator) has
   already found the zones, the structure and the sweep states. This only
   arranges that answer for one pair + timeframe:
     zones      every live order block / FVG, plus every block price has come
                into, each with ONE state and the engine's message
     structure  BOS / CHoCH, newest first
     bias       ONE rule: the direction of the most recent break
     nearest    the nearest zone that is still in play
     balance    live demand vs supply
     sweep      the single most important sweep state, for banners and badges
   Served by the server at /bw-smc-read.js. Change it here, never in a module. */
(function(root){
  'use strict';
  var STATES = {
    approaching:{label:'Approaching',     ui:'warning',  rank:4, inPlay:true },
    'in-zone':  {label:'In the zone',     ui:'warning',  rank:3, inPlay:true },
    sweeping:   {label:'Sweeping (live)', ui:'swept',    rank:0, inPlay:true },
    confirmed:  {label:'Swept & reclaimed',ui:'confirmed',rank:1, inPlay:true },
    broken:     {label:'Failed',          ui:'spent',    rank:2, inPlay:false},
    reacted:    {label:'Entry passed',    ui:'spent',    rank:5, inPlay:false},
    live:       {label:'Live',            ui:'live',     rank:6, inPlay:true },
    waiting:    {label:'Untouched',       ui:'live',     rank:7, inPlay:true }
  };
  function dirOf(s){ return /bear/i.test(String(s||'')) ? 'bear' : 'bull'; }
  function num(x){ var v=parseFloat(x); return isFinite(v)?v:NaN; }
  function key(lo,hi){ return (+lo).toFixed(6)+'|'+(+hi).toFixed(6); }
  /* EA times are broker wall-clock "YYYY.MM.DD HH:MM" */
  function timeOf(s){ if(s==null||s==='') return NaN; if(typeof s==='number') return s>1e12?s/1000:s;
    var m=String(s).match(/(\d{4})\D(\d{2})\D(\d{2})\D+(\d{2}):(\d{2})/); return m?Date.UTC(+m[1],m[2]-1,+m[3],+m[4],+m[5])/1000:NaN; }

  function read(node, opt){
    opt = opt || {};
    var tf = opt.tf || (node && node.timeframe) || 'H1';
    var pip = opt.pip || 0.0001, price = num(opt.price);
    if(!isFinite(price) && node) price = num(node.price);
    var out = { tf:tf, ok:!!node, price:price, zones:[], structure:[], bias:{dir:'none',text:'No structure on '+tf+' yet'},
                nearest:null, balance:{demand:0,supply:0}, sweeps:[], sweep:null, hasEngine:!!(node&&Array.isArray(node.sweeps)) };
    if(!node) return out;

    /* sweep states first — they say what price has DONE at each block */
    var byKey = {};
    (node.sweeps||[]).forEach(function(w){
      var lo=num(w.low), hi=num(w.high); if(!isFinite(lo)||!isFinite(hi)) return;
      var st = STATES[w.state] ? w.state : null; if(!st) return;
      /* in-zone means price is inside the block NOW — older EA builds kept it for 8 candles after price left */
      if(st==='in-zone' && isFinite(price) && (price<Math.min(lo,hi) || price>Math.max(lo,hi))) return;
      var s = { kind:'ob', dir:dirOf(w.direction), lo:Math.min(lo,hi), hi:Math.max(lo,hi), at:w.timeStart||null,
                state:st, label:STATES[st].label, ui:STATES[st].ui, msg:w.message||'', stop:num(w.stop)||null,
                eventAt:w.time||null, tf:tf, fromSweep:true };
      out.sweeps.push(s); byKey[key(s.lo,s.hi)] = s;
    });
    /* live order blocks the engine still counts as unspent */
    (node.orderBlocks||node.order_blocks||[]).forEach(function(o){
      var lo=num(o.low), hi=num(o.high); if(!isFinite(lo)||!isFinite(hi)) return;
      var k=key(Math.min(lo,hi),Math.max(lo,hi)); if(byKey[k]) return;   // already carried by its sweep state
      out.zones.push({ kind:'ob', dir:dirOf(o.direction||o.type), lo:Math.min(lo,hi), hi:Math.max(lo,hi), at:o.timeStart||o.time||null,
                       state:'waiting', label:STATES.waiting.label, ui:'live', msg:'Untouched — price has not come back to it yet.', tf:tf });
    });
    out.sweeps.forEach(function(s){ out.zones.push(s); });
    (node.fvgs||node.fvg||[]).forEach(function(f){
      var lo=num(f.low), hi=num(f.high); if(!isFinite(lo)||!isFinite(hi)) return;
      out.zones.push({ kind:'fvg', dir:dirOf(f.direction||f.type), lo:Math.min(lo,hi), hi:Math.max(lo,hi), at:f.timeStart||f.time||null,
                       state:'live', label:'Unfilled', ui:'live', msg:'Unfilled gap — price has not retraced half way into it.', tf:tf });
    });
    out.zones.forEach(function(z){
      z.spent = !STATES[z.state].inPlay;
      z.away  = !isFinite(price) ? Infinity : (price>=z.lo && price<=z.hi) ? 0 : (price>z.hi ? price-z.hi : z.lo-price)/pip;
      z.t     = timeOf(z.at);
    });

    /* structure, newest first, and ONE bias rule: the most recent break */
    out.structure = (node.structure||[]).map(function(s){
      var t=String(s.type||'').toUpperCase();
      return { kind: t.indexOf('CHOCH')>=0?'CHoCH':t.indexOf('BOS')>=0?'BOS':(t||'—'),
               dir: t.indexOf('BEAR')>=0?'bear':t.indexOf('BULL')>=0?'bull':'none',
               level:num(s.level), breach:num(s.breach), at:s.time||null, from:s.from||null, t:timeOf(s.time) };
    }).filter(function(x){ return isFinite(x.level); }).sort(function(a,b){ return (b.t||0)-(a.t||0); });
    var last = out.structure[0];
    if(last && last.dir!=='none'){
      out.bias = { dir:last.dir, kind:last.kind, level:last.level, at:last.at,
                   text: (last.dir==='bull'?'Bullish':'Bearish') + ' — the last ' + tf + ' break was a ' + last.kind + ' ' +
                         (last.dir==='bull'?'up':'down') + (last.kind==='CHoCH'?' (the trend turned)':' (the trend continued)') };
    }

    /* nearest zone still in play, and the balance of live zones */
    var play = out.zones.filter(function(z){ return !z.spent; });
    play.sort(function(a,b){ return a.away-b.away; });
    out.nearest = play[0] || null;
    play.forEach(function(z){ if(z.dir==='bull') out.balance.demand++; else out.balance.supply++; });

    /* the one sweep state that matters most */
    var ranked = out.sweeps.slice().sort(function(a,b){ return (STATES[a.state].rank-STATES[b.state].rank) || ((a.away||0)-(b.away||0)); });
    var top = ranked[0] || null;
    if(top) out.sweep = { state:top.state, label:top.label, status: top.ui==='spent' ? null : top.ui, zone:top, msg:top.msg, away:top.away, dir:top.dir };
    return out;
  }

  /* label + colour class for a sweep read, shared wording */
  function sweepLabel(sw){
    if(!sw || !sw.status) return { text:'No block in play', cls:'mut', note: sw ? sw.msg : 'No order block is in play near price on this timeframe.' };
    if(sw.status==='confirmed') return { text:'Enter now', cls:'up', note:sw.msg };
    if(sw.status==='swept')     return { text:'Watch',     cls:'bl', note:sw.msg };
    return { text:'Wait', cls:'gd', note:sw.msg };
  }
  root.BWSMCRead = { read:read, sweepLabel:sweepLabel, STATES:STATES, timeOf:timeOf };
})(typeof window!=='undefined'?window:globalThis);
