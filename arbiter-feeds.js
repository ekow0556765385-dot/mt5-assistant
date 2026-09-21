/* ═══════════════════════════════════════════════════════════════════
   ARBITER — FEEDS (Phase 3)

   Builds the WORLD the engine judges. Nothing here decides anything; it
   only gathers, normalises and labels.

   WHERE EACH READING COMES FROM, AND WHY
   Arbiter runs in its own iframe, so it cannot call BWStructure,
   BWRetracement or BWFormations — those live inside patterns.html. Two
   modules describing the same market differently is the worst outcome
   here, so the order is always:

     1. the OTHER MODULE'S OWN PUBLISHED READ, if it is fresh
        `bw-confluence-now`  (patterns.html — trend, trigger, the decisive
                              level, participation, higher timeframe)
        `bw-risk-now`        (index.html — Risk Radar per pair)
        `bw-liquidity-now`   (index.html — participation per pair)
     2. ARBITER'S OWN read from candles, clearly labelled as such
     3. nothing — the condition reports `unknown`, which the engine
        handles honestly rather than scoring as a pass

   Every reading carries `.from` so the UI can always say which it is
   showing. A number whose origin cannot be named does not belong here.
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
'use strict';

var CHANNEL_MAX_AGE = 5 * 60 * 1000;   // a published read older than this is not used
var SPREAD_KEY = 'bw-arb-spread';      // Arbiter's own rolling spread baseline

var n = function (v) { var x = parseFloat(v); return isFinite(x) ? x : null; };
var norm = function (s) {
  s = String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
  return s.length > 6 ? s.slice(0, 6) : s;
};
function pipSizeFor(sym) {
  sym = String(sym || '').toUpperCase();
  if (/JPY$/.test(sym)) return 0.01;
  if (/^XAU/.test(sym)) return 0.1;
  if (/^XAG/.test(sym)) return 0.01;
  if (/^(BTC|ETH)/.test(sym)) return 1;
  return 0.0001;
}
var cH = function (c) { return n(c.h !== undefined ? c.h : c.high); };
var cL = function (c) { return n(c.l !== undefined ? c.l : c.low); };
var cC = function (c) { return n(c.c !== undefined ? c.c : c.close); };
var cT = function (c) { return n(c.t !== undefined ? c.t : c.time) || 0; };

function readChannel(key) {
  try {
    var raw = JSON.parse(localStorage.getItem(key) || 'null');
    if (!raw || !raw.t) return null;
    if (Date.now() - raw.t > CHANNEL_MAX_AGE) return null;
    return raw;
  } catch (e) { return null; }
}

async function getJSON(url) {
  try {
    var r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

/* ── ARBITER'S OWN STRUCTURE READ ────────────────────────────────────
   The fallback only. Swing pivots from candles, then the sequence of
   highs and lows. Assan's rule: in an uptrend the HL breaking is the
   reversal; in a downtrend it is the LH. The decisive level returned is
   exactly that pivot, because it is what would invalidate the read.
   Deliberately simple, and always labelled "Arbiter's own read" so it is
   never mistaken for the structure engine. */
