// The full export for a month: every register as a spreadsheet (CSV) plus the receipt images, in one zip.
// Goes with the month-end pack so the accountant or an auditor has the raw records, not only the PDF.
import { sb, state, personName, proofUrl, branchName } from './api.js';
import { monthLabel, isoDate } from './ui.js';

let zipLib = null;
async function loadZip() { if (!zipLib) zipLib = (await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm')).default; return zipLib; }

const esc = (v) => { if (v === null || v === undefined) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function csv(rows, cols) {
  const keys = cols || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n');
}
const named = (rows, fields) => rows.map((r) => { const o = { ...r }; for (const f of fields) if (o[f]) o[`${f}_name`] = personName(o[f]); return o; });

/** Build the zip for one float and hand it to the browser. */
export async function downloadFullExport(float, onProgress = () => {}) {
  const JSZip = await loadZip();
  const zip = new JSZip();
  const month = String(float.period).slice(0, 7);
  const next = new Date(float.period); next.setMonth(next.getMonth() + 1);
  const from = String(float.period), to = isoDate(next);
  onProgress('Reading the records…');
  const [reqs, ledger, counts, topUps, moves, adjust, receipts, exceptions] = await Promise.all([
    sb.from('requests').select('*, expense:expenses(*, lines:expense_lines(*), proofs:expense_proofs(*))').eq('branch_id', float.branch_id).gte('created_at', from).lt('created_at', to).order('request_no').then((r) => r.data || []),
    sb.rpc('cash_ledger', { p_float: float.id }).then((r) => r.data || []),
    sb.from('cash_counts').select('*').eq('float_id', float.id).order('counted_at').then((r) => r.data || []),
    sb.from('top_ups').select('*').eq('float_id', float.id).order('requested_at').then((r) => r.data || []),
    sb.from('stock_movements').select('*, item:items!inner(name, unit, branch_id)').eq('item.branch_id', float.branch_id).gte('occurred_on', from).lt('occurred_on', to).order('occurred_on').then((r) => r.data || []),
    sb.from('stock_adjustments').select('*, item:items!inner(name, unit, branch_id)').eq('item.branch_id', float.branch_id).gte('requested_at', from).lt('requested_at', to).order('requested_at').then((r) => r.data || []),
    sb.from('stock_receipts').select('*, item:items!inner(name, unit, branch_id)').eq('item.branch_id', float.branch_id).gte('created_at', from).lt('created_at', to).order('created_at').then((r) => r.data || []),
    sb.rpc('exceptions_log', { p_from: from }).then((r) => (r.data || []).filter((x) => x.at < to)),
  ]);
  const folder = zip.folder(`petty-cash-${month}${state.branches.length > 1 ? `-${branchName(float.branch_id).toLowerCase()}` : ''}`);
  const lines = []; const vouchers = [];
  for (const q of reqs) {
    const e = Array.isArray(q.expense) ? q.expense[0] : q.expense;
    vouchers.push({ request_no: q.request_no, type: q.type, status: q.status, purpose: q.purpose, requester: personName(q.requester_id), submitted_at: q.submitted_at, approved_by: q.approved_by ? personName(q.approved_by) : '', approved_at: q.approved_at,
      disbursed_by: q.disbursed_by ? personName(q.disbursed_by) : '', disbursed_to: q.disbursed_to ? personName(q.disbursed_to) : '', disbursed_at: q.disbursed_at, disbursed_amount: q.disbursed_amount, spent: e?.total ?? '', spent_at: e?.spent_at ?? '', change_returned: e?.change_returned ?? '', proof_status: e?.proof_status ?? '',
      over_budget: q.over_budget, review_reason: q.review_reason || '', schedule_version: q.schedule_version, branch: branchName(q.branch_id) });
    for (const l of e?.lines || []) if (!l.void) lines.push({ request_no: q.request_no, spent_at: e.spent_at, description: l.description, qty: l.qty, unit_price: l.unit_price, line_total: l.line_total, supplier: l.supplier_name || '', item_id: l.item_id || '' });
  }
  folder.file('vouchers.csv', csv(vouchers));
  folder.file('expense-lines.csv', csv(lines));
  folder.file('cash-ledger.csv', csv(ledger));
  folder.file('cash-counts.csv', csv(named(counts, ['counted_by', 'reviewed_by'])));
  folder.file('top-ups.csv', csv(named(topUps, ['requested_by', 'decided_by', 'received_by'])));
  folder.file('stock-movements.csv', csv(moves.map((m) => ({ occurred_on: m.occurred_on, item: m.item?.name, unit: m.item?.unit, kind: m.kind, delta: m.delta, unit_cost: m.unit_cost, issued_to: m.issued_to ? personName(m.issued_to) : '', by: personName(m.created_by), note: m.note, request_id: m.request_id || '', void: m.void }))));
  folder.file('stock-corrections.csv', csv(adjust.map((a) => ({ requested_at: a.requested_at, item: a.item?.name, kind: a.kind, qty_before: a.qty_before, qty_after: a.qty_after, delta: a.delta, value: a.value, limit_at: a.limit_at, reason: a.reason, status: a.status, requested_by: personName(a.requested_by), decided_by: a.decided_by ? personName(a.decided_by) : '', decided_at: a.decided_at, decision_note: a.decision_note }))));
  folder.file('deliveries.csv', csv(receipts.map((r) => ({ created_at: r.created_at, item: r.item?.name, qty_bought: r.qty_bought, unit_cost: r.unit_cost, bought_by: personName(r.bought_by), qty_received: r.qty_received, status: r.status, checked_by: r.checked_by ? personName(r.checked_by) : '', checked_at: r.checked_at, note: r.note }))));
  folder.file('exceptions.csv', csv(exceptions.map((x) => ({ at: x.at, kind: x.kind, title: x.title, detail: x.detail, who: x.who ? personName(x.who) : '', amount: x.amount, state: x.state, reviewed_by: x.by_whom ? personName(x.by_whom) : '', reviewed_at: x.at2, note: x.note, outcome: x.outcome }))));
  folder.file('README.txt', `Petty cash full export – ${monthLabel(float.period)}${state.branches.length > 1 ? ` – ${branchName(float.branch_id)}` : ''}\nMade ${new Date().toISOString()} by ${state.me.full_name || state.me.email} from ${state.settings?.org_name || 'the app'}.\n\nvouchers.csv        every request of the month with who asked, approved and paid, and what was spent\nexpense-lines.csv   each line of each receipt\ncash-ledger.csv     every movement of cash with the running balance\ncash-counts.csv     counts of the box and the GM's sign-off\ntop-ups.csv         top-ups requested, authorised and received\nstock-movements.csv purchases in, issues out, usage, corrections\nstock-corrections.csv  count differences, corrections and short deliveries, with approvals\ndeliveries.csv      goods bought for the store against what arrived\nexceptions.csv      the approval and exception log for the month\nreceipts/           the receipt images, named by voucher number\n`);
  // the receipts
  const proofs = []; for (const q of reqs) { const e = Array.isArray(q.expense) ? q.expense[0] : q.expense; for (const p of e?.proofs || []) proofs.push({ q, p }); }
  let n = 0;
  for (const { q, p } of proofs) {
    n += 1; onProgress(`Receipts ${n} of ${proofs.length}…`);
    try {
      const url = await proofUrl(p.storage_path); if (!url) continue;
      const res = await fetch(url); if (!res.ok) continue;
      const ext = (p.file_name || p.storage_path).split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      folder.file(`receipts/${q.request_no}-${String(n).padStart(2, '0')}.${ext}`, await res.arrayBuffer());
    } catch { /* a missing image is noted in the PDF pack; the export carries on */ }
  }
  onProgress('Packing…');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `petty-cash-${month}-export.zip`; document.body.append(a); a.click(); a.remove();
  onProgress('');
  return { files: Object.keys(folder.files || {}).length, receipts: proofs.length };
}
