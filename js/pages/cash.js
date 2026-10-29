import { sb, state, can, has, personName, unwrap, rpc, uploadPack, packUrl, sendPack, mdInPlace } from '../api.js';
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
  const [floats, packs, counts, topUps] = await Promise.all([
    unwrap(await sb.from('v_floats').select('*').order('period', { ascending: false })),
    unwrap(await sb.from('packs').select('*')),
    unwrap(await sb.from('cash_counts').select('*').order('counted_at', { ascending: false }).limit(300)),
    unwrap(await sb.from('top_ups').select('*').order('requested_at', { ascending: false }).limit(60)),
  ]);
  const packOf = (f) => packs.find((p) => p.float_id === f.id);
  const open = floats.find((f) => f.status === 'open');
  const custodian = has('finance');   // finance holds the cash: counts it and asks for top-ups; the GM signs off
  const page = h('div', {});

  const openTopUp = open ? topUps.find((t) => t.float_id === open.id && ['requested', 'authorised'].includes(t.status)) : null;
  const actions = [];
  if (!open) actions.push(h('button', { class: 'btn btn-primary', onclick: () => openFloatDialog(floats) }, 'Open this month\'s float'));
  else {
    actions.push(packButton(open));
    actions.push(h('button', { class: 'btn', onclick: () => payoutNowDialog(open) }, 'Pay out now'));
    if (custodian) actions.push(h('button', { class: 'btn', onclick: () => countDialog(open) }, 'Count cash'));
    if (custodian && !openTopUp) actions.push(h('button', { class: 'btn', onclick: () => topUpDialog(open) }, 'Request top-up'));
    actions.push(h('button', { class: 'btn', onclick: () => txDialog(open) }, 'Return cash'));
    actions.push(h('button', { class: 'btn btn-primary', onclick: () => closeDialog(open) }, 'Close & reconcile'));
  }

  let current = null;
  if (open) {
    const [{ data: ledger }, { data: reqs }] = await Promise.all([
      sb.rpc('cash_ledger', { p_float: open.id }),
      sb.from('requests').select('*, expense:expenses(total, proof_status)').eq('float_id', open.id).order('disbursed_at'),
    ]);
    const floatCounts = counts.filter((c) => c.float_id === open.id);
    current = h('div', {},
      h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, `${monthLabel(open.period)} – open`), h('span', { class: 'sub' }, `opened ${fmtDate(open.opened_at)} by ${personName(open.opened_by)}`)), floatStrip(open),
        lastCountLine(floatCounts[0], open),
        Number(open.balance) < 0 ? h('div', { class: 'banner banner-red', style: { marginTop: '14px' } }, h('strong', {}, 'The float is overdrawn'), 'More was spent than was in the box. Request a top-up or check the overspent expenses.') : null),
      topUpSheet(topUps.filter((t) => t.float_id === open.id).slice(0, 3), counts),
      countsSheet(floatCounts, open),
      ledgerSheet(ledger || [], open),
      h('div', { class: 'grid-2' },
        h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h3', {}, 'Advances not yet recorded')),
          (reqs || []).filter((r) => r.status === 'disbursed').length
            ? h('ul', { class: 'ledger-list' }, (reqs || []).filter((r) => r.status === 'disbursed').map((r) => h('li', { class: 'click', onclick: () => { location.hash = `#/requests/${r.id}`; } },
              h('div', { class: 'what' }, h('strong', {}, `#${r.request_no} ${r.purpose}`), h('span', {}, `${personName(r.disbursed_to)} · ${daysAgo(r.disbursed_at)}`)), h('span', { class: 'amt' }, money(r.disbursed_amount)))))
            : emptyState('All advances recorded', 'Everyone who received cash has accounted for it.')),
        h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h3', {}, 'How the box is checked')),
          h('ul', { class: 'plain-list' },
            h('li', {}, `Finance counts the cash ${Number(state.settings.cash_count_days) > 0 ? `at least every ${Number(state.settings.cash_count_days) === 7 ? 'week' : `${state.settings.cash_count_days} days`}` : 'regularly'} and at month-end; the General Manager signs each count off.`),
            h('li', {}, `A difference above ${money(state.settings.cash_variance_limit || 0)} needs a reason from finance and a resolution from the GM, who can write it off.`),
            h('li', {}, `Top-ups are requested with a count, authorised by the GM (the MD above ${money(state.settings.gm_limit)}) and recorded when the cash arrives.`)))));
  }

  const past = floats.filter((f) => f.status === 'closed');
  mount(page,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Petty cash'), h('p', {}, 'The monthly float from finance: what came in, what went out, and what should be in the box.')), h('div', { class: 'page-actions' }, actions)),
    !open ? h('div', { class: 'banner banner-amber' }, h('strong', {}, 'No float is open'), 'Nothing can be paid out until a float is opened for the month.') : null,
    current,
    h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Past months')),
      past.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Month'), h('th', { class: 'num' }, 'Allocated'), h('th', { class: 'num' }, 'Top-ups'), h('th', { class: 'num' }, 'Spent'), h('th', { class: 'num' }, 'Closing balance'), h('th', { class: 'num' }, 'Counted'), h('th', { class: 'num' }, 'Difference'), h('th', {}, 'Count'), h('th', {}, 'Pack'))),
        h('tbody', {}, past.map((f) => h('tr', {}, h('td', {}, monthLabel(f.period), f.notes ? h('div', { class: 'muted', style: { fontSize: '.8rem' } }, f.notes) : null), h('td', { class: 'num' }, money(f.allocated)), h('td', { class: 'num' }, money(Number(f.topped_up) + Number(f.carried_over))), h('td', { class: 'num' }, money(f.spent)), h('td', { class: 'num amt' }, money(f.balance)),
          h('td', { class: 'num' }, f.counted_cash != null ? money(f.counted_cash) : '—'), h('td', { class: 'num', style: { color: f.counted_cash != null && Math.abs(Number(f.counted_cash) - Number(f.balance)) > 0.005 ? 'var(--red)' : '' } }, f.counted_cash != null ? money(Number(f.counted_cash) - Number(f.balance), { sign: true }) : '—'), h('td', { style: { whiteSpace: 'nowrap' } }, monthEndCell(counts.find((c) => c.float_id === f.id && c.kind === 'month_end' && c.status !== 'superseded'))), h('td', { style: { whiteSpace: 'nowrap' } }, packCell(f, packOf(f))))))))
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
  const monthEnd = (await sb.from('cash_counts').select('*').eq('float_id', floatId).eq('kind', 'month_end').neq('status', 'superseded').maybeSingle()).data;
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
    check(monthEnd?.status === 'accepted', 'Month-end count signed off by the GM', monthEnd ? (monthEnd.status === 'accepted' ? `${personName(monthEnd.reviewed_by)}, ${fmtDate(monthEnd.reviewed_at)}` : monthEnd.status === 'queried' ? 'the GM has a question' : 'waiting for the GM') : 'no month-end count recorded'),
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
          Number(s.adjusted || 0) ? [h('dt', {}, Number(s.adjusted) < 0 ? 'Cash short, written off' : 'Cash over, taken in'), h('dd', {}, money(s.adjusted, { sign: true }))] : null,
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
      h('p', { class: 'hint' }, state.settings.float_rollover ? 'Any balance left in the previous closed month is carried over automatically.' : 'Unspent balance from the previous month is not carried over (set in the authority schedule).'),
      field('Month', period), field('Amount received from finance', amount), field('Note', note),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

