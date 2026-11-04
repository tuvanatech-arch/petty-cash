// Passwords: how strong one is (rated as it is typed, with tips), a suggestion that is strong and easy to remember,
// and the eye button that shows what was typed. The same minimum is checked by the admin-users server function.
import { h } from './ui.js';

const COMMON = ['password', 'passw0rd', 'petti', 'pettycash', 'welcome', 'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'letmein', 'admin', 'administrator',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football', 'soccer', 'baseball', 'master', 'shadow', 'superman', 'batman', 'trustno1',
  'windhoek', 'namibia', 'swakop', 'walvisbay', 'abc123', 'changeme', 'secret', 'computer', 'internet', 'samsung', 'iphone', 'whatever',
  'summer', 'winter', 'spring', 'autumn', 'january', 'february', 'march', 'april', 'august', 'september', 'october', 'november', 'december',
  'monday', 'friday', 'company', 'office', 'finance', 'money', 'cash', 'login', 'hello', 'freedom', 'blessed', 'jesus', 'love', 'family'];
const WORDS = ['acacia', 'baobab', 'camel', 'canyon', 'cedar', 'cheetah', 'cloud', 'comet', 'copper', 'coral', 'dune', 'eagle', 'ember', 'falcon',
  'fern', 'flint', 'forest', 'gecko', 'granite', 'harbour', 'hippo', 'island', 'jackal', 'kudu', 'lagoon', 'lantern', 'lemon', 'lion', 'lizard',
  'mango', 'maple', 'marble', 'meadow', 'meteor', 'mongoose', 'moon', 'nectar', 'ocean', 'olive', 'orbit', 'oryx', 'otter', 'pebble', 'pepper',
  'planet', 'quartz', 'rain', 'raven', 'reef', 'river', 'rocket', 'saffron', 'sandal', 'savanna', 'shell', 'silver', 'sparrow', 'spring', 'star',
  'stone', 'storm', 'sunset', 'thunder', 'tiger', 'timber', 'topaz', 'tulip', 'valley', 'velvet', 'violet', 'walnut', 'willow', 'zebra'];
const SEQ = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

export const MIN_LENGTH = 10;
export const MIN_SCORE = 3;   // "Good"
export const LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];

/** Rate a password 0–4 with tips. `who` (email, name, company) makes passwords built from them weak. */
export function rate(pw, who = {}) {
  const p = String(pw || ''); const low = p.toLowerCase(); const letters = low.replace(/[^a-z]/g, '');
  const tips = [];
  if (!p) return { score: 0, label: LABELS[0], tips: [`Use at least ${MIN_LENGTH} characters.`], ok: false };
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  const pool = (/[a-z]/.test(p) ? 26 : 0) + (/[A-Z]/.test(p) ? 26 : 0) + (/\d/.test(p) ? 10 : 0) + (/[^A-Za-z0-9]/.test(p) ? 33 : 0);
  let bits = p.length * Math.log2(Math.max(pool, 10));
  // what makes a password guessable: common words, the person's or company's name, repeats, keyboard runs, dates
  const personal = [who.email?.split('@')[0], ...(String(who.name || '').toLowerCase().split(/\s+/)), ...(String(who.org || '').toLowerCase().split(/\s+/))]
    .map((x) => String(x || '').toLowerCase().replace(/[^a-z]/g, '')).filter((x) => x.length >= 3);
  const common = COMMON.find((w) => letters.includes(w));
  const mine = personal.find((w) => letters.includes(w));
  if (common) { bits -= common.length * 3.5; tips.push('Avoid common words like “' + common + '”.'); }
  if (mine) { bits -= mine.length * 3.5; tips.push('Avoid your name, email or the company name.'); }
  if (/(.)\1\1/.test(p)) { bits -= 10; tips.push('Avoid repeats like “aaa” or “111”.'); }
  if (SEQ.some((s) => { for (let i = 0; i + 4 <= low.length; i += 1) { const run = low.slice(i, i + 4); if (s.includes(run) || s.split('').reverse().join('').includes(run)) return true; } return false; })) { bits -= 12; tips.push('Avoid runs like “1234” or “abcd”.'); }
  if (/(19|20)\d\d/.test(p)) { bits -= 6; tips.push('Avoid years and dates.'); }
  if (/^[A-Z][a-z]+\d{1,4}[^A-Za-z0-9]?$/.test(p)) { bits -= 10; tips.push('A word with a number on the end is guessed first: mix it up.'); }
  if (p.length < MIN_LENGTH) tips.unshift(`Use at least ${MIN_LENGTH} characters (now ${p.length}).`);
  else if (p.length < 14 && kinds < 4) tips.push(kinds < 3 ? 'Mix capital and small letters, numbers and a symbol.' : 'Longer is stronger: 14 or more characters.');
  let score = bits < 30 ? 0 : bits < 42 ? 1 : bits < 55 ? 2 : bits < 70 ? 3 : 4;
  if (p.length < MIN_LENGTH) score = Math.min(score, 1);
  if ((common || mine) && p.length < 16) score = Math.min(score, 2);
  if (score >= MIN_SCORE && !tips.length && score < 4) tips.push('Good. A few more characters make it strong.');
  return { score, label: LABELS[score], tips: tips.slice(0, 3), ok: score >= MIN_SCORE && p.length >= MIN_LENGTH };
}

