// What the authority schedule holds, in the words the screen, the PDF and the history use.
// The database (schedule_keys) holds the same list; labels match so a change reads the same everywhere.
import { personName } from './api.js';
import { money, fmtDate } from './ui.js';

export const EVERY = [[0, 'Off'], [1, 'Every day'], [3, 'Every 3 days'], [7, 'Every week'], [14, 'Every two weeks'], [30, 'Every 30 days']];
export const WEEKDAYS = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [0, 'No reminder']];
export const BUDGET_MODES = [['warn', 'Flag it, let it through'], ['require_approval', 'Send it for approval'], ['block', 'Block it']];

export const ITEMS = {
  approval_threshold: { label: 'Finance pays alone up to', kind: 'money', hint: 'No approval needed up to this amount. N$0: every amount is approved first.' },
  gm_step: { label: 'The GM approves above that', kind: 'bool', hint: 'No: amounts above what finance pays alone go straight to the MD.' },
  gm_limit: { label: 'General Manager approves up to', kind: 'money', hint: 'Above this the Managing Director approves instead.' },
  md_step: { label: 'The MD approves above the GM limit', kind: 'bool', hint: 'No: the GM approves every amount above what finance pays alone.' },
  quick_payout_limit: { label: '“Pay out now” (cash without a request) up to', kind: 'money', hint: 'Finance hands out small urgent cash straight from Petty cash, logged but with no request. Never more than finance pays alone; N$0 switches it off.' },
  split_window_days: { label: 'Requests counted together over', kind: 'days', min: 1, max: 31, hint: 'One person’s small requests in this period are added up, so splitting a purchase cannot avoid approval.' },
  change_tolerance_pct: { label: 'Pay-out tolerance', kind: 'pct', min: 0, max: 50, hint: 'Paying or spending more than was approved by more than this goes back for approval or a review.' },
  claims_need_approval: { label: 'Every claim needs approval', kind: 'bool', hint: 'A claim is money someone paid from their own pocket without asking first. Yes: approved whatever the amount. No: claims under the finance limit go straight to finance.' },
  budget_mode: { label: 'When a request goes over its budget', kind: 'mode', hint: 'Budgets are set further down.' },
  block_with_outstanding: { label: 'Hold new pay-outs to someone who owes a receipt', kind: 'bool', hint: 'Finance sees the outstanding advance on the pay-out screen either way.' },
  default_monthly_float: { label: 'Usual monthly float', kind: 'money', hint: 'Pre-filled when finance opens a month.' },
  float_rollover: { label: 'Unspent balance carries into the next month', kind: 'bool', hint: 'No: a quiet month shows as a saving and finance receives the full float again. Yes: the float resets to the usual amount plus whatever was left.' },
  cash_variance_limit: { label: 'Cash difference allowed at a count', kind: 'money', hint: 'A count further out than this needs a reason from finance and a resolution from the GM. N$0 means every difference is explained.' },
  cash_count_days: { label: 'Cash count reminder', kind: 'every', hint: 'Finance is reminded to count the box when it has not been counted for this long.' },
  stock_adjust_limit: { label: 'Stock correction the controller may make alone', kind: 'money', hint: 'A count difference on an issued item, a manual correction or a short delivery worth up to this is applied and logged; above it the GM approves before the balance changes. The same limit decides when someone other than the controller signs a delivery in.' },
  advance_grace_days: { label: 'Receipt reminder after', kind: 'days', min: 1, max: 60, hint: 'Cash out with no receipt recorded after this many days gets a reminder every few days.' },
  advance_escalate_days: { label: 'Overdue: GM and finance told after', kind: 'days', min: 1, max: 90, hint: 'From then on the GM and finance are told each week until it is settled.' },
  count_day: { label: 'Weekly stock count reminder', kind: 'weekday', hint: 'The stock controller gets a nudge to do a quick count.' },
  reserve_buffer_pct: { label: 'Safety buffer on the float minimum', kind: 'pct', min: 0, max: 100, hint: 'Added on top of what is usually spent in the rest of the month; an approval that would leave the float below it shows a caution.' },
  schedule_ref: { label: 'Schedule reference', kind: 'text', hint: 'Printed on the schedule PDF.' },
  policy_ref: { label: 'Policy reference', kind: 'text', hint: 'The petty cash policy this schedule belongs to.' },
  policy_url: { label: 'Link to the policy', kind: 'url', hint: 'Where the current policy document lives (SharePoint, Drive…). Everyone can open it from Account.' },
};

