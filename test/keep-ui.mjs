// Nothing typed is lost: a form being filled in survives the app being closed or crashing, comes back as it was
// (with a note saying so), Home offers "Continue where you left off", going to the background saves a draft,
// sending or cancelling forgets the copy, and another person on the same phone never sees it.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const uid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 800 } }); const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const as = async (role) => { await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); sessionStorage.setItem('pcs_update_shown', '1'); }, role); };
const go = async (hash) => { await page.evaluate((x) => { location.hash = x; }, hash); await page.waitForTimeout(1500); };
const crash = async (hash = '#/home') => { await page.goto(base + hash); await page.reload(); await page.waitForTimeout(1800); };   // the app closes and is opened again
const kept = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pcs_keep_')));
const background = () => page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); });

await page.goto(base + '#/home'); await as('requester'); await crash();

/* 1. a request being typed survives the app closing */
await go('#/requests/new');
await page.locator('input[placeholder]').first().fill('Taxi to Bank Windhoek for the deposit');
await page.locator('input[placeholder="0.00"]').fill('350');
await page.locator('#no-quote').check();   // a payment request: sent with no quote (042)
await page.waitForTimeout(600);
await crash();
const card = page.locator('#continue-card');
check(await card.count() === 1 && /Taxi to Bank Windhoek for the deposit/.test(await card.innerText()), 'after the app closed, Home offers “Continue where you left off”');
await card.locator('a.btn', { hasText: 'Continue' }).first().click(); await page.waitForTimeout(1500);
check(await page.locator('input[placeholder]').first().inputValue() === 'Taxi to Bank Windhoek for the deposit' && await page.locator('input[placeholder="0.00"]').inputValue() === '350', 'Continue brings the form back exactly as it was');
check(/Brought back what you were filling in/.test(await page.locator('#kept-banner').innerText()), '…and says so, with the time');
check(await page.locator('#no-quote').isChecked(), '…including the “No quote” tick');

/* 2. going to the background saves a draft on the server */
await background(); await page.waitForTimeout(1200);
const keys = await kept();
check(keys.some((k) => /_req_[0-9a-f-]{36}$/.test(k)) && !keys.some((k) => k.endsWith('_req_new')), 'going to the background saves it as a draft (and the copy follows the draft)');
await go('#/home');   // tapped away inside Petti (the preview forgets saved drafts on a restart; the real server does not)
const link = await page.locator('#continue-card a.btn', { hasText: 'Continue' }).first().getAttribute('href');
check(/^#\/requests\/[0-9a-f-]{36}\/edit$/.test(link || ''), 'Home now opens the saved draft');
await page.locator('#continue-card a.btn', { hasText: 'Continue' }).first().click(); await page.waitForTimeout(1500);
check(await page.locator('input[placeholder]').first().inputValue() === 'Taxi to Bank Windhoek for the deposit', 'the draft opens with what was typed');

/* 3. sending it forgets the copy */
await page.locator('main button', { hasText: 'Submit request' }).click(); await page.waitForTimeout(1500);
check(!(await kept()).some((k) => /_req_/.test(k)), 'once sent, the copy on the phone is gone');
await crash();
check(await page.locator('#continue-card').count() === 0, '…and Home no longer offers it');

/* 3b. a draft sent or deleted elsewhere: its entry goes away instead of lingering */
await page.evaluate(async () => {
  const { state } = await import(new URL('js/api.js', location.href).href);
  const gone = '99999999-0000-4000-8000-000000000000';
  localStorage.setItem(`pcs_keep_${state.me.id}_req_${gone}`, JSON.stringify({ label: 'Gone draft', link: `#/requests/${gone}/edit`, id: gone, at: Date.now() }));
});
await crash();
check(/Gone draft/.test(await page.locator('#continue-card').innerText().catch(() => '')), 'a copy of a draft is offered on Home');
await page.locator('#continue-card a.btn', { hasText: 'Continue' }).first().click(); await page.waitForTimeout(1500);
check(/no longer there/.test((await page.locator('.toast').allInnerTexts()).join(' ')) && !(await kept()).length, 'if that draft was sent or deleted elsewhere, Petti says so and forgets the copy');

/* 4. Cancel means cancel */
await go('#/requests/new/claim');
await page.locator('input[placeholder]').first().fill('Milk for the kitchen'); await page.waitForTimeout(500);
await page.locator('main a', { hasText: 'Cancel' }).click(); await page.waitForTimeout(800);
check(!(await kept()).length, 'Cancel throws the copy away');

/* 4b. a claim whose draft is made by the first receipt upload: one entry, following the draft */
await go('#/requests/new/claim');
await page.locator('input[placeholder]').first().fill('Taxi in Oshikango');
await page.locator('#no-receipt-start').click(); await page.waitForTimeout(1500);   // saves the draft, like the first upload does
await page.locator('#no-receipt-why').fill('Taxi – no slips'); await page.waitForTimeout(600);
await go('#/home');
const entries = await page.locator('#continue-card .continue-row').count();
check(entries === 1 && /\/edit$/.test(await page.locator('#continue-card a.btn').first().getAttribute('href')), 'a claim saved as a draft shows once on Home, opening the draft');
await page.locator('#continue-card a.btn', { hasText: 'Continue' }).first().click(); await page.waitForTimeout(1500);
check(await page.locator('#no-receipt-why').inputValue() === 'Taxi – no slips', '…with the no-receipt reason still there');
await page.locator('main a', { hasText: 'Cancel' }).click(); await page.waitForTimeout(600);

/* 5. what was spent is kept too */
await as('stock_manager'); await crash(`#/requests/${uid(105)}`);
await page.locator('textarea[placeholder^="Anything finance"]').fill('Bought at Game, Maerua Mall'); await page.waitForTimeout(600);
await crash(`#/requests/${uid(105)}`);
check(await page.locator('textarea[placeholder^="Anything finance"]').inputValue() === 'Bought at Game, Maerua Mall' && await page.locator('#kept-banner').count() === 1, '“Record what you spent” comes back after the app closed');
await go('#/home');
check(/What you spent: #1005/.test(await page.locator('#continue-card').innerText().catch(() => '')), 'Home offers it as well');

/* 6. another person on the same phone does not see it */
await as('finance'); await crash();
check(await page.locator('#continue-card').count() === 0, 'someone else signed in on the same phone does not see it');

/* 7. Discard */
await as('stock_manager'); await crash();
await page.locator('#continue-card button', { hasText: 'Discard' }).first().click(); await page.waitForTimeout(400);
await page.locator('.modal button', { hasText: 'Discard' }).click(); await page.waitForTimeout(400);
check(await page.locator('#continue-card').count() === 0 && !(await kept()).length, 'Discard removes it');
check(!errs.length, `no page errors ${errs.join('|')}`);

await b.close(); server.close();
console.log(fails.length ? `KEEP UI: FAIL (${fails.length})` : 'KEEP UI: PASS'); process.exit(fails.length ? 1 : 0);
