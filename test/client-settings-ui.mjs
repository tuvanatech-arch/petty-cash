// One codebase, many clients: an administrator sets the region and the position titles, and every screen follows.
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
  await page.goto(base + '#/admin/settings'); await page.reload(); await page.waitForTimeout(900);
  let t = await page.locator('main').innerText();
  check(/Region/.test(t) && /Position titles/.test(t), `${w}: region and titles on Admin → Settings`);
  check(/Default: GM/.test(t) && /Default: Managing Director/.test(t), `${w}: the app's own words shown as defaults`);
  // before: MGP's words and Namibian numbers
  await page.goto(base + '#/admin/schedule'); await page.waitForTimeout(700);
  t = await page.locator('main').innerText();
  check(/\bGM\b/.test(t) && /\d,\d{3}\.\d{2}/.test(t), `${w}: before – GM and 5,000.00 style`);
  // an Angolan client
  await page.goto(base + '#/admin/settings'); await page.waitForTimeout(700);
  // (the preview never saves, so the Angolan client's settings are loaded the way a sales demo would load them)
  await page.evaluate(() => localStorage.setItem('demo_settings', JSON.stringify({ org_name: 'Lobito Supply Co', currency: 'Kz ', time_zone: 'Africa/Luanda', number_locale: 'pt-AO',
    titles: { gm: 'DG', gm_long: 'Director-Geral', md: 'PCA', md_long: 'Presidente do Conselho' } })));
  await page.reload(); await page.waitForTimeout(900);
  check(await page.inputValue('#set-title-gm') === 'DG' && await page.inputValue('#set-locale') === 'pt-AO' && await page.inputValue('#set-tz') === 'Africa/Luanda', `${w}: the client's titles and region show in Settings`);
  t = await page.locator('main').innerText();
  check(/Default: GM/.test(t), `${w}: the defaults hint still names the app's own word`);
  await page.goto(base + '#/admin/schedule'); await page.waitForTimeout(800);
  t = await page.locator('main').innerText();
  check(!/\bGM\b/.test(t) && !/\bMD\b/.test(t) && /\bDG\b/.test(t), `${w}: schedule speaks of the DG, never the GM or MD`);
  await page.goto(base + '#/home'); await page.waitForTimeout(800);
  t = await page.locator('main').innerText() + await page.locator('nav, .side, .topbar').allInnerTexts().then((a) => a.join(' '));
  check(!/\bGM\b/.test(t) && !/General Manager/.test(t), `${w}: home has no GM left`);
  check(/\d\s\d{3},\d{2}/.test(t) && !/\d,\d{3}\.\d{2}/.test(t), `${w}: amounts written the Angolan way (3 000,00)`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${w}: no sideways scroll`);
  check(!errs.length, `${w}: no page errors ${errs.join('|')}`);
}
await b.close(); server.close();
console.log(fails.length ? `CLIENT SETTINGS UI: FAIL (${fails.length})` : 'CLIENT SETTINGS UI: PASS'); process.exit(fails.length ? 1 : 0);
