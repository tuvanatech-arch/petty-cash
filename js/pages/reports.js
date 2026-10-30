import { sb, state, can, personName, unwrap, scoped, multiBranch, branchName, rpc } from '../api.js';
import { h, mount, money, qty, fmtDate, monthLabel, pill, emptyState, select, field, isoDate, more, toast, busy, confirmDialog, refresh } from '../ui.js';
import { barChart, lineChart, hBars } from '../charts.js';

const thr = () => Number(state.settings?.approval_threshold || 0);
const monthKey = (d) => String(d).slice(0, 7);
function lastMonths(n) { const out = []; const now = new Date(); for (let i = n - 1; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); out.push(isoDate(d).slice(0, 7)); } return out; }
const shortMonth = (k) => new Date(k + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });

/** Median hours spent in each workflow stage, from the event log. */
export function stageDurations(events) {
  const byReq = {};
  for (const e of events) (byReq[e.request_id] ||= []).push(e);
  const stages = { stock_review: 'Stock review', pending_approval: 'Approval', awaiting_disbursement: 'Finance pay-out', disbursed: 'Receipt recorded by spender', proof_review: 'Finance receipt check' };
  const samples = Object.fromEntries(Object.keys(stages).map((k) => [k, []]));
  for (const evs of Object.values(byReq)) {
    evs.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    for (let i = 0; i < evs.length; i++) {
      const to = evs[i].to_status; if (!stages[to]) continue;
      const next = evs.slice(i + 1).find((e) => e.from_status === to && e.to_status !== to);
      if (next) samples[to].push((new Date(next.created_at) - new Date(evs[i].created_at)) / 36e5);
    }
  }
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  return Object.entries(stages).map(([k, label]) => ({ key: k, label, n: samples[k].length, median: median(samples[k]), max: samples[k].length ? Math.max(...samples[k]) : null }));
}
export const fmtHours = (hrs) => (hrs == null ? '—' : hrs < 1 ? `${Math.round(hrs * 60)} min` : hrs < 48 ? `${hrs.toFixed(hrs < 10 ? 1 : 0)} h` : `${(hrs / 24).toFixed(1)} days`);

