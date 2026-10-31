import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm';
import { SUPABASE_URL, SUPABASE_KEY, FUNCTIONS_URL } from './config.js';
import { thisDeviceLabel, isStandaloneApp } from './device-label.js';

// A request that never answers (a phone waking up with a dead socket) must fail, not hang the page:
// 20 s for ordinary calls, longer for uploads, which can legitimately be slow.
function fetchWithTimeout(input, init = {}) {
  if (init.signal || typeof AbortController === 'undefined') return fetch(input, init).then((res) => noticeSignedOut(res, input));
  const body = init.body;
  const upload = body && (typeof Blob !== 'undefined' && body instanceof Blob || typeof FormData !== 'undefined' && body instanceof FormData || body instanceof ArrayBuffer);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), upload ? 180000 : 20000);
  return fetch(input, { ...init, signal: ctrl.signal }).then((res) => noticeSignedOut(res, input)).finally(() => clearTimeout(t));
}

// This device was signed out from another one: the server refuses with "session_revoked" and the app signs out here too.
let signedOutElsewhere = null;
export function whenSignedOutElsewhere(fn) { signedOutElsewhere = fn; }
function noticeSignedOut(res, input) {
  if (res.status === 401 && signedOutElsewhere) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (/\/rest\/v1\//.test(url)) res.clone().text().then((t) => { if (/session_revoked/.test(t)) signedOutElsewhere(); }).catch(() => {});
  }
  return res;
}

// No cross-tab lock around auth: on iPhone home-screen apps the system lock can be left held after a suspend and
// getSession() then waits forever. This app is one person on one device at a time, so the lock buys nothing.
export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { lock: async (_name, _timeout, fn) => fn(), persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }, global: { fetch: fetchWithTimeout } });

export const state = {
  session: null,
  me: null,        // profiles row
  settings: null,  // settings row
  people: [],      // profiles (for names)
  roles: [],       // effective roles today: own role plus any stand-in roles
  standingIn: [],  // active delegations to me
  unread: 0,       // unread notifications
  branches: [],    // the branches I may work in (my_branch_list), with their company and currency
  view: null,      // the branch I am looking at (profiles.view_branch); null = all of mine
};

export const ROLE_LABEL = {
  requester: 'Requester',
  stock_manager: 'Stock manager',
  finance: 'Finance',
  approver: 'General Manager (admin)',
  managing_director: 'Managing Director',
};
/** Who approves at each level, in plain words. */
export const LEVEL_LABEL = { gm: 'General Manager', md: 'Managing Director' };

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
    case 'schedule': return isStaff();   // everyone with a position can read the authority schedule; only the administrator changes it
    case 'catalogue': return role() === 'stock_manager' || role() === 'approver';   // the catalogue (items, suppliers, categories) stays with the real stock manager, not a stand-in
    default: return false;
  }
}

/** Can I approve this request? Never my own; the MD level only for the Managing Director (or their stand-in). */
export function canApproveReq(q) {
  if (!q || q.status !== 'pending_approval' || q.requester_id === state.me?.id) return false;
  return q.approval_level === 'md' ? has('managing_director') : has('approver');
}
/** Can I review this request after the fact (an MD's own request, or spending over what was paid out)? */
export function canReviewReq(q) {
  if (!q?.review_reason || q.reviewed_at || q.requester_id === state.me?.id || q.disbursed_to === state.me?.id) return false;
  return q.review_role === 'managing_director' ? has('managing_director') : has('approver');
}
/** Is the Managing Director position filled? (Until it is, the GM approves the larger amounts too.) */
/* ---------- branches ---------- */
/** More than one branch to look at: the switcher shows, and lists can be narrowed to one. */
export function multiBranch() { return state.branches.length > 1; }
/** The branch I am acting in: my chosen view, else my home branch. */
export function myBranch() { return state.view || state.branches.find((b) => b.home)?.id || state.branches[0]?.id || null; }
export function branchName(id) { return state.branches.find((b) => b.id === id)?.name || ''; }
/** The company (and so the currency) of the branch being looked at. */
export function company() { const b = state.branches.find((x) => x.id === myBranch()) || state.branches[0]; return b ? { id: b.company_id, name: b.company, currency: b.currency, currency_code: b.currency_code } : null; }
/** Narrow a list query to the branch being looked at (no-op when looking at all branches). */
export function scoped(q) { return state.view ? q.eq('branch_id', state.view) : q; }
/** Choose the branch to look at (null = all of mine); remembered on the profile, so every device follows. */
export async function setView(id) {
  const v = id || null;
  await rpc('set_view_branch', { p_branch: v });
  state.view = v; if (state.me) state.me.view_branch = v;
}
/** Keep only rows whose float belongs to the branch being looked at. */
export function inView(rows, floats, key = 'float_id') { if (!state.view) return rows; const ids = new Set(floats.filter((f) => f.branch_id === state.view).map((f) => f.id)); return rows.filter((r) => ids.has(r[key])); }

