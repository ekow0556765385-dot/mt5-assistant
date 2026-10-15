#!/usr/bin/env node
/* build-host.js — regenerates combined-read.js from patterns.html.
   Run from the server folder after every patterns.html change:
       node build-host.js
   Everything below is COPIED VERBATIM from patterns.html — nothing is rewritten —
   so the Arbiter's Combined Read is the Pattern Detector's Combined Read.
   If a name in PAGE_FUNCTIONS is missing from patterns.html the build stops,
   rather than shipping a file that silently differs from the page. */
'use strict';
const fs = require('fs'), path = require('path');
const SRC = path.join(__dirname, process.argv[2] || 'patterns.html');
const OUT = path.join(__dirname, process.argv[3] || 'combined-read.js');
const page = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

/* every page-level declaration the calculation needs, in page order of dependency */
const PAGE_FUNCTIONS = [
  'P_CCY', 'P_BASE', 'prettyPair', 'RISK_FRESH_MS', 'loadRisk', 'jget', 'normOpen', 'bwBarMs',
  'loadPair', 'SERIES_CAP', 'mergeSeries', 'D', 'pipOf', 'digitsOf', 'loadConfAlerts', 'confFeedGap',
  'publishFormations', 'publishConfluence',
  /* the Combined Read's live RSI (Momentum row) */
  'CF_RSI_HIST', 'cfRsi',
  /* the reversal pressure reading */
  'CONF_H4', 'PR_LOCK', 'PR_EP', 'confH4Levels', 'prRsi', 'prBarOf', 'readRevPressure', 'prHead'
];

