// Two-step sign-in and the company logo: the reminder before the date, setting it up (wrong code, right code), the code
// asked at sign-in, the hard stop after the date, the GM's view and reset, and the logo printed on documents.
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

/* 1. before the date: a reminder on Home, and setting it up from Account */
{
  const { ctx, page, errs } = await open('finance', '#/home');
  check(/Set up two-step sign-in by/.test(await page.locator('#two-step-banner').innerText().catch(() => '')), 'finance, before the date: Home reminds them, with the date');
  await page.locator('#two-step-banner a').click(); await page.waitForTimeout(1200);
  const sheet = page.locator('#two-step');
  check(/Required for finance, the GM and the MD from/.test(await sheet.innerText()), 'Account explains it is required for their position, from the date');
  await page.locator('#two-step-start').click(); await page.waitForTimeout(300);
  check(/Google Authenticator or Microsoft Authenticator/.test(await sheet.innerText()), 'step 1: install a free authenticator app');
  await sheet.locator('button', { hasText: 'Start' }).click(); await page.waitForTimeout(600);
  check(await page.locator('#two-step-add').count() === 1 && /otpauth:/.test(await page.locator('#two-step-add').getAttribute('href')), 'on a phone: one tap adds Petti to the authenticator app');
  check(/JBSW Y3DP/.test(await sheet.locator('.two-step-key').innerText()), 'the key is shown in groups of four, for typing in by hand');
  const code = sheet.locator('input.code-input');
  await code.fill('000000'); await sheet.locator('button', { hasText: 'Turn on two-step sign-in' }).click(); await page.waitForTimeout(500);
  check(/That code is not right/.test(await sheet.innerText()), 'a wrong code is refused, in plain words');
  await code.fill('123456'); await sheet.locator('button', { hasText: 'Turn on two-step sign-in' }).click(); await page.waitForTimeout(900);
  check(/On since/.test(await page.locator('#two-step').innerText()) && /stays on/.test(await page.locator('#two-step').innerText()), 'the right code turns it on; required, so it stays on (no Turn off)');
  check(await noSideScroll(page), 'nothing runs off the side of a phone');
  check(!errs.length, `setup: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* 2. the next sign-in asks for the code first */
{
  const { ctx, page, errs } = await open('finance', '#/home', { twoStep: 'code' });
  check(/Two-step sign-in/.test(await page.locator('.auth h1').innerText().catch(() => '')) && await page.locator('.auth input.code-input').count() === 1, 'set up: the code is asked for before anything opens');
  check(/ask your GM to reset/i.test(await page.locator('.auth').innerText()), 'and it says what to do about a lost phone');
  await page.locator('.auth input.code-input').fill('111111'); await page.waitForTimeout(700);
  check(/That code is not right/.test(await page.locator('.auth .error').innerText()), 'a wrong code: try again');
  await page.locator('.auth input.code-input').fill('123456'); await page.waitForTimeout(1500);
  check(await page.locator('.auth').count() === 0 && /Good (morning|afternoon|evening)/.test(await page.locator('main h1').first().innerText().catch(() => '')), 'the right code (typed, no button) opens Home');
  check(!errs.length, `code: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* 3. after the date, without it: nothing opens until it is set up */
{
  const { ctx, page, errs } = await open('finance', '#/cash', { from: isoDay(-1) });
  check(/Set up two-step sign-in to continue/.test(await page.locator('.auth h1').innerText().catch(() => '')), 'after the date: a hard stop, with the reason');
  check(await page.locator('main').count() === 0, 'no screen of the app is shown');
  await page.locator('.auth button', { hasText: 'Start' }).click(); await page.waitForTimeout(600);
  await page.locator('.auth input.code-input').fill('123456'); await page.locator('.auth button', { hasText: 'Turn on two-step sign-in' }).click(); await page.waitForTimeout(1600);
  check(await page.locator('.auth').count() === 0 && await page.locator('main').count() === 1, 'once set up, Petti opens');
  check(!errs.length, `hard stop: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* 4. a requester: optional, no reminder, can turn it off again */
{
  const { ctx, page, errs } = await open('requester', '#/home');
  check(await page.locator('#two-step-banner').count() === 0, 'requester: no reminder on Home');
  await page.goto(base + '#/account'); await page.waitForTimeout(1200);
  check(/Recommended for anyone who handles money/.test(await page.locator('#two-step').innerText()), 'requester: Account offers it as optional');
  check(!errs.length, `requester: no page errors ${errs.join('|')}`);
  await ctx.close();
  const on = await open('requester', '#/account', { twoStep: 'on' });
  const off = on.page.locator('#two-step button', { hasText: 'Turn off' });
  check(await off.count() === 1, 'optional and on: it can be turned off');
  await off.click(); await on.page.locator('.modal button', { hasText: 'Turn off' }).click(); await on.page.waitForTimeout(800);
  check(/Off/.test(await on.page.locator('#two-step .sheet-head').innerText()), 'turned off');
  await on.ctx.close();
}

/* 5. the GM: who has it, a reset for a lost phone, the date, and the logo */
{
  const { ctx, page, errs } = await open('approver', '#/admin/users', { twoStep: 'on', w: 1280 });
  const fiona = page.locator('tr', { hasText: 'Fiona Shikongo' });
  check(/On/.test(await fiona.locator('.two-step-cell').innerText().catch(() => '')), 'People: shows who has two-step sign-in');
  check(/Not yet/.test(await page.locator('tr', { hasText: 'Paulus Nghipondoka' }).innerText()) && /Off/.test(await page.locator('tr', { hasText: 'Rita Amadhila' }).locator('td').nth(-2).innerText()), 'People: a required position without it says "Not yet"; others "Off"');
  await fiona.locator('button', { hasText: 'Reset' }).click(); await page.waitForTimeout(300);
  check(/lost their phone/.test(await page.locator('.modal').innerText()), 'Reset asks first, and says when to use it');
  await page.locator('.modal button', { hasText: 'Reset' }).click(); await page.waitForTimeout(500);

  await page.goto(base + '#/admin/settings'); await page.waitForTimeout(1200);
  check(await page.locator('#set-two-step-from').inputValue() !== '', 'Settings: the required-from date can be moved');
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
