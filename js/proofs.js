// Proof of payment, the same everywhere a receipt is added: scan it, upload it, and keep it only if Petti can read it.
import { rpc, uploadProof, removeProof, readReceipt } from './api.js';
import { h, toast, showIf, retext, adapted } from './ui.js';
import { scanReceipt, unreadable } from './scan.js';

/** Scan, upload and read each file. Returns the proofs that were kept; says why any were refused. */
export async function addProofFiles(files, { requestId, expenseId, onExtract = null, onProgress = () => {} }) {
  const kept = []; let dup = null;
  for (const original of files) {
    if (original.size > 10 * 1024 * 1024) { toast(`${original.name} is larger than 10 MB.`, { error: true }); continue; }
    onProgress('Scanning…');
    const scan = await scanReceipt(original).catch((e) => ({ ok: false, problems: [e.message] }));
    if (!scan.ok) { toast(`Not accepted: ${scan.problems.join(' ')}`, { error: true, ms: 9000 }); continue; }
    onProgress('Uploading…');
    const row = await uploadProof(requestId, expenseId, scan.file);
    onProgress('Checking it can be read…');
    let reading = null;
    try { reading = await readReceipt(row.id); } catch { reading = null; }   // reading switched off or busy: finance checks by eye
    const why = unreadable(reading);
    if (why) { await removeProof(row).catch(() => {}); toast(`Not accepted: ${why}`, { error: true, ms: 9000 }); continue; }
    row.extracted = reading || row.extracted;
    dup = dup || row.used_on;
    kept.push(row);
    if (reading && onExtract) onExtract(reading);
  }
  onProgress('');
  if (kept.length) toast(dup ? `Accepted – but this receipt is already on #${dup}. Finance will ask about it.` : `Receipt accepted${kept.length > 1 ? ` (${kept.length})` : ''}.`, { error: !!dup });
  return kept;
}

/** "Do you have the paper slip?" – asked once there is a receipt; the answer is saved straight away. */
export function paperSlipQuestion(requestId, current, onAnswer = () => {}) {
  const name = `paper-${requestId}`;
  const opt = (value, label, hint) => {
    const r = h('input', { type: 'radio', name, value: String(value), checked: current === value, id: `${name}-${value}` });
    r.onchange = async () => { try { await rpc('set_paper_slip', { p_request: requestId, p_has: value }); onAnswer(value); } catch (e) { toast(e.message, { error: true }); } };
    return h('label', { class: 'check paper-opt' }, r, h('span', {}, h('strong', {}, label), h('span', { class: 'hint' }, hint)));
  };
  return h('div', { class: 'field paper-q' }, h('span', { class: 'label' }, 'Do you have the paper slip?'),
    opt(true, 'Yes', 'Hand it to finance – the request closes once they have it.'),
    opt(false, 'No paper slip', 'For example an e-receipt, an emailed invoice, or the shop gave none.'));
}

/** Finance's choice before paying out: proof required, or no proof possible (by the purpose of the spending).
 *  Each reason says what the spender must write instead, so the note is worth something at month end. */
