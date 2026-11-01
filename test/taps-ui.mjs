// Fewer taps: earlier requests to repeat with one tap (and undo), suggestions while typing what it is for,
// "Request this again" on a request, and searchable item lists with the most-used first.
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
const purpose = (page) => page.locator('main input[maxlength="140"]').first();
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/* 1. repeat with one tap, and undo */
{
  const { ctx, page, errs } = await open('requester', '#/requests/new');
  const chips = page.locator('#again .again-chip');
  check(await chips.count() > 0 && /Ask for one of these again/.test(await page.locator('#again').innerText()), 'new request: earlier requests are offered to repeat');
  const chipText = (await chips.first().innerText()).split('·')[0].trim();
  await chips.first().click(); await page.waitForTimeout(600);
  check(await purpose(page).inputValue() === chipText, 'one tap fills in what it is for');
  check(Number(await page.locator('input[placeholder="0.00"]').inputValue()) > 0 && /Filled in from #\d+/.test(await page.locator('#filled-from').innerText()), '…and the amount, saying where it came from');
  check(!(await page.locator('#again').isVisible().catch(() => false)), 'the shortcuts step aside once used');
  check(await noSideScroll(page), 'nothing runs off the side of a phone');
  await page.locator('#filled-from a', { hasText: 'Undo' }).click(); await page.waitForTimeout(500);
  check(await purpose(page).inputValue() === '' && await page.locator('#again').isVisible(), 'Undo puts the form back as it was');

  /* 2. suggestions while typing */
  await purpose(page).click(); await purpose(page).pressSequentially('flow', { delay: 40 }); await page.waitForTimeout(400);
  const sug = page.locator('#suggest .suggest-opt');
  check(await sug.count() >= 1 && /Flowers for reception/.test(await sug.first().innerText()), 'typing “flow” suggests the earlier flowers request');
  await sug.first().click(); await page.waitForTimeout(500);
  check(/Flowers for reception/.test(await purpose(page).inputValue()) && await page.locator('#filled-from').isVisible(), 'tapping the suggestion fills the form');
  check(!errs.length, `new request: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* 3. claims: the lines come along */
{
  const { ctx, page, errs } = await open('requester', '#/requests/new/claim');
  const chip = page.locator('#again .again-chip', { hasText: 'Milk and rusks' });
  check(await chip.count() === 1, 'claim: earlier claims are offered');
  await chip.click(); await page.waitForTimeout(600);
  const firstLine = await page.locator('main input[placeholder="What you bought"]').first().inputValue();
  check(firstLine.length > 0 && /Check the amount and the date/.test(await page.locator('#filled-from').innerText()), 'claim: the lines are filled in, with a reminder to check the date');
  check(!errs.length, `claim: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* 4. "Request this again" on a request */
{
  const { ctx, page, errs } = await open('requester', `#/requests/${uid(121)}`);
  const again = page.locator('#again-btn');
  check(await again.count() === 1 && /Request this again/.test(await again.innerText()), 'own request: “Request this again” is offered');
  await again.click(); await page.waitForTimeout(1800);
  check(/Flowers for reception/.test(await purpose(page).inputValue()) && Number(await page.locator('input[placeholder="0.00"]').inputValue()) === 80, 'it opens a new request filled in from that one');
  check(!errs.length, `again: no page errors ${errs.join('|')}`);
  await ctx.close();
  const other = await open('requester', `#/requests/${uid(102)}`);   // Joe's request: not Rita's to repeat
  check(await other.page.locator('#again-btn').count() === 0, 'someone else’s request: no “Request this again”');
  await other.ctx.close();
}

/* 5. searchable item list, most-used first */
{
  const { ctx, page, errs } = await open('stock_manager', '#/requests/new');
  const face = page.locator('main .picker-face').first();
  check(await face.count() === 1 && /Choose an item/.test(await face.innerText()), 'stock request: the item list is a searchable picker');
  await face.click(); await page.waitForTimeout(400);
  check(await page.locator('.picker-search').first().evaluate((e) => e === document.activeElement), 'tapping it puts the cursor in the search box');
  const before = await page.locator('.picker-opt').count();
  await page.locator('.picker-search').first().pressSequentially('cof', { delay: 30 }); await page.waitForTimeout(200);
  const after = await page.locator('.picker-opt').count();
  check(after >= 1 && after < before && (await page.locator('.picker-opt').allInnerTexts()).every((t) => /cof/i.test(t)), 'typing narrows the list');
  await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  check(/coffee/i.test(await face.innerText()) && !(await page.locator('.picker-panel').first().isVisible()) && Number(await page.locator('main td.num input').nth(1).inputValue()) > 0, 'Enter picks it, closes the list and fills the price');
  check(await noSideScroll(page), 'nothing runs off the side of a phone');
  check(!errs.length, `picker: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* 6. reporting low stock: the ones they report most first */
{
  const { ctx, page, errs } = await open('requester', '#/home');
  await page.locator('main button', { hasText: 'Report low stock' }).first().click(); await page.waitForTimeout(900);
  const face = page.locator('.modal .picker-face');
  if (await face.count()) {
    await face.click(); await page.waitForTimeout(300);
    check(await page.locator('.modal .picker-opt').count() > 0, 'low stock: the item list is searchable');
  } else check(await page.locator('.modal select').count() === 1, 'low stock: a short list stays an ordinary dropdown');
  check(!errs.length, `low stock: no page errors ${errs.join('|')}`);
  await ctx.close();
}

await b.close(); server.close();
console.log(fails.length ? `TAPS UI: FAIL (${fails.length})` : 'TAPS UI: PASS'); process.exit(fails.length ? 1 : 0);
