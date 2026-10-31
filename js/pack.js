// Month-end pack: one PDF with the reconciliation, a one-page monthly summary, every voucher paid from the float,
// and the receipts (photos embedded, PDF invoices merged in as pages).
import { sb, state, personName, unwrap, proofUrl, multiBranch, branchName } from './api.js';
import { money, qty, fmtDate, monthLabel, STATUS, isoDate } from './ui.js';
import { drawSchedule } from './schedule-pdf.js';

let jsPDFCtor = null; let pdfLib = null;
async function loadJsPDF() { if (!jsPDFCtor) jsPDFCtor = (await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm')).jsPDF; return jsPDFCtor; }
async function loadPdfLib() { if (!pdfLib) pdfLib = await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm'); return pdfLib; }

/** Fetch a proof: a JPEG data URL sized for print for images, raw bytes for PDFs, null on failure. */
async function fetchProof(p) {
  const url = await proofUrl(p.storage_path);
  if (!url) return null;
  try {
    const blob = await (await fetch(url)).blob();
    if (/pdf$/i.test(p.mime || '')) return { pdf: await blob.arrayBuffer() };
    if (!/^image\//.test(p.mime || '')) return null;
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return { data: c.toDataURL('image/jpeg', 0.82), w: c.width, h: c.height };
  } catch { return null; }
}

const monthKey = (d) => String(d).slice(0, 7);
function monthsAround(period) { const p = new Date(String(period).slice(0, 10) + 'T00:00:00'); return [2, 1, 0].map((i) => isoDate(new Date(p.getFullYear(), p.getMonth() - i, 1)).slice(0, 7)); }

/** Everything the summary page and the accountant's email need, as plain numbers. */
export async function packSummary(float, requests) {
  const months = monthsAround(float.period);
  const from = months[0] + '-01';
  const next = new Date(String(float.period).slice(0, 10) + 'T00:00:00'); next.setMonth(next.getMonth() + 1);
  const [lines, raised, budgets, cats] = await Promise.all([
    unwrap(await sb.from('v_spend_lines').select('*').gte('spent_at', from).lt('spent_at', isoDate(next))),
    unwrap(await sb.from('requests').select('id, type, status, estimated_total, approval_required, approved_by, for_store, disbursed_amount').eq('branch_id', float.branch_id).gte('submitted_at', float.period).lt('submitted_at', isoDate(next))),
    unwrap(await sb.from('budgets').select('category_id, person_id, monthly_limit').eq('active', true)),
    unwrap(await sb.from('categories').select('id, name')),
  ]);
  const cur = months[2];
  const byMonth = Object.fromEntries(months.map((m) => [m, { spent: 0, vouchers: new Set() }]));
  for (const l of lines) { const k = monthKey(l.spent_at); if (byMonth[k]) { byMonth[k].spent += Number(l.line_total); byMonth[k].vouchers.add(l.request_id); } }
  const byCat = {}; const byCatPrev = {};
  for (const l of lines) { const k = monthKey(l.spent_at); if (k === cur) byCat[l.category_name] = (byCat[l.category_name] || 0) + Number(l.line_total); if (k === months[1]) byCatPrev[l.category_name] = (byCatPrev[l.category_name] || 0) + Number(l.line_total); }
  const top = {}; for (const l of lines) if (monthKey(l.spent_at) === cur) top[l.description] = (top[l.description] || 0) + Number(l.line_total);
  const ex = (r) => (Array.isArray(r.expense) ? r.expense[0] : r.expense);
  const vouchers = requests.length;
  const missing = requests.filter((r) => !(ex(r)?.proofs || []).length).length;
  const physical = requests.filter((r) => ex(r)?.physical_received_at).length;
  const catName = (id) => cats.find((c) => c.id === id)?.name || '—';
  return {
    period: float.period, allocated: Number(float.allocated), topped_up: Number(float.topped_up), carried_over: Number(float.carried_over), returned: Number(float.returned),
    spent: Number(float.spent), outstanding: Number(float.outstanding), balance: Number(float.balance), counted_cash: float.counted_cash != null ? Number(float.counted_cash) : null,
    adjusted: Number(float.adjusted || 0),
    vouchers, missing_proofs: missing, physical_receipts: physical,
    months: months.map((m) => ({ month: m, spent: Math.round(byMonth[m].spent * 100) / 100, vouchers: byMonth[m].vouchers.size })),
    by_category: Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([name, v]) => ({ name, amount: Math.round(v * 100) / 100, previous: Math.round((byCatPrev[name] || 0) * 100) / 100 })),
    top_lines: Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, v]) => ({ name, amount: Math.round(v * 100) / 100 })),
    requests: { raised: raised.length, approved: raised.filter((r) => r.approved_by).length, approved_amount: Math.round(raised.filter((r) => r.approved_by).reduce((s, r) => s + Number(r.estimated_total), 0) * 100) / 100,
      rejected: raised.filter((r) => r.status === 'rejected').length, claims: raised.filter((r) => r.type === 'claim').length, restock_orders: raised.filter((r) => r.for_store).length },
    budgets: budgets.filter((b) => b.category_id).map((b) => ({ name: catName(b.category_id), limit: Number(b.monthly_limit), used: Math.round((byCat[catName(b.category_id)] || 0) * 100) / 100 })),
  };
}

