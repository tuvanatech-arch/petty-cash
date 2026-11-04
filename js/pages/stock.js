import { sb, state, can, personName, unwrap, rpc, queueOffline, scoped, multiBranch, myBranch, branchName } from '../api.js';
import { branchGate } from '../branch.js';
import { myTopReported } from '../usage.js';
import { h, mount, money, qty, num, fmtDate, monthLabel, emptyState, toast, busy, field, select, modal, MOVEMENT_LABEL, PACE, refresh, today, isoDate, confirmDialog, onceHint, showIf, picker, units } from '../ui.js';
import { barChart } from '../charts.js';
import { itemThumb, itemPhotos, uploadPhoto, photoUrl } from '../itemphotos.js';
import { storeMatches } from './requests.js';

export async function stockPage(tab = 'items') {
  const manage = can('manage_stock');
  // one store at a time: looking at all branches, pick one first
  const gate = tab === 'suggestions' ? null : branchGate('store');   // suggestions from every branch can be decided without picking one
  if (gate) return h('div', {}, h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Stock'), h('p', {}, 'Each branch keeps its own store.'))), gate);
  const openReports = (await sb.from('stock_reports').select('id', { count: 'exact', head: true }).is('resolved_at', null)).count || 0;
  const acts = manage ? (await sb.rpc('stock_actions')).data || {} : {};
  const nDeliv = Number(acts.receipts_to_check || 0), nCorr = Number(acts.adjustments_to_approve || 0);
  // suggestions waiting for me: the stock controller checks, the GM approves (053)
  const nSug = (await sb.from('item_suggestions').select('id, status, suggested_by')).data?.filter((x) => x.suggested_by !== state.me.id
    && ((x.status === 'with_stock' && state.me.role === 'stock_manager') || (x.status === 'with_gm' && state.me.role === 'approver'))).length || 0;
  const sugTab = ['suggestions', nSug ? `Suggestions (${nSug})` : 'Suggestions'];
  // daily work in the tab bar; catalogue setup (suppliers, categories) one tap away under "Catalogue"
  const setup = tab === 'suppliers' || tab === 'categories';
  const tabs = setup ? [['suppliers', 'Suppliers'], ['categories', 'Categories']]
    : manage ? [['items', 'Items'], ['reports', openReports ? `Reported (${openReports})` : 'Reported'], sugTab, ['deliveries', nDeliv ? `Deliveries (${nDeliv})` : 'Deliveries'], ['usage', 'Usage'], ['movements', 'Movements'], ['adjustments', nCorr ? `Corrections (${nCorr})` : 'Corrections']]
    : [['items', 'Items'], ['reports', 'My reports'], sugTab];
  const body = h('div', {});
  const tabBar = h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: k === tab ? 'active' : '', onclick: () => { location.hash = `#/stock/${k}`; } }, l)));
  const actions = [];
  if (!manage) actions.push(h('button', { class: 'btn btn-primary', onclick: () => reportDialog(null) }, 'Report low / out'));
  if (!setup) actions.push(h('button', { class: `btn${manage ? ' btn-quiet' : ''}`, id: 'suggest-item', onclick: () => suggestDialog() }, 'Suggest an item'));
  if (manage && !setup) {
    actions.push(h('button', { class: 'btn btn-primary', onclick: () => quickCountDialog() }, 'Quick count'));
    const restock = h('button', { class: 'btn' }, 'Restock order');
    restock.onclick = busy(restock, async () => { const req = await rpc('create_restock_request'); toast('Draft restock order created from measured usage. Check the quantities, then submit.'); location.hash = `#/requests/${req.id}/edit`; });
    actions.push(restock);
    if (tab === 'items' && can('catalogue')) actions.push(h('button', { class: 'btn btn-quiet', onclick: () => itemDialog(null, () => refresh()) }, '+ Item'));
    if (can('catalogue')) actions.push(h('a', { class: 'btn btn-quiet', href: '#/stock/suppliers' }, 'Catalogue'));
  }
  if (manage && setup) {
    actions.push(h('a', { class: 'btn btn-quiet', href: '#/stock' }, '← Stock'));
    if (tab === 'suppliers' && can('catalogue')) actions.push(h('button', { class: 'btn btn-primary', onclick: () => supplierDialog(null, () => refresh()) }, 'Add supplier'));
    if (tab === 'categories' && can('catalogue')) actions.push(h('button', { class: 'btn btn-primary', onclick: () => categoryDialog(null, () => refresh()) }, 'Add category'));
  }
  mount(body, await ({ items: itemsTab, reports: reportsTab, suggestions: suggestionsTab, deliveries: deliveriesTab, adjustments: adjustmentsTab, usage: usageTab, movements: movementsTab, suppliers: suppliersTab, categories: categoriesTab }[tab] || itemsTab)(manage));
  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, setup ? 'Catalogue' : 'Stock'), h('p', {}, setup ? 'Suppliers and categories – set up once, rarely changed.' : manage ? 'What is in the store, how fast it goes, and when it runs out.' : 'Tap an item that is running low or finished to report it.')),
      h('div', { class: 'page-actions' }, actions)),
    tabBar, body);
}

/* ---------------- shared loaders ---------------- */
async function loadStats() {
  const { data } = await sb.rpc('item_usage_stats');
  const map = {}; for (const s of data || []) map[s.item_id] = s; return map;
}
function paceBadge(s) {
  if (!s) return null;
  const p = PACE[s.pace] || PACE.normal;
  if (s.pace === 'normal') return null;
  return h('span', { class: `pill ${p.pill}`, title: p.hint, style: { marginLeft: '6px' } }, p.label);
}
function runoutCell(i, s) {
  if (!s || s.runout_date == null) return h('td', { class: 'num muted' }, Number(i.qty_on_hand) <= 0 ? 'Out' : '—');
  const days = Number(s.days_of_cover);
  const soon = days <= 14;
  return h('td', { class: 'num', style: { color: Number(i.qty_on_hand) <= 0 ? 'var(--red)' : soon ? 'var(--amber)' : '', fontWeight: soon ? 600 : 400 } },
    Number(i.qty_on_hand) <= 0 ? 'Out' : `${fmtDate(s.runout_date)}`, h('div', { class: 'muted', style: { fontSize: '.78rem', fontWeight: 400 } }, `${days} day${days === 1 ? '' : 's'} left`));
}

