import { sb, state, can, personName, unwrap, rpc, uploadPack, packUrl, sendPack } from '../api.js';
import { buildMonthEndPack } from '../pack.js';
import { h, mount, money, num, fmtDate, monthLabel, pill, emptyState, toast, busy, field, select, modal, refresh, isoDate, confirmDialog } from '../ui.js';

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

/** Petty-cash outlook: what the float holds, what is already committed, and the minimum it should hold at this point in the month. */
export function outlookBox(o, { request = null } = {}) {
  if (!o) return null;
  const row = (k, v, cls = '', title = '') => h('tr', { class: cls, title }, h('td', {}, k), h('td', { class: 'num' }, v));
  const neg = (v) => (Number(v) > 0 ? `−${money(v)}` : money(0));
  const tone = { ok: 'green', caution: 'amber', short: 'red', overdrawn: 'red', no_float: 'amber' }[o.status] || 'grey';
  const after = Number(o.after_approval), expected = Number(o.expected_remaining), reserve = Number(o.reserve);
  const verdict = {
    no_float: ['No float is open', 'Finance cannot pay anything out until this month\'s float is opened, so approving now only queues it.'],
    overdrawn: ['The float cannot cover this', `After what is already committed there is ${money(Math.max(after + Number(o.this_request), 0))} available${request ? `, and this request needs ${money(o.this_request)}` : ''}. Finance would need a top-up first.`],
    short: ['Not enough left for the rest of the month', `This leaves ${money(after)}, but about ${money(expected)} is usually still spent before month-end – a shortfall of roughly ${money(expected - after)} unless the float is topped up.`],
    caution: ['Tight', `This leaves ${money(after)}, below the recommended minimum of ${money(reserve)} for day ${o.days_in_month - o.days_left} of ${o.days_in_month}. It should just cover a normal rest of month, with no room for surprises.`],
    ok: ['Comfortable', `This leaves ${money(after)} – ${money(after - reserve)} above the recommended minimum of ${money(reserve)} for this point in the month.`],
  }[o.status] || ['', ''];
  return h('div', { class: 'sheet', style: { borderColor: `var(--${tone === 'grey' ? 'rule' : tone})` } },
    h('div', { class: 'sheet-head' }, h('h2', {}, request ? 'Impact on petty cash' : 'Petty cash outlook'), h('span', { class: 'sub' }, o.has_float ? `${o.days_left} day${o.days_left === 1 ? '' : 's'} left in the month` : 'no open float')),
    h('div', { class: 'grid-2' },
      h('table', { class: 'ledger', style: { fontSize: '.93rem' } }, h('tbody', {},
        row('In the box now', money(o.balance), '', 'Funds received less what has been spent and what is out with people'),
        Number(o.outstanding) > 0 ? row(h('span', { class: 'muted' }, 'of which out with people, unaccounted'), h('span', { class: 'muted' }, money(o.outstanding))) : null,
        Number(o.awaiting) > 0 ? row('Approved, waiting for pay-out', neg(o.awaiting)) : null,
        request ? row('This request', neg(o.this_request)) : null,
        h('tr', { style: { fontWeight: 600 } }, h('td', {}, request ? 'Left if you approve' : 'Left after commitments'), h('td', { class: 'num', style: { color: after < 0 ? 'var(--red)' : '' } }, money(after))),
        Number(o.pending_other) > 0 ? row(h('span', { class: 'muted' }, `${request ? 'Other requests' : 'Requests'} still awaiting your decision`), h('span', { class: 'muted' }, `${neg(o.pending_other)} → ${money(o.after_all_pending)}`)) : null)),
      h('div', {},
        h('div', { class: 'stat' }, h('span', { class: 'k' }, 'Recommended minimum today'), h('span', { class: 'v' }, money(reserve))),
        h('p', { class: 'hint' }, `About ${money(expected)} is usually spent between now and month-end (${o.basis}${o.typical_month != null ? `, typically ${money(o.typical_month)} a month` : ''}), plus a ${o.buffer_pct}% buffer.`))),
    h('div', { class: `banner banner-${tone}`, style: { marginTop: '12px', marginBottom: 0 } }, h('strong', {}, verdict[0]), verdict[1]));
}

