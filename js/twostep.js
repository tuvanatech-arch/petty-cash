// Two-step sign-in by email (051): after the password, Petti emails a 6-digit code for this sign-in. Required for the
// positions that release money (finance, the GM and the MD) from the date the GM sets under Admin → Settings; until
// then it is off. The database opens nothing until the code is given, so this screen only explains and guides.
import { state, cleanError, signOutHere, loadSessionContext, accountMail, rpc } from './api.js';
import { h, toast, busy, field, fmtDate } from './ui.js';

const POSITIONS = 'finance, the GM and the MD';
const digits = (v) => String(v || '').replace(/\D/g, '');
const SENT_KEY = 'pcs_code_sent';

async function sendCode(status, { quiet = false } = {}) {
  status.textContent = 'Sending the code…';
  try {
    const r = await accountMail({ action: 'login_code' });
    try { sessionStorage.setItem(SENT_KEY, String(Date.now())); } catch {}
    if (r.sent) { status.textContent = `We emailed a 6-digit code to ${r.to}. It works for 10 minutes.`; return true; }
    status.textContent = r.reason === 'too_many' ? 'Too many codes asked for. Wait 15 minutes, then tap “Send a new code”.'
      : r.reason === 'no_provider' || r.reason === 'no_sender' ? 'Petti cannot send email yet, so the code cannot reach you. Ask your GM to switch two-step sign-in off under Admin → Settings until email works.'
        : 'The email could not be sent. Tap “Send a new code” in a minute.';
    return false;
  } catch (e) { status.textContent = cleanError(e); if (!quiet) toast(cleanError(e), { error: true }); return false; }
}

/** Sign-in, second step: the code from the email. */
export async function codePage(render) {
  const ts = state.twoStep || {};
  const code = h('input', { class: 'input code-input', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9 ]*', maxlength: 7, placeholder: '123 456', 'aria-label': '6-digit code' });
  const err = h('div', { class: 'error' });
  const status = h('p', { class: 'lead', id: 'code-status', 'aria-live': 'polite' }, ts.email ? `We are emailing a 6-digit code to ${ts.email}.` : 'We are emailing you a 6-digit code.');
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Confirm');
  const go = busy(btn, async () => {
    err.textContent = '';
    const c = digits(code.value);
    if (c.length !== 6) { err.textContent = 'Type the 6 digits from the email.'; return; }
    try {
      const ok = await rpc('verify_login_code', { p_code: c });
      if (!ok) { err.textContent = 'That code is not right. Check the newest email from Petti.'; code.select(); return; }
    } catch (e) { err.textContent = cleanError(e); return; }
    try { sessionStorage.removeItem(SENT_KEY); } catch {}
    await loadSessionContext();
    render();
  });
  code.addEventListener('input', () => { if (digits(code.value).length === 6) go(); });
  const again = h('button', { class: 'btn btn-block', type: 'button', id: 'code-again' }, 'Send a new code');
  again.onclick = busy(again, async () => { if (await sendCode(status)) { code.value = ''; code.focus(); } });
  const out = h('button', { class: 'btn btn-quiet btn-block', type: 'button' }, 'Sign out');
  out.onclick = busy(out, async () => { await signOutHere(); });
  // one code per visit: a reload within 10 minutes does not send another
  let last = 0; try { last = Number(sessionStorage.getItem(SENT_KEY) || 0); } catch {}
  if (Date.now() - last > 10 * 60 * 1000) sendCode(status, { quiet: true });
  else status.textContent = `We emailed a 6-digit code${ts.email ? ` to ${ts.email}` : ''}. It works for 10 minutes.`;
  setTimeout(() => code.focus(), 50);
  return h('div', { class: 'auth' }, h('div', { class: 'card' },
    h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('h1', {}, 'Check your email'),
      status,
      field('Code', code), err, btn),
    h('p', { class: 'hint', style: { marginTop: '14px' } }, `Two-step sign-in: ${POSITIONS} release money, so after the password Petti asks for a code sent to their email. Nothing there? Check spam, then send a new code.`),
    again, out));
}

/** Account → Two-step sign-in: what happens, when it is on. Nothing to set up. */
export function twoStepSheet() {
  const ts = state.twoStep || {};
  if (!ts.required) return null;
  const on = ts.from && ts.from <= new Date().toISOString().slice(0, 10);
  return h('div', { class: 'sheet', id: 'two-step' },
    h('div', { class: 'sheet-head' }, h('h2', {}, 'Two-step sign-in'), h('span', { class: 'sub' }, on ? 'On' : ts.from ? `From ${fmtDate(ts.from)}` : 'Off')),
    h('p', { class: 'hint' }, on || ts.from
      ? `After your password, Petti emails a 6-digit code to ${ts.email || 'your email'} and asks for it, so a stolen password alone cannot release money. Nothing to set up.`
      : state.me?.role === 'approver' ? 'When you switch it on under Admin → Settings, Petti will email a 6-digit code after the password to you, finance and the MD. Switch it on once email sending is set up.'
        : 'When your GM switches it on, Petti will email you a 6-digit code after your password. Nothing to set up.'));
}

/** Home: nothing to set up any more (the code comes by email). */
export function twoStepBanner() { return null; }