export const SECTIONS = [
  { title: 'Who approves what', md: true, keys: ['approval_threshold', 'gm_step', 'gm_limit', 'md_step', 'quick_payout_limit', 'split_window_days', 'change_tolerance_pct', 'claims_need_approval', 'budget_mode', 'block_with_outstanding'] },
  { title: 'The float and cash counts', md: true, keys: ['default_monthly_float', 'float_rollover', 'cash_variance_limit'] },
  { title: 'The store', md: true, keys: ['stock_adjust_limit'] },
  { title: 'Reminders and warnings', md: false, keys: ['advance_grace_days', 'advance_escalate_days', 'cash_count_days', 'count_day', 'reserve_buffer_pct'] },
  { title: 'Documents', md: false, keys: ['schedule_ref', 'policy_ref', 'policy_url'] },
];

export const AREA_LABEL = { start: 'Starting schedule', rules: 'Limits, rules and reminders', budgets: 'Budgets', positions: 'Who holds each position' };

export const POSITIONS = [
  { role: 'finance', label: 'Finance – custodian of the float', duty: (s) => `Holds the cash and makes every pay-out. Pays alone up to ${money(s.approval_threshold)}; checks every receipt; counts the box and requests top-ups.` },
  { role: 'approver', label: 'General Manager', duty: (s) => `${gmBand(s) ? `Approves ${gmBand(s)}, ` : 'Approves '}finance’s own requests, claims and top-ups${mdBand(s) ? ` up to ${money(s.gm_limit)}` : ''}. Signs off cash counts. Approves stock corrections above ${money(s.stock_adjust_limit)}. Administers the app.` },
  { role: 'managing_director', label: 'Managing Director', duty: (s) => `${mdBand(s) ? `Approves ${mdBand(s)} (requests and top-ups), and ` : 'Approves '}the GM’s own requests; approves changes to limits, rules and the float.` },
  { role: 'stock_manager', label: 'Stock controller', duty: (s) => `Keeps the store and the catalogue; records hand-outs of issued items; confirms deliveries; counts the shelf; corrects differences up to ${money(s.stock_adjust_limit)} alone; reviews stock requests and raises restock orders.` },
];

/** Who approves an amount under the approval steps: null (finance pays alone), 'gm' or 'md' – as approval_level_for in the database. */
export function approvalLevelFor(amount, s) {
  const a = Number(amount);
  if (a <= Number(s?.approval_threshold ?? 0)) return null;
  const gm = s?.gm_step !== false; const md = s?.md_step !== false;
  if (gm && (!md || a <= Number(s?.gm_limit ?? 0))) return 'gm';
  return md ? 'md' : 'gm';
}
/** "Pay out now": its own limit, never above what finance pays alone. */
export const quickLimit = (s) => Math.min(Number(s?.quick_payout_limit ?? s?.approval_threshold ?? 0), Number(s?.approval_threshold ?? 0));
const gmBand = (s) => (s.gm_step === false ? '' : s.md_step === false ? `above ${money(s.approval_threshold)}` : `above ${money(s.approval_threshold)} up to ${money(s.gm_limit)}`);
const mdBand = (s) => (s.md_step === false ? '' : `above ${money(s.gm_step === false ? s.approval_threshold : s.gm_limit)}`);
/** The approval steps in plain words, one line each – the Schedule screen and its PDF show these. */
export function approvalSteps(s) {
  const thr = Number(s.approval_threshold);
  const lines = [thr > 0 ? `Up to ${money(thr)}: finance pays, no approval needed.` : 'Every amount is approved before it is paid.'];
  if (s.gm_step !== false && s.md_step !== false) lines.push(`${money(thr)} – ${money(s.gm_limit)}: the GM approves.`, `Above ${money(s.gm_limit)}: the MD approves.`);
  else if (s.gm_step !== false) lines.push(`Above ${money(thr)}: the GM approves, whatever the amount.`);
  else lines.push(`Above ${money(thr)}: the MD approves.`);
  const q = quickLimit(s);
  lines.push(q > 0 ? `“Pay out now” (cash without a request): up to ${money(q)}.` : '“Pay out now” is switched off.');
  lines.push('Always: finance pays; nobody approves or pays their own request; finance’s own requests go to the GM and the GM’s own to the MD; top-ups and payments from the company account are always approved.');
  return lines;
}

