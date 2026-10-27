// Renders every screen per role in real Chromium at several device profiles and reports overflow and small touch targets.
import { chromium, devices } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve('../demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0].split('#')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;
const profiles = [
  ['phone-portrait', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
  ['phone-landscape', { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true }],
  ['small-phone', { viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true }],
  ['tablet-portrait', { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true }],
  ['tablet-landscape', { viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true }],
  ['laptop', { viewport: { width: 1366, height: 768 } }],
  ['tv', { viewport: { width: 1920, height: 1080 } }],
];
const pages = { approver: ['/home', '/requests', '/requests/00000103-0000-4000-8000-000000000000', '/reports', '/cash', '/admin/settings', '/stock'], finance: ['/home', '/cash/pack/00000042-0000-4000-8000-000000000000', '/requests/00000106-0000-4000-8000-000000000000'], requester: ['/home', '/requests/new', '/snap', '/stock', '/account'], stock_manager: ['/stock', '/stock/reports'] };
const browser = await chromium.launch();
const out = [];
for (const [name, opts] of profiles) {
  const ctx = await browser.newContext({ ...opts, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  for (const [role, list] of Object.entries(pages)) {
    for (const p of list) {
      await page.goto(base + '#' + p);
      await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); }, role);
      await page.reload(); await page.waitForTimeout(600);
      const m = await page.evaluate(() => {
        const de = document.documentElement; const vw = window.innerWidth;
        const overflow = Math.max(de.scrollWidth, document.body.scrollWidth) - vw;
        const offenders = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1 && getComputedStyle(e).position !== 'fixed'; }).slice(0, 3).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].slice(0, 2).join('.')}`);
        const scope = 'main, .tabbar, .topbar, .side, #modal-root';
        const targets = [...document.querySelectorAll(scope)].flatMap((c) => [...c.querySelectorAll('button, a.btn, a[href], input:not([type=checkbox]):not([type=file]):not([type=radio]), select, .click, .item-row, summary, label.tap, label.check')]).filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < window.innerHeight; });
        const smallEls = targets.filter((e) => e.getBoundingClientRect().height < 40);
        const small = smallEls.length;
        window.__small = smallEls.slice(0, 6).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].slice(0, 2).join('.')}:${Math.round(e.getBoundingClientRect().height)}`);
        const leaves = [...document.querySelectorAll('main *, .tabbar *')].filter((e) => e.children.length === 0 && e.textContent.trim());
        const minFont = Math.min(...leaves.map((e) => parseFloat(getComputedStyle(e).fontSize)));
        window.__tiny = leaves.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).slice(0, 3).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].slice(0, 2).join('.')}:${getComputedStyle(e).fontSize}`);
        return { overflow, offenders, targets: targets.length, small, smallEls: window.__small, tiny: window.__tiny, minFont: Math.round(minFont) };
      });
      out.push({ profile: name, role, page: p, ...m });
    }
  }
  await ctx.close();
}
await browser.close(); server.close();
const bad = out.filter((r) => r.overflow > 1);
console.log(`checked ${out.length} screen/profile combinations`);
console.log(`horizontal overflow: ${bad.length}`);
for (const r of out.filter((x) => /phone|tablet/.test(x.profile) && x.small > 0).slice(0, 8)) console.log(`  small on ${r.profile} ${r.role} ${r.page}: ${r.smallEls.join(', ')}`);
for (const r of out.filter((x) => x.tiny?.length).slice(0, 4)) console.log(`  tiny text on ${r.profile} ${r.role} ${r.page}: ${r.tiny.join(', ')}`); for (const b of bad) console.log(`  ${b.profile} ${b.role} ${b.page}: +${b.overflow}px  ${b.offenders.join(', ')}`);
const byProfile = {}; for (const r of out) { (byProfile[r.profile] ||= { t: 0, s: 0, f: 99 }); byProfile[r.profile].t += r.targets; byProfile[r.profile].s += r.small; byProfile[r.profile].f = Math.min(byProfile[r.profile].f, r.minFont); }
let fail = bad.length > 0;
for (const [k, v] of Object.entries(byProfile)) { const pct = Math.round(v.s / v.t * 100); const touch = /phone|tablet/.test(k); if (touch && pct > 5) fail = true; if (v.f < 12) fail = true; console.log(`${k.padEnd(18)} targets under 40px tall: ${v.s}/${v.t} (${pct}%)${touch && pct > 5 ? '  <-- too many for touch' : ''} · smallest text ${v.f}px${v.f < 12 ? '  <-- too small' : ''}`); }
console.log(fail ? 'DEVICE AUDIT: FAIL' : 'DEVICE AUDIT: PASS');
process.exit(fail ? 1 : 0);