function txDialog(f) {
  modal('Return cash to finance', (close) => {
    const amount = h('input', { class: 'input num', type: 'number', min: '0.01', step: '0.01' });
    const note = h('input', { class: 'input', placeholder: 'e.g. surplus returned to main account' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Record return');
    const go = busy(b, async () => { await rpc('float_transaction', { p_float: f.id, p_kind: 'return', p_amount: num(amount.value), p_note: note.value }); toast('Recorded.'); close(); refresh(); });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } }, h('p', { class: 'hint' }, `Balance now ${money(f.balance)}. Top-ups are requested under “Request top-up” and authorised by the GM.`), field('Amount', amount), field('Note', note),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

function closeDialog(f) {
  modal(`Close ${monthLabel(f.period)}`, (close) => {
    const { counted, el } = countField(f);
    const notes = h('textarea', { class: 'input', placeholder: 'Reconciliation notes – needed if the count does not match' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Close month');
    const go = busy(b, async () => {
      if (counted.value === '') throw new Error('Count the cash first – the close is a count.');
      await rpc('close_float', { p_float: f.id, p_counted_cash: num(counted.value), p_notes: notes.value });
      toast('Month closed – the count went to the GM to sign off. Building the pack…', { ms: 6000 });
      try {
        const closed = unwrap(await sb.from('v_floats').select('*').eq('id', f.id).single());
        await buildAndStorePack(closed, (m) => { b.textContent = m; });
        close(); location.hash = `#/cash/pack/${f.id}`;
      } catch (e) { toast(`Closed, but the pack could not be built: ${e.message}. Open the month under Past months to build it.`, { error: true, ms: 8000 }); close(); refresh(); }
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('p', { class: 'hint' }, `Book balance is ${money(f.balance)}${Number(f.outstanding) > 0 ? `, with ${money(f.outstanding)} still out with people – those expenses must be recorded first` : ''}. The month-end count goes to the General Manager to sign off, like any other count.`),
      el, field('Notes', notes),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

/* ================================================================ cash counts, top-ups and the ledger */
const diffText = (d) => (Math.abs(Number(d)) < 0.005 ? 'matches the book' : Number(d) < 0 ? `${money(-d)} short` : `${money(d)} over`);
const diffPill = (d, exc) => h('span', { class: `pill ${Math.abs(Number(d)) < 0.005 ? 'pill-green' : exc ? 'pill-red' : 'pill-amber'}` }, diffText(d));
const COUNT_STATUS = {
  to_review: ['Waiting for the GM', 'pill-amber'], queried: ['Question from the GM', 'pill-purple'],
  accepted: ['Signed off', 'pill-green'], superseded: ['Replaced by a later count', 'pill-grey'],
};
const countStatusPill = (c) => { const [l, cls] = COUNT_STATUS[c.status] || [c.status, 'pill-grey']; return h('span', { class: `pill ${cls}` }, c.status === 'accepted' && c.reviewed_by ? `Signed off by ${personName(c.reviewed_by)}` : l); };
const KIND_LABEL = { spot: 'Cash count', month_end: 'Month-end count', top_up: 'Count with a top-up request' };

function lastCountLine(c, f) {
  const days = c ? Math.floor((Date.now() - new Date(c.counted_at)) / 86400000) : Math.floor((Date.now() - new Date(f.opened_at)) / 86400000);
  const due = Number(state.settings.cash_count_days || 0);
  const late = due > 0 && days >= due;
  return h('p', { class: 'hint', style: { marginTop: '10px', color: late ? 'var(--amber)' : '' } },
    c ? `Last counted ${fmtDate(c.counted_at, { time: true })} by ${personName(c.counted_by)}: ${diffText(c.difference)} · ${{ to_review: 'waiting for the GM', queried: 'the GM has a question', accepted: 'signed off', superseded: 'replaced' }[c.status] || ''}.` : 'Not counted yet this month.',
    late ? ` A count is due (every ${due === 7 ? 'week' : `${due} days`}).` : '');
}

function countActions(c) {
  const out = [];
  if (['to_review', 'queried'].includes(c.status) && has('approver') && c.counted_by !== state.me.id) out.push(h('button', { class: 'btn btn-sm btn-primary', onclick: () => reviewCountDialog(c) }, 'Sign off'));
  if (c.status === 'queried' && has('finance')) out.push(h('button', { class: 'btn btn-sm', onclick: () => answerCountDialog(c) }, 'Answer'));
  return out;
}

function countRow(c) {
  return h('li', {}, h('div', { class: 'what' },
    h('strong', {}, `${KIND_LABEL[c.kind] || 'Count'} · ${fmtDate(c.counted_at, { time: true })}`),
    h('span', {}, `${personName(c.counted_by)} counted ${money(c.counted)} against a book balance of ${money(c.expected)}${c.note ? ` – “${c.note}”` : ''}`),
    c.review_note ? h('span', { style: { display: 'block' } }, `${c.status === 'queried' || c.answer_note ? 'GM asked' : 'GM'}: “${c.review_note}”${c.answer_note ? ` · finance: “${c.answer_note}”` : ''}`) : null,
    c.written_off != null ? h('span', { style: { display: 'block' } }, `${money(Math.abs(c.written_off))} written off as cash ${Number(c.written_off) < 0 ? 'short' : 'over'}.`) : null),
    h('div', { class: 'row-actions' }, diffPill(c.difference, c.exception), countStatusPill(c), ...countActions(c)));
}

function countsSheet(list, f) {
  const shown = list.filter((c) => c.status !== 'superseded' || list.indexOf(c) < 3).slice(0, 6);
  return h('div', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, h('h3', {}, 'Cash counts'), h('span', { class: 'sub' }, list.length ? `${list.length} this month` : 'none yet')),
    list.length ? h('ul', { class: 'ledger-list' }, shown.map(countRow))
      : h('p', { class: 'hint' }, has('finance') ? 'Count the cash in the box with “Count cash”. The General Manager signs each count off.' : 'Finance has not counted the box this month yet.'));
}

function topUpSheet(list, counts) {
  if (!list.length) return null;
  const STATUS = { requested: ['Waiting for authorisation', 'pill-amber'], authorised: ['Authorised – waiting for the cash', 'pill-purple'], received: ['Received', 'pill-green'], rejected: ['Turned down', 'pill-red'], cancelled: ['Cancelled', 'pill-grey'] };
  return h('div', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, h('h3', {}, 'Top-ups'), h('span', { class: 'sub' }, 'one open at a time')),
    h('ul', { class: 'ledger-list' }, list.map((t) => {
      const c = counts.find((x) => x.id === t.count_id);
      const [label, cls] = STATUS[t.status] || [t.status, 'pill-grey'];
      const acts = [];
      const mine = t.requested_by === state.me.id;
      const canDecide = t.status === 'requested' && !mine && (t.level === 'md' ? has('managing_director') : has('approver'));
      if (canDecide) acts.push(h('button', { class: 'btn btn-sm btn-primary', onclick: () => decideTopUpDialog(t, c) }, 'Decide'));
      if (t.status === 'authorised' && has('finance')) acts.push(h('button', { class: 'btn btn-sm btn-primary', onclick: () => receiveTopUpDialog(t) }, 'Record the cash'));
      if (['requested', 'authorised'].includes(t.status) && has('finance')) {
        const x = h('button', { class: 'btn btn-sm btn-quiet' }, 'Cancel');
        x.onclick = busy(x, async () => { if (!(await confirmDialog('Cancel this top-up?', 'Nothing is added to the float.', { ok: 'Cancel it', danger: true }))) return; await rpc('cancel_top_up', { p_id: t.id }); toast('Cancelled.'); refresh(); });
        acts.push(x);
      }
      return h('li', {}, h('div', { class: 'what' },
        h('strong', {}, `${money(t.amount)} · ${t.reason}`),
        h('span', {}, `Requested by ${personName(t.requested_by)}, ${fmtDate(t.requested_at)} · ${t.level === 'md' ? 'the MD authorises' : 'the GM authorises'}${c ? ` · count: ${diffText(c.difference)}` : ''}`),
        t.route_note ? h('span', { style: { display: 'block' } }, t.route_note) : null,
        t.decided_by && t.status !== 'cancelled' ? h('span', { style: { display: 'block' } }, `${t.status === 'rejected' ? 'Turned down' : 'Authorised'} by ${personName(t.decided_by)}, ${fmtDate(t.decided_at)}${t.decision_note ? ` – “${t.decision_note}”` : ''}`) : null,
        t.status === 'received' ? h('span', { style: { display: 'block' } }, `${money(t.received_amount)} received ${fmtDate(t.received_at)} by ${personName(t.received_by)}`) : null),
        h('div', { class: 'row-actions' }, h('span', { class: `pill ${cls}` }, label), ...acts));
    })));
}

const LEDGER_KIND = { allocation: 'In', carry_over: 'In', top_up: 'In', change: 'In', surplus: 'In', payout: 'Out', claim: 'Out', paid_back: 'Out', return: 'Out', shortage: 'Out' };
function ledgerSheet(rows, f) {
  const csv = h('button', { class: 'btn btn-sm', type: 'button' }, 'Download CSV');
  csv.onclick = () => downloadLedgerCsv(rows, f);
  const last = rows[rows.length - 1];
  return h('div', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, h('h3', {}, 'Petty cash ledger'), rows.length ? csv : null),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'ledger cash-ledger' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'What'), h('th', { class: 'num' }, 'In / out'), h('th', { class: 'num' }, 'Balance'))),
      h('tbody', {}, rows.map((r) => h('tr', { class: r.request_id ? 'click' : '', onclick: r.request_id ? () => { location.hash = `#/requests/${r.request_id}`; } : null },
        h('td', { class: 'muted', style: { whiteSpace: 'nowrap' } }, fmtDate(r.at)),
        h('td', {}, r.ref ? `${r.ref} ` : '', r.description, r.person && r.request_id ? h('div', { class: 'muted', style: { fontSize: '.8rem' } }, personName(r.person)) : null),
        h('td', { class: 'num amt', style: { color: Number(r.cash_out) > 0 ? '' : 'var(--green-ink)' } }, Number(r.cash_in) > 0 ? money(r.cash_in, { sign: true }) : money(-r.cash_out)),
        h('td', { class: 'num' }, money(r.balance))))),
      h('tfoot', {}, h('tr', {}, h('td', { colspan: 3 }, 'Book balance'), h('td', { class: 'num' }, h('strong', {}, money(last?.balance ?? 0)))))))
      : emptyState('Nothing yet', 'Money in and out of the box appears here as it happens.'));
}

function downloadLedgerCsv(rows, f) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Date', 'Reference', 'Description', 'Person', 'In', 'Out', 'Balance'].map(q).join(',')];
  for (const r of rows) lines.push([isoDate(new Date(r.at)), r.ref || '', r.description, r.person ? personName(r.person) : '', Number(r.cash_in).toFixed(2), Number(r.cash_out).toFixed(2), Number(r.balance).toFixed(2)].map(q).join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `petty-cash-ledger-${String(f.period).slice(0, 7)}.csv`;
  document.body.append(a); a.click(); a.remove();
}

function monthEndCell(c) {
  if (!c) return h('span', { class: 'muted' }, '—');
  const [label, cls] = { to_review: ['Waiting', 'pill-amber'], queried: ['Question', 'pill-purple'], accepted: ['Signed off', 'pill-green'] }[c.status] || [c.status, 'pill-grey'];
  return h('span', { class: `pill ${cls}`, title: c.status === 'accepted' ? `Signed off by ${personName(c.reviewed_by)}, ${fmtDate(c.reviewed_at)}${c.review_note ? ` – ${c.review_note}` : ''}` : c.review_note || '' }, label);
}

/** The cash field and its live comparison with the book, shared by the count, top-up and close forms. */
function countField(f, label = 'Cash counted in the box') {
  const counted = h('input', { class: 'input num', type: 'number', min: 0, step: '0.01', inputmode: 'decimal', placeholder: 'Count it, then enter the total', required: true });
  const diff = h('div', { class: 'hint' });
  const limit = Number(state.settings.cash_variance_limit || 0);
  const upd = () => {
    if (counted.value === '') { diff.textContent = `Book balance ${money(f.balance)}. Count notes and coins before you look.`; diff.style.color = ''; return; }
    const d = Math.round((num(counted.value) - Number(f.balance)) * 100) / 100;
    diff.textContent = Math.abs(d) < 0.005 ? 'Matches the book balance.' : `${d > 0 ? 'Over' : 'Short'} by ${money(Math.abs(d))} against the book balance of ${money(f.balance)}${Math.abs(d) > limit ? ' – say what caused it below.' : ` (within the ${money(limit)} allowed).`}`;
    diff.style.color = Math.abs(d) < 0.005 ? 'var(--green-ink)' : Math.abs(d) > limit ? 'var(--red)' : 'var(--amber)';
  };
  counted.oninput = upd; upd();
  return { counted, el: field(label, counted, diff) };
}

function countDialog(f) {
  modal('Count the cash', (close) => {
    const { counted, el } = countField(f);
    const note = h('textarea', { class: 'input', rows: 2, placeholder: 'Only needed if it does not match – what do you think caused it?' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Record the count');
    const go = busy(b, async () => {
      if (counted.value === '') throw new Error('Enter the cash counted.');
      const c = await rpc('count_cash', { p_counted: num(counted.value), p_note: note.value });
      toast(Math.abs(Number(c.difference)) < 0.005 ? 'Counted – matches the book. The GM signs it off.' : `Counted – ${diffText(c.difference)}. The GM has been told.`); close(); refresh();
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('p', { class: 'hint' }, 'Count every note and coin in the box. Cash out with people is already off the book balance, so do not add it.'),
      el, field('Note', note),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

export function reviewCountDialog(c) {
  modal(`Sign off the ${KIND_LABEL[c.kind]?.toLowerCase() || 'count'}`, (close) => {
    const off = Math.abs(Number(c.difference)) >= 0.005;
    const note = h('textarea', { class: 'input', rows: 2, placeholder: c.exception ? 'How was it resolved? (needed – the difference is above the limit)' : 'Optional note, or your question for finance' });
    const writeOff = off ? h('input', { type: 'checkbox', checked: !!c.exception }) : null;
    const err = h('div', { class: 'error' });
    const ask = h('button', { class: 'btn', type: 'button' }, 'Ask finance a question');
    ask.onclick = busy(ask, async () => {
      err.textContent = '';
      if (!note.value.trim()) { err.textContent = 'Write the question for finance.'; return; }
      try { await rpc('review_cash_count', { p_id: c.id, p_accept: false, p_note: note.value.trim() }); toast('Sent to finance.'); close(); refresh(); } catch (e) { err.textContent = e.message; }
    });
    const ok = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Sign off');
    const go = busy(ok, async () => {
      err.textContent = '';
      if (c.exception && !note.value.trim()) { err.textContent = 'The difference is above the limit: say how it was resolved.'; return; }
      try { await rpc('review_cash_count', { p_id: c.id, p_accept: true, p_note: note.value.trim() || null, p_write_off: !!writeOff?.checked }); toast(writeOff?.checked ? 'Signed off – the difference was written off.' : 'Signed off.'); close(); refresh(); } catch (e) { err.textContent = e.message; }
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('dl', { class: 'kv' },
        h('dt', {}, 'Counted'), h('dd', {}, `${money(c.counted)} by ${personName(c.counted_by)}, ${fmtDate(c.counted_at, { time: true })}`),
        h('dt', {}, 'Book balance'), h('dd', {}, money(c.expected)),
        Number(c.outstanding) > 0 ? [h('dt', {}, 'Out with people'), h('dd', {}, `${money(c.outstanding)} (already off the book)`)] : null,
        h('dt', {}, 'Difference'), h('dd', {}, diffPill(c.difference, c.exception)),
        c.note ? [h('dt', {}, 'Finance says'), h('dd', {}, `“${c.note}”`)] : null,
        c.review_note && c.answer_note ? [h('dt', {}, 'You asked'), h('dd', {}, `“${c.review_note}”`), h('dt', {}, 'Answer'), h('dd', {}, `“${c.answer_note}”`)] : null),
      field('Note', note),
      writeOff ? h('label', { class: 'check', style: { marginBottom: '6px' } }, writeOff, `Write the ${money(Math.abs(c.difference))} off as cash ${Number(c.difference) < 0 ? 'short' : 'over'}, so the book matches the box`) : null,
      writeOff ? h('p', { class: 'hint' }, 'Leave it unticked if the difference will be found (a pay-out not yet recorded, change still to come back).') : null,
      err, h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn btn-quiet', onclick: close }, 'Cancel'), ask, ok));
  });
}

export function answerCountDialog(c) {
  modal('Answer the GM', (close) => {
    const note = h('textarea', { class: 'input', rows: 3 });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send answer');
    const go = busy(b, async () => { await rpc('answer_cash_count', { p_id: c.id, p_note: note.value }); toast('Answer sent.'); close(); refresh(); });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('p', {}, h('strong', {}, 'The GM asks: '), `“${c.review_note}”`),
      h('p', { class: 'hint' }, `Your count of ${fmtDate(c.counted_at, { time: true })}: ${money(c.counted)}, ${diffText(c.difference)}. If you have found the difference, record it (or count again) and answer here.`),
      field('Your answer', note),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

function topUpDialog(f) {
  modal('Request a top-up', (close) => {
    const amount = h('input', { class: 'input num', type: 'number', min: '0.01', step: '0.01', inputmode: 'decimal', required: true });
    const reason = h('input', { class: 'input', placeholder: 'e.g. Busy month – three site visits still to pay for', maxlength: 200, required: true });
    const who = h('div', { class: 'hint' });
    amount.oninput = () => { const a = num(amount.value); who.textContent = a > Number(state.settings.gm_limit) && mdInPlace() ? 'Above the GM limit: the Managing Director authorises it.' : 'The General Manager authorises it.'; };
    amount.oninput();
    const { counted, el } = countField(f, 'Cash in the box now');
    const note = h('input', { class: 'input', placeholder: 'Only if the count does not match' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send for authorisation');
    const go = busy(b, async () => {
      if (counted.value === '') throw new Error('Count the cash first – the request carries the count.');
      await rpc('request_top_up', { p_amount: num(amount.value), p_reason: reason.value.trim(), p_counted: num(counted.value), p_count_note: note.value });
      toast('Sent for authorisation.'); close(); refresh();
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('p', { class: 'hint' }, 'A top-up rests on a count: the cash in the box now is recorded with the request. Nothing is added until it is authorised and the cash arrives.'),
      h('div', { class: 'row' }, field('Amount needed', amount, who), field('Why', reason)),
      el, field('Note on the count', note),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

export function decideTopUpDialog(t, c) {
  modal(`Top-up of ${money(t.amount)}`, (close) => {
    const note = h('textarea', { class: 'input', rows: 2, placeholder: c?.exception ? 'The count is out – say how that was resolved (needed)' : 'Optional; needed to turn it down' });
    const err = h('div', { class: 'error' });
    const no = h('button', { class: 'btn btn-danger', type: 'button' }, 'Turn down');
    no.onclick = busy(no, async () => { err.textContent = ''; if (!note.value.trim()) { err.textContent = 'Say why it is turned down.'; return; } try { await rpc('decide_top_up', { p_id: t.id, p_approve: false, p_note: note.value.trim() }); toast('Turned down – finance has been told.'); close(); refresh(); } catch (e) { err.textContent = e.message; } });
    const ok = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Authorise');
    const go = busy(ok, async () => { err.textContent = ''; try { await rpc('decide_top_up', { p_id: t.id, p_approve: true, p_note: note.value.trim() || null }); toast('Authorised – finance records it when the cash arrives.'); close(); refresh(); } catch (e) { err.textContent = e.message; } });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('dl', { class: 'kv' },
        h('dt', {}, 'Amount'), h('dd', {}, money(t.amount)),
        h('dt', {}, 'Why'), h('dd', {}, t.reason),
        h('dt', {}, 'Requested'), h('dd', {}, `${personName(t.requested_by)}, ${fmtDate(t.requested_at, { time: true })}`),
        c ? [h('dt', {}, 'Count with it'), h('dd', {}, `${money(c.counted)} counted, book ${money(c.expected)} · `, diffPill(c.difference, c.exception), c.note ? ` “${c.note}”` : '')] : null,
        t.route_note ? [h('dt', {}, 'Routing'), h('dd', {}, t.route_note)] : null),
      h('p', { class: 'hint' }, 'Authorising also signs off the count it rests on.'),
      field('Note', note),
      err, h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn btn-quiet', onclick: close }, 'Cancel'), no, ok));
  });
}

export function receiveTopUpDialog(t) {
  modal('Record the top-up cash', (close) => {
    const amount = h('input', { class: 'input num', type: 'number', min: '0.01', max: Number(t.amount).toFixed(2), step: '0.01', value: Number(t.amount).toFixed(2) });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add to the float');
    const go = busy(b, async () => { await rpc('receive_top_up', { p_id: t.id, p_amount: num(amount.value) }); toast(`${money(num(amount.value))} added to the float.`); close(); refresh(); });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('p', { class: 'hint' }, `Authorised by ${personName(t.decided_by)} on ${fmtDate(t.decided_at)}: ${money(t.amount)} – ${t.reason}. Count what actually arrived; it cannot be more than was authorised.`),
      field('Cash received', amount),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}
