// Diagnostics: errors, slow boots and freezes are written to the server (client_logs) so a phone can be understood from afar.
// Also: pull-to-refresh for the installed app (no browser bar there), and a reload when the app comes back stale.
import { sb, state } from './api.js';

export const BUILD = (document.querySelector('script[type=module]')?.getAttribute('src') || '').split('?v=')[1] || 'dev';
const seen = new Set();
let queue = [];
let flushing = false;

function device() {
  const d = document.documentElement.dataset;
  return { device: d.device, input: d.input, orient: d.orient, w: window.innerWidth, h: window.innerHeight, standalone: !!(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true), online: navigator.onLine, dpr: window.devicePixelRatio };
}

/** Record something worth knowing. Deduplicated per message within a session; sent in the background. */
export function log(level, message, detail) {
  const key = `${level}:${message}`.slice(0, 200);
  if (level === 'error' && seen.has(key)) return;
  seen.add(key);
  queue.push({ user_id: state.me?.id || null, level, message: String(message).slice(0, 500), detail: detail == null ? null : String(detail).slice(0, 4000), url: location.hash.slice(0, 200), build: BUILD, device: device(), user_agent: navigator.userAgent.slice(0, 300) });
  try { localStorage.setItem('pcs_diag_pending', JSON.stringify(queue.slice(-20))); } catch {}
  flush();
}
async function flush() {
  if (flushing || !queue.length || !navigator.onLine) return;
  flushing = true;
  const batch = queue.splice(0, 20);
  try { const { error } = await sb.from('client_logs').insert(batch); if (error) queue.unshift(...batch); else { try { localStorage.removeItem('pcs_diag_pending'); } catch {} } }
  catch { queue.unshift(...batch); }
  finally { flushing = false; }
}

export function startDiagnostics() {
  try { const pending = JSON.parse(localStorage.getItem('pcs_diag_pending') || '[]'); if (pending.length) { queue.push(...pending); flush(); } } catch {}
  window.addEventListener('error', (e) => log('error', e.message || 'Script error', `${e.filename || ''}:${e.lineno || ''}\n${e.error?.stack || ''}`));
  window.addEventListener('unhandledrejection', (e) => log('error', e.reason?.message || String(e.reason || 'Unhandled rejection'), e.reason?.stack || ''));
  window.addEventListener('online', flush);
  const t0 = performance.now();
  // a boot that takes long is worth a note even if it eventually works
  window.__pcsBooted = () => { const ms = Math.round(performance.now() - t0); if (ms > 6000) log('warn', `Slow boot: ${ms} ms`); };
  // the previous run froze or was killed before it finished booting
  try { if (localStorage.getItem('pcs_booting') === '1') log('warn', 'Previous launch did not finish booting'); localStorage.setItem('pcs_booting', '1'); } catch {}
}
export function bootFinished() { try { localStorage.setItem('pcs_booting', '0'); } catch {} window.__pcsBooted?.(); }

/* ---------- pull-to-refresh (installed app) and stale-resume reload ---------- */
export const isStandalone = () => !!(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true);

/** Something half-done on the page that a reload would throw away. */
function unsavedWork() {
  if (document.querySelector('.modal-back')) return true;
  return [...document.querySelectorAll('main input, main textarea')].some((el) => !/^(checkbox|radio|hidden|submit|button|file|search)$/.test(el.type) && el.value && el.value !== el.defaultValue);
}

export function startPullToRefresh(onRefresh) {
  // Browsers in a tab have their own pull-to-refresh; the installed app has none, so it gets this one.
  if (isStandalone() && 'ontouchstart' in window) {
    let startY = null, pulled = 0, armed = false;
    const bar = document.createElement('div'); bar.className = 'ptr'; bar.setAttribute('aria-hidden', 'true'); bar.textContent = 'Pull to refresh'; document.body.append(bar);
    const scroller = () => document.scrollingElement || document.documentElement;
    const reset = () => { startY = null; bar.classList.remove('armed'); bar.style.transform = ''; bar.style.opacity = ''; };
    window.addEventListener('touchstart', (e) => {
      if (scroller().scrollTop <= 0 && e.touches.length === 1 && !document.querySelector('.modal-back') && !e.target.closest?.('.tabbar, textarea, select, .table-wrap')) { startY = e.touches[0].clientY; pulled = 0; armed = false; } else startY = null;
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (startY == null) return;
      pulled = e.touches[0].clientY - startY;
      if (pulled < 10) { if (pulled < -10) startY = null; return; }
      const show = Math.min(pulled, 110);
      bar.style.transform = `translateY(${show - 52}px)`; bar.style.opacity = String(Math.min(1, pulled / 60));
      armed = pulled > 85; bar.textContent = armed ? 'Release to refresh' : 'Pull to refresh'; bar.classList.toggle('armed', armed);
    }, { passive: true });
    const end = () => { if (startY == null) return; if (armed) { bar.textContent = 'Refreshing…'; startY = null; onRefresh(); } else reset(); };
    window.addEventListener('touchend', end, { passive: true }); window.addEventListener('touchcancel', end, { passive: true });
  }

  // back from the background after a long while: a fresh start beats a stale page with dead connections,
  // unless something half-written is on screen
  let hiddenAt = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = null;
    if (away > 10 * 60 * 1000 && !unsavedWork()) { log('info', `Resumed after ${Math.round(away / 60000)} min – reloading`); onRefresh(); }
  });
}
