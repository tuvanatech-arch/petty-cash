// The subscription in the app: nothing shows until a plan is set; the plan's places on Admin → People; a full plan
// stops "Add person"; Download everything; cancelling (typed company name), the banner for each role, and keeping Petti.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
// the zip library the app loads from a CDN, served from the test's own copy
const jszip = `const module = { exports: {} }; const exports = module.exports;\n${readFileSync(new URL('./node_modules/jszip/dist/jszip.min.js', import.meta.url), 'utf8')}\nexport default module.exports;`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch();
async function open(role, hash, plan, w = 1280) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 }, acceptDownloads: true }); const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.route(/cdn\.jsdelivr\.net\/npm\/jszip/, (r) => r.fulfill({ contentType: 'text/javascript', body: jszip }));
  await page.goto(base + '#/home');
  await page.evaluate(([r, p]) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); sessionStorage.setItem('pcs_update_shown', '1'); localStorage.setItem('demo_two_step', 'on'); if (p) localStorage.setItem('demo_plan', JSON.stringify(p)); else localStorage.removeItem('demo_plan'); }, [role, plan]);
  await page.goto(base + hash); await page.reload(); await page.waitForTimeout(1500);
  return { ctx, page, errs };
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/* 1. no plan set (MGP today): nothing new to see */
{
  const { ctx, page, errs } = await open('approver', '#/admin/users', null);
  check(await page.locator('#plan-line').count() === 0, 'no plan: People shows no plan line');
  await page.goto(base + '#/admin/settings'); await page.waitForTimeout(1000);
  check(await page.locator('#subscription').count() === 0 && await page.locator('#cancelled-banner').count() === 0, 'no plan: no subscription section, no banner');
  check(!errs.length, `no plan: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 2. a Business plan with room */
{
  const { ctx, page, errs } = await open('approver', '#/admin/users', { plan: 'business', people_limit: 30, branch_limit: 3 });
  const line = await page.locator('#plan-line').innerText().catch(() => '');
  check(/^\d+ of 30 people on your Business plan\./.test(line) && /switch off do not count/.test(line), `People: "${line.split('\n')[0]}"`);
  await page.locator('.page-actions button', { hasText: 'Add person' }).click(); await page.waitForTimeout(300);
  check(/Add a person/.test(await page.locator('.modal').innerText().catch(() => '')), 'with room, Add person opens the form');
  check(!errs.length, `room: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 3. a full plan */
{
  const { ctx, page, errs } = await open('approver', '#/admin/users', { plan: 'starter', people_limit: 7, branch_limit: 1 });
  const line = await page.locator('#plan-line').innerText().catch(() => '');
  check(/7 of 7 people on your Starter plan\./.test(line) && /It is full/.test(line) && /\+264 81 495 0605/.test(line), 'full: People says so, with how to upgrade');
  await page.locator('.page-actions button', { hasText: 'Add person' }).click(); await page.waitForTimeout(300);
  const m = await page.locator('.modal').innerText().catch(() => '');
  check(/Your plan is full/.test(m) && /allows 7 people/.test(m) && !/Add a person/.test(m), 'full: Add person explains instead of opening the form');
  await page.locator('.modal button', { hasText: 'OK' }).click();
  await page.goto(base + '#/admin/branches'); await page.waitForTimeout(1000);
  await page.locator('.page-actions button', { hasText: 'Add branch' }).click(); await page.waitForTimeout(300);
  check(/allows 1 branch,/.test(await page.locator('.modal').innerText().catch(() => '')), 'full: Add branch explains too (one branch)');
  check(!errs.length, `full: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 4. the subscription, Download everything, cancelling and keeping */
{
  const { ctx, page, errs } = await open('approver', '#/admin/settings', { plan: 'business', people_limit: 30, branch_limit: 3 });
  const sub = page.locator('#subscription');
  check(/Business/.test(await sub.innerText()) && /of 30/.test(await sub.innerText()) && /of 3/.test(await sub.innerText()), 'Settings: the plan, people and branches');
  await sub.locator('#download-everything').click(); await page.waitForTimeout(1500);
  check(/Downloaded 3 months with 4 receipts/.test(await page.locator('#everything-status').innerText()), 'Download everything reports what it packed (the preview stands in for the zip; export-all-test builds a real one)');
  await sub.locator('#cancel-petti').click(); await page.waitForTimeout(300);
  const dlg = page.locator('.modal');
  check(/Download everything first/.test(await dlg.innerText()) && await dlg.locator('#cancel-go').isDisabled(), 'Cancel: offers the download first; the button waits for the name');
  await dlg.locator('#cancel-confirm').fill('Tuvana');
  check(await dlg.locator('#cancel-go').isDisabled(), 'a wrong name keeps it disabled');
  const org = await page.evaluate(async () => (await import('./js/api.js')).state.settings.org_name);
  await dlg.locator('#cancel-confirm').fill(` ${org.toUpperCase()} `);
  check(await dlg.locator('#cancel-go').isEnabled(), 'the company name, in any case, enables it');
  await dlg.locator('#cancel-go').click(); await page.waitForTimeout(1500);
  const banner = await page.locator('#cancelled-banner').innerText().catch(() => '');
  check(/Petti has been cancelled\. Everything is removed for good on/.test(banner) && /keep Petti/.test(banner), 'after cancelling: a banner with the date, and for the GM a link to keep it');
  check(/Cancelled/.test(await page.locator('#subscription').innerText()) && await page.locator('#keep-petti').count() === 1 && await page.locator('#cancel-petti').count() === 0, 'Settings shows who cancelled and offers Keep Petti');
  await ctx.close();
  // what the others see while it is cancelled
  const removeOn = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  for (const [role, re] of [['finance', /Download the records you need from Petty cash/], ['requester', /Ask finance for any records/]]) {
    const o = await open(role, '#/home', { plan: 'business', people_limit: 30, branch_limit: 3, status: 'cancelled', remove_on: removeOn, cancelled_at: new Date().toISOString(), cancelled_by: 'Ada Nangolo' }, 390);
    check(re.test(await o.page.locator('#cancelled-banner').innerText().catch(() => '')) && await noSideScroll(o.page), `${role}: the banner says what to do, on a phone`);
    await o.ctx.close();
  }
  // keeping it
  const k = await open('approver', '#/admin/settings', { plan: 'business', people_limit: 30, branch_limit: 3, status: 'cancelled', remove_on: removeOn, cancelled_at: new Date().toISOString(), cancelled_by: 'Ada Nangolo' });
  await k.page.locator('#keep-petti').click(); await k.page.waitForTimeout(300);
  await k.page.locator('.modal button', { hasText: 'Keep Petti' }).last().click(); await k.page.waitForTimeout(1500);
  check(await k.page.locator('#cancelled-banner').count() === 0 && await k.page.locator('#cancel-petti').count() === 1, 'Keep Petti: the banner goes and Cancel is offered again');
  check(!errs.length && !k.errs.length, `cancelling: no page errors ${[...errs, ...k.errs].join(' | ')}`);
  await k.ctx.close();
}

await b.close(); server.close();
console.log(fails.length ? `SUBSCRIPTION UI: FAIL (${fails.length})` : 'SUBSCRIPTION UI: PASS'); process.exit(fails.length ? 1 : 0);
