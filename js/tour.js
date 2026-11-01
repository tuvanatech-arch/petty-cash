// A guided walk-through on the person's own screen: each step opens the right screen, spotlights the actual
// button or section, and says what to do there. Steps: { at: '#/stock/deliveries', css: 'main .tabs button', text: 'Deliveries', say: 'Tap Deliveries.' }
// (css and text are both optional: text picks the first visible button, tab, link or heading containing it).
import { h, mount, clear } from './ui.js';

const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
/** The element a step points at, or null if it is not on screen (yet). Exported so screenshots use the same rule. */
export function locate(step) {
  const scope = document.querySelector('main') || document.body;
  const pool = step.css ? [...document.querySelectorAll(step.css)] : [...scope.querySelectorAll('button, a[href], [role=tab], h1, h2, h3, .sheet, .banner')];
  const want = (step.text || '').trim().toLowerCase();
  return pool.find((el) => visible(el) && (!want || (el.textContent || '').trim().toLowerCase().includes(want))) || null;
}
function waitFor(step, ms = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => { const el = locate(step); if (el) return resolve(el); if (Date.now() - t0 > ms) return resolve(null); setTimeout(tick, 120); };
    tick();
  });
}

let active = null;   // { steps, i, root }
/** Start a walk-through. Returns when it ends (finished or stopped). */
export async function runTour(steps, { title = 'Show me' } = {}) {
  if (!Array.isArray(steps) || !steps.length) return;
  stopTour();
  clear(document.getElementById('modal-root'));   // a note's window gives way to the tour
  const root = h('div', { class: 'tour', role: 'dialog', 'aria-label': title });
  document.body.append(root);
  active = { steps, i: 0, root, done: null };
  const finished = new Promise((r) => { active.done = r; });
  const onKey = (e) => { if (e.key === 'Escape') stopTour(); };
  document.addEventListener('keydown', onKey);
  const onResize = () => { if (active?.el) place(active.el, active.steps[active.i]); };
  const onRedraw = new MutationObserver(() => { if (active?.el && !active.el.isConnected) place(active.el, active.steps[active.i]); });
  onRedraw.observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
  window.addEventListener('resize', onResize); window.addEventListener('scroll', onResize, true);
  showStep();
  await finished;
  document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); window.removeEventListener('scroll', onResize, true); onRedraw.disconnect();
}
export function stopTour() { if (!active) return; const a = active; active = null; a.root.remove(); a.done?.(); }
export const tourRunning = () => !!active;

async function showStep() {
  const a = active; if (!a) return;
  const step = a.steps[a.i];
  mount(a.root, h('div', { class: 'tour-wait' }, h('div', { class: 'tour-bubble' }, 'One moment…')));
  if (step.at && location.hash !== step.at) location.hash = step.at;
  const el = await waitFor(step);
  if (active !== a) return;
  if (!el) {   // the screen changed, or this role cannot see it: say so instead of pointing at nothing
    bubble(null, step, 'That part is not on this screen right now. The step says: ' + step.say);
    return;
  }
  el.scrollIntoView({ block: el.getBoundingClientRect().height > window.innerHeight * 0.6 ? 'start' : 'center', behavior: 'smooth' });
  await new Promise((r) => setTimeout(r, 350));
  if (active !== a) return;
  // the screen may have redrawn meanwhile (pages load in two passes): point at the element as it is now
  a.el = locate(step) || el;
  bubble(a.el, step, step.say);
}

function place(el, step) {
  const a = active; if (!a || !a.spot) return;
  if (!el.isConnected) { el = locate(step) || el; a.el = el; }
  const r = el.getBoundingClientRect(); const pad = 6;
  Object.assign(a.spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
  const b = a.bubble; const bw = Math.min(340, window.innerWidth - 24); b.style.width = `${bw}px`;
  const below = r.bottom + 12 + b.offsetHeight < window.innerHeight - 70;
  b.style.top = below ? `${r.bottom + 12}px` : `${Math.max(12, r.top - 12 - b.offsetHeight)}px`;
  b.style.left = `${Math.min(Math.max(12, r.left), window.innerWidth - bw - 12)}px`;
  b.classList.toggle('above', !below);
  void step;
}

function bubble(el, step, text) {
  const a = active; if (!a) return;
  const last = a.i === a.steps.length - 1;
  const next = h('button', { class: 'btn btn-primary btn-sm', onclick: () => { if (last) stopTour(); else { a.i += 1; a.el = null; showStep(); } } }, last ? 'Done' : 'Next');
  const stop = h('button', { class: 'btn btn-quiet btn-sm', onclick: stopTour }, 'Stop');
  a.bubble = h('div', { class: 'tour-bubble', role: 'status' },
    h('div', { class: 'tour-step' }, `Step ${a.i + 1} of ${a.steps.length}`),
    h('p', {}, text),
    h('div', { class: 'tour-actions' }, stop, next));
  // the spotlight darkens everything except the element, which stays tappable so the person can do the step there and then
  a.spot = el ? h('div', { class: 'tour-spot' }) : null;
  mount(a.root, a.spot || h('div', { class: 'tour-shade' }), a.bubble);
  if (el) place(el, step); else Object.assign(a.bubble.style, { left: '12px', right: '12px', top: '80px', width: 'auto' });
  next.focus();
}
