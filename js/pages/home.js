import { sb, state, can, role, personName, unwrap, rpc, isStaff, pushSupport, enablePush, canApproveReq, canReviewReq, scoped, inView, multiBranch, branchName } from '../api.js';
import { h, money, fmtDate, qty, toast, busy, confirmDialog, refresh, emptyState, onceHint, more } from '../ui.js';
import { requestRow, expenseOf } from './requests.js';
import { floatStrip, reviewCountDialog, answerCountDialog, decideTopUpDialog, receiveTopUpDialog } from './cash.js';
import { reportDialog, confirmReceiptDialog, decideAdjustmentActions } from './stock.js';
import { setupCard, welcomeStrip } from '../learn.js';
import { overviewSection, liveRoot } from './overview.js';

/** A duty is a role you hold today: your own, or one you are standing in for. The approver can see everything but only approving is theirs. */
const duty = (r) => role() === r || state.standingIn.some((d) => d.role === r);
const OPEN = ['stock_review', 'pending_approval', 'awaiting_disbursement', 'disbursed', 'proof_review', 'physical_required'];
const HOLDER = { stock_review: 'stock_manager', pending_approval: 'approver', awaiting_disbursement: 'finance', proof_review: 'finance', physical_required: 'finance', disbursed: 'people' };
const holderOf = (q) => (q.status === 'pending_approval' && q.approval_level === 'md' ? 'managing_director' : HOLDER[q.status]);
const oversight = () => duty('approver') || duty('managing_director');

/** The MD's Home is the approvals first, then the live overview; everyone else gets their own queue. */
export async function homePage() { return role() === 'managing_director' ? liveRoot(buildHome) : buildHome(); }

