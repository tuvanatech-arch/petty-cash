// "What's new": every update that affects you, in your words – what changes for you and how to use it.
// Each note also arrives as an alert (and on your phone); opening this page counts as reading them.
import { state, rpc, ROLE_LABEL } from '../api.js';
import { h, mount, fmtDate, emptyState, modal, toast, busy, confirmDialog, field, retext } from '../ui.js';
import { runTour } from '../tour.js';
import { setUpdatesCount } from '../tabbar.js';

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
  document.querySelectorAll('[data-updates]').forEach((el) => { if (el.dataset.section) return; el.textContent = n; el.style.display = n ? '' : 'none'; });
  setUpdatesCount(n);   // the bar's More and its What's new row add it to their own numbers
}

/** "Show me": the walk-through on this screen when the note has one, otherwise the screen itself. */
function showMe(u, { then = null } = {}) {
  const label = u.link_label || 'Show me';
  const b = h('button', { class: 'btn btn-primary' }, u.tour?.length ? `${label} ▸` : label);
  b.onclick = async () => { then?.(); if (u.tour?.length) await runTour(u.tour, { title: u.title }); else if (u.link) location.hash = u.link; };
  return b;
}
/** "Was this clear?" – thumbs up or down, and a line for the person who found it unclear. */
function clearAsk(u) {
  const box = h('div', { class: 'clear-ask' });
  const draw = () => {
    if (u.clear !== null && u.clear !== undefined) { mount(box, h('span', { class: 'hint' }, u.clear ? 'Thanks – glad it was clear.' : `Thanks – ${u.comment ? 'your note went to the administrator.' : 'the administrator has been told.'}`)); return; }
    const yes = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': 'Yes, clear' }, '👍 Yes');
    const no = h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': 'No, not clear' }, '👎 Not really');
    yes.onclick = busy(yes, async () => { await rpc('rate_update', { p_id: u.id, p_clear: true }); u.clear = true; draw(); });
    no.onclick = () => {
      const ta = h('textarea', { class: 'input', rows: 2, placeholder: 'What was unclear? (optional)' });
      const send = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Send');
      send.onclick = busy(send, async () => { await rpc('rate_update', { p_id: u.id, p_clear: false, p_comment: ta.value }); u.clear = false; u.comment = ta.value.trim(); draw(); });
      mount(box, h('span', { class: 'hint' }, 'Sorry about that.'), ta, h('div', { class: 'form-actions', style: { justifyContent: 'flex-start', margin: '6px 0 0' } }, send));
      ta.focus();
    };
    mount(box, h('span', { class: 'hint' }, 'Was this clear?'), yes, no);
  };
  draw();
  return box;
}
const picture = (u) => (u.image ? h('img', { class: 'update-pic', src: u.image, alt: '', loading: 'lazy' }) : null);

function noteCard(u, { open = false, fresh = false } = {}) {
  return h('article', { class: `sheet update-note${fresh ? ' fresh' : ''}${open ? ' focus' : ''}`, id: `u-${u.id}` },
    h('div', { class: 'update-head' },
      h('div', {}, h('h2', {}, u.title), h('span', { class: 'sub' }, `${fmtDate(u.sent_at)}${u.notice ? ` · notice from ${u.from || 'the administrator'}` : ''}`)),
      fresh ? h('span', { class: 'pill pill-green' }, 'New') : u.notice ? h('span', { class: 'pill pill-purple' }, 'Notice') : null),
    h('h3', { class: 'update-label' }, u.notice ? 'The message' : 'What changes for you'),
    h('p', {}, u.impact),
    picture(u),
    u.steps?.length ? h('div', {}, h('h3', { class: 'update-label' }, 'How to use it'), h('ol', { class: 'update-steps' }, u.steps.map((s) => h('li', {}, s)))) : null,
    u.link || u.tour?.length ? h('p', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, showMe(u)) : null,
    clearAsk(u));
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
    const close = modal(u.notice ? `Notice from ${u.from || 'the administrator'}` : 'What’s new', (done) => {
      const got = h('button', { class: u.tour?.length ? 'btn' : 'btn btn-primary' }, 'Got it');
      got.onclick = busy(got, async () => { await markSeen([u.id]); done(); });
      const later = h('button', { class: 'btn btn-quiet', onclick: () => done() }, 'Later');   // comes back next time
      return h('div', { class: 'update-pop' },
        h('h3', {}, u.title),
        h('h4', { class: 'update-label' }, u.notice ? 'The message' : 'What changes for you'), h('p', {}, u.impact),
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
    const fb = u.status === 'sent' && (u.clear || u.unclear) ? h('span', { class: 'hint' }, `Clear: ${u.clear} 👍 · ${u.unclear} 👎`) : null;
    const comments = (u.comments || []).map((c) => h('span', { class: 'hint' }, `${c.clear ? '👍' : '👎'} ${c.who}: “${c.text}”`));
    return h('li', {}, h('div', { class: 'what' }, h('strong', {}, u.title), h('span', {}, `To ${who(u)} · ${u.release || ''}`),
      u.status === 'sent' && u.not_seen?.length ? h('span', { class: 'hint' }, `Not read yet: ${u.not_seen.join(', ')}`) : null, fb, ...comments), state_, cancel);
  }));
  const announce = state.me.role === 'approver' ? h('button', { class: 'btn btn-primary', onclick: () => noticeDialog() }, 'Send a notice') : null;
  return h('div', { id: 'updates-admin' },
    h('div', { class: 'banner banner-grey' }, 'Every change to Petti that affects people is announced to them: what changes and how to use it, as an alert on their phone and under More → What’s new. You can send your own notices the same way – an office closure, a new rule, a reminder. Nothing here is emailed.'),
    announce ? h('div', { class: 'form-actions', style: { justifyContent: 'flex-start', margin: '0 0 12px' } }, announce) : null,
    h('div', { class: 'sheet' }, rows.length ? list : emptyState('No updates yet', 'Announcements appear here with who they went to and who has read them.')));
}

