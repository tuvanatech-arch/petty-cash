// One receipt, several requests (056) in the preview: Joe's door-handle receipt also has the kitchen's coffee on it.
// Petti lists each line: on this request, or "Looks like Rita's request #1006" → Send; Rita is asked "Is this yours?",
// says yes, and the receipt shows on her request with her share; Joe's receipt shows every line placed. Personal and
// "Start a request for it". Finance: "Pay these together" for two requests to the same supplier.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const SHOTS = process.env.SHOTS || null;
const uid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const JOE = uid(5), RITA = uid(4), FIONA = uid(2);
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 1100 }, deviceScaleFactor: SHOTS ? 2 : 1 });
const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const shot = async (name, loc) => { if (!SHOTS) return; await page.addStyleTag({ content: '#toast-root{display:none!important}' }); await (loc || page).screenshot({ path: `${SHOTS}/${name}.png` }); };
const text = async (css) => (await page.locator(css).first().innerText().catch(() => '')).replace(/\s+/g, ' ');
async function be(person, hash) {
  await page.evaluate(async ({ person, hash }) => { window.__demoBecome(person); const a = await import('./js/api.js'); await a.loadSessionContext(); location.hash = hash; }, { person, hash });
  await page.waitForTimeout(1800);
}
await page.goto(base + '#/home');
await page.evaluate((j) => { localStorage.setItem('demo_person', j); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); sessionStorage.setItem('pcs_update_shown', '1'); }, JOE);
await page.goto(base + `#/requests/${uid(104)}`); await page.reload(); await page.waitForTimeout(2500);

/* Joe: his receipt's lines */
const panel = page.locator('.placement').first();
check(await panel.count() === 1, 'Joe: "What is on this receipt" under his receipt');
check(/N\$168\.99 not placed yet/.test(await text('.placement')), 'the coffee is "not placed yet"');
check((await page.locator('.pl-row', { hasText: 'Lever handle' }).innerText()).includes('On this request'), 'the door handle is on this request (matched to his own line)');
const coffee = page.locator('.pl-row', { hasText: 'Instant coffee' });
check(/Looks like Rita Amadhila’s request #1006/.test(await coffee.innerText()), 'the coffee: "Looks like Rita Amadhila’s request #1006"');
await shot('share-joe-before', panel);
await coffee.getByRole('button', { name: 'Send to Rita (#1006)' }).click(); await page.waitForTimeout(1200);
check(/Sent to Rita Amadhila’s #1006 – waiting/.test(await page.locator('.pl-row', { hasText: 'Instant coffee' }).innerText()), 'sent: "waiting for their answer"');

/* Rita: "Is this yours?" on her request */
await be(RITA, `#/requests/${uid(106)}`);
const offer = page.locator('#share-offer');
check(await offer.isVisible() && /Joe Katjivena bought Instant coffee 750 g \(N\$168\.99\)/.test(await offer.innerText()), 'Rita: "Is this yours?" with who bought what');
await shot('share-rita-offer', offer);
await page.locator('#share-yes').click(); await page.waitForTimeout(1500);
check(!(await page.locator('#share-offer').count()), 'Rita: answered, the question goes');
check(/This request’s share: N\$168\.99 of a N\$487\.49 receipt/.test(await text('main')), 'the receipt is on her request with her share');

/* Joe again: every line placed */
await be(JOE, `#/requests/${uid(104)}`);
check(/✓ On Rita Amadhila’s #1006/.test(await page.locator('.pl-row', { hasText: 'Instant coffee' }).innerText()), 'Joe: the coffee is on Rita’s #1006');
check(/Every line is placed/.test(await text('.placement')), 'Joe: every line is placed');
await shot('share-joe-after', page.locator('.placement').first());

/* personal, and undo */
const handle = page.locator('.pl-row', { hasText: 'Screw pack' });
check(await handle.count() === 1, 'the screws line is there');

/* finance: pay these together */
await page.evaluate(({ id }) => window.__demoChange('request_documents', { id: crypto.randomUUID(), request_id: id, kind: 'quote', storage_path: `${id}/quote-swift.pdf`, file_name: 'quote-swift.pdf', mime: 'application/pdf', extracted: { supplier: 'Swift Couriers Namibia', total: 80 } }), { id: uid(121) });
await be(FIONA, `#/requests/${uid(125)}`);
const tab = page.getByRole('tab', { name: /petty cash account|company account/i }).first();
if (await tab.count()) { await tab.click(); await page.waitForTimeout(1500); }
const tog = page.locator('#pay-together');
check(/Same supplier: pay this one together\?/.test(await tog.innerText().catch(() => '')) && /#1021/.test(await tog.innerText().catch(() => '')), `finance: "Same supplier: pay this one together?" lists #1021 (${(await tog.innerText().catch(() => '')).slice(0, 80)})`);
await tog.locator('input[type=checkbox]').first().check().catch(() => {}); await page.waitForTimeout(300);
check(/One transfer of N\$230\.00 for 2 requests/.test(await text('#together-total')), `the total for both: ${await text('#together-total')}`);
await shot('pay-together', page.locator('#pay-together'));
check(!errs.length, `no page errors ${errs.slice(0, 2).join(' | ')}`);

await b.close(); server.close();
console.log(fails.length ? `SHARED RECEIPTS UI: FAIL (${fails.length})` : 'SHARED RECEIPTS UI: PASS'); process.exit(fails.length ? 1 : 0);
