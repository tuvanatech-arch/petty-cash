// Stock item photos and suggestions for the store (053) in the preview: photos on the items list and the item, adding
// one; suggesting an item (already-stocked items shown first, a reason required); the stock controller agrees, the GM
// approves and the item is in the catalogue; the Home cards; the photo when reporting low stock.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMgAAABQCAYAAABcbTqwAAABuUlEQVR42u3dsVHDQBBAUdtdMAQElEMPFEcPlENAwFCGKQADQnd7ut17Lyaw5f23UqDhdAIAAACmcJ7pw9w/P123/u3Hy+vZz0fZQP4Tg2hYJpCIMIRC6kBGRCEW0gVyZBhCoYfLCnHM+HlYdINkGETbhEM2SJZT2jZheCDZhk4kDAsk67CJhPBAsg+ZSAgLpMpwiYTugVQbKpHQLZCqwyQSmgOpPkQiYXcgqwyPSOjykA4CWfRUtUXYHMiqwyIS3GJBSyCrn6K2iEAAgUDnQNxeuA4CAX50dmpu1/Kq7t3jg+s5mc+39z9/TxsEBAICAYHA4YF4QL/NdREIIBAQCAgEBAICAYGAQEAgIBAQyDf+RdltrotAAIGAQEAgEOnXh07vP3hAt0GAfYE4NV0HgQACgZBAVr+9cHslEKAlkFVPUduDi2HxfXGLBfGBrHKq2h7s3iDVh0ccNN9iVR0icdDtGaTaMImD7g/pVYZKHIQEUmG4xEFoIJmHTBwMCSTjsImDoYFkGjpxsFXYoMz4uq4wOHSDzDyM4mCqDTLLNhEG0wcyOhZRkDaQyFCEQZlAWqMRAwAAANV8AaAesII7uQHFAAAAAElFTkSuQmCC', 'base64');
const b = await chromium.launch();
async function open(role, hash, w = 390) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } }); const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '#/home');
  await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); sessionStorage.setItem('pcs_update_shown', '1'); localStorage.setItem('demo_two_step', 'off'); }, role);
  await page.goto(base + hash); await page.reload(); await page.waitForTimeout(1600);
  return { ctx, page, errs };
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const text = async (page, css) => (await page.locator(css).first().innerText().catch(() => '')).replace(/\s+/g, ' ');

