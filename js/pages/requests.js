import { sb, state, can, personName, unwrap, rpc, uploadProof, proofUrl, removeProof, isStaff, readReceipt } from '../api.js';
import { h, mount, money, qty, num, fmtDate, pill, OPEN_STATUSES, EVENT_LABEL, MOVEMENT_LABEL, emptyState, toast, busy, field, select, confirmDialog, today } from '../ui.js';

export function expenseOf(q) { return Array.isArray(q.expense) ? q.expense[0] : q.expense; }
const thr = () => Number(state.settings?.approval_threshold || 0);
export const TYPE_LABEL = { stock: 'Stock', cash: 'Cash', claim: 'Claim' };
const typeLabel = (q) => (q.for_store ? 'Restock order' : TYPE_LABEL[q.type] || q.type);

/* =============================================================== list row */
export function requestRow(q, { showRequester = false, note = null } = {}) {
  const ex = expenseOf(q);
  const amount = ['closed', 'proof_review', 'physical_required'].includes(q.status) || (q.type === 'claim' && Number(ex?.total) > 0)
    ? (ex?.total ?? q.disbursed_amount ?? q.estimated_total)
    : q.status === 'disbursed' ? q.disbursed_amount : q.estimated_total;
  const over = Number(q.estimated_total) > thr() || Number(q.disbursed_amount) > thr();
  return h('li', { class: 'click', onclick: () => { location.hash = `#/requests/${q.id}`; } },
    h('div', { class: 'what' },
      h('strong', {}, `#${q.request_no} · ${q.purpose || (q.type === 'stock' ? 'Stock request' : q.type === 'claim' ? 'Claim' : 'Cash request')}`),
      h('span', {}, [typeLabel(q), showRequester ? ` · ${personName(q.requester_id)}` : '', ` · ${fmtDate(q.submitted_at || q.created_at)}`].join(''),
        q.over_budget ? h('span', { style: { color: 'var(--amber)' } }, ' · over budget') : null,
        note ? h('span', { style: { color: 'var(--amber)' } }, ` · ${note}`) : null)),
    pill(q.status),
    h('span', { class: `amt${over ? ' threshold' : ''}`, title: over ? 'Above the approval threshold' : '' }, money(amount)));
}

/* =============================================================== list page */
export async function requestsPage() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  let view = params.get('view') || 'open';
  let search = '';
  const list = h('div', {});
  const tabs = h('div', { class: 'tabs' });
  const searchBox = h('input', { class: 'input', placeholder: 'Search purpose or number', oninput: (e) => { search = e.target.value.toLowerCase(); draw(); } });
  let rows = [];

  async function load() {
    let q = sb.from('requests').select('*, expense:expenses(total, proof_status)').order('updated_at', { ascending: false }).limit(300);
    if (view === 'open') q = q.in('status', OPEN_STATUSES);
    else if (view === 'mine') q = q.eq('requester_id', state.me.id);
    else if (view === 'closed') q = q.in('status', ['closed', 'fulfilled_from_stock', 'rejected', 'cancelled']);
    rows = unwrap(await q);
    draw();
  }
  function draw() {
    const views = [['open', 'Open'], ['mine', 'Mine'], ['closed', 'Finished'], ['all', 'All']];
    mount(tabs, views.map(([k, l]) => h('button', { class: k === view ? 'active' : '', onclick: () => { view = k; load(); } }, l)));
    const filtered = rows.filter((r) => !search || `#${r.request_no} ${r.purpose}`.toLowerCase().includes(search));
    mount(list, filtered.length ? h('ul', { class: 'ledger-list' }, filtered.map((r) => requestRow(r, { showRequester: isStaff() })))
      : emptyState('Nothing here', view === 'open' ? 'No open requests.' : 'No requests match.'));
  }
  await load();
  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Requests'), h('p', {}, isStaff() ? 'Every request you can see, newest first.' : 'Your requests, claims and anything paid out to you.')),
      h('div', { class: 'page-actions' }, h('a', { class: 'btn', href: '#/requests/new/claim' }, 'Claim back'), h('a', { class: 'btn btn-primary', href: '#/requests/new' }, 'New request'))),
    tabs, h('div', { class: 'toolbar' }, searchBox), h('div', { class: 'sheet' }, list));
}

/* =============================================================== budgets & prices (shared hints) */
async function loadBudgets() { const { data } = await sb.rpc('budget_status'); return (data || []).filter((b) => b.active); }
function budgetHint(budgets, { categoryId = null, personId = null, add = 0 } = {}) {
  const hits = budgets.filter((b) => (categoryId && b.category_id === categoryId) || (personId && b.person_id === personId && !b.category_id));
  if (!hits.length) return null;
  return h('div', {}, hits.map((b) => {
    const used = Number(b.used), lim = Number(b.monthly_limit), after = used + add; const over = after > lim;
    return h('div', { class: 'hint', style: { color: over ? 'var(--amber)' : '' } },
      `${b.label} budget: ${money(used)} of ${money(lim)} used this month${add ? ` – this takes it to ${money(after)}` : ''}${over ? (state.settings.budget_mode === 'block' ? '. Over budget: it will be blocked.' : state.settings.budget_mode === 'require_approval' ? '. Over budget: it will go to the approver.' : '. Over budget.') : ''}`);
  }));
}
async function loadPrices() { const { data } = await sb.from('v_price_history').select('item_id, on_date, unit_price, supplier_name').order('on_date', { ascending: false }).limit(600); return data || []; }
function priceHint(prices, itemId) {
  const last = prices.filter((p) => p.item_id === itemId).slice(0, 3);
  if (!last.length) return null;
  return h('div', { class: 'hint' }, 'Last paid: ', last.map((p, i) => `${i ? ' · ' : ''}${money(p.unit_price)}${p.supplier_name ? ` (${p.supplier_name}, ${fmtDate(p.on_date)})` : ` (${fmtDate(p.on_date)})`}`).join(''));
}

