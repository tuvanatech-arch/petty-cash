// "Put it on your …" says what the person is using: phone, iPad, tablet or computer (install page and Account).
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const DEVICES = [
  ['computer', null, 1280, 'Put it on your computer', /Computer/, /opens in its own window/],
  ['phone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 390, 'Put it on your phone', /iPhone/, /long press on the Petti icon/],
  ['iPad', 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 820, 'Put it on your iPad', /iPad/, /long press/],
  ['tablet', 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 820, 'Put it on your tablet', /Android tablet/, /long press/],
  ['Android phone', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36', 390, 'Put it on your phone', /Android phone/, /long press/],
];
const b = await chromium.launch();
for (const [name, ua, w, label, lead, hint] of DEVICES) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 }, ...(ua ? { userAgent: ua } : {}) }); const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '#/home');
  await page.evaluate(() => { localStorage.setItem('demo_role', 'requester'); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); sessionStorage.setItem('pcs_update_shown', '1'); });
  await page.goto(base + '#/install'); await page.reload(); await page.waitForTimeout(1200);
  const t = await page.locator('main, .auth').first().innerText().catch(() => '');
  check((await page.locator('h1').first().innerText()) === label && lead.test(t) && hint.test(t), `${name}: the install page says "${label}"`);
  await page.goto(base + '#/account'); await page.waitForTimeout(1200);
  check(await page.getByText(label, { exact: true }).count() >= 1, `${name}: Account offers "${label}"`);
  check(!errs.length, `${name}: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}
await b.close(); server.close();
console.log(fails.length ? `INSTALL LABEL UI: ${fails.length} FAILED` : 'INSTALL LABEL UI: PASS');
process.exit(fails.length ? 1 : 0);
