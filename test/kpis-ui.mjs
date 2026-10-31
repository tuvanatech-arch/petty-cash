// Phase 6 in the preview: the KPI tab with the management summary, the journal export, account codes on categories.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true }); const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const as = async (role, hash) => { await page.goto(base + '#/home'); await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); localStorage.removeItem('demo_view'); }, role); await page.goto(base + '#' + hash); await page.reload(); await page.waitForTimeout(900); };
const text = () => page.locator('main').innerText();

await as('approver', '/reports/kpis');
let t = await text();
check(/The seven KPIs/.test(t) && /01 · Expenditure vs budget/.test(t) && /07 · Approval turnaround/.test(t), 'KPIs: all seven tiles');
check(await page.locator('.kpi-red').count() === 2 && await page.locator('.kpi-green').count() === 2, 'KPIs: colours follow the limits');
check(/1\. How much was spent/.test(t) && /6\. Where costs could fall/.test(t) && /Repairs & maintenance is over budget/.test(t), 'management summary: the six questions');
check(/3 open – clear them on the Controls tab/.test(t), 'summary: links open exceptions to the log');
const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('main button:has-text("Journal (CSV)")').click()]);
check(/petty-cash-journal-\d{4}-\d{2}\.csv/.test(dl.suggestedFilename()), 'journal: downloads a CSV for the month');
await page.locator('main select.kpi-month').first().selectOption({ index: 1 }); await page.waitForTimeout(600);
check(/The seven KPIs/.test(await text()), 'KPIs: another month loads');

await as('stock_manager', '/stock/categories');
check(/Account code/.test(await text()), 'categories: account code column');
await page.locator('main button:has-text("Edit")').first().click(); await page.waitForTimeout(300);
check(/Account code/.test(await page.locator('.modal').innerText()), 'category: account code field');
await page.keyboard.press('Escape');
await as('approver', '/admin/settings');
check(/Accounting package/.test(await text()) && /Petty cash ledger account/.test(await text()), 'settings: accounting package and petty cash account');

await as('managing_director', '/reports/kpis');
check(/The seven KPIs/.test(await text()), 'MD: can read the KPIs');
await as('finance', '/reports');
check(/Page not found|KPIs/.test(await text()), 'finance: reports as before');

check(!errs.length, `no page errors (${errs.join(' | ')})`);
await b.close(); server.close();
console.log(fails.length ? `KPIS UI: FAIL (${fails.length})` : 'KPIS UI: PASS');
process.exit(fails.length ? 1 : 0);
