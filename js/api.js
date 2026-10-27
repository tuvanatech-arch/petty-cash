import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm';
import { SUPABASE_URL, SUPABASE_KEY, FUNCTIONS_URL } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

export const state = {
  session: null,
  me: null,        // profiles row
  settings: null,  // settings row
  people: [],      // profiles (for names)
  roles: [],       // effective roles today: own role plus any stand-in roles
  standingIn: [],  // active delegations to me
  unread: 0,       // unread notifications
};

export const ROLE_LABEL = {
  requester: 'Requester',
  stock_manager: 'Stock manager',
  finance: 'Finance',
  approver: 'Approver (admin)',
};

export function role() { return state.me?.role; }
export function has(r) { return state.roles.includes(r); }
export function isStaff() { return has('stock_manager') || has('finance') || has('approver'); }
export function can(what) {
  switch (what) {
    case 'stock_review': return has('stock_manager') || has('approver');
    case 'manage_stock': return has('stock_manager') || has('approver');
    case 'approve': return has('approver');
    case 'finance': return has('finance') || has('approver');
    case 'admin': return role() === 'approver';          // administration never passes to a stand-in
    case 'reports': return isStaff();
    case 'catalogue': return isStaff();
    default: return false;
  }
}

export function personName(id) {
  if (!id) return '—';
  const p = state.people.find((x) => x.id === id);
  return p ? (p.full_name || p.email) : 'Someone';
}

/** Throws a readable Error on failure. */
export function unwrap({ data, error }) {
  if (error) throw new Error(cleanError(error));
  return data;
}

export function cleanError(error) {
  let m = error?.message || String(error);
  if (/JWT|token|session/i.test(m) && /expired|invalid/i.test(m)) m = 'Your session has expired. Sign in again.';
  if (/Failed to fetch|NetworkError/i.test(m)) m = 'No connection. Check your internet and try again.';
  return m;
}

export async function rpc(fn, args = {}) {
  return unwrap(await sb.rpc(fn, args));
}

export async function loadSessionContext() {
  const { data: { session } } = await sb.auth.getSession();
  state.session = session;
  if (!session) { state.me = null; return null; }
  const { data: me } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  state.me = me;
  if (me && me.active) {
    const today = new Date(); const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const [{ data: settings }, { data: people }, { data: roles }, { data: deleg }, { count }] = await Promise.all([
      sb.from('settings').select('*').eq('id', 1).single(),
      sb.from('profiles').select('id, full_name, email, role, active').order('full_name'),
      sb.rpc('my_roles'),
      sb.from('delegations').select('*').eq('to_user', me.id).lte('starts_on', iso).gte('ends_on', iso),
      sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
    ]);
    state.settings = settings;
    state.people = people || [];
    state.roles = Array.isArray(roles) && roles.length ? roles : [me.role];
    state.standingIn = deleg || [];
    state.unread = count || 0;
  }
  return me;
}

export async function refreshUnread() {
  const { count } = await sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
  state.unread = count || 0;
  document.querySelectorAll('[data-unread]').forEach((el) => { el.textContent = state.unread; el.style.display = state.unread ? '' : 'none'; });
  return state.unread;
}

