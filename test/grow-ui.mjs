// Text boxes grow as you type (styles.css field-sizing, and the ui.js fallback for browsers without it): on a phone and a
// computer, in a window (the GM's "Send a notice"), up to 60% of the screen and then scrolling inside; shorter again when
// text is removed; the page does not jump.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch();
const para = 'The plumber came on Tuesday to fix the kitchen tap and found the pipe behind the wall was cracked, so he replaced it as well. ';
for (const [mode, w, h] of [['native', 390, 760], ['native', 1280, 900], ['fallback', 390, 760], ['fallback', 1280, 900]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } }); const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  // a browser without field-sizing: the app's own code makes the box grow
  if (mode === 'fallback') await page.addInitScript(() => { const s = CSS.supports.bind(CSS); CSS.supports = (...a) => (String(a[0]).includes('field-sizing') ? false : s(...a)); });
  await page.goto(base + '#/home');
  await page.evaluate(() => { localStorage.setItem('demo_role', 'approver'); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); sessionStorage.setItem('pcs_update_shown', '1'); localStorage.setItem('demo_two_step', 'on'); });
  await page.goto(base + '#/admin/updates'); await page.reload(); await page.waitForTimeout(1500);
  if (mode === 'fallback') await page.addStyleTag({ content: 'textarea.input { field-sizing: fixed !important }' });
  await page.locator('main button', { hasText: 'Send a notice' }).click(); await page.waitForTimeout(500);
  const box = page.locator('#nt-msg'); const height = () => box.evaluate((t) => t.getBoundingClientRect().height);
  const start = await height();
  await box.click(); await box.pressSequentially(para, { delay: 0 }); await page.waitForTimeout(100);
  const one = await height();
  await box.pressSequentially(para + para, { delay: 0 }); await page.waitForTimeout(100);
  const three = await height();
  const fits = await box.evaluate((t) => t.scrollHeight <= t.clientHeight + 1);
  const tag = `${mode} ${w}px`;
  check(start >= 60 && one >= start && three > start && fits, `${tag}: the box grows as you type, with all the text showing (${Math.round(start)} → ${Math.round(one)} → ${Math.round(three)}px)`);
  await box.pressSequentially((para + '\n').repeat(12), { delay: 0 }); await page.waitForTimeout(100);
  const tall = await height();
  check(tall <= h * 0.6 + 2 && await box.evaluate((t) => t.scrollHeight > t.clientHeight), `${tag}: it stops at 60% of the screen and scrolls inside (${Math.round(tall)}px)`);
  await box.fill('Short.'); await box.dispatchEvent('input'); await page.waitForTimeout(100);
  check(Math.abs(await height() - start) <= 2, `${tag}: back to its starting size when the text is short again`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${tag}: no sideways scrolling`);
  check(!errs.length, `${tag}: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}
await b.close(); server.close();
console.log(fails.length ? `GROW UI: ${fails.length} FAILED` : 'GROW UI: PASS');
process.exit(fails.length ? 1 : 0);