function structureFromCandles(cd) {
  if (!cd || cd.length < 25) return null;
  var piv = [], L = 2;
  for (var i = L; i < cd.length - L; i++) {
    var hi = true, lo = true;
    for (var j = i - L; j <= i + L; j++) {
      if (j === i) continue;
      if (cH(cd[j]) >= cH(cd[i])) hi = false;
      if (cL(cd[j]) <= cL(cd[i])) lo = false;
    }
    if (hi) piv.push({ k: 'H', p: cH(cd[i]), i: i });
    if (lo) piv.push({ k: 'L', p: cL(cd[i]), i: i });
  }
  if (piv.length < 4) return null;
  var last = piv.slice(-6);
  var highs = last.filter(function (x) { return x.k === 'H'; });
  var lows  = last.filter(function (x) { return x.k === 'L'; });
  if (highs.length < 2 || lows.length < 2) return null;
  var hh = highs[highs.length - 1].p > highs[highs.length - 2].p;
  var hl = lows[lows.length - 1].p > lows[lows.length - 2].p;
  var lh = highs[highs.length - 1].p < highs[highs.length - 2].p;
  var ll = lows[lows.length - 1].p < lows[lows.length - 2].p;
  var regime = (hh && hl) ? 'uptrend' : (lh && ll) ? 'downtrend' : 'range';
  var labels = last.map(function (x, k) {
    if (k === 0) return null;
    var prev = last.slice(0, k).filter(function (y) { return y.k === x.k; }).pop();
    if (!prev) return null;
    return (x.k === 'H' ? (x.p > prev.p ? 'HH' : 'LH') : (x.p > prev.p ? 'HL' : 'LL'));
  }).filter(Boolean);
  // the pivot whose break would end this read
  var decisive = regime === 'uptrend' ? lows[lows.length - 1].p
               : regime === 'downtrend' ? highs[highs.length - 1].p : null;
  return {
    regime: regime,
    confidence: regime === 'range' ? 0.4 : (hh && hl) || (lh && ll) ? 0.7 : 0.5,
    labels: labels.slice(-4).join(' '),
    decisive: decisive,
    from: "Arbiter's own read from candles"
  };
}

function atrFrom(cd, look) {
  if (!cd || cd.length < 5) return null;
  look = look || 14;
  var s = 0, k = 0;
  for (var i = Math.max(1, cd.length - look); i < cd.length; i++) {
    var h = cH(cd[i]), l = cL(cd[i]);
    if (h != null && l != null) { s += (h - l); k++; }
  }
  return k ? s / k : null;
}

/* Sessions by UTC hour. Arbiter's own, and labelled — the Assistant's
   liquidity read is preferred whenever it is publishing. */
function sessionFromClock(d) {
  var h = d.getUTCHours();
  var london = h >= 7 && h < 16, ny = h >= 12 && h < 21, tokyo = h >= 23 || h < 8;
  var name = london && ny ? 'London / New York overlap'
    : london ? 'London' : ny ? 'New York' : tokyo ? 'Tokyo' : 'Between sessions';
  var depth = london && ny ? 1.0 : london ? 0.75 : ny ? 0.7 : tokyo ? 0.45 : 0.15;
  var endH = london && ny ? 16 : london ? 16 : ny ? 21 : tokyo ? 8 : 7;
  var mins = ((endH - h + 24) % 24) * 60 - d.getUTCMinutes();
  return { name: name, depth: depth, minutesLeft: mins, from: "Arbiter's own read from the clock" };
}

/* A spread baseline Arbiter builds for itself, per pair and session hour,
   because no module publishes one. Until there are enough samples the
   condition stays unknown rather than being judged against a guess. */
function spreadBaseline(sym, spread) {
  try {
    var all = JSON.parse(localStorage.getItem(SPREAD_KEY) || '{}');
    var hour = new Date().getUTCHours();
    var key = sym + '|' + hour;
    var arr = all[key] || [];
    if (spread != null) { arr.push(spread); if (arr.length > 200) arr = arr.slice(-200); all[key] = arr; }
    localStorage.setItem(SPREAD_KEY, JSON.stringify(all));
    if (arr.length < 20) return { median: null, samples: arr.length };
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return { median: s[Math.floor(s.length / 2)], samples: arr.length };
  } catch (e) { return { median: null, samples: 0 }; }
}

/* ── zones from the SMC feed ─────────────────────────────────────────
   Order blocks are zones with high/low as STRINGS and a timeStart. The
   feed carries no mitigation flag, so `spent` is inferred the same way
   the SMC panel does it: a demand block is spent once a candle has
   CLOSED below its low (and the reverse for supply). */
