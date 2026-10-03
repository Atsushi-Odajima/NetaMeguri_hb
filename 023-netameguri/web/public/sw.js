// NetaMeguri service worker: app shell cache + limited offline reads.
// Writes are never replayed by the SW (the app's offline queue handles Quick Capture / Draft edits explicitly).
const VERSION = 'cl-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/favicon.svg'];
// GET endpoints that may be shown from cache when offline (clearly marked as cached)
const OFFLINE_READ = [/\/api\/auth\/me$/, /\/api\/w\/[^/]+$/, /\/api\/w\/[^/]+\/(dashboard|calendar|content|ideas-memory|inbox|connectors)(\?.*)?$/, /\/api\/w\/[^/]+\/content\/[^/]+$/];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/media/')) return;
  if (url.pathname.startsWith('/api/')) {
    if (!OFFLINE_READ.some((r) => r.test(url.pathname + url.search))) return;
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(req);
          if (!hit) return new Response(JSON.stringify({ error: 'offline', message: 'オフラインのため取得できません' }), { status: 503, headers: { 'content-type': 'application/json' } });
          const body = await hit.text();
          return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'x-from-cache': '1' } });
        }),
    );
    return;
  }
  // navigation: network first, fallback to cached shell
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/index.html')));
    return;
  }
  // static assets: cache first
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/'))) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