export async function cashPage() {
  const [floats, packs] = await Promise.all([
    unwrap(await sb.from('v_floats').select('*').order('period', { ascending: false })),
    unwrap(await sb.from('packs').select('*')),
  ]);
  const packOf = (f) => packs.find((p) => p.float_id === f.id);
  const open = floats.find((f) => f.status === 'open');
  const page = h('div', {});

  const actions = [];
  if (!open) actions.push(h('button', { class: 'btn btn-primary', onclick: () => openFloatDialog(floats) }, 'Open this month\'s float'));
  else {
    actions.push(packButton(open));
    actions.push(h('button', { class: 'btn', onclick: () => payoutNowDialog(open) }, 'Pay out now'));
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
        h('thead', {}, h('tr', {}, h('th', {}, 'Month'), h('th', { class: 'num' }, 'Allocated'), h('th', { class: 'num' }, 'Top-ups'), h('th', { class: 'num' }, 'Spent'), h('th', { class: 'num' }, 'Closing balance'), h('th', { class: 'num' }, 'Counted'), h('th', { class: 'num' }, 'Difference'), h('th', {}, 'Pack'))),
        h('tbody', {}, past.map((f) => h('tr', {}, h('td', {}, monthLabel(f.period), f.notes ? h('div', { class: 'muted', style: { fontSize: '.8rem' } }, f.notes) : null), h('td', { class: 'num' }, money(f.allocated)), h('td', { class: 'num' }, money(Number(f.topped_up) + Number(f.carried_over))), h('td', { class: 'num' }, money(f.spent)), h('td', { class: 'num amt' }, money(f.balance)),
          h('td', { class: 'num' }, f.counted_cash != null ? money(f.counted_cash) : '—'), h('td', { class: 'num', style: { color: f.counted_cash != null && Math.abs(Number(f.counted_cash) - Number(f.balance)) > 0.005 ? 'var(--red)' : '' } }, f.counted_cash != null ? money(Number(f.counted_cash) - Number(f.balance), { sign: true }) : '—'), h('td', { style: { whiteSpace: 'nowrap' } }, packCell(f, packOf(f))))))))
        : emptyState('No closed months yet', 'Closed floats appear here with their reconciliation.')));
  const awaitingPacks = floats.filter((f) => f.status === 'closed' && packOf(f)?.status !== 'sent');
  if (awaitingPacks.length) page.prepend(h('div', { class: 'banner banner-amber' }, h('strong', {}, `${awaitingPacks.length === 1 ? 'A month-end pack is' : `${awaitingPacks.length} month-end packs are`} not yet with the accountant`),
    awaitingPacks.map((f, i) => [i ? ' · ' : '', h('a', { href: `#/cash/pack/${f.id}` }, `${monthLabel(f.period)}: ${packOf(f) ? 'review and send' : 'build the pack'}`)])));
  return page;
}

function packCell(f, pack) {
  if (!pack) return h('a', { href: `#/cash/pack/${f.id}` }, 'Build pack');
  return h('a', { href: `#/cash/pack/${f.id}`, style: { textDecoration: 'none' } }, h('span', { class: `pill ${pack.status === 'sent' ? 'pill-green' : 'pill-amber'}` }, pack.status === 'sent' ? `Sent ${fmtDate(pack.sent_at)}` : 'Awaiting review'));
}

/* ---------------- month-end pack: build → bookkeeper review → send ---------------- */
export async function buildAndStorePack(f, onProgress = () => {}) {
  const { bytes, name, pages, summary } = await buildMonthEndPack(f, { onProgress, save: false });
  onProgress('Uploading…');
  const path = await uploadPack(f, bytes, name);
  return rpc('pack_register', { p_float: f.id, p_path: path, p_file_name: name, p_size: bytes.byteLength, p_pages: pages, p_summary: summary });
}