/* ---------------- items ---------------- */
async function itemsTab(manage) {
  const [{ data: items }, { data: cats }, { data: sups }, stats] = await Promise.all([
    scoped(sb.from('items').select('*')).order('name'), sb.from('categories').select('*'), sb.from('suppliers').select('*'), loadStats(),
  ]);
  const catName = (id) => cats.find((c) => c.id === id)?.name || '—';
  const supName = (id) => sups.find((s) => s.id === id)?.name || '—';
  let search = ''; let showInactive = false; let filter = 'all';
  const wrap = h('div', {});
  const low = (i) => { const s = stats[i.id]; return i.active && ( Number(i.qty_on_hand) <= 0 || (Number(i.reorder_level) > 0 && Number(i.qty_on_hand) < Number(i.reorder_level)) || (s?.days_of_cover != null && Number(s.days_of_cover) <= 14)); };
  function draw() {
    const rows = items.filter((i) => (showInactive ? !i.active : i.active) && (!search || `${i.name} ${i.sku || ''} ${catName(i.category_id)}`.toLowerCase().includes(search))
      && (filter === 'all' || filter === 'inactive' || (filter === 'low' ? low(i) : filter === 'recurring' ? i.recurring : stats[i.id]?.pace === filter)));
    const totalValue = rows.reduce((s, i) => s + Number(i.qty_on_hand) * Number(i.last_unit_price || 0), 0);
    mount(wrap, rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'ledger compact' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', { class: 'num' }, 'On hand'), manage ? h('th', { class: 'num hide-xs' }, 'Per month') : null, h('th', { class: 'num' }, 'Runs out'), h('th'))),
      h('tbody', {}, rows.map((i) => {
        const s = stats[i.id];
        return h('tr', { class: `item-row${low(i) ? ' low' : ''}`, onclick: () => (manage ? itemSheet(i, s, { catName, supName, sups }) : reportDialog(i)) },
          h('td', {}, h('div', { class: 'item-cell' }, itemThumb(i), h('div', {}, h('strong', {}, i.name), paceBadge(s), manage && i.tracking === 'issued' ? h('span', { class: 'pill pill-purple', style: { marginLeft: '6px' }, title: 'Recorded at each hand-out; a count difference is a variance' }, 'Issued') : null, !i.active ? h('span', { class: 'pill pill-grey', style: { marginLeft: '6px' } }, 'inactive') : null,
            manage ? h('div', { class: 'muted', style: { fontSize: '.8rem' } }, [catName(i.category_id), i.recurring ? 'monthly' : null].filter((x) => x && x !== '—').join(' · ')) : null))),
          h('td', { class: 'num amt' }, `${units(i.qty_on_hand, i.unit)}`),
          manage ? h('td', { class: 'num hide-xs' }, s && Number(s.used_per_month) > 0 ? qty(s.used_per_month) : h('span', { class: 'muted' }, '—')) : null,
          runoutCell(i, s),
          h('td', { class: 'num chev' }, manage ? '›' : 'Report ›'));
      })),
      manage ? h('tfoot', {}, h('tr', {}, h('td', { colspan: 3 }, `${rows.length} item${rows.length === 1 ? '' : 's'}`), h('td', { class: 'num' }, money(totalValue)), h('td'))) : null))
      : emptyState('Nothing here', manage ? (items.length ? 'No items match this filter.' : 'Add the things you buy regularly – paper, cleaning supplies, toner.') : 'The stock manager has not added items yet.'));
  }
  draw();
  const chips = manage ? [['all', 'All'], ['low', 'Running low'], ['recurring', 'Monthly'], ['fast', 'Fast'], ['slow', 'Slow'], ['inactive', 'Inactive']] : [['all', 'All'], ['low', 'Running low']];
  const chipBar = h('div', { class: 'tabs', style: { borderBottom: 0, marginBottom: '6px' } });
  const drawChips = () => mount(chipBar, chips.map(([k, l]) => h('button', { class: k === filter ? 'active' : '', onclick: () => { filter = k; showInactive = k === 'inactive'; drawChips(); draw(); } }, l)));
  drawChips();
  const noPhoto = items.filter((i) => i.active && !(i.photos || []).length).length;
  return h('div', {},
    can('catalogue') && noPhoto ? h('div', { class: 'banner banner-grey', id: 'no-photo-count' }, h('strong', {}, `${noPhoto} item${noPhoto === 1 ? '' : 's'} without a photo`), 'A photo helps everyone pick the right item. Tap an item, then “Add a photo”.') : null,
    items.length > 8 ? h('div', { class: 'toolbar' }, h('input', { class: 'input', placeholder: 'Search items', oninput: (e) => { search = e.target.value.toLowerCase(); draw(); } })) : null,
    chipBar,
    h('div', { class: 'sheet' }, wrap),
    manage ? onceHint('stock-usage', 'Usage is measured from quick counts, “Used” entries and issues; “Runs out” projects that rate over what is on hand. Tap an item to record use, issue, receive or edit it.') : null);
}

/** One item: the numbers that matter, and the four things you can do with it. */
function itemSheet(i, s, { catName, supName, sups }) {
  modal(i.name, (close) => {
    const done = () => { close(); refresh(); };
    const stat = (k, v) => h('div', { class: 'stat' }, h('span', { class: 'k' }, k), h('span', { class: 'v', style: { fontSize: '1.1rem' } }, v));
    return h('div', {},
      itemPhotos(i, { canEdit: can('catalogue') }),
      h('div', { class: 'row', style: { marginBottom: '10px' } },
        stat('On hand', `${units(i.qty_on_hand, i.unit)}`),
        stat('Used / month', s && Number(s.used_per_month) > 0 ? qty(s.used_per_month) : '—'),
        stat('Runs out', s?.runout_date ? fmtDate(s.runout_date) : Number(i.qty_on_hand) <= 0 ? 'Out' : '—'),
        stat('Last price', i.last_unit_price != null ? money(i.last_unit_price) : '—')),
      h('dl', { class: 'kv', style: { marginBottom: '14px' } },
        h('dt', {}, 'Category'), h('dd', {}, catName(i.category_id)),
        h('dt', {}, 'Supplier'), h('dd', {}, supName(i.preferred_supplier_id)),
        i.recurring ? [h('dt', {}, 'Monthly'), h('dd', {}, `expect ${units(i.expected_monthly_qty, i.unit)}`)] : null,
        Number(i.reorder_level) > 0 ? [h('dt', {}, 'Reorder at'), h('dd', {}, `${units(i.reorder_level, i.unit)}`)] : null,
        s?.pace && s.pace !== 'normal' ? [h('dt', {}, 'Pace'), h('dd', {}, (PACE[s.pace] || PACE.normal).label)] : null),
      h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } },
        h('button', { class: 'btn btn-primary', onclick: () => { close(); usageDialog(i, () => refresh()); } }, 'Used'),
        h('button', { class: 'btn', onclick: () => { close(); issueDialog(i, () => refresh()); } }, 'Issue to someone'),
        h('button', { class: 'btn', onclick: () => { close(); receiveDialog(i, sups, () => refresh()); } }, 'Receive'),
        h('button', { class: 'btn btn-quiet', onclick: () => { close(); correctDialog(i, () => refresh()); } }, 'Correct'),
        can('catalogue') ? h('button', { class: 'btn btn-quiet', onclick: () => { close(); itemDialog(i, done); } }, 'Edit') : null));
  });
}

