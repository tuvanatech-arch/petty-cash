import { sb, state, can, personName, unwrap, rpc, queueOffline } from '../api.js';
import { h, mount, money, qty, num, fmtDate, monthLabel, emptyState, toast, busy, field, select, modal, MOVEMENT_LABEL, PACE, refresh, today, isoDate } from '../ui.js';
import { barChart } from '../charts.js';

export async function stockPage(tab = 'items') {
  const manage = can('manage_stock');
  const tabs = [['items', 'Items'], ['usage', 'Usage'], ['movements', 'Movements'], ['suppliers', 'Suppliers'], ['categories', 'Categories']];
  const body = h('div', {});
  const tabBar = h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: k === tab ? 'active' : '', onclick: () => { location.hash = `#/stock/${k}`; } }, l)));
  const actions = [];
  if (manage) {
    if (tab === 'items' || tab === 'usage') actions.push(h('button', { class: 'btn btn-primary', onclick: () => quickCountDialog() }, 'Quick count'));
    const restock = h('button', { class: 'btn' }, 'Raise monthly restock');
    restock.onclick = busy(restock, async () => { const req = await rpc('create_restock_request'); toast('Draft restock order created from measured usage. Check the quantities, then submit.'); location.hash = `#/requests/${req.id}/edit`; });
    actions.push(restock);
    if (tab === 'items') actions.push(h('button', { class: 'btn', onclick: () => itemDialog(null, () => refresh()) }, 'Add item'));
    if (tab === 'suppliers') actions.push(h('button', { class: 'btn btn-primary', onclick: () => supplierDialog(null, () => refresh()) }, 'Add supplier'));
    if (tab === 'categories' && can('catalogue')) actions.push(h('button', { class: 'btn btn-primary', onclick: () => categoryDialog(null, () => refresh()) }, 'Add category'));
  }
  mount(body, await ({ items: itemsTab, usage: usageTab, movements: movementsTab, suppliers: suppliersTab, categories: categoriesTab }[tab] || itemsTab)(manage));
  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Stock'), h('p', {}, manage ? 'What is in the store, how fast it goes, and when it will run out.' : 'What the store holds. Ask for items through a stock request.')),
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
    sb.from('items').select('*').order('name'), sb.from('categories').select('*'), sb.from('suppliers').select('*'), loadStats(),
  ]);
  const catName = (id) => cats.find((c) => c.id === id)?.name || '—';
  const supName = (id) => sups.find((s) => s.id === id)?.name || '—';
  let search = ''; let showInactive = false; let filter = 'all';
  const wrap = h('div', {});
  const low = (i) => { const s = stats[i.id]; return Number(i.qty_on_hand) <= 0 || (Number(i.reorder_level) > 0 && Number(i.qty_on_hand) < Number(i.reorder_level)) || (s?.days_of_cover != null && Number(s.days_of_cover) <= 14); };
  function draw() {
    const rows = items.filter((i) => (showInactive || i.active) && (!search || `${i.name} ${i.sku || ''} ${catName(i.category_id)}`.toLowerCase().includes(search))
      && (filter === 'all' || (filter === 'low' ? low(i) : filter === 'recurring' ? i.recurring : stats[i.id]?.pace === filter)));
    const totalValue = rows.reduce((s, i) => s + Number(i.qty_on_hand) * Number(i.last_unit_price || 0), 0);
    mount(wrap, rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', { class: 'num' }, 'On hand'), h('th', { class: 'num' }, 'Used / month'), h('th', { class: 'num' }, 'Runs out'), h('th', { class: 'num' }, 'Last price'), h('th', {}, 'Supplier'), manage ? h('th') : null)),
      h('tbody', {}, rows.map((i) => {
        const s = stats[i.id];
        return h('tr', { class: low(i) ? 'low' : '' },
          h('td', {}, h('strong', {}, i.name), paceBadge(s), !i.active ? h('span', { class: 'pill pill-grey', style: { marginLeft: '6px' } }, 'inactive') : null,
            h('div', { class: 'muted', style: { fontSize: '.8rem' } }, [catName(i.category_id), i.recurring ? `monthly · expect ${qty(i.expected_monthly_qty)}` : null, Number(i.reorder_level) > 0 ? `reorder at ${qty(i.reorder_level)}` : null].filter(Boolean).join(' · '))),
          h('td', { class: 'num amt' }, `${qty(i.qty_on_hand)} ${i.unit}`),
          h('td', { class: 'num' }, s && Number(s.used_per_month) > 0 ? qty(s.used_per_month) : h('span', { class: 'muted' }, '—')),
          runoutCell(i, s),
          h('td', { class: 'num' }, i.last_unit_price != null ? money(i.last_unit_price) : '—'),
          h('td', { class: 'muted' }, supName(i.preferred_supplier_id)),
          manage ? h('td', { class: 'num', style: { whiteSpace: 'nowrap' } },
            h('button', { class: 'btn btn-sm', onclick: () => usageDialog(i, () => refresh()) }, 'Used'),
            ' ', h('button', { class: 'btn btn-sm', onclick: () => issueDialog(i, () => refresh()) }, 'Issue'),
            ' ', h('button', { class: 'btn btn-sm', onclick: () => receiveDialog(i, sups, () => refresh()) }, 'Receive'),
            ' ', h('button', { class: 'btn btn-sm btn-quiet', onclick: () => itemDialog(i, () => refresh()) }, 'Edit')) : null);
      })),
      h('tfoot', {}, h('tr', {}, h('td', { colspan: 4 }, `${rows.length} item${rows.length === 1 ? '' : 's'} · value at last price`), h('td', { class: 'num' }, money(totalValue)), h('td', { colspan: manage ? 2 : 1 })))))
      : emptyState('Nothing here', manage ? (items.length ? 'No items match this filter.' : 'Add the things you buy regularly – paper, cleaning supplies, toner.') : 'The stock manager has not added items yet.'));
  }
  draw();
  const chips = [['all', 'All'], ['low', 'Running low'], ['recurring', 'Monthly items'], ['fast', 'Fast movers'], ['slow', 'Slow movers']];
  const chipBar = h('div', { class: 'tabs', style: { borderBottom: 0, marginBottom: '6px' } });
  const drawChips = () => mount(chipBar, chips.map(([k, l]) => h('button', { class: k === filter ? 'active' : '', onclick: () => { filter = k; drawChips(); draw(); } }, l)));
  drawChips();
  return h('div', {},
    h('div', { class: 'toolbar' }, h('input', { class: 'input', placeholder: 'Search items', oninput: (e) => { search = e.target.value.toLowerCase(); draw(); } }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { showInactive = e.target.checked; draw(); } }), 'Show inactive')),
    chipBar,
    h('div', { class: 'sheet' }, wrap),
    manage ? h('p', { class: 'hint' }, 'Usage is measured from quick counts, “Used” entries and issues. “Runs out” projects the current rate over what is on hand.') : null);
}

