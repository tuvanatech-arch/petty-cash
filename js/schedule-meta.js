// What the authority schedule (MGP-SCH-PC-001) holds, in the words the screen, the PDF and the history use.
// The database (schedule_keys) holds the same list; labels match so a change reads the same everywhere.
import { personName } from './api.js';
import { money, fmtDate } from './ui.js';

export const EVERY = [[0, 'Off'], [1, 'Every day'], [3, 'Every 3 days'], [7, 'Every week'], [14, 'Every two weeks'], [30, 'Every 30 days']];
export const WEEKDAYS = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [0, 'No reminder']];
export const BUDGET_MODES = [['warn', 'Flag it, let it through'], ['require_approval', 'Send it for approval'], ['block', 'Block it']];

export const ITEMS = {
  approval_threshold: { label: 'Finance pays alone up to', kind: 'money', hint: 'Above this the General Manager approves.' },
  gm_limit: { label: 'General Manager approves up to', kind: 'money', hint: 'Above this the Managing Director approves instead.' },
  split_window_days: { label: 'Requests counted together over', kind: 'days', min: 1, max: 31, hint: 'One person’s small requests in this period are added up, so splitting a purchase cannot avoid approval.' },
  change_tolerance_pct: { label: 'Pay-out tolerance', kind: 'pct', min: 0, max: 50, hint: 'Paying or spending more than was approved by more than this goes back for approval or a review.' },
  claims_need_approval: { label: 'Every claim needs approval', kind: 'bool', hint: 'A claim is money someone paid from their own pocket without asking first. Yes: approved whatever the amount. No: claims under the finance limit go straight to finance.' },
  budget_mode: { label: 'When a request goes over its budget', kind: 'mode', hint: 'Budgets are set further down.' },
  block_with_outstanding: { label: 'Hold new pay-outs to someone who owes a receipt', kind: 'bool', hint: 'Finance sees the outstanding advance on the pay-out screen either way.' },
  default_monthly_float: { label: 'Usual monthly float', kind: 'money', hint: 'Pre-filled when finance opens a month.' },
  float_rollover: { label: 'Unspent balance carries into the next month', kind: 'bool', hint: 'No: a quiet month shows as a saving and finance receives the full float again. Yes: the float resets to the usual amount plus whatever was left.' },
  cash_variance_limit: { label: 'Cash difference allowed at a count', kind: 'money', hint: 'A count further out than this needs a reason from finance and a resolution from the GM. N$0 means every difference is explained.' },
  cash_count_days: { label: 'Cash count reminder', kind: 'every', hint: 'Finance is reminded to count the box when it has not been counted for this long.' },
  advance_grace_days: { label: 'Receipt reminder after', kind: 'days', min: 1, max: 60, hint: 'Cash out with no receipt recorded after this many days gets a reminder every few days.' },
  advance_escalate_days: { label: 'Overdue: GM and finance told after', kind: 'days', min: 1, max: 90, hint: 'From then on the GM and finance are told each week until it is settled.' },
  count_day: { label: 'Weekly stock count reminder', kind: 'weekday', hint: 'The stock controller gets a nudge to do a quick count.' },
  reserve_buffer_pct: { label: 'Safety buffer on the float minimum', kind: 'pct', min: 0, max: 100, hint: 'Added on top of what is usually spent in the rest of the month; an approval that would leave the float below it shows a caution.' },
  schedule_ref: { label: 'Schedule reference', kind: 'text', hint: 'Printed on the schedule PDF.' },
  policy_ref: { label: 'Policy reference', kind: 'text', hint: 'The petty cash policy this schedule belongs to.' },
  policy_url: { label: 'Link to the policy', kind: 'url', hint: 'Where the current policy document lives (SharePoint, Drive…). Everyone can open it from Account.' },
};

export const SECTIONS = [
  { title: 'Who approves what', md: true, keys: ['approval_threshold', 'gm_limit', 'split_window_days', 'change_tolerance_pct', 'claims_need_approval', 'budget_mode', 'block_with_outstanding'] },
  { title: 'The float and cash counts', md: true, keys: ['default_monthly_float', 'float_rollover', 'cash_variance_limit'] },
  { title: 'Reminders and warnings', md: false, keys: ['advance_grace_days', 'advance_escalate_days', 'cash_count_days', 'count_day', 'reserve_buffer_pct'] },
  { title: 'Documents', md: false, keys: ['schedule_ref', 'policy_ref', 'policy_url'] },
];

export const AREA_LABEL = { start: 'Starting schedule', rules: 'Limits, rules and reminders', budgets: 'Budgets', positions: 'Who holds each position' };

export const POSITIONS = [
  { role: 'finance', label: 'Finance – custodian of the float', duty: (s) => `Holds the cash and pays out. Pays alone up to ${money(s.approval_threshold)}; checks every receipt; counts the box and requests top-ups.` },
  { role: 'approver', label: 'General Manager', duty: (s) => `Approves above ${money(s.approval_threshold)} up to ${money(s.gm_limit)}, and finance’s own requests. Signs off cash counts and authorises top-ups up to ${money(s.gm_limit)}. Administers the app.` },
  { role: 'managing_director', label: 'Managing Director', duty: (s) => `Approves above ${money(s.gm_limit)}, the GM’s own requests and top-ups above ${money(s.gm_limit)}; approves changes to limits, rules and the float.` },
  { role: 'stock_manager', label: 'Stock controller', duty: () => 'Keeps the store and the catalogue; reviews stock requests and raises restock orders.' },
];

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
