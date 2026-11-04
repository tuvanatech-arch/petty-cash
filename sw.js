// App shell cache: the pages open without signal; data always comes from the server when it can.
const CACHE = 'pcs-shell-__BUILD__';
const SHELL = ['./', './index.html', './styles.css', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './badge-96.png',
  './js/app.js', './js/api.js', './js/ui.js', './js/twostep.js', './js/brand.js', './js/adapt.js', './js/diag.js', './js/share.js', './js/charts.js', './js/config.js', './js/pack.js', './js/learn.js', './js/devices.js', './js/device-label.js', './js/schedule-meta.js', './js/schedule-pdf.js',
  './js/pages/auth.js', './js/pages/home.js', './js/pages/requests.js', './js/pages/stock.js', './js/pages/cash.js',
  './js/pages/reports.js', './js/pages/admin.js', './js/pages/schedule.js', './js/pages/overview.js', './js/export.js', './js/branch.js', './js/pages/account.js', './js/pages/notifications.js', './js/pages/snap.js', './js/pages/install.js', './js/pages/updates.js', './js/tour.js', './js/live.js', './js/scan.js', './js/proofs.js', './js/version.js', './js/keep.js', './js/usage.js', './js/password.js'];

const BUILD = CACHE.slice('pcs-shell-'.length);
// Installing a new version: each file is fetched on its own, so one file that fails on a weak signal does not stop
// the whole update (the page fetches anything missing later). The app's modules are also kept under the exact
// address this version asks for (…/app.js?v=<build>), so the next start finds them without the network.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map(async (u) => {
    const res = await fetch(new Request(u, { cache: 'reload' }));
    if (!res.ok) return;
    await c.put(u, res.clone());
    if (u.endsWith('.js')) await c.put(`${u}?v=${BUILD}`, res.clone());
  }))).then(() => self.skipWaiting()));
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
  if (e.request.cache === 'no-store') return;   // a deliberate question to the server (the update check): never answered from the copy
  // the app's modules carry the build in their address (…?v=<build>) and never change: the kept copy is used at once,
  // and the network only when this version's copy is missing. One page therefore only ever runs one version.
  if (url.searchParams.has('v')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))));
    return;
  }
  // the page itself, styles, pictures: network first, revalidated ('no-cache'). On a weak signal the kept copy is used
  // after 4 s – and the answer that arrives late still refreshes the copy, so the next start has the newest version.
  // (a navigation request cannot be re-built with options – the browser throws; files can)
  const fresh = e.request.mode === 'navigate' ? e.request : new Request(e.request, { cache: 'no-cache' });
  const net = fetch(fresh).then((res) => {
    if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  });
  e.waitUntil(net.then(() => {}, () => {}));   // keep working until the late answer is stored
  const slow = new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 4000));
  e.respondWith(Promise.race([net, slow]).catch(() => caches.match(e.request, { ignoreSearch: true })
    .then((hit) => hit || (e.request.mode === 'navigate' ? caches.match('./index.html') : null))
    .then((hit) => hit || net)));
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
