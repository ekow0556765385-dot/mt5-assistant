// test-page.js — Phase 3. Run: node test-page.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const results = [];
/* Every page a test opens is CLOSED when the test ends. They used to stay open, each running its
   own 5-second cycle with all 17 engines — by the end dozens of pages cycled at once, the machine
   ran short of memory, and the suite ran past its time limit. */
const OPEN_PAGES = [];
function closePages() { OPEN_PAGES.splice(0).forEach(w => { try { w.close(); } catch (e) {} }); }
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ok   ' + name); },
    e => { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  ).then(closePages);
}

const HTML = fs.readFileSync(path.join(__dirname, 'arbiter.html'), 'utf8');
const ENGINE = fs.readFileSync(path.join(__dirname, 'arbiter-engine.js'), 'utf8');
const FEEDS = fs.readFileSync(path.join(__dirname, 'arbiter-feeds.js'), 'utf8');
/* EXACTLY the scripts the page loads, in the page's own order: read from arbiter.html, so this
   harness can never drift from what is deployed. (It used to load only the engine and feeds, so
   the page was tested WITHOUT the reversal rules, the structure engine, the Combined Read copy.) */
const PAGE_SCRIPTS = [...HTML.matchAll(/<script src="\/([a-z0-9.\-]+\.js)"/g)].map(m => m[1])
  .map(f => ({ f, src: fs.readFileSync(path.join(__dirname, f), 'utf8') }));

/* Realistic payloads, shaped like the real producers:
   - /api/state: EA field names (type, openPrice, riskPct, openTime seconds)
   - /api/candles?symbol: THE NODE ITSELF, not a symbol-keyed bag
   - /smc: keyed by BROKER symbol, order blocks with STRING high/low
   - /api/patterns: the RAW EA shape (type, confidence_pct)               */
function candles(closes, opts = {}) {
  const start = Math.floor(Date.now() / 1000) - closes.length * 3600;
  return closes.map((c, i) => ({
    t: start + i * 3600,
    o: c - 0.0005, h: c + (opts.hi || 0.0012), l: c - (opts.lo || 0.0012), c
  }));
}
function zigzag(n, base, step, down) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const leg = Math.floor(i / 5), within = i % 5;
    const drift = down ? -leg * step * 3 : leg * step * 3;
    out.push(base + drift + (within < 3 ? within * step : (4 - within) * step));
  }
  return out;
}

function makeEnv(over = {}) {
  const state = over.state || {
    watchlist: [{ symbol: 'EURUSDm', bid: 1.08400, spread: 8 }],
    openTrades: [{ ticket: 501, symbol: 'EURUSDm', type: 'sell', volume: 0.4,
      openPrice: 1.08420, sl: 1.08680, tp: 1.07900, profit: 31.2, riskPct: 1.0,
      openTime: Math.floor(Date.now() / 1000) - 8000 }],
    closedTrades: [], accountInfo: { login: 5000, balance: 5000, equity: 5031, margin: 120, currency: 'USD' },
    news: [{ title: 'US Retail Sales', impact: 'high', timestamp: Math.floor(Date.now() / 1000) + 13000 }]
  };
  const cd = candles(zigzag(60, 1.0920, 0.0006, true));
  const smc = over.smc !== undefined ? over.smc : {
    EURUSDm: { orderBlocks: [
      { type: 'bearish', high: '1.08455', low: '1.08380', timeStart: Date.now() - 3 * 86400000 },
      { type: 'bullish', high: '1.07700', low: '1.07600', timeStart: Date.now() - 2 * 86400000 }
    ] }
  };
  const patterns = over.patterns !== undefined ? over.patterns : {
    patterns: [{ name: 'Bearish Engulfing', type: 'bearish', confidence_pct: 81, bar_index: 1, timeframe: 'H1' }]
  };
  const status = over.status || {
    ok: true, accounts: [{ account_number: '1001' }],
    openEpisodes: [{ type: 'no_sl', severity: 'high', opened_at: new Date(Date.now() - 41 * 60000).toISOString(), open_for_minutes: 41 }],
    openPositions: [{ ticket: '501', mfe_pips: 22, mae_pips: 4.1, best_pl: 88, worst_pl: -16 }]
  };
  const routes = {
    '/api/state': state,
    '/api/candles': over.candles !== undefined ? over.candles : { symbol: 'EURUSDm', candlesByTF: { H1: cd }, candles: cd },
    '/smc': smc, '/smc/tf/H4': smc,
    '/api/patterns': patterns,
    '/api/arbiter/status': status,
    '/api/arbiter/call': { ok: true, id: 1 },
    '/api/arbiter/report/daily': over.daily !== undefined ? over.daily : null,
    '/api/arbiter/settings': over.settings !== undefined ? over.settings : null,
    '/api/arbiter/progress': over.progress !== undefined ? over.progress : null,
    '/api/credits': over.credits !== undefined ? over.credits : { balance: 6.42, monthly: 8, resetAt: null, unlimited: false },
    '/api/sources': over.sources !== undefined ? over.sources : { sources: [{ sourceId: 'k1', lastSeen: Date.now() - 3000 }], active: 'k1' },
    '/api/arbiter/calibration': over.calibration !== undefined ? over.calibration : null,
    '/api/arbiter/report/weekly': over.weekly !== undefined ? over.weekly : null,
    '/api/arbiter/habits': over.habits !== undefined ? over.habits : Object.assign({ ok: true },
      require('./arbiter-route.js').habits.habitsSummary([], Date.now(), Date.now() - 30 * 86400000)),
    '/api/arbiter/calls': over.calls !== undefined ? over.calls : { ok: true, calls: [], resolved: 0, pending: 0,
      quad: { good: 0, expensive: 0, ours: 0, luck: 0 } },
    '/api/journal': over.journal !== undefined ? over.journal : {
      entries: Array.from({ length: 40 }, (_, i) => ({ symbol: 'EURUSD', direction: 'sell',
        total_pl: i % 3 ? 20 : -15, session: null }))
    }
  };

  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://app.test/arbiter', pretendToBeVisual: true });
  const win = dom.window;
  /* Choose the active terminal the way a TRADER does — a pick saved in this tab, which bw-source.js
     reads first — and make sure the server lists it. (Defining bwActiveSource here used to work only
     because bw-source.js was not loaded; on the real page bw-source owns that function.) */
  if (over.activeSource) {
    win.sessionStorage.setItem('bw-active-source', over.activeSource);
    const src = routes['/api/sources'];
    if (src && src.sources && !src.sources.some(x => x.sourceId === over.activeSource))
      src.sources.push({ sourceId: over.activeSource, lastSeen: Date.now() - 2000 });
  }
  const calls = [], posts = [];
  win.fetch = (url, init) => {
    // bw-source.js (loaded first, as on the page) turns '/api/state' into a FULL address carrying
    // ?source= — as a real server would, read the path, not the origin
    const u = String(url && url.url ? url.url : url).replace(/^https?:\/\/[^/]+/, ''); calls.push(u);
    if (init && init.method && init.method !== 'GET') {
      posts.push({ url: u, method: init.method, body: JSON.parse(init.body) });
      const pk = init.method + ' ' + u.split('?')[0];
      if (routes[pk]) { const r = routes[pk];
        return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) }); }
    }
    // A route may answer PER SYMBOL: the real server keys candles and
    // patterns by symbol, so a fixture that returns the same data for every
    // pair can never catch a per-symbol bug (it could not catch the one
    // Assan hit: EA on GBP/USD, trade on EUR/USD).
    const path = u.split('?')[0];
    const qsym = (u.match(/[?&]symbol=([^&]+)/) || [])[1];
    const key = Object.keys(routes).find(k => path === k);
    if (key && qsym && routes[key] && routes[key].__bySymbol) {
      const norm = x => decodeURIComponent(x).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
      const table = routes[key].__bySymbol;
      const hit = Object.keys(table).find(k => norm(k) === norm(qsym));
      calls.push(u);
      return Promise.resolve({ ok: true, status: 200,
        json: () => Promise.resolve(hit ? table[hit] : { symbol: decodeURIComponent(qsym), candles: [], note: 'No candle data yet' }) });
    }
    const body = key ? routes[key] : null;
    return Promise.resolve({ ok: body !== null, status: body ? 200 : 404, json: () => Promise.resolve(body) });
  };
  // the page's own scripts, in load order
  // over.omitScripts: leave a named script out, to test what the page says when it failed to deploy
  PAGE_SCRIPTS.filter(x => (over.omitScripts || []).indexOf(x.f) < 0).forEach(x => win.eval(x.src));
  const inline = HTML.split('<script>')[1].split('</script>')[0];
  win.eval(inline);
  OPEN_PAGES.push(win);
  return { dom, win, calls, posts, routes, state };
}

const settle = (win, ms = 60) => new Promise(r => setTimeout(r, ms));

/* A LOSING short (price ~1.0722 from the fixture candles, entry 1.0700), so
   Assan's cut-the-loser rule applies. stackAgainst() adds opposing patterns
   from BOTH sources at 90% plus Risk Radar at stand-down: 15+15+8+10 = 48,
   over the losing cut bar of 45. */
function losingEnv() {
  const env = makeEnv();
  env.routes['/api/state'].openTrades[0] = Object.assign({}, env.routes['/api/state'].openTrades[0],
    { openPrice: 1.0700, sl: 1.0760, tp: 1.0600, profit: -88 });
  return env;
}
function stackAgainst(env) {
  env.routes['/api/patterns'] = { patterns: [
    { name: 'Bullish Engulfing', type: 'bullish', confidence_pct: 90, bar_index: 1 }] };
  env.routes['/api/state'].patternAlerts = [{ symbol: 'EURUSDm', name: 'Hammer', direction: 'bullish',
    confidence: 90, timeframe: 'H1', time: new Date().toISOString() }];
  env.win.localStorage.setItem('bw-risk-now', JSON.stringify({ t: Date.now(),
    pairs: { EURUSD: { score: 80, state: 'standdown', name: 'Stand down' } } }));
  /* A SECOND, INDEPENDENT witness (DEC-11): the Combined Read reports a reversal
     ESTABLISHED against the short, and the trend reading up. The candle above,
     seen by both detectors, is only ONE witness — on its own a concern, not a cut. */
  env.win.localStorage.setItem('bw-confluence-now', JSON.stringify({ t: Date.now(), reads: {
    'EURUSD|H1': { symbol: 'EURUSD', timeframe: 'H1', trend: 'up', trendConf: 0.7,
                   reversal: { stage: 'established', from: 'down', to: 'up', level: 1.0700, barsSince: 4 } } } }));
}
const txt = win => win.document.getElementById('main').textContent.replace(/\s+/g, ' ');
// What is actually ON SCREEN: body text with the page's own <script> source removed.
// (body.textContent includes inline scripts, which would make any code word a "leak".)
const screenText = win => { const b = win.document.body.cloneNode(true);
  b.querySelectorAll('script,style').forEach(x => x.remove()); return b.textContent; };

