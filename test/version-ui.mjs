// A new version reaches a phone that only resumes Petti (never closes it): when the app comes back to the screen
// it notices the newer version and switches over – at once on a quiet screen, but never in the middle of a form
// (then it waits for the next change of screen).
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
let build = 'aaa111';   // what the server is "deployed" with; index.html carries it the way the real deploy does
const server = http.createServer((req, res) => {
  let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  if (!existsSync(p)) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream');
  if (p.endsWith('index.html')) return res.end(readFileSync(p, 'utf8').replace('src="js/app.js"', `src="js/app.js?v=${build}"`));
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 800 } }); const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(base + '#/home'); await page.evaluate(() => { localStorage.setItem('demo_role', 'requester'); localStorage.setItem('pcs_push_asked', 'later'); sessionStorage.setItem('pcs_update_shown', '1'); });
await page.reload(); await page.waitForTimeout(1800);
const loaded = () => page.evaluate(() => document.querySelector('script[type=module]').getAttribute('src'));
const comeBack = () => page.evaluate(async () => { const { checkVersion } = await import(new URL('js/version.js', location.href).href); return checkVersion({ force: true }); });   // the same copy the app uses

check(await comeBack() === false, 'same version: nothing happens');

// 1. quiet screen: switches over straight away, and says so
build = 'bbb222';
await Promise.all([page.waitForEvent('load', { timeout: 8000 }).catch(() => null), comeBack()]); await page.waitForTimeout(2000);
check(/v=bbb222/.test(await loaded()), 'new version on a quiet screen: Petti switches over at once');
check(/updated to the latest version/.test(await page.locator('.toast').allInnerTexts().then((t) => t.join(' '))), '…and says it has been updated');

// 2. half-filled form: waits, then switches at the next screen
await page.evaluate(() => { location.hash = '#/requests/new'; }); await page.waitForTimeout(1500);
await page.locator('input[placeholder]').first().fill('Printer paper'); await page.locator('main h1').click();
build = 'ccc333';
await comeBack(); await page.waitForTimeout(1500);
check(/v=bbb222/.test(await loaded()) && await page.locator('input[placeholder]').first().inputValue() === 'Printer paper', 'a form being filled in is left alone');
await Promise.all([page.waitForEvent('load', { timeout: 8000 }).catch(() => null), page.evaluate(() => { location.hash = '#/requests'; })]); await page.waitForTimeout(2000);
check(/v=ccc333/.test(await loaded()) && /#\/requests$/.test(page.url()), 'the next screen opens in the new version');
check(!errs.length, `no page errors ${errs.join('|')}`);

await b.close(); server.close();
console.log(fails.length ? `VERSION UI: FAIL (${fails.length})` : 'VERSION UI: PASS'); process.exit(fails.length ? 1 : 0);