function zonesFrom(smcNode, cd, sym) {
  if (!smcNode) return null;
  var out = [];
  var blocks = smcNode.orderBlocks || smcNode.order_blocks || smcNode.obs || [];
  var heights = [];
  blocks.forEach(function (b) {
    var hi = n(b.high !== undefined ? b.high : b.hi);
    var lo = n(b.low !== undefined ? b.low : b.lo);
    if (hi == null || lo == null) return;
    if (hi < lo) { var t = hi; hi = lo; lo = t; }
    var kindRaw = String(b.type || b.kind || b.direction || '').toLowerCase();
    var kind = /bull|demand|buy/.test(kindRaw) ? 'demand' : /bear|supply|sell/.test(kindRaw) ? 'supply' : null;
    if (!kind) return;
    var startMs = n(b.timeStart || b.time || b.timestamp);
    if (startMs != null && startMs < 1e12) startMs *= 1000;      // seconds -> ms
    var spent = false, touches = 0;
    (cd || []).forEach(function (c) {
      var close = cC(c), h = cH(c), l = cL(c);
      if (close == null) return;
      if (startMs != null && cT(c) * 1000 < startMs) return;
      if (h >= lo && l <= hi) touches++;
      if (kind === 'demand' && close < lo) spent = true;
      if (kind === 'supply' && close > hi) spent = true;
    });
    heights.push(hi - lo);
    out.push({ kind: kind, lo: lo, hi: hi, spent: spent, touches: touches,
      ageHours: startMs != null ? (Date.now() - startMs) / 3600000 : null });
  });
  heights.sort(function (a, b) { return a - b; });
  return { zones: out, medianHeight: heights.length ? heights[Math.floor(heights.length / 2)] : null };
}

function pickNode(bag, sym) {
  if (!bag) return null;
  if (bag.orderBlocks || bag.order_blocks) return bag;          // already a node
  var key = Object.keys(bag).find(function (k) { return norm(k) === norm(sym); });
  return key ? bag[key] : null;
}

/* ── edge: the trader's own record on this pair + direction + session ── */
function edgeFrom(journal, sym, want, sessionName) {
  if (!journal || !journal.entries) return null;
  var rows = journal.entries.filter(function (r) { return norm(r.symbol) === norm(sym); });
  var dirWord = want === 'bull' ? 'buy' : 'sell';
  var matching = rows.filter(function (r) {
    var d = String(r.direction || '').toLowerCase();
    return d.indexOf(dirWord) >= 0 && (!sessionName || !r.session || String(r.session).toLowerCase() === String(sessionName).toLowerCase());
  });
  var wins = function (list) { return list.filter(function (r) { return n(r.total_pl) > 0; }).length; };
  var all = journal.entries;
  return {
    sample: matching.length,
    hitRate: matching.length ? wins(matching) / matching.length : null,
    baseline: all.length ? wins(all) / all.length : null,
    from: 'your closed trades'
  };
}

/* ═══════════════════════════════════════════════════════════════════
   BUILD THE WORLD
   ═══════════════════════════════════════════════════════════════════ */
