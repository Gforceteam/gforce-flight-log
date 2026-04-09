const CACHE = 'gforce-v1';
const APP = '/gforce-flight-log/';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll([
      APP,
      APP + 'index.html',
      APP + 'manifest.json',
      APP + 'icon-192.png',
      APP + 'icon-512.png',
    ]))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(caches.delete, caches)))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Only handle app requests
  if (!url.pathname.startsWith(APP) && url.pathname !== APP.slice(0,-1)) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp.ok) {
          const cl = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, cl));
        }
        return resp;
      }).catch(() => {
        if (e.request.mode === 'navigate') {
          return caches.match(APP + 'index.html');
        }
        return new Response('', { status: 503 });
      });
    })
  );
});