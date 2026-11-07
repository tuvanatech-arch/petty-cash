// Offline mode (Nov 2026). Without signal Petti shows what this phone saw the last time it was online, with an
// "Offline – as of …" banner, and keeps the safe things people do (a new request or claim with its receipt, a snapped
// receipt, a stock report or suggestion) in an outbox that is sent as soon as the signal is back. Money decisions
// (approving, paying, confirming cash, signing off counts) need a connection: someone may have acted meanwhile.
//
// The database client is wrapped: every read that succeeds online is copied to this phone (Cache Storage, per read);
// offline (or when the network fails) the copy answers instead. Writes offline answer "Needs a connection".
// Everything kept here is wiped when the person signs out.

const DATA = 'petti-offline-data';
const FILES = 'petti-outbox-files';
const OUTBOX = 'pcs_outbox';
export const NEEDS_CONNECTION = 'Needs a connection. This is done when the signal is back – try again then.';
const NOT_SAVED = 'Not saved on this phone yet: open this page once with signal, then it works offline too.';

// server functions that only read (safe to answer from the copy); every other one changes something
const READ_RPC = new Set(['suggest_cash', 'cash_with', 'cash_with_people', 'supplier_bank_check', 'supplier_book', 'budget_status', 'plan_status', 'claims_summary', 'cash_ledger', 'bank_ledger', 'stock_actions', 'schedule_budget',
  'next_working_morning', 'management_summary', 'item_usage_stats', 'expense_checks', 'exceptions_open', 'exceptions_log', 'branch_outlooks',
  'setup_status', 'sign_in_log', 'pack_register', 'no_proof_list', 'my_updates', 'my_two_step', 'my_roles', 'my_branch_list', 'journal',
  'item_open_orders', 'float_outlook', 'outlook_for', 'devices', 'device_counts', 'cash_actions', 'access_review_status', 'access_list', 'proof_used',
  'approval_level_for', 'update_feedback', 'receipt_line_matches', 'receipt_shares_info', 'proof_amount']);
const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete']);

/* ---------- offline or not, and since when ---------- */
export const offline = { on: false, asOf: null };
const listeners = new Set();
export function onOfflineChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const tell = () => listeners.forEach((fn) => { try { fn(offline); } catch {} });
export function markOffline(at) {
  const was = offline.on; offline.on = true;
  if (at && (!offline.asOf || at < offline.asOf)) offline.asOf = at;   // the oldest copy on screen
  if (!was || at) tell();
}
export function markOnline() { if (!offline.on) return; offline.on = false; offline.asOf = null; tell(); }
const noSignal = () => typeof navigator !== 'undefined' && navigator.onLine === false;
export const isNetworkError = (e) => /Failed to fetch|NetworkError|Load failed|network|AbortError|aborted|timed out|No connection/i.test(String(e?.message || e || ''));

/* ---------- the copies ---------- */
const hash = (s) => { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36); };
// times change on every call ("the last 30 days"): a second, looser key ignores them
const loose = (k) => k.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d\d:?\d\d)?/g, 'T');
const url = (k) => `https://offline.petti/${hash(k)}`;
const hasCaches = () => typeof caches !== 'undefined';
async function writeCopy(key, r) {
  if (!hasCaches()) return;
  try {
    const c = await caches.open(DATA); const body = JSON.stringify({ data: r.data ?? null, count: r.count ?? null, at: Date.now() });
    await c.put(url(key), new Response(body)); if (loose(key) !== key) await c.put(url(`~${loose(key)}`), new Response(body));
  } catch {}
}
async function readCopy(key) {
  if (!hasCaches()) return null;
  try { const c = await caches.open(DATA); const r = (await c.match(url(key))) || (await c.match(url(`~${loose(key)}`))); return r ? await r.json() : null; } catch { return null; }
}

