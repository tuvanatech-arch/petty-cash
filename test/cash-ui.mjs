// Cash controls in the preview: finance counts the box and records an authorised top-up; the GM signs counts off;
// the ledger runs with a balance; a reused receipt needs an explanation before it is accepted.
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
const modalText = () => page.locator('.modal').innerText();
const btn = (label) => page.locator(`main button:has-text("${label}")`);

/* ---- finance ---- */
await as('finance', '/cash');
let t = await text();
check(await btn('Count cash').count() === 1 && await btn('Return cash').count() === 1, 'finance: Count cash and Return cash');
check(await page.locator('main button', { hasText: /^Top up$/ }).count() === 0, 'finance: no direct “Top up” any more');
check(await btn('Request top-up').count() === 0 && /Authorised – waiting for the cash/.test(t), 'finance: an authorised top-up is open, so no second request');
check(/Cash counts/.test(t) && /N\$20\.00 short/.test(t) && /Waiting for the GM/.test(t), 'finance: the counts list shows the short count waiting for the GM');
check(/Petty cash ledger/.test(t) && /Monthly allocation/.test(t) && /Paid out/.test(t) && /Book balance/.test(t) && await btn('Download CSV').count() === 1, 'finance: the ledger with a running balance and CSV');
check(/Last counted/.test(t), 'finance: when the box was last counted');

await btn('Count cash').click(); await page.waitForTimeout(250);
check((await page.locator('.modal input.num').inputValue()) === '', 'count: the amount starts empty (no pre-filled book balance)');
await page.locator('.modal input.num').fill('1300');
check(/(Short|Over) by N\$[\d,.]+ against the book balance/.test(await modalText()) && /say what caused it/.test(await modalText()), 'count: shows the difference against the book as you type');
await page.keyboard.press('Escape');

await btn('Record the cash').first().click(); await page.waitForTimeout(250);
check(/Record the top-up cash/.test(await modalText()) && (await page.locator('.modal input.num').inputValue()) === '1000.00', 'top-up: record the authorised cash, at most what was authorised');
await page.keyboard.press('Escape');

await btn('Close & reconcile').click(); await page.waitForTimeout(250);
check((await page.locator('.modal input.num').inputValue()) === '' && /goes to the General Manager to sign off/.test(await modalText()), 'close: a count like any other, empty until counted');
await page.keyboard.press('Escape');

await as('finance', '/home');
t = await text();
check(/Top-up authorised/.test(t) && /Year-end function supplies/.test(t), 'finance Home: the authorised top-up to record');

// a receipt already used on another request
await as('finance', `/requests/${uid(106)}`);
t = await text();
check(/Already used on #1003/.test(t), 'reused receipt is flagged on the request');
await page.locator('button:has-text("Confirm & close")').click(); await page.waitForTimeout(300);
check(/This receipt was used before/.test(await modalText()), 'confirming it asks why it is right');
await page.locator('.modal button:has-text("Accept with this note")').click(); await page.waitForTimeout(200);
check(/required/.test(await modalText()), 'the explanation is required');
await page.keyboard.press('Escape');

/* ---- the GM ---- */
await as('approver', '/home');
t = await text();
check(/Cash counts to sign off/.test(t) && /N\$20\.00 short/.test(t), 'GM Home: the count to sign off');
await page.locator('main button:has-text("Sign off")').first().click(); await page.waitForTimeout(250);
t = await modalText();
check(/Write the N\$20\.00 off as cash short/.test(t) && /courier tip/.test(t), 'sign-off: shows finance’s reason and offers the write-off');
await page.locator('.modal button:has-text("Sign off")').click(); await page.waitForTimeout(250);
check(/say how it was resolved/.test(await modalText()), 'sign-off: a difference above the limit needs a resolution');
await page.locator('.modal textarea').fill('Courier tip confirmed – written off');
await page.locator('.modal button:has-text("Sign off")').click(); await page.waitForTimeout(500);
check(!(await page.locator('.modal').count()), 'sign-off: done with a resolution');

await as('approver', '/cash');
t = await text();
check(await btn('Count cash').count() === 0 && await btn('Request top-up').count() === 0, 'GM: does not count the cash or request top-ups');
check(/Signed off by Ada/.test(t), 'GM: the signed-off count shows who signed it');

await as('approver', '/admin/schedule');
t = await text();
check(/Cash difference allowed at a count/.test(t) && /Cash count reminder/.test(t), 'schedule: the cash difference allowed and the count reminder');

await as('requester', '/cash');
check(/Page not found/.test(await text()), 'requester: no Petty cash page');

check(!errs.length, `no page errors (${errs.join(' | ')})`);
await b.close(); server.close();
console.log(fails.length ? `CASH UI: FAIL (${fails.length})` : 'CASH UI: PASS');
process.exit(fails.length ? 1 : 0);
