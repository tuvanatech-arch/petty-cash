import { sb, state, loadSessionContext, refreshUnread, can, has, role, ROLE_LABEL, personName, flushOfflineQueue, offlineQueueLength, checkIn, signOutHere, whenSignedOutElsewhere } from './api.js';
import { h, mount, toast, fmtDate } from './ui.js';
import { authPage } from './pages/auth.js';
import { homePage } from './pages/home.js';
import { requestsPage, newRequestPage, requestDetailPage } from './pages/requests.js';
import { stockPage } from './pages/stock.js';
import { cashPage, packPage } from './pages/cash.js';
import { reportsPage } from './pages/reports.js';
import { adminPage } from './pages/admin.js';
import { schedulePage } from './pages/schedule.js';
import { accountPage } from './pages/account.js';
import { notificationsPage } from './pages/notifications.js';
import { snapPage } from './pages/snap.js';
import { installPage, installBanner, captureInstallPrompt } from './pages/install.js';
import { startAdapting } from './adapt.js';
import { startDiagnostics, bootFinished, startPullToRefresh, log, BUILD } from './diag.js';
import { howPage } from './learn.js';

startDiagnostics();

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
  { path: /^\/cash\/pack\/([0-9a-f-]{36})$/, page: (m) => packPage(m[1]), guard: 'finance' },
  { path: /^\/reports$/, page: () => reportsPage(), guard: 'reports' },
  { path: /^\/admin(?:\/(\w+))?$/, page: (m) => adminPage(m[1]), guard: 'admin' },
  { path: /^\/schedule$/, page: () => (can('admin') ? adminPage('schedule') : schedulePage()), guard: 'schedule' },
  { path: /^\/account$/, page: () => accountPage() },
  { path: /^\/notifications$/, page: () => notificationsPage() },
  { path: /^\/snap$/, page: () => snapPage() },
  { path: /^\/install$/, page: () => installPage() },
  { path: /^\/how$/, page: () => howPage() },
  { path: /^\/more$/, page: async () => h('div', {}, h('div', { class: 'page-head' }, h('h1', {}, 'More')),
    h('div', { class: 'sheet' }, h('ul', { class: 'ledger-list' }, navItems().slice(4).map((it) => h('li', { class: 'click', onclick: () => { location.hash = it.href; } }, h('div', { class: 'what' }, h('strong', {}, it.label)))),
      h('li', { class: 'click', onclick: () => { location.hash = '#/how'; } }, h('div', { class: 'what' }, h('strong', {}, 'How it works'), h('span', {}, 'One screen per role, and “show tips again”'))),
      h('li', { class: 'click', onclick: () => { location.reload(); } }, h('div', { class: 'what' }, h('strong', {}, 'Reload the app'), h('span', {}, `Build ${BUILD} · or pull down on any page`)))))) },
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
  else if (has('managing_director') || role() === 'finance') items.push({ href: '#/schedule', label: 'Schedule', key: 'schedule' });
  items.push({ href: '#/account', label: 'Account', key: 'account' });
  return items;
}

/** Phone tab bar: the four things this role does most, in that order; the rest under More. Alerts live in the top bell. */
function tabItems() {
  const all = Object.fromEntries(navItems().map((i) => [i.key, i]));
  const snap = { href: '#/snap', label: 'Snap', key: 'snap' };
  const order = { approver: ['home', 'requests', 'reports', 'cash'], managing_director: ['home', 'requests', 'reports', 'cash'], finance: ['home', 'requests', 'cash', 'stock'], stock_manager: ['home', 'stock', 'requests', 'snap'], requester: ['home', 'snap', 'requests', 'stock'] }[role()] || ['home', 'requests', 'stock', 'snap'];
  const main = order.map((k) => (k === 'snap' ? snap : all[k])).filter(Boolean);
  const rest = navItems().filter((i) => i.key !== 'notifications' && !main.some((m) => m.key === i.key));
  return { main, rest };
}

