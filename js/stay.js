// "Keep me signed in on this device" (Nov 2026). Ticked (the phone app's default): signed in for 30 days, then the
// password once. Not ticked (a browser's default, the computer may be shared): signed out when the browser is closed
// or after 30 minutes without use. Signing out wipes this device's offline copy too (signOutHere → wipeOffline).
import { signOutHere } from './api.js';
import { isStandaloneApp } from './device-label.js';

const KEEP = 'pcs_stay', UNTIL = 'pcs_stay_until', ALIVE = 'pcs_alive', LAST = 'pcs_last_active';
const DAYS = 30, IDLE_MIN = 30;
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} } };

/** The tick's starting value on the sign-in screen. */
export const keepDefault = () => (ls.get(KEEP) != null ? ls.get(KEEP) === '1' : isStandaloneApp());

/** Called on signing in. */
export function rememberChoice(keep) {
  ls.set(KEEP, keep ? '1' : '0');
  ls.set(UNTIL, String(Date.now() + DAYS * 864e5));
  ss.set(ALIVE, '1'); ss.set(LAST, String(Date.now()));
}

const out = async (why) => { ss.set('pcs_out', why); await signOutHere(); return true; };

/** On opening Petti while signed in: true when this device had to be signed out. */
export async function stayCheck() {
  const keep = ls.get(KEEP);
  if (keep == null) { rememberChoice(true); return false; }                     // signed in before this existed: kept, 30 days from now
  if (keep === '1') {
    if (Number(ls.get(UNTIL) || 0) < Date.now()) return out('expired');
  } else {
    if (!ss.get(ALIVE)) return out('closed');                                    // the browser was closed since
    if (Date.now() - Number(ss.get(LAST) || 0) > IDLE_MIN * 6e4) return out('idle');
  }
  ss.set(ALIVE, '1'); ss.set(LAST, String(Date.now()));
  watchIdle();
  return false;
}

let watching = false;
function watchIdle() {
  if (watching || ls.get(KEEP) !== '0') return; watching = true;
  const seen = () => ss.set(LAST, String(Date.now()));
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((e) => window.addEventListener(e, seen, { passive: true }));
  setInterval(() => { if (ls.get(KEEP) === '0' && Date.now() - Number(ss.get(LAST) || 0) > IDLE_MIN * 6e4) out('idle'); }, 60 * 1000);
}

/** The line shown on the sign-in screen after Petti signed someone out. */
export function stayNote(why) {
  return { idle: 'Signed out after 30 minutes without use, because “Keep me signed in” was not ticked on this device.',
    closed: 'Signed out because the browser was closed and “Keep me signed in” was not ticked on this device.',
    expired: 'It has been 30 days: sign in again to keep your account safe.' }[why] || null;
}