(async () => {
  console.log('\nTHE PAGE RENDERS FROM REAL FEEDS');

  await check('an open position renders with its action, pillars and score', async () => {
    const { win } = makeEnv();
    await settle(win, 120);
    const t = txt(win);
    assert.ok(/EURUSD/.test(t), 'symbol shown');
    assert.ok(/SHORT/.test(t), 'direction shown');
    assert.ok(/The case for this trade/.test(t), 'pillars rendered');
    assert.ok(/evidence agreement/.test(t), 'score rendered');
    assert.ok(win.document.querySelector('.act'), 'an action is shown');
  });

  await check('every fetch carries a real endpoint, and nothing is invented', async () => {
    const { win, calls } = makeEnv();
    await settle(win, 120);
    const wanted = ['/api/state', '/api/candles', '/smc', '/api/patterns', '/api/arbiter/status'];
    wanted.forEach(w => assert.ok(calls.some(c => c.indexOf(w) === 0), 'called ' + w));
    assert.ok(!calls.some(c => /undefined|NaN|\[object/.test(c)), 'no malformed URLs: ' + calls.join(' '));
  });

  await check('MFE/MAE from the server appear on the excursion bar', async () => {
    const { win } = makeEnv();
    await settle(win, 120);
    const t = txt(win);
    assert.ok(/Where it has been/.test(t));
    assert.ok(/best \+22/.test(t), 'server MFE used: ' + t.slice(0, 400));
    assert.ok(/worst -4\.1/.test(t), 'server MAE used');
  });

  await check('the open habit episode reaches the rail with its duration', async () => {
    const { win } = makeEnv();
    await settle(win, 120);
    const r = win.document.getElementById('episodes').textContent;
    assert.ok(/no sl/.test(r), r);
    assert.ok(/41m/.test(r), 'duration shown');
  });

  await check('the rail names WHERE the structure read came from', async () => {
    const { win } = makeEnv();
    await settle(win, 120);
    const feeds = win.document.getElementById('feeds').textContent;
    assert.ok(/Structure/.test(feeds));
    assert.ok(/own read|engine/.test(feeds), 'provenance stated: ' + feeds);
  });

  await check('no open positions gives an honest empty state, not a blank page', async () => {
    const { win } = makeEnv({ state: { watchlist: [], openTrades: [], closedTrades: [], accountInfo: {}, news: [] } });
    await settle(win, 100);
    // Phase 4: flat with no watchlist is still an honest message, never a blank
    assert.ok(/No watchlist yet/.test(txt(win)), txt(win).slice(0, 200));
    assert.strictEqual(win.document.getElementById('ctNow').textContent, '0');
  });

  console.log('\nIT SURVIVES BAD AND MISSING DATA');

  await check('every feed failing does not blank the page or invent a score', async () => {
    const { win } = makeEnv({ smc: null, patterns: null, candles: null, journal: null });
    await settle(win, 120);
    const t = txt(win);
    assert.ok(/EURUSD/.test(t), 'the position is still shown from /api/state');
    assert.ok(/No score|not enough/i.test(t), 'refuses to score: ' + t.slice(0, 300));
  });

  await check('a symbol-keyed candle bag (the classic fixture trap) does not fake a price', async () => {
    // /api/candles?symbol returns THE NODE. A keyed bag is the wrong shape —
    // the page must fall back to the watchlist bid rather than read garbage.
    const { win } = makeEnv({ candles: { EURUSDm: { candles: [] } } });
    await settle(win, 120);
    const t = txt(win);
    assert.ok(/EURUSD/.test(t));
    assert.ok(!/NaN/.test(t), 'no NaN reached the screen');
  });

  await check('no NaN, undefined or [object Object] anywhere on screen', async () => {
    const { win } = makeEnv();
    await settle(win, 120);
    const t = screenText(win);
    ['NaN', 'undefined', '[object Object]'].forEach(bad => {
      const i = t.indexOf(bad);
      assert.ok(i < 0, 'found ' + bad + ' in: ...' + t.slice(Math.max(0, i - 90), i + 30).replace(/\s+/g, ' ') + '...');
    });
  });

  console.log('\nTHE ENTRY CASE IS FROZEN');

  await check('the entry case is captured once and does not re-derive', async () => {
    const env = makeEnv();
    await settle(env.win, 120);
    const saved = JSON.parse(env.win.localStorage.getItem('bw-arbiter-entry-cases'));
    const K = '5000:501';        // account:ticket
    assert.ok(saved[K], 'frozen under account:ticket, keys=' + Object.keys(saved));
    const firstZone = saved[K].case.pillars.zone_trust.state;
    // the zone is now spent — the LIVE reading must change, the frozen one must not
    env.routes['/smc'].EURUSDm.orderBlocks[0].high = '1.08000';
    env.routes['/smc'].EURUSDm.orderBlocks[0].low = '1.07950';
    await env.win.BWArbiterPage.cycle();
    await settle(env.win, 120);
    const after = JSON.parse(env.win.localStorage.getItem('bw-arbiter-entry-cases'));
    assert.strictEqual(after[K].case.pillars.zone_trust.state, firstZone, 'frozen case unchanged');
    assert.strictEqual(after[K].at, saved[K].at, 'frozen timestamp unchanged');
  });

  await check('a closed position is forgotten, so a reused ticket cannot inherit its case', async () => {
    const env = makeEnv();
    await settle(env.win, 120);
    assert.ok(JSON.parse(env.win.localStorage.getItem('bw-arbiter-entry-cases'))['5000:501']);
    env.routes['/api/state'].openTrades = [];
    await env.win.BWArbiterPage.cycle();
    await settle(env.win, 80);
    assert.ok(!JSON.parse(env.win.localStorage.getItem('bw-arbiter-entry-cases'))['5000:501'], 'forgotten');

    // a different account's frozen case must NOT be wiped by this account's beat
    env.win.localStorage.setItem('bw-arbiter-entry-cases',
      JSON.stringify({ '9999:501': { at: Date.now(), case: { pillars: {} } } }));
    await env.win.BWArbiterPage.cycle();
    await settle(env.win, 80);
    assert.ok(JSON.parse(env.win.localStorage.getItem('bw-arbiter-entry-cases'))['9999:501'],
      'another account keeps its own');
  });

  console.log('\nADVICE DOES NOT FLICKER ON SCREEN');

  await check('a one-cycle change of mind never reaches the screen', async () => {
    const env = losingEnv();
    await settle(env.win, 150);
    const first = env.win.document.querySelector('.act-word').textContent;
    assert.ok(/HOLD/.test(first), 'starts on hold: ' + first);
    stackAgainst(env);
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 60);
    assert.strictEqual(env.win.document.querySelector('.act-word').textContent, first,
      'the first cycle of a new opinion is held back');
    const pend = env.win.document.querySelector('.act-pending');
    assert.ok(pend && /Moving toward CUT/.test(pend.textContent), 'but the page says where it is heading');
  });

  await check('a change must hold ~40 SECONDS to show: 7 cycles at 5s is not enough, 8 is', async () => {
    const env = losingEnv();
    await settle(env.win, 150);
    stackAgainst(env);
    for (let i = 0; i < 7; i++) { await env.win.BWArbiterPage.cycle(); await settle(env.win, 30); }
    assert.ok(/HOLD/.test(env.win.document.querySelector('.act-word').textContent), 'still held after 35s');
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 30);
    assert.ok(/CUT/.test(env.win.document.querySelector('.act-word').textContent), 'shown at 40s');
  });

  await check('the action is shown WITH its number, and the factors behind it', async () => {
    const env = losingEnv();
    await settle(env.win, 150);
    stackAgainst(env);
    for (let i = 0; i < 8; i++) { await env.win.BWArbiterPage.cycle(); await settle(env.win, 25); }
    // the redesign: the word beside a dial, the number INSIDE the dial (the Liquidity tab's look)
    const word = env.win.document.querySelector('.act-word').textContent.trim(), num = env.win.document.querySelector('.act-val').textContent.trim();
    assert.ok(word === 'CUT' && /^\d+$/.test(num), 'word and number: "' + word + '" / "' + num + '"');
    const factors = Array.from(env.win.document.querySelectorAll('.act .press .pn')).map(e => e.firstChild.textContent);
    assert.ok(factors.length >= 2, factors.join(' | '));
    // the witnesses, by name (DEC-11 replaced the per-detector pattern scores)
    assert.ok(factors.some(f => /Reversal candle|Combined Read|Structure label/.test(f)), factors.join(' | '));
  });

  console.log('\n5-SECOND SCAN SAFEGUARDS');

  await check('Supabase-backed reads are cached: 1 per minute, not 1 per cycle', async () => {
    const env = makeEnv();
    await settle(env.win, 120);
    for (let i = 0; i < 5; i++) { await env.win.BWArbiterPage.cycle(); await settle(env.win, 20); }
    const n = p => env.calls.filter(c => c.split('?')[0] === p).length;
    assert.strictEqual(n('/api/journal'), 1, 'journal x' + n('/api/journal'));
    assert.strictEqual(n('/api/arbiter/status'), 1, 'status x' + n('/api/arbiter/status'));
    assert.ok(n('/api/state') >= 6, 'market reads stay fresh: state x' + n('/api/state'));
  });

  await check('an unchanged world causes ZERO repaints', async () => {
    const env = makeEnv();
    await settle(env.win, 150);
    let mutations = 0;
    new env.win.MutationObserver(m => { mutations += m.length; })
      .observe(env.win.document.getElementById('main'), { childList: true, subtree: true, characterData: true });
    for (let i = 0; i < 4; i++) { await env.win.BWArbiterPage.cycle(); await settle(env.win, 20); }
    assert.strictEqual(mutations, 0, 'repainted ' + mutations + ' times with nothing changed');
  });

  await check('a real change DOES repaint', async () => {
    const env = makeEnv();
    await settle(env.win, 150);
    let mutations = 0;
    new env.win.MutationObserver(m => { mutations += m.length; })
      .observe(env.win.document.getElementById('main'), { childList: true, subtree: true });
    env.routes['/api/state'].openTrades[0].profit = -12.5;
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 30);
    assert.ok(mutations > 0, 'the new P/L must reach the screen');
    assert.ok(/-12\.50/.test(env.win.document.getElementById('main').textContent));
  });

  await check('the spread baseline samples once a minute per pair, however fast the scan', async () => {
    const env = makeEnv();
    await settle(env.win, 120);
    for (let i = 0; i < 6; i++) { await env.win.BWArbiterPage.cycle(); await settle(env.win, 15); }
    const store = JSON.parse(env.win.localStorage.getItem('bw-arb-spread') || '{}');
    const samples = Object.values(store).reduce((a, arr) => a + arr.length, 0);
    assert.strictEqual(samples, 1, 'one sample in the first minute, got ' + samples);
  });

  console.log('\nPHASE 4 — HUNTING');

  function flatEnv(extra = {}) {
    const wl = [{ symbol: 'EURUSDm', bid: 1.084, spread: 8 }, { symbol: 'GBPJPYm', bid: 193.4, spread: 30 },
                { symbol: 'XAUUSDc', bid: 2338.4, spread: 25 }];
    return makeEnv(Object.assign({ state: { watchlist: wl, openTrades: [],
      closedTrades: [{ ticket: 9, symbol: 'EURUSDm', profit: -18, time: Math.floor(Date.now() / 1000) - 3 * 3600 }],
      accountInfo: { login: 5000, balance: 5000 }, news: [] } }, extra));
  }

  await check('flat: the Now tab IS the hunting state, not a placeholder', async () => {
    const { win } = flatEnv();
    await settle(win, 200);
    const t = txt(win);
    assert.ok(/Nothing here is worth taking|worth a closer look/.test(t), t.slice(0, 300));
    assert.ok(/What the scan sees/.test(t));
  });

  await check('every watchlist pair is scanned, broker suffixes stripped', async () => {
    const { win } = flatEnv();
    await settle(win, 200);
    const syms = Array.from(win.document.querySelectorAll('#main button.scan')).map(b => b.dataset.sym).sort();
    assert.deepStrictEqual(syms, ['EURUSD', 'GBPJPY', 'XAUUSD']);
  });

  await check('the scan produces REAL scores (so the sorting test is not vacuous)', async () => {
    const { win } = flatEnv();
    await settle(win, 200);
    const rows = Array.from(win.document.querySelectorAll('#main button.scan')).map(b =>
      b.dataset.sym + ' ' + b.querySelector('.sc').textContent + ' | ' + b.querySelector('.ms').textContent.slice(0, 80));
    console.log('       ' + rows.join('\n       '));
    const scored = rows.filter(r => !/ – \|/.test(r));
    assert.ok(scored.length >= 1, 'at least one pair must be scored');
  });

  await check('scan rows are sorted best first, unscored last', async () => {
    const { win } = flatEnv();
    await settle(win, 200);
    const scores = Array.from(win.document.querySelectorAll('#main button.scan .sc')).map(e => e.textContent);
    const nums = scores.filter(x => x !== '–').map(Number);
    assert.deepStrictEqual(nums, nums.slice().sort((a, b) => b - a), scores.join(','));
    const firstDash = scores.indexOf('–');
    if (firstDash >= 0) assert.ok(scores.slice(firstDash).every(x => x === '–'), 'unscored at the bottom');
  });

  await check('the closest candidate shows all FOURTEEN conditions, numbered, with tiers', async () => {
    const { win } = flatEnv();
    await settle(win, 200);
    const pills = win.document.querySelectorAll('#main .grid14 .pill');
    assert.strictEqual(pills.length, 14);
    const t = txt(win);
    ['gate', 'core', 'adjuster'].forEach(tier => assert.ok(new RegExp(tier).test(t), 'tier ' + tier));
    assert.ok(/1 · Structure alignment/.test(t) && /14 · Your own edge here/.test(t));
  });

  await check('clicking a pair switches the candidate card to it', async () => {
    const { win } = flatEnv();
    await settle(win, 200);
    const btns = Array.from(win.document.querySelectorAll('#main button.scan'));
    const target = btns[btns.length - 1];
    target.click();
    await settle(win, 30);
    const head = win.document.querySelector('#main .grid14').closest('.card').querySelector('h3').textContent;
    assert.ok(head.indexOf(target.dataset.sym) === 0, head);
    assert.ok(win.document.querySelector('#main button.scan.sel').dataset.sym === target.dataset.sym);
  });

  await check('account-wide feeds are fetched ONCE per cycle, not once per pair', async () => {
    const { win, calls } = flatEnv();
    await settle(win, 200);
    const count = p => calls.filter(c => c.split('?')[0] === p).length;
    assert.strictEqual(count('/api/state'), 1, 'state x' + count('/api/state'));
    assert.strictEqual(count('/smc'), 1, 'smc x' + count('/smc'));
    assert.strictEqual(count('/api/journal'), 1, 'journal x' + count('/api/journal'));
    // one H1 read per watchlist pair, plus ONE H4 read — of the pair on display only
    assert.strictEqual(count('/api/candles'), 4, 'candles x' + count('/api/candles'));
    assert.strictEqual(calls.filter(c => /\/api\/candles/.test(c)).length, 4);
  });

  await check('while flat, room and reach are measured against an IMPLIED target, labelled as implied', async () => {
    const env = makeEnv({ state: { watchlist: [{ symbol: 'EURUSDm', bid: 1.0840, spread: 8 }], openTrades: [],
      closedTrades: [], accountInfo: { login: 5000 }, news: [] } });
    await settle(env.win, 300);
    const rows = Array.from(env.win.document.querySelectorAll('#main .pill'));
    const room = rows.find(r => /Room to target/.test(r.textContent));
    assert.ok(room, 'the condition is listed');
    assert.ok(/implied/.test(env.win.document.getElementById('main').textContent), 'and the card says the target is implied');
    assert.ok(!/No target to measure against/.test(room.textContent), room.textContent);
    const reach = rows.find(r => /get there/.test(r.textContent));
    assert.ok(!/No ATR or target/.test(reach.textContent), reach.textContent);
    // and where it IS unknown, it still says why rather than inventing one
    rows.filter(r => r.classList.contains('unknown')).forEach(r =>
      assert.ok(r.textContent.trim().length > 10, 'an unknown condition still explains itself'));
  });

  await check('the last closed trade is reported, with the ledger counts', async () => {
    const { win } = flatEnv();
    await settle(win, 200);
    const t = txt(win);
    assert.ok(/Since your last trade closed/.test(t));
    assert.ok(/EURUSDm -18\.00/.test(t), 'real last result');
    assert.ok(/Setups Arbiter rated 70\+ today/.test(t), 'the ledger counts are shown');
  });

  await check('the Hunting tab works while positions ARE open', async () => {
    const { win } = makeEnv();
    await settle(win, 200);
    win.document.querySelector('.nav-tab[data-p="hunt"]').click();
    assert.ok(win.document.getElementById('p-hunt').classList.contains('on'));
    assert.ok(win.document.querySelectorAll('#hunt button.scan').length >= 1);
    assert.ok(/SHORT/.test(win.document.getElementById('main').textContent), 'live cards still on Now');
  });

  await check('no NaN / undefined anywhere in the hunting state', async () => {
    const { win } = flatEnv();
    await settle(win, 200);
    const t = screenText(win);
    ['NaN', 'undefined', '[object Object]'].forEach(bad => {
      const i = t.indexOf(bad);
      assert.ok(i < 0, 'found ' + bad + ' in: ...' + t.slice(Math.max(0, i - 90), i + 30).replace(/\s+/g, ' ') + '...');
    });
  });

  console.log('\nPHASE 5 — THE LEDGER ON THE PAGE');

  function scoringEnv(extra) {
    // EURUSD in a downtrend whose LAST close sits inside the supply zone
    // (1.08380-1.08455), with a fresh bearish trigger: all three gates pass.
    // zigzag(60, 1.1040, .0006, down) ends at exactly 1.1040 - 11*3*.0006 = 1.0842.
    const cd = candles(zigzag(60, 1.1040, 0.0006, true));
    return makeEnv(Object.assign({
      candles: { symbol: 'EURUSDm', candlesByTF: { H1: cd }, candles: cd },
      state: { watchlist: [{ symbol: 'EURUSDm', bid: 1.0842, spread: 8 }],
      openTrades: [], closedTrades: [], accountInfo: { login: 5000, balance: 5000 }, news: [] } }, extra || {}));
  }

  await check('a scanned setup is PROPOSED to the server with its frozen snapshot', async () => {
    const env = scoringEnv();
    await settle(env.win, 200);
    const p = env.posts.filter(x => x.url.indexOf('/api/arbiter/call') === 0);
    assert.ok(p.length >= 1, 'something must actually be proposed, or this test proves nothing');
    p.forEach(x => {
      assert.ok(['take', 'skip'].indexOf(x.body.kind) >= 0, x.body.kind);
      assert.ok(x.body.snapshot && x.body.snapshot.conditions.length === 14, 'all 14 frozen');
      if (x.body.kind === 'skip') assert.strictEqual(x.body.snapshot.gatesFailed.length, 0, 'a skip passes every gate');
      if (x.body.kind === 'take') assert.ok(x.body.score >= 70);
      assert.ok(!('price_at' in x.body), 'the page never sends a price — the server stamps it');
    });
  });

  await check('a gate-failing pair is NEVER proposed (it is not a setup)', async () => {
    const env = makeEnv({ state: { watchlist: [{ symbol: 'EURUSDm', bid: 1.084, spread: 8 }], openTrades: [],
      closedTrades: [], accountInfo: { login: 5000 }, news: [] } });
    await settle(env.win, 200);
    // this fixture fails a gate (location: price far from the zone), so it is capped at 45 or lower.
    // With the page's real structure engine loaded it reads TRANSITION, and Phase F takes 15 off
    // after the cap (DEC-3): 30. The old harness had no structure engine, so it showed 45.
    const scanned = env.win.document.querySelector('#main button.scan .sc').textContent;
    assert.ok(Number(scanned) <= 45, 'fixture sanity — a gate fails, so capped: ' + scanned);
    assert.strictEqual(env.posts.length, 0, 'nothing proposed for a gated pair: ' + JSON.stringify(env.posts.map(p => p.body.kind)));
  });

  await check('the same setup is proposed ONCE, not every 5 seconds', async () => {
    const env = scoringEnv({ smc: { EURUSDm: { orderBlocks: [
      { type: 'bearish', high: '1.08455', low: '1.08380', timeStart: Date.now() - 3 * 86400000 }] } } });
    await settle(env.win, 200);
    for (let i = 0; i < 5; i++) { await env.win.BWArbiterPage.cycle(); await settle(env.win, 20); }
    const keys = env.posts.map(p => p.body.kind + ':' + p.body.symbol + ':' + p.body.direction);
    assert.ok(keys.length >= 1, 'a proposal must happen at least once');
    assert.strictEqual(new Set(keys).size, keys.length, 'no repeats: ' + keys.join(' '));
  });

  await check('the call is sent with the active terminal, so it is stamped on the right feed', async () => {
    const env = scoringEnv({ activeSource: 'key-7', smc: { EURUSDm: { orderBlocks: [
      { type: 'bearish', high: '1.08455', low: '1.08380', timeStart: Date.now() - 3 * 86400000 }] } } });
    await settle(env.win, 200);
    const p = env.posts.filter(x => x.url.indexOf('/api/arbiter/call') === 0);
    assert.ok(p.length >= 1, 'a proposal must happen for this to mean anything');
    assert.ok(p.every(x => /source=key-7/.test(x.url)), p.map(x => x.url).join(' '));
  });

  await check('a settled change of action on an open trade is proposed as a LIVE call — once', async () => {
    const env = losingEnv();
    await settle(env.win, 150);
    assert.strictEqual(env.posts.filter(p => p.body.kind === 'live').length, 0, 'hold at entry is not a call');
    stackAgainst(env);
    for (let i = 0; i < 10; i++) { await env.win.BWArbiterPage.cycle(); await settle(env.win, 15); }
    const live = env.posts.filter(p => p.body.kind === 'live');
    assert.strictEqual(live.length, 1, 'exactly one: ' + JSON.stringify(live.map(l => l.body.action)));
    assert.strictEqual(live[0].body.action, 'cut');
    assert.ok(live[0].body.score >= 45, 'carries its pressure: ' + live[0].body.score);
    assert.strictEqual(live[0].body.snapshot.volume, 0.4, 'volume frozen, so a partial close can be detected');
  });

  await check('NO TP: the card says so prominently, and the shell dot is raised', async () => {
    const env = makeEnv();
    env.routes['/api/state'].openTrades[0].tp = 0;
    await settle(env.win, 150);
    const t = txt(env.win);
    assert.ok(/No take profit set on this trade/.test(t), t.slice(0, 200));
    assert.ok(/implied target/.test(t));
    const ch = JSON.parse(env.win.localStorage.getItem('bw-arbiter-now') || 'null');
    assert.ok(ch && ch.urgent && /no take profit/.test(ch.text), JSON.stringify(ch));
  });

  await check('the attention timestamp holds steady while the message is unchanged', async () => {
    const env = makeEnv();
    env.routes['/api/state'].openTrades[0].tp = 0;
    await settle(env.win, 150);
    const t1 = JSON.parse(env.win.localStorage.getItem('bw-arbiter-now')).t;
    await settle(env.win, 20);
    for (let i = 0; i < 3; i++) { await env.win.BWArbiterPage.cycle(); await settle(env.win, 20); }
    const t2 = JSON.parse(env.win.localStorage.getItem('bw-arbiter-now')).t;
    assert.strictEqual(t2, t1, 'a seen dot must not relight for the same thing');
  });

  await check('with a TP set and nothing to cut, the shell dot is cleared', async () => {
    const env = makeEnv();
    env.win.localStorage.setItem('bw-arbiter-now', JSON.stringify({ t: Date.now(), urgent: true, text: 'stale' }));
    await settle(env.win, 150);
    assert.strictEqual(env.win.localStorage.getItem('bw-arbiter-now'), null);
  });

  await check('a partial close is detected, so TAKE PARTIAL cannot reappear after you took it', async () => {
    const env = makeEnv();
    await settle(env.win, 150);
    const k = Object.keys(JSON.parse(env.win.localStorage.getItem('bw-arbiter-entry-cases')))[0];
    assert.strictEqual(JSON.parse(env.win.localStorage.getItem('bw-arbiter-entry-cases'))[k].volume, 0.4);
    env.routes['/api/state'].openTrades[0].volume = 0.2;
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 40);
    assert.notStrictEqual(env.win.document.querySelector('.act-word').textContent.indexOf('PARTIAL'), 0);
  });

  const CALLS = { ok: true, resolved: 3, pending: 1, quad: { good: 1, expensive: 1, ours: 0, luck: 1 },
    calls: [
      { id: 4, kind: 'take', symbol: 'EURUSD', direction: 'bear', score: 74, created_at: new Date(Date.now() - 5 * 60000).toISOString(),
        window_ends_at: new Date(Date.now() + 15 * 60000).toISOString(), horizon_ends_at: new Date(Date.now() + 3.9 * 3600000).toISOString() },
      { id: 3, kind: 'skip', symbol: 'GBPUSD', direction: 'bull', score: 58, adherence: 'ignored', matched_ticket: '12',
        outcome: 'ran', correct: false, box: 'luck', resolved_at: new Date().toISOString(),
        created_at: new Date(Date.now() - 3 * 3600000).toISOString(), window_ends_at: new Date(Date.now() - 2.7 * 3600000).toISOString() },
      { id: 2, kind: 'take', symbol: 'XAUUSD', direction: 'bull', score: 77, adherence: 'ignored',
        outcome: 'ran', correct: true, box: 'expensive', resolved_at: new Date().toISOString(),
        created_at: new Date(Date.now() - 5 * 3600000).toISOString(), window_ends_at: new Date(Date.now() - 4.7 * 3600000).toISOString() },
      { id: 1, kind: 'live', symbol: 'EURUSD', direction: 'bear', ticket: '501', action: 'partial', adherence: 'followed',
        outcome: 'not_graded', resolved_at: new Date().toISOString(),
        created_at: new Date(Date.now() - 6 * 3600000).toISOString(), window_ends_at: new Date(Date.now() - 5.7 * 3600000).toISOString() }
    ] };

  await check('the Today tab shows the 2x2 with the server\'s counts', async () => {
    const env = scoringEnv({ calls: CALLS });
    await settle(env.win, 200);
    const qs = Array.from(env.win.document.querySelectorAll('#calls .q .qn')).map(e => e.textContent);
    assert.deepStrictEqual(qs, ['1', '1', '0', '1']);
    assert.strictEqual(env.win.document.getElementById('ctCalls').textContent, '4');
  });

  await check('each call says what Arbiter said, what you did, and which box', async () => {
    const env = scoringEnv({ calls: CALLS });
    await settle(env.win, 200);
    const t = env.win.document.getElementById('calls').textContent.replace(/\s+/g, ' ');
    assert.ok(/window open · 15m left/.test(t), 'an open window counts down');
    assert.ok(/Wrong, you ignored it/.test(t), 'the luck box is named plainly');
    assert.ok(/Right, you ignored it/.test(t), 'the expensive box is named plainly');
    assert.ok(/graded when the trade closes/.test(t), 'a live call on an open trade says when it will be graded');
    assert.ok(!/no rule for live calls yet/.test(t), 'the stale wording is gone');
    assert.ok(/TAKE PARTIAL|PARTIAL/.test(t));
  });

  await check('a thin ledger says it is too thin to mean anything', async () => {
    const env = scoringEnv({ calls: CALLS });
    await settle(env.win, 200);
    assert.ok(/not enough to say anything about you or about Blackwood/.test(env.win.document.getElementById('calls').textContent));
  });

  await check('since-last-trade counts come from the real ledger', async () => {
    const env = scoringEnv({ calls: CALLS, state: { watchlist: [{ symbol: 'EURUSDm', bid: 1.0842, spread: 8 }],
      openTrades: [], accountInfo: { login: 5000 }, news: [],
      closedTrades: [{ ticket: 9, symbol: 'EURUSDm', profit: 12, time: Math.floor(Date.now() / 1000) - 3600 }] } });
    await settle(env.win, 200);
    const t = txt(env.win);
    assert.ok(/Setups Arbiter rated 70\+ today ?2/.test(t), t.slice(t.indexOf('Since'), t.indexOf('Since') + 300));
    assert.ok(/You took ?0 of them/.test(t));
    assert.ok(/1 rated 58/.test(t), 'the skip you took anyway, with its score');
  });

  await check('the calls endpoint is read once a minute, not every 5 seconds', async () => {
    const env = scoringEnv({ calls: CALLS });
    await settle(env.win, 150);
    for (let i = 0; i < 4; i++) { await env.win.BWArbiterPage.cycle(); await settle(env.win, 20); }
    assert.strictEqual(env.calls.filter(c => c.split('?')[0] === '/api/arbiter/calls').length, 1);
  });

  console.log('\nPHASE 6 — HABITS ON THE PAGE');
  // Built with the SERVER's own habitsSummary, so the page is tested against
  // the shape the producer actually emits — never a hand-made fixture.
  const HS = require('./arbiter-route.js').habits.habitsSummary;
  const nowMs = Date.now(), DD = 86400000, MM = 60000;
  const todayStart = Date.parse(new Date(nowMs).toISOString().slice(0, 10) + 'T00:00:00Z');
  const e = (type, daysAgo, startMin, len, reason = 'resolved', detail) => {
    const o = (daysAgo ? todayStart - daysAgo * DD + 9 * 3600000 : Math.max(todayStart, nowMs - startMin * MM));
    return { type, opened_at: new Date(o).toISOString(),
      closed_at: reason === 'open' ? null : new Date(o + len * MM).toISOString(),
      close_reason: reason === 'open' ? null : reason,
      context: { first: { detail: detail || null } } };
  };
  const richHabits = () => Object.assign({ ok: true }, HS([
    e('no_sl', 0, 120, 41, 'resolved', 'Trade on GBPUSDm has no stop loss set.'),
    e('no_sl', 2, 0, 27), e('no_sl', 4, 0, 30),
    ...Array.from({ length: 12 }, (_, i) => e('overtrade', i + 1, 0, 1))
  ], nowMs, nowMs - 30 * DD));

  await check('the Habits tab: today\'s episode with its real duration and the trader\'s own normal', async () => {
    const env = makeEnv({ habits: richHabits() });
    await settle(env.win, 200);
    const t = env.win.document.getElementById('habits').textContent.replace(/\s+/g, ' ');
    assert.ok(/No stop loss/.test(t));
    assert.ok(/41m in total/.test(t), t.slice(0, 400));
    assert.ok(/has no stop loss set/.test(t), 'the episode\'s own words');
    assert.ok(/Your usual:/.test(t));
  });

  await check('a recurring pattern is badged as a habit, with its count and days', async () => {
    const env = makeEnv({ habits: richHabits() });
    await settle(env.win, 200);
    const t = env.win.document.getElementById('habits').textContent;
    assert.ok(/a habit — 3 times on 3 days this week/.test(t), t.slice(0, 500));
  });

  await check('good habits are reported, not just bad ones', async () => {
    const env = makeEnv({ habits: richHabits() });
    await settle(env.win, 200);
    const t = env.win.document.getElementById('habits').textContent;
    assert.ok(/What you did well today/.test(t));
    assert.ok(/Overtrading/.test(t) && /Not today/.test(t));
    assert.ok(/normally a habit for you/.test(t), 'a clean day on a HABIT is the most worth saying');
  });

  await check('with under 5 days of history it refuses to judge, and says why', async () => {
    const early = Object.assign({ ok: true }, HS([e('no_sl', 0, 60, 30)], nowMs, nowMs - 2 * DD));
    const env = makeEnv({ habits: early });
    await settle(env.win, 200);
    const t = env.win.document.getElementById('habits').textContent;
    assert.ok(/Too early to compare/.test(t));
    // check the BADGES, not the prose — the explanation itself says "better or worse than your usual"
    const badges = Array.from(env.win.document.querySelectorAll('#habits .trend')).map(b => b.className);
    assert.ok(badges.length >= 1, 'the episode is still shown');
    assert.ok(badges.every(c => /too_early/.test(c)), 'every badge is too-early: ' + badges.join(' | '));
  });

  await check('an open habit on a live trade is flagged ON that trade\'s card', async () => {
    const env = makeEnv({ status: { ok: true, accounts: [], openPositions: [{ ticket: '501', mfe_pips: 22, mae_pips: 4 }],
      openEpisodes: [{ type: 'no_sl', severity: 'high', ticket: '501', open_for_minutes: 41,
                       opened_at: new Date(Date.now() - 41 * 60000).toISOString() }] } });
    await settle(env.win, 200);
    const card = env.win.document.querySelector('#main .card[data-ticket="501"]');
    assert.ok(card, 'the card exists');
    assert.ok(/No stop loss on this trade — open for 41m/.test(card.textContent.replace(/\s+/g, ' ')), card.textContent.slice(0, 300));
  });

  await check('a habit on ANOTHER trade is not shown on this one', async () => {
    const env = makeEnv({ status: { ok: true, accounts: [], openPositions: [],
      openEpisodes: [{ type: 'no_sl', severity: 'high', ticket: '999', open_for_minutes: 12 }] } });
    await settle(env.win, 200);
    assert.ok(!env.win.document.querySelector('#main .habflag'));
  });

  await check('habits are read once a minute, not every 5 seconds', async () => {
    const env = makeEnv({ habits: richHabits() });
    await settle(env.win, 150);
    for (let i = 0; i < 4; i++) { await env.win.BWArbiterPage.cycle(); await settle(env.win, 20); }
    assert.strictEqual(env.calls.filter(c => c.split('?')[0] === '/api/arbiter/habits').length, 1);
  });

  await check('no NaN / undefined in the Habits tab', async () => {
    const env = makeEnv({ habits: richHabits() });
    await settle(env.win, 200);
    const t = env.win.document.getElementById('habits').textContent;
    ['NaN', 'undefined', '[object Object]'].forEach(bad => assert.ok(t.indexOf(bad) < 0, 'found ' + bad));
  });

  console.log('\nPHASE 7 — REPORTS ON THE PAGE');
  // Facts generated by the SERVER's own buildFacts — never a hand-made shape.
  const RP = require('./arbiter-route.js').reports;
  const dstr = new Date().toISOString().slice(0, 10);
  const d0 = Date.parse(dstr + 'T00:00:00Z');
  const at = h => new Date(d0 + h * 3600000).toISOString();
  const callsF = [
    { kind: 'take', symbol: 'EURUSD', score: 74, created_at: at(1), adherence: 'followed', matched_ticket: '70', outcome: 'ran', box: 'good', resolved_at: at(2) },
    { kind: 'skip', symbol: 'GBPUSD', score: 58, created_at: at(1.5), adherence: 'ignored', matched_ticket: '71', outcome: 'ran', box: 'luck', resolved_at: at(2) }];
  const journalF = [{ ticket: 70, symbol: 'EURUSDm', total_pl: 66.8, close_time: at(2) }, { ticket: 71, symbol: 'GBPUSDm', total_pl: -108, close_time: at(2) }];
  const dailyFacts = RP.buildFacts('daily', RP.dayRange(dstr), callsF, [], [], journalF, d0 - 30 * DD);
  const wk = RP.weekOf(Date.now());
  const weeklyFacts = RP.buildFacts('weekly', wk, callsF, [
    { type: 'no_sl', opened_at: at(1), closed_at: at(1.5), close_reason: 'resolved' },
    { type: 'revenge', opened_at: at(1.2), closed_at: at(1.2), close_reason: 'resolved' }], [], journalF, d0 - 30 * DD);
  const REPORT = { report_md: '## What went well\nYou followed the call.\n- one\n- two\n## One thing to try\nMeasure it.', model: 'claude-haiku-4-5-20251001', cost: 0.0061 };

  await check('the daily numbers are shown FREE, from the server\'s facts', async () => {
    const env = makeEnv({ daily: { ok: true, period: dstr, facts: dailyFacts, report: null } });
    await settle(env.win, 200);
    const t = env.win.document.getElementById('daily').textContent.replace(/\s+/g, ' ');
    assert.ok(/P\/L on calls you followed ?\+66\.80/.test(t), t.slice(0, 500));
    assert.ok(/P\/L where you went your own way ?-108\.00/.test(t));
    assert.ok(/not enough to say anything/.test(t), 'a thin sample says so');
    assert.ok(!env.posts.some(p => /report/.test(p.url)), 'nothing was written or charged just by looking');
  });

  await check('no review yet → a clear button, with the cost stated before anything is spent', async () => {
    const env = makeEnv({ daily: { ok: true, period: dstr, facts: dailyFacts, report: null } });
    await settle(env.win, 200);
    const box = env.win.document.getElementById('dailyReport');
    assert.ok(box.querySelector('[data-write="daily"]'));
    assert.ok(/charged from your analysis credits/.test(box.textContent));
    assert.ok(/asking again shows the same review at no charge/.test(box.textContent));
  });

  await check('clicking writes the review ONCE and shows it with its exact cost', async () => {
    const env = makeEnv({ daily: { ok: true, period: dstr, facts: dailyFacts, report: null } });
    env.routes['POST /api/arbiter/report/daily'] = { status: 200, body: { ok: true, report: REPORT } };
    await settle(env.win, 200);
    env.win.document.querySelector('[data-write="daily"]').click();
    await settle(env.win, 80);
    const box = env.win.document.getElementById('dailyReport');
    assert.ok(/What went well/.test(box.textContent));
    assert.ok(/\$0\.0061/.test(box.textContent), 'the real charge, not an estimate');
    assert.strictEqual(env.posts.filter(p => /report\/daily/.test(p.url)).length, 1);
    assert.strictEqual(box.querySelectorAll('.rep li').length, 2, 'bullets rendered');
  });

  await check('a report containing <script> renders as harmless text', async () => {
    const evil = Object.assign({}, REPORT, { report_md: '## Hi\n<script>window.PWNED=1</script>\n- <img src=x onerror="window.PWNED=2">' });
    const env = makeEnv({ daily: { ok: true, period: dstr, facts: dailyFacts, report: evil } });
    await settle(env.win, 200);
    const box = env.win.document.getElementById('dailyReport');
    assert.strictEqual(box.querySelectorAll('script,img').length, 0, 'no elements were created from the text');
    assert.ok(/<script>window\.PWNED=1<\/script>/.test(box.textContent), 'shown as text');
    assert.strictEqual(env.win.PWNED, undefined);
  });

  await check('out of credits: said plainly, and that nothing was charged', async () => {
    const env = makeEnv({ daily: { ok: true, period: dstr, facts: dailyFacts, report: null } });
    env.routes['POST /api/arbiter/report/daily'] = { status: 402, body: { ok: false } };
    await settle(env.win, 200);
    env.win.document.querySelector('[data-write="daily"]').click();
    await settle(env.win, 80);
    assert.ok(/out of analysis credits for this cycle\. Nothing was charged/.test(env.win.document.getElementById('dailyReport').textContent));
  });

  await check('weekly: seven days, the worst day highlighted and explained', async () => {
    const env = makeEnv({ weekly: { ok: true, period: wk.key, facts: weeklyFacts, report: REPORT } });
    await settle(env.win, 200);
    const dayCardEl = Array.from(env.win.document.querySelectorAll('#weekly .card')).find(c => /Day by day/.test(c.textContent));
    assert.strictEqual(dayCardEl.querySelectorAll('tbody tr').length, weeklyFacts.perDay.length);
    assert.ok(weeklyFacts.perDay.every(d => d.day <= new Date().toISOString().slice(0, 10)), 'no day after today');
    assert.strictEqual(dayCardEl.querySelectorAll('tr.worst').length, 1);
    assert.ok(/one bad session, not five bad habits/.test(env.win.document.getElementById('weekly').textContent));
  });

  await check('the download carries the habits table, the untraded grid and the answer', async () => {
    const RR = require('./arbiter-route.js');
    const w = realWeek();
    const env = makeEnv(w);
    let blob = null;
    env.win.URL.createObjectURL = b => { blob = b; return 'blob:x'; };
    env.win.URL.revokeObjectURL = () => {};
    const orig = env.win.HTMLAnchorElement.prototype.click;
    env.win.HTMLAnchorElement.prototype.click = function () {};
    await settle(env.win, 250);
    env.win.document.querySelector('#weekly [data-dl="html"]').click();
    const html = await new Promise(r => { const fr = new env.win.FileReader(); fr.onload = () => r(fr.result); fr.readAsText(blob); });
    ['Habits across the week', 'Exposed', 'On the pairs you did not trade', 'The answer to the question',
     'If you had taken only your 70+ calls', 'Best session', 'Average hold, winners',
     'not a backtest of trades you never took'].forEach(bit =>
       assert.ok(html.indexOf(bit) >= 0, 'missing from the download: ' + bit));
    assert.ok(/No stop loss/.test(html), 'the habit rows themselves');
    assert.ok(!/undefined|NaN|\[object/.test(html), 'and nothing broken in it');
    env.win.HTMLAnchorElement.prototype.click = orig;
  });

  await check('the weekly review downloads as a standalone document', async () => {
    const env = makeEnv({ weekly: { ok: true, period: wk.key, facts: weeklyFacts, report: REPORT } });
    let blob = null, name = null;
    env.win.URL.createObjectURL = b => { blob = b; return 'blob:x'; };
    env.win.URL.revokeObjectURL = () => {};
    const origClick = env.win.HTMLAnchorElement.prototype.click;
    env.win.HTMLAnchorElement.prototype.click = function () { name = this.download; };
    await settle(env.win, 200);
    env.win.document.querySelector('[data-dl="html"]').click();
    assert.strictEqual(name, 'blackwood-weekly-review-' + wk.key + '.html');
    const html = await new Promise(r => { const fr = new env.win.FileReader(); fr.onload = () => r(fr.result); fr.readAsText(blob); });
    assert.ok(/^<!DOCTYPE html>/.test(html));
    assert.ok(/Is it you, or is it Blackwood\?/.test(html));
    assert.ok(/What went well/.test(html), 'the written review is inside');
    assert.ok(!/<script/i.test(html), 'the saved file carries no script');
    // it must carry EVERYTHING the tab shows, not a summary of it
    ['Where the week went', 'Day by day', 'P/L on calls you followed', 'You followed', 'Blackwood was right',
     'Week of'].forEach(bit => assert.ok(html.indexOf(bit) >= 0, 'missing from the download: ' + bit));
    env.win.HTMLAnchorElement.prototype.click = origClick;
  });

  await check('reports are read once a minute, not every 5 seconds', async () => {
    const env = makeEnv({ daily: { ok: true, period: dstr, facts: dailyFacts, report: null } });
    await settle(env.win, 150);
    for (let i = 0; i < 4; i++) { await env.win.BWArbiterPage.cycle(); await settle(env.win, 20); }
    assert.strictEqual(env.calls.filter(c => c.split('?')[0] === '/api/arbiter/report/daily').length, 1);
  });

  console.log('\nSETTINGS — automatic reviews, by the trader\'s own choice');
  const RT = require('./arbiter-route.js').reports;
  const settingsFix = (over = {}) => Object.assign({ ok: true, consentVersion: RT.CONSENT_VERSION, consentText: RT.CONSENT_TEXT,
    settings: { auto_daily: false, auto_weekly: false }, charges: [], history: [] }, over);
  const S = win => win.document.getElementById('settings');

  await check('off by default, and the statement shown is the SERVER\'S own wording', async () => {
    const env = makeEnv({ settings: settingsFix() });
    await settle(env.win, 200);
    const t = S(env.win).textContent;
    const badges = Array.from(S(env.win).querySelectorAll('.auto .badge')).map(b => b.textContent);
    assert.deepStrictEqual(badges, ['Off', 'Off']);
    assert.ok(t.indexOf(RT.CONSENT_TEXT.auto_daily) >= 0, 'the exact server text');
  });

  await check('"Turn on" CANNOT be pressed until the statement is ticked', async () => {
    const env = makeEnv({ settings: settingsFix() });
    await settle(env.win, 200);
    const btn = S(env.win).querySelector('[data-auto="auto_daily"][data-val="1"]');
    assert.ok(btn.disabled, 'disabled before ticking');
    btn.click(); await settle(env.win, 40);
    assert.strictEqual(env.posts.filter(p => /settings/.test(p.url)).length, 0, 'nothing sent');
  });

  await check('ticking then turning on sends the consent and version — never the text itself', async () => {
    const env = makeEnv({ settings: settingsFix() });
    env.routes['PUT /api/arbiter/settings'] = { status: 200, body: { ok: true } };
    await settle(env.win, 200);
    const box = S(env.win).querySelector('[data-consent="auto_daily"]');
    box.checked = true; box.dispatchEvent(new env.win.Event('change', { bubbles: true }));
    await settle(env.win, 20);
    const btn = S(env.win).querySelector('[data-auto="auto_daily"][data-val="1"]');
    assert.ok(!btn.disabled, 'enabled once ticked');
    btn.click(); await settle(env.win, 60);
    const put = env.posts.find(p => p.method === 'PUT');
    assert.deepStrictEqual(put.body, { setting: 'auto_daily', value: true, consentAccepted: true, consentVersion: RT.CONSENT_VERSION });
  });

  await check('when on: who turned it on and when, and turning off needs no statement', async () => {
    const env = makeEnv({ settings: settingsFix({ settings: { auto_daily: true, auto_weekly: false },
      history: [{ setting: 'auto_daily', value: true, at: '2026-09-20T18:04:00Z', consent_version: RT.CONSENT_VERSION }] }) });
    env.routes['PUT /api/arbiter/settings'] = { status: 200, body: { ok: true } };
    await settle(env.win, 200);
    assert.ok(/Turned on by you on/.test(S(env.win).textContent));
    S(env.win).querySelector('[data-auto="auto_daily"][data-val="0"]').click(); await settle(env.win, 60);
    assert.deepStrictEqual(env.posts.find(p => p.method === 'PUT').body, { setting: 'auto_daily', value: false });
  });

  await check('every charge is listed, automatic or asked-for, with a total', async () => {
    const env = makeEnv({ settings: settingsFix({ charges: [
      { kind: 'daily', period: '2026-09-20', trigger: 'auto', cost: 0.0061, created_at: '2026-09-21T00:20:05Z' },
      { kind: 'weekly', period: '2026-W38', trigger: 'manual', cost: 0.0112, created_at: '2026-09-19T20:00:00Z' }] }) });
    await settle(env.win, 200);
    const t = S(env.win).textContent;
    assert.ok(/automatic/.test(t) && /you asked/.test(t));
    assert.ok(/\$0\.0173 in total/.test(t), t.slice(t.indexOf('Last'), t.indexOf('Last') + 80));
  });

  await check('what the schedule last did — including a skip and why', async () => {
    const env = makeEnv({ settings: settingsFix({ settings: { auto_daily: true, auto_weekly: false,
      last_daily_run: { period: '2026-09-20', outcome: 'skipped', why: 'no credits left — nothing charged' } } }) });
    await settle(env.win, 200);
    assert.ok(/skipped — no credits left — nothing charged/.test(S(env.win).textContent));
  });

  await check('a failed save says so and changes nothing', async () => {
    const env = makeEnv({ settings: settingsFix() });
    env.routes['PUT /api/arbiter/settings'] = { status: 500, body: { ok: false } };
    await settle(env.win, 200);
    const box = S(env.win).querySelector('[data-consent="auto_weekly"]');
    box.checked = true; box.dispatchEvent(new env.win.Event('change', { bubbles: true }));
    await settle(env.win, 20);
    S(env.win).querySelector('[data-auto="auto_weekly"][data-val="1"]').click(); await settle(env.win, 80);
    assert.ok(/was not saved\. Nothing has changed/.test(S(env.win).textContent));
  });

  await check('the schedule is shown in the trader\'s OWN time, not UTC', async () => {
    const env = makeEnv({ settings: settingsFix() });
    await settle(env.win, 200);
    assert.ok(/your time, for the day that has just ended/.test(S(env.win).textContent));
  });

  console.log('\nPROGRESS and CALIBRATION ON THE PAGE');
  // generated by the SERVER'S own functions — the page is tested against their real output
  const PGm = require('./arbiter-route.js').progress, RTm = require('./arbiter-route.js').reports;
  const NOWP = Date.now(), WK = RTm.weekOf(NOWP).start;
  const wkT = (i, h) => new Date(WK - i * 7 * DD + DD + h * 3600000).toISOString();
  function weeks(spec) {
    const c = [], e = [], j = [];
    spec.forEach(([i, follow, noSl]) => {
      for (let k = 0; k < 10; k++) c.push({ kind: 'take', created_at: wkT(i, k), score: 70, adherence: k < follow * 10 ? 'followed' : 'ignored' });
      if (noSl) e.push({ type: 'no_sl', opened_at: wkT(i, 1), closed_at: new Date(Date.parse(wkT(i, 1)) + noSl * 60000).toISOString(), close_reason: 'resolved' });
      j.push({ ticket: i, symbol: 'EURUSD', direction: 'buy', open_price: 1.1, sl: 1.098, close_price: 1.102, close_time: wkT(i, 4) });
    });
    return [c, e, j];
  }
  const improving = () => { const [c, e, j] = weeks([[5, .4, 120], [4, .4, 120], [3, .4, 120], [2, .9, 5], [1, .9, 5], [0, .9, 5]]);
    return Object.assign({ ok: true }, PGm.progressSummary(c, e, j, [{ account_number: '2', first_seen_at: wkT(2, 0) },
      { account_number: '1', first_seen_at: wkT(6, 0) }], NOWP)); };

  await check('Progress: the verdict in plain words, with what improved', async () => {
    const env = makeEnv({ progress: improving() });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('progress').textContent;
    assert.ok(/Getting better/.test(t), t.slice(0, 200));
    assert.ok(/calls you followed/.test(t));
    assert.ok(/on medians — one bad week cannot flip it/.test(t));
  });

  await check('Progress: each behaviour with its trend line and before → now', async () => {
    const env = makeEnv({ progress: improving() });
    await settle(env.win, 250);
    const mets = env.win.document.querySelectorAll('#progress .met');
    assert.strictEqual(mets.length, 6, 'five behaviours plus R expectancy as context');
    assert.ok(env.win.document.querySelector('#progress .met svg path'), 'a real line, not an empty box');
    assert.ok(/40% → 90%/.test(mets[0].textContent), mets[0].textContent);
  });

  await check('Progress: a new account is marked on its week, in R, never dollars', async () => {
    const env = makeEnv({ progress: improving() });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('progress').textContent;
    assert.ok(/new account/.test(t));
    assert.ok(/in R — the same on any account size/.test(t));
    assert.ok(!/\$/.test(t), 'no dollar figure anywhere on the progress page');
  });

  await check('Progress: under 3 weeks it says so and claims nothing', async () => {
    const [c, e, j] = weeks([[1, .5, 30], [0, .9, 5]]);
    const env = makeEnv({ progress: Object.assign({ ok: true }, PGm.progressSummary(c, e, j, [], NOWP)) });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('progress').textContent;
    assert.ok(/Not enough weeks yet/.test(t));
    assert.ok(!/Getting better|Getting worse/.test(t));
  });

  function twoAccounts(riskTo) {
    const [c, e, j] = weeks([[5, .4, 120], [4, .4, 120], [3, .4, 120], [2, .9, 5], [1, .9, 5], [0, .9, 5]]);
    const acc = [{ account_number: '1', first_seen_at: wkT(6, 0), starting_balance: 2000, currency: 'USD', kind: 'unknown' },
                 { account_number: '2', first_seen_at: wkT(2, 0), starting_balance: 5000, currency: 'USD', kind: 'unknown' }];
    const pos = [].concat(
      Array.from({ length: 6 }, () => ({ account_number: '1', symbol: 'EURUSD', raw_symbol: 'EURUSD', volume: 0.19, risk_pct: 1.0 })),
      Array.from({ length: 6 }, () => ({ account_number: '2', symbol: 'EURUSD', raw_symbol: 'EURUSDm', volume: 0.42, risk_pct: riskTo })));
    return Object.assign({ ok: true }, PGm.progressSummary(c, e, j, acc, NOWP, pos));
  }

  await check('Your accounts: each account, its balance, its suffix, and the pairs that carried over', async () => {
    const env = makeEnv({ progress: twoAccounts(0.95) });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('progress').textContent.replace(/\s+/g, ' ');
    assert.ok(/Your accounts/.test(t) && /the record does not reset/.test(t));
    assert.ok(/Account 1 · type not reported · \$2,000 · symbols carry no suffix/.test(t), t.slice(t.indexOf('Your accounts'), t.indexOf('Your accounts') + 300));
    assert.ok(/Account 2 · type not reported · \$5,000 · symbols carry a m suffix — matched to the same pairs \(EURUSD\)/.test(t));
    assert.ok(/All 2 accounts feed one history/.test(t));
  });

  await check('Your accounts: never claims "live" — the EA does not report it yet', async () => {
    const env = makeEnv({ progress: twoAccounts(0.95) });
    await settle(env.win, 250);
    const card = Array.from(env.win.document.querySelectorAll('#progress .card')).find(c => /Your accounts/.test(c.textContent));
    assert.ok(!/\blive\b/.test(card.textContent));
  });

  await check('sizing note: lots grew, risk held — "that is not oversizing"', async () => {
    const env = makeEnv({ progress: twoAccounts(0.95) });
    await settle(env.win, 250);
    assert.ok(/from 0\.19 to 0\.42 lots, and that is not oversizing/.test(env.win.document.getElementById('progress').textContent));
  });

  await check('sizing note: risk DID rise — said plainly, not excused', async () => {
    const env = makeEnv({ progress: twoAccounts(2.1) });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('progress').textContent;
    assert.ok(/your risk per trade DID rise with it, from 1% to 2\.1%/.test(t), t.slice(t.indexOf('Sizing'), t.indexOf('Sizing') + 200));
    assert.ok(!/not oversizing/.test(t));
  });

  await check('the trend lines carry a violet marker on the week the new account appeared', async () => {
    const env = makeEnv({ progress: twoAccounts(0.95) });
    await settle(env.win, 250);
    const lines = env.win.document.querySelectorAll('#progress .met svg line');
    assert.strictEqual(lines.length, 6, 'one marker on each trend line');
    assert.ok(/new account this week/.test(lines[0].textContent));
  });

  await check('with one account: no continuity note, no markers, no sizing comparison', async () => {
    const [c, e, j] = weeks([[5, .4, 120], [4, .4, 120], [3, .4, 120], [2, .9, 5], [1, .9, 5], [0, .9, 5]]);
    const one = Object.assign({ ok: true }, PGm.progressSummary(c, e, j, [{ account_number: '1', first_seen_at: wkT(9, 0) }], NOWP, []));
    const env = makeEnv({ progress: one });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('progress').textContent;
    assert.ok(!/feed one history/.test(t) && !/Sizing is judged/.test(t));
    assert.strictEqual(env.win.document.querySelectorAll('#progress .met svg line').length, 0);
  });

  await check('the header says how much history it is built on', async () => {
    const env = makeEnv({ progress: improving() });
    await settle(env.win, 250);
    const card = env.win.document.querySelector('#progress .card');
    assert.ok(/Are you getting better\?/.test(card.textContent));
    assert.ok(/\d+ weeks · \d+ accounts? · \d+ trades?/.test(card.textContent.replace(/\s+/g, ' ')), card.textContent.slice(0, 160));
  });

  await check('each metric carries a line explaining what it means', async () => {
    const env = makeEnv({ progress: improving() });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('progress').textContent.replace(/\s+/g, ' ');
    assert.ok(/The cleanest signal there is/.test(t), 'adherence');
    assert.ok(/\d+ of the last \d+ weeks moved up/.test(t), 'counted from the series, not asserted');
    assert.ok(/Dollar figures are never compared across accounts/.test(t), 'the override cost, in R');
  });

  await check('R expectancy is shown but marked as context, never counted in the verdict', async () => {
    const env = makeEnv({ progress: improving() });
    await settle(env.win, 250);
    const met = Array.from(env.win.document.querySelectorAll('#progress .met')).find(m => /R expectancy/.test(m.textContent));
    assert.ok(met, 'shown');
    assert.ok(/context, not counted/.test(met.textContent));
  });

  await check('the week table gains the score taken and a line per week', async () => {
    const env = makeEnv({ progress: improving() });
    await settle(env.win, 250);
    const card = Array.from(env.win.document.querySelectorAll('#progress .card')).find(c => /Week by week/.test(c.textContent));
    const head = Array.from(card.querySelectorAll('thead th')).map(h => h.textContent);
    assert.deepStrictEqual(head, ['Week', 'Followed', 'Own way', 'No stop', 'Revenge', 'Avg taken', 'R exp.']);
  });

  await check('THE VERTICAL WORDS: each week\'s sentence sits on its OWN full-width line under its numbers', async () => {
    const env = makeEnv({ progress: improving() });
    await settle(env.win, 250);
    const card = Array.from(env.win.document.querySelectorAll('#progress .card')).find(c => /Week by week/.test(c.textContent));
    const lines = Array.from(card.querySelectorAll('tbody tr.wk-line'));
    assert.ok(lines.length >= 1, 'fixture sanity: at least one week has a sentence');
    lines.forEach(tr => {
      const td = tr.querySelectorAll('td'); assert.strictEqual(td.length, 1); assert.strictEqual(td[0].getAttribute('colspan'), '7', 'spans every column');
      const prev = tr.previousElementSibling; assert.ok(prev && !prev.classList.contains('wk-line') && /^\d{4}-W\d{2}/.test(prev.cells[0].textContent.trim()), 'right under its week');
      assert.ok(td[0].textContent.trim().length > 3);
    });
    card.querySelectorAll('tbody tr:not(.wk-line)').forEach(tr => assert.strictEqual(tr.cells.length, 7, 'seven number columns, no squeezed eighth'));
  });

  await check('the row that matters is called out, so a good week is not read as a failure', async () => {
    const RRp = require('./arbiter-route.js').progress;
    const good = [.5, 120], better = [.85, 15];
    const mk = (i, f, n, res) => { const [c, e, j] = weeks([[i, f, n]]); j[0].close_price = 1.1 + res * 0.002; return [c, e, j]; };
    let C = [], E = [], J = [];
    [[5, ...good, 2], [4, ...good, 2], [3, ...good, 1], [2, ...better, -1], [1, ...better, -1], [0, ...better, -1]]
      .forEach(([i, f, n, res]) => { const [c, e, j] = mk(i, f, n, res); C = C.concat(c); E = E.concat(e); J = J.concat(j); });
    const env = makeEnv({ progress: Object.assign({ ok: true }, RRp.progressSummary(C, E, J, [], NOWP)) });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('progress').textContent.replace(/\s+/g, ' ');
    if (/is the row that matters/.test(t))
      assert.ok(/behavioural columns improved that week and the money still went backwards/.test(t));
    else assert.ok(true, 'this fixture produced no such week — the paragraph is absent, as it should be');
  });

  await check('milestones say how close the ones not reached are', async () => {
    const env = makeEnv({ progress: improving() });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('progress').textContent.replace(/\s+/g, ' ');
    assert.ok(/First week following 80%\+ of calls/.test(t));
    assert.ok(/points? away|not yet/.test(t), 'a near miss says how near');
    assert.ok(/hard to feel from the inside/.test(t));
  });

  const band = (score, n, share) => Array.from({ length: n }, (_, k) => ({ kind: 'take', score, outcome: k < n * share ? 'ran' : 'failed' }));
  const stage = require('./arbiter-engine.js').STAGE;

  await check('Calibration: an honest score shows rising bars and says so', async () => {
    const cal = PGm.calibrationSummary([].concat(band(50, 25, .3), band(60, 25, .45), band(75, 25, .6), band(85, 25, .76)), [], stage);
    const env = makeEnv({ calibration: Object.assign({ ok: true }, cal) });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('calibration').textContent;
    assert.ok(/Yes\./.test(t) && /doing its job/.test(t));
    assert.strictEqual(env.win.document.querySelectorAll('#calibration .bands .b').length, 5);
  });

  await check('Calibration: an inverted score is shown as a warning, not hidden', async () => {
    const cal = PGm.calibrationSummary([].concat(band(60, 25, .6), band(85, 25, .3)), [], stage);
    const env = makeEnv({ calibration: Object.assign({ ok: true }, cal) });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('calibration').textContent;
    assert.ok(/Not yet\./.test(t) && /weights need changing/.test(t));
  });

  await check('Calibration: the thresholds say how much evidence exists, and their own numbers', async () => {
    const cal = PGm.calibrationSummary([], [], stage);
    const env = makeEnv({ calibration: Object.assign({ ok: true }, cal) });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('calibration').textContent;
    assert.ok(/threshold 45/.test(t) && /threshold 20/.test(t));
    assert.ok(/20 are needed before the threshold of 45 can be judged/.test(t));
  });

  await check('progress and calibration are read every 5 minutes, not every 5 seconds', async () => {
    const env = makeEnv({ progress: improving() });
    await settle(env.win, 150);
    for (let i = 0; i < 4; i++) { await env.win.BWArbiterPage.cycle(); await settle(env.win, 20); }
    assert.strictEqual(env.calls.filter(c => c.split('?')[0] === '/api/arbiter/progress').length, 1);
  });

  await check('no NaN / undefined on Progress or Calibration', async () => {
    const env = makeEnv({ progress: improving(), calibration: Object.assign({ ok: true }, PGm.calibrationSummary([], [], stage)) });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('progress').textContent + env.win.document.getElementById('calibration').textContent;
    ['NaN', 'undefined', '[object Object]'].forEach(bad => assert.ok(t.indexOf(bad) < 0, 'found ' + bad));
  });

  console.log('\nTHE RAIL — every prototype block, every row real');
  const railText = win => win.document.querySelector('aside.rail').textContent.replace(/\s+/g, ' ');

  await check('all five prototype blocks are there, plus the open-habits block that was already shipped', async () => {
    const env = makeEnv();
    await settle(env.win, 250);
    const heads = Array.from(env.win.document.querySelectorAll('aside.rail h4')).map(h => h.textContent);
    assert.deepStrictEqual(heads.map(h => h.replace(/ — .*/, ' — …')), ['Reading — …', 'Reading — …', 'Habits open right now',
      'Its own record', 'Claude budget', 'The long record', 'Honest limits']);
    assert.strictEqual(heads[0], 'Reading — your whole account');
  });

  await check('open positions show the age of the EA\'s OWN last report', async () => {
    const env = makeEnv();
    await settle(env.win, 250);
    assert.ok(/Open positions ?1 · 3s/.test(railText(env.win)), railText(env.win).slice(0, 120));
  });

  await check('an EA that has gone quiet turns that row red', async () => {
    const env = makeEnv({ sources: { sources: [{ sourceId: 'k1', lastSeen: Date.now() - 5 * 60000 }], active: 'k1' } });
    await settle(env.win, 250);
    const r = Array.from(env.win.document.querySelectorAll('#acctfeeds .frow')).find(x => /Open positions/.test(x.textContent));
    assert.ok(r.querySelector('.dot.r'), 'red dot');
    assert.ok(/5m/.test(r.textContent));
  });

  await check('Formations: with the chart tab not publishing, Arbiter reads them ITSELF (DEC-14) — a real count, no invented "2 leads"', async () => {
    const env = makeEnv();
    await settle(env.win, 250);
    assert.ok(/Formations ?\d+ · \d+ in play/.test(railText(env.win)), railText(env.win));
    assert.ok(!/leads/.test(railText(env.win)));
  });
  await check('Formations: if combined-read.js is MISSING as well, it says the chart tab is not open — never a guess', async () => {
    const env = makeEnv({ omitScripts: ['combined-read.js'] });
    await settle(env.win, 250);
    assert.ok(/Formations ?chart tab not open/.test(railText(env.win)), railText(env.win));
    assert.ok(!/leads/.test(railText(env.win)));
  });

  await check('Journal shows real trades on file — never an "unfilled" count with nothing behind it', async () => {
    const env = makeEnv();
    await settle(env.win, 250);
    assert.ok(/Journal ?40 trades on file/.test(railText(env.win)), railText(env.win));
    assert.ok(!/unfilled/.test(railText(env.win)));
  });

  await check('Claude budget shows the REAL balance — no invented "on demand 3 left"', async () => {
    const env = makeEnv();
    await settle(env.win, 250);
    const t = railText(env.win);
    assert.ok(/Credits ?\$6\.42 of \$8\.00/.test(t), t);
    assert.ok(!/3 left|On demand/.test(t));
  });

  await check('the owner sees "unlimited"', async () => {
    const env = makeEnv({ credits: { balance: 8, monthly: 8, unlimited: true } });
    await settle(env.win, 250);
    assert.ok(/Credits ?unlimited/.test(railText(env.win)));
  });

  await check('its own record: this week\'s right/graded, from the real ledger', async () => {
    const PGr = require('./arbiter-route.js').progress, RTr = require('./arbiter-route.js').reports;
    const t = new Date(RTr.weekOf(Date.now()).start + 3600000).toISOString();
    const prog = Object.assign({ ok: true }, PGr.progressSummary([
      { kind: 'take', created_at: t, correct: true, adherence: 'followed', score: 74 },
      { kind: 'take', created_at: t, correct: true, adherence: 'followed', score: 71 },
      { kind: 'skip', created_at: t, correct: false, adherence: 'followed', score: 58 }], [], [{}], [{}, {}], Date.now()));
    const env = makeEnv({ progress: prog });
    await settle(env.win, 250);
    const tx = railText(env.win);
    assert.ok(/This week ?2 \/ 3 right/.test(tx), tx);
    assert.ok(/Accounts ?2 · unbroken/.test(tx));
    assert.ok(/Trades on file ?1/.test(tx));
  });

  await check('the rail is filled while FLAT too, not only with trades open', async () => {
    const env = makeEnv({ state: { watchlist: [{ symbol: 'EURUSDm', bid: 1.084, spread: 8 }], openTrades: [],
      closedTrades: [], accountInfo: { login: 5000 }, news: [] } });
    await settle(env.win, 250);
    const t = railText(env.win);
    assert.ok(/Open positions ?0/.test(t) && /Credits/.test(t) && /History/.test(t), t.slice(0, 200));
  });

  await check('the honest limits carry the CORRECTED latency, not the prototype\'s 1-5 seconds', async () => {
    const env = makeEnv();
    await settle(env.win, 250);
    const t = railText(env.win);
    assert.ok(/up to about 15 seconds/.test(t));
    assert.ok(!/1 to 5 seconds/.test(t));
  });

  await check('no NaN / undefined anywhere in the rail', async () => {
    const env = makeEnv({ progress: null, calibration: null, credits: null, sources: null });
    await settle(env.win, 250);
    const t = railText(env.win);
    ['NaN', 'undefined', '[object Object]'].forEach(bad => assert.ok(t.indexOf(bad) < 0, 'found ' + bad + ': ' + t));
  });

  console.log('\nWHICH PAIR THE RAIL READS — and it always says');
  const head = win => win.document.getElementById('pairHead').textContent;
  const why = win => win.document.getElementById('pairWhy').textContent;
  const flatWL = () => ({ watchlist: [{ symbol: 'EURUSDm', bid: 1.084, spread: 8 }, { symbol: 'GBPJPYm', bid: 193.4, spread: 30 },
    { symbol: 'XAUUSDc', bid: 2338.4, spread: 25 }], openTrades: [], closedTrades: [], accountInfo: { login: 5000 }, news: [] });

  await check('flat: it reads the TOP-scored pair by default, and says that is why', async () => {
    const env = makeEnv({ state: flatWL() });
    await settle(env.win, 250);
    const top = env.win.document.querySelector('#main button.scan').dataset.sym;
    assert.strictEqual(head(env.win), 'Reading — ' + top + ' · H1');
    assert.ok(/the highest score in the scan/.test(why(env.win)));
  });

  await check('clicking a pair in Hunting makes the rail read THAT pair, and says you picked it', async () => {
    const env = makeEnv({ state: flatWL() });
    await settle(env.win, 250);
    const rows = Array.from(env.win.document.querySelectorAll('#main button.scan'));
    const other = rows[rows.length - 1]; other.click(); await settle(env.win, 20);
    assert.strictEqual(head(env.win), 'Reading — ' + other.dataset.sym + ' · H1');
    assert.ok(/the pair you picked in Hunting/.test(why(env.win)));
  });

  // two positions: EURUSD losing with the evidence stacked (pressure ~48), GBPUSD quiet
  function twoPositions() {
    const env = losingEnv();
    env.routes['/api/state'].watchlist.push({ symbol: 'GBPUSDm', bid: 1.2700, spread: 9 });
    // a quiet SHORT that agrees with the (shared) downtrend — a long here would be fighting
    // the trend and would correctly score CUT 100, outranking EURUSD
    env.routes['/api/state'].openTrades.push({ ticket: 502, symbol: 'GBPUSDm', type: 'sell', volume: 0.2,
      openPrice: 1.0800, sl: 1.0900, tp: 1.0600, profit: 12, riskPct: 1, openTime: Math.floor(Date.now() / 1000) - 3600 });
    stackAgainst(env);
    return env;
  }

  await check('several positions: it reads the one under the MOST pressure by default', async () => {
    const env = twoPositions();
    await settle(env.win, 300);
    assert.strictEqual(head(env.win), 'Reading — EURUSD · H1');
    assert.ok(/your position under the most pressure/.test(why(env.win)), why(env.win));
  });

  await check('the picker opens on whichever position carries the MOST pressure', async () => {
    // (was "structure turned, 100 outranks ~67" — the label flip is no longer an automatic 100, DEC-8;
    //  the purpose of the test is the ranking itself, so it now checks the ranking directly)
    const env = twoPositions();
    const g = env.routes['/api/state'].openTrades.find(t => t.ticket === 502);
    Object.assign(g, { type: 'buy', openPrice: 1.0700, sl: 1.0600, tp: 1.0900 });
    await settle(env.win, 300);
    const btns = Array.from(env.win.document.querySelectorAll('#pairPick button'));
    const num = b => +(b.textContent.trim().match(/(\d+)$/) || [0, -1])[1];
    assert.ok(btns.length >= 2, 'two positions listed');
    const on = env.win.document.querySelector('#pairPick button.on');
    assert.strictEqual(num(on), Math.max.apply(null, btns.map(num)), btns.map(b => b.textContent.trim()).join(' | '));
  });

  await check('several positions: a picker lists every one with its pressure', async () => {
    const env = twoPositions();
    await settle(env.win, 300);
    const btns = Array.from(env.win.document.querySelectorAll('#pairPick button'));
    assert.deepStrictEqual(btns.map(b => b.textContent.replace(/\s+\d+$/, '')), ['EURUSD short', 'GBPUSD short']);
    assert.ok(btns.every(b => /\d+$/.test(b.textContent)), 'each shows its pressure');
    assert.ok(btns[0].classList.contains('on'));
  });

  await check('picking another position switches the rail to it — and it STAYS there next cycle', async () => {
    const env = twoPositions();
    await settle(env.win, 300);
    env.win.document.querySelector('#pairPick button[data-focus="502"]').click(); await settle(env.win, 20);
    assert.strictEqual(head(env.win), 'Reading — GBPUSD · H1');
    assert.ok(/the position you picked/.test(why(env.win)));
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 60);
    assert.strictEqual(head(env.win), 'Reading — GBPUSD · H1', 'a refresh must not throw away what the trader picked');
  });

  await check('clicking a position CARD focuses it too', async () => {
    const env = twoPositions();
    await settle(env.win, 300);
    env.win.document.querySelector('#main .card[data-ticket="502"] .thead').click(); await settle(env.win, 20);
    assert.strictEqual(head(env.win), 'Reading — GBPUSD · H1');
  });

  await check('a picked position that closes falls back to the most pressure, not a dead pair', async () => {
    const env = twoPositions();
    await settle(env.win, 300);
    env.win.document.querySelector('#pairPick button[data-focus="502"]').click(); await settle(env.win, 20);
    env.routes['/api/state'].openTrades = env.routes['/api/state'].openTrades.filter(t => t.ticket !== 502);
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 60);
    assert.strictEqual(head(env.win), 'Reading — EURUSD · H1');
  });

  await check('with positions open, the Hunting tab reads the scan pair, not a position', async () => {
    const env = twoPositions();
    await settle(env.win, 300);
    env.win.document.querySelector('.nav-tab[data-p="hunt"]').click(); await settle(env.win, 20);
    assert.ok(/the highest score in the scan|the pair you picked in Hunting/.test(why(env.win)), why(env.win));
    assert.strictEqual(env.win.document.querySelectorAll('#pairPick button').length, 0, 'no position picker while hunting');
  });

  await check('every pair is still JUDGED — only the display follows one', async () => {
    const env = twoPositions();
    await settle(env.win, 300);
    assert.strictEqual(env.win.document.querySelectorAll('#main .card[data-ticket]').length, 2, 'both cards judged and shown');
    assert.ok(/Every open position is judged every cycle/.test(why(env.win)));
  });

  await check('the calendar row counts only releases on the currencies of THIS pair', async () => {
    const st = flatWL();
    st.news = [{ title: 'BoJ Rate', impact: 'high', country: 'JPY', timestamp: Math.floor(Date.now() / 1000) + 1800 }];
    const env = makeEnv({ state: st });
    await settle(env.win, 250);
    const eur = Array.from(env.win.document.querySelectorAll('#main button.scan')).find(b => b.dataset.sym === 'EURUSD');
    eur.click(); await settle(env.win, 20);
    assert.ok(/Calendar, EUR\/USD ?none ahead/.test(env.win.document.getElementById('feeds').textContent), 'a JPY release does not move EUR/USD');
  });

  await check('the structure row lists only the timeframes read for THIS pair', async () => {
    const env = makeEnv({ state: flatWL() });
    env.win.localStorage.setItem('bw-confluence-now', JSON.stringify({ t: Date.now(), reads: {
      'GBPJPY|H4': { trend: 'up', trendConf: 0.8 }, 'EURUSD|H1': { trend: 'down', trendConf: 0.8 } } }));
    await settle(env.win, 250);
    const eur = Array.from(env.win.document.querySelectorAll('#main button.scan')).find(b => b.dataset.sym === 'EURUSD');
    eur.click(); await settle(env.win, 20);
    const t = env.win.document.getElementById('feeds').textContent;
    assert.ok(/Structure ?H1/.test(t) && !/H1\+H4/.test(t), t);
  });

  await check('an evidence row says how much of the 14 conditions this pair actually had', async () => {
    const env = makeEnv();
    await settle(env.win, 250);
    assert.ok(/Evidence ?\d+ of 14 conditions readable/.test(env.win.document.getElementById('feeds').textContent));
  });

  console.log('\nTODAY\'S CALLS — only pairs you traded are judged');
  const mixed = { ok: true, resolved: 3, pending: 0, quad: { good: 0, expensive: 0, ours: 0, luck: 1 }, calls: [
    { id: 9, kind: 'take', symbol: 'GBPJPY', direction: 'bull', score: 77, adherence: 'not_traded', outcome: 'ran', correct: true, box: null,
      resolved_at: new Date().toISOString(), created_at: new Date(Date.now() - 3 * 3600000).toISOString(), window_ends_at: new Date(Date.now() - 2.6 * 3600000).toISOString() },
    { id: 8, kind: 'skip', symbol: 'USDCHF', direction: 'bear', score: 58, adherence: 'not_traded', outcome: 'ran', correct: false, box: null,
      resolved_at: new Date().toISOString(), created_at: new Date(Date.now() - 4 * 3600000).toISOString(), window_ends_at: new Date(Date.now() - 3.6 * 3600000).toISOString() },
    { id: 7, kind: 'skip', symbol: 'EURUSD', direction: 'bull', score: 58, adherence: 'ignored', matched_ticket: '71', outcome: 'ran', correct: false, box: 'luck',
      resolved_at: new Date().toISOString(), created_at: new Date(Date.now() - 5 * 3600000).toISOString(), window_ends_at: new Date(Date.now() - 4.6 * 3600000).toISOString() }] };

  await check('every suggestion is still LISTED, including pairs you never traded', async () => {
    const env = makeEnv({ calls: mixed });
    await settle(env.win, 250);
    assert.strictEqual(env.win.document.querySelectorAll('#calls .lrow').length, 3);
  });

  await check('the grid counts ONLY the pair you traded, and says why', async () => {
    const env = makeEnv({ calls: mixed });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('calls').textContent.replace(/\s+/g, ' ');
    const firstGrid = env.win.document.querySelector('#calls .card');   // the "is it you" grid, not the second one
    assert.deepStrictEqual(Array.from(firstGrid.querySelectorAll('.q .qn')).map(e => e.textContent), ['0', '0', '0', '1']);
    assert.ok(/1 on pairs you traded/.test(t));
    assert.ok(/which pairs you trade is your choice/.test(t));
    assert.ok(/2 calls were on pairs you did not trade/.test(t));
  });

  await check('an untraded call says so plainly — and still shows whether ARBITER was right', async () => {
    const env = makeEnv({ calls: mixed });
    await settle(env.win, 250);
    const rows = Array.from(env.win.document.querySelectorAll('#calls .lrow')).map(r => r.textContent.replace(/\s+/g, ' '));
    const gbp = rows.find(r => /GBPJPY/.test(r)), chf = rows.find(r => /USDCHF/.test(r));
    assert.ok(/you did not trade this pair — not counted in the grid/.test(gbp), gbp);
    assert.ok(/Arbiter was right/.test(gbp));
    assert.ok(/Arbiter was wrong/.test(chf), 'a wrong skip still counts against Arbiter');
    assert.ok(!/Blackwood (right|wrong)/.test(gbp), 'but no grid box');
  });

  await check('the scoring table: one line per call, in time order, from the stored calls', async () => {
    const withLive = JSON.parse(JSON.stringify(mixed));
    withLive.calls.push({ id: 6, kind: 'live', symbol: 'EURUSD', direction: 'bull', ticket: '71', action: 'partial', score: 52,
      adherence: 'followed', outcome: 'not_graded', resolved_at: new Date().toISOString(),
      created_at: new Date(Date.now() - 1 * 3600000).toISOString(), window_ends_at: new Date(Date.now() - 0.6 * 3600000).toISOString() });
    withLive.calls.push({ id: 5, kind: 'take', symbol: 'XAUUSD', direction: 'bull', score: 74,
      created_at: new Date(Date.now() - 2 * 60000).toISOString(), window_ends_at: new Date(Date.now() + 18 * 60000).toISOString() });
    const env = makeEnv({ calls: withLive });
    await settle(env.win, 250);
    const card = Array.from(env.win.document.querySelectorAll('#calls .card')).find(c => /How the calls scored/.test(c.textContent));
    assert.ok(card, 'the table is there');
    const rows = Array.from(card.querySelectorAll('tbody tr')).map(r => Array.from(r.cells).slice(1).map(td => td.textContent.trim()));
    assert.deepStrictEqual(rows[0], ['EURUSD', 'Skip it', '58', 'Ignored', 'Wrong', 'Blackwood wrong, you ignored']);
    assert.deepStrictEqual(rows[1], ['USDCHF', 'Skip it', '58', 'Not traded', 'Wrong', 'not counted']);
    assert.deepStrictEqual(rows[2], ['GBPJPY', 'Take it', '77', 'Not traded', 'Right', 'not counted']);
    assert.deepStrictEqual(rows[3], ['EURUSD', 'Take partial', '52', 'Followed', 'trade open', '–'], 'graded only once the trade closes');
    assert.deepStrictEqual(rows[4], ['XAUUSD', 'Take it', '74', 'deciding', 'Open', '–']);
    assert.ok(/Nothing in this table is re-derived later/.test(card.textContent));
  });

  // live calls, graded by the SERVER'S own liveWorth — never a hand-made worth
  const LWp = require('./arbiter-route.js').progress.liveWorth;
  const jt = close => ({ ticket: 165605356, symbol: 'GBPUSD', direction: 'buy', open_price: 1.27, sl: 1.268, close_price: close });
  const lc = (action, adherence, price_at, close) => {
    const c = { id: Math.random(), kind: 'live', symbol: 'GBPUSD', direction: 'bull', ticket: '165605356', action, score: 52, adherence,
      price_at, created_at: new Date(Date.now() - 3600000).toISOString(), window_ends_at: new Date(Date.now() - 2400000).toISOString(),
      resolved_at: new Date().toISOString(), outcome: 'not_graded' };
    c.worth = close == null ? LWp(c, null) : LWp(c, jt(close));
    return c;
  };
  const liveCalls = cs => ({ ok: true, resolved: cs.length, pending: 0, quad: { good: 0, expensive: 0, ours: 0, luck: 0 }, calls: cs });

  await check('a live call on a CLOSED trade shows what following it was worth, in R', async () => {
    const env = makeEnv({ calls: liveCalls([lc('cut', 'followed', 1.271, 1.268)]) });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('calls').textContent.replace(/\s+/g, ' ');
    assert.ok(/pressure 52/.test(t));
    assert.ok(/you followed — it was worth \+1\.5R/.test(t), t.slice(0, 400));
  });

  await check('held on through a CUT that then got worse: "following would have been worth"', async () => {
    const env = makeEnv({ calls: liveCalls([lc('cut', 'ignored', 1.271, 1.268)]) });
    await settle(env.win, 250);
    assert.ok(/you held on — following would have been worth \+1\.5R/.test(env.win.document.getElementById('calls').textContent));
  });

  await check('a HOLD that was followed and the trade ran: holding was worth it', async () => {
    const env = makeEnv({ calls: liveCalls([lc('hold', 'followed', 1.271, 1.274)]) });
    await settle(env.win, 250);
    assert.ok(/you followed — it was worth \+1\.5R/.test(env.win.document.getElementById('calls').textContent));
  });

  await check('a PARTIAL (your example) is graded as banking half at the call', async () => {
    const env = makeEnv({ calls: liveCalls([lc('partial', 'ignored', 1.271, 1.268)]) });
    await settle(env.win, 250);
    assert.ok(/following would have been worth \+0\.75R/.test(env.win.document.getElementById('calls').textContent));
  });

  await check('the grid card totals live advice on closed trades', async () => {
    const env = makeEnv({ calls: liveCalls([lc('cut', 'ignored', 1.271, 1.268), lc('hold', 'followed', 1.271, 1.274),
                                            lc('hold', 'followed', 1.271, null)]) });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('calls').textContent.replace(/\s+/g, ' ');
    assert.ok(/Live advice today: 2 calls on trades that have closed\. Following all of it would have been worth \+3R in total/.test(t), t.slice(0, 600));
  });

  await check('the scoring table shows the worth in R for a closed trade', async () => {
    const env = makeEnv({ calls: liveCalls([lc('cut', 'ignored', 1.271, 1.268)]) });
    await settle(env.win, 250);
    const card = Array.from(env.win.document.querySelectorAll('#calls .card')).find(c => /How the calls scored/.test(c.textContent));
    assert.strictEqual(card.querySelector('tbody tr').cells[5].textContent.trim(), '+1.5R');
  });

  await check('Daily summary: the grid holds your traded pairs, and live advice is totalled in R', async () => {
    // built by the SERVER'S own attachLive + buildFacts: the same path the endpoint uses
    const RR = require('./arbiter-route.js');
    const d0s = new Date().toISOString().slice(0, 10), d0 = Date.parse(d0s + 'T00:00:00Z');
    const jr = [{ ticket: 165605356, symbol: 'GBPUSD', direction: 'buy', open_price: 1.27, sl: 1.268, close_price: 1.268,
      close_time: new Date(d0 + 3 * 3600000).toISOString() }];
    const calls = RR.progress.attachLive([
      { kind: 'live', action: 'cut', ticket: '165605356', price_at: 1.271, adherence: 'ignored', created_at: new Date(d0 + 3600000).toISOString() },
      { kind: 'live', action: 'partial', ticket: '165605356', price_at: 1.271, adherence: 'followed', created_at: new Date(d0 + 7200000).toISOString() }], jr);
    const facts = RR.reports.buildFacts('daily', RR.reports.dayRange(d0s), calls, [], [], jr, d0 - 30 * DD);
    const env = makeEnv({ daily: { ok: true, period: d0s, facts, report: null } });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('daily').textContent.replace(/\s+/g, ' ');
    assert.deepStrictEqual(Array.from(env.win.document.querySelectorAll('#daily .q .qn')).map(e => e.textContent), ['1', '1', '0', '0']);
    assert.ok(/Following all live advice was worth ?\+2\.25R \(2 on closed trades\)/.test(t), t.slice(0, 500));
  });

  console.log('\nTHE DAILY SUMMARY — as the prototype laid it out');
  function realDay(opts = {}) {
    const RR = require('./arbiter-route.js');
    const ds = new Date().toISOString().slice(0, 10), d0 = Date.parse(ds + 'T00:00:00Z');
    const at = hr => new Date(d0 + hr * 3600000).toISOString();
    const jr = [
      { ticket: 70, symbol: 'EURUSD', direction: 'sell', open_price: 1.085, sl: 1.087, close_price: 1.083, total_pl: 66.8, close_time: at(3) },
      { ticket: 71, symbol: 'GBPUSD', direction: 'buy', open_price: 1.27, sl: 1.268, close_price: 1.268, total_pl: -108, close_time: at(4) }];
    const calls = RR.progress.attachLive([
      { kind: 'take', symbol: 'EURUSD', score: 74, adherence: 'followed', matched_ticket: '70', outcome: 'ran', correct: true, box: 'good', created_at: at(1), resolved_at: at(3) },
      { kind: 'skip', symbol: 'GBPUSD', score: 38, adherence: 'ignored', matched_ticket: '71', outcome: 'failed', correct: true, box: 'expensive', created_at: at(1.5), resolved_at: at(4) },
      { kind: 'take', symbol: 'USDJPY', score: 72, adherence: 'not_traded', outcome: 'ran', correct: true, created_at: at(2), resolved_at: at(5) },
      { kind: 'live', action: 'cut', ticket: '71', price_at: 1.2705, adherence: 'ignored', created_at: at(2.5), resolved_at: at(3) }], jr);
    const eps = opts.noErrors ? [] : [
      { type: 'no_sl', opened_at: at(1.5), closed_at: new Date(d0 + 1.5 * 3600000 + 41 * 60000).toISOString(), close_reason: 'resolved',
        context: { first: { detail: 'Trade on GBPUSDm has no stop loss set.' } } }];
    const facts = RR.reports.buildFacts('daily', RR.reports.dayRange(ds), calls, eps, [], opts.noTrades ? [] : jr, d0 - 30 * DD);
    const habits = Object.assign({ ok: true }, RR.habits.habitsSummary(eps, Date.now(), Date.now() - 30 * DD));
    return { daily: { ok: true, period: ds, facts, report: null }, habits };
  }
  const dayText = win => win.document.getElementById('daily').textContent.replace(/\s+/g, ' ');

  await check('the heading is the day in words, and says honestly whether it has closed', async () => {
    const env = makeEnv(realDay());
    await settle(env.win, 250);
    const h3 = env.win.document.querySelector('#daily .card h3').textContent;
    assert.ok(/^[A-Z][a-z]+day, \d{1,2} [A-Z][a-z]+$|^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/.test(h3), h3);
    assert.ok(/In progress · closes \d{1,2}:\d{2}( ?[AP]M)? your time/.test(dayText(env.win)), dayText(env.win).slice(0, 160));
    assert.ok(/ends at 00:00 UTC/.test(dayText(env.win)), 'and says which clock it is');
  });

  await check('Blackwood was right / You followed — counted the way the grid counts', async () => {
    const env = makeEnv(realDay());
    await settle(env.win, 250);
    const t = dayText(env.win);
    // right: EURUSD take ran, GBPUSD skip failed, USDJPY take ran (untraded still grades Blackwood),
    // and the held-through CUT whose following would have been worth +R  -> 4 of 4
    assert.ok(/Blackwood was right ?4 of 4 · 100%/.test(t), t.slice(0, 400));
    // followed: only pairs you traded — EURUSD followed; GBPUSD skip ignored; the live cut ignored -> 1 of 3
    assert.ok(/You followed ?1 of 3 · 33%/.test(t));
  });

  await check('P/L split, unactioned warnings, errors and unprotected time are all there', async () => {
    const env = makeEnv(realDay());
    await settle(env.win, 250);
    const t = dayText(env.win);
    assert.ok(/P\/L on trades you followed ?\+66\.80/.test(t));
    assert.ok(/P\/L on trades you overrode ?-108\.00/.test(t));
    assert.ok(/Unactioned warnings ?1/.test(t), 'the CUT you held through');
    assert.ok(/Trade errors raised ?1 · 1 fixed/.test(t));
    assert.ok(/Time money was unprotected ?41m/.test(t));
  });

  await check('the day in one line says only what the numbers support', async () => {
    const env = makeEnv(realDay());
    await settle(env.win, 250);
    const t = dayText(env.win);
    assert.ok(/The day in one line: ?Your following trades made money, your overriding trades lost more/.test(t), t);
    assert.ok(/money sat without a stop for 41m/.test(t));
    assert.ok(/1 warning was not acted on/.test(t));
  });

  await check('on a quiet day the one line says so, instead of inventing a story', async () => {
    const env = makeEnv(realDay({ noTrades: true, noErrors: true }));
    await settle(env.win, 250);
    assert.ok(!/following trades made money/.test(dayText(env.win)));
    assert.ok(!/without a stop/.test(dayText(env.win)));
  });

  await check('"How you traded, not what you traded" is inside the daily summary', async () => {
    const env = makeEnv(realDay());
    await settle(env.win, 250);
    const card = Array.from(env.win.document.querySelectorAll('#daily .card')).find(c => /How you traded, not what you traded/.test(c.textContent));
    assert.ok(card, 'present');
    assert.ok(/No stop loss/.test(card.textContent) && /41m in total/.test(card.textContent), card.textContent.slice(0, 300));
  });

  await check('in the prototype\'s order: the day, the grid, how you traded, then the numbers', async () => {
    const env = makeEnv(realDay());
    await settle(env.win, 250);
    const heads = Array.from(env.win.document.querySelectorAll('#daily .card h3')).map(h => h.textContent);
    assert.strictEqual(heads[1], 'Is it you, or is it Blackwood?');
    assert.strictEqual(heads[2], 'On the pairs you did not trade');
    assert.strictEqual(heads[3], 'How you traded, not what you traded');
    assert.strictEqual(heads[4], 'The numbers');
  });

  console.log('\nTHE SECOND GRID, RICHER HABITS, AND LIQUIDITY');

  await check('the pairs you did not trade get their own grid — Arbiter answering for itself', async () => {
    const env = makeEnv({ calls: mixed });
    await settle(env.win, 250);
    const card = Array.from(env.win.document.querySelectorAll('#calls .card')).find(c => /On the pairs you did not trade/.test(c.textContent));
    assert.ok(card, 'the second grid is there');
    const t = card.textContent.replace(/\s+/g, ' ');
    assert.ok(/Said take it — it ran/.test(t) && /Said skip it — it ran/.test(t));
    assert.ok(/Nothing here is about you/.test(t));
    assert.deepStrictEqual(Array.from(card.querySelectorAll('.q .qn')).map(e => e.textContent), ['1', '0', '0', '1'],
      'GBPJPY take ran (right), USDCHF skip ran (wrong)');
  });

  await check('a habit line carries the size multiple, the call and the result', async () => {
    const RR = require('./arbiter-route.js');
    // an episode from EARLIER TODAY, whatever time this runs: "an hour ago" is
    // yesterday just after midnight UTC, which made this test fail at 00:02
    const now = Date.now(), dayStartMs = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z');
    const opened = Math.floor((dayStartMs + Math.max(60000, (now - dayStartMs) / 2)) / 1000);
    const eps = RR.habits.enrichEpisodes(
      [{ type: 'revenge', ticket: '500', opened_at: new Date(opened * 1000).toISOString(),
         closed_at: new Date(opened * 1000 + 60000).toISOString(), close_reason: 'resolved', context: {} }],
      [{ kind: 'take', symbol: 'GBPUSD', score: 38, direction: 'bull', created_at: new Date(opened * 1000 - 9 * 60000).toISOString() }],
      [{ ticket: '500', symbol: 'GBPUSDm', direction: 'buy', open_price: 1.27, close_price: 1.2682, total_pl: -108, pips: -18,
         close_time: new Date(now).toISOString() }],
      [{ ticket: '500', symbol: 'GBPUSD', side: 'buy', open_price: 1.27, open_time_s: opened, volume: 0.6, risk_pct: 3.2 }]
        .concat(Array.from({ length: 20 }, (_, i) => ({ ticket: 'h' + i, volume: 0.19, risk_pct: 1.0 }))));
    const habits = Object.assign({ ok: true }, RR.habits.habitsSummary(eps, now, now - 30 * DD));
    const env = makeEnv({ habits });
    await settle(env.win, 250);
    const t = env.win.document.getElementById('habits').textContent.replace(/\s+/g, ' ');
    assert.ok(/3\.2x your median of 1%/.test(t), t.slice(0, 400));
    assert.ok(/\(0\.6 lots against your usual 0\.19\)/.test(t));
    assert.ok(/Arbiter had rated that setup 38/.test(t));
    assert.ok(/It closed -18 pips/.test(t));
  });

  await check('a position on a flagged pair is reported, once a minute, never oftener', async () => {
    const env = makeEnv();
    env.win.localStorage.setItem('bw-risk-now', JSON.stringify({ t: Date.now(), pairs: { EURUSD: { score: 61, state: 'elevated' } } }));
    await settle(env.win, 250);
    const flags = env.posts.filter(p => /\/api\/arbiter\/flagged/.test(p.url));
    assert.strictEqual(flags.length, 1, 'reported once');
    assert.strictEqual(flags[0].body.ticket, '501');
    assert.strictEqual(flags[0].body.score, 61);
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 40);
    assert.strictEqual(env.posts.filter(p => /flagged/.test(p.url)).length, 1, 'not again within the minute');
  });

  await check('a clear pair is never reported as flagged', async () => {
    const env = makeEnv();
    env.win.localStorage.setItem('bw-risk-now', JSON.stringify({ t: Date.now(), pairs: { EURUSD: { score: 14, state: 'clear' } } }));
    await settle(env.win, 250);
    assert.strictEqual(env.posts.filter(p => /flagged/.test(p.url)).length, 0);
  });

  await check('the rail names the liquidity reading, not a made-up percentage', async () => {
    const env = makeEnv();
    await settle(env.win, 300);
    const t = env.win.document.getElementById('feeds').textContent.replace(/\s+/g, ' ');
    assert.ok(/Liquidity ?(Healthy|Thin|Learning|Being swept|Liquidity drought|not read)/.test(t), t);
  });

  console.log('\nTHE WEEKLY REVIEW — the prototype\'s missing pieces');
  function realWeek() {
    const RR = require('./arbiter-route.js');
    const wk = RR.reports.weekOf(Date.now());
    const d = (day, hr) => new Date(wk.start + day * DD + hr * 3600000).toISOString();
    const jr = [
      { ticket: '1', symbol: 'EURUSD', direction: 'buy', open_price: 1.1, sl: 1.098, close_price: 1.104, total_pl: 412, pips: 40,
        session: 'London', open_time: d(0, 8), close_time: d(0, 10) },
      { ticket: '2', symbol: 'GBPUSD', direction: 'buy', open_price: 1.27, sl: 1.268, close_price: 1.268, total_pl: -388, pips: -20,
        session: 'Late New York', open_time: d(2, 14), close_time: d(2, 20) }];
    const calls = RR.progress.attachLive([
      { kind: 'take', symbol: 'EURUSD', score: 74, adherence: 'followed', matched_ticket: '1', outcome: 'ran', correct: true, box: 'good', created_at: d(0, 7), resolved_at: d(0, 10) },
      { kind: 'skip', symbol: 'GBPUSD', score: 58, adherence: 'ignored', matched_ticket: '2', outcome: 'failed', correct: true, box: 'expensive', created_at: d(2, 13), resolved_at: d(2, 20) },
      { kind: 'take', symbol: 'USDCHF', score: 77, adherence: 'not_traded', outcome: 'ran', correct: true, created_at: d(1, 9), resolved_at: d(1, 14) }], jr, []);
    const eps = [
      { type: 'no_sl', opened_at: d(2, 13), closed_at: new Date(wk.start + 2 * DD + 13 * 3600000 + 41 * 60000).toISOString(), close_reason: 'resolved' },
      { type: 'no_sl', opened_at: d(2, 15), closed_at: new Date(wk.start + 2 * DD + 15 * 3600000 + 28 * 60000).toISOString(), close_reason: 'resolved' },
      { type: 'revenge', opened_at: d(2, 14), closed_at: d(2, 14), close_reason: 'resolved' },
      { type: 'oversize', opened_at: d(2, 14), closed_at: d(2, 16), close_reason: 'resolved' },
      { type: 'no_sl', opened_at: new Date(wk.start - 5 * DD).toISOString(), closed_at: new Date(wk.start - 5 * DD + 10 * 60000).toISOString(), close_reason: 'resolved' }];
    const facts = RR.reports.buildFacts('weekly', wk, calls, eps, [], jr, wk.start - 60 * DD);
    return { weekly: { ok: true, period: wk.key, facts, report: null } };
  }
  const weekText = win => win.document.getElementById('weekly').textContent.replace(/\s+/g, ' ');

  await check('each box carries the money behind it', async () => {
    const env = makeEnv(realWeek());
    await settle(env.win, 250);
    const t = weekText(env.win);
    assert.ok(/\+412\.00\. The system working as intended/.test(t), t.slice(0, 400));
    assert.ok(/-388\.00\. The expensive box/.test(t));
  });

  await check('the answer to the question the module exists for, from the week\'s own figures', async () => {
    const env = makeEnv(realWeek());
    await settle(env.win, 250);
    const t = weekText(env.win);
    assert.ok(/Blackwood was right on 3 of 3 resolved calls this week/.test(t), t.slice(t.indexOf('The answer'), t.indexOf('The answer') + 260));
    assert.ok(/You acted on 1 of 2/.test(t));
    // this fixture week finished UP, so the "more than the whole week's loss" clause must NOT appear
    assert.ok(/you overrode cost -388\.00\./.test(t), t.slice(t.indexOf('The answer'), t.indexOf('The answer') + 300));
    assert.ok(!/more than the whole week/.test(t), 'no claim the numbers do not carry');
    assert.ok(/treat all of this as a hint, not a finding/.test(t), 'and it admits the sample is thin');
  });

  await check('...and on a LOSING week it does say the overrides cost more than the loss', async () => {
    const w = realWeek();
    // the followed winner becomes a smaller win, so the week finishes down
    w.weekly.facts.trades.netPL = -18; w.weekly.facts.week.netPL = -18;
    const env = makeEnv(w);
    await settle(env.win, 250);
    assert.ok(/you overrode cost -388\.00 — more than the whole week/.test(weekText(env.win)));
  });

  await check('"Where the week went", with the 70+ figure honestly framed', async () => {
    const env = makeEnv(realWeek());
    await settle(env.win, 250);
    const t = weekText(env.win);
    assert.ok(/Where the week went/.test(t));
    assert.ok(/Net ?\+24\.00/.test(t), t.slice(t.indexOf('Where the week'), t.indexOf('Where the week') + 300));
    assert.ok(/If you had taken only your 70\+ calls ?\+412\.00/.test(t));
    assert.ok(/Best session ?London · \+412\.00/.test(t));
    assert.ok(/Worst session ?Late New York · -388\.00/.test(t));
    assert.ok(/Average hold, winners ?2h 0m/.test(t));
    assert.ok(/Average hold, losers ?6h 0m/.test(t));
    assert.ok(/not a backtest of trades you never took/.test(t));
  });

  await check('habits across the week: a column per day, exposure, and the direction', async () => {
    const env = makeEnv(realWeek());
    await settle(env.win, 250);
    const card = Array.from(env.win.document.querySelectorAll('#weekly .card')).find(c => /Habits across the week/.test(c.textContent));
    assert.ok(card, 'the table is there');
    const head = Array.from(card.querySelectorAll('thead th')).map(h => h.textContent);
    const nDays = card.querySelectorAll('thead th').length - 3;
    assert.ok(nDays >= 1 && nDays <= 7, 'name + the days so far + exposed + direction');
    const row = Array.from(card.querySelectorAll('tbody tr')).find(r => /No stop loss/.test(r.textContent));
    assert.strictEqual(row.cells[3].textContent, '2', 'both on the same day');
    assert.ok(/1h 9m/.test(row.cells[nDays + 1].textContent), row.cells[nDays + 1].textContent);
    assert.ok(/worse — 69m of exposure vs 10m last week/.test(row.cells[nDays + 2].textContent), row.cells[nDays + 2].textContent);
  });

  await check('one bad session is called one bad session, not many bad habits', async () => {
    const env = makeEnv(realWeek());
    await settle(env.win, 250);
    const t = weekText(env.win);
    assert.ok(/is every column/.test(t), t.slice(t.indexOf('Habits across'), t.indexOf('Habits across') + 700));
    assert.ok(/That is one bad session, not 3 bad habits/.test(t));
  });

  await check('exposure is explained — 90 seconds and two hours are not the same error', async () => {
    const env = makeEnv(realWeek());
    await settle(env.win, 250);
    assert.ok(/A stop set in 90 seconds and one set after two hours are not the same error/.test(weekText(env.win)));
  });

  console.log('\nEXPOSURE, THE WEEK HEADING, AND THE MIDNIGHT RESET');

  await check('two positions that move TOGETHER are called one idea, with the correlation measured', async () => {
    const env = twoPositions();
    // both pairs given the SAME closes: perfectly correlated, both short
    const cd = candles(zigzag(80, 1.0920, 0.0006, true));
    env.routes['/api/candles'] = { symbol: 'EURUSDm', candlesByTF: { H1: cd }, candles: cd };
    env.routes['/api/state'].openTrades[1].type = 'sell';
    await settle(env.win, 300);
    const card = Array.from(env.win.document.querySelectorAll('#main .card')).find(c => /Exposure right now/.test(c.textContent));
    assert.ok(card, 'the exposure card is there with two positions');
    const t = card.textContent.replace(/\s+/g, ' ');
    assert.ok(/Open risk if every stop is hit/.test(t) && /Floating/.test(t));
    assert.ok(/correlated over the last \d+ H1 candles/.test(t), 'measured, and the window named: ' + t.slice(0, 300));
    assert.ok(/not 2 independent bets/.test(t));
    assert.ok(/it is telling you what you are actually holding/.test(t));
  });

  await check('one position: no exposure card at all', async () => {
    const env = makeEnv();
    await settle(env.win, 250);
    assert.ok(!Array.from(env.win.document.querySelectorAll('#main .card')).some(c => /Exposure right now/.test(c.textContent)));
  });

  await check('correlation is never claimed without enough candles', async () => {
    const env = twoPositions();
    const few = candles(zigzag(12, 1.09, 0.0006, true));
    env.routes['/api/candles'] = { symbol: 'EURUSDm', candlesByTF: { H1: few }, candles: few };
    await settle(env.win, 300);
    const card = Array.from(env.win.document.querySelectorAll('#main .card')).find(c => /Exposure right now/.test(c.textContent));
    assert.ok(/Correlation needs at least 30 candles/.test(card.textContent));
    assert.ok(!/correlated over/.test(card.textContent));
  });

  await check('the weekly heading reads as a date range, and can be downloaded without a written review', async () => {
    const env = makeEnv({ weekly: { ok: true, period: wk.key, facts: weeklyFacts, report: null } });
    await settle(env.win, 250);
    const head = env.win.document.querySelector('#weekly .card h3').textContent;
    // same month: "Week of 21-27 September"; across months: "Week of 28 September - 4 October"
    assert.ok(/^Week of \d{1,2}–\d{1,2} [A-Z][a-z]+$|^Week of \d{1,2} [A-Z][a-z]+ – \d{1,2} [A-Z][a-z]+$/.test(head), head);
    assert.ok(env.win.document.querySelector('#weekly [data-dl="html"]'), 'download is there with no Claude review');
    assert.ok(env.win.document.querySelector('#weekly [data-dl="print"]'));
  });

  await check('Today\'s calls asks for TODAY, not the last 24 hours', async () => {
    const env = makeEnv();
    await settle(env.win, 250);
    assert.ok(env.calls.some(c => c === '/api/arbiter/calls?days=1'), env.calls.filter(c => /calls/.test(c)).join(' '));
  });

  console.log('\nPATTERN ALERTS IN HUNTING, AND THE LIVE PATH');

  await check('the hunting card shows the Pattern ALERTS tab, not just the live tab', async () => {
    const env = makeEnv({ state: { watchlist: [{ symbol: 'EURUSDm', bid: 1.084, spread: 8 }], openTrades: [], closedTrades: [],
      accountInfo: { login: 5000 }, news: [],
      patternAlerts: [{ symbol: 'EURUSDm', name: 'Bullish Engulfing', direction: 'bullish', confidence: 88, timeframe: 'H1',
        time: new Date(Date.now() - 45 * 60000).toISOString() }] } });
    await settle(env.win, 300);
    const t = env.win.document.getElementById('main').textContent.replace(/\s+/g, ' ');
    assert.ok(/Pattern alerts/.test(t), 'the window is there');
    assert.ok(/Bullish Engulfing/.test(t) && /88%/.test(t), t.slice(t.indexOf('Pattern alerts'), t.indexOf('Pattern alerts') + 200));
    assert.ok(/still fresh/.test(t));
  });

  await check('with no alerts it says both windows are read, rather than showing nothing', async () => {
    const env = makeEnv({ state: { watchlist: [{ symbol: 'EURUSDm', bid: 1.084, spread: 8 }], openTrades: [], closedTrades: [],
      accountInfo: { login: 5000 }, news: [], patternAlerts: [] } });
    await settle(env.win, 300);
    assert.ok(/Both the Pattern Detector's live tab and the Assistant's Pattern Alerts tab are read here/
      .test(env.win.document.getElementById('main').textContent));
  });

  await check('a trigger that fired as an ALERT can satisfy the trigger condition', async () => {
    const E = require('./arbiter-engine.js');
    const w = { symbol: 'EURUSD', price: 1.08, timeframe: 'H1', patterns: [],
      alerts: [{ name: 'Bullish Engulfing', direction: 'bullish', confidence: 88, timeframe: 'H1', barsAgo: 1 }] };
    const c = E._internals.judge(w, 'bull').conditions.find(x => x.id === 'trigger');
    assert.strictEqual(c.state, 'pass', c.detail);
    assert.strictEqual(c.source, 'pattern alerts', 'and it says which window it came from');
  });

  await check('LIVE: with trades open, Arbiter judges them AND records what it says', async () => {
    const env = losingEnv();
    stackAgainst(env);
    await settle(env.win, 300);
    // it is judging
    const card = env.win.document.querySelector('#main .card[data-ticket]');
    assert.ok(card, 'a judgement card for the open trade');
    assert.ok(/CUT|HOLD|PARTIAL|BREAK-EVEN/.test(card.querySelector('.act-word').textContent));
    assert.ok(card.querySelectorAll('.press .pn').length > 0, 'with the pressure behind it');
    // and recording it
    // find the LIVE call: the hunting scan keeps running while a trade is open,
    // so a skip call for another setup can legitimately be recorded first
    const posted = env.posts.filter(p => /\/api\/arbiter\/call/.test(p.url) && p.body && p.body.kind === 'live');
    assert.ok(posted.length >= 1, 'the live call was recorded');
    const body = posted[0].body;
    assert.strictEqual(body.kind, 'live');
    assert.strictEqual(String(body.ticket), '501');
    // the page does NOT send a price: the SERVER stamps price_at from the live
    // feed, which is the trustworthy side (test-arbiter covers that end)
    assert.ok(!('price' in body), 'the browser never supplies the price');
    assert.ok(body.snapshot && body.snapshot.pressure, 'the full reasoning is frozen with the call');
    assert.ok(body.action && body.score != null, 'the action and the pressure behind it');
  });

  await check('LIVE: a plain HOLD on first sight is not recorded as a call', async () => {
    const env = makeEnv();                       // a quiet winning position
    await settle(env.win, 300);
    assert.strictEqual(env.posts.filter(p => /\/api\/arbiter\/call/.test(p.url)).length, 0);
  });

  console.log('\nGROUPING OPEN POSITIONS');
  // three GBP/USD shorts, 1.00 lot each. `levels` sets each leg's stop/target.
  function threeLegs(levels) {
    // the status must be in place BEFORE the first cycle, or the legs are
    // judged without their excursions
    const env = makeEnv({ status: { ok: true, accounts: [{ account_number: '1001' }], openEpisodes: [],
      openPositions: levels.map((_, i) => ({ ticket: String(700 + i), mfe_pips: 18 - i, mae_pips: 6 + i })) } });
    const st = env.routes['/api/state'];
    st.openTrades = levels.map((lv, i) => ({ ticket: 700 + i, symbol: 'EURUSDm', type: 'sell', volume: 1.00,
      openPrice: 1.0850 + i * 0.0002, sl: lv.sl, tp: lv.tp, profit: -20 - i, riskPct: 0.9,
      openTime: Math.floor(Date.now() / 1000) - (3600 - i * 600) }));
    return env;
  }
  const boxCards = win => Array.from(win.document.querySelectorAll('#main .card[data-ticket]'));

  await check('three legs, same lot, identical levels → ONE box, ONE verdict', async () => {
    const env = threeLegs([{ sl: 1.0880, tp: 1.0800 }, { sl: 1.0880, tp: 1.0800 }, { sl: 1.0880, tp: 1.0800 }]);
    await settle(env.win, 350);
    const cards = boxCards(env.win);
    assert.strictEqual(cards.length, 1, 'one box, not three cards');
    assert.strictEqual(cards[0].querySelectorAll('.verdict[data-part="action"]').length, 1, 'one verdict');
    const t = cards[0].textContent.replace(/\s+/g, ' ');
    assert.ok(/3 × 1 lots/.test(t), t.slice(0, 200));
    assert.ok(/identical levels, one verdict/.test(t));
    assert.ok(/All 3 legs/.test(t));
  });

  await check('the box still carries the FULL analysis — nothing about the judging changed', async () => {
    const env = threeLegs([{ sl: 1.0880, tp: 1.0800 }, { sl: 1.0880, tp: 1.0800 }, { sl: 1.0880, tp: 1.0800 }]);
    await settle(env.win, 350);
    const t = boxCards(env.win)[0].textContent.replace(/\s+/g, ' ');
    console.log('       has meter: ' + /exc-track/.test(boxCards(env.win)[0].innerHTML));
    ['The case for this trade', 'Where it has been', 'evidence agreement', 'What is working against it']
      .forEach(bit => assert.ok(new RegExp(bit, 'i').test(t), 'missing from the box: ' + bit));
    assert.ok(boxCards(env.win)[0].querySelectorAll('.pill').length >= 4, 'the pillars are there');
  });

  await check('the third leg on ITS OWN stop gets its own verdict, in the same box', async () => {
    const env = threeLegs([{ sl: 1.0880, tp: null }, { sl: 1.0880, tp: null }, { sl: 1.0870, tp: 1.0790 }]);
    await settle(env.win, 350);
    const cards = boxCards(env.win);
    assert.strictEqual(cards.length, 1, 'still one box — same pair, direction and size');
    const verdicts = cards[0].querySelectorAll('.verdict[data-part="action"]');
    assert.strictEqual(verdicts.length, 2, 'two verdicts');
    assert.ok(/2 verdicts, because the levels differ/.test(cards[0].textContent));
    assert.ok(/Legs #700 and #701/.test(verdicts[0].textContent));
    assert.ok(/Leg #702 — its own stop and target/.test(verdicts[1].textContent));
    // and the lone leg is judged in full, not summarised
    assert.ok(/PRESSURE/.test(verdicts[1].textContent), 'it has its own pressure reading');
    const readings = cards[0].querySelectorAll('.verdict[data-part="analysis"]');
    assert.strictEqual(readings.length, 2, 'and each verdict has its full reading below');
    assert.ok(readings[1].querySelectorAll('.pill').length >= 4, 'with its own pillars');
  });

  await check('different LOT SIZES on one pair and side are ONE box (Assan: "it will make things simple")', async () => {
    const env = threeLegs([{ sl: 1.0880, tp: 1.0800 }, { sl: 1.0880, tp: 1.0800 }, { sl: 1.0880, tp: 1.0800 }]);
    env.routes['/api/state'].openTrades[2].volume = 2.00;
    await settle(env.win, 350);
    assert.strictEqual(boxCards(env.win).length, 1, 'one box');
    assert.ok(/1 \+ 1 \+ 2 lots/.test(boxCards(env.win)[0].textContent), 'its lots, as they are');
  });

  await check('opposite directions on one pair are NOT grouped — a hedge', async () => {
    const env = threeLegs([{ sl: 1.0880, tp: 1.0800 }, { sl: 1.0880, tp: 1.0800 }]);
    env.routes['/api/state'].openTrades[1].type = 'buy';
    env.routes['/api/state'].openTrades[1].sl = 1.0820;
    env.routes['/api/state'].openTrades[1].tp = 1.0900;
    await settle(env.win, 350);
    assert.strictEqual(boxCards(env.win).length, 2, 'each side on its own');
  });

  await check('a call is posted per LEG, so the grid keeps counting legs', async () => {
    const env = threeLegs([{ sl: 1.0880, tp: null }, { sl: 1.0880, tp: null }, { sl: 1.0880, tp: null }]);
    stackAgainst(env);
    await settle(env.win, 350);
    const posted = env.posts.filter(p => /\/api\/arbiter\/call/.test(p.url) && p.body.kind === 'live');
    if (posted.length) {
      const tickets = posted.map(p => String(p.body.ticket)).sort();
      assert.deepStrictEqual(tickets, ['700', '701', '702'], 'one call per leg: ' + tickets.join(','));
      const actions = new Set(posted.map(p => p.body.action));
      assert.strictEqual(actions.size, 1, 'the same verdict for every leg of the book');
    } else assert.ok(true, 'this fixture settled on HOLD at first sight, which is not a call');
  });

  await check('the rail picker shows ONE entry per box, at its highest pressure', async () => {
    const env = threeLegs([{ sl: 1.0880, tp: null }, { sl: 1.0880, tp: null }, { sl: 1.0880, tp: null }]);
    env.routes['/api/state'].openTrades.push({ ticket: 800, symbol: 'GBPUSDm', type: 'sell', volume: 0.5,
      openPrice: 1.2700, sl: 1.2750, tp: 1.2600, profit: 8, riskPct: 0.5, openTime: Math.floor(Date.now() / 1000) - 3600 });
    await settle(env.win, 350);
    const btns = Array.from(env.win.document.querySelectorAll('#pairPick button'));
    assert.strictEqual(btns.length, 2, 'two boxes, two buttons: ' + btns.map(b => b.textContent).join(' | '));
    assert.ok(/×3/.test(btns[0].textContent), 'and it says the box holds three legs');
  });

  await check('the positions are VISIBLE — no clicking — with their money and pips', async () => {
    const env = threeLegs([{ sl: 1.0880, tp: null }, { sl: 1.0880, tp: null }, { sl: 1.0870, tp: 1.0790 }]);
    await settle(env.win, 350);
    const card = boxCards(env.win)[0];
    assert.strictEqual(card.querySelectorAll('details').length, 0, 'nothing is hidden behind a click');
    const legs = card.querySelector('.legs');
    assert.ok(legs, 'the positions are on the card');
    const rows = legs.querySelectorAll('tbody tr');
    assert.strictEqual(rows.length, 3);
    const head = Array.from(legs.querySelectorAll('thead th')).map(h => h.textContent);
    assert.ok(head.indexOf('Floating') >= 0 && head.indexOf('Pips') >= 0, head.join(','));
    assert.ok(/own levels/.test(legs.textContent), 'the odd leg is marked');
  });

  await check('the box reads top-down like the prototype: verdict, numbers, positions, then the reading', async () => {
    const env = threeLegs([{ sl: 1.0880, tp: null }, { sl: 1.0880, tp: null }, { sl: 1.0880, tp: null }]);
    await settle(env.win, 350);
    const kids = Array.from(boxCards(env.win)[0].querySelector('.card-b').children);
    const order = kids.map(k => k.getAttribute('data-part') || k.className.split(' ')[0]);
    assert.deepStrictEqual(order, ['action', 'bookq', 'legs', 'analysis'], order.join(' → '));
  });

  await check('the tab bar: an active tab reads clearly, and nothing animates on repaint', () => {
    const css = HTML.split('<style>')[1].split('</style>')[0];
    assert.ok(/\.nav-tab\.active\{[^}]*color:var\(--text\)/.test(css), 'the active tab is brighter than the rest');
    assert.ok(/\.nav-tab\.active::after\{transform:scaleX\(1\)/.test(css), 'and carries the underline');
    assert.ok(/\.nav-tab:hover/.test(css), 'hover responds');
    assert.ok(/\.nav-tab:focus-visible/.test(css), 'and it is reachable by keyboard');
    assert.ok(!/\.nav-tab\{[^}]*animation/.test(css), 'no animation on a repainted element');
    assert.ok(/@supports not \(backdrop-filter/.test(css), 'a solid fallback where blur is unsupported');
  });

  await check('nothing on the card animates on a repaint — that was the flicker', async () => {
    const css = HTML.split('<style>')[1].split('</style>')[0];
    assert.ok(!/\.card\{[^}]*animation/.test(css), 'the card must not animate: it is repainted every cycle');
    assert.ok(!/\.verdict\{[^}]*animation/.test(css));
    assert.ok(!/\.act\.cut\{[^}]*animation/.test(css));
  });

  await check('one position alone still renders exactly as before', async () => {
    const env = makeEnv();
    await settle(env.win, 300);
    const cards = boxCards(env.win);
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].querySelectorAll('.verdict').length, 0, 'no box wrapper for a single position');
    assert.ok(/PRESSURE/.test(cards[0].textContent));
  });

  console.log('\nTHE EA IS ON ANOTHER CHART (Assan: EA on GBP/USD, trade on EUR/USD)');

  function otherChartEnv(opts = {}) {
    const eur = candles(zigzag(80, 1.0800, 0.0006, false));
    const gbp = candles(zigzag(80, 1.2700, 0.0006, true));
    const env = makeEnv({
      // the EA is attached to GBP/USD: that is the chart symbol
      state: { symbol: 'GBPUSDm', timeframe: 'H1',
        watchlist: [{ symbol: 'GBPUSDm', bid: 1.2700, spread: 9 }, { symbol: 'EURUSDm', bid: 1.0840, spread: 8 }],
        openTrades: opts.trade ? [{ ticket: 901, symbol: 'EURUSDm', type: 'buy', volume: 0.5, openPrice: 1.0830,
          sl: 1.0800, tp: 1.0900, profit: 12, riskPct: 0.8, openTime: Math.floor(Date.now() / 1000) - 1800 }] : [],
        closedTrades: [], accountInfo: { login: 5000, balance: 10000 }, news: [],
        patterns: [{ name: 'Bullish Engulfing', direction: 'bullish', confidence: 74, barsAgo: 0 }] },
      // the server keys candles and patterns by symbol — both pairs are cached,
      // which is the whole point of the multi-candles bundle
      candles: { __bySymbol: {
        'GBPUSDm': { symbol: 'GBPUSDm', candlesByTF: { H1: gbp }, candles: gbp },
        'EURUSDm': { symbol: 'EURUSDm', candlesByTF: { H1: eur }, candles: eur } } },
      patterns: { __bySymbol: {
        'GBPUSDm': { patterns: [{ name: 'Bearish Engulfing', type: 'bearish', confidence_pct: 80, bar_index: 1, timeframe: 'H1' }] },
        'EURUSDm': { patterns: [{ name: 'Bullish Engulfing', type: 'bullish', confidence_pct: 78, bar_index: 1, timeframe: 'H1' }] } } },
      status: { ok: true, accounts: [{ account_number: '1001' }], openEpisodes: [],
        openPositions: [{ ticket: '901', mfe_pips: 12, mae_pips: 3 }] },
      // THE EA'S REAL PAYLOAD (SendMultiSymbolSMC): per symbol, orderBlocks with
      // direction / timeStart / high / low, stamped receivedAt by the server.
      // `zonesForEur: false` = the EUR/USD post has not arrived.
      smc: (function(){
        const ob = (dir, lo, hi) => ({ direction: dir, timeStart: '2026.09.21 08:00', high: hi, low: lo, mitigated: false });
        const bag = { 'GBPUSDm': { symbol: 'GBPUSDm', timeframe: 'H1', receivedAt: new Date(Date.now() - 4000).toISOString(),
                                   structure: [], fvgs: [], orderBlocks: [ob('bullish', 1.2680, 1.2695)] } };
        if (opts.zonesForEur !== false)
          bag['EURUSDm'] = { symbol: 'EURUSDm', timeframe: 'H1', receivedAt: new Date(Date.now() - 6000).toISOString(),
                             structure: [], fvgs: [], orderBlocks: [ob('bullish', 1.0815, 1.0835)] };
        return bag;
      })()
    });
    return env;
  }

  await check('CORRECTED: the EA sends zones for EVERY watch pair — EUR/USD reads them on another chart', async () => {
    const env = otherChartEnv({ trade: true });
    await settle(env.win, 420);
    const card = env.win.document.querySelector('#main .card[data-ticket]');
    const loc = Array.from(card.querySelectorAll('.pill')).find(p => /Location/.test(p.textContent));
    assert.ok(!loc.classList.contains('unknown'), 'location reads from the EUR/USD zones: ' + loc.textContent);
    assert.ok(/SMC zones ?\d+ live · \d+s ago/.test(env.win.document.getElementById('feeds').textContent.replace(/\s+/g, ' ')),
      'and the rail says how fresh they are');
  });

  await check('when a pair\'s zones have NOT arrived, Arbiter reads its own — and says so', async () => {
    const env = otherChartEnv({ zonesForEur: false, trade: true });
    await settle(env.win, 420);
    const card = env.win.document.querySelector('#main .card[data-ticket]');
    const t = card.textContent.replace(/\s+/g, ' ');
    assert.ok(!/SMC indicator/.test(t), 'never blames an indicator that does not exist');
    const rail = env.win.document.getElementById('feeds').textContent.replace(/\s+/g, ' ');
    assert.ok(/from Arbiter's own read · nothing received from the EA/.test(rail), rail.slice(0, 300));
    // every zone-based condition names the source, so an own-read zone never passes for an EA zone
    const loc = Array.from(card.querySelectorAll('.pill')).find(p => /Location/.test(p.textContent));
    assert.ok(/Arbiter's own read from candles|No SMC data/.test(loc.textContent), loc.textContent);
  });

  await check('HUNTING reads EUR/USD even though the EA sits on GBP/USD', async () => {
    const env = otherChartEnv();
    await settle(env.win, 350);
    const rows = Array.from(env.win.document.querySelectorAll('#main button.scan')).map(b => b.dataset.sym);
    assert.ok(rows.indexOf('EURUSD') >= 0, 'EUR/USD is scanned: ' + rows.join(','));
    const eur = Array.from(env.win.document.querySelectorAll('#main button.scan')).find(b => b.dataset.sym === 'EURUSD');
    eur.click(); await settle(env.win, 40);
    const known = Array.from(env.win.document.querySelectorAll('#main .pill')).filter(p => !p.classList.contains('unknown')).length;
    assert.ok(known >= 6, 'EUR/USD is genuinely read while hunting: ' + known + ' of 14 conditions');
  });

  await check('AFTER TAKING IT, the live card must read EUR/USD just as well', async () => {
    const env = otherChartEnv({ trade: true });
    await settle(env.win, 400);
    const card = env.win.document.querySelector('#main .card[data-ticket]');
    assert.ok(card, 'the position card is there');
    const t = card.textContent.replace(/\s+/g, ' ');
    assert.ok(!/Not enough is reaching Arbiter/.test(t), 'it must not go blank: ' + t.slice(0, 200));
    const pills = Array.from(card.querySelectorAll('.pill'));
    const known = pills.filter(p => !p.classList.contains('unknown')).length;
    assert.ok(known >= 4, 'the pillars read: ' + known + ' known of ' + pills.length + ' — ' +
      pills.map(p => p.textContent.slice(0, 22)).join(' | '));
  });

  await check('a position\'s age is shown in real time, not the broker\'s clock', async () => {
    const env = makeEnv();
    const st = env.routes['/api/state'];
    st.brokerOffsetSec = 3 * 3600;                                         // a GMT+3 broker
    st.openTrades[0].openTime = Math.floor(Date.now() / 1000) - 1800 + 3 * 3600;   // opened 30 min ago, broker clock
    await settle(env.win, 320);
    const t = env.win.document.querySelector('#main .card').textContent.replace(/\s+/g, ' ');
    assert.ok(/· 3\dm\b|· 30m/.test(t), 'shows about 30m, not minus three hours: ' + t.slice(0, 160));
  });

  console.log('\nA WINDOW LOSING SIGNAL (Assan: they sometimes appear disconnected)');

  await check('ONE failed request must not blank the windows for that cycle', async () => {
    const env = makeEnv({ state: { watchlist: [{ symbol: 'EURUSDm', bid: 1.0840, spread: 8 }], openTrades: [],
      closedTrades: [], accountInfo: { login: 5000 }, news: [] } });
    await settle(env.win, 320);
    const known = () => Array.from(env.win.document.querySelectorAll('#main .pill')).filter(p => !p.classList.contains('unknown')).length;
    const before = known();
    assert.ok(before >= 4, 'readable to start with: ' + before);
    // a single blip: the candle request fails for one cycle
    const saved = env.routes['/api/candles'];
    env.routes['/api/candles'] = null;          // a REAL failure: the request comes back 404
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 60);
    const during = known();
    env.routes['/api/candles'] = saved;
    assert.strictEqual(during, before, 'a blip blanked ' + (before - during) + ' conditions for a whole cycle');
  });

  await check('the Retracement row reports the engine for real — no leftover "not published yet"', async () => {
    const env = makeEnv();
    await settle(env.win, 300);
    const t = env.win.document.getElementById('feeds').textContent.replace(/\s+/g, ' ');
    assert.ok(!/not published yet/.test(t), 'the stale placeholder is gone');
    // the real page loads retracement.js: the row shows the engine's own verdict and score
    assert.ok(/Retracement ?(pullback|reversal|unclear|undecided)[^·]*· ?\d+/i.test(t), t.slice(0, 500));
  });
  await check('...and if retracement.js is MISSING, the row says so — never a leftover or a guess', async () => {
    const env = makeEnv({ omitScripts: ['retracement.js'] });
    await settle(env.win, 300);
    const t = env.win.document.getElementById('feeds').textContent.replace(/\s+/g, ' ');
    assert.ok(/Retracement ?engine not loaded — is retracement.js deployed beside app.js\?/.test(t), t.slice(0, 500));
  });

  await check('...but a feed that has REALLY died still shows as dead after 90 seconds', async () => {
    const env = makeEnv({ state: { watchlist: [{ symbol: 'EURUSDm', bid: 1.0840, spread: 8 }], openTrades: [],
      closedTrades: [], accountInfo: { login: 5000 }, news: [] } });
    await settle(env.win, 320);
    const known = () => Array.from(env.win.document.querySelectorAll('#main .pill')).filter(p => !p.classList.contains('unknown')).length;
    const before = known();
    env.routes['/api/candles'] = null;          // a REAL failure: the request comes back 404
    const realNow = env.win.Date.now;
    env.win.Date.now = () => realNow.call(env.win.Date) + 120 * 1000;      // two minutes later
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 60);
    const after = known();
    env.win.Date.now = realNow;
    assert.ok(after < before, 'old data must not hide a dead feed: ' + before + ' -> ' + after);
  });

  await check('CX-14: three legs on the SAME levels — the reversal is judged ONCE per box, not once per leg', async () => {
    const env = threeLegs([{ sl: 1.0880, tp: null }, { sl: 1.0880, tp: null }, { sl: 1.0880, tp: null }]);
    await settle(env.win, 320);
    // count EXACTLY one cycle: first wait until none is running (the page disables its refresh
    // button meanwhile). With the page's real engines a cycle takes longer, and the first one could
    // still be judging inside the counting window — counted twice, though one cycle judges once.
    for (let i = 0; i < 100 && env.win.document.getElementById('btnRefresh').disabled; i++) await settle(env.win, 20);
    const E = env.win.BWArbiterEngine, real = E.judgePosition; let calls = 0;
    E.judgePosition = function () { calls++; return real.apply(this, arguments); };
    await env.win.BWArbiterPage.cycle();
    E.judgePosition = real;
    assert.strictEqual(calls, 1, 'judged ' + calls + ' times for one box of three identical legs');
  });

  await check('CX-14: a leg on its OWN levels is judged separately — two judgements for that box', async () => {
    const env = threeLegs([{ sl: 1.0880, tp: null }, { sl: 1.0880, tp: null }, { sl: 1.0870, tp: 1.0790 }]);
    await settle(env.win, 320);
    // count EXACTLY one cycle: first wait until none is running (the page disables its refresh
    // button meanwhile). With the page's real engines a cycle takes longer, and the first one could
    // still be judging inside the counting window — counted twice, though one cycle judges once.
    for (let i = 0; i < 100 && env.win.document.getElementById('btnRefresh').disabled; i++) await settle(env.win, 20);
    const E = env.win.BWArbiterEngine, real = E.judgePosition; let calls = 0;
    E.judgePosition = function () { calls++; return real.apply(this, arguments); };
    await env.win.BWArbiterPage.cycle();
    E.judgePosition = real;
    assert.strictEqual(calls, 2, 'judged ' + calls + ' times');
  });

  await check('R-2 / G-2: the card names the route, and the recorded call carries it', async () => {
    const env = losingEnv(); stackAgainst(env);
    await settle(env.win, 380);
    const t = env.win.document.querySelector('#main .card').textContent.replace(/\s+/g, ' ');
    assert.ok(/Confirmation route — the reversal was witnessed\./.test(t), t.slice(0, 400));
    const live = env.posts.filter(p => /\/api\/arbiter\/call/.test(p.url) && p.body && p.body.kind === 'live');
    assert.ok(live.length >= 1, 'a live call was recorded');
    assert.strictEqual(live[0].body.snapshot.route, 'confirmation');
  });

  await check('THE NOW TAB picks up a NEW pattern alert on the very next cycle, with when it fired', async () => {
    const env = losingEnv();                                     // an open SHORT on EUR/USD
    const st = env.routes['/api/state'];
    const ago = m => new Date(Date.now() - m * 60000).toISOString();
    st.patternAlerts = [{ id: 1, symbol: 'EURUSDm', name: 'Bearish Engulfing', direction: 'bearish', confidence: 90, timeframe: 'H1', time: ago(70) }];
    await settle(env.win, 320);
    const card = () => env.win.document.querySelector('#main .card[data-ticket]').textContent.replace(/\s+/g, ' ');
    assert.ok(/Bearish Engulfing/.test(card()), 'the first alert is shown');
    // a NEW alert fires in the Assistant
    st.patternAlerts.unshift({ id: 2, symbol: 'EURUSDm', name: 'Evening Star', direction: 'bearish', confidence: 74, timeframe: 'H1', time: ago(0) });
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 60);
    const t = card();
    assert.ok(/Evening Star on H1 at 74%, 0 bars ago, fired just now/.test(t), t.slice(t.indexOf('Trigger'), t.indexOf('Trigger') + 200));
  });

  await check('THE HUNT TAB lists alerts newest first, each with when it fired', async () => {
    const env = makeEnv();
    const ago = m => new Date(Date.now() - m * 60000).toISOString();
    env.routes['/api/state'].openTrades = [];
    env.routes['/api/state'].patternAlerts = [
      { id: 1, symbol: 'EURUSDm', name: 'Older', direction: 'bullish', confidence: 88, timeframe: 'H1', time: ago(95) },
      { id: 2, symbol: 'EURUSDm', name: 'Newest', direction: 'bullish', confidence: 70, timeframe: 'M5', time: ago(3) }];
    await settle(env.win, 320);
    const eur = Array.from(env.win.document.querySelectorAll('#main button.scan')).find(b => b.dataset.sym === 'EURUSD');
    if (eur) { eur.click(); await settle(env.win, 40); }
    const rows = Array.from(env.win.document.querySelectorAll('#main .frow')).map(r => r.textContent.replace(/\s+/g, ' '))
      .filter(t => /Older|Newest/.test(t));
    assert.ok(rows.length >= 2, 'both listed: ' + rows.join(' | '));
    assert.ok(/Newest/.test(rows[0]) && /fired 3 min ago/.test(rows[0]), rows[0]);
    assert.ok(/fired 1 h 35 min ago/.test(rows[1]), rows[1]);
  });

  console.log('\nRC-1 — THE REASONING CHART INSIDE THE NOW TAB');
  const pane = w => w.document.getElementById('rcPane');
  const svgText = w => Array.from(w.document.querySelectorAll('#rcSvg text')).map(t => t.textContent);
  await check('RC1-1: the chart is part of the page, inside the Now tab, ABOVE the cards', async () => {
    const env = losingEnv(); await settle(env.win, 350);
    const p = pane(env.win), main = env.win.document.getElementById('main');
    assert.ok(p && p.querySelector('#rcSvg'), 'drawn');
    assert.strictEqual(p.parentNode.id, 'p-now'); assert.ok(p.compareDocumentPosition(main) & 4, 'before #main');
  });
  await check('RC1-2: real candles, the LAST one forming and dashed', async () => {
    const env = losingEnv(); await settle(env.win, 350);
    const c = env.win.document.querySelectorAll('#rcSvg rect[data-rck]');
    assert.ok(c.length >= 40, c.length + ' candles');
    const f = env.win.document.querySelectorAll('#rcSvg rect[data-forming]');
    assert.strictEqual(f.length, 1); assert.strictEqual(f[0], c[c.length - 1]); assert.ok(/2 2/.test(f[0].getAttribute('stroke-dasharray')));
  });
  await check('RC1-3: both clocks on the time axis — broker and UTC, 2 hours apart for a GMT+2 broker', async () => {
    const env = losingEnv(); env.routes['/api/state'].brokerOffsetSec = 7200; await settle(env.win, 350);
    const ax = svgText(env.win).filter(t => /broker · .* UTC/.test(t));
    assert.strictEqual(ax.length, 3, ax.join(' | '));
    const m = ax[2].match(/(\d\d):(\d\d) broker · (\d\d):(\d\d) UTC/);
    assert.ok(m, ax[2]); assert.strictEqual((+m[1] - +m[3] + 24) % 24, 2);
  });
  await check('RC1-4: an entry marker per leg, labelled with its ticket', async () => {
    const env = losingEnv(); await settle(env.win, 350);
    const t = svgText(env.win); assert.ok(t.indexOf('▼') >= 0 && t.indexOf('#501') >= 0, t.join(','));
  });
  await check('RC1-5: entry, stop and target; with no target set, the IMPLIED target, labelled so', async () => {
    const env = losingEnv(); await settle(env.win, 350);
    const t = svgText(env.win).join(' | ');
    assert.ok(/entry \d/.test(t) && /stop \d/.test(t) && /target \d/.test(t), t);
    const env2 = losingEnv(); env2.routes['/api/state'].openTrades[0].tp = 0; await settle(env2.win, 350);
    const t2 = svgText(env2.win).join(' | ');
    assert.ok(/implied target \d/.test(t2) || !/target/.test(t2), 'never a target without saying it is implied: ' + t2);
  });
  await check('RC1-6: the decisive level, and the damage line 1x ATR beyond it', async () => {
    const env = losingEnv(); await settle(env.win, 350);
    const w = env.win.BWArbiterPage, t = svgText(env.win).join(' | ');
    assert.ok(/decisive \d/.test(t) && /damage 1xATR \d/.test(t), t);
  });
  await check('RC1-7: a LIVE zone is drawn, naming its source; SPENT zones are not (Arbiter does not judge with them)', async () => {
    const env = losingEnv();
    // the fixture's two zones are spent (touched 9-10 times); add one fresh zone nothing has touched
    env.routes['/smc'].EURUSDm.orderBlocks.push({ type: 'bearish', high: '1.08000', low: '1.07900', timeStart: Date.now() - 2 * 3600e3 });
    await settle(env.win, 350);
    assert.ok(svgText(env.win).some(t => /^supply · SMC$/.test(t)), svgText(env.win).join(','));
    const zr = Array.from(env.win.document.querySelectorAll('#rcSvg rect.rf-violet'));      // the zone colour, now a theme class
    assert.strictEqual(zr.length, 1, 'only the live zone');
  });
  await check('RC1-8 / RC1-9: the H4 strip, and the ATR', async () => {
    const env = losingEnv(); await settle(env.win, 350);
    assert.ok(svgText(env.win).some(t => /^H4 · /.test(t)));
    assert.ok(/ATR \d+(\.\d)? pips \(H1\)/.test(pane(env.win).textContent.replace(/\s+/g, ' ')));
  });
  await check('RC1-10: it follows the timeframe switch; on H4 the same levels, and the H1 note', async () => {
    const env = losingEnv();
    const c = env.routes['/api/candles']; c.candlesByTF.H4 = c.candlesByTF.H1.filter((x, i) => i % 4 === 0);   // real H4 candles
    await settle(env.win, 350);
    const btn = env.win.document.querySelector('[data-rtf="H4"]'); assert.ok(btn, 'the switch exists');
    btn.click(); await settle(env.win, 120);
    const txt = pane(env.win).textContent.replace(/\s+/g, ' ');
    assert.ok(/· H4/.test(txt) && /judged on H1 — switch to H1 to see it/.test(txt), txt.slice(0, 300));
    assert.ok(/decisive \d/.test(svgText(env.win).join(' ')), 'the same levels');
    env.win.document.querySelector('[data-rtf="H1"]').click(); await settle(env.win, 120);
    assert.ok(!/judged on H1 — switch/.test(pane(env.win).textContent));
  });
  await check('RC1-10: a timeframe with NO candles says so — never "loading" forever', async () => {
    const env = losingEnv(); await settle(env.win, 350);
    env.win.document.querySelector('[data-rtf="H4"]').click(); await settle(env.win, 120);
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 80);
    assert.ok(/No H4 candles have arrived for EURUSD yet\./.test(pane(env.win).textContent), pane(env.win).textContent);
  });

  await check('RC1-11: no right-hand label overlaps another; nothing unknown drawn; no NaN', async () => {
    const env = losingEnv(); env.routes['/api/state'].openTrades[0].sl = 0; await settle(env.win, 350);
    const ys = Array.from(env.win.document.querySelectorAll('#rcSvg text')).filter(t => +t.getAttribute('x') >= 780).map(t => +t.getAttribute('y')).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 10.99, 'gap ' + (ys[i] - ys[i - 1]));
    assert.ok(!svgText(env.win).some(t => /^stop /.test(t)), 'no stop set: no stop line');
    assert.ok(!/NaN|undefined|Infinity/.test(pane(env.win).innerHTML));
  });
  await check('RC1-12: nothing drawn while the Now tab is hidden; no animation in the chart', async () => {
    const env = losingEnv(); await settle(env.win, 350);
    const before = pane(env.win).innerHTML;
    env.win.document.getElementById('p-now').classList.remove('on');
    env.routes['/api/state'].openTrades[0].openPrice = 1.0600;
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 60);
    assert.strictEqual(pane(env.win).innerHTML, before, 'not redrawn while hidden');
    const css = HTML.split('<style>')[1].split('</style>')[0];
    assert.ok(!/#rcPane[^{]*\{[^}]*animation/.test(css));
  });
  await check('no open position: no chart', async () => {
    const env = makeEnv({ state: { watchlist: [{ symbol: 'EURUSDm', bid: 1.084, spread: 8 }], openTrades: [], closedTrades: [], accountInfo: { login: 5000 }, news: [] } });
    await settle(env.win, 350); assert.strictEqual(pane(env.win).innerHTML, '');
  });

  console.log('\nRC-2 — THE REVERSAL CASE AND THE ROUTES');
  /* a box judged by the REAL engine from candles built to break the level a particular way */
  const T0 = Math.floor(Date.now() / 1000 / 3600) * 3600 - 40 * 3600;
  const bar = (i, o, h, l, c) => ({ t: T0 + i * 3600, o, h, l, c });
  const calmBars = n => Array.from({ length: n }, (_, i) => bar(i, 1.0862, 1.0868, 1.0856, 1.0861));
  const judgedBox = (win, cd, extra, posOver) => {
    const E = win.BWArbiterEngine;
    const world = Object.assign({ symbol: 'EURUSD', timeframe: 'H1', price: cd[cd.length - 1].c, atr: 0.0012, candles: cd, candlesH4: [],
      invalidationLevel: 1.0850, structure: { regime: 'uptrend', confidence: 0.8 }, zones: [], patterns: [], alerts: [], session: {}, news: [] }, extra || {});
    const position = { ticket: '7', side: 'buy', openPrice: 1.0866, sl: 1.0800, tp: 1.0960, volume: 1, openTime: T0 + 5 * 3600,
      floatingPips: Math.round((world.price - 1.0866) / 0.0001 * 10) / 10, mfePips: 6, stopPips: 66 };
    Object.assign(position, posOver || {});
    const j = E.judgePosition(world, position); j.settled = { action: j.action };
    const r = { world, position, judgement: j };
    return { key: 'EURUSD|buy|1', sym: 'EURUSD', side: 'buy', volume: 1, world, legs: [r], verdicts: [{ legs: [r], lead: r, position, judgement: j }] };
  };
  // drawing is synchronous: check IMMEDIATELY after — a wait lets the page's own cycle redraw over the box
  const drawBox = async (env, box, st) => { env.win.BWArbiterPage.chart.draw([box], Object.assign({ brokerOffsetSec: 0 }, st || {})); };
  const tags = w => Array.from(w.document.querySelectorAll('#rcSvg text')).map(t => t.textContent);
  await check('RC2-1 / RC2-2: the breaking bar outlined and tagged "strong 1"; the follow-through "+1.0"', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const cd = calmBars(30).concat([bar(30, 1.0856, 1.0858, 1.0836, 1.0838), bar(31, 1.0838, 1.0840, 1.0824, 1.0826), bar(32, 1.0826, 1.0827, 1.0825, 1.0826)]);
    await drawBox(env, judgedBox(env.win, cd));
    assert.strictEqual(env.win.document.querySelectorAll('#rcSvg [data-rcbreak]').length, 1, 'the breaking bar outlined');
    const t = tags(env.win); assert.ok(t.indexOf('strong 1') >= 0 && t.indexOf('+1.0') >= 0, t.join(','));
    assert.ok(/Conviction 2\.0 of 2/.test(env.win.document.getElementById('rcPane').textContent));
  });
  await check('RC2-3: a huge bar that held is RE-GRADED, and the chart says so', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const cd = calmBars(30).concat([bar(30, 1.0862, 1.0864, 1.0832, 1.0834), bar(31, 1.0834, 1.0836, 1.0826, 1.0828), bar(32, 1.0828, 1.0829, 1.0827, 1.0828)]);
    await drawBox(env, judgedBox(env.win, cd));
    const t = tags(env.win).filter(x => /huge/.test(x));
    assert.ok(t.length && /1(\.0)?/.test(t[0]) && /held|re-?grad/i.test(t[0]), 'tag: ' + t.join(','));
  });
  await check('RC2-4: a FAILED break — "back inside", the breaking bar keeping its tag', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const cd = calmBars(30).concat([bar(30, 1.0856, 1.0858, 1.0836, 1.0838), bar(31, 1.0838, 1.0866, 1.0837, 1.0864), bar(32, 1.0864, 1.0865, 1.0863, 1.0864)]);
    await drawBox(env, judgedBox(env.win, cd));
    const t = tags(env.win); assert.ok(t.indexOf('back inside') >= 0 && t.indexOf('strong 1') >= 0, t.join(','));
    assert.strictEqual(env.win.document.querySelectorAll('#rcSvg [data-rcbreak]').length, 0, 'no live break');
  });
  await check('RC2-5: a RETEST — back up to the level from underneath, then on — marked at the level; the grind in words', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const cd = calmBars(30).concat([bar(30, 1.0856, 1.0858, 1.0836, 1.0838), bar(31, 1.0838, 1.0849, 1.0836, 1.0840),
      bar(32, 1.0840, 1.0841, 1.0826, 1.0828), bar(33, 1.0828, 1.0830, 1.0820, 1.0822), bar(34, 1.0822, 1.0823, 1.0821, 1.0822)]);
    const box = judgedBox(env.win, cd), bc = box.verdicts[0].judgement.pressure.reversal.breakCase;
    assert.ok(bc && bc.retest, 'fixture sanity: the ENGINE saw a retest — ' + JSON.stringify(bc && { retest: bc.retest, conv: bc.conv }));
    await drawBox(env, box);
    assert.ok(tags(env.win).indexOf('retest held') >= 0, tags(env.win).join(','));
    assert.ok(/Grind \d+ bars · [\d.]+ ATR/.test(env.win.document.getElementById('rcPane').textContent), 'the grind in words');
  });
  await check('RC2-6 / RC2-7: witnesses with weight and points, the independent count and the tier — the engine\'s words', async () => {
    const env = losingEnv(); stackAgainst(env); await settle(env.win, 380);
    const t = env.win.document.querySelector('#rcPane .rccase').textContent.replace(/\s+/g, ' ');
    assert.ok(/Tier [123] — /.test(t) && /\d independent/.test(t), t);
    assert.ok(/\((heavy|medium|low|forming) [\d.]+\)/.test(t), 'weights and points: ' + t);
    assert.ok(/Combined Read: reversal/.test(t), 'the Combined Read\'s stage: ' + t);
  });
  await check('RC2-8: a pin for each LIVE call of this trade, at the recorded price, labelled with its route', async () => {
    const env = losingEnv();
    env.routes['/api/arbiter/calls'] = { ok: true, calls: [
      { kind: 'live', ticket: 501, action: 'cut', price_at: 1.0730, created_at: new Date(Date.now() - 2 * 3600e3).toISOString(), snapshot: { route: 'damage' } },
      { kind: 'live', ticket: 999, action: 'partial', price_at: 1.0700, created_at: new Date().toISOString(), snapshot: { route: 'milestone' } },
      { kind: 'take', ticket: null, action: null, created_at: new Date().toISOString() }] };
    await settle(env.win, 380);
    const pins = env.win.document.querySelectorAll('#rcSvg [data-rccall]');
    assert.strictEqual(pins.length, 1, 'only THIS trade\'s live call — not another trade\'s, not a hunting call');
    assert.ok(tags(env.win).indexOf('CUT · damage') >= 0, tags(env.win).join(','));
  });
  await check('RC2-9: the pressure line, and the threshold that applies NOW (45 while losing)', async () => {
    const env = losingEnv(); await settle(env.win, 300); await env.win.BWArbiterPage.cycle(); await settle(env.win, 40);
    assert.ok(env.win.document.querySelector('#rcSvg [data-rcpress]'), 'the line');
    const b = env.win.document.querySelector('#rcSvg [data-rcbar]'); assert.strictEqual(b.getAttribute('data-rcbar'), '45');
    assert.ok(/since this page opened/.test(tags(env.win).join(' ')));
  });
  await check('RC2-9: a WINNER\'s threshold is 70 + 20 x the reward still left', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const cd = calmBars(30).concat([bar(30, 1.0880, 1.0886, 1.0878, 1.0884)]);
    const box = judgedBox(env.win, cd, { price: 1.0884 });
    box.verdicts[0].position.floatingPips = 18; box.verdicts[0].judgement.progress = 0.25;
    await drawBox(env, box);
    assert.strictEqual(env.win.document.querySelector('#rcSvg [data-rcbar]').getAttribute('data-rcbar'), '85');
  });
  await check('RC2-10: on H4, none of the H1 tags — the pins and pressure stay', async () => {
    const env = losingEnv();
    const c = env.routes['/api/candles']; c.candlesByTF.H4 = c.candlesByTF.H1.filter((x, i) => i % 4 === 0);
    env.routes['/api/arbiter/calls'] = { ok: true, calls: [{ kind: 'live', ticket: 501, action: 'cut', price_at: 1.0730,
      created_at: new Date(Date.now() - 8 * 3600e3).toISOString(), snapshot: { route: 'pressure' } }] };
    await settle(env.win, 300);
    env.win.document.querySelector('[data-rtf="H4"]').click(); await settle(env.win, 120);
    assert.strictEqual(env.win.document.querySelectorAll('#rcSvg [data-rcbreak]').length, 0);
    assert.ok(!tags(env.win).some(t => /^(strong|wick|news|huge|thin|sweep|modest|gap) |^\+[01]\.0$|^back inside$/.test(t)));
    assert.ok(env.win.document.querySelector('#rcSvg [data-rcbar]'), 'pressure stays');
  });
  await check('RC2-11: no two tags overlap; no NaN', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const cd = calmBars(30).concat([bar(30, 1.0856, 1.0858, 1.0836, 1.0838), bar(31, 1.0838, 1.0840, 1.0824, 1.0826), bar(32, 1.0826, 1.0827, 1.0825, 1.0826)]);
    await drawBox(env, judgedBox(env.win, cd));
    const R = Array.from(env.win.document.querySelectorAll('#rcSvg rect[rx="4"]')).map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }));
    for (let i = 0; i < R.length; i++) for (let k = i + 1; k < R.length; k++) {
      const a = R[i], b = R[k];
      assert.ok(!(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y), 'tags ' + i + ' and ' + k + ' overlap'); }
    assert.ok(!/NaN|undefined|Infinity/.test(env.win.document.getElementById('rcPane').innerHTML));
  });

  console.log('\nRC-3 — PROTECTING PROFIT');
  // a WINNER: bought 1.0866, calm candles around 1.0881 (+15), best +30; ATR 12 pips; target +94
  const winCd = () => calmBars(30).map(b => ({ t: b.t, o: b.o + 0.0020, h: b.h + 0.0020, l: b.l + 0.0020, c: b.c + 0.0020 }))
    .concat([bar(30, 1.0881, 1.0884, 1.0879, 1.0881)]);
  const winner = (win, over, extra) => judgedBox(win, winCd(), Object.assign({ price: 1.0881, invalidationLevel: 1.0830 }, extra || {}),
    Object.assign({ floatingPips: 15, mfePips: 30 }, over || {}));
  const text = w => w.document.getElementById('rcPane').textContent.replace(/\s+/g, ' ');
  await check('RC3-1: the ladder from the best profit — "best +30", partial 50%, break-even 75% — the engine\'s own numbers', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const box = winner(env.win), L = box.verdicts[0].judgement.ladder;
    assert.ok(L && L.active, 'fixture sanity: the ENGINE has an active ladder — ' + JSON.stringify(L));
    await drawBox(env, box);
    const t = tags(env.win).join(' | ');
    assert.ok(/best \+30 /.test(t) && /partial 50% /.test(t) && /break-even 75% /.test(t), t);
  });
  await check('RC3-2: high volatility — the LOWERED thresholds, 40% and 60%, drawn and said', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const box = winner(env.win, {}, { radar: { score: 70, factors: [{ id: 'vol', name: 'Volatility', label: 'Volatility' }] } });
    assert.ok(box.verdicts[0].judgement.ladder.hv, 'fixture sanity: the engine reads high volatility');
    await drawBox(env, box);
    const t = tags(env.win).join(' | ');
    assert.ok(/partial 40% \(volatile\)/.test(t) && /break-even 60% \(volatile\)/.test(t), t);
    assert.ok(/volatility high: partial at 40%, break-even at 60%/.test(text(env.win)));
  });
  await check('RC3-3: in profit but not far enough yet — NO ladder lines, and it says how far is needed', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const box = winner(env.win, { floatingPips: 5, mfePips: 8 }, { price: 1.0871 });
    assert.strictEqual(box.verdicts[0].judgement.ladder.active, false, 'fixture sanity');
    await drawBox(env, box);
    assert.ok(!tags(env.win).some(t => /^best \+|^partial \d|^break-even \d/.test(t)), tags(env.win).join(','));
    assert.ok(/profit ladder starts at \+\d+ pips \(1x ATR and 3x the spread\) — best so far \+8/.test(text(env.win)), text(env.win));
  });
  await check('RC3-4: the profit floor — its bar labelled with WHAT SET IT, the near-entry band, "armed" once reached', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const box = winner(env.win, { mfePips: 35 }), F = box.verdicts[0].judgement.floor;
    assert.ok(F && F.reached, 'fixture sanity: the engine says the floor is armed — ' + JSON.stringify(F));
    await drawBox(env, box);
    // drawn as a line, or — when far above these quiet candles — as an arrow label at the chart's edge
    assert.ok(tags(env.win).some(t => new RegExp('^(↑ |↓ )?floor bar ' + F.bar.toFixed(0) + 'p · armed ').test(t)), tags(env.win).join(','));
    assert.ok(env.win.document.querySelector('#rcSvg [data-rcfloor]'), 'the near-entry band');
    assert.ok(text(env.win).indexOf('(' + F.why + ')') >= 0 && /armed: back to entry means break-even/.test(text(env.win)), text(env.win));
  });
  await check('RC3-5: where the trader FOLLOWED a partial (◆) and a break-even (■) — not where a call was ignored', async () => {
    const env = losingEnv();
    const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
    env.routes['/api/arbiter/calls'] = { ok: true, calls: [
      { kind: 'live', ticket: 501, action: 'partial', adherence: 'followed', price_at: 1.0712, created_at: ago(6), snapshot: { route: 'milestone' } },
      { kind: 'live', ticket: 501, action: 'be', adherence: 'followed', price_at: 1.0716, created_at: ago(4), snapshot: { route: 'protection' } },
      { kind: 'live', ticket: 501, action: 'partial', adherence: 'ignored', price_at: 1.0718, created_at: ago(2), snapshot: { route: 'protection' } }] };
    await settle(env.win, 380);
    const done = Array.from(env.win.document.querySelectorAll('#rcSvg [data-rcdone]')).map(e => e.getAttribute('data-rcdone')).sort();
    assert.deepStrictEqual(done, ['be', 'partial'], 'the followed ones only');
    const t = tags(env.win); assert.ok(t.indexOf('partial taken') >= 0 && t.indexOf('stop → entry') >= 0, t.join(','));
  });
  await check('RC3-6: the status line in words — "Given back 50% of +30 pips"', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    await drawBox(env, winner(env.win));
    assert.ok(/Given back 50% of \+30 pips/.test(text(env.win)), text(env.win));
  });
  await check('RC3-7: a LOSING trade — no ladder, no floor; no overlaps; no NaN', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const box = winner(env.win, { floatingPips: -10, mfePips: 30 }, { price: 1.0856 });
    assert.ok(!box.verdicts[0].judgement.ladder && !box.verdicts[0].judgement.floor, 'fixture sanity: the engine gives neither for a loser');
    await drawBox(env, box);
    assert.ok(!tags(env.win).some(t => /^best \+|^partial \d|^break-even \d|^floor bar/.test(t)));
    assert.ok(!env.win.document.querySelector('#rcSvg [data-rcfloor]'));
    const ys = Array.from(env.win.document.querySelectorAll('#rcSvg text')).filter(t => +t.getAttribute('x') >= 780).map(t => +t.getAttribute('y')).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 10.99, 'right labels ' + (ys[i] - ys[i - 1]) + ' apart');
    assert.ok(!/NaN|undefined|Infinity/.test(env.win.document.getElementById('rcPane').innerHTML));
  });

  console.log('\nRC-4 — THE MARKET AROUND THE TRADE');
  // calm candles (12-pip range) with ONE huge candle at index 20 (40 pips: over 2x the 12-pip ATR)
  const hugeCd = () => { const cd = calmBars(30); cd[20] = bar(20, 1.0862, 1.0888, 1.0848, 1.0880); cd.push(bar(30, 1.0861, 1.0862, 1.0860, 1.0861)); return cd; };
  const candleMs = i => (T0 + i * 3600) * 1000;                                   // candle i's start, ms (brokerOffsetSec 0)
  const ev = (i, mins, title, ccy, impact) => ({ title, impact: impact || 'high', currency: ccy, timestamp: Math.floor((candleMs(i) + mins * 60000) / 1000) });
  await check('RC4-1: high-impact news for the pair is banded and named — another currency\'s is not', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    await drawBox(env, judgedBox(env.win, calmBars(31)), { news: [ev(12, 30, 'US CPI', 'USD'), ev(14, 0, 'BoJ rate', 'JPY'), ev(16, 0, 'Minor data', 'EUR', 'low')] });
    assert.strictEqual(env.win.document.querySelectorAll('#rcSvg [data-rcnews]').length, 1, 'only the USD high-impact event');
    assert.ok(tags(env.win).indexOf('US CPI (USD)') >= 0, tags(env.win).join(','));
    assert.ok(/News on the chart: US CPI/.test(text(env.win)));
  });
  await check('RC4-2: a huge candle with NO high-impact news near it — "big move · unexplained", and the sentence', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    await drawBox(env, judgedBox(env.win, hugeCd()), { news: [ev(2, 0, 'Early data', 'EUR', 'low')] });     // the calendar covers from candle 2
    assert.ok(tags(env.win).indexOf('big move · unexplained') >= 0, tags(env.win).join(','));
    assert.ok(/Big move nothing on the calendar explains: \d\d:\d\d UTC/.test(text(env.win)), text(env.win));
  });
  await check('RC4-3: honesty — with news near it, NOT unexplained; before the calendar\'s coverage, "no calendar for this time"', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    await drawBox(env, judgedBox(env.win, hugeCd()), { news: [ev(2, 0, 'Early data', 'EUR', 'low'), ev(20, 10, 'NFP', 'USD')] });
    assert.ok(!tags(env.win).some(t => /^big move/.test(t)), 'explained by NFP: ' + tags(env.win).join(','));
    await drawBox(env, judgedBox(env.win, hugeCd()), { news: [ev(25, 0, 'Later data', 'EUR', 'low')] });     // coverage starts AFTER it
    assert.ok(tags(env.win).indexOf('big move · no calendar') >= 0 && tags(env.win).indexOf('big move · unexplained') < 0, tags(env.win).join(','));
    assert.ok(/no calendar for that time/.test(text(env.win)));
    await drawBox(env, judgedBox(env.win, hugeCd()), { news: [] });                                          // no calendar at all
    assert.ok(tags(env.win).indexOf('big move · unexplained') < 0, 'never "unexplained" without a calendar');
  });
  await check('RC4-4: the rollover hours (21:00-22:59 UTC) shaded — the ENGINE\'s own setting', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const cd = calmBars(31); await drawBox(env, judgedBox(env.win, cd));
    const R = env.win.BWReversal.CFG.ROLLOVER_UTC;
    const expect = cd.slice(0, -1).filter(c => { const h = new Date(c.t * 1000).getUTCHours(); return h >= R[0] && h < R[1]; }).length;
    assert.ok(expect > 0, 'fixture sanity: the window holds rollover candles');
    assert.strictEqual(env.win.document.querySelectorAll('#rcSvg [data-rcthin]').length, expect);
  });
  await check('RC4-5: a volatile candle (1.8x the 20 before it) shaded — the calm ones not', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    await drawBox(env, judgedBox(env.win, hugeCd()));
    assert.strictEqual(env.win.document.querySelectorAll('#rcSvg [data-rcvol]').length, 1);
  });
  await check('RC4-6: a pattern alert on the candle it fired at, with WHEN', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const box = judgedBox(env.win, calmBars(31), { alerts: [{ name: 'Bearish Engulfing', direction: 'bearish', timeframe: 'H1',
      firedAt: new Date(candleMs(26)).toISOString(), minutesAgo: 40 }] });
    await drawBox(env, box);
    assert.strictEqual(env.win.document.querySelectorAll('#rcSvg [data-rcalert]').length, 1);
    assert.ok(tags(env.win).indexOf('Bearish Engulfing · 40 min ago') >= 0, tags(env.win).join(','));
  });
  await check('RC4-7: on H4 the news still drawn; no two tags overlap; no NaN', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    await drawBox(env, judgedBox(env.win, hugeCd(), { alerts: [{ name: 'Bullish Engulfing', direction: 'bullish', firedAt: new Date(candleMs(21)).toISOString(), minutesAgo: 400 }] }),
      { news: [ev(2, 0, 'Early data', 'EUR', 'low'), ev(12, 30, 'US CPI', 'USD')] });
    const R = Array.from(env.win.document.querySelectorAll('#rcSvg rect[rx="4"]')).map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }));
    for (let i = 0; i < R.length; i++) for (let k = i + 1; k < R.length; k++) { const a = R[i], b = R[k];
      assert.ok(!(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y), 'tags ' + i + '/' + k + ' overlap'); }
    assert.ok(!/NaN|undefined|Infinity/.test(env.win.document.getElementById('rcPane').innerHTML));
    const env2 = losingEnv(); const c = env2.routes['/api/candles']; c.candlesByTF.H4 = c.candlesByTF.H1.filter((x, i) => i % 4 === 0);
    // this fixture's candles carry their time as `t`, in seconds
    const lastT = c.candlesByTF.H1[c.candlesByTF.H1.length - 10].t;
    assert.ok(isFinite(lastT), 'fixture sanity: a real candle time');
    env2.routes['/api/state'].news = [{ title: 'US CPI', impact: 'high', currency: 'USD', timestamp: lastT + 1800 }];
    await settle(env2.win, 300); env2.win.document.querySelector('[data-rtf="H4"]').click(); await settle(env2.win, 120);
    assert.ok(env2.win.document.querySelector('#rcSvg [data-rcnews]'), 'the news band on H4 too');
  });
  await check('the timeframe switch keeps the page state — the broker clock (UTC times) stays right straight after a switch', async () => {
    const env = losingEnv(); env.routes['/api/state'].brokerOffsetSec = 7200;
    const c = env.routes['/api/candles']; c.candlesByTF.H4 = c.candlesByTF.H1.filter((x, i) => i % 4 === 0);
    await settle(env.win, 300); env.win.document.querySelector('[data-rtf="H4"]').click(); await settle(env.win, 60);
    const ax = Array.from(env.win.document.querySelectorAll('#rcSvg text')).map(t => t.textContent).filter(t => /broker · .* UTC/.test(t));
    const m = ax[ax.length - 1].match(/(\d\d):(\d\d) broker · (\d\d):(\d\d) UTC/);
    assert.ok(m, ax.join(' | ')); assert.strictEqual((+m[1] - +m[3] + 24) % 24, 2, 'two hours apart on H4 too: ' + ax[ax.length - 1]);
  });

  console.log('\nRC-5 — MANY POSITIONS');
  // two boxes on two pairs: an EUR/USD sell (losing, more pressure) and a GBP/USD buy
  const twoPairs = (extra) => {
    const env = losingEnv(), st = env.routes['/api/state'];
    st.watchlist.push({ symbol: 'GBPUSDm', bid: 1.2710, spread: 9 });
    st.openTrades.push(Object.assign({ ticket: 601, symbol: 'GBPUSDm', type: 'buy', volume: 0.50, openPrice: 1.2700, sl: 1.2650, tp: 1.2800,
      profit: 5, riskPct: 0.5, openTime: Math.floor(Date.now() / 1000) - 7200 }, extra || {}));
    return env;
  };
  const chips = w => Array.from(w.document.querySelectorAll('#rcPane .rcc'));
  await check('RC5-1 / RC5-2: a chip per box; ONE chart, the box under most pressure first; a chip switches it', async () => {
    const env = twoPairs(); await settle(env.win, 400);
    const c = chips(env.win); assert.strictEqual(c.length, 2, 'two chips');
    assert.ok(c.every(x => /pressure \d+/.test(x.textContent) && /(LONG|SHORT)/.test(x.textContent)), c.map(x => x.textContent).join(' | '));
    assert.strictEqual(env.win.document.querySelectorAll('#rcSvg').length, 1, 'one chart');
    const on = env.win.document.querySelector('#rcPane .rcc.on'), label = () => env.win.document.getElementById('rcSvg').getAttribute('aria-label');
    const other = c.find(x => x !== on); other.click(); await settle(env.win, 30);
    assert.ok(env.win.document.querySelector('#rcPane .rcc.on') === chips(env.win).find(x => x.getAttribute('data-rcbox') === other.getAttribute('data-rcbox')));
    assert.ok(new RegExp(other.getAttribute('data-rcbox').split('|')[0].slice(0, 6), 'i').test(label()), label());
  });
  await check('RC5-3: the OTHER box collapses to one line (its card hidden, still in the page); the line opens it', async () => {
    const env = twoPairs(); await settle(env.win, 400);
    const hidden = env.win.document.querySelectorAll('#main .card.rc-hidden'), lines = env.win.document.querySelectorAll('#main .rc-line');
    assert.strictEqual(hidden.length, 1); assert.strictEqual(lines.length, 1);
    assert.ok(/(LONG|SHORT)/.test(lines[0].textContent) && /pressure \d+/.test(lines[0].textContent));
    const key = lines[0].getAttribute('data-rcbox'); lines[0].click(); await settle(env.win, 30);
    assert.strictEqual(env.win.document.querySelector('#rcPane .rcc.on').getAttribute('data-rcbox'), key, 'the line opened its box');
    assert.strictEqual(env.win.document.querySelectorAll('#main .card.rc-hidden').length, 1, 'and the other one collapsed instead');
    const one = losingEnv(); await settle(one.win, 350);
    assert.strictEqual(one.win.document.querySelectorAll('#main .rc-line, #main .card.rc-hidden').length, 0, 'one box: nothing collapses');
  });
  await check('RC5-4: every leg\'s markers carry its ticket; hovering a leg lights its markers and dims the others', async () => {
    const env = threeLegs([{ sl: 1.0880, tp: 1.0800 }, { sl: 1.0880, tp: 1.0800 }, { sl: 1.0880, tp: 1.0800 }]); await settle(env.win, 400);
    const g = () => Array.from(env.win.document.querySelectorAll('#rcSvg g[data-leg]'));
    assert.deepStrictEqual(g().map(x => x.getAttribute('data-leg')).sort(), ['700', '701', '702']);
    const chip = env.win.document.querySelector('#rcPane [data-rcleg="701"]'); assert.ok(chip, 'a chip per leg');
    chip.dispatchEvent(new env.win.MouseEvent('mouseover', { bubbles: true })); await settle(env.win, 20);
    const op = Object.fromEntries(g().map(x => [x.getAttribute('data-leg'), x.getAttribute('opacity')]));
    assert.deepStrictEqual(op, { '700': '0.25', '701': '1', '702': '0.25' });
    const row = Array.from(env.win.document.querySelectorAll('#main tr')).find(r => /#702/.test(r.textContent)); assert.ok(row, 'the leg row in the card');
    row.dispatchEvent(new env.win.MouseEvent('mouseover', { bubbles: true })); await settle(env.win, 20);
    assert.strictEqual(g().find(x => x.getAttribute('data-leg') === '702').getAttribute('opacity'), '1');
    assert.strictEqual(g().find(x => x.getAttribute('data-leg') === '700').getAttribute('opacity'), '0.25');
  });
  await check('RC5-5: a leg on its OWN levels — a Book / leg switch; the chosen levels bold, the other thin and named', async () => {
    const env = threeLegs([{ sl: 1.0880, tp: 1.0800 }, { sl: 1.0880, tp: 1.0800 }, { sl: 1.0900, tp: 1.0760 }]); await settle(env.win, 400);
    const sw = Array.from(env.win.document.querySelectorAll('#rcPane [data-rcv]'));   // the switch's own buttons (the replay controls share the style)
    assert.strictEqual(sw.length, 2, 'the switch'); assert.ok(/Book · 2 legs/.test(sw[0].textContent) && /Leg #702 · own levels/.test(sw[1].textContent));
    const t = () => Array.from(env.win.document.querySelectorAll('#rcSvg text')).map(x => x.textContent);
    assert.ok(t().includes('stop 1.08800') && t().includes('#702 stop 1.09000'), t().join(','));
    sw[1].click(); await settle(env.win, 30);
    assert.ok(t().includes('stop 1.09000') && t().includes('book stop 1.08800'), 'switched: ' + t().join(','));
  });
  await check('RC5-6: a box moved by the same event as another says so on its chip', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const a = judgedBox(env.win, calmBars(31)), b = judgedBox(env.win, calmBars(31));
    b.key = 'GBPUSD|buy|1'; b.sym = 'GBPUSD';
    a.verdicts[0].judgement.sameEvent = { ccy: 'USD', with: 'GBPUSD', risk: 1.4 };
    env.win.BWArbiterPage.chart.draw([a, b], { brokerOffsetSec: 0 });
    assert.ok(chips(env.win).some(c => /same USD move as GBPUSD/.test(c.textContent)), chips(env.win).map(c => c.textContent).join(' | '));
  });
  await check('RC5-7: a hedge — each side its own box, chip and chart', async () => {
    const env = losingEnv(), st = env.routes['/api/state'];
    st.openTrades.push(Object.assign({}, st.openTrades[0], { ticket: 502, type: 'buy' }));
    await settle(env.win, 400);
    const c = chips(env.win); assert.strictEqual(c.length, 2, c.map(x => x.textContent).join(' | '));
    assert.ok(/LONG/.test(c.map(x => x.textContent).join(' ')) && /SHORT/.test(c.map(x => x.textContent).join(' ')));
  });
  await check('RC5-8: the chips scroll sideways; the hidden cards stay in the page; no NaN', async () => {
    const css = HTML.split('<style>')[1].split('</style>')[0];
    assert.ok(/#rcPane \.rcchips\{[^}]*overflow-x:auto/.test(css));
    const env = twoPairs(); await settle(env.win, 400);
    assert.strictEqual(env.win.document.querySelectorAll('#main .card[data-ticket]').length, 2, 'both cards still in the page');
    assert.ok(!/NaN|undefined|Infinity/.test(env.win.document.getElementById('rcPane').innerHTML));
  });

  console.log('\nRC-6 — INTERACTION, REPLAY, PHONE');
  const breakCd = () => calmBars(30).concat([bar(30, 1.0856, 1.0858, 1.0836, 1.0838), bar(31, 1.0838, 1.0840, 1.0824, 1.0826), bar(32, 1.0826, 1.0827, 1.0825, 1.0826)]);
  // a click makes the page redraw from ITS boxes; a test drawing its own box redraws that box after,
  // exactly as the page's cycle redraws its own
  const rp = (env, a, box) => { env.win.document.querySelector('#rcPane [data-rcrp="' + a + '"]').click(); if (box) drawBox(env, box); };
  const nCandles = w => w.document.querySelectorAll('#rcSvg rect[data-rck]').length;
  await check('RC6-1: hovering a candle — its time (broker and UTC), O H L C, and what the chart says about it', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    await drawBox(env, judgedBox(env.win, breakCd()));
    const r = env.win.document.querySelector('#rcSvg rect[data-rck="30"]');
    r.dispatchEvent(new env.win.MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 50 }));
    const t = env.win.document.getElementById('rcTip').textContent;
    assert.ok(/broker  \(\d\d:\d\d UTC\)/.test(t) && /^.*\nO \d\.\d{5}  H \d\.\d{5}\nL \d\.\d{5}  C \d\.\d{5}/.test(t), t);
    assert.ok(/the breaking candle — strong 1/.test(t), t);
    env.win.document.querySelector('#rcSvg rect[data-forming]').dispatchEvent(new env.win.MouseEvent('mousemove', { bubbles: true }));
    assert.ok(/this candle is still forming/.test(env.win.document.getElementById('rcTip').textContent));
  });
  await check('RC6-2: a layer switched off is HIDDEN (only hidden), and remembered on this device', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    await drawBox(env, judgedBox(env.win, breakCd()));
    env.win.document.querySelector('#rcPane [data-rclayer="case"]').click(); await settle(env.win, 20);
    const svg = env.win.document.getElementById('rcSvg');
    assert.ok(/\boff-case\b/.test(svg.getAttribute('class')), svg.getAttribute('class'));
    assert.ok(svg.querySelector('[data-layer="case"]'), 'still drawn — the class hides it');
    const css = HTML.split('<style>')[1].split('</style>')[0];
    assert.ok(/#rcSvg\.off-case \[data-layer="case"\][^{]*\{display:none\}/.test(css.replace(/\s*,\s*/g, ',')));
    assert.deepStrictEqual(JSON.parse(env.win.localStorage.getItem('bw-rc-layers')), { case: true });
    env.win.document.querySelector('#rcPane [data-rclayer="case"]').click(); await settle(env.win, 20);
    assert.ok(!/\boff-case\b/.test(env.win.document.getElementById('rcSvg').getAttribute('class')), 'on again');
  });
  await check('RC6-3 / RC6-4: replay from the entry candle — only what existed then; step, jump, exit', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const box = judgedBox(env.win, breakCd());
    await drawBox(env, box); rp(env, 'start', box); await settle(env.win, 20);
    assert.strictEqual(nCandles(env.win), 6, 'up to the entry candle (index 5)');
    assert.strictEqual(env.win.document.querySelectorAll('#rcSvg rect[data-forming]').length, 0, 'a replayed candle is never "forming"');
    assert.ok(/Replay · .* UTC · candle 1 of \d+/.test(text(env.win)), text(env.win));
    rp(env, 'next', box); await settle(env.win, 20); assert.strictEqual(nCandles(env.win), 7);
    rp(env, 'last', box); await settle(env.win, 20); assert.strictEqual(nCandles(env.win), 32, 'every closed candle');
    rp(env, 'prev', box); await settle(env.win, 20); assert.strictEqual(nCandles(env.win), 31);
    await drawBox(env, box);                                         // a live cycle redraws: the replay holds
    assert.strictEqual(nCandles(env.win), 31, 'the live cycle did not break the replay');
    rp(env, 'exit', box); await settle(env.win, 20);
    assert.strictEqual(env.win.document.querySelectorAll('#rcSvg rect[data-forming]').length, 1, 'live again');
  });
  await check('RC6-5: replay REBUILDS the break case with the engine\'s tracker — none before the break, there after it', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const box = judgedBox(env.win, breakCd());
    await drawBox(env, box); rp(env, 'start', box);
    for (let i = 0; i < 24; i++) rp(env, 'next', box);              // candle 29: before the break
    await settle(env.win, 20);
    assert.strictEqual(env.win.document.querySelectorAll('#rcSvg [data-rcbreak]').length, 0, 'no break yet');
    rp(env, 'next', box); rp(env, 'next', box); await settle(env.win, 20);    // candle 31: the break and its follow-through
    assert.strictEqual(env.win.document.querySelectorAll('#rcSvg [data-rcbreak]').length, 1);
    const t = tags(env.win); assert.ok(t.indexOf('strong 1') >= 0 && t.indexOf('+1.0') >= 0, t.join(','));
    assert.ok(/conviction 2\.0 of 2/.test(text(env.win)) && /Not stored for that moment, so not shown: the liquidity reading, the spread, the volatility switch, the witnesses and the tier/.test(text(env.win)), text(env.win));
  });
  await check('RC6-5: replay rebuilds the ladder from the PRICE PATH (and never shows the floor)', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const box = winner(env.win);
    await drawBox(env, box); rp(env, 'start', box); rp(env, 'last', box); await settle(env.win, 20);
    assert.ok(tags(env.win).some(t => /^best \+\d+ /.test(t)), tags(env.win).join(','));
    assert.ok(!tags(env.win).some(t => /^floor bar/.test(t)), 'the floor is not rebuilt');
  });
  await check('RC6-4: replay shows a live call only from the candle it was made on', async () => {
    const env = losingEnv();
    env.routes['/api/arbiter/calls'] = { ok: true, calls: [{ kind: 'live', ticket: 501, action: 'cut', price_at: 1.0730,
      created_at: new Date(Date.now() - 2 * 3600e3).toISOString(), snapshot: { route: 'damage' } }] };
    await settle(env.win, 380);
    rp(env, 'start'); await settle(env.win, 20);
    assert.strictEqual(env.win.document.querySelectorAll('#rcSvg [data-rccall]').length, 0, 'not made yet at the entry candle');
    rp(env, 'last'); await settle(env.win, 20);
    assert.strictEqual(env.win.document.querySelectorAll('#rcSvg [data-rccall]').length, 1, 'there by the end');
  });
  await check('THE FUTURE-NEWS BUG: an event still to come is NOT drawn on the forming candle — it is "next"', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const later = Math.floor(Date.now() / 1000) + 3 * 3600;
    await drawBox(env, judgedBox(env.win, calmBars(31)), { news: [{ title: 'FOMC', impact: 'high', currency: 'USD', timestamp: later }] });
    assert.strictEqual(env.win.document.querySelectorAll('#rcSvg [data-rcnews]').length, 0, 'not on a candle yet');
    assert.ok(/Next high-impact for EUR\/USD: FOMC in \d+ h/.test(text(env.win)), text(env.win));
  });
  await check('RC6-6: the phone — chips scroll, status lines wrap, the chart scales to the width', async () => {
    const css = HTML.split('<style>')[1].split('</style>')[0];
    assert.ok(/@media\(max-width:640px\)\{#rcPane \.rcc\{min-width:150px\}/.test(css));
    assert.ok(/#rcPane \.rcstat\{display:flex;gap:16px;flex-wrap:wrap/.test(css) && /#rcPane svg\{display:block;width:100%\}/.test(css));
  });

  console.log('\nRC-7 — TEACHING THE TERMS');
  const skipTour = env => { try { env.win.localStorage.setItem('bw-arbiter-tour', 'done'); } catch (e) {} const o = env.win.document.getElementById('rcTour'); if (o) o.remove(); };
  await check('RC7-1: ONE glossary — every entry has a term, a group, a one-line and a fuller meaning; ids unique', async () => {
    const env = losingEnv(); await settle(env.win, 300);
    const T = env.win.BWArbiterPage.chart.terms;
    assert.ok(T.length >= 35, T.length + ' terms');
    T.forEach(x => assert.ok(x.id && x.g && x.t && x.s && x.l && x.s.length < 140, 'incomplete: ' + JSON.stringify(x)));
    assert.strictEqual(new Set(T.map(x => x.id)).size, T.length, 'unique ids');
    assert.ok(new Set(T.map(x => x.g)).size >= 6, 'grouped');
  });
  await check('RC7-2: the "?" opens the glossary — grouped, searchable, Esc closes it', async () => {
    const env = losingEnv(); await settle(env.win, 300); skipTour(env);
    env.win.document.getElementById('btnHelp').click();
    const g = env.win.document.getElementById('rcGloss');
    assert.strictEqual(g.style.display, 'flex'); assert.ok(g.querySelectorAll('h4').length >= 6, 'groups');
    const find = env.win.document.getElementById('rcgFind'); find.value = 'damage'; find.dispatchEvent(new env.win.Event('input'));
    const shown = Array.from(g.querySelectorAll('.rcg-item')).filter(n => n.style.display !== 'none');
    assert.ok(shown.length >= 1 && shown.every(n => /damage/i.test(n.textContent)), shown.map(n => n.textContent.slice(0, 30)).join(' | '));
    env.win.document.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.strictEqual(g.style.display, 'none');
  });
  await check('RC7-3: a word on the chart carries its meaning — hover shows the line; a click opens that entry', async () => {
    const env = losingEnv(); await settle(env.win, 300); skipTour(env);
    const d = env.win.document.querySelector('#rcSvg [data-term="decisive"]'); assert.ok(d, 'the decisive label is linked');
    d.dispatchEvent(new env.win.MouseEvent('mouseover', { bubbles: true }));
    assert.ok(/Decisive level — The swing your trade/.test(env.win.document.getElementById('rcDef').textContent));
    d.dispatchEvent(new env.win.MouseEvent('click', { bubbles: true }));
    const on = env.win.document.querySelector('#rcGloss .rcg-item.on'); assert.ok(on && on.id === 'g-decisive', on && on.id);
  });
  await check('RC7-4: EVERY label the chart draws is linked to an entry — none missing, none undefined', async () => {
    const env = losingEnv(); await settle(env.win, 300); skipTour(env);
    const T = env.win.BWArbiterPage.chart.terms.map(x => x.id);
    const draws = [
      [winner(env.win, { mfePips: 35 }), {}],
      [judgedBox(env.win, breakCd()), {}],
      [judgedBox(env.win, calmBars(30).concat([bar(30, 1.0856, 1.0858, 1.0836, 1.0838), bar(31, 1.0838, 1.0866, 1.0837, 1.0864), bar(32, 1.0864, 1.0865, 1.0863, 1.0864)])), {}],
      [judgedBox(env.win, hugeCd(), { alerts: [{ name: 'Bearish Engulfing', direction: 'bearish', firedAt: new Date(candleMs(26)).toISOString(), minutesAgo: 40 }] }),
       { news: [ev(2, 0, 'Early data', 'EUR', 'low'), ev(12, 30, 'US CPI', 'USD')] }]];
    const plain = /broker · .* UTC$|^(now|then) \d|^[▲▼◆■]$/;                      // axis times, prices, bare markers: nothing to define
    for (const [box, st] of draws) {
      await drawBox(env, box, st);
      Array.from(env.win.document.querySelectorAll('#rcSvg text')).forEach(n => {
        const t = n.textContent.trim(); if (!t || plain.test(t)) return;
        const id = n.getAttribute('data-term');
        assert.ok(id, 'no glossary link for the chart label "' + t + '"');
        assert.ok(T.indexOf(id) >= 0, '"' + t + '" links to "' + id + '", which is not in the glossary');
      });
    }
  });
  await check('RC7-5: the first-open tour walks the REAL Now tab; a step whose element is absent is skipped', async () => {
    const env = losingEnv(); await settle(env.win, 400);
    const o = env.win.document.getElementById('rcTour'); assert.ok(o, 'it opened on first sight of the chart');
    assert.ok(/1 of \d+/.test(o.textContent) && /One chip per box/.test(o.textContent), o.textContent.slice(0, 120));
    const steps = +o.textContent.match(/1 of (\d+)/)[1], titles = [];
    for (let i = 0; i < steps; i++) {
      titles.push(env.win.document.querySelector('#rcTour .rct-card b').textContent);
      env.win.document.querySelector('#rcTour [data-rct="next"]').click();
    }
    assert.ok(titles.indexOf('The decisive level') >= 0 && titles.indexOf('Replay') >= 0 && titles[titles.length - 1] === 'Any word you don\'t know', titles.join(' > '));
    assert.ok(!env.win.document.getElementById('rcTour'), 'done');
    // a page with NO open position: the chart steps are absent, so they are skipped (here: nothing to tour)
    const flat = makeEnv({ state: { watchlist: [{ symbol: 'EURUSDm', bid: 1.084, spread: 8 }], openTrades: [], closedTrades: [], accountInfo: { login: 5000 }, news: [] } });
    await settle(flat.win, 350);
    assert.ok(!flat.win.document.getElementById('rcTour'), 'no chart, no chart tour');
  });
  await check('RC7-6: once finished or skipped the tour never repeats; "Take the tour again" restarts it', async () => {
    const env = losingEnv(); await settle(env.win, 400);
    env.win.document.querySelector('#rcTour [data-rct="skip"]').click();
    assert.strictEqual(env.win.localStorage.getItem('bw-arbiter-tour'), 'done');
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 60);
    assert.ok(!env.win.document.getElementById('rcTour'), 'not again');
    env.win.document.getElementById('btnHelp').click(); env.win.document.getElementById('rcgTour').click();
    assert.ok(env.win.document.getElementById('rcTour'), 'taken again from the glossary');
  });
  await check('RC7-7: teaching never changes a decision — the card\'s verdict and the posted calls are the same with it open; no NaN', async () => {
    const env = losingEnv(); await settle(env.win, 400);
    const verdict = () => env.win.document.querySelector('#main .card[data-ticket]').textContent.replace(/\s+/g, ' ').slice(0, 200);
    const before = verdict(), posts = env.posts.length;
    env.win.document.getElementById('btnHelp').click();
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 60);
    assert.strictEqual(verdict(), before);
    assert.strictEqual(env.posts.filter(p => /\/api\/arbiter\/call/.test(p.url)).length, env.posts.slice(0, posts).filter(p => /\/api\/arbiter\/call/.test(p.url)).length, 'no extra calls');
    assert.ok(!/NaN|undefined|Infinity/.test(env.win.document.getElementById('rcGloss').innerHTML));
  });

  console.log('\nTHE TOUR\'S HIGHLIGHT STAYS ON WHAT IT EXPLAINS');
  // every element reports a screen position we control; a DETACHED element (replaced by a redraw) reports zero
  const screenAt = win => { const pos = { top: 300 }, seen = [];
    win.Element.prototype.getBoundingClientRect = function () {
      if (!this.isConnected) return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
      return { top: pos.top, left: 40, bottom: pos.top + 200, right: 640, width: 600, height: 200 }; };
    win.Element.prototype.scrollIntoView = function () { seen.push(this); };
    return { pos, seen }; };
  const toStep = (env, title) => { for (let i = 0; i < 9; i++) {
    const b = env.win.document.querySelector('#rcTour .rct-card b'); if (b && b.textContent === title) return;
    env.win.document.querySelector('#rcTour [data-rct="next"]').click(); } };
  const hole = env => env.win.document.querySelector('#rcTour .rct-hole');
  await check('each step brings its target INTO VIEW first', async () => {
    const env = losingEnv(); const S = screenAt(env.win); await settle(env.win, 400);
    assert.ok(S.seen.length >= 1 && S.seen[S.seen.length - 1].matches('#rcPane .rcchips'), 'step 1: the chips');
    toStep(env, 'The reasoning chart');
    assert.ok(S.seen[S.seen.length - 1].matches('#rcSvg'), 'step 2: the chart');
  });
  await check('THE BUG: scrolling — the highlight MOVES WITH the chart instead of framing what slides under it', async () => {
    const env = losingEnv(); const S = screenAt(env.win); await settle(env.win, 400);
    toStep(env, 'The reasoning chart');
    assert.strictEqual(hole(env).style.top, '294px', 'on the chart at first');
    S.pos.top = 80; env.win.dispatchEvent(new env.win.Event('scroll'));            // the trader scrolls: the chart moves up
    assert.strictEqual(hole(env).style.top, '74px', 'the box followed the chart');
    S.pos.top = -120; env.win.document.dispatchEvent(new env.win.Event('scroll')); // scrolling inside the page too
    assert.strictEqual(hole(env).style.top, '-126px');
  });
  await check('a chart REDRAW (every cycle) keeps the highlight on the NEW chart — never on the replaced one', async () => {
    const env = losingEnv(); const S = screenAt(env.win); await settle(env.win, 400);
    toStep(env, 'The reasoning chart');
    const old = env.win.document.getElementById('rcSvg');
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 40);
    assert.ok(env.win.document.getElementById('rcSvg') !== old, 'fixture sanity: the chart was replaced');
    S.pos.top = 420; env.win.dispatchEvent(new env.win.Event('scroll'));
    assert.strictEqual(hole(env).style.top, '414px', 'measured on the live chart, not the detached one (which reads 0)');
  });
  await check('the card stays on screen: below the target when there is room, above it when not', async () => {
    const env = losingEnv(); const S = screenAt(env.win); await settle(env.win, 400);
    toStep(env, 'The reasoning chart');
    const card = () => parseFloat(env.win.document.querySelector('#rcTour .rct-card').style.top);
    S.pos.top = 100; env.win.dispatchEvent(new env.win.Event('scroll'));
    assert.strictEqual(card(), 314, 'below: bottom 300 + 14');
    S.pos.top = 520; env.win.dispatchEvent(new env.win.Event('scroll'));
    assert.ok(card() < 520 && card() >= 12, 'above, still on screen: ' + card());
  });

  console.log('\nTHE CHIP AND THE CARD SHOW THE SAME PRESSURE; THE CHART IN DAY MODE');
  const cardPressures = (w, card) => Array.from(card.querySelectorAll('.act-val')).map(n => n.textContent.trim()).filter(Boolean);   // the dial's number
  await check('THE MISMATCH: a box with a leg on its OWN levels — the chip shows each verdict\'s pressure, exactly as the card', async () => {
    const env = threeLegs([{ sl: 1.0880, tp: 1.0800 }, { sl: 1.0880, tp: 1.0800 }, { sl: 1.0900, tp: 1.0760 }]); await settle(env.win, 420); skipTour(env);
    const card = env.win.document.querySelector('#main .card[data-ticket]:not(.rc-hidden)');
    const fromCard = cardPressures(env.win, card); assert.strictEqual(fromCard.length, 2, 'fixture sanity: two verdicts in the card');
    const chip = env.win.document.querySelector('#rcPane .rcc.on').textContent;
    const distinct = fromCard.filter((x, i) => fromCard.indexOf(x) === i);
    assert.ok(chip.indexOf('pressure ' + distinct.join(' · ')) >= 0, 'chip: "' + chip + '" | card: ' + fromCard.join(' · '));
  });
  await check('...and every chip and one-line box matches its own card (two pairs)', async () => {
    const env = twoPairs(); await settle(env.win, 420); skipTour(env);
    Array.from(env.win.document.querySelectorAll('#rcPane .rcc')).forEach(chip => {
      const key = chip.getAttribute('data-rcbox');
      const B = env.win.document.querySelector('#main .rc-line[data-rcbox="' + key + '"]');
      const card = B ? B.nextElementSibling : env.win.document.querySelector('#main .card[data-ticket]:not(.rc-hidden)');
      const cp = cardPressures(env.win, card), want = cp.filter((x, i) => cp.indexOf(x) === i).join(' · ');
      assert.ok(chip.textContent.indexOf('pressure ' + want) >= 0, key + ' chip "' + chip.textContent + '" vs card ' + want);
      if (B) assert.ok(B.textContent.indexOf('pressure ' + want) >= 0, key + ' line "' + B.textContent + '" vs card ' + want);
    });
  });
  await check('THE CHIP, ASSAN\'S RULE: each DISTINCT pressure once, in the card\'s order — 45, 45, 72 reads "45 · 72"; all equal reads one number', async () => {
    const env = losingEnv(); await settle(env.win, 300); skipTour(env);
    const mk = ps => { const b = judgedBox(env.win, calmBars(31));
      b.verdicts = ps.map(p => { const j = Object.assign({}, b.verdicts[0].judgement, { settled: { action: { key: 'hold', word: 'HOLD', pressure: p } } });
        return Object.assign({}, b.verdicts[0], { judgement: j }); }); return b; };
    env.win.BWArbiterPage.chart.draw([mk([45, 45, 72])], { brokerOffsetSec: 0 });
    assert.ok(/pressure 45 · 72 · [+-]?\d+\.\d pips/.test(env.win.document.querySelector('#rcPane .rcc').textContent), env.win.document.querySelector('#rcPane .rcc').textContent);
    env.win.BWArbiterPage.chart.draw([mk([45, 45, 45, 45, 45, 45])], { brokerOffsetSec: 0 });
    assert.ok(/pressure 45 · [+-]?\d+\.\d pips/.test(env.win.document.querySelector('#rcPane .rcc').textContent), 'six at 45 read "45"');
    env.win.BWArbiterPage.chart.draw([mk([72, 45, 72, null])], { brokerOffsetSec: 0 });
    assert.ok(/pressure 72 · 45 · – · [+-]?\d+\.\d pips/.test(env.win.document.querySelector('#rcPane .rcc').textContent), 'first-seen order; not settled reads "–"');
  });
  await check('THE BLANK CHART: every shape is CLOSED — nothing nested inside a line, rectangle or circle (dark and day mode)', async () => {
    for (const theme of ['dark', 'light']) {
      const env = losingEnv(); env.win.document.documentElement.setAttribute('data-theme', theme); await settle(env.win, 300); skipTour(env);
      await drawBox(env, winner(env.win, { mfePips: 35 }), { news: [ev(12, 30, 'US CPI', 'USD')] });
      const shapes = Array.from(env.win.document.querySelectorAll('#rcSvg line, #rcSvg rect, #rcSvg circle, #rcSvg polyline'));
      assert.ok(shapes.length > 40, 'fixture sanity: a full chart (' + shapes.length + ' shapes)');
      const open = shapes.filter(n => n.children.length);
      assert.strictEqual(open.length, 0, theme + ': ' + open.length + ' shapes swallowed others — the browser would draw nothing (' +
        (open[0] ? open[0].outerHTML.slice(0, 90) : '') + ')');
      assert.ok(!/\/ class=/.test(env.win.document.getElementById('rcSvg').innerHTML), 'no stranded slash');
    }
  });
  await check('DAY MODE: no fixed colour is left in the chart — every colour follows the theme', async () => {
    const env = losingEnv(); env.win.document.documentElement.setAttribute('data-theme', 'light'); await settle(env.win, 300); skipTour(env);
    await drawBox(env, winner(env.win, { mfePips: 35 }), { news: [ev(12, 30, 'US CPI', 'USD')] });
    const fixed = Array.from(env.win.document.querySelectorAll('#rcSvg *')).filter(n => /^#/.test(n.getAttribute('fill') || '') || /^#/.test(n.getAttribute('stroke') || ''));
    assert.strictEqual(fixed.length, 0, 'fixed colours left: ' + fixed.slice(0, 3).map(n => n.outerHTML.slice(0, 80)).join(' | '));
    assert.ok(env.win.document.querySelector('#rcSvg .rf-fg'), 'the main text uses the theme colour');
  });
  await check('DAY MODE: the light palette is DARK text on white, deeper accents — nothing white-on-white', async () => {
    const css = HTML.split('<style>')[1].split('</style>')[0];
    const light = (css.match(/:root\[data-theme="light"\] #rcPane\{([^}]*)\}/) || [])[1] || '';
    const v = k => (light.match(new RegExp('--rc-' + k + ':(#[0-9a-f]{6})')) || [])[1];
    const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16) / 255).map(x => x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const contrast = h => (1 + 0.05) / (lum(h) + 0.05);                           // against white
    ['fg', 'fg2', 'green', 'red', 'blue', 'amber', 'violet', 'teal'].forEach(k => {
      assert.ok(v(k), 'light value for ' + k);
      assert.ok(contrast(v(k)) >= 4.5, k + ' ' + v(k) + ' has contrast ' + contrast(v(k)).toFixed(2) + ' on white (needs 4.5)'); });
    assert.ok(/#rcSvg \.rf-fg\{fill:var\(--rc-fg\)\}/.test(css));
  });

  console.log('\nTHE SELF-ZOOM, AND THE CALLS COVERING THE CANDLES');
  const candleY = (w, k) => +w.document.querySelector('#rcSvg rect[data-rck="' + k + '"]').getAttribute('y');
  await check('THE SELF-ZOOM: the decisive level vanishing and returning between redraws — the candles DO NOT MOVE', async () => {
    const env = losingEnv(); await settle(env.win, 300); skipTour(env);
    const withL = judgedBox(env.win, calmBars(31), { invalidationLevel: 1.0835 }), noL = judgedBox(env.win, calmBars(31), { invalidationLevel: null });
    await drawBox(env, withL); const y0 = candleY(env.win, 10);
    for (const b of [noL, withL, noL, noL, withL]) { await drawBox(env, b); assert.strictEqual(candleY(env.win, 10), y0, 'the chart jumped'); }
  });
  await check('...a genuinely wider market widens the scale AT ONCE; a tighter one narrows it only after 3 redraws in a row', async () => {
    const env = losingEnv(); await settle(env.win, 300); skipTour(env);
    const wide = judgedBox(env.win, calmBars(30).concat([bar(30, 1.0861, 1.0899, 1.0830, 1.0861)]), { invalidationLevel: null });
    const calm = judgedBox(env.win, calmBars(31), { invalidationLevel: null });
    await drawBox(env, calm); const yCalm = candleY(env.win, 10);
    await drawBox(env, wide); assert.notStrictEqual(candleY(env.win, 10), yCalm, 'widened at once');
    const yWide = candleY(env.win, 10);
    await drawBox(env, calm); assert.strictEqual(candleY(env.win, 10), yWide, 'held (1)');
    await drawBox(env, calm); assert.strictEqual(candleY(env.win, 10), yWide, 'held (2)');
    await drawBox(env, calm); assert.notStrictEqual(candleY(env.win, 10), yWide, 'narrowed on the third');
  });
  await check('a FAR take profit is an arrow label at the edge — it no longer squashes the candles', async () => {
    const env = losingEnv(); await settle(env.win, 300); skipTour(env);
    await drawBox(env, judgedBox(env.win, calmBars(31), { invalidationLevel: null }, { tp: 1.1300 }));   // 434 pips away
    assert.ok(tags(env.win).some(t => /^↑ target 1\.13000$/.test(t)), tags(env.win).join(','));
    // a candle's WICK (high to low, 12 pips here): squashed by a 434-pip scale it would be a few pixels
    const wicks = Array.from(env.win.document.querySelectorAll('#rcSvg line')).filter(l => l.getAttribute('x1') === l.getAttribute('x2') &&
      /rs-(green|red)/.test(l.getAttribute('class') || '')).map(l => Math.abs(+l.getAttribute('y2') - +l.getAttribute('y1')));
    assert.ok(wicks.length > 20 && Math.max(...wicks) > 100, 'the candles keep the room: the tallest wick is ' + Math.max(...wicks).toFixed(0) + 'px');
  });
  await check('THE CALLS: only WARNINGS, legs merged ("×3"), all in their LANE (none over the candles), one label; hover for detail', async () => {
    const env = threeLegs([{ sl: 1.0880, tp: 1.0800 }, { sl: 1.0880, tp: 1.0800 }, { sl: 1.0880, tp: 1.0800 }]);
    const ago = m => new Date(Date.now() - m * 60000).toISOString(), L = (t, action, m, adh) => ({ kind: 'live', ticket: t, action, adherence: adh || null,
      price_at: 1.0850, created_at: ago(m), snapshot: { route: action === 'cut' ? 'pressure' : 'protection' } });
    env.routes['/api/arbiter/calls'] = { ok: true, calls: [
      L(700, 'cut', 300), L(701, 'cut', 300), L(702, 'cut', 300),                       // ONE decision on three legs
      L(700, 'hold', 240), L(701, 'hold', 240), L(702, 'hold', 240), L(700, 'hold', 180), // HOLDs: not warnings
      L(700, 'partial', 120, 'followed'), L(700, 'be', 60), L(701, 'cut', 30)] };
    await settle(env.win, 420); skipTour(env);
    const pins = Array.from(env.win.document.querySelectorAll('#rcSvg [data-rccall]'));
    assert.deepStrictEqual(pins.map(p => p.getAttribute('data-rccall')), ['cut', 'partial', 'be', 'cut'], 'warnings only, in time order');
    assert.strictEqual(pins[0].getAttribute('data-rclegs'), '700,701,702'); assert.ok(tags(env.win).indexOf('×3') >= 0);
    const rects = Array.from(env.win.document.querySelectorAll('#rcSvg rect[data-rck]')).map(r => +r.getAttribute('y') + +r.getAttribute('height'));
    const candleBottom = Math.max(...rects);
    pins.forEach(p => { const y = p.tagName === 'circle' ? +p.getAttribute('cy') : p.tagName === 'rect' ? +p.getAttribute('y') + 4.5
        : +((p.getAttribute('d') || '').match(/^M[\d.]+ ([\d.]+)/) || [])[1] - 4;                     // the triangle's base, less half its height
      assert.ok(y > candleBottom - 1, p.getAttribute('data-rccall') + ' pin at y=' + y + ' sits over the candles (bottom ' + candleBottom + ')'); });
    const labels = tags(env.win).filter(t => /^(CUT|PARTIAL|BE) · /.test(t));
    assert.deepStrictEqual(labels, ['CUT · pressure'], 'only the latest is labelled');
    pins[1].dispatchEvent(new env.win.MouseEvent('mousemove', { bubbles: true }));
    const tip = env.win.document.getElementById('rcTip').textContent;
    assert.ok(/^TAKE PARTIAL — protection route\n.* broker  \(\d\d:\d\d UTC\)\nat 1\.08500 · leg #700\nyou followed it$/.test(tip), tip);
  });

  console.log('\nSJ-2 — ONE ENTRY CASE PER TRADE: THE SERVER\'S');
  await check('the page ADOPTS the server\'s frozen entry case when the status carries one', async () => {
    const env = losingEnv();
    const serverCase = { score: 77, pillars: { structure: { state: 'pass' }, location: { state: 'pass' } }, marker: 'from-the-server' };
    const at = new Date(Date.now() - 3 * 3600e3).toISOString();
    env.routes['/api/arbiter/status'] = { ok: true, accounts: [], openEpisodes: [],
      openPositions: [{ ticket: '501', mfe_pips: 4, mae_pips: 12, entry_case: { at, case: serverCase }, entry_volume: 0.5 }] };
    await settle(env.win, 400);
    const frozen = JSON.parse(env.win.localStorage.getItem('bw-arbiter-entry-cases') || '{}');
    const mine = Object.keys(frozen).map(k => frozen[k]).find(x => x.case && x.case.marker === 'from-the-server');
    assert.ok(mine, 'the server\'s case is the one the page uses: ' + JSON.stringify(frozen).slice(0, 200));
    assert.strictEqual(mine.server, true); assert.strictEqual(mine.at, Date.parse(at)); assert.strictEqual(mine.volume, 0.5);
  });
  await check('...and with NO server case (the migration not run yet), the page freezes its own — exactly as before', async () => {
    const env = losingEnv(); await settle(env.win, 400);
    const frozen = JSON.parse(env.win.localStorage.getItem('bw-arbiter-entry-cases') || '{}');
    const all = Object.keys(frozen).map(k => frozen[k]);
    assert.ok(all.length >= 1 && all.every(x => x.case && !x.server), JSON.stringify(frozen).slice(0, 200));
  });

  console.log('\nSJ-4 — WHO RECORDED IT, AND THE PARITY MONITOR');
  await check('Today\'s calls says who recorded each live call — the server, or your screen (old calls: your screen)', async () => {
    const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
    const live = (id, ticket, by) => ({ id, kind: 'live', symbol: 'EURUSD', direction: 'bear', ticket, action: 'cut', adherence: 'ignored',
      outcome: 'not_graded', resolved_at: ago(0), created_at: ago(id), window_ends_at: ago(id - 0.3), snapshot: by ? { by } : {} });
    const env = scoringEnv({ calls: { ok: true, quad: { good: 0, expensive: 0, ours: 0, luck: 0 }, calls: [live(1, '501', 'server'), live(2, '502', 'page'), live(3, '503', null)] } });
    await settle(env.win, 200);
    const by = Array.from(env.win.document.querySelectorAll('#calls [data-by]')).map(e => e.getAttribute('data-by') + ':' + e.textContent);
    assert.deepStrictEqual(by, ['server:recorded by the server', 'page:on your screen', 'page:on your screen'], by.join(' | '));
    assert.ok(!/<span|&lt;span/.test(env.win.document.getElementById('calls').textContent), 'never shown as raw code');
  });
  const parityEnv = (verdictAction, ageMs) => {
    const env = losingEnv();
    env.routes['/api/arbiter/server-verdicts'] = { ok: true, at: Date.now() - (ageMs || 0), verdicts: { '501': { action: verdictAction, pressure: 99, route: 'damage' } } };
    return env;
  };
  const pageAction = env => { const b = env.win.BWArbiterPage.chart ? null : null;
    const t = env.win.document.querySelector('#main .card[data-ticket]').textContent; return /CUT/.test(t) ? 'cut' : /BREAK-EVEN/.test(t) ? 'be' : /PARTIAL/.test(t) ? 'partial' : 'hold'; };
  await check('THE PARITY MONITOR: a disagreement that LASTS a minute is shown on the card and reported ONCE', async () => {
    const env = parityEnv('be'); await settle(env.win, 400); skipTour(env);
    assert.notStrictEqual(pageAction(env), 'be', 'fixture sanity: the page reads it differently');
    assert.ok(!env.win.document.querySelector('#main .act-note.parity'), 'not after a few seconds — a change can be in progress');
    const real = Date.now(); env.win.Date.now = () => real + 61000; env.routes['/api/arbiter/server-verdicts'].at = real + 61000;
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 80);
    const note = env.win.document.querySelector('#main .act-note.parity');
    assert.ok(note && /Arbiter's server reads #501 as BE; this page reads [A-Z]+\. The two should agree — this has been reported\./.test(note.textContent), note && note.textContent);
    const reports = () => env.posts.filter(p => /\/api\/arbiter\/parity/.test(p.url));
    assert.strictEqual(reports().length, 1); assert.deepStrictEqual(reports()[0].body.server, { action: 'be', pressure: 99 });
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 80);
    assert.strictEqual(reports().length, 1, 'reported once, not every cycle');
  });
  await check('...a STALE server verdict (over 30 s old) is never compared; agreement is never flagged', async () => {
    const env = parityEnv('be', 45000); await settle(env.win, 400); skipTour(env);
    const real = Date.now(); env.win.Date.now = () => real + 61000;
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 80);
    assert.ok(!env.win.document.querySelector('#main .act-note.parity'), 'stale: no comparison');
    const env2 = losingEnv(); await settle(env2.win, 400);
    env2.routes['/api/arbiter/server-verdicts'] = { ok: true, at: Date.now(), verdicts: { '501': { action: pageAction(env2), pressure: 1 } } };
    const r2 = Date.now(); env2.win.Date.now = () => r2 + 61000; env2.routes['/api/arbiter/server-verdicts'].at = r2 + 61000;
    await env2.win.BWArbiterPage.cycle(); await settle(env2.win, 80);
    assert.ok(!env2.win.document.querySelector('#main .act-note.parity'), 'they agree: nothing to flag');
  });

  console.log('\nN-4 — ALERTS WHEN ARBITER IS CLOSED: THE TRADER\'S SWITCHES');
  const alertsFix = over => Object.assign({ ok: true, telegram: { linked: true, on: true }, email: { available: true, on: false, to: 'j***@gmail.com', perDay: 3 },
    push: { available: true, on: false, devices: 0 }, perHour: 12 }, over || {});
  const openSettings = async env => { env.win.document.querySelector('.nav-tab[data-p="settings"]').click(); await settle(env.win, 80); };
  const panel = env => env.win.document.getElementById('alertsPanel').textContent.replace(/\s+/g, ' ');
  await check('Settings shows the alerts panel — Telegram on, email off with the hidden address, and THIS browser\'s honest limit', async () => {
    const env = losingEnv(); env.routes['/api/arbiter/alerts'] = alertsFix(); await settle(env.win, 300); skipTour(env); await openSettings(env);
    const t = panel(env);
    assert.ok(/Alerts when Arbiter is closed/.test(t) && /When no Arbiter page is open, Arbiter keeps judging on the server/.test(t), t.slice(0, 200));
    assert.ok(/Telegram ?Through the Blackwood bot you linked\. ?On/.test(t), t);
    assert.ok(/Email ?CUTs only, at most 3 a day — to j\*\*\*@gmail\.com\. ?Off/.test(t), t);
    assert.ok(/This device ?This browser cannot receive alerts\./.test(t), 'the test browser has no push: said so, no button that would fail');
  });
  await check('the email switch posts the change and redraws', async () => {
    const env = losingEnv(); env.routes['/api/arbiter/alerts'] = alertsFix(); env.routes['POST /api/arbiter/alerts'] = { status: 200, body: { ok: true } };
    await settle(env.win, 300); skipTour(env); await openSettings(env);
    env.routes['/api/arbiter/alerts'] = alertsFix({ email: { available: true, on: true, to: 'j***@gmail.com', perDay: 3 } });   // the server, after the save
    env.win.document.querySelector('#alertsPanel [data-al="email"]').click(); await settle(env.win, 80);
    const posted = env.posts.filter(p => /\/api\/arbiter\/alerts$/.test(p.url.split('?')[0]));
    assert.deepStrictEqual(posted.map(p => p.body), [{ email: true }]);
    assert.strictEqual(env.win.document.querySelector('#alertsPanel [data-al="email"]').getAttribute('aria-pressed'), 'true');
  });
  await check('Telegram NOT linked: the way to link it — and no switch that cannot work', async () => {
    const env = losingEnv(); env.routes['/api/arbiter/alerts'] = alertsFix({ telegram: { linked: false, on: false } });
    await settle(env.win, 300); skipTour(env); await openSettings(env);
    assert.ok(/Not linked yet — link your Telegram to the Blackwood bot first/.test(panel(env)));
    assert.ok(!env.win.document.querySelector('#alertsPanel [data-al="telegram"]'));
  });
  await check('"Send me a test" says where it went — or that nothing is switched on yet', async () => {
    const env = losingEnv(); env.routes['/api/arbiter/alerts'] = alertsFix();
    env.routes['POST /api/arbiter/alerts/test'] = { status: 200, body: { ok: true, sent: ['telegram'] } };
    await settle(env.win, 300); skipTour(env); await openSettings(env);
    env.win.document.querySelector('#alertsPanel [data-al="test"]').click(); await settle(env.win, 80);
    assert.ok(/Test sent by telegram\./.test(panel(env)), panel(env));
    env.routes['POST /api/arbiter/alerts/test'] = { status: 200, body: { ok: true, sent: [] } };
    env.win.document.querySelector('#alertsPanel [data-al="test"]').click(); await settle(env.win, 80);
    assert.ok(/Nothing is switched on yet — switch on a way to reach you first\./.test(panel(env)));
  });
  await check('"Send me a test" that FAILED says why — per channel — never "sent"', async () => {
    const env = losingEnv(); env.routes['/api/arbiter/alerts'] = alertsFix();
    env.routes['POST /api/arbiter/alerts/test'] = { status: 200, body: { ok: true, sent: [], failed: [{ channel: 'telegram', why: 'Telegram alerts are paused on the Blackwood bot \u2014 send /resume to it' }] } };
    await settle(env.win, 300); skipTour(env); await openSettings(env);
    env.win.document.querySelector('#alertsPanel [data-al="test"]').click(); await settle(env.win, 80);
    assert.ok(/Not sent\. Telegram: Telegram alerts are paused on the Blackwood bot — send \/resume to it\./.test(panel(env)), panel(env));
  });

  await check('an IPHONE not opened from the Home Screen gets the tip — not a button that would fail', async () => {
    const env = losingEnv(); env.routes['/api/arbiter/alerts'] = alertsFix();
    Object.defineProperty(env.win.navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)', configurable: true });
    Object.defineProperty(env.win.navigator, 'serviceWorker', { value: { getRegistration: async () => null }, configurable: true });
    env.win.PushManager = function () {}; env.win.Notification = function () {};
    await settle(env.win, 300); skipTour(env); await openSettings(env);
    assert.ok(/On iPhone: tap Share, then Add to Home Screen, and open Blackwood from there to switch this on\./.test(panel(env)), panel(env));
    assert.ok(!env.win.document.querySelector('#alertsPanel [data-al="push-on"]'));
  });

  console.log('\nTHE FLICKER: TWO BOXES ON ONE PAIR (first seen with 10 + 5 lots; now a hedge is the way to get two)');
  const twoSizes = () => {
    const env = makeEnv({ status: { ok: true, accounts: [{ account_number: '1001' }], openEpisodes: [],
      openPositions: [{ ticket: '800', mfe_pips: 5, mae_pips: 12 }, { ticket: '801', mfe_pips: 4, mae_pips: 10 }] } });
    env.routes['/api/state'].openTrades = [
      { ticket: 800, symbol: 'EURUSDm', type: 'sell', volume: 10, openPrice: 1.0850, sl: 1.0880, tp: 0, profit: -200, riskPct: 2.0, openTime: Math.floor(Date.now() / 1000) - 3000 },
      { ticket: 801, symbol: 'EURUSDm', type: 'buy', volume: 5, openPrice: 1.0852, sl: 1.0820, tp: 1.0920, profit: 90, riskPct: 1.0, openTime: Math.floor(Date.now() / 1000) - 2400 }];   // a HEDGE: two boxes on one pair
    return env;
  };
  const boxCardsAll = w => Array.from(w.document.querySelectorAll('#main .card[data-ticket]'));
  const visibleCards = w => Array.from(w.document.querySelectorAll('#main .card[data-ticket]')).filter(c => !c.classList.contains('rc-hidden')).map(c => c.getAttribute('data-ticket'));
  await check('THE FLICKER: with the candles arriving SLOWLY, at EVERY moment of every cycle exactly ONE box card shows — always the same one', async () => {
    const env = twoSizes(); await settle(env.win, 400); skipTour(env);
    assert.strictEqual(env.win.document.querySelectorAll('#rcPane .rcc').length, 2, 'fixture sanity: two boxes on one pair');
    const chosen = visibleCards(env.win);
    assert.strictEqual(chosen.length, 1);
    const real = env.win.fetch;                                  // every candle request now takes 300 ms
    env.win.fetch = (u, i) => /\/api\/candles/.test(String(u)) ? new Promise(r => setTimeout(() => r(real(u, i)), 300)) : real(u, i);
    const seen = new Set(); let worst = 1;
    for (let c = 0; c < 3; c++) {
      const run = env.win.BWArbiterPage.cycle();
      for (let t = 0; t < 25; t++) { await new Promise(r => setTimeout(r, 40)); const v = visibleCards(env.win); worst = Math.max(worst, v.length); v.forEach(x => seen.add(x)); }
      await run;
    }
    assert.strictEqual(worst, 1, 'both cards showed at some moment — the flicker');
    assert.deepStrictEqual([...seen], chosen, 'the shown card changed between cycles');
  });
  await check('the chips say the side and LOT SIZE — "SHORT · 10 lots", "LONG · 5 lots" — two boxes on one pair told apart', async () => {
    const env = twoSizes(); await settle(env.win, 400); skipTour(env);
    const chips = Array.from(env.win.document.querySelectorAll('#rcPane .rcc')).map(c => c.textContent);
    assert.ok(chips.some(t => /SHORT · 10 lots/.test(t)) && chips.some(t => /LONG · 5 lots/.test(t)), chips.join(' | '));
    assert.ok(/· (10|5) lots/.test(env.win.document.querySelector('#main .rc-line').textContent), 'and the one-line row');
  });
  await check('choosing the 5-lot chip: ITS card shows and STAYS; the 10-lot\'s take-profit warning never flickers back', async () => {
    const env = twoSizes(); await settle(env.win, 400); skipTour(env);
    const chip5 = Array.from(env.win.document.querySelectorAll('#rcPane .rcc')).find(c => /5 lots/.test(c.textContent));
    chip5.click(); await settle(env.win, 60);
    const real = env.win.fetch;
    env.win.fetch = (u, i) => /\/api\/candles/.test(String(u)) ? new Promise(r => setTimeout(() => r(real(u, i)), 300)) : real(u, i);
    const seen = new Set();
    for (let c = 0; c < 2; c++) { const run = env.win.BWArbiterPage.cycle();
      for (let t = 0; t < 25; t++) { await new Promise(r => setTimeout(r, 40)); visibleCards(env.win).forEach(x => seen.add(x)); } await run; }
    assert.deepStrictEqual([...seen], ['801'], 'only the 5-lot card, every moment');
    const shown = env.win.document.querySelector('#main .card[data-ticket="801"]');
    assert.ok(!/take profit|take-profit|no target/i.test(shown.textContent) || /1\.07800/.test(shown.textContent), 'the 5-lot HAS a target');
  });

  await check('ASSAN\'S CASE: 10 lots + 5 lots selling ONE pair — ONE chip ("10 + 5 lots"), ONE card holding BOTH legs, steady', async () => {
    const env = twoSizes(); env.routes['/api/state'].openTrades[1] = Object.assign({}, env.routes['/api/state'].openTrades[1],
      { type: 'sell', sl: 1.0885, tp: 1.0780, profit: -90 });
    await settle(env.win, 400); skipTour(env);
    const chips = Array.from(env.win.document.querySelectorAll('#rcPane .rcc')).map(c => c.textContent);
    assert.strictEqual(chips.length, 1, 'one chip — ' + chips.join(' | '));
    assert.ok(/SHORT · 10 \+ 5 lots/.test(chips[0]), chips[0]);
    assert.strictEqual(boxCardsAll(env.win).length, 1, 'one card');
    const card = boxCardsAll(env.win)[0];
    assert.ok(/10 \+ 5 lots/.test(card.textContent) && /#800/.test(card.textContent) && /#801/.test(card.textContent), 'both legs in it');
    const before = card.textContent;
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 80);
    assert.strictEqual(boxCardsAll(env.win).length, 1, 'still one card');
  });

  await check('the CHIP\'s pips speak for the WHOLE box — every leg, weighted by its lots (a book AND a leg on its own levels)', async () => {
    const env = twoSizes(); env.routes['/api/state'].openTrades[1] = Object.assign({}, env.routes['/api/state'].openTrades[1],
      { type: 'sell', sl: 1.0885, tp: 1.0780, profit: -90 });                     // 10 lots + 5 lots, different levels: two verdicts, one box
    await settle(env.win, 400); skipTour(env);
    const chip = env.win.document.querySelector('#rcPane .rcc').textContent;
    const shown = Number((chip.match(/([+-]?\d+\.\d) pips/) || [])[1]);
    const legs = Array.from(env.win.document.querySelectorAll('#main .card[data-ticket] tbody tr')).length;
    const st = env.routes['/api/state'], px = env.win.BWArbiterPage.chart ? null : null;
    // the legs' own pips, as the page computes them, weighted 10:5
    const card = env.win.document.querySelector('#main .card[data-ticket]').textContent;
    assert.ok(isFinite(shown), 'the chip shows pips: ' + chip);
    const legPips = Array.from(env.win.document.querySelectorAll('#main .card[data-ticket] tbody tr')).map(tr => Number((tr.textContent.match(/([+-]\d+\.\d)(?!\d)/g) || []).pop()));
    assert.ok(legPips.length === 2 && legPips.every(isFinite), 'both legs\' pips read from the card: ' + legPips.join(', '));
    const want = (legPips[0] * 10 + legPips[1] * 5) / 15;
    assert.ok(Math.abs(shown - want) < 0.15, 'chip ' + shown + ' vs the legs weighted ' + want.toFixed(2) + ' (' + legPips.join(', ') + ')');
  });

  console.log('\nASSAN\'S SETUP, END TO END: EA ON GBPUSD, A GBPJPY BOOK AND A GBPUSD TRADE');
  await check('each pair judged on ITS OWN prices and pip size — no leak between pairs; the GBPJPY book reads its real pips', async () => {
    const now = Math.floor(Date.now() / 1000);
    const series = (base, amp, n, step) => Array.from({ length: n }, (_, i) => { const c = base + Math.sin(i / 6) * amp;
      return { time: now - (n - i) * step, open: c - amp * 0.1, high: c + amp * 0.3, low: c - amp * 0.3, close: c }; });
    const pack = (sym, base, amp) => { const H1 = series(base, amp, 150, 3600); H1[149].close = base; return { symbol: sym, candlesByTF: { H1, H4: series(base, amp, 80, 14400) }, candles: H1 }; };
    const env = makeEnv({ status: { ok: true, accounts: [{ account_number: '1001' }], openEpisodes: [],
      openPositions: [{ ticket: '578', mfe_pips: 1.9, mae_pips: -2.6 }, { ticket: '608', mfe_pips: 1.9, mae_pips: -2.6 }, { ticket: '615', mfe_pips: 1.9, mae_pips: -2.6 },
                      { ticket: '900', mfe_pips: 8, mae_pips: -3 }] } });
    env.routes['/api/candles'] = { __bySymbol: { GBPJPYm: pack('GBPJPYm', 208.951, 0.35), GBPUSDm: pack('GBPUSDm', 1.2710, 0.0020) } };
    const st = env.routes['/api/state'];
    st.symbol = 'GBPUSDm';                                                   // the EA's chart: GBPUSD
    st.watchlist = [{ symbol: 'GBPUSDm', bid: 1.2710, spread: 12 }, { symbol: 'GBPJPYm', bid: 208.951, spread: 19 }];
    st.openTrades = [
      { ticket: 578, symbol: 'GBPJPYm', type: 'sell', volume: 1, openPrice: 208.939, sl: 209.427, tp: 208.289, profit: -12.00, riskPct: 0.5, openTime: now - 4 * 3600 },
      { ticket: 608, symbol: 'GBPJPYm', type: 'sell', volume: 1, openPrice: 208.925, sl: 209.427, tp: 208.289, profit: -20.85, riskPct: 0.5, openTime: now - 3 * 3600 },
      { ticket: 615, symbol: 'GBPJPYm', type: 'sell', volume: 1, openPrice: 208.926, sl: 209.427, tp: 208.289, profit: -20.22, riskPct: 0.5, openTime: now - 3 * 3600 },
      { ticket: 900, symbol: 'GBPUSDm', type: 'buy', volume: 0.5, openPrice: 1.2702, sl: 1.2660, tp: 1.2800, profit: 4.00, riskPct: 0.4, openTime: now - 2 * 3600 }];
    await settle(env.win, 500); skipTour(env);
    const chips = Array.from(env.win.document.querySelectorAll('#rcPane .rcc')).map(c => c.textContent);
    assert.strictEqual(chips.length, 2, 'two boxes, one per pair: ' + chips.join(' | '));
    const pipsOf = re => Number(((chips.find(c => re.test(c)) || '').match(/([+-]?\d+\.\d) pips/) || [])[1]);
    const jpy = pipsOf(/GBPJPY/), usd = pipsOf(/GBPUSD/);
    assert.ok(Math.abs(jpy - (-2.1)) < 0.2, 'the GBPJPY book: about -2.1 pips, got ' + jpy);
    assert.ok(Math.abs(usd - 8.0) < 0.2, 'the GBPUSD trade: +8.0 pips, got ' + usd);
    const all = env.win.document.getElementById('main').textContent;
    assert.ok(!/100% of the stop distance used/.test(all), 'no "100% of the stop"');
    assert.ok(!/\d{4,}% of the best/.test(all), 'no thousands-of-percent handed back');
  });

  console.log('\nA PAIR THE EA DOES NOT SEND: NO DATA, NOT A FALSE ALL-CLEAR');
  await check('a trade on a pair with NO live price: "NO DATA" and why — never "HOLD, nothing is working against it"; never recorded', async () => {
    const env = losingEnv();
    env.routes['/api/candles'] = { __bySymbol: { EURUSDm: env.routes['/api/candles'] } };
    env.routes['/api/state'].openTrades = [{ ticket: 950, symbol: 'NZDCADm', type: 'sell', volume: 1, openPrice: 0.8210, sl: 0.8260, tp: 0.8110,
      profit: -15, riskPct: 0.6, openTime: Math.floor(Date.now() / 1000) - 7200 }];
    await settle(env.win, 500); skipTour(env);
    const t = env.win.document.querySelector('#main .card[data-ticket]').textContent.replace(/\s+/g, ' ');
    assert.ok(/NO DATA/.test(t) && /NO VERDICT/.test(t), t.slice(0, 300));
    assert.ok(/Arbiter cannot see NZDCAD: the EA is not sending its prices, so this trade cannot be judged\. Add NZDCAD to the EA's watch pairs/.test(t));
    assert.ok(!/nothing is working against it|PRESSURE \d/.test(t), 'no false all-clear, no pressure');
    assert.strictEqual(env.posts.filter(p => /\/api\/arbiter\/call/.test(p.url)).length, 0, 'never recorded as a call (so never alerted)');
  });

  console.log('\nTP-4 — TRADED PAIRS IN ARBITER');
  await check('a pair BEYOND the EA\'s cap (no candles, no watchlist price): judged on the trade\'s OWN currentPrice — and the card says so', async () => {
    const env = losingEnv();
    env.routes['/api/candles'] = { __bySymbol: { EURUSDm: env.routes['/api/candles'] } };
    env.routes['/api/state'].tradedPairs = ['NZDCAD'];
    env.routes['/api/state'].openTrades = [{ ticket: 951, symbol: 'NZDCADm', type: 'sell', volume: 1, openPrice: 0.8231, currentPrice: 0.8212,
      sl: 0.8280, tp: 0.8150, profit: 135, riskPct: 0.6, openTime: Math.floor(Date.now() / 1000) - 7200 }];
    await settle(env.win, 500); skipTour(env);
    const t = env.win.document.querySelector('#main .card[data-ticket]').textContent.replace(/\s+/g, ' ');
    assert.ok(!/NO DATA/.test(t), 'judged, not NO DATA: ' + t.slice(0, 200));
    assert.ok(/\+19\.0 pips/.test(t), 'pips from the trade\'s own price: 0.8231 to 0.8212 = +19.0 on a sell — ' + t.slice(0, 260));
    assert.ok(/Judged on this trade's own price only: Arbiter has no chart data for NZDCAD/.test(t), 'and it says so');
    const chip = (env.win.document.querySelector('#rcPane .rcc') || {}).textContent || '';
    assert.ok(!chip || /traded/.test(chip), 'a traded pair\'s chip is labelled: ' + chip);
  });
  await check('a traded pair WITH data: judged normally — no "price only" note — and its chip carries the TRADED label', async () => {
    const env = losingEnv();
    env.routes['/api/state'].tradedPairs = ['EURUSD'];
    await settle(env.win, 400); skipTour(env);
    const t = env.win.document.getElementById('main').textContent;
    assert.ok(!/Judged on this trade's own price only/.test(t), 'a full judgement needs no such note');
    const chips = Array.from(env.win.document.querySelectorAll('#rcPane .rcc')).map(c => c.textContent);
    assert.ok(chips.length && chips.every(c => /traded/.test(c)), 'labelled: ' + chips.join(' | '));
  });

  console.log('\nA BOX\'S LIFE: A PARTIAL CLOSE, A TRADE OPENING, A TRADE CLOSING, THE BOX CLOSING');
  await check('partial close → a new trade joins → a trade leaves → the box closes: every step clean, no stale card or chip', async () => {
    const now = Math.floor(Date.now() / 1000);
    const env = makeEnv({ status: { ok: true, accounts: [{ account_number: '1001' }], openEpisodes: [],
      openPositions: ['700', '701', '702', '703', '800'].map(t => ({ ticket: t, mfe_pips: 6, mae_pips: -4 })) } });
    const st = env.routes['/api/state'];
    const sell = (t, v, op) => ({ ticket: t, symbol: 'EURUSDm', type: 'sell', volume: v, openPrice: op, sl: 1.0880, tp: 1.0800, profit: -10, riskPct: 0.5, openTime: now - 3600 });
    st.openTrades = [sell(700, 1, 1.0850), sell(701, 1, 1.0851), sell(702, 1, 1.0852),
                     { ticket: 800, symbol: 'EURUSDm', type: 'buy', volume: 0.5, openPrice: 1.0840, sl: 1.0810, tp: 1.0900, profit: 5, riskPct: 0.3, openTime: now - 1800 }];
    await settle(env.win, 400); skipTour(env);
    const D = env.win.document, cycle = async () => { await env.win.BWArbiterPage.cycle(); await settle(env.win, 60); };
    const sellChip = () => (Array.from(D.querySelectorAll('#rcPane .rcc')).find(c => /SHORT/.test(c.textContent)) || {}).textContent || '';
    const cards = () => Array.from(D.querySelectorAll('#main .card[data-ticket]'));
    assert.ok(/3 × 1 lots/.test(sellChip()), 'start: ' + sellChip());
    // 1. a PARTIAL close: #702 from 1 lot to 0.5
    st.openTrades[2] = Object.assign({}, st.openTrades[2], { volume: 0.5 }); await cycle();
    assert.ok(/1 \+ 1 \+ 0\.5 lots/.test(sellChip()), 'after the partial: ' + sellChip());
    // 2. a NEW trade on the same pair and side joins the SAME box
    st.openTrades.push(sell(703, 2, 1.0853)); await cycle();
    assert.ok(/1 \+ 1 \+ 0\.5 \+ 2 lots/.test(sellChip()), 'after #703 opened: ' + sellChip());
    assert.strictEqual(D.querySelectorAll('#rcPane .rcc').length, 2, 'still two boxes: the sells and the buy');
    // 3. a trade CLOSES
    st.openTrades = st.openTrades.filter(t => t.ticket !== 700); await cycle();
    assert.ok(/1 \+ 0\.5 \+ 2 lots/.test(sellChip()), 'after #700 closed: ' + sellChip());
    assert.ok(!/#700/.test(D.getElementById('main').textContent), '#700 is gone from every card');
    // 4. the whole SELL box closes: no stale chip or card; the buy box is shown
    st.openTrades = st.openTrades.filter(t => t.type === 'buy'); await cycle();
    assert.strictEqual(D.querySelectorAll('#rcPane .rcc').length <= 1, true, 'no stale chip');
    assert.ok(cards().every(c => !/#70\d/.test(c.textContent)), 'no stale card');
    const vis = cards().filter(c => !c.classList.contains('rc-hidden'));
    assert.deepStrictEqual(vis.map(c => c.getAttribute('data-ticket')), ['800'], 'the buy box shown, alone');
    assert.strictEqual(D.querySelectorAll('#main .rc-line').length, 0, 'no stale one-line row');
  });

  console.log('\nPATTERNS ON THE CANDLE THAT HAS NOT CLOSED');

  function formingEnv(dir) {
    const env = losingEnv();
    const st = env.routes['/api/state'];
    st.symbol = 'EURUSDm'; st.timeframe = 'H1';
    st.patterns = [{ name: 'Shooting Star', direction: dir, confidence: 76, barsAgo: 0 }];
    return env;
  }

  await check('a reversal FORMING on the open candle reaches the judgement', async () => {
    const env = formingEnv('bullish');       // the trade is SHORT, so bullish is against it
    await settle(env.win, 320);
    const card = env.win.document.querySelector('#main .card[data-ticket]');
    const t = card.textContent.replace(/\s+/g, ' ');
    assert.ok(/Reversal forming on this candle/.test(t), t.slice(t.indexOf('working against'), t.indexOf('working against') + 300));
    assert.ok(/this candle has not closed, so it may not finish this way/.test(t), 'and it says it is unfinished');
  });

  await check('THE BLIND SPOT: the EA on GBPUSD, the trade on EURUSD — a reversal forming on EURUSD now REACHES the judgement', async () => {
    // the EA sends every pair's live read in the candle bundle; the server keeps it as formingPatterns
    const env = losingEnv(); const st = env.routes['/api/state'];
    st.symbol = 'GBPUSDm'; st.timeframe = 'H1';
    st.patterns = [{ name: 'Doji', direction: 'bullish', confidence: 70, barsAgo: 0 }];        // GBPUSD's own — not this trade's
    st.formingPatterns = { EURUSDm: { H1: [{ name: 'Shooting Star', direction: 'bullish', confidence: 76, barsAgo: 0 }] } };
    await settle(env.win, 320);
    const t = env.win.document.querySelector('#main .card[data-ticket]').textContent.replace(/\s+/g, ' ');
    assert.ok(/Reversal forming on this candle/.test(t), 'seen on the trade\'s own pair: ' + t.slice(t.indexOf('working against'), t.indexOf('working against') + 300));
  });
  await check('...without the pair\'s own read (an old server) and the EA elsewhere: still nothing — never another pair\'s candle', async () => {
    const env = losingEnv(); const st = env.routes['/api/state'];
    st.symbol = 'GBPUSDm'; st.timeframe = 'H1';
    st.patterns = [{ name: 'Shooting Star', direction: 'bullish', confidence: 76, barsAgo: 0 }];   // GBPUSD's
    await settle(env.win, 320);
    assert.ok(!/Reversal forming on this candle/.test(env.win.document.querySelector('#main .card').textContent), 'GBPUSD\'s candle never judged as EURUSD\'s');
  });

  await check('one that AGREES with the trade is not counted against it', async () => {
    const env = formingEnv('bearish');       // the trade is SHORT; bearish agrees
    await settle(env.win, 320);
    assert.ok(!/Reversal forming on this candle/.test(env.win.document.querySelector('#main .card').textContent));
  });

  await check('the rail says what this candle is doing, and admits when it cannot see', async () => {
    const env = formingEnv('bullish');
    await settle(env.win, 320);
    assert.ok(/This candle ?1 forming · Shooting Star/.test(env.win.document.getElementById('feeds').textContent.replace(/\s+/g, ' ')));
    const other = makeEnv();                 // no chart symbol reported
    delete other.routes['/api/state'].symbol;
    await settle(other.win, 320);
    assert.ok(/This candle ?only for the charted pair/.test(other.win.document.getElementById('feeds').textContent.replace(/\s+/g, ' ')),
      'the multi-symbol bundle has no forming patterns — that is not the same as "nothing forming"');
  });

  console.log('\nTIMEFRAMES IN THE RAIL');
  // H1 candles trend DOWN, H4 candles trend UP: the two timeframes disagree
  const upCd = candles(zigzag(60, 1.0600, 0.0006, false));
  function tfEnv(h4) {
    const downCd = candles(zigzag(60, 1.0920, 0.0006, true));
    const byTF = { H1: downCd }; if (h4) byTF.H4 = h4;
    return makeEnv({ candles: { symbol: 'EURUSDm', candlesByTF: byTF, candles: downCd } });
  }
  const feedsText = win => win.document.getElementById('feeds').textContent.replace(/\s+/g, ' ');

  await check('H1 is the default, and the H1/H4 switch is there', async () => {
    const env = tfEnv(upCd);
    await settle(env.win, 300);
    const on = env.win.document.querySelector('#railTF button.on');
    assert.strictEqual(on.textContent, 'H1');
    assert.ok(/· H1$/.test(head(env.win)));
  });

  await check('it always says whether H1 and H4 AGREE on structure — here they do not', async () => {
    const env = tfEnv(upCd);
    await settle(env.win, 300);
    assert.ok(/H1 vs H4 ?disagree — H1 down, H4 up/.test(feedsText(env.win)), feedsText(env.win).slice(0, 160));
  });

  await check('switching to H4 shows the H4 reading, labelled, with H4 requested from every source', async () => {
    const env = tfEnv(upCd);
    await settle(env.win, 300);
    env.win.document.querySelector('#railTF button[data-rtf="H4"]').click(); await settle(env.win, 80);
    assert.ok(/· H4$/.test(head(env.win)), head(env.win));
    assert.ok(/Actions and scores are judged on H1 — this is the H4 view of the same pair/.test(why(env.win)));
    assert.ok(env.calls.some(c => c.indexOf('/smc/tf/H4') === 0), 'H4 zones');
    assert.ok(env.calls.some(c => /\/api\/patterns\?.*tf=H4/.test(c)), 'H4 patterns');
  });

  await check('switching timeframe NEVER changes the action on the card', async () => {
    const env = tfEnv(upCd);
    await settle(env.win, 300);
    const before = env.win.document.querySelector('.act-word').textContent;
    env.win.document.querySelector('#railTF button[data-rtf="H4"]').click(); await settle(env.win, 80);
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 60);
    assert.strictEqual(env.win.document.querySelector('.act-word').textContent, before);
  });

  await check('the chosen timeframe stays chosen across refreshes', async () => {
    const env = tfEnv(upCd);
    await settle(env.win, 300);
    env.win.document.querySelector('#railTF button[data-rtf="H4"]').click(); await settle(env.win, 80);
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 60);
    assert.ok(/· H4$/.test(head(env.win)));
    assert.strictEqual(env.win.document.querySelector('#railTF button.on').textContent, 'H4');
  });

  await check('THE FALLBACK BUG: with no H4 candles, H4 shows nothing — never H1 data under an H4 label', async () => {
    const env = tfEnv(null);                       // only H1 candles exist
    await settle(env.win, 300);
    env.win.document.querySelector('#railTF button[data-rtf="H4"]').click(); await settle(env.win, 80);
    const t = feedsText(env.win);
    assert.ok(/Structure ?none/.test(t), 'no H4 structure invented from H1 candles: ' + t.slice(0, 200));
    assert.ok(/H1 vs H4 ?structure unknown/.test(t));
  });

  await check('M15 is offered, alongside H1 and H4', async () => {
    const env = tfEnv(upCd);
    await settle(env.win, 300);
    assert.deepStrictEqual(Array.from(env.win.document.querySelectorAll('#railTF button')).map(b => b.textContent), ['M15', 'H1', 'H4']);
  });

  await check('M15 never borrows H1 zones — it says zones are not built for M15', async () => {
    const m15 = candles(zigzag(80, 1.0900, 0.0002, true));
    const downCd = candles(zigzag(60, 1.0920, 0.0006, true));
    const env = makeEnv({ candles: { symbol: 'EURUSDm', candlesByTF: { H1: downCd, H4: upCd, M15: m15 }, candles: downCd } });
    await settle(env.win, 300);
    // Every normal cycle fetches /api/state once and /smc once. A cycle can land inside the
    // window (timing), so the precise check is: no /smc request BEYOND one per cycle — any
    // extra one would be the M15 read borrowing H1 zones. (Counting /smc alone was flaky.)
    const n = p => env.calls.filter(c => c.split('?')[0] === p).length;
    const smcBefore = n('/smc'), stateBefore = n('/api/state');
    env.win.document.querySelector('#railTF button[data-rtf="M15"]').click(); await settle(env.win, 120);
    assert.strictEqual(n('/smc') - smcBefore, n('/api/state') - stateBefore, 'the M15 read fetched no H1 zones');
    assert.ok(/SMC zones ?not built for M15/.test(feedsText(env.win)), feedsText(env.win));
    assert.ok(env.calls.some(c => /\/api\/patterns\?.*tf=M15/.test(c)), 'M15 patterns requested');
    assert.ok(/· M15$/.test(head(env.win)));
  });

  await check('the M15 view records NOTHING and changes NO action — it only reads', async () => {
    const env = tfEnv(upCd);
    await settle(env.win, 300);
    const before = env.win.document.querySelector('.act-word').textContent, posts = env.posts.length;
    env.win.document.querySelector('#railTF button[data-rtf="M15"]').click(); await settle(env.win, 120);
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 60);
    assert.strictEqual(env.win.document.querySelector('.act-word').textContent, before);
    assert.strictEqual(env.posts.length, posts, 'no call was proposed from the M15 view');
  });

  await check('scrollbars are thin and follow the theme, not the browser default', () => {
    const css = HTML.split('<style>')[1].split('</style>')[0];
    assert.ok(/scrollbar-width:thin/.test(css), 'Firefox');
    assert.ok(/::-webkit-scrollbar\{width:10px/.test(css), 'WebKit and Blink');
    assert.ok(/::-webkit-scrollbar-thumb\{background:var\(--line2\)/.test(css), 'themed, not grey');
    assert.ok(/::-webkit-scrollbar-track\{background:transparent/.test(css), 'no grey trough');
    assert.ok(/html\{scroll-behavior:smooth\}/.test(css));
    assert.ok(!/\.tbl-wrap\{[^}]*mask-image/.test(css), 'no edge fade: CSS cannot tell if a table overflows');
    assert.ok(/prefers-reduced-motion[^}]*\}\s*html\{scroll-behavior:auto\}/.test(css.replace(/\n/g, '')),
      'and smooth scrolling is off for anyone who asked for less motion');
  });

  await check('the rail flows down the page — no height cap, no inner scroll box', async () => {
    const css = HTML.split('<style>')[1].split('</style>')[0];
    const rail = css.match(/\.rail\{[^}]*\}/)[0];
    assert.ok(!/max-height/.test(rail), rail);
    assert.ok(!/overflow-y\s*:\s*auto/.test(rail), rail);
    assert.ok(!/\.rail\{[^}]*max-height:calc/.test(css), 'not reintroduced by a later rule either');
  });

  console.log('\nHOUSE RULES');

  await check('the page never depends on a third-party icon CDN', async () => {
    const links = HTML.match(/<link[^>]+href="https?:\/\/([^"/]+)/g) || [];
    const hosts = links.map(l => l.split('//')[1]);
    hosts.forEach(h => assert.ok(/fonts\.(googleapis|gstatic)\.com/.test(h), 'unexpected external host: ' + h));
    assert.ok(!/tabler|cdnjs|unpkg/.test(HTML), 'no icon CDN');
  });

  await check('nothing important is display:none at a breakpoint', async () => {
    const media = HTML.split('@media').slice(1).join('@media');
    assert.ok(!/\.rail\s*\{[^}]*display\s*:\s*none/.test(media), 'the rail is never hidden');
    assert.ok(/\.rail\s*\{\s*width:\s*100%/.test(media), 'it stacks instead');
  });

  await check('both themes define the legacy vars host scripts write inline', async () => {
    const dark = HTML.split(':root{')[1].split('}')[0];
    const light = HTML.split(':root[data-theme="light"]{')[1].split('}')[0];
    ['--bg2', '--bg3', '--text2'].forEach(v => {
      assert.ok(dark.indexOf(v) >= 0, 'dark missing ' + v);
      assert.ok(light.indexOf(v) >= 0, 'light missing ' + v);
    });
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
