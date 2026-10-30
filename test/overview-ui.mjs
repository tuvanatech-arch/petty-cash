// The MD's Home: approvals first, then the live overview (status, recommendations, charts, tracking); others unchanged.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch();
async function open(role, w = 1280) {
  const page = await (await b.newContext({ viewport: { width: w, height: 900 } })).newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '#/home'); await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); }, role);
  await page.goto(base + '#/home'); await page.reload(); await page.waitForTimeout(1200);
  return { page, errs };
}
let { page, errs } = await open('managing_director');
let t = await page.locator('main').innerText();
check(/Overview/.test(t) && /Live/.test(t) && /updated \d\d:\d\d/.test(t), 'MD: the overview is on Home and says it is live');
check(/In the box/.test(t) && /Spent this month/.test(t) && /Cash out with people/.test(t) && /Waiting for approval/.test(t) && /Cash box last counted/.test(t), 'MD: the five status boxes');
check(/What to look at/.test(t) && await page.locator('.rec').count() > 0, 'MD: recommendations');
check(await page.locator('.overview svg').count() >= 2, 'MD: charts are drawn');
check(/Where requests are/.test(t) && /Cash out with people/.test(t) && /The cash box/.test(t) && /How quickly it moves/.test(t), 'MD: tracking sections');
check(/Where the money goes/.test(t) && /Budgets this month/.test(t), 'MD: spending by category and budgets');
const order = await page.evaluate(() => { const m = document.querySelector('main').innerText; return [m.indexOf('Needs your approval'), m.indexOf('Overview')]; });
check(order[0] >= 0 && order[1] > order[0], 'MD: approvals come before the overview');
check(!/Your open requests/.test(t) && !/Elsewhere:/.test(t), 'MD: no clutter below the overview');
check(await page.evaluate(() => window.__liveChannels) === 1, 'MD: one live channel open');
const top = await page.locator('.rec').first().innerText(); console.log('   first recommendation:', top.replace(/\n/g, ' | ').slice(0, 160));
const scrollBefore = await page.evaluate(() => { window.scrollTo(0, 400); return window.scrollY; });
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
check(errs.length === 0, `MD: no page errors (${errs.join(' | ')})`);
// leaving the page lets the live connection go
await page.goto(base + '#/requests'); await page.waitForTimeout(800); await page.goto(base + '#/home'); await page.waitForTimeout(1200);
check(await page.evaluate(() => window.__liveChannels) <= 2, 'MD: coming back does not pile up connections');
// phone width
({ page, errs } = await open('managing_director', 390));
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'MD on a phone: no sideways scroll');
check(errs.length === 0, 'MD on a phone: no page errors');
// others do not get it
for (const role of ['approver', 'finance', 'requester']) {
  ({ page, errs } = await open(role));
  check(!/What to look at/.test(await page.locator('main').innerText()) && errs.length === 0, `${role}: Home unchanged`);
}
await b.close(); server.close();
console.log(fails.length ? `OVERVIEW UI: FAIL (${fails.length})` : 'OVERVIEW UI: PASS');
process.exit(fails.length ? 1 : 0);
