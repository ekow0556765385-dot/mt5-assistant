/* arbiter-sw.js — Arbiter's service worker (N-3). It does one thing: show Arbiter's alert on this device when
   no Arbiter page is open, and open Arbiter when the alert is tapped. It caches nothing and runs no code of
   the page — it cannot change what Arbiter decides. */
self.addEventListener('push', function (e) {
  var d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'Arbiter', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Arbiter', {
    body: d.body || '', tag: d.title || 'arbiter', renotify: true, data: { url: d.url || '/arbiter' } }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/arbiter';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if (list[i].url.indexOf('/arbiter') >= 0 && 'focus' in list[i]) return list[i].focus();
    return self.clients.openWindow(url);
  }));
});