/* =============================================================== new / edit */
export async function newRequestPage(editId, presetType) {
  const [{ data: items }, { data: cats }, budgets, prices] = await Promise.all([
    sb.from('items').select('*').eq('active', true).order('name'),
    sb.from('categories').select('*').eq('active', true).order('name'),
    loadBudgets(), loadPrices(),
  ]);
  let existing = null; let lines = []; let expense = null;
  if (editId) {
    existing = unwrap(await sb.from('requests').select('*').eq('id', editId).single());
    if (existing.status !== 'draft' || existing.requester_id !== state.me.id) { location.hash = `#/requests/${editId}`; return h('div'); }
    lines = unwrap(await sb.from('request_lines').select('*').eq('request_id', editId).order('line_no'));
    if (existing.type === 'claim') expense = (await sb.from('expenses').select('*, proofs:expense_proofs(*)').eq('request_id', editId).maybeSingle()).data;
  }
  let type = existing?.type || (presetType === 'claim' ? 'claim' : presetType === 'cash' ? 'cash' : 'stock');
  const forStore = existing?.for_store || false;
  if (!lines.length) lines = [blankLine()];
  function blankLine() { return { item_id: '', description: '', qty: 1, est_unit_price: 0 }; }
  const placeholders = { stock: 'e.g. Printer paper for reception', cash: 'e.g. Taxi to the bank', claim: 'e.g. Milk and sugar I paid for on Friday' };

  const purpose = h('input', { class: 'input', value: existing?.purpose || '', placeholder: placeholders[type], maxlength: 140 });
  const needed = h('input', { class: 'input', type: 'date', value: existing?.needed_by || '' });
  const category = select([['', 'No category'], ...cats.filter((c) => c.kind !== 'stock').map((c) => [c.id, c.name])], existing?.category_id || '');
  const spentAt = h('input', { class: 'input', type: 'date', value: expense?.spent_at || today(), max: today() });
  const supplier = h('input', { class: 'input', value: expense?.supplier_name || '', placeholder: 'Where you bought it' });
  const notes = h('input', { class: 'input', value: expense?.notes || '', placeholder: 'Optional' });
  const linesBox = h('div', { class: 'lines-edit' });
  const totalEl = h('span', { class: 'amt' });
  const budgetBox = h('div', {});
  const err = h('div', { class: 'error' });
  const receiptBox = h('div', {});
  const intro = h('p', {});

  const typeBtns = h('div', { class: 'tabs' });
  function drawType() {
    mount(typeBtns, [['stock', 'Stock item'], ['cash', 'Cash for an expense'], ['claim', 'I already paid – claim back']].map(([k, l]) =>
      h('button', { type: 'button', class: k === type ? 'active' : '', disabled: !!existing || forStore, onclick: () => { type = k; lines = [blankLine()]; purpose.placeholder = placeholders[k]; drawType(); drawLines(); } }, l)));
    category.closest('.field').style.display = type === 'stock' ? 'none' : '';
    needed.closest('.field').style.display = type === 'claim' ? 'none' : '';
    for (const el of [spentAt, supplier, notes]) el.closest('.field').style.display = type === 'claim' ? '' : 'none';
    receiptBox.style.display = type === 'claim' ? '' : 'none';
    intro.textContent = forStore ? 'Items to buy for the store this month. Quantities come from measured usage; adjust them.'
      : type === 'stock' ? `Stock requests go to the stock manager first; anything above ${money(thr())} then goes to the approver before finance pays out.`
      : type === 'cash' ? `Cash requests go straight to finance, or to the approver first if above ${money(thr())}.`
      : `You paid with your own money. Attach the receipt and finance pays you back from petty cash${thr() ? `; above ${money(thr())} the approver signs it off first` : ''}.`;
    budget();
  }
  category.onchange = budget;

  function drawLines() {
    const rows = lines.map((ln, i) => {
      const qtyIn = h('input', { class: 'input num', type: 'number', min: '0.01', step: 'any', value: ln.qty, inputmode: 'decimal', oninput: (e) => { ln.qty = num(e.target.value); total(); } });
      const priceIn = h('input', { class: 'input num', type: 'number', min: '0', step: '0.01', value: ln.est_unit_price, inputmode: 'decimal', oninput: (e) => { ln.est_unit_price = num(e.target.value); total(); } });
      let first; const hint = h('div', {});
      if (type === 'stock') {
        first = select([['', 'Choose an item…'], ...items.map((it) => [it.id, `${it.name} (${it.unit})`])], ln.item_id, {
          onchange: (e) => {
            ln.item_id = e.target.value; const it = items.find((x) => x.id === ln.item_id);
            ln.description = it?.name || ''; if (it?.last_unit_price != null) { ln.est_unit_price = Number(it.last_unit_price); priceIn.value = ln.est_unit_price; }
            mount(hint, priceHint(prices, ln.item_id)); total();
          } });
        mount(hint, priceHint(prices, ln.item_id));
      } else {
        first = h('input', { class: 'input', placeholder: type === 'claim' ? 'What you bought' : 'What is it for?', value: ln.description, oninput: (e) => { ln.description = e.target.value; } });
      }
      return h('tr', {}, h('td', {}, first, hint), h('td', { class: 'num', style: { width: '90px' } }, qtyIn), h('td', { class: 'num', style: { width: '120px' } }, priceIn),
        h('td', { class: 'num', style: { width: '40px' } }, h('button', { type: 'button', class: 'btn btn-quiet btn-sm', title: 'Remove line', onclick: () => { lines.splice(i, 1); if (!lines.length) lines.push(blankLine()); drawLines(); } }, '✕')));
    });
    mount(linesBox, h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
      h('thead', {}, h('tr', {}, h('th', {}, type === 'stock' ? 'Item' : 'Description'), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, type === 'claim' ? 'Price paid' : 'Est. price'), h('th'))),
      h('tbody', {}, rows),
      h('tfoot', {}, h('tr', {}, h('td', { colspan: 2 }, h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { lines.push(blankLine()); drawLines(); } }, '+ Add line')), h('td', { class: 'num muted' }, type === 'claim' ? 'Claimed' : 'Estimated'), h('td', { class: 'num' }, totalEl))))));
    total();
  }
  function currentTotal() { return lines.reduce((s, l) => s + num(l.qty) * num(l.est_unit_price), 0); }
  function total() {
    const t = currentTotal();
    totalEl.textContent = money(t);
    totalEl.className = `amt${t > thr() ? ' threshold' : ''}`;
    totalEl.title = t > thr() ? `Above ${money(thr())}: needs approval` : '';
    budget();
  }
  function budget() {
    const t = currentTotal();
    const parts = [budgetHint(budgets, { personId: state.me.id, add: t })];
    if (type === 'stock') {
      const byCat = {};
      for (const l of lines) { const it = items.find((x) => x.id === l.item_id); if (it?.category_id) byCat[it.category_id] = (byCat[it.category_id] || 0) + num(l.qty) * num(l.est_unit_price); }
      for (const [cid, amt] of Object.entries(byCat)) parts.push(budgetHint(budgets, { categoryId: cid, add: amt }));
    } else if (category.value) parts.push(budgetHint(budgets, { categoryId: category.value, add: t }));
    mount(budgetBox, parts.filter(Boolean));
  }

  async function saveHead(validateAll) {
    if (!purpose.value.trim()) throw new Error(type === 'claim' ? 'Say what the claim is for.' : 'Say what the request is for.');
    let id = existing?.id;
    if (type === 'claim') {
      const r = await rpc('save_claim', { p_request: id || null, p_purpose: purpose.value.trim(), p_category: category.value || null, p_spent_at: spentAt.value, p_supplier: supplier.value.trim() || null, p_notes: notes.value.trim() || null });
      id = r.id;
      if (!existing) { existing = r; expense = (await sb.from('expenses').select('*, proofs:expense_proofs(*)').eq('request_id', id).maybeSingle()).data; }
    } else {
      const head = { type, purpose: purpose.value.trim(), needed_by: needed.value || null, category_id: type === 'cash' ? (category.value || null) : null };
      if (id) unwrap(await sb.from('requests').update(head).eq('id', id));
      else { const row = unwrap(await sb.from('requests').insert({ ...head, requester_id: state.me.id, for_store: forStore }).select().single()); id = row.id; existing = row; }
    }
    const clean = lines.filter((l) => (type === 'stock' ? l.item_id : l.description.trim()));
    if (validateAll) {
      if (!clean.length) throw new Error(type === 'stock' ? 'Choose at least one item.' : 'Add at least one line.');
      if (clean.some((l) => num(l.qty) <= 0)) throw new Error('Every line needs a quantity.');
      if (type !== 'stock' && clean.some((l) => num(l.est_unit_price) <= 0)) throw new Error(type === 'claim' ? 'Enter the price you paid on every line.' : 'Enter an estimated price for every line.');
    }
    unwrap(await sb.from('request_lines').delete().eq('request_id', id));
    if (clean.length) unwrap(await sb.from('request_lines').insert(clean.map((l, i) => ({
      request_id: id, line_no: i + 1, item_id: l.item_id || null, description: l.description || items.find((x) => x.id === l.item_id)?.name || '',
      qty: num(l.qty), est_unit_price: num(l.est_unit_price),
    }))));
    return id;
  }
  async function save(submit) {
    err.textContent = '';
    const id = await saveHead(submit);
    if (submit) { await rpc('submit_request', { p_request: id }); toast(type === 'claim' ? 'Claim submitted.' : 'Request submitted.'); }
    else toast('Draft saved.');
    location.hash = `#/requests/${id}`;
  }

  // claim receipts live on the draft, so the draft is saved on the first upload
  async function drawReceipts() {
    if (type !== 'claim') return;
    if (!expense) {
      mount(receiptBox, h('div', { class: 'field' }, h('span', { class: 'label' }, 'Receipt'),
        h('label', { class: 'upload' }, h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, onchange: async (e) => {
          const files = Array.from(e.target.files || []); if (!files.length) return;
          try { await saveHead(false); for (const f of files) { const row = await uploadProof(existing.id, expense.id, f); expense.proofs = [...(expense.proofs || []), row]; } toast('Receipt attached.'); }
          catch (ex) { toast(ex.message, { error: true }); }
          drawReceipts();
        } }), '📷 Take a photo or upload the receipt'),
        h('span', { class: 'hint' }, 'Required before the claim can be submitted.')));
      return;
    }
    mount(receiptBox, h('div', { class: 'field' }, h('span', { class: 'label' }, 'Receipt'), await proofGallery(expense, existing, true, drawReceipts, drawReceipts, { onExtract: applyExtract }),
      h('span', { class: 'hint' }, 'Required before the claim can be submitted. “Read receipt” fills the lines in for you.')));
  }
  function applyExtract(x) {
    if (x.supplier && !supplier.value) supplier.value = x.supplier;
    if (x.date && /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.date <= today()) spentAt.value = x.date;
    if (Array.isArray(x.lines) && x.lines.length && lines.every((l) => !l.description.trim())) {
      lines = x.lines.filter((l) => l && l.description).map((l) => ({ item_id: '', description: String(l.description), qty: num(l.qty) || 1, est_unit_price: num(l.unit_price) }));
      drawLines();
    }
    toast(`Receipt read${x.total != null ? `: total ${money(x.total)}` : ''}. Check the lines before submitting.`, { ms: 6000 });
  }

  const saveBtn = h('button', { type: 'button', class: 'btn' }, 'Save draft');
  const submitBtn = h('button', { type: 'button', class: 'btn btn-primary' }, type === 'claim' ? 'Submit claim' : 'Submit request');
  saveBtn.onclick = busy(saveBtn, () => save(false));
  submitBtn.onclick = busy(submitBtn, () => save(true));

  const page = h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, existing ? `Edit draft #${existing.request_no}` : forStore ? 'Restock order' : type === 'claim' ? 'Claim back' : 'New request'), intro)),
    expense?.proof_status === 'returned' && expense.finance_note ? h('div', { class: 'banner banner-red' }, h('strong', {}, 'Finance returned this claim'), expense.finance_note) : null,
    h('div', { class: 'sheet' },
      typeBtns,
      field('What is it for?', purpose),
      h('div', { class: 'row' }, field('Needed by', needed, 'Optional'), field('Category', category), field('Date you paid', spentAt), field('Shop / supplier', supplier)),
      field('Notes for finance', notes),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Lines'), linesBox, budgetBox,
        h('span', { class: 'hint' }, type === 'stock' ? 'The stock manager may issue part of this from the store instead of buying.' : type === 'claim' ? 'Enter exactly what the receipt says.' : 'Estimates are fine – the real amounts go on the receipt afterwards.')),
      receiptBox,
      err,
      h('div', { class: 'form-actions' }, h('a', { class: 'btn btn-quiet', href: existing ? `#/requests/${existing.id}` : '#/requests' }, 'Cancel'), saveBtn, submitBtn)));
  drawType(); drawLines(); await drawReceipts();
  return page;
}

