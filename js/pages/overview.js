// The Managing Director's overview: live status, charts, tracking and plain-language recommendations.
// Everything is read from the same data the rest of the app uses; nothing here is stored or typed in.
import { sb, state, personName, scoped, inView, multiBranch, branchName } from '../api.js';
import { h, money, fmtDate, monthLabel, emptyState, isoDate } from '../ui.js';
import { barChart, lineChart, hBars } from '../charts.js';
import { stageDurations, fmtHours } from './reports.js';

const OPEN = ['stock_review', 'pending_approval', 'awaiting_disbursement', 'disbursed', 'proof_review', 'physical_required'];
const STAGE = {
  stock_review: 'With the stock controller', pending_approval: 'Waiting for approval', awaiting_disbursement: 'Approved, to pay out',
  disbursed: 'Cash out, receipt awaited', proof_review: 'Receipts being checked', physical_required: 'Paper receipts awaited',
};
const monthKey = (d) => String(d).slice(0, 7);
const lastMonths = (n) => { const out = []; const now = new Date(); for (let i = n - 1; i >= 0; i--) out.push(isoDate(new Date(now.getFullYear(), now.getMonth() - i, 1)).slice(0, 7)); return out; };
const shortMonth = (k) => new Date(k + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
const daysSince = (t) => (Date.now() - new Date(t)) / 86400000;
const num = (v) => Number(v || 0);
const pct = (a, b) => (b > 0 ? (a - b) / b : null);
const ago = (days) => (days < 1 ? 'today' : days < 2 ? 'yesterday' : `${Math.floor(days)} days ago`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

/** Ask for something; a failure leaves that part of the overview out instead of breaking the page. */
async function ask(p) { try { const r = await p; return r.error ? null : r.data; } catch { return null; } }

async function load() {
  const months = lastMonths(6);
  const since = months[0] + '-01';
  const since3 = isoDate(new Date(Date.now() - 90 * 864e5));
  const [lines, open, prices, events, fl, outlook, budgets, claims, counts, topUps, sched, items, reports, allFloats] = await Promise.all([
    ask(scoped(sb.from('v_spend_lines').select('*')).gte('spent_at', since).order('spent_at')),
    ask(scoped(sb.from('requests').select('id, request_no, purpose, type, status, approval_level, estimated_total, requester_id, disbursed_to, disbursed_amount, disbursed_at, submitted_at, updated_at, branch_id')).in('status', OPEN)),
    ask(sb.from('v_price_history').select('*').gte('on_date', since).order('on_date')),
    ask(sb.from('request_events').select('request_id, from_status, to_status, created_at').gte('created_at', since3).order('created_at').limit(5000)),
    ask(scoped(sb.from('v_floats').select('*')).eq('status', 'open').order('period')),
    ask(sb.rpc('branch_outlooks')),
    ask(sb.rpc('budget_status')),
    ask(sb.rpc('claims_summary')),
    ask(sb.from('cash_counts').select('*').neq('status', 'superseded').order('counted_at', { ascending: false }).limit(12)),
    ask(sb.from('top_ups').select('*').order('requested_at', { ascending: false }).limit(5)),
    ask(sb.from('schedule_versions').select('version_no, status').eq('status', 'applied').order('version_no', { ascending: false }).limit(1)),
    ask(scoped(sb.from('items').select('id, name, qty_on_hand, reorder_level, recurring')).eq('active', true)),
    ask((state.view ? sb.from('stock_reports').select('item_id, item:items!inner(branch_id)').eq('item.branch_id', state.view) : sb.from('stock_reports').select('item_id')).is('resolved_at', null)),
    ask(sb.from('floats').select('id, branch_id')),
  ]);
  const fls = allFloats || [];
  return { months, lines: lines || [], open: open || [], prices: prices || [], events: events || [], floats: fl || [], outlooks: Array.isArray(outlook) ? outlook : [], budgets: (budgets || []).filter((b) => b.active), claims: claims || [], counts: inView(counts || [], fls), topUps: inView(topUps || [], fls), schedule: (sched || [])[0] || null, items: items || [], reports: reports || [], allFloats: fls };
}

/** Turn the raw data into the numbers the screen shows and the recommendations draw on. */
function model(d) {
  const s = state.settings || {};
  const { months, lines } = d;
  const cur = months[months.length - 1];
  const byMonth = Object.fromEntries(months.map((k) => [k, 0]));
  for (const l of lines) byMonth[monthKey(l.spent_at)] = (byMonth[monthKey(l.spent_at)] || 0) + num(l.line_total);
  const spent = byMonth[cur], prev = byMonth[months[months.length - 2]];
  const prev3 = months.slice(-4, -1); const avg3 = prev3.reduce((t, k) => t + byMonth[k], 0) / Math.max(1, prev3.length);
  const avgSeries = months.map((k, i) => { const p = months.slice(Math.max(0, i - 3), i); return p.length === 3 ? p.reduce((t, x) => t + byMonth[x], 0) / 3 : null; });
  const now = new Date(); const dayOfMonth = now.getDate(); const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const pace = dayOfMonth >= 8 ? (spent / dayOfMonth) * daysInMonth : null;   // this month at today's rate

  // which category moved most against its own usual month
  const catMonth = {}; for (const l of lines) { const k = monthKey(l.spent_at); (catMonth[l.category_name || 'Uncategorised'] ||= {})[k] = (catMonth[l.category_name || 'Uncategorised'][k] || 0) + num(l.line_total); }
  const drivers = Object.entries(catMonth).map(([name, m]) => ({ name, rise: (m[cur] || 0) - prev3.reduce((t, k) => t + (m[k] || 0), 0) / Math.max(1, prev3.length) })).sort((a, b) => b.rise - a.rise);

  // the open float(s): funds, spent, and the line that climbs through the month – every open float added together when looking at all branches
  const opens = d.floats; let float = null;
  if (opens.length) {
    const ids = new Set(opens.map((f) => f.id));
    const funds = opens.reduce((t, f) => t + num(f.allocated) + num(f.topped_up) + num(f.carried_over) - num(f.returned), 0);
    const mine = lines.filter((l) => ids.has(l.float_id)).sort((a, b) => (a.spent_at < b.spent_at ? -1 : 1));
    let cum = 0; const seen = {}; for (const l of mine) { cum += num(l.line_total); seen[l.spent_at] = cum; }
    const first = isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), last = isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    float = { f: opens[0], n: opens.length, funds, cum, pts: Object.entries(seen).map(([x, y]) => ({ x, y })), first, last };
  }
  // one outlook across the branches being looked at: sums, and the worst verdict
  const rank = { no_float: 0, ok: 1, caution: 2, short: 3, overdrawn: 4 };
  const os = d.outlooks; const sum = (k) => os.reduce((t, x) => t + num(x[k]), 0);
  d.o = os.length ? { has_float: os.some((x) => x.has_float), balance: sum('balance'), after_approval: sum('after_approval'), awaiting: sum('awaiting'), expected_remaining: sum('expected_remaining'), reserve: sum('reserve'), days_left: os[0].days_left,
    status: os.filter((x) => x.has_float).map((x) => x.status).sort((a, b) => rank[b] - rank[a])[0] || 'no_float' } : null;
  d.f = opens[0] || null;

  // work in progress and cash out with people
  const grace = num(s.advance_grace_days) || 5, esc = num(s.advance_escalate_days) || 14;
  const stages = OPEN.map((k) => {
    const rs = d.open.filter((r) => r.status === k);
    return { key: k, label: STAGE[k], n: rs.length, value: rs.reduce((t, r) => t + num(r.estimated_total), 0), oldest: rs.length ? Math.max(...rs.map((r) => daysSince(k === 'disbursed' ? r.disbursed_at || r.updated_at : r.updated_at))) : 0, late: k === 'disbursed' ? grace : 2 };
  }).filter((x) => x.n);
  const advances = d.open.filter((r) => r.status === 'disbursed').map((r) => ({ r, days: daysSince(r.disbursed_at || r.updated_at) })).sort((a, b) => b.days - a.days);
  const advTotal = advances.reduce((t, a) => t + num(a.r.disbursed_amount), 0);
  const overdue = advances.filter((a) => a.days > grace);
  const waitingMD = d.open.filter((r) => r.status === 'pending_approval' && r.approval_level === 'md');
  const stale = d.open.filter((r) => r.status === 'pending_approval' && daysSince(r.updated_at) > 2);

  // the cash box
  const lastCount = d.counts[0] || null;
  const countAge = lastCount ? daysSince(lastCount.counted_at) : null;
  const diffs = d.counts.filter((c) => Math.abs(num(c.difference)) >= 0.005 && daysSince(c.counted_at) <= 90);
  const diffNet = diffs.reduce((t, c) => t + num(c.difference), 0);
  const openTopUp = d.topUps.find((t) => ['requested', 'authorised'].includes(t.status)) || null;

  // claims, price moves, controls, stock
  const claimed = d.claims.reduce((t, c) => t + num(c.claimed), 0), allSpend = d.claims.reduce((t, c) => t + num(c.all_spend), 0);
  const claimShare = allSpend > 0 ? (claimed / allSpend) * 100 : 0;
  const byItem = {}; for (const p of d.prices) (byItem[p.item_id] ||= { name: p.item_name, pts: [] }).pts.push(p);
  const rises = Object.values(byItem).filter((v) => v.pts.length > 1).map((v) => { const a = v.pts[0], b = v.pts[v.pts.length - 1]; return { name: v.name, from: num(a.unit_price), to: num(b.unit_price), chg: pct(num(b.unit_price), num(a.unit_price)), since: a.on_date }; }).filter((x) => x.chg != null && x.chg >= 0.15).sort((a, b) => b.chg - a.chg);
  const thr = num(s.approval_threshold);
  const seenReq = new Set(); const overNoApproval = [];
  for (const l of lines) { if (seenReq.has(l.request_id) || daysSince(l.spent_at) > 90) continue; seenReq.add(l.request_id); if (l.type !== 'claim' && thr && num(l.expense_total) > thr && !l.approved_by) overNoApproval.push(l); }
  const reported = new Set(d.reports.map((r) => r.item_id));
  const lowItems = d.items.filter((i) => reported.has(i.id) || (num(i.reorder_level) > 0 && num(i.qty_on_hand) < num(i.reorder_level)));

  const m = { d, s, months, byMonth, spent, prev, avg3, avgSeries, pace, drivers, float, stages, advances, advTotal, overdue, waitingMD, stale, lastCount, countAge, diffs, diffNet, openTopUp, claimed, claimShare, rises, overNoApproval, lowItems, grace, esc, thr };
  m.recs = recommend(m);
  return m;
}

/** What the MD should look at, in words, worst first. */
function recommend(m) {
  const { d, s } = m; const R = [];
  const add = (tone, title, text, href) => R.push({ tone, title, text, href });
  const many = d.outlooks.length > 1; const pre = (o) => (many ? `${o.branch} · ` : '');
  for (const o of d.outlooks) {
    if (!(o.has_float && ['overdrawn', 'short', 'caution'].includes(o.status))) continue;
    const after = num(o.after_approval); const need = Math.max(0, num(o.expected_remaining) - after); const round = Math.ceil(need / 100) * 100;
    const tu = d.topUps.find((t) => t.float_id === o.float_id && ['requested', 'authorised'].includes(t.status));
    const pending = tu ? ` A top-up of ${money(tu.amount)} is already ${tu.status === 'requested' ? 'requested' : 'authorised'}.` : round ? ` A top-up of about ${money(round)} would cover it.` : '';
    if (o.status === 'overdrawn') add('red', `${pre(o)}More has been approved than the box holds`, `Approved payments of ${money(o.awaiting)} are more than the ${money(o.balance)} in the box.${pending}`, '#/cash');
    else if (o.status === 'short') add('red', `${pre(o)}The float may not last the month`, `After what is already approved ${money(after)} is left, but about ${money(o.expected_remaining)} is usually still spent in the ${plural(num(o.days_left), 'day')} to month-end.${pending}`, '#/cash');
    else add('amber', `${pre(o)}The float is getting tight`, `${money(after)} is left after approved payments, close to the ${money(o.reserve)} usually needed to month-end.${pending}`, '#/cash');
  }
  const budgets = m.d.budgets.filter((b) => num(b.monthly_limit) > 0);
  const overB = budgets.filter((b) => num(b.used) > num(b.monthly_limit)), nearB = budgets.filter((b) => num(b.used) <= num(b.monthly_limit) && num(b.used) / num(b.monthly_limit) >= 0.8);
  if (overB.length) add('red', overB.length === 1 ? `${overB[0].label} is over budget` : `${overB.length} budgets are over`, overB.map((b) => `${b.label}: ${money(b.used)} of ${money(b.monthly_limit)}`).join(' · ') + '. Spending beyond a budget is flagged on each request.', '#/reports');
  if (nearB.length) add('amber', nearB.length === 1 ? `${nearB[0].label} is nearly used up` : `${nearB.length} budgets are almost used`, nearB.map((b) => `${b.label}: ${Math.round(num(b.used) / num(b.monthly_limit) * 100)}% (${money(b.used)} of ${money(b.monthly_limit)})`).join(' · ') + '.', '#/reports');
  if (m.overdue.length) {
    const worst = m.overdue[0];
    add(worst.days > m.esc ? 'red' : 'amber', `${plural(m.overdue.length, 'receipt')} overdue`, `${money(m.overdue.reduce((t, a) => t + num(a.r.disbursed_amount), 0))} has been out longer than ${plural(m.grace, 'day')}. Longest: ${personName(worst.r.disbursed_to)}, ${money(worst.r.disbursed_amount)}, ${Math.floor(worst.days)} days.`, '#/requests?status=disbursed');
  }
  if (m.stale.length) add('amber', `${plural(m.stale.length, 'request')} waiting over 2 days for approval`, m.stale.slice(0, 3).map((r) => `#${r.request_no} ${r.purpose} (${money(r.estimated_total)})`).join(' · ') + (m.waitingMD.length ? `. ${m.waitingMD.length} of the approvals are yours.` : '.'), '#/requests?status=pending_approval');
  for (const f of d.floats) {
    const days = num(s.cash_count_days) || 7; const bp = many ? `${branchName(f.branch_id)} · ` : '';
    const last = d.counts.find((c) => c.float_id === f.id); const age = last ? daysSince(last.counted_at) : null;
    if (!last) add('amber', `${bp}The cash box has not been counted`, 'No count has been recorded yet. A count against the book is the only proof the cash is there.', '#/cash');
    else if (days && age > days) add('amber', `${bp}The box was last counted ${ago(age)}`, `The schedule asks for a count at least every ${plural(days, 'day')}.`, '#/cash');
  }
  if (m.diffs.length) add('amber', `${plural(m.diffs.length, 'count')} did not match the book (90 days)`, `Net ${m.diffNet < 0 ? money(-m.diffNet) + ' short' : money(m.diffNet) + ' over'}. Each was explained and signed off by the General Manager; a pattern is worth a conversation.`, '#/cash');
  if (m.pace != null && m.avg3 > 0 && m.pace > m.avg3 * 1.25) {
    const top = m.drivers[0]; add('amber', `Spending is running ${Math.round((m.pace / m.avg3 - 1) * 100)}% above a usual month`, `At today's pace this month ends near ${money(m.pace)}, against a usual ${money(m.avg3)}.${top && top.rise > 0 ? ` Most of the rise is ${top.name} (${money(top.rise)} above its usual).` : ''}`, '#/reports');
  }
  if (m.claimShare >= 25 && m.claimed > 0) add('amber', `${Math.round(m.claimShare)}% of this month's spending was claimed after the fact`, `${money(m.claimed)} was paid from people's own pockets without asking first. Remind staff to ask before they spend.`, '#/reports');
  if (m.overNoApproval.length) add('amber', `${plural(m.overNoApproval.length, 'purchase')} over ${money(m.thr)} without approval (90 days)`, `The estimate was under the limit but the receipt came in over it. Finance and the GM were told each time.`, '#/reports');
  for (const r of m.rises.slice(0, 2)) add('info', `${r.name} is up ${Math.round(r.chg * 100)}%`, `${money(r.from)} → ${money(r.to)} since ${fmtDate(r.since)}. Worth asking suppliers for a quote.`, '#/reports');
  if (m.lowItems.length) add('info', `${plural(m.lowItems.length, 'store item')} low or out`, m.lowItems.slice(0, 4).map((i) => i.name).join(', ') + (m.lowItems.length > 4 ? '…' : '') + '. Restocking will draw on the float.', '#/stock');
  const order = { red: 0, amber: 1, info: 2 };
  return R.sort((a, b) => order[a.tone] - order[b.tone]);
}

/* ------------------------------ drawing ------------------------------ */

const box = (k, v, ...sub) => h('div', { class: 'box' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v), ...sub);
const dtext = (d, label) => (d == null ? null : h('span', { class: `d ${d > 0.05 ? 'up' : d < -0.05 ? 'down' : ''}` }, `${d > 0 ? '+' : ''}${Math.round(d * 100)}% ${label}`));
const sheet = (title, sub, ...body) => h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, title), sub ? h('span', { class: 'sub' }, sub) : null), ...body);