export function mdInPlace() { return state.people.some((p) => p.active && p.role === 'managing_director'); }

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
  if (/session_revoked/.test(m)) m = 'This device was signed out from another device. Sign in again.';
  if (/Could not find the function/i.test(m)) m = 'This part of the app is still being switched on. Try again in a few minutes.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) m = 'No connection. Check your internet and try again.';
  if (/abort|timed out/i.test(m) || error?.name === 'AbortError') m = 'The server did not answer in time. Pull down to refresh and try again.';
  return m;
}

export async function rpc(fn, args = {}) {
  return unwrap(await sb.rpc(fn, args));
}

export async function loadSessionContext() {
  const { data: { session } } = await sb.auth.getSession();
  state.session = session;
  if (!session) { state.me = null; syncAppBadge(0); return null; }
  const { data: me } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  state.me = me;
  if (me && me.active) {
    const today = new Date(); const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const [{ data: settings }, { data: people }, { data: roles }, { data: deleg }, { count }] = await Promise.all([
      sb.from('settings').select('*').eq('id', 1).single(),
      sb.from('profiles').select('id, full_name, email, role, active, branch_id, extra_branches').order('full_name'),
      sb.rpc('my_roles'),
      sb.from('delegations').select('*').eq('to_user', me.id).lte('starts_on', iso).gte('ends_on', iso),
      sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
    ]);
    state.settings = settings;
    state.people = people || [];
    state.roles = Array.isArray(roles) && roles.length ? roles : [me.role];
    // the Managing Director holds every power of the General Manager except administration (same rule as the server)
    if (state.roles.includes('managing_director') && !state.roles.includes('approver')) state.roles.push('approver');
    state.standingIn = deleg || [];
    state.unread = count || 0;
    const { data: branches } = await sb.rpc('my_branch_list');
    state.branches = Array.isArray(branches) ? branches : [];
    state.view = me.view_branch && state.branches.some((b) => b.id === me.view_branch) ? me.view_branch : null;
  }
  syncAppBadge(me && me.active ? state.unread : 0);
  if (me && me.active) checkIn().catch(() => {});
  return me;
}

/* ---------- devices ---------- */
/** The id of this device's sign-in, read from its access token (to mark "this device" and keep it when signing out others). */
export function currentSessionId() {
  try {
    const p = (state.session?.access_token || '').split('.')[1];
    return p ? JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((p.length + 3) % 4))).session_id || null : null;
  } catch { return null; }
}

