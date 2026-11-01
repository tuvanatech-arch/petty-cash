#!/usr/bin/env node
// Pictures for "What's new": a phone-sized screenshot of the preview, as the role sees it, with the part the
// walk-through points at ringed in sand. Always taken from the current app, so the picture matches the real screen.
//
//   node ops/update-shots.mjs ops/shots/<release>.json      writes web/updates/<name>.png for each entry
//
// The JSON: [{ "name": "deliveries", "role": "stock_manager", "step": { "at": "#/stock/deliveries", "text": "Deliveries" } }, …]
// `step` uses the same rule as the walk-through (web/js/tour.js), so the ring is where the bubble will be.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const root = path.resolve('demo'); const outDir = path.resolve('web/updates'); mkdirSync(outDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const b = await chromium.launch();
for (const e of spec) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 640 }, deviceScaleFactor: 2 });
  if (e.push) {   // show the Alerts box as a phone that can receive alerts sees it (the preview itself has no push)
    await ctx.grantPermissions(['notifications']);
    await ctx.addInitScript(() => { try { Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true }); } catch {} window.PushManager = function () {}; const reg = { pushManager: { getSubscription: async () => null } }; Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve(reg), getRegistration: async () => reg, register: async () => reg, addEventListener() {} } }); });
  }
  const page = await ctx.newPage();
  await page.goto(base + '#/home');
  await page.evaluate((role) => { localStorage.setItem('demo_role', role); localStorage.setItem('pcs_push_asked', 'later'); sessionStorage.setItem('pcs_update_shown', '1'); }, e.role);
  await page.goto(base + (e.step.at || '#/home')); await page.reload(); await page.waitForTimeout(1200);
  await page.addStyleTag({ content: '.preview-bar, #toast-root { display: none !important } body { padding-top: 0 !important }' });
  const rect = await page.evaluate(async (step) => {
    const { locate } = await import('./js/tour.js');
    const el = locate(step); if (!el) return null;
    el.scrollIntoView({ block: el.getBoundingClientRect().height > window.innerHeight * 0.6 ? 'start' : 'center' }); await new Promise((r) => setTimeout(r, 300));
    const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, e.step);
  if (!rect) { console.error(`${e.name}: could not find the element for`, e.step); await page.close(); continue; }
  // the ring, drawn on the page itself so it scales with the screenshot
  await page.evaluate((r) => { const d = document.createElement('div'); Object.assign(d.style, { position: 'fixed', left: `${r.x - 8}px`, top: `${r.y - 8}px`, width: `${r.w + 16}px`, height: `${r.h + 16}px`, border: '4px solid #e4b85c', borderRadius: '12px', boxShadow: '0 0 0 9999px rgba(25,35,31,.28)', zIndex: 9999, pointerEvents: 'none' }); document.body.append(d); }, rect);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(outDir, `${e.name}.png`) });
  console.log(`web/updates/${e.name}.png`);
  await page.close();
}
await b.close(); server.close();
