import { state } from './api.js';

/* ---------- DOM ---------- */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required' || k === 'readonly') { if (v) el.setAttribute(k, ''); }
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(titled(String(c))));
  }
}
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function mount(el, ...children) { clear(el); append(el, children); return el; }

/* ---------- the client's own words for positions ----------
   The app and the database say "GM" / "MD"; each client sets what those positions are called (Admin → Settings),
   and every piece of text on screen and in documents goes through titled(). For MGP the words are unchanged. */
let titleKey = null, titleRe = null, titleMap = null;
export function titled(s) {
  const t = state.settings?.titles;
  if (!t || typeof s !== 'string') return s;
  const key = JSON.stringify(t);
  if (key !== titleKey) {
    titleKey = key;
    const pairs = [['General Manager', t.gm_long], ['Managing Director', t.md_long], ['GM', t.gm], ['MD', t.md]].filter(([a, b]) => b && b.trim() && b !== a);
    titleMap = new Map(pairs);
    titleRe = pairs.length ? new RegExp(`\\b(${pairs.map(([a]) => a).join('|')})\\b`, 'g') : null;
  }
  return titleRe ? s.replace(titleRe, (m) => titleMap.get(m)) : s;
}
/** The client's number format (en-NA for Namibia: 1,234.50). */
export function locale() { return state.settings?.number_locale || 'en-NA'; }

/* ---------- loading: the Petti full stop ---------- */
const LOADING_LINES = ['Counting the float…', 'Checking the receipts…', 'Balancing the book…', 'Matching the vouchers…', 'Tallying the stock…'];
/** The mark with its full stop landing, and a line that changes while you wait. Shows only after a short moment. */
export function loader(text = null, { small = false, now = false } = {}) {
  const line = h('div', { class: 'pl-text' }, text || LOADING_LINES[0]);
  const el = h('div', { class: `petti-loader${small ? ' small' : ''}${now ? ' now' : ''}`, role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'pl-mark', 'aria-hidden': 'true' }, h('span', { class: 'pl-glyph' }, 'P', h('span', { class: 'pl-dot' }))), line);
  if (!text) {
    let i = 0;
    const t = setInterval(() => {
      if (!el.isConnected && i > 0) { clearInterval(t); return; }
      i += 1; line.classList.add('fade');
      setTimeout(() => { line.textContent = LOADING_LINES[i % LOADING_LINES.length]; line.classList.remove('fade'); }, 250);
    }, 1800);
  }
  return el;
}
/** The thin line across the top while a page loads. */
export const progress = (() => {
  let timer = null, n = 0;
  const bar = () => document.getElementById('nav-progress');
  return {
    start() {
      const b = bar(); if (!b) return; n += 1; clearInterval(timer);
      let p = 8; b.style.setProperty('--p', `${p}%`); b.classList.add('on');
      timer = setInterval(() => { p += (90 - p) * 0.12; b.style.setProperty('--p', `${p}%`); }, 200);   // creeps towards 90% until done
    },
    done() {
      const b = bar(); if (!b) return; n = Math.max(0, n - 1); if (n) return;
      clearInterval(timer); b.style.setProperty('--p', '100%');
      setTimeout(() => { b.classList.remove('on'); setTimeout(() => { if (!n) b.style.setProperty('--p', '0%'); }, 350); }, 200);
    },
  };
})();

