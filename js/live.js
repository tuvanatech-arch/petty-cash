// Live screens: when something changes that the open screen shows (a request approved, cash paid out, a delivery
// confirmed), the screen redraws itself quietly a moment later – same scroll position, no loading flash.
// It waits while someone is typing, has a window open or is in a walk-through, and catches up as soon as they stop.
// Only one connection, and only while Petti is on screen, so phones keep their battery.
import { sb, state } from './api.js';

// which screens follow which records (the MD overview keeps its own live view)
const WATCH = [
  { route: /^\/(home)?$/, tables: ['requests', 'expenses', 'floats', 'float_transactions', 'top_ups', 'cash_counts', 'stock_receipts', 'stock_adjustments', 'stock_reports', 'schedule_versions'] },
  { route: /^\/requests$/, tables: ['requests', 'expenses'] },
  { route: /^\/requests\/[0-9a-f-]{36}$/, tables: ['requests', 'expenses', 'request_messages', 'request_documents'] },
  { route: /^\/cash$/, tables: ['floats', 'float_transactions', 'top_ups', 'cash_counts', 'requests', 'expenses'] },
  { route: /^\/stock(\/\w+)?$/, tables: ['items', 'stock_movements', 'stock_reports', 'stock_receipts', 'stock_adjustments'] },
];
const TABLES = [...new Set(WATCH.flatMap((w) => w.tables))];
const path = () => (location.hash.replace(/^#/, '').split('?')[0] || '/home');
// the MD's Home is the overview, which keeps itself live
const watching = () => (state.me?.role === 'managing_director' && /^\/(home)?$/.test(path()) ? null : WATCH.find((w) => w.route.test(path())));

let refresh = null;      // the app's quiet redraw of the current screen
let chan = null, pending = false, timer = null, lastChange = 0;

/** Is now a bad moment to redraw? (typing, a dialog or walk-through open, a button mid-action) */
function busyNow() {
  const a = document.activeElement;
  if (a && a.closest('main') && (a.matches('input, textarea, select, [contenteditable]'))) return true;
  if (document.querySelector('#modal-root .modal, .tour')) return true;
  if (document.querySelector('main button[disabled][aria-busy="true"], main .btn.working')) return true;
  if (document.visibilityState !== 'visible') return true;
  return false;
}

async function run() {
  timer = null;
  if (!pending || !refresh) return;
  if (!watching()) { pending = false; return; }
  if (busyNow()) { timer = setTimeout(run, 2500); return; }       // try again shortly; also retried on blur / dialog close
  pending = false;
  try { await refresh(); } catch { /* keep what is showing */ }
}
function soon(ms = 1200) { clearTimeout(timer); timer = setTimeout(run, ms); }

function onChange(table) {
  lastChange = Date.now();
  const w = watching();
  if (!w || !w.tables.includes(table)) return;
  pending = true; soon();
}

function connect() {
  if (chan || !state.me || !watching()) return;   // only on the screens it serves (the MD overview has its own)
  try {
    chan = sb.channel('screens-' + Math.random().toString(36).slice(2));
    for (const t of TABLES) chan.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => onChange(t));
    chan.subscribe();
  } catch { chan = null; }
}
function disconnect() { if (!chan) return; try { sb.removeChannel(chan); } catch { /* gone already */ } chan = null; }

/** Start following changes. `redraw` re-renders the current screen in place. */
export function startLive(redraw) {
  refresh = redraw;
  connect();
  window.addEventListener('hashchange', () => { if (watching()) connect(); else { disconnect(); pending = false; } });
  // battery: no connection while Petti is in the background; on return, catch up once
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      connect();
      if (hiddenAt && Date.now() - hiddenAt > 15000 && watching()) { pending = true; soon(600); }   // away a while: changes may have been missed
    } else { hiddenAt = Date.now(); disconnect(); clearTimeout(timer); }
  });
  // the moment someone stops typing or closes a window, catch up if something changed meanwhile
  document.addEventListener('focusout', () => { if (pending) soon(800); }, true);
  if (typeof MutationObserver !== 'undefined') new MutationObserver(() => { if (pending && !document.querySelector('#modal-root .modal')) soon(800); })
    .observe(document.getElementById('modal-root') || document.body, { childList: true });
}
/** A screen was drawn from fresh data: nothing is waiting any more. */
export function liveDrawn() { pending = false; }
export const liveConnected = () => !!chan;