/* =============================================================== detail */
export async function requestDetailPage(id) {
  const q = unwrap(await sb.from('requests').select('*').eq('id', id).single());
  const [lines, events, expense, movements] = await Promise.all([
    unwrap(await sb.from('request_lines').select('*, item:items(name, unit, qty_on_hand, last_unit_price, category_id)').eq('request_id', id).order('line_no')),
    unwrap(await sb.from('request_events').select('*').eq('request_id', id).order('created_at')),
    sb.from('expenses').select('*, lines:expense_lines(*), proofs:expense_proofs(*)').eq('request_id', id).maybeSingle().then((r) => r.data),
    unwrap(await sb.from('stock_movements').select('*, item:items(name, unit)').eq('request_id', id).eq('void', false).order('created_at')),
  ]);
  if (expense?.lines) expense.lines = expense.lines.filter((l) => !l.void);
  const me = state.me.id;
  const isRequester = q.requester_id === me;
  const isClaim = q.type === 'claim';
  const reload = () => { location.hash = `#/requests/${id}?t=${Date.now()}`; };
  const over = Number(q.estimated_total) > thr();

  const head = h('div', { class: 'page-head' },
    h('div', {},
      h('div', { class: 'ref' }, `${isClaim ? 'Claim' : 'Request'} #${q.request_no} · ${typeLabel(q)} · raised by ${personName(q.requester_id)} on ${fmtDate(q.created_at)}`),
      h('h1', {}, q.purpose || 'Request'),
      h('p', {}, pill(q.status), ' ', q.approval_required ? h('span', { class: 'pill pill-purple' }, `Above ${money(thr())}`) : null, ' ',
        q.over_budget ? h('span', { class: 'pill pill-amber', title: q.budget_note || '' }, 'Over budget') : null,
        q.needed_by ? h('span', { class: 'ref' }, ` · needed by ${fmtDate(q.needed_by)}`) : null)),
    h('div', { class: 'page-actions' }, headerActions()));

  function headerActions() {
    const a = [];
    if (q.status === 'draft' && isRequester) {
      a.push(h('a', { class: 'btn', href: `#/requests/${id}/edit` }, 'Edit'));
      const del = h('button', { class: 'btn btn-danger' }, 'Delete draft');
      del.onclick = busy(del, async () => { if (!(await confirmDialog('Delete draft?', 'This cannot be undone.', { ok: 'Delete', danger: true }))) return; unwrap(await sb.from('requests').delete().eq('id', id)); location.hash = '#/requests'; });
      a.push(del);
    }
    if (['stock_review', 'pending_approval', 'awaiting_disbursement'].includes(q.status) && (isRequester || can('admin'))) {
      const c = h('button', { class: 'btn btn-quiet' }, isClaim ? 'Withdraw claim' : 'Cancel request');
      c.onclick = busy(c, async () => { const n = await confirmDialog(isClaim ? 'Withdraw this claim?' : 'Cancel this request?', 'It will be withdrawn from the queue.', { ok: isClaim ? 'Withdraw' : 'Cancel request', danger: true, note: { label: 'Reason (optional)' } }); if (n === null) return; await rpc('cancel_request', { p_request: id, p_note: n }); toast('Withdrawn.'); reload(); });
      a.push(c);
    }
    return a;
  }

  const reviewed = !!q.stock_reviewed_at || q.type !== 'stock' || q.for_store;
  const showSplit = reviewed && q.type === 'stock' && !q.for_store;
  const linesTable = h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', { class: 'num' }, 'Qty'),
      showSplit ? [h('th', { class: 'num' }, 'From store'), h('th', { class: 'num' }, 'To buy')] : null,
      h('th', { class: 'num' }, isClaim ? 'Price paid' : 'Est. price'), h('th', { class: 'num' }, 'Total'))),
    h('tbody', {}, lines.map((l) => h('tr', {},
      h('td', {}, l.item?.name || l.description, l.item ? h('span', { class: 'muted' }, ` · ${l.item.unit}`) : null),
      h('td', { class: 'num' }, qty(l.qty)),
      showSplit ? [h('td', { class: 'num' }, qty(l.qty_from_stock)), h('td', { class: 'num' }, qty(l.qty_to_buy ?? l.qty))] : null,
      h('td', { class: 'num' }, money(l.est_unit_price)),
      h('td', { class: 'num' }, money((reviewed ? Number(l.qty_to_buy ?? l.qty) : Number(l.qty)) * Number(l.est_unit_price)))))),
    h('tfoot', {}, h('tr', {}, h('td', { colspan: showSplit ? 5 : 3 }, isClaim ? 'Claimed' : reviewed ? 'To be bought' : 'Estimated'), h('td', { class: `num${over ? ' threshold' : ''}` }, money(q.estimated_total))))));

  const stage = await stagePanel(q, lines, expense, reload);

  const expenseSheet = expense && Number(expense.total) > 0 && !(isClaim && ['draft', 'pending_approval', 'awaiting_disbursement'].includes(q.status)) ? h('div', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, h('h2', {}, isClaim ? 'What was claimed' : 'What was spent'), h('span', { class: 'sub' }, `${fmtDate(expense.spent_at)} · recorded by ${personName(expense.spent_by)}${expense.supplier_name ? ` · ${expense.supplier_name}` : ''}`)),
    h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Line'), h('th', {}, 'Supplier'), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, 'Unit price'), h('th', { class: 'num' }, 'Total'))),
      h('tbody', {}, expense.lines.map((l) => h('tr', {}, h('td', {}, l.description), h('td', { class: 'muted' }, l.supplier_name || '—'), h('td', { class: 'num' }, qty(l.qty)), h('td', { class: 'num' }, money(l.unit_price)), h('td', { class: 'num' }, money(l.line_total))))),
      h('tfoot', {}, h('tr', {}, h('td', { colspan: 4 }, isClaim ? 'Reimbursed' : 'Spent'), h('td', { class: 'num' }, money(expense.total))),
        isClaim ? null : h('tr', {}, h('td', { colspan: 4, class: 'muted', style: { fontWeight: 400 } }, Number(expense.total) > Number(q.disbursed_amount) ? `Overspent against ${money(q.disbursed_amount)} paid out – finance to reimburse` : `Change returned against ${money(q.disbursed_amount)} paid out`),
          h('td', { class: 'num', style: { fontWeight: 400 } }, Number(expense.total) > Number(q.disbursed_amount) ? money(Number(expense.total) - Number(q.disbursed_amount)) : money(expense.change_returned)))))),
    expense.notes ? h('p', { class: 'hint', style: { marginTop: '8px' } }, expense.notes) : null,
    h('div', { style: { marginTop: '12px' } }, h('h3', { style: { marginBottom: '8px' } }, 'Proof'), await proofGallery(expense, q, false, reload)),
    expense.proof_status === 'confirmed' ? h('p', { class: 'hint', style: { marginTop: '8px' } }, `Confirmed by ${personName(expense.confirmed_by)} on ${fmtDate(expense.confirmed_at, { time: true })}${expense.physical_received_at ? ` · physical receipt received ${fmtDate(expense.physical_received_at)}` : ''}`) : null) : null;

  const timeline = h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'History')),
    h('ul', { class: 'timeline' },
      h('li', {}, h('span', { class: 'when' }, fmtDate(q.created_at, { time: true })), `Created by ${personName(q.requester_id)}`),
      events.map((ev, i) => h('li', { class: i === events.length - 1 ? 'now' : '' }, h('span', { class: 'when' }, fmtDate(ev.created_at, { time: true })),
        `${EVENT_LABEL[ev.action] || ev.action} · ${personName(ev.actor_id)}`, ev.note ? h('span', { class: 'note' }, ev.note) : null))));

  const movementsSheet = movements.length ? h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Stock movements')),
    h('ul', { class: 'ledger-list' }, movements.map((m) => h('li', {}, h('div', { class: 'what' }, h('strong', {}, m.item.name), h('span', {}, `${MOVEMENT_LABEL[m.kind]}${m.issued_to ? ' to ' + personName(m.issued_to) : ''} · ${fmtDate(m.occurred_on || m.created_at)}`)),
      h('span', { class: 'amt' }, `${Number(m.delta) > 0 ? '+' : ''}${qty(m.delta)} ${m.item.unit}`))))) : null;

  const details = h('dl', { class: 'kv' },
    q.stock_reviewed_at ? [h('dt', {}, 'Stock review'), h('dd', {}, `${personName(q.stock_reviewed_by)}, ${fmtDate(q.stock_reviewed_at)}${q.stock_note ? ' – ' + q.stock_note : ''}`)] : null,
    q.over_budget && q.budget_note ? [h('dt', {}, 'Budget'), h('dd', { style: { color: 'var(--amber)' } }, q.budget_note)] : null,
    q.approved_at ? [h('dt', {}, 'Approved'), h('dd', {}, `${personName(q.approved_by)}, ${fmtDate(q.approved_at)}${q.approval_note ? ' – ' + q.approval_note : ''}`)] : null,
    q.rejected_at ? [h('dt', {}, 'Rejected'), h('dd', {}, `${personName(q.rejected_by)}, ${fmtDate(q.rejected_at)} – ${q.rejection_reason}`)] : null,
    q.disbursed_at ? [h('dt', {}, isClaim ? 'Reimbursed' : 'Cash paid out'), h('dd', {}, `${money(q.disbursed_amount)} to ${personName(q.disbursed_to)} by ${personName(q.disbursed_by)}, ${fmtDate(q.disbursed_at)}`)] : null,
    q.closed_at ? [h('dt', {}, 'Closed'), h('dd', {}, `${personName(q.closed_by)}, ${fmtDate(q.closed_at)}`)] : null);

  return h('div', {}, head, stage,
    h('div', { class: 'grid-2' },
      h('div', {}, h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, isClaim ? 'Claimed' : 'Requested')), linesTable, details.children.length ? h('div', { style: { marginTop: '14px' } }, details) : null), expenseSheet),
      h('div', {}, timeline, movementsSheet)));
}

