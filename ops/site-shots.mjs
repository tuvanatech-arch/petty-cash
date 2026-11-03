#!/usr/bin/env node
// Pictures of the real app for usepetti.com, taken from the preview (demo/: the real screens on sample data, nothing
// live). The clock is fixed so every relative date in the sample data falls in the same month, and the company is
// called "Demo Company" so nobody mistakes the sample for a real client.
//
//   node ops/site-shots.mjs ops/shots/site.json [outDir]      default outDir: site/img
//
// Each entry: { "name": "cash", "role": "finance", "at": "#/cash", "width": 390, "height": 844, "scroll": "css or text",
//               "full": false, "hide": ["css", ...] }
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const outDir = path.resolve(process.argv[3] || 'site/img'); mkdirSync(outDir, { recursive: true });
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const NOW = new Date(spec.now || '2026-11-26T09:30:00Z');   // a Thursday late in the month, mid-morning in Windhoek
const settings = JSON.stringify({ org_name: 'Demo Company', ...(spec.settings || {}) });
const b = await chromium.launch();
for (const e of spec.shots) {
  const ctx = await b.newContext({ viewport: { width: e.width || 390, height: e.height || 844 }, deviceScaleFactor: e.dpr || 2, locale: 'en-GB', timezoneId: 'Africa/Windhoek' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(NOW);
  const errs = []; page.on('pageerror', (x) => errs.push(x.message));
  await page.goto(base + '#/home');
  await page.evaluate(([role, s, extra]) => {
    localStorage.clear();
    localStorage.setItem('demo_role', role); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0');
    localStorage.setItem('demo_settings', s); sessionStorage.setItem('pcs_update_shown', '1');
    for (const [k, v] of Object.entries(extra || {})) localStorage.setItem(k, v);
  }, [e.role, settings, e.storage]);
  await page.goto(base + e.at); await page.reload(); await page.waitForTimeout(e.wait || 1500);
  await page.addStyleTag({ content: `.preview-bar, #toast-root, .install-nudge { display: none !important } body { padding-top: 0 !important } ${(e.hide || []).join(', ')}${(e.hide || []).length ? ' { display: none !important }' : ''}` });
  if (e.click) { for (const c of [].concat(e.click)) { await page.locator(c).first().click(); await page.waitForTimeout(600); } }
  if (e.scroll) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) || [...document.querySelectorAll('h1,h2,h3,strong,th,summary,button,.k')].find((x) => x.textContent.trim().startsWith(sel));
      if (el) { el.scrollIntoView({ block: 'start' }); window.scrollBy(0, -12); }
    }, e.scroll);
    await page.waitForTimeout(300);
  }
  const file = path.join(outDir, `${e.name}.${e.png ? 'png' : 'jpg'}`);
  const opts = { path: file, ...(e.png ? {} : { type: 'jpeg', quality: 84 }) };
  // "el": just that part of the screen; "clip": { x, y, width, height } of the page; otherwise the screen (or "full" page)
  // "between": ["text A", "text B"]: from the heading that starts with A to the end of the block that starts with B
  if (e.between) {
    const clip = await page.evaluate(([a, z, pad, within]) => {
      const all = [...document.querySelectorAll(`${within} h1, ${within} h2, ${within} h3, ${within} strong, ${within} summary, ${within} button, ${within} th, ${within} td, ${within} span, ${within} p, ${within} div, ${within} li, ${within} dt, ${within} dd, ${within} a, ${within} label`)];
      const find = (t) => all.find((x) => x.childElementCount === 0 && x.textContent.trim().startsWith(t)) || all.find((x) => x.textContent.trim().startsWith(t));
      const A = find(a), Z = find(z); if (!A || !Z) return null;
      const box = (Z.closest('.card, .sheet, section, table, ul, ol') || Z).getBoundingClientRect(); const top = A.getBoundingClientRect().top;
      const m = document.querySelector(within).getBoundingClientRect();
      return { x: Math.max(0, m.left), y: top + scrollY - pad, width: m.width, height: Math.max(box.bottom, Z.getBoundingClientRect().bottom) - top + 2 * pad };
    }, [e.between[0], e.between[1], e.pad ?? 14, e.within || 'main']);
    if (!clip) { console.error(`${e.name}: could not find`, e.between); await ctx.close(); continue; }
    await page.screenshot({ ...opts, fullPage: true, clip });
  } else if (e.el) await page.locator(e.el).first().screenshot(opts);
  else await page.screenshot({ ...opts, fullPage: !!e.full, ...(e.clip ? { clip: e.clip } : {}) });
  console.log(`${errs.length ? 'ERR ' : 'ok  '} ${e.name}${errs.length ? ' ' + errs.join(' | ') : ''}`);
  await ctx.close();
}
await b.close(); server.close();
