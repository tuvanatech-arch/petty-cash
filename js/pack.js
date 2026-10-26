// Month-end pack: one PDF with the reconciliation, every voucher paid from the float, and the scanned receipts.
import { sb, state, personName, unwrap, proofUrl } from './api.js';
import { money, qty, fmtDate, monthLabel, STATUS } from './ui.js';

let jsPDFCtor = null;
async function loadJsPDF() {
  if (jsPDFCtor) return jsPDFCtor;
  const mod = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm');
  jsPDFCtor = mod.jsPDF;
  return jsPDFCtor;
}

/** Fetch a proof and return a JPEG data URL sized for print, or null for PDFs / failures. */
async function proofImage(p) {
  if (!/^image\//.test(p.mime || '')) return null;
  const url = await proofUrl(p.storage_path);
  if (!url) return null;
  try {
    const blob = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return { data: c.toDataURL('image/jpeg', 0.82), w: c.width, h: c.height };
  } catch { return null; }
}

export async function buildMonthEndPack(float, { onProgress = () => {} } = {}) {
  const jsPDF = await loadJsPDF();
  onProgress('Collecting vouchers…');
  const [requests, txs] = await Promise.all([
    unwrap(await sb.from('requests').select('*, expense:expenses(*, lines:expense_lines(*), proofs:expense_proofs(*))').eq('float_id', float.id).order('disbursed_at')),
    unwrap(await sb.from('float_transactions').select('*').eq('float_id', float.id).order('created_at')),
  ]);
  const org = state.settings?.org_name || 'Petty cash';
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 16, LH = 5.2; let y = M;
  const ink = () => doc.setTextColor(25, 35, 31), muted = () => doc.setTextColor(123, 133, 127);
  const newPage = () => { doc.addPage(); y = M; footer(); };
  const need = (hgt) => { if (y + hgt > 297 - M) newPage(); };
  const footer = () => { const n = doc.getNumberOfPages(); doc.setFontSize(8); muted(); doc.text(`${org} · petty cash · ${monthLabel(float.period)} · page ${n}`, M, 297 - 8); ink(); };
  const pdfSafe = (v) => String(v ?? '').replace(/\u2212/g, '-');
  const text = (s, { size = 10, bold = false, x = M, color = null } = {}) => { doc.setFontSize(size); doc.setFont('helvetica', bold ? 'bold' : 'normal'); if (color) doc.setTextColor(...color); else ink(); const lines = doc.splitTextToSize(pdfSafe(s), W - x - M); need(lines.length * LH); doc.text(lines, x, y); y += lines.length * LH; doc.setFont('helvetica', 'normal'); };
  const rule = () => { need(3); doc.setDrawColor(184, 192, 184); doc.line(M, y, W - M, y); y += 3; };
  const table = (cols, rows, { size = 9 } = {}) => {
    // cols: [{label, w, align}] widths in mm; rows: arrays of strings
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

  /* ---- page 1: reconciliation ---- */
  footer();
  text(org, { size: 11, color: [123, 133, 127] });
  text(`Petty cash pack – ${monthLabel(float.period)}`, { size: 18, bold: true });
  text(`${float.status === 'open' ? 'Open float (interim pack)' : `Closed ${fmtDate(float.closed_at)} by ${personName(float.closed_by)}`} · prepared ${fmtDate(new Date().toISOString(), { time: true })} by ${state.me.full_name || state.me.email}`, { size: 9, color: [123, 133, 127] });
  y += 4;
  text('Reconciliation', { size: 13, bold: true }); rule();
  const kv = [
    ['Allocated by finance', money(float.allocated)],
    Number(float.carried_over) > 0 ? ['Carried over from last month', money(float.carried_over)] : null,
    Number(float.topped_up) > 0 ? ['Top-ups', money(float.topped_up)] : null,
    Number(float.returned) > 0 ? ['Returned to finance', `−${money(float.returned)}`] : null,
    ['Spent (receipts recorded)', `−${money(float.spent)}`],
    ['Out with people, not yet accounted for', `−${money(float.outstanding)}`],
    ['Book balance', money(float.balance)],
    float.counted_cash != null ? ['Cash counted at close', money(float.counted_cash)] : null,
    float.counted_cash != null ? ['Difference', money(Number(float.counted_cash) - Number(float.balance), { sign: true })] : null,
  ].filter(Boolean);
  for (const [k, v] of kv) { need(LH); doc.setFontSize(10); const bold = /balance|Difference/.test(k); doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.text(k, M, y); doc.text(pdfSafe(v), W - M, y, { align: 'right' }); doc.setFont('helvetica', 'normal'); y += LH; }
  if (float.notes) { y += 2; text(`Notes: ${float.notes}`, { size: 9 }); }
  y += 5;
  if (txs.length) {
    text('Money in and out of the box', { size: 13, bold: true }); rule();
    table([{ label: 'Date', w: 28 }, { label: 'What', w: 110 }, { label: 'Amount', w: 40, align: 'right' }],
      txs.map((t) => [fmtDate(t.created_at), `${{ allocation: 'Monthly allocation', top_up: 'Top-up', carry_over: 'Carry-over', return: 'Returned to finance' }[t.kind]}${t.note ? ` – ${t.note}` : ''}`, money(t.kind === 'return' ? -t.amount : t.amount, { sign: true })]));
    y += 5;
  }

  /* ---- vouchers ---- */
  const ex = (r) => (Array.isArray(r.expense) ? r.expense[0] : r.expense);
  text('Vouchers', { size: 13, bold: true }); rule();
  if (!requests.length) text('No cash was paid out from this float.', { size: 10, color: [123, 133, 127] });
  else {
    table([{ label: '#', w: 11 }, { label: 'Purpose', w: 55 }, { label: 'Paid to', w: 32 }, { label: 'Paid', w: 22, align: 'right' }, { label: 'Spent', w: 22, align: 'right' }, { label: 'Status', w: 36 }],
      requests.map((r) => { const e = ex(r); return [String(r.request_no), `${r.purpose}${r.type === 'claim' ? ' (claim)' : ''}${r.approved_by ? `\napproved by ${personName(r.approved_by)}` : ''}`, personName(r.disbursed_to), money(r.disbursed_amount), e && Number(e.total) > 0 ? money(e.total) : '—', STATUS[r.status]?.label || r.status]; }));
    y += 2;
    const totPaid = requests.reduce((s, r) => s + Number(r.disbursed_amount || 0), 0);
    const totSpent = requests.reduce((s, r) => s + Number(ex(r)?.total || 0), 0);
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
      const img = await proofImage(p);
      y += 4;
      if (!img) { text(/pdf$/i.test(p.mime || '') ? `${p.file_name} – a PDF, kept in the app rather than embedded here` : `${p.file_name} – could not be embedded; open it in the app`, { size: 9, color: [123, 133, 127] }); continue; }
      const maxW = W - 2 * M, maxH = 297 - M - y - 6;
      let w = maxW, hgt = img.h / img.w * w;
      if (hgt > maxH) { if (maxH < 80) { newPage(); hgt = Math.min(297 - 2 * M - 8, img.h / img.w * w); } else hgt = maxH; w = img.w / img.h * hgt; }
      text(p.file_name, { size: 8, color: [123, 133, 127] });
      doc.addImage(img.data, 'JPEG', M, y, w, hgt); y += hgt + 2;
    }
  }
  onProgress('Saving…');
  const name = `petty-cash-${String(float.period).slice(0, 7)}.pdf`;
  doc.save(name);
  return name;
}
