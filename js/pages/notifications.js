import { sb, state, unwrap, rpc, refreshUnread, markAlertsRead } from '../api.js';
import { h, mount, fmtDate, emptyState } from '../ui.js';

const ICON = { approval: '✓', payout: 'N$', document: '📎', payout_undone: '↩', proof: '🧾', stock_review: '📦', cash_ready: 'N$', closed: '✓', rejected: '✕', returned: '↩', physical: '📄',
  advance_reminder: '⏰', advance_overdue: '⏰', weekly_count: '📋', price_jump: '↑', reimbursed: 'N$', approved: '✓', in_progress: '…', cancelled: '✕', stock_report: '📦', stock_report_resolved: '✓', claim: 'N$', float_warning: '⚠', pack_review: '📑', pack_sent: '📤', month_close: '📅', message: '💬', stale: '⏳', stale_escalation: '⏳', weekly_digest: '📈' };

export async function notificationsPage() {
  const rows = unwrap(await sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(100));
  const unread = rows.filter((r) => !r.read_at);
  const list = h('div', {});

  async function open(n) {
    if (!n.read_at) { n.read_at = new Date().toISOString(); rpc('mark_notifications_read', { p_ids: [n.id] }).then(refreshUnread).catch(() => {}); }
    if (n.link) location.hash = n.link; else draw();
  }
  function draw() {
    const groups = [['New', rows.filter((r) => !r.read_at)], ['Earlier', rows.filter((r) => r.read_at)]].filter(([, g]) => g.length);
    mount(list, rows.length ? groups.map(([title, g]) => h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, title), h('span', { class: 'sub' }, g.length)),
      h('ul', { class: 'ledger-list' }, g.map((n) => h('li', { class: 'click', onclick: () => open(n), style: { alignItems: 'flex-start' } },
        h('span', { style: { width: '28px', height: '28px', borderRadius: '50%', background: n.read_at ? 'var(--paper)' : 'var(--green-tint)', color: n.read_at ? 'var(--ink-3)' : 'var(--green-ink)', display: 'grid', placeItems: 'center', fontSize: '.8rem', fontWeight: 600, flex: '0 0 auto' } }, ICON[n.kind] || '•'),
        h('div', { class: 'what' }, h('strong', { style: { fontWeight: n.read_at ? 500 : 600, whiteSpace: 'normal' } }, n.title), n.body ? h('span', { style: { display: 'block', whiteSpace: 'normal' } }, n.body) : null,
          h('span', { style: { display: 'block' } }, fmtDate(n.created_at, { time: true }))))))))
      : emptyState('Nothing yet', 'You will be told here when something needs you: an approval, cash ready to collect, a receipt to check.'));
  }
  draw();
  // seen = read: the bell and the icon clear; this page still groups what was new until you leave it
  if (unread.length) markAlertsRead().catch(() => {});
  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Alerts'), h('p', {}, unread.length ? `${unread.length} new.` : 'You are up to date.')),
      null),
    list,
    h('p', { class: 'hint' }, state.me.email_notifications ? 'These also go to your email. Change that under Account.' : 'Email copies are switched off. Change that under Account.'));
}