function strip(m) {
  const o = m.d.o; const f = m.d.f;
  const verdict = o && o.has_float ? { ok: ['pill-green', 'Comfortable'], caution: ['pill-amber', 'Tight'], short: ['pill-red', 'Short for the month'], overdrawn: ['pill-red', 'Overcommitted'] }[o.status] : null;
  const c = m.lastCount;
  const diff = c ? (Math.abs(num(c.difference)) < 0.005 ? 'matched the book' : num(c.difference) < 0 ? `${money(-c.difference)} short` : `${money(c.difference)} over`) : null;
  const waiting = m.d.open.filter((r) => r.status === 'pending_approval');
  return h('div', { class: 'score' },
    box('In the box', f ? money(o.balance) : '—', f && o?.has_float ? h('span', { class: 'd' }, m.d.outlooks.length > 1 ? m.d.outlooks.map((x) => `${x.branch} ${x.has_float ? money(x.balance) : 'no float'}`).join(' · ') : `${money(o.after_approval)} after approved payments`) : h('span', { class: 'd' }, f ? '' : 'no float open'), verdict ? h('span', { class: `pill ${verdict[0]}`, style: { marginTop: '4px', alignSelf: 'flex-start' } }, verdict[1]) : null),
    box('Spent this month', money(m.spent), dtext(pct(m.spent, m.prev), 'on last month'), m.avg3 > 0 ? h('span', { class: 'd' }, `usual month ${money(m.avg3)}`) : null),
    box('Cash out with people', money(m.advTotal), h('span', { class: 'd', style: m.overdue.length ? { color: 'var(--amber)' } : {} }, m.advances.length ? `${plural(m.advances.length, 'receipt')} awaited${m.overdue.length ? ` · ${m.overdue.length} overdue` : ''}` : 'all receipts in')),
    box('Waiting for approval', plural(waiting.length, 'request'), h('span', { class: 'd' }, waiting.length ? `${money(waiting.reduce((t, r) => t + num(r.estimated_total), 0))} · ${m.waitingMD.length} with you` : 'nothing waiting')),
    box('Cash box last counted', c ? ago(m.countAge) : 'never', h('span', { class: 'd', style: c && diff !== 'matched the book' ? { color: 'var(--amber)' } : {} }, c ? diff : 'count it to start the record')));
}