/* ---------- formatting ---------- */
export function cur() { const b = state.branches?.find((x) => x.id === (state.view || state.branches.find((y) => y.home)?.id)) || state.branches?.[0]; return b?.currency || state.settings?.currency || 'N$'; }
export function money(v, { sign = false } = {}) {
  const n = Number(v || 0);
  const s = Math.abs(n).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '−' : sign && n > 0 ? '+' : ''}${cur()}${s}`;
}
export function qty(v) {
  const n = Number(v || 0);
  return Number.isInteger(n) ? String(n) : n.toLocaleString(locale(), { maximumFractionDigits: 2 });
}
// units of measure that read the same for any amount
const SAME = new Set(['each', 'g', 'kg', 'mg', 'ml', 'l', 'lt', 'm', 'cm', 'mm', 'km', 'pcs', 'pc', 'dozen', 'gross']);
/** "1 ream", "5 reams", "2 boxes", "0 bottles", "3 each": a unit fitted to the amount (only exactly 1 is singular). */
export function unitFor(v, unit) {
  const u = String(unit || '').trim(); const n = Number(v || 0);
  if (!u || Math.abs(n) === 1 || SAME.has(u.toLowerCase()) || !/^[a-z]+$/i.test(u) || /s$/i.test(u) && !/ss$/i.test(u)) return u;
  if (/(s|x|z|ch|sh)$/i.test(u)) return u + 'es';
  if (/[^aeiou]y$/i.test(u)) return u.slice(0, -1) + 'ies';
  return u + 's';
}
/** A quantity with its unit: "5 reams". */
export function units(v, unit) { const u = unitFor(v, unit); return u ? `${qty(v)} ${u}` : qty(v); }
export function fmtDate(d, { time = false } = {}) {
  if (!d) return '—';
  const dt = typeof d === 'string' && d.length === 10 ? new Date(d + 'T00:00:00') : new Date(d);
  const opts = { day: 'numeric', month: 'short', year: dt.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' };
  let s = dt.toLocaleDateString('en-GB', opts);
  if (time) s += ', ' + dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return s;
}
export function monthLabel(d) {
  const dt = typeof d === 'string' ? new Date(d.slice(0, 10) + 'T00:00:00') : d;
  return dt.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}
/** Local-date ISO string (yyyy-mm-dd) – avoids the UTC shift of toISOString(). */
export function isoDate(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
export function today() { return isoDate(); }
export function num(v) { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; }

/* ---------- statuses ---------- */
export const STATUS = {
  draft:                 { label: 'Draft',                 pill: 'pill-grey' },
  stock_review:          { label: 'Stock review',          pill: 'pill-blue' },
  pending_approval:      { label: 'Needs approval',        pill: 'pill-purple' },
  awaiting_disbursement: { label: 'Awaiting payment',      pill: 'pill-amber' },
  disbursed:             { label: 'Cash out – record spend', pill: 'pill-amber' },
  proof_review:          { label: 'Proof with finance',    pill: 'pill-blue' },
  awaiting_supplier:     { label: 'Waiting for the supplier', pill: 'pill-blue' },   // shown for a transfer in proof_review
  physical_required:     { label: 'Physical receipt needed', pill: 'pill-amber' },
  closed:                { label: 'Closed',                pill: 'pill-green' },
  fulfilled_from_stock:  { label: 'Issued from stock',     pill: 'pill-green' },
  rejected:              { label: 'Rejected',              pill: 'pill-red' },
  cancelled:             { label: 'Cancelled',             pill: 'pill-grey' },
};
export const OPEN_STATUSES = ['draft', 'stock_review', 'pending_approval', 'awaiting_disbursement', 'disbursed', 'proof_review', 'physical_required'];
/** The status to show: a bank transfer waits for the requester to confirm the supplier, not for a receipt check. */
export const shownStatus = (q) => (q?.status === 'proof_review' && q.paid_via === 'transfer' ? 'awaiting_supplier' : q?.status);
export function pill(status) {
  if (status && typeof status === 'object') status = shownStatus(status);
  const s = STATUS[status] || { label: status, pill: 'pill-grey' };
  return h('span', { class: `pill ${s.pill}` }, s.label);
}
export const EVENT_LABEL = {
  submitted: 'Submitted', stock_reviewed: 'Stock reviewed', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled',
  escalated: 'Sent for approval', referred_to_md: 'Sent to the Managing Director', reviewed: 'Reviewed after payment', disbursed: 'Cash paid out', expense_recorded: 'Expense recorded', proof_confirmed: 'Proof confirmed – closed',
  physical_required: 'Physical receipt requested', physical_received: 'Physical receipt received', expense_returned: 'Returned for correction',
  reimbursed: 'Reimbursed – closed', float_warning: 'Finance warned about the float', document_attached: 'Invoice / quote attached', payout_undone: 'Pay-out undone', paid_by_transfer: 'Paid by bank transfer', supplier_confirmed: 'Supplier confirmed', cash_received: 'Cash received', cash_not_received: 'Cash not received',
  duplicate_explained: 'Reused receipt explained' };
export const MOVEMENT_LABEL = { purchase_in: 'Bought', issue_out: 'Issued', usage: 'Used', adjustment: 'Adjusted', count: 'Count correction', reversal: 'Reversed' };
export const PACE = { fast: { label: 'Fast mover', pill: 'pill-amber', hint: 'a month\'s order lasts under two weeks' }, slow: { label: 'Slow mover', pill: 'pill-blue', hint: 'a month\'s order lasts over four months, or nothing used in 60 days' }, dormant: { label: 'Never used', pill: 'pill-grey', hint: 'no usage recorded yet' }, normal: { label: 'Steady', pill: 'pill-green', hint: '' } };

/* ---------- toast ---------- */
let toastTimer;
export function toast(msg, { error = false, ms = 3500 } = {}) {
  const root = document.getElementById('toast-root');
  mount(root, h('div', { class: `toast${error ? ' err' : ''}`, role: 'status' }, msg));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => clear(root), error ? ms + 2500 : ms);
}

/* ---------- modal ---------- */
export function modal(title, body, { wide = false } = {}) {
  const root = document.getElementById('modal-root');
  const close = () => clear(root);
  const slot = h('div', {});
  const box = h('div', { class: `modal${wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
    h('h2', {}, title),
    slot);
  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } }, box);
  mount(root, back);
  const focusFirst = () => { const first = slot.querySelector('input:not([type=hidden]), select, textarea, button'); if (first) first.focus(); };
  const content = typeof body === 'function' ? body(close) : body;
  if (content instanceof Promise) {
    mount(slot, loader(null, { small: true }));
    content.then((el) => { mount(slot, el); focusFirst(); }).catch((e) => mount(slot, h('div', { class: 'error' }, e.message)));
  } else { mount(slot, content); focusFirst(); }
  const esc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
  return close;
}