export async function reportsPage(startTab = null) {
  const months = lastMonths(13);
  const since = months[0] + '-01';
  const since3 = months[months.length - 3] + '-01';
  const [lines, requests, prices, items, floats, events, { data: budgets }] = await Promise.all([
    unwrap(await scoped(sb.from('v_spend_lines').select('*')).gte('spent_at', since).order('spent_at')),
    unwrap(await scoped(sb.from('requests').select('*, expense:expenses(total)')).gte('created_at', since).order('created_at')),
    unwrap(await sb.from('v_price_history').select('*').order('on_date')),
    unwrap(await scoped(sb.from('items').select('*')).eq('active', true).order('name')),
    can('finance') ? unwrap(await scoped(sb.from('v_floats').select('*')).order('period')) : [],
    unwrap(await sb.from('request_events').select('request_id, from_status, to_status, created_at').gte('created_at', since3).order('created_at').limit(5000)),
    sb.rpc('budget_status'),
  ]);
  // money spent before anyone approved it (claims), per person: this month and the last 12
  const m12from = months[Math.max(0, months.length - 12)] + '-01';
  const [{ data: claimsNow }, { data: claims12 }, { data: exceptions }] = await Promise.all([sb.rpc('claims_summary'), sb.rpc('claims_summary', { p_from: m12from }), sb.rpc('exceptions_log', { p_from: m12from })]);
  const exc = Array.isArray(exceptions) ? exceptions : [];
  const scorecard = buildScorecard({ months, lines, requests, items, events, budgets: (budgets || []).filter((b) => b.active) });

  let range = 3; // months in the "period" views
  let tab = ['spending', 'prices', 'controls'].includes(startTab) ? startTab : 'spending';
  const rangeSel = select([[1, 'This month'], [3, 'Last 3 months'], [6, 'Last 6 months'], [12, 'Last 12 months']], 3, { onchange: (e) => { range = Number(e.target.value); draw(); } });
  const tabBar = h('div', { class: 'tabs', style: { marginTop: '4px' } });
  const periodMonths = () => months.slice(-range);
  const inPeriod = (l) => periodMonths().includes(monthKey(l.spent_at));
  const body = h('div', {});

  function draw() {
    const pm = periodMonths(); const pl = lines.filter(inPeriod);
    const total = pl.reduce((s, l) => s + Number(l.line_total), 0);

    /* --- monthly spend (6 months) with 3-month trailing average --- */
    const m6 = months.slice(-6);
    const byMonth = Object.fromEntries(months.map((k) => [k, 0]));
    for (const l of lines) byMonth[monthKey(l.spent_at)] = (byMonth[monthKey(l.spent_at)] || 0) + Number(l.line_total);
    const avg = m6.map((k) => { const i = months.indexOf(k); const prev = months.slice(Math.max(0, i - 3), i); return prev.length === 3 ? prev.reduce((s, p) => s + byMonth[p], 0) / 3 : null; });
    const thisMonth = byMonth[months[months.length - 1]]; const lastAvg = avg[avg.length - 1];

    /* --- float burn-down for the open month --- */
    // the open month: one float, or every branch's open float added together when looking at all branches
    const opens = floats.filter((f) => f.status === 'open');
    const open = opens[0];
    let burn = null;
    if (open) {
      const ids = new Set(opens.map((f) => f.id));
      const fl = lines.filter((l) => ids.has(l.float_id)).sort((a, b) => (a.spent_at < b.spent_at ? -1 : 1));
      let cum = 0; const pts = []; const seen = {};
      for (const l of fl) { cum += Number(l.line_total); seen[l.spent_at] = cum; }
      for (const [x, y] of Object.entries(seen)) pts.push({ x, y });
      const funds = opens.reduce((s, f) => s + Number(f.allocated) + Number(f.topped_up) + Number(f.carried_over) - Number(f.returned), 0);
      burn = { pts, funds, cum };
    }

    /* --- by category / supplier / requester --- */
    const sumBy = (key) => { const m = {}; for (const l of pl) { const k = l[key] || '—'; m[k] = (m[k] || 0) + Number(l.line_total); } return Object.entries(m).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value); };
    const byCat = sumBy('category_name'); const bySup = sumBy('supplier_name').map((r) => ({ ...r, label: r.label === '—' ? 'No supplier recorded' : r.label }));
    const byReq = sumBy('requester_name');

    /* --- price trends --- */
    const byItem = {};
    for (const p of prices) { (byItem[p.item_id] ||= { name: p.item_name, unit: p.unit, pts: [] }).pts.push(p); }
    const trendRows = Object.entries(byItem).map(([id, v]) => { const first = v.pts[0], last = v.pts[v.pts.length - 1]; const chg = Number(first.unit_price) ? (Number(last.unit_price) - Number(first.unit_price)) / Number(first.unit_price) : 0; return { id, name: v.name, n: v.pts.length, first: Number(first.unit_price), last: Number(last.unit_price), chg, since: first.on_date, min: Math.min(...v.pts.map((p) => Number(p.unit_price))), max: Math.max(...v.pts.map((p) => Number(p.unit_price))) }; })
      .sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg));
    const itemSel = select(Object.entries(byItem).map(([id, v]) => [id, v.name]), trendRows[0]?.id || '');
    const trendChart = h('div', {});
    const drawTrend = () => { const v = byItem[itemSel.value]; mount(trendChart, v ? lineChart(null, { series: [{ name: '', points: v.pts.map((p) => ({ x: p.on_date, y: Number(p.unit_price) })) }], format: money, xLabel: (x) => fmtDate(x) }) : emptyState('No purchases recorded yet', 'Unit prices appear here once expenses are recorded against catalogue items.')); };
    itemSel.onchange = drawTrend; drawTrend();

    /* --- recurring items: expected vs bought --- */
    const rec = items.filter((i) => i.recurring);
    const recRows = rec.map((i) => { const bought = {}; for (const l of lines) if (l.item_id === i.id) bought[monthKey(l.spent_at)] = (bought[monthKey(l.spent_at)] || 0) + Number(l.qty); return { i, bought }; });
    const recMonths = months.slice(-4);

    /* --- controls --- */
    const m12 = months.slice(-12);
    const closedish = requests.filter((r) => ['proof_review', 'physical_required', 'closed'].includes(r.status) && m12.includes(monthKey(r.created_at)));
    const exTotal = (r) => Number((Array.isArray(r.expense) ? r.expense[0] : r.expense)?.total || 0);
    const above = requests.filter((r) => r.approval_required && m12.includes(monthKey(r.created_at)));
    const nearMiss = requests.filter((r) => !r.approval_required && Number(r.estimated_total) >= thr() * 0.9 && Number(r.estimated_total) <= thr() && r.status !== 'draft' && m12.includes(monthKey(r.created_at)));
    const overUnapproved = closedish.filter((r) => exTotal(r) > thr() && !r.approved_by);
    const splits = []; const byDay = {};
    for (const r of requests) { if (r.status === 'draft' || r.approval_required) continue; const k = `${r.requester_id}|${String(r.submitted_at || r.created_at).slice(0, 10)}`; (byDay[k] ||= []).push(r); }
    for (const [k, rs] of Object.entries(byDay)) { const sum = rs.reduce((s, r) => s + Number(r.estimated_total), 0); if (rs.length > 1 && sum > thr()) splits.push({ who: rs[0].requester_id, day: k.split('|')[1], rs, sum }); }

    const reqRow = (r) => h('tr', { class: 'click', onclick: () => { location.hash = `#/requests/${r.id}`; } }, h('td', {}, `#${r.request_no} ${r.purpose}`), h('td', { class: 'muted' }, personName(r.requester_id)), h('td', { class: 'muted' }, fmtDate(r.submitted_at || r.created_at)), h('td', {}, pill(r.status)), h('td', { class: 'num' }, money(exTotal(r) || r.estimated_total)));
    const tbl = (rows, empty) => rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' }, h('tbody', {}, rows.map(reqRow)))) : h('p', { class: 'hint' }, empty);

    const flags = exc.filter((x) => x.state === 'open').length;
    mount(tabBar, [['spending', 'Spending'], ['prices', 'Prices & items'], ['controls', flags ? `Controls (${flags})` : 'Controls']].map(([k, l]) => h('button', { class: k === tab ? 'active' : '', onclick: () => { tab = k; draw(); } }, l)));
    rangeSel.style.display = tab === 'spending' ? '' : 'none';
    const sections = {
      spending: () => [
      h('div', { class: 'grid-3' },
        h('div', { class: 'sheet stat' }, h('span', { class: 'k' }, `Spent in ${pm.length === 1 ? monthLabel(pm[0] + '-01') : `the last ${pm.length} months`}`), h('span', { class: 'v' }, money(total))),
        h('div', { class: 'sheet stat' }, h('span', { class: 'k' }, 'This month vs 3-month average'), h('span', { class: 'v' }, money(thisMonth), lastAvg != null ? h('small', { style: { color: thisMonth > lastAvg * 1.1 ? 'var(--amber)' : 'var(--ink-3)' } }, `avg ${money(lastAvg)}`) : null))),
      h('div', { class: 'grid-2' },
        h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Monthly spend'), h('span', { class: 'sub' }, 'last 6 months')), barChart(null, { labels: m6.map(shortMonth), values: m6.map((k) => byMonth[k]), line: avg, lineName: '3-month average', format: money })),
        h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Float burn-down'), h('span', { class: 'sub' }, open ? `${monthLabel(open.period)} · ${money(burn.cum)} of ${money(burn.funds)} spent` : 'no open float')),
          open ? (burn.pts.length ? lineChart(null, { series: [{ name: '', points: burn.pts }], format: money, xLabel: (x) => fmtDate(x) }) : emptyState('Nothing spent yet this month', 'The line climbs as expenses are recorded.')) : (can('finance') ? emptyState('No open float', 'Open the month under Petty cash.') : emptyState('Finance only', 'Float figures are visible to finance and the approver.')))),
      h('div', { class: 'grid-2' },
        h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'By category'), h('span', { class: 'sub' }, periodLabel())), byCat.length ? hBars(byCat, { format: money }) : emptyState('No spend in this period')),
        h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'By supplier'), h('span', { class: 'sub' }, periodLabel())), bySup.length ? hBars(bySup.slice(0, 10), { format: money }) : emptyState('No spend in this period'))),
        more('By requester', h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'By requester'), h('span', { class: 'sub' }, periodLabel())), byReq.length ? hBars(byReq, { format: money }) : emptyState('No spend in this period')))],
      prices: () => [
        h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Unit price over time'), itemSel), trendChart),
      h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Price movement by item'), h('span', { class: 'sub' }, 'first recorded price against the latest')),
        trendRows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', { class: 'num' }, 'Purchases'), h('th', { class: 'num' }, 'First'), h('th', { class: 'num' }, 'Latest'), h('th', { class: 'num' }, 'Low – high'), h('th', { class: 'num' }, 'Change'))),
          h('tbody', {}, trendRows.map((r) => h('tr', {}, h('td', {}, r.name, h('span', { class: 'muted' }, ` · since ${fmtDate(r.since)}`)), h('td', { class: 'num' }, r.n), h('td', { class: 'num' }, money(r.first)), h('td', { class: 'num amt' }, money(r.last)), h('td', { class: 'num muted' }, `${money(r.min)} – ${money(r.max)}`),
            h('td', { class: 'num', style: { color: r.chg > 0.05 ? 'var(--red)' : r.chg < -0.05 ? 'var(--green-ink)' : '' } }, r.n > 1 ? `${r.chg > 0 ? '+' : ''}${(r.chg * 100).toFixed(0)}%` : '—')))))) : emptyState('No price history yet', 'Record expenses against catalogue items to build it up.')),
      rec.length ? h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Recurring items: expected vs bought'), h('span', { class: 'sub' }, 'quantities per month')),
        h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', { class: 'num' }, 'Expected'), recMonths.map((k) => h('th', { class: 'num' }, shortMonth(k))), h('th', { class: 'num' }, 'On hand'))),
          h('tbody', {}, recRows.map(({ i, bought }) => h('tr', {}, h('td', {}, i.name), h('td', { class: 'num muted' }, qty(i.expected_monthly_qty)),
            recMonths.map((k) => { const b = bought[k] || 0; const exp = Number(i.expected_monthly_qty); return h('td', { class: 'num', style: { color: exp && b > exp * 1.25 ? 'var(--amber)' : '' } }, b ? qty(b) : '—'); }),
            h('td', { class: 'num amt' }, `${qty(i.qty_on_hand)} ${i.unit}`))))))) : null,
      ],
      controls: () => [
      exceptionsSheet(exc),
      claimsSheet(claimsNow || [], claims12 || []),
      h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Around the limit'), h('span', { class: 'sub' }, `the ${money(thr())} threshold, last 12 months`)),
        h('h3', { style: { margin: '8px 0 6px' } }, `Spent above ${money(thr())} without approval`), h('p', { class: 'hint' }, 'The estimate was under the limit but the receipt came in over it.'), tbl(overUnapproved, 'None.'),
        h('h3', { style: { margin: '16px 0 6px' } }, `Just under the limit (${money(thr() * 0.9)} – ${money(thr())})`), tbl(nearMiss, 'None.'))],
    };
    mount(body, scorecard, tabBar, sections[tab]());
  }
  function periodLabel() { const pm = periodMonths(); return pm.length === 1 ? monthLabel(pm[0] + '-01') : `${shortMonth(pm[0])} – ${shortMonth(pm[pm.length - 1])}`; }

  draw();
  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, multiBranch() ? `Reports · ${state.view ? branchName(state.view) : 'all branches'}` : 'Reports'), h('p', {}, 'The scorecard first; the detail when you want it.')),
      h('div', { class: 'page-actions' }, rangeSel, exportButton(lines))),
    body);
}

