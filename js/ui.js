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
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function mount(el, ...children) { clear(el); append(el, children); return el; }

/* ---------- formatting ---------- */
export function cur() { return state.settings?.currency || 'N$'; }
export function money(v, { sign = false } = {}) {
  const n = Number(v || 0);
  const s = Math.abs(n).toLocaleString('en-NA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '−' : sign && n > 0 ? '+' : ''}${cur()}${s}`;
}
export function qty(v) {
  const n = Number(v || 0);
  return Number.isInteger(n) ? String(n) : n.toLocaleString('en-NA', { maximumFractionDigits: 2 });
}
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
  awaiting_disbursement: { label: 'Awaiting cash',         pill: 'pill-amber' },
  disbursed:             { label: 'Cash out – record spend', pill: 'pill-amber' },
  proof_review:          { label: 'Proof with finance',    pill: 'pill-blue' },
  physical_required:     { label: 'Physical receipt needed', pill: 'pill-amber' },
  closed:                { label: 'Closed',                pill: 'pill-green' },
  fulfilled_from_stock:  { label: 'Issued from stock',     pill: 'pill-green' },
  rejected:              { label: 'Rejected',              pill: 'pill-red' },
  cancelled:             { label: 'Cancelled',             pill: 'pill-grey' },
};
export const OPEN_STATUSES = ['draft', 'stock_review', 'pending_approval', 'awaiting_disbursement', 'disbursed', 'proof_review', 'physical_required'];
export function pill(status) {
  const s = STATUS[status] || { label: status, pill: 'pill-grey' };
  return h('span', { class: `pill ${s.pill}` }, s.label);
}
export const EVENT_LABEL = {
  submitted: 'Submitted', stock_reviewed: 'Stock reviewed', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled',
  escalated: 'Sent for approval', referred_to_md: 'Sent to the Managing Director', reviewed: 'Reviewed after payment', disbursed: 'Cash paid out', expense_recorded: 'Expense recorded', proof_confirmed: 'Proof confirmed – closed',
  physical_required: 'Physical receipt requested', physical_received: 'Physical receipt received', expense_returned: 'Returned for correction',
  reimbursed: 'Reimbursed – closed', float_warning: 'Finance warned about the float', document_attached: 'Invoice / quote attached', payout_undone: 'Pay-out undone',
};
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
    mount(slot, h('div', { class: 'loading' }, 'Loading…'));
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