async function buildWorld(symbol, timeframe, opts) {
  opts = opts || {};
  var sym = norm(symbol), tf = timeframe || 'H1';
  var provenance = {};

  // Account-wide data can be passed in via opts.shared so a six-pair scan
  // fetches it ONCE per cycle instead of six times. Only the per-pair reads
  // (candles, patterns) are always fetched here.
  var sh = opts.shared || {};
  var smcKey = tf === 'H4' ? 'smcH4' : 'smc';
  var results = await Promise.all([
    'state' in sh ? sh.state : getJSON('/api/state'),
    getJSON('/api/candles?symbol=' + encodeURIComponent(symbol)),
    smcKey in sh ? sh[smcKey] : getJSON(tf === 'H4' ? '/smc/tf/H4' : '/smc'),
    getJSON('/api/patterns?symbol=' + encodeURIComponent(symbol) + '&tf=' + encodeURIComponent(tf)),
    'status' in sh ? sh.status : getJSON('/api/arbiter/status'),
    opts.journal === false ? null : ('journal' in sh ? sh.journal : getJSON('/api/journal'))
  ]);
  var state = results[0] || {}, candleNode = results[1] || {}, smc = results[2],
      pats = results[3], status = results[4] || {}, journal = results[5];

  var cd = (candleNode.candlesByTF && (candleNode.candlesByTF[tf] || candleNode.candlesByTF.H1))
        || candleNode.candles || [];
  var last = cd.length ? cd[cd.length - 1] : null;
  var price = last ? cC(last) : null;

  var wl = (state.watchlist || []).find(function (w) { return norm(w.symbol) === sym; }) || {};
  if (price == null) price = n(wl.bid);

  // ── the other modules' own reads, preferred ───────────────────────
  var conf = readChannel('bw-confluence-now');
  var confRead = null;
  if (conf && conf.reads) {
    var key = Object.keys(conf.reads).find(function (k) {
      var parts = k.split('|'); return norm(parts[0]) === sym && (parts[1] === tf || !parts[1]);
    });
    confRead = key ? conf.reads[key] : null;
  }
  var riskCh = readChannel('bw-risk-now');
  var liqCh = readChannel('bw-liquidity-now');
  var riskPair = riskCh && riskCh.pairs ? (riskCh.pairs[sym] || riskCh.pairs[symbol]) : null;
  var liqPair = liqCh && liqCh.pairs ? (liqCh.pairs[sym] || liqCh.pairs[symbol]) : null;

  // structure
  var structure = null, invalidation = null;
  if (confRead && confRead.trend) {
    structure = { regime: /up|bull/i.test(confRead.trend) ? 'uptrend' : /down|bear/i.test(confRead.trend) ? 'downtrend' : 'range',
                  confidence: n(confRead.trendConf), labels: confRead.labels,
                  from: 'the structure engine (Pattern Detector)' };
    if (confRead.decides) invalidation = n(confRead.decides.price);
    provenance.structure = 'channel';
  } else {
    var own = structureFromCandles(cd);
    if (own) { structure = own; invalidation = own.decisive; provenance.structure = 'own'; }
  }

  // session and depth
  var session;
  if (liqPair && (liqPair.pct != null || liqPair.score != null)) {
    var pct = n(liqPair.pct != null ? liqPair.pct : liqPair.score);
    session = { name: liqPair.session || (confRead && confRead.participation && confRead.participation.session) || 'Live',
                depth: pct > 1 ? pct / 100 : pct, from: 'the Assistant\'s liquidity read' };
    provenance.session = 'channel';
  } else {
    session = sessionFromClock(new Date());
    provenance.session = 'own';
  }

  // zones
  var node = pickNode(smc, symbol);
  var z = zonesFrom(node, cd, sym);

  // patterns — tolerant to both shapes, handled inside the engine
  var patterns = null;
  if (pats) patterns = pats.patterns || pats.list || (Array.isArray(pats) ? pats : null);
  if (!patterns && confRead && confRead.trigger) {
    patterns = [{ name: confRead.trigger.name, direction: confRead.trigger.dir,
                  confidence: confRead.trigger.conf, barsAgo: confRead.trigger.barsAgo, timeframe: tf }];
    provenance.patterns = 'channel';
  }

  // news, in minutes away
  var news = (state.news || state.newsEvents || []).map(function (e) {
    var ts = n(e.timestamp);
    if (ts != null && ts < 1e12) ts *= 1000;
    return { title: e.title, impact: e.impact, country: e.country,
             minutesAway: ts != null ? (ts - Date.now()) / 60000 : null };
  }).filter(function (e) { return e.minutesAway != null && e.minutesAway > -30; });

  var spreadPts = n(wl.spread);
  var spreadPips = spreadPts != null ? spreadPts * (pipSizeFor(sym) === 0.01 ? 0.1 : pipSizeFor(sym) === 0.1 ? 0.1 : 0.1) : null;
  // MT5 spread arrives in POINTS. One pip is ten points on a 5-digit pair
  // and on 3-digit JPY, which is the case for every pair in the watchlist.
  if (spreadPts != null) spreadPips = spreadPts / 10;
  var base = spreadBaseline(sym, spreadPips);

  var want = opts.direction || null;
  var world = {
    symbol: sym, rawSymbol: wl.symbol || symbol, timeframe: tf, higherTimeframe: tf === 'H4' ? 'D1' : 'H4',
    now: Date.now(), price: price,
    structure: structure,
    invalidationLevel: invalidation,
    zones: z ? z.zones : null,
    medianZoneHeight: z ? z.medianHeight : null,
    patterns: patterns,
    formations: (confRead && confRead.pressure) ? [] : [],   // no formation channel yet — see note below
    sweep: node ? (node.sweepStatus || node.sweep || null) : null,
    retracement: (confRead && confRead.reversal)
      ? { score: confRead.reversal.givenBackPct != null ? confRead.reversal.givenBackPct : null,
          note: confRead.reversal.stage || null, from: 'the retracement engine' } : null,
    atr: atrFrom(cd),
    session: { name: session.name, depth: session.depth },
    sessionMinutesLeft: session.minutesLeft != null ? session.minutesLeft : null,
    news: news,
    expectedMinutes: opts.expectedMinutes || 240,
    radar: riskPair ? { score: n(riskPair.score), state: riskPair.state || riskPair.level,
                        stateName: riskPair.name || riskPair.stateName,
                        factors: riskPair.factors || [] } : null,
    openPositions: (state.openTrades || []).map(function (t) {
      return { ticket: String(t.ticket), symbol: norm(t.symbol), side: t.type, volume: n(t.volume), riskPct: n(t.riskPct) };
    }),
    correlations: opts.correlations || [],
    spread: spreadPips, medianSpread: base.median,
    edge: want ? edgeFrom(journal, sym, want, session.name) : null,
    _journal: journal, _sessionName: session.name,
    target: opts.target != null ? n(opts.target) : null,
    accountInfo: state.accountInfo || {},
    provenance: provenance,
    sources: {
      structure: structure ? structure.from : null,
      session: session.from || 'the Assistant\'s liquidity read',
      spreadSamples: base.samples
    },
    arbiter: status
  };
  return world;
}