/* ---------------- suggestions for the store (053) ---------------- */
const SUG_STATUS = { with_stock: ['pill-amber', 'With the stock controller'], with_gm: ['pill-purple', 'With the GM'], approved: ['pill-green', 'Added to the store'], declined: ['pill-red', 'Not added'], withdrawn: ['pill-grey', 'Withdrawn'] };
async function suggestionsTab() {
  const { data } = await scoped(sb.from('item_suggestions').select('*')).order('created_at', { ascending: false }).limit(100);
  const list = data || [];
  const me = state.me.id;
  const mineToDo = (x) => x.suggested_by !== me && ((x.status === 'with_stock' && state.me.role === 'stock_manager') || (x.status === 'with_gm' && state.me.role === 'approver'));
  const order = [...list].sort((a, b) => Number(mineToDo(b)) - Number(mineToDo(a)));
  const card = async (x) => {
    const [pill, label] = SUG_STATUS[x.status] || ['pill-grey', x.status];
    const u = x.photo_path ? await photoUrl(x.photo_path) : null;
    const acts = [];
    if (mineToDo(x)) {
      const final = x.status === 'with_gm' || x.suggested_role === 'approver';
      const ok = h('button', { class: 'btn btn-primary btn-sm', 'data-act': 'ok' }, final ? 'Approve – add to the store' : 'Agree – send to the GM');
      ok.onclick = busy(ok, async () => {
        const n = await confirmDialog(final ? `Add ${x.name} to the store?` : `Agree to stock ${x.name}?`, final ? 'It goes into the catalogue; you then set the reorder level and supplier, and order it with the next restock.' : 'The GM gives the final approval.', { ok: final ? 'Approve' : 'Agree', note: { label: 'Note (optional)' } });
        if (n === null) return; await rpc('review_item_suggestion', { p_id: x.id, p_ok: true, p_note: n || null }); toast(final ? `${x.name} added to the store.` : 'Sent to the GM.'); refresh();
      });
      const no = h('button', { class: 'btn btn-sm btn-quiet btn-danger', 'data-act': 'no' }, 'Decline');
      no.onclick = busy(no, async () => {
        const n = await confirmDialog(`Decline ${x.name}?`, `${personName(x.suggested_by)} sees your reason.`, { ok: 'Decline', danger: true, note: { label: 'Why', required: true } });
        if (!n) return; await rpc('review_item_suggestion', { p_id: x.id, p_ok: false, p_note: n }); toast('Declined.'); refresh();
      });
      acts.push(ok, no);
    }
    if (x.suggested_by === me && ['with_stock', 'with_gm'].includes(x.status)) {
      const w = h('button', { class: 'btn btn-sm btn-quiet' }, 'Withdraw');
      w.onclick = busy(w, async () => { if (!(await confirmDialog('Withdraw your suggestion?', 'It is no longer considered.', { ok: 'Withdraw' }))) return; await rpc('withdraw_item_suggestion', { p_id: x.id }); toast('Withdrawn.'); refresh(); });
      acts.push(w);
    }
    const why = x.status === 'declined' ? (x.gm_note || x.stock_note) : null;
    return h('li', { class: `sug${mineToDo(x) ? ' sug-todo' : ''}` },
      u ? h('a', { href: u, target: '_blank', rel: 'noopener', class: 'sug-pic' }, h('img', { src: u, alt: x.name, loading: 'lazy' })) : null,
      h('div', { class: 'what' },
        h('strong', {}, x.name, ' ', h('span', { class: `pill ${pill}` }, label)),
        h('span', {}, `${personName(x.suggested_by)}${multiBranch() ? ` · ${branchName(x.branch_id)}` : ''} · ${fmtDate(x.created_at)}${x.monthly_qty ? ` · about ${qty(x.monthly_qty)} a month` : ''}${x.est_price ? ` · about ${money(x.est_price)} each` : ''}${x.where_to_buy ? ` · ${x.where_to_buy}` : ''}`),
        h('span', { class: 'sug-reason' }, `“${x.reason}”`),
        x.stock_note && x.status !== 'declined' ? h('span', { class: 'muted' }, `Stock controller: ${x.stock_note}`) : null,
        why ? h('span', { style: { color: 'var(--red)' } }, `Why not: ${why}`) : null,
        acts.length ? h('div', { class: 'form-actions', style: { justifyContent: 'flex-start', margin: '6px 0 0' } }, acts) : null));
  };
  return h('div', {},
    h('p', { class: 'hint' }, 'Something the store should keep? Suggest it with a good reason. The stock controller checks it, then the GM approves it.'),
    h('div', { class: 'sheet' }, list.length ? h('ul', { class: 'ledger-list sug-list', id: 'suggestions' }, await Promise.all(order.map(card)))
      : emptyState('No suggestions yet', 'Tap “Suggest an item” for something the store should keep.')));
}

