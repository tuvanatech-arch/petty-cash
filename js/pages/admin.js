import { sb, state, adminUsers, accountMail, refreshPeople, unwrap, rpc, ROLE_LABEL, personName } from '../api.js';
import { devicesDialog } from '../devices.js';
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
  const [, counts] = await Promise.all([refreshPeople(), rpc('device_counts').catch(() => [])]);
  const people = state.people;
  const devs = Object.fromEntries((counts || []).map((c) => [c.user_id, c]));
  const devCell = (p) => {
    const c = devs[p.id];
    if (!c) return h('span', { class: 'muted dev-count' }, p.active ? 'Not signed in' : '—');
    return h('button', { class: 'btn btn-sm btn-quiet dev-count', title: c.places || '', onclick: () => devicesDialog(p) }, `${c.devices} device${c.devices === 1 ? '' : 's'}`);
  };
  // an alert about someone's account links straight to their devices
  const want = new URLSearchParams(location.hash.split('?')[1] || '').get('devices');
  if (want) setTimeout(() => { const p = people.find((x) => x.id === want); if (p) devicesDialog(p); }, 50);
  const roleHelp = {
    requester: 'Raises requests and claims; records what they spent.',
    stock_manager: 'Reviews stock requests, keeps the store, raises the monthly restock.',
    finance: 'Opens the float, pays out, checks receipts, closes the month.',
    approver: 'General Manager: approves above the finance limit up to the GM limit (never their own); administers the system.',
    managing_director: 'Approves above the GM limit and the GM’s own requests; sees everything; no administration. Their own requests are paid, then reviewed by the GM.',
  };
  return h('div', {},
    h('div', { class: 'sheet' },
      h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Role'), h('th', {}, 'Devices'), h('th'))),
        h('tbody', {}, people.map((p) => h('tr', { class: p.active ? '' : 'inactive' },
          h('td', {}, h('strong', {}, p.full_name || '—'), !p.active ? h('span', { class: 'pill pill-grey', style: { marginLeft: '6px' } }, 'inactive') : null, p.id === state.me.id ? h('span', { class: 'muted' }, ' (you)') : null),
          h('td', { class: 'muted' }, p.email), h('td', {}, ROLE_LABEL[p.role]), h('td', {}, devCell(p)),
          h('td', { class: 'num', style: { whiteSpace: 'nowrap' } },
            h('button', { class: 'btn btn-sm btn-quiet', onclick: () => userDialog(p) }, 'Edit'), ' ',
            p.active ? h('button', { class: 'btn btn-sm btn-quiet', onclick: () => inviteDialog(p) }, 'Invite') : null, ' ',
            h('button', { class: 'btn btn-sm btn-quiet', onclick: () => passwordDialog(p) }, 'Password'), ' ',
            p.id !== state.me.id ? h('button', { class: `btn btn-sm btn-quiet${p.active ? ' btn-danger' : ''}`, onclick: async () => {
              const ok = await confirmDialog(p.active ? `Deactivate ${p.full_name}?` : `Reactivate ${p.full_name}?`, p.active ? 'They will not be able to sign in. Their history stays.' : 'They will be able to sign in again.', { ok: p.active ? 'Deactivate' : 'Reactivate', danger: p.active });
              if (!ok) return;
              try { await adminUsers({ action: 'set_active', user_id: p.id, active: !p.active }); toast(p.active ? 'Deactivated.' : 'Reactivated.'); refresh(); } catch (e) { toast(e.message, { error: true }); }
            } }, p.active ? 'Deactivate' : 'Reactivate') : null, ' ',
            p.id !== state.me.id && !p.active ? h('button', { class: 'btn btn-sm btn-quiet btn-danger', onclick: async () => {
              const ok = await confirmDialog(`Delete ${p.full_name}'s account?`, 'Only possible for an account that never did anything in the app. Anyone with history is kept (deactivated) so the records stay whole.', { ok: 'Delete', danger: true });
              if (!ok) return;
              try { await adminUsers({ action: 'delete', user_id: p.id }); toast('Deleted.'); refresh(); } catch (e) { toast(e.message, { error: true, ms: 7000 }); }
            } }, 'Delete') : null))))))),
    h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h3', {}, 'Roles')),
      h('dl', { class: 'kv' }, Object.entries(roleHelp).map(([k, v]) => [h('dt', {}, ROLE_LABEL[k]), h('dd', {}, v)]))));
}