/** The Approval and Exception Log: every override, correction and delegated action, with who, why and whether it was reviewed. */
export function exceptionsSheet(rows, { compact = false } = {}) {
  const gm = can('admin');
  let only = 'open'; const list = h('div', {});
  const TONE = { open: ['Open', 'pill-amber'], reviewed: ['Cleared', 'pill-green'], auto: ['Reviewed', 'pill-green'], info: ['Logged', 'pill-grey'] };
  const clear = (x, outcome) => { const b = h('button', { class: `btn btn-sm ${outcome === 'resolved' ? 'btn-primary' : ''}` }, outcome === 'justified' ? 'Justified' : 'Resolved');
    b.onclick = busy(b, async (e) => { e.stopPropagation(); const why = await confirmDialog(outcome === 'justified' ? 'Mark as justified' : 'Mark as resolved', x.title + ' – ' + (x.detail || ''), { ok: outcome === 'justified' ? 'Justified' : 'Resolved', note: { label: 'In a few words', required: true } }); if (!why) return; await rpc('review_exception', { p_kind: x.kind, p_ref: x.ref, p_outcome: outcome, p_note: why }); toast('Cleared.'); refresh(); }); return b; };
  const draw = () => {
    const shown = rows.filter((x) => only === 'all' || (only === 'open' ? x.state === 'open' : only === 'reviewed' ? ['reviewed', 'auto'].includes(x.state) : x.state === 'info'));
    mount(list, shown.length ? h('ul', { class: 'ledger-list' }, shown.slice(0, compact ? 8 : 300).map((x) => h('li', { class: x.request_id ? 'click' : '', onclick: x.request_id ? () => { location.hash = `#/requests/${x.request_id}`; } : null },
      h('div', { class: 'what' }, h('strong', {}, x.title), h('span', {}, `${fmtDate(x.at)}${x.who ? ` · ${personName(x.who)}` : ''}${x.detail ? ` · ${x.detail}` : ''}`),
        x.at2 || x.note ? h('span', { style: { display: 'block' } }, `${x.by_whom ? `${x.state === 'reviewed' ? (x.outcome === 'resolved' ? 'Resolved' : 'Justified') : 'By'} ${personName(x.by_whom)}` : ''}${x.at2 ? `, ${fmtDate(x.at2)}` : ''}${x.note ? ` – “${x.note}”` : ''}`) : null),
      x.amount != null ? h('span', { class: 'amt' }, money(x.amount)) : null,
      x.state === 'open' && gm ? h('div', { class: 'row-actions', onclick: (e) => e.stopPropagation() }, clear(x, 'justified'), clear(x, 'resolved')) : h('span', { class: `pill ${TONE[x.state][1]}` }, TONE[x.state][0]))))
      : emptyState(only === 'open' ? 'Nothing open' : 'Nothing here', only === 'open' ? 'Every exception has been looked at.' : ''));
  };
  const chips = h('div', { class: 'tabs', style: { borderBottom: 0, marginBottom: '6px' } });
  const n = (k) => rows.filter((x) => k === 'all' || (k === 'open' ? x.state === 'open' : k === 'reviewed' ? ['reviewed', 'auto'].includes(x.state) : x.state === 'info')).length;
  const drawChips = () => mount(chips, [['open', 'Open'], ['reviewed', 'Reviewed'], ['info', 'Logged'], ['all', 'All']].map(([k, l]) => h('button', { class: k === only ? 'active' : '', onclick: () => { only = k; drawChips(); draw(); } }, `${l} (${n(k)})`)));
  drawChips(); draw();
  return h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Approval and exception log'), h('span', { class: 'sub' }, 'last 12 months')),
    h('p', { class: 'hint' }, 'Every override, correction and delegated action: money spent before approval, approvals over budget, spending looked at after payment, possible split purchases, undone pay-outs, stock corrections, cash differences, overdue receipts, actions by stand-ins, and changes to the schedule, people and branches. Open ones wait for the General Manager to mark them justified or resolved.'),
    compact ? null : chips, list);
}