function recs(m) {
  const icon = { red: '●', amber: '●', info: '●' };
  return sheet('What to look at', m.recs.length ? `${m.recs.length} item${m.recs.length === 1 ? '' : 's'}` : null,
    m.recs.length ? h('div', { class: 'recs' }, m.recs.map((r) => h('a', { class: `rec ${r.tone}`, href: r.href }, h('span', { class: 'dot', 'aria-hidden': 'true' }, icon[r.tone]), h('div', {}, h('strong', {}, r.title), h('p', {}, r.text)))))
      : h('div', { class: 'rec green' }, h('span', { class: 'dot', 'aria-hidden': 'true' }, '●'), h('div', {}, h('strong', {}, 'Nothing to flag'), h('p', {}, 'The float, budgets, receipts and cash counts are all within the limits in the schedule.'))),
    h('p', { class: 'hint', style: { marginTop: '8px' } }, 'These are worked out from the figures above and the limits in the authority schedule. They are prompts for a conversation, not decisions.'));
}

function charts(m) {
  const m6 = m.months;
  const spend = sheet('Monthly spend', 'last 6 months', barChart(null, { labels: m6.map(shortMonth), values: m6.map((k) => m.byMonth[k]), line: m.avgSeries, lineName: '3-month average', format: money }));
  const fl = m.float;
  const burn = sheet(fl && fl.n > 1 ? `This month's floats (${fl.n} branches)` : 'This month\'s float', fl ? `${money(fl.cum)} spent of ${money(fl.funds)}${m.d.o?.has_float ? ` · about ${money(fl.cum + num(m.d.o.expected_remaining))} by month-end` : ''}` : 'no float open',
    fl ? (fl.pts.length ? lineChart(null, { series: [{ name: 'Spent', points: fl.pts }, { name: 'Funds', points: [{ x: fl.first, y: fl.funds }, { x: fl.last, y: fl.funds }] }], format: money, xLabel: (x) => fmtDate(x) }) : emptyState('Nothing spent yet this month', 'The line climbs as expenses are recorded.')) : emptyState('No float open', 'Finance opens the month under Petty cash.'));
  const cat = {}; const cut = isoDate(new Date(Date.now() - 90 * 864e5));
  for (const l of m.d.lines) if (l.spent_at >= cut) cat[l.category_name || 'Uncategorised'] = (cat[l.category_name || 'Uncategorised'] || 0) + num(l.line_total);
  const rows = Object.entries(cat).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 8);
  const byCat = sheet('Where the money goes', 'last 90 days', rows.length ? hBars(rows, { format: money }) : emptyState('No spending recorded yet'));
  const bud = m.d.budgets.filter((b) => num(b.monthly_limit) > 0);
  const budgets = sheet('Budgets this month', null, bud.length ? h('div', { class: 'row' }, bud.map((b) => { const p = Math.min(100, Math.round(num(b.used) / num(b.monthly_limit) * 100)); const over = num(b.used) > num(b.monthly_limit);
    return h('div', {}, h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '.85rem', marginBottom: '4px' } }, h('span', {}, b.label), h('span', { style: { color: over ? 'var(--red)' : 'var(--ink-3)' } }, `${money(b.used)} / ${money(b.monthly_limit)}`)),
      h('div', { class: 'meter' }, h('div', { class: 'meter-fill', style: { width: `${p}%`, background: over ? 'var(--red)' : p > 80 ? 'var(--amber)' : 'var(--green)' } }))); }))
    : emptyState('No budgets set', 'Budgets are part of the authority schedule.'));
  return [h('div', { class: 'grid-2' }, spend, burn), h('div', { class: 'grid-2' }, byCat, budgets)];
}

