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


/* ── THE ENGINE FILES ARBITER LOADS ─────────────────────────────────────
   Each is the engine's own self-contained block from patterns.html, copied
   VERBATIM (the whole "(function(root){ … })(…);" statement). Arbiter loads
   them with <script src>, so they must be exactly the page's engines or the
   Arbiter's answer drifts from the Pattern Detector's. */
const ENGINES = [
  ['structure.js',      'root.BWStructure='],
  ['chart-patterns.js', 'root.BWChartPatterns='],
  ['extremes.js',       'root.BWExtremes='],
  ['bw-range.js',       'root.BWRange ='],
  ['retracement.js',    'root.BWRetracement='],
  ['governor.js',       'root.BWGovernor2='],
  ['conductor.js',      'root.BWConductor='],
  ['formations.js',     'root.BWFormations='],
  ['confluence.js',     'root.BWConfluence ='],
  ['break-confirm.js',  'root.BWBreakConfirm=']
];
function engineBlock(marker){
  const m = page.indexOf(marker);
  if(m < 0) throw new Error('engine not found in patterns.html: ' + marker);
  const starts = [...page.slice(0, m).matchAll(/^[ \t]*\(function ?\(root\) ?\{/mg)];
  if(!starts.length) throw new Error('no block start before ' + marker);
  const s = starts[starts.length - 1].index;
  const endRe = /^\}\)\([^\n]*\);/mg; endRe.lastIndex = m;
  const e = endRe.exec(page);
  if(!e) throw new Error('no block end after ' + marker);
  return page.slice(s, e.index + e[0].length).replace(/^[ \t]+(?=\(function)/, '');
}
/* Page-level names (declared at the start of a line in the page's scripts) that a
   block USES but does not declare itself — plus whatever those use in turn. */
/* engine blocks removed first: only names declared at the page's own top level count */
const pageTop = page.replace(/^[ \t]*\(function ?\(root\) ?\{[\s\S]*?^\}\)\([^\n]*\);/mg, '');
const PAGE_NAMES = [...new Set([...pageTop.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/mg)
  .map(m => m[1] || m[2])])];
function declaresItself(text, name){
  return new RegExp('(?:function\\s+' + name + '\\s*\\(|(?:const|let|var)\\s+' + name + '\\b|[,{]\\s*' + name + '\\s*=(?!=))').test(text);
}
/* the page's STATE (current pair, its data, timers) is never copied — only helper functions */
const PAGE_STATE = new Set(['pair', 'tf', 'view', 'RISK', 'OPEN', 'DATA', 'SERIES', 'secs', 'CPV', 'PAIRS', 'brokerSym',
  'publishPatternAlert']);   /* the page's own alert badge: never raised from Arbiter */
const codeOnly = t => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
                       .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''");
function pageDeps(text){
  const out = [], seen = new Set(PAGE_STATE);
  (function walk(raw){
    const t = codeOnly(raw);
    PAGE_NAMES.forEach(nm => {
      if(seen.has(nm) || nm.length < 3) return;
      if(!new RegExp('(?<![\\w$.])' + nm + '\\b').test(t) || declaresItself(t, nm)) return;
      const d = decl(page, nm); if(!d) return;
      seen.add(nm); walk(d); out.push(nm);
    });
  })(text);
  return out;
}
const dir = path.dirname(OUT);
ENGINES.forEach(([file, marker]) => {
  const block = engineBlock(marker);
  /* The page's shared bar-time helpers are page-level functions the engines call.
     Arbiter has no page, so each engine file that uses one carries a VERBATIM copy. */
  const helpers = pageDeps(block);
  const txt = '/* ' + file + ' — GENERATED from patterns.html by build-host.js. Do not edit by hand:\n' +
              '   it is the engine block from the page, copied VERBATIM. */\n' +
              (helpers.length ? '/* the page helpers it calls, VERBATIM */\n' + helpers.map(h => decl(page, h)).join('\n') + '\n' : '') +
              block + '\n';
  fs.writeFileSync(path.join(dir, file), txt);
  console.log('build-host: wrote ' + file + ' (' + txt.length + ' bytes)');
});

/* pd-liquidity.js — the Liquidity tab's liqRead and the helpers it uses. These are
   plain page-level statements (not one block), so they are copied VERBATIM and
   wrapped in a function so their names stay private, exactly as on the page. */