/* ---------------- usage ---------------- */
async function usageTab(manage) {
  const months = []; const now = new Date();
  for (let i = 5; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push(isoDate(d).slice(0, 7)); }
  const since = months[0] + '-01';
  const [{ data: items }, stats, { data: monthly }, { data: runouts }] = await Promise.all([
    sb.from('items').select('*').eq('active', true).order('name'), loadStats(),
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
            h('td', { class: 'num amt' }, `${qty(i.qty_on_hand)} ${i.unit}`),
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
      const { data, error } = await sb.from('items').select('id, name, unit, qty_on_hand, recurring, active').eq('active', true).order('name');
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
        return h('tr', {}, h('td', {}, i.name, h('div', { class: 'muted', style: { fontSize: '.78rem' } }, i.unit)), h('td', { class: 'num muted' }, qty(i.qty_on_hand)), h('td', { class: 'num', style: { width: '110px' } }, inp));
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
      toast(n ? `Count saved – ${n} item${n === 1 ? '' : 's'} adjusted.` : 'Count saved – everything matched the book.'); close(); refresh();
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      offline ? h('div', { class: 'banner banner-amber' }, h('strong', {}, 'You are offline'), 'Book quantities are from the last time this phone was online. The count is kept here and sent later.') : null,
      h('p', { class: 'hint' }, 'Type what is actually on the shelf. Anything you leave blank is skipped. Less than the book is logged as used; more is a correction.'),
      h('div', { class: 'row' }, field('Counted on', date), field('Note', note)),
      h('label', { class: 'check', style: { marginBottom: '10px' } }, h('input', { type: 'checkbox', checked: onlyRecurring, onchange: (e) => { onlyRecurring = e.target.checked; draw(); } }), 'Monthly items only'),
      h('div', { class: 'table-wrap lines-edit' }, h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', { class: 'num' }, 'Book'), h('th', { class: 'num' }, 'Counted'))), tbody)),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  }, { wide: true });
}

function usageDialog(item, done) {
  modal(`Used: ${item.name}`, (close) => {
    const q = h('input', { class: 'input num', type: 'number', min: '0.01', max: item.qty_on_hand, step: 'any', value: 1, inputmode: 'decimal' });
    const date = h('input', { class: 'input', type: 'date', value: today(), max: today() });
    const note = h('input', { class: 'input', placeholder: 'Optional' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Record usage');
    const go = busy(b, async () => { await rpc('record_usage', { p_item: item.id, p_qty: num(q.value), p_on: date.value, p_note: note.value }); toast('Usage recorded.'); close(); done(); });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } }, h('p', { class: 'hint' }, `${qty(item.qty_on_hand)} ${item.unit} on hand. For things consumed from the store (coffee, cleaning stock) rather than handed to a person.`),
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
    const monthly = h('input', { class: 'input num', type: 'number', min: 0, step: 'any', value: item?.expected_monthly_qty || 0 });
    const reorder = h('input', { class: 'input num', type: 'number', min: 0, step: 'any', value: item?.reorder_level || 0 });
    const price = h('input', { class: 'input num', type: 'number', min: 0, step: '0.01', value: item?.last_unit_price ?? '' });
    const opening = item ? null : h('input', { class: 'input num', type: 'number', min: 0, step: 'any', value: 0 });
    const active = h('input', { type: 'checkbox', checked: item ? !!item.active : true });
    const err = h('div', { class: 'error' });
    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, item ? 'Save' : 'Add item');
    const form = h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('datalist', { id: 'units' }, ['each', 'box', 'pack', 'ream', 'bottle', 'litre', 'kg', 'roll', 'bag', 'tin'].map((u) => h('option', { value: u }))),
      field('Name', name), h('div', { class: 'row' }, field('Unit', unit), field('Code / SKU', sku, 'Optional')), field('Pack note', pack, 'Optional'),
      h('div', { class: 'row' }, field('Category', cat), field('Preferred supplier', sup)),
      h('div', { class: 'row' }, field('Reorder when below', reorder), field('Last known price', price, 'Per unit')),
      h('label', { class: 'check', style: { marginBottom: '10px' } }, recurring, 'Bought every month'),
      field('Expected monthly quantity', monthly, 'Starting point for the restock order until usage has been measured for two weeks'),
      opening ? field('Opening stock on hand', opening) : h('label', { class: 'check', style: { marginBottom: '10px' } }, active, 'Active (shown when raising requests)'),
      err, h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), save));
    const go = busy(save, async () => {
      err.textContent = '';
      const row = { name: name.value.trim(), sku: sku.value.trim() || null, unit: unit.value.trim() || 'each', pack_note: pack.value.trim() || null, category_id: cat.value || null, preferred_supplier_id: sup.value || null,
        recurring: recurring.checked, expected_monthly_qty: num(monthly.value), reorder_level: num(reorder.value), last_unit_price: price.value === '' ? null : num(price.value), active: active.checked };
      if (!row.name) { err.textContent = 'Give the item a name.'; return; }
      try {
        if (item) unwrap(await sb.from('items').update(row).eq('id', item.id));
        else {
          const created = unwrap(await sb.from('items').insert(row).select().single());
          if (num(opening.value) > 0) await rpc('adjust_stock', { p_item: created.id, p_new_qty: num(opening.value), p_note: 'Opening stock' });
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
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } }, h('p', { class: 'hint' }, `${qty(item.qty_on_hand)} ${item.unit} on hand. For handing stock to a named person; requests issue automatically.`),
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
  const { data } = await sb.from('stock_movements').select('*, item:items(name, unit)').eq('void', false).order('occurred_on', { ascending: false }).order('created_at', { ascending: false }).limit(200);
  const rows = data || [];
  return h('div', { class: 'sheet' }, rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
    h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Item'), h('th', {}, 'What'), h('th', { class: 'num' }, 'Change'), h('th', { class: 'num' }, 'Unit cost'), h('th', {}, 'By'))),
    h('tbody', {}, rows.map((m) => h('tr', {}, h('td', { class: 'muted', style: { whiteSpace: 'nowrap' } }, fmtDate(m.occurred_on || m.created_at)), h('td', {}, m.item?.name),
      h('td', {}, MOVEMENT_LABEL[m.kind] || m.kind, m.issued_to ? ` to ${personName(m.issued_to)}` : '', m.request_id ? h('a', { href: `#/requests/${m.request_id}`, class: 'muted', style: { marginLeft: '6px' } }, 'request') : null, m.note ? h('div', { class: 'muted', style: { fontSize: '.8rem' } }, m.note) : null),
      h('td', { class: `num amt`, style: { color: Number(m.delta) < 0 ? 'var(--amber)' : 'var(--green-ink)' } }, `${Number(m.delta) > 0 ? '+' : ''}${qty(m.delta)} ${m.item?.unit || ''}`),
      h('td', { class: 'num muted' }, m.unit_cost != null ? money(m.unit_cost) : ''), h('td', { class: 'muted' }, personName(m.created_by))))))) : emptyState('No movements yet', 'Purchases, usage, issues and counts will show here.'));
}

/* ---------------- suppliers ---------------- */
async function suppliersTab(manage) {
  const { data } = await sb.from('suppliers').select('*').order('name');
  const rows = data || [];
  return h('div', { class: 'sheet' }, rows.length ? h('table', { class: 'ledger' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Supplier'), h('th', {}, 'Contact'), h('th', {}, 'Notes'), manage ? h('th') : null)),
    h('tbody', {}, rows.map((s) => h('tr', {}, h('td', {}, h('strong', {}, s.name), !s.active ? h('span', { class: 'pill pill-grey', style: { marginLeft: '6px' } }, 'inactive') : null), h('td', { class: 'muted' }, s.contact || ''), h('td', { class: 'muted' }, s.notes || ''),
      manage ? h('td', { class: 'num' }, h('button', { class: 'btn btn-sm btn-quiet', onclick: () => supplierDialog(s, () => refresh()) }, 'Edit')) : null)))) : emptyState('No suppliers yet', 'Add the shops you buy from so prices can be compared.'));
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
    h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, h('th', {}, 'Category'), h('th', {}, 'Used for'), manage ? h('th') : null)),
      h('tbody', {}, rows.map((c) => h('tr', {}, h('td', {}, c.name, !c.active ? h('span', { class: 'pill pill-grey', style: { marginLeft: '6px' } }, 'inactive') : null), h('td', { class: 'muted' }, kind[c.kind]),
        manage ? h('td', { class: 'num' }, h('button', { class: 'btn btn-sm btn-quiet', onclick: () => categoryDialog(c, () => refresh()) }, 'Edit')) : null)))));
}
function categoryDialog(c, done) {
  modal(c ? `Edit ${c.name}` : 'New category', (close) => {
    const name = h('input', { class: 'input', value: c?.name || '', required: true });
    const kind = select([['both', 'Both'], ['stock', 'Stock items'], ['cash', 'Cash expenses']], c?.kind || 'both');
    const active = h('input', { type: 'checkbox', checked: c ? !!c.active : true });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, c ? 'Save' : 'Add category');
    const go = busy(b, async () => {
      const row = { name: name.value.trim(), kind: kind.value, active: active.checked };
      if (!row.name) throw new Error('Give the category a name.');
      if (c) unwrap(await sb.from('categories').update(row).eq('id', c.id)); else unwrap(await sb.from('categories').insert(row));
      toast('Saved.'); close(); done();
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } }, field('Name', name), field('Used for', kind), c ? h('label', { class: 'check', style: { marginBottom: '10px' } }, active, 'Active') : null,
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}