export async function packPage(floatId) {
  const f = unwrap(await sb.from('v_floats').select('*').eq('id', floatId).single());
  let pack = (await sb.from('packs').select('*').eq('float_id', floatId).maybeSingle()).data;
  const page = h('div', {});
  const progress = h('p', { class: 'hint' });

  async function build(btn) {
    const run = async () => { pack = await buildAndStorePack(f, (m) => { progress.textContent = m; if (btn) btn.textContent = m; }); progress.textContent = ''; toast('Pack built.'); refresh(); };
    if (btn) await busy(btn, run)(); else await run();
  }
  if (f.status !== 'closed') {
    mount(page, h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, `${monthLabel(f.period)} pack`), h('p', {}, 'The pack is built when the month is closed.'))),
      h('div', { class: 'banner banner-amber' }, h('strong', {}, 'This month is still open'), 'Close and reconcile it under Petty cash; the pack is built automatically right after. ', h('a', { href: '#/cash' }, 'Go to Petty cash')));
    return page;
  }
  if (!pack) {
    const b = h('button', { class: 'btn btn-primary' }, 'Build the pack');
    b.onclick = () => build(b);
    mount(page, h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, `${monthLabel(f.period)} pack`), h('p', {}, 'Reconciliation, monthly summary, every voucher and its receipts, as one PDF for the accountant.'))),
      h('div', { class: 'sheet' }, h('p', {}, 'The pack for this month has not been built yet (the month was closed before this step existed, or the build was interrupted).'), h('div', { class: 'form-actions' }, b), progress));
    return page;
  }

  const s = pack.summary || {};
  const url = await packUrl(pack.storage_path);
  const sent = pack.status === 'sent';
  const acct = state.settings?.accountant_email;
  const diff = s.counted_cash != null ? Number(s.counted_cash) - Number(s.balance) : null;
  const check = (ok, label, detail) => h('li', {}, h('span', { style: { color: ok ? 'var(--green-ink)' : 'var(--amber)', fontWeight: 600, marginRight: '8px' } }, ok ? '✓' : '!'), label, detail ? h('span', { class: 'muted' }, ` · ${detail}`) : null);
  const checklist = h('ul', { style: { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '6px' } },
    check(Number(s.outstanding || 0) === 0, 'Every advance accounted for', Number(s.outstanding || 0) ? `${money(s.outstanding)} still out` : null),
    check(!s.missing_proofs, 'Every voucher has a scanned receipt', s.missing_proofs ? `${s.missing_proofs} without` : `${s.vouchers} vouchers`),
    check(diff != null && Math.abs(diff) < 0.005, 'Cash counted matches the book', diff == null ? 'not counted' : Math.abs(diff) < 0.005 ? 'matches' : `${diff > 0 ? 'surplus' : 'shortfall'} of ${money(Math.abs(diff))}${f.notes ? ` – ${f.notes}` : ''}`),
    check(!!acct, 'Accountant email set', acct || 'add it under Admin → Settings'));

  const download = h('a', { class: 'btn', href: url || '#', target: '_blank', rel: 'noopener', download: pack.file_name }, 'Download PDF');
  const rebuild = h('button', { class: 'btn' }, 'Rebuild');
  rebuild.onclick = () => build(rebuild);
  const send = h('button', { class: 'btn btn-primary', disabled: !acct }, acct ? `Approve & send to ${state.settings.accountant_name || acct}` : 'Approve & send');
  send.onclick = busy(send, async () => {
    const n = await confirmDialog('Send the pack to the accountant', `It goes to ${acct}, with you and the approver in copy. This is the bookkeeper's sign-off that the pack has been reviewed.`, { ok: 'Send', note: { label: 'Note to the accountant (optional)' } });
    if (n === null) return;
    const r = await sendPack(pack.id, n);
    toast(`Sent to ${r.sent_to}.`); refresh();
  });
  const manual = h('button', { class: 'btn btn-quiet' }, 'Sent another way');
  manual.onclick = busy(manual, async () => {
    const n = await confirmDialog('Mark as sent', 'Use this when the pack went to the accountant by other means (printed, memory stick, your own email).', { ok: 'Mark as sent', note: { label: 'How was it sent?', required: true } });
    if (!n) return; await rpc('pack_mark_sent', { p_pack: pack.id, p_how: n }); toast('Marked as sent.'); refresh();
  });

  mount(page,
    h('div', { class: 'page-head' }, h('div', {}, h('div', { class: 'ref' }, `Month-end pack · built ${fmtDate(pack.built_at, { time: true })} by ${personName(pack.built_by)} · ${pack.pages} pages · ${(Number(pack.size_bytes) / 1048576).toFixed(1)} MB`),
      h('h1', {}, `${monthLabel(f.period)} pack`), h('p', {}, sent ? h('span', { class: 'pill pill-green' }, `Sent ${fmtDate(pack.sent_at, { time: true })} by ${personName(pack.sent_by)} to ${pack.sent_to}`) : h('span', { class: 'pill pill-amber' }, 'Awaiting bookkeeper review'))),
      h('div', { class: 'page-actions' }, download, sent ? null : rebuild)),
    sent ? null : h('div', { class: 'sheet', style: { borderColor: 'var(--amber)' } },
      h('div', { class: 'sheet-head' }, h('h2', {}, 'Review before sending'), h('span', { class: 'sub' }, 'the bookkeeper\'s sign-off')),
      checklist,
      h('p', { class: 'hint', style: { marginTop: '10px' } }, 'Open the PDF below and page through the vouchers. If something is wrong, fix it in the app (a returned claim, a missing receipt) and rebuild.'),
      h('div', { class: 'form-actions' }, manual, send)),
    pack.send_status && pack.send_status !== 'sent' && pack.send_status !== 'manual' ? h('div', { class: 'banner banner-red' }, h('strong', {}, 'Last send failed'), pack.send_status) : null,
    sent && pack.note ? h('p', { class: 'hint' }, `Note sent with it: ${pack.note}`) : null,
    h('div', { class: 'grid-2' },
      h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Reconciliation')),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Allocated'), h('dd', {}, money(s.allocated)),
          Number(s.topped_up) > 0 ? [h('dt', {}, 'Top-ups'), h('dd', {}, money(s.topped_up))] : null,
          Number(s.carried_over) > 0 ? [h('dt', {}, 'Carried over'), h('dd', {}, money(s.carried_over))] : null,
          h('dt', {}, 'Spent'), h('dd', {}, money(s.spent)),
          h('dt', {}, 'Book balance'), h('dd', {}, h('strong', {}, money(s.balance))),
          s.counted_cash != null ? [h('dt', {}, 'Counted'), h('dd', {}, money(s.counted_cash)), h('dt', {}, 'Difference'), h('dd', { style: { color: diff && Math.abs(diff) > 0.005 ? 'var(--red)' : '' } }, money(diff, { sign: true }))] : null)),
      h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Summary')),
        h('dl', { class: 'kv' },
          (s.months || []).map((m, i) => [h('dt', {}, monthLabel(m.month + '-01')), h('dd', {}, `${money(m.spent)} · ${m.vouchers} voucher${m.vouchers === 1 ? '' : 's'}${i === 2 ? ' (this pack)' : ''}`)]),
          h('dt', {}, 'Via approver'), h('dd', {}, `${s.requests?.approved ?? 0} · ${money(s.requests?.approved_amount)}`),
          h('dt', {}, 'Claims'), h('dd', {}, String(s.requests?.claims ?? 0)),
          h('dt', {}, 'Top category'), h('dd', {}, s.by_category?.[0] ? `${s.by_category[0].name} · ${money(s.by_category[0].amount)}` : '—')))),
    h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'The pack'), h('span', { class: 'sub' }, pack.file_name)),
      url ? h('iframe', { src: url, title: pack.file_name, style: { width: '100%', height: '70vh', border: '1px solid var(--rule)', borderRadius: 'var(--radius)', background: '#fff' } }) : h('p', { class: 'hint' }, 'Could not load the PDF preview – use Download.')));
  return page;
}