/* ---------- the administrator's own notice ---------- */
function noticeDialog() {
  modal('Send a notice', (close) => {
    const title = h('input', { class: 'input', id: 'nt-title', maxlength: 80, placeholder: 'e.g. Petty cash closed Friday afternoon' });
    const msg = h('textarea', { class: 'input', id: 'nt-msg', rows: 3, placeholder: 'What people need to know, in one or two sentences.' });
    const steps = h('textarea', { class: 'input', id: 'nt-steps', rows: 3, placeholder: 'One per line (optional)' });
    const roles = Object.entries(ROLE_LABEL).map(([k, l]) => { const c = h('input', { type: 'checkbox', value: k, id: `nt-role-${k}` }); return h('label', { class: 'check' }, c, l.replace(' (admin)', '')); });
    const branches = state.branches.length > 1 ? state.branches.map((b) => { const c = h('input', { type: 'checkbox', value: b.id, id: `nt-br-${b.id}` }); return h('label', { class: 'check' }, c, b.name); }) : [];
    const people = h('select', { class: 'input', id: 'nt-people', multiple: true, size: 4 }, state.people.filter((p) => p.active).map((p) => h('option', { value: p.id }, p.full_name)));
    const when = h('select', { class: 'input', id: 'nt-when' }, h('option', { value: 'now' }, 'Now'), h('option', { value: 'morning' }, 'Next working morning, 10:00'));
    const err = h('div', { class: 'error' });
    const send = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send');
    const whenHint = h('span', { class: 'hint' }, 'Notices sent now also buzz phones now.');
    when.onchange = async () => {
      if (when.value === 'now') { retext(whenHint, 'Notices sent now also buzz phones now.'); send.textContent = 'Send'; return; }
      send.textContent = 'Schedule';
      try { const at = await rpc('next_working_morning', { p_hour: 10 }); retext(whenHint, `Goes out ${new Date(at).toLocaleString('en-GB', { timeZone: state.settings?.time_zone || 'Africa/Windhoek', weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. You can cancel it until then.`); }
      catch { retext(whenHint, 'Goes out at 10:00 on the next working day. You can cancel it until then.'); }
    };
    const go = busy(send, async () => {
      err.textContent = '';
      const rs = roles.map((l) => l.firstChild).filter((c) => c.checked).map((c) => c.value);
      const bs = branches.map((l) => l.firstChild).filter((c) => c.checked).map((c) => c.value);
      const us = [...people.selectedOptions].map((o) => o.value);
      if (!title.value.trim() || !msg.value.trim()) { err.textContent = 'A title and a message are needed.'; return; }
      const everyone = !rs.length && !bs.length && !us.length;
      if (everyone && !(await confirmDialog('Send to everyone?', 'No role, branch or person is ticked, so every active person gets this notice.', { ok: 'Send to everyone' }))) return;
      const sendAt = when.value === 'morning' ? (await rpc('next_working_morning', { p_hour: 10 })) : null;
      await rpc('announce_notice', { p_title: title.value.trim(), p_impact: msg.value.trim(), p_steps: steps.value.split('\n').map((x) => x.trim()).filter(Boolean), p_link: null, p_roles: rs, p_branches: bs, p_users: us, p_send_at: sendAt });
      toast(sendAt ? 'Scheduled for the next working morning.' : 'Sent.'); close(); mount(document.getElementById('updates-admin'), await updatesAdminTab());
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      field('Title', title), field('Message', msg), field('Steps, if any', steps),
      field('Who gets it', h('div', { class: 'check-list' }, ...roles, ...branches), 'Tick roles or branches, or pick people below. Nothing ticked = everyone.'),
      field('Or these people', people),
      h('div', { class: 'field' }, h('label', {}, 'When'), when, whenHint),
      err, h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), send));
  }, { wide: true });
}
