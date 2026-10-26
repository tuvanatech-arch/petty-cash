import { sb, state, can, personName, unwrap, rpc } from '../api.js';
import { buildMonthEndPack } from '../pack.js';
import { h, mount, money, num, fmtDate, monthLabel, pill, emptyState, toast, busy, field, select, modal, refresh, isoDate } from '../ui.js';

export function floatStrip(f) {
  const cell = (k, v, cls = '') => h('div', {}, h('span', { class: 'k' }, k), h('span', { class: `v ${cls}` }, money(v)));
  return h('div', { class: 'strip' },
    cell('Allocated', f.allocated),
    Number(f.carried_over) > 0 ? cell('Carried over', f.carried_over) : null,
    Number(f.topped_up) > 0 ? cell('Topped up', f.topped_up) : null,
    Number(f.returned) > 0 ? cell('Returned to finance', f.returned) : null,
    cell('Spent', f.spent),
    cell('Out with people', f.outstanding),
    cell(f.status === 'open' ? 'Balance in the box' : 'Closing balance', f.balance, `hero${Number(f.balance) < 0 ? ' neg' : ''}`));
}

export async function cashPage() {
  const floats = unwrap(await sb.from('v_floats').select('*').order('period', { ascending: false }));
  const open = floats.find((f) => f.status === 'open');
  const page = h('div', {});

  const actions = [];
  if (!open) actions.push(h('button', { class: 'btn btn-primary', onclick: () => openFloatDialog(floats) }, 'Open this month\'s float'));
  else {
    actions.push(packButton(open));
    actions.push(h('button', { class: 'btn', onclick: () => txDialog(open, 'top_up') }, 'Top up'));
    actions.push(h('button', { class: 'btn', onclick: () => txDialog(open, 'return') }, 'Return cash'));
    actions.push(h('button', { class: 'btn btn-primary', onclick: () => closeDialog(open) }, 'Close & reconcile'));
  }

  let current = null;
  if (open) {
    const [{ data: txs }, { data: reqs }] = await Promise.all([
      sb.from('float_transactions').select('*').eq('float_id', open.id).order('created_at'),
      sb.from('requests').select('*, expense:expenses(total, proof_status)').eq('float_id', open.id).order('disbursed_at'),
    ]);
    current = h('div', {},
      h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, `${monthLabel(open.period)} – open`), h('span', { class: 'sub' }, `opened ${fmtDate(open.opened_at)} by ${personName(open.opened_by)}`)), floatStrip(open),
        Number(open.balance) < 0 ? h('div', { class: 'banner banner-red', style: { marginTop: '14px' } }, h('strong', {}, 'The float is overdrawn'), 'More was spent than was in the box. Top it up or check the overspent expenses.') : null),
      h('div', { class: 'grid-2' },
        h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h3', {}, 'Money in and out of the box')),
          h('table', { class: 'ledger' }, h('tbody', {}, (txs || []).map((t) => h('tr', {}, h('td', { class: 'muted', style: { whiteSpace: 'nowrap' } }, fmtDate(t.created_at)), h('td', {}, { allocation: 'Monthly allocation', top_up: 'Top-up', carry_over: 'Carry-over', return: 'Returned to finance' }[t.kind], t.note ? h('div', { class: 'muted', style: { fontSize: '.8rem' } }, t.note) : null),
            h('td', { class: 'num amt' }, money(t.kind === 'return' ? -t.amount : t.amount, { sign: true })))),
            (reqs || []).map((r) => h('tr', { class: 'click', onclick: () => { location.hash = `#/requests/${r.id}`; } }, h('td', { class: 'muted', style: { whiteSpace: 'nowrap' } }, fmtDate(r.disbursed_at)),
              h('td', {}, `#${r.request_no} ${r.purpose}`, h('div', { class: 'muted', style: { fontSize: '.8rem' } }, `to ${personName(r.disbursed_to)} · `, pill(r.status))),
              h('td', { class: 'num amt' }, money(-(r.status === 'disbursed' ? r.disbursed_amount : (expenseTotal(r) ?? r.disbursed_amount)), { sign: true }))))))),
        h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h3', {}, 'Advances not yet recorded')),
          (reqs || []).filter((r) => r.status === 'disbursed').length
            ? h('ul', { class: 'ledger-list' }, (reqs || []).filter((r) => r.status === 'disbursed').map((r) => h('li', { class: 'click', onclick: () => { location.hash = `#/requests/${r.id}`; } },
              h('div', { class: 'what' }, h('strong', {}, `#${r.request_no} ${r.purpose}`), h('span', {}, `${personName(r.disbursed_to)} · ${daysAgo(r.disbursed_at)}`)), h('span', { class: 'amt' }, money(r.disbursed_amount)))))
            : emptyState('All advances recorded', 'Everyone who received cash has accounted for it.'))));
  }

  const past = floats.filter((f) => f.status === 'closed');
  mount(page,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Petty cash'), h('p', {}, 'The monthly float from finance: what came in, what went out, and what should be in the box.')), h('div', { class: 'page-actions' }, actions)),
    !open ? h('div', { class: 'banner banner-amber' }, h('strong', {}, 'No float is open'), 'Nothing can be paid out until a float is opened for the month.') : null,
    current,
    h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Past months')),
      past.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Month'), h('th', { class: 'num' }, 'Allocated'), h('th', { class: 'num' }, 'Top-ups'), h('th', { class: 'num' }, 'Spent'), h('th', { class: 'num' }, 'Closing balance'), h('th', { class: 'num' }, 'Counted'), h('th', { class: 'num' }, 'Difference'), h('th'))),
        h('tbody', {}, past.map((f) => h('tr', {}, h('td', {}, monthLabel(f.period), f.notes ? h('div', { class: 'muted', style: { fontSize: '.8rem' } }, f.notes) : null), h('td', { class: 'num' }, money(f.allocated)), h('td', { class: 'num' }, money(Number(f.topped_up) + Number(f.carried_over))), h('td', { class: 'num' }, money(f.spent)), h('td', { class: 'num amt' }, money(f.balance)),
          h('td', { class: 'num' }, f.counted_cash != null ? money(f.counted_cash) : '—'), h('td', { class: 'num', style: { color: f.counted_cash != null && Math.abs(Number(f.counted_cash) - Number(f.balance)) > 0.005 ? 'var(--red)' : '' } }, f.counted_cash != null ? money(Number(f.counted_cash) - Number(f.balance), { sign: true }) : '—'), h('td', { class: 'num' }, packButton(f, true)))))))
        : emptyState('No closed months yet', 'Closed floats appear here with their reconciliation.')));
  return page;
}