/* find one top-level declaration and return its exact text */
function decl(src, name){
  const re = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(|^(?:const|let|var)\\s+' + name + '\\b', 'm');
  const m = re.exec(src); if(!m) return null;
  const start = m.index, isFn = /^(async\s+)?function/.test(m[0]);
  let depth = 0, k = start, str = null, opened = false;
  while(k < src.length){
    const ch = src[k], nx = src[k+1];
    if(str){ if(ch === '\\'){ k += 2; continue; } if(ch === str) str = null; k++; continue; }
    if(ch === '/' && nx === '/'){ k = src.indexOf('\n', k); continue; }
    if(ch === '/' && nx === '*'){ k = src.indexOf('*/', k) + 2; continue; }
    if(ch === '"' || ch === "'" || ch === '`'){ str = ch; k++; continue; }
    if('{(['.includes(ch)){ depth++; opened = true; }
    else if('})]'.includes(ch)){ depth--; if(isFn && depth === 0 && ch === '}') return src.slice(start, k+1); }
    else if(!isFn && depth === 0 && ch === ';') return src.slice(start, k+1);
    else if(!isFn && depth === 0 && ch === '\n' && opened) return src.slice(start, k);
    k++;
  }
  return null;
}
/* a render function's body from its start up to (and including) a marker statement */
function slice(src, name, marker){
  const s = src.indexOf('function ' + name + '(');
  if(s < 0) throw new Error('missing ' + name);
  const full = decl(src, name);
  if(!marker) return full;
  const e = full.indexOf(marker);
  if(e < 0) throw new Error(name + ': marker not found: ' + marker);
  return full.slice(0, e + marker.length) + '\n}';
}

const missing = PAGE_FUNCTIONS.filter(n => !decl(page, n));
if(missing.length){ console.error('build-host: not found in patterns.html: ' + missing.join(', ')); process.exit(1); }

/* the formations engine, so each pair gets its own instance */
const fEnd = page.indexOf("root.BWFormations=");
const fStart = page.lastIndexOf("(function(root){", fEnd);
const fClose = "})(typeof window!=='undefined'?window:globalThis);";
const formations = page.slice(fStart, page.indexOf(fClose, fEnd) + fClose.length);

/* create(): the page STATE Arbiter supplies (fixed text, not from the page) */
const HEAD = "function create(opts){\n  /* \u2500\u2500 the page's STATE, supplied by Arbiter \u2500\u2500 */\n  var SERIES = {}, DATA = {}, RISK = {}, OPEN = [], brokerSym = {}, PAIRS = [];\n  var CPV = {cd:[], pats:[], sel:null, animFrom:0, key:null};\n  var CONF_ALERTS = {rows:[], at:0, busy:false, fails:0, downSince:0, gapMs:0, ok:true};\n  var BASE = root.location ? root.location.origin : '';\n  var pair = '', tf = 'H1', captured = null;\n  var STUB = { innerHTML:'', textContent:'' };\n  var $ = function(){ return STUB; };                       /* no DOM is drawn \u2014 the calculation only */\n  var formationsByPair = {};\n  var winFor = function(p){                                   /* real engines, this pair's own formations */\n    var w = Object.create(root);\n    w.BWFormations = formationsByPair[p] || (formationsByPair[p] = makeFormations());\n    return w;\n  };\n  /* PRIVATE storage for the Combined Read's own channel; every other key reads the real storage.\n     publishConfluence writes here and NEVER to the real bw-confluence-now. */\n  var PRIVATE = {};\n  /* BOTH channels the copied code writes are kept PRIVATE: Arbiter must never\n     overwrite what the Pattern Detector publishes */\n  var OWN = { 'bw-confluence-now': 1, 'bw-formations-now': 1 };\n  var localStorage = {\n    getItem: function(k){ return OWN[k] ? (PRIVATE[k] || null) : root.localStorage.getItem(k); },\n    setItem: function(k, v){ if (OWN[k]) PRIVATE[k] = String(v); },\n    removeItem: function(k){ if (OWN[k]) delete PRIVATE[k]; }\n  };\n  var fetch = (opts && opts.fetch) || (root.fetch ? root.fetch.bind(root) : null);\n  var location = root.location;\n\n  ";
/* the API Arbiter calls (fixed text) */
const FOOT = "\n  return {\n    /* the exact statements loadPairs uses to read /api/state */\n    setState: function(st){\n      OPEN=((st.open_trades||st.openTrades||[])).map(normOpen).filter(Boolean);\n      const syms=(st.watchlist||[]).map(w=>typeof w==='string'?w:(w&&w.symbol)).filter(Boolean);\n      syms.forEach(sym=>{ const b=prettyPair(sym); brokerSym[b]=sym; if(PAIRS.indexOf(b)<0) PAIRS.push(b); });\n    },\n    load: function(b, t){ return loadPair(b, t); },\n    loadRisk: function(){ loadRisk(); },\n    pretty: function(sym){ return prettyPair(sym); },\n    run: function(p, t){\n      pair = p; tf = t || 'H1';\n      var w = winFor(p);\n      w.__cfLast = null;\n      /* the page's own order each refresh: chart, retracement, Combined Read */\n      makeChart(w)();\n      makeRetrace(w)();\n      makeConf(w)();\n      return w.__cfLast || null;\n    },\n    /* the reading in the Pattern Detector's own published shape, keyed pair|tf */\n    channel: function(){ try { return JSON.parse(PRIVATE['bw-confluence-now'] || 'null'); } catch (e) { return null; } },\n    /* the formations, exactly as the chart tab publishes them (DEC-14) */\n    formations: function(){ try { return JSON.parse(PRIVATE['bw-formations-now'] || 'null'); } catch (e) { return null; } },\n    _state: function(){ return { SERIES:SERIES, DATA:DATA, RISK:RISK, OPEN:OPEN, CONF_ALERTS:CONF_ALERTS }; }\n  };\n}\nroot.BWCombinedRead = { create: create };\n})(typeof window !== 'undefined' ? window : globalThis);\n";

const out =
`/* combined-read.js — GENERATED from patterns.html by build-host.js. Do not edit by hand.
   The Pattern Detector's Combined Read, run inside Arbiter when that page is not publishing.
   Every page function below is copied VERBATIM; test-combined-read.js fails if any drifts.
   Arbiter supplies only the page's STATE (candles, pattern data, risk, open trades, broker
   symbols, the alert cache). publishConfluence runs VERBATIM, so the reading comes out in
   exactly the shape the Pattern Detector publishes — but into PRIVATE storage: Arbiter
   never writes the Pattern Detector's channel. Formations get a SEPARATE instance per pair, because their
   hold state is keyed by start bar, not by pair. */
(function(root){
/* NOT strict: the page's own scripts run in sloppy mode, and an exact copy must too */
function makeFormations(){
  var own = {};
  (function(window, globalThis){
${formations}
  })(own, own);
  return own.BWFormations;
}
${HEAD}/* ── page functions, VERBATIM ── */
${PAGE_FUNCTIONS.map(n => decl(page, n)).join('\n\n')}

  /* ── the calculation slices, VERBATIM, each given this pair's window ── */
  var makeChart   = function(window){ return (${slice(page, 'renderChart', 'if(!CPV.sel && CPV.forms.length) CPV.sel=CPV.forms[0].key;')}); };
  var makeRetrace = function(window){ return (${slice(page, 'renderRetrace', 'window.__BWMandate=mandate;')}); };
  var makeConf    = function(window){ return (${slice(page, 'renderConf', 'publishConfluence(o, cd);')}); };
${FOOT}`;
fs.writeFileSync(OUT, out);
console.log('build-host: wrote ' + path.basename(OUT) + ' (' + out.length + ' bytes) from ' + path.basename(SRC));
