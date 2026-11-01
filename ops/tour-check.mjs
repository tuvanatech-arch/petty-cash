import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo'); const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
// usage: node ops/tour-check.mjs ops/shots/<release>-tours.json   ({ role: [steps] }) – every step must resolve on that role's screens
const tours = JSON.parse(readFileSync(process.argv[2], 'utf8')); const b = await chromium.launch(); let bad = 0;
for (const [role, steps] of Object.entries(tours)) {
  const page = await (await b.newContext({ viewport: { width: 390, height: 760 } })).newPage();
  await page.goto(base + '#/home'); await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); sessionStorage.setItem('pcs_update_shown', '1'); }, role);
  for (const s of steps) {
    await page.goto(base + s.at); await page.reload(); await page.waitForTimeout(1300);
    const found = await page.evaluate(async (st) => { const { locate } = await import('./js/tour.js'); const el = locate(st); return el ? el.textContent.trim().slice(0, 40) : null; }, s);
    console.log(found ? 'ok  ' : 'MISS', role, s.at, s.text, '→', found); if (!found) bad += 1;
  }
  await page.close();
}
await b.close(); server.close(); process.exit(bad ? 1 : 0);
