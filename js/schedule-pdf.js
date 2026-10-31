// MGP-SCH-PC-001 as a PDF, drawn from a recorded schedule version – so the printed schedule and the app never disagree.
// Used on its own (Download PDF) and inside the month-end pack.
import { state, personName } from './api.js';
import { money } from './ui.js';
import { ITEMS, SECTIONS, AREA_LABEL, POSITIONS, fmtValue, versionStatus, changeText } from './schedule-meta.js';

let jsPDFCtor = null;
async function loadJsPDF() { if (!jsPDFCtor) jsPDFCtor = (await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm')).jsPDF; return jsPDFCtor; }

// a printed schedule always carries the year
const dateY = (d, time = false) => { if (!d) return '—'; const x = new Date(d); return x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + (time ? ', ' + x.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''); };
const dayY = (s) => (s ? dateY(String(s).slice(0, 10) + 'T00:00:00') : '—');
// the built-in PDF fonts have no arrow or minus sign
const pdfSafe = (s) => String(s ?? '').replace(/→/g, '->').replace(/−/g, '-');

/** Draw version v of the schedule into a jsPDF document. In a pack it starts on a new page. */
export function drawSchedule(doc, v, { inPack = false, monthChanges = [] } = {}) {
  const snap = v.snapshot || {}; const val = snap.values || {};
  const org = state.settings?.org_name || 'Petty cash';
  const ref = val.schedule_ref || 'MGP-SCH-PC-001';
  const W = 210, M = 16, LH = 5.2; let y = M;
  const ink = () => doc.setTextColor(25, 35, 31), muted = () => doc.setTextColor(123, 133, 127);
  const footer = () => { doc.setFontSize(8); muted(); doc.text(pdfSafe(`${ref} version ${v.version_no} · in force from ${dateY(v.effective_at)} · printed from Petti (Tuvana Tech), which holds the master copy`), M, 297 - 8); ink(); };
  const newPage = () => { doc.addPage(); y = M; footer(); };
  const need = (hgt) => { if (y + hgt > 297 - M) newPage(); };
  const text = (s, { size = 10, bold = false, color = null, x = M } = {}) => {
    doc.setFontSize(size); doc.setFont('helvetica', bold ? 'bold' : 'normal'); if (color) doc.setTextColor(...color); else ink();
    const lines = doc.splitTextToSize(pdfSafe(s), W - x - M); need(lines.length * LH); doc.text(lines, x, y); y += lines.length * LH; doc.setFont('helvetica', 'normal'); ink();
  };
  const rule = () => { need(3); doc.setDrawColor(184, 192, 184); doc.line(M, y, W - M, y); y += 3; };
  const heading = (s, sub = null) => { y += 3; need(14); text(s, { size: 12.5, bold: true }); if (sub) text(sub, { size: 8.5, color: [123, 133, 127] }); rule(); };
  const table = (cols, rows, { size = 9 } = {}) => {
    doc.setFontSize(size);
    const head = () => { need(LH + 2); doc.setFont('helvetica', 'bold'); let x = M; cols.forEach((c) => { doc.text(c.label, x, y); x += c.w; }); doc.setFont('helvetica', 'normal'); y += 1.5; doc.setDrawColor(25, 35, 31); doc.line(M, y, W - M, y); y += LH - 1; };
    head();
    for (const r of rows) {
      const wrapped = r.map((c, i) => doc.splitTextToSize(pdfSafe(c), cols[i].w - 3));
      const hgt = Math.max(...wrapped.map((w) => w.length)) * (LH - 0.8);
      if (y + hgt > 297 - M) { newPage(); doc.setFontSize(size); head(); }
      let x = M; wrapped.forEach((w, i) => { doc.text(w, x, y); x += cols[i].w; });
      y += hgt; doc.setDrawColor(214, 219, 212); doc.line(M, y - 1.5, W - M, y - 1.5); y += 1;
    }
  };
  const kv = (rows) => { for (const [k, s] of rows) { doc.setFontSize(9.5); const lines = doc.splitTextToSize(pdfSafe(s), W - 2 * M - 38); need(lines.length * LH); muted(); doc.text(k, M, y); ink(); doc.text(lines, M + 38, y); y += lines.length * LH; } };

  if (inPack) newPage(); else footer();
  text(org, { size: 11, color: [123, 133, 127] }); y += 1.5;
  text('Authority schedule – petty cash', { size: 18, bold: true });
  text(`${ref} · version ${v.version_no} · in force from ${dateY(v.effective_at, true)}`, { size: 11 });
  y += 2;
  const st = versionStatus(v);
  kv([
    ['Issued under', `${val.policy_ref || 'MGP-POL-PC-001'}${val.policy_url ? ` – ${val.policy_url}` : ''}`],
    ['This version', `${AREA_LABEL[v.area] || ''} · changed by ${personName(v.proposed_by)}${v.reason ? ` – “${v.reason}”` : ''}`],
    ['Approval', v.md_status === 'no_md' ? 'Applied before a Managing Director was set up in the app; kept for the MD to review' : st.text || '—'],
  ]);

  heading('Approval authority by position', 'Every request is approved by the position its amount needs; nobody approves, pays out or confirms their own spending.');
  const held = Object.fromEntries((snap.positions || []).map((p) => [p.role, (p.holders || []).join(', ')]));
  table([{ label: 'Position', w: 52 }, { label: 'Held by', w: 42 }, { label: 'Authority', w: 84 }],
    POSITIONS.map((p) => [p.label, held[p.role] || 'Not set up', p.duty(val)]));

  for (const sec of SECTIONS) {
    heading(sec.title, sec.md ? 'Changes take effect only once the Managing Director approves them.' : 'Changes take effect at once; the Managing Director is told.');
    table([{ label: 'Item', w: 78 }, { label: 'Setting', w: 100 }], sec.keys.map((k) => [ITEMS[k].label, fmtValue(k, val[k])]));
  }

  heading('Monthly budgets', 'Counted against cash paid out and claims reimbursed in the calendar month. Changes take effect at once; the MD is told.');
  const budgets = snap.budgets || [];
  if (budgets.length) table([{ label: 'Budget', w: 90 }, { label: 'For', w: 30 }, { label: 'Monthly limit', w: 34 }, { label: 'Status', w: 24 }],
    budgets.map((b) => [b.label + (b.note ? ` – ${b.note}` : ''), b.scope === 'person' ? 'Person' : 'Category', money(b.monthly_limit), b.active ? 'On' : 'Off']));
  else text('No budgets set.', { size: 9, color: [123, 133, 127] });

  heading('Stand-ins', 'A stand-in acts under their own name and never approves their own request. Only the Managing Director names the MD’s stand-in.');
  const sis = snap.standins || [];
  if (sis.length) table([{ label: 'Away', w: 44 }, { label: 'Covered by', w: 44 }, { label: 'Position', w: 44 }, { label: 'Period', w: 46 }],
    sis.map((x) => [x.away, x.covers, (POSITIONS.find((p) => p.role === x.role)?.label || x.role).replace(' – custodian of the float', ''), `${dayY(x.starts_on)} – ${dayY(x.ends_on)}`]));
  else text('None current or planned when this version took effect.', { size: 9, color: [123, 133, 127] });

  heading('What changed in this version');
  if ((v.changes || []).length) for (const c of v.changes) text(`• ${changeText(c)}`, { size: 9.5 });
  else text('First recorded version: the schedule as it stood when it was brought into the app.', { size: 9.5 });

  if (monthChanges.length) {
    heading('Schedule changes during the month');
    for (const m of monthChanges) text(`• Version ${m.version_no}, ${dateY(m.effective_at)}: ${(m.changes || []).map(changeText).join('; ') || AREA_LABEL[m.area]}`, { size: 9.5 });
  }
  return doc;
}

/** Version v of the schedule as a PDF download. */
export async function downloadSchedulePdf(v) {
  if (!v?.snapshot) throw new Error('This version has no recorded schedule to print.');
  const jsPDF = await loadJsPDF();
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  drawSchedule(doc, v);
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(123, 133, 127); doc.text(`page ${i} of ${n}`, 210 - 16, 297 - 8, { align: 'right' }); }
  const ref = v.snapshot.values?.schedule_ref || 'MGP-SCH-PC-001';
  doc.setProperties({ title: `${ref} version ${v.version_no}` });
  doc.save(`${ref}-v${v.version_no}.pdf`);
}
