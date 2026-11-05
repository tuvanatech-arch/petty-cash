// What happens to the things kept on this phone offline (offline.js outbox) once the signal is back.
// New requests and claims become drafts – never sent for approval without the person checking them first.
import { sb, state, unwrap, rpc, uploadToInbox } from './api.js';
import { addProofFiles } from './proofs.js';
import { flushOutbox } from './offline.js';

async function addLines(id, lines) {
  if (lines?.length) unwrap(await sb.from('request_lines').insert(lines.map((l, i) => ({ request_id: id, line_no: i + 1, item_id: l.item_id || null, description: l.description || '', qty: l.qty, est_unit_price: l.est_unit_price }))));
}
async function urgent(id, d) { if (d.urgent) await rpc('set_urgent', { p_request: id, p_urgent: true, p_reason: d.urgent_reason }); }

const HANDLERS = {
  async request(d) {
    const row = unwrap(await sb.from('requests').insert({ type: d.type, purpose: d.purpose, needed_by: d.needed_by || null, category_id: d.category_id || null, not_stock: !!d.not_stock, requester_id: state.me.id, for_store: false, branch_id: d.branch_id || null }).select().single());
    await addLines(row.id, d.lines); await urgent(row.id, d);
    return { id: row.id, what: d.purpose };
  },
  async claim(d, files) {
    const r = await rpc('save_claim', { p_request: null, p_purpose: d.purpose, p_category: d.category_id || null, p_spent_at: d.spent_at, p_supplier: d.supplier || null, p_notes: d.notes || null });
    await addLines(r.id, d.lines); await urgent(r.id, d);
    if (files.length) {
      const ex = (await sb.from('expenses').select('id').eq('request_id', r.id).maybeSingle()).data;
      if (ex) await addProofFiles(files, { requestId: r.id, expenseId: ex.id });
    }
    return { id: r.id, what: d.purpose };
  },
  async inbox(_d, files) { for (const f of files) await uploadToInbox(f); return { inbox: files.length }; },
  async rpc(d) { await rpc(d.fn, d.args); return { what: d.what }; },
};

/** Send everything kept offline; says what happened in one short message. */
export async function sendKept({ toast } = {}) {
  if (!state.me) return [];
  const done = await flushOutbox(HANDLERS);
  if (!done.length || !toast) return done;
  const ok = done.filter((j) => !j.failed); const drafts = ok.filter((j) => j.result?.id);
  const failed = done.filter((j) => j.failed);
  const parts = [];
  if (ok.length) parts.push(`Back online: ${ok.length} thing${ok.length === 1 ? '' : 's'} kept on this phone ${ok.length === 1 ? 'was' : 'were'} sent.`);
  if (drafts.length) parts.push(`${drafts.length === 1 ? `“${drafts[0].result.what}” is` : `${drafts.length} requests are`} saved as draft${drafts.length === 1 ? '' : 's'}: open ${drafts.length === 1 ? 'it' : 'them'} under Requests, check and send.`);
  if (failed.length) parts.push(`${failed.length} could not be sent: ${failed[0].failed}`);
  toast(parts.join(' '), { ms: 9000, error: !!failed.length && !ok.length });
  return done;
}
