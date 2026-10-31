// Renders every page against the mock client and reports thrown errors / leftover "Loading…".
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/app/#/home', pretendToBeVisual: true });
const w = dom.window;
for (const k of ['window', 'document', 'location', 'HTMLElement', 'Node', 'HashChangeEvent', 'Event', 'Blob', 'getComputedStyle']) { try { globalThis[k] = w[k]; } catch { Object.defineProperty(globalThis, k, { value: w[k], configurable: true }); } }
globalThis.fetch = async () => ({ ok: true, json: async () => ({ needs_bootstrap: false }) });
globalThis.crypto ??= w.crypto;
w.scrollTo = () => {};
const errors = [];
w.addEventListener('error', (e) => errors.push(e.error || e.message));
process.on('unhandledRejection', (e) => errors.push(e));
const origError = console.error; console.error = (...a) => { errors.push(a.map(String).join(' ')); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = await import('../web/js/app.js');
await sleep(50);

const pages = ['/home', '/requests', '/requests/new', '/requests/new/claim', '/requests/new/cash', '/notifications', '/admin/standins', '/admin/budgets', '/stock/reports', '/snap', '/install', '/how', '/verify', '/snap?inbox=ib1', '/cash/pack/f0', '/requests/33333333-3333-4333-8333-333333333333', '/requests/33333333-3333-4333-8333-333333333333/edit', '/stock', '/stock/movements', '/stock/suppliers', '/stock/categories', '/cash', '/reports', '/admin', '/admin/settings', '/account', '/more', '/nope'];
let failed = 0;
for (const p of pages) {
  const before = errors.length;
  w.location.hash = '#' + p;
  await app.render();
  await sleep(80);
  const main = w.document.querySelector('main');
  const text = main?.textContent || '';
  const loading = /Loading…/.test(text) || !!main?.querySelector('.petti-loader');
  const errs = errors.slice(before);
  const ok = !loading && !errs.length;
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${p}${loading ? ' (still loading)' : ''}${errs.length ? ' ' + errs.map((e) => (e?.stack || String(e)).split('\n').slice(0, 2).join(' | ')).join(' || ') : ''}`);
  if (ok) console.log('     ' + text.replace(/\s+/g, ' ').slice(0, 160));
}
// exercise a few dialogs
w.location.hash = '#/stock';
await app.render(); await sleep(80);
const addBtn = [...w.document.querySelectorAll('button')].find((b) => b.textContent === 'Add item');
addBtn?.click(); await sleep(80);
console.log('dialog:', w.document.querySelector('.modal')?.textContent.replace(/\s+/g, ' ').slice(0, 120));
process.exit(failed ? 1 : 0);
