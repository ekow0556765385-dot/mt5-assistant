// test-shell.js — does the real dashboard shell open Arbiter the same way it opens the Brain?
'use strict';
const assert = require('assert');
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const HTML = fs.readFileSync(__dirname + '/out/blackwood_dashboard.html', 'utf8');

const vc = new VirtualConsole();           // swallow the shell's own console noise
const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://app.test/dashboard',
  pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(win) {
    // every endpoint the shell calls during boot answers politely
    win.fetch = (url) => Promise.resolve({ ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ ok: true, ticket: 'T123', plan: 'pro', user: { id: 'u1' } }),
      text: () => Promise.resolve('{}') });
    win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {} });
  } });
const win = dom.window, doc = win.document;

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const frameFor = path => Array.from(doc.querySelectorAll('iframe'))
  .find(f => (f.getAttribute('src') || '').split('?')[0].replace(/^https?:\/\/[^/]+/, '') === path);

(async () => {
  await wait(300);
  console.log('\nTHE SHELL');

  await check('Arbiter appears in the sidebar, under Trading Brain', () => {
    const items = Array.from(doc.querySelectorAll('.nav-item')).map(b => b.dataset.path);
    const a = items.indexOf('/arbiter'), b = items.indexOf('/brain');
    assert.ok(a >= 0, 'no Arbiter button: ' + items.join(' '));
    assert.strictEqual(a, b + 1, 'directly under the Brain');
  });

  await check('its icon rule exists and is an inline SVG mask (no CDN)', () => {
    assert.ok(/\.ti-scale\{-webkit-mask-image:url\('data:image\/svg\+xml,/.test(HTML));
  });

  await check('clicking the Brain opens an iframe — the reference behaviour', async () => {
    doc.querySelector('.nav-item[data-path="/brain"]').click();
    await wait(300);
    assert.ok(frameFor('/brain'), 'brain frame: ' + Array.from(doc.querySelectorAll('iframe')).map(f => f.getAttribute('src')).join(' | '));
  });

  await check('clicking Arbiter opens an iframe at /arbiter, the same way', async () => {
    doc.querySelector('.nav-item[data-path="/arbiter"]').click();
    await wait(300);
    const f = frameFor('/arbiter');
    assert.ok(f, 'arbiter frame: ' + Array.from(doc.querySelectorAll('iframe')).map(x => x.getAttribute('src')).join(' | '));
    assert.notStrictEqual(f.style.display, 'none', 'and it is the visible one');
    assert.strictEqual(frameFor('/brain').style.display, 'none', 'the Brain is hidden, not destroyed');
  });

  await check('the Arbiter src carries a ticket exactly as the Brain src does', () => {
    const q = s => (s.split('?')[1] || '').replace(/=[^&]*/g, '=');
    assert.strictEqual(q(frameFor('/arbiter').getAttribute('src')), q(frameFor('/brain').getAttribute('src')));
  });

  await check('the title bar names it', () => {
    assert.ok(/arbiter/i.test(doc.getElementById('url-display').textContent));
  });

  await check('Ctrl+6 opens it', async () => {
    doc.querySelector('.nav-item[data-path="/"]').click(); await wait(150);
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: '6', ctrlKey: true, bubbles: true }));
    await wait(200);
    assert.ok(doc.querySelector('.nav-item[data-path="/arbiter"]').classList.contains('active'));
  });

  await check('another module can open it by postMessage', async () => {
    doc.querySelector('.nav-item[data-path="/"]').click(); await wait(150);
    win.dispatchEvent(new win.MessageEvent('message', { data: { bw: 'open', module: 'arbiter' }, origin: 'https://app.test' }));
    await wait(250);
    const f = frameFor('/arbiter');
    assert.ok(f && f.style.display !== 'none', 'the Arbiter frame is the visible one');
    // NOTE, not asserted: the sidebar highlight does NOT follow a postMessage
    // open, for ANY module. The handler calls loadPath() directly and only
    // loadTool() moves the highlight. Pre-existing; reported, not changed.
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