/** Tell the server this device is open: which device, and (from its address) roughly where. At most every 15 minutes. */
export async function checkIn(force = false) {
  const sid = currentSessionId();
  if (!sid || !state.me?.active) return null;
  try { const last = JSON.parse(localStorage.getItem('pcs_checkin') || 'null'); if (!force && last?.sid === sid && Date.now() - last.at < 15 * 60e3) return null; } catch {}
  relinkPush(sid).catch(() => {});
  const label = await thisDeviceLabel();
  let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
  const res = await fetch(`${FUNCTIONS_URL}/devices`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${state.session.access_token}` }, body: JSON.stringify({ label, tz, standalone: isStandaloneApp() }) });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && json.revoked && signedOutElsewhere) { signedOutElsewhere(); return null; }
  if (res.ok) { try { localStorage.setItem('pcs_checkin', JSON.stringify({ sid, at: Date.now() })); } catch {} }
  return json;
}

/** Alerts follow the sign-in: after signing in again on a phone that had alerts on, they come back on by themselves. */
async function relinkPush(sid) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return;
  try { if (localStorage.getItem('pcs_push_asked') === 'off') return; } catch {}
  const reg = await navigator.serviceWorker.getRegistration();
  let sub = await reg?.pushManager?.getSubscription();
  if (!sub) return;
  // the server's alert key changed (a new key, or a new installation): sign this phone up again with the new one
  const key = await pushKey().catch(() => null);
  if (key && sub.options?.applicationServerKey && bytesToB64(sub.options.applicationServerKey) !== key.replace(/=+$/, '')) {
    await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe().catch(() => {});
    try { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }); } catch { return; }   // Account → Phone alerts turns it back on
  }
  const j = sub.toJSON();
  await sb.from('push_subscriptions').upsert({ user_id: state.me.id, endpoint: sub.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200), session_id: sid }, { onConflict: 'endpoint' });
}

/** Sign out on this device only (the default in the auth library would sign out every device). */
export async function signOutHere() {
  try { sessionStorage.setItem('pcs_out', 'self'); } catch {}
  await sb.auth.signOut({ scope: 'local' });
}

/** The number on the home-screen icon = unread alerts (iPhone 16.4+ and installed desktop apps; elsewhere a no-op). */
export function syncAppBadge(n = state.unread) {
  try {
    if (!('setAppBadge' in navigator)) return;
    (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  } catch { /* not supported */ }
}

/** Mark alerts read (all of them, or just these) and bring the bell and the icon up to date. */
export async function markAlertsRead(ids = null) {
  if (ids && !ids.length) return state.unread;
  await rpc('mark_notifications_read', ids ? { p_ids: ids } : {});
  return refreshUnread();
}

export async function refreshUnread() {
  const { count } = await sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
  state.unread = count || 0;
  document.querySelectorAll('[data-unread]').forEach((el) => { el.textContent = state.unread; el.style.display = state.unread ? '' : 'none'; });
  syncAppBadge();
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

/* ---------- phone alerts (web push) ---------- */
export function pushSupport() {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return { ok: false, reason: iOS && !standalone ? 'ios_not_installed' : 'unsupported' };
  if (Notification.permission === 'denied') return { ok: false, reason: 'denied' };
  return { ok: true, granted: Notification.permission === 'granted' };
}
async function swReady() { if (!('serviceWorker' in navigator)) throw new Error('Not supported in this browser'); return navigator.serviceWorker.ready; }
/** The public half of this installation's alert key (each client has its own). */
let pushKeyCache = null;
async function pushKey() { if (!pushKeyCache) { const { data, error } = await sb.rpc('push_public_key'); if (error || !data) throw new Error('Phone alerts are not set up on the server yet.'); pushKeyCache = data; } return pushKeyCache; }
function bytesToB64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64ToBytes(b64) { const pad = '='.repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); }
/** Is this device subscribed for the signed-in person? */
export async function pushStatus() {
  try {
    const sup = pushSupport(); if (!sup.ok) return { on: false, ...sup };
    const reg = await swReady(); const sub = await reg.pushManager.getSubscription();
    if (!sub) return { on: false, ok: true };
    const { data } = await sb.from('push_subscriptions').select('id').eq('endpoint', sub.endpoint).maybeSingle();
    return { on: !!data, ok: true, orphan: !data };
  } catch { return { on: false, ok: false, reason: 'unsupported' }; }
}
export async function enablePush() {
  const sup = pushSupport(); if (!sup.ok) throw new Error(sup.reason === 'ios_not_installed' ? 'On iPhone, alerts only work once the app is on your home screen (Share → Add to Home Screen).' : sup.reason === 'denied' ? 'Notifications are blocked for this site in your browser settings.' : 'This browser cannot receive alerts.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Alerts were not allowed.');
  const reg = await swReady();
  let sub = await reg.pushManager.getSubscription();
  const key = await pushKey();
  if (sub && sub.options?.applicationServerKey && bytesToB64(sub.options.applicationServerKey) !== key.replace(/=+$/, '')) { await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  const j = sub.toJSON();
  unwrap(await sb.from('push_subscriptions').upsert({ user_id: state.me.id, endpoint: sub.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200), session_id: currentSessionId() }, { onConflict: 'endpoint' }));
  try { localStorage.setItem('pcs_push_asked', 'on'); } catch {}
  return true;
}
export async function disablePush() {
  try { const reg = await swReady(); const sub = await reg.pushManager.getSubscription(); if (sub) { await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); } } catch {}
  try { localStorage.setItem('pcs_push_asked', 'off'); } catch {}
}
export async function testPush() {
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${state.session?.access_token || ''}` };
  const res = await fetch(`${FUNCTIONS_URL}/send-push`, { method: 'POST', headers, body: JSON.stringify({ test: true }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `Could not send (${res.status})`);
  return json;
}

/** A file's fingerprint, so the same receipt photo is recognised wherever it is attached again. */
export async function fileSha256(file) {
  try {
    const d = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}
/** The request this photo is already attached to, if any (shown as a warning; finance must explain before accepting it). */
async function usedOn(sha, requestId = null) {
  if (!sha) return null;
  try { const r = await rpc('proof_used', { p_sha256: sha, p_request: requestId }); return r?.request_no || null; } catch { return null; }
}

/* ---------- snapped receipts (inbox) ---------- */
export async function uploadToInbox(file) {
  const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80) || 'receipt.jpg';
  const path = `inbox/${state.me.id}/${crypto.randomUUID()}-${safe}`;
  const sha256 = await fileSha256(file);
  const { error } = await sb.storage.from('proofs').upload(path, file, { contentType: file.type || 'application/octet-stream' });
  if (error) throw new Error(cleanError(error));
  const row = unwrap(await sb.from('receipt_inbox').insert({ user_id: state.me.id, storage_path: path, file_name: file.name || safe, mime: file.type, sha256 }).select().single());
  return { ...row, used_on: await usedOn(sha256) };
}
/** Move the snapped file into the request's folder and attach it as a proof. */
export async function fileInboxReceipt(inbox, requestId) {
  const base = inbox.storage_path.split('/').pop();
  const newPath = `${requestId}/${base}`;
  const { error } = await sb.storage.from('proofs').move(inbox.storage_path, newPath);
  if (error && !/already exists|duplicate/i.test(error.message)) throw new Error(cleanError(error));
  return rpc('file_inbox_receipt', { p_inbox: inbox.id, p_request: requestId, p_new_path: newPath });
}
/** Move the file into the request's folder and attach it as an invoice/quote *before* the pay-out (own approved or pending request). */
export async function fileInboxDocument(inbox, requestId, kind = 'invoice') {
  const base = inbox.storage_path.split('/').pop();
  const newPath = `${requestId}/${base}`;
  const { error } = await sb.storage.from('proofs').move(inbox.storage_path, newPath);
  if (error && !/already exists|duplicate/i.test(error.message)) throw new Error(cleanError(error));
  return rpc('file_inbox_document', { p_inbox: inbox.id, p_request: requestId, p_new_path: newPath, p_kind: kind });
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
  const { data } = await sb.from('profiles').select('id, full_name, email, role, active, branch_id, extra_branches').order('full_name');
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

/** Call the account-mail function: welcome / invitation (admin), password reset and sign-in link (public). */
export async function accountMail(body) {
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
  if (state.session?.access_token) headers.Authorization = `Bearer ${state.session.access_token}`;
  let res;
  try { res = await fetch(`${FUNCTIONS_URL}/account-mail`, { method: 'POST', headers, body: JSON.stringify(body) }); }
  catch { throw new Error('No connection. Check your internet and try again.'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

/* ---------- proofs ---------- */
export async function uploadProof(requestId, expenseId, file) {
  const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80);
  const path = `${requestId}/${crypto.randomUUID()}-${safe}`;
  const sha256 = await fileSha256(file);
  const { error } = await sb.storage.from('proofs').upload(path, file, { contentType: file.type || 'application/octet-stream' });
  if (error) throw new Error(cleanError(error));
  const row = unwrap(await sb.from('expense_proofs').insert({
    expense_id: expenseId, storage_path: path, file_name: file.name, mime: file.type, uploaded_by: state.me.id, sha256,
  }).select().single());
  return { ...row, used_on: await usedOn(sha256, requestId) };
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
