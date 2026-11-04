// Passwords: the strength rating (and its tips) as people type, the suggestion, the eye button, the stronger password
// asked for after signing in with a weak one, and strong temporary passwords for new people.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch();
async function open(role, hash, { weak = false, w = 390 } = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } }); const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '#/home');
  await page.evaluate(([r, wk]) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); sessionStorage.setItem('pcs_update_shown', '1'); localStorage.setItem('demo_two_step', 'off'); if (wk) sessionStorage.setItem('pcs_pw_weak', '1'); else sessionStorage.removeItem('pcs_pw_weak'); }, [role, weak]);
  await page.goto(base + hash); await page.reload(); await page.waitForTimeout(1600);
  return { ctx, page, errs };
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/* 1. the rating itself */
{
  const { ctx, page } = await open('finance', '#/home');
  const r = await page.evaluate(async () => {
    const m = await import('./js/password.js');
    const who = { email: 'fiona.shikongo@mgp.com.na', name: 'Fiona Shikongo', org: 'MGP' };
    const rate = (p) => m.rate(p, who);
    const sug = Array.from({ length: 20 }, () => m.suggest());
    return { pw123: rate('password123'), short: rate('Ada2026!'), name: rate('Fiona2025!'), word: rate('Windhoek1!'), run: rate('abcd1234efgh'),
      long: rate('kudu river comet lantern'), strong: rate('Kudu-river-Comet!42'), sug: sug.map((s) => rate(s).ok).every(Boolean), sugEx: sug[0] };
  });
  check(r.pw123.score <= 1 && !r.pw123.ok && /common words/.test(r.pw123.tips.join(' ')), `"password123": weak, says why (${r.pw123.label})`);
  check(!r.short.ok && /at least 10 characters/.test(r.short.tips.join(' ')), `"Ada2026!": too short (${r.short.label})`);
  check(!r.name.ok && /your name/.test(r.name.tips.join(' ')), `"Fiona2025!": her own name is not accepted (${r.name.label})`);
  check(!r.word.ok, `"Windhoek1!": a common word with a number on the end is not accepted (${r.word.label})`);
  check(!r.run.ok, `"abcd1234efgh": runs are not accepted (${r.run.label})`);
  check(r.long.ok && r.strong.ok && r.strong.score >= 3, `four random words, and a mixed 19-character password, are accepted (${r.long.label}, ${r.strong.label})`);
  check(r.sug, `every suggestion is accepted (e.g. ${r.sugEx})`);
  await ctx.close();
}

/* 2. Account: rated as you type, tips, the suggestion, and the eye */
{
  const { ctx, page, errs } = await open('finance', '#/account');
  const pass = page.locator('#new-pass');
  await page.locator('summary', { hasText: 'Change password' }).click(); await page.waitForTimeout(200);
  await pass.fill('password1'); await page.waitForTimeout(100);
  const rateText = await page.locator('.pw-meter').first().innerText();
  check(/Very weak|Weak/.test(rateText) && /not accepted yet/.test(rateText) && /Avoid common words/.test(rateText), 'typing a weak one: the rating, "not accepted yet" and a tip');
  await page.locator('button', { hasText: 'Change password' }).click(); await page.waitForTimeout(300);
  check(/Not strong enough yet/.test(await page.locator('main .error').first().innerText()), 'saving a weak one is refused');
  check(await pass.getAttribute('type') === 'password', 'hidden by default');
  await page.locator('.pw-eye').first().click();
  check(await pass.getAttribute('type') === 'text' && await page.locator('.pw-eye').first().getAttribute('aria-pressed') === 'true', 'the eye shows it');
  await page.locator('.pw-eye').first().click();
  check(await pass.getAttribute('type') === 'password', 'and hides it again');
  await page.locator('.pw-suggest').first().click(); await page.waitForTimeout(100);
  const v = await pass.inputValue();
  check(/Good|Strong/.test(await page.locator('.pw-meter').first().innerText()) && await page.locator('#new-pass-2').inputValue() === v && await pass.getAttribute('type') === 'text', `"Suggest a strong one": filled in both boxes and shown (${v})`);
  check(await page.locator('#new-pass-2').locator('xpath=..').locator('.pw-eye').count() === 1, 'the second box has its eye too');
  check(await noSideScroll(page) && !errs.length, `Account: phone fits, no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* 3. signed in with a weak password: a stronger one first */
{
  const { ctx, page, errs } = await open('requester', '#/home', { weak: true });
  check(/Choose a stronger password/.test(await page.locator('h1').innerText()), 'after signing in with a weak password: "Choose a stronger password" before anything else');
  await page.fill('#new-pass', 'rita12345678'); await page.fill('#new-pass-2', 'rita12345678');
  await page.locator('button', { hasText: 'Save and continue' }).click(); await page.waitForTimeout(400);
  check(/Not strong enough yet/.test(await page.locator('.error').innerText()), 'a weak new one is refused');
  await page.fill('#new-pass', 'Oryx-meadow-Lantern#57'); await page.fill('#new-pass-2', 'Oryx-meadow-Lantern#5');
  await page.locator('button', { hasText: 'Save and continue' }).click(); await page.waitForTimeout(400);
  check(/do not match/.test(await page.locator('.error').innerText()), 'the two must match');
  await page.fill('#new-pass-2', 'Oryx-meadow-Lantern#57');
  await page.locator('button', { hasText: 'Save and continue' }).click(); await page.waitForTimeout(1500);
  check(/Good (morning|afternoon|evening)/.test(await page.locator('main').innerText().catch(() => '')), 'a strong one: saved, and Petti opens');
  check(await page.evaluate(() => sessionStorage.getItem('pcs_pw_weak')) === null, '…and is not asked again');
  check(await noSideScroll(page) && !errs.length, `weak sign-in: phone fits, no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* 4. new people get a strong temporary password */
{
  const { ctx, page, errs } = await open('approver', '#/admin/users', { w: 1280 });
  await page.locator('main button', { hasText: 'Password' }).first().click(); await page.waitForTimeout(400);
  const tmp = await page.locator('.modal input').first().inputValue();
  const ok = await page.evaluate(async (p) => (await import('./js/password.js')).rate(p).ok, tmp);
  check(ok && /Strong by default/.test(await page.locator('.modal').innerText()), `a temporary password is strong (${tmp})`);
  check(!errs.length, `GM: no page errors ${errs.join('|')}`);
  await ctx.close();
}
await b.close(); server.close();
console.log(fails.length ? `PASSWORD UI: ${fails.length} FAILED` : 'PASSWORD UI: PASS');
process.exit(fails.length ? 1 : 0);
