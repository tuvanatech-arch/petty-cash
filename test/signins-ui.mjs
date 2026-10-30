// The administrator's sign-in log: who, when, device, place, unusual ones flagged, filters work.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch();
for (const w of [1280, 390]) {
  const page = await (await b.newContext({ viewport: { width: w, height: 900 } })).newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '#/home'); await page.evaluate(() => { localStorage.setItem('demo_role', 'approver'); localStorage.setItem('pcs_push_asked', 'later'); });
  await page.goto(base + '#/admin/signins'); await page.reload(); await page.waitForTimeout(900);
  let t = await page.locator('main').innerText();
  check(/Sign-ins/.test(t) && /Lubango, Angola/.test(t) && /Two far-apart places/.test(t) && /Still signed in/.test(t) && /Signed out/.test(t), `${w}: log with places, flags and status`);
  check(await page.locator('main .ledger-list li').count() === 6, `${w}: six sign-ins`);
  await page.locator('main input[type=checkbox]').check(); await page.waitForTimeout(200);
  check(await page.locator('main .ledger-list li').count() === 3, `${w}: only unusual → 3`);
  await page.locator('main .ledger-list li').first().click(); await page.waitForTimeout(400);
  check(await page.locator('.modal').count() === 1, `${w}: tapping opens that person's devices`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${w}: no sideways scroll`);
  check(!errs.length, `${w}: no page errors ${errs.join('|')}`);
}
await b.close(); server.close();
console.log(fails.length ? `SIGN-INS UI: FAIL (${fails.length})` : 'SIGN-INS UI: PASS'); process.exit(fails.length ? 1 : 0);
