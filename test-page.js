// test-page.js — Phase 3. Run: node test-page.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const results = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ok   ' + name); },
    e => { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  );
}

const HTML = fs.readFileSync(path.join(__dirname, 'arbiter.html'), 'utf8');
const ENGINE = fs.readFileSync(path.join(__dirname, 'arbiter-engine.js'), 'utf8');
const FEEDS = fs.readFileSync(path.join(__dirname, 'arbiter-feeds.js'), 'utf8');

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
    '/api/journal': over.journal !== undefined ? over.journal : {
      entries: Array.from({ length: 40 }, (_, i) => ({ symbol: 'EURUSD', direction: 'sell',
        total_pl: i % 3 ? 20 : -15, session: null }))
    }
  };

  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://app.test/arbiter', pretendToBeVisual: true });
  const win = dom.window;
  const calls = [];
  win.fetch = (url) => {
    const u = String(url); calls.push(u);
    const key = Object.keys(routes).find(k => u.split('?')[0] === k);
    const body = key ? routes[key] : null;
    return Promise.resolve({ ok: body !== null, status: body ? 200 : 404, json: () => Promise.resolve(body) });
  };
  // the page's own scripts, in load order
  win.eval(ENGINE);
  win.eval(FEEDS);
  const inline = HTML.split('<script>')[1].split('</script>')[0];
  win.eval(inline);
  return { dom, win, calls, routes, state };
}

const settle = (win, ms = 60) => new Promise(r => setTimeout(r, ms));
const txt = win => win.document.getElementById('main').textContent.replace(/\s+/g, ' ');

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
    assert.ok(/Nothing is open/.test(txt(win)));
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
    const t = win.document.body.textContent;
    ['NaN', 'undefined', '[object Object]'].forEach(bad => assert.ok(t.indexOf(bad) < 0, 'found ' + bad));
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
    const env = makeEnv();
    await settle(env.win, 120);
    const first = env.win.document.querySelector('.act-word').textContent;
    // one cycle with a counter-pattern, then back
    env.routes['/api/patterns'] = { patterns: [
      { name: 'Bearish Engulfing', type: 'bearish', confidence_pct: 81, bar_index: 1 },
      { name: 'Bullish Engulfing', type: 'bullish', confidence_pct: 85, bar_index: 1 }] };
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 100);
    assert.strictEqual(env.win.document.querySelector('.act-word').textContent, first,
      'the first cycle of a new opinion is held back');
    const pend = env.win.document.querySelector('.act-pending');
    assert.ok(pend && /Moving toward/.test(pend.textContent), 'but the page says it is moving');
  });

  await check('a change that persists IS shown on the second cycle', async () => {
    const env = makeEnv();
    await settle(env.win, 120);
    env.routes['/api/patterns'] = { patterns: [
      { name: 'Bullish Engulfing', type: 'bullish', confidence_pct: 85, bar_index: 1 }] };
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 80);
    await env.win.BWArbiterPage.cycle(); await settle(env.win, 80);
    const word = env.win.document.querySelector('.act-word').textContent;
    assert.ok(/PARTIAL|CUT/.test(word), 'settled into ' + word);
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
