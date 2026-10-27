import { sb, state, can, role, personName, unwrap, rpc, isStaff, pushSupport, enablePush } from '../api.js';
import { h, money, fmtDate, qty, toast, busy, confirmDialog, refresh, emptyState, onceHint, more } from '../ui.js';
import { requestRow, expenseOf } from './requests.js';
import { floatStrip } from './cash.js';
import { reportDialog } from './stock.js';

/** A duty is a role you hold today: your own, or one you are standing in for. The approver can see everything but only approving is theirs. */
const duty = (r) => role() === r || state.standingIn.some((d) => d.role === r);
const OPEN = ['stock_review', 'pending_approval', 'awaiting_disbursement', 'disbursed', 'proof_review', 'physical_required'];
const HOLDER = { stock_review: 'stock_manager', pending_approval: 'approver', awaiting_disbursement: 'finance', proof_review: 'finance', physical_required: 'finance', disbursed: 'people' };

export async function homePage() {
  const me = state.me;
  const staff = isStaff();
  const [openRes, mineRes, cashRes, floatRes, itemsRes, statsRes, outlookRes, reportsRes, inboxRes, checksRes] = await Promise.all([
    staff ? sb.from('requests').select('*, expense:expenses(proof_status, finance_note)').in('status', OPEN).order('submitted_at', { ascending: true }) : { data: [] },
    sb.from('requests').select('*').eq('requester_id', me.id).order('updated_at', { ascending: false }).limit(staff ? 20 : 6),
    sb.from('requests').select('*, expense:expenses(proof_status, finance_note)').eq('status', 'disbursed').eq('disbursed_to', me.id).order('disbursed_at'),
    duty('finance') || duty('approver') ? sb.from('v_floats').select('*').eq('status', 'open').maybeSingle() : { data: null },
    duty('stock_manager') ? sb.from('items').select('id,name,unit,qty_on_hand,reorder_level,recurring').eq('active', true).order('name') : { data: [] },
    duty('stock_manager') ? sb.rpc('item_usage_stats') : { data: [] },
    duty('finance') || duty('approver') ? sb.rpc('float_outlook') : { data: null },
    sb.from('stock_reports').select('id, item_id, level, reported_by, created_at, request_id, item:items(name, unit, qty_on_hand)').is('resolved_at', null).order('created_at', { ascending: false }),
    sb.from('receipt_inbox').select('id, file_name, extracted, created_at').eq('status', 'unfiled').order('created_at', { ascending: false }),
    duty('finance') ? sb.rpc('expense_checks') : { data: [] },
  ]);
  const open = openRes.data || [];
  const checks = {}; for (const c of checksRes.data || []) checks[c.request_id] = c;
  outlookRef.current = outlookRes.data; checksRef.current = checks;
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
  if (duty('approver') && byStatus('pending_approval').length) {
    cards.push(card('Needs your approval', byStatus('pending_approval').length,
      onceHint('approve-inline', 'Approve or reject straight from here; the line under each shows what it leaves in the float. Tap a request for the full picture.'),
      list(byStatus('pending_approval'), approveActions), null, 'purple'));
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
  if (duty('finance')) {
    const payouts = byStatus('awaiting_disbursement');
    if (payouts.length) cards.push(card('To pay out', payouts.length, null, list(payouts, (q) => (q.type === 'claim' ? h('div', { class: 'row-actions' }, h('span', { class: 'note' }, 'Claim – reimburse from the float')) : null))));
    const proofs = byStatus('proof_review');
    if (proofs.length) {
      const matched = proofs.filter((q) => checks[q.id]?.status === 'matches');
      cards.push(card('Receipts to check', proofs.length, null, list(proofs, proofActions), null, null, matched.length > 1 ? confirmAllButton(matched) : null));
    }
    const physical = byStatus('physical_required');
    if (physical.length) cards.push(card('Paper receipts awaited', physical.length, null, list(physical)));
  }
  const n = cards.reduce((s, c) => s + c.n, 0);

  /* ---------------- everything else, in one line ---------------- */
  let elsewhere = null;
  if (staff) {
    const mineHolders = new Set(['approver', 'stock_manager', 'finance'].filter(duty));
    const counts = {};
    for (const q of open) { const hld = HOLDER[q.status]; if (mineHolders.has(hld)) continue; counts[hld] = (counts[hld] || 0) + 1; }
    const label = { approver: 'with the approver', stock_manager: 'with the stock manager', finance: 'with finance', people: 'cash out with people' };
    const statuses = { approver: 'pending_approval', stock_manager: 'stock_review', finance: 'awaiting_disbursement,proof_review,physical_required', people: 'disbursed' };
    const stuck = open.filter((q) => q.status !== 'disbursed' && Date.now() - new Date(q.updated_at) > 48 * 3600e3).length;
    const parts = Object.entries(counts).map(([k, c]) => h('a', { href: `#/requests?status=${statuses[k]}` }, h('strong', {}, c), ` ${label[k]}`));
    const othersReports = !duty('stock_manager') && reports.length ? h('a', { href: '#/stock/reports' }, h('strong', {}, new Set(reports.map((r) => r.item_id)).size), ' stock item' + (new Set(reports.map((r) => r.item_id)).size === 1 ? '' : 's') + ' reported') : null;
    if (parts.length || stuck || othersReports) elsewhere = h('div', { class: 'elsewhere' }, h('span', {}, 'Elsewhere:'), parts, othersReports, stuck ? h('a', { href: '#/requests?view=open', style: { color: 'var(--amber)' } }, h('strong', {}, stuck), ' stuck 2+ days') : null);
  }

  /* ---------------- the float, once ---------------- */
  const floatCard = (duty('finance') || duty('approver')) ? floatSummary(floatRes.data, outlookRes.data) : null;

  /* ---------------- my own requests ---------------- */
  const myReports = reports.filter((r) => r.reported_by === me.id);
  const mine = (mineRes.data || []).filter((q) => (staff ? !['closed', 'rejected', 'cancelled', 'fulfilled_from_stock'].includes(q.status) && q.status !== 'disbursed' : q.status !== 'disbursed'));
  const mineCard = mine.length || !staff ? h('div', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, h('h2', {}, staff ? 'Your open requests' : 'Your requests'), h('a', { href: '#/requests' }, 'All')),
    mine.length ? h('ul', { class: 'ledger-list' }, mine.slice(0, 6).map((q) => requestRow(q))) : emptyState('Nothing yet', 'Snap or upload a receipt to claim money back, or ask for cash.'),
    myReports.length ? h('p', { class: 'hint', style: { marginTop: '10px' } }, `Reported to the stock manager: ${myReports.map((r) => r.item?.name).join(', ')}.`) : null) : null;

  /* ---------------- header ---------------- */
  const actions = [h('a', { class: 'btn btn-primary', href: '#/snap' }, '📷 Snap or upload')];
  if (!can('manage_stock')) actions.push(h('button', { class: 'btn', onclick: () => reportDialog(null) }, 'Report low stock'));
  actions.push(h('a', { class: 'btn', href: '#/requests/new' }, 'Ask for cash'));
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `${greet}, ${(me.full_name || me.email).split(' ')[0]}`),
        h('p', {}, n ? `${n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you.` : 'You are all caught up.')),
      h('div', { class: 'page-actions' }, actions)),
    alertsAsk(),
    floatCard,
    cards.map((c) => c.el),
    staff && !cards.length ? h('div', { class: 'sheet duty-empty' }, h('strong', {}, 'Nothing needs you right now'), 'You will get a buzz when something does.') : null,
    elsewhere,
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
  if (!f) return duty('finance') ? h('div', { class: 'banner banner-amber' }, h('strong', {}, 'No float is open'), 'Nothing can be paid out until this month\'s float is opened. ', h('a', { href: '#/cash' }, 'Open it')) : null;
  const after = o ? Number(o.after_approval) : Number(f.balance);
  const verdict = o ? { ok: ['pill-green', 'Comfortable'], caution: ['pill-amber', 'Tight'], short: ['pill-red', 'Short for the month'], overdrawn: ['pill-red', 'Overcommitted'] }[o.status] : null;
  const cell = (k, v, cls = '') => h('div', {}, h('span', { class: 'k' }, k), h('span', { class: `v ${cls}` }, v));
  return h('div', { class: 'sheet flat' },
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
  const o = outlookRef.current;
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
  const ok = c.status === 'matches' ? h('button', { class: 'btn btn-sm btn-primary' }, 'Confirm & close') : null;
  if (ok) ok.onclick = busy(ok, async (e) => { e.stopPropagation(); await rpc('finance_review_expense', { p_request: q.id, p_action: 'confirm', p_note: 'Matches the scanned receipt' }); toast(`#${q.request_no} closed.`); refresh(); });
  return h('div', { class: 'row-actions', onclick: (e) => e.stopPropagation() }, h('span', { class: `pill check-pill ${tone}`, title: c.note || '' }, label), c.status === 'matches' ? null : h('span', { class: `note${c.status === 'duplicate' ? ' bad' : c.status === 'mismatch' ? ' warn' : ''}` }, c.note || ''), ok);
}
function confirmAllButton(matched) {
  const b = h('button', { class: 'btn btn-sm btn-primary' }, `Confirm ${matched.length} matched`);
  b.onclick = busy(b, async () => { for (const q of matched) await rpc('finance_review_expense', { p_request: q.id, p_action: 'confirm', p_note: 'Matches the scanned receipt' }); toast(`${matched.length} closed.`); refresh(); });
  return b;
}
