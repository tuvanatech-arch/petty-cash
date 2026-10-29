// Learning without nagging: a set-up checklist for the approver, a three-line welcome per role, one-time hints,
// and a "How it works" page. What a person has dismissed is remembered on their profile, so a phone and a laptop
// do not both ask; the browser copy only covers the moment before the profile has loaded.
import { sb, state, role, can, rpc, ROLE_LABEL } from './api.js';
import { h, mount, money, toast, busy, more, setTipStore } from './ui.js';

const thr = () => money(state.settings?.approval_threshold || 0);

/* ---------- memory ---------- */
export function seen(key) {
  if (state.me?.seen_tips?.[key]) return true;
  try { return !!localStorage.getItem(`pcs_hint_${key}`); } catch { return false; }
}
export function markSeen(key, isSeen = true) {
  if (state.me) state.me.seen_tips = isSeen ? { ...(state.me.seen_tips || {}), [key]: true } : Object.fromEntries(Object.entries(state.me.seen_tips || {}).filter(([k]) => k !== key));
  try { isSeen ? localStorage.setItem(`pcs_hint_${key}`, '1') : localStorage.removeItem(`pcs_hint_${key}`); } catch {}
  sb.rpc('mark_tip', { p_key: key, p_seen: isSeen }).then(() => {}, () => {});
}
export async function resetTips() {
  if (state.me) state.me.seen_tips = {};
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('pcs_hint_')) localStorage.removeItem(k); } catch {}
  await rpc('mark_tip', { p_key: null });
}
setTipStore({ seen, markSeen });

/* ---------- the approver's set-up checklist ---------- */
export async function setupCard() {
  if (role() !== 'approver' || seen('setup_hidden')) return null;
  const { data: s } = await sb.rpc('setup_status');
  if (!s || !Object.keys(s).length) return null;
  const standalone = !!(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true);
  const steps = [
    { done: !!s.company, title: 'Company and the rules', what: `Name and currency under Settings; the ${thr()} approval line and the usual monthly float on the Schedule.`, href: '#/admin/schedule', go: 'Schedule' },
    { done: !!s.people, title: 'People', what: s.people ? `Finance: ${s.finance_named}${s.stock_manager_named ? ` · Stock: ${s.stock_manager_named}` : ''}` : 'Add finance first, then the stock manager and the team. Each gets a temporary password you hand over.', href: '#/admin', go: 'People' },
    { done: Number(s.items) > 0 || seen('setup_stock_skip'), title: 'Stock catalogue', what: Number(s.items) > 0 ? `${s.items} item${s.items === 1 ? '' : 's'} on the shelf.` : 'The things you buy again and again – paper, toner, cleaning. The stock manager can do this; or skip it and add items as they come up.', href: '#/stock', go: 'Stock', skip: 'setup_stock_skip' },
    { done: !!s.float, title: 'This month’s float', what: s.float ? 'Open.' : 'Finance opens the month under Petty cash with the cash actually in the box. You can too.', href: '#/cash', go: 'Petty cash' },
    { done: !!s.alerts || seen('setup_phone_skip'), title: 'Phones and alerts', what: s.alerts ? 'This phone buzzes when something needs you.' : `${standalone ? 'Turn on alerts under Account' : 'Put it on your home screen, then turn on alerts'} – and tell the team to do the same.`, href: standalone ? '#/account' : '#/install', go: standalone ? 'Account' : 'Install', skip: 'setup_phone_skip' },
  ];
  const n = steps.filter((x) => x.done).length;
  if (n === steps.length) { markSeen('setup_hidden'); return null; }
  const box = h('div', { class: 'sheet setup' });
  const hide = h('button', { class: 'btn btn-sm btn-quiet' }, 'Hide');
  hide.onclick = () => { markSeen('setup_hidden'); box.remove(); toast('Hidden. It is listed under More → How it works if you need it back.'); };
  mount(box,
    h('div', { class: 'sheet-head' }, h('h2', {}, 'Set up in 5 steps'), h('span', { class: 'sub' }, `${n} of ${steps.length} done`)),
    n ? h('p', { class: 'hint done-line' }, `Done: ${steps.filter((x) => x.done).map((x) => x.title.toLowerCase()).join(' · ')}.`) : null,
    h('ol', { class: 'steps' }, steps.map((st, i) => st.done ? null : h('li', { 'data-n': String(i + 1) },
      h('div', { class: 'what' }, h('strong', {}, st.title), h('span', {}, st.what)),
      h('span', { class: 'row-actions' },
        h('a', { class: 'btn btn-sm', href: st.href }, st.go),
        st.skip ? h('button', { class: 'btn btn-sm btn-quiet', onclick: (e) => { markSeen(st.skip); const li = e.target.closest('li'); li.classList.add('done'); li.querySelector('.row-actions').remove(); } }, 'Skip') : null)))),
    h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, hide));
  return box;
}

