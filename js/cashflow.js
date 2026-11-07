// Cash that goes out for errands (057): counting by notes and coins, hand out together, cash with a person and
// taking the change back at once, "Price went up", handing out more, paying back what someone paid themselves, and
// "Received" when someone else bought it.
import { sb, state, rpc, can, personName } from './api.js';
import { h, mount, money, toast, busy, confirmDialog, field, num, modal } from './ui.js';

/* ---------- notes and coins (Namibia dollar; the rand counts the same) ---------- */
const NOTES = [200, 100, 50, 20, 10];
const COINS = [10, 5, 1, 0.5, 0.1, 0.05];
const label = (v) => (v >= 1 ? `N$${v}` : `${Math.round(v * 100)}c`);
/** How many of each note and coin; value() gives the total and the list to save ([{value, count}]). */
export function denomsField({ onChange = () => {} } = {}) {
  const inputs = [];
  const total = h('strong', { class: 'num', id: 'denoms-total' }, money(0));
  const recount = () => { const t = value().total; total.textContent = money(t); onChange(t); };
  const row = (v, kind) => {
    const i = h('input', { class: 'input denom-n', type: 'number', min: '0', step: '1', inputmode: 'numeric', placeholder: '0', 'aria-label': `${label(v)} ${kind}s`, 'data-value': v, 'data-kind': kind });
    i.addEventListener('input', recount); inputs.push({ v, i });
    return h('label', { class: 'denom' }, h('span', { class: `denom-face ${kind}` }, label(v)), i);
  };
  const el = h('div', { class: 'denoms', id: 'denoms' },
    h('div', { class: 'denom-group' }, h('span', { class: 'label' }, 'Notes'), h('div', { class: 'denom-grid' }, NOTES.map((v) => row(v, 'note')))),
    h('div', { class: 'denom-group' }, h('span', { class: 'label' }, 'Coins'), h('div', { class: 'denom-grid' }, COINS.map((v) => row(v, 'coin')))),
    h('p', { class: 'denom-sum' }, 'Counted: ', total));
  function value() {
    const by = new Map();
    for (const { v, i } of inputs) { const c = Math.max(0, Math.floor(num(i.value))); if (c) by.set(v, (by.get(v) || 0) + c); }
    const list = [...by].map(([value, count]) => ({ value, count }));
    return { total: Math.round(list.reduce((s, x) => s + x.value * x.count, 0) * 100) / 100, list };
  }
  return { el, value };
}

