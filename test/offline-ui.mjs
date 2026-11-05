// Offline mode in the preview: with the signal gone, the screens seen before open from this phone's copy under an
// "Offline – as of …" banner; a new request, a snapped receipt and a stock report are kept; a money decision says it
// needs a connection; back online, the kept things are sent (the request becomes a draft) and the banner goes;
// signing out wipes the copy.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const SHOTS = process.env.SHOTS || null;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 2 : 1 });
await ctx.route(/googleapis/, (r) => r.abort());
const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const go = async (hash, ms = 1300) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(ms); };
const text = async () => (await page.locator('main').innerText()).replace(/\s+/g, ' ');
const banner = () => page.locator('#offline-banner');
await page.goto(base + '#/home');
await page.evaluate(() => { localStorage.setItem('demo_role', 'requester'); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); sessionStorage.setItem('pcs_update_shown', '1'); });
await page.reload(); await page.waitForTimeout(1800);

/* online: the screens are seen once (and the main lists copied in the background) */
await go('#/requests'); await go('#/stock'); await go('#/requests/new/cash'); await go('#/snap'); await go('#/home', 5500);
check(!(await banner().count()), 'online: no offline banner');
const homeOnline = await page.locator('main h1').first().innerText();

/* the signal goes */
await ctx.setOffline(true); await page.waitForTimeout(300);
await go('#/requests');
check(await banner().isVisible() && /Offline – as of \d\d:\d\d/.test(await banner().innerText()), `offline: the banner says so, with the time of the copy (${(await banner().innerText().catch(() => '')).slice(0, 40)})`);
check(/Requests/.test(await text()) && !/Could not load/.test(await text()), 'offline: Requests opens from the copy');
if (SHOTS) await page.screenshot({ path: `${SHOTS}/offline-requests.png` });
await go('#/home');
check((await page.locator('main h1').first().innerText()) === homeOnline && !/Could not load/.test(await text()), `offline: Home opens from the copy (${homeOnline})`);

/* a new payment request: kept on the phone */
await go('#/requests/new/cash', 1800);
await page.locator('main input.input').first().fill('Water for the office (offline test)');
const amount = page.locator('main input.num').first(); if (await amount.count()) await amount.fill('120');
await page.getByRole('button', { name: 'Save draft' }).click(); await page.waitForTimeout(1200);
const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('pcs_outbox') || '[]'));
check(kept.length === 1 && kept[0].kind === 'request' && kept[0].data.purpose === 'Water for the office (offline test)', 'offline: a new request is kept on this phone');
check(/Waiting to send: 1/.test(await banner().innerText().catch(() => '')), 'the banner counts what waits to be sent');
if (SHOTS) await page.screenshot({ path: `${SHOTS}/offline-kept.png` });

/* Snap: the scan is kept */
await go('#/snap', 1500);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const fileIn = page.locator('main input[type=file]').first();
if (await fileIn.count()) {
  // a screenshot-shaped picture passes the slip check (a 1×1 dot is too small, so make a real one in the page)
  const big = await page.evaluate(async () => { const c = document.createElement('canvas'); c.width = 1080; c.height = 2340; const x = c.getContext('2d'); x.fillStyle = '#222'; x.fillRect(0, 0, 1080, 2340); x.fillStyle = '#fff'; x.font = '60px sans-serif'; x.fillText('N$ 85.00', 80, 400); const bl = await new Promise((r) => c.toBlob(r, 'image/png')); return Array.from(new Uint8Array(await bl.arrayBuffer())); });
  await fileIn.setInputFiles({ name: 'Screenshot_receipt.png', mimeType: 'image/png', buffer: Buffer.from(big) }); await page.waitForTimeout(2000);
  check(await page.locator('#snap-kept').isVisible(), 'offline: a snapped receipt is kept on this phone');
} else check(false, 'Snap has a file input');
void png;

/* a money decision needs a connection (as the GM, approving) – checked through the same client */
const needs = await page.evaluate(async () => { const { sb } = await import('./js/api.js'); const r = await sb.rpc('approve_request', { p_request: '00000000-0000-0000-0000-000000000000' }); return r.error?.message || ''; });
check(/Needs a connection/.test(needs), `offline: approving says it needs a connection ("${needs.slice(0, 40)}")`);

/* back online: sent, the request becomes a draft, the banner goes */
await ctx.setOffline(false); await page.waitForTimeout(4500);
const left = await page.evaluate(() => JSON.parse(localStorage.getItem('pcs_outbox') || '[]').length);
check(left === 0, `back online: everything kept was sent (${left} left)`);
await go('#/requests', 1800);
check(/Water for the office \(offline test\)/.test(await text()), 'the request is now a draft under Requests');
check(!(await banner().count()), 'back online: the banner is gone');

/* signing out wipes the copy */
const before = await page.evaluate(async () => (await caches.keys()).includes('petti-offline-data'));
await page.evaluate(async () => { const { signOutHere } = await import('./js/api.js'); await signOutHere(); }); await page.waitForTimeout(800);
const after = await page.evaluate(async () => (await caches.keys()).includes('petti-offline-data'));
check(before && !after, 'signing out wipes the copy from this phone');
check(!errs.length, `no page errors ${errs.slice(0, 2).join(' | ')}`);

await b.close(); server.close();
console.log(fails.length ? `OFFLINE UI: FAIL (${fails.length})` : 'OFFLINE UI: PASS'); process.exit(fails.length ? 1 : 0);
