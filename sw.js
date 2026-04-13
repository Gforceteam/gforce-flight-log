const CACHE = 'gforce-v7';
const APP = '/checklist/';
const VERSION_URL = APP + 'version.json';

// Static assets that change rarely and are safe to cache long-term
const STATIC = [
  APP,
  APP + 'gforce.html',
  APP + 'manifest.json',
  APP + 'icon-192.png',
  APP + 'icon-512.png',
  APP + 'version.json',
];

// Check version on install and every 24h after
async function checkVersion() {
  try {
    const resp = await fetch(VERSION_URL + '?t=' + Date.now());
    if (!resp.ok) return;
    const info = await resp.json();
    const last = localStorage.getItem('gforce_version_notified') || '';
    if (info.version && info.version !== last) {
      localStorage.setItem('gforce_version_notified', info.version);
      // Notify all clients that a new version is available
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(c => c.postMessage({ type: 'VERSION_UPDATE', version: info.version }));
    }
  } catch (_) {}
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
  e.waitUntil(checkVersion());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
  // Recheck version on activation
  e.waitUntil(checkVersion());
  // Also schedule a recheck in 24h
  setInterval(checkVersion, 24 * 60 * 60 * 1000);
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Only intercept same-origin requests within our app path
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/checklist')) return;

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
          caches.match(e.request)
            .then(c => c || caches.match(APP + 'gforce.html'))
            .then(c => c || new Response('<h1>Offline</h1><p>Please reconnect to use GForce.</p>', { headers: { 'Content-Type': 'text/html' } }))
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
      icon: '/checklist/icon-192.png',
      badge: '/checklist/icon-192.png',
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
      const appClient = cs.find(c => c.url.includes('/checklist'));
      if (appClient) return appClient.focus();
      return clients.openWindow(APP + 'gforce.html');
    })
  );
});