/* ---------- the wrapped database client ---------- */
const args = (a) => { try { return JSON.stringify(a); } catch { return '?'; } };
async function run(target, key, write) {
  const fromCopy = async () => {
    if (write) return { data: null, error: { message: NEEDS_CONNECTION, code: 'offline' }, count: null, status: 0, statusText: 'offline' };
    const c = await readCopy(key);
    if (!c) { markOffline(null); return { data: null, error: { message: NOT_SAVED, code: 'offline' }, count: null, status: 0, statusText: 'offline' }; }
    markOffline(c.at);
    return { data: c.data, error: null, count: c.count, status: 200, statusText: 'offline copy', offline: true };
  };
  if (noSignal()) return fromCopy();
  let r;
  try { r = await target; } catch (e) { if (isNetworkError(e)) return fromCopy(); throw e; }
  if (r?.error && isNetworkError(r.error)) return fromCopy();
  if (r && !r.error) { markOnline(); if (!write) writeCopy(key, r); }
  return r;
}
function wrapBuilder(b, key, write) {
  return new Proxy(b, {
    get(t, p) {
      if (p === 'then') return (ok, bad) => run(t, key, write).then(ok, bad);
      const v = t[p];
      if (typeof v !== 'function') return v;
      return (...a) => {
        const r = v.apply(t, a);
        return r && typeof r === 'object' && typeof r.then === 'function' ? wrapBuilder(r, `${key}|${String(p)}${args(a)}`, write || WRITE_METHODS.has(p)) : r;
      };
    },
  });
}
/** The database client, with reads copied to this phone and answered from the copy offline. */
export function offlineClient(sb) {
  const from = sb.from.bind(sb); const rpcFn = sb.rpc.bind(sb);
  sb.from = (table) => wrapBuilder(from(table), `from:${table}`, false);
  sb.rpc = (fn, a, o) => wrapBuilder(rpcFn(fn, a, o), `rpc:${fn}${args(a)}`, !READ_RPC.has(fn));
  return sb;
}

/* ---------- the outbox: things done offline, sent when the signal is back ---------- */
const readBox = () => { try { return JSON.parse(localStorage.getItem(OUTBOX) || '[]'); } catch { return []; } };
const writeBox = (b) => { try { localStorage.setItem(OUTBOX, JSON.stringify(b)); } catch {} };
export const outboxCount = () => readBox().length;
export const outboxItems = () => readBox();
/** Keep something to send later: kind ('request' | 'claim' | 'inbox' | 'rpc'), its data, and any files (photos). */
export async function outboxAdd(kind, data, files = []) {
  const id = (crypto.randomUUID?.() || String(Date.now() + Math.random()));
  const names = [];
  if (files.length && hasCaches()) {
    const c = await caches.open(FILES);
    for (const [i, f] of files.entries()) { const n = `https://outbox.petti/${id}/${i}`; await c.put(n, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Name': encodeURIComponent(f.name || `photo-${i + 1}.jpg`) } })); names.push(n); }
  }
  const box = readBox(); box.push({ id, kind, data, files: names, at: Date.now() }); writeBox(box); tell();
  return box.length;
}
async function filesOf(job) {
  if (!job.files?.length || !hasCaches()) return [];
  const c = await caches.open(FILES); const out = [];
  for (const n of job.files) { const r = await c.match(n); if (r) { const b = await r.blob(); out.push(new File([b], decodeURIComponent(r.headers.get('X-Name') || 'photo.jpg'), { type: b.type || r.headers.get('Content-Type') || '' })); } }
  return out;
}
async function dropFiles(job) { if (!job.files?.length || !hasCaches()) return; try { const c = await caches.open(FILES); for (const n of job.files) await c.delete(n); } catch {} }

let flushing = false;
/** Send what was kept offline. handlers[kind](data, files) does the work; a job that fails for lack of signal stays. */
export async function flushOutbox(handlers) {
  if (flushing || noSignal()) return [];
  flushing = true; const done = [];
  try {
    for (const job of readBox()) {
      const fn = handlers[job.kind]; if (!fn) continue;
      try { const res = await fn(job.data, await filesOf(job)); done.push({ ...job, result: res }); }
      catch (e) { if (isNetworkError(e) || e?.message === NEEDS_CONNECTION) break; done.push({ ...job, failed: e?.message || String(e) }); }
      writeBox(readBox().filter((j) => j.id !== job.id)); await dropFiles(job);
    }
  } finally { flushing = false; if (done.length) tell(); }
  return done;
}

/** Signing out: nothing of the company's stays on this phone. */
export async function wipeOffline() {
  try { localStorage.removeItem(OUTBOX); } catch {}
  if (hasCaches()) { try { await caches.delete(DATA); await caches.delete(FILES); } catch {} }
  offline.on = false; offline.asOf = null; tell();
}
