// Tapping an alert opens its page: Petti already open (the page is told and switches, even from another page),
// Petti closed (a new window on the alert's page), and a phone that opens the start page instead (the note left
// by the worker takes Petti to the alert's page). Runs the real service worker on the real app files.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo'); const swFile = path.resolve('web/sw.js');   // the preview (sample data) with the real worker
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => { let p = req.url.split('?')[0] === '/sw.js' ? swFile : path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://localhost:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch();
const ctx = await b.newContext({ permissions: ['notifications'] });
await ctx.route(/googleapis/, (r) => r.abort());
let page = await ctx.newPage(); page.on('pageerror', (e) => console.log('page error', e.message));
await page.goto(base + '#/home');
await page.evaluate(async () => { await navigator.serviceWorker.register('sw.js'); await navigator.serviceWorker.ready; });
await page.reload(); await page.waitForTimeout(1200);
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const tap = (link) => sw.evaluate(async (link) => {
  // headless browsers show no notifications: hand the worker the same tap with the alert's data
  const ev = new ExtendableEvent('notificationclick');
  Object.defineProperty(ev, 'notification', { value: { data: { link }, close() {} } });
  self.dispatchEvent(ev);
}, link);
const ID = '#/requests/0c6cf325-7935-4d1c-92bb-c7765488b17f';

/* 1. Petti open on another page */
await page.evaluate(() => { location.hash = '#/stock'; }); await page.waitForTimeout(300);
await tap(ID); await page.waitForTimeout(1200);
check(await page.evaluate(() => location.hash) === ID, `open on another page → the alert's request (${await page.evaluate(() => location.hash)})`);
await tap('#/cash'); await page.waitForTimeout(1200);
check(await page.evaluate(() => location.hash) === '#/cash', 'a second alert → Petty cash');

/* 2. Petti closed: the worker opens a window on the alert's page (browsers only allow that after a real tap, so here
   we check the note it leaves for the start-up, and that Petti starting then shows the alert's page) */
await page.close(); await new Promise((r) => setTimeout(r, 500));
await tap('#/updates'); await new Promise((r) => setTimeout(r, 800));
const note = await sw.evaluate(async () => { const c = await caches.open('petti-open'); const r = await c.match('./__open'); return r ? (await r.json()).hash : null; });
check(note === '#/updates', `closed → the alert's page is remembered (${note})`);
page = await ctx.newPage(); await page.goto(base); await page.waitForTimeout(1500);
check(await page.evaluate(() => location.hash) === '#/updates', 'and Petti opens on it');
await page.close();

/* 3. a phone that opens the start page: the worker's note takes Petti there */
await sw.evaluate(async () => { const c = await caches.open('petti-open'); await c.put(new Request('./__open'), new Response(JSON.stringify({ hash: '#/schedule', at: Date.now() }))); });
page = await ctx.newPage(); await page.goto(base + '#/home'); await page.waitForTimeout(1500);
check(await page.evaluate(() => location.hash) === '#/schedule', 'opened on the start page → still goes to the alert\'s page');
await page.reload(); await page.waitForTimeout(1200);
check(await page.evaluate(() => location.hash) === '#/schedule', 'the note is used once');
await page.goto(base + '#/home'); await page.waitForTimeout(1200);
check(await page.evaluate(() => location.hash) === '#/home', 'later starts are not sent anywhere');

await b.close(); server.close();
console.log(fails.length ? `ALERT OPEN UI: FAIL (${fails.length})` : 'ALERT OPEN UI: PASS'); process.exit(fails.length ? 1 : 0);
