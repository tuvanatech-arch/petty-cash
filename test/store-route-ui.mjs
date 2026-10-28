// In the preview, as a requester: a cash request that names a store item turns into "Send to the stock manager"
// (the cash buttons go away); a client lunch stays a cash request; "It isn't from the store" brings the cash buttons back.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch(); const page = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(base + '#/home'); await page.evaluate(() => { localStorage.setItem('demo_role', 'requester'); localStorage.setItem('pcs_push_asked', 'later'); });
const open = async () => { await page.goto(base + '#/requests/new/cash'); await page.reload(); await page.waitForTimeout(600); };
const purpose = () => page.locator('input[placeholder^="e.g. Taxi"]');
const visible = async (sel) => page.locator(sel).first().isVisible().catch(() => false);

await open();
await purpose().fill('2 reams printer paper'); await page.waitForTimeout(450);
check(await visible('.store-route'), 'naming a store item shows the store panel');
check(!(await visible('button:has-text("Submit request")')) && !(await visible('button:has-text("Save draft")')) && !(await visible('input[placeholder="0.00"]')), 'the cash buttons and the amount are hidden');
const opt = await page.locator('.store-route select').inputValue().then(async (v) => page.locator(`.store-route select option[value="${v}"]`).textContent());
check(/A4 paper/.test(opt) && /in store/.test(opt), `the matching item is picked (${opt})`);
check(await page.locator('.store-route input[type=number]').inputValue() === '2', 'the quantity is read from the text');
await page.locator('.store-route button.btn-primary').click(); await page.waitForTimeout(600);
check(/#\/stock\/reports/.test(page.url()), `sending lands on My reports (${page.url().split('#')[1]})`);
const mine = await page.locator('.sheet').first().textContent();
check(/A4 paper/.test(mine) && /Needed/.test(mine) && /needs 2/.test(mine), 'the ask shows as Needed, with how many');

await open();
await purpose().fill('Coffee for the client meeting'); await page.waitForTimeout(450);
check(!(await visible('.store-route')) && await visible('button:has-text("Submit request")'), 'a client-meeting coffee stays a cash request');

await purpose().fill('Toner'); await page.waitForTimeout(450);
check(await visible('.store-route'), 'toner shows the store panel');
await page.locator('.store-route button:has-text("from the store")').click(); await page.waitForTimeout(200);
check(!(await visible('.store-route')) && await visible('button:has-text("Submit request")') && /is told it is not from the store/.test(await page.locator('.sheet').first().textContent()), '"not from the store" brings the cash buttons back and says the stock manager is told');
await page.locator('.sheet a:has-text("Undo")').click(); await page.waitForTimeout(200);
check(await visible('.store-route'), 'undo routes it to the store again');

check(!errs.length, `no page errors (${errs.join(' | ')})`);
await b.close(); server.close();
console.log(fails.length ? `STORE ROUTE UI: FAIL (${fails.length})` : 'STORE ROUTE UI: PASS'); process.exit(fails.length ? 1 : 0);
