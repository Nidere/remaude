// remaude service worker: PWA install + receiving push notifications.
// Caching is deliberately absent — the UI is live and light, and stale statics already bit us in dev.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data?.json() ?? {};
  } catch {
    data = { title: 'remaude', body: e.data?.text() ?? '' };
  }
  e.waitUntil(
    self.registration.showNotification(data.title ?? 'remaude', {
      body: data.body ?? '',
      tag: data.tag ?? 'remaude',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url ?? '/' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
      const existing = tabs.find((t) => 'focus' in t);
      return existing ? existing.focus() : self.clients.openWindow(e.notification.data?.url ?? '/');
    })
  );
});
