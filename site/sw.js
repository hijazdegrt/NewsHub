// Service worker: makes the hub installable and opens it offline with the last loaded copy.
// Everything is fetched from the network first, so a new version shows up on the next
// load. The cache is only used when the network fails or takes longer than 4 seconds.
const VERSION = 'mh-v4';
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
const TIMEOUT_MS = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
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

  // One cache entry per path (ignores ?t= cache-busting on news.json).
  const key = new Request(url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname);

  const network = fetch(url.href, { cache: 'no-cache' }).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(key, copy));
    }
    return res;
  });
  const fallback = () => caches.match(key).then((hit) => hit || caches.match(e.request));
  const slow = new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS)).then(fallback);

  e.respondWith(
    Promise.race([network.catch(fallback), slow.then((hit) => hit || network)])
      .then((res) => res || network)
  );
});
