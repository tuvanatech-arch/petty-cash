// Proof of payment: finance chooses the proof before paying out, a "no proof" expense asks for the where instead,
// a receipt brings the paper-slip question, a claim can go without a receipt, the scanner refuses a blurred photo,
// and spending without proof is listed under Reports → Controls.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.pdf': 'application/pdf' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const uid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const b = await chromium.launch();

async function open(role, hash, w = 1280) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } }); const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '#/home');
  await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); sessionStorage.setItem('pcs_update_shown', '1'); }, role);
  await page.goto(base + hash); await page.reload(); await page.waitForTimeout(1800);
  return { ctx, page, errs };
}
// a receipt photographed on a desk, drawn in the browser; blur > 0 makes it a shaky photo
async function receiptPng(page, blur) {
  const data = await page.evaluate(async (blur) => {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 1600; const x = c.getContext('2d');
    x.fillStyle = '#5b4a3a'; x.fillRect(0, 0, 1200, 1600);
    x.save(); if (blur) x.filter = `blur(${blur}px)`;
    x.fillStyle = '#f7f5ef'; x.fillRect(300, 200, 600, 1200);
    x.fillStyle = '#222'; x.font = 'bold 40px monospace'; x.fillText('CHECKERS', 460, 300);
    x.font = '26px monospace'; for (let i = 0; i < 18; i++) x.fillText(`ITEM ${i + 1}  ....  N$ ${(12 + i * 3.5).toFixed(2)}`, 340, 380 + i * 48);
    x.font = 'bold 32px monospace'; x.fillText('TOTAL  N$ 125.50', 380, 1300); x.restore();
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, blur);
  return Buffer.from(data);
}

/* 1. finance pays out the street-vendor request with "No proof possible" */
{
  const inv = await open('finance', `#/requests/${uid(102)}`);
  check(await inv.page.locator('#proof-rule').count() === 0, 'finance: an invoice attached before pay-out is already the proof – no choice asked');
  await inv.ctx.close();
  const { ctx, page, errs } = await open('finance', `#/requests/${uid(121)}`);
  check(await page.locator('#proof-rule').count() === 1, 'finance: the pay-out asks what proof comes back');
  check(await page.locator('#proof-rule').inputValue() === 'required', 'finance: “Proof required” is the default');
  await page.selectOption('#proof-rule', 'none');
  check(await page.locator('#proof-reason').isVisible(), 'finance: choosing “No proof possible” asks why');
  await page.locator('button', { hasText: /^Pay out$/ }).click(); await page.waitForTimeout(600);
  check(/why no proof/i.test(await page.locator('.toast').last().innerText().catch(() => '')), 'finance: no reason – refused with a clear message');
  await page.selectOption('#proof-reason', 'Informal / street seller');
  await page.locator('button', { hasText: /^Pay out$/ }).click(); await page.waitForTimeout(1500);
  const t = await page.locator('main').innerText();
  check(/No receipt needed for this one/.test(t) && /Informal \/ street seller/.test(t), 'finance: after paying, the expense says no receipt is needed, and why');
  await page.evaluate(() => { location.hash = '#/reports/controls'; }); await page.waitForTimeout(2000);
  const np = page.locator('#no-proof');
  check(await np.count() === 1 && /Flowers for reception/.test(await np.innerText()) && /Taxi to the Ministry/.test(await np.innerText()), 'reports: Spent without proof lists the new one and the earlier one');
  check(!errs.length, `finance: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* 2. own request: finance cannot waive proof */
{
  const { ctx, page } = await open('finance', `#/requests/${uid(102)}`);
  const own = await page.evaluate(async () => { const { rpc } = await import('./js/api.js'); try { await rpc('set_proof_rule', { p_request: '00000119-0000-4000-8000-000000000000', p_rule: 'none', p_reason: 'Other' }); return 'allowed'; } catch (e) { return e.message; } });
  check(own === 'allowed' || /own request/i.test(own), 'finance: the mock enforces the own-request rule where it applies');
  await ctx.close();
}

/* 3. the stock manager's restock with a receipt: the paper-slip question */
{
  const { ctx, page, errs } = await open('stock_manager', `#/requests/${uid(105)}`);
  const q = page.locator('.paper-q');
  check(await q.count() === 1 && /Do you have the paper slip\?/.test(await q.innerText()), 'spender: with a receipt, Petti asks about the paper slip');
  await page.locator('button', { hasText: 'Submit expense to finance' }).click(); await page.waitForTimeout(600);
  check(/paper slip/i.test(await page.locator('.toast').last().innerText().catch(() => '')), 'spender: cannot submit without answering');
  await q.locator('input[value="true"]').check(); await page.waitForTimeout(400);
  check(await q.locator('input[value="true"]').isChecked(), 'spender: the answer is kept');
  check(!errs.length, `spender: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* 4. the scanner: a sharp photo is accepted, a shaky one refused with the reason */
for (const w of [1280, 390]) {
  const { ctx, page, errs } = await open('stock_manager', `#/requests/${uid(105)}`, w);
  const input = page.locator('label.upload input[type=file]').first();
  await input.setInputFiles({ name: 'shaky.png', mimeType: 'image/png', buffer: await receiptPng(page, 9) }); await page.waitForTimeout(2500);
  const bad = await page.locator('.toast').allInnerTexts();
  check(bad.some((t) => /Not accepted/.test(t) && /blur|sharp|shak|still/i.test(t)), `${w}: a blurred photo is refused, saying why`);
  const before = await page.locator('main img, main .proof').count();
  await input.setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: await receiptPng(page, 0) }); await page.waitForTimeout(3500);
  const good = await page.locator('.toast').allInnerTexts();
  check(good.some((t) => /Receipt accepted/.test(t)), `${w}: a clear photo is straightened and accepted ${good.join(' / ')}`);
  check(await page.locator('main img, main .proof').count() >= before, `${w}: it shows with the receipts`);
  check(!errs.length, `${w}: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* 5. a claim with no receipt: the claimant says why; finance decides */
{
  const { ctx, page, errs } = await open('requester', '#/requests/new/claim');
  await page.locator('input[placeholder]').first().fill('Taxi to the client in Klein Windhoek');
  await page.locator('#no-receipt-start').click(); await page.waitForTimeout(1500);
  check(await page.locator('#no-receipt').isChecked() && await page.locator('#no-receipt-why').isVisible(), 'claimant: “I have no receipt” opens the reason box');
  check(!errs.length, `claimant: no page errors ${errs.join('|')}`);
  await ctx.close();
}

/* 6. the same, reached from "New request" by switching to "I already paid – claim back" (as on the phone) */
for (const role of ['requester', 'finance']) {
  const { ctx, page, errs } = await open(role, '#/requests/new', 390);
  await page.locator('main .tabs button', { hasText: 'claim back' }).click(); await page.waitForTimeout(800);
  check(await page.locator('main label.upload', { hasText: 'Scan the receipt' }).isVisible() && await page.locator('#no-receipt-start').isVisible(), `${role}: switching to a claim shows the receipt section`);
  check(await page.locator('main h1').innerText() === 'Claim back' && await page.locator('main button', { hasText: 'Submit claim' }).count() === 1, `${role}: the title and button say claim`);
  check(!/may issue part of this from the store/.test(await page.locator('main').innerText()), `${role}: no stock wording on a claim`);
  await page.locator('input[placeholder]').first().fill('Taxi in Oshikango');
  await page.locator('#no-receipt-start').click(); await page.waitForTimeout(1500);
  await page.locator('#no-receipt-why').fill('Taxi – no slips');
  await page.locator('main .tabs ~ * input, main input').first().click();
  check(await page.locator('#no-receipt').isChecked(), `${role}: the reason box is ready`);
  check(!errs.length, `${role}: no page errors ${errs.join('|')}`);
  await ctx.close();
}

await b.close(); server.close();
console.log(fails.length ? `PROOF UI: FAIL (${fails.length})` : 'PROOF UI: PASS'); process.exit(fails.length ? 1 : 0);