const LIQ = ['bwBarMs', 'bwBarHourUTC', 'LIQ_TF_MIN', 'liqHourOf', 'liqV', 'liqH', 'liqO', 'liqMed', 'liqAvg', 'liqClamp',
             'liqSlot', 'liqBaseline', 'liqBaseFor', 'liqAtr', 'BW_SESS', 'bwSessionsOpen', 'liqSession', 'liqRead'];
const liqMissing = LIQ.filter(n => !decl(page, n));
if(liqMissing.length){ console.error('build-host: not found in patterns.html: ' + liqMissing.join(', ')); process.exit(1); }
const liqTxt = '/* pd-liquidity.js — GENERATED from patterns.html by build-host.js. Do not edit by hand. */\n' +
  '(function(){\n' + LIQ.map(n => decl(page, n)).join('\n') + '\nwindow.BWLiquidity={liqRead};\n})();\n';
fs.writeFileSync(path.join(dir, 'pd-liquidity.js'), liqTxt);
console.log('build-host: wrote pd-liquidity.js (' + liqTxt.length + ' bytes)');

/* the Combined Read's slice ends where it publishes — either spelling of that line, so an
   older patterns.html (before the pressure reading was passed in) still builds */
const CONF_END = page.indexOf('  publishConfluence(o, cd, PR);') >= 0 ? 'publishConfluence(o, cd, PR);' : 'publishConfluence(o, cd);';
/* ── combined-read.js ── written last, once the dependency finder exists ── */
const SLICES = [slice(page, 'renderChart', 'if(!CPV.sel && CPV.forms.length) CPV.sel=CPV.forms[0].key;'),
                slice(page, 'renderRetrace', 'window.__BWMandate=mandate;'),
                slice(page, 'renderConf', CONF_END)];
/* names create() already supplies as the page's state */
const HEAD_NAMES = new Set([...HEAD.matchAll(/\bvar\s+([^;]+);/g)].flatMap(m => m[1].split(',').map(x => x.trim().split(/[\s=]/)[0])));
/* every page helper the listed functions and slices call, found automatically, VERBATIM */
const CR_EXTRA = pageDeps(PAGE_FUNCTIONS.map(n => decl(page, n)).join('\n') + '\n' + SLICES.join('\n'))
  .filter(n => PAGE_FUNCTIONS.indexOf(n) < 0 && !HEAD_NAMES.has(n));
const CR_NAMES = CR_EXTRA.concat(PAGE_FUNCTIONS);
console.log('build-host: combined-read also needs: ' + (CR_EXTRA.join(', ') || 'nothing else'));
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
${CR_NAMES.map(n => decl(page, n)).join('\n\n')}

  /* ── the calculation slices, VERBATIM, each given this pair's window ── */
  var makeChart   = function(window){ return (${slice(page, 'renderChart', 'if(!CPV.sel && CPV.forms.length) CPV.sel=CPV.forms[0].key;')}); };
  var makeRetrace = function(window){ return (${slice(page, 'renderRetrace', 'window.__BWMandate=mandate;')}); };
  var makeConf    = function(window){ return (${slice(page, 'renderConf', CONF_END)}); };
${FOOT}`;
fs.writeFileSync(OUT, out);
console.log('build-host: wrote ' + path.basename(OUT) + ' (' + out.length + ' bytes) from ' + path.basename(SRC));

/* ── risk-radar.js — from the MT5 Assistant's index.html, when it sits next to this script ──
   The Risk Radar engine block, copied VERBATIM. Arbiter's risk-radar-host supplies the three
   globals it waits for (state, dataBySymbol, normalisePair). Skipped if index.html is absent. */
const IDX = path.join(__dirname, 'index.html');
if(fs.existsSync(IDX)){
  const ix = fs.readFileSync(IDX, 'utf8').replace(/\r\n/g, '\n');
  const mk = ix.indexOf('const RR = window.BWRiskRadar = {};');
  const st = ix.lastIndexOf('\n(function boot(){', mk);
  const en = ix.indexOf('\n})();', mk);
  if(mk < 0 || st < 0 || en < 0){ console.error('build-host: Risk Radar block not found in index.html'); process.exit(1); }
  const rr = '/* risk-radar.js — GENERATED from index.html by build-host.js. Do not edit by hand:\n' +
             '   the Risk Radar engine block from the MT5 Assistant, copied VERBATIM. */' + ix.slice(st, en + 6) + '\n';
  fs.writeFileSync(path.join(dir, 'risk-radar.js'), rr);
  console.log('build-host: wrote risk-radar.js (' + rr.length + ' bytes) from index.html');
}
