// Stock controls in the preview: deliveries to confirm, corrections within and above the limit, issued vs counted items,
// the GM's approvals, and the duplicate-buying warning on a stock review.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const uid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const b = await chromium.launch(); const page = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const as = async (role, hash) => { await page.goto(base + '#/home'); await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_view', '00000081-0000-4000-8000-000000000000'); }, role); await page.goto(base + '#' + hash); await page.reload(); await page.waitForTimeout(800); };
const text = () => page.locator('main').innerText();
const modalText = () => page.locator('.modal').innerText();

/* ---- the stock controller ---- */
await as('stock_manager', '/stock');
let t = await text();
check(/Deliveries \(2\)/.test(t) && /Corrections/.test(t), 'stock: Deliveries and Corrections tabs, with the count to check');
check(await page.locator('main .pill:has-text("Issued")').count() > 0, 'items: issued items are marked');
await page.locator('main button:has-text("Quick count")').click(); await page.waitForTimeout(400);
check(/issued items a difference is a variance/.test(await modalText()) && /N\$200\.00/.test(await modalText()), 'quick count: explains counted vs issued and the limit');
await page.keyboard.press('Escape');
await page.locator('main tr.item-row', { hasText: 'Toner HP 26A' }).click(); await page.waitForTimeout(300);
check(/Correct/.test(await modalText()), 'item sheet: a Correct action');
await page.locator('.modal button:has-text("Correct")').click(); await page.waitForTimeout(300);
await page.locator('.modal input.num').fill('0'); await page.waitForTimeout(100);
check(/Above the N\$200\.00 limit/.test(await modalText()), 'correct: a big difference says the GM approves it first');
await page.keyboard.press('Escape');
await page.locator('main tr.item-row', { hasText: 'Toner HP 26A' }).click(); await page.waitForTimeout(300);
await page.locator('.modal button:has-text("Edit")').click(); await page.waitForTimeout(300);
check(/How it is tracked/.test(await modalText()), 'edit item: the tracking mode');
await page.keyboard.press('Escape');

await as('stock_manager', '/stock/deliveries');
t = await text();
check(/To check/.test(t) && /Confirm arrival/.test(t) && /1 short/.test(t) && /Arrived in full|short/.test(t), 'deliveries: to check and the checked history');
await page.locator('main button:has-text("Confirm arrival")').first().click(); await page.waitForTimeout(300);
await page.locator('.modal input.num').fill('1'); await page.waitForTimeout(100);
check(/short – worth/.test(await modalText()), 'confirm: fewer arrived shows the shortfall and its value');
await page.keyboard.press('Escape');

await as('stock_manager', '/stock/adjustments');
t = await text();
check(/Waiting for the General Manager/.test(t) && /Toner HP 26A/.test(t) && /Waiting for the GM/.test(t) && await page.locator('main button:has-text("Approve")').count() === 0, 'corrections: the pending one waits, no approve buttons for the controller');
check(/Short delivery/.test(t) && /Water damage/.test(t), 'corrections: the log shows applied ones');

await as('stock_manager', '/home');
t = await text();
check(/Deliveries to check/.test(t) && !/Toner HP 26A · 2/.test(t), 'controller Home: deliveries to check, without the one they bought above the limit');

/* ---- the GM ---- */
await as('approver', '/home');
t = await text();
check(/Stock corrections to approve/.test(t) && /Toner HP 26A/.test(t) && await page.locator('main button:has-text("Approve")').count() > 0, 'GM Home: corrections to approve');
check(/Deliveries to confirm/.test(t) && /bought by the stock controller/i.test(t), 'GM Home: the delivery the controller bought above the limit');
await as('approver', '/stock/adjustments');
check(await page.locator('main button:has-text("Turn down")').count() === 1 && await page.locator('main button:has-text("Approve")').count() === 1, 'GM corrections: approve or turn down');
await as('approver', '/admin/schedule');
check(/Stock correction the controller may make alone/.test(await text()), 'schedule: the stock correction limit');

/* ---- the review warns about duplicate buying ---- */
await as('stock_manager', `/requests/${uid(101)}`);
t = await text();
check(/Stock review/.test(t) && /already on order/.test(t), 'stock review: warns that the item is already on order');

check(!errs.length, `no page errors (${errs.join(' | ')})`);
await b.close(); server.close();
console.log(fails.length ? `STOCK CONTROLS UI: FAIL (${fails.length})` : 'STOCK CONTROLS UI: PASS');
process.exit(fails.length ? 1 : 0);
