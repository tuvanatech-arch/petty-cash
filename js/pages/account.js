import { sb, state, unwrap, ROLE_LABEL, cleanError, personName, pushStatus, enablePush, disablePush, testPush, signOutHere, can } from '../api.js';
import { h, mount, toast, busy, field, fmtDate, today, confirmDialog, refresh, more } from '../ui.js';
import { standinDialog, endDelegation } from './admin.js';
import { BUILD, log } from '../diag.js';
import { devicesBlock } from '../devices.js';
import { twoStepSheet } from '../twostep.js';
import { rate, revealable, newPasswordField } from '../password.js';
import { installLabel, deviceWord } from './install.js';
import { thisDevice } from '../device-label.js';

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
  const p1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 10, required: true, id: 'new-pass' });
  const p2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 10, required: true, id: 'new-pass-2' });
  const who = { email: me.email, name: me.full_name, org: state.settings?.org_name };
  const err = h('div', { class: 'error' });
  const savePass = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Change password');
  savePass.onclick = busy(savePass, async (e) => {
    e.preventDefault(); err.textContent = '';
    if (!rate(p1.value, who).ok) { err.textContent = 'Not strong enough yet: see the tips under the password.'; return; }
    if (p1.value !== p2.value) { err.textContent = 'The two passwords do not match.'; return; }
    const { error } = await sb.auth.updateUser({ password: p1.value });
    if (error) { err.textContent = cleanError(error); return; }
    p1.value = ''; p2.value = ''; toast('Password changed.');
    if (recovery) location.hash = '#/home';
  });
  const out = h('button', { class: 'btn btn-quiet btn-danger' }, 'Sign out');
  out.onclick = busy(out, async () => { await signOutHere(); });

  // email copies of alerts
  const emailToggle = h('input', { type: 'checkbox', checked: me.email_notifications !== false });
  // email sending not set up yet (the last alert email was held back for that): say so, so nobody waits for emails
  const emailNote = h('p', { class: 'hint', id: 'email-not-yet', style: { display: 'none' } }, 'Emails start once Petti’s email sending is set up. Until then alerts come here and on phones with alerts on.');
  sb.from('notifications').select('email_status').not('email_status', 'is', null).neq('email_status', 'in_app_only').order('created_at', { ascending: false }).limit(1)
    .then(({ data }) => { if (data?.[0]?.email_status === 'no_provider') emailNote.style.display = ''; }).catch(() => {});
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
  const installSheet = standalone ? null : more(installLabel(), h('p', { class: 'hint' }, 'Opens like an app, “Snap or upload” is a long-press away, and counts done without signal are sent later.'), h('a', { class: 'btn', href: '#/install' }, 'Show me how'));

  // phone alerts
  const ps = await pushStatus();
  const pushBox = h('div', {});
  function drawPush(st) {
    const onBtn = h('button', { class: 'btn btn-primary' }, `Turn on alerts on ${thisDevice()}`);
    onBtn.onclick = busy(onBtn, async () => { await enablePush(); toast(`Alerts are on for ${thisDevice()}.`); drawPush(await pushStatus()); });
    const offBtn = h('button', { class: 'btn' }, `Turn off on ${thisDevice()}`);
    offBtn.onclick = busy(offBtn, async () => { await disablePush(); toast(`Alerts off for ${thisDevice()}.`); drawPush(await pushStatus()); });
    const tst = h('button', { class: 'btn btn-quiet' }, 'Send a test');
    tst.onclick = busy(tst, async () => { await testPush(); toast('Sent – it should buzz in a moment.'); });
    mount(pushBox,
      st.on ? [h('p', { class: 'hint' }, '✓ This phone buzzes when something needs you.'), h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, tst, offBtn)]
      : st.ok ? [h('p', { class: 'hint' }, 'Get a buzz the moment something needs you – an approval, cash to collect, a receipt to check – even with the app closed.'), h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, onBtn)]
      : h('p', { class: 'hint' }, st.reason === 'ios_not_installed' ? `On ${deviceWord() === 'iPad' ? 'iPad' : 'iPhone'}, alerts work once the app is on your home screen. ` : st.reason === 'denied' ? 'Notifications are blocked for this site in the browser settings – allow them there, then come back.' : 'This browser cannot receive phone alerts; you still get them in the app and by email.',
          st.reason === 'ios_not_installed' ? h('a', { href: '#/install' }, 'Install it first') : null));
  }
  drawPush(ps);

  const passForm = h('form', {}, field('New password', newPasswordField(p1, who, { confirm: p2 })), field('Repeat it', revealable(p2)), err, h('div', { class: 'form-actions' }, savePass));

  // every device signed in to this account, with sign-out
  const devCount = h('span', { class: 'sub' });
  const devicesSheet = h('div', { class: 'sheet', id: 'devices' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Devices'), devCount),
    devicesBlock(null, { onCount: (n) => { devCount.textContent = `${n} signed in`; } }));
  if (/devices=1/.test(location.hash)) setTimeout(() => devicesSheet.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);

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
      h('label', { class: 'check', style: { marginTop: '12px' } }, emailToggle, 'Also email me (bundled – one message, not ten)'), emailNote),
    appearanceSheet(),
    twoStepSheet(),
    devicesSheet,
    standinSheet,
    rulesSheet(),
    h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'You')),
      h('form', {}, field('Your name, as shown on requests', name), h('div', { class: 'form-actions' }, saveName)),
      recovery ? passForm : more('Change password', passForm),
      installSheet, appSheet));
}

