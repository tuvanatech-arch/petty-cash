import { sb, state, loadSessionContext, can, has, role, ROLE_LABEL, personName, flushOfflineQueue, offlineQueueLength } from './api.js';
import { h, mount, toast, fmtDate } from './ui.js';
import { authPage } from './pages/auth.js';
import { homePage } from './pages/home.js';
import { requestsPage, newRequestPage, requestDetailPage } from './pages/requests.js';
import { stockPage } from './pages/stock.js';
import { cashPage } from './pages/cash.js';
import { reportsPage } from './pages/reports.js';
import { adminPage } from './pages/admin.js';
import { accountPage } from './pages/account.js';
import { notificationsPage } from './pages/notifications.js';

const app = document.getElementById('app');

const ROUTES = [
  { path: /^\/?$/, page: () => homePage() },
  { path: /^\/home$/, page: () => homePage() },
  { path: /^\/requests$/, page: () => requestsPage() },
  { path: /^\/requests\/new(?:\/(\w+))?$/, page: (m) => newRequestPage(null, m[1]) },
  { path: /^\/requests\/([0-9a-f-]{36})$/, page: (m) => requestDetailPage(m[1]) },
  { path: /^\/requests\/([0-9a-f-]{36})\/edit$/, page: (m) => newRequestPage(m[1]) },
  { path: /^\/stock(?:\/(\w+))?$/, page: (m) => stockPage(m[1]) },
  { path: /^\/cash$/, page: () => cashPage(), guard: 'finance' },
  { path: /^\/reports$/, page: () => reportsPage(), guard: 'reports' },
  { path: /^\/admin(?:\/(\w+))?$/, page: (m) => adminPage(m[1]), guard: 'admin' },
  { path: /^\/account$/, page: () => accountPage() },
  { path: /^\/notifications$/, page: () => notificationsPage() },
  { path: /^\/more$/, page: async () => h('div', {}, h('div', { class: 'page-head' }, h('h1', {}, 'More')),
    h('div', { class: 'sheet' }, h('ul', { class: 'ledger-list' }, navItems().slice(4).map((it) => h('li', { class: 'click', onclick: () => { location.hash = it.href; } }, h('div', { class: 'what' }, h('strong', {}, it.label))))))) },
];

function navItems() {
  const items = [
    { href: '#/home', label: 'Home', key: 'home' },
    { href: '#/requests', label: 'Requests', key: 'requests' },
    { href: '#/notifications', label: 'Alerts', key: 'notifications', badge: 'unread' },
    { href: '#/stock', label: 'Stock', key: 'stock' },
  ];
  if (can('finance')) items.push({ href: '#/cash', label: 'Petty cash', key: 'cash' });
  if (can('reports')) items.push({ href: '#/reports', label: 'Reports', key: 'reports' });
  if (can('admin')) items.push({ href: '#/admin', label: 'Admin', key: 'admin' });
  items.push({ href: '#/account', label: 'Account', key: 'account' });
  return items;
}

async function actionCounts() {
  // Items waiting on the current user, for the Home badge
  const me = state.me.id;
  const or = [];
  if (has('stock_manager') || has('approver')) or.push('status.eq.stock_review');
  if (has('approver')) or.push('status.eq.pending_approval');
  if (has('finance') || has('approver')) { or.push('status.eq.awaiting_disbursement'); or.push('status.eq.proof_review'); or.push('status.eq.physical_required'); }
  or.push(`and(status.eq.disbursed,disbursed_to.eq.${me})`);
  const { count } = await sb.from('requests').select('id', { count: 'exact', head: true }).or(or.join(','));
  return count || 0;
}

