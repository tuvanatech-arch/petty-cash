import { sb, adminUsers, cleanError } from '../api.js';
import { h, field, busy, toast } from '../ui.js';

const brand = () => h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, 'N$'),
  h('div', { class: 'brand-name' }, 'Petty cash & stock'));

export async function authPage() {
  let needsBootstrap = false;
  try { ({ needs_bootstrap: needsBootstrap } = await adminUsers({ action: 'status' })); } catch { /* show login anyway */ }
  return h('div', { class: 'auth' }, h('div', { class: 'card' }, brand(), needsBootstrap ? bootstrapForm() : loginForm()));
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
    h('div', { class: 'links' },
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); forgot(email.value); } }, 'Forgot password?'),
      h('span', { class: 'hint' }, 'No account? Ask your administrator.')));
  const submit = busy(btn, async () => {
    err.textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
    if (error) err.textContent = /invalid/i.test(error.message) ? 'Email or password is wrong.' : cleanError(error);
  });
  return form;
}

async function forgot(email) {
  if (!email) { toast('Enter your email first, then tap “Forgot password”.', { error: true }); return; }
  const { error } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: location.origin + location.pathname });
  if (error) toast(cleanError(error), { error: true });
  else toast('If that email has an account, a reset link is on its way. Your administrator can also set a new password for you.', { ms: 7000 });
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