/* =============================================================== stage panels */
async function stagePanel(q, lines, expense, reload) {
  const me = state.me.id;
  const banner = (tone, title, text, ...extra) => h('div', { class: `banner banner-${tone}` }, h('strong', {}, title), text, ...extra);
  const isClaim = q.type === 'claim';

  switch (q.status) {
    case 'draft':
      if (isClaim && expense?.proof_status === 'returned') return banner('red', 'Finance returned this claim', `${expense.finance_note || ''} Edit it and submit again.`);
      return q.requester_id === me ? banner('amber', 'This is a draft', 'Edit it, then submit when it is ready.') : banner('amber', 'Draft', 'Not submitted yet.');

    case 'stock_review':
      if (can('stock_review')) return stockReviewPanel(q, lines, reload);
      return banner('blue', 'With the stock manager', 'They will issue what is in the store and arrange to buy the rest.');

    case 'pending_approval':
      if (can('approve')) return approvalPanel(q, reload);
      return banner('purple', 'Waiting for approval', q.over_budget ? q.budget_note : `The amount is above ${money(thr())}, so the approver must sign it off before finance pays out.`);

    case 'awaiting_disbursement':
      if (isClaim) {
        if (can('finance')) return claimPanel(q, expense, reload);
        return banner('amber', 'Waiting for finance to reimburse you', expense?.proof_status === 'physical_required' && !expense.physical_received_at ? `Finance needs the paper receipt first${expense.finance_note ? `: ${expense.finance_note}` : '.'}` : 'Finance checks the receipt and pays you from the float.');
      }
      if (can('finance')) return disbursePanel(q, reload);
      return banner('amber', 'Approved – waiting for finance', 'Finance will pay the cash out from the float.');

    case 'disbursed': {
      const spender = q.disbursed_to === me;
      if (spender || can('finance')) return expensePanel(q, lines, expense, reload);
      return banner('amber', `Cash paid to ${personName(q.disbursed_to)}`, 'Waiting for them to record what was spent and upload the receipt.');
    }

    case 'proof_review':
      if (can('finance')) return financeReviewPanel(q, expense, reload);
      return banner('blue', 'Finance is checking the receipt', 'You will be told if anything else is needed.');

    case 'physical_required':
      if (can('finance')) return financeReviewPanel(q, expense, reload);
      return banner('amber', 'Finance needs the physical receipt', expense?.finance_note ? `${expense.finance_note} ` : 'Hand the original receipt to finance; they will close the request once they have it. ',
        q.disbursed_to === me ? h('div', { style: { marginTop: '10px' } }, await proofGallery(expense, q, true, reload)) : null);

    case 'closed': return banner('green', isClaim ? 'Reimbursed' : 'Closed', isClaim ? `${money(q.disbursed_amount)} paid back from petty cash on ${fmtDate(q.disbursed_at)}.` : `Spent ${money(expense?.total)} · proof confirmed by finance.`);
    case 'fulfilled_from_stock': return banner('green', 'Issued from the store', 'Everything requested was available in stock; no cash was needed.');
    case 'rejected': return banner('red', `Rejected by ${personName(q.rejected_by)}`, q.rejection_reason);
    case 'cancelled': return banner('grey', 'Withdrawn', '');
    default: return null;
  }
}

