import { sb, state, adminUsers, accountMail, refreshPeople, unwrap, rpc, ROLE_LABEL, personName, multiBranch, myBranch, branchName } from '../api.js';
import { devicesDialog } from '../devices.js';
import { schedulePage } from './schedule.js';
import { h, mount, money, num, fmtDate, toast, busy, field, select, modal, refresh, confirmDialog, today, isoDate, emptyState } from '../ui.js';

export async function adminPage(tab = 'users') {
  if (tab === 'budgets') tab = 'schedule';   // budgets live in the schedule now
  const tabs = [['users', 'People'], ['branches', 'Branches'], ['signins', 'Sign-ins'], ['standins', 'Stand-ins'], ['schedule', 'Schedule'], ['settings', 'Settings']];
  const bar = h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: k === tab ? 'active' : '', onclick: () => { location.hash = `#/admin/${k}`; } }, l)));
  const body = tab === 'settings' ? settingsTab() : tab === 'standins' ? await standinsTab() : tab === 'signins' ? await signInsTab() : tab === 'branches' ? await branchesTab() : tab === 'schedule' ? await schedulePage({ embedded: true }) : await usersTab();
  const action = { users: ['Add person', () => userDialog(null)], standins: ['Add stand-in', () => standinDialog(null)], branches: ['Add branch', () => branchDialog(null)] }[tab];
  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Admin'), h('p', {}, 'Who can sign in, the branches, who covers for whom, the authority schedule, and the organisation’s details.')),
      action ? h('div', { class: 'page-actions' }, h('button', { class: 'btn btn-primary', onclick: action[1] }, action[0])) : null),
    bar, body);
}

/* =============================================================== branches */
async function branchesTab() {
  const [{ data: companies }, { data: branches }, { data: people }] = await Promise.all([
    sb.from('companies').select('*').order('name'), sb.from('branches').select('*').order('name'), sb.from('profiles').select('id, full_name, role, active, branch_id').eq('active', true)]);
  const { data: floats } = await sb.from('v_floats').select('id, branch_id, period, status, balance').eq('status', 'open');
  const custodians = (b) => (people || []).filter((p) => p.branch_id === b.id && p.role === 'finance').map((p) => p.full_name).join(', ');
  const stock = (b) => (people || []).filter((p) => p.branch_id === b.id && p.role === 'stock_manager').map((p) => p.full_name).join(', ');
  return h('div', {},
    (companies || []).map((c) => h('div', { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('h2', {}, c.name), h('span', { class: 'sub' }, `${c.currency} · ${c.currency_code}${c.is_base ? ' · group reports are shown in this currency' : ''}`)),
      h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Branch'), h('th', {}, 'Code'), h('th', {}, 'Custodian (finance)'), h('th', {}, 'Stock controller'), h('th', { class: 'num' }, 'Usual float'), h('th', {}, 'This month'), h('th'))),
        h('tbody', {}, (branches || []).filter((b) => b.company_id === c.id).map((b) => { const f = (floats || []).find((x) => x.branch_id === b.id);
          return h('tr', { class: b.active ? '' : 'inactive' },
            h('td', {}, h('strong', {}, b.name), !b.active ? h('span', { class: 'pill pill-grey', style: { marginLeft: '6px' } }, 'closed') : null),
            h('td', { class: 'muted' }, b.code),
            h('td', {}, custodians(b) || h('span', { class: 'muted' }, 'nobody yet')),
            h('td', {}, stock(b) || h('span', { class: 'muted' }, '—')),
            h('td', { class: 'num' }, b.usual_float != null ? money(b.usual_float) : h('span', { class: 'muted', title: 'the schedule’s usual float' }, money(state.settings?.default_monthly_float || 0))),
            h('td', {}, f ? `${money(f.balance)} in the box` : h('span', { class: 'muted' }, 'no float open')),
            h('td', { class: 'num' }, h('button', { class: 'btn btn-sm btn-quiet', onclick: () => branchDialog(b, companies) }, 'Edit'))); })))))),
    h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h3', {}, 'How branches work')),
      h('ul', { class: 'plain-list' },
        h('li', {}, 'Each branch keeps its own float, cash counts, top-ups, store and month-end pack. The limits and rules in the authority schedule apply to every branch of the company; only the usual float amount can differ per branch.'),
        h('li', {}, 'Each person has a home branch and can cover others. The General Manager and the Managing Director see every branch; the branch switcher in the menu narrows the screens to one.'),
        h('li', {}, 'A branch needs its own custodian: add a person with the Finance role whose home branch it is. You approve their requests from wherever you are.'),
        h('li', {}, 'A second company (for example the Angolan one) gets its own currency; its figures are converted into the base currency for the group view at a rate recorded each month.'))));
}
function branchDialog(b, companies = null) {
  modal(b ? `Edit ${b.name}` : 'Add a branch', (close) => {
    const cos = companies || [];
    const company = select(cos.map((c) => [c.id, c.name]), b?.company_id || cos[0]?.id);
    const name = h('input', { class: 'input', value: b?.name || '', required: true, placeholder: 'Lüderitz' });
    const code = h('input', { class: 'input', value: b?.code || '', required: true, placeholder: 'LUD', maxlength: 6, style: { textTransform: 'uppercase' } });
    const usual = h('input', { class: 'input num', type: 'number', step: '0.01', min: '0', value: b?.usual_float ?? '', placeholder: String(state.settings?.default_monthly_float || '') });
    const active = h('input', { type: 'checkbox', checked: b ? b.active : true });
    const copyFrom = b ? null : select([['', 'Start with an empty store'], ...state.branches.map((x) => [x.id, `Copy the ${x.name} catalogue (names and reorder levels, no quantities)`])], '');
    const err = h('div', { class: 'error' });
    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, b ? 'Save' : 'Add branch');
    const go = busy(save, async () => {
      err.textContent = '';
      try {
        await rpc('save_branch', { p_id: b?.id || null, p_company: company.value || null, p_name: name.value, p_code: code.value, p_usual_float: usual.value === '' ? null : num(usual.value), p_active: active.checked, p_copy_catalogue_from: copyFrom?.value || null });
        toast(b ? 'Saved.' : `${name.value.trim()} added. Now add its custodian under People.`, { ms: 6000 }); close(); location.reload();
      } catch (e) { err.textContent = e.message; }
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      cos.length > 1 ? field('Company', company) : null,
      field('Name', name), field('Short code', code, 'Printed on vouchers and the pack.'),
      field('Usual monthly float', usual, `Leave empty to use the schedule’s usual float (${money(state.settings?.default_monthly_float || 0)}).`),
      copyFrom ? field('Store', copyFrom) : null,
      b ? field('', h('label', { class: 'check' }, active, ' Open (people can work in it)'), 'A branch can only be closed once its float is closed.') : null,
      err, h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), save));
  });
}

