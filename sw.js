// App shell cache: the pages open without signal; data always comes from the server when it can.
const CACHE = 'pcs-shell-v4';
const SHELL = ['./', './index.html', './styles.css', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png',
  './js/app.js', './js/api.js', './js/ui.js', './js/charts.js', './js/config.js', './js/pack.js',
  './js/pages/auth.js', './js/pages/home.js', './js/pages/requests.js', './js/pages/stock.js', './js/pages/cash.js',
  './js/pages/reports.js', './js/pages/admin.js', './js/pages/account.js', './js/pages/notifications.js', './js/pages/snap.js', './js/pages/install.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // API, storage and CDN calls go straight through
  // network first so updates arrive; cache is the fallback when offline
  e.respondWith(fetch(e.request).then((res) => { if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone())); return res; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html'))));
});

// ---- push: buzz the phone, open the right page on tap ----
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Petty cash', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Petty cash', {
    body: d.body || '', icon: './icon-192.png', badge: './icon-192.png', tag: d.tag || 'petty-cash', renotify: true,
    data: { link: d.link || '#/notifications', id: d.id || null },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const link = (e.notification.data && e.notification.data.link) || '#/notifications';
  const target = new URL('./' + (link.startsWith('#') ? link : '#' + link), self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if (c.url.startsWith(self.registration.scope)) { c.navigate(target); return c.focus(); } }
    return self.clients.openWindow(target);
  }));
});