function userDialog(p) {
  modal(p ? `Edit ${p.full_name || p.email}` : 'Add a person', (close) => {
    const name = h('input', { class: 'input', value: p?.full_name || '', required: true, autocomplete: 'off' });
    const email = h('input', { class: 'input', type: 'email', value: p?.email || '', required: true, autocomplete: 'off' });
    const role = select(Object.entries(ROLE_LABEL), p?.role || 'requester');
    const pass = p ? null : h('input', { class: 'input', type: 'text', value: tempPassword(), autocomplete: 'off' });
    const err = h('div', { class: 'error' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, p ? 'Save' : 'Create account');
    const go = busy(b, async () => {
      err.textContent = '';
      try {
        if (p) {
          await adminUsers({ action: 'update', user_id: p.id, full_name: name.value, role: role.value, email: email.value });
          toast(email.value.trim().toLowerCase() !== (p.email || '').toLowerCase() ? `Saved. ${name.value.trim()} now signs in as ${email.value.trim().toLowerCase()}.` : 'Saved.', { ms: 6000 }); close(); refresh();
        } else {
          const { user_id } = await adminUsers({ action: 'create', email: email.value, full_name: name.value, role: role.value, password: pass.value });
          close(); refresh();
          inviteDialog({ id: user_id, full_name: name.value.trim(), email: email.value.trim().toLowerCase(), role: role.value }, pass.value);
        }
      } catch (e) { err.textContent = e.message; }
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      field('Name', name), field('Email', email, p ? 'They sign in with this. If you change it, tell them – the old address stops working at once.' : 'They sign in with this.'), field('Role', role),
      pass ? field('Temporary password', pass, 'Only needed if the invitation cannot be emailed; shown again on the next screen.') : null,
      err, h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), b));
  });
}