export const NO_PROOF_GROUPS = [
  ['Getting around', [
    ['Taxi or bus fare', 'from where to where, and why (for example: office to FNB Independence Ave, bank deposit)'],
    ['Parking attendant or car guard', 'where they parked and for how long'],
  ]],
  ['Bought from someone without a till', [
    ['Street vendor or market stall', 'what was bought, from whom and where (for example: kapana for the site team, Oshetu market)'],
    ['Small informal service', 'what was done, by whom and where (for example: keys cut at the street stand, Post Street Mall)'],
    ['Vending machine or coin meter', 'which machine or meter, and where'],
  ]],
  ['Paid to people by hand', [
    ['Tip or gratuity', 'who was tipped and for what'],
    ['Casual labour', 'who did the work, what work, and for how long (for example: two people offloading the delivery, 3 hours)'],
    ['Informal car wash', 'which vehicle and where'],
  ]],
  ['Given', [
    ['Contribution or donation', 'for whom and the occasion (for example: condolence contribution for a staff member)'],
  ]],
  ['', [['Other', 'where the money was spent and on what']]],
];
export const NO_PROOF_REASONS = NO_PROOF_GROUPS.flatMap(([, rs]) => rs.map(([r]) => r));
/** What the spender writes instead of a receipt, for the reason finance chose. */
export function noteFor(reason) {
  for (const [, rs] of NO_PROOF_GROUPS) for (const [r, note] of rs) if (r === reason) return note;
  return 'where the money was spent and on what';
}
export function proofChoice(current = 'required', reason = '') {
  const rule = h('select', { class: 'input', id: 'proof-rule' }, h('option', { value: 'required', selected: current !== 'none' }, 'Proof required'), h('option', { value: 'none', selected: current === 'none' }, 'No proof possible'));
  const known = NO_PROOF_REASONS.includes(reason) ? reason : reason ? 'Other' : '';
  const why = h('select', { class: 'input', id: 'proof-reason' }, h('option', { value: '' }, 'Why…'),
    NO_PROOF_GROUPS.map(([g, rs]) => { const opts = rs.map(([r]) => h('option', { value: r, selected: r === known }, r)); return g ? h('optgroup', { label: g }, opts) : opts; }));
  const other = h('input', { class: 'input', id: 'proof-other', placeholder: 'Say what it is for', value: known === 'Other' ? reason : '' });
  const hint = h('span', { class: 'hint' });
  let lockedWhy = null;
  const draw = () => {
    const none = rule.value === 'none';
    showIf(why, none); showIf(other, none && why.value === 'Other');
    retext(hint, lockedWhy || (!none ? 'A receipt or invoice, scanned in Petti. If there is a paper slip, it comes to you too.'
      : why.value ? `Instead of a receipt they write ${noteFor(why.value)}. It is listed for the GM, the MD and the month-end pack.`
      : 'Choose why. They then say where they spent it instead; it is listed for the GM, the MD and the month-end pack.'));
  };
  rule.onchange = () => { draw(); if (rule.value === 'none' && !why.value) why.focus(); };
  why.onchange = () => { draw(); if (why.value === 'Other') other.focus(); };
  draw();
  const el = h('div', { class: 'field proof-choice' }, h('span', { class: 'label' }, 'Proof of payment'), h('div', { class: 'row' }, rule, why, other), hint);
  el.value = () => ({ rule: rule.value, reason: rule.value !== 'none' ? null : why.value === 'Other' ? other.value.trim() : why.value });
  /** The cash goes to the person paying it out: proof is always required, so "No proof possible" is not offered. */
  el.lock = (on, text = 'You are handing the cash to yourself, so proof is required.') => {
    const was = rule.value;
    lockedWhy = on ? text : null;
    rule.options[1].disabled = !!on;
    if (on && was === 'none') { rule.value = 'required'; adapted(rule); }
    draw();
  };
  return el;
}

/** For a claim with no receipt at all: the claimant says why; finance then decides. */
export function noReceiptBox(requestId, current, onChange = () => {}, { open = false } = {}) {
  const box = h('input', { type: 'checkbox', id: 'no-receipt', checked: !!current || open });
  const why = h('textarea', { class: 'input', id: 'no-receipt-why', rows: 2, placeholder: 'Why is there no receipt? (for example: taxi, street seller)', value: current || '' });
  const wrap = h('div', { style: { display: current || open ? '' : 'none', marginTop: '6px' } }, why);
  if (open && !current) setTimeout(() => why.focus(), 50);
  const save = async () => { try { await rpc('claim_without_receipt', { p_request: requestId, p_note: box.checked ? why.value : '' }); onChange(box.checked ? why.value : null); } catch (e) { toast(e.message, { error: true }); } };
  box.onchange = () => { showIf(wrap, box.checked); if (!box.checked) save(); else why.focus(); };
  why.onchange = save;
  return h('div', { class: 'field' }, h('label', { class: 'check' }, box, 'I have no receipt for this'), wrap, h('span', { class: 'hint' }, 'Finance decides whether it can be paid without one.'));
}
