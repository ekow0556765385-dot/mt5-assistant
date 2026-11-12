/**
 * bw-source.js — feed switcher, shared by every Blackwood dashboard.
 *
 * One account can hold more than one licence key: a direct-WebRequest
 * terminal and a file-bridge terminal are two separate FEEDS even though
 * they belong to the same login. The server keys all data by
 * user + licence key, and every read route accepts ?source=<id>.
 *
 * Rather than edit every fetch() in six dashboards, this wraps fetch and
 * WebSocket so the active source is appended automatically. Each page only
 * needs one <script src="/bw-source.js"></script> tag; nothing else in the
 * page changes, and a page with a single feed behaves exactly as before.
 */
(function () {
  'use strict';

  var KEY      = 'bw-active-source';
  var SCOPED   = ['/api/state', '/api/alerts', '/api/candles', '/api/multi-candles',
                  '/api/live-patterns', '/api/patterns', '/api/math-data',
                  '/smc', '/confluence'];
  var active   = null;
  var sources  = [];

  // ── Tab pass (Nov 2026) ─────────────────────────────────────────
  // The login cookie is ONE per browser, so two accounts open in two tabs
  // shared it and each saw whichever account touched the server last.
  // The server now hands every dashboard TAB its own signed pass (the
  // X-BW-Tab response header on /api/ticket). It is kept in this tab's
  // sessionStorage — which the shell and the modules framed inside it
  // share, and no other tab does — and sent back on every request to our
  // own server, where it decides whose data is returned.
  var TAB_KEY = 'bw-tab-pass', TAB_HDR = 'X-BW-Tab';
  function tabPass() { try { return sessionStorage.getItem(TAB_KEY) || ''; } catch (e) { return ''; } }
  function keepPass(r) {
    try { var p = r && r.headers && r.headers.get(TAB_HDR); if (p) sessionStorage.setItem(TAB_KEY, p); } catch (e) {}
    return r;
  }
  // Whose tab this is, read from the pass (not secret, and not trusted for
  // anything: it only labels this browser's own saved items, below).
  var uidFor = '', uidIs = '';
  function tabUid() {
    var p = tabPass();
    if (p === uidFor) return uidIs;
    uidFor = p; uidIs = '';
    try {
      var b = p.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      uidIs = String(JSON.parse(atob(b)).uid || '');
    } catch (e) {}
    return uidIs;
  }
  // A fresh sign-in arriving in this tab (/dashboard?token=…): whatever pass
  // the tab held belonged to the previous sign-in. Drop it; the first ticket
  // brings the new one.
  try {
    if (window.top === window && /[?&]token=/.test(window.location.search)) sessionStorage.removeItem(TAB_KEY);
  } catch (e) {}

  // ── Saved items, kept per account ───────────────────────────────
  // localStorage is also one per browser. The modules keep readings there
  // for each other (Risk Radar, the Combined Read, the sidebar's attention
  // dots…) plus logs and history, so a second account in the same browser
  // read the first one's. Every Blackwood key is now stored under the
  // account it belongs to. No page changes: they keep using the same names.
  // An item saved before this existed is taken over by the first account
  // that reads it, and is then that account's alone. The theme stays shared.
  (function () {
    var P = window.Storage && window.Storage.prototype;
    if (!P || P.__bwPerAccount) return;
    var get = P.getItem, set = P.setItem, del = P.removeItem;
    function own(store, k) {
      try { if (store !== window.localStorage) return null; } catch (e) { return null; }
      k = String(k);
      if (k === 'bw-theme' || !(k.indexOf('bw-') === 0 || k.indexOf('mt5_') === 0)) return null;
      var u = tabUid(); if (!u) return null;
      var suf = '::' + u;
      return k.slice(-suf.length) === suf ? null : k + suf;
    }
    P.getItem = function (k) {
      var n = own(this, k);
      if (!n) return get.call(this, k);
      var v = get.call(this, n);
      if (v !== null) return v;
      var old = get.call(this, k);
      if (old !== null) { try { set.call(this, n, old); del.call(this, k); } catch (e) {} }
      return old;
    };
    P.setItem = function (k, v) { return set.call(this, own(this, k) || k, v); };
    P.removeItem = function (k) { return del.call(this, own(this, k) || k); };
    P.__bwPerAccount = true;
  })();

  function isScoped(pathname) {
    for (var i = 0; i < SCOPED.length; i++) {
      if (pathname === SCOPED[i] || pathname.indexOf(SCOPED[i] + '/') === 0) return true;
    }
    return false;
  }

  // ── fetch wrapper ───────────────────────────────────────────────
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var same = false;
    try {
      // This tab's pass, on every call to OUR server and nothing else.
      var target = new URL(
        typeof input === 'string' ? input : ((input && (input.url || input.href)) || String(input)),
        window.location.origin
      );
      same = target.origin === window.location.origin;
      var pass = same ? tabPass() : '';
      if (pass) {
        var hdrs = new Headers((init && init.headers) ||
                               (typeof input !== 'string' && input && input.headers) || {});
        if (!hdrs.has(TAB_HDR)) {
          hdrs.set(TAB_HDR, pass);
          init = Object.assign({}, init || {}, { headers: hdrs });
        }
      }
    } catch (e) { /* send it through as it came */ }
    try {
      if (active) {
        var url = new URL(
          typeof input === 'string' ? input : input.url,
          window.location.origin
        );
        // Only same-origin API reads. Never touch Supabase, Telegram, or
        // any third-party call, and never override an explicit ?source=.
        if (url.origin === window.location.origin &&
            isScoped(url.pathname) &&
            !url.searchParams.has('source')) {
          url.searchParams.set('source', active);
          if (typeof input === 'string') input = url.toString();
          else input = new Request(url.toString(), input);
        }
      }
    } catch (e) { /* malformed URL — send it through untouched */ }
    var sent = nativeFetch(input, init);
    // A new or renewed pass comes back on the response; the response itself
    // is handed on untouched.
    return same ? sent.then(keepPass) : sent;
  };

  // ── WebSocket wrapper ───────────────────────────────────────────
  // The socket binds server-side to one feed, so the id has to be on the
  // handshake URL — a query param can't be added after connecting.
  var NativeWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    try {
      if (active && String(url).indexOf('source=') === -1) {
        url += (String(url).indexOf('?') === -1 ? '?' : '&') +
               'source=' + encodeURIComponent(active);
      }
    } catch (e) {}
    try {
      // The live connection cannot carry a header, so this tab's pass goes
      // on its address — to our own server only.
      var pass = tabPass();
      if (pass && String(url).indexOf('bwtab=') === -1 &&
          new URL(String(url), window.location.href).host === window.location.host) {
        url += (String(url).indexOf('?') === -1 ? '?' : '&') +
               'bwtab=' + encodeURIComponent(pass);
      }
    } catch (e) {}
    return protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
  }
  PatchedWS.prototype = NativeWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
    PatchedWS[k] = NativeWS[k];
  });
  window.WebSocket = PatchedWS;

  // ── Switcher UI ─────────────────────────────────────────────────
  function label(s) {
    var parts = [];
    if (s.account) parts.push('Account ' + s.account);
    else parts.push('Key ****' + (s.keyTail || '????'));
    if (s.transport) parts.push(s.transport === 'bridge' ? 'File bridge' : 'Direct');
    if (s.server) parts.push(s.server);
    return parts.join(' · ');
  }

  function render() {
    // A single feed needs no switcher — showing one is just noise.
    if (sources.length < 2) return;
    if (document.getElementById('bw-source-bar')) return;

    var bar = document.createElement('div');
    bar.id = 'bw-source-bar';
    bar.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:99999;display:flex;' +
      'align-items:center;gap:10px;padding:7px 14px;font:500 12px/1.4 Inter,system-ui,sans-serif;' +
      'background:#14141c;color:#eceae0;border-bottom:1px solid #2e2e3e;';

    var lbl = document.createElement('span');
    lbl.textContent = 'Feed';
    lbl.style.cssText = 'color:#9a9890;text-transform:uppercase;letter-spacing:.08em;font-size:10px;';

    var sel = document.createElement('select');
    sel.style.cssText =
      'background:#0f0f16;color:#eceae0;border:1px solid #2e2e3e;border-radius:6px;' +
      'padding:4px 9px;font:inherit;cursor:pointer;max-width:60vw;';
    sources.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.sourceId;
      o.textContent = label(s);
      if (s.sourceId === active) o.selected = true;
      sel.appendChild(o);
    });

    // A full reload is deliberate: every panel on these pages caches its
    // own copy of the feed data, so re-fetching piecemeal would leave
    // stale numbers behind. Reloading guarantees one consistent feed.
    sel.onchange = function () {
      // Remember locally for an instant reload, AND tell the server so the
      // choice follows this ACCOUNT to any other device. sessionStorage
      // alone is per-tab and per-device: on a phone it is empty, the page
      // fell back to "most recently seen terminal", and you could end up
      // with the account page showing one feed and the dashboard another.
      try { sessionStorage.setItem(KEY, sel.value); } catch (e) {}
      window.fetch('/api/preferred-source', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: sel.value })
      }).catch(function () { /* local choice still applies this session */ })
        .then(function () { window.location.reload(); });
    };

    var note = document.createElement('span');
    note.textContent = sources.length + ' terminals connected';
    note.style.cssText = 'color:#72706a;font-size:11px;margin-left:auto;';

    bar.appendChild(lbl); bar.appendChild(sel); bar.appendChild(note);
    document.body.appendChild(bar);
    document.body.style.paddingTop =
      (parseInt(getComputedStyle(document.body).paddingTop, 10) || 0) + 34 + 'px';
  }

  // ── Boot ────────────────────────────────────────────────────────
  // Runs BEFORE the page's own scripts fetch anything, so the very first
  // request already carries the right source.
  window.bwSourceReady = window.fetch('/api/sources', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : { sources: [] }; })
    .then(function (data) {
      sources = data.sources || [];
      var saved = null;
      try { saved = sessionStorage.getItem(KEY); } catch (e) {}

      // Order matters. A saved local pick wins (the user chose it in this
      // tab), then the server's remembered preference for this ACCOUNT,
      // then whatever the server resolved, then the first feed. The
      // account-level preference is what makes a phone with empty storage
      // land on the same feed as the desktop instead of guessing.
      var validSaved = sources.some(function (s) { return s.sourceId === saved; });
      var pref       = data.preferred;
      var validPref  = sources.some(function (s) { return s.sourceId === pref; });
      active = validSaved ? saved
             : validPref  ? pref
             : (data.active || (sources[0] || {}).sourceId || null);

      // Deliberately NOT seeding sessionStorage here any more.
      //
      // Seeding cached whatever was auto-picked, including the server's
      // "most recently seen terminal" guess. Once written it looked like a
      // deliberate user choice and won on every later load — so an account
      // that guessed wrong once stayed wrong permanently, which is why the
      // WebRequest account kept showing the file-bridge feed. Only an
      // explicit pick in the switcher is stored (see sel.onchange).

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', render);
      } else {
        render();
      }
      return active;
    })
    .catch(function () { return null; });

  window.bwActiveSource = function () { return active; };
})();
