/* ═══════════════════════════════════════════════════════════════
   bw-error-reporter.js — reports errors that happen on the user's
   device to /api/client-error.

   Add to every page, as the FIRST script in <head>:
       <script src="/bw-error-reporter.js" data-module="assistant"></script>

   First, deliberately: an error thrown by a script loaded before this
   one is an error nobody hears about. Errors are queued until the page
   is ready, so even a failure during parsing is captured.

   Serve it from app.js:
       app.get('/bw-error-reporter.js', (req,res) =>
         res.type('js').sendFile(path.join(__dirname,'bw-error-reporter.js')));

   Rules this follows:
   * Never throws. A reporter that breaks the page it watches is worse
     than no reporter.
   * Never reports its own failures — that is how you get a loop.
   * Caps at 12 reports per page load. A render loop firing an error
     every frame must not become a denial of service on your own API.
   * Sends no page content, no form values, no tokens. Message, source,
     line, and which module — nothing else.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var MAX_PER_PAGE = 12;
  var sent = 0;
  var recent = {};                 // dedupe within this page load
  var script = document.currentScript;
  var MODULE = (script && script.getAttribute('data-module')) || 'unknown';
  var ENDPOINT = '/api/client-error';

  function userId() {
    // Best effort only. Absent for signed-out pages, which is fine —
    // an anonymous report still names the bug.
    try {
      var t = sessionStorage.getItem('bw-dash-token') || sessionStorage.getItem('sb-access-token');
      if (!t) return null;
      var p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return p.sub || null;
    } catch (e) { return null; }
  }

  function report(message, source, line) {
    try {
      if (sent >= MAX_PER_PAGE || !message) return;
      // Ignore our own network failures, or a broken endpoint would
      // report itself in a loop until the cap is hit.
      if (String(source || '').indexOf('bw-error-reporter') !== -1) return;
      if (String(message).indexOf(ENDPOINT) !== -1) return;

      var key = String(message).slice(0, 120) + '|' + line;
      if (recent[key]) return;
      recent[key] = 1;
      sent += 1;

      var body = JSON.stringify({
        message: String(message).slice(0, 500),
        source:  source ? String(source).slice(0, 300) : null,
        line:    line || null,
        module:  MODULE,
        userId:  userId()
      });

      if (navigator.sendBeacon) {
        // Survives the page being closed, which is exactly when a fatal
        // error tends to happen.
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      } else {
        fetch(ENDPOINT, {
          method: 'POST', keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: body
        })['catch'](function () {});
      }
    } catch (e) { /* never throw from in here */ }
  }

  window.addEventListener('error', function (e) {
    // A failed <script>/<img>/<link> fires an error event on the element
    // rather than a message — that is how the blocked icon CDN showed up.
    if (e && e.target && e.target !== window && (e.target.src || e.target.href)) {
      report('Failed to load ' + (e.target.tagName || 'resource') + ': ' +
             String(e.target.src || e.target.href).slice(0, 200), 'resource', 0);
      return;
    }
    report(e && e.message, e && e.filename, e && e.lineno);
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    report('Unhandled promise rejection: ' + (r && r.message ? r.message : String(r)),
           r && r.stack ? String(r.stack).split('\n')[1] : null, 0);
  });

  // console.error is where most real failures surface in this codebase —
  // caught exceptions that were logged and swallowed.
  var realError = console.error;
  console.error = function () {
    try {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        parts.push(a && a.message ? a.message : (typeof a === 'object' ? JSON.stringify(a).slice(0, 200) : String(a)));
      }
      report(parts.join(' '), 'console.error', 0);
    } catch (e) {}
    return realError.apply(console, arguments);
  };

  window.bwReportError = report;   // for deliberate reporting
})();
