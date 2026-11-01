// What this person has asked for before, so the forms can offer it again: their earlier requests to repeat with
// one tap or pick while typing, and the items and people they use most (listed first in the pickers).
import { sb, state } from './api.js';

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
let hist = null; let histAt = 0;

/** Their own requests from the last year (not drafts), newest first, with their lines. */
export async function myHistory() {
  if (hist && Date.now() - histAt < 60_000) return hist;
  const since = new Date(Date.now() - 365 * 864e5).toISOString();
  const { data } = await sb.from('requests')
    .select('id, request_no, type, purpose, category_id, estimated_total, created_at, status, for_store, lines:request_lines(item_id, description, qty, est_unit_price)')
    .eq('requester_id', state.me.id).neq('status', 'draft').gte('created_at', since).order('created_at', { ascending: false }).limit(150);
  hist = (data || []).filter((r) => r.purpose && !r.for_store); histAt = Date.now();
  return hist;
}
export function forgetHistory() { hist = null; }

/** One entry per different thing they asked for (the latest version of it), most often asked first. */
export function repeats(history, type) {
  const by = new Map();
  for (const r of history) {
    if (type && r.type !== type) continue;
    const k = `${r.type}|${norm(r.purpose)}`;
    const e = by.get(k); if (e) e.times += 1; else by.set(k, { ...r, times: 1 });   // newest first: the first seen is the latest
  }
  return [...by.values()].sort((a, b) => b.times - a.times || String(b.created_at).localeCompare(String(a.created_at)));
}
/** Earlier requests whose purpose contains every word typed so far. */
export function matching(list, text) {
  const words = norm(text).split(' ').filter((w) => w.length > 0);
  if (!words.length || norm(text).length < 2) return [];
  return list.filter((r) => { const p = norm(r.purpose); return p !== norm(text) && words.every((w) => p.includes(w)); });
}
/** The amount an earlier request was for (lines if there are any). */
export const amountOf = (r) => { const t = (r.lines || []).reduce((s, l) => s + Number(l.qty || 0) * Number(l.est_unit_price || 0), 0); return t > 0 ? t : Number(r.estimated_total || 0); };

const topOf = (counts, n = 5) => [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
const tally = (values) => { const m = new Map(); for (const v of values) if (v) m.set(v, (m.get(v) || 0) + 1); return m; };

/** Items they have asked for most (their requests' lines). */
export async function myTopItems() { return topOf(tally((await myHistory()).flatMap((r) => (r.lines || []).map((l) => l.item_id)))); }
/** Items they report running low most. */
export async function myTopReported() {
  const { data } = await sb.from('stock_reports').select('item_id').eq('reported_by', state.me.id).order('created_at', { ascending: false }).limit(300);
  return topOf(tally((data || []).map((r) => r.item_id)));
}
/** People finance hands cash to most (the last six months). */
let payees = null;
export async function myTopPayees() {
  if (payees) return payees;
  const since = new Date(Date.now() - 182 * 864e5).toISOString();
  const { data } = await sb.from('requests').select('disbursed_to').eq('disbursed_by', state.me.id).gte('disbursed_at', since).limit(500);
  payees = topOf(tally((data || []).map((r) => r.disbursed_to)), 6);
  return payees;
}
