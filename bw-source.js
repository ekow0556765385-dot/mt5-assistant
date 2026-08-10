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

  function isScoped(pathname) {
    for (var i = 0; i < SCOPED.length; i++) {
      if (pathname === SCOPED[i] || pathname.indexOf(SCOPED[i] + '/') === 0) return true;
    }
    return false;
  }

  // ── fetch wrapper ───────────────────────────────────────────────
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
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
    return nativeFetch(input, init);
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
      nativeFetch('/api/preferred-source', {
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
  window.bwSourceReady = nativeFetch('/api/sources', { credentials: 'same-origin' })
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

      // Seed this tab so later reads agree without another round-trip.
      if (active) { try { sessionStorage.setItem(KEY, active); } catch (e) {} }

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
