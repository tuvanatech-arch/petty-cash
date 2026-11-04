// The old GitHub Pages address (app.js): it switches off that browser's alerts from the old address, then forwards to
// app.usepetti.com on the same page. The new address itself never forwards anywhere. And an alert tapped from the old
// address opens the new one (sw.js).
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch();
const OLD = 'https://tuvanatech-arch.github.io/petty-cash/';
async function serve(ctx, base) {
  await ctx.route(base + '**', (r) => { let p = path.join(root, decodeURIComponent(new URL(r.request().url()).pathname.replace(new URL(base).pathname, '/'))); if (p.endsWith('/')) p += 'index.html';
    if (!existsSync(p)) return r.fulfill({ status: 404, body: '' }); return r.fulfill({ contentType: types[path.extname(p)] || 'application/octet-stream', body: readFileSync(p) }); });
}
/* 1. the old address: old alerts off, then on to the new address, same page */
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 800 } }); const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await serve(ctx, OLD);
  await ctx.route('https://app.usepetti.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>new</title><p id="new">Petti at app.usepetti.com</p>' }));
  await page.addInitScript(() => {
    localStorage.setItem('demo_role', 'finance'); localStorage.setItem('pcs_push_asked', 'later'); sessionStorage.setItem('pcs_update_shown', '1');
    // an alert sign-up from the old address in this browser
    const sub = { endpoint: 'https://push.example/old-address', unsubscribe: async () => { localStorage.setItem('t_unsub', '1'); return true; } };
    if (location.hostname.endsWith('github.io')) Object.defineProperty(navigator, 'serviceWorker', { value: { getRegistration: async () => ({ pushManager: { getSubscription: async () => sub } }), register: async () => ({}), addEventListener() {}, ready: new Promise(() => {}) } });
  });
  await page.goto(OLD + '#/requests?status=awaiting_disbursement');
  await page.waitForURL(/app\.usepetti\.com/, { timeout: 8000 }).catch(() => {});
  check(page.url() === 'https://app.usepetti.com/#/requests?status=awaiting_disbursement', `forwarded to the new address, same page (${page.url()})`);
  check(await page.locator('#new').count() === 1, 'the new address opened');
  const p2 = await ctx.newPage(); await p2.goto(OLD + 'manifest.webmanifest').catch(() => {});
  check(await p2.evaluate(() => localStorage.getItem('t_unsub')) === '1', "the old address's alerts were switched off first");
  check(!errs.length, `no page errors ${errs.join(' | ')}`);
  await ctx.close();
}
/* 2. the new address stays put */
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 800 } }); const page = await ctx.newPage();
  await serve(ctx, 'https://app.usepetti.com/');
  await page.addInitScript(() => { localStorage.setItem('demo_role', 'finance'); localStorage.setItem('pcs_push_asked', 'later'); sessionStorage.setItem('pcs_update_shown', '1'); });
  await page.goto('https://app.usepetti.com/#/home'); await page.waitForTimeout(2500);
  check(page.url().startsWith('https://app.usepetti.com/#/home') && await page.locator('#moved-bar').count() === 0, 'app.usepetti.com: no bar, no forwarding');
  await ctx.close();
}
/* 3. sw.js: a tapped alert from the old address opens app.usepetti.com */
{
  const src = readFileSync(path.resolve('web/sw.js'), 'utf8');
  const run = (host) => { const handlers = {}; const opened = []; const navigated = [];
    const self = { location: { hostname: host, origin: `https://${host}` }, registration: { scope: `https://${host}/petty-cash/` }, addEventListener: (t, f) => { handlers[t] = f; },
      clients: { matchAll: async () => [{ url: `https://${host}/petty-cash/#/home`, navigate: (u) => navigated.push(u), focus: () => null }], openWindow: async (u) => opened.push(u), claim: async () => {} }, skipWaiting: () => {} };
    new Function('self', 'caches', 'fetch', src)(self, { open: async () => ({}) }, async () => ({}));
    let p; handlers.notificationclick({ notification: { close() {}, data: { link: '#/requests/abc' } }, waitUntil: (x) => { p = x; } });
    return p.then(() => ({ opened, navigated })); };
  const o = await run('tuvanatech-arch.github.io');
  check(o.opened[0] === 'https://app.usepetti.com/#/requests/abc' && !o.navigated.length, `old address: the alert opens app.usepetti.com (${o.opened[0]})`);
  const n = await run('app.usepetti.com');
  check(n.navigated[0] === 'https://app.usepetti.com/petty-cash/#/requests/abc' || n.navigated[0]?.startsWith('https://app.usepetti.com/'), 'new address: the open copy goes to the request, as before');
}
await b.close();
console.log(fails.length ? `MOVED UI: ${fails.length} FAILED` : 'MOVED UI: PASS');
process.exit(fails.length ? 1 : 0);
