// Phase 5 in the preview: the exception log the GM clears, the quarterly access review the MD signs off, the full export on the pack page.
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
const as = async (role, hash) => { await page.goto(base + '#/home'); await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); localStorage.removeItem('demo_view'); }, role); await page.goto(base + '#' + hash); await page.reload(); await page.waitForTimeout(800); };
const text = () => page.locator('main').innerText();
const modalText = () => page.locator('.modal').innerText();

/* ---- the GM clears exceptions ---- */
await as('approver', '/home');
let t = await text();
check(/Exceptions to clear/.test(t) && /Open the log/.test(t), 'GM Home: exceptions to clear');
await as('approver', '/reports/controls');
t = await text();
check(/Approval and exception log/.test(t) && /Open \(3\)/.test(t) && /Split purchase\?/.test(t) && /Pay-out undone/.test(t), 'controls: the log opens on the open ones');
check(await page.locator('main button:has-text("Justified")').count() === 3 && await page.locator('main button:has-text("Resolved")').count() === 3, 'GM: justified / resolved on each open one');
await page.locator('main button:has-text("Resolved")').first().click(); await page.waitForTimeout(300);
await page.locator('.modal button:has-text("Resolved")').click(); await page.waitForTimeout(200);
check(/required/.test(await modalText()), 'clearing needs a note');
await page.keyboard.press('Escape');
await page.locator('main .tabs button:has-text("Reviewed")').last().click(); await page.waitForTimeout(200);
t = await text();
check(/Cash count did not match/.test(t) && /Resolved Ada Nangolo/.test(t) && /Spent before approval/.test(t), 'reviewed: cleared and auto-reviewed entries with who');
await page.locator('main .tabs button:has-text("Logged")').last().click(); await page.waitForTimeout(200);
check(/Done by a stand-in/.test(await text()) && /Schedule changed/.test(await text()) && /People: changed/.test(await text()), 'logged: stand-in actions, schedule and people changes');

/* ---- the MD signs off the access review ---- */
await as('managing_director', '/schedule');
t = await text();
check(/Access review/.test(t) && /due/.test(t) && /Last signed off/.test(t) && /Paulus Nghipondoka/.test(t), 'MD schedule: the access review with the list and the last sign-off');
check(await page.locator('main button:has-text("Confirm Q")').count() === 1, 'MD: a confirm button for this quarter');
await page.locator('main button:has-text("Confirm Q")').click(); await page.waitForTimeout(300);
check(/nobody who has left/.test(await modalText()), 'confirm: says what is being confirmed');
await page.keyboard.press('Escape');
await as('approver', '/admin/schedule');
t = await text();
check(/Access review/.test(t) && await page.locator('main button:has-text("Confirm Q")').count() === 0, 'GM: sees the review, cannot sign it off');
await as('managing_director', '/home');
check(/exception[s]? waiting for the GM/.test(await text()), 'MD overview: open exceptions in what to look at');

/* ---- the full export on the pack page ---- */
await as('finance', `/cash/pack/${uid(42)}`);
check(await page.locator('main button:has-text("Full export (zip)")').count() === 1, 'pack page: the full export');
await page.locator('main button:has-text("Full export (zip)")').click(); await page.waitForTimeout(1200);
check(/Export ready/.test(await page.locator('body').innerText()), 'export: runs and reports');

/* ---- finance reads the log but cannot clear ---- */
await as('finance', '/reports/controls');
check(/Page not found|Approval and exception log/.test(await text()), 'finance: the controls tab is readable or not reachable, never editable');
check(await page.locator('main button:has-text("Justified")').count() === 0, 'finance: no clear buttons');

check(!errs.length, `no page errors (${errs.join(' | ')})`);
await b.close(); server.close();
console.log(fails.length ? `EXCEPTIONS UI: FAIL (${fails.length})` : 'EXCEPTIONS UI: PASS');
process.exit(fails.length ? 1 : 0);
