// Start from the document (052): a quote or invoice fills in a payment request (form and Snap), a receipt fills in a
// claim, and finance sees the supplier's bank details read from the invoice when paying by transfer.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const uid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const pdf = (name) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') });
const isoDay = (offset) => { const x = new Date(); x.setDate(x.getDate() + offset); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const b = await chromium.launch();
async function open(role, hash, w = 390) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } }); const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '#/home');
  await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); sessionStorage.setItem('pcs_update_shown', '1'); localStorage.setItem('demo_two_step', 'off'); }, role);
  await page.goto(base + hash); await page.reload(); await page.waitForTimeout(1600);
  return { ctx, page, errs };
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/* 1. Request a payment: start from the invoice */
{
  const { ctx, page, errs } = await open('requester', '#/requests/new/cash');
  check(await page.locator('#start-from-doc').isVisible(), 'the form offers "Have the quote or invoice? Start from it"');
  await page.locator('#start-from-doc input[type=file]').setInputFiles(pdf('aqua-invoice.pdf')); await page.waitForTimeout(3000);
  const purpose = await page.locator('input[placeholder]').first().inputValue();
  check(/Aqua Plumbing CC – Plumbing repair, kitchen tap/.test(purpose), `what it is for, from the invoice ("${purpose}")`);
  check(await page.locator('main input.num').first().inputValue() === '1450.00', 'the amount, from the invoice');
  const banner = await page.locator('#doc-filled').innerText().catch(() => '');
  check(/Filled in from the document/.test(banner) && /what it is for/.test(banner) && /the amount/.test(banner) && /needed by/.test(banner) && /Check each one/.test(banner), `says what was filled in ("${banner.replace(/\s+/g, ' ').slice(0, 120)}")`);
  check(await page.locator('input[type=date]').first().inputValue() === isoDay(7), 'needed by: the due date on the invoice');
  check(/Aqua Plumbing CC · N\$1,450\.00/.test(await page.locator('#quote-list').innerText().catch(() => '')) && await page.locator('#start-from-doc').count() === 0, 'the invoice is attached, and the start button goes away');
  check(await noSideScroll(page) && !errs.length, `form: phone fits, no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 2. Snap or upload a quote: "Request this payment" */
{
  const { ctx, page, errs } = await open('requester', '#/snap');
  await page.locator('main input[type=file]').first().setInputFiles(pdf('plumber-quote.pdf')); await page.waitForTimeout(3500);
  const t = await page.locator('main').innerText();
  check(/This is a quote still to be paid/.test(t) && await page.locator('#request-from-doc').isVisible(), 'Snap: a quote is recognised, with "Request this payment"');
  await page.locator('#request-from-doc').click(); await page.waitForTimeout(2500);
  check(/\/edit\?from=doc/.test(page.url()) && /Filled in from the document/.test(await page.locator('#doc-filled').innerText().catch(() => '')), 'it opens the filled-in payment request to check');
  check(/Aqua Plumbing CC – Plumbing repair, kitchen tap/.test(await page.locator('input[placeholder]').first().inputValue()), '…with what it is for');
  check(!errs.length, `snap: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 3. A claim: the receipt first */
{
  const { ctx, page, errs } = await open('requester', '#/requests/new/claim');
  await page.locator('main label.upload input[type=file]').first().setInputFiles(pdf('till-receipt.pdf')); await page.waitForTimeout(3500);
  const purpose = await page.locator('input[placeholder]').first().inputValue();
  check(/Pick n Pay Maerua – Milk and rusks for the kitchen/.test(purpose), `a claim with no purpose typed: filled in from the receipt ("${purpose}")`);
  check(/Filled in from the receipt/.test(await page.locator('#doc-filled').innerText().catch(() => '')), 'says what was filled in');
  check(!errs.length, `claim: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 4. Finance pays by transfer: the bank details from the quote */
{
  const { ctx, page, errs } = await open('finance', `#/requests/${uid(122)}`);
  await page.locator('#pay-how button', { hasText: 'Company account' }).click(); await page.waitForTimeout(400);
  const t = (await page.locator('#payee-bank').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check(/Pay to – read from the quote from Aqua Plumbing Windhoek/.test(t) && /Account number 8001234567/.test(t) && /Branch code 481972/.test(t) && /Their reference Q-1187/.test(t), `the supplier's bank details, from the quote ("${t.slice(0, 120)}")`);
  check(/fraudsters change bank details/.test(t), '…with the warning to check them');
  check(await noSideScroll(page) && !errs.length, `finance: phone fits, no page errors ${errs.join(' | ')}`);
  await ctx.close();
}
await b.close(); server.close();
console.log(fails.length ? `DOCS UI: ${fails.length} FAILED` : 'DOCS UI: PASS');
process.exit(fails.length ? 1 : 0);