export function confirmDialog(title, text, { ok = 'Confirm', danger = false, note = null } = {}) {
  return new Promise((resolve) => {
    modal(title, (close) => {
      const ta = note ? h('textarea', { class: 'input', placeholder: note.placeholder || '', required: note.required }) : null;
      const err = h('div', { class: 'error' });
      return h('div', {},
        h('p', {}, text),
        ta ? h('div', { class: 'field' }, h('label', {}, note.label), ta) : null,
        err,
        h('div', { class: 'form-actions' },
          h('button', { class: 'btn', onclick: () => { close(); resolve(null); } }, 'Cancel'),
          h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => {
            if (note?.required && !ta.value.trim()) { err.textContent = 'This is required.'; return; }
            close(); resolve(ta ? ta.value.trim() : true);
          } }, ok)));
    });
  });
}

/** Wrap an async handler: disables the button while running, shows errors as a toast. */
export function busy(btn, fn) {
  return async (e) => {
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Working…';
    try { await fn(e); }
    catch (err) { toast(err.message || String(err), { error: true }); }
    finally { btn.disabled = false; btn.textContent = label; }
  };
}

export function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
}
/* ---- forms that adapt to a choice: the parts that come and go slide in and out, filled-in values glow briefly ---- */
const calm = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
/** Show or hide part of a form. Changes after the form is on screen slide and fade; the first draw is instant. */
export function showIf(el, show) {
  if (!el) return;
  show = !!show;
  const was = el.dataset.shown ? el.dataset.shown === '1' : el.style.display !== 'none';
  el.dataset.shown = show ? '1' : '0';
  if (was === show) { if (show) el.style.display = ''; return; }
  el.getAnimations?.().forEach((a) => a.cancel());
  if (!el.isConnected || calm() || !el.animate || !el.getClientRects) { el.style.display = show ? '' : 'none'; return; }
  if (show) el.style.display = '';
  const cs = getComputedStyle(el);
  const full = { height: `${el.offsetHeight}px`, opacity: 1, marginTop: cs.marginTop, marginBottom: cs.marginBottom, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, overflow: 'hidden' };
  const none = { height: '0px', opacity: 0, marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px', overflow: 'hidden' };
  const a = el.animate(show ? [none, full] : [full, none], { duration: show ? 220 : 170, easing: show ? 'cubic-bezier(.2,.7,.3,1)' : 'ease-in' });
  if (!show) a.onfinish = () => { if (el.dataset.shown === '0') el.style.display = 'none'; };
}
/** A field Petti has just filled in or changed because of another choice: a short sand glow, so the eye follows. */
export function adapted(el) {
  if (!el?.animate || calm()) return;
  el.animate([{ boxShadow: '0 0 0 3px rgb(228 184 92 / .7)' }, { boxShadow: '0 0 0 3px rgb(228 184 92 / 0)' }], { duration: 1100, easing: 'ease-out' });
}
/** Change a hint's words with a quick fade instead of a jump. */
export function retext(el, text) {
  if (!el || el.textContent === text) return;
  el.textContent = text;
  if (el.isConnected && el.animate && !calm()) el.animate([{ opacity: 0, transform: 'translateY(-2px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'ease-out' });
}

/**
 * A long dropdown made easy on a phone: tap it, type two letters, tap the one you want. The ones this person
 * uses most (`top`, a list of option values) are listed first. The ordinary <select> stays underneath and keeps
 * its value and change events, so the code around it does not change. Short lists stay ordinary dropdowns.
 */
export function picker(sel, { top = [], topLabel = 'You use these most', placeholder = 'Type to search…', min = 8 } = {}) {
  const opts = () => [...sel.options].filter((o) => o.value !== '' && !o.disabled);
  if (opts().length < min) return sel;
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const label = h('span', { class: 'picker-label' });
  const face = h('button', { type: 'button', class: 'input picker-face', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }, label, h('span', { class: 'picker-chev', 'aria-hidden': 'true' }, '▾'));
  const search = h('input', { class: 'input picker-search', type: 'search', placeholder, autocomplete: 'off', 'aria-label': placeholder });
  const list = h('div', { class: 'picker-list', role: 'listbox' });
  const panel = h('div', { class: 'picker-panel', style: { display: 'none' } }, search, list);
  const wrap = h('div', { class: 'picker' }, face, panel);
  sel.classList.add('picker-native'); sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');
  wrap.prepend(sel);
  let active = 0; let shown = [];
  const sync = () => {
    const o = sel.options[sel.selectedIndex];
    label.textContent = o ? o.textContent : '';
    label.classList.toggle('muted', !o || o.value === '');
    face.disabled = sel.disabled;
  };
  const choose = (v) => {
    if (sel.value !== v) { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    sync(); close(); face.focus();
  };
  const row = (o, i) => h('button', { type: 'button', role: 'option', class: `picker-opt${i === active ? ' active' : ''}${o.value === sel.value ? ' chosen' : ''}`, 'aria-selected': String(o.value === sel.value),
    onclick: () => choose(o.value), onmousemove: () => { if (active !== i) { active = i; paint(); } } }, o.textContent);
  function paint() {
    const q = norm(search.value).trim(); const words = q.split(/\s+/).filter(Boolean);
    const all = opts(); const topSet = new Set(top.map(String));
    const hits = words.length ? all.filter((o) => words.every((w) => norm(o.textContent).includes(w))) : all;
    const first = hits.filter((o) => topSet.has(o.value)).sort((a, b) => top.map(String).indexOf(a.value) - top.map(String).indexOf(b.value));
    const rest = hits.filter((o) => !topSet.has(o.value));
    shown = [...first, ...rest].slice(0, 60);
    if (active >= shown.length) active = 0;
    const kids = [];
    if (first.length) kids.push(h('div', { class: 'picker-group' }, topLabel));
    shown.forEach((o, i) => { if (i === first.length && first.length && rest.length) kids.push(h('div', { class: 'picker-group' }, words.length ? 'Other matches' : 'Everything else')); kids.push(row(o, i)); });
    if (!shown.length) kids.push(h('div', { class: 'picker-empty' }, `Nothing matches “${search.value.trim()}”.`));
    mount(list, kids);
    list.querySelector('.picker-opt.active')?.scrollIntoView?.({ block: 'nearest' });
  }
  const outside = (e) => { if (!wrap.contains(e.target)) close(); };
  function open() {
    if (sel.disabled) return;
    search.value = ''; active = 0; paint();
    showIf(panel, true); face.setAttribute('aria-expanded', 'true'); wrap.classList.add('open');
    setTimeout(() => search.focus(), 30);
    document.addEventListener('pointerdown', outside, true);
  }
  function close() {
    showIf(panel, false); face.setAttribute('aria-expanded', 'false'); wrap.classList.remove('open');
    document.removeEventListener('pointerdown', outside, true);
  }
  face.onclick = () => (wrap.classList.contains('open') ? close() : open());
  search.oninput = () => { active = 0; paint(); };
  search.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, shown.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) choose(shown[active].value); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); face.focus(); }
  };
  sel.addEventListener('change', sync);
  sync();
  wrap.sync = sync;
  return wrap;
}

export function select(options, value, attrs = {}) {
  const sel = h('select', { class: 'input', ...attrs });
  for (const o of options) {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    sel.append(h('option', { value: v, selected: String(v) === String(value) }, l));
  }
  return sel;
}
export function emptyState(title, text) {
  return h('div', { class: 'empty' }, h('strong', {}, title), text || '');
}
export function link(href, ...children) {
  return h('a', { href }, ...children);
}
export function tooltipFollow(el, getText) {
  const tip = document.getElementById('tip');
  el.addEventListener('mousemove', (e) => {
    const t = getText(e);
    if (!t) { tip.style.display = 'none'; return; }
    tip.textContent = t; tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX + 12, window.innerWidth - 160) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
  });
  el.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}

/** Re-run the router for the current page (after a dialog saved something). */
export function refresh() { window.dispatchEvent(new HashChangeEvent('hashchange')); }

/** An explanation shown until the person taps "Got it" on this device; then it is gone for good. */
// which tips a person has dismissed: remembered on their profile (learn.js plugs in), with the browser as the fallback
let tipStore = null;
export function setTipStore(store) { tipStore = store; }
export function onceHint(key, ...text) {
  if (tipStore ? tipStore.seen(key) : (() => { try { return !!localStorage.getItem(`pcs_hint_${key}`); } catch { return false; } })()) return null;
  const el = h('p', { class: 'hint once-hint' }, ...text, ' ',
    h('button', { type: 'button', class: 'linkish', onclick: () => { if (tipStore) tipStore.markSeen(key); else { try { localStorage.setItem(`pcs_hint_${key}`, '1'); } catch {} } el.remove(); } }, 'Got it'));
  return el;
}

/** A collapsed section: summary line visible, body on tap. */
export function more(summary, ...body) {
  return h('details', { class: 'more' }, h('summary', {}, summary), h('div', { class: 'more-body' }, ...body));
}