/** Claims are money spent before approval: how much of each person's spend went that way. */
function claimsSheet(now, year) {
  const byId = Object.fromEntries(year.map((r) => [r.person_id, r]));
  for (const r of now) byId[r.person_id] = { ...(byId[r.person_id] || r), now: r };
  const rows = Object.values(byId).sort((a, b) => Number(b.claimed) - Number(a.claimed));
  const totNow = now.reduce((s, r) => s + Number(r.claimed), 0), nNow = now.reduce((s, r) => s + Number(r.claims), 0);
  const tone = (share) => (Number(share) >= 25 ? 'var(--amber)' : '');
  return h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Spent before approval'), h('span', { class: 'sub' }, nNow ? `this month: ${money(totNow)} across ${nNow} claim${nNow === 1 ? '' : 's'}` : 'none this month')),
    h('p', { class: 'hint' }, 'A claim is money someone paid out of pocket without a prior request. A rising share is a conversation, not a rule – every claim already passes the approver.'),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Person'), h('th', { class: 'num' }, 'This month'), h('th', { class: 'num' }, 'Last 12 months'), h('th', { class: 'num' }, 'Claims'), h('th', { class: 'num' }, 'Share of their spend'))),
      h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.person_name), h('td', { class: 'num' }, r.now ? money(r.now.claimed) : '—'), h('td', { class: 'num amt' }, money(r.claimed)), h('td', { class: 'num muted' }, r.claims),
        h('td', { class: 'num', style: { color: tone(r.share) } }, `${Number(r.share).toFixed(0)}%`))))))
      : h('p', { class: 'hint' }, 'No claims in the last 12 months.'));
}

