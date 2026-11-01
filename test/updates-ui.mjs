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
  await pop.getByRole('button', { name: 'Got it' }).click(); await page.waitForTimeout(500);
  check(await page.locator('.modal').count() === 0, `${w}: Got it closes it`);
  check(await page.evaluate(() => [...document.querySelectorAll('[data-updates]')].some((e) => e.textContent === '1')), `${w}: the count drops to 1`);
  await page.reload(); await page.waitForTimeout(1300);
  check(await page.locator('.modal').count() === 0, `${w}: it does not pop up again in the same session`);
  await page.goto(base + '#/updates'); await page.waitForTimeout(1100);
  let t = await page.locator('main').innerText();
  check(/A place for updates/.test(t) && /Petti’s new look/.test(t) && !/Deliveries to confirm/.test(t), `${w}: the GM sees the two notes for everyone, not finance's`);
  check(await page.locator('main .update-steps li').count() >= 4 && await page.locator('main a.btn', { hasText: /Open/ }).count() >= 2, `${w}: steps and a Show-me button on each`);
  check(await page.evaluate(() => [...document.querySelectorAll('[data-updates]')].every((e) => e.style.display === 'none')), `${w}: opening What's new reads them all`);
  // finance sees its own note too
  await page.evaluate(() => localStorage.setItem('demo_role', 'finance')); await page.goto(base + '#/updates'); await page.reload(); await page.waitForTimeout(1300);
  t = await page.locator('main').innerText();
  check(/Deliveries to confirm/.test(t) && /Stock → Deliveries/.test(t), `${w}: finance gets the note meant for finance`);
  // the administrator's view
  await page.evaluate(() => localStorage.setItem('demo_role', 'approver')); await page.goto(base + '#/admin/updates'); await page.reload(); await page.waitForTimeout(1200);
  t = await page.locator('main').innerText();
  check(/Read by 4 of 7/.test(t) && /Not read yet: Nangula Iipinge/.test(t) && /Goes out/.test(t), `${w}: Admin → Updates shows who has read what, and what is still to go out`);
  await page.locator('main button', { hasText: 'Cancel' }).first().click(); await page.waitForTimeout(400);
  await page.locator('.modal button', { hasText: 'Cancel it' }).click(); await page.waitForTimeout(800);
  check(/Cancelled/.test(await page.locator('main').innerText()), `${w}: a scheduled update can be cancelled`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${w}: no sideways scroll`);
  check(!errs.length, `${w}: no page errors ${errs.join('|')}`);
  await ctx.close();
}
await b.close(); server.close();
console.log(fails.length ? `UPDATES UI: FAIL (${fails.length})` : 'UPDATES UI: PASS'); process.exit(fails.length ? 1 : 0);
