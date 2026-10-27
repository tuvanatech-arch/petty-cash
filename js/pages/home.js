import { sb, state, can, role, personName, unwrap, rpc } from '../api.js';
import { h, money, fmtDate, pill, emptyState, qty, toast, busy } from '../ui.js';
import { requestRow, expenseOf } from './requests.js';
import { floatStrip, outlookBox } from './cash.js';
import { reportDialog } from './stock.js';

export async function homePage() {
  const me = state.me;
  const r = role();
  const statuses = [];
  if (can('stock_review')) statuses.push('stock_review');
  if (can('approve')) statuses.push('pending_approval');
  if (can('finance')) statuses.push('awaiting_disbursement', 'proof_review', 'physical_required');

  const [queueRes, mineRes, cashRes, floatRes, lowRes, statsRes, outlookRes, reportsRes, inboxRes] = await Promise.all([
    statuses.length ? sb.from('requests').select('*').in('status', statuses).order('submitted_at', { ascending: true }) : { data: [] },
    sb.from('requests').select('*').eq('requester_id', me.id).order('updated_at', { ascending: false }).limit(8),
    sb.from('requests').select('*, expense:expenses(proof_status, finance_note)').eq('status', 'disbursed').eq('disbursed_to', me.id).order('disbursed_at'),
    can('finance') ? sb.from('v_floats').select('*').eq('status', 'open').maybeSingle() : { data: null },
    can('manage_stock') ? sb.from('items').select('id,name,unit,qty_on_hand,reorder_level,recurring').eq('active', true).order('name') : { data: [] },
    can('manage_stock') ? sb.rpc('item_usage_stats') : { data: [] },
    can('approve') || can('finance') ? sb.rpc('float_outlook') : { data: null },
    sb.from('stock_reports').select('id, item_id, level, reported_by, created_at, item:items(name)').is('resolved_at', null).order('created_at', { ascending: false }),
    sb.from('receipt_inbox').select('id, file_name, extracted, created_at').eq('status', 'unfiled').order('created_at', { ascending: false }),
  ]);
  const unfiled = inboxRes.data || [];
  const reports = reportsRes.data || [];
  const myReports = reports.filter((r) => r.reported_by === me.id);
  const stats = {}; for (const s of statsRes.data || []) stats[s.item_id] = s;
  const queue = unwrap(queueRes); const mine = unwrap(mineRes); const cash = unwrap(cashRes);
  const openFloat = floatRes.data;
  const low = (lowRes.data || []).filter((i) => { const s = stats[i.id]; return Number(i.qty_on_hand) <= 0 ? (i.recurring || Number(i.reorder_level) > 0) : (Number(i.reorder_level) > 0 && Number(i.qty_on_hand) < Number(i.reorder_level)) || (s?.days_of_cover != null && Number(s.days_of_cover) <= 14); })
    .sort((a, b) => (Number(stats[a.id]?.days_of_cover ?? 999)) - (Number(stats[b.id]?.days_of_cover ?? 999)));

  const groups = [];
  const grace = Number(state.settings?.advance_grace_days || 5);
  const overdue = cash.filter((q) => (Date.now() - new Date(q.disbursed_at)) / 86400000 > grace);
  if (cash.length) groups.push(group('Cash in your hands – record what you spent', cash,
    overdue.length ? `${overdue.length === cash.length ? 'These are' : `${overdue.length} of these are`} more than ${grace} days old. Upload the receipt and enter the lines so finance can close the month.` : 'Upload the receipt and enter the lines. Finance is waiting on these before month-end.'));
  const byStatus = (s) => queue.filter((q) => q.status === s);
  if (can('stock_review') && byStatus('stock_review').length) groups.push(group('Stock requests to review', byStatus('stock_review')));
  if (can('approve') && byStatus('pending_approval').length) groups.push(group(`Above ${money(state.settings.approval_threshold)} – needs your approval`, byStatus('pending_approval'), null, 'purple'));
  if (can('finance')) {
    const payouts = byStatus('awaiting_disbursement').filter((q) => q.type !== 'claim'), claims = byStatus('awaiting_disbursement').filter((q) => q.type === 'claim');
    if (payouts.length) groups.push(group('Ready to pay out', payouts));
    if (claims.length) groups.push(group('Claims to reimburse', claims, 'People paid from their own pocket. Check the receipt, then pay them back from the float.'));
    if (byStatus('proof_review').length) groups.push(group('Proofs to check', byStatus('proof_review')));
    if (byStatus('physical_required').length) groups.push(group('Waiting for physical receipts', byStatus('physical_required')));
  }

  const actions = [h('a', { class: 'btn btn-primary', href: '#/snap' }, '📷 Snap a receipt'), h('a', { class: 'btn', href: '#/requests/new' }, 'New request')];
  if (!can('manage_stock')) actions.splice(1, 0, h('button', { class: 'btn', onclick: () => reportDialog(null) }, 'Report low / out'));
  if (can('manage_stock')) {
    const b = h('button', { class: 'btn' }, 'Raise monthly restock');
    b.onclick = busy(b, async () => {
      const req = await rpc('create_restock_request');
      toast('Draft restock order created from recurring items. Check the quantities, then submit.');
      location.hash = `#/requests/${req.id}/edit`;
    });
    actions.push(b);
  }

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `${greet}, ${(me.full_name || me.email).split(' ')[0]}`),
        h('p', {}, groups.length ? `${groups.reduce((n, g) => n + g.n, 0)} item${groups.reduce((n, g) => n + g.n, 0) === 1 ? '' : 's'} waiting on you.` : 'Nothing is waiting on you.')),
      h('div', { class: 'page-actions' }, actions)),
    openFloat ? h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, `Petty cash – ${fmtMonth(openFloat.period)}`), h('a', { href: '#/cash' }, 'Manage float')), floatStrip(openFloat)) : null,
    openFloat && outlookRes.data ? outlookBox(outlookRes.data) : null,
    can('manage_stock') && reports.length ? h('div', { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('h2', {}, 'Reported by the team'), h('a', { href: '#/stock/reports' }, 'All reports')),
      h('ul', { class: 'ledger-list' }, Object.values(reports.reduce((m, r) => { (m[r.item_id] ||= { name: r.item?.name, out: false, n: 0, who: [] }); m[r.item_id].n++; m[r.item_id].out ||= r.level === 'out'; m[r.item_id].who.push(personName(r.reported_by)); return m; }, {})).map((g) =>
        h('li', { class: 'click', onclick: () => { location.hash = '#/stock/reports'; } }, h('div', { class: 'what' }, h('strong', {}, g.name), h('span', {}, `reported by ${[...new Set(g.who)].join(', ')}`)), h('span', { class: `pill ${g.out ? 'pill-red' : 'pill-amber'}` }, g.out ? 'Out' : 'Running low'))))) : null,
    unfiled.length ? h('div', { class: 'banner banner-amber' }, h('strong', {}, `${unfiled.length} unfiled receipt${unfiled.length === 1 ? '' : 's'}`), 'Snapped but not yet filed: ', unfiled.map((u, i) => [i ? ', ' : '', h('a', { href: `#/snap?inbox=${u.id}` }, u.extracted?.supplier || u.file_name)]), '.') : null,
    !can('manage_stock') && myReports.length ? h('p', { class: 'hint', style: { marginBottom: '14px' } }, `You have ${myReports.length} open report${myReports.length === 1 ? '' : 's'} with the stock manager: ${myReports.map((r) => r.item?.name).join(', ')}. `, h('a', { href: '#/stock/reports' }, 'See them')) : null,
    can('finance') && !openFloat ? h('div', { class: 'banner banner-amber' }, h('strong', {}, 'No petty cash float is open'), 'Cash cannot be paid out until finance opens this month\'s float. ', h('a', { href: '#/cash' }, 'Open it now')) : null,
    groups.map((g) => g.el),
    low.length ? h('div', { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('h2', {}, 'Running low'), h('a', { href: '#/stock/usage' }, 'Usage')),
      h('ul', { class: 'ledger-list' }, low.map((i) => { const s = stats[i.id]; const out = Number(i.qty_on_hand) <= 0;
        return h('li', { class: 'click', onclick: () => { location.hash = '#/stock'; } }, h('div', { class: 'what' }, h('strong', {}, i.name),
          h('span', {}, out ? 'Out of stock' : s?.runout_date ? `runs out about ${fmtDate(s.runout_date)} at the current rate` : `below the reorder level of ${qty(i.reorder_level)}`)),
          h('span', { class: 'amt', style: { color: out ? 'var(--red)' : 'var(--amber)' } }, `${qty(i.qty_on_hand)} ${i.unit}`)); }))) : null,
    h('div', { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('h2', {}, 'Your recent requests'), h('a', { href: '#/requests' }, 'All requests')),
      mine.length ? h('ul', { class: 'ledger-list' }, mine.map((q) => requestRow(q))) : emptyState('No requests yet', 'Raise one with “New request”.')));
}

function fmtMonth(d) { return new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); }

function group(title, items, hint, tone) {
  return {
    n: items.length,
    el: h('div', { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('h2', { class: tone === 'purple' ? 'threshold' : '' }, title), h('span', { class: 'sub' }, `${items.length}`)),
      hint ? h('p', { class: 'hint' }, hint) : null,
      h('ul', { class: 'ledger-list' }, items.map((q) => requestRow(q, { showRequester: true, note: expenseOf(q)?.proof_status === 'returned' ? `Returned: ${expenseOf(q).finance_note}` : null })))),
  };
}