async function actionCounts() {
  // Items waiting on the current user, for the Home badge
  const me = state.me.id;
  const or = [];
  // same rule as Home: only the queues that are this person's duty (own role or standing in)
  const duty = (r) => role() === r || state.standingIn.some((d) => d.role === r);
  if (duty('stock_manager')) or.push('status.eq.stock_review');
  if (duty('approver')) { or.push('and(status.eq.pending_approval,or(approval_level.is.null,approval_level.eq.gm))'); or.push('and(reviewed_at.is.null,review_role.eq.approver)'); }
  if (duty('managing_director')) { or.push('and(status.eq.pending_approval,approval_level.eq.md)'); or.push('and(reviewed_at.is.null,review_role.eq.managing_director)'); }
  if (duty('finance')) { or.push('status.eq.awaiting_disbursement'); or.push('status.eq.proof_review'); or.push('status.eq.physical_required'); }
  or.push(`and(status.eq.disbursed,disbursed_to.eq.${me})`);
  const [{ count }, sched] = await Promise.all([
    sb.from('requests').select('id', { count: 'exact', head: true }).or(or.join(',')),
    // a schedule change waiting for the MD counts as one of the MD's things to do
    duty('managing_director') ? sb.from('schedule_versions').select('id', { count: 'exact', head: true }).eq('status', 'pending').neq('proposed_by', me) : { count: 0 },
  ]);
  return (count || 0) + (sched.count || 0);
}

let renderToken = 0;
export async function render() {
  const hash = location.hash.replace(/^#/, '') || '/home';
  const me = state.me;
  if (hash.split('?')[0] === '/verify') { mount(app, h('div', { class: 'auth' }, h('div', { class: 'card' }, await verifyPage()))); return; }
  if (hash.split('?')[0] === '/install') { mount(app, h('div', { class: 'auth' }, h('div', { class: 'card', style: { maxWidth: '560px' } }, await installPage(), me ? null : h('p', { class: 'links', style: { marginTop: '14px' } }, h('a', { href: '#/home' }, 'Back to sign in'))))); return; }
  if (!me) { mount(app, await authPage()); return; }
  if (!me.active) {
    mount(app, h('div', { class: 'auth' }, h('div', { class: 'card' }, h('h1', {}, 'Account deactivated'),
      h('p', { class: 'lead' }, 'Your account has been deactivated. Ask the administrator if you think this is a mistake.'),
      h('button', { class: 'btn btn-block', onclick: () => signOutHere() }, 'Sign out'))));
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
    const active = it.key === activeKey || (it.key === 'more' && tabItems().rest.some((x) => x.key === activeKey));
    return h('a', { href: it.href, class: active ? 'active' : '' }, it.label, badge);
  };
  const token = ++renderToken;
  // at most one banner, most important first: unsent counts, then standing in, then install
  const queued = offlineQueueLength();
  const banner = queued ? h('div', { class: 'banner banner-amber' }, h('strong', {}, `${queued} count${queued === 1 ? '' : 's'} saved on this device`), 'Sent as soon as there is a connection.')
    : state.standingIn.length ? h('div', { class: 'banner banner-purple' }, h('strong', {}, `Standing in as ${state.standingIn.map((d) => `${ROLE_LABEL[d.role].replace(' (admin)', '').toLowerCase()} for ${personName(d.from_user)}`).join(' and ')} until ${fmtDate(state.standingIn[0].ends_on)}`), 'Their queue is on your Home; what you do is recorded under your name. Day-to-day only: the catalogue and settings stay with them.')
    : installBanner();
  const tabs = tabItems();
  const bell = h('a', { href: '#/notifications', class: `bell${activeKey === 'notifications' ? ' active' : ''}`, 'aria-label': 'Alerts' }, '🔔', h('span', { class: 'count', 'data-unread': '1', style: { display: state.unread ? '' : 'none' } }, state.unread));
  const topbar = h('div', { class: 'topbar' }, h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, 'N$'), h('div', { class: 'brand-name' }, state.settings?.org_name || 'Petty cash')), bell);
  mount(app,
    h('a', { class: 'skip', href: '#', onclick: (e) => { e.preventDefault(); const first = document.querySelector('main .sheet [tabindex="0"], main .sheet button, main .sheet a[href]'); (first || document.querySelector('main h1'))?.focus(); } }, 'Skip to what needs me'),
    h('div', { class: 'shell' },
      h('aside', { class: 'side' },
        h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, 'N$'),
          h('div', { class: 'brand-name' }, state.settings?.org_name || 'Petty cash', h('small', {}, 'Petty cash & stock'))),
        h('nav', { class: 'nav' }, items.map(navLink)),
        h('div', { class: 'me' }, h('strong', {}, me.full_name || me.email), h('span', {}, ROLE_LABEL[me.role]))),
      h('main', { class: 'main' }, topbar, banner, page)),
    h('nav', { class: 'tabbar' }, tabs.main.map(navLink), tabs.rest.length ? navLink({ href: '#/more', label: 'More', key: 'more' }) : null));
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
    log('error', `Page ${path} failed: ${err.message}`, err.stack);
    if (token === renderToken) page.replaceWith(h('div', { class: 'banner banner-red' }, h('strong', {}, 'Could not load this page'), err.message));
  }
}

