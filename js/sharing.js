// One receipt, several requests (056). Under a scanned receipt Petti lists its lines and where each one goes: on this
// request; on someone else's open request ("Send to Sarah" – she is asked "Is this yours?"); a new request; or
// personal, not claimed. The person whose request it is answers on their request ("Yes, it's mine" / "Not mine").
import { sb, state, rpc, unwrap, personName, proofUrl } from './api.js';
import { h, mount, money, toast, busy, confirmDialog, fmtDate } from './ui.js';

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3);
const near = (a, b) => a > 0 && b > 0 && Math.abs(a - b) <= Math.max(1, a * 0.05);
/** A receipt line that is plainly one of this request's own lines (same word, or the same amount). */
function onOwn(line, own) {
  const w = words(line.description);
  return own.some((l) => near(line.amount, Number(l.qty) * Number(l.est_unit_price)) || words(l.description).some((x) => w.some((y) => y.startsWith(x.slice(0, 4)) || x.startsWith(y.slice(0, 4)))));
}
const FINISHED = ['closed', 'fulfilled_from_stock', 'rejected', 'cancelled'];

/** The sorting panel under a receipt scanned on this request (null when there is nothing to sort). */
export function receiptPlacement(proof, q, onChange = () => {}) {
  const lines = proof?.extracted?.lines || [];
  if (!lines.length || proof.shared_from || FINISHED.includes(q.status)) return null;
  const mine = q.requester_id === state.me.id || q.disbursed_to === state.me.id || proof.uploaded_by === state.me.id;
  const box = h('div', { class: 'placement', id: `placement-${proof.id}` }, h('p', { class: 'hint' }, 'Checking the receipt’s lines…'));
  async function draw() {
    const [matches, shares, own] = await Promise.all([
      rpc('receipt_line_matches', { p_proof: proof.id }).catch(() => []),
      rpc('receipt_shares_info', { p_proof: proof.id }).catch(() => []),
      sb.from('request_lines').select('description, qty, est_unit_price').eq('request_id', q.id).then((r) => r.data || []),
    ]);
    const placed = Object.fromEntries((proof.placement || []).map((x) => [x.i, x.where]));
    const live = shares.filter((s) => ['offered', 'accepted'].includes(s.status));
    const shareOf = (i) => live.find((s) => (s.lines || []).some((l) => l.i === i));
    const reqNo = {}; for (const m of matches) for (const c of m.candidates || []) reqNo[c.request_id] = c;
    for (const x of shares) reqNo[x.to_request] = { person: x.mine ? 'your' : x.person, request_no: x.request_no, mine: x.mine };
    const sum = { own: 0, shared: 0, personal: 0, open: 0 };
    const rows = matches.map((m) => {
      const i = m.i; const amt = Number(m.amount) || 0; const s = shareOf(i);
      const head = h('div', { class: 'pl-line' }, h('strong', {}, m.description || `Line ${i + 1}`), h('span', { class: 'num' }, money(amt)));
      let state_ = null; let actions = [];
      if (s) {
        sum.shared += amt;
        const to = reqNo[s.to_request];
        const who = to ? (to.mine ? `your #${to.request_no}` : `${to.person}’s #${to.request_no}`) : 'another request';
        state_ = s.status === 'accepted' ? h('span', { class: 'pill pill-green' }, `✓ On ${who}`) : h('span', { class: 'pill pill-amber' }, `Sent to ${who} – waiting for their answer`);
        if (s.status === 'offered' && s.offered_by === state.me.id) {
          const back = h('button', { type: 'button', class: 'btn btn-sm btn-quiet' }, 'Take back');
          back.onclick = busy(back, async () => { await rpc('withdraw_receipt_share', { p_share: s.id }); toast('Taken back.'); await draw(); onChange(); });
          actions.push(back);
        }
      } else if (placed[i] === 'personal') {
        sum.personal += amt; state_ = h('span', { class: 'pill pill-grey' }, 'Personal – not claimed');
        actions.push(undo(i));
      } else if (placed[i] === 'own' || onOwn({ description: m.description, amount: amt }, own)) {
        sum.own += amt; state_ = h('span', { class: 'pill pill-green' }, '✓ On this request');
        if (placed[i] === 'own') actions.push(undo(i));
      } else {
        sum.open += amt; state_ = h('span', { class: 'pill pill-amber' }, 'Not on this request');
        if (mine) {
          for (const c of (m.candidates || []).slice(0, 2)) {
            const b = h('button', { type: 'button', class: 'btn btn-sm btn-primary' }, c.mine ? `Move to your #${c.request_no}` : `Send to ${c.person.split(' ')[0]} (#${c.request_no})`);
            b.title = `${c.purpose} – ${c.line}${c.line_amount ? ` (${money(c.line_amount)})` : ''}`;
            b.onclick = busy(b, async () => {
              await rpc('share_receipt_lines', { p_proof: proof.id, p_to_request: c.request_id, p_lines: [i] });
              toast(c.mine ? `Moved to your #${c.request_no}.` : `Sent to ${c.person}: they are asked whether it is theirs.`, { ms: 5000 }); await draw(); onChange();
            });
            actions.push(h('span', { class: 'pl-cand' }, h('span', { class: 'hint' }, `Looks like ${c.mine ? 'your' : `${c.person}’s`} request #${c.request_no} “${c.purpose}”`), b));
          }
          const onThis = h('button', { type: 'button', class: 'btn btn-sm' }, 'It’s on this request');
          onThis.onclick = busy(onThis, async () => { proof.placement = await rpc('place_receipt_line', { p_proof: proof.id, p_index: i, p_where: 'own' }); await draw(); onChange(); });
          const start = h('button', { type: 'button', class: 'btn btn-sm' }, 'Start a request for it');
          start.onclick = busy(start, async () => {
            const id = await startClaimFor(proof, m);
            toast(`Draft claim started for “${m.description}” with its share of the receipt – open it under Requests, check it and send.`, { ms: 7000 });
            await draw(); onChange(); return id;
          });
          const pers = h('button', { type: 'button', class: 'btn btn-sm btn-quiet' }, 'Personal, not claimed');
          pers.onclick = busy(pers, async () => { proof.placement = await rpc('place_receipt_line', { p_proof: proof.id, p_index: i, p_where: 'personal' }); await draw(); onChange(); });
          actions.push(onThis, start, pers);
        }
      }
      return h('li', { class: 'pl-row', 'data-line': i }, head, h('div', { class: 'pl-state' }, state_), actions.length ? h('div', { class: 'pl-actions' }, actions) : null);
    });
    function undo(i) {
      const b = h('button', { type: 'button', class: 'btn btn-sm btn-quiet' }, 'Undo');
      b.onclick = busy(b, async () => { proof.placement = await rpc('place_receipt_line', { p_proof: proof.id, p_index: i, p_where: 'clear' }); await draw(); onChange(); });
      return b;
    }
    const total = Number(proof.extracted?.total) || 0;
    const parts = [sum.own ? `on this request ${money(sum.own)}` : null, sum.shared ? `shared ${money(sum.shared)}` : null, sum.personal ? `personal ${money(sum.personal)}` : null].filter(Boolean);
    mount(box,
      h('div', { class: 'sheet-head' }, h('h3', {}, 'What is on this receipt'), total ? h('span', { class: 'sub' }, money(total)) : null),
      sum.open > 0.005 ? h('div', { class: 'banner banner-amber', id: 'not-placed' }, h('strong', {}, `${money(sum.open)} not placed yet`),
        'Some lines are not on this request. Send them to the request they belong to, start a request for them, or mark them personal.')
        : parts.length ? h('p', { class: 'hint', id: 'all-placed' }, `✓ Every line is placed: ${parts.join(' · ')}.`) : null,
      h('ul', { class: 'pl-list' }, rows));
  }
  draw().catch((e) => mount(box, h('p', { class: 'hint' }, e.message)));
  return box;
}