/** Send (or hand over) the welcome link. With email set up it is sent; without, the link and a ready-made message are shown to copy. */
function inviteDialog(p, tempPassword = null) {
  modal(`Invite ${p.full_name || p.email}`, (close) => {
    const box = h('div', {}, h('p', { class: 'hint' }, 'Preparing the one-time link…'));
    const copy = (text, label = 'Copy') => { const b = h('button', { type: 'button', class: 'btn btn-sm' }, label); b.onclick = async () => { try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(() => { b.textContent = label; }, 1500); } catch { toast('Select the text and copy it.', { error: true }); } }; return b; };
    accountMail({ action: 'welcome', user_id: p.id }).then((r) => {
      if (r.sent) {
        mount(box, h('div', { class: 'banner banner-green' }, h('strong', {}, `Invitation emailed to ${r.email}`), `${p.full_name || 'They'} opens the link once, sets a password and lands in the ${ROLE_LABEL[p.role] || p.role} view. The link expires; “Invite” on the People list sends a fresh one.`));
      } else {
        const why = r.reason === 'no_provider' ? 'Email is not set up yet (no sending key), so pass this on yourself – WhatsApp works well.'
          : r.reason === 'no_sender' ? 'No sending address is set under Admin → Settings, so pass this on yourself.' : `The email could not be sent (${r.reason}). Pass this on yourself.`;
        const share = navigator.share ? h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => navigator.share({ text: r.message }).catch(() => {}) }, 'Share…') : null;
        mount(box,
          h('p', { class: 'hint' }, why),
          h('div', { class: 'field' }, h('span', { class: 'label' }, 'Message to send'), h('textarea', { class: 'input', rows: 5, readonly: true, value: r.message })),
          h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, share, copy(r.message, 'Copy message'), copy(r.link, 'Copy link only')),
          tempPassword ? h('p', { class: 'hint', style: { marginTop: '10px' } }, `If the link has expired by the time they open it, they can sign in with the temporary password instead: `, h('code', {}, tempPassword), ' – and change it under Account.') : null,
          h('p', { class: 'hint' }, 'The link works once and expires after a while; “Invite” on the People list makes a new one.'));
      }
    }).catch((e) => mount(box, h('div', { class: 'error' }, e.message), tempPassword ? h('p', { class: 'hint' }, `Give ${p.full_name || 'them'} the temporary password `, h('code', {}, tempPassword), ' to sign in with; they change it under Account.') : null));
    return h('div', {}, box, h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Done')));
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
      h('tbody', {}, rows.map((b) => h('tr', { class: b.active ? '' : 'inactive' },
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
  const gmLimit = h('input', { class: 'input num', type: 'number', min: 0, step: '0.01', value: Number(s.gm_limit ?? 5000).toFixed(2) });
  const splitDays = h('input', { class: 'input num', type: 'number', min: 1, max: 31, step: 1, value: s.split_window_days ?? 7 });
  const tolerance = h('input', { class: 'input num', type: 'number', min: 0, max: 50, step: 1, value: s.change_tolerance_pct ?? 10 });
  const floatAmt = h('input', { class: 'input num', type: 'number', min: 0, step: '0.01', value: Number(s.default_monthly_float).toFixed(2) });
  const rollover = h('input', { type: 'checkbox', checked: !!s.float_rollover });
  const grace = h('input', { class: 'input num', type: 'number', min: 1, max: 60, step: 1, value: s.advance_grace_days ?? 5 });
  const blockOutstanding = h('input', { type: 'checkbox', checked: !!s.block_with_outstanding });
  const claimsApprove = h('input', { type: 'checkbox', checked: s.claims_need_approval !== false });
  const budgetMode = select([['warn', 'Flag it, let it through'], ['require_approval', 'Send it for approval'], ['block', 'Block it']], s.budget_mode || 'warn');
  const countDay = select([[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [0, 'No reminder']], String(s.count_day ?? 5));
  const headcount = h('input', { class: 'input num', type: 'number', min: 1, step: 1, value: s.headcount ?? 8 });
  const reserveBuf = h('input', { class: 'input num', type: 'number', min: 0, max: 100, step: 1, value: s.reserve_buffer_pct ?? 15 });
  const emailFrom = h('input', { class: 'input', value: s.email_from || '', placeholder: 'Petty Cash <petty@yourdomain>' });
  const appUrl = h('input', { class: 'input', type: 'url', value: s.app_url || '', placeholder: 'https://…' });
  const acctName = h('input', { class: 'input', value: s.accountant_name || '', placeholder: 'e.g. Maria Shilongo' });
  const acctEmail = h('input', { class: 'input', type: 'email', value: s.accountant_email || '', placeholder: 'accounts@…' });
  const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save settings');
  const go = busy(b, async () => {
    unwrap(await sb.from('settings').update({
      org_name: org.value.trim() || 'Petty cash', currency: currency.value.trim() || 'N$', approval_threshold: num(threshold.value), default_monthly_float: num(floatAmt.value), float_rollover: rollover.checked,
      gm_limit: Math.max(num(gmLimit.value), num(threshold.value)), split_window_days: Math.min(31, Math.max(1, Math.round(num(splitDays.value) || 7))), change_tolerance_pct: Math.min(50, Math.max(0, num(tolerance.value))),
      advance_grace_days: Math.max(1, Math.round(num(grace.value) || 5)), block_with_outstanding: blockOutstanding.checked, claims_need_approval: claimsApprove.checked, budget_mode: budgetMode.value,
      count_day: Number(countDay.value), headcount: Math.max(1, Math.round(num(headcount.value) || 1)), email_from: emailFrom.value.trim() || null, app_url: appUrl.value.trim() || null,
      reserve_buffer_pct: Math.min(100, Math.max(0, Math.round(num(reserveBuf.value)))),
      accountant_name: acctName.value.trim() || null, accountant_email: acctEmail.value.trim() || null,
      updated_at: new Date().toISOString(),
    }).eq('id', 1));
    state.settings = unwrap(await sb.from('settings').select('*').eq('id', 1).single());
    toast('Settings saved.'); refresh();
  });
  const block = (title, ...kids) => h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, title)), ...kids);
  return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
    block('Basics', field('Organisation name', org), field('Currency symbol', currency),
      field('Usual monthly float', floatAmt, 'Pre-filled when finance opens a month.'),
      h('label', { class: 'check', style: { marginBottom: '8px' } }, rollover, 'Carry unspent balance into the next month'),
      h('p', { class: 'hint' }, 'Off: a quiet month shows as a saving and finance receives the full float again. On: the float resets to the usual amount plus whatever was left.')),
    block('Who approves what',
      h('div', { class: 'row' }, field('Finance pays alone up to', threshold, 'Above this the General Manager approves.'), field('General Manager approves up to', gmLimit, 'Above this the Managing Director approves instead.')),
      h('div', { class: 'row' }, field('Count requests together over (days)', splitDays, 'One person’s small requests in this period are added up, so splitting cannot avoid approval.'), field('Pay-out tolerance (%)', tolerance, 'Paying or spending more than approved by more than this needs approval again or a review.')),
      h('p', { class: 'hint' }, 'No one approves, pays out or confirms their own spending. The GM’s own requests go to the MD; finance’s own go to the GM; the MD’s own are paid, then reviewed by the GM.')),
    block('Chasing cash that is out', h('div', { class: 'row' }, field('Days before a reminder', grace, 'Cash paid out with no receipt recorded after this many days gets a daily nudge; finance is told too.')),
      h('label', { class: 'check', style: { marginBottom: '8px' } }, blockOutstanding, 'Hold new pay-outs to someone who still owes a receipt'),
      h('p', { class: 'hint' }, 'Finance sees the outstanding advance on the pay-out screen either way.')),
    block('Money spent before approval', h('label', { class: 'check', style: { marginBottom: '8px' } }, claimsApprove, 'Every claim needs approval, whatever the amount'),
      h('p', { class: 'hint' }, 'A claim is money someone paid out of pocket without a prior request. On: the approver signs off each one before finance pays it back. Off: claims under the threshold go straight to finance, like any other request. Reports show how much of each person’s spend went this way.')),
    block('Budgets and the float', field('When a request goes over its budget', budgetMode, 'Budgets are set on the Budgets tab.'),
      field('Safety buffer on the recommended minimum', reserveBuf, 'Percent added on top of what is usually spent for the rest of the month. The approver is cautioned when an approval would leave the float below that minimum.')),
    block('Counting and reports', h('div', { class: 'row' }, field('Weekly count reminder', countDay, 'The stock manager gets a nudge to do a quick count.'), field('People in the office', headcount, 'Used for cost per head in reports.'))),
    block('Month-end pack', h('div', { class: 'row' }, field('Senior accountant', acctName), field('Their email', acctEmail, 'The reviewed pack is emailed here, with the approver in copy.'))),
    block('Email', h('div', { class: 'row' }, field('Send emails from', emailFrom, 'Must be an address on a domain verified with the email provider; blank uses the test sender.'), field('Link to the app', appUrl, 'Used in emails so people can open the thing that needs them.'))),
    h('div', { class: 'form-actions' }, b));
}
