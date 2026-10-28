import { sb, adminUsers, accountMail, cleanError } from '../api.js';
import { h, field, busy, toast } from '../ui.js';

const brand = () => h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, 'N$'),
  h('div', { class: 'brand-name' }, 'Petty cash & stock'));

export async function authPage() {
  let needsBootstrap = false;
  try { ({ needs_bootstrap: needsBootstrap } = await adminUsers({ action: 'status' })); } catch { /* show login anyway */ }
  let why = null;
  try { why = sessionStorage.getItem('pcs_out'); sessionStorage.removeItem('pcs_out'); } catch {}
  const note = why === 'elsewhere' ? h('div', { class: 'banner banner-amber', style: { marginBottom: '14px' } }, h('strong', {}, 'You were signed out on this device'),
    'It was signed out from another device or by the administrator. Sign in again if that was meant – if it was not you, change your password after signing in.') : null;
  return h('div', { class: 'auth' }, h('div', { class: 'card' }, brand(), note, needsBootstrap ? bootstrapForm() : loginForm()));
}

function loginForm() {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'username', required: true, placeholder: 'you@company.com' });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const err = h('div', { class: 'error' });
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in');
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('h1', {}, 'Sign in'),
    h('p', { class: 'lead' }, 'Requests, approvals and receipts for the petty cash float.'),
    field('Email', email), field('Password', pass), err, btn,
    linkBtn,
    h('div', { class: 'links' },
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); forgot(email.value); } }, 'Forgot password?'),
      h('a', { href: '#/install' }, 'Put it on your phone')),
    h('p', { class: 'hint', style: { marginTop: '10px' } }, 'No account? Ask your administrator.'));
  const submit = busy(btn, async () => {
    err.textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
    if (error) err.textContent = /invalid/i.test(error.message) ? 'Email or password is wrong.' : cleanError(error);
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
  const pass = h('input', { class: 'input', type: 'password', required: true, autocomplete: 'new-password', minlength: 8 });
  const err = h('div', { class: 'error' });
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Create administrator account');
  const submit = busy(btn, async () => {
    err.textContent = '';
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
    field('Your name', name), field('Email', email), field('Password', pass, 'At least 8 characters'), err, btn);
}
