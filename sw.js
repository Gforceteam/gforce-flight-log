const CACHE = 'gforce-v1';
const APP_PATH = '/gforce-flight-log/';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => {
      return c.addAll([
        APP_PATH,
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
  const url = new URL(e.request.url);
  // Only handle requests for our app
  if (!url.pathname.startsWith(APP_PATH) && url.pathname !== '/gforce-flight-log') {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match(APP_PATH + 'index.html')))
  );
});