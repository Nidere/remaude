// remaude service worker: PWA install, push notifications and a warm start.
//
// iOS evicts backgrounded PWAs whenever it likes, so relaunching happens often
// and the cache keeps that relaunch instant. But cache-first on code was a trap:
// a reload kept repainting the previous build, so fixes looked like they had
// never shipped. Code (html/js/css) is therefore network-first with a cache
// fallback for offline; only static assets stay cache-first. Chat data is never
// cached — it always comes live over the WebSocket.

const SHELL = 'remaude-shell-v2';
const CODE_FILES = ['/', '/app.js', '/md.js', '/style.css'];
const ASSET_FILES = ['/manifest.webmanifest', '/icons/icon-192.png'];
const SHELL_FILES = [...CODE_FILES, ...ASSET_FILES];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isShell =
    e.request.method === 'GET' &&
    url.origin === location.origin &&
    (SHELL_FILES.includes(url.pathname) || url.pathname.startsWith('/icons/'));
  if (!isShell) return; // API calls and WebSocket traffic go straight to the network

  const isCode = CODE_FILES.includes(url.pathname);
  e.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const cached = await cache.match(e.request);
      const fresh = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached); // offline: whatever we have is better than nothing
      // code must never lag a deploy; assets may come from cache instantly
      return isCode ? (await fresh) ?? cached : cached ?? fresh;
    })
  );
});

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