/* 1. the stock controller (catalogue): photos on the list, the nudge, adding a photo to an item */
{
  const { ctx, page, errs } = await open('stock_manager', '#/stock');
  check(await page.locator('.item-thumb').count() >= 5 && await page.locator('.item-thumb.empty').count() >= 1, 'items list: a picture beside each item, a plain box where there is none');
  check(/items? without a photo/.test(await text(page, '#no-photo-count')), 'the count of items without a photo');
  await page.locator('tr.item-row:has(.item-thumb.empty)').first().click(); await page.waitForTimeout(600);
  check(/No photo yet\. A photo helps everyone pick the right item \(recommended\)/.test(await text(page, '#item-photos')), 'an item without a photo: recommended, with "Add a photo"');
  await page.locator('#add-item-photo input[type=file]').setInputFiles({ name: 'pens.png', mimeType: 'image/png', buffer: png }); await page.waitForTimeout(1500);
  check(await page.locator('#item-photos .item-photo img').count() === 1 && /Add another photo/.test(await text(page, '#item-photos')), 'the photo is added and shown; up to two more can follow');
  check(await noSideScroll(page) && !errs.length, `stock controller items: phone fits, no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 2. a requester suggests an item */
{
  const { ctx, page, errs } = await open('requester', '#/stock');
  check(await page.locator('#add-item-photo').count() === 0, 'a requester cannot add photos');
  await page.locator('#suggest-item').click(); await page.waitForTimeout(800);
  await page.fill('#sug-name', 'A4 paper'); await page.waitForTimeout(200);
  check(/Already in the store/.test(await text(page, '#sug-already')) && /A4 paper \(ream\)/.test(await text(page, '#sug-already')), 'typing an item the store has: "Already in the store" first');
  await page.fill('#sug-name', 'Sticky notes, blue');
  await page.fill('#sug-reason', 'We need them');
  await page.locator('.modal button', { hasText: 'Send the suggestion' }).click(); await page.waitForTimeout(300);
  check(/full sentence/.test(await text(page, '.modal .error')), 'a reason is required (a full sentence)');
  await page.fill('#sug-reason', 'Finance colour-codes the claims to check with blue notes, and buys them herself.');
  await page.fill('#sug-qty', '4');
  await page.locator('#sug-photo input[type=file]').setInputFiles({ name: 'blue.png', mimeType: 'image/png', buffer: png }); await page.waitForTimeout(1200);
  await page.locator('.modal button', { hasText: 'Send the suggestion' }).click(); await page.waitForTimeout(1500);
  const li = page.locator('#suggestions li', { hasText: 'Sticky notes, blue' });
  check(await li.count() === 1 && /With the stock controller/.test(await li.innerText()) && await li.locator('button', { hasText: 'Withdraw' }).count() === 1 && await li.locator('img').count() === 1, 'sent: listed as "With the stock controller", with its photo and "Withdraw"');
  check(/Gold pens.*Not added.*Why not: Too expensive for every day/s.test(await text(page, '#suggestions')), 'a declined suggestion stays visible, with the reason');
  check(await noSideScroll(page) && !errs.length, `requester: phone fits, no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 3. the stock controller: the Home card, then agrees */
{
  const { ctx, page, errs } = await open('stock_manager', '#/home');
  check(/Item suggestions to check/.test(await page.locator('main').innerText()) && /Sticky notes, yellow/.test(await text(page, '#sug-home')), 'Home: "Item suggestions to check"');
  await page.goto(base + '#/stock/suggestions'); await page.waitForTimeout(1200);
  const li = page.locator('#suggestions li', { hasText: 'Sticky notes, yellow' });
  check(await li.locator('button', { hasText: 'Agree – send to the GM' }).count() === 1, 'the stock controller: "Agree – send to the GM" or "Decline"');
  await li.locator('button', { hasText: 'Agree' }).click(); await page.waitForTimeout(400);
  await page.locator('.modal button', { hasText: 'Agree' }).click(); await page.waitForTimeout(1300);
  check(/With the GM/.test(await page.locator('#suggestions li', { hasText: 'Sticky notes, yellow' }).innerText()), 'agreed: now with the GM');
  check(!errs.length, `stock controller: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 4. the GM approves: the item is in the catalogue */
{
  const { ctx, page, errs } = await open('approver', '#/home');
  check(/Item suggestions to approve/.test(await page.locator('main').innerText()), 'Home: "Item suggestions to approve" for the GM');
  await page.goto(base + '#/stock/suggestions'); await page.waitForTimeout(1200);
  const li = page.locator('#suggestions li', { hasText: 'Hand sanitiser 500 ml' });
  check(/Stock controller: Cheaper in a 5 L refill/.test(await li.innerText()), "the stock controller's note is shown to the GM");
  await li.locator('button', { hasText: 'Approve – add to the store' }).click(); await page.waitForTimeout(400);
  await page.locator('.modal button', { hasText: 'Approve' }).click(); await page.waitForTimeout(1300);
  check(/Added to the store/.test(await page.locator('#suggestions li', { hasText: 'Hand sanitiser 500 ml' }).innerText()), 'approved: "Added to the store"');
  check(!errs.length, `GM: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 5. reporting low stock shows the item's photo */
{
  const { ctx, page, errs } = await open('requester', '#/stock');
  await page.locator('tr.item-row', { hasText: 'A4 paper' }).nth(1).click(); await page.waitForTimeout(800);
  check(await page.locator('.report-pic img').count() === 1 && /Is this the one\?/.test(await text(page, '.report-pic')), 'reporting: the photo, "Is this the one?"');
  check(!errs.length, `report: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}
await b.close(); server.close();
console.log(fails.length ? `STOCK PHOTOS UI: ${fails.length} FAILED` : 'STOCK PHOTOS UI: PASS');
process.exit(fails.length ? 1 : 0);