async function buildHome() {
  const me = state.me;
  const isMD = role() === 'managing_director';
  const staff = isStaff();
  const [openRes, mineRes, cashRes, floatRes, itemsRes, statsRes, outlookRes, reportsRes, inboxRes, checksRes, reviewRes, schedRes, countsRes, topUpsRes, receiptsRes, adjRes] = await Promise.all([
    staff ? scoped(sb.from('requests').select('*, expense:expenses(proof_status, finance_note)')).in('status', OPEN).order('submitted_at', { ascending: true }) : { data: [] },
    sb.from('requests').select('*').eq('requester_id', me.id).order('updated_at', { ascending: false }).limit(staff ? 20 : 6),
    sb.from('requests').select('*, expense:expenses(proof_status, finance_note)').eq('status', 'disbursed').eq('disbursed_to', me.id).order('disbursed_at'),
    duty('finance') || oversight() ? scoped(sb.from('v_floats').select('*')).eq('status', 'open').order('period') : { data: [] },
    duty('stock_manager') ? scoped(sb.from('items').select('id,name,unit,qty_on_hand,reorder_level,recurring')).eq('active', true).order('name') : { data: [] },
    duty('stock_manager') ? sb.rpc('item_usage_stats') : { data: [] },
    duty('finance') || oversight() ? sb.rpc('branch_outlooks') : { data: [] },
    (state.view ? sb.from('stock_reports').select('id, item_id, level, reported_by, created_at, request_id, item:items!inner(name, unit, qty_on_hand, branch_id)').eq('item.branch_id', state.view) : sb.from('stock_reports').select('id, item_id, level, reported_by, created_at, request_id, item:items(name, unit, qty_on_hand, branch_id)')).is('resolved_at', null).order('created_at', { ascending: false }),
    sb.from('receipt_inbox').select('id, file_name, extracted, created_at').eq('status', 'unfiled').order('created_at', { ascending: false }),
    duty('finance') ? sb.rpc('expense_checks') : { data: [] },
    oversight() ? sb.from('requests').select('*').not('review_reason', 'is', null).is('reviewed_at', null).order('submitted_at') : { data: [] },
    oversight() ? sb.from('schedule_versions').select('id, status, md_status, area, version_no, changes, reason, proposed_by, proposed_at').or('status.eq.pending,and(status.eq.applied,md_status.eq.no_md)') : { data: [] },
    duty('finance') || oversight() ? sb.from('cash_counts').select('*').in('status', ['to_review', 'queried']).order('counted_at') : { data: [] },
    duty('finance') || oversight() ? sb.from('top_ups').select('*').in('status', ['requested', 'authorised']).order('requested_at') : { data: [] },
    staff ? sb.from('stock_receipts').select('*, item:items(name, unit, branch_id)').eq('status', 'to_check').order('created_at') : { data: [] },
    oversight() ? sb.from('stock_adjustments').select('*, item:items(name, unit, branch_id)').eq('status', 'to_approve').order('requested_at') : { data: [] },
  ]);
  const open = openRes.data || [];
  const checks = {}; for (const c of checksRes.data || []) checks[c.request_id] = c;
  const floats = floatRes.data || [];
  const outlooks = Array.isArray(outlookRes.data) ? outlookRes.data : [];
  outlookRef.current = outlooks; checksRef.current = checks;
  const cash = unwrap(cashRes);
  const unfiled = inboxRes.data || [];
  const reports = reportsRes.data || [];
  const byStatus = (s) => open.filter((q) => q.status === s);

  /* ---------------- what is mine to do ---------------- */
  const cards = [];
  if (cash.length || unfiled.length) {
    const grace = Number(state.settings?.advance_grace_days || 5);
    const late = cash.filter((q) => (Date.now() - new Date(q.disbursed_at)) / 86400000 > grace).length;
    cards.push(card('Receipts you owe', cash.length + unfiled.length,
      late ? h('p', { class: 'hint', style: { color: 'var(--amber)' } }, `${late} more than ${grace} days old – snap the receipt to clear ${late === 1 ? 'it' : 'them'}.`) : null,
      h('ul', { class: 'ledger-list' },
        unfiled.map((u) => h('li', { class: 'click', onclick: () => { location.hash = `#/snap?inbox=${u.id}`; } }, h('div', { class: 'what' }, h('strong', {}, u.extracted?.supplier || 'Snapped receipt'), h('span', {}, `photo from ${fmtDate(u.created_at)} · not filed yet`)), h('span', { class: 'amt' }, u.extracted?.total != null ? money(u.extracted.total) : '→'))),
        cash.map((q) => requestRow(q))),
      h('a', { class: 'btn btn-primary btn-sm', href: '#/snap', style: { marginTop: '10px' } }, '📷 Snap or upload')));
  }
  // approvals: the GM's level for the GM, the MD's level for the MD, never one's own
  const toApprove = byStatus('pending_approval').filter((q) => canApproveReq(q) && (q.approval_level === 'md' ? duty('managing_director') : duty('approver')));
  if (toApprove.length) {
    cards.push(card('Needs your approval', toApprove.length,
      onceHint('approve-inline', 'Approve or reject straight from here; the line under each shows what it leaves in the float. Tap a request for the full picture.'),
      list(toApprove, approveActions), null, 'purple'));
  }
  // paid without approval (the MD's own) or spent over what was paid out: looked at afterwards
  const toReview = (reviewRes.data || []).filter((q) => canReviewReq(q) && (q.review_role === 'managing_director' ? duty('managing_director') : duty('approver')));
  if (toReview.length) {
    cards.push(card('To review after payment', toReview.length, null,
      list(toReview, (q) => h('div', { class: 'row-actions' }, h('span', { class: 'note' }, q.review_reason)))));
  }
  // the authority schedule: a change waiting for the MD, and what was changed before there was an MD
  const sched = schedRes.data || [];
  const schedPending = sched.find((v) => v.status === 'pending' && v.proposed_by !== me.id);
  const schedUnseen = sched.filter((v) => v.status === 'applied' && v.proposed_by !== me.id);
  if (duty('managing_director') && schedPending) {
    cards.push(card('Schedule change to approve', 1, null,
      h('ul', { class: 'plain-list changes' }, (schedPending.changes || []).map((c) => h('li', {}, `${c.label}: `, h('s', {}, c.from), ' → ', h('strong', {}, c.to)))),
      h('p', { class: 'hint' }, `From ${personName(schedPending.proposed_by)}${schedPending.reason ? ` – “${schedPending.reason}”` : ''}`, ' ', h('a', { class: 'btn btn-sm btn-primary', href: '#/schedule' }, 'Open to approve')), 'purple'));
  }
  if (role() === 'managing_director' && schedUnseen.length) {
    cards.push(card('Schedule to review', schedUnseen.length, h('p', { class: 'hint' }, 'Versions made before you were set up in the app. Look through them and mark them reviewed.'),
      h('a', { class: 'btn btn-sm', href: '#/schedule' }, 'Open the schedule')));
  }
  // the cash box: counts to sign off or answer, top-ups to authorise or receive
  const allFloats = (duty('finance') || oversight()) ? (await sb.from('floats').select('id, branch_id')).data || [] : [];
  const counts = inView(countsRes.data || [], allFloats); const topUps = inView(topUpsRes.data || [], allFloats);
  const diffWords = (d) => (Math.abs(Number(d)) < 0.005 ? 'matches the book' : Number(d) < 0 ? `${money(-d)} short` : `${money(d)} over`);
  const cashRow = (title, sub, amt, btnLabel, onClick, tone = '') => h('li', {}, h('div', { class: 'what' }, h('strong', {}, title), h('span', {}, sub)),
    amt ? h('span', { class: 'amt', style: { color: tone } }, amt) : null, h('div', { class: 'row-actions' }, h('button', { class: 'btn btn-sm btn-primary', onclick: onClick }, btnLabel)));
  const heldByTopUp = (c) => topUps.some((t) => t.count_id === c.id && t.status === 'requested');
  if (duty('approver')) {
    const toSign = counts.filter((c) => c.status === 'to_review' && c.counted_by !== me.id && !heldByTopUp(c));
    if (toSign.length) cards.push(card('Cash counts to sign off', toSign.length, null, h('ul', { class: 'ledger-list' }, toSign.map((c) =>
      cashRow(`${c.kind === 'month_end' ? 'Month-end count' : 'Cash count'} · ${fmtDate(c.counted_at)}`, `${personName(c.counted_by)} counted ${money(c.counted)}${c.note ? ` – “${c.note}”` : ''}${c.answer_note ? ` · answered: “${c.answer_note}”` : ''}`,
        diffWords(c.difference), 'Sign off', () => reviewCountDialog(c), Math.abs(Number(c.difference)) < 0.005 ? '' : c.exception ? 'var(--red)' : 'var(--amber)')))));
  }
  const toDecide = topUps.filter((t) => t.status === 'requested' && t.requested_by !== me.id && (t.level === 'md' ? duty('managing_director') : duty('approver')));
  if (toDecide.length) cards.push(card('Top-ups to authorise', toDecide.length, null, h('ul', { class: 'ledger-list' }, toDecide.map((t) => {
    const c = counts.find((x) => x.id === t.count_id);
    return cashRow(t.reason, `${personName(t.requested_by)}, ${fmtDate(t.requested_at)}${c ? ` · count: ${diffWords(c.difference)}` : ''}`, money(t.amount), 'Decide', () => decideTopUpDialog(t, c));
  })), null, 'purple'));
  if (duty('finance')) {
    const asked = counts.filter((c) => c.status === 'queried');
    if (asked.length) cards.push(card('Questions on your cash count', asked.length, null, h('ul', { class: 'ledger-list' }, asked.map((c) =>
      cashRow(`“${c.review_note}”`, `${personName(c.reviewed_by)} on your count of ${fmtDate(c.counted_at)} (${diffWords(c.difference)})`, null, 'Answer', () => answerCountDialog(c))))));
    const arrived = topUps.filter((t) => t.status === 'authorised');
    if (arrived.length) cards.push(card('Top-up authorised', arrived.length, h('p', { class: 'hint' }, 'Record it when the cash is in the box.'), h('ul', { class: 'ledger-list' }, arrived.map((t) =>
      cashRow(t.reason, `Authorised by ${personName(t.decided_by)}, ${fmtDate(t.decided_at)}`, money(t.amount), 'Record the cash', () => receiveTopUpDialog(t))))));
  }
  if (duty('stock_manager')) {
    if (byStatus('stock_review').length) cards.push(card('Stock requests to review', byStatus('stock_review').length, null, list(byStatus('stock_review'))));
    const stockRows = stockToAct(itemsRes.data || [], statsRes.data || [], reports);
    if (stockRows.length) {
      const restock = h('button', { class: 'btn btn-sm' }, 'Raise restock order');
      restock.onclick = busy(restock, async () => { const req = await rpc('create_restock_request'); toast('Draft restock order created from measured usage – check quantities, then submit.'); location.hash = `#/requests/${req.id}/edit`; });
      cards.push(card('Stock to act on', stockRows.length, null, h('ul', { class: 'ledger-list' }, stockRows), h('div', { class: 'form-actions', style: { justifyContent: 'flex-start', marginTop: '10px' } }, h('a', { class: 'btn btn-sm btn-quiet', href: '#/stock/reports' }, 'Team reports'), restock)));
    }
  }
  // the store: deliveries to check, and corrections above the limit for the GM
  const inViewItem = (r) => !state.view || r.item?.branch_id === state.view;
  const receipts = (receiptsRes.data || []).filter(inViewItem);
  const limit = Number(state.settings?.stock_adjust_limit || 0);
  const roleOf = (id) => state.people.find((p) => p.id === id)?.role;
  const receiptRow = (r) => h('li', {}, h('div', { class: 'what' }, h('strong', {}, `${r.item?.name || 'Item'} · ${qty(r.qty_bought)} ${r.item?.unit || ''} bought`), h('span', {}, `by ${personName(r.bought_by)}, ${fmtDate(r.created_at)}${Number(r.unit_cost) ? ` · ${money(Number(r.qty_bought) * Number(r.unit_cost))}` : ''}`)),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn btn-sm btn-primary', onclick: () => confirmReceiptDialog(r, null) }, 'Confirm arrival')));
  if (duty('stock_manager')) {
    const mine = receipts.filter((r) => !(r.bought_by === me.id && Number(r.qty_bought) * Number(r.unit_cost || 0) > limit));
    if (mine.length) cards.push(card('Deliveries to check', mine.length, h('p', { class: 'hint' }, 'Count what reached the shelf against what was bought.'), h('ul', { class: 'ledger-list' }, mine.map(receiptRow))));
  }
  if (duty('finance') || duty('approver')) {
    // the controller bought it above the limit: someone independent signs it in
    const theirs = receipts.filter((r) => roleOf(r.bought_by) === 'stock_manager' && Number(r.qty_bought) * Number(r.unit_cost || 0) > limit && r.bought_by !== me.id);
    if (theirs.length) cards.push(card('Deliveries to confirm', theirs.length, h('p', { class: 'hint' }, `Bought by the stock controller for more than ${money(limit)}, so someone else confirms what arrived.`), h('ul', { class: 'ledger-list' }, theirs.map(receiptRow))));
  }
  if (duty('approver')) {
    const adj = (adjRes.data || []).filter(inViewItem).filter((a) => a.requested_by !== me.id);
    if (adj.length) cards.push(card('Stock corrections to approve', adj.length, h('p', { class: 'hint' }, `Above the ${money(limit)} limit the balance only changes once you approve.`),
      h('ul', { class: 'ledger-list' }, adj.map((a) => h('li', {}, h('div', { class: 'what' }, h('strong', {}, `${a.item?.name || 'Item'} · ${qty(a.qty_before)} → ${qty(a.qty_after)} ${a.item?.unit || ''}`),
        h('span', {}, `${{ count: 'Count difference', correction: 'Correction', delivery: 'Short delivery' }[a.kind] || a.kind} · worth ${money(a.value)} · ${personName(a.requested_by)}, ${fmtDate(a.requested_at)}${a.reason ? ` – “${a.reason}”` : ''}`)), decideAdjustmentActions(a)))), null, 'purple'));
  }
  if (duty('finance')) {
    const payouts = byStatus('awaiting_disbursement');
    if (payouts.length) cards.push(card('To pay out', payouts.length, null, list(payouts, (q) => (q.type === 'claim' ? h('div', { class: 'row-actions' }, h('span', { class: 'note' }, 'Claim – reimburse from the float')) : null))));
    const proofs = byStatus('proof_review');
    if (proofs.length) {
      const matched = proofs.filter((q) => checks[q.id]?.status === 'matches' && q.disbursed_to !== me.id && q.requester_id !== me.id);   // never your own receipt
      cards.push(card('Receipts to check', proofs.length, null, list(proofs, proofActions), null, null, matched.length > 1 ? confirmAllButton(matched) : null));
    }
    const physical = byStatus('physical_required');
    if (physical.length) cards.push(card('Paper receipts awaited', physical.length, null, list(physical)));
  }
  const n = cards.reduce((s, c) => s + c.n, 0);

  /* ---------------- everything else, in one line ---------------- */
  let elsewhere = null;
  if (staff && !isMD) {
    const mineHolders = new Set(['approver', 'managing_director', 'stock_manager', 'finance'].filter(duty));
    const counts = {};
    for (const q of open) { const hld = holderOf(q); if (mineHolders.has(hld)) continue; counts[hld] = (counts[hld] || 0) + 1; }
    const label = { approver: 'with the GM', managing_director: 'with the MD', stock_manager: 'with the stock manager', finance: 'with finance', people: 'cash out with people' };
    const statuses = { approver: 'pending_approval', managing_director: 'pending_approval', stock_manager: 'stock_review', finance: 'awaiting_disbursement,proof_review,physical_required', people: 'disbursed' };
    const stuck = open.filter((q) => q.status !== 'disbursed' && Date.now() - new Date(q.updated_at) > 48 * 3600e3).length;
    const parts = Object.entries(counts).map(([k, c]) => h('a', { href: `#/requests?status=${statuses[k]}` }, h('strong', {}, c), ` ${label[k]}`));
    const othersReports = !duty('stock_manager') && reports.length ? h('a', { href: '#/stock/reports' }, h('strong', {}, new Set(reports.map((r) => r.item_id)).size), ' stock item' + (new Set(reports.map((r) => r.item_id)).size === 1 ? '' : 's') + ' reported') : null;
    const schedWait = !duty('managing_director') && sched.some((v) => v.status === 'pending') ? h('a', { href: can('admin') ? '#/admin/schedule' : '#/schedule' }, h('strong', {}, 1), ' schedule change with the MD') : null;
    if (schedWait) parts.push(schedWait);
    if (parts.length || stuck || othersReports) elsewhere = h('div', { class: 'elsewhere' }, h('span', {}, 'Elsewhere:'), parts, othersReports, stuck ? h('a', { href: '#/requests?view=open', style: { color: 'var(--amber)' } }, h('strong', {}, stuck), ' stuck 2+ days') : null);
  }

  /* ---------------- the float, once ---------------- */
  // one float card per branch being looked at (the MD's overview has its own)
  const floatCard = !isMD && (duty('finance') || oversight()) ? outlooks.map((o) => floatSummary(floats.find((f) => f.id === o.float_id) || null, o)) : null;

  /* ---------------- my own requests ---------------- */
  const myReports = reports.filter((r) => r.reported_by === me.id);
  const mine = (mineRes.data || []).filter((q) => (staff ? !['closed', 'rejected', 'cancelled', 'fulfilled_from_stock'].includes(q.status) && q.status !== 'disbursed' : q.status !== 'disbursed'));
  const mineCard = !isMD && (mine.length || !staff) ? h('div', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, h('h2', {}, staff ? 'Your open requests' : 'Your requests'), h('a', { href: '#/requests' }, 'All')),
    mine.length ? h('ul', { class: 'ledger-list' }, mine.slice(0, 6).map((q) => requestRow(q))) : emptyState('Nothing yet', 'Snap or upload a receipt to claim money back, or ask for cash.'),
    myReports.length ? h('p', { class: 'hint', style: { marginTop: '10px' } }, `Reported to the stock manager: ${myReports.map((r) => r.item?.name).join(', ')}.`) : null) : null;

  /* ---------------- header ---------------- */
  const actions = [h('a', { class: 'btn btn-primary', href: '#/snap' }, '📷 Snap or upload')];
  if (!can('manage_stock')) actions.push(h('button', { class: 'btn', onclick: () => reportDialog(null) }, 'Report low stock'));
  actions.push(h('a', { class: 'btn', href: '#/requests/new' }, 'Ask for cash'));
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  // first visit: three lines on how it works for this role – unless they have plainly used it already
  const acted = (mineRes.data || []).length > 0 || cash.length > 0 || (staff && open.some((q) => [q.approved_by, q.disbursed_by, q.stock_reviewed_by].includes(me.id)));
  const welcome = welcomeStrip({ actedAlready: acted });
  const setup = await setupCard();
  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `${greet}, ${(me.full_name || me.email).split(' ')[0]}`),
        h('p', {}, n ? `${n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you.` : 'You are all caught up.')),
      h('div', { class: 'page-actions' }, actions)),
    setup,
    welcome,
    alertsAsk(),
    floatCard,
    cards.map((c) => c.el),
    staff && !cards.length ? h('div', { class: 'sheet duty-empty' }, h('strong', {}, 'Nothing needs you right now'), 'You will get a buzz when something does.') : null,
    elsewhere,
    isMD ? await overviewSection() : null,
    mineCard);
}