/* ---- stock manager review ---- */
function stockReviewPanel(q, lines, reload) {
  const edits = lines.map((l) => ({ line_id: l.id, qty_from_stock: Math.min(Number(l.qty), Number(l.item?.qty_on_hand || 0)), qty_to_buy: 0, est_unit_price: Number(l.est_unit_price) || Number(l.item?.last_unit_price || 0) }));
  edits.forEach((e, i) => { e.qty_to_buy = Math.max(Number(lines[i].qty) - e.qty_from_stock, 0); });
  const note = h('textarea', { class: 'input', placeholder: 'Note for the requester or finance (optional)' });
  const totalEl = h('span', {});
  const tbody = h('tbody', {});
  function draw() {
    mount(tbody, lines.map((l, i) => {
      const e = edits[i]; const onhand = Number(l.item?.qty_on_hand || 0);
      const from = h('input', { class: 'input num', type: 'number', min: 0, max: onhand, step: 'any', value: e.qty_from_stock, disabled: !l.item_id, oninput: (ev) => { e.qty_from_stock = Math.min(num(ev.target.value), onhand); e.qty_to_buy = Math.max(Number(l.qty) - e.qty_from_stock, 0); buy.value = e.qty_to_buy; total(); } });
      const buy = h('input', { class: 'input num', type: 'number', min: 0, step: 'any', value: e.qty_to_buy, oninput: (ev) => { e.qty_to_buy = num(ev.target.value); total(); } });
      const price = h('input', { class: 'input num', type: 'number', min: 0, step: '0.01', value: e.est_unit_price, oninput: (ev) => { e.est_unit_price = num(ev.target.value); total(); } });
      return h('tr', {}, h('td', {}, l.item?.name || l.description, h('span', { class: 'muted' }, l.item ? ` · ${qty(onhand)} ${l.item.unit} on hand` : ' · not a catalogue item')),
        h('td', { class: 'num' }, qty(l.qty)), h('td', { class: 'num', style: { width: '100px' } }, from), h('td', { class: 'num', style: { width: '100px' } }, buy), h('td', { class: 'num', style: { width: '120px' } }, price));
    }));
    total();
  }
  function total() {
    const t = edits.reduce((s, e) => s + e.qty_to_buy * e.est_unit_price, 0);
    mount(totalEl, h('span', { class: t > thr() ? 'threshold' : '' }, money(t)), t > thr() ? h('span', { class: 'muted' }, ' – needs the approver') : edits.every((e) => e.qty_to_buy === 0) ? h('span', { class: 'muted' }, ' – all from stock, nothing to buy') : h('span', { class: 'muted' }, ' – straight to finance'));
  }
  draw();
  const done = h('button', { class: 'btn btn-primary' }, 'Complete review');
  done.onclick = busy(done, async () => { await rpc('stock_review', { p_request: q.id, p_lines: edits, p_note: note.value }); toast('Review complete.'); reload(); });
  const rej = h('button', { class: 'btn btn-danger' }, 'Reject');
  rej.onclick = busy(rej, async () => { const n = await confirmDialog('Reject this request?', 'The requester will see your reason.', { ok: 'Reject', danger: true, note: { label: 'Reason', required: true } }); if (!n) return; await rpc('reject_request', { p_request: q.id, p_reason: n }); toast('Rejected.'); reload(); });
  return h('div', { class: 'sheet', style: { borderColor: 'var(--blue)' } },
    h('div', { class: 'sheet-head' }, h('h2', {}, 'Stock review'), h('span', { class: 'sub' }, 'Issue what the store has; the rest gets bought')),
    h('div', { class: 'table-wrap lines-edit' }, h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', { class: 'num' }, 'Asked'), h('th', { class: 'num' }, 'From store'), h('th', { class: 'num' }, 'To buy'), h('th', { class: 'num' }, 'Est. price'))), tbody,
      h('tfoot', {}, h('tr', {}, h('td', { colspan: 4 }, 'Cash needed'), h('td', { class: 'num' }, totalEl))))),
    h('div', { class: 'field', style: { marginTop: '12px' } }, note),
    h('div', { class: 'form-actions' }, rej, done));
}

