const CACHE = 'gforce-v4';
const APP = '/gforce-flight-log/';

// Static assets that change rarely and are safe to cache long-term
const STATIC = [
  APP + 'manifest.json',
  APP + 'icon-192.png',
  APP + 'icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Delete old caches (v1, v2, v3, etc.)
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Only intercept same-origin requests within our app path
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/gforce-flight-log')) return;

  // HTML (navigate) — network first so updates are always visible on refresh
  // Fall back to cache only when genuinely offline
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          if (resp.ok) {
            caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
          }
          return resp;
        })
        .catch(() =>
          caches.match(e.request).then(c => c || caches.match(APP + 'index.html'))
        )
    );
    return;
  }

  // Static assets (icons, manifest) — cache first, network fallback
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp.ok) caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
        return resp;
      }).catch(() => new Response('', { status: 503 }));
    })
  );
});

// ─── Push notification handler ────────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: '🪂 GForce — YOU\'RE AWAY!', body: 'Office has started your timer.' };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch (_) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/gforce-flight-log/icon-192.png',
      badge: '/gforce-flight-log/icon-192.png',
      vibrate: [600, 200, 600, 200, 1000],
      requireInteraction: data.requireInteraction !== false,
      tag: data.tag || 'pilot-sent-away',
      data: { url: APP }
    })
  );
});

// When pilot taps the system notification, focus or open the app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      const appClient = cs.find(c => c.url.includes('/gforce-flight-log/'));
      if (appClient) return appClient.focus();
      return clients.openWindow(APP);
    })
  );
});