/* ---------------- building blocks ---------------- */
function card(title, n, hint, body, foot = null, tone = null, headAction = null) {
  return { n, el: h('div', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, h('h2', { class: tone === 'purple' ? 'threshold' : '' }, title), headAction || h('span', { class: 'sub' }, n)),
    hint, body, foot) };
}
function list(items, extra = null) {
  return h('ul', { class: 'ledger-list' }, items.map((q) => {
    const li = requestRow(q, { showRequester: true, note: expenseOf(q)?.proof_status === 'returned' ? `returned: ${expenseOf(q).finance_note}` : null });
    const x = extra && extra(q); if (x) li.append(x); return li;
  }));
}

/** Team reports and measured low stock, as one list (reported items first). */
function stockToAct(items, statsArr, reports) {
  const stats = {}; for (const s of statsArr) stats[s.item_id] = s;
  const byItem = {};
  for (const r of reports) (byItem[r.item_id] ||= { item: r.item, out: false, who: new Set(), onOrder: false }).who.add(personName(r.reported_by)), (byItem[r.item_id].out ||= r.level === 'out'), (byItem[r.item_id].onOrder ||= !!r.request_id);
  const rows = Object.entries(byItem).map(([id, g]) => h('li', { class: 'click', onclick: () => { location.hash = '#/stock/reports'; } },
    h('div', { class: 'what' }, h('strong', {}, g.item?.name || 'Item'), h('span', {}, `reported by ${[...g.who].join(', ')}${g.onOrder ? ' · on a restock order' : ''}`)),
    h('span', { class: `pill ${g.out ? 'pill-red' : 'pill-amber'}` }, g.out ? 'Out' : 'Low')));
  const low = items.filter((i) => !byItem[i.id]).filter((i) => { const s = stats[i.id]; return Number(i.qty_on_hand) <= 0 ? (i.recurring || Number(i.reorder_level) > 0) : (Number(i.reorder_level) > 0 && Number(i.qty_on_hand) < Number(i.reorder_level)) || (s?.days_of_cover != null && Number(s.days_of_cover) <= 14); })
    .sort((a, b) => Number(stats[a.id]?.days_of_cover ?? 999) - Number(stats[b.id]?.days_of_cover ?? 999));
  for (const i of low) { const s = stats[i.id]; const out = Number(i.qty_on_hand) <= 0;
    rows.push(h('li', { class: 'click', onclick: () => { location.hash = '#/stock'; } }, h('div', { class: 'what' }, h('strong', {}, i.name), h('span', {}, out ? 'out of stock' : s?.runout_date ? `${qty(i.qty_on_hand)} ${i.unit} left · runs out about ${fmtDate(s.runout_date)}` : `${qty(i.qty_on_hand)} ${i.unit} left · below reorder level`)), h('span', { class: `pill ${out ? 'pill-red' : 'pill-amber'}` }, out ? 'Out' : 'Low'))); }
  return rows;
}