/** The policy and the authority schedule: everyone can open the policy; anyone with a position can read the schedule. */
function rulesSheet() {
  const s = state.settings || {};
  if (!s.policy_url && !can('schedule')) return null;
  return h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'The rules')),
    h('ul', { class: 'ledger-list' },
      s.policy_url ? h('li', { class: 'click', onclick: () => window.open(s.policy_url, '_blank', 'noopener') }, h('div', { class: 'what' }, h('strong', {}, 'Petty cash policy'), h('span', {}, `${s.policy_ref} · opens the current version`)), h('span', { class: 'amt' }, '↗')) : null,
      can('schedule') ? h('li', { class: 'click', onclick: () => { location.hash = can('admin') ? '#/admin/schedule' : '#/schedule'; } }, h('div', { class: 'what' }, h('strong', {}, 'Authority schedule'), h('span', {}, `${s.schedule_ref} · limits, the float, budgets and who approves what`)), h('span', { class: 'amt' }, '→')) : null));
}

/** Appearance: follow the phone (default), or always light or always dark – on this device. */
function appearanceSheet() {
  let now = 'auto'; try { now = localStorage.getItem('pcs_theme') || 'auto'; } catch {}
  const opts = [['auto', 'Automatic', 'Like your phone'], ['light', 'Light', 'Easier in bright light'], ['dark', 'Dark', 'Easier on the eyes at night']];
  const row = h('div', { class: 'appearance', role: 'radiogroup', 'aria-label': 'Appearance' });
  const draw = () => mount(row, opts.map(([k, l, sub]) => {
    const b = h('button', { type: 'button', class: `appear-opt appear-${k}${now === k ? ' on' : ''}`, role: 'radio', 'aria-checked': now === k ? 'true' : 'false' },
      h('span', { class: 'appear-swatch', 'aria-hidden': 'true' }), h('strong', {}, l), h('span', {}, sub));
    b.onclick = () => {
      now = k;
      try { if (k === 'auto') localStorage.removeItem('pcs_theme'); else localStorage.setItem('pcs_theme', k); } catch {}
      if (k === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', k);
      draw();
    };
    return b;
  }));
  draw();
  return h('div', { class: 'sheet', id: 'appearance' }, h('div', { class: 'sheet-head' }, h('h2', {}, 'Appearance'), h('span', { class: 'sub' }, 'This device')), row);
}
