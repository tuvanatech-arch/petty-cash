// The offline copy-keeper on a weak signal: the app still opens quickly from the kept copy, the late answer from the
// server refreshes the copy, and the next start runs the new version. Offline, it opens from the copy.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve(process.argv[2]);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let delayPage = 0; let build = 'aaaa1111'; let down = false;
const server = http.createServer((req, res) => {
  if (down) { req.socket.destroy(); return; }
  let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  if (!existsSync(p)) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'max-age=600');
  const send = () => res.end(p.endsWith('index.html') ? readFileSync(p, 'utf8').replaceAll('aaaa1111', build) : readFileSync(p));
  if (p.endsWith('index.html') && delayPage) setTimeout(send, delayPage); else send();
});
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch();
const ctx = await b.newContext(); const page = await ctx.newPage();
const loaded = () => page.evaluate(() => document.querySelector('script[type=module]')?.getAttribute('src') || '');
await page.goto(base + '#/home'); await page.evaluate(() => { localStorage.setItem('demo_role', 'requester'); sessionStorage.setItem('pcs_update_shown', '1'); });
await page.evaluate(() => navigator.serviceWorker.register('sw.js'));
await page.evaluate(() => navigator.serviceWorker.ready); await page.reload(); await page.waitForTimeout(1500);
check(await page.evaluate(() => !!navigator.serviceWorker.controller), 'the copy-keeper is installed and in charge');
const kept = await page.evaluate(async () => (await (await caches.open((await caches.keys()).find((k) => k.startsWith('pcs-shell')))).keys()).map((r) => r.url));
check(kept.some((u) => /app\.js\?v=aaaa1111$/.test(u)), 'modules are kept under this version’s exact address');

// a new version is published, but the signal is weak: the page answers only after 9 s
build = 'bbbb2222'; delayPage = 9000;
const t0 = Date.now(); await page.reload({ waitUntil: 'domcontentloaded' }); const took = Date.now() - t0;
await page.waitForTimeout(1500);
check(took < 6500 && /v=aaaa1111/.test(await loaded()), `weak signal: Petti still opens quickly from the kept copy (${took} ms)`);
check(await page.locator('main').count() === 1, '…and works');
await page.waitForTimeout(9000);   // the late answer arrives and is kept
delayPage = 0; down = true;        // next start: no signal at all
await page.reload(); await page.waitForTimeout(1500);
check(/v=bbbb2222/.test(await loaded()), 'the late answer was kept: the next start (even offline) has the new version');
down = false;
await b.close(); server.close();
console.log(fails.length ? `SW TEST: FAIL (${fails.length})` : 'SW TEST: PASS'); process.exit(fails.length ? 1 : 0);
