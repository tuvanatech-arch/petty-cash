// The service worker's push handling, in real Chromium: a push shows a notification that vibrates, carries the
// status-bar badge, stacks per request, stays up when urgent, sets the number on the app icon, and tells an open app.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve('../web');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/blank.html') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>t</title>'); }
  let p = path.join(root, u); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.grantPermissions(['notifications'], { origin: base });
const page = await ctx.newPage();
await page.goto(`${base}/blank.html`);
const messages = [];
await page.exposeFunction('gotMessage', (m) => messages.push(m));
await page.evaluate(async () => { navigator.serviceWorker.addEventListener('message', (e) => window.gotMessage(e.data)); const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; return !!reg.active; });
await page.reload(); await page.evaluate(() => navigator.serviceWorker.ready); // controlled now
await page.evaluate(() => navigator.serviceWorker.addEventListener('message', (e) => window.gotMessage(e.data)));
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');

// spy on the icon badge inside the worker
await sw.evaluate(() => { self.__shown = []; self.registration.showNotification = (title, opts) => { self.__shown.push({ title, ...opts, vibrate: opts.vibrate }); return Promise.resolve(); }; self.__badges = []; const spy = (n) => { self.__badges.push(n ?? 0); return Promise.resolve(); }; try { Object.defineProperty(self.navigator, 'setAppBadge', { value: spy, configurable: true }); Object.defineProperty(self.navigator, 'clearAppBadge', { value: () => spy(0), configurable: true }); } catch (e) { self.__spyError = String(e); } });
const push = (payload) => sw.evaluate((p) => new Promise((resolve) => { const ev = new PushEvent('push', { data: JSON.stringify(p) }); const orig = ev.waitUntil.bind(ev); let pr = Promise.resolve(); ev.waitUntil = (x) => { pr = x; try { orig(x); } catch {} }; self.dispatchEvent(ev); pr.then(() => resolve(true), (e) => resolve(String(e))); }), payload);

await push({ title: 'Approval needed: #1004 Door handle', body: 'N$320.00 · Joe', link: '#/requests/r1', id: 'n1', tag: 'r-r1', urgent: true, unread: 3, at: new Date().toISOString() });
await push({ title: 'Approval needed: #1005 Paper', body: 'N$925.00', link: '#/requests/r2', id: 'n2', tag: 'r-r2', urgent: false, unread: 4 });
await push({ title: 'Approved: #1004', body: 'again for the same request', link: '#/requests/r1', id: 'n3', tag: 'r-r1', unread: 5 });
await page.waitForTimeout(300);
const notes = await sw.evaluate(() => self.__shown);
const latest = {}; for (const n of notes) latest[n.tag] = n;   // the phone keeps one alert per tag: the latest
check(notes.length === 3 && Object.keys(latest).length === 2, `three pushes, two requests → two alerts on screen (tags ${notes.map((n) => n.tag)})`);
check(latest['r-r1']?.title === 'Approved: #1004', 'the same-request alert shows the newest message');
check((latest['r-r2']?.vibrate || []).join(',') === '200,100,200,100,320', `vibration pattern set (${latest['r-r2']?.vibrate})`);
check(/badge-96\.png$/.test(latest['r-r2']?.badge || ''), 'status-bar badge icon set');
check(/icon-192\.png$/.test(latest['r-r2']?.icon || ''), 'app icon set');
check(latest['r-r2']?.silent === false, 'not silent');
check(latest['r-r2']?.renotify === true, 'buzzes again when replaced');
check(latest['r-r2']?.data?.link === '#/requests/r2', 'tapping opens the request');
check(notes[0].requireInteraction === true && latest['r-r2'].requireInteraction === false, 'urgent alerts stay on screen until dealt with; others time out');
const badges = await sw.evaluate(() => ({ b: self.__badges, err: self.__spyError || null }));
check(!badges.err && badges.b.join(',') === '3,4,5', `icon count follows the unread alerts (${badges.b} ${badges.err || ''})`);
await push({ title: 'Read elsewhere', id: 'n4', unread: 0 });
const cleared = await sw.evaluate(() => self.__badges.slice(-1)[0]);
check(cleared === 0, 'icon count clears at zero');
await page.waitForTimeout(200);
check(messages.some((m) => m?.type === 'push'), `an open app is told straight away (${messages.length} message(s))`);
await browser.close(); server.close();
console.log(fails.length ? `PUSH TEST: FAIL (${fails.length})` : 'PUSH TEST: PASS');
process.exit(fails.length ? 1 : 0);
