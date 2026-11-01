// Forms that adapt to a choice: the parts that depend on a dropdown slide in and out (and really animate),
// and the fields around it follow the choice – proof locked when you pay yourself, what someone still owes,
// a stand-in who cannot cover for themselves, the region preview, a notice's exact send time, monthly quantity.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const uid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const b = await chromium.launch();
async function open(role, hash, w = 390) {
  const ctx = await b.newContext({ viewport: { width: w, height: 800 } }); const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '#/home');
  await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); sessionStorage.setItem('pcs_update_shown', '1'); }, role);
  await page.goto(base + hash); await page.reload(); await page.waitForTimeout(1800);
  return { ctx, page, errs };
}
const moving = (page) => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);

/* proof of payment on a request's pay-out */
{
  const { ctx, page, errs } = await open('finance', `#/requests/${uid(121)}`);
  check(!(await page.locator('#proof-reason').isVisible()), 'pay-out: the reason is hidden while proof is required');
  await page.selectOption('#proof-rule', 'none');
  check(await moving(page) > 0, 'pay-out: choosing “No proof possible” slides the reason in');
  await page.waitForTimeout(400);
  check(await page.locator('#proof-reason').isVisible() && await page.evaluate(() => document.activeElement?.id) === 'proof-reason', 'pay-out: …and puts the cursor on it');
  await page.selectOption('#proof-reason', 'Other'); await page.waitForTimeout(400);
  check(await page.locator('#proof-other').isVisible() && await page.evaluate(() => document.activeElement?.id) === 'proof-other', 'pay-out: “Other” opens a box to say what it is for');
  check(await page.locator('#proof-reason optgroup').count() >= 4 && await page.locator('#proof-reason option').count() >= 10, 'pay-out: the reasons are grouped, with more to choose from');
  await page.selectOption('#proof-reason', 'Taxi or bus fare'); await page.waitForTimeout(400);
  check(/from where to where/.test(await page.locator('.proof-choice .hint').innerText()) && !(await page.locator('#proof-other').isVisible()), 'pay-out: each reason says what the spender must write instead');
  await page.selectOption('#proof-reason', 'Casual labour'); await page.waitForTimeout(400);
  check(/who did the work/.test(await page.locator('.proof-choice .hint').innerText()), 'pay-out: …and it follows the reason');
  await page.locator('.sheet select').filter({ has: page.locator('option', { hasText: 'Fiona Shikongo' }) }).first().selectOption({ label: 'Fiona Shikongo' }); await page.waitForTimeout(500);
  check(await page.locator('#proof-rule').inputValue() === 'required' && await page.locator('#proof-rule option[value=none]').isDisabled(), 'pay-out: handing the cash to yourself switches back to “Proof required” and locks it');
  check(/to yourself/.test(await page.locator('.proof-choice .hint').innerText()) && !(await page.locator('#proof-reason').isVisible()), 'pay-out: …says why, and the reason folds away');
  await page.locator('.sheet select').filter({ has: page.locator('option', { hasText: 'Joe Katjivena' }) }).first().selectOption({ label: 'Joe Katjivena' }); await page.waitForTimeout(800);
  check(!(await page.locator('#proof-rule option[value=none]').isDisabled()) && /Joe Katjivena still has/.test(await page.locator('main').innerText()), 'pay-out: someone else – the choice is back, with what they still owe');
  check(!errs.length, `pay-out: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* Pay out now (Petty cash) */
{
  const { ctx, page, errs } = await open('finance', '#/cash');
  await page.locator('main button', { hasText: 'Pay out now' }).first().click(); await page.waitForTimeout(800);
  const dlg = page.locator('.modal');
  await dlg.locator('select').first().selectOption({ label: 'Joe Katjivena' }); await page.waitForTimeout(800);
  check(/Joe Katjivena still has/.test(await dlg.innerText()), 'pay out now: choosing the person shows what they still owe');
  await dlg.locator('select').first().selectOption({ label: 'Fiona Shikongo' }); await page.waitForTimeout(600);
  check(await dlg.locator('#proof-rule option[value=none]').isDisabled(), 'pay out now: paying yourself locks “Proof required”');
  check(!errs.length, `pay out now: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* new request: switching the kind slides fields */
{
  const { ctx, page, errs } = await open('requester', '#/requests/new');
  await page.locator('main .tabs button', { hasText: 'claim back' }).click();
  check(await moving(page) > 0, 'new request: switching to a claim slides the fields in and out');
  await page.waitForTimeout(400);
  check(await page.locator('main label.upload').isVisible() && !(await page.locator('main label', { hasText: 'Needed by' }).isVisible()), 'new request: the claim fields are there, “Needed by” is gone');
  check(!errs.length, `new request: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* new item: monthly quantity only for things bought every month */
{
  const { ctx, page, errs } = await open('stock_manager', '#/stock/items');
  await page.locator('main button', { hasText: '+ Item' }).click(); await page.waitForTimeout(800);
  const dlg = page.locator('.modal'); const monthly = dlg.locator('.field', { hasText: 'Expected monthly quantity' });
  check(!(await monthly.isVisible()), 'item: monthly quantity hidden until “Bought every month”');
  await dlg.locator('label.check', { hasText: 'Bought every month' }).locator('input').check(); await page.waitForTimeout(400);
  check(await monthly.isVisible(), 'item: ticking it brings the monthly quantity in');
  check(!errs.length, `item: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* administrator: stand-ins, region, notices */
{
  const { ctx, page, errs } = await open('approver', '#/admin/standins', 1280);
  await page.locator('main button', { hasText: 'Add stand-in' }).click(); await page.waitForTimeout(700);
  const dlg = page.locator('.modal'); const [from, to] = [dlg.locator('select').nth(0), dlg.locator('select').nth(1)];
  const fromId = await from.inputValue();
  check(await to.locator(`option[value="${fromId}"]`).isDisabled(), 'stand-in: the person being covered cannot be picked to cover');
  const other = await from.locator('option').nth(1).getAttribute('value'); await from.selectOption(other); await page.waitForTimeout(200);
  check(await to.locator(`option[value="${other}"]`).isDisabled() && !(await to.locator(`option[value="${fromId}"]`).isDisabled()), 'stand-in: …and that follows the choice');
  await dlg.locator('button', { hasText: 'Cancel' }).click();
  await page.evaluate(() => { location.hash = '#/admin/settings'; }); await page.waitForTimeout(1500);
  const before = await page.locator('#region-now').innerText();
  await page.selectOption('#set-locale', 'en-US'); await page.waitForTimeout(300);
  check(/now .* there/.test(before) && /1,234\.50/.test(await page.locator('#region-now').innerText()), 'region: the preview shows the time there and how money will read');
  await page.selectOption('#set-locale', 'pt-AO'); await page.waitForTimeout(300);
  check(/1[.\u00a0\u202f ]234,50/.test(await page.locator('#region-now').innerText()), 'region: …and follows the choice');
  await page.evaluate(() => { location.hash = '#/admin/updates'; }); await page.waitForTimeout(1500);
  await page.locator('main button', { hasText: 'Send a notice' }).click(); await page.waitForTimeout(700);
  await page.selectOption('#nt-when', 'morning'); await page.waitForTimeout(700);
  const n = page.locator('.modal');
  check(await n.locator('button[type=submit]').innerText() === 'Schedule' && /Goes out/.test(await n.innerText()), 'notice: “Next working morning” says exactly when, and the button says Schedule');
  check(!errs.length, `admin: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* reduced motion: no sliding, same result */
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 800 }, reducedMotion: 'reduce' }); const page = await ctx.newPage();
  await page.goto(base + '#/home'); await page.evaluate(() => { localStorage.setItem('demo_role', 'finance'); localStorage.setItem('pcs_push_asked', 'later'); sessionStorage.setItem('pcs_update_shown', '1'); });
  await page.goto(base + `#/requests/${uid(121)}`); await page.reload(); await page.waitForTimeout(1800);
  await page.selectOption('#proof-rule', 'none');
  check(await moving(page) === 0 && await page.locator('#proof-reason').isVisible(), 'reduced motion: the reason appears at once, without sliding');
  await ctx.close();
}

await b.close(); server.close();
console.log(fails.length ? `FORMS UI: FAIL (${fails.length})` : 'FORMS UI: PASS'); process.exit(fails.length ? 1 : 0);
