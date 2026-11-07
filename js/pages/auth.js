import { sb, adminUsers, accountMail, cleanError, state, loadSessionContext, signOutHere } from '../api.js';
import { h, field, busy, toast } from '../ui.js';
import { rate, revealable, newPasswordField } from '../password.js';
import { installLabel } from './install.js';
import { keepDefault, rememberChoice, stayNote } from '../stay.js';

const brand = () => h('div', { class: 'brand' }, h('div', { class: 'brand-mark', 'aria-hidden': 'true' }, h('span', {}, 'P', h('span', { class: 'dot' }, '.'))),
  h('div', { class: 'brand-name' }, 'Petti', h('span', { class: 'dot' }, '.'), h('small', {}, 'Petty cash & stock · by Tuvana Tech')));

export async function authPage() {
  let needsBootstrap = false;
  try { ({ needs_bootstrap: needsBootstrap } = await adminUsers({ action: 'status' })); } catch { /* show login anyway */ }
  let why = null;
  try { why = sessionStorage.getItem('pcs_out'); sessionStorage.removeItem('pcs_out'); } catch {}
  const note = why === 'elsewhere' ? h('div', { class: 'banner banner-amber', style: { marginBottom: '14px' } }, h('strong', {}, 'You were signed out on this device'),
    'It was signed out from another device or by the administrator. Sign in again if that was meant – if it was not you, change your password after signing in.')
    : stayNote(why) ? h('div', { class: 'banner', id: 'stay-note', style: { marginBottom: '14px' } }, stayNote(why)) : null;
  return h('div', { class: 'auth' }, h('div', { class: 'card' }, brand(), note, needsBootstrap ? bootstrapForm() : loginForm()));
}

function loginForm() {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'username', required: true, placeholder: 'you@company.com' });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const err = h('div', { class: 'error' });
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in');
  // "Keep me signed in": ticked in the phone app, not in a browser (a computer may be shared)
  const keep = h('input', { type: 'checkbox', id: 'keep-signed-in', checked: keepDefault() });
  const keepRow = h('label', { class: 'check', style: { margin: '4px 0 12px' } }, keep, h('span', {}, 'Keep me signed in on this device', h('span', { class: 'hint', style: { display: 'block' } }, 'For 30 days. Leave it off on a shared computer: you are signed out when the browser closes or after 30 minutes without use.')));
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('h1', {}, 'Sign in'),
    h('p', { class: 'lead' }, 'Requests, approvals and receipts for the petty cash float.'),
    field('Email', email), field('Password', revealable(pass)), keepRow, err, btn,
    linkBtn,
    h('div', { class: 'links' },
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); forgot(email.value); } }, 'Forgot password?'),
      h('a', { href: '#/install' }, installLabel())),
    h('p', { class: 'hint', style: { marginTop: '10px' } }, 'No account? Ask your administrator.'));
  const submit = busy(btn, async () => {
    err.textContent = '';
    // a weak password is noticed here, the only moment Petti sees it: a stronger one is asked for straight after
    try { if (!rate(pass.value, { email: email.value }).ok) sessionStorage.setItem('pcs_pw_weak', '1'); else sessionStorage.removeItem('pcs_pw_weak'); } catch {}
    rememberChoice(keep.checked);
    const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
    if (error) { try { sessionStorage.removeItem('pcs_pw_weak'); } catch {} err.textContent = /invalid/i.test(error.message) ? 'Email or password is wrong.' : cleanError(error); }
  });
  return form;
}

// no password: a one-tap sign-in link by email (the link opens the app already signed in)
const linkBtn = h('button', { class: 'btn btn-block', type: 'button', style: { marginTop: '8px' } }, 'Email me a sign-in link instead');
linkBtn.onclick = busy(linkBtn, async () => {
  const email = document.querySelector('.auth input[type=email]')?.value.trim();
  if (!email) { toast('Enter your email first.', { error: true }); return; }
  try {
    const r = await accountMail({ action: 'magiclink', email });
    if (!r.sent && r.reason === 'no_provider') { toast('Email is not set up yet – sign in with your password, or ask your administrator for a sign-in link.', { error: true, ms: 8000 }); return; }
    if (!r.sent) { toast('The email could not be sent right now. Use your password, or ask your administrator.', { error: true, ms: 8000 }); return; }
    toast(`If that email has an account, a sign-in link is on its way to ${email}. Open it on this device and you are in.`, { ms: 9000 });
  } catch (e) { toast(cleanError(e), { error: true, ms: 7000 }); }
});

