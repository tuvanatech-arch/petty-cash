// "What's new": every update that affects you, in your words – what changes for you and how to use it.
// Each note also arrives as an alert (and on your phone); opening this page counts as reading them.
import { state, rpc } from '../api.js';
import { h, mount, fmtDate, emptyState, modal, toast, busy, confirmDialog } from '../ui.js';
import { runTour } from '../tour.js';

let cache = null;
/** My notes (newest first), fetched once and kept for the session. */
export async function myUpdates(force = false) {
  if (!cache || force) { const r = await rpc('my_updates'); cache = Array.isArray(r) ? r : []; }
  return cache;
}
async function markSeen(ids) {
  if (!ids.length) return;
  await rpc('mark_update_seen', { p_ids: ids }).catch(() => {});
  for (const u of cache || []) if (ids.includes(u.id) && !u.seen_at) u.seen_at = new Date().toISOString();
  syncUpdateBadge();
}
/** The number beside "What's new" in the menu. */
export function syncUpdateBadge() {
  const n = (cache || []).filter((u) => !u.seen_at).length;
  document.querySelectorAll('[data-updates]').forEach((el) => { el.textContent = n; el.style.display = n ? '' : 'none'; });
}

/** "Show me": the walk-through on this screen when the note has one, otherwise the screen itself. */
function showMe(u, { then = null } = {}) {
  const label = u.link_label || 'Show me';
  const b = h('button', { class: 'btn btn-primary' }, u.tour?.length ? `${label} ▸` : label);
  b.onclick = async () => { then?.(); if (u.tour?.length) await runTour(u.tour, { title: u.title }); else if (u.link) location.hash = u.link; };
  return b;
}
const picture = (u) => (u.image ? h('img', { class: 'update-pic', src: u.image, alt: '', loading: 'lazy' }) : null);

function noteCard(u, { open = false, fresh = false } = {}) {
  return h('article', { class: `sheet update-note${fresh ? ' fresh' : ''}${open ? ' focus' : ''}`, id: `u-${u.id}` },
    h('div', { class: 'update-head' },
      h('div', {}, h('h2', {}, u.title), h('span', { class: 'sub' }, fmtDate(u.sent_at))),
      fresh ? h('span', { class: 'pill pill-green' }, 'New') : null),
    h('h3', { class: 'update-label' }, 'What changes for you'),
    h('p', {}, u.impact),
    picture(u),
    u.steps?.length ? h('div', {}, h('h3', { class: 'update-label' }, 'How to use it'), h('ol', { class: 'update-steps' }, u.steps.map((s) => h('li', {}, s)))) : null,
    u.link || u.tour?.length ? h('p', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, showMe(u)) : null);
}