/* ---------------- pay out now: an urgent one-off, under the threshold ---------------- */
function payoutNowDialog(f) {
  modal('Pay out now', async (close) => {
    const cats = (await sb.from('categories').select('id, name, kind').eq('active', true).order('name')).data || [];
    const thr = Number(state.settings?.approval_threshold || 0);
    const to = select([['', 'Who gets the cash…'], ...state.people.filter((p) => p.active).map((p) => [p.id, p.full_name || p.email])], '');
    const amount = h('input', { class: 'input num', type: 'number', min: '0.01', max: thr.toFixed(2), step: '0.01', inputmode: 'decimal' });
    const purpose = h('input', { class: 'input', placeholder: 'e.g. Courier at the door – contracts to Walvis Bay', maxlength: 140 });
    const cat = select([['', 'No category'], ...cats.filter((c) => c.kind !== 'stock').map((c) => [c.id, c.name])], '');
    const note = h('input', { class: 'input', placeholder: 'Optional' });
    const warn = h('div', { class: 'hint' });
    amount.oninput = () => { warn.textContent = num(amount.value) > thr ? `Above ${money(thr)} – that needs the approver. Raise a request instead.` : ''; warn.style.color = warn.textContent ? 'var(--purple)' : ''; };
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Pay out');
    const go = busy(b, async () => {
      if (!to.value) throw new Error('Choose who gets the cash.');
      const r = await rpc('quick_payout', { p_to: to.value, p_amount: num(amount.value), p_purpose: purpose.value.trim(), p_category: cat.value || null, p_note: note.value });
      toast(`Paid out ${money(num(amount.value))} – they owe the receipt.`); close(); location.hash = `#/requests/${r.id}`;
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('p', { class: 'hint' }, `For an urgent one-off up to ${money(thr)}: it is recorded as a request on their behalf and paid in one step. They still upload the receipt and record what was spent. Balance in the box: ${money(f.balance)}.`),
      field('Hand the cash to', to), h('div', { class: 'row' }, field('Amount', amount, warn), field('Category', cat)), field('What is it for?', purpose), field('Note', note),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
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
    const go = busy(b, async () => {
      await rpc('close_float', { p_float: f.id, p_counted_cash: num(counted.value), p_notes: notes.value });
      toast('Month closed – building the pack…', { ms: 6000 });
      try {
        const closed = unwrap(await sb.from('v_floats').select('*').eq('id', f.id).single());
        await buildAndStorePack(closed, (m) => { b.textContent = m; });
        close(); location.hash = `#/cash/pack/${f.id}`;
      } catch (e) { toast(`Closed, but the pack could not be built: ${e.message}. Open the month under Past months to build it.`, { error: true, ms: 8000 }); close(); refresh(); }
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('p', { class: 'hint' }, `Book balance is ${money(f.balance)}${Number(f.outstanding) > 0 ? `, with ${money(f.outstanding)} still out with people – those expenses must be recorded first` : ''}.`),
      field('Cash counted in the box', counted, diff), field('Notes', notes),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}
