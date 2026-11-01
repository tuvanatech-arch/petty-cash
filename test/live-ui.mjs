// Live screens: when someone else changes something, the open screen redraws itself in place (same scroll, no
// loading screen) – but never while you type or have a window open; it catches up the moment you stop.
// While Petti is in the background there is no connection at all.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const TONER = '00000103-0000-4000-8000-000000000000';   // a request waiting for the GM in the sample data
const b = await chromium.launch();
for (const w of [1280, 390]) {
  const page = await (await b.newContext({ viewport: { width: w, height: 700 } })).newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '#/home'); await page.evaluate(() => { localStorage.setItem('demo_role', 'approver'); localStorage.setItem('pcs_push_asked', 'later'); sessionStorage.setItem('pcs_update_shown', '1'); });
  await page.reload(); await page.waitForTimeout(1500);
  const has = async (txt) => (await page.locator('main').innerText()).includes(txt);
  check(await has('Toner for the Finance printer'), `${w}: the GM's Home lists the toner request to approve`);
  check(await page.evaluate(() => window.__liveSubs?.size === 1), `${w}: one live connection`);
  await page.evaluate(() => window.scrollTo(0, 200)); const y0 = await page.evaluate(() => window.scrollY);
  // someone else approves it
  await page.evaluate((id) => window.__demoChange('requests', { id, status: 'awaiting_disbursement', approved_at: new Date().toISOString() }), TONER);
  await page.waitForTimeout(400);
  check(await page.locator('main .petti-loader').count() === 0, `${w}: no loading screen while it refreshes`);
  await page.waitForTimeout(2200);
  check(!(await has('Toner for the Finance printer')) || !(await page.locator('main .card, main .sheet', { hasText: 'Needs your approval' }).innerText().catch(() => '')).includes('Toner'), `${w}: Home updates by itself – the toner request has left “Needs your approval”`);
  const y1 = await page.evaluate(() => window.scrollY);
  check(Math.abs(y1 - y0) < 40, `${w}: the page stays where it was scrolled (${y0} → ${y1})`);
  // typing: no redraw under the cursor
  await page.goto(base + '#/requests'); await page.waitForTimeout(1200);
  const box = page.locator('main input.input').first(); await box.fill('ton');
  const before = await page.evaluate(() => { const m = document.querySelector('main'); m.dataset.mark = 'x'; return document.querySelector('main input.input').value; });
  await page.evaluate(() => { window.__marker = document.querySelector('main input.input'); });
  await page.evaluate(() => window.__demoChange('requests', { id: '00000116-0000-4000-8000-000000000000', status: 'awaiting_disbursement' }));
  await page.waitForTimeout(3000);
  check(await page.evaluate(() => window.__marker.isConnected && document.activeElement === window.__marker), `${w}: while typing, the screen is not redrawn`);
  check(before === 'ton', `${w}: what was typed is kept`);
  await page.locator('main h1').click(); await page.waitForTimeout(2200);
  check(await page.evaluate(() => !window.__marker.isConnected), `${w}: after typing stops, it catches up`);
  // a window open: no redraw until it closes
  await page.goto(base + '#/home'); await page.waitForTimeout(1300);
  await page.evaluate(async () => { const ui = await import('./js/ui.js'); ui.modal('Test', ui.h('p', {}, 'open')); window.__home = document.querySelector('main').lastElementChild; });
  await page.evaluate(() => window.__demoChange('requests', { id: '00000102-0000-4000-8000-000000000000', status: 'disbursed' }));
  await page.waitForTimeout(3000);
  check(await page.evaluate(() => window.__home.isConnected && !!document.querySelector('.modal')), `${w}: with a window open, nothing moves`);
  await page.evaluate(() => document.getElementById('modal-root').replaceChildren()); await page.waitForTimeout(2200);
  check(await page.evaluate(() => !window.__home.isConnected), `${w}: once it closes, the screen catches up`);
  // battery: no connection in the background
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  const bg = await page.evaluate(() => window.__liveSubs.size); check(bg === 0, `${w}: in the background the live connection is closed (${bg})`);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  check(await page.evaluate(() => window.__liveSubs.size === 1), `${w}: back on screen, it reconnects`);
  // a screen that does not follow these records ignores them
  await page.goto(base + '#/account'); await page.waitForTimeout(1200); await page.evaluate(() => { window.__acc = document.querySelector('main').lastElementChild; });
  await page.evaluate(() => window.__demoChange('requests', { id: '00000102-0000-4000-8000-000000000000', status: 'closed' })); await page.waitForTimeout(2500);
  check(await page.evaluate(() => window.__acc.isConnected), `${w}: Account is left alone`);
  check(!errs.length, `${w}: no page errors ${errs.join('|')}`);
}
await b.close(); server.close();
console.log(fails.length ? `LIVE UI: FAIL (${fails.length})` : 'LIVE UI: PASS'); process.exit(fails.length ? 1 : 0);