export async function updatesPage(focusId = null) {
  const list = await myUpdates(true);
  const unseen = list.filter((u) => !u.seen_at).map((u) => u.id);
  const el = h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'What’s new'), h('p', {}, 'Changes to Petti that affect you: what changes, and how to use it. The newest is at the top.'))),
    list.length ? list.map((u) => noteCard(u, { open: u.id === focusId, fresh: !u.seen_at })) : emptyState('Nothing new yet', 'When Petti changes in a way that affects your work, it is explained here and you get an alert.'));
  // on screen = read
  setTimeout(() => { markSeen(unseen); if (focusId) document.getElementById(`u-${focusId}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 300);
  return el;
}

/** Once per session, when someone lands on Home (not when they arrive from an alert with a job to do): the newest unread note. */
export async function showUnseenUpdate() {
  try {
    if (sessionStorage.getItem('pcs_update_shown')) return;
    if (!/^#?\/?(home)?$/.test(location.hash)) return;
    if (document.querySelector('.modal, .tour')) return;
    const list = await myUpdates();
    syncUpdateBadge();
    const unseen = list.filter((u) => !u.seen_at);
    if (!unseen.length) return;
    sessionStorage.setItem('pcs_update_shown', '1');
    const u = unseen[0];
    const close = modal('What’s new', (done) => {
      const got = h('button', { class: u.tour?.length ? 'btn' : 'btn btn-primary' }, 'Got it');
      got.onclick = busy(got, async () => { await markSeen([u.id]); done(); });
      const later = h('button', { class: 'btn btn-quiet', onclick: () => done() }, 'Later');   // comes back next time
      return h('div', { class: 'update-pop' },
        h('h3', {}, u.title),
        h('h4', { class: 'update-label' }, 'What changes for you'), h('p', {}, u.impact),
        picture(u),
        u.steps?.length ? h('div', {}, h('h4', { class: 'update-label' }, 'How to use it'), h('ol', { class: 'update-steps' }, u.steps.map((s) => h('li', {}, s)))) : null,
        unseen.length > 1 ? h('p', { class: 'hint' }, `${unseen.length - 1} more under More → What’s new.`) : null,
        h('div', { class: 'form-actions' },
          later,
          unseen.length > 1 ? h('a', { class: 'btn', href: '#/updates', onclick: () => close() }, `See all ${unseen.length}`) : null,
          u.link || u.tour?.length ? showMe(u, { then: () => { markSeen([u.id]); close(); } }) : null,
          got));
    });
  } catch { /* never block the app over a note */ }
}

/* ---------- Admin → Updates: what went out, to whom, who has read it ---------- */
const ROLE_WORD = { requester: 'requesters', stock_manager: 'stock', finance: 'finance', approver: 'GM', managing_director: 'MD' };
export async function updatesAdminTab() {
  const r = await rpc('update_status'); const rows = Array.isArray(r) ? r : [];
  const who = (u) => {
    const parts = [];
    if (u.roles?.length) parts.push(u.roles.map((r) => ROLE_WORD[r] || r).join(', '));
    if (u.branches?.length) parts.push(`${u.branches.length} branch${u.branches.length === 1 ? '' : 'es'}`);
    if (u.users?.length) parts.push(`${u.users.length} named ${u.users.length === 1 ? 'person' : 'people'}`);
    return parts.length ? parts.join(' + ') : 'everyone';
  };
  const list = h('ul', { class: 'ledger-list' }, rows.map((u) => {
    const state_ = u.status === 'scheduled' ? h('span', { class: 'pill pill-amber' }, `Goes out ${fmtDate(u.send_at, { time: true })}`)
      : u.status === 'cancelled' ? h('span', { class: 'pill pill-grey' }, 'Cancelled')
      : h('span', { class: `pill ${u.seen === u.recipients ? 'pill-green' : 'pill-blue'}` }, `Read by ${u.seen} of ${u.recipients}`);
    const cancel = u.status === 'scheduled' && state.me.role === 'approver' ? h('button', { class: 'btn btn-sm' }, 'Cancel') : null;
    if (cancel) cancel.onclick = async () => {
      if (!(await confirmDialog('Cancel this update?', `“${u.title}” will not be sent.`, { ok: 'Cancel it', danger: true }))) return;
      try { await rpc('cancel_update', { p_id: u.id }); toast('Cancelled – it will not be sent.'); mount(document.getElementById('updates-admin'), await updatesAdminTab()); } catch (e) { toast(e.message, { error: true }); }
    };
    return h('li', {}, h('div', { class: 'what' }, h('strong', {}, u.title), h('span', {}, `To ${who(u)} · ${u.release || ''}`),
      u.status === 'sent' && u.not_seen?.length ? h('span', { class: 'hint' }, `Not read yet: ${u.not_seen.join(', ')}`) : null), state_, cancel);
  }));
  return h('div', { id: 'updates-admin' },
    h('div', { class: 'banner banner-grey' }, 'Every change to Petti that affects people is announced to them: what changes and how to use it, as an alert on their phone and under More → What’s new. Updates are never emailed. One that has not gone out yet can be cancelled here.'),
    h('div', { class: 'sheet' }, rows.length ? list : emptyState('No updates yet', 'Announcements appear here with who they went to and who has read them.')));
}