/** A strong password that is easy to remember: three random words, a number and a symbol. */
export function suggest() {
  const r = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  const words = [];
  while (words.length < 3) { const w = WORDS[r(WORDS.length)]; if (!words.includes(w)) words.push(w); }
  const sym = '!#%&*+=?@'[r(9)];
  return `${cap(words[0])}-${words[1]}-${cap(words[2])}${sym}${10 + r(90)}`;
}

/** The eye button: shows or hides what was typed. Returns the input wrapped with its button. */
export function revealable(input) {
  const btn = h('button', { type: 'button', class: 'pw-eye', 'aria-label': 'Show password', 'aria-pressed': 'false', title: 'Show password' }, eye(false));
  btn.onclick = () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show)); btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); btn.title = show ? 'Hide password' : 'Show password';
    btn.replaceChildren(eye(show)); input.focus();
  };
  return h('div', { class: 'pw-wrap' }, input, btn);
}
function eye(open) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '20'); svg.setAttribute('height', '20'); svg.setAttribute('aria-hidden', 'true');
  const path = (d) => { const e = document.createElementNS(ns, 'path'); e.setAttribute('d', d); e.setAttribute('fill', 'none'); e.setAttribute('stroke', 'currentColor'); e.setAttribute('stroke-width', '2'); e.setAttribute('stroke-linecap', 'round'); svg.append(e); };
  path('M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z'); path('M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z');
  if (open) path('M3 3l18 18');
  return svg;
}

/** A new-password box: the eye, the strength bar and label, the tips, and "Suggest one". `who` as for rate(). */
export function newPasswordField(input, who = {}, { confirm = null } = {}) {
  const bar = h('div', { class: 'pw-bar', 'aria-hidden': 'true' }, h('span'));
  const label = h('span', { class: 'pw-label', id: `pw-label-${Math.random().toString(36).slice(2, 8)}`, 'aria-live': 'polite' });
  const tips = h('ul', { class: 'pw-tips' });
  const sug = h('button', { type: 'button', class: 'btn btn-sm btn-quiet pw-suggest' }, 'Suggest a strong one');
  sug.onclick = () => {
    const s = suggest(); input.value = s; input.type = 'text';
    const eyeBtn = input.parentElement?.querySelector('.pw-eye'); if (eyeBtn) { eyeBtn.setAttribute('aria-pressed', 'true'); eyeBtn.replaceChildren(eye(true)); }
    if (confirm) confirm.value = s;
    draw(); input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const draw = () => {
    const r = rate(input.value, who);
    const box = bar.parentElement;
    box.dataset.score = input.value ? String(r.score) : '';
    bar.firstChild.style.width = input.value ? `${(r.score + 1) * 20}%` : '0';
    label.textContent = input.value ? `${r.label}${r.ok ? '' : ' – not accepted yet'}` : `At least ${MIN_LENGTH} characters, rated as you type`;
    tips.replaceChildren(...(input.value ? r.tips : ['Tip: three random words, a symbol and a number are strong and easy to remember.']).map((t) => h('li', {}, t)));
  };
  input.addEventListener('input', draw);
  const el = h('div', { class: 'pw-meter' }, revealable(input), h('div', { class: 'pw-rate' }, bar, label), tips, sug);
  queueMicrotask(draw);
  return el;
}