export async function buildMonthEndPack(float, { onProgress = () => {}, save = true } = {}) {
  onProgress('Collecting vouchers…');
  const [requests, ledger, counts, mgmt] = await Promise.all([
    unwrap(await sb.from('requests').select('*, expense:expenses(*, lines:expense_lines(*), proofs:expense_proofs(*))').eq('float_id', float.id).order('disbursed_at')),
    unwrap(await sb.rpc('cash_ledger', { p_float: float.id })) || [],
    unwrap(await sb.from('cash_counts').select('*').eq('float_id', float.id).order('counted_at')) || [],
    sb.rpc('management_summary', { p_month: float.period }).then((r) => r.data || null).catch(() => null),   // as the builder sees it (their branch view)
  ]);
  const summary = await packSummary(float, requests);
  const org = state.settings?.org_name || 'Petty cash';
  const jsPDF = await loadJsPDF();
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 16, LH = 5.2; let y = M;
  const pdfInserts = []; // { afterPage, bytes } – PDF invoices merged in after the voucher page
  const ink = () => doc.setTextColor(25, 35, 31), muted = () => doc.setTextColor(123, 133, 127);
  const footer = () => { doc.setFontSize(8); muted(); doc.text(`${org} · petty cash · ${monthLabel(float.period)} · produced with Petti by Tuvana Tech`, M, 297 - 8); ink(); };
  const newPage = () => { doc.addPage(); y = M; footer(); };
  const need = (hgt) => { if (y + hgt > 297 - M) newPage(); };
  const pdfSafe = (v) => String(v ?? '').replace(/−/g, '-').replace(/→/g, '->').replace(/·/g, '-');
  const text = (s, { size = 10, bold = false, x = M, color = null } = {}) => { doc.setFontSize(size); doc.setFont('helvetica', bold ? 'bold' : 'normal'); if (color) doc.setTextColor(...color); else ink(); const lines = doc.splitTextToSize(pdfSafe(s), W - x - M); need(lines.length * LH); doc.text(lines, x, y); y += lines.length * LH; doc.setFont('helvetica', 'normal'); };
  const rule = () => { need(3); doc.setDrawColor(184, 192, 184); doc.line(M, y, W - M, y); y += 3; };
  const heading = (s) => { text(s, { size: 13, bold: true }); rule(); };
  const table = (cols, rows, { size = 9 } = {}) => {
    doc.setFontSize(size);
    const rowH = LH;
    const pad = (i) => (i > 0 && cols[i - 1].align === 'right' && cols[i].align !== 'right' ? 3 : 0);
    const put = (v, i, x) => doc.text(v, cols[i].align === 'right' ? x + cols[i].w : x + pad(i), y, { align: cols[i].align === 'right' ? 'right' : 'left' });
    const head = () => { need(rowH + 2); doc.setFont('helvetica', 'bold'); let x = M; cols.forEach((c, i) => { put(c.label, i, x); x += c.w; }); doc.setFont('helvetica', 'normal'); y += 1.5; doc.setDrawColor(25, 35, 31); doc.line(M, y, W - M, y); y += rowH - 1; };
    head();
    for (const r of rows) {
      const wrapped = r.map((v, i) => doc.splitTextToSize(pdfSafe(v), cols[i].w - 2 - pad(i)));
      const hgt = Math.max(...wrapped.map((w) => w.length)) * (rowH - 0.8);
      if (y + hgt > 297 - M) { newPage(); doc.setFontSize(size); head(); }
      let x = M;
      wrapped.forEach((w, i) => { put(w, i, x); x += cols[i].w; });
      y += hgt; doc.setDrawColor(214, 219, 212); doc.line(M, y - 1.5, W - M, y - 1.5); y += 1;
    }
  };
  const kvRows = (rows) => { for (const [k, v, bold] of rows) { need(LH); doc.setFontSize(10); doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.text(k, M, y); doc.text(pdfSafe(v), W - M, y, { align: 'right' }); doc.setFont('helvetica', 'normal'); y += LH; } };

  /* ---- page 1: the management summary (six questions) and the KPIs ---- */
  footer();
  text(org, { size: 11, color: [123, 133, 127] });
  text(`Petty cash pack – ${monthLabel(float.period)}${multiBranch() ? ` – ${branchName(float.branch_id)}` : ''}`, { size: 18, bold: true });
  text(`${float.status === 'open' ? 'Open float (interim pack)' : `Closed ${fmtDate(float.closed_at)} by ${personName(float.closed_by)}`} · prepared ${fmtDate(new Date().toISOString(), { time: true })} by ${state.me.full_name || state.me.email}`, { size: 9, color: [123, 133, 127] });
  y += 4;
  if (mgmt) {
    heading('Management summary');
    const prevD = Number(mgmt.prev) > 0 ? Math.round((Number(mgmt.spent) - Number(mgmt.prev)) / Number(mgmt.prev) * 100) : null;
    text(`1. Spent ${money(mgmt.spent)} on ${mgmt.requests} request${Number(mgmt.requests) === 1 ? '' : 's'}${prevD != null ? ` (${prevD > 0 ? '+' : ''}${prevD}% on last month)` : ''}${Number(mgmt.avg6) > 0 ? `; a usual month is ${money(mgmt.avg6)}` : ''}.`);
    text(`2. On: ${(mgmt.categories || []).slice(0, 5).map((c) => `${c.name} ${money(c.amount)} (${c.share}%)`).join(', ') || 'nothing recorded'}.`);
    const bud = mgmt.budgets || [];
    text(`3. Against budget: ${bud.length ? bud.map((b) => `${b.label} ${money(b.used)} of ${money(b.limit)}${b.over ? ' – OVER' : ''}`).join('; ') : 'no budgets set'}.`);
    const bx = (mgmt.boxes || [])[0];
    text(`4. Funds and receipts: ${bx ? `${money(bx.funds)} in, ${money(bx.spent)} spent, ${money(bx.balance)} on the book${bx.counted != null ? `, ${money(bx.counted)} counted` : ''}; ${Number(bx.missing_receipts) ? `${bx.missing_receipts} receipt(s) outstanding` : 'every receipt in'}; ${bx.signed_off} of ${bx.counts} count(s) signed off by the GM` : 'no float'}.`);
    const ex = mgmt.exceptions || [];
    text(`5. Irregularities: ${ex.length ? `${ex.length} logged (${Number(mgmt.open_exceptions)} open): ` + ex.slice(0, 6).map((x) => `${x.title}${x.amount != null ? ` ${money(x.amount)}` : ''}${x.state === 'open' ? ' [open]' : ''}`).join('; ') : 'none recorded'}.`);
    const sv = mgmt.savings || [];
    text(`6. Where costs could fall: ${sv.length ? sv.map((x) => x.text).join('; ') : 'nothing stands out'}.`);
    y += 3;
    heading('KPIs');
    for (const k of mgmt.kpis || []) text(`${k.id} ${k.label}: ${k.value} – ${k.text}`, { size: 9.5 });
    y += 4;
  }
  heading('Reconciliation');
  kvRows([
    ['Allocated by finance', money(float.allocated)],
    Number(float.carried_over) > 0 ? ['Carried over from last month', money(float.carried_over)] : null,
    Number(float.topped_up) > 0 ? ['Top-ups', money(float.topped_up)] : null,
    Number(float.returned) > 0 ? ['Returned to finance', `-${money(float.returned)}`] : null,
    ['Spent (receipts recorded)', `-${money(float.spent)}`],
    Number(float.adjusted || 0) < 0 ? ['Cash short at a count, written off by the GM', money(float.adjusted)] : null,
    Number(float.adjusted || 0) > 0 ? ['Cash over at a count, taken in by the GM', `+${money(float.adjusted)}`] : null,
    Number(float.outstanding) > 0 ? ['Out with people, not yet accounted for', `-${money(float.outstanding)}`] : null,
    ['Book balance', money(float.balance), true],
    float.counted_cash != null ? ['Cash counted at close', money(float.counted_cash)] : null,
    float.counted_cash != null ? ['Difference', money(Number(float.counted_cash) - Number(float.balance), { sign: true }), true] : null,
  ].filter(Boolean));
  if (float.notes) { y += 2; text(`Notes: ${float.notes}`, { size: 9 }); }
  y += 5;
  const shown = counts.filter((c) => c.status !== 'superseded');
  if (shown.length) {
    heading('Cash counts and sign-off');
    const st = { to_review: 'waiting for the GM', queried: 'GM has a question', accepted: 'signed off' };
    table([{ label: 'Counted', w: 30 }, { label: 'By', w: 30 }, { label: 'Book', w: 22, align: 'right' }, { label: 'Cash', w: 22, align: 'right' }, { label: 'Difference', w: 22, align: 'right' }, { label: 'Sign-off', w: 52 }],
      shown.map((c) => [`${fmtDate(c.counted_at)}${c.kind === 'month_end' ? ' (month-end)' : ''}`, personName(c.counted_by), money(c.expected), money(c.counted), money(c.difference, { sign: true }),
        `${c.status === 'accepted' ? `${personName(c.reviewed_by)}, ${fmtDate(c.reviewed_at)}` : st[c.status] || c.status}${c.note ? `\nfinance: ${c.note}` : ''}${c.review_note ? `\nGM: ${c.review_note}` : ''}${c.written_off != null ? `\n${money(Math.abs(c.written_off))} written off` : ''}`]), { size: 8.5 });
    y += 5;
  }

  /* ---- the petty cash ledger: every movement of cash, with a running balance ---- */
  if (ledger.length) {
    newPage();
    heading('Petty cash ledger');
    table([{ label: 'Date', w: 22 }, { label: 'Ref', w: 14 }, { label: 'What', w: 86 }, { label: 'In', w: 18, align: 'right' }, { label: 'Out', w: 18, align: 'right' }, { label: 'Balance', w: 20, align: 'right' }],
      ledger.map((r) => [fmtDate(r.at), r.ref || '', `${r.description}${r.person && r.request_id ? ` – ${personName(r.person)}` : ''}`, Number(r.cash_in) ? money(r.cash_in) : '', Number(r.cash_out) ? money(r.cash_out) : '', money(r.balance)]), { size: 8 });
    y += 5;
  }

  /* ---- page 2: monthly summary ---- */
  newPage();
  heading('Monthly summary');
  const s = summary;
  const mName = (k) => monthLabel(k + '-01');
  text('Spending against the previous two months', { size: 10, bold: true }); y += 1;
  table([{ label: 'Month', w: 70 }, { label: 'Vouchers', w: 40, align: 'right' }, { label: 'Spent', w: 68, align: 'right' }],
    s.months.map((m, i) => [mName(m.month) + (i === 2 ? ' (this pack)' : ''), String(m.vouchers), money(m.spent)]));
  y += 4;
  if (s.by_category.length) {
    text('By category', { size: 10, bold: true }); y += 1;
    const tot = s.by_category.reduce((a, c) => a + c.amount, 0) || 1;
    table([{ label: 'Category', w: 78 }, { label: 'This month', w: 34, align: 'right' }, { label: 'Share', w: 22, align: 'right' }, { label: 'Last month', w: 44, align: 'right' }],
      s.by_category.map((c) => [c.name, money(c.amount), `${Math.round(c.amount / tot * 100)}%`, c.previous ? money(c.previous) : '—']));
    y += 4;
  }
  if (s.budgets.length) {
    text('Budgets', { size: 10, bold: true }); y += 1;
    table([{ label: 'Budget', w: 78 }, { label: 'Used', w: 34, align: 'right' }, { label: 'Limit', w: 34, align: 'right' }, { label: 'Status', w: 32 }],
      s.budgets.map((b) => [b.name, money(b.used), money(b.limit), b.used > b.limit ? `over by ${money(b.used - b.limit)}` : 'within']));
    y += 4;
  }
  text('Requests and controls', { size: 10, bold: true }); y += 1;
  kvRows([
    ['Requests raised in the month', String(s.requests.raised)],
    [`Went through the approver (above ${money(state.settings?.approval_threshold)} or over budget)`, `${s.requests.approved} · ${money(s.requests.approved_amount)}`],
    ['Rejected', String(s.requests.rejected)],
    ['Claims reimbursed from the float', String(s.requests.claims)],
    ['Restock orders by the stock manager', String(s.requests.restock_orders)],
    ['Vouchers in this pack', String(s.vouchers)],
    ['Vouchers without a scanned receipt', String(s.missing_proofs)],
    ['Paper originals handed to finance', String(s.physical_receipts)],
  ]);
  if (s.top_lines.length) {
    y += 4; text('Largest items', { size: 10, bold: true }); y += 1;
    table([{ label: 'Item', w: 130 }, { label: 'Amount', w: 48, align: 'right' }], s.top_lines.map((t) => [t.name, money(t.amount)]));
  }

  /* ---- the authority schedule in force for the month, and any change to it during the month ---- */
  onProgress('Adding the authority schedule…');
  const monthEnd = new Date(String(float.period).slice(0, 10) + 'T00:00:00'); monthEnd.setMonth(monthEnd.getMonth() + 1);
  const until = new Date(Math.min(monthEnd.getTime(), float.closed_at ? new Date(float.closed_at).getTime() : Date.now()));
  const versions = unwrap(await sb.from('schedule_versions').select('*').eq('status', 'applied').order('version_no', { ascending: false })) || [];
  const inForce = versions.find((v) => new Date(v.effective_at) <= until) || versions[versions.length - 1];
  if (inForce?.snapshot) {
    const monthChanges = versions.filter((v) => new Date(v.effective_at) >= new Date(String(float.period).slice(0, 10) + 'T00:00:00') && new Date(v.effective_at) <= until).reverse();
    drawSchedule(doc, inForce, { inPack: true, monthChanges });
  }

  /* ---- vouchers list ---- */
  newPage();
  const ex = (r) => (Array.isArray(r.expense) ? r.expense[0] : r.expense);
  heading('Vouchers');
  if (!requests.length) text('No cash was paid out from this float.', { size: 10, color: [123, 133, 127] });
  else {
    table([{ label: '#', w: 11 }, { label: 'Purpose', w: 55 }, { label: 'Paid to', w: 32 }, { label: 'Paid', w: 22, align: 'right' }, { label: 'Spent', w: 22, align: 'right' }, { label: 'Status', w: 36 }],
      requests.map((r) => { const e = ex(r); return [String(r.request_no), `${r.purpose}${r.type === 'claim' ? ' (claim)' : ''}${r.approved_by ? `\napproved by ${personName(r.approved_by)}` : ''}`, personName(r.disbursed_to), money(r.disbursed_amount), e && Number(e.total) > 0 ? money(e.total) : '—', STATUS[r.status]?.label || r.status]; }));
    y += 2;
    const totPaid = requests.reduce((a, r) => a + Number(r.disbursed_amount || 0), 0);
    const totSpent = requests.reduce((a, r) => a + Number(ex(r)?.total || 0), 0);
    doc.setFontSize(10); doc.setFont('helvetica', 'bold'); need(LH); doc.text(`Paid out ${money(totPaid)} · receipts ${money(totSpent)}`, W - M, y, { align: 'right' }); doc.setFont('helvetica', 'normal'); y += LH;
  }

  /* ---- one page per voucher with its receipt(s) ---- */
  let i = 0;
  for (const r of requests) {
    const e = ex(r); i++;
    onProgress(`Adding receipts ${i} of ${requests.length}…`);
    newPage();
    text(`Voucher #${r.request_no} · ${r.purpose}`, { size: 13, bold: true }); rule();
    const details = [
      ['Type', r.type === 'claim' ? 'Claim (paid from own pocket)' : r.type === 'stock' ? (r.for_store ? 'Restock order' : 'Stock request') : 'Cash request'],
      ['Requested by', `${personName(r.requester_id)} on ${fmtDate(r.submitted_at || r.created_at)}`],
      r.stock_reviewed_by ? ['Stock review', `${personName(r.stock_reviewed_by)}, ${fmtDate(r.stock_reviewed_at)}${r.stock_note ? ` – ${r.stock_note}` : ''}`] : null,
      r.approved_by ? ['Approved', `${personName(r.approved_by)}, ${fmtDate(r.approved_at)}${r.approval_note ? ` – ${r.approval_note}` : ''}`] : null,
      r.schedule_version ? ['Schedule', `${state.settings?.schedule_ref || 'MGP-SCH-PC-001'} version ${r.schedule_version}`] : null,
      [r.type === 'claim' ? 'Reimbursed' : 'Cash paid', `${money(r.disbursed_amount)} to ${personName(r.disbursed_to)} by ${personName(r.disbursed_by)}, ${fmtDate(r.disbursed_at)}`],
      e && Number(e.total) > 0 ? ['Spent', `${money(e.total)} on ${fmtDate(e.spent_at)}${e.supplier_name ? ` at ${e.supplier_name}` : ''}${r.type !== 'claim' ? ` · change ${money(e.change_returned)}` : ''}`] : ['Spent', 'Not yet recorded'],
      e?.confirmed_by ? ['Receipt confirmed', `${personName(e.confirmed_by)}, ${fmtDate(e.confirmed_at)}${e.physical_received_at ? ` · paper original received ${fmtDate(e.physical_received_at)}` : ''}`] : null,
      e?.notes ? ['Notes', e.notes] : null,
    ].filter(Boolean);
    for (const [k, v] of details) { doc.setFontSize(9); need(LH); muted(); doc.text(k, M, y); ink(); const lines = doc.splitTextToSize(pdfSafe(v), W - M - 42); doc.text(lines, M + 42, y); y += lines.length * LH; }
    const lines = (e?.lines || []).filter((l) => !l.void);
    if (lines.length) {
      y += 3;
      table([{ label: 'Line', w: 86 }, { label: 'Supplier', w: 40 }, { label: 'Qty', w: 14, align: 'right' }, { label: 'Unit', w: 19, align: 'right' }, { label: 'Total', w: 19, align: 'right' }],
        lines.map((l) => [l.description, l.supplier_name || '', qty(l.qty), money(l.unit_price), money(l.line_total)]), { size: 8.5 });
    }
    const proofs = e?.proofs || [];
    if (!proofs.length) { y += 3; text('No scanned proof uploaded.', { size: 9, color: [167, 84, 26] }); continue; }
    for (const p of proofs) {
      const got = await fetchProof(p);
      y += 4;
      if (got?.pdf) { text(`${p.file_name} – follows on the next page`, { size: 8, color: [123, 133, 127] }); pdfInserts.push({ afterPage: doc.getNumberOfPages(), bytes: got.pdf, name: p.file_name }); continue; }
      if (!got) { text(`${p.file_name} – could not be embedded; open it in the app`, { size: 9, color: [123, 133, 127] }); continue; }
      const maxW = W - 2 * M, maxH = 297 - M - y - 6;
      let w = maxW, hgt = got.h / got.w * w;
      if (hgt > maxH) { if (maxH < 80) { newPage(); hgt = Math.min(297 - 2 * M - 8, got.h / got.w * w); } else hgt = maxH; w = got.w / got.h * hgt; }
      text(p.file_name, { size: 8, color: [123, 133, 127] });
      doc.addImage(got.data, 'JPEG', M, y, w, hgt); y += hgt + 2;
    }
  }

  /* ---- merge PDF invoices in, number the pages ---- */
  onProgress('Assembling the PDF…');
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const out = await PDFDocument.create();
  const base = await PDFDocument.load(doc.output('arraybuffer'));
  const basePages = await out.copyPages(base, base.getPageIndices());
  for (let n = 0; n < basePages.length; n++) {
    out.addPage(basePages[n]);
    for (const ins of pdfInserts.filter((x) => x.afterPage === n + 1)) {
      try { const d = await PDFDocument.load(ins.bytes, { ignoreEncryption: true }); (await out.copyPages(d, d.getPageIndices())).forEach((pg) => out.addPage(pg)); }
      catch { /* an unreadable PDF is skipped; the voucher page says where it lives */ }
    }
  }
  const font = await out.embedFont(StandardFonts.Helvetica);
  const total = out.getPageCount();
  out.getPages().forEach((pg, n) => { const { width } = pg.getSize(); const label = `page ${n + 1} of ${total}`; pg.drawText(label, { x: width - 45.4 - font.widthOfTextAtSize(label, 8), y: 22.7, size: 8, font, color: rgb(0.48, 0.52, 0.5) }); });
  out.setTitle(`Petty cash pack – ${monthLabel(float.period)} – ${org}`);
  const bytes = await out.save();
  const name = `petty-cash-${String(float.period).slice(0, 7)}.pdf`;
  if (save) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); a.download = name;
    document.body.append(a); a.click(); a.remove();
  }
  return { bytes, name, pages: total, summary };
}
