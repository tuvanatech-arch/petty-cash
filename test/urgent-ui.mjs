// Urgent requests (049) in the preview: the tick on the form (a reason is required), the red card at the top of the Home
// of whoever acts next, urgent first in the lists, the banner with how often the person used it, and marking / unmarking.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const uid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const b = await chromium.launch();
async function open(role, hash, w = 390) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } }); const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '#/home');
  await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); sessionStorage.setItem('pcs_update_shown', '1'); localStorage.setItem('demo_two_step', 'on'); }, role);
  await page.goto(base + hash); await page.reload(); await page.waitForTimeout(1600);
  return { ctx, page, errs };
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const text = async (page, css) => (await page.locator(css).innerText().catch(() => '')).replace(/\s+/g, ' ');

/* 1. the requester: tick Urgent, a reason is required */
{
  const { ctx, page, errs } = await open('requester', '#/requests/new/cash');
  check(await page.locator('#urgent').isVisible() && !(await page.locator('#urgent-why').isVisible()), 'form: an "Urgent" tick, the reason hidden until ticked');
  await page.locator('#urgent').check(); await page.waitForTimeout(150);
  check(await page.locator('#urgent-why').isVisible() && /never skips an approval/.test(await text(page, '#urgent-box')), 'ticked: "Why is it urgent?" with what it does and does not do');
  await page.fill('input[placeholder="e.g. Taxi to the bank"]', 'Locksmith, front door jammed').catch(() => {});
  await page.locator('button', { hasText: 'Save draft' }).click(); await page.waitForTimeout(500);
  check(/Say why it is urgent/.test(await page.locator('body').innerText()), 'no reason: refused, with what to do');
  check(await noSideScroll(page) && !errs.length, `form: phone fits, no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 2. finance: the red card on top of Home, urgent first in Requests, the banner, "Not urgent" */
{
  const { ctx, page, errs } = await open('finance', '#/home');
  const firstCard = await page.locator('main .sheet').nth(1).getAttribute('id').catch(() => null);
  const card = await text(page, '#urgent-card');
  check(firstCard === 'urgent-card' || (await page.locator('#urgent-card').count()) === 1, 'Home: an "Urgent" card for finance');
  check(/#1025/.test(card) && /#1022/.test(card) && /Water leaking under the sink/.test(card) && /The tender closes on Friday/.test(card), 'the card lists both urgent requests with their reasons');
  const top = await page.evaluate(() => { const c = document.getElementById('urgent-card'); const others = [...document.querySelectorAll('main .sheet')].filter((s) => s.querySelector('h2') && s !== c); return others.every((s) => c.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING); });
  check(top, 'it comes before every other to-do card');
  await page.goto(base + '#/requests'); await page.waitForTimeout(1200);
  const rows = await page.locator('main .ledger-list li').allInnerTexts();
  check(/Urgent/.test(rows[0] || '') && /Urgent/.test(rows[1] || '') && !/Urgent/.test(rows[2] || ''), 'Requests: the urgent ones first, with the red label');
  await page.goto(base + `#/requests/${uid(122)}`); await page.waitForTimeout(1300);
  const ban = await text(page, '#urgent-banner');
  check(/Urgent Water leaking under the sink/.test(ban) && /2nd urgent request from Joe this month/.test(ban), `the request: the reason, and how often Joe used it ("${ban.slice(0, 90)}")`);
  await page.locator('#not-urgent').click(); await page.waitForTimeout(400);
  check(/Why is it not urgent/.test(await text(page, '.modal')), '"Not urgent" asks why');
  await page.locator('.modal textarea, .modal input').first().fill('Plumber only free on Monday');
  await page.locator('.modal button', { hasText: 'Not urgent' }).click(); await page.waitForTimeout(1300);
  check(await page.locator('#urgent-banner').count() === 0 && await page.locator('.urgent-tag').count() === 0, 'the label is off');
  check(/No longer urgent · Fiona/.test(await page.locator('main').textContent()), '…and the history says so');
  check(await page.locator('#mark-urgent').count() === 0, 'finance cannot mark a sent request urgent');
  check(await noSideScroll(page) && !errs.length, `finance: phone fits, no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 3. the GM marks a waiting request urgent */
{
  const { ctx, page, errs } = await open('approver', `#/requests/${uid(115)}`);
  check(await page.locator('#urgent-banner').count() === 0 && await page.locator('#mark-urgent').isVisible(), 'GM: "Mark urgent" on a waiting request');
  await page.locator('#mark-urgent').click(); await page.waitForTimeout(400);
  await page.locator('.modal textarea, .modal input').first().fill('Keys needed for the auditors on Monday');
  await page.locator('.modal button', { hasText: 'Mark urgent' }).click(); await page.waitForTimeout(1300);
  const ban = await text(page, '#urgent-banner');
  check(/Keys needed for the auditors on Monday/.test(ban) && /Marked urgent by Ada Nangolo/.test(ban), 'marked: the banner shows why and who marked it');
  check(!errs.length, `GM: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 4. the requester's own urgent request: no "Not urgent", no count */
{
  const { ctx, page, errs } = await open('requester', `#/requests/${uid(122)}`);
  const ban = await text(page, '#urgent-banner');
  check(await page.locator('#not-urgent').count() === 0 && !/urgent request from/.test(ban), 'someone else viewing: no buttons, no count');
  check(!errs.length, `requester: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}
await b.close(); server.close();
console.log(fails.length ? `URGENT UI: ${fails.length} FAILED` : 'URGENT UI: PASS');
process.exit(fails.length ? 1 : 0);