/* ---------- three lines per role, once ---------- */
const WELCOME = {
  requester: { lines: ['Need something? “Ask for cash” – or report low stock and the stock manager takes it from there.', 'Bought it? Snap or upload the receipt; the app files it against your request.', 'Paid from your own pocket? Snap it – it becomes a claim, signed off before you are paid back.'], go: ['#/snap', 'Snap or upload'] },
  finance: { lines: ['Everything waiting for you is on this Home: pay-outs, receipts to check, cash to chase.', 'Pay out with the exact amount; people snap their receipts and you confirm them here.', 'Count the box under Petty cash → Count cash at least weekly; the GM signs each count off. Need more cash? Request a top-up – it carries a count.', 'Month-end: close the month under Petty cash (a count like any other) – the pack builds itself for your review.'], go: ['#/cash', 'Petty cash'] },
  stock_manager: { lines: ['The team reports low or out; the reports land here, grouped by item.', 'Tick what to buy and raise one restock order – it goes to the approver, then finance.', 'A quick count once a week keeps “runs out” honest; it works without signal.'], go: ['#/stock', 'Stock'] },
  managing_director: { lines: ['Requests above the GM limit, and the GM’s own, come to you for approval; each shows what the float can carry after it.', 'Your own requests are paid without approval and reviewed by the GM afterwards.', 'Reports gives the month at a glance: spending, claims, budgets and who approved what.', 'Changes to the limits and the float in the authority schedule wait for your approval; you are told of every other change.'], go: ['#/reports', 'Reports'] },
  approver: { lines: ['Approvals up to the GM limit are yours (never your own); each shows what the float can carry after it.', 'Claims are money spent before approval – every one passes you, and Reports shows who does it.', 'Finance’s cash counts and top-up requests come to your Home: sign off each count (write a difference off if it will not be found) and authorise top-ups.', 'Reports gives the month at a glance; the month-end pack goes to the accountant after finance’s review.'], go: ['#/reports', 'Reports'] },
};
export function welcomeStrip({ actedAlready = false } = {}) {
  const r = role(); const w = WELCOME[r];
  const key = `welcome_${r}`;
  if (!w || seen(key)) return null;
  if (actedAlready) { markSeen(key); return null; }   // they have used it already: nothing to teach
  const el = h('div', { class: 'sheet welcome' },
    h('div', { class: 'sheet-head' }, h('h2', {}, `How this works for you`), h('button', { class: 'btn btn-sm btn-quiet', onclick: () => { markSeen(key); el.remove(); } }, 'Got it')),
    h('ol', {}, w.lines.map((t) => h('li', {}, t))),
    h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, h('a', { class: 'btn btn-sm', href: w.go[0] }, w.go[1]), h('a', { class: 'btn btn-sm btn-quiet', href: '#/how' }, 'The whole picture')));
  return el;
}

/* ---------- How it works ---------- */
const HOW = {
  requester: ['Ask for cash (or a stock item) from Home. Under the approval line it goes straight to finance; above it, the approver signs it off first.', 'Finance pays you out and the request moves to you. Buy the thing.', 'Snap or upload the receipt – the app reads it, matches it to your pay-out and fills the lines in. Confirm, and finance checks it.', 'Change goes back to finance; if you paid extra, finance reimburses it with the settlement.', 'Paid from your own pocket with no request? Snap the receipt: it becomes a claim, the approver signs it off, finance pays you back.', 'Something low in the store? Report it – the stock manager decides what to buy.'],
  finance: ['Home shows what is yours: pay-outs waiting, receipts to check, cash out too long.', 'Pay out with the exact amount. An invoice attached beforehand sets it for you. A mistake can be undone until something is recorded against it.', 'People snap receipts; you confirm, return for correction, or ask for the paper original.', 'Claims are reimbursed for exactly what was claimed, after the approver has signed them off.', 'Count the box any day with “Count cash”; a difference needs a short reason and the GM signs every count off. Top-ups are requested with a count, authorised by the GM, and recorded when the cash arrives.', 'A receipt photo already used on another request is flagged; accepting it needs a note saying why it is right.', 'Month-end: count the box, close the month – the pack with every receipt, the counts and the cash ledger builds itself. Review it, then send it to the accountant from the app.', 'Need the stock manager’s or approver’s queue while they are away? Stand-ins, under Account.'],
  stock_manager: ['Home shows the team’s reports and anything measured low, as one list.', 'Issue from the store, or tick what to buy and raise one restock order from the reports – approver, then finance.', 'Receiving stock clears the reports and the item counts.', 'Quick count once a week: tick what is on the shelf; the difference becomes usage, and “runs out” stays honest. Works without signal.', 'Items, suppliers and categories are yours alone – a stand-in covers the day-to-day, not the catalogue.'],
  approver: ['Only approvals are yours. Each shows the float after it and what is usually still spent this month; you are cautioned when it gets tight.', 'Questions go on the request, not by returning it – the other side gets a buzz.', 'Claims (spent before approval) always pass you; Reports → Controls shows who does it and how often.', 'Reports: the scorecard first, then spending, prices, and the controls around the approval line.', 'Admin: people (you create every account), stand-ins, the authority schedule (limits, float, reminders, budgets – every change a version, the MD approves the limits) and settings. A weekly backup runs on its own.', 'Month-end: finance closes the month and reviews the pack; it is emailed to the accountant with you in copy.'],
};
export async function howPage() {
  const mine = role();
  const order = [mine, ...Object.keys(HOW).filter((r) => r !== mine)];
  const section = (r) => h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, r === mine ? 'You' : ROLE_LABEL[r].replace(' (admin)', '')), h('span', { class: 'sub' }, ROLE_LABEL[r])), h('ol', { class: 'how' }, HOW[r].map((t) => h('li', {}, t))));
  const again = h('button', { class: 'btn btn-sm' }, 'Show tips again');
  again.onclick = busy(again, async () => { await resetTips(); toast('Tips will show again as you go.'); });
  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'How it works'), h('p', {}, 'One screen per role. Yours first.')), h('div', { class: 'page-actions' }, again)),
    section(mine),
    more('Everyone else', ...order.slice(1).map(section)),
    role() === 'approver' ? h('p', { class: 'hint', style: { marginTop: '12px' } }, 'Getting started: the 5-step checklist sits on your Home until it is complete. ', h('button', { class: 'linkish', onclick: () => { markSeen('setup_hidden', false); location.hash = '#/home'; } }, 'Show it again')) : null);
}
