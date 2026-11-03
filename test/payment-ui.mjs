// Payment requests (042) in the preview: "Request a payment" on Home, the quote or "No quote" on the form, and
// finance choosing cash from the box or a bank transfer (only with a quote or invoice attached).
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const uid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const b = await chromium.launch();
async function open(role, hash, w = 1280) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } }); const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '#/home');
  await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); sessionStorage.setItem('pcs_update_shown', '1'); localStorage.setItem('demo_two_step', 'on'); }, role);
  await page.goto(base + hash); await page.reload(); await page.waitForTimeout(1500);
  return { ctx, page, errs };
}
const toastText = (page) => page.locator('#toast-root').innerText().catch(() => '');
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/* 1. the requester: Home → Request a payment → quote or "No quote" */
{
  const { ctx, page, errs } = await open('requester', '#/home');
  const btn = page.locator('#request-payment');
  check(await btn.innerText().catch(() => '') === 'Request a payment', 'Home: the button says "Request a payment"');
  check(await page.getByText('Ask for cash').count() === 0, 'Home: "Ask for cash" is gone');
  await btn.click(); await page.waitForTimeout(1200);
  check(await page.locator('h1').innerText() === 'Request a payment', 'the form is called "Request a payment"');
  check(await page.locator('.tabs button.active').innerText() === 'Payment', 'the "Payment" tab is chosen');
  check(await page.locator('#quote-box').isVisible() && /Attach the quote or invoice/.test(await page.locator('#quote-box').innerText()), 'the form asks for the quote or invoice');
  check(await page.locator('#no-quote').isVisible(), '…with a "No quote" tick box');
  await page.locator('input[placeholder^="e.g."]').first().fill('Taxi to the bank');
  await page.locator('#quote-box').scrollIntoViewIfNeeded();
  const amount = page.locator('input[placeholder="0.00"]');
  await amount.fill('80');
  await page.locator('button', { hasText: 'Submit request' }).click(); await page.waitForTimeout(600);
  check(/Attach the quote or invoice, or tick “No quote”/.test(await toastText(page)), 'sending with neither is stopped, with what to do');
  await page.locator('#no-quote').check();
  await page.locator('button', { hasText: 'Submit request' }).click(); await page.waitForTimeout(1500);
  check(/#\/requests\/[0-9a-f-]{36}/.test(page.url()), 'with "No quote" ticked it is sent');
  check(!errs.length, `requester form: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 2. attaching a quote on the draft fills in the amount */
{
  const { ctx, page, errs } = await open('requester', '#/requests/new');
  await page.locator('input[placeholder^="e.g."]').first().fill('Plumber for the kitchen tap');
  await page.locator('#attach-quote input[type=file]').setInputFiles({ name: 'quote-plumber.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%quote\n') });
  await page.waitForTimeout(3000);
  check(await page.locator('#quote-list li').count() === 1, 'the quote is attached and listed on the form');
  check(await page.locator('#no-quote').count() === 0, 'with a quote attached, "No quote" is no longer offered');
  check(/Quote attached/.test(await toastText(page)), `it says so: "${(await toastText(page)).slice(0, 60)}"`);
  check(!errs.length, `quote attach: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 3. finance: a request with a quote can be paid by bank transfer */
{
  const { ctx, page, errs } = await open('finance', `#/requests/${uid(122)}`);
  const tabs = page.locator('#pay-how button');
  check(await tabs.count() === 2 && await tabs.nth(0).innerText() === 'Cash from the box' && await tabs.nth(1).innerText() === 'Bank transfer', 'finance chooses: Cash from the box, or Bank transfer');
  check(await page.locator('#pay-panel h2').innerText() === 'Pay out from petty cash', 'cash from the box is the default, as before');
  await tabs.nth(1).click(); await page.waitForTimeout(300);
  check(await page.locator('#pay-panel h2').innerText() === 'Pay by bank transfer', 'Bank transfer: the panel says so');
  check(await page.locator('#transfer-amount').inputValue() === '650.00', 'the amount comes from the quote');
  check(/petty cash box is not touched/.test(await page.locator('#pay-panel').innerText()) && /Aqua Plumbing Windhoek/.test(await page.locator('#pay-panel').innerText()), 'it says the box is not touched, and whose quote it is');
  await page.locator('#record-transfer').click(); await page.waitForTimeout(500);
  check(/bank reference/.test(await toastText(page)), 'the bank reference is required');
  await page.locator('#transfer-ref').fill('FNB 4471023');
  await page.locator('#record-transfer').click(); await page.waitForTimeout(1800);
  check(/Paid by bank transfer/.test(await page.locator('.banner').first().innerText().catch(() => '')), 'recorded: the request shows "Paid by bank transfer"');
  check(/FNB 4471023/.test(await page.locator('#transfer-detail').textContent().catch(() => '')), 'the details show the reference (under "What was asked for")');
  check(/What was paid/.test(await page.locator('main').innerText()) && !/Change returned/.test(await page.locator('main').innerText()), 'what was paid, with no change line');
  check(!errs.length, `finance transfer: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 4. finance: sent with no quote, so cash only */
{
  const { ctx, page, errs } = await open('finance', `#/requests/${uid(121)}`);
  check(await page.locator('#pay-how').count() === 0, 'no quote: no bank transfer option');
  check(/Sent with no quote, so it is paid in cash from the box/.test(await page.locator('#cash-only').innerText().catch(() => '')), 'it says why');
  check(/None – sent without a quote or invoice/.test(await page.locator('#no-quote-note').innerText().catch(() => '')), '"No quote" is shown on the request');
  check(!errs.length, `finance no quote: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 5. the GM can record a transfer too; on a phone it fits */
{
  const { ctx, page, errs } = await open('approver', `#/requests/${uid(122)}`, 390);
  check(await page.locator('#pay-how button').count() === 2, 'the GM sees the same choice');
  await page.locator('#pay-how button').nth(1).click(); await page.waitForTimeout(300);
  check(await noSideScroll(page), 'phone: the transfer form fits without sideways scrolling');
  check(!errs.length, `GM phone: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 6. the requester sees what finance can do with the quote */
{
  const { ctx, page, errs } = await open('requester', `#/requests/${uid(121)}`);
  check(/Finance pays it in cash from the petty cash box\./.test(await page.locator('.banner').first().innerText().catch(() => '')), 'no quote: the requester is told it is paid in cash');
  check(!errs.length, `requester detail: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

await b.close(); server.close();
console.log(fails.length ? `PAYMENT UI: ${fails.length} FAILED` : 'PAYMENT UI: PASS');
process.exit(fails.length ? 1 : 0);
