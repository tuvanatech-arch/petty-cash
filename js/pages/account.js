import { sb, state, unwrap, ROLE_LABEL, cleanError, personName, pushStatus, enablePush, disablePush, testPush } from '../api.js';
import { h, mount, toast, busy, field, fmtDate, today, confirmDialog, refresh, more } from '../ui.js';
import { standinDialog, endDelegation } from './admin.js';
import { BUILD, log } from '../diag.js';

export async function accountPage() {
  const me = state.me;
  const recovery = /recovery=1/.test(location.hash);
  const name = h('input', { class: 'input', value: me.full_name });
  const saveName = h('button', { class: 'btn', type: 'submit' }, 'Save name');
  saveName.onclick = busy(saveName, async (e) => {
    e.preventDefault();
    unwrap(await sb.from('profiles').update({ full_name: name.value.trim() }).eq('id', me.id));
    state.me.full_name = name.value.trim(); toast('Name saved.');
  });
  const p1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const p2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const err = h('div', { class: 'error' });
  const savePass = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Change password');
  savePass.onclick = busy(savePass, async (e) => {
    e.preventDefault(); err.textContent = '';
    if (p1.value.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
    if (p1.value !== p2.value) { err.textContent = 'The two passwords do not match.'; return; }
    const { error } = await sb.auth.updateUser({ password: p1.value });
    if (error) { err.textContent = cleanError(error); return; }
    p1.value = ''; p2.value = ''; toast('Password changed.');
    if (recovery) location.hash = '#/home';
  });
  const out = h('button', { class: 'btn btn-quiet btn-danger' }, 'Sign out');
  out.onclick = busy(out, async () => { await sb.auth.signOut(); });

  // email copies of alerts
  const emailToggle = h('input', { type: 'checkbox', checked: me.email_notifications !== false });
  emailToggle.onchange = async () => {
    try { unwrap(await sb.from('profiles').update({ email_notifications: emailToggle.checked }).eq('id', me.id)); state.me.email_notifications = emailToggle.checked; toast(emailToggle.checked ? 'Email copies on.' : 'Email copies off.'); }
    catch (e) { emailToggle.checked = !emailToggle.checked; toast(e.message, { error: true }); }
  };

  // my stand-in (only roles with a queue)
  let standinSheet = null;
  if (me.role !== 'requester') {
    const t = today();
    const mine = unwrap(await sb.from('delegations').select('*').eq('from_user', me.id).gte('ends_on', t).order('starts_on'));
    standinSheet = h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'When you are away')),
      mine.length ? h('ul', { class: 'ledger-list' }, mine.map((d) => h('li', {},
        h('div', { class: 'what' }, h('strong', {}, `${personName(d.to_user)} covers for you`), h('span', {}, `${fmtDate(d.starts_on)} – ${fmtDate(d.ends_on)}${d.note ? ` · ${d.note}` : ''}${d.starts_on > t ? ' · not started yet' : ''}`)),
        h('button', { class: 'btn btn-sm btn-quiet', onclick: () => standinDialog(d, { fixedFrom: me }) }, 'Edit'),
        h('button', { class: 'btn btn-sm btn-quiet btn-danger', onclick: async () => { if (!(await confirmDialog('End this stand-in?', `${personName(d.to_user)} will stop seeing your queue.`, { ok: 'End it', danger: true }))) return; try { await endDelegation(d); toast('Ended.'); refresh(); } catch (e) { toast(e.message, { error: true }); } } }, 'End'))))
        : h('p', { class: 'hint' }, 'Nobody covers for you yet. Set someone before leave so nothing waits.'),
      h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, h('button', { class: 'btn btn-sm', onclick: () => standinDialog(null, { fixedFrom: me }) }, mine.length ? 'Add another' : 'Set a stand-in')));
  }

  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone;
  const installSheet = standalone ? null : more('Put it on your phone', h('p', { class: 'hint' }, 'Opens like an app, “Snap or upload” is a long-press away, and counts done without signal are sent later.'), h('a', { class: 'btn', href: '#/install' }, 'Show me how'));

  // phone alerts
  const ps = await pushStatus();
  const pushBox = h('div', {});
  function drawPush(st) {
    const onBtn = h('button', { class: 'btn btn-primary' }, 'Turn on alerts on this phone');
    onBtn.onclick = busy(onBtn, async () => { await enablePush(); toast('Alerts are on for this phone.'); drawPush(await pushStatus()); });
    const offBtn = h('button', { class: 'btn' }, 'Turn off on this phone');
    offBtn.onclick = busy(offBtn, async () => { await disablePush(); toast('Alerts off for this phone.'); drawPush(await pushStatus()); });
    const tst = h('button', { class: 'btn btn-quiet' }, 'Send a test');
    tst.onclick = busy(tst, async () => { await testPush(); toast('Sent – it should buzz in a moment.'); });
    mount(pushBox,
      st.on ? [h('p', { class: 'hint' }, '✓ This phone buzzes when something needs you.'), h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, tst, offBtn)]
      : st.ok ? [h('p', { class: 'hint' }, 'Get a buzz the moment something needs you – an approval, cash to collect, a receipt to check – even with the app closed.'), h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, onBtn)]
      : h('p', { class: 'hint' }, st.reason === 'ios_not_installed' ? 'On iPhone, alerts work once the app is on your home screen. ' : st.reason === 'denied' ? 'Notifications are blocked for this site in the browser settings – allow them there, then come back.' : 'This browser cannot receive phone alerts; you still get them in the app and by email.',
          st.reason === 'ios_not_installed' ? h('a', { href: '#/install' }, 'Install it first') : null));
  }
  drawPush(ps);

  const passForm = h('form', {}, field('New password', p1), field('Repeat it', p2), err, h('div', { class: 'form-actions' }, savePass));

  // the app itself: which build this phone runs, a reload, and a way to tell the admin what went wrong
  const note = h('textarea', { class: 'input', rows: 2, placeholder: 'What happened? e.g. “Home page stuck after I opened it”' });
  const send = h('button', { class: 'btn btn-sm' }, 'Send to the admin');
  send.onclick = busy(send, async () => { if (!note.value.trim()) return; log('report', note.value.trim()); note.value = ''; toast('Sent – thank you.'); });
  const appSheet = more('About this app', h('p', { class: 'hint' }, `Build ${BUILD}${standalone ? ' · installed' : ''}. If a page sticks, pull down to refresh${standalone ? '' : ' or reload the browser'}.`),
    h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, h('button', { class: 'btn btn-sm', onclick: () => location.reload() }, 'Reload now')),
    field('Something went wrong?', note), h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, send));
  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Account'), h('p', {}, `${me.email} · ${ROLE_LABEL[me.role]}`)), h('div', { class: 'page-actions' }, out)),
    recovery ? h('div', { class: 'banner banner-green' }, h('strong', {}, 'Set a new password'), 'You arrived from a reset link. Choose a new password below.') : null,
    h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Alerts')),
      pushBox,
      h('label', { class: 'check', style: { marginTop: '12px' } }, emailToggle, 'Also email me (bundled – one message, not ten)')),
    standinSheet,
    h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'You')),
      h('form', {}, field('Your name, as shown on requests', name), h('div', { class: 'form-actions' }, saveName)),
      recovery ? passForm : more('Change password', passForm),
      installSheet, appSheet));
}