/* ---------- hand out together ---------- */
export async function handOutTogetherDialog(onDone = () => {}) {
  if (!can('finance')) return;
  const [{ data: waiting }, { data: people }] = await Promise.all([
    sb.from('requests').select('id, request_no, purpose, requester_id, estimated_total, price_known, type, branch_id, approved_by, review_reason').eq('status', 'awaiting_disbursement').neq('type', 'claim').order('request_no'),
    sb.from('profiles').select('id, full_name, role, active').eq('active', true).order('full_name'),
  ]);
  const reqs = (waiting || []).filter((r) => r.requester_id !== state.me.id);
  if (reqs.length < 2) { toast('Hand out together needs at least two approved requests waiting for cash.', { ms: 6000 }); return; }
  const who = h('select', { class: 'input', id: 'handout-person' }, h('option', { value: '' }, 'Choose who goes to the shop…'),
    (people || []).filter((p) => p.id !== state.me.id).map((p) => h('option', { value: p.id }, p.full_name)));
  const amounts = new Map(); const ticks = new Map();
  const sum = h('strong', { class: 'num', id: 'handout-total' }, money(0));
  const list = h('ul', { class: 'handout-list' });
  const recount = () => { let t = 0; for (const [id, cb] of ticks) if (cb.checked) t += num(amounts.get(id).value); sum.textContent = money(t); return t; };
  const suggestions = await Promise.all(reqs.map((r) => rpc('suggest_cash', { p_request: r.id }).catch(() => null)));
  const draw = () => {
    const pid = who.value;
    const ordered = [...reqs].sort((a, b) => (b.requester_id === pid) - (a.requester_id === pid) || a.request_no - b.request_no);
    mount(list, ordered.map((r) => {
      if (!ticks.has(r.id)) {
        const sg = suggestions[reqs.indexOf(r)];
        ticks.set(r.id, h('input', { type: 'checkbox', 'data-request': r.id, onchange: recount }));
        amounts.set(r.id, h('input', { class: 'input num', type: 'number', step: '0.01', min: '0.01', value: Number(sg?.amount || r.estimated_total).toFixed(2), oninput: recount, 'aria-label': `Amount for #${r.request_no}` }));
        amounts.get(r.id).title = sg?.why || '';
      }
      return h('li', {}, h('label', { class: 'check' }, ticks.get(r.id), h('span', {}, h('strong', {}, `#${r.request_no} ${r.purpose}`),
        h('span', { class: 'hint' }, `${r.requester_id === pid ? 'Their own' : personName(r.requester_id)} · ${r.price_known ? 'price known' : 'estimate'} ${money(r.estimated_total)}`))), amounts.get(r.id));
    }));
    recount();
  };
  who.onchange = draw; draw();
  const notes = denomsField();
  const note = h('input', { class: 'input', placeholder: 'Optional' });
  const err = h('div', { class: 'error' });
  const ok = h('button', { class: 'btn btn-primary', id: 'handout-save' }, 'Record the hand-out');
  const close = modal('Hand out together', h('div', {},
    h('p', { class: 'hint' }, 'One person buys several approved requests in one trip – theirs and other people’s. Tick them, check each amount (Petti suggests one with a margin), and count what you hand over.'),
    field('Who goes to the shop', who), list, h('p', { class: 'handout-sum' }, 'To hand over: ', sum),
    h('details', { class: 'more' }, h('summary', {}, 'Count the notes and coins you hand over (optional)'), notes.el),
    field('Note', note), err, h('div', { class: 'form-actions' }, ok)));
  ok.onclick = busy(ok, async () => {
    err.textContent = '';
    if (!who.value) { err.textContent = 'Choose who goes to the shop.'; return; }
    const parts = [...ticks].filter(([, cb]) => cb.checked).map(([id]) => ({ request: id, amount: Math.round(num(amounts.get(id).value) * 100) / 100 }));
    if (parts.length < 2) { err.textContent = 'Tick at least two requests (for one, use Pay out on the request).'; return; }
    const d = notes.value(); const total = parts.reduce((s, x) => s + x.amount, 0);
    if (d.list.length && Math.abs(d.total - total) > 0.004) { err.textContent = `The notes and coins add up to ${money(d.total)}, not ${money(total)}.`; return; }
    try {
      await rpc('hand_out_together', { p_to: who.value, p_parts: parts, p_denoms: d.list.length ? d.list : null, p_note: note.value.trim() || null });
      toast(`Recorded: ${money(total)} to ${who.selectedOptions[0].textContent} for ${parts.length} requests. They confirm once; the others are told who is buying for them.`, { ms: 7000 });
      close(); onDone();
    } catch (e) { err.textContent = e.message; }
  });
}

/* ---------- cash with a person ---------- */
const rowText = (r) => r.status === 'disbursed' ? `holding ${money(r.holding)} – receipt not recorded yet`
  : r.change > 0 ? `${money(r.change)} change to hand back (${money(r.handed)} − ${money(r.spent)})`
    : r.owed > 0 ? `${money(r.owed)} owed to them (spent ${money(r.spent)}, given ${money(r.handed)})` : 'settled';

/** Home, for the person holding cash: what they hold, the change to hand back, what is owed to them. */
export async function cashWithYouCard() {
  const c = await rpc('cash_with', { p_person: null }).catch(() => null);
  if (!c || !Array.isArray(c.rows) || !(Number(c.holding) + Number(c.change) + Number(c.owed) > 0)) return null;
  return h('div', { class: 'sheet cash-with', id: 'cash-with-you' },
    h('div', { class: 'sheet-head' }, h('h2', {}, 'Petty cash with you'), Number(c.change) > 0 ? h('span', { class: 'pill pill-amber' }, `Hand back ${money(c.change)}`) : null),
    h('ul', { class: 'ledger-list' }, c.rows.map((r) => h('li', { class: 'click', onclick: () => { location.hash = `#/requests/${r.request_id}`; } },
      h('div', { class: 'what' }, h('strong', {}, `#${r.request_no} ${r.purpose}`), h('span', {}, `${r.mine ? 'Yours' : `For ${r.requester}`} · ${rowText(r)}`))))),
    h('p', { class: 'hint' }, [Number(c.holding) > 0 ? `Holding ${money(c.holding)} for purchases not recorded yet.` : null, Number(c.change) > 0 ? `Hand ${money(c.change)} of change back to finance.` : null, Number(c.owed) > 0 ? `Finance owes you ${money(c.owed)}.` : null].filter(Boolean).join(' ')));
}