/* ---- approver ---- */
function approvalPanel(q, reload) {
  const note = h('textarea', { class: 'input', placeholder: 'Note (optional)' });
  const ok = h('button', { class: 'btn btn-purple' }, `Approve ${money(q.estimated_total)}`);
  ok.onclick = busy(ok, async () => { await rpc('approve_request', { p_request: q.id, p_note: note.value }); toast('Approved – finance can pay out.'); reload(); });
  const rej = h('button', { class: 'btn btn-danger' }, 'Reject');
  rej.onclick = busy(rej, async () => { const n = await confirmDialog('Reject this request?', 'The requester will see your reason.', { ok: 'Reject', danger: true, note: { label: 'Reason', required: true } }); if (!n) return; await rpc('reject_request', { p_request: q.id, p_reason: n }); toast('Rejected.'); reload(); });
  return h('div', { class: 'sheet', style: { borderColor: 'var(--purple)' } },
    h('div', { class: 'sheet-head' }, h('h2', { class: 'threshold' }, 'Your approval is needed'), h('span', { class: 'sub' }, Number(q.estimated_total) > thr() ? `${money(q.estimated_total)} is above the ${money(thr())} threshold` : 'Sent to you because it goes over a budget')),
    q.over_budget && q.budget_note ? h('div', { class: 'banner banner-amber' }, h('strong', {}, 'Over budget'), q.budget_note) : null,
    q.stock_note ? h('p', { class: 'hint' }, `Stock manager: ${q.stock_note}`) : null,
    h('div', { class: 'field' }, note), h('div', { class: 'form-actions' }, rej, ok));
}

/* ---- finance: pay out ---- */
function disbursePanel(q, reload) {
  const defaultTo = q.type === 'stock' && !q.for_store ? (q.stock_reviewed_by || q.requester_id) : q.requester_id;
  const amount = h('input', { class: 'input num', type: 'number', min: '0.01', step: '0.01', value: Number(q.estimated_total).toFixed(2) });
  const to = select(state.people.filter((p) => p.active).map((p) => [p.id, p.full_name || p.email]), defaultTo);
  const note = h('input', { class: 'input', placeholder: 'Note (optional)' });
  const warn = h('div', { class: 'hint' });
  const check = () => { const a = num(amount.value); warn.textContent = a > thr() && !q.approved_by ? `Above ${money(thr())} and not approved – escalate it instead.` : ''; warn.style.color = warn.textContent ? 'var(--purple)' : ''; };
  amount.oninput = check; check();
  // cash already out with the payee and not yet accounted for
  const owing = h('div', { class: 'hint', style: { color: 'var(--amber)' } });
  const checkOwing = async () => {
    const { data } = await sb.from('requests').select('request_no, disbursed_amount, disbursed_at').eq('status', 'disbursed').eq('disbursed_to', to.value).neq('id', q.id);
    const rows = data || [];
    owing.textContent = rows.length ? `${personName(to.value)} still has ${money(rows.reduce((s, r) => s + Number(r.disbursed_amount), 0))} out with no receipt recorded (${rows.map((r) => `#${r.request_no}`).join(', ')})${state.settings.block_with_outstanding ? ' – pay-outs to them are on hold until that is recorded.' : '.'}` : '';
  };
  to.onchange = checkOwing; checkOwing().catch(() => {});
  const pay = h('button', { class: 'btn btn-primary' }, 'Pay out');
  pay.onclick = busy(pay, async () => { await rpc('disburse_request', { p_request: q.id, p_amount: num(amount.value), p_to: to.value, p_note: note.value }); toast(`Paid out ${money(num(amount.value))}.`); reload(); });
  const esc = h('button', { class: 'btn' }, 'Send for approval');
  esc.onclick = busy(esc, async () => {
    const n = await confirmDialog('Send for approval', `The approver will see the revised amount of ${money(num(amount.value))}.`, { ok: 'Send', note: { label: 'Why', required: true } });
    if (!n) return; await rpc('escalate_request', { p_request: q.id, p_new_estimate: num(amount.value), p_note: n }); toast('Sent to the approver.'); reload();
  });
  const rej = h('button', { class: 'btn btn-danger' }, 'Decline');
  rej.onclick = busy(rej, async () => { const n = await confirmDialog('Decline this request?', 'The requester will see your reason.', { ok: 'Decline', danger: true, note: { label: 'Reason', required: true } }); if (!n) return; await rpc('reject_request', { p_request: q.id, p_reason: n }); toast('Declined.'); reload(); });
  return h('div', { class: 'sheet', style: { borderColor: 'var(--amber)' } },
    h('div', { class: 'sheet-head' }, h('h2', {}, 'Pay out from petty cash'), h('span', { class: 'sub' }, q.approved_by ? `Approved by ${personName(q.approved_by)}` : `Within the ${money(thr())} limit – no approval needed`)),
    q.over_budget && q.budget_note ? h('p', { class: 'hint', style: { color: 'var(--amber)' } }, q.budget_note) : null,
    h('div', { class: 'row' }, field('Amount', amount, warn), field('Hand the cash to', to), field('Note', note)),
    owing,
    h('div', { class: 'form-actions' }, rej, esc, pay));
}

/* ---- finance: reimburse a claim ---- */
async function claimPanel(q, expense, reload) {
  const note = h('textarea', { class: 'input', placeholder: 'Note to the claimant / for the record' });
  const act = (label, action, cls, needNote) => {
    const b = h('button', { class: `btn ${cls}` }, label);
    b.onclick = busy(b, async () => {
      if (needNote && !note.value.trim()) throw new Error('Add a note first so the claimant knows what to do.');
      await rpc('finance_review_expense', { p_request: q.id, p_action: action, p_note: note.value });
      toast({ require_physical: 'The claimant has been asked for the paper receipt.', physical_received: 'Paper receipt recorded.', return: 'Returned to the claimant.' }[action]); reload();
    });
    return b;
  };
  const pay = h('button', { class: 'btn btn-primary' }, `Reimburse ${money(expense?.total)}`);
  pay.onclick = busy(pay, async () => { await rpc('disburse_request', { p_request: q.id, p_amount: Number(expense.total), p_note: note.value }); toast(`Reimbursed ${money(expense.total)}.`); reload(); });
  const physicalPending = expense?.proof_status === 'physical_required' && !expense.physical_received_at;
  return h('div', { class: 'sheet', style: { borderColor: 'var(--amber)' } },
    h('div', { class: 'sheet-head' }, h('h2', {}, 'Reimburse from petty cash'), h('span', { class: 'sub' }, `${money(expense?.total)} claimed by ${personName(q.requester_id)}${q.approved_by ? ` · approved by ${personName(q.approved_by)}` : ''}`)),
    q.over_budget && q.budget_note ? h('p', { class: 'hint', style: { color: 'var(--amber)' } }, q.budget_note) : null,
    physicalPending ? h('div', { class: 'banner banner-amber' }, h('strong', {}, 'Paper receipt requested'), expense.finance_note || 'Waiting for the original to be handed in.') : null,
    expense?.physical_received_at ? h('p', { class: 'hint' }, `Paper receipt received ${fmtDate(expense.physical_received_at)}.`) : null,
    h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, h('th', {}, 'Line'), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, 'Unit price'), h('th', { class: 'num' }, 'Total'))),
      h('tbody', {}, (expense?.lines || []).map((l) => h('tr', {}, h('td', {}, l.description), h('td', { class: 'num' }, qty(l.qty)), h('td', { class: 'num' }, money(l.unit_price)), h('td', { class: 'num' }, money(l.line_total))))),
      h('tfoot', {}, h('tr', {}, h('td', { colspan: 3 }, `Paid on ${fmtDate(expense?.spent_at)}${expense?.supplier_name ? ` at ${expense.supplier_name}` : ''}`), h('td', { class: 'num' }, money(expense?.total)))))),
    expense?.notes ? h('p', { class: 'hint' }, expense.notes) : null,
    h('div', { style: { margin: '12px 0' } }, h('h3', { style: { marginBottom: '8px' } }, 'Receipt'), await proofGallery(expense, q, false, reload)),
    h('div', { class: 'field' }, note),
    h('div', { class: 'form-actions' }, act('Return for correction', 'return', 'btn-danger', true),
      physicalPending ? act('Paper receipt received', 'physical_received', '') : act('Require paper receipt', 'require_physical', ''),
      physicalPending ? null : pay));
}

