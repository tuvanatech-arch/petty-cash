// App shell cache: the pages open without signal; data always comes from the server when it can.
const CACHE = 'pcs-shell-__BUILD__';
const SHELL = ['./', './index.html', './styles.css', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png', './badge-96.png',
  './js/app.js', './js/api.js', './js/ui.js', './js/adapt.js', './js/diag.js', './js/share.js', './js/charts.js', './js/config.js', './js/pack.js', './js/learn.js', './js/devices.js', './js/device-label.js',
  './js/pages/auth.js', './js/pages/home.js', './js/pages/requests.js', './js/pages/stock.js', './js/pages/cash.js',
  './js/pages/reports.js', './js/pages/admin.js', './js/pages/account.js', './js/pages/notifications.js', './js/pages/snap.js', './js/pages/install.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'pcs-share').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // "Share → Petty cash" (Android): the shared file is parked in a small cache and the app opens on Snap to collect it
  if (e.request.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const file = form.get('file') || form.get('files');
        if (file && file.size) {
          const cache = await caches.open('pcs-share');
          await cache.put('shared-file', new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name || '') } }));
        }
      } catch (err) { /* nothing shared: just open the app */ }
      return Response.redirect(new URL('./?source=share#/snap?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // API, storage and CDN calls go straight through
  // network first, always revalidated with the server ('no-cache'): the browser can never mix an old module with a new one
  // after a deploy; the shell cache is only the fallback when offline
  // a navigation request cannot be re-built with options (the browser throws); files can
  const fresh = e.request.mode === 'navigate' ? e.request : new Request(e.request, { cache: 'no-cache' });
  // a request that never answers (phone just woke up, dead socket) must not hold the page: after 6 s the cached copy is used
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000));
  e.respondWith(Promise.race([fetch(fresh), timeout]).then((res) => { if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone())); return res; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html'))));
});

// ---- push: buzz the phone, show the count on the icon, open the right page on tap ----
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Petty cash', body: e.data ? e.data.text() : '' }; }
  const shown = self.registration.showNotification(d.title || 'Petty cash', {
    body: d.body || '', icon: './icon-192.png', badge: './badge-96.png',
    tag: d.tag || ('n-' + (d.id || Date.now())), renotify: true,   // one alert per request: a newer one replaces it and buzzes again
    vibrate: [200, 100, 200, 100, 320], silent: false,              // Android vibrates; iPhone uses its own sound/haptic settings
    requireInteraction: !!d.urgent, timestamp: d.at ? Date.parse(d.at) : Date.now(),
    data: { link: d.link || '#/notifications', id: d.id || null },
  });
  // the number on the home-screen icon (iPhone 16.4+, installed desktop apps; Android shows its own dot)
  const nav = self.navigator;
  const badge = typeof d.unread === 'number' && nav && 'setAppBadge' in nav
    ? (d.unread > 0 ? nav.setAppBadge(d.unread) : nav.clearAppBadge()).catch(() => {}) : Promise.resolve();
  // an open copy of the app updates its bell straight away
  const tell = self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => list.forEach((c) => c.postMessage({ type: 'push', unread: d.unread })));
  e.waitUntil(Promise.all([shown, badge, tell]));
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