/** One card for the float: four numbers and a verdict; the breakdown on tap. */
function floatSummary(f, o) {
  const where = multiBranch() && o?.branch ? ` for ${o.branch}` : '';
  if (!f) return duty('finance') || multiBranch() ? h('div', { class: 'banner banner-amber' }, h('strong', {}, `No float is open${where}`), 'Nothing can be paid out until this month\'s float is opened. ', h('a', { href: '#/cash' }, 'Open it')) : null;
  const after = o ? Number(o.after_approval) : Number(f.balance);
  const verdict = o ? { ok: ['pill-green', 'Comfortable'], caution: ['pill-amber', 'Tight'], short: ['pill-red', 'Short for the month'], overdrawn: ['pill-red', 'Overcommitted'] }[o.status] : null;
  const cell = (k, v, cls = '') => h('div', {}, h('span', { class: 'k' }, k), h('span', { class: `v ${cls}` }, v));
  return h('div', { class: 'sheet flat' },
    multiBranch() ? h('div', { class: 'sheet-head', style: { marginBottom: '6px' } }, h('h3', {}, o?.branch || branchName(f.branch_id))) : null,
    h('div', { class: 'float-card' },
      cell('In the box', money(f.balance), Number(f.balance) < 0 ? 'neg' : ''),
      cell('Approved, not paid', money(o?.awaiting || 0)),
      cell('Left after that', money(after), after < 0 ? 'neg' : 'hero'),
      cell(`Minimum for day ${o ? o.days_in_month - o.days_left : ''}`, o ? money(o.reserve) : '—'),
      verdict ? h('div', { class: 'verdict' }, h('span', { class: `pill ${verdict[0]}` }, verdict[1])) : null),
    more('Details', floatStrip(f),
      o ? h('p', { class: 'hint', style: { marginTop: '10px' } }, `The minimum is what is usually still spent between today and month-end (${o.basis}) plus a ${o.buffer_pct}% buffer.${Number(o.pending_other) > 0 ? ` ${money(o.pending_other)} more is waiting for approval.` : ''}`) : null,
      h('a', { href: '#/cash' }, 'Open petty cash →')));
}