async function forgot(email) {
  if (!email) { toast('Enter your email first, then tap “Forgot password”.', { error: true }); return; }
  try {
    const r = await accountMail({ action: 'reset', email: email.trim() });
    if (!r.sent && r.reason === 'no_provider') { toast('Email is not set up yet. Ask your administrator – they can set you a new password in a moment.', { error: true, ms: 8000 }); return; }
    if (!r.sent) { toast('The email could not be sent right now. Ask your administrator to set you a new password.', { error: true, ms: 8000 }); return; }
    toast('If that email has an account, a reset link is on its way. Your administrator can also set a new password for you.', { ms: 7000 });
  } catch (e) { toast(cleanError(e), { error: true, ms: 7000 }); }
}

function bootstrapForm() {
  const name = h('input', { class: 'input', required: true, autocomplete: 'name' });
  const email = h('input', { class: 'input', type: 'email', required: true, autocomplete: 'username' });
  const pass = h('input', { class: 'input', type: 'password', required: true, autocomplete: 'new-password', minlength: 10 });
  const err = h('div', { class: 'error' });
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Create administrator account');
  const submit = busy(btn, async () => {
    err.textContent = '';
    if (!rate(pass.value, { email: email.value, name: name.value }).ok) { err.textContent = 'Choose a stronger password: see the tips under it.'; return; }
    try {
      await adminUsers({ action: 'bootstrap', email: email.value, password: pass.value, full_name: name.value });
      const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
      if (error) throw error;
      toast('Welcome. Start by adding your team under Admin.', { ms: 6000 });
    } catch (e) { err.textContent = cleanError(e); }
  });
  return h('form', { onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('h1', {}, 'Set up the first account'),
    h('p', { class: 'lead' }, 'This becomes the approver and administrator. You will add finance, the stock manager and requesters afterwards.'),
    field('Your name', name), field('Email', email), field('Password', newPasswordField(pass, { email: email.value, name: name.value })), err, btn);
}

/** Signed in with a weak password: choose a stronger one before carrying on. */
export function weakPasswordPage(render) {
  const me = state.me || {};
  const who = { email: me.email, name: me.full_name, org: state.settings?.org_name };
  const p1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', id: 'new-pass' });
  const p2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', id: 'new-pass-2' });
  const err = h('div', { class: 'error' });
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Save and continue');
  const go = busy(btn, async () => {
    err.textContent = '';
    if (!rate(p1.value, who).ok) { err.textContent = 'Not strong enough yet: see the tips under the password.'; return; }
    if (p1.value !== p2.value) { err.textContent = 'The two passwords do not match.'; return; }
    const { error } = await sb.auth.updateUser({ password: p1.value });
    if (error) { err.textContent = /same|different/i.test(error.message) ? 'Choose a password you have not used before.' : cleanError(error); return; }
    try { sessionStorage.removeItem('pcs_pw_weak'); } catch {}
    toast('Password changed. Thank you.', { ms: 5000 });
    await loadSessionContext(); render();
  });
  const out = h('button', { class: 'btn btn-quiet btn-block', type: 'button' }, 'Sign out');
  out.onclick = busy(out, async () => { try { sessionStorage.removeItem('pcs_pw_weak'); } catch {} await signOutHere(); });
  return h('div', { class: 'auth' }, h('div', { class: 'card' }, brand(),
    h('form', { onsubmit: (e) => { e.preventDefault(); go(); }, id: 'weak-password' },
      h('h1', {}, 'Choose a stronger password'),
      h('p', { class: 'lead' }, 'The password you signed in with is easy to guess, and Petti holds money records. Choose a new one to carry on: it takes a minute.'),
      field('New password', newPasswordField(p1, who, { confirm: p2 })),
      field('Type it again', revealable(p2)), err, btn),
    out));
}
