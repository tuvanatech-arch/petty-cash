// Approval by position in the preview: the GM sees GM-level approvals and the MD's own request to review; the MD sees
// MD-level approvals (including the GM's own); an MD-level request shows the GM who it waits for; Settings holds the limits.
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
const as = async (role, hash) => { await page.goto(base + '#/home'); await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); }, role); await page.goto(base + '#' + hash); await page.reload(); await page.waitForTimeout(700); };
const text = () => page.locator('main').innerText();
const cardText = async (title) => { const c = page.locator('.sheet', { has: page.locator('h2', { hasText: title }) }).first(); return (await c.count()) ? c.innerText() : ''; };

await as('approver', '/home');
let t = await cardText('Needs your approval');
check(/Toner for the Finance printer/.test(t) && /Spare keys/.test(t), 'GM: GM-level requests are in the approval list');
check(!/Laptop for the new accountant/.test(t) && !/Client lunch/.test(t), 'GM: MD-level requests and own request are not');
t = await cardText('To review after payment');
check(/Board meeting refreshments/.test(t), 'GM: the MD’s own paid request is listed to review');
check(/with the MD/.test(await text()), 'GM: “Elsewhere” shows what is with the MD');

await as('approver', `/requests/${uid(116)}`);
t = await text();
check(/Waiting for the Managing Director/.test(t) && !/Your approval is needed/.test(t), 'GM viewing an MD-level request: waiting for the MD, no approve buttons');
await as('approver', `/requests/${uid(117)}`);
check(/Your own request – the Managing Director approves it/.test(await text()), 'GM viewing own request: the MD approves it');
await as('approver', `/requests/${uid(103)}`);
check(await page.locator('button:has-text("Send to the MD")').count() === 1, 'GM: “Send to the MD” on a GM-level request');
await as('approver', `/requests/${uid(118)}`);
t = await text();
check(/For your review/.test(t) && await page.locator('button:has-text("Mark reviewed")').count() === 1, 'GM: review panel on the MD’s own request');
await page.locator('button:has-text("Mark reviewed")').click(); await page.waitForTimeout(500);
check(/Reviewed after payment/.test(await text()), 'marking it reviewed shows on the request');

await as('managing_director', '/home');
t = await cardText('Needs your approval');
check(/Laptop for the new accountant/.test(t) && /Client lunch/.test(t), 'MD: MD-level requests and the GM’s own are in the approval list');
check(!/Toner for the Finance printer/.test(t), 'MD: GM-level requests are not');
check(!(await page.locator('nav a[href="#/admin"]').count()), 'MD: no Admin');
check(await page.locator('nav a[href="#/reports"]').count() > 0, 'MD: Reports');
await as('managing_director', `/requests/${uid(116)}`);
check(/Your approval is needed/.test(await text()) && /Managing Director level/.test(await text()), 'MD: can approve an MD-level request');

await as('approver', '/admin/settings');
t = await text();
const vals = await page.evaluate(() => [...document.querySelectorAll('input.num')].map((i) => i.value));
check(/Who approves what/.test(t) && /General Manager approves up to/.test(t) && vals.includes('5000.00') && vals.includes('7') && vals.includes('10'), `Settings: finance limit, GM limit, split window, tolerance (${vals.join(', ')})`);
await as('approver', '/admin');
check(/Managing Director/.test(await text()) && /Paulus/.test(await text()), 'People lists the Managing Director');

check(!errs.length, `no page errors (${errs.join(' | ')})`);
await b.close(); server.close();
console.log(fails.length ? `AUTHORITY UI: FAIL (${fails.length})` : 'AUTHORITY UI: PASS'); process.exit(fails.length ? 1 : 0);
