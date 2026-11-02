// Two-step sign-in: after the password, a 6-digit code from an authenticator app on the person's phone.
// The database opens nothing until the code is given (and, for finance, the GM and the MD, nothing after the
// required date until it is set up), so these screens only explain and guide; they are not the lock itself.
import { sb, state, cleanError, signOutHere, loadSessionContext } from './api.js';
import { h, mount, toast, busy, field, fmtDate, confirmDialog } from './ui.js';

const POSITIONS = 'finance, the GM and the MD';
const isPhone = () => window.matchMedia?.('(pointer: coarse)').matches || window.innerWidth < 700;
const codeInput = () => h('input', { class: 'input code-input', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]*', maxlength: 6, placeholder: '123456', 'aria-label': '6-digit code' });
const digits = (v) => String(v || '').replace(/\D/g, '');

async function verifiedFactor() {
  const { data, error } = await sb.auth.mfa.listFactors();
  if (error) throw error;
  return (data?.totp || []).find((f) => f.status === 'verified') || null;
}
function codeError(e) {
  return /invalid|expired|code/i.test(e?.message || '') ? 'That code is not right. The app shows a new one every 30 seconds; type the one showing now.' : cleanError(e);
}

/** Sign-in, second step: the code from the phone. */
export async function codePage(render) {
  const code = codeInput();
  const err = h('div', { class: 'error' });
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Confirm');
  const go = busy(btn, async () => {
    err.textContent = '';
    const c = digits(code.value);
    if (c.length !== 6) { err.textContent = 'Type the 6 digits the app shows.'; return; }
    const f = await verifiedFactor();
    if (!f) { await loadSessionContext(); render(); return; }
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: f.id, code: c });
    if (error) { err.textContent = codeError(error); code.select(); return; }
    await loadSessionContext();
    render();
  });
  code.addEventListener('input', () => { if (digits(code.value).length === 6) go(); });
  const out = h('button', { class: 'btn btn-quiet btn-block', type: 'button' }, 'Sign out');
  out.onclick = busy(out, async () => { await signOutHere(); });
  setTimeout(() => code.focus(), 50);
  return h('div', { class: 'auth' }, h('div', { class: 'card' },
    h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('h1', {}, 'Two-step sign-in'),
      h('p', { class: 'lead' }, 'Open your authenticator app and type the 6-digit code it shows for Petti.'),
      field('Code', code), err, btn),
    h('p', { class: 'hint', style: { marginTop: '14px' } }, 'Lost your phone or deleted the app? Ask your GM to reset two-step sign-in for you, then sign in again.'),
    out));
}