/** Ask once to switch phone alerts on, where the browser can. Hidden while another banner is already showing. */
function alertsAsk() {
  try {
    if (document.querySelector('.main > .banner')) return null;
    const sup = pushSupport(); const asked = localStorage.getItem('pcs_push_asked');
    if (!sup.ok || sup.granted || asked) return null;
    const b = h('button', { class: 'btn btn-primary btn-sm' }, 'Turn on');
    const el = h('div', { class: 'banner banner-green install-banner' }, h('div', {}, h('strong', {}, 'Get a buzz when something needs you'), 'Even with the app closed.'),
      h('div', { class: 'form-actions', style: { margin: 0 } }, h('button', { class: 'btn btn-quiet btn-sm', onclick: () => { try { localStorage.setItem('pcs_push_asked', 'later'); } catch {} el.remove(); } }, 'Not now'), b));
    b.onclick = busy(b, async () => { await enablePush(); toast('Alerts are on.'); el.remove(); });
    return el;
  } catch { return null; }
}

/* ---- inline actions: approve / reject with the float impact in one line ---- */
const outlookRef = { current: null };
const checksRef = { current: {} };
function approveActions(q) {
  const o = (outlookRef.current || []).find((x) => x.branch_id === q.branch_id) || null;
  let note = null; let tight = false;
  if (o && o.has_float) {
    const after = Number(o.balance) - Number(o.awaiting) - Number(q.estimated_total);
    const st = after < Number(o.expected_remaining) ? 'bad' : after < Number(o.reserve) ? 'warn' : '';
    tight = st === 'bad';
    note = h('span', { class: `note ${st}` }, `Leaves ${money(after)} · ${after < 0 ? 'cannot cover it' : after < Number(o.expected_remaining) ? 'short for the month' : after < Number(o.reserve) ? 'tight' : 'comfortable'}${q.over_budget ? ' · over budget' : ''}`);
  } else if (o && !o.has_float) note = h('span', { class: 'note warn' }, 'No float open yet');
  const ok = h('button', { class: 'btn btn-sm btn-purple' }, tight ? 'Approve anyway' : 'Approve');
  ok.onclick = busy(ok, async (e) => { e.stopPropagation(); await rpc('approve_request', { p_request: q.id, p_note: null }); toast(`Approved #${q.request_no}.`); refresh(); });
  const no = h('button', { class: 'btn btn-sm btn-quiet btn-danger' }, 'Reject');
  no.onclick = busy(no, async (e) => { e.stopPropagation(); const r = await confirmDialog(`Reject #${q.request_no}?`, q.purpose, { ok: 'Reject', danger: true, note: { label: 'Reason', required: true } }); if (!r) return; await rpc('reject_request', { p_request: q.id, p_reason: r }); toast('Rejected.'); refresh(); });
  return h('div', { class: 'row-actions', onclick: (e) => e.stopPropagation() }, note, no, ok);
}
function proofActions(q) {
  const c = checksRef.current[q.id];
  if (!c) return null;
  const tone = { matches: 'pill-green', mismatch: 'pill-amber', duplicate: 'pill-red', unread: 'pill-grey', no_proof: 'pill-amber' }[c.status] || 'pill-grey';
  const label = { matches: 'Matches scan', mismatch: 'Scan differs', duplicate: 'Possible duplicate', unread: 'Scan not read', no_proof: 'No scan' }[c.status] || 'Not checked';
  const own = q.disbursed_to === state.me.id || q.requester_id === state.me.id;
  const ok = c.status === 'matches' && !own ? h('button', { class: 'btn btn-sm btn-primary' }, 'Confirm & close') : null;
  if (ok) ok.onclick = busy(ok, async (e) => { e.stopPropagation(); await rpc('finance_review_expense', { p_request: q.id, p_action: 'confirm', p_note: 'Matches the scanned receipt' }); toast(`#${q.request_no} closed.`); refresh(); });
  return h('div', { class: 'row-actions', onclick: (e) => e.stopPropagation() }, h('span', { class: `pill check-pill ${tone}`, title: c.note || '' }, label), c.status === 'matches' ? null : h('span', { class: `note${c.status === 'duplicate' ? ' bad' : c.status === 'mismatch' ? ' warn' : ''}` }, c.note || ''), ok);
}
function confirmAllButton(matched) {
  const b = h('button', { class: 'btn btn-sm btn-primary' }, `Confirm ${matched.length} matched`);
  b.onclick = busy(b, async () => { for (const q of matched) await rpc('finance_review_expense', { p_request: q.id, p_action: 'confirm', p_note: 'Matches the scanned receipt' }); toast(`${matched.length} closed.`); refresh(); });
  return b;
}