/** One-screen scorecard for the approver: is this month normal, and where does the time go. */
export function buildScorecard({ months, lines, requests, items, events, budgets }) {
  const cur = months[months.length - 1], prev = months[months.length - 2], lastYear = months[0];
  const sum = (k) => lines.filter((l) => monthKey(l.spent_at) === k).reduce((s, l) => s + Number(l.line_total), 0);
  const curTotal = sum(cur), prevTotal = sum(prev), lyTotal = sum(lastYear);
  const headcount = Math.max(1, Number(state.settings?.headcount || 1));
  const delta = (now, then) => (then > 0 ? (now - then) / then : null);
  const dText = (d, label) => (d == null ? h('span', { class: 'd' }, `no ${label} to compare`) : h('span', { class: `d ${d > 0.05 ? 'up' : d < -0.05 ? 'down' : ''}` }, `${d > 0 ? '+' : ''}${Math.round(d * 100)}% vs ${label}`));
  const box = (k, v, ...d) => h('div', { class: 'box' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v), ...d);

  const thisMonthReqs = requests.filter((r) => monthKey(r.submitted_at || r.created_at) === cur && !['draft', 'cancelled'].includes(r.status));
  const viaApproval = thisMonthReqs.filter((r) => r.approval_required || r.approved_by).length;
  const pctApproval = thisMonthReqs.length ? Math.round(viaApproval / thisMonthReqs.length * 100) : null;
  const claims = thisMonthReqs.filter((r) => r.type === 'claim').length;

  const top = {};
  for (const l of lines) if (monthKey(l.spent_at) === cur) { const k = l.item_id ? l.description : (l.description || '—'); top[k] = (top[k] || 0) + Number(l.line_total); }
  const topItems = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const stages = stageDurations(events).filter((s) => s.n);

  return h('div', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, h('h2', {}, 'Scorecard'), h('span', { class: 'sub' }, `${monthLabel(cur + '-01')} at a glance`)),
    h('div', { class: 'score' },
      box('Spent this month', money(curTotal), dText(delta(curTotal, prevTotal), 'last month'), dText(delta(curTotal, lyTotal), monthLabel(lastYear + '-01'))),
      box('Cost per head', money(curTotal / headcount), h('span', { class: 'd' }, `${headcount} people · last month ${money(prevTotal / headcount)}`)),
      box('Went through approval', pctApproval == null ? '—' : `${pctApproval}%`, h('span', { class: 'd' }, thisMonthReqs.length ? `${viaApproval} of ${thisMonthReqs.length} requests` : 'no requests yet')),
      box('Claims (paid from own pocket)', claims, h('span', { class: 'd' }, claims ? 'reimbursed from the float' : 'none this month'))),
    h('div', { class: 'grid-2', style: { marginTop: '14px' } },
      h('div', {}, h('h3', { style: { marginBottom: '6px' } }, 'Top 5 this month'),
        topItems.length ? h('table', { class: 'ledger' }, h('tbody', {}, topItems.map(([name, v]) => h('tr', {}, h('td', {}, name), h('td', { class: 'num' }, money(v)))))) : h('p', { class: 'hint' }, 'Nothing recorded yet.')),
      h('div', {}, h('h3', { style: { marginBottom: '6px' } }, 'Where the time goes'), h('p', { class: 'hint' }, 'Median wait in each stage, last 3 months.'),
        stages.length ? h('table', { class: 'ledger' }, h('tbody', {}, stages.map((s) => h('tr', {}, h('td', {}, s.label, h('span', { class: 'muted' }, ` · ${s.n}`)), h('td', { class: 'num', style: { color: s.median > 48 ? 'var(--amber)' : '' } }, fmtHours(s.median)), h('td', { class: 'num muted' }, `max ${fmtHours(s.max)}`))))) : h('p', { class: 'hint' }, 'Not enough history yet.'))),
    budgets.length ? h('div', { style: { marginTop: '14px' } }, h('h3', { style: { marginBottom: '6px' } }, 'Budgets this month'),
      h('div', { class: 'row' }, budgets.map((b) => { const pct = Number(b.monthly_limit) > 0 ? Math.min(100, Math.round(Number(b.used) / Number(b.monthly_limit) * 100)) : 0; const over = Number(b.used) > Number(b.monthly_limit);
        return h('div', {}, h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '.85rem', marginBottom: '4px' } }, h('span', {}, b.label), h('span', { style: { color: over ? 'var(--red)' : 'var(--ink-3)' } }, `${money(b.used)} / ${money(b.monthly_limit)}`)),
          h('div', { class: 'meter' }, h('div', { class: 'meter-fill', style: { width: `${pct}%`, background: over ? 'var(--red)' : pct > 80 ? 'var(--amber)' : 'var(--green)' } }))); }))) : null);
}

function exportButton(lines) {
  return h('button', { class: 'btn', onclick: () => {
    const cols = ['spent_at', 'request_no', 'type', 'requester_name', 'category_name', 'description', 'qty', 'unit_price', 'line_total', 'supplier_name', 'status'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...lines.map((l) => cols.map((c) => esc(l[c])).join(','))].join('\n');
    const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `petty-cash-spend-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a); a.click(); a.remove();
  } }, 'Export CSV');
}
