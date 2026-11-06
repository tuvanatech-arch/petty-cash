// The phone's bottom bar: each person's three most-used screens with icons, a round "New" button in the middle, and
// "More", which slides up from the bottom with everything else. The numbers sit on the screen where the work is
// (requests waiting for you on Requests, counts to sign off on Petty cash …); More adds up what it hides.
import { can, role } from './api.js';
import { h } from './ui.js';
import { BUILD } from './diag.js';

/* ---------- icons: simple line drawings, the colour of the text ---------- */
const PATHS = {
  home: '<path d="M3.5 10.2 12 3.5l8.5 6.7V19a1.5 1.5 0 0 1-1.5 1.5h-4.2v-5.8H9.2v5.8H5A1.5 1.5 0 0 1 3.5 19z"/>',
  requests: '<path d="M7 3.5h7l4.5 4.5v11A1.5 1.5 0 0 1 17 20.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M14 3.5V8h4.5M8.8 12.5h6.4M8.8 16h6.4"/>',
  stock: '<path d="M3.5 7.6 12 3.5l8.5 4.1v8.8L12 20.5l-8.5-4.1z"/><path d="M3.5 7.6 12 11.7l8.5-4.1M12 11.7v8.8"/>',
  cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v.01M18 14.5v.01"/>',
  reports: '<path d="M4 20h16M7 16.5v-5M12 16.5V6M17 16.5V9"/>',
  admin: '<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>',
  schedule: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  updates: '<path d="M11 3.5l1.7 4.6 4.6 1.7-4.6 1.7L11 16.1l-1.7-4.6-4.6-1.7 4.6-1.7z"/><path d="M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  account: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  more: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>',
  snap: '<path d="M4.5 7.5h2.8l1.8-2.6h5.8l1.8 2.6h2.8A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V9a1.5 1.5 0 0 1 1.5-1.5z"/><circle cx="12" cy="13.3" r="3.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pay: '<path d="M12 3v18M16.5 7H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H6.5"/>',
  claim: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  low: '<path d="M3 7l6 6 4-4 8 8"/><path d="M21 11v6h-6"/>',
  suggest: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z"/>',
  how: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.3M12 16.8v.01"/>',
  reload: '<path d="M20 11.5A8 8 0 1 1 17.7 6"/><path d="M20 4v5h-5"/>',
  chevron: '<path d="M9.5 6l6 6-6 6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  person: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  alerts: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
};
export function icon(name, { size = 24 } = {}) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: `ic ic-${name}` })) s.setAttribute(k, v);
  s.innerHTML = PATHS[name] || PATHS.more;
  return s;
}

/* ---------- which screens go on the bar ---------- */
const ORDER = {
  requester: ['home', 'requests', 'stock'],
  stock_manager: ['home', 'stock', 'requests'],
  finance: ['home', 'requests', 'cash'],
  approver: ['home', 'requests', 'cash'],
  managing_director: ['home', 'requests', 'reports'],
};
const FILL = ['requests', 'stock', 'cash', 'reports'];

/** The bar's three screens for this person (left, left, right), and the rest for More. Alerts live in the top bell. */
export function tabItems(navItems) {
  const all = Object.fromEntries(navItems.map((i) => [i.key, i]));
  const keys = (ORDER[role()] || ['home', 'requests', 'stock']).filter((k) => all[k]);
  for (const k of FILL) if (keys.length < 3 && all[k] && !keys.includes(k)) keys.push(k);
  const main = keys.slice(0, 3).map((k) => all[k]);
  const rest = navItems.filter((i) => i.key !== 'notifications' && !main.some((m) => m.key === i.key));
  return { main, rest };
}

/* ---------- the numbers ---------- */
let counts = {};
let updatesN = 0;
const badgeEls = new Set();
/** A number on a tab or a row: the work waiting in that screen. */
function badge(key) {
  const b = h('span', { class: 'count', 'data-section': key, style: { display: 'none' } });
  badgeEls.add(b); paint(b);
  return b;
}
function paint(b) {
  // forget a number once its screen has been replaced (it was on screen, and is no longer)
  if (b.isConnected) b.dataset.shown = '1'; else if (b.dataset.shown) { badgeEls.delete(b); return; }
  const keys = b.dataset.section.split(',');
  const n = keys.reduce((s, k) => s + Number(counts[k] || 0), 0) + (b.dataset.updates ? updatesN : 0);
  b.textContent = n > 99 ? '99+' : n; b.style.display = n ? '' : 'none';
}
/** New numbers from the database: { requests, cash, stock, schedule }. */
export function setCounts(next) { counts = { ...next, admin: next.schedule || 0 }; [...badgeEls].forEach(paint); }
/** What's new: unread notes, shown on its row and added into More. */
export function setUpdatesCount(n) { updatesN = Number(n) || 0; for (const b of badgeEls) if (b.dataset.updates) paint(b); }