function tracking(m) {
  const flow = sheet('Where requests are', m.d.open.length ? `${m.d.open.length} open` : null,
    m.stages.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' }, h('tbody', {}, m.stages.map((x) => h('tr', { class: 'click', onclick: () => { location.hash = `#/requests?status=${x.key}`; } },
      h('td', {}, x.label), h('td', { class: 'num' }, x.n), h('td', { class: 'num muted' }, money(x.value)), h('td', { class: 'num', style: x.oldest > x.late ? { color: 'var(--amber)' } : { color: 'var(--ink-3)' } }, `oldest ${Math.max(0, Math.floor(x.oldest))}d`)))))) : emptyState('Nothing in progress', 'Everything has been paid, checked and closed.'));
  const adv = sheet('Cash out with people', m.advances.length ? `${money(m.advTotal)} · receipts awaited` : null,
    m.advances.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' }, h('tbody', {}, m.advances.slice(0, 6).map((a) => h('tr', { class: 'click', onclick: () => { location.hash = `#/requests/${a.r.id}`; } },
      h('td', {}, personName(a.r.disbursed_to), h('span', { class: 'muted' }, ` · #${a.r.request_no}`)), h('td', { class: 'num' }, money(a.r.disbursed_amount)), h('td', { class: 'num', style: a.days > m.grace ? { color: 'var(--amber)' } : { color: 'var(--ink-3)' } }, `${Math.floor(a.days)}d`)))))) : emptyState('No cash out', 'Every pay-out has its receipt.'));
  const c = m.lastCount; const tu = m.openTopUp;
  const box_ = sheet('The cash box', m.d.schedule ? `schedule version ${m.d.schedule.version_no}` : null,
    c ? h('ul', { class: 'ledger-list' }, m.d.counts.slice(0, 4).map((x) => h('li', {}, h('div', { class: 'what' }, h('strong', {}, `${m.d.outlooks.length > 1 ? `${branchName(m.d.allFloats.find((f) => f.id === x.float_id)?.branch_id)} · ` : ''}${x.kind === 'month_end' ? 'Month-end count' : 'Count'} · ${fmtDate(x.counted_at)}`), h('span', {}, `${money(x.counted)} counted · ${personName(x.counted_by)}${x.status === 'accepted' ? ` · signed off by ${personName(x.reviewed_by)}` : x.status === 'queried' ? ' · queried by the GM' : ' · waiting for the GM'}`)),
      h('span', { class: 'amt', style: Math.abs(num(x.difference)) < 0.005 ? {} : { color: 'var(--amber)' } }, Math.abs(num(x.difference)) < 0.005 ? 'matched' : num(x.difference) < 0 ? `${money(-x.difference)} short` : `${money(x.difference)} over`))))
      : emptyState('No counts yet', 'Finance counts the box under Petty cash.'),
    tu ? h('p', { class: 'hint', style: { marginTop: '8px' } }, `Top-up of ${money(tu.amount)} (${tu.reason}): ${tu.status === 'requested' ? `waiting for the ${tu.level === 'md' ? 'MD' : 'GM'}` : 'authorised, waiting for the cash'}.`) : null);
  const st = stageDurations(m.d.events).filter((x) => x.n);
  const speed = sheet('How quickly it moves', 'median wait, last 3 months', st.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' }, h('tbody', {}, st.map((x) => h('tr', {}, h('td', {}, x.label, h('span', { class: 'muted' }, ` · ${x.n}`)), h('td', { class: 'num', style: x.median > 48 ? { color: 'var(--amber)' } : {} }, fmtHours(x.median)), h('td', { class: 'num muted' }, `max ${fmtHours(x.max)}`)))))) : emptyState('Not enough history yet'));
  return [h('div', { class: 'grid-2' }, flow, adv), h('div', { class: 'grid-2' }, box_, speed)];
}

