// Nothing typed is lost: a form someone is filling in is copied to the phone as they type, and again the moment
// Petti goes to the background (a call, another app, the screen locking). If the app is closed or crashes, the
// form comes back as it was, and Home offers "Continue where you left off". The copy is per person and per
// device, and is removed once the form is saved or sent – or after 14 days.
import { state } from './api.js';

const PREFIX = 'pcs_keep_';
const MAX_AGE = 14 * 864e5;
const key = (name) => `${PREFIX}${state.me?.id || 'anon'}_${name}`;

export function keepRead(name) {
  try { const v = JSON.parse(localStorage.getItem(key(name)) || 'null'); if (v && Date.now() - v.at < MAX_AGE) return v; if (v) localStorage.removeItem(key(name)); } catch {}
  return null;
}
export function keepWrite(name, data) { try { localStorage.setItem(key(name), JSON.stringify({ ...data, at: Date.now() })); } catch {} }
export function keepDrop(name) { try { localStorage.removeItem(key(name)); } catch {} }
/** Everything this person left unfinished on this device, newest first: [{ name, label, link, at, … }]. */
export function keepAll() {
  const mine = `${PREFIX}${state.me?.id || 'anon'}_`; const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); if (!k || !k.startsWith(mine)) continue;
      const v = keepRead(k.slice(mine.length)); if (v?.link) out.push({ name: k.slice(mine.length), ...v });
    }
  } catch {}
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Watch a form. `snapshot()` returns what to keep ({ label, link, …state }); when it equals the form as it was
 * opened (`initial`, taken before anything was restored), nothing is kept. `onHide` runs when Petti goes to the background (e.g. save a draft on the server).
 */
export function keepForm(root, name, snapshot, { onHide = null, initial: before } = {}) {
  const strip = (d) => { if (!d) return null; const { label, link, at, ...rest } = d; return JSON.stringify(rest); };
  const initial = strip(before !== undefined ? before : snapshot()); let timer = null; let live = true; let shown = false;
  const nameNow = () => (typeof name === 'function' ? name() : name);
  let last = nameNow();
  const save = () => {
    clearTimeout(timer); if (!live) return;
    if (root.isConnected) shown = true;
    else if (shown) { stop(); return; }   // the form has gone (another screen): its last state was already kept
    const n = nameNow();
    if (n !== last) { keepDrop(last); last = n; }   // a new form became a saved draft: the copy moves with it
    const d = snapshot();
    if (!d || strip(d) === initial) keepDrop(n);
    else keepWrite(n, d);
  };
  const soon = () => { clearTimeout(timer); timer = setTimeout(save, 300); };
  const onClick = (e) => { if (e.target.closest?.('button')) soon(); };   // adding or removing a line, switching the kind
  const onVis = () => { if (document.visibilityState !== 'hidden') return; save(); if (live && root.isConnected) onHide?.(); };
  const onLeave = () => save();
  root.addEventListener('input', soon, true); root.addEventListener('change', soon, true); root.addEventListener('click', onClick, true);
  document.addEventListener('visibilitychange', onVis); window.addEventListener('pagehide', onLeave);
  window.addEventListener('hashchange', onLeave);   // tapping away inside Petti keeps it too
  function stop() { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', onLeave); window.removeEventListener('hashchange', onLeave); }
  return {
    save,
    /** The form was saved or sent properly: forget the copy. */
    done() { clearTimeout(timer); keepDrop(nameNow()); keepDrop(last); stop(); },
  };
}

/** "Brought back what you were filling in" – shown at the top of a restored form. */
export function whenText(at) {
  const d = new Date(at); const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