/* ---------- the sheets that slide up ---------- */
let openSheet = null;
export function closeSheet({ instant = false } = {}) {
  const s = openSheet; if (!s) return;
  openSheet = null;
  document.removeEventListener('keydown', s.esc);
  document.querySelector('.tabbar .tab-new')?.classList.remove('open');
  document.querySelectorAll('.tabbar [aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  const done = () => { s.back.remove(); s.opener?.focus?.({ preventScroll: true }); };
  if (instant || matchMedia('(prefers-reduced-motion: reduce)').matches) { done(); return; }
  s.back.classList.remove('in');
  setTimeout(done, 220);
}
window.addEventListener('hashchange', () => closeSheet({ instant: true }));

function sheetRow({ ic, label, sub, href, onclick, section, updates }) {
  const b = section || updates ? badge(section || 'none') : null;
  if (b && updates) { b.dataset.updates = '1'; paint(b); }
  const inner = [h('span', { class: 'bs-ic' }, icon(ic, { size: 22 })), h('span', { class: 'bs-text' }, h('strong', {}, label), sub ? h('span', {}, sub) : null), b, h('span', { class: 'bs-go' }, icon('chevron', { size: 18 }))];
  return h('li', {}, href
    ? h('a', { href, class: 'bs-row', onclick: () => closeSheet({ instant: true }) }, inner)
    : h('button', { type: 'button', class: 'bs-row', onclick: () => { closeSheet({ instant: true }); onclick(); } }, inner));
}

/** A list that slides up from the bottom; tap outside, swipe it down or press Escape to close. */
function bottomSheet(title, rows, opener, { id } = {}) {
  closeSheet({ instant: true });
  const handle = h('div', { class: 'bs-handle', 'aria-hidden': 'true' }, h('i'));
  const close = h('button', { type: 'button', class: 'bs-close', 'aria-label': 'Close' }, '×');
  const panel = h('div', { class: 'bs-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, id },
    handle, h('div', { class: 'bs-head' }, h('h2', {}, title), close), h('ul', { class: 'bs-list' }, rows));
  const back = h('div', { class: 'bs-back' }, panel);
  back.addEventListener('click', (e) => { if (e.target === back) closeSheet(); });
  close.onclick = () => closeSheet();
  // swipe down to close
  let y0 = null, dy = 0;
  panel.addEventListener('touchstart', (e) => { if (panel.scrollTop <= 0) { y0 = e.touches[0].clientY; dy = 0; } }, { passive: true });
  panel.addEventListener('touchmove', (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); panel.style.transform = dy ? `translateY(${dy}px)` : ''; }, { passive: true });
  panel.addEventListener('touchend', () => { if (y0 == null) return; y0 = null; panel.style.transform = ''; if (dy > 70) closeSheet(); });
  const esc = (e) => { if (e.key === 'Escape') closeSheet(); };
  document.addEventListener('keydown', esc);
  document.body.append(back);
  openSheet = { back, esc, opener };
  requestAnimationFrame(() => requestAnimationFrame(() => back.classList.add('in')));
  setTimeout(() => panel.querySelector('.bs-row')?.focus({ preventScroll: true }), 60);
  return back;
}

/** "New": the things this person can start, in the order they are most often needed. */
async function newSheet(opener) {
  const stockMgr = can('manage_stock');
  const rows = [
    sheetRow({ ic: 'snap', label: 'Snap or upload', sub: 'A receipt, quote or invoice – Petti fills in the rest', href: '#/snap' }),
    sheetRow({ ic: 'pay', label: 'Request a payment', sub: 'A supplier, a service, anything that is not office stock', href: '#/requests/new/cash' }),
    sheetRow({ ic: 'claim', label: 'Claim back', sub: 'Money you already spent', href: '#/requests/new/claim' }),
    stockMgr ? sheetRow({ ic: 'stock', label: 'Stock item', sub: 'Buy items for the store', href: '#/requests/new/stock' }) : null,
    !stockMgr ? sheetRow({ ic: 'low', label: 'Report low stock', sub: 'Something in the store is running low or finished', onclick: async () => (await import('./pages/stock.js')).reportDialog(null) }) : null,
    sheetRow({ ic: 'suggest', label: 'Suggest an item', sub: 'Something the store should keep', onclick: async () => (await import('./pages/stock.js')).suggestDialog() }),
  ].filter(Boolean);
  bottomSheet('New', rows, opener, { id: 'new-sheet' });
}

const SUB = { stock: 'Items, reports, deliveries and counts', cash: 'The box, the bank, counts and pay-outs', reports: 'Spending, budgets and the month’s pack', admin: 'People, settings, branches and updates', schedule: 'Who approves what, and the limits', updates: 'Changes to Petti, and how to use them', account: 'Your details, password and alerts', requests: 'Every request you can see' };
const ICON = { home: 'home', requests: 'requests', stock: 'stock', cash: 'cash', reports: 'reports', admin: 'admin', schedule: 'schedule', updates: 'updates', account: 'account', notifications: 'alerts', more: 'more', snap: 'snap' };
export const iconFor = (key) => ICON[key] || 'more';

/** The rows of More: every screen not on the bar, then help and reload. Used by the sheet and the #/more page. */
export function moreRows(rest) {
  return [
    ...rest.map((it) => sheetRow({ ic: iconFor(it.key), label: it.label, sub: SUB[it.key], href: it.href, section: it.key === 'updates' ? null : it.key, updates: it.key === 'updates' })),
    sheetRow({ ic: 'how', label: 'How it works', sub: 'One screen per role, and “show tips again”', href: '#/how' }),
    sheetRow({ ic: 'reload', label: 'Reload the app', sub: `Build ${BUILD} · or pull down on any page`, onclick: () => location.reload() }),
  ];
}

/** The bar itself. */
export function tabBar(navItems, activeKey) {
  const { main, rest } = tabItems(navItems);
  const tab = (it) => {
    const active = it.key === activeKey;
    return h('a', { href: it.href, class: `tab${active ? ' active' : ''}`, 'aria-current': active ? 'page' : null, 'data-key': it.key },
      h('span', { class: 'tab-ic' }, icon(iconFor(it.key)), it.key === 'home' ? null : badge(it.key)), h('span', { class: 'tab-label' }, it.label));
  };
  const plus = h('button', { type: 'button', class: 'tab tab-new', 'aria-label': 'New: snap, request or claim', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', id: 'tab-new' },
    h('span', { class: 'tab-fab' }, icon('plus', { size: 26 })), h('span', { class: 'tab-label' }, 'New'));
  plus.onclick = () => {
    if (openSheet && plus.classList.contains('open')) { closeSheet(); return; }
    newSheet(plus); plus.classList.add('open'); plus.setAttribute('aria-expanded', 'true');
  };
  const moreActive = rest.some((x) => x.key === activeKey) || activeKey === 'more' || activeKey === 'how';
  const moreBadge = badge(rest.map((x) => x.key).filter((k) => k !== 'updates').join(',') || 'none');
  moreBadge.dataset.updates = '1'; paint(moreBadge);
  const more = h('a', { href: '#/more', class: `tab tab-more${moreActive ? ' active' : ''}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-key': 'more', id: 'tab-more' },
    h('span', { class: 'tab-ic' }, icon('more'), moreBadge), h('span', { class: 'tab-label' }, 'More'));
  more.onclick = (e) => {
    e.preventDefault();
    if (openSheet && more.getAttribute('aria-expanded') === 'true') { closeSheet(); return; }
    bottomSheet('More', moreRows(rest), more, { id: 'more-sheet' }); more.setAttribute('aria-expanded', 'true');
  };
  const [a, b, c] = main;
  return h('nav', { class: 'tabbar', 'aria-label': 'Main' }, a ? tab(a) : null, b ? tab(b) : null, plus, c ? tab(c) : null, more);
}

/** The side menu's number for a screen (computer screens). */
export const sideBadge = (key) => (['requests', 'cash', 'stock', 'admin', 'schedule'].includes(key) ? badge(key) : null);

/* While someone types, the bar steps aside (more room above the keyboard); text boxes check spelling. */
const TEXTY = 'textarea, input:not([type]), input[type="text"], input[type="search"]';
document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (!el?.matches || el.closest('.tabbar')) return;
  if (el.matches(TEXTY + ', input[type="number"], input[type="email"], input[type="tel"], input[type="date"], input[type="password"], select')) document.documentElement.classList.add('typing');
  if (el.matches(TEXTY) && !el.hasAttribute('spellcheck')) { el.setAttribute('spellcheck', 'true'); if (!el.hasAttribute('autocapitalize')) el.setAttribute('autocapitalize', 'sentences'); el.setAttribute('autocorrect', 'on'); }
});
document.addEventListener('focusout', () => setTimeout(() => {
  const a = document.activeElement;
  if (!a || a === document.body || !a.matches?.('input, textarea, select')) {
    document.documentElement.classList.remove('typing');
    const open = document.querySelector('.picker.open .picker-panel'); if (open) import('./ui.js').then((u) => u.fitAbove(open));
  }
}, 120));

/* The bar is pinned to the bottom of the screen, always; it only slides away while someone types (styles.css html.typing). */