let renderToken = 0;
export async function render() {
  const hash = location.hash.replace(/^#/, '') || '/home';
  const me = state.me;
  if (!me) { mount(app, await authPage()); return; }
  if (!me.active) {
    mount(app, h('div', { class: 'auth' }, h('div', { class: 'card' }, h('h1', {}, 'Account deactivated'),
      h('p', { class: 'lead' }, 'Your account has been deactivated. Ask the administrator if you think this is a mistake.'),
      h('button', { class: 'btn btn-block', onclick: () => sb.auth.signOut() }, 'Sign out'))));
    return;
  }
  const [path] = hash.split('?');
  const route = ROUTES.find((rt) => rt.path.test(path));
  const match = route ? path.match(route.path) : null;
  const page = h('div', { class: 'loading' }, 'Loading…');
  const activeKey = (path.split('/')[1] || 'home');
  const items = navItems();
  const homeBadges = [];
  const navLink = (it) => {
    let badge = null;
    if (it.key === 'home') { badge = h('span', { class: 'count', style: { display: 'none' } }); homeBadges.push(badge); }
    if (it.badge === 'unread') badge = h('span', { class: 'count', 'data-unread': '1', style: { display: state.unread ? '' : 'none' } }, state.unread);
    const active = it.key === activeKey || (it.key === 'more' && items.slice(4).some((x) => x.key === activeKey));
    return h('a', { href: it.href, class: active ? 'active' : '' }, it.label, badge);
  };
  const token = ++renderToken;
  const standIn = state.standingIn.length ? h('div', { class: 'banner banner-purple' }, h('strong', {}, 'You are standing in'),
    state.standingIn.map((d) => `${ROLE_LABEL[d.role].replace(' (admin)', '')} for ${personName(d.from_user)} until ${fmtDate(d.ends_on)}`).join(' · '),
    '. Everything you do is recorded under your own name.') : null;
  const queued = offlineQueueLength();
  const offline = queued ? h('div', { class: 'banner banner-amber' }, h('strong', {}, `${queued} count${queued === 1 ? '' : 's'} saved on this device`), 'They will be sent to the server as soon as there is a connection.') : null;
  mount(app,
    h('div', { class: 'shell' },
      h('aside', { class: 'side' },
        h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, 'N$'),
          h('div', { class: 'brand-name' }, state.settings?.org_name || 'Petty cash', h('small', {}, 'Petty cash & stock'))),
        h('nav', { class: 'nav' }, items.map(navLink)),
        h('div', { class: 'me' }, h('strong', {}, me.full_name || me.email), h('span', {}, ROLE_LABEL[me.role]))),
      h('main', { class: 'main' }, standIn, offline, page)),
    h('nav', { class: 'tabbar' }, items.length <= 5 ? items.map(navLink) : [...items.slice(0, 4).map(navLink), navLink({ href: '#/more', label: 'More', key: 'more' })]));
  window.scrollTo(0, 0);

  actionCounts().then((count) => { for (const b of homeBadges) { b.textContent = count; b.style.display = count ? '' : 'none'; } }).catch(() => {});

  if (!route || (route.guard && !can(route.guard))) {
    page.replaceWith(h('div', {}, h('h1', {}, 'Page not found'), h('p', {}, h('a', { href: '#/home' }, 'Back to home'))));
    return;
  }
  try {
    const el = await route.page(match);
    if (token === renderToken) page.replaceWith(el);
  } catch (err) {
    console.error(err);
    if (token === renderToken) page.replaceWith(h('div', { class: 'banner banner-red' }, h('strong', {}, 'Could not load this page'), err.message));
  }
}

window.addEventListener('hashchange', render);

sb.auth.onAuthStateChange(async (event) => {
  if (event === 'PASSWORD_RECOVERY') {
    await loadSessionContext();
    location.hash = '#/account?recovery=1';
    render();
    return;
  }
  if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED' || event === 'TOKEN_REFRESHED') {
    const before = state.session?.user?.id;
    await loadSessionContext();
    if (event === 'SIGNED_OUT') { location.hash = '#/home'; }
    if (before !== state.session?.user?.id || event === 'SIGNED_OUT' || event === 'SIGNED_IN') render();
  }
});

// counts saved while offline are sent once a connection is back
async function syncQueue() {
  try {
    const n = await flushOfflineQueue();
    if (n) { toast(`${n} saved count${n === 1 ? '' : 's'} sent to the server.`); render(); }
  } catch { /* try again next time */ }
}
window.addEventListener('online', syncQueue);

// installable on a phone; the shell works offline
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}

(async () => {
  try {
    await loadSessionContext();
  } catch (e) {
    console.error(e);
    toast('Could not reach the server. Check your connection and reload.', { error: true, ms: 8000 });
  }
  render();
  syncQueue();
})();