/** "Start a request for it": a draft claim for that line, carrying its share of the receipt. */
async function startClaimFor(proof, m) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(proof.extracted?.date || '') ? proof.extracted.date : new Date().toISOString().slice(0, 10);
  const r = await rpc('save_claim', { p_request: null, p_purpose: m.description, p_category: null, p_spent_at: date, p_supplier: proof.extracted?.supplier || null, p_notes: null });
  unwrap(await sb.from('request_lines').insert({ request_id: r.id, line_no: 1, description: m.description, qty: 1, est_unit_price: Number(m.amount) || 0 }));
  await rpc('share_receipt_lines', { p_proof: proof.id, p_to_request: r.id, p_lines: [m.i] });
  return r.id;
}

/** On a request: receipts others think belong to it ("Is this yours?"), for its requester to answer. */
export async function shareOffers(q, reload) {
  if (![q.requester_id, q.disbursed_to].includes(state.me.id)) return null;
  const data = await rpc('receipt_shares_info', { p_proof: null, p_request: q.id }).catch(() => []);
  if (!data?.length) return null;
  return h('div', {}, await Promise.all(data.map(async (s) => {
    const url = s.storage_path ? await proofUrl(s.storage_path).catch(() => null) : null;
    const yes = h('button', { class: 'btn btn-primary', id: 'share-yes' }, 'Yes, it’s mine');
    yes.onclick = busy(yes, async () => { await rpc('decide_receipt_share', { p_share: s.id, p_accept: true }); toast('Added to your request with your share of the receipt.'); reload(); });
    const no = h('button', { class: 'btn', id: 'share-no' }, 'Not mine');
    no.onclick = busy(no, async () => {
      const why = await confirmDialog('Not on your request?', `${personName(s.offered_by)} is told, so they can place it on the right request.`, { ok: 'Send', note: { label: 'Why it is not yours', required: true } });
      if (!why) return; await rpc('decide_receipt_share', { p_share: s.id, p_accept: false, p_note: why }); toast(`${personName(s.offered_by)} has been told.`); reload();
    });
    const what = (s.lines || []).map((l) => `${l.description} (${money(l.amount)})`).join(', ');
    return h('div', { class: 'banner banner-amber share-offer', id: 'share-offer' },
      h('strong', {}, 'Is this yours?'),
      `${s.by || personName(s.offered_by)} bought ${what} on one receipt${s.supplier ? ` at ${s.supplier}` : ''} on ${fmtDate(String(s.offered_at).slice(0, 10))} and thinks it belongs to this request. If yes, the receipt is added here with your share of ${money(s.amount)}.`,
      url ? h('p', {}, h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open the receipt')) : null,
      h('div', { class: 'form-actions', style: { justifyContent: 'flex-start', marginTop: '8px' } }, yes, no));
  })));
}

/** Under a receipt that is this request's share of a shared one. */
export function shareCaption(proof) {
  if (proof?.share_amount == null) return null;
  return h('p', { class: 'hint share-caption' }, `This request’s share: ${money(proof.share_amount)} of a ${money(proof.extracted?.total)} receipt shared with another request.`);
}