/** The approval steps as a picture: one row per amount band, with who acts in order (the roles), as approvalSteps. */
export function approvalFlow(s) {
  const thr = Number(s.approval_threshold); const gm = s.gm_step !== false; const md = s.md_step !== false;
  const rows = thr > 0 ? [{ band: `Up to ${money(thr)}`, steps: ['finance'] }] : [];
  if (gm && md) rows.push({ band: thr > 0 ? `${money(thr)} – ${money(s.gm_limit)}` : `Up to ${money(s.gm_limit)}`, steps: ['approver', 'finance'] }, { band: `Above ${money(s.gm_limit)}`, steps: ['managing_director', 'finance'] });
  else rows.push({ band: thr > 0 ? `Above ${money(thr)}` : 'Every amount', steps: [gm ? 'approver' : 'managing_director', 'finance'] });
  return rows;
}
/** Ready-made approval setups: which steps are on. The amounts stay as they are. */
export const SETUPS = [
  { id: 'gm', label: 'The GM approves', hint: 'One approver for everything above what finance pays alone.', gm_step: true, md_step: false },
  { id: 'gm_md', label: 'The GM, then the MD', hint: 'The GM approves up to the GM limit, the MD above it.', gm_step: true, md_step: true },
  { id: 'md', label: 'The MD approves', hint: 'The MD approves everything above what finance pays alone.', gm_step: false, md_step: true },
];
export const setupOf = (s) => SETUPS.find((x) => x.gm_step === (s.gm_step !== false) && x.md_step === (s.md_step !== false)) || null;

/** A schedule value in words, the same way the database writes it in the history. */
export function fmtValue(key, v) {
  const it = ITEMS[key];
  if (v === null || v === undefined || v === '') return '—';
  if (!it) return String(v);
  switch (it.kind) {
    case 'money': return money(v);
    case 'days': return `${Number(v)} ${Number(v) === 1 ? 'day' : 'days'}`;
    case 'pct': return `${Number(v)}%`;
    case 'bool': return v === true || v === 'true' ? 'Yes' : 'No';
    case 'mode': return (BUDGET_MODES.find(([k]) => k === v) || [null, String(v)])[1];
    case 'weekday': return (WEEKDAYS.find(([k]) => String(k) === String(v)) || [null, String(v)])[1];
    case 'every': return (EVERY.find(([k]) => String(k) === String(v)) || [null, `Every ${Number(v)} days`])[1];
    default: return String(v);
  }
}

/** How a version came to be in effect (or not), in a few words. */
export function versionStatus(v) {
  if (v.status === 'pending') return { text: 'Waiting for the MD', pill: 'pill-purple' };
  if (v.status === 'withdrawn') return { text: v.decision_note === 'Nothing left to change' ? 'Nothing left to change' : `Withdrawn${v.decided_by ? ` by ${personName(v.decided_by)}` : ''}`, pill: 'pill-grey' };
  if (v.status === 'rejected') return { text: `Not approved by ${personName(v.decided_by)}`, pill: 'pill-red' };
  switch (v.md_status) {
    case 'approved': return { text: `Approved by ${personName(v.decided_by)}, ${fmtDate(v.decided_at)}`, pill: 'pill-green' };
    case 'notified': return { text: 'MD told', pill: 'pill-grey' };
    case 'by_md': return { text: 'Set by the MD', pill: 'pill-green' };
    case 'reviewed': return { text: `Reviewed by ${personName(v.decided_by)}, ${fmtDate(v.decided_at)}`, pill: 'pill-green' };
    case 'no_md': return { text: 'Before an MD was set up – for the MD to review', pill: 'pill-amber' };
    default: return { text: '', pill: 'pill-grey' };
  }
}

export const changeText = (c) => `${c.label}: ${c.from} → ${c.to}`;
