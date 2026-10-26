import { sb, state, adminUsers, refreshPeople, unwrap, ROLE_LABEL, personName } from '../api.js';
import { h, mount, money, num, fmtDate, toast, busy, field, select, modal, refresh, confirmDialog, today, isoDate, emptyState } from '../ui.js';

export async function adminPage(tab = 'users') {
  const tabs = [['users', 'People'], ['standins', 'Stand-ins'], ['budgets', 'Budgets'], ['settings', 'Settings']];
  const bar = h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: k === tab ? 'active' : '', onclick: () => { location.hash = `#/admin/${k}`; } }, l)));
  const body = tab === 'settings' ? settingsTab() : tab === 'standins' ? await standinsTab() : tab === 'budgets' ? await budgetsTab() : await usersTab();
  const action = { users: ['Add person', () => userDialog(null)], standins: ['Add stand-in', () => standinDialog(null)], budgets: ['Add budget', () => budgetDialog(null)] }[tab];
  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Admin'), h('p', {}, 'Who can sign in, who covers for whom, the budgets, and the rules the system enforces.')),
      action ? h('div', { class: 'page-actions' }, h('button', { class: 'btn btn-primary', onclick: action[1] }, action[0])) : null),
    bar, body);
}

/* =============================================================== people */
async function usersTab() {
  await refreshPeople();
  const people = state.people;
  const roleHelp = {
    requester: 'Raises requests and claims; records what they spent.',
    stock_manager: 'Reviews stock requests, keeps the store, raises the monthly restock.',
    finance: 'Opens the float, pays out, checks receipts, closes the month.',
    approver: 'Signs off anything above the threshold or over budget; administers the system.',
  };
  return h('div', {},
    h('div', { class: 'sheet' },
      h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Role'), h('th'))),
        h('tbody', {}, people.map((p) => h('tr', { style: { opacity: p.active ? 1 : 0.55 } },
          h('td', {}, h('strong', {}, p.full_name || '—'), !p.active ? h('span', { class: 'pill pill-grey', style: { marginLeft: '6px' } }, 'inactive') : null, p.id === state.me.id ? h('span', { class: 'muted' }, ' (you)') : null),
          h('td', { class: 'muted' }, p.email), h('td', {}, ROLE_LABEL[p.role]),
          h('td', { class: 'num', style: { whiteSpace: 'nowrap' } },
            h('button', { class: 'btn btn-sm btn-quiet', onclick: () => userDialog(p) }, 'Edit'), ' ',
            h('button', { class: 'btn btn-sm btn-quiet', onclick: () => passwordDialog(p) }, 'Password'), ' ',
            p.id !== state.me.id ? h('button', { class: `btn btn-sm btn-quiet${p.active ? ' btn-danger' : ''}`, onclick: async () => {
              const ok = await confirmDialog(p.active ? `Deactivate ${p.full_name}?` : `Reactivate ${p.full_name}?`, p.active ? 'They will not be able to sign in. Their history stays.' : 'They will be able to sign in again.', { ok: p.active ? 'Deactivate' : 'Reactivate', danger: p.active });
              if (!ok) return;
              try { await adminUsers({ action: 'set_active', user_id: p.id, active: !p.active }); toast(p.active ? 'Deactivated.' : 'Reactivated.'); refresh(); } catch (e) { toast(e.message, { error: true }); }
            } }, p.active ? 'Deactivate' : 'Reactivate') : null))))))),
    h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h3', {}, 'Roles')),
      h('dl', { class: 'kv' }, Object.entries(roleHelp).map(([k, v]) => [h('dt', {}, ROLE_LABEL[k]), h('dd', {}, v)]))));
}