/** "Month-end pack": the reconciliation, every voucher and its receipts as one PDF for the auditor's file. */
export function packButton(f, small = false) {
  const b = h('button', { class: `btn${small ? ' btn-sm btn-quiet' : ''}`, title: 'One PDF: reconciliation, vouchers and the scanned receipts' }, small ? 'PDF pack' : 'Month-end pack');
  b.onclick = busy(b, async () => {
    const name = await buildMonthEndPack(f, { onProgress: (m) => { b.textContent = m; } });
    toast(`${name} downloaded.`);
  });
  return b;
}

function expenseTotal(r) { const e = Array.isArray(r.expense) ? r.expense[0] : r.expense; return e && Number(e.total) > 0 ? Number(e.total) : null; }
function daysAgo(d) { const n = Math.floor((Date.now() - new Date(d)) / 86400000); return n === 0 ? 'today' : n === 1 ? '1 day ago' : `${n} days ago`; }

function openFloatDialog(floats) {
  modal('Open the float', (close) => {
    const now = new Date();
    const months = [];
    for (let i = -1; i <= 2; i++) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push([isoDate(d), monthLabel(d)]); }
    const existing = new Set(floats.map((f) => f.period.slice(0, 7)));
    const period = select(months.filter(([v]) => !existing.has(v.slice(0, 7))), months[1][0]);
    const amount = h('input', { class: 'input num', type: 'number', min: 0, step: '0.01', value: Number(state.settings.default_monthly_float || 0).toFixed(2) });
    const note = h('input', { class: 'input', placeholder: 'Optional' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Open float');
    const go = busy(b, async () => { await rpc('open_float', { p_period: period.value, p_amount: num(amount.value), p_note: note.value }); toast('Float opened.'); close(); refresh(); });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('p', { class: 'hint' }, state.settings.float_rollover ? 'Any balance left in the previous closed month is carried over automatically.' : 'Unspent balance from the previous month is not carried over (change this under Admin → Settings).'),
      field('Month', period), field('Amount received from finance', amount), field('Note', note),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

function txDialog(f, kind) {
  modal(kind === 'top_up' ? 'Top up the float' : 'Return cash to finance', (close) => {
    const amount = h('input', { class: 'input num', type: 'number', min: '0.01', step: '0.01' });
    const note = h('input', { class: 'input', placeholder: kind === 'top_up' ? 'e.g. extra for the year-end function' : 'e.g. surplus returned to main account' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, kind === 'top_up' ? 'Add to float' : 'Record return');
    const go = busy(b, async () => { await rpc('float_transaction', { p_float: f.id, p_kind: kind, p_amount: num(amount.value), p_note: note.value }); toast('Recorded.'); close(); refresh(); });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } }, h('p', { class: 'hint' }, `Balance now ${money(f.balance)}.`), field('Amount', amount), field('Note', note),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

function closeDialog(f) {
  modal(`Close ${monthLabel(f.period)}`, (close) => {
    const counted = h('input', { class: 'input num', type: 'number', min: 0, step: '0.01', value: Number(f.balance).toFixed(2) });
    const notes = h('textarea', { class: 'input', placeholder: 'Reconciliation notes' });
    const diff = h('div', { class: 'hint' });
    const upd = () => { const d = num(counted.value) - Number(f.balance); diff.textContent = Math.abs(d) < 0.005 ? 'Matches the book balance.' : `${d > 0 ? 'Surplus' : 'Shortfall'} of ${money(Math.abs(d))} against the book balance.`; diff.style.color = Math.abs(d) < 0.005 ? 'var(--green-ink)' : 'var(--red)'; };
    counted.oninput = upd; upd();
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Close month');
    const go = busy(b, async () => { await rpc('close_float', { p_float: f.id, p_counted_cash: num(counted.value), p_notes: notes.value }); toast('Month closed.'); close(); refresh(); });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('p', { class: 'hint' }, `Book balance is ${money(f.balance)}${Number(f.outstanding) > 0 ? `, with ${money(f.outstanding)} still out with people – those expenses must be recorded first` : ''}.`),
      field('Cash counted in the box', counted, diff), field('Notes', notes),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}
