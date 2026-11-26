// Service worker: makes the hub installable and opens it offline with the last loaded news.
// Bump VERSION whenever index.html, app.css, app.js or the Oat files change.
const VERSION = 'mh-v1';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'vendor/oat/oat.min.css',
  'vendor/oat/oat.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // News data: always try the network first, fall back to the last copy.
  if (url.pathname.endsWith('/data/news.json')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(new Request(url.pathname), copy));
          return res;
        })
        .catch(() => caches.match(new Request(url.pathname)))
    );
    return;
  }

  // App files: serve from cache, refresh in the background.
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request).then((res) => {
        if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