/** Ask the read-receipt function to read a scanned proof (an expense proof id, or { inbox_id } for a snapped receipt). */
export async function readReceipt(ref) {
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${state.session?.access_token || ''}` };
  const body = typeof ref === 'object' ? ref : { proof_id: ref };
  let res;
  try { res = await fetch(`${FUNCTIONS_URL}/read-receipt`, { method: 'POST', headers, body: JSON.stringify(body) }); }
  catch { throw new Error('No connection. Check your internet and try again.'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `Could not read the receipt (${res.status})`);
  return json;
}

/* ---------- snapped receipts (inbox) ---------- */
export async function uploadToInbox(file) {
  const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80) || 'receipt.jpg';
  const path = `inbox/${state.me.id}/${crypto.randomUUID()}-${safe}`;
  const { error } = await sb.storage.from('proofs').upload(path, file, { contentType: file.type || 'application/octet-stream' });
  if (error) throw new Error(cleanError(error));
  return unwrap(await sb.from('receipt_inbox').insert({ user_id: state.me.id, storage_path: path, file_name: file.name || safe, mime: file.type }).select().single());
}
/** Move the snapped file into the request's folder and attach it as a proof. */
export async function fileInboxReceipt(inbox, requestId) {
  const base = inbox.storage_path.split('/').pop();
  const newPath = `${requestId}/${base}`;
  const { error } = await sb.storage.from('proofs').move(inbox.storage_path, newPath);
  if (error && !/already exists|duplicate/i.test(error.message)) throw new Error(cleanError(error));
  return rpc('file_inbox_receipt', { p_inbox: inbox.id, p_request: requestId, p_new_path: newPath });
}
export async function discardInboxReceipt(inbox) {
  await sb.storage.from('proofs').remove([inbox.storage_path]);
  unwrap(await sb.from('receipt_inbox').update({ status: 'discarded' }).eq('id', inbox.id));
}

/* ---------- month-end packs ---------- */
export async function uploadPack(float, bytes, name) {
  const path = `${String(float.period).slice(0, 7)}/${name}`;
  const { error } = await sb.storage.from('packs').upload(path, new Blob([bytes], { type: 'application/pdf' }), { contentType: 'application/pdf', upsert: true });
  if (error) throw new Error(cleanError(error));
  return path;
}
export async function packUrl(path) {
  const { data, error } = await sb.storage.from('packs').createSignedUrl(path, 60 * 30);
  return error ? null : data.signedUrl;
}
/** Email the pack to the accountant via the send-pack function. */
export async function sendPack(packId, note) {
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${state.session?.access_token || ''}` };
  let res;
  try { res = await fetch(`${FUNCTIONS_URL}/send-pack`, { method: 'POST', headers, body: JSON.stringify({ pack_id: packId, note: note || null }) }); }
  catch { throw new Error('No connection. Check your internet and try again.'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `Could not send the pack (${res.status})`);
  return json;
}

/* ---------- offline queue (quick counts done without signal) ---------- */
const QUEUE_KEY = 'pcs_offline_queue';
export function queueOffline(fn, args) {
  try { const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); q.push({ fn, args, at: new Date().toISOString() }); localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); return q.length; } catch { return 0; }
}
export function offlineQueueLength() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]').length; } catch { return 0; } }
export async function flushOfflineQueue() {
  let q; try { q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return 0; }
  if (!q.length || !navigator.onLine || !state.me) return 0;
  const left = []; let done = 0;
  for (const job of q) {
    try { await rpc(job.fn, job.args); done++; }
    catch (e) { if (/No connection/.test(e.message)) left.push(job); else done++; /* server rejected it: drop, it will not succeed later */ }
  }
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(left)); } catch {}
  return done;
}

export async function refreshPeople() {
  const { data } = await sb.from('profiles').select('id, full_name, email, role, active').order('full_name');
  state.people = data || [];
}

/** Call the admin-users edge function. */
export async function adminUsers(body) {
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
  if (state.session?.access_token) headers.Authorization = `Bearer ${state.session.access_token}`;
  let res;
  try {
    res = await fetch(`${FUNCTIONS_URL}/admin-users`, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error('No connection. Check your internet and try again.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

/* ---------- proofs ---------- */
export async function uploadProof(requestId, expenseId, file) {
  const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80);
  const path = `${requestId}/${crypto.randomUUID()}-${safe}`;
  const { error } = await sb.storage.from('proofs').upload(path, file, { contentType: file.type || 'application/octet-stream' });
  if (error) throw new Error(cleanError(error));
  return unwrap(await sb.from('expense_proofs').insert({
    expense_id: expenseId, storage_path: path, file_name: file.name, mime: file.type, uploaded_by: state.me.id,
  }).select().single());
}

export async function proofUrl(path) {
  const { data, error } = await sb.storage.from('proofs').createSignedUrl(path, 60 * 30);
  if (error) return null;
  return data.signedUrl;
}

export async function removeProof(proof) {
  await sb.storage.from('proofs').remove([proof.storage_path]);
  unwrap(await sb.from('expense_proofs').delete().eq('id', proof.id));
}
