// notify-watch.js — Blackwood pop-up alerts, Phase 2b (Nov 2026)
//
// The dashboard's dots for Stop Radar, Risk Radar and the SMC Panel are worked
// out INSIDE the browser, so with every Blackwood page closed (or on a phone,
// where a background page is paused) nothing raised them. This file watches
// the same three things on the server, for traders who have switched alerts
// on (they have at least one device in push_subscriptions), and sends them
// through notify-route.js, which applies the trader's switches, quiet hours
// and the "dashboard already open on this computer" rule.
//
//   Stop Radar  — the Math Dashboard's rule: RED once a position is 70%
//                 (the trader's "Warn at %" setting) of the way to its stop
//                 and the stop is not already in profit; AMBER for a
//                 position with no stop at all.
//   SMC zones   — the zone states the EA itself sends (EA v5.1+): approaching
//                 or in a zone is AMBER, swept / swept and reclaimed is RED —
//                 the same states the SMC Panel shows, so they cannot disagree.
//   Risk Radar  — risk-radar.js, the MT5 Assistant's own engine, run
//                 unchanged against the server's copy of the trader's data.
//                 AMBER when a pair rises to Elevated, RED at Stand down.
//
// Each alert is sent once. It is only sent again after the situation has
// cleared and come back. The first look after a server restart only records
// what is already there, so a restart never replays alerts.

const fs = require('fs'), path = require('path'), vm = require('vm');

