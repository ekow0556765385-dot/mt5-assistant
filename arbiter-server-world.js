/* arbiter-server-world.js — SERVER-SIDE JUDGING, phase SJ-1: the server's world.

   Arbiter used to judge only while its page was open. The server will judge too — and it must judge
   with EXACTLY the page's code, or a server CUT and a page HOLD could contradict each other. So nothing
   is re-implemented here: the page's own scripts (read from arbiter.html's script tags, so the list can
   never drift) are loaded into a sandbox, and every request the feeds make is answered from server
   memory exactly as the real endpoint answers it.

   ONE SANDBOX PER ACCOUNT. The feeds keep caches at module level (the last good answer per URL for 90
   seconds, the slow cache…). Shared across accounts, one trader's cached answer could be served to
   another. Each account gets its own sandbox, released after it has been idle. */
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path');

const IDLE_MS = 10 * 60 * 1000;            // a sandbox with no use for 10 minutes is released

module.exports = function createServerWorld(deps) {
  const { dir, getState, getCandlesStore, normalisePair, findByPairTf, smc, getJournal, statusFor, log } = deps;
  const L = log || console;

  /* the page's own script list, in the page's order (bw-source.js is the browser's account picker) */
  const html = fs.readFileSync(path.join(dir, 'arbiter.html'), 'utf8');
  const files = [...html.matchAll(/<script src="\/([a-z0-9.\-]+\.js)"/g)].map(m => m[1]).filter(f => f !== 'bw-source.js');
  const scripts = files.map(f => new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f }));

  /* ── every request the feeds make, answered from server memory exactly as its endpoint answers ── */
  async function answer(userId, sourceId, p, q) {
    if (p === '/api/state') return getState(userId, sourceId);
    if (p === '/api/candles') {                        // app.js GET /api/candles: exact key, else the normalised pair
      const cs = getCandlesStore(userId, sourceId) || {};
      const symbol = q.symbol;
      if (!symbol) return null;
      let data = cs[symbol];
      if (!data) { const want = normalisePair(symbol); const hit = Object.keys(cs).find(k => normalisePair(k) === want); if (hit) data = cs[hit]; }
      return data || { symbol, candles: [], note: 'No candle data yet' };
    }
    if (p === '/api/patterns') {                       // app.js GET /api/patterns: findByPairTf on the state's livePatterns
      const s = getState(userId, sourceId) || {};
      if (q.symbol && q.tf) return findByPairTf(s.livePatterns || {}, q.symbol, q.tf) || {};
      return s.livePatterns || {};
    }
    if (p === '/smc' || /^\/smc\/tf\/[A-Za-z0-9]+$/.test(p)) {   // smc-route GET /smc and /smc/tf/:tf
      const prefix = smc.scopeOf(userId, sourceId) + '::', out = {};
      const tf = p === '/smc' ? null : p.split('/').pop().toUpperCase(), suffix = tf ? '::' + tf : null;
      Object.keys(smc.store).forEach(k => {
        if (!k.startsWith(prefix)) return;
        if (!tf) { const rest = k.slice(prefix.length); if (!rest.includes('::')) out[rest] = smc.store[k]; }
        else if (k.endsWith(suffix)) out[k.slice(prefix.length, k.length - suffix.length)] = smc.store[k];
      });
      return out;
    }
    if (p === '/api/arbiter/status') return statusFor ? await statusFor(userId) : null;
    if (p === '/api/journal') return getJournal ? { entries: await getJournal(userId) } : { entries: [] };
    return null;                                       // anything else: not available on the server
  }

  /* ── one sandbox per account ── */
  const boxes = new Map();
  function sandboxFor(userId, sourceId) {
    const key = userId + '|' + (sourceId || '');
    let b = boxes.get(key);
    if (b) { b.usedAt = Date.now(); return b.ctx; }
    const mem = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)),
      removeItem: k => m.delete(k), clear: () => m.clear(), key: i => [...m.keys()][i] || null, get length() { return m.size; } }; };
    const ctx = {
      console: { log() {}, info() {}, debug() {}, warn: (...a) => L.warn && L.warn('[ARBITER-SERVER]', ...a), error: (...a) => L.warn && L.warn('[ARBITER-SERVER]', ...a) },
      setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},      // no repeating timers: the server drives the cycle
      localStorage: mem(), sessionStorage: mem(),                                   // private to this account
      location: { href: 'https://server.local/arbiter', search: '', hash: '', hostname: 'server.local', pathname: '/arbiter', origin: 'https://server.local' },
      navigator: { userAgent: 'Blackwood-Arbiter-Server' },
      URLSearchParams, URL, TextEncoder, TextDecoder
    };
    ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
    ctx.fetch = (url) => {
      const u = String(url && url.url ? url.url : url).replace(/^https?:\/\/[^/]+/, ''), qi = u.indexOf('?');
      const p = qi < 0 ? u : u.slice(0, qi), q = Object.fromEntries(new URLSearchParams(qi < 0 ? '' : u.slice(qi + 1)));
      return Promise.resolve().then(() => answer(userId, sourceId, p, q)).catch(e => { L.warn && L.warn('[ARBITER-SERVER] answer failed', p, e.message); return null; })
        .then(body => ({ ok: body != null, status: body != null ? 200 : 404,
          json: () => Promise.resolve(body == null ? null : JSON.parse(JSON.stringify(body))),   // a copy, exactly as over the network
          text: () => Promise.resolve(body == null ? '' : JSON.stringify(body)) }));
    };
    vm.createContext(ctx);
    scripts.forEach(s => s.runInContext(ctx));
    boxes.set(key, { ctx, usedAt: Date.now() });
    return ctx;
  }
  function sweep(nowMs) {
    const t = nowMs || Date.now(); let n = 0;
    for (const [k, b] of boxes) if (t - b.usedAt > IDLE_MS) { boxes.delete(k); n++; }
    return n;
  }

  /* ── each open position's world, built exactly as the page builds it ── */
  async function worldsFor(userId, sourceId) {
    const ctx = sandboxFor(userId, sourceId), F = ctx.BWArbiterFeeds;
    const shared = await F.fetchShared('H1');
    const trades = (shared.state && shared.state.openTrades) || [];
    const results = [];
    for (const t of trades) results.push(await F.buildPositionWorld(t, { shared: shared }));   // as arbiter.html calls it
    return { shared, results, ctx };
  }

  return { worldsFor, sandboxFor, answer, sweep, size: () => boxes.size, files };
};