/* =============================================================== sign-ins */
const FLAG = { new_device: ['New device', 'pill-amber'], new_country: ['New country', 'pill-amber'], far_apart: ['Two far-apart places', 'pill-red'] };
let signInFilter = { days: 30, who: '', unusual: false };
async function signInsTab() {
  const from = new Date(Date.now() - signInFilter.days * 864e5).toISOString();
  const rows = (await rpc('sign_in_log', { p_from: from }).catch(() => [])) || [];
  const people = [...new Map(rows.map((r) => [r.user_id, r.person])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const body = h('div', {});
  const draw = () => {
    const shown = rows.filter((r) => (!signInFilter.who || r.user_id === signInFilter.who) && (!signInFilter.unusual || (r.flags || []).length));
    const unusual = rows.filter((r) => (r.flags || []).length).length;
    const places = new Set(rows.map((r) => r.place).filter(Boolean)).size;
    mount(body,
      h('div', { class: 'score', style: { marginBottom: '14px' } },
        h('div', { class: 'box' }, h('span', { class: 'k' }, 'Sign-ins'), h('span', { class: 'v' }, rows.length), h('span', { class: 'd' }, `${new Set(rows.map((r) => r.user_id)).size} people`)),
        h('div', { class: 'box' }, h('span', { class: 'k' }, 'Unusual'), h('span', { class: 'v', style: unusual ? { color: 'var(--amber)' } : {} }, unusual), h('span', { class: 'd' }, 'new device, new country or far apart')),
        h('div', { class: 'box' }, h('span', { class: 'k' }, 'Places'), h('span', { class: 'v' }, places), h('span', { class: 'd' }, 'approximate, from the internet address'))),
      h('div', { class: 'sheet' },
        shown.length ? h('ul', { class: 'ledger-list' }, shown.map((r) => h('li', { class: 'click', onclick: () => devicesDialog(state.people.find((p) => p.id === r.user_id) || { id: r.user_id, full_name: r.person }) },
          h('div', { class: 'what' }, h('strong', {}, `${r.person} · ${r.label || 'A device'}`),
            h('span', {}, `${fmtDate(r.at, { time: true })} · near ${r.place || 'an unknown place'}${r.approx ? ' (rough)' : ''}${r.ip ? ` · ${r.ip}` : ''}`),
            h('span', { style: { display: 'block' } }, r.signed_in ? `Still signed in · last active ${fmtDate(r.last_seen, { time: true })}${r.current_place && r.current_place !== r.place ? ` near ${r.current_place}` : ''}` : 'Signed out')),
          h('div', { class: 'row-actions' }, (r.flags || []).map((f) => h('span', { class: `pill ${(FLAG[f] || [f, 'pill-grey'])[1]}` }, (FLAG[f] || [f])[0])),
            h('span', { class: `pill ${r.signed_in ? 'pill-green' : 'pill-grey'}` }, r.signed_in ? 'Signed in' : 'Signed out')))))
          : emptyState('No sign-ins in this view', 'Change the period or the person above.')),
      h('p', { class: 'hint' }, 'Places come from the internet address, so they are approximate (a mobile network can show a nearby city). Tap a sign-in to see that person’s devices and sign one out. Kept for 12 months.'));
  };
  const who = select([['', 'Everyone'], ...people], signInFilter.who, { onchange: (e) => { signInFilter.who = e.target.value; draw(); } });
  const days = select([[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last 12 months']], signInFilter.days, { onchange: (e) => { signInFilter.days = Number(e.target.value); refresh(); } });
  const unusualBox = h('input', { type: 'checkbox', checked: signInFilter.unusual, onchange: (e) => { signInFilter.unusual = e.target.checked; draw(); } });
  draw();
  return h('div', {}, h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', margin: '4px 0 14px', flexWrap: 'wrap', display: 'flex' } }, days, who, h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, unusualBox, 'Only unusual')), body);
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
    managing_director: 'Approves above the GM limit, the GM’s own requests and changes to the schedule’s limits and float; sees everything; no administration. Their own requests are paid, then reviewed by the GM.',
  };
  return h('div', {},
    h('div', { class: 'sheet' },
      h('div', { class: 'table-wrap' }, h('table', { class: 'ledger' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Role'), multiBranch() ? h('th', {}, 'Branch') : null, h('th', {}, 'Devices'), h('th'))),
        h('tbody', {}, people.map((p) => h('tr', { class: p.active ? '' : 'inactive' },
          h('td', {}, h('strong', {}, p.full_name || '—'), !p.active ? h('span', { class: 'pill pill-grey', style: { marginLeft: '6px' } }, 'inactive') : null, p.id === state.me.id ? h('span', { class: 'muted' }, ' (you)') : null),
          h('td', { class: 'muted' }, p.email), h('td', {}, ROLE_LABEL[p.role]), multiBranch() ? h('td', {}, ['approver', 'managing_director'].includes(p.role) ? h('span', { class: 'muted' }, 'All branches') : [branchName(p.branch_id), (p.extra_branches || []).length ? h('span', { class: 'muted' }, ` + ${(p.extra_branches || []).map(branchName).join(', ')}`) : null]) : null, h('td', {}, devCell(p)),
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
    const branches = state.branches.filter((b) => b.active);
    const home = select(branches.map((b) => [b.id, b.name]), p?.branch_id || myBranch());
    const extra = branches.map((b) => { const cb = h('input', { type: 'checkbox', value: b.id, checked: (p?.extra_branches || []).includes(b.id) }); return { id: b.id, cb, el: h('label', { class: 'check' }, cb, ` ${b.name}`) }; });
    const extraWrap = h('div', { class: 'row', style: { gap: '12px', flexWrap: 'wrap', display: 'flex' } }, extra.map((x) => x.el));
    const syncExtra = () => { for (const x of extra) { x.el.style.display = x.id === home.value || ['approver', 'managing_director'].includes(role.value) ? 'none' : ''; } };
    home.onchange = syncExtra; role.onchange = syncExtra; syncExtra();
    const pass = p ? null : h('input', { class: 'input', type: 'text', value: tempPassword(), autocomplete: 'off' });
    const err = h('div', { class: 'error' });
    const b = h('button', { class: 'btn btn-primary', type: 'submit' }, p ? 'Save' : 'Create account');
    const go = busy(b, async () => {
      err.textContent = '';
      try {
        if (p) {
          await adminUsers({ action: 'update', user_id: p.id, full_name: name.value, role: role.value, email: email.value });
          if (multiBranch()) await rpc('set_person_branches', { p_user: p.id, p_home: home.value, p_extra: extra.filter((x) => x.cb.checked && x.id !== home.value).map((x) => x.id) });
          toast(email.value.trim().toLowerCase() !== (p.email || '').toLowerCase() ? `Saved. ${name.value.trim()} now signs in as ${email.value.trim().toLowerCase()}.` : 'Saved.', { ms: 6000 }); close(); refresh();
        } else {
          const { user_id } = await adminUsers({ action: 'create', email: email.value, full_name: name.value, role: role.value, password: pass.value, branch_id: home.value });
          if (multiBranch()) await rpc('set_person_branches', { p_user: user_id, p_home: home.value, p_extra: extra.filter((x) => x.cb.checked && x.id !== home.value).map((x) => x.id) });
          close(); refresh();
          inviteDialog({ id: user_id, full_name: name.value.trim(), email: email.value.trim().toLowerCase(), role: role.value }, pass.value);
        }
      } catch (e) { err.textContent = e.message; }
    });
    return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
      field('Name', name), field('Email', email, p ? 'They sign in with this. If you change it, tell them – the old address stops working at once.' : 'They sign in with this.'), field('Role', role),
      multiBranch() ? field('Home branch', home, 'Where they work. The General Manager and the Managing Director cover every branch.') : null,
      multiBranch() ? field('Also covers', extraWrap, 'Other branches this person holds the same position in.') : null,
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

/* =============================================================== settings */
function settingsTab() {
  const s = state.settings;
  const org = h('input', { class: 'input', value: s.org_name });
  const currency = h('input', { class: 'input', value: s.currency, maxlength: 6 });
  const headcount = h('input', { class: 'input num', type: 'number', min: 1, step: 1, value: s.headcount ?? 8 });
  const emailFrom = h('input', { class: 'input', value: s.email_from || '', placeholder: 'Petty Cash <petty@yourdomain>' });
  const appUrl = h('input', { class: 'input', type: 'url', value: s.app_url || '', placeholder: 'https://…' });
  const acctName = h('input', { class: 'input', value: s.accountant_name || '', placeholder: 'e.g. Maria Shilongo' });
  const acctEmail = h('input', { class: 'input', type: 'email', value: s.accountant_email || '', placeholder: 'accounts@…' });
  const b = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save settings');
  const go = busy(b, async () => {
    unwrap(await sb.from('settings').update({
      org_name: org.value.trim() || 'Petty cash', currency: currency.value.trim() || 'N$',
      headcount: Math.max(1, Math.round(num(headcount.value) || 1)), email_from: emailFrom.value.trim() || null, app_url: appUrl.value.trim() || null,
      accountant_name: acctName.value.trim() || null, accountant_email: acctEmail.value.trim() || null,
      updated_at: new Date().toISOString(),
    }).eq('id', 1));
    state.settings = unwrap(await sb.from('settings').select('*').eq('id', 1).single());
    toast('Settings saved.'); refresh();
  });
  const block = (title, ...kids) => h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h2', {}, title)), ...kids);
  return h('form', { onsubmit: (e) => { e.preventDefault(); go(); } },
    h('div', { class: 'banner banner-grey' }, 'Limits, the float, reminders and budgets are on the ', h('a', { href: '#/admin/schedule' }, 'Schedule'), ' tab, where every change is a version and the MD approves what needs approving.'),
    block('Organisation', h('div', { class: 'row' }, field('Organisation name', org), field('Currency symbol', currency)),
      field('People in the office', headcount, 'Used for cost per head in reports.')),
    block('Month-end pack', h('div', { class: 'row' }, field('Senior accountant', acctName), field('Their email', acctEmail, 'The reviewed pack is emailed here, with the approver in copy.'))),
    block('Email', h('div', { class: 'row' }, field('Send emails from', emailFrom, 'Must be an address on a domain verified with the email provider; blank uses the test sender.'), field('Link to the app', appUrl, 'Used in emails so people can open the thing that needs them.'))),
    h('div', { class: 'form-actions' }, b));
}
