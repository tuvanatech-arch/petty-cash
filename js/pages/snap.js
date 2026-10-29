// Snap or upload a receipt or invoice: the file comes first, then the app proposes where it belongs –
// cash you are holding, a purchase that is approved but not yet paid, or a new claim.
import { sb, state, unwrap, rpc, readReceipt, uploadToInbox, fileInboxReceipt, fileInboxDocument, discardInboxReceipt, proofUrl, personName } from '../api.js';
import { h, mount, money, fmtDate, toast, busy, emptyState, today, isoDate, num, confirmDialog } from '../ui.js';
import { takeSharedFile } from '../share.js';

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !['from', 'with', 'this', 'that', 'the', 'and', 'for'].includes(w));

/** Is the money for this request already out (a receipt is expected) or still to be paid (an invoice may come first)? */
export const isAdvance = (req) => ['disbursed', 'proof_review', 'physical_required'].includes(req.status);

/** Score how well a reading fits a request: amount, date, then words. Returns a number; >= 3 is a confident match. */
export function matchScore(reading, req) {
  let score = 0; const reasons = [];
  const advance = isAdvance(req);
  const total = Number(reading?.total), paid = Number(advance ? req.disbursed_amount || req.estimated_total : req.estimated_total) || 0;
  if (total > 0 && paid > 0) {
    const ratio = total / paid;
    if (Math.abs(total - paid) <= Math.max(1, paid * 0.02)) { score += 3; reasons.push('same amount'); }
    else if (ratio >= 0.5 && ratio <= 1.0) { score += 1.5; reasons.push(advance ? 'within the amount paid out' : 'within the amount approved'); }
    else if (ratio > 1 && ratio <= 1.25) { score += 0.5; reasons.push(advance ? 'a little over the amount paid out' : 'a little over the amount approved'); }
    else if (ratio > 1.5) { score -= 1.5; }
  }
  if (reading?.date && advance && req.disbursed_at) {
    const paidOn = String(req.disbursed_at).slice(0, 10);
    if (reading.date >= paidOn) { score += 1; reasons.push('dated after the pay-out'); }
    else { score -= 2; }
  } else if (reading?.date && !advance && req.submitted_at) {
    if (reading.date >= String(req.submitted_at).slice(0, 10)) { score += 0.5; reasons.push('dated after the request'); }
  }
  const hay = new Set([...words(req.purpose), ...(req.lines || []).flatMap((l) => words(l.description))]);
  const needle = [...words(reading?.supplier), ...(reading?.lines || []).flatMap((l) => words(l.description))];
  const hits = [...new Set(needle.filter((w) => hay.has(w)))];
  if (hits.length) { score += Math.min(2, hits.length); reasons.push(`mentions ${hits.slice(0, 2).join(', ')}`); }
  return { score, reasons };
}

