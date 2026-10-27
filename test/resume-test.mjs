// The installed app on a phone: pull down reloads, a long time in the background reloads (unless something is half-written),
// and the SIGNED_IN that supabase re-emits on every return from the background does NOT redraw the page.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve('../demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0].split('#')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { get: () => true }); });
const page = await ctx.newPage();
const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
let loads = 0; page.on('load', () => loads++);

await page.goto(base + '#/home');
await page.evaluate(() => { localStorage.setItem('demo_role', 'approver'); localStorage.setItem('pcs_push_asked', 'later'); });
await page.reload(); await page.waitForTimeout(700);
const l0 = loads;

// 1. supabase's "back from background" SIGNED_IN: the page must stay as it is
await page.evaluate(() => { window.__marker = document.createElement('i'); window.__marker.id = 'marker'; document.querySelector('main').append(window.__marker); });
await page.evaluate(() => window.__emitAuth('SIGNED_IN'));
await page.waitForTimeout(400);
check(await page.evaluate(() => !!document.getElementById('marker')), 'SIGNED_IN on resume leaves the page untouched');
check(await page.evaluate(() => !!document.querySelector('.ptr')), 'pull-to-refresh indicator exists in the installed app');

// 2. a short time away: no reload
await page.evaluate(() => {
  let vis = 'hidden'; Object.defineProperty(document, 'visibilityState', { get: () => vis, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  const real = Date.now; Date.now = () => real() + 2 * 60 * 1000; vis = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(300);
check(loads === l0, 'back after 2 minutes: no reload');

// 3. a long time away with a half-written note: no reload
await page.goto(base + '#/requests/new'); await page.waitForTimeout(500);
await page.evaluate(() => { const t = document.querySelector('main textarea, main input[type=text]'); if (t) t.value = 'half written'; });
await page.evaluate(() => {
  let vis = 'hidden'; Object.defineProperty(document, 'visibilityState', { get: () => vis, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  const real = Date.now; Date.now = () => real() + 15 * 60 * 1000; vis = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(400);
check(loads === l0, 'back after 15 minutes with unsaved text: no reload');

// 4. a long time away on a clean page: reload
await page.goto(base + '#/home'); await page.waitForTimeout(500);
const l1 = loads;
await page.evaluate(() => {
  let vis = 'hidden'; Object.defineProperty(document, 'visibilityState', { get: () => vis, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  const real = Date.now; Date.now = () => real() + 15 * 60 * 1000; vis = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(1200);
check(loads > l1, 'back after 15 minutes on a clean page: reloaded');

// 5. pull down far enough and let go: reload
await page.waitForTimeout(500);
const l2 = loads;
const touch = async (type, y) => page.evaluate(([type, y]) => {
  const target = document.querySelector('main') || document.body;
  const t = new Touch({ identifier: 1, target, clientX: 180, clientY: y, pageX: 180, pageY: y });
  target.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
}, [type, y]);
await touch('touchstart', 200); await touch('touchmove', 240); await touch('touchmove', 300);
const text = await page.evaluate(() => document.querySelector('.ptr')?.textContent);
check(text === 'Release to refresh', `indicator says "Release to refresh" (got "${text}")`);
await touch('touchend', 300);
await page.waitForTimeout(1200);
check(loads > l2, 'pull down and release: reloaded');

// 6. a short pull does nothing
const l3 = loads;
await touch('touchstart', 200); await touch('touchmove', 230); await touch('touchend', 230);
await page.waitForTimeout(500);
check(loads === l3, 'a short pull does not reload');

await browser.close(); server.close();
console.log(fails.length ? `RESUME TEST: FAIL (${fails.length})` : 'RESUME TEST: PASS');
process.exit(fails.length ? 1 : 0);
