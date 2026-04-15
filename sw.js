const CACHE = 'gforce-v17';

// Resolve all assets relative to this service worker (works on GitHub Pages /repo-name/ and at domain root).
const SW_DIR = new URL('.', self.location);
const VERSION_URL = new URL('version.json', SW_DIR).href;
const INDEX_URL = new URL('index.html', SW_DIR).href;
const ICON_192_URL = new URL('icon-192.png', SW_DIR).href;

const STATIC = [
  SW_DIR.href,
  INDEX_URL,
  new URL('manifest.json', SW_DIR).href,
  new URL('icon-192.png', SW_DIR).href,
  new URL('icon-512.png', SW_DIR).href,
  new URL('version.json', SW_DIR).href,
  new URL('changelog.json', SW_DIR).href,
];

const SW_PREFIX = SW_DIR.pathname.replace(/\/$/, '');

function isAppPath(pathname) {
  if (!SW_PREFIX) return true;
  return pathname === SW_PREFIX || pathname.startsWith(SW_PREFIX + '/');
}

// Check version and notify all open clients if a newer version exists.
// NOTE: localStorage is NOT available in service worker scope — version dedup
// is intentionally omitted here; the main app handles duplicate banner suppression.
async function checkVersion() {
  try {
    const resp = await fetch(VERSION_URL + '?t=' + Date.now());
    if (!resp.ok) return;
    const info = await resp.json();
    if (!info.version) return;
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'VERSION_UPDATE', version: info.version }));
  } catch (_) {}
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC))
      .then(() => checkVersion())
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => checkVersion())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (url.origin !== self.location.origin) return;
  if (!isAppPath(url.pathname)) return;

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
            .then(c => c || caches.match(INDEX_URL))
            .then(c => c || caches.match(SW_DIR.href))
            .then(c => c || new Response('<h1>Offline</h1><p>Please reconnect to use GForce.</p>', { headers: { 'Content-Type': 'text/html' } }))
        )
    );
    return;
  }

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

self.addEventListener('push', e => {
  let data = { title: '🪂 GForce — YOU\'RE AWAY!', body: 'Office has started your timer.' };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch (_) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: ICON_192_URL,
      badge: ICON_192_URL,
      vibrate: [600, 200, 600, 200, 1000],
      requireInteraction: data.requireInteraction !== false,
      tag: data.tag || 'pilot-sent-away',
      data: { url: SW_DIR.href }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      const appClient = cs.find(c => {
        try {
          return isAppPath(new URL(c.url).pathname);
        } catch {
          return false;
        }
      });
      if (appClient) return appClient.focus();
      return clients.openWindow(INDEX_URL);
    })
  );
});
