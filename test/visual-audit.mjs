// Visual audit: every screen × role × device × light/dark, checked in a real browser for
//   contrast   – text below WCAG AA against what is actually behind it (4.5:1, large text 3:1)
//   clipped    – text cut off by its own box (overflow hidden / ellipsis)
//   hidden     – text pushed outside a scrolling strip (e.g. a tab you cannot see)
//   offscreen  – anything running past the edge of the screen
//   overlap    – two controls on top of each other
//   misaligned – fields or buttons side by side that do not line up (top or height)
//   bright     – a light box in dark mode
// Usage: node visual-audit.mjs [--shots]   (exit 1 when anything is found)
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve('../demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0].split('#')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;
const SHOTS = process.argv.includes('--shots');
if (SHOTS) mkdirSync('shots/visual', { recursive: true });
const id = (n) => `00000${n}-0000-4000-8000-000000000000`;

const common = ['/home', '/requests', '/requests/new', '/requests/new/claim', '/snap', '/stock', '/stock/reports', '/notifications', '/account', '/more', '/how', '/install'];
const pages = {
  requester: [...common],
  stock_manager: [...common, '/stock/usage', '/stock/movements', '/stock/suppliers', '/stock/categories', `/requests/${id(101)}`, `/requests/${id(105)}`],
  finance: [...common, '/cash', '/reports', `/requests/${id(102)}`, `/requests/${id(104)}`, `/requests/${id(106)}`, `/requests/${id(107)}`, `/requests/${id(113)}`, `/cash/pack/${id(42)}`],
  approver: [...common, '/cash', '/reports', '/admin', '/admin/standins', '/admin/budgets', '/admin/settings', `/requests/${id(103)}`, `/requests/${id(108)}`, `/requests/${id(112)}`, `/requests/${id(115)}`, '/requests/new/cash'],
};
// dialogs and expanded states, opened by clicking
const actions = [
  { role: 'requester', page: '/stock', name: 'report dialog', click: 'button:has-text("Report low")' },
  { role: 'stock_manager', page: '/stock', name: 'item sheet', click: 'tr.item-row' },
  { role: 'stock_manager', page: '/stock', name: 'quick count', click: 'button:has-text("Quick count")' },
  { role: 'approver', page: '/admin', name: 'add person', click: 'button:has-text("Add person")' },
  { role: 'approver', page: '/admin', name: 'invite', click: 'button:has-text("Invite")' },
  { role: 'approver', page: '/admin', name: 'devices dialog', click: 'button.dev-count' },
  { role: 'requester', page: '/requests/new/cash', name: 'store item routed', script: async () => { const i = document.querySelector('input[placeholder^="e.g. Taxi"]'); i.value = '2 reams printer paper'; i.dispatchEvent(new Event('input')); await new Promise((r) => setTimeout(r, 450)); } },
  { role: 'approver', page: '/account', name: 'device sign-out armed', click: '.devices li:not(.this-device) button' },
  { role: 'approver', page: '/account', name: 'sign-in activity', click: '#devices summary' },
  { role: 'finance', page: '/cash', name: 'details open', click: 'summary' },
  { role: 'approver', page: '/reports', name: 'controls tab', click: '.tabs button:has-text("Controls")' },
  { role: 'approver', page: '/reports', name: 'prices tab', click: '.tabs button:has-text("Prices")' },
  { role: 'requester', page: '/home', name: 'toast', script: () => { const t = document.createElement('div'); t.className = 'toast'; t.textContent = 'Saved.'; document.body.append(t); const e = document.createElement('div'); e.className = 'toast err'; e.style.bottom = '90px'; e.textContent = 'Something went wrong.'; document.body.append(e); } },
  { role: 'requester', page: '/requests/new', name: 'error under form', script: () => { const e = document.querySelector('.error'); if (e) e.textContent = 'Enter the amount.'; } },
];
const profiles = [
  ['phone', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, ['dark', 'light']],
  ['small-phone', { viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true }, ['dark']],
  ['tablet', { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true }, ['light']],
  ['laptop', { viewport: { width: 1366, height: 800 } }, ['light', 'dark']],
];

function inPageAudit(scheme) {
  const out = [];
  const W = innerWidth;
  const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const label = (el) => { const cls = [...el.classList].slice(0, 2).join('.'); const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40); return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} “${t}”`; };
  const visible = (el) => { if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false; if (el.closest('details:not([open]) > :not(summary)')) return false; const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return false; } return true; };
  const opacityOf = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const bgOf = (el) => { // what is really painted behind el
    const stack = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const s = getComputedStyle(e); if (s.backgroundImage && s.backgroundImage !== 'none' && !/url\(/.test(s.backgroundImage)) return null; const c = parse(s.backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } }
    let col = { r: 255, g: 255, b: 255, a: 1 };
    if (!stack.length || stack[stack.length - 1].a < 1) { const b = parse(getComputedStyle(document.body).backgroundColor); if (b) col = b; }
    for (let i = stack.length - 1; i >= 0; i--) col = over(stack[i], col);
    return col;
  };
  const fixedAncestor = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const p = getComputedStyle(e).position; if (p === 'fixed' || p === 'sticky') return e; } return null; };
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
  const all = [...document.querySelectorAll('body *')].filter((el) => !['SCRIPT', 'STYLE', 'svg', 'path', 'NOSCRIPT'].includes(el.tagName) && !el.closest('svg') && !el.closest('.demo-bar, #demo-bar'));

  for (const el of all) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el); const r = el.getBoundingClientRect();
    const isText = ownText(el) || ((el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') && (el.value || el.selectedOptions?.[0]?.text));
    // contrast
    if (isText && !el.disabled && !el.closest('[disabled]')) {
      const fg = parse(s.color); const bg = bgOf(el);
      if (fg && bg) {
        const op = opacityOf(el);
        const eff = over({ ...fg, a: fg.a * op }, bg);
        const size = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700;
        const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
        const cr = ratio(eff, bg);
        if (cr < need) out.push({ type: 'contrast', what: label(el), detail: `${cr.toFixed(2)}:1 (needs ${need}) – text ${s.color} on ${`rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`}` });
      }
    }
    // clipped by its own box
    if (isText && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && (/(hidden|clip)/.test(s.overflowX) || s.textOverflow === 'ellipsis') && !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) out.push({ type: 'clipped', what: label(el), detail: `${el.scrollWidth}px of text in ${el.clientWidth}px` });
    // pushed outside a scrolling strip / off screen
    if (isText) {
      let cut = null;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const as = getComputedStyle(a); if (/(auto|scroll|hidden|clip)/.test(as.overflowX)) { const ar = a.getBoundingClientRect(); if (r.right > ar.right + 2 || r.left < ar.left - 2) { cut = a; } break; } }
      if (cut && !cut.closest('.table-wrap')) out.push({ type: 'hidden', what: label(el), detail: `outside the visible part of ${label(cut).split(' ')[0]} (needs sideways scrolling)` });
      else if (cut && cut.closest('.table-wrap') && W < 700) out.push({ type: 'table-scroll', what: label(cut.closest('.table-wrap').querySelector('table') || cut), detail: 'table wider than the phone – sideways scroll' });
      if (!fixedAncestor(el) && !el.matches('.skip') && (r.right > W + 1 || r.left < -1) && !cut) out.push({ type: 'offscreen', what: label(el), detail: `x ${Math.round(r.left)}–${Math.round(r.right)} of ${W}` });
    }
    // light box in dark mode
    if (scheme === 'dark' && r.width * r.height > 600 && !['IMG', 'CANVAS', 'VIDEO'].includes(el.tagName) && !el.closest('.snap-thumb, .proof, img, .toast, .skip')) {
      const c = parse(s.backgroundColor); if (c && c.a > 0.5 && lum(c) > 0.45) out.push({ type: 'bright', what: label(el), detail: `background ${s.backgroundColor} in dark mode` });
    }
  }
  // squeezed fields: an input or dropdown too narrow to read or type in
  for (const c of document.querySelectorAll('input.input, select, textarea')) {
    if (!visible(c) || c.type === 'checkbox' || c.type === 'radio' || c.type === 'hidden' || c.type === 'file') continue;
    const w = c.getBoundingClientRect().width; const min = c.type === 'number' ? 52 : 90;
    if (w < min) out.push({ type: 'squeezed', what: label(c), detail: `${Math.round(w)}px wide (needs at least ${min})` });
  }
  // overlapping controls
  const ctrls = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], summary, label.tap')].filter((c) => visible(c) && !fixedAncestor(c));
  for (let i = 0; i < ctrls.length; i++) for (let j = i + 1; j < ctrls.length; j++) {
    const a = ctrls[i], b = ctrls[j]; if (a.contains(b) || b.contains(a)) continue;
    if ((a.tagName === 'LABEL' && a.contains(b)) || (b.tagName === 'LABEL' && b.contains(a))) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (ix > 3 && iy > 3) out.push({ type: 'overlap', what: `${label(a)} × ${label(b)}`, detail: `${Math.round(ix)}×${Math.round(iy)}px overlap` });
  }
  // side-by-side fields: controls in one visual row must share top and height
  for (const row of document.querySelectorAll('.row, .form-row, .grid-2, .toolbar')) {
    if (!visible(row)) continue;
    const fs = [...row.children].map((f) => f.querySelector?.(':scope > input.input, :scope > select, :scope > .input, input.input, select.input, select')).filter((c) => c && visible(c) && c.closest('.row, .form-row, .grid-2, .toolbar') === row);
    const groups = {};
    for (const c of fs) { const f = c.closest(':scope > *'); const top = Math.round(c.parentElement.getBoundingClientRect().top / 4); (groups[top] ||= []).push(c); }
    for (const g of Object.values(groups)) {
      if (g.length < 2) continue;
      const tops = g.map((c) => c.getBoundingClientRect().top), hs = g.map((c) => c.getBoundingClientRect().height);
      if (Math.max(...tops) - Math.min(...tops) > 2) out.push({ type: 'misaligned', what: g.map(label).join(' | '), detail: `field tops differ by ${Math.round(Math.max(...tops) - Math.min(...tops))}px` });
      if (Math.max(...hs) - Math.min(...hs) > 2) out.push({ type: 'misaligned', what: g.map(label).join(' | '), detail: `field heights ${hs.map(Math.round).join(' vs ')}px` });
    }
  }
  // buttons side by side: same height
  for (const bar of document.querySelectorAll('.form-actions, .page-actions, .row-actions, .msg-form')) {
    if (!visible(bar)) continue;
    const bs = [...bar.querySelectorAll(':scope > .btn, :scope > button, :scope > a.btn, :scope > input, :scope > select')].filter(visible);
    const rows = {}; for (const b of bs) (rows[Math.round(b.getBoundingClientRect().top / 10)] ||= []).push(b);
    for (const g of Object.values(rows)) { if (g.length < 2) continue; const hs = g.map((b) => b.getBoundingClientRect().height); if (Math.max(...hs) - Math.min(...hs) > 2) out.push({ type: 'misaligned', what: g.map(label).join(' | '), detail: `button heights ${hs.map(Math.round).join(' vs ')}px` }); }
  }
  return out;
}

const browser = await chromium.launch();
const found = new Map(); // key → { type, what, detail, where:Set }
let loads = 0;
for (const [pname, opts, schemes] of profiles) {
  for (const scheme of schemes) {
    const ctx = await browser.newContext({ ...opts, colorScheme: scheme, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const run = async (role, route, act) => {
      await page.goto(base + '#' + route);
      await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); }, role);
      await page.reload(); await page.waitForTimeout(450); loads++;
      await page.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => t.remove()); for (const d of document.querySelectorAll('body > div')) if ((d.textContent || '').startsWith('Preview · viewing as')) d.remove(); });
      if (act?.click) { const l = page.locator(act.click).first(); if (await l.count()) { await l.click().catch(() => {}); await page.waitForTimeout(250); } else return; }
      if (act?.script) { await page.evaluate(act.script); await page.waitForTimeout(50); }
      const where = `${pname}/${scheme} ${role} ${route}${act ? ` [${act.name}]` : ''}`;
      const issues = await page.evaluate(inPageAudit, scheme);
      for (const i of issues) { const k = `${i.type}|${i.what}|${i.detail.replace(/[\d.]+:1/, '').replace(/\d+px/g, '#')}|${scheme}`; const f = found.get(k) || { ...i, scheme, where: new Set() }; f.where.add(where); found.set(k, f); }
      if (SHOTS && ((pname === 'phone' && scheme === 'dark') || (pname === 'laptop' && scheme === 'light'))) await page.screenshot({ path: `shots/visual/${pname}-${scheme}-${role}-${(route + (act ? '-' + act.name : '')).replace(/[^\w]+/g, '_')}.png`, fullPage: true });
    };
    for (const [role, list] of Object.entries(pages)) for (const route of list) await run(role, route);
    for (const a of actions) await run(a.role, a.page, a);
    await ctx.close();
  }
}
await browser.close(); server.close();

const byType = {};
for (const f of found.values()) (byType[f.type] ||= []).push(f);
const order = ['contrast', 'bright', 'overlap', 'offscreen', 'clipped', 'hidden', 'squeezed', 'misaligned', 'table-scroll'];
let total = 0;
console.log(`${loads} screens checked`);
for (const t of order) {
  const list = byType[t] || []; total += t === 'table-scroll' ? 0 : list.length;
  console.log(`\n== ${t}: ${list.length}`);
  for (const f of list.slice(0, 40)) console.log(`  [${f.scheme}] ${f.what}\n      ${f.detail}  ·  ${f.where.size} screen(s), e.g. ${[...f.where][0]}`);
  if (list.length > 40) console.log(`  … ${list.length - 40} more`);
}
writeFileSync('visual-audit.json', JSON.stringify([...found.values()].map((f) => ({ ...f, where: [...f.where] })), null, 1));
console.log(`\nVISUAL AUDIT: ${total ? `${total} finding(s)` : 'CLEAN'}`);
process.exit(total ? 1 : 0);