/* ---- spender: record expense + proofs ---- */
async function expensePanel(q, lines, expense, reload) {
  const [{ data: suppliers }, { data: items }, prices] = await Promise.all([
    sb.from('suppliers').select('id, name').eq('active', true).order('name'),
    q.type === 'stock' ? sb.from('items').select('id, name, unit, last_unit_price').eq('active', true).order('name') : { data: [] },
    q.type === 'stock' ? loadPrices() : [],
  ]);
  const returned = expense?.proof_status === 'returned';
  let exLines = expense?.lines?.length ? expense.lines.map((l) => ({ item_id: l.item_id || '', description: l.description, qty: Number(l.qty), unit_price: Number(l.unit_price), supplier_id: l.supplier_id || '', supplier_name: l.supplier_name || '' }))
    : lines.filter((l) => Number(l.qty_to_buy ?? l.qty) > 0).map((l) => ({ item_id: l.item_id || '', description: l.item?.name || l.description, qty: Number(l.qty_to_buy ?? l.qty), unit_price: Number(l.est_unit_price), supplier_id: '', supplier_name: '' }));
  if (!exLines.length) exLines = [{ item_id: '', description: '', qty: 1, unit_price: 0, supplier_id: '', supplier_name: '' }];
  const spentAt = h('input', { class: 'input', type: 'date', value: expense?.spent_at && Number(expense.total) > 0 ? expense.spent_at : today(), max: today() });
  const notes = h('textarea', { class: 'input', placeholder: 'Anything finance should know (optional)', value: expense?.notes || '' });
  const supplierOpts = [['', 'Supplier…'], ...suppliers.map((s) => [s.id, s.name]), ['__other', 'Other (type a name)']];
  const tbody = h('tbody', {}); const totalEl = h('td', { class: 'num' });
  let receiptTotal = null;
  const mismatch = h('div', { class: 'hint' });
  function draw() {
    mount(tbody, exLines.map((l, i) => {
      const warn = h('div', { class: 'hint', style: { color: 'var(--amber)' } });
      const checkPrice = () => { const it = items.find((x) => x.id === l.item_id); const last = Number(it?.last_unit_price || 0); warn.textContent = last > 0 && num(l.unit_price) > last * 1.1 ? `${Math.round((num(l.unit_price) / last - 1) * 100)}% above the last price paid (${money(last)})` : ''; };
      const desc = q.type === 'stock' && items.length
        ? select([['', 'Not a catalogue item'], ...items.map((it) => [it.id, it.name])], l.item_id, { onchange: (e) => { l.item_id = e.target.value; const it = items.find((x) => x.id === l.item_id); if (it) l.description = it.name; descIn.value = l.description; checkPrice(); } })
        : null;
      const descIn = h('input', { class: 'input', placeholder: 'Description', value: l.description, oninput: (e) => { l.description = e.target.value; } });
      const qtyIn = h('input', { class: 'input num', type: 'number', min: '0.01', step: 'any', value: l.qty, inputmode: 'decimal', oninput: (e) => { l.qty = num(e.target.value); total(); } });
      const priceIn = h('input', { class: 'input num', type: 'number', min: 0, step: '0.01', value: l.unit_price, inputmode: 'decimal', oninput: (e) => { l.unit_price = num(e.target.value); total(); checkPrice(); } });
      const supName = h('input', { class: 'input', placeholder: 'Supplier name', value: l.supplier_name, style: { display: l.supplier_id === '__other' || (!l.supplier_id && l.supplier_name) ? '' : 'none', marginTop: '4px' }, oninput: (e) => { l.supplier_name = e.target.value; } });
      const sup = select(supplierOpts, l.supplier_id || (l.supplier_name ? '__other' : ''), { onchange: (e) => { l.supplier_id = e.target.value; supName.style.display = l.supplier_id === '__other' ? '' : 'none'; if (l.supplier_id !== '__other') l.supplier_name = ''; } });
      checkPrice();
      return h('tr', {}, h('td', {}, desc, h('div', { style: { marginTop: desc ? '4px' : 0 } }, descIn), warn), h('td', {}, sup, supName),
        h('td', { class: 'num', style: { width: '80px' } }, qtyIn), h('td', { class: 'num', style: { width: '110px' } }, priceIn),
        h('td', { class: 'num', style: { width: '36px' } }, h('button', { type: 'button', class: 'btn btn-quiet btn-sm', onclick: () => { exLines.splice(i, 1); if (!exLines.length) exLines.push({ item_id: '', description: '', qty: 1, unit_price: 0, supplier_id: '', supplier_name: '' }); draw(); } }, '✕')));
    }));
    total();
  }
  function total() {
    const t = exLines.reduce((s, l) => s + num(l.qty) * num(l.unit_price), 0);
    const diff = Number(q.disbursed_amount) - t;
    mount(totalEl, money(t), h('div', { class: 'muted', style: { fontWeight: 400, fontSize: '.8rem' } }, diff >= 0 ? `change ${money(diff)}` : `over by ${money(-diff)}`));
    if (receiptTotal != null) { const off = Math.abs(t - receiptTotal) > Math.max(0.5, receiptTotal * 0.01); mismatch.textContent = off ? `The receipt reads ${money(receiptTotal)} but the lines add up to ${money(t)}.` : `Matches the receipt total of ${money(receiptTotal)}.`; mismatch.style.color = off ? 'var(--amber)' : 'var(--green-ink)'; }
  }
  function applyExtract(x) {
    if (x.total != null) receiptTotal = Number(x.total);
    if (x.date && /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.date <= today()) spentAt.value = x.date;
    if (Array.isArray(x.lines) && x.lines.length) {
      const fresh = x.lines.filter((l) => l && l.description).map((l) => ({ item_id: '', description: String(l.description), qty: num(l.qty) || 1, unit_price: num(l.unit_price), supplier_id: '', supplier_name: x.supplier || '' }));
      // keep catalogue links where the names match
      for (const f of fresh) { const it = items.find((i) => i.name.toLowerCase() === f.description.toLowerCase()); if (it) f.item_id = it.id; }
      const existingSup = suppliers.find((s) => x.supplier && s.name.toLowerCase() === String(x.supplier).toLowerCase());
      if (existingSup) fresh.forEach((f) => { f.supplier_id = existingSup.id; f.supplier_name = ''; });
      else if (x.supplier) fresh.forEach((f) => { f.supplier_id = '__other'; });
      exLines = fresh; draw();
    } else total();
    toast(`Receipt read${x.total != null ? `: ${money(x.total)}` : ''}. Check the lines, then submit.`, { ms: 6000 });
  }
  draw();
  const gallery = h('div', {});
  async function drawGallery() { mount(gallery, await proofGallery(expense, q, true, reload, drawGallery, { onExtract: applyExtract })); }
  await drawGallery();

  const submit = h('button', { class: 'btn btn-primary' }, 'Submit expense to finance');
  submit.onclick = busy(submit, async () => {
    const clean = exLines.filter((l) => l.description.trim()).map((l) => ({ item_id: l.item_id || null, description: l.description.trim(), qty: num(l.qty), unit_price: num(l.unit_price), supplier_id: l.supplier_id && l.supplier_id !== '__other' ? l.supplier_id : null, supplier_name: l.supplier_name.trim() || null }));
    if (!clean.length) throw new Error('Add at least one line.');
    await rpc('record_expense', { p_request: q.id, p_spent_at: spentAt.value, p_lines: clean, p_notes: notes.value });
    toast('Expense submitted – finance will check the receipt.'); reload();
  });
  return h('div', { class: 'sheet', style: { borderColor: 'var(--amber)' } },
    h('div', { class: 'sheet-head' }, h('h2', {}, `Record what you spent of the ${money(q.disbursed_amount)}`), h('span', { class: 'sub' }, `paid out ${fmtDate(q.disbursed_at)} by ${personName(q.disbursed_by)}`)),
    returned ? h('div', { class: 'banner banner-red' }, h('strong', {}, 'Finance returned this for correction'), expense.finance_note) : null,
    h('div', { class: 'field' }, h('span', { class: 'label' }, '1. Scan the receipt'), h('span', { class: 'hint' }, 'Take a photo or upload a PDF, then “Read receipt” to fill the lines in. Finance may still ask for the paper original.'), gallery),
    h('div', { class: 'field' }, h('span', { class: 'label' }, '2. What was bought'),
      h('div', { class: 'table-wrap lines-edit' }, h('table', { class: 'ledger' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Line'), h('th', {}, 'Supplier'), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, 'Unit price'), h('th'))), tbody,
        h('tfoot', {}, h('tr', {}, h('td', { colspan: 3 }, h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { exLines.push({ item_id: '', description: '', qty: 1, unit_price: 0, supplier_id: '', supplier_name: '' }); draw(); } }, '+ Add line')), h('td', { class: 'num muted' }, 'Spent'), totalEl)))), mismatch),
    h('div', { class: 'row' }, field('Date of purchase', spentAt), field('Notes', notes)),
    h('div', { class: 'form-actions' }, submit));
}