/** The whole overview as one element. */
export async function overviewSection() {
  const m = model(await load());
  const when = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return h('div', { class: 'overview' },
    h('div', { class: 'overview-head' }, h('h2', {}, 'Overview'), h('span', { class: 'live-ind', title: 'The figures update by themselves when something changes' }, h('i', {}), h('span', { class: 'live-text' }, ''), ` · updated ${when}`)),
    strip(m), recs(m), charts(m), tracking(m),
    h('p', { class: 'hint', style: { margin: '4px 0 0' } }, 'More detail: ', h('a', { href: '#/reports' }, 'Reports'), ' · ', h('a', { href: '#/cash' }, 'Petty cash'), ' · ', h('a', { href: '#/schedule' }, 'Authority schedule')));
}

/* ------------------------------ staying live ------------------------------ */

const LIVE_TABLES = ['requests', 'expenses', 'floats', 'float_transactions', 'cash_counts', 'top_ups', 'schedule_versions', 'stock_reports'];

/**
 * Build a page, then keep it current: any change to the tables above (and a quiet check every minute, in case the
 * connection drops) rebuilds it in place, without moving the scroll position. Stops when the page is left.
 */
export async function liveRoot(build) {
  const root = h('div', { class: 'live-root' });
  root.append(await build());
  let working = false, again = false, timer = null, poll = null, chan = null, connected = false, lastRun = Date.now();
  const paint = () => root.querySelectorAll('.live-text').forEach((el) => { el.textContent = connected ? 'Live' : 'Updates every minute'; el.parentElement.dataset.live = connected ? 'on' : 'off'; });
  const stop = () => { clearTimeout(timer); clearInterval(poll); document.removeEventListener('visibilitychange', onVisible); if (chan) { try { sb.removeChannel(chan); } catch {} chan = null; } };
  const reload = async () => {
    if (!root.isConnected) return stop();
    if (document.querySelector('.modal')) return later(5000);          // never rebuild under an open dialog
    if (working) { again = true; return; }
    working = true;
    try { const fresh = await build(); if (root.isConnected) { root.replaceChildren(fresh); paint(); } } catch { /* keep what is showing */ }
    finally { working = false; lastRun = Date.now(); if (again) { again = false; later(1500); } }
  };
  const later = (ms) => { clearTimeout(timer); timer = setTimeout(reload, ms); };
  function onVisible() { if (document.visibilityState === 'visible' && Date.now() - lastRun > 20000) reload(); }
  document.addEventListener('visibilitychange', onVisible);
  poll = setInterval(() => { if (document.visibilityState === 'visible') reload(); }, 60000);
  try {
    chan = sb.channel('live-' + Math.random().toString(36).slice(2));
    for (const t of LIVE_TABLES) chan.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => later(1500));
    chan.subscribe((status) => { connected = status === 'SUBSCRIBED'; paint(); });
  } catch { /* the minute check still keeps it current */ }
  paint();
  return root;
}
