const CACHE = 'gforce-v1';
const APP_PATH = '/gforce-flight-log/';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => {
      return c.addAll([
        APP_PATH + 'index.html',
        APP_PATH + 'manifest.json',
        APP_PATH + 'icon-192.png',
        APP_PATH + 'icon-512.png',
      ]);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Only handle requests for our app
  const url = new URL(e.request.url);
  if (!url.pathname.startsWith(APP_PATH)) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        // Cache successful responses
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      }).catch(() => {
        // For navigation requests, fallback to index.html
        if (e.request.mode === 'navigate') {
          return caches.match(APP_PATH + 'index.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});