// The authority schedule (MGP-SCH-PC-001): limits, the float, reminder periods, budgets and who holds each position,
// in one versioned place. The administrator changes it; the Managing Director approves what needs approving.
import { sb, state, unwrap, rpc, role, has, personName, ROLE_LABEL, mdInPlace } from '../api.js';
import { h, money, num, fmtDate, toast, busy, field, select, modal, refresh, confirmDialog, emptyState, today } from '../ui.js';
import { ITEMS, SECTIONS, WEEKDAYS, EVERY, BUDGET_MODES, AREA_LABEL, POSITIONS, fmtValue, versionStatus, changeText } from '../schedule-meta.js';
import { downloadSchedulePdf } from '../schedule-pdf.js';

async function load() {
  const [settings, versions, budgets, cats, standins] = await Promise.all([
    sb.from('settings').select('*').eq('id', 1).single(),
    sb.from('schedule_versions').select('*').order('proposed_at', { ascending: false }).limit(300),
    sb.rpc('budget_status'),
    sb.from('categories').select('id, name').order('name'),
    sb.from('delegations').select('*').gte('ends_on', today()).order('starts_on'),
  ]);
  state.settings = unwrap(settings);
  const all = unwrap(versions) || [];
  const applied = all.filter((v) => v.status === 'applied').sort((a, b) => b.version_no - a.version_no);
  const when = (v) => v.effective_at || v.decided_at || v.proposed_at;
  return {
    versions: all,
    current: applied[0] || null,
    pending: all.find((v) => v.status === 'pending') || null,
    history: all.filter((v) => v.status !== 'pending').sort((a, b) => String(when(b)).localeCompare(String(when(a)))),
    budgets: budgets.data || [],
    cats: cats.data || [],
    standins: standins.data || [],
  };
}

export async function schedulePage({ embedded = false } = {}) {
  const d = await load();
  const admin = role() === 'approver';
  const isMD = has('managing_director');
  const body = h('div', { class: 'schedule' },
    headCard(d, admin), pendingCard(d, admin, isMD), reviewCard(d, isMD),
    valuesBlock(d, admin), budgetsBlock(d, admin), positionsBlock(d, admin), historyBlock(d));
  if (embedded) return body;
  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Authority schedule'),
      h('p', {}, 'The limits, the float, budgets and who holds each position – the version in force and every earlier one.'))),
    body);
}

/** A section heading with its approval rule beside the title (and an optional action on the right). */
const head = (title, md, action = null) => h('div', { class: 'sheet-head' },
  h('div', { class: 'head-title' }, h('h2', {}, title), h('span', { class: `pill ${md ? 'pill-purple' : 'pill-grey'}` }, md ? 'MD approves changes' : 'MD is told')), action);
const reloadSettings = async () => { state.settings = unwrap(await sb.from('settings').select('*').eq('id', 1).single()); };
const pdfButton = (v, label = 'Download PDF', cls = 'btn btn-sm') => {
  const b = h('button', { class: cls, type: 'button' }, label);
  b.onclick = busy(b, async () => { await downloadSchedulePdf(v); });
  return b;
};
const changesList = (changes, empty = 'The schedule as it stood when it was first recorded.') =>
  (changes || []).length ? h('ul', { class: 'plain-list changes' }, changes.map((c) => h('li', {}, h('span', {}, `${c.label}: `), h('s', {}, c.from), ' → ', h('strong', {}, c.to))))
    : h('p', { class: 'hint' }, empty);

/* ---------------------------------------------------------------- the version in force */
function headCard(d, admin) {
  const s = state.settings; const v = d.current;
  const st = v ? versionStatus(v) : null;
  return h('div', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, h('h2', {}, `${s.schedule_ref} · version ${v?.version_no ?? '—'}`), v ? pdfButton(v) : null),
    v ? h('p', { class: 'hint' }, `In force since ${fmtDate(v.effective_at, { time: true })} · ${AREA_LABEL[v.area] || ''} · changed by ${personName(v.proposed_by)}`, st.text ? ` · ${st.text}` : '') : null,
    s.policy_url ? h('p', {}, h('a', { href: s.policy_url, target: '_blank', rel: 'noopener' }, `${s.policy_ref} – the petty cash policy ↗`))
      : h('p', { class: 'hint' }, `${s.policy_ref}: no link to the policy document yet${admin ? ' – add it under Documents.' : '.'}`),
    h('p', { class: 'hint' }, mdInPlace()
      ? 'Changes to the limits, the approval rules and the float wait for the Managing Director’s approval. Reminders, documents and budgets apply at once and the MD is told. Every request records the version it was approved under.'
      : 'No Managing Director is set up yet, so changes apply at once and are kept for the MD to review. Every request records the version it was approved under.'));
}

/* ---------------------------------------------------------------- waiting for the MD */
function pendingCard(d, admin, isMD) {
  const p = d.pending;
  if (!p) return null;
  const actions = [];
  if (isMD && p.proposed_by !== state.me.id) {
    const ok = h('button', { class: 'btn btn-primary btn-sm' }, 'Approve');
    ok.onclick = busy(ok, async () => {
      const note = await confirmDialog('Approve this change?', 'It takes effect at once as the next version, and the GM and finance are told.', { ok: 'Approve', note: { label: 'Note (optional)' } });
      if (note === null) return;
      const v = await rpc('decide_schedule', { p_id: p.id, p_approve: true, p_note: note || null });
      await reloadSettings();
      toast(v?.version_no ? `Approved – version ${v.version_no} is in force.` : 'Nothing was left to change.'); refresh();
    });
    const no = h('button', { class: 'btn btn-sm btn-danger' }, 'Turn down');
    no.onclick = busy(no, async () => {
      const note = await confirmDialog('Turn this change down?', 'Nothing changes. The GM sees your reason.', { ok: 'Turn down', danger: true, note: { label: 'Why', required: true } });
      if (note === null) return;
      await rpc('decide_schedule', { p_id: p.id, p_approve: false, p_note: note });
      toast('Turned down – the GM has been told.'); refresh();
    });
    actions.push(ok, no);
  }
  if (admin || p.proposed_by === state.me.id) {
    const w = h('button', { class: 'btn btn-sm btn-quiet' }, 'Withdraw');
    w.onclick = busy(w, async () => {
      if (!(await confirmDialog('Withdraw this change?', 'The MD will no longer be asked. Nothing changes.', { ok: 'Withdraw' }))) return;
      await rpc('withdraw_schedule', { p_id: p.id }); toast('Withdrawn.'); refresh();
    });
    actions.push(w);
  }
  return h('div', { class: 'sheet sched-pending' },
    h('div', { class: 'sheet-head' }, h('h2', { class: 'threshold' }, isMD ? 'Schedule change to approve' : 'Waiting for the Managing Director'), h('span', { class: 'sub' }, fmtDate(p.proposed_at))),
    changesList(p.changes),
    h('p', { class: 'hint' }, `Proposed by ${personName(p.proposed_by)}, ${fmtDate(p.proposed_at, { time: true })}`, p.reason ? ` – “${p.reason}”` : ''),
    isMD && p.proposed_by === state.me.id ? h('p', { class: 'hint' }, 'You proposed this, so someone else must approve it.') : null,
    actions.length ? h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, actions) : null);
}

/* ---------------------------------------------------------------- what the MD has not seen yet */
function reviewCard(d, isMD) {
  const list = d.history.filter((v) => v.status === 'applied' && v.md_status === 'no_md' && v.proposed_by !== state.me.id);
  if (!isMD || !list.length) return null;
  const b = h('button', { class: 'btn btn-primary btn-sm' }, list.length === 1 ? 'Mark reviewed' : `Mark all ${list.length} reviewed`);
  b.onclick = busy(b, async () => {
    const note = await confirmDialog('Mark these reviewed?', 'This records that you have looked at each version listed.', { ok: 'Mark reviewed', note: { label: 'Note (optional)' } });
    if (note === null) return;
    const n = await rpc('review_schedule', { p_ids: list.map((v) => v.id), p_note: note || null });
    toast(`${n} version${n === 1 ? '' : 's'} marked reviewed.`); refresh();
  });
  return h('div', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, h('h2', {}, 'Changed before you were set up'), h('span', { class: 'sub' }, list.length)),
    h('p', { class: 'hint' }, 'These versions were made while there was no Managing Director in the app, so nobody approved them. Look through each one.'),
    h('ul', { class: 'ledger-list' }, list.map((v) => h('li', {}, h('div', { class: 'what' },
      h('strong', {}, `Version ${v.version_no} · ${AREA_LABEL[v.area] || ''}`),
      h('span', {}, `${fmtDate(v.effective_at)} by ${personName(v.proposed_by)}${v.reason ? ` – “${v.reason}”` : ''}`),
      changesList(v.changes)), pdfButton(v, 'PDF', 'btn btn-sm btn-quiet')))),
    h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, b));
}

/* ---------------------------------------------------------------- the values */
function readInput(k, el) {
  const kind = ITEMS[k].kind;
  if (kind === 'bool') return el.checked;
  if (kind === 'money') return Math.round(num(el.value) * 100) / 100;
  if (kind === 'days') return Math.round(num(el.value));
  if (kind === 'pct') return num(el.value);
  if (kind === 'weekday' || kind === 'every') return Number(el.value);
  if (kind === 'url') return el.value.trim() || null;
  return el.value.trim();
}
const same = (k, a, b) => {
  const kind = ITEMS[k].kind;
  if (['money', 'days', 'pct', 'weekday', 'every'].includes(kind)) return Number(a) === Number(b);
  if (kind === 'bool') return !!a === !!b;
  return (a ?? '') === (b ?? '');
};

function inputFor(k, v) {
  const it = ITEMS[k];
  switch (it.kind) {
    case 'money': return h('input', { class: 'input num', type: 'number', min: 0, step: '0.01', value: Number(v ?? 0).toFixed(2) });
    case 'days': case 'pct': return h('input', { class: 'input num', type: 'number', min: it.min, max: it.max, step: it.kind === 'pct' ? '0.5' : 1, value: v ?? '' });
    case 'bool': return h('input', { type: 'checkbox', checked: !!v });
    case 'mode': return select(BUDGET_MODES, v || 'warn');
    case 'weekday': return select(WEEKDAYS, String(v ?? 5));
    case 'every': return select(EVERY.some(([k]) => String(k) === String(v ?? 7)) ? EVERY : [...EVERY, [Number(v), `Every ${Number(v)} days`]], String(v ?? 7));
    case 'url': return h('input', { class: 'input', type: 'url', value: v || '', placeholder: 'https://…' });
    default: return h('input', { class: 'input', value: v || '', maxlength: 40 });
  }
}

function valuesBlock(d, admin) {
  const s = state.settings;
  const pend = d.pending?.proposed || {};
  const inputs = {};
  const waiting = (k) => (k in pend && !same(k, pend[k], s[k]) ? h('span', { class: 'pending-val' }, `Waiting for the MD: ${fmtValue(k, pend[k])}`) : null);
  const sections = SECTIONS.map((sec) => h('div', { class: 'sheet' },
    head(sec.title, sec.md),
    admin
      ? h('div', { class: 'sched-grid' }, sec.keys.map((k) => {
        const it = ITEMS[k]; const el = inputFor(k, s[k]); inputs[k] = el;
        if (it.kind === 'bool') return h('div', { class: 'field' }, h('label', { class: 'check' }, el, it.label), it.hint ? h('span', { class: 'hint' }, it.hint) : null, waiting(k));
        const f = field(it.label, el, it.hint); const w = waiting(k); if (w) f.append(w); return f;
      }))
      : h('dl', { class: 'kv sched-kv' }, sec.keys.filter((k) => k !== 'policy_url').map((k) => [h('dt', {}, ITEMS[k].label), h('dd', {}, fmtValue(k, s[k]), waiting(k) ? [h('br'), waiting(k)] : null)]))));
  if (!admin) return sections;
  const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Review and save…');
  return h('form', { onsubmit: (e) => { e.preventDefault(); reviewChanges(inputs); } }, sections,
    h('div', { class: 'form-actions sched-save' }, h('span', { class: 'hint' }, 'Nothing changes until you review and give a reason.'), b));
}

function reviewChanges(inputs) {
  const s = state.settings; const md = mdInPlace();
  const values = {}; const rows = [];
  for (const [k, el] of Object.entries(inputs)) {
    const v = readInput(k, el);
    if (same(k, v, s[k])) continue;
    values[k] = v;
    const waits = md && SECTIONS.find((sec) => sec.keys.includes(k)).md;
    rows.push(h('li', {}, h('span', {}, `${ITEMS[k].label}: `), h('s', {}, fmtValue(k, s[k])), ' → ', h('strong', {}, fmtValue(k, v)), ' ',
      h('span', { class: `pill ${waits ? 'pill-purple' : 'pill-green'}` }, waits ? 'waits for the MD' : 'applies now')));
  }
  if (!rows.length) { toast('Nothing has changed.'); return; }
  modal('Save changes to the schedule', (close) => {
    const reason = h('textarea', { class: 'input', rows: 2, placeholder: 'e.g. Fuel prices went up; agreed at the management meeting of 28 Oct' });
    const err = h('div', { class: 'error' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save');
    const go = busy(b, async () => {
      err.textContent = '';
      if (reason.value.trim().length < 3) { err.textContent = 'Say why the schedule is changing – it is kept with the version.'; return; }
      try {
        const r = await rpc('change_schedule', { p_values: values, p_reason: reason.value.trim() });
        await reloadSettings();
        const parts = [];
        if (r.version) parts.push(`Version ${r.version} is in force`);
        if (r.pending) parts.push(`${(r.waiting || []).length === 1 ? 'the change' : 'the changes'} to limits and rules went to the MD for approval`);
        const msg = parts.join('; '); toast(msg.charAt(0).toUpperCase() + msg.slice(1) + '.'); close(); refresh();
      } catch (e) { err.textContent = e.message; }
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      h('ul', { class: 'plain-list changes' }, rows),
      !md ? h('p', { class: 'hint' }, 'No Managing Director is set up yet, so everything applies now and is kept for the MD to review.') : null,
      field('Reason for the change', reason, 'Kept with the version and printed on the schedule.'),
      err, h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

/* ---------------------------------------------------------------- budgets */
function budgetsBlock(d, admin) {
  const rows = d.budgets;
  const mode = state.settings.budget_mode || 'warn';
  const modeText = { warn: 'Over-budget requests are flagged but flow as normal.', require_approval: 'Over-budget requests go for approval even under the finance limit.', block: 'Over-budget requests cannot be submitted.' }[mode];
  const meter = (b) => {
    const pct = Number(b.monthly_limit) > 0 ? Math.min(100, Math.round(Number(b.used) / Number(b.monthly_limit) * 100)) : 0;
    const over = Number(b.used) > Number(b.monthly_limit);
    return h('div', { class: 'meter', title: `${pct}% used` }, h('div', { class: 'meter-fill', style: { width: `${pct}%`, background: over ? 'var(--red)' : pct > 80 ? 'var(--amber)' : 'var(--green)' } }));
  };
  const toggle = (b) => {
    const btn = h('button', { class: 'btn btn-sm btn-quiet' }, b.active ? 'Switch off' : 'Switch on');
    btn.onclick = busy(btn, async () => {
      const why = await confirmDialog(b.active ? `Switch off the ${b.label} budget?` : `Switch the ${b.label} budget back on?`, 'This is a new version of the schedule; the MD is told.', { ok: b.active ? 'Switch off' : 'Switch on', note: { label: 'Reason', required: true } });
      if (why === null) return;
      const r = await rpc('schedule_budget', { p_budget: b.budget_id, p_category: null, p_person: null, p_limit: Number(b.monthly_limit), p_note: b.note, p_active: !b.active, p_reason: why });
      toast(`${b.active ? 'Switched off' : 'Switched on'} – version ${r.version} is in force.`); refresh();
    });
    return btn;
  };
  return h('div', { class: 'sheet' },
    head('Budgets', false, admin ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => budgetDialog(null, d.cats) }, 'Add budget') : null),
    h('p', { class: 'hint' }, `Monthly limits per category or per person, counted against cash paid out and claims reimbursed in the calendar month. ${modeText}`),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Budget'), h('th', { style: { width: '30%' } }, 'This month'), h('th', { class: 'num' }, 'Used'), h('th', { class: 'num' }, 'Limit'), admin ? h('th') : null)),
      h('tbody', {}, rows.map((b) => h('tr', { class: b.active ? '' : 'inactive' },
        h('td', {}, h('strong', {}, b.label), b.note ? h('div', { class: 'muted' }, b.note) : null, !b.active ? h('span', { class: 'pill pill-grey', style: { marginLeft: '6px' } }, 'off') : null),
        h('td', {}, meter(b)),
        h('td', { class: 'num', style: { color: Number(b.used) > Number(b.monthly_limit) ? 'var(--red)' : '' } }, money(b.used)),
        h('td', { class: 'num' }, money(b.monthly_limit)),
        admin ? h('td', { class: 'num', style: { whiteSpace: 'nowrap' } }, h('button', { class: 'btn btn-sm btn-quiet', onclick: () => budgetDialog(b, d.cats) }, 'Edit'), ' ', toggle(b)) : null)))))
      : emptyState('No budgets yet', admin ? 'Add a monthly limit for a category (e.g. Cleaning) or a person.' : 'None set.'));
}

function budgetDialog(b, cats) {
  modal(b ? `Edit budget: ${b.label}` : 'Add a budget', (close) => {
    const kind = select([['category', 'A category'], ['person', 'A person']], b?.person_id ? 'person' : 'category', { disabled: !!b });
    const cat = select(cats.map((c) => [c.id, c.name]), b?.category_id || cats[0]?.id, { disabled: !!b });
    const person = select(state.people.filter((p) => p.active).map((p) => [p.id, p.full_name || p.email]), b?.person_id || state.people[0]?.id, { disabled: !!b });
    const limit = h('input', { class: 'input num', type: 'number', min: '0.01', step: '0.01', value: b ? Number(b.monthly_limit).toFixed(2) : '', required: true });
    const note = h('input', { class: 'input', value: b?.note || '', placeholder: 'Optional' });
    const reason = h('input', { class: 'input', placeholder: b ? 'e.g. Two more people in the office' : 'e.g. Cleaning costs agreed at 1,200 a month' });
    const err = h('div', { class: 'error' });
    const sync = () => { cat.closest('.field').style.display = kind.value === 'category' ? '' : 'none'; person.closest('.field').style.display = kind.value === 'person' ? '' : 'none'; };
    kind.onchange = sync;
    const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, b ? 'Save' : 'Add budget');
    const go = busy(btn, async () => {
      err.textContent = '';
      if (num(limit.value) <= 0) { err.textContent = 'Enter a monthly limit.'; return; }
      if (reason.value.trim().length < 3) { err.textContent = 'Say why – it is kept with the schedule version.'; return; }
      try {
        const r = await rpc('schedule_budget', {
          p_budget: b?.budget_id || null, p_category: b ? null : (kind.value === 'category' ? cat.value : null), p_person: b ? null : (kind.value === 'person' ? person.value : null),
          p_limit: num(limit.value), p_note: note.value.trim() || null, p_active: b ? b.active : true, p_reason: reason.value.trim(),
        });
        toast(r.version ? `Budget saved – version ${r.version} is in force.` : 'Budget note saved.'); close(); refresh();
      } catch (e) { err.textContent = e.message; }
    });
    const form = h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      field('Budget for', kind), field('Category', cat), field('Person', person),
      field('Monthly limit', limit, 'Counted against cash paid out and claims reimbursed in the calendar month.'), field('Note', note),
      field('Reason for the change', reason, 'Kept with the schedule version; the MD is told.'),
      err, h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), btn));
    sync();
    return form;
  });
}

/* ---------------------------------------------------------------- positions and stand-ins */
function positionsBlock(d, admin) {
  const s = state.settings;
  const holders = (r) => state.people.filter((p) => p.active && p.role === r);
  const roleName = (r) => (ROLE_LABEL[r] || r).replace(' (admin)', '');
  return h('div', { class: 'sheet' },
    head('Positions and who holds them', false, admin ? h('a', { class: 'btn btn-sm btn-quiet', href: '#/admin/users' }, 'Change under People') : null),
    h('ul', { class: 'ledger-list' }, POSITIONS.map((pos) => {
      const who = holders(pos.role);
      return h('li', {}, h('div', { class: 'what' }, h('strong', {}, pos.label), h('span', {}, pos.duty(s))),
        h('span', { class: 'amt', style: who.length ? null : { color: 'var(--amber)' } }, who.length ? who.map((p) => p.full_name || p.email).join(', ') : 'Not set up'));
    })),
    h('div', { class: 'sheet-head', style: { marginTop: '16px' } }, h('h3', {}, 'Stand-ins, now and coming up'), admin ? h('a', { class: 'btn btn-sm btn-quiet', href: '#/admin/standins' }, 'Stand-ins') : null),
    d.standins.length ? h('ul', { class: 'plain-list' }, d.standins.map((x) => h('li', {}, `${personName(x.to_user)} covers ${roleName(x.role).toLowerCase()} for ${personName(x.from_user)}, ${fmtDate(x.starts_on)} – ${fmtDate(x.ends_on)}`)))
      : h('p', { class: 'hint' }, 'None. A stand-in acts under their own name; the MD names their own stand-in.'));
}

/* ---------------------------------------------------------------- every version */
function historyBlock(d) {
  if (!d.history.length) return null;
  return h('div', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, h('h2', {}, 'Versions'), h('span', { class: 'sub' }, `${d.history.filter((v) => v.status === 'applied').length} in all`)),
    h('ul', { class: 'ledger-list' }, d.history.map((v) => {
      const st = versionStatus(v);
      const title = v.status === 'applied' ? `Version ${v.version_no}` : 'Proposed change';
      return h('li', {}, h('details', { class: 'more sched-version' },
        h('summary', {}, h('strong', {}, title), ` · ${fmtDate(v.effective_at || v.decided_at || v.proposed_at)} · ${AREA_LABEL[v.area] || ''} `, h('span', { class: `pill ${st.pill}` }, st.text)),
        h('div', { class: 'more-body' },
          changesList(v.status === 'applied' ? v.changes : (v.changes?.length ? v.changes : [])),
          h('p', { class: 'hint' }, `${v.status === 'applied' ? 'Changed' : 'Proposed'} by ${personName(v.proposed_by)}, ${fmtDate(v.proposed_at, { time: true })}`, v.reason ? ` – “${v.reason}”` : '',
            v.decision_note ? ` · ${v.status === 'rejected' ? 'MD' : 'Note'}: “${v.decision_note}”` : ''),
          v.status === 'applied' ? pdfButton(v, `PDF of version ${v.version_no}`, 'btn btn-sm btn-quiet') : null)));
    })));
}
