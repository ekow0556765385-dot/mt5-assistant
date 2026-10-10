/* traded-pairs.js — TP-2: pairs a trader TRADES that are not on their WatchPairs (EA v4.4).

   The EA adds the pairs of open trades to the data it sends, and names them in the heartbeat's
   "tradedPairs". When a trade closes, its pair leaves that list — and here it is RETIRED: every piece of
   that trader's data for it is removed, so no module ever shows its last candles as if they were live.

   Why the heartbeat decides, not the data: on the file bridge, a pair's per-symbol files (zones, pattern
   data) stop being rewritten when it drops out, but the bridge RE-POSTS each file's last contents every
   60 s until the file is 15 minutes old. So for RETIRE_MS after retiring, anything still arriving for the
   pair is removed again on every heartbeat. (The multi-pair candle bundle is one file rewritten every 5 s
   with only the CURRENT pairs, so candles — and the pattern alerts made from them — need no guard.)

   ONLY former traded extras are ever touched: never a watch pair, never the EA's chart pair. */
'use strict';
const RETIRE_MS = 15 * 60 * 1000;          // matches the bridge's stale-file guard

function updateTradedPairs({ s, tradedPairs, candlesStore, smcStore, smcPrefix, normalisePair, now }) {
  const N = x => normalisePair(String(x || ''));
  const t = now == null ? Date.now() : now;
  const list = Array.isArray(tradedPairs) ? tradedPairs.map(String) : [];
  // what the trader's EA is sending NOW: the watchlist (which includes the traded extras) and its chart pair
  const listed = new Set((s.watchlist || []).map(w => N(w && w.symbol)).concat([N(s.symbol)]).filter(Boolean));
  const nowSet = new Set(list.map(N));
  if (!s.retiredPairs) s.retiredPairs = {};
  (s.tradedPairs || []).forEach(p => { const k = N(p); if (k && !nowSet.has(k) && !listed.has(k)) s.retiredPairs[k] = t + RETIRE_MS; });
  s.tradedPairs = list;
  // a pair traded or watched again is never retired; a retirement ends after RETIRE_MS
  Object.keys(s.retiredPairs).forEach(k => { if (nowSet.has(k) || listed.has(k) || s.retiredPairs[k] < t) delete s.retiredPairs[k]; });
  const gone = new Set(Object.keys(s.retiredPairs));
  const removed = [];
  if (!gone.size) return removed;
  const isGone = sym => gone.has(N(sym));
  const drop = (obj, keyToSym, label) => { if (!obj) return; Object.keys(obj).forEach(k => { if (isGone(keyToSym(k))) { delete obj[k]; removed.push(label + ':' + k); } }); };
  drop(candlesStore, k => k, 'candles');                                                   // getCandlesStore
  ['candles', 'patterns', 'indicatorsBySymbol', 'formingPatterns'].forEach(f => drop(s[f], k => k, f));   // per-symbol state
  drop(s.livePatterns, k => { const i = k.lastIndexOf('_'); return i > 0 ? k.slice(0, i) : k; }, 'livePatterns');   // `${sym}_${tf}`
  if (smcStore && smcPrefix)                                                                 // `${scope}::${sym}` and `${scope}::${sym}::${tf}`
    Object.keys(smcStore).forEach(k => { if (k.startsWith(smcPrefix) && isGone(k.slice(smcPrefix.length).split('::')[0])) { delete smcStore[k]; removed.push('smc:' + k); } });
  return removed;
}

module.exports = { updateTradedPairs, RETIRE_MS };