/** A link from an invitation, a reset or a sign-in email: the app finishes the sign-in itself with the one-time token. */
async function verifyPage() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const th = params.get('th'); const type = params.get('type') === 'magiclink' ? 'magiclink' : 'recovery';
  if (!th) return h('div', {}, h('h1', {}, 'That link is incomplete'), h('p', { class: 'lead' }, 'Open the full link from the message, or ask your administrator for a new one.'), h('p', { class: 'links' }, h('a', { href: '#/home' }, 'Go to sign in')));
  const { error } = await sb.auth.verifyOtp({ token_hash: th, type });
  if (error) {
    log('warn', `Link verification failed: ${error.message}`);
    return h('div', {}, h('h1', {}, 'This link no longer works'), h('p', { class: 'lead' }, /expired|invalid/i.test(error.message) ? 'Links work once and expire after a while. Ask your administrator for a new one – or, if you already set a password, just sign in.' : error.message), h('p', { class: 'links' }, h('a', { href: '#/home' }, 'Go to sign in')));
  }
  await loadSessionContext();
  history.replaceState(null, '', location.pathname + (type === 'recovery' ? '#/account?recovery=1' : '#/home'));
  render();
  return h('div', { class: 'loading' }, 'Signing you in…');
}

window.addEventListener('hashchange', render);
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'push' && state.me) refreshUnread().catch(() => {}); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.me) { refreshUnread().catch(() => {}); checkIn().catch(() => {}); } });

// signed out from another device (or by the administrator): sign out here too and say why on the sign-in screen
let signingOutElsewhere = false;
whenSignedOutElsewhere(async () => {
  if (signingOutElsewhere) return;
  signingOutElsewhere = true;
  try { sessionStorage.setItem('pcs_out', 'elsewhere'); } catch {}
  log('info', 'Signed out from another device');
  try { await sb.auth.signOut({ scope: 'local' }); } catch { /* already gone on the server */ }
  setTimeout(() => { signingOutElsewhere = false; }, 5000);
});

// Auth events. The callback fires while the auth client is busy, so the work is deferred and never waits on the client itself.
// Note: supabase emits SIGNED_IN again every time the app comes back from the background – that is not a new sign-in,
// and the page is left exactly as it was (a half-written request survives a phone call).
let booting = true;
sb.auth.onAuthStateChange((event, session) => {
  setTimeout(async () => {
    try {
      if (event === 'SIGNED_IN' && /access_token=|type=magiclink|type=recovery/.test(location.hash)) history.replaceState(null, '', location.pathname + '#/home');
      if (event === 'PASSWORD_RECOVERY') {
        await loadSessionContext();
        location.hash = '#/account?recovery=1';
        render();
        return;
      }
      if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') { state.session = session; return; }
      if (event === 'SIGNED_IN' && session?.user?.id && session.user.id === state.me?.id) { state.session = session; refreshUnread().catch(() => {}); return; }
      if (booting && event !== 'SIGNED_OUT') return; // the boot below loads everything once
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
        // a sign-out nobody pressed here: the sign-in was ended from another device, by the administrator, or expired
        if (event === 'SIGNED_OUT' && state.me) { try { if (!sessionStorage.getItem('pcs_out')) sessionStorage.setItem('pcs_out', 'elsewhere'); } catch {} }
        await loadSessionContext();
        if (event === 'SIGNED_OUT') location.hash = '#/home';
        render();
      }
    } catch (e) { log('error', `Auth event ${event} failed: ${e.message}`, e.stack); }
  }, 0);
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
startAdapting();
captureInstallPrompt();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}

(async () => {
  // never sit on "Loading…": if the account check has not answered in 8 s, show the app anyway and keep trying
  const watchdog = new Promise((r) => setTimeout(() => r('timeout'), 8000));
  try {
    const result = await Promise.race([loadSessionContext().then(() => 'ok'), watchdog]);
    if (result === 'timeout') {
      log('warn', 'Boot: session context not loaded after 8 s');
      toast('Taking longer than usual to connect…', { ms: 6000 });
      loadSessionContext().then(() => render()).catch((e) => log('error', `Boot retry failed: ${e.message}`, e.stack));
    }
  } catch (e) {
    console.error(e);
    log('error', `Boot failed: ${e.message}`, e.stack);
    toast('Could not reach the server. Check your connection and pull down to refresh.', { error: true, ms: 8000 });
  }
  render();
  booting = false;
  bootFinished();
  syncQueue();
  startPullToRefresh(() => location.reload());
})();
