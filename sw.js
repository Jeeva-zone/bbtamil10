/**
 * Service worker — network-first with an offline fallback.
 *
 * Network-first on purpose: a stream list or a bug fix should reach the viewer
 * on the next load, never be pinned behind a stale cache. The cache exists only
 * so the app shell still opens when the device is offline.
 */
const CACHE = 'bbtamil10-v1';

const SHELL = [
  './',
  'index.html',
  'player.html',
  'assets/css/app.css',
  'assets/js/app.js',
  'assets/js/data.js',
  'assets/js/player.js',
  'assets/js/util.js',
  'manifest.webmanifest',
  'assets/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return; // never touch third-party streams

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => cached || caches.match('index.html')),
      ),
  );
});