/* For an OPEN position: the world plus the trade's own numbers, including
   the water marks Phase 1 has been recording server-side. */
async function buildPositionWorld(trade, opts) {
  opts = opts || {};
  var want = String(trade.type || trade.side || '').toLowerCase().indexOf('sell') >= 0 ? 'bear' : 'bull';
  var w = await buildWorld(trade.symbol, opts.timeframe || 'H1',
    { direction: want, target: n(trade.tp) || null, journal: opts.journal, shared: opts.shared });

  var rec = ((w.arbiter && w.arbiter.openPositions) || []).find(function (p) {
    return String(p.ticket) === String(trade.ticket);
  }) || {};
  var pip = pipSizeFor(w.symbol);
  var openPrice = n(trade.openPrice || trade.open_price);
  var sl = n(trade.sl), tp = n(trade.tp);
  var live = w.price;
  var sign = want === 'bull' ? 1 : -1;

  var position = {
    ticket: String(trade.ticket), side: want === 'bull' ? 'buy' : 'sell',
    symbol: w.symbol, rawSymbol: trade.symbol,
    openPrice: openPrice, sl: sl, tp: tp, volume: n(trade.volume),
    openTime: n(trade.openTime),
    profit: n(trade.profit),
    floatingPips: (live != null && openPrice != null) ? sign * (live - openPrice) / pip : null,
    mfePips: n(rec.mfe_pips), maePips: n(rec.mae_pips),
    bestPL: n(rec.best_pl), worstPL: n(rec.worst_pl),
    stopPips: (sl && openPrice) ? Math.abs(openPrice - sl) / pip : null,
    entryCase: opts.entryCase || null
  };
  return { world: w, position: position };
}

/* The account-wide reads, fetched once per cycle and handed to every
   buildWorld call in a scan. */
async function fetchShared(tf) {
  var r = await Promise.all([
    getJSON('/api/state'),
    getJSON(tf === 'H4' ? '/smc/tf/H4' : '/smc'),
    getJSON('/api/arbiter/status'),
    getJSON('/api/journal')
  ]);
  var out = { state: r[0], status: r[2], journal: r[3] };
  out[tf === 'H4' ? 'smcH4' : 'smc'] = r[1];
  return out;
}

root.BWArbiterFeeds = {
  buildWorld: buildWorld,
  fetchShared: fetchShared,
  buildPositionWorld: buildPositionWorld,
  _internals: { structureFromCandles: structureFromCandles, zonesFrom: zonesFrom, atrFrom: atrFrom,
                sessionFromClock: sessionFromClock, edgeFrom: edgeFrom, readChannel: readChannel,
                pipSizeFor: pipSizeFor, spreadBaseline: spreadBaseline }
};
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = (typeof window !== 'undefined' ? window : globalThis).BWArbiterFeeds;
