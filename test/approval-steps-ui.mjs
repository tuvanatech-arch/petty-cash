// The approval steps (047) in the preview: the Schedule shows them in plain words and follows the inputs while the GM
// edits; "Pay out now" has its own limit; a payment from the company account needs approval first; a stand-in that
// would let one person approve and pay is refused.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const uid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const b = await chromium.launch();
async function open(role, hash, w = 1280) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } }); const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '#/home');
  await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); sessionStorage.setItem('pcs_update_shown', '1'); localStorage.setItem('demo_two_step', 'on'); }, role);
  await page.goto(base + hash); await page.reload(); await page.waitForTimeout(1600);
  return { ctx, page, errs };
}
const toastText = (page) => page.locator('#toast-root').innerText().catch(() => '');
const steps = async (page) => (await page.locator('#approval-steps').innerText().catch(() => '')).replace(/\s+/g, ' ');
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const checkbox = (page, label) => page.locator('label.check', { hasText: label }).locator('input[type=checkbox]');

/* 1. the GM: the steps in words, following the inputs */
{
  const { ctx, page, errs } = await open('approver', '#/admin/schedule');
  const t = await steps(page);
  check(/Up to N\$200\.00: finance pays, no approval needed/.test(t) && /N\$200\.00 – N\$5,000\.00: the GM approves/.test(t) && /Above N\$5,000\.00: the MD approves/.test(t), `the steps as today: "${t.slice(0, 160)}"`);
  check(/“Pay out now” \(cash without a request\): up to N\$200\.00/.test(t) && /Always: finance pays/.test(t), 'with "Pay out now" and the fixed safeguards');
  await checkbox(page, 'The GM approves above that').uncheck(); await page.waitForTimeout(200);
  check(/Above N\$200\.00: the MD approves\./.test(await steps(page)), 'GM step off: everything above N$200 goes to the MD');
  check(!(await page.locator('.field', { hasText: 'General Manager approves up to' }).isVisible()), '…and the GM limit is hidden (it no longer applies)');
  await checkbox(page, 'The GM approves above that').check();
  await checkbox(page, 'The MD approves above the GM limit').uncheck(); await page.waitForTimeout(200);
  check(/Above N\$200\.00: the GM approves, whatever the amount/.test(await steps(page)), 'MD step off: the GM approves every amount above N$200');
  await page.locator('button', { hasText: 'Review and save…' }).click(); await page.waitForTimeout(600);
  check(/The MD approves above the GM limit/.test(await page.locator('.modal').innerText().catch(() => '')) && /waits for the MD/.test(await page.locator('.modal').innerText().catch(() => '')), 'the change is listed and waits for the MD');
  await page.keyboard.press('Escape');
  check(await noSideScroll(page), 'no sideways scrolling');
  check(!errs.length, `GM schedule: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 2. the MD and finance read the same steps */
for (const role of ['managing_director', 'finance']) {
  const { ctx, page, errs } = await open(role, '#/schedule', 390);
  check(/Above N\$5,000\.00: the MD approves/.test(await steps(page)), `${role}: the steps on the Schedule`);
  check(await noSideScroll(page), `${role}: phone, no sideways scrolling`);
  check(!errs.length, `${role}: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 3. finance: a payment from the company account needs approval first */
{
  const { ctx, page, errs } = await open('finance', `#/requests/${uid(125)}`);
  await page.locator('#pay-how button', { hasText: 'Company account' }).click(); await page.waitForTimeout(300);
  check(/needs approval first, whatever the amount/.test(await page.locator('#transfer-info').innerText()) && await page.locator('#record-transfer').isDisabled(), 'not approved: told to send it for approval, and it cannot be recorded');
  await page.locator('#pay-how button', { hasText: 'Cash from the box' }).click(); await page.waitForTimeout(300);
  check(await page.locator('#pay-panel h2').innerText() === 'Pay out from petty cash', 'cash from the box still needs no approval under N$200');
  await page.goto(base + `#/requests/${uid(122)}`); await page.waitForTimeout(1500);
  await page.locator('#pay-how button', { hasText: 'Company account' }).click(); await page.waitForTimeout(300);
  check(!(await page.locator('#record-transfer').isDisabled()), 'an approved request can be paid from the company account');
  check(!errs.length, `finance company account: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 4. "Pay out now" has its own limit */
{
  const { ctx, page, errs } = await open('finance', '#/cash');
  await page.locator('button', { hasText: 'Pay out now' }).click(); await page.waitForTimeout(600);
  await page.locator('.modal input[type=number]').first().fill('250');
  check(/“Pay out now” is for up to N\$200\.00/.test(await page.locator('.modal').innerText()), 'above its limit it says to raise a request');
  check(!errs.length, `pay out now: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 5. a stand-in that would let one person approve and pay is refused */
{
  const { ctx, page, errs } = await open('approver', '#/admin/standins');
  await page.locator('main button', { hasText: 'Add stand-in' }).click(); await page.waitForTimeout(700);
  check(/One person never both approves and pays/.test(await page.locator('.modal').innerText()), 'the form says who cannot cover whom');
  const sels = page.locator('.modal select');
  await sels.nth(0).selectOption({ label: 'Fiona Shikongo (Finance)' }).catch(async () => { const o = await sels.nth(0).locator('option', { hasText: 'Fiona' }).first().getAttribute('value'); await sels.nth(0).selectOption(o); });
  const ada = await sels.nth(1).locator('option', { hasText: 'Ada Nangolo' }).first().getAttribute('value');
  await sels.nth(1).selectOption(ada);
  await page.locator('.modal input[type=date]').nth(1).fill(await page.locator('.modal input[type=date]').nth(0).inputValue());
  await page.locator('.modal button', { hasText: 'Set stand-in' }).click(); await page.waitForTimeout(900);
  const said = await page.locator('.modal').innerText().catch(() => '');
  check(/Ada Nangolo approves, so cannot also stand in for finance/.test(said), 'the GM covering finance is refused, with the reason');
  check(!errs.length, `stand-ins: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

await b.close(); server.close();
console.log(fails.length ? `APPROVAL STEPS UI: ${fails.length} FAILED` : 'APPROVAL STEPS UI: PASS');
process.exit(fails.length ? 1 : 0);