export function suggestDialog() {
  modal('Suggest an item for the store', async (close) => {
    const [{ data: items }, { data: cats }, { data: open }] = await Promise.all([
      scoped(sb.from('items').select('id, name, unit, qty_on_hand, photos')).eq('active', true).order('name'),
      sb.from('categories').select('*').eq('active', true).order('name'),
      scoped(sb.from('item_suggestions').select('id, name, status, suggested_by')).in('status', ['with_stock', 'with_gm']),
    ]);
    const name = h('input', { class: 'input', id: 'sug-name', maxlength: 80, placeholder: 'e.g. Sticky notes, yellow 76 × 76 mm' });
    const already = h('div', { id: 'sug-already' });
    name.addEventListener('input', () => {
      const t = name.value.trim();
      const hits = t.length >= 3 ? storeMatches(t, items || []).slice(0, 3) : [];
      const waiting = t.length >= 3 ? (open || []).filter((x) => x.name.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(x.name.toLowerCase())).slice(0, 2) : [];
      mount(already, hits.length || waiting.length ? h('div', { class: 'banner banner-amber' },
        hits.length ? [h('strong', {}, 'Already in the store'), h('ul', { class: 'plain-list' }, hits.map((i) => h('li', { class: 'item-cell' }, itemThumb(i, { size: 28 }), `${i.name} · ${units(i.qty_on_hand, i.unit)} on hand`)))] : null,
        waiting.length ? [h('strong', {}, 'Already suggested'), h('ul', { class: 'plain-list' }, waiting.map((x) => h('li', {}, `${x.name} · ${SUG_STATUS[x.status][1].toLowerCase()}`)))] : null) : null);
    });
    const reason = h('textarea', { class: 'input', id: 'sug-reason', rows: 3, placeholder: 'e.g. Reception buys these every week from their own pocket; we use about two packs a week.' });
    const monthly = h('input', { class: 'input num', id: 'sug-qty', type: 'number', min: 0, step: 'any', inputmode: 'decimal' });
    const price = h('input', { class: 'input num', id: 'sug-price', type: 'number', min: 0, step: '0.01', inputmode: 'decimal' });
    const where = h('input', { class: 'input', id: 'sug-where', maxlength: 80, placeholder: 'e.g. Pick n Pay, or a website' });
    const cat = select([['', 'Not sure'], ...(cats || []).filter((c) => c.kind !== 'cash').map((c) => [c.id, c.name])], '');
    let photo = null;
    const photoIn = h('input', { type: 'file', accept: 'image/*' });
    const photoLabel = h('label', { class: 'upload', id: 'sug-photo' }, photoIn, '📷 Add a photo (recommended)');
    photoIn.onchange = async () => {
      const f = photoIn.files?.[0]; if (!f) return;
      photoLabel.lastChild.textContent = 'Uploading…';
      try { photo = await uploadPhoto(f, `suggestions/${state.me.id}`); photoLabel.lastChild.textContent = '✓ Photo added – tap to change'; }
      catch (e) { photoLabel.lastChild.textContent = '📷 Add a photo (recommended)'; toast(e.message, { error: true }); }
    };
    const err = h('div', { class: 'error' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send the suggestion');
    const go = busy(b, async () => {
      err.textContent = '';
      if (name.value.trim().length < 2) { err.textContent = 'Say what the item is.'; name.focus(); return; }
      if (reason.value.trim().length < 20) { err.textContent = 'Say why the store should keep it, in a full sentence.'; reason.focus(); return; }
      try {
        const r = await rpc('suggest_item', { p_name: name.value.trim(), p_reason: reason.value.trim(), p_monthly_qty: num(monthly.value) || null, p_price: price.value === '' ? null : num(price.value),
          p_where: where.value.trim() || null, p_photo: photo, p_category: cat.value || null });
        toast(r.status === 'with_gm' ? 'Sent to the GM for approval.' : 'Sent to the stock controller. You are told at each step.', { ms: 5000 });
        close(); location.hash = '#/stock/suggestions'; refresh();
      } catch (e) { err.textContent = e.message; }
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      field('What is the item?', h('div', {}, name, already)),
      field('Why should the store keep it?', reason, 'Required. Who needs it, how often, and what happens now without it.'),
      h('div', { class: 'row' }, field('About how many a month', monthly, 'Optional'), field('Price each (about)', price, 'Optional')),
      h('div', { class: 'row' }, field('Where to buy it', where, 'Optional'), field('Category', cat)),
      field('Photo', photoLabel, 'Optional, but it helps the stock controller buy the right one.'),
      h('p', { class: 'hint' }, 'The stock controller checks it, then the GM gives the final approval. You are told at each step.'),
      err, h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

/* ---------------- low-stock reports from the team ---------------- */
export function reportDialog(item) {
  modal(item ? `Report: ${item.name}` : 'Report low stock', async (close) => {
    const items = item ? [item] : (await scoped(sb.from('items').select('id, name, unit, qty_on_hand, photos')).eq('active', true).order('name')).data || [];
    const sel = select([['', 'Choose an item…'], ...items.map((i) => [i.id, `${i.name} (${units(i.qty_on_hand, i.unit)} on the books)`])], item?.id || '', { disabled: !!item });
    const pic = h('div', { class: 'report-pic' });
    const drawPic = () => { const it = items.find((x) => x.id === sel.value); mount(pic, it && (it.photos || []).length ? [itemThumb(it, { size: 72 }), h('span', { class: 'hint' }, 'Is this the one?')] : null); };
    sel.addEventListener('change', drawPic); drawPic();
    let level = 'low';
    const lvl = h('div', { class: 'tabs', style: { marginBottom: '12px' } });
    const drawLvl = () => mount(lvl, [['low', 'Running low'], ['out', 'Completely out']].map(([k, l]) => h('button', { type: 'button', class: k === level ? 'active' : '', onclick: () => { level = k; drawLvl(); } }, l)));
    drawLvl();
    const note = h('input', { class: 'input', placeholder: 'e.g. last box opened this morning (optional)' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send to the stock manager');
    const go = busy(b, async () => {
      if (!sel.value) throw new Error('Choose the item.');
      await rpc('report_stock', { p_item: sel.value, p_level: level, p_note: note.value });
      toast('Reported – the stock manager has been told.'); close(); refresh();
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      field('Item', picker(sel, { top: item ? [] : await myTopReported().catch(() => []), topLabel: 'You report these most', placeholder: 'Type the item…', min: 6 })), pic, h('div', { class: 'field' }, h('label', {}, 'How bad is it?'), lvl), field('Note', note),
      h('p', { class: 'hint' }, 'Need something from the store right now? Ask the stock manager – they hand it over and log it.'),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

async function reportsTab(manage) {
  let q = sb.from('stock_reports').select('*, item:items!inner(name, unit, qty_on_hand, recurring, branch_id)').order('created_at', { ascending: false }).limit(300);
  if (state.view) q = q.eq('item.branch_id', state.view);
  if (!manage) q = q.eq('reported_by', state.me.id);
  const rows = unwrap(await q);
  const open = rows.filter((r) => !r.resolved_at); const done = rows.filter((r) => r.resolved_at).slice(0, 30);
  const chosen = new Set();
  const list = h('div', {});
  const toolbar = h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } });
  function drawToolbar() {
    const ids = [...chosen];
    const add = h('button', { class: 'btn btn-primary', disabled: !ids.length }, ids.length ? `Add ${ids.length} to a restock order` : 'Add to a restock order');
    add.onclick = busy(add, async () => { const r = await rpc('restock_from_reports', { p_reports: ids }); toast('Added to your draft restock order – check quantities, then submit.'); location.hash = `#/requests/${r.id}/edit`; });
    const sorted = h('button', { class: 'btn', disabled: !ids.length }, 'Mark sorted');
    sorted.onclick = busy(sorted, async () => {
      const n = await confirmDialog('Mark as sorted', `${ids.length} report${ids.length === 1 ? '' : 's'}. The people who reported will be told.`, { ok: 'Mark sorted', note: { label: 'What was done', placeholder: 'e.g. issued from the store / already on order' } });
      if (n === null) return; for (const id of ids) await rpc('resolve_report', { p_report: id, p_note: n }); toast('Marked sorted.'); refresh();
    });
    mount(toolbar, add, sorted);
  }
  // group open reports by item so three people reporting the same thing reads as one line
  const byItem = {};
  for (const r of open) (byItem[r.item_id] ||= { item: r.item, item_id: r.item_id, reports: [] }).reports.push(r);
  const groups = Object.values(byItem).sort((a, b) => (b.reports.some((r) => r.level === 'out') ? 1 : 0) - (a.reports.some((r) => r.level === 'out') ? 1 : 0) || b.reports.length - a.reports.length);
  function draw() {
    mount(list, groups.length ? h('ul', { class: 'ledger-list' }, groups.map((g) => {
      const out = g.reports.some((r) => r.level === 'out');
      // asked for through a cash request: a quantity, for something the store has
      const needed = g.reports.some((r) => r.qty) && Number(g.item?.qty_on_hand) > 0;
      const cb = manage ? h('label', { class: 'tap' }, h('input', { type: 'checkbox', checked: g.reports.every((r) => chosen.has(r.id)), onchange: (e) => { for (const r of g.reports) e.target.checked ? chosen.add(r.id) : chosen.delete(r.id); drawToolbar(); } })) : null;
      const onOrder = g.reports.find((r) => r.request_id);
      return h('li', { style: { alignItems: 'flex-start' } }, cb,
        h('div', { class: 'what' }, h('strong', {}, g.item?.name || 'Item', ' ', h('span', { class: `pill ${needed ? 'pill-blue' : out ? 'pill-red' : 'pill-amber'}` }, needed ? 'Needed' : out ? 'Out' : 'Running low'), onOrder ? h('a', { class: 'pill pill-blue', href: `#/requests/${onOrder.request_id}`, style: { marginLeft: '6px', textDecoration: 'none' } }, 'on a restock order') : null),
          h('span', { style: { whiteSpace: 'normal' } }, `${g.item ? `${units(g.item.qty_on_hand, g.item.unit)} on the books · ` : ''}${g.reports.map((r) => `${personName(r.reported_by)}${r.qty ? ` needs ${qty(r.qty)}` : ''} ${fmtDate(r.created_at)}${r.note ? ` – “${r.note}”` : ''}`).join(' · ')}`)),
        manage ? h('span', { class: 'amt' }, g.reports.length > 1 ? `${g.reports.length} reports` : '') : null);
    })) : emptyState(manage ? 'Nothing reported' : 'No open reports', manage ? 'When someone on the team reports an item running low or out, it shows here.' : 'Use “Report low / out” when you notice something is finishing.'));
  }
  draw(); if (manage) drawToolbar();
  return h('div', {},
    manage ? onceHint('stock-reports', 'The team reports; you decide. Tick what to buy and add it to a restock order (approver, then finance), or mark it sorted if the store covers it. Receiving stock clears the report automatically.') : null,
    h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, manage ? 'Open reports' : 'Open'), h('span', { class: 'sub' }, open.length)), list, manage && groups.length ? toolbar : null),
    done.length ? h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Sorted recently')),
      h('ul', { class: 'ledger-list' }, done.map((r) => h('li', {}, h('div', { class: 'what' }, h('strong', {}, r.item?.name || 'Item'), h('span', {}, `${r.qty ? `Needed ${qty(r.qty)}` : r.level === 'out' ? 'Out' : 'Low'} · reported by ${personName(r.reported_by)} ${fmtDate(r.created_at)} · ${r.resolution || 'sorted'} ${fmtDate(r.resolved_at)}${r.resolved_by ? ` by ${personName(r.resolved_by)}` : ''}`)))))) : null);
}

/* ---------------- usage ---------------- */
async function usageTab(manage) {
  const months = []; const now = new Date();
  for (let i = 5; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push(isoDate(d).slice(0, 7)); }
  const since = months[0] + '-01';
  const [{ data: items }, stats, { data: monthly }, { data: runouts }] = await Promise.all([
    scoped(sb.from('items').select('*')).eq('active', true).order('name'), loadStats(),
    sb.from('v_item_monthly_usage').select('*').gte('month', since), sb.from('v_item_runouts').select('*').gte('ran_out_on', since),
  ]);
  const mk = (d) => String(d).slice(0, 7);
  const used = {}; const bought = {}; const ranOut = {};
  for (const r of monthly || []) { used[r.item_id + mk(r.month)] = Number(r.used); bought[r.item_id + mk(r.month)] = Number(r.bought); }
  for (const r of runouts || []) { const k = r.item_id + mk(r.ran_out_on); (ranOut[k] ||= []).push(new Date(r.ran_out_on + 'T00:00:00').getDate()); }
  const order = { fast: 0, normal: 1, slow: 2, dormant: 3 };
  const rows = items.slice().sort((a, b) => (a.recurring === b.recurring ? (order[stats[a.id]?.pace] ?? 1) - (order[stats[b.id]?.pace] ?? 1) || a.name.localeCompare(b.name) : a.recurring ? -1 : 1));
  const short = (k) => new Date(k + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short' });
  const ordinal = (n) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

  const counts = { fast: 0, slow: 0, dormant: 0, normal: 0 };
  for (const i of items) counts[stats[i.id]?.pace || 'dormant']++;
  const sel = select(items.map((i) => [i.id, i.name]), items.find((i) => stats[i.id]?.pace === 'fast')?.id || items[0]?.id);
  const chartBox = h('div', {});
  const drawChart = () => {
    const id = sel.value; if (!id) return mount(chartBox, emptyState('No items yet'));
    mount(chartBox, barChart(null, { labels: months.map(short), values: months.map((m) => used[id + m] || 0), line: months.map((m) => bought[id + m] || 0), lineName: 'Bought', barName: 'Used', format: (v) => qty(v) }));
  };
  sel.onchange = drawChart; drawChart();

  return h('div', {},
    h('div', { class: 'grid-3' },
      h('div', { class: 'sheet stat' }, h('span', { class: 'k' }, 'Fast movers'), h('span', { class: 'v' }, counts.fast, h('small', {}, 'a month\'s order lasts under 2 weeks'))),
      h('div', { class: 'sheet stat' }, h('span', { class: 'k' }, 'Slow movers'), h('span', { class: 'v' }, counts.slow, h('small', {}, 'over 4 months, or untouched for 60 days'))),
      h('div', { class: 'sheet stat' }, h('span', { class: 'k' }, 'Running out within 14 days'), h('span', { class: 'v' }, items.filter((i) => stats[i.id]?.days_of_cover != null && Number(stats[i.id].days_of_cover) <= 14).length))),
    h('div', { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('h2', {}, 'Usage by month'), h('span', { class: 'sub' }, 'units used, and the day of the month it ran out')),
      rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', { class: 'num' }, 'On hand'), h('th', { class: 'num' }, 'Used / month'), h('th', { class: 'num' }, 'Days left'), months.map((m) => h('th', { class: 'num' }, short(m))))),
        h('tbody', {}, rows.map((i) => { const s = stats[i.id]; const p = PACE[s?.pace || 'dormant'];
          return h('tr', {}, h('td', {}, h('strong', {}, i.name), h('span', { class: `pill ${p.pill}`, style: { marginLeft: '6px' }, title: p.hint }, p.label), i.recurring ? h('div', { class: 'muted', style: { fontSize: '.78rem' } }, `expected ${qty(i.expected_monthly_qty)} / month`) : null),
            h('td', { class: 'num amt' }, `${units(i.qty_on_hand, i.unit)}`),
            h('td', { class: 'num' }, s && Number(s.used_per_month) > 0 ? qty(s.used_per_month) : h('span', { class: 'muted' }, '—')),
            h('td', { class: 'num', style: { color: s?.days_of_cover != null && Number(s.days_of_cover) <= 14 ? 'var(--amber)' : '' } }, s?.days_of_cover != null ? `${qty(s.days_of_cover)}` : '—'),
            months.map((m) => { const u = used[i.id + m]; const ro = ranOut[i.id + m];
              return h('td', { class: 'num' }, u ? qty(u) : h('span', { class: 'muted' }, '—'), ro ? h('div', { style: { fontSize: '.75rem', color: 'var(--red)' } }, `out ${ro.map(ordinal).join(', ')}`) : null); })); })))) : emptyState('No items yet')),
    h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Used against bought'), sel), chartBox),
    manage ? h('p', { class: 'hint' }, 'To keep this accurate, do a quick count once a week: tick off what is actually on the shelf and the difference is logged as usage.') : null);
}

/* ---------------- quick count ---------------- */
const ITEMS_CACHE = 'pcs_items_cache';
function quickCountDialog() {
  modal('Quick count', async (close) => {
    // works without signal: the item list is cached on the phone and the count is queued until there is a connection
    let items = null; let offline = !navigator.onLine;
    if (!offline) {
      const { data, error } = await scoped(sb.from('items').select('id, name, unit, qty_on_hand, recurring, active, tracking')).eq('active', true).order('name');
      if (error && /No connection|Failed to fetch|NetworkError/i.test(error.message)) offline = true;
      else if (error) throw new Error(error.message);
      else { items = data; try { localStorage.setItem(ITEMS_CACHE, JSON.stringify({ at: new Date().toISOString(), items })); } catch {} }
    }
    if (!items) {
      let cached = null; try { cached = JSON.parse(localStorage.getItem(ITEMS_CACHE) || 'null'); } catch {}
      if (!cached) throw new Error('No connection, and the item list has not been loaded on this device yet. Open Stock once while online.');
      items = cached.items; offline = true;
    }
    let onlyRecurring = items.some((i) => i.recurring);
    const date = h('input', { class: 'input', type: 'date', value: today(), max: today() });
    const note = h('input', { class: 'input', placeholder: 'e.g. Friday count' });
    const inputs = new Map();
    const tbody = h('tbody', {});
    function draw() {
      mount(tbody, items.filter((i) => !onlyRecurring || i.recurring).map((i) => {
        let inp = inputs.get(i.id);
        if (!inp) { inp = h('input', { class: 'input num', type: 'number', min: 0, step: 'any', placeholder: qty(i.qty_on_hand), inputmode: 'decimal' }); inputs.set(i.id, inp); }
        return h('tr', {}, h('td', {}, i.name, i.tracking === 'issued' ? h('span', { class: 'pill pill-purple', style: { marginLeft: '6px' } }, 'Issued') : null, h('div', { class: 'muted', style: { fontSize: '.78rem' } }, i.unit)), h('td', { class: 'num muted' }, qty(i.qty_on_hand)), h('td', { class: 'num', style: { width: '110px' } }, inp));
      }));
    }
    draw();
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save count');
    const go = busy(b, async () => {
      const lines = [];
      for (const [id, inp] of inputs) if (inp.value !== '' && inp.isConnected) lines.push({ item_id: id, counted: num(inp.value) });
      if (!lines.length) throw new Error('Enter a counted quantity for at least one item. Leave the others blank.');
      const args = { p_lines: lines, p_on: date.value, p_note: note.value };
      const park = () => { const n = queueOffline('quick_count', args); toast(`No connection – count saved on this device (${n} waiting). It will be sent when you are back online.`, { ms: 6000 }); close(); refresh(); };
      if (offline || !navigator.onLine) return park();
      let n;
      try { n = await rpc('quick_count', args); }
      catch (e) { if (/No connection/.test(e.message)) return park(); throw e; }
      const waiting = Math.floor((n || 0) / 1000), changed = (n || 0) % 1000;
      toast(!changed ? 'Count saved – everything matched the book.' : waiting ? `Count saved – ${changed} item${changed === 1 ? '' : 's'} differ; ${waiting} above the correction limit wait${waiting === 1 ? 's' : ''} for the GM.` : `Count saved – ${changed} item${changed === 1 ? '' : 's'} adjusted.`, { ms: waiting ? 7000 : 4000 }); close(); refresh();
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      offline ? h('div', { class: 'banner banner-amber' }, h('strong', {}, 'You are offline'), 'Book quantities are from the last time this phone was online. The count is kept here and sent later.') : null,
      h('p', { class: 'hint' }, `Type what is actually on the shelf. Anything you leave blank is skipped. For counted items, less than the book is logged as used. For issued items a difference is a variance: within ${money(state.settings?.stock_adjust_limit || 0)} it is applied and logged; above that the GM approves it first.`),
      h('div', { class: 'row' }, field('Counted on', date), field('Note', note)),
      h('label', { class: 'check', style: { marginBottom: '10px' } }, h('input', { type: 'checkbox', checked: onlyRecurring, onchange: (e) => { onlyRecurring = e.target.checked; draw(); } }), 'Monthly items only'),
      h('div', { class: 'table-wrap lines-edit' }, h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', { class: 'num' }, 'Book'), h('th', { class: 'num' }, 'Counted'))), tbody)),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  }, { wide: true });
}

/** A manual correction with a reason: within the limit it applies at once; above it the GM approves first. */
function correctDialog(item, done) {
  modal(`Correct: ${item.name}`, (close) => {
    const limit = Number(state.settings?.stock_adjust_limit || 0);
    const q = h('input', { class: 'input num', type: 'number', min: 0, step: 'any', value: qty(item.qty_on_hand), inputmode: 'decimal' });
    const note = h('input', { class: 'input', placeholder: 'e.g. Two boxes water-damaged', required: true });
    const line = h('p', { class: 'hint' });
    const draw = () => { const d = num(q.value) - Number(item.qty_on_hand); const v = Math.abs(d) * Number(item.last_unit_price || 0);
      mount(line, d === 0 ? 'No change.' : `${d < 0 ? `${qty(-d)} fewer` : `${qty(d)} more`} than the book – worth ${money(v)}. ${v > limit && !can('admin') ? `Above the ${money(limit)} limit: the General Manager approves it before the balance changes.` : 'Applied at once and logged.'}`); };
    q.oninput = draw; draw();
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save correction');
    const go = busy(b, async () => {
      const mv = await rpc('adjust_stock', { p_item: item.id, p_new_qty: num(q.value), p_note: note.value.trim() });
      toast(mv ? 'Correction applied and logged.' : 'Sent to the General Manager to approve. The balance changes once approved.', { ms: mv ? 4000 : 6000 }); close(); done();
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('p', { class: 'hint' }, `${units(item.qty_on_hand, item.unit)} on the book. A correction is for breakage, loss or a counting mistake – not for things handed out (use Issue) or used up (use Used).`),
      h('div', { class: 'row' }, field('Actually on hand', q), field('Reason', note)), line,
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

/* ---------------- deliveries: what was bought against what arrived ---------------- */
async function deliveriesTab() {
  const q = state.view ? sb.from('stock_receipts').select('*, item:items!inner(name, unit, branch_id)').eq('item.branch_id', state.view) : sb.from('stock_receipts').select('*, item:items(name, unit, branch_id)');
  const { data } = await q.neq('status', 'void').order('created_at', { ascending: false }).limit(200);
  const rows = data || [];
  const ids = [...new Set(rows.map((r) => r.request_id).filter(Boolean))];
  const { data: reqs } = ids.length ? await sb.from('requests').select('id, request_no, purpose').in('id', ids) : { data: [] };
  const reqOf = (id) => (reqs || []).find((r) => r.id === id);
  const open = rows.filter((r) => r.status === 'to_check'); const done = rows.filter((r) => r.status !== 'to_check');
  const limit = Number(state.settings?.stock_adjust_limit || 0);
  const row = (r) => { const rq = reqOf(r.request_id); const val = Number(r.qty_bought) * Number(r.unit_cost || 0);
    return h('li', { class: rq ? 'click' : '', onclick: rq ? () => { location.hash = `#/requests/${rq.id}`; } : null },
      h('div', { class: 'what' }, h('strong', {}, `${r.item?.name || 'Item'} · ${units(r.qty_bought, r.item?.unit)} bought`),
        h('span', {}, `${rq ? `#${rq.request_no} ${rq.purpose} · ` : ''}by ${personName(r.bought_by)}, ${fmtDate(r.created_at)}${val ? ` · ${money(val)}` : ''}`),
        r.status !== 'to_check' ? h('span', { style: { display: 'block' } }, `${qty(r.qty_received)} arrived · checked by ${personName(r.checked_by)}, ${fmtDate(r.checked_at)}${r.note ? ` – “${r.note}”` : ''}`) : null),
      r.status === 'to_check' ? h('div', { class: 'row-actions', onclick: (e) => e.stopPropagation() }, h('button', { class: 'btn btn-sm btn-primary', onclick: () => confirmReceiptDialog(r, rq) }, 'Confirm arrival'))
        : h('span', { class: `pill ${r.status === 'short' ? 'pill-red' : 'pill-green'}` }, r.status === 'short' ? `${qty(Number(r.qty_bought) - Number(r.qty_received))} short` : 'Arrived in full')); };
  return h('div', {},
    h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'To check'), h('span', { class: 'sub' }, open.length)),
      h('p', { class: 'hint' }, `Goods bought for the store are confirmed by the controller when they arrive. Where the controller bought them and the value is above ${money(limit)}, the GM or finance confirms instead. A shortfall is flagged to the GM and finance.`),
      open.length ? h('ul', { class: 'ledger-list' }, open.map(row)) : emptyState('Nothing waiting', 'Each purchase for the store appears here once its receipt is recorded.')),
    done.length ? h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Checked'), h('span', { class: 'sub' }, 'latest first')), h('ul', { class: 'ledger-list' }, done.slice(0, 40).map(row))) : null);
}
export function confirmReceiptDialog(r, rq) {
  modal(`Delivery: ${r.item?.name || 'item'}`, (close) => {
    const got = h('input', { class: 'input num', type: 'number', min: 0, max: r.qty_bought, step: 'any', value: qty(r.qty_bought), inputmode: 'decimal' });
    const note = h('input', { class: 'input', placeholder: 'Needed if fewer arrived' });
    const line = h('p', { class: 'hint' });
    const draw = () => { const short = Number(r.qty_bought) - num(got.value); mount(line, short > 0 ? `${qty(short)} short – worth ${money(short * Number(r.unit_cost || 0))}. Say what happened; the GM and finance are told and the shelf is corrected.` : 'Everything arrived.'); };
    got.oninput = draw; draw();
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Confirm');
    const go = busy(b, async () => { await rpc('confirm_stock_receipt', { p_id: r.id, p_received: num(got.value), p_note: note.value.trim() || null }); toast('Delivery confirmed.'); close(); refresh(); });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('p', { class: 'hint' }, `${units(r.qty_bought, r.item?.unit)} bought${rq ? ` on #${rq.request_no} ${rq.purpose}` : ''} by ${personName(r.bought_by)}. Count what reached the shelf.`),
      h('div', { class: 'row' }, field('Arrived', got), field('Note', note)), line,
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

/* ---------------- corrections: count differences, manual corrections and short deliveries ---------------- */
async function adjustmentsTab() {
  const q = state.view ? sb.from('stock_adjustments').select('*, item:items!inner(name, unit, branch_id)').eq('item.branch_id', state.view) : sb.from('stock_adjustments').select('*, item:items(name, unit, branch_id)');
  const { data } = await q.order('requested_at', { ascending: false }).limit(200);
  const rows = data || [];
  const pending = rows.filter((a) => a.status === 'to_approve'); const done = rows.filter((a) => a.status !== 'to_approve');
  const limit = Number(state.settings?.stock_adjust_limit || 0);
  const KIND = { count: 'Count difference', correction: 'Correction', delivery: 'Short delivery' };
  const STATUS = { applied: ['Applied', 'pill-grey'], to_approve: ['Waiting for the GM', 'pill-amber'], approved: ['Approved', 'pill-green'], rejected: ['Turned down', 'pill-red'] };
  const row = (a) => h('li', {},
    h('div', { class: 'what' }, h('strong', {}, `${a.item?.name || 'Item'} · ${qty(a.qty_before)} → ${units(a.qty_after, a.item?.unit)}`),
      h('span', {}, `${KIND[a.kind] || a.kind} · worth ${money(a.value)} · ${personName(a.requested_by)}, ${fmtDate(a.requested_at)}${a.reason ? ` – “${a.reason}”` : ''}`),
      a.decided_at ? h('span', { style: { display: 'block' } }, `${a.status === 'approved' ? 'Approved' : 'Turned down'} by ${personName(a.decided_by)}, ${fmtDate(a.decided_at)}${a.decision_note ? ` – “${a.decision_note}”` : ''}`) : null),
    a.status === 'to_approve' && can('admin') && a.requested_by !== state.me.id ? decideAdjustmentActions(a) : h('span', { class: `pill ${STATUS[a.status][1]}` }, STATUS[a.status][0]));
  return h('div', {},
    h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Waiting for the General Manager'), h('span', { class: 'sub' }, pending.length)),
      h('p', { class: 'hint' }, `A count difference on an issued item, a manual correction or a short delivery worth up to ${money(limit)} is applied at once and logged here. Above that the balance only changes once the GM approves it.`),
      pending.length ? h('ul', { class: 'ledger-list' }, pending.map(row)) : emptyState('Nothing waiting', 'Corrections above the limit appear here for the GM.')),
    done.length ? h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Log'), h('span', { class: 'sub' }, 'latest first')), h('ul', { class: 'ledger-list' }, done.slice(0, 60).map(row))) : null);
}
export function decideAdjustmentActions(a) {
  const ok = h('button', { class: 'btn btn-sm btn-primary' }, 'Approve');
  ok.onclick = busy(ok, async (e) => { e.stopPropagation(); await rpc('decide_stock_adjustment', { p_id: a.id, p_approve: true, p_note: null }); toast('Approved – the balance has been corrected.'); refresh(); });
  const no = h('button', { class: 'btn btn-sm btn-quiet btn-danger' }, 'Turn down');
  no.onclick = busy(no, async (e) => { e.stopPropagation(); const why = await confirmDialog('Turn this correction down?', 'The balance stays as it is; the controller is told.', { ok: 'Turn down', danger: true, note: { label: 'Reason', required: true } }); if (!why) return; await rpc('decide_stock_adjustment', { p_id: a.id, p_approve: false, p_note: why }); toast('Turned down.'); refresh(); });
  return h('div', { class: 'row-actions', onclick: (e) => e.stopPropagation() }, no, ok);
}

function usageDialog(item, done) {
  modal(`Used: ${item.name}`, (close) => {
    const q = h('input', { class: 'input num', type: 'number', min: '0.01', max: item.qty_on_hand, step: 'any', value: 1, inputmode: 'decimal' });
    const date = h('input', { class: 'input', type: 'date', value: today(), max: today() });
    const note = h('input', { class: 'input', placeholder: 'Optional' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Record usage');
    const go = busy(b, async () => { await rpc('record_usage', { p_item: item.id, p_qty: num(q.value), p_on: date.value, p_note: note.value }); toast('Usage recorded.'); close(); done(); });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } }, h('p', { class: 'hint' }, `${units(item.qty_on_hand, item.unit)} on hand. For things consumed from the store (coffee, cleaning stock) rather than handed to a person.`),
      h('div', { class: 'row' }, field('Quantity used', q), field('On', date)), field('Note', note), h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

/* ---------------- item dialogs ---------------- */
function itemDialog(item, done) {
  modal(item ? `Edit ${item.name}` : 'New item', async (close) => {
    const [{ data: cats }, { data: sups }] = await Promise.all([sb.from('categories').select('*').eq('active', true).order('name'), sb.from('suppliers').select('*').eq('active', true).order('name')]);
    const name = h('input', { class: 'input', value: item?.name || '', required: true });
    const sku = h('input', { class: 'input', value: item?.sku || '' });
    const unit = h('input', { class: 'input', value: item?.unit || 'each', list: 'units' });
    const pack = h('input', { class: 'input', value: item?.pack_note || '', placeholder: 'e.g. box of 5 reams' });
    const cat = select([['', 'No category'], ...cats.filter((c) => c.kind !== 'cash').map((c) => [c.id, c.name])], item?.category_id || '');
    const sup = select([['', 'No preferred supplier'], ...sups.map((s) => [s.id, s.name])], item?.preferred_supplier_id || '');
    const recurring = h('input', { type: 'checkbox', checked: !!item?.recurring });
    const tracking = select([['counted', 'Counted – the weekly count measures what was used (tea, sugar, cleaning stock)'], ['issued', 'Issued – every hand-out is recorded; a count difference is a variance (toner, paper, memory sticks)']], item?.tracking || (Number(item?.last_unit_price) > 100 ? 'issued' : 'counted'));
    const monthly = h('input', { class: 'input num', type: 'number', min: 0, step: 'any', value: item?.expected_monthly_qty || 0 });
    const reorder = h('input', { class: 'input num', type: 'number', min: 0, step: 'any', value: item?.reorder_level || 0 });
    const price = h('input', { class: 'input num', type: 'number', min: 0, step: '0.01', value: item?.last_unit_price ?? '' });
    const opening = item ? null : h('input', { class: 'input num', type: 'number', min: 0, step: 'any', value: 0 });
    const active = h('input', { type: 'checkbox', checked: item ? !!item.active : true });
    const err = h('div', { class: 'error' });
    // the monthly quantity only matters for things bought every month (it sets their restock order)
    const monthlyField = field('Expected monthly quantity', monthly, 'Starting point for the restock order until usage has been measured for two weeks');
    showIf(monthlyField, recurring.checked);
    recurring.addEventListener('change', () => { showIf(monthlyField, recurring.checked); if (recurring.checked && !num(monthly.value)) monthly.focus(); });
    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, item ? 'Save' : 'Add item');
    const form = h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('datalist', { id: 'units' }, ['each', 'box', 'pack', 'ream', 'bottle', 'litre', 'kg', 'roll', 'bag', 'tin'].map((u) => h('option', { value: u }))),
      field('Name', name), h('div', { class: 'row' }, field('Unit', unit), field('Code / SKU', sku, 'Optional')), field('Pack note', pack, 'Optional'),
      h('div', { class: 'row' }, field('Category', cat), field('Preferred supplier', sup)),
      h('div', { class: 'row' }, field('Reorder when below', reorder), field('Last known price', price, 'Per unit')),
      field('How it is tracked', tracking, 'Things worth more than N$100 each are usually issued.'),
      h('label', { class: 'check', style: { marginBottom: '10px' } }, recurring, 'Bought every month'),
      monthlyField,
      opening ? field('Opening stock on hand', opening) : h('label', { class: 'check', style: { marginBottom: '10px' } }, active, 'Active (shown when raising requests)'),
      err, h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), save));
    const go = busy(save, async () => {
      err.textContent = '';
      const row = { name: name.value.trim(), sku: sku.value.trim() || null, unit: unit.value.trim() || 'each', pack_note: pack.value.trim() || null, category_id: cat.value || null, preferred_supplier_id: sup.value || null,
        recurring: recurring.checked, expected_monthly_qty: num(monthly.value), reorder_level: num(reorder.value), last_unit_price: price.value === '' ? null : num(price.value), active: active.checked, tracking: tracking.value };
      if (!row.name) { err.textContent = 'Give the item a name.'; return; }
      try {
        if (item) unwrap(await sb.from('items').update(row).eq('id', item.id));
        else {
          const created = unwrap(await sb.from('items').insert({ ...row, branch_id: myBranch() }).select().single());
          if (num(opening.value) > 0) { const mv = await rpc('adjust_stock', { p_item: created.id, p_new_qty: num(opening.value), p_note: 'Opening stock' }); if (!mv) toast('Opening stock is above the correction limit – sent to the GM to approve.', { ms: 6000 }); }
        }
        toast(item ? 'Item saved.' : 'Item added.'); close(); done();
      } catch (e) { err.textContent = /items_name_uq/.test(e.message) ? 'An item with that name already exists.' : e.message; }
    });
    return form;
  });
}

function issueDialog(item, done) {
  modal(`Issue ${item.name}`, (close) => {
    const q = h('input', { class: 'input num', type: 'number', min: '0.01', max: item.qty_on_hand, step: 'any', value: 1 });
    const to = select(state.people.filter((p) => p.active).map((p) => [p.id, p.full_name || p.email]), state.me.id);
    const note = h('input', { class: 'input', placeholder: 'Optional' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Issue');
    const go = busy(b, async () => { await rpc('issue_stock', { p_item: item.id, p_qty: num(q.value), p_to: to.value, p_note: note.value }); toast('Issued.'); close(); done(); });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } }, h('p', { class: 'hint' }, `${units(item.qty_on_hand, item.unit)} on hand. For handing stock to a named person; requests issue automatically.`),
      field('Quantity', q), field('To', to), field('Note', note), h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

function receiveDialog(item, sups, done) {
  modal(`Receive ${item.name}`, (close) => {
    const q = h('input', { class: 'input num', type: 'number', min: '0.01', step: 'any', value: 1 });
    const cost = h('input', { class: 'input num', type: 'number', min: 0, step: '0.01', value: item.last_unit_price ?? '' });
    const sup = select([['', 'Supplier…'], ...sups.filter((s) => s.active).map((s) => [s.id, s.name])], item.preferred_supplier_id || '');
    const note = h('input', { class: 'input', placeholder: 'e.g. bought on account, donated' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Receive');
    const go = busy(b, async () => { await rpc('receive_stock', { p_item: item.id, p_qty: num(q.value), p_unit_cost: cost.value === '' ? null : num(cost.value), p_supplier: sup.value || null, p_note: note.value }); toast('Received into stock.'); close(); done(); });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } }, h('p', { class: 'hint' }, 'For stock that did not come through petty cash. Purchases on requests are received automatically when the expense is recorded.'),
      h('div', { class: 'row' }, field('Quantity', q), field('Unit cost', cost, 'Optional – feeds the price history')), field('Supplier', sup), field('Note', note),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

/* ---------------- movements ---------------- */
async function movementsTab() {
  let mq = sb.from('stock_movements').select('*, item:items!inner(name, unit, branch_id)').eq('void', false).order('occurred_on', { ascending: false }).order('created_at', { ascending: false }).limit(200);
  if (state.view) mq = mq.eq('item.branch_id', state.view);
  const { data } = await mq;
  const rows = data || [];
  return h('div', { class: 'sheet' }, rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
    h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Item'), h('th', {}, 'What'), h('th', { class: 'num' }, 'Change'), h('th', { class: 'num' }, 'Unit cost'), h('th', {}, 'By'))),
    h('tbody', {}, rows.map((m) => h('tr', {}, h('td', { class: 'muted', style: { whiteSpace: 'nowrap' } }, fmtDate(m.occurred_on || m.created_at)), h('td', {}, m.item?.name),
      h('td', {}, MOVEMENT_LABEL[m.kind] || m.kind, m.issued_to ? ` to ${personName(m.issued_to)}` : '', m.request_id ? h('a', { href: `#/requests/${m.request_id}`, class: 'muted', style: { marginLeft: '6px' } }, 'request') : null, m.note ? h('div', { class: 'muted', style: { fontSize: '.8rem' } }, m.note) : null),
      h('td', { class: `num amt`, style: { color: Number(m.delta) < 0 ? 'var(--amber)' : 'var(--green-ink)' } }, `${Number(m.delta) > 0 ? '+' : ''}${units(m.delta, m.item?.unit)}`),
      h('td', { class: 'num muted' }, m.unit_cost != null ? money(m.unit_cost) : ''), h('td', { class: 'muted' }, personName(m.created_by))))))) : emptyState('No movements yet', 'Purchases, usage, issues and counts will show here.'));
}

/* ---------------- suppliers ---------------- */
async function suppliersTab(manage) {
  const { data } = await sb.from('suppliers').select('*').order('name');
  const rows = data || [];
  return h('div', { class: 'sheet' }, rows.length ? h('table', { class: 'ledger' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Supplier'), h('th', {}, 'Contact'), h('th', {}, 'Notes'), manage ? h('th') : null)),
    h('tbody', {}, rows.map((s) => h('tr', {}, h('td', {}, h('strong', {}, s.name), !s.active ? h('span', { class: 'pill pill-grey', style: { marginLeft: '6px' } }, 'inactive') : null), h('td', { class: 'muted' }, s.contact || ''), h('td', { class: 'muted' }, s.notes || ''),
      manage && can('catalogue') ? h('td', { class: 'num' }, h('button', { class: 'btn btn-sm btn-quiet', onclick: () => supplierDialog(s, () => refresh()) }, 'Edit')) : null)))) : emptyState('No suppliers yet', 'Add the shops you buy from so prices can be compared.'));
}
function supplierDialog(s, done) {
  modal(s ? `Edit ${s.name}` : 'New supplier', (close) => {
    const name = h('input', { class: 'input', value: s?.name || '', required: true });
    const contact = h('input', { class: 'input', value: s?.contact || '', placeholder: 'Phone, branch, account number' });
    const notes = h('input', { class: 'input', value: s?.notes || '' });
    const active = h('input', { type: 'checkbox', checked: s ? !!s.active : true });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, s ? 'Save' : 'Add supplier');
    const go = busy(b, async () => {
      const row = { name: name.value.trim(), contact: contact.value.trim() || null, notes: notes.value.trim() || null, active: active.checked };
      if (!row.name) throw new Error('Give the supplier a name.');
      if (s) unwrap(await sb.from('suppliers').update(row).eq('id', s.id)); else unwrap(await sb.from('suppliers').insert(row));
      toast('Saved.'); close(); done();
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } }, field('Name', name), field('Contact', contact), field('Notes', notes),
      s ? h('label', { class: 'check', style: { marginBottom: '10px' } }, active, 'Active') : null,
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

/* ---------------- categories ---------------- */
async function categoriesTab(manage) {
  const { data } = await sb.from('categories').select('*').order('name');
  const rows = data || [];
  const kind = { stock: 'Stock items', cash: 'Cash expenses', both: 'Both' };
  return h('div', { class: 'sheet' }, h('p', { class: 'hint' }, 'Categories group spending in the reports. Stock items carry their own category; cash requests pick one.'),
    h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, h('th', {}, 'Category'), h('th', {}, 'Used for'), h('th', {}, 'Account code'), manage ? h('th') : null)),
      h('tbody', {}, rows.map((c) => h('tr', {}, h('td', {}, c.name, !c.active ? h('span', { class: 'pill pill-grey', style: { marginLeft: '6px' } }, 'inactive') : null), h('td', { class: 'muted' }, kind[c.kind]), h('td', { class: 'muted' }, c.account_code || '—'),
        manage && can('catalogue') ? h('td', { class: 'num' }, h('button', { class: 'btn btn-sm btn-quiet', onclick: () => categoryDialog(c, () => refresh()) }, 'Edit')) : null)))));
}
function categoryDialog(c, done) {
  modal(c ? `Edit ${c.name}` : 'New category', (close) => {
    const name = h('input', { class: 'input', value: c?.name || '', required: true });
    const kind = select([['both', 'Both'], ['stock', 'Stock items'], ['cash', 'Cash expenses']], c?.kind || 'both');
    const code = h('input', { class: 'input', value: c?.account_code || '', placeholder: 'e.g. 6210' });
    const active = h('input', { type: 'checkbox', checked: c ? !!c.active : true });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, c ? 'Save' : 'Add category');
    const go = busy(b, async () => {
      const row = { name: name.value.trim(), kind: kind.value, active: active.checked, account_code: code.value.trim() || null };
      if (!row.name) throw new Error('Give the category a name.');
      if (c) unwrap(await sb.from('categories').update(row).eq('id', c.id)); else unwrap(await sb.from('categories').insert(row));
      toast('Saved.'); close(); done();
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } }, field('Name', name), field('Used for', kind), field('Account code', code, 'The expense account in the accounting package; the journal export uses it.'), c ? h('label', { class: 'check', style: { marginBottom: '10px' } }, active, 'Active') : null,
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}
