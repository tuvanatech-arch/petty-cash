// Petty cash in two places (043) in the preview: the box and the bank account side by side, Move cash, Check the
// bank, the close asking for the statement; the person handed cash confirms it; the requester confirms the supplier.
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
  await page.goto(base + hash); await page.reload(); await page.waitForTimeout(1600);
  return { ctx, page, errs };
}
const toastText = (page) => page.locator('#toast-root').innerText().catch(() => '');
const tiles = async (page) => (await page.locator('#cash-places').innerText().catch(() => '')).replace(/\s+/g, ' ');
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/* 1. finance: the box and the bank account, side by side */
{
  const { ctx, page, errs } = await open('finance', '#/cash');
  const t = await tiles(page);
  check(/Cash box N\$1,765\.03/.test(t) && /Bank account N\$1,150\.00 FNB petty cash account/.test(t) && /Petty cash in total N\$2,915\.03/.test(t), `the two places and the total: "${t.slice(0, 120)}"`);
  check(/Bank account · FNB petty cash account/.test(await page.locator('#bank-sheet').innerText().catch(() => '')), 'the bank account has its own sheet');
  check(/Cash box ledger/.test(await page.locator('#cash-ledger').innerText()) && /Bank account ledger/.test(await page.locator('#bank-ledger').innerText()) && /Aircon service/.test(await page.locator('#bank-ledger').innerText()), 'two ledgers: the box, and the bank with the transfer');
  check(!/Aircon service/.test(await page.locator('#cash-ledger').innerText()), 'the transfer is not in the box ledger');

  // move cash: bank → box
  await page.locator('#move-cash').click(); await page.waitForTimeout(400);
  await page.locator('#move-amount').fill('200');
  await page.locator('.modal button[type=submit]').click(); await page.waitForTimeout(500);
  check(/photo of the bank slip, or say why/.test(await toastText(page)), 'a withdrawal needs the slip or a note');
  await page.locator('#move-note').fill('ATM, no slip');
  await page.locator('.modal button[type=submit]').click(); await page.waitForTimeout(1500);
  const t2 = await tiles(page);
  check(/Cash box N\$1,965\.03/.test(t2) && /Bank account N\$950\.00/.test(t2) && /Petty cash in total N\$2,915\.03/.test(t2), 'N$200 moved: box up, bank down, total the same');
  check(/Cash withdrawn from the bank/.test(await page.locator('#cash-ledger').innerText()) && /Cash withdrawn into the box/.test(await page.locator('#bank-ledger').innerText()), 'both ledgers show the move');

  // check the bank
  await page.locator('#check-bank').click(); await page.waitForTimeout(400);
  await page.locator('#statement').fill('940');
  check(/N\$10\.00 below the book balance of N\$950\.00/.test(await page.locator('.modal').innerText()), 'the bank check compares with the book as you type');
  await page.locator('.modal button[type=submit]').click(); await page.waitForTimeout(500);
  check(/Say what caused it/.test(await toastText(page)), 'a difference needs a note');
  await page.locator('.modal textarea').fill('Bank charges');
  await page.locator('.modal button[type=submit]').click(); await page.waitForTimeout(1500);
  check(/Bank check · /.test(await page.locator('main').innerText()) && /N\$10\.00 below the book/.test(await page.locator('main').innerText()), 'the bank check is listed for the GM to sign off');

  // the close asks for the statement too
  await page.locator('button', { hasText: 'Close & reconcile' }).click(); await page.waitForTimeout(400);
  check(await page.locator('.modal #statement').count() === 1 && /Balance on the bank statement \(FNB petty cash account\)/.test(await page.locator('.modal').innerText()), 'the month-end close asks for the bank statement');
  await page.keyboard.press('Escape');
  // money in: into the box or the bank account
  await page.locator('button', { hasText: 'Record the cash' }).click(); await page.waitForTimeout(400);
  check(await page.locator('.modal #place-choice').count() === 1, 'a top-up can arrive in the box or the bank account');
  check(!errs.length, `finance cash page: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 2. a branch without a bank account (the GM looking at Lüderitz): as before, with a way to add one */
{
  const { ctx, page, errs } = await open('approver', '#/home');
  await page.evaluate(() => localStorage.setItem('demo_view', '00000082-0000-4000-8000-000000000000'));
  await page.goto(base + '#/cash'); await page.reload(); await page.waitForTimeout(1600);
  check(await page.locator('#cash-places').count() === 0 && await page.locator('#move-cash').count() === 0 && await page.locator('#bank-ledger').count() === 0, 'no bank account: the box only, no Move cash, one ledger');
  check(/Add the petty cash bank account/.test(await page.locator('#bank-setup').innerText().catch(() => '')), 'and a way to add the account');
  await page.locator('#bank-setup a').click(); await page.waitForTimeout(300);
  await page.locator('#bank-name').fill('Bank Windhoek petty cash');
  check(/What is in the account now/.test(await page.locator('.modal').innerText()), 'adding the account asks what is in it now');
  await page.locator('#bank-opening').fill('3250.40');
  await page.locator('.modal button[type=submit]').click(); await page.waitForTimeout(1500);
  check(/Bank account N\$3,250\.40 Bank Windhoek petty cash/.test(await tiles(page)), 'once named, the box and the account show side by side, starting at the statement balance');
  check(/Opening balance of Bank Windhoek petty cash/.test(await page.locator('#bank-ledger').innerText().catch(() => '')), 'the bank ledger starts with the opening balance');
  check(!errs.length, `no-bank branch: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 3. the person handed cash confirms it */
{
  const { ctx, page, errs } = await open('requester', '#/home', 390);
  check(/Did you receive this cash\?/.test(await page.locator('main').innerText()) && await page.locator('#cash-ask li').count() === 1, 'Home asks: Did you receive this cash?');
  await page.locator('#cash-ask li').first().click(); await page.waitForTimeout(1500);
  check(/Did you receive N\$120\.00 from Fiona Shikongo\?/.test(await page.locator('#cash-question').innerText().catch(() => '')), 'the request asks, with the amount and who paid');
  await page.locator('#cash-yes').click(); await page.waitForTimeout(1500);
  check(await page.locator('#cash-question').count() === 0 && /Yes – Rita Amadhila/.test(await page.locator('#cash-received-detail').textContent().catch(() => '')), '"Yes, I received it" is kept on the request');
  check(await noSideScroll(page), 'phone: no sideways scrolling');
  check(!errs.length, `cash question: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 4. the requester confirms the supplier delivered */
{
  const { ctx, page, errs } = await open('requester', `#/requests/${uid(124)}`, 390);
  check(/Waiting for the supplier/.test(await page.locator('main').innerText()), 'the transfer shows "Waiting for the supplier"');
  check(/Has the supplier delivered\?/.test(await page.locator('#supplier-panel').innerText()) && await page.locator('#share-pop').count() === 1, 'the requester sees the question and can share the proof of payment');
  await page.locator('#supplier-note').fill('Both units serviced');
  await page.locator('#supplier-confirmed').click(); await page.waitForTimeout(1500);
  check(/Paid by bank transfer/.test(await page.locator('.banner').first().innerText()) && /Supplier confirmed by Rita Amadhila/.test(await page.locator('.banner').first().innerText()), 'closed: paid by transfer, supplier confirmed');
  check(!errs.length, `supplier: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 5. finance's Home: a transfer waiting for the supplier is not a receipt to check */
{
  const { ctx, page, errs } = await open('finance', '#/home');
  const t = await page.locator('main').innerText();
  check(!/Receipts to check[\s\S]*Aircon service/.test(t.split('To pay out')[0] || ''), 'the transfer is not among the receipts to check');
  check(!errs.length, `finance home: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

await b.close(); server.close();
console.log(fails.length ? `PLACES UI: ${fails.length} FAILED` : 'PLACES UI: PASS');
process.exit(fails.length ? 1 : 0);
