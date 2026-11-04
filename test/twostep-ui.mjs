// Two-step sign-in by email (051) and the company logo: off by default, the emailed code asked at sign-in (wrong,
// right), never for a requester, nothing left of the authenticator app, and the logo printed on documents.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch();
const isoDay = (offset) => { const x = new Date(); x.setDate(x.getDate() + offset); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
async function open(role, hash, { twoStep = 'off', from = null, w = 390 } = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: 820 } }); const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '#/home');
  await page.evaluate(([r, ts, f]) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); sessionStorage.setItem('pcs_update_shown', '1'); localStorage.setItem('demo_two_step', ts); if (f) localStorage.setItem('demo_two_step_from', f); else localStorage.removeItem('demo_two_step_from'); }, [role, twoStep, from]);
  await page.goto(base + hash); await page.reload(); await page.waitForTimeout(1600);
  return { ctx, page, errs };
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/* 1. off (no date): finance signs in with the password alone; Home has no reminder; Account says nothing to set up */
{
  const { ctx, page, errs } = await open('finance', '#/home');
  check(await page.locator('#two-step-banner').count() === 0 && /Good (morning|afternoon|evening)/.test(await page.locator('main').innerText()), 'off: Home opens, no reminder to set anything up');
  await page.goto(base + '#/account'); await page.waitForTimeout(1200);
  const t = await page.locator('#two-step').innerText().catch(() => '');
  check(/Off/.test(t) && /email you a 6-digit code/.test(t) && /Nothing to set up/.test(t) && await page.locator('#two-step button').count() === 0, 'Account: off, by email when switched on, nothing to set up');
  check(!errs.length, `finance: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* 2. on, and this sign-in owes the code: the emailed code first (wrong, then right) */
{
  const { ctx, page, errs } = await open('finance', '#/home', { twoStep: 'code', from: isoDay(-1) });
  check(/Check your email/.test(await page.locator('h1').innerText()) && /emailed a 6-digit code to f•••@example\.test/.test(await page.locator('#code-status').innerText()), 'the code page: where the code went');
  await page.locator('.code-input').fill('111 111'); await page.waitForTimeout(600);
  check(/not right/.test(await page.locator('.error').innerText()), 'a wrong code: says so');
  await page.locator('.code-input').fill('123 456'); await page.waitForTimeout(1500);
  check(/Good (morning|afternoon|evening)/.test(await page.locator('main').innerText().catch(() => '')), 'the right code (typed with a space): Petti opens');
  check(await noSideScroll(page) && !errs.length, `code: phone fits, no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* 3. a requester is never asked */
{
  const { ctx, page, errs } = await open('requester', '#/home', { twoStep: 'code', from: isoDay(-1) });
  check(await page.locator('.code-input').count() === 0, 'a requester is not asked for a code');
  check(!errs.length, `requester: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* 4. the GM: no authenticator left in People, the date explained, and the logo */
{
  const { ctx, page, errs } = await open('approver', '#/admin/users', { twoStep: 'on', w: 1280 });
  check(!/Two-step/.test(await page.locator('main thead').innerText()) && await page.locator('main button', { hasText: 'Reset' }).count() === 0, 'People: no authenticator column or reset any more');
  await page.goto(base + '#/admin/settings'); await page.waitForTimeout(1200);
  check(/emails them a 6-digit code/.test(await page.locator('main').innerText()) && /only once Petti can send email/.test(await page.locator('main').innerText()), 'Settings: the date, explained for email codes');
  check(/No logo yet/.test(await page.locator('#logo-block').innerText()), 'Settings: no logo yet');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMgAAABQCAYAAABcbTqwAAABuUlEQVR42u3dsVHDQBBAUdtdMAQElEMPFEcPlENAwFCGKQADQnd7ut17Lyaw5f23UqDhdAIAAACmcJ7pw9w/P123/u3Hy+vZz0fZQP4Tg2hYJpCIMIRC6kBGRCEW0gVyZBhCoYfLCnHM+HlYdINkGETbhEM2SJZT2jZheCDZhk4kDAsk67CJhPBAsg+ZSAgLpMpwiYTugVQbKpHQLZCqwyQSmgOpPkQiYXcgqwyPSOjykA4CWfRUtUXYHMiqwyIS3GJBSyCrn6K2iEAAgUDnQNxeuA4CAX50dmpu1/Kq7t3jg+s5mc+39z9/TxsEBAICAYHA4YF4QL/NdREIIBAQCAgEBAICAYGAQEAgIBAQyDf+RdltrotAAIGAQEAgEOnXh07vP3hAt0GAfYE4NV0HgQACgZBAVr+9cHslEKAlkFVPUduDi2HxfXGLBfGBrHKq2h7s3iDVh0ccNN9iVR0icdDtGaTaMImD7g/pVYZKHIQEUmG4xEFoIJmHTBwMCSTjsImDoYFkGjpxsFXYoMz4uq4wOHSDzDyM4mCqDTLLNhEG0wcyOhZRkDaQyFCEQZlAWqMRAwAAANV8AaAesII7uQHFAAAAAElFTkSuQmCC', 'base64');
  await page.locator('#logo-file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png }); await page.waitForTimeout(1200);
  check(await page.locator('#logo-preview').count() === 1, 'uploading a logo shows it as it will print');
  const logo = await page.evaluate(async () => { const m = await import('./js/brand.js'); const l = await m.loadLogo(); if (!l) return null;
    const calls = []; const doc = { addImage: (...a) => calls.push(a) }; const hgt = m.drawLogo(doc, l, 16, 12, 70, 16);
    return { w: l.w, h: l.h, png: l.dataUrl.startsWith('data:image/png'), hgt, fmt: calls[0]?.[1], alias: calls[0]?.[6], width: calls[0]?.[4] }; });
  check(logo && logo.png && logo.w === 200 && logo.h === 80, 'the logo is read for documents as a PNG at its own size');
  check(logo && logo.fmt === 'PNG' && logo.alias === 'company-logo' && Math.abs(logo.hgt - 16) < 0.01 && Math.abs(logo.width - 40) < 0.01, 'drawn in a 70 x 16 mm box, keeping its shape, stored once in the PDF');
  check(!errs.length, `GM: no page errors ${errs.join('|')}`);
  await ctx.close();
}

await b.close(); server.close();
console.log(fails.length ? `TWO-STEP UI: FAIL (${fails.length})` : 'TWO-STEP UI: PASS'); process.exit(fails.length ? 1 : 0);