function userDialog(p) {
  modal(p ? `Edit ${p.full_name || p.email}` : 'Add a person', (close) => {
    const name = h('input', { class: 'input', value: p?.full_name || '', required: true, autocomplete: 'off' });
    const email = h('input', { class: 'input', type: 'email', value: p?.email || '', required: true, disabled: !!p, autocomplete: 'off' });
    const role = select(Object.entries(ROLE_LABEL), p?.role || 'requester');
    const pass = p ? null : h('input', { class: 'input', type: 'text', value: tempPassword(), autocomplete: 'off' });
    const err = h('div', { class: 'error' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, p ? 'Save' : 'Create account');
    const go = busy(b, async () => {
      err.textContent = '';
      try {
        if (p) await adminUsers({ action: 'update', user_id: p.id, full_name: name.value, role: role.value });
        else await adminUsers({ action: 'create', email: email.value, full_name: name.value, role: role.value, password: pass.value });
        toast(p ? 'Saved.' : `Account created. Give ${name.value.trim()} the temporary password.`, { ms: 6000 }); close(); refresh();
      } catch (e) { err.textContent = e.message; }
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      field('Name', name), field('Email', email, p ? 'Email cannot be changed here.' : 'They sign in with this.'), field('Role', role),
      pass ? field('Temporary password', pass, 'Share it with them in person or by message; they can change it under Account.') : null,
      err, h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

function passwordDialog(p) {
  modal(`New password for ${p.full_name || p.email}`, (close) => {
    const pass = h('input', { class: 'input', type: 'text', value: tempPassword(), autocomplete: 'off' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Set password');
    const go = busy(b, async () => { await adminUsers({ action: 'reset_password', user_id: p.id, password: pass.value }); toast('Password set. Share it with them.'); close(); });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } }, field('Temporary password', pass, 'At least 8 characters. They can change it afterwards.'),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

function tempPassword() {
  const words = ['river', 'desert', 'acacia', 'dune', 'ocean', 'baobab', 'sunset', 'granite', 'harbour', 'oryx', 'welwitschia', 'kudu'];
  const w = () => words[Math.floor(Math.random() * words.length)];
  return `${w()}-${w()}-${Math.floor(100 + Math.random() * 900)}`;
}

/* =============================================================== stand-ins */
export async function endDelegation(d) {
  // keep history: a stand-in that has started ends yesterday; one that has not started is removed
  if (d.starts_on <= today()) { const y = new Date(); y.setDate(y.getDate() - 1); unwrap(await sb.from('delegations').update({ ends_on: isoDate(y) }).eq('id', d.id)); }
  else unwrap(await sb.from('delegations').delete().eq('id', d.id));
}

async function standinsTab() {
  const rows = unwrap(await sb.from('delegations').select('*').order('starts_on', { ascending: false }).limit(200));
  const t = today();
  const current = rows.filter((d) => d.starts_on <= t && d.ends_on >= t);
  const upcoming = rows.filter((d) => d.starts_on > t);
  const past = rows.filter((d) => d.ends_on < t).slice(0, 20);
  const row = (d, live) => h('li', {}, h('div', { class: 'what' },
    h('strong', {}, `${personName(d.to_user)} covers ${ROLE_LABEL[d.role].replace(' (admin)', '').toLowerCase()} for ${personName(d.from_user)}`),
    h('span', {}, `${fmtDate(d.starts_on)} – ${fmtDate(d.ends_on)}${d.note ? ` · ${d.note}` : ''}`)),
    live ? h('button', { class: 'btn btn-sm btn-quiet', onclick: () => standinDialog(d) }, 'Edit') : null,
    live ? h('button', { class: 'btn btn-sm btn-quiet btn-danger', onclick: async () => { if (!(await confirmDialog('End this stand-in?', `${personName(d.to_user)} will stop seeing ${personName(d.from_user)}'s queue.`, { ok: 'End it', danger: true }))) return; try { await endDelegation(d); toast('Ended.'); refresh(); } catch (e) { toast(e.message, { error: true }); } } }, 'End') : null);
  const section = (title, list, live) => list.length ? h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, title), h('span', { class: 'sub' }, list.length)), h('ul', { class: 'ledger-list' }, list.map((d) => row(d, live)))) : null;
  return h('div', {},
    h('p', { class: 'hint', style: { marginBottom: '12px' } }, 'A stand-in sees the queue and gets the alerts of the person they cover for, and every action is recorded under the stand-in\'s own name. Administration never passes on. People can also set their own stand-in under Account.'),
    rows.length ? [section('Covering now', current, true), section('Coming up', upcoming, true), section('Past', past, false)] : emptyState('No stand-ins', 'Set one up before someone goes on leave so nothing waits for them.'));
}

export function standinDialog(d, { fixedFrom = null } = {}) {
  modal(d ? 'Edit stand-in' : 'Who covers for whom', (close) => {
    const people = state.people.filter((p) => p.active);
    const fromPeople = fixedFrom ? people.filter((p) => p.id === fixedFrom.id) : people.filter((p) => p.role !== 'requester');
    const from = select(fromPeople.map((p) => [p.id, `${p.full_name || p.email} (${ROLE_LABEL[p.role].replace(' (admin)', '')})`]), d?.from_user || fixedFrom?.id || fromPeople[0]?.id, { disabled: !!fixedFrom || !!d });
    const to = select([['', 'Choose…'], ...people.map((p) => [p.id, p.full_name || p.email])], d?.to_user || '');
    const starts = h('input', { class: 'input', type: 'date', value: d?.starts_on || today(), required: true });
    const ends = h('input', { class: 'input', type: 'date', value: d?.ends_on || '', required: true });
    const note = h('input', { class: 'input', value: d?.note || '', placeholder: 'e.g. Annual leave' });
    const err = h('div', { class: 'error' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, d ? 'Save' : 'Set stand-in');
    const go = busy(b, async () => {
      err.textContent = '';
      const fp = state.people.find((p) => p.id === from.value);
      if (!to.value) { err.textContent = 'Choose who covers.'; return; }
      if (to.value === from.value) { err.textContent = 'Someone cannot stand in for themselves.'; return; }
      if (!ends.value || ends.value < starts.value) { err.textContent = 'The end date must be on or after the start.'; return; }
      const payload = { role: fp.role, from_user: from.value, to_user: to.value, starts_on: starts.value, ends_on: ends.value, note: note.value.trim() || null };
      try {
        if (d) unwrap(await sb.from('delegations').update(payload).eq('id', d.id));
        else unwrap(await sb.from('delegations').insert({ ...payload, created_by: state.me.id }));
        toast(`${personName(to.value)} covers ${ROLE_LABEL[fp.role].replace(' (admin)', '').toLowerCase()} from ${fmtDate(starts.value)}.`); close(); refresh();
      } catch (e) { err.textContent = e.message; }
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      field('Who is away', from, 'Their role is what gets covered.'), field('Who covers', to),
      h('div', { class: 'row' }, field('From', starts), field('Until', ends)), field('Note', note),
      err, h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

/* =============================================================== budgets */
async function budgetsTab() {
  const [{ data: status }, { data: cats }] = await Promise.all([sb.rpc('budget_status'), sb.from('categories').select('id, name').order('name')]);
  const rows = status || [];
  const mode = state.settings.budget_mode || 'warn';
  const modeText = { warn: 'Over-budget requests are flagged but still flow as normal.', require_approval: 'Over-budget requests go to the approver even when under the threshold.', block: 'Over-budget requests cannot be submitted.' }[mode];
  const bar = (b) => {
    const pct = Number(b.monthly_limit) > 0 ? Math.min(100, Math.round(Number(b.used) / Number(b.monthly_limit) * 100)) : 0;
    const over = Number(b.used) > Number(b.monthly_limit);
    return h('div', { class: 'meter', title: `${pct}% used` }, h('div', { class: 'meter-fill', style: { width: `${pct}%`, background: over ? 'var(--red)' : pct > 80 ? 'var(--amber)' : 'var(--green)' } }));
  };
  return h('div', {},
    h('p', { class: 'hint', style: { marginBottom: '12px' } }, `Monthly limits per category or per person. ${modeText} Change the rule under Settings.`),
    rows.length ? h('div', { class: 'sheet' }, h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Budget'), h('th', { style: { width: '32%' } }, 'This month'), h('th', { class: 'num' }, 'Used'), h('th', { class: 'num' }, 'Limit'), h('th'))),
      h('tbody', {}, rows.map((b) => h('tr', { style: { opacity: b.active ? 1 : 0.55 } },
        h('td', {}, h('strong', {}, b.label), b.note ? h('div', { class: 'muted' }, b.note) : null, !b.active ? h('span', { class: 'pill pill-grey', style: { marginLeft: '6px' } }, 'off') : null),
        h('td', {}, bar(b)),
        h('td', { class: 'num', style: { color: Number(b.used) > Number(b.monthly_limit) ? 'var(--red)' : '' } }, money(b.used)),
        h('td', { class: 'num' }, money(b.monthly_limit)),
        h('td', { class: 'num', style: { whiteSpace: 'nowrap' } },
          h('button', { class: 'btn btn-sm btn-quiet', onclick: () => budgetDialog(b, cats) }, 'Edit'), ' ',
          h('button', { class: 'btn btn-sm btn-quiet', onclick: async () => { try { unwrap(await sb.from('budgets').update({ active: !b.active }).eq('id', b.budget_id)); toast(b.active ? 'Budget switched off.' : 'Budget switched on.'); refresh(); } catch (e) { toast(e.message, { error: true }); } } }, b.active ? 'Switch off' : 'Switch on'))))))))
      : emptyState('No budgets yet', 'Add a monthly limit for a category (e.g. Cleaning) or a person. Spending is counted when cash is paid out.'));
}

function budgetDialog(b, cats) {
  modal(b ? `Edit budget: ${b.label}` : 'Add a budget', async (close) => {
    if (!cats) cats = (await sb.from('categories').select('id, name').order('name')).data || [];
    const kind = select([['category', 'A category'], ['person', 'A person']], b?.person_id ? 'person' : 'category', { disabled: !!b });
    const cat = select(cats.map((c) => [c.id, c.name]), b?.category_id || cats[0]?.id, { disabled: !!b });
    const person = select(state.people.filter((p) => p.active).map((p) => [p.id, p.full_name || p.email]), b?.person_id || state.people[0]?.id, { disabled: !!b });
    const limit = h('input', { class: 'input num', type: 'number', min: '0.01', step: '0.01', value: b ? Number(b.monthly_limit).toFixed(2) : '', required: true });
    const note = h('input', { class: 'input', value: b?.note || '', placeholder: 'Optional' });
    const err = h('div', { class: 'error' });
    const sync = () => { cat.closest('.field').style.display = kind.value === 'category' ? '' : 'none'; person.closest('.field').style.display = kind.value === 'person' ? '' : 'none'; };
    kind.onchange = sync;
    const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, b ? 'Save' : 'Add budget');
    const go = busy(btn, async () => {
      err.textContent = '';
      if (num(limit.value) <= 0) { err.textContent = 'Enter a monthly limit.'; return; }
      try {
        if (b) unwrap(await sb.from('budgets').update({ monthly_limit: num(limit.value), note: note.value.trim() || null }).eq('id', b.budget_id));
        else unwrap(await sb.from('budgets').insert({ category_id: kind.value === 'category' ? cat.value : null, person_id: kind.value === 'person' ? person.value : null, monthly_limit: num(limit.value), note: note.value.trim() || null, active: true }));
        toast('Budget saved.'); close(); refresh();
      } catch (e) { err.textContent = /duplicate|unique/i.test(e.message) ? 'There is already a budget for that. Edit it instead.' : e.message; }
    });
    const form = h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      field('Budget for', kind), field('Category', cat), field('Person', person),
      field('Monthly limit', limit, 'Counted against cash paid out and claims reimbursed in the calendar month.'), field('Note', note),
      err, h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), btn));
    sync();
    return form;
  }, { wide: false });
}

/* =============================================================== settings */
function settingsTab() {
  const s = state.settings;
  const org = h('input', { class: 'input', value: s.org_name });
  const currency = h('input', { class: 'input', value: s.currency, maxlength: 6 });
  const threshold = h('input', { class: 'input num', type: 'number', min: 0, step: '0.01', value: Number(s.approval_threshold).toFixed(2) });
  const floatAmt = h('input', { class: 'input num', type: 'number', min: 0, step: '0.01', value: Number(s.default_monthly_float).toFixed(2) });
  const rollover = h('input', { type: 'checkbox', checked: !!s.float_rollover });
  const grace = h('input', { class: 'input num', type: 'number', min: 1, max: 60, step: 1, value: s.advance_grace_days ?? 5 });
  const blockOutstanding = h('input', { type: 'checkbox', checked: !!s.block_with_outstanding });
  const budgetMode = select([['warn', 'Flag it, let it through'], ['require_approval', 'Send it to the approver'], ['block', 'Block it']], s.budget_mode || 'warn');
  const countDay = select([[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [0, 'No reminder']], String(s.count_day ?? 5));
  const headcount = h('input', { class: 'input num', type: 'number', min: 1, step: 1, value: s.headcount ?? 8 });
  const emailFrom = h('input', { class: 'input', value: s.email_from || '', placeholder: 'Petty Cash <petty@yourdomain>' });
  const appUrl = h('input', { class: 'input', type: 'url', value: s.app_url || '', placeholder: 'https://…' });
  const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save settings');
  const go = busy(b, async () => {
    unwrap(await sb.from('settings').update({
      org_name: org.value.trim() || 'Petty cash', currency: currency.value.trim() || 'N$', approval_threshold: num(threshold.value), default_monthly_float: num(floatAmt.value), float_rollover: rollover.checked,
      advance_grace_days: Math.max(1, Math.round(num(grace.value) || 5)), block_with_outstanding: blockOutstanding.checked, budget_mode: budgetMode.value,
      count_day: Number(countDay.value), headcount: Math.max(1, Math.round(num(headcount.value) || 1)), email_from: emailFrom.value.trim() || null, app_url: appUrl.value.trim() || null,
      updated_at: new Date().toISOString(),
    }).eq('id', 1));
    state.settings = unwrap(await sb.from('settings').select('*').eq('id', 1).single());
    toast('Settings saved.'); refresh();
  });
  const block = (title, ...kids) => h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, title)), ...kids);
  return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
    block('Basics', field('Organisation name', org), h('div', { class: 'row' }, field('Currency symbol', currency), field('Approval threshold', threshold, 'Requests and claims above this go to the approver.')),
      field('Usual monthly float', floatAmt, 'Pre-filled when finance opens a month.'),
      h('label', { class: 'check', style: { marginBottom: '8px' } }, rollover, 'Carry unspent balance into the next month'),
      h('p', { class: 'hint' }, 'Off: a quiet month shows as a saving and finance receives the full float again. On: the float resets to the usual amount plus whatever was left.')),
    block('Chasing cash that is out', h('div', { class: 'row' }, field('Days before a reminder', grace, 'Cash paid out with no receipt recorded after this many days gets a daily nudge; finance is told too.')),
      h('label', { class: 'check', style: { marginBottom: '8px' } }, blockOutstanding, 'Hold new pay-outs to someone who still owes a receipt'),
      h('p', { class: 'hint' }, 'Finance sees the outstanding advance on the pay-out screen either way.')),
    block('Budgets', field('When a request goes over its budget', budgetMode, 'Budgets are set on the Budgets tab.')),
    block('Counting and reports', h('div', { class: 'row' }, field('Weekly count reminder', countDay, 'The stock manager gets a nudge to do a quick count.'), field('People in the office', headcount, 'Used for cost per head in reports.'))),
    block('Email', h('div', { class: 'row' }, field('Send emails from', emailFrom, 'Must be an address on a domain verified with the email provider; blank uses the test sender.'), field('Link to the app', appUrl, 'Used in emails so people can open the thing that needs them.'))),
    h('div', { class: 'form-actions' }, b));
}
