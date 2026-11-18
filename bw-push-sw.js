/* bw-push-sw.js — Blackwood's alerts on this device (Nov 2026, Phase 2a).
   It does one thing: show an alert the server sends when Blackwood is closed or this
   is a phone, and open the dashboard when it is tapped. It caches nothing and runs
   none of the dashboard's code. The Arbiter keeps its own worker (arbiter-sw.js). */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'Blackwood', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Blackwood', {
    body: d.body || '',
    icon: '/bw-icon-192.png',
    tag: d.tag || 'blackwood',
    renotify: true,
    requireInteraction: !!d.urgent,
    data: { url: d.url || '/dashboard' }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/dashboard';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    if (url.indexOf('/dashboard') === 0) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf('/dashboard') >= 0 && 'focus' in list[i]) return list[i].focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
