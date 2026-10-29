// The authority schedule in the preview: the GM edits and sees what waits for the MD; the MD approves or turns down;
// finance reads it; a requester cannot open it; budgets and limits are no longer edited anywhere else.
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

/* ---- the GM ---- */
await as('approver', '/admin/schedule');
let t = await text();
check(/MGP-SCH-PC-001 · version 3/.test(t), 'GM: the version in force is shown');
check(/MGP-POL-PC-001 – the petty cash policy/.test(t), 'GM: the policy link is shown');
check(/Waiting for the Managing Director/.test(t) && /Finance pays alone up to/.test(t) && /Taxi fares went up/.test(t), 'GM: the change waiting for the MD, with its reason');
check(await page.locator('button:has-text("Withdraw")').count() === 1 && await page.locator('button:has-text("Approve")').count() === 0, 'GM: can withdraw, cannot approve');
check(/Waiting for the MD: N\$300\.00/.test(t), 'GM: the waiting value shows under the finance limit');
check(/MD approves changes/.test(t) && /MD is told/.test(t), 'GM: each section says whether the MD approves or is told');
const vals = await page.evaluate(() => [...document.querySelectorAll('.schedule input.num')].map((i) => i.value));
check(vals.includes('200.00') && vals.includes('5000.00') && vals.includes('3000.00') && vals.includes('7'), `GM: limits and float are editable (${vals.join(', ')})`);
check(/Budgets/.test(t) && /Kitchen/.test(t) && await page.locator('.schedule button:has-text("Edit")').count() > 0, 'GM: budgets are on the schedule, with Edit');
check(/Paulus Nghipondoka/.test(t) && /Managing Director/.test(t) && /Change under People/.test(t), 'GM: positions and holders');
check(/Version 3/.test(t) && /Not approved by Paulus/.test(t), 'GM: version history, including the change the MD turned down');

// change one approval limit and one reminder: the review shows which waits and which applies now; a reason is required
await page.locator('.schedule input.num').nth(1).fill('6000');
await page.locator('.schedule .field', { hasText: 'Weekly stock count reminder' }).locator('select').selectOption('3');
await page.locator('button:has-text("Review and save")').click(); await page.waitForTimeout(300);
t = await modalText();
check(/General Manager approves up to/.test(t) && /N\$6,000\.00/.test(t) && /waits for the MD/.test(t), 'review: the GM limit waits for the MD');
check(/Weekly stock count reminder/.test(t) && /Wednesday/.test(t) && /applies now/.test(t), 'review: the count day applies now');
await page.locator('.modal button:has-text("Save")').click(); await page.waitForTimeout(300);
check(/Say why/.test(await modalText()), 'review: a reason is required');
await page.locator('.modal textarea').fill('Agreed at the management meeting');
await page.locator('.modal button:has-text("Save")').click(); await page.waitForTimeout(600);
check(!(await page.locator('.modal').count()), 'review: saved with a reason');

await page.locator('.schedule button:has-text("Edit")').first().click(); await page.waitForTimeout(300);
check(/Reason for the change/.test(await modalText()), 'budget edit asks for a reason');
await page.keyboard.press('Escape');

await as('approver', '/admin/settings');
t = await text();
check(!/Finance pays alone/.test(t) && /Schedule/.test(t) && /Organisation name/.test(t), 'Settings: only the organisation details; limits point to the Schedule');
await as('approver', '/admin/budgets');
check(/MGP-SCH-PC-001/.test(await text()), 'old Budgets link opens the Schedule');
await as('approver', '/home');
check(/schedule change with the MD/.test(await text()), 'GM Home: “Elsewhere” shows the schedule change with the MD');
await as('approver', `/requests/${uid(102)}`);
check(/under MGP-SCH-PC-001 version 3/.test(await text()), 'a request shows the schedule version it ran under');

/* ---- the MD ---- */
await as('managing_director', '/home');
t = await text();
check(/Schedule change to approve/.test(t) && /Finance pays alone up to/.test(t), 'MD Home: the schedule change to approve');
check(await page.locator('nav a[href="#/schedule"]').count() > 0, 'MD: Schedule in the menu');
await as('managing_director', '/schedule');
t = await text();
check(/Schedule change to approve/.test(t) && await page.locator('button:has-text("Approve")').count() === 1 && await page.locator('button:has-text("Turn down")').count() === 1, 'MD: approve or turn down');
check(!(await page.locator('.schedule input.num').count()) && /Finance pays alone up to/.test(t) && /N\$200\.00/.test(t), 'MD: reads the values, cannot edit them');
check(!/Withdraw/.test(t), 'MD: cannot withdraw the GM’s change');
await page.locator('button:has-text("Turn down")').click(); await page.waitForTimeout(300);
await page.locator('.modal button:has-text("Turn down")').click(); await page.waitForTimeout(200);
check(/required/.test(await modalText()), 'MD: turning down needs a reason');
await page.keyboard.press('Escape');
await page.locator('button:has-text("Approve")').click(); await page.waitForTimeout(300);
await page.locator('.modal button:has-text("Approve")').click(); await page.waitForTimeout(800);
t = await text();
check(!/Schedule change to approve/.test(t) && /Approved by Paulus/.test(t), 'MD: approving puts it in force and in the history');

/* ---- finance and a requester ---- */
await as('finance', '/schedule');
t = await text();
check(/MGP-SCH-PC-001/.test(t) && !(await page.locator('.schedule input.num').count()) && !(await page.locator('button:has-text("Approve")').count()), 'finance: reads the schedule only');
check(await page.locator('nav a[href="#/schedule"]').count() > 0, 'finance: Schedule in the menu');
await as('finance', '/account');
t = await text();
check(/Petty cash policy/.test(t) && /Authority schedule/.test(t), 'finance Account: the policy and the schedule');
await as('requester', '/schedule');
check(/Page not found/.test(await text()), 'requester: cannot open the schedule');
await as('requester', '/account');
t = await text();
check(/Petty cash policy/.test(t) && !/Authority schedule/.test(t), 'requester Account: the policy only');

check(!errs.length, `no page errors (${errs.join(' | ')})`);
await b.close(); server.close();
console.log(fails.length ? `SCHEDULE UI: FAIL (${fails.length})` : 'SCHEDULE UI: PASS');
process.exit(fails.length ? 1 : 0);
