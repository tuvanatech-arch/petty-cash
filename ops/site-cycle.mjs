// Frames for the website hero's button cycle (site/img/cycle), from the preview (demo/) as finance, the clock and "Demo Company" as
// in ops/site-shots.mjs. Writes <out>/<size>-<step>.jpg, the month-end pack PDF, and boxes.json (each button's box).
//   cd petty-cash-stock && node ops/site-cycle.mjs <out>, then save each jpg to site/img/cycle (desk 1600x900 q76, phone q72).
// The month-end pack downloads as a PDF: its frame is the pack's first page (test/pack-test.mjs on the same fixed clock,
// pdftoppm -r 110) on a PDF viewer's grey, desk 1180px wide at the top, phone 740px.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const out = path.resolve(process.argv[2]); mkdirSync(out, { recursive: true });
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const NOW = new Date('2026-11-26T09:30:00Z');
const STEPS = [['month-end', 'Month-end pack'], ['payout', 'Pay out now'], ['count', 'Count cash'], ['bank', 'Check the bank'], ['move', 'Move cash'], ['return', 'Return cash'], ['close', 'Close & reconcile']];
const SIZES = { desk: { width: 1280, height: 720, dpr: 1.5 }, phone: { width: 390, height: 685, dpr: 2 } };
const b = await chromium.launch(); const boxes = {};
async function open(sz) {
  const ctx = await b.newContext({ viewport: { width: sz.width, height: sz.height }, deviceScaleFactor: sz.dpr, locale: 'en-GB', timezoneId: 'Africa/Windhoek', acceptDownloads: true });
  const page = await ctx.newPage(); await page.clock.setFixedTime(NOW);
  await page.route(/cdn\.jsdelivr\.net\/npm\/jszip/, (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.goto(base + '#/home');
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('demo_role', 'finance'); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); localStorage.setItem('demo_settings', JSON.stringify({ org_name: 'Demo Company' })); sessionStorage.setItem('pcs_update_shown', '1'); localStorage.setItem('demo_two_step', 'on'); });
  await page.goto(base + '#/cash'); await page.reload(); await page.waitForTimeout(1500);
  await page.addStyleTag({ content: '.preview-bar, #toast-root, .install-nudge, .banner-amber, .banner { display: none !important } body { padding-top: 0 !important }' });
  await page.waitForTimeout(300);
  return { ctx, page };
}
for (const [size, sz] of Object.entries(SIZES)) {
  const { ctx, page } = await open(sz);
  await page.screenshot({ path: `${out}/${size}-page.jpg`, type: 'jpeg', quality: 82 });
  boxes[size] = {};
  for (const [k, label] of STEPS) {
    const bb = await page.locator('main button', { hasText: label }).first().boundingBox();
    boxes[size][k] = bb && { x: +(bb.x / sz.width * 100).toFixed(2), y: +(bb.y / sz.height * 100).toFixed(2), w: +(bb.width / sz.width * 100).toFixed(2), h: +(bb.height / sz.height * 100).toFixed(2) };
  }
  await ctx.close();
  for (const [k, label] of STEPS) {
    const { ctx: c2, page: p2 } = await open(sz);
    if (k === 'month-end') { await c2.close(); continue; }   // the pack downloads as a PDF: its frame is made from the pack itself
    await p2.locator('main button', { hasText: label }).first().click(); await p2.waitForTimeout(700);
    await p2.screenshot({ path: `${out}/${size}-${k}.jpg`, type: 'jpeg', quality: 82 });
    await c2.close();
  }
}
writeFileSync(`${out}/boxes.json`, JSON.stringify(boxes, null, 1));
await b.close(); server.close();
console.log('done', JSON.stringify(boxes.desk));
