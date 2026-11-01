// "What's new": a new note pops up once when the app opens, the menu counts unread notes, the page explains what
// changes and how to use it, each person sees only their notes, and the administrator sees who has read them.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch();
for (const w of [1280, 390]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } }); const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '#/home'); await page.evaluate(() => { localStorage.setItem('demo_role', 'approver'); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '1'); });
  await page.reload(); await page.waitForTimeout(1500);
  const pop = page.locator('.modal');
  check(await pop.count() === 1 && /What’s new/.test(await pop.innerText()), `${w}: the newest unread note pops up on opening`);
  const pt = await pop.innerText();
  check(/What changes for you/i.test(pt) && /How to use it/i.test(pt) && /See all 2/.test(pt), `${w}: it says what changes, how to use it, and that there is one more`);
  check(await page.evaluate(() => [...document.querySelectorAll('[data-updates]')].some((e) => e.textContent === '2' && e.style.display !== 'none')), `${w}: the menu counts 2 unread`);
  check(await pop.locator('img.update-pic').count() === 1, `${w}: the note carries a picture`);
  // Later: closes without marking read, back next session
  await pop.getByRole('button', { name: 'Later' }).click(); await page.waitForTimeout(300);
  check(await page.locator('.modal').count() === 0 && await page.evaluate(() => [...document.querySelectorAll('[data-updates]')].some((e) => e.textContent === '2')), `${w}: Later closes it and keeps it unread`);
  await page.evaluate(() => sessionStorage.removeItem('pcs_update_shown')); await page.reload(); await page.waitForTimeout(1500);
  check(await page.locator('.modal').count() === 1, `${w}: it comes back next time`);
  // Show me runs the walk-through on the person's own screen
  await page.locator('.modal button', { hasText: 'Show me' }).click(); await page.waitForTimeout(2500);
  check(await page.locator('.tour .tour-spot').count() === 1 && /Step 1 of 2/i.test(await page.locator('.tour-bubble').innerText()) && /^#\/account/.test(await page.evaluate(() => location.hash)), `${w}: Show me opens Account and spotlights the Alerts box`);
  const spot = await page.locator('.tour-spot').boundingBox(); const target = await page.locator('main .sheet', { hasText: 'Alerts' }).first().boundingBox();
  check(spot && target && Math.abs(spot.x + 6 - target.x) < 2 && Math.abs(spot.y + 6 - target.y) < 2, `${w}: the spotlight sits on the element`);
  await page.locator('.tour-bubble button', { hasText: 'Next' }).click(); await page.waitForTimeout(900);
  check(/Step 2 of 2/i.test(await page.locator('.tour-bubble').innerText()) && /phone or computer/.test(await page.locator('.tour-bubble').innerText()), `${w}: Next moves to step 2`);
  await page.locator('.tour-bubble button', { hasText: 'Done' }).click(); await page.waitForTimeout(300);
  check(await page.locator('.tour').count() === 0, `${w}: Done ends the walk-through`);
  check(await page.evaluate(() => [...document.querySelectorAll('[data-updates]')].some((e) => e.textContent === '1')), `${w}: Show me counted as read`);
  await page.goto(base + '#/home'); await page.waitForTimeout(600);
  await page.evaluate(() => sessionStorage.removeItem('pcs_update_shown')); await page.reload(); await page.waitForTimeout(1500);
  check(await page.locator('.modal').count() === 1, `${w}: the next unread note pops up`);
  await page.locator('.modal').getByRole('button', { name: 'Got it' }).click(); await page.waitForTimeout(500);
  check(await page.locator('.modal').count() === 0, `${w}: Got it closes it`);
  check(await page.evaluate(() => [...document.querySelectorAll('[data-updates]')].every((e) => e.style.display === 'none')), `${w}: the count is gone`);
  await page.reload(); await page.waitForTimeout(1300);
  check(await page.locator('.modal').count() === 0, `${w}: it does not pop up again in the same session`);
  // arriving from an alert with a job to do: no pop-up
  await page.evaluate(() => { sessionStorage.removeItem('pcs_update_shown'); localStorage.setItem('demo_role', 'finance'); }); await page.goto(base + '#/cash'); await page.reload(); await page.waitForTimeout(1500);
  check(await page.locator('.modal').count() === 0, `${w}: no pop-up when landing on Petty cash from an alert`);
  if (w === 390) check(await page.evaluate(() => { const b = document.querySelector('.tabbar [data-updates]'); return b && b.style.display !== 'none' && b.textContent === '1'; }), `${w}: the phone's More tab shows the unread count`);
  await page.evaluate(() => localStorage.setItem('demo_role', 'approver'));
  await page.goto(base + '#/updates'); await page.reload(); await page.waitForTimeout(1100);
  let t = await page.locator('main').innerText();
  check(/A place for updates/.test(t) && /Petti’s new look/.test(t) && !/Deliveries to confirm/.test(t), `${w}: the GM sees the two notes for everyone, not finance's`);
  check(await page.locator('main .update-steps li').count() >= 4 && await page.locator('main button.btn', { hasText: /Show me|Open/ }).count() >= 2, `${w}: steps and a Show-me button on each`);
  check(await page.evaluate(() => [...document.querySelectorAll('[data-updates]')].every((e) => e.style.display === 'none')), `${w}: opening What's new reads them all`);
  // was this clear?
  await page.locator('main .clear-ask button', { hasText: 'Not really' }).first().click(); await page.locator('main .clear-ask textarea').fill('Which tab?');
  await page.locator('main .clear-ask button', { hasText: 'Send' }).click(); await page.waitForTimeout(400);
  check(/administrator/.test(await page.locator('main .clear-ask').first().innerText()), `${w}: thumbs down with a comment is sent`);
  await page.locator('main .clear-ask button', { hasText: 'Yes' }).first().click(); await page.waitForTimeout(300);
  check(/glad it was clear/.test(await page.locator('main .clear-ask').nth(1).innerText()), `${w}: thumbs up is sent`);
  // finance sees its own note too
  await page.evaluate(() => localStorage.setItem('demo_role', 'finance')); await page.goto(base + '#/updates'); await page.reload(); await page.waitForTimeout(1300);
  t = await page.locator('main').innerText();
  check(/Deliveries to confirm/.test(t) && /Stock → Deliveries/.test(t), `${w}: finance gets the note meant for finance`);
  // the administrator's view
  await page.evaluate(() => localStorage.setItem('demo_role', 'approver')); await page.goto(base + '#/admin/updates'); await page.reload(); await page.waitForTimeout(1200);
  t = await page.locator('main').innerText();
  check(/Read by 4 of 7/.test(t) && /Not read yet: Nangula Iipinge/.test(t) && /Goes out/.test(t), `${w}: Admin → Updates shows who has read what, and what is still to go out`);
  check(/👎 Fiona Shikongo: “Which tab\?”/.test(t) || /Which tab/.test(t), `${w}: the administrator sees the comment`);
  // the administrator's own notice
  await page.locator('main button', { hasText: 'Send a notice' }).click(); await page.waitForTimeout(400);
  await page.fill('#nt-title', 'Petty cash closed Friday afternoon'); await page.fill('#nt-msg', 'No pay-outs after 12:00 on Friday.'); await page.fill('#nt-steps', 'Ask on Thursday.\n'); await page.check('#nt-role-finance');
  await page.locator('.modal button', { hasText: 'Send' }).last().click(); await page.waitForTimeout(800);
  t = await page.locator('main').innerText();
  check(/Petty cash closed Friday afternoon/.test(t) && /To finance · Notice from/.test(t), `${w}: the notice is sent to finance and listed`);
  await page.evaluate(() => localStorage.setItem('demo_role', 'finance')); await page.goto(base + '#/updates'); await page.reload(); await page.waitForTimeout(1200);
  t = await page.locator('main').innerText();
  check(/Petty cash closed Friday afternoon/.test(t) && /notice from Ada Nangolo/.test(t) && /The message/i.test(t), `${w}: finance reads it as a notice from Ada`);
  await page.evaluate(() => localStorage.setItem('demo_role', 'approver')); await page.goto(base + '#/admin/updates'); await page.reload(); await page.waitForTimeout(1200);
  await page.locator('main button', { hasText: 'Cancel' }).first().click(); await page.waitForTimeout(400);
  await page.locator('.modal button', { hasText: 'Cancel it' }).click(); await page.waitForTimeout(800);
  check(/Cancelled/.test(await page.locator('main').innerText()), `${w}: a scheduled update can be cancelled`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${w}: no sideways scroll`);
  check(!errs.length, `${w}: no page errors ${errs.join('|')}`);
  await ctx.close();
}
await b.close(); server.close();
console.log(fails.length ? `UPDATES UI: FAIL (${fails.length})` : 'UPDATES UI: PASS'); process.exit(fails.length ? 1 : 0);