export async function snapPage() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const resumeId = params.get('inbox');
  const page = h('div', {});
  const [{ data: unfiled }, { data: advances }, { data: approved }] = await Promise.all([
    sb.from('receipt_inbox').select('*').eq('status', 'unfiled').order('created_at', { ascending: false }),
    sb.from('requests').select('*, lines:request_lines(description)').eq('disbursed_to', state.me.id).in('status', ['disbursed', 'proof_review', 'physical_required']).order('disbursed_at'),
    sb.from('requests').select('*, lines:request_lines(description)').eq('requester_id', state.me.id).neq('type', 'claim').in('status', ['pending_approval', 'awaiting_disbursement']).order('submitted_at'),
  ]);
  const inboxList = unfiled || [];
  const held = (advances || []).filter((r) => r.status === 'disbursed' || r.status === 'physical_required');
  const pending = approved || [];
  const candidates = [...held, ...pending];

  // ---- step 1: the file. Phones lead with the camera; a desk leads with the file picker (and can drop a file on it) ----
  const hasCamera = document.documentElement.dataset.pointer === 'coarse' && document.documentElement.dataset.device !== 'tv';
  const input = h('input', { type: 'file', accept: 'image/*,application/pdf' });
  if (hasCamera) input.setAttribute('capture', 'environment');
  const chooser = h('label', { class: 'snap-btn' }, input, h('span', { class: 'big' }, hasCamera ? '📷' : '📄'),
    h('span', {}, hasCamera ? 'Snap or upload a receipt or invoice' : 'Upload a receipt or invoice'),
    h('span', { class: 'hint' }, hasCamera ? 'camera, photos or a PDF from Files / email' : 'choose a PDF or image, or drop it here'));
  input.onchange = () => { const f = input.files?.[0]; if (f) start(f); };
  chooser.ondragover = (e) => { e.preventDefault(); chooser.classList.add('over'); };
  chooser.ondragleave = () => chooser.classList.remove('over');
  chooser.ondrop = (e) => { e.preventDefault(); chooser.classList.remove('over'); const f = e.dataTransfer?.files?.[0]; if (f) start(f); };

  const stage = h('div', {});
  function drawStart() {
    const bits = [];
    if (held.length) bits.push(`cash you are holding (${held.map((r) => `#${r.request_no} ${money(r.disbursed_amount)}`).join(', ')})`);
    if (pending.length) bits.push(`your ${pending.length === 1 ? 'request' : 'requests'} not yet paid out (${pending.map((r) => `#${r.request_no}`).join(', ')}) – an invoice attached there tells finance the exact amount`);
    mount(stage, chooser,
      bits.length ? h('p', { class: 'hint', style: { marginTop: '12px' } }, `It is matched against ${bits.join(' and ')}. Anything else becomes a claim for money you paid yourself.`)
        : h('p', { class: 'hint', style: { marginTop: '12px' } }, 'You hold no petty cash and have nothing waiting to be paid, so what you add here becomes a claim for money you paid yourself.'),
      inboxList.length ? h('div', { class: 'sheet', style: { marginTop: '16px' } }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Unfiled receipts'), h('span', { class: 'sub' }, inboxList.length)),
        h('ul', { class: 'ledger-list' }, inboxList.map((ib) => h('li', { class: 'click', onclick: () => resume(ib) },
          h('div', { class: 'what' }, h('strong', {}, ib.extracted?.supplier || ib.file_name), h('span', {}, `${fmtDate(ib.created_at, { time: true })}${ib.extracted?.total != null ? ` · ${money(ib.extracted.total)}` : ib.read_error ? ' · could not be read' : ' · not read yet'}`)),
          h('span', { class: 'amt' }, 'Continue →'))))) : null);
  }

  async function start(file) {
    if (file.size > 10 * 1024 * 1024) { toast('That file is larger than 10 MB.', { error: true }); return; }
    mount(stage, h('div', { class: 'loading' }, 'Uploading…'));
    let ib;
    try { ib = await uploadToInbox(file); }
    catch (e) { toast(e.message, { error: true }); drawStart(); return; }
    if (ib.used_on) toast(`This photo is already on #${ib.used_on}. If it is a different purchase, take a new photo; otherwise finance will ask about it.`, { error: true, ms: 7000 });
    await resume(ib);
  }

  async function resume(ib) {
    const url = await proofUrl(ib.storage_path);
    const thumb = h('div', { class: 'snap-thumb' }, /^image\//.test(ib.mime || '') && url ? h('img', { src: url, alt: ib.file_name }) : h('span', {}, 'PDF'));
    const status = h('div', { class: 'hint' }, 'Reading the receipt…');
    mount(stage, h('div', { class: 'snap-row' }, thumb, h('div', {}, h('strong', {}, ib.file_name), status)));
    let reading = ib.extracted && !ib.read_error ? ib.extracted : null;
    if (!reading) {
      try { reading = await readReceipt({ inbox_id: ib.id }); ib.extracted = reading; }
      catch (e) { reading = null; status.textContent = `${e.message} You can still file it by hand below.`; status.style.color = 'var(--amber)'; }
    }
    propose(ib, reading, thumb);
  }

  function propose(ib, reading, thumb) {
    const summary = reading ? h('div', { class: 'snap-read' },
      h('div', {}, h('span', { class: 'k' }, 'Shop'), h('span', { class: 'v' }, reading.supplier || '—')),
      h('div', {}, h('span', { class: 'k' }, 'Date'), h('span', { class: 'v' }, reading.date ? fmtDate(reading.date) : '—')),
      h('div', {}, h('span', { class: 'k' }, 'Total'), h('span', { class: 'v' }, reading.total != null ? money(reading.total) : '—')),
      h('div', {}, h('span', { class: 'k' }, 'Items'), h('span', { class: 'v' }, String((reading.lines || []).length))))
      : h('p', { class: 'hint' }, 'The receipt could not be read automatically – choose where it belongs and fill the lines in yourself.');

    const scored = candidates.map((r) => ({ r, ...matchScore(reading, r) })).sort((a, b) => b.score - a.score);
    const best = scored[0]; const second = scored[1];
    const confident = best && best.score >= 3 && (!second || best.score - second.score >= 1.5);
    const options = h('div', { class: 'snap-options' });

    const attachBtn = (r, label) => { const b = h('button', { class: 'btn btn-primary' }, label); b.onclick = busy(b, () => attach(ib, r, reading)); return b; };
    const claimBtn = (label = 'It’s a claim – I paid this myself') => { const b = h('button', { class: 'btn' }, label); b.onclick = busy(b, () => claim(ib, reading)); return b; };
    const laterBtn = h('button', { class: 'btn btn-quiet', onclick: () => { toast('Kept under Unfiled receipts.'); location.hash = '#/home'; } }, 'Decide later');
    const discardBtn = h('button', { class: 'btn btn-quiet btn-danger' }, 'Discard');
    discardBtn.onclick = busy(discardBtn, async () => { if (!(await confirmDialog('Discard this file?', 'It will be deleted.', { ok: 'Discard', danger: true }))) return; await discardInboxReceipt(ib); toast('Discarded.'); location.hash = '#/snap'; });

    const line = (r) => isAdvance(r) ? `${money(r.disbursed_amount)} paid to you ${fmtDate(r.disbursed_at)}`
      : r.status === 'awaiting_disbursement' ? `${money(r.estimated_total)} approved, not yet paid out` : `${money(r.estimated_total)} requested, waiting for approval`;
    const card = (r, why, primary) => h('div', { class: `snap-card${primary ? ' primary' : ''}` },
      h('div', { class: 'what' }, h('strong', {}, `#${r.request_no} · ${r.purpose}`), h('span', {}, `${line(r)}${why?.length ? ` · ${why.join(', ')}` : ''}`)),
      attachBtn(r, primary ? 'Yes, attach to this' : 'Attach here'));

    const claimNote = h('p', { class: 'hint', style: { margin: '10px 0 0' } }, 'A claim is money spent before anyone approved it – the approver signs it off before finance pays you back.');
    if (!candidates.length) {
      mount(options, h('div', { class: 'banner banner-green', style: { marginBottom: '12px' } }, h('strong', {}, 'Nothing of yours is waiting for a receipt or invoice'), reading?.total != null ? `So this looks like money you paid yourself: claim ${money(reading.total)}${reading.supplier ? ` from ${reading.supplier}` : ''} back from the float.` : 'So this would be a claim for money you paid yourself.'),
        h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, claimBtn('Create the claim'), laterBtn, discardBtn), claimNote);
    } else if (confident) {
      mount(options, h('p', { style: { fontWeight: 600, margin: '10px 0 6px' } }, 'Looks like this one:'), card(best.r, best.reasons, true),
        scored.length > 1 ? h('details', { style: { marginTop: '8px' } }, h('summary', { class: 'hint', style: { cursor: 'pointer' } }, 'Not that one? Choose another'), scored.slice(1).map((s) => card(s.r, s.reasons, false))) : null,
        h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, claimBtn(), laterBtn, discardBtn));
    } else {
      mount(options, h('p', { style: { fontWeight: 600, margin: '10px 0 6px' } }, 'Which of these is it for?'), scored.map((s, i) => card(s.r, s.reasons, i === 0 && s.score >= 1.5)),
        h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, claimBtn(), laterBtn, discardBtn));
    }
    mount(stage, h('div', { class: 'snap-row' }, thumb, h('div', { style: { flex: 1 } }, h('strong', {}, ib.file_name), summary)), options);
  }

  /** What the difference between the document and the request means, said before anything is filed. */
  function discrepancy(reading, r) {
    const total = Number(reading?.total);
    if (!(total > 0)) return { ok: true, text: 'The total could not be read, so you will fill the lines in yourself and finance checks the paper.' };
    const advance = isAdvance(r);
    const base = Number(advance ? r.disbursed_amount : r.estimated_total) || 0;
    const diff = total - base;
    if (Math.abs(diff) <= Math.max(1, base * 0.02)) return { ok: true, text: `${money(total)} – matches the ${money(base)} ${advance ? 'paid out' : r.status === 'awaiting_disbursement' ? 'approved' : 'requested'}.` };
    if (advance) {
      return diff < 0
        ? { ok: false, text: `It reads ${money(total)} against ${money(base)} paid out: ${money(-diff)} change is due back to finance. That is recorded when you confirm the lines.` }
        : { ok: false, text: `It reads ${money(total)} against ${money(base)} paid out: you covered ${money(diff)} yourself. Finance sees the difference and reimburses it with the settlement.` };
    }
    return diff < 0
      ? { ok: false, text: `It reads ${money(total)} against ${money(base)} ${r.status === 'awaiting_disbursement' ? 'approved' : 'requested'} – finance will pay the invoice amount, not the estimate.` }
      : { ok: false, text: `It reads ${money(total)}, ${money(diff)} more than the ${money(base)} ${r.status === 'awaiting_disbursement' ? 'approved' : 'requested'}. ${r.status === 'awaiting_disbursement' ? 'Finance can pay the higher amount only within the approval limit; otherwise it goes back to the approver.' : 'The approver sees the invoice amount.'}` };
  }

  async function attach(ib, r, reading) {
    const d = discrepancy(reading, r);
    if (!d.ok && !(await confirmDialog(`Attach to #${r.request_no}?`, d.text, { ok: 'Attach anyway' }))) return;
    if (isAdvance(r)) {
      const proof = await fileInboxReceipt(ib, r.id);
      toast(`Attached to #${r.request_no}. Check the lines, then submit.`, { ms: 5000 });
      location.hash = `#/requests/${r.id}?apply=${proof.id}`;
    } else {
      await fileInboxDocument(ib, r.id, 'invoice');
      toast(r.status === 'awaiting_disbursement' ? `Invoice attached to #${r.request_no} – finance has been told.` : `Attached to #${r.request_no} – the approver sees it.`, { ms: 5000 });
      location.hash = `#/requests/${r.id}`;
    }
  }

  async function claim(ib, reading) {
    const purpose = reading?.supplier ? `${reading.supplier}${reading.lines?.[0]?.description ? ` – ${reading.lines[0].description}` : ''}`.slice(0, 140) : 'Receipt I paid myself';
    const spentAt = reading?.date && /^\d{4}-\d{2}-\d{2}$/.test(reading.date) && reading.date <= today() ? reading.date : today();
    const req = await rpc('save_claim', { p_request: null, p_purpose: purpose, p_category: null, p_spent_at: spentAt, p_supplier: reading?.supplier || null, p_notes: null });
    const lines = (reading?.lines || []).filter((l) => l && l.description).map((l, i) => ({ request_id: req.id, line_no: i + 1, item_id: null, description: String(l.description), qty: num(l.qty) || 1, est_unit_price: num(l.unit_price) }));
    if (!lines.length && reading?.total != null) lines.push({ request_id: req.id, line_no: 1, item_id: null, description: purpose, qty: 1, est_unit_price: Number(reading.total) });
    if (lines.length) unwrap(await sb.from('request_lines').insert(lines));
    await fileInboxReceipt(ib, req.id);
    toast('Claim created from the receipt – check it, then submit.', { ms: 5000 });
    location.hash = `#/requests/${req.id}/edit`;
  }

  // a file shared into the app (Android "Share → Petty cash") is waiting in the service worker's hand-off
  const shared = params.get('shared') ? await takeSharedFile().catch(() => null) : null;
  if (shared) start(shared);
  else if (resumeId) { const ib = inboxList.find((x) => x.id === resumeId); if (ib) resume(ib); else drawStart(); } else drawStart();
  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, hasCamera ? 'Snap or upload' : 'Upload a receipt or invoice'), h('p', {}, 'The file first. The app reads it and proposes where it belongs; you confirm.'))),
    h('div', { class: 'sheet' }, stage));
}