module.exports = function notifyWatch(deps) {
  const log = deps.log || console;
  const notify = deps.notify;                     // notify-route.js instance
  const dir = deps.dir || __dirname;
  const LIVE_MS = 2 * 60 * 1000;                  // only judge a terminal that sent data recently

  /* ── helpers ── */
  const CCY = ['USD','EUR','GBP','JPY','CHF','AUD','NZD','CAD','SEK','NOK','DKK','SGD','HKD','ZAR','MXN','TRY','PLN','CZK','HUF','CNH','THB','INR'];
  const BASE = CCY.concat(['XAU','XAG','XPT','XPD','BTC','ETH','LTC','XRP','SOL','BNB']);
  function normalisePair(sym) {                   // same rule as smc-route.js
    if (!sym) return '';
    const up = String(sym).toUpperCase().replace(/[._-]/g, '');
    for (let cut = 0; cut <= 3 && up.length - cut >= 6; cut++) {
      const c = up.slice(0, up.length - cut);
      if (c.length === 6 && BASE.includes(c.slice(0, 3)) && CCY.includes(c.slice(3, 6))) return c;
    }
    return up;
  }
  function pipOf(sym) { return /JPY$/.test(sym) ? 0.01 : /^XAU/.test(sym) ? 0.1 : /^XAG/.test(sym) ? 0.01 : /^BTC|^ETH/.test(sym) ? 1 : 0.0001; }
  function pipValOf(sym) { return /^XAG/.test(sym) ? 50 : /JPY$/.test(sym) ? 6.7 : /^BTC|^ETH/.test(sym) ? 1 : 10; }
  function digitsOf(sym) { return /JPY$/.test(sym) ? 3 : /^XA[UG]|^BTC|^ETH/.test(sym) ? 2 : 5; }
  const CCY_USD = { USD:1, EUR:1.12, GBP:1.28, AUD:0.66, CAD:0.73, CHF:1.13, NZD:0.61, JPY:0.0067, ZAR:0.055, NGN:0.00065, GHS:0.064, KES:0.0077, INR:0.012, SGD:0.75 };
  /* MT5 writes times like "2026.11.18 14:00"; the browser pages read them with bwDate. */
  function bwDate(v) {
    if (v instanceof Date) return v;
    if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
    const s = String(v || '');
    const m = s.match(/^(\d{4})[.\-](\d{2})[.\-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
    return new Date(s);
  }
  function feed(uid) {
    try {
      const src = deps.resolveSource(uid);
      const last = (deps.listSources(uid) || []).find(s => s.sourceId === src) || (deps.listSources(uid) || [])[0];
      if (!last || Date.now() - (last.lastSeen || 0) > LIVE_MS) return null;
      return { src, st: deps.getState(uid, src), scope: deps.scopeOf(uid, src) };
    } catch (e) { return null; }
  }
  function priceFor(st, sym, side) {
    const w = (st.watchlist || []).find(x => normalisePair(x.symbol) === sym);
    if (!w) return NaN;
    const v = side === 'ask' ? +w.ask : +w.bid;
    return v > 0 ? v : (+w.bid > 0 ? +w.bid : NaN);
  }

  /* ── 1. STOP RADAR ── */
  const stopSeen = new Map();     // uid -> Map(ticket -> 'hot'|'nostop')
  const stopPrimed = new Set();
  async function stopTick(uid) {
    const f = feed(uid); if (!f) return;
    const open = (f.st.openTrades || []);
    let warn = 70;
    try { const s = deps.getMathSettings ? await deps.getMathSettings(uid) : null; if (s && +s.slWarn > 0) warn = +s.slWarn; } catch (e) {}
    const ccy = String((f.st.accountInfo && (f.st.accountInfo.currency || f.st.accountInfo.ccy)) || 'USD').toUpperCase();
    const rate = CCY_USD[ccy] != null ? CCY_USD[ccy] : 1;
    const seen = stopSeen.get(uid) || new Map(), now = new Map();
    const primed = stopPrimed.has(uid);
    for (const raw of open) {
      const sym = normalisePair(raw.symbol); if (!sym) continue;
      const ticket = String(raw.ticket || (sym + raw.openPrice));
      const dir = String(raw.type || '').toLowerCase().indexOf('sell') >= 0 ? -1 : 1;
      const side = dir > 0 ? 'buy' : 'sell';
      const entry = parseFloat(raw.open_price || raw.openPrice || raw.entry || 0);
      const sl = parseFloat(raw.sl || raw.stopLoss || 0);
      const lots = Math.abs(parseFloat(raw.lots || raw.volume || 0));
      if (!entry || !lots) continue;
      const pip = pipOf(sym), pipVal = pipValOf(sym);
      if (!sl) {
        now.set(ticket, 'nostop');
        if (primed && seen.get(ticket) !== 'nostop')
          notify.notifyUser(uid, { kind: 'stop', sub: 'stop', urgent: false, tag: 'bw-stop-' + ticket, url: '/dashboard',
            title: `Stop Radar: ${sym} ${side} has no stop loss`, body: 'This position is open with nothing protecting it. Click to open Math Dashboard.' });
        continue;
      }
      /* the price the position would close at; the EA sends no current price for positions,
         so the watchlist's live quote is used, and failing that the floating profit is
         turned back into a distance, exactly as the Math Dashboard does */
      let price = priceFor(f.st, sym, dir > 0 ? 'bid' : 'ask');
      if (!(price > 0)) {
        const perUnit = lots * (pipVal / pip), profit = parseFloat(raw.profit || 0);
        price = perUnit > 0 ? entry + dir * ((profit * rate) / perUnit) : entry;
      }
      const full = Math.abs(entry - sl);
      const left = Math.max(0, dir > 0 ? price - sl : sl - price);
      const pct = full > 0 ? Math.max(0, Math.min(100, (1 - left / full) * 100)) : 0;
      const lockedPips = (dir > 0 ? sl - entry : entry - sl) / pip;
      const protectedNow = lockedPips >= -0.5;            /* a stop at or past entry is not a risk */
      const hot = !protectedNow && pct >= warn;
      const was = seen.get(ticket);
      if (hot) {
        now.set(ticket, 'hot');
        if (primed && was !== 'hot')
          notify.notifyUser(uid, { kind: 'stop', sub: 'stop', urgent: true, tag: 'bw-stop-' + ticket, url: '/dashboard',
            title: `Stop Radar: ${sym} ${side} is ${Math.round(pct)}% of the way to its stop`,
            body: `${(left / pip).toFixed(1)} pips left. Click to open Math Dashboard.` });
      } else if (was === 'hot' && pct >= warn - 10) {
        now.set(ticket, 'hot');      /* a little room before it can fire again, so 70% ↔ 69% does not repeat */
      }
    }
    stopSeen.set(uid, now); stopPrimed.add(uid);
  }

  /* ── 2. SMC ZONES (EA v5.1 zone states) ── */
  const RANK = { confirmed: 3, sweeping: 2, 'in-zone': 1, approaching: 1 };
  const zoneSeen = new Map();     // uid -> Map(pair|tf -> signature)
  const zonePrimed = new Set();
  function zoneTick(uid) {
    const f = feed(uid); if (!f || !deps.smcStore) return;
    const prefix = f.scope + '::';
    const seen = zoneSeen.get(uid) || new Map(), now = new Map();
    const primed = zonePrimed.has(uid);
    for (const k of Object.keys(deps.smcStore)) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length), parts = rest.split('::');
      const sym = normalisePair(parts[0]), tf = (parts[1] || 'H1').toUpperCase();
      const node = deps.smcStore[k];
      if (!node || !Array.isArray(node.sweeps)) continue;          /* EA older than v5.1: nothing to read */
      const age = Date.now() - bwDate(node.receivedAt).getTime();
      if (!(age < 20 * 60 * 1000)) continue;
      const best = node.sweeps.filter(w => RANK[w.state]).sort((a, b) => RANK[b.state] - RANK[a.state])[0];
      const key = sym + '|' + tf;
      if (!best) continue;
      const sig = best.state + '|' + best.low + '|' + best.high;
      now.set(key, sig);
      if (!primed || seen.get(key) === sig) continue;
      const prevRank = seen.has(key) ? (RANK[String(seen.get(key)).split('|')[0]] || 0) : 0;
      const sameZone = seen.has(key) && String(seen.get(key)).split('|').slice(1).join('|') === (best.low + '|' + best.high);
      if (sameZone && RANK[best.state] <= prevRank) continue;      /* only news: a new zone, or the same zone getting more serious */
      const bull = String(best.direction || '').toLowerCase().startsWith('bull');
      const kind = bull ? 'demand block' : 'supply block';
      const red = best.state === 'confirmed' || best.state === 'sweeping';
      const what = best.state === 'confirmed' ? 'swept and reclaimed the ' : best.state === 'sweeping' ? 'swept the ' : 'approaching the ';
      const px = priceFor(f.st, sym, 'bid'), pip = pipOf(sym), lo = +best.low, hi = +best.high;
      const away = px > 0 && !(px >= lo && px <= hi) ? Math.round((px > hi ? px - hi : lo - px) / pip) : null;
      const dg = digitsOf(sym);
      notify.notifyUser(uid, { kind: 'smc', sub: 'smczone', urgent: red, tag: `bw-smc-${sym}-${tf}`, url: '/dashboard',
        title: `SMC Panel: ${sym} ${tf} ${what}${kind}`,
        body: `Zone ${lo.toFixed(dg)} – ${hi.toFixed(dg)}` + (away != null && !red ? ` · ${away} pips away` : '') + '. Click to open SMC Panel.' });
    }
    zoneSeen.set(uid, now); zonePrimed.add(uid);
  }

  /* ── 3. RISK RADAR (the Assistant's engine, unchanged) ── */
  let rrSrc = null;
  function rrSource() {
    if (rrSrc !== null) return rrSrc;
    try { rrSrc = fs.readFileSync(path.join(dir, 'risk-radar.js'), 'utf8'); }
    catch (e) { rrSrc = ''; log.warn('[NOTIFY] risk-radar.js not found next to app.js — Risk Radar alerts off'); }
    return rrSrc;
  }
  const rrCtx = new Map();        // uid -> { ctx, born, scope, pushed: {pair: rank} }
  const LV = { clear: 0, caution: 1, elevated: 2, standdown: 3 };
  function smcBag(scope, tf) {
    const out = {}, prefix = scope + '::';
    for (const k of Object.keys(deps.smcStore || {})) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (tf === 'H1' && !rest.includes('::')) out[rest] = deps.smcStore[k];
      if (tf === 'H4' && rest.endsWith('::H4')) out[rest.slice(0, -4)] = deps.smcStore[k];
    }
    return out;
  }
  function makeCtx(uid, scope) {
    const src = rrSource(); if (!src) return null;
    const quiet = { log() {}, warn() {}, error() {} };
    const ctx = {
      console: quiet, setTimeout, clearTimeout,
      localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      normalisePair, bwDate,
      state: { watchlist: [], news: [] }, dataBySymbol: {},
      fetch: (url) => {
        const s = (rrCtx.get(uid) || {}).scope || scope;
        const bag = /\/smc\/tf\/H4/.test(url) ? smcBag(s, 'H4') : smcBag(s, 'H1');
        return Promise.resolve({ ok: true, json: () => Promise.resolve(bag) });
      }
    };
    ctx.window = ctx;
    try { vm.createContext(ctx); vm.runInContext(src, ctx, { timeout: 2000, filename: 'risk-radar.js' }); }
    catch (e) { log.warn('[NOTIFY] Risk Radar engine failed to load:', e.message); return null; }
    return ctx.BWRiskRadar ? ctx : null;
  }
  function riskTick(uid) {
    const f = feed(uid); if (!f) return;
    let r = rrCtx.get(uid);
    if (!r || r.scope !== f.scope) {
      const ctx = makeCtx(uid, f.scope); if (!ctx) return;
      r = { ctx, born: Date.now(), scope: f.scope, pushed: {} };
      rrCtx.set(uid, r);
    }
    const st = f.st, ctx = r.ctx;
    ctx.state.watchlist = st.watchlist || [];
    ctx.state.news = (deps.news && deps.news()) || [];
    const dbs = {};
    Object.keys(st.candles || {}).forEach(raw => {
      const sym = normalisePair(raw);
      dbs[sym] = { candlesByTF: st.candles[raw] || {}, patternsByTF: (st.patterns || {})[raw] || {}, indicatorsByTF: (st.indicatorsBySymbol || {})[raw] || {} };
    });
    ctx.dataBySymbol = dbs;
    try { ctx.BWRiskRadar.cycle(); } catch (e) { log.warn('[NOTIFY] Risk Radar cycle failed:', e.message); return; }
    const warm = Date.now() - r.born > 3 * 60 * 1000;   /* spreads need a few minutes of samples; record only until then */
    for (const k of Object.keys(ctx.BWRiskRadar.mem || {})) {
      const m = ctx.BWRiskRadar.mem[k]; if (!m || !m.level) continue;
      const rank = LV[m.level.key] || 0, had = r.pushed[m.sym] || 0;
      if (rank < 2) { r.pushed[m.sym] = 0; continue; }            /* back to Clear/Caution: may alert again later */
      if (rank <= had) continue;
      r.pushed[m.sym] = rank;
      if (!warm) continue;
      const why = (m.factors || []).slice(0, 2).map(x => x.label).join(', ');
      notify.notifyUser(uid, { kind: 'risk', sub: 'risk', urgent: rank === 3, tag: 'bw-risk-' + m.sym, url: '/dashboard',
        title: `Risk Radar: ${m.sym} — ${m.level.name}`,
        body: (why ? why + '. ' : '') + (m.level.advice || '') + ' Click to open MT5 Assistant.' });
    }
  }

  /* ── the loop ── */
  let busy = false;
  async function tick() {
    if (busy) return; busy = true;
    try {
      const users = notify.watchedUsers ? notify.watchedUsers() : [];
      for (const uid of users) {
        try { await stopTick(uid); } catch (e) { log.warn('[NOTIFY] stop watch:', e.message); }
        try { zoneTick(uid); } catch (e) { log.warn('[NOTIFY] zone watch:', e.message); }
        try { riskTick(uid); } catch (e) { log.warn('[NOTIFY] risk watch:', e.message); }
      }
      for (const uid of rrCtx.keys()) if (!users.includes(uid)) rrCtx.delete(uid);   /* alerts switched off everywhere */
    } finally { busy = false; }
  }
  if (!deps.noTimers) setInterval(tick, deps.everyMs || 10000).unref?.();

  return { tick, _test: { stopTick, zoneTick, riskTick, normalisePair, bwDate, rrCtx, stopSeen, zoneSeen } };
};
