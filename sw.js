const CACHE_NAME = 'image-sequence-sorter-v4';

const APP_SHELL = [
  '.',
  'index.html',
  'sketch.js',
  'style.css',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// Cache-first, falling back to network; successful network responses
// (including third-party CDN assets like p5.js) are cached for next time.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // version.json is regenerated on every deploy - always go to the
  // network so the displayed build number stays current.
  if (new URL(event.request.url).pathname.endsWith('/version.json')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    }).catch(() => caches.match('index.html'))
  );
});