/** Petty cash (finance): everyone holding cash or owed some, with "Return all change". */
export async function cashWithPeopleSheet(onChange = () => {}) {
  if (!can('finance')) return null;
  const got = await rpc('cash_with_people').catch(() => []); const people = Array.isArray(got) ? got : [];
  const handout = h('button', { class: 'btn btn-sm', id: 'hand-out-together' }, 'Hand out together');
  handout.onclick = () => handOutTogetherDialog(onChange);
  return h('div', { class: 'sheet cash-with', id: 'cash-with-people' },
    h('div', { class: 'sheet-head' }, h('h2', {}, 'Cash with people'), handout),
    people.length ? h('ul', { class: 'ledger-list' }, people.map((c) => {
      const back = Number(c.change) > 0 ? h('button', { class: 'btn btn-sm btn-primary', 'data-person': c.person }, `Return all change (${money(c.change)})`) : null;
      if (back) back.onclick = () => returnChangeDialog(c, onChange);
      return h('li', {}, h('div', { class: 'what' }, h('strong', {}, c.name),
        h('span', {}, [Number(c.holding) > 0 ? `holding ${money(c.holding)}` : null, Number(c.change) > 0 ? `${money(c.change)} change due` : null, Number(c.owed) > 0 ? `owed ${money(c.owed)}` : null].filter(Boolean).join(' · ')),
        h('span', { class: 'hint' }, `Requests ${c.rows.map((r) => `#${r.request_no}`).join(', ')}`)), back);
    })) : h('p', { class: 'hint' }, 'Nobody is holding petty cash right now.'));
}

/** Finance takes all the change back at once, counted by notes and coins. */
export function returnChangeDialog(c, onDone = () => {}) {
  const due = c.rows.filter((r) => Number(r.change) > 0);
  const ticks = new Map(due.map((r) => [r.request_id, h('input', { type: 'checkbox', checked: true })]));
  const dueNow = () => due.filter((r) => ticks.get(r.request_id).checked).reduce((s, r) => s + Number(r.change), 0);
  const counted = h('input', { class: 'input num', type: 'number', step: '0.01', min: '0', id: 'change-counted', value: Number(c.change).toFixed(2) });
  const diff = h('p', { class: 'hint', id: 'change-diff' });
  const redo = () => { const d = num(counted.value) - dueNow(); diff.textContent = Math.abs(d) < 0.005 ? `Matches the ${money(dueNow())} due.` : `${d < 0 ? 'Short' : 'Over'} by ${money(Math.abs(d))} – the GM is told.`; diff.style.color = Math.abs(d) < 0.005 ? 'var(--green-ink)' : 'var(--amber)'; };
  const notes = denomsField({ onChange: (t) => { if (t > 0) { counted.value = t.toFixed(2); redo(); } } });
  counted.addEventListener('input', redo); ticks.forEach((cb) => cb.addEventListener('change', redo)); redo();
  const ok = h('button', { class: 'btn btn-primary', id: 'change-save' }, 'Record the change');
  const err = h('div', { class: 'error' });
  const close = modal(`Change from ${c.name}`, h('div', {},
    h('ul', { class: 'handout-list' }, due.map((r) => h('li', {}, h('label', { class: 'check' }, ticks.get(r.request_id), h('span', {}, h('strong', {}, `#${r.request_no} ${r.purpose}`), h('span', { class: 'hint' }, rowText(r))))))),
    h('details', { class: 'more', open: true }, h('summary', {}, 'Count the notes and coins'), notes.el),
    field('Counted', counted), diff, err, h('div', { class: 'form-actions' }, ok)));
  ok.onclick = busy(ok, async () => {
    const ids = due.filter((r) => ticks.get(r.request_id).checked).map((r) => r.request_id);
    if (!ids.length) { err.textContent = 'Tick the requests the change is for.'; return; }
    const d = notes.value();
    try {
      const r = await rpc('return_change', { p_person: c.person, p_requests: ids, p_counted: num(counted.value), p_denoms: d.list.length ? d.list : null, p_note: null });
      toast(Math.abs(Number(r.difference)) < 0.005 ? `Change taken back: ${money(r.counted)}.` : `Recorded ${money(r.counted)} against ${money(r.due)} due – the GM is told.`, { ms: 6000 });
      close(); onDone();
    } catch (e) { err.textContent = e.message; }
  });
}

/* ---------- on a request ---------- */
/** "Price went up" (the buyer), "Hand out more" and "Pay the difference" (finance), "Received" (the requester). */
export function cashExtras(q, expense, reload) {
  const out = [];
  const me = state.me.id;
  const spent = Number(expense?.total || 0); const handed = Number(q.disbursed_amount || 0);
  if (q.status === 'disbursed' && q.paid_via === 'cash' && q.disbursed_to === me && !q.price_rise) {
    const b = h('button', { class: 'btn', id: 'price-went-up' }, 'Price went up');
    b.onclick = busy(b, async () => {
      const amt = h('input', { class: 'input num', type: 'number', step: '0.01', min: '0.01', placeholder: '0.00' });
      const why = h('input', { class: 'input', placeholder: 'e.g. the shelf price is now N$55' });
      const ok = await confirmDialog('The price went up?', h('div', {}, h('p', {}, `You have ${money(handed)}. Say the new price: whoever approves that amount is asked straight away (marked urgent), and finance hands out the rest once it is approved.`), field('New price', amt), field('Note', why)), { ok: 'Ask for more' });
      if (!ok) return;
      await rpc('price_went_up', { p_request: q.id, p_new_total: num(amt.value), p_note: why.value.trim() || null });
      toast('Sent: you are told when it is approved and finance can hand out the rest.'); reload();
    });
    out.push(h('div', { class: 'banner', id: 'price-up-box' }, h('strong', {}, 'At the shop and it costs more?'), 'Small differences are covered by the margin you were given. If it is more than that, ask for more before you pay.', h('div', { style: { marginTop: '6px' } }, b)));
  }
  if (q.price_rise && q.status === 'disbursed') {
    const nt = Number(q.price_rise.new_total); const more = Math.max(0, nt - handed);
    const okd = q.reviewed_at != null;
    const parts = [h('strong', {}, `Price went up: ${money(nt)} instead of ${money(q.price_rise.was)}`), okd ? `Approved – ${money(more)} more to hand out.` : 'Waiting for approval.'];
    if (okd && can('finance') && q.disbursed_to !== me && q.requester_id !== me && more > 0) {
      const b = h('button', { class: 'btn btn-primary btn-sm', id: 'top-up' }, `Hand out ${money(more)} more`);
      b.onclick = busy(b, async () => { await rpc('top_up_request', { p_request: q.id, p_amount: more, p_note: 'Price went up' }); toast(`Recorded: ${money(more)} more to ${personName(q.disbursed_to)}.`); reload(); });
      parts.push(h('div', { style: { marginTop: '6px' } }, b));
    }
    out.push(h('div', { class: `banner ${okd ? 'banner-green' : 'banner-amber'}`, id: 'price-rise' }, ...parts));
  }
  if (expense && q.paid_via === 'cash' && q.status !== 'disbursed' && spent > handed + 0.004 && !expense.difference_paid_at) {
    const owed = spent - handed;
    const waiting = q.review_reason && !q.reviewed_at;
    const parts = [h('strong', {}, `${money(owed)} owed to ${q.disbursed_to === me ? 'you' : personName(q.disbursed_to)}`), `Spent ${money(spent)} with ${money(handed)} handed out.${waiting ? ' The GM checks it first.' : ''}`];
    if (!waiting && can('finance') && q.disbursed_to !== me && q.requester_id !== me) {
      const b = h('button', { class: 'btn btn-primary btn-sm', id: 'pay-difference' }, `Pay the difference (${money(owed)})`);
      b.onclick = busy(b, async () => { await rpc('pay_difference', { p_request: q.id }); toast(`Paid back ${money(owed)} to ${personName(q.disbursed_to)}.`); reload(); });
      parts.push(h('div', { style: { marginTop: '6px' } }, b));
    }
    out.push(h('div', { class: 'banner banner-amber', id: 'owed-box' }, ...parts));
  }
  if (q.requester_id === me && q.disbursed_to && q.disbursed_to !== me && !q.goods_received_at && ['disbursed', 'proof_review', 'physical_required', 'closed'].includes(q.status)) {
    const b = h('button', { class: 'btn btn-primary btn-sm', id: 'goods-received' }, 'Received');
    b.onclick = busy(b, async () => { await rpc('confirm_goods', { p_request: q.id }); toast(`${personName(q.disbursed_to)} is told you have it.`); reload(); });
    out.push(h('div', { class: 'banner', id: 'bought-for-you' }, h('strong', {}, `Being bought by ${personName(q.disbursed_to)}`), 'Tap “Received” when you have it.', h('div', { style: { marginTop: '6px' } }, b)));
  }
  return out.length ? h('div', { class: 'cash-extras' }, out) : null;
}

/* ===================================================== a pay-back date for a claim (058) */
const dayText = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
function dateDialog(title, text, { needWhy, ok }, send) {
  modal(title, (close) => {
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const date = h('input', { class: 'input', type: 'date', id: 'payback-date', min: new Date().toISOString().slice(0, 10), value: tomorrow });
    const why = h('textarea', { class: 'input', id: 'payback-why', rows: 2, spellcheck: 'true', placeholder: needWhy ? 'Why this date suits you better' : 'Optional, for example: after the bank withdrawal on Monday' });
    const b = h('button', { class: 'btn btn-primary', id: 'payback-send' }, ok);
    b.onclick = busy(b, async () => {
      if (!date.value) throw new Error('Choose a date.');
      if (needWhy && why.value.trim().length < 3) throw new Error('Say why the other date suits you better.');
      await send(date.value, why.value.trim()); close();
    });
    return h('div', {}, h('p', { class: 'muted' }, text), field('Pay-back date', date), field(needWhy ? 'Why' : 'Note', why),
      h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-quiet', onclick: close }, 'Cancel'), b));
  });
}
/** On a claim waiting to be paid back: propose a date (finance), or accept / suggest another (whoever did not propose it). */
export function paybackBox(q, reload) {
  if (q.type !== 'claim' || q.status !== 'awaiting_disbursement') return null;
  const me = state.me.id; const fin = can('finance') && q.requester_id !== me; const claimer = q.requester_id === me;
  if (!fin && !claimer) return q.payback_state === 'agreed' ? h('p', { class: 'hint', id: 'payback' }, `Pay-back date agreed: ${dayText(q.payback_date)}.`) : null;
  const propose = (needWhy, label) => {
    const b = h('button', { class: 'btn btn-sm', id: needWhy ? 'payback-other' : 'payback-propose' }, label);
    b.onclick = () => dateDialog(needWhy ? 'Suggest another date' : 'Propose a pay-back date',
      needWhy ? 'Finance is told and can accept your date or suggest another.' : `${personName(q.requester_id)} is asked to accept it, or to suggest another date. You can still pay it out straight away.`,
      { needWhy, ok: needWhy ? 'Suggest this date' : 'Propose this date' },
      async (d, why) => { await rpc('propose_payback', { p_request: q.id, p_date: d, p_note: why || null }); toast(needWhy ? 'Date suggested – finance is told.' : `Proposed – ${personName(q.requester_id)} is asked.`); reload(); });
    return b;
  };
  const accept = h('button', { class: 'btn btn-sm btn-primary', id: 'payback-accept' }, 'Accept');
  accept.onclick = busy(accept, async () => { await rpc('accept_payback', { p_request: q.id }); toast('Pay-back date agreed.'); reload(); });
  const box = (cls, title, text, ...btns) => h('div', { class: `banner ${cls}`, id: 'payback' }, h('strong', {}, title), h('span', {}, text),
    btns.length ? h('div', { class: 'row', style: { marginTop: '8px', gap: '8px', justifyContent: 'flex-start' } }, ...btns) : null);
  const by = q.payback_by === me ? 'You' : q.payback_by === q.requester_id ? personName(q.requester_id) : 'Finance';
  const why = q.payback_note ? ` – “${q.payback_note}”` : '';
  if (q.payback_state === 'agreed') return box('banner-green', `Pay-back date agreed: ${dayText(q.payback_date)}`, fin ? 'Petti reminds you that morning. You can still pay it out earlier.' : 'Finance pays you back on that day, or earlier.');
  if (q.payback_state === 'proposed') {
    if (q.payback_by === me) return box('banner-grey', `You proposed ${dayText(q.payback_date)}`, `Waiting for ${fin ? personName(q.requester_id) : 'finance'} to accept it or suggest another date.`);
    return box('banner-amber', `${by} proposes to pay back on ${dayText(q.payback_date)}${why}`, 'Accept it, or suggest another date.', accept, propose(claimer, claimer ? 'Suggest another date' : 'Propose another date'));
  }
  return fin ? box('banner-grey', 'Pay now, or agree a date', `Pay it out now below, or propose a date to pay ${personName(q.requester_id)} back.`, propose(false, 'Propose a pay-back date')) : null;
}