/** Setting it up: install an app, add Petti to it, type the first code. Calls onDone() once it is on. */
export function twoStepSetup(onDone) {
  const box = h('div', { class: 'two-step-setup' });
  const start = h('button', { class: 'btn btn-primary', type: 'button' }, 'Start');
  start.onclick = busy(start, async () => {
    // an earlier set-up that was never finished would block a new one: clear it first
    const { data: list } = await sb.auth.mfa.listFactors();
    for (const f of (list?.all || []).filter((x) => x.status !== 'verified')) await sb.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
    const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Petti ${new Date().toISOString().slice(0, 16).replace('T', ' ')}` });
    if (error) throw new Error(cleanError(error));
    showCode(data);
  });
  function showCode(f) {
    const qr = f.totp?.qr_code || '';
    const src = qr.startsWith('data:') ? qr : `data:image/svg+xml;utf-8,${encodeURIComponent(qr)}`;
    const key = (f.totp?.secret || '').replace(/(.{4})/g, '$1 ').trim();
    const copy = h('button', { class: 'btn btn-sm btn-quiet', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(f.totp.secret); toast('Key copied.'); } catch { toast('Select the key and copy it.'); } } }, 'Copy key');
    const addBtn = h('a', { class: 'btn btn-primary', href: f.totp?.uri || '#', id: 'two-step-add' }, 'Add Petti to my authenticator app');
    const qrBlock = h('div', { class: 'two-step-qr' }, h('img', { src, alt: 'QR code to scan with your authenticator app', width: 180, height: 180 }));
    const code = codeInput();
    const err = h('div', { class: 'error' });
    const ok = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Turn on two-step sign-in');
    const finish = busy(ok, async () => {
      err.textContent = '';
      const c = digits(code.value);
      if (c.length !== 6) { err.textContent = 'Type the 6 digits the app shows.'; return; }
      const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: f.id, code: c });
      if (error) { err.textContent = codeError(error); code.select(); return; }
      toast('Two-step sign-in is on. Each sign-in now asks for a code.', { ms: 6000 });
      await loadSessionContext();
      onDone?.();
    });
    mount(box,
      h('ol', { class: 'steps-list' },
        h('li', {}, h('strong', {}, 'Add Petti to the app. '),
          isPhone() ? [h('span', {}, 'On this phone, tap the button. On a computer, scan the square with the app instead.'), h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, addBtn), qrBlock]
            : [h('span', {}, 'In the app, tap + and scan this square with your phone.'), qrBlock]),
        h('li', {}, h('strong', {}, 'No camera or button? '), 'Type this key into the app instead: ', h('code', { class: 'two-step-key' }, key), ' ', copy),
        h('li', {}, h('strong', {}, 'Type the 6-digit code the app now shows for Petti.'),
          h('form', { onsubmit: (e) => { e.preventDefault(); finish(); } }, field('Code', code), err, h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, ok)))));
    setTimeout(() => { if (!isPhone()) code.focus(); }, 50);
  }
  mount(box,
    h('ol', { class: 'steps-list' },
      h('li', {}, h('strong', {}, 'Install a free authenticator app on your phone: '), 'Google Authenticator or Microsoft Authenticator, from the App Store or Google Play.'),
      h('li', {}, h('strong', {}, 'Tap Start, '), 'then add Petti to the app and type the code it shows. It takes about two minutes.')),
    h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, start));
  return box;
}

/** After the required date: nothing opens until it is set up. */
export async function setupRequiredPage(render) {
  const ts = state.twoStep || {};
  const out = h('button', { class: 'btn btn-quiet btn-block', type: 'button' }, 'Sign out');
  out.onclick = busy(out, async () => { await signOutHere(); });
  return h('div', { class: 'auth' }, h('div', { class: 'card', style: { maxWidth: '560px' } },
    h('h1', {}, 'Set up two-step sign-in to continue'),
    h('p', { class: 'lead' }, `Since ${ts.from ? fmtDate(ts.from) : 'the date your administrator set'}, ${POSITIONS} sign in with their password and a code from their phone, because they release money. Petti opens again as soon as it is set up.`),
    twoStepSetup(async () => { render(); }),
    out));
}

/** Account → Two-step sign-in. */
export function twoStepSheet() {
  const sheet = h('div', { class: 'sheet', id: 'two-step' });
  function draw() {
    const ts = state.twoStep || {};
    const head = h('div', { class: 'sheet-head' }, h('h2', {}, 'Two-step sign-in'), h('span', { class: 'sub' }, ts.enabled ? 'On' : 'Off'));
    if (ts.enabled) {
      const off = ts.required ? null : h('button', { class: 'btn btn-sm btn-quiet btn-danger', type: 'button' }, 'Turn off');
      if (off) off.onclick = busy(off, async () => {
        if (!(await confirmDialog('Turn off two-step sign-in?', 'Your password alone will open Petti again. You can turn it back on at any time.', { ok: 'Turn off', danger: true }))) return;
        const f = await verifiedFactor();
        if (f) { const { error } = await sb.auth.mfa.unenroll({ factorId: f.id }); if (error) throw new Error(cleanError(error)); }
        await loadSessionContext(); toast('Two-step sign-in is off.'); draw();
      });
      mount(sheet, head,
        h('p', { class: 'hint' }, `✓ On${ts.since ? ` since ${fmtDate(ts.since)}` : ''}. Each sign-in asks for the code from your authenticator app.`),
        h('p', { class: 'hint' }, ts.required ? `Required for ${POSITIONS}, so it stays on.` : 'Lost your phone? Ask your GM to reset it.'),
        off ? h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, off) : null);
      return;
    }
    const due = ts.required && ts.from;
    const setUp = h('button', { class: 'btn btn-primary', type: 'button', id: 'two-step-start' }, 'Set up two-step sign-in');
    setUp.onclick = () => mount(sheet, head, twoStepSetup(() => draw()));
    mount(sheet, head,
      h('p', { class: 'hint' }, due ? `Required for ${POSITIONS} from ${fmtDate(ts.from)}: after your password, Petti asks for a code from your phone, so a stolen password alone cannot release money.`
        : 'After your password, Petti asks for a code from your phone, so a stolen password alone is not enough. Recommended for anyone who handles money.'),
      h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, setUp));
    if (/two_step=1/.test(location.hash)) setTimeout(() => { sheet.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 300);
  }
  draw();
  return sheet;
}

/** Home: a reminder before the required date, for those it applies to. */
export function twoStepBanner() {
  const ts = state.twoStep;
  if (!ts || ts.enabled || !ts.required || !ts.from) return null;
  return h('div', { class: 'banner banner-amber', id: 'two-step-banner' },
    h('strong', {}, `Set up two-step sign-in by ${fmtDate(ts.from)}`),
    'From then, Petti asks finance, the GM and the MD for a code from their phone after the password. It takes two minutes. ',
    h('a', { href: '#/account?two_step=1' }, 'Set it up now'));
}