/* ---- proofs gallery (shared) ---- */
async function proofGallery(expense, q, canEdit, reload, redraw, { onExtract = null } = {}) {
  const proofs = expense?.proofs || [];
  const cards = await Promise.all(proofs.map(async (p) => {
    const url = await proofUrl(p.storage_path);
    const isImg = /^image\//.test(p.mime || '');
    const del = canEdit && p.uploaded_by === state.me.id && ['pending', 'returned'].includes(expense.proof_status)
      ? h('button', { type: 'button', onclick: async () => { if (!(await confirmDialog('Remove this file?', p.file_name, { ok: 'Remove', danger: true }))) return; try { await removeProof(p); expense.proofs = expense.proofs.filter((x) => x.id !== p.id); redraw ? redraw() : reload(); } catch (e) { toast(e.message, { error: true }); } } }, 'Remove') : null;
    let read = null;
    if (canEdit && onExtract) {
      read = h('button', { type: 'button', style: { color: 'var(--green-ink)' } }, p.extracted ? 'Use reading' : 'Read receipt');
      read.onclick = busy(read, async () => { const x = p.extracted && !p.extracted.error ? p.extracted : await readReceipt(p.id); p.extracted = x; onExtract(x); });
    }
    return h('div', { class: 'proof' }, h('a', { href: url || '#', target: '_blank', rel: 'noopener' },
      h('div', { class: 'thumb' }, isImg && url ? h('img', { src: url, alt: p.file_name, loading: 'lazy' }) : 'PDF'), h('div', { class: 'name', title: p.file_name }, p.file_name)), read, del);
  }));
  let uploader = null;
  if (canEdit && expense) {
    const input = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true });
    const label = h('label', { class: 'upload' }, input, proofs.length ? '+ Add another scan or photo' : '📷 Take a photo or upload the receipt');
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      label.textContent = `Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`;
      try {
        for (const f of files) {
          if (f.size > 10 * 1024 * 1024) throw new Error(`${f.name} is larger than 10 MB.`);
          const row = await uploadProof(q.id, expense.id, f);
          expense.proofs = [...(expense.proofs || []), row];
        }
        toast('Uploaded.');
      } catch (e) { toast(e.message, { error: true }); }
      redraw ? redraw() : reload();
    };
    uploader = label;
  }
  return h('div', {}, cards.length ? h('div', { class: 'proofs', style: { marginBottom: uploader ? '10px' : 0 } }, cards) : (!uploader ? h('span', { class: 'muted' }, 'No scanned proof uploaded.') : null), uploader);
}

/* ---- finance: review proof ---- */
function financeReviewPanel(q, expense, reload) {
  const note = h('textarea', { class: 'input', placeholder: 'Note to the spender / for the record' });
  const act = (label, action, cls, needNote) => {
    const b = h('button', { class: `btn ${cls}` }, label);
    b.onclick = busy(b, async () => {
      if (needNote && !note.value.trim()) throw new Error('Add a note first so the spender knows what to do.');
      await rpc('finance_review_expense', { p_request: q.id, p_action: action, p_note: note.value });
      toast({ confirm: 'Proof confirmed – request closed.', require_physical: 'The spender has been asked for the physical receipt.', physical_received: 'Physical receipt recorded – request closed.', return: 'Returned to the spender.' }[action]); reload();
    });
    return b;
  };
  const physical = q.status === 'physical_required';
  const reading = (expense?.proofs || []).map((p) => p.extracted).find((x) => x && x.total != null);
  const off = reading && Math.abs(Number(reading.total) - Number(expense.total)) > Math.max(0.5, Number(reading.total) * 0.01);
  return h('div', { class: 'sheet', style: { borderColor: 'var(--blue)' } },
    h('div', { class: 'sheet-head' }, h('h2', {}, physical ? 'Waiting for the physical receipt' : 'Check the receipt'),
      h('span', { class: 'sub' }, `${money(expense?.total)} spent of ${money(q.disbursed_amount)} · ${expense?.proofs?.length || 0} file${expense?.proofs?.length === 1 ? '' : 's'} uploaded`)),
    reading ? h('p', { class: 'hint', style: { color: off ? 'var(--amber)' : 'var(--green-ink)' } }, off ? `The receipt reads ${money(reading.total)} but ${money(expense.total)} was recorded.` : `The receipt reading (${money(reading.total)}) matches what was recorded.`) : null,
    physical ? h('p', { class: 'hint' }, `Requested ${fmtDate(expense.physical_required_at)}${expense.finance_note ? ` – “${expense.finance_note}”` : ''}. Once you hold the paper original, mark it received to close the request.`)
      : h('p', { class: 'hint' }, 'Compare the scan below against the lines. Confirm if the scan is enough, or ask for the paper original to be handed in.'),
    h('div', { class: 'field' }, note),
    h('div', { class: 'form-actions' },
      act('Return for correction', 'return', 'btn-danger', true),
      physical ? act('Physical receipt received – close', 'physical_received', 'btn-primary') : [act('Require physical receipt', 'require_physical', ''), act('Confirm & close', 'confirm', 'btn-primary')]));
}
