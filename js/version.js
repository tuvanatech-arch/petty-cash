// A phone usually brings Petti back from the background instead of starting it again, so a new version would
// only show after the app is fully closed. This checks for a newer version whenever Petti comes back to the
// screen (and every 15 minutes while open), then switches over at a safe moment: straight away if nothing is
// being typed or filled in, otherwise at the next change of screen – never in the middle of someone's work.
import { BUILD } from './diag.js';
import { toast } from './ui.js';

let newer = false, lastCheck = 0, dirty = false;

function safeNow() {
  if (dirty) return false;                                                    // a form has been filled in on this screen
  const a = document.activeElement;
  if (a && a.matches?.('input, textarea, select, [contenteditable]')) return false;
  if (document.querySelector('#modal-root .modal, .tour')) return false;      // a window or walk-through is open
  if (document.querySelector('button[disabled][aria-busy="true"], .btn.working')) return false;
  return true;
}
let target = null;
function switchOver() {
  // on a weak signal the reload may still open the kept copy: try once per new version every 10 minutes, never in a loop
  try {
    const t = JSON.parse(sessionStorage.getItem('pcs_update_try') || 'null');
    if (t && t.v === target && Date.now() - t.at < 10 * 60_000) return;
    sessionStorage.setItem('pcs_update_try', JSON.stringify({ v: target, at: Date.now() }));
    sessionStorage.setItem('pcs_just_updated', '1');
  } catch {}
  location.reload();
}
function applyWhenSafe() {
  if (document.visibilityState === 'visible' && safeNow()) return switchOver();
  window.addEventListener('hashchange', switchOver, { once: true });         // the next screen opens in the new version
}

export async function checkVersion({ force = false } = {}) {
  if (BUILD === 'dev' || newer || (!force && Date.now() - lastCheck < 60_000)) return false;
  lastCheck = Date.now();
  try {
    const html = await (await fetch('./index.html', { cache: 'no-store' })).text();
    const v = (html.match(/js\/app\.js\?v=([a-z0-9]+)/) || [])[1];
    if (!v || v === BUILD) return false;
    newer = true; target = v;
    navigator.serviceWorker?.getRegistration?.().then((r) => r?.update()).catch(() => {});
    applyWhenSafe();
    return true;
  } catch { return false; }   // offline: try again next time
}

export function startVersionCheck() {
  // anything typed or chosen on this screen means "not now"; a new screen starts clean
  document.addEventListener('input', () => { dirty = true; }, true);
  window.addEventListener('hashchange', () => { dirty = false; });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });
  window.addEventListener('focus', () => checkVersion());
  setInterval(() => { if (document.visibilityState === 'visible') checkVersion(); }, 15 * 60_000);
  let just = null; try { just = sessionStorage.getItem('pcs_just_updated'); sessionStorage.removeItem('pcs_just_updated'); } catch {}
  // say "updated" only when the new version really arrived (on a weak signal the reload may have opened the kept copy)
  let arrived = !!just;
  try { const t = JSON.parse(sessionStorage.getItem('pcs_update_try') || 'null'); if (t) arrived = arrived && t.v === BUILD; } catch {}
  if (arrived) setTimeout(() => toast('Petti has been updated to the latest version.'), 1200);
}
