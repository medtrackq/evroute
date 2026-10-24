// Lets EVROUTE be installed to the home screen and open without a connection. Pages and files come
// from the network first (so a new deploy shows at once), with the last copy kept for offline use.
// Live data (/api/...) is never cached here.
const CACHE = 'evroute-v2';
const SHELL = ['./', 'index.html', 'assets/css/style.css', 'assets/js/i18n.js', 'assets/js/app.js', 'assets/js/plan.js', 'assets/js/cars.js', 'assets/js/mapview.js', 'assets/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then((hit) => hit || (e.request.mode === 'navigate' ? caches.match('./') : Response.error()))));
});
