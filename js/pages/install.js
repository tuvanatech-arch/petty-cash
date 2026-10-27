// Install on the phone. Chrome/Edge/Samsung on Android (and desktop Chrome/Edge) give us a real install prompt;
// Safari on iPhone/iPad needs Share → Add to Home Screen; everything else gets the matching menu steps.
import { h, mount } from '../ui.js';

let deferredPrompt = null;
const listeners = new Set();
const DISMISS_KEY = 'pcs_install_dismissed';

export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; listeners.forEach((fn) => fn()); });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; try { localStorage.setItem(DISMISS_KEY, 'installed'); } catch {} listeners.forEach((fn) => fn()); });
}

export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true || document.referrer.startsWith('android-app://');
}

export function detect() {
  const ua = navigator.userAgent || '';
  const iOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const mobile = iOS || android || /Mobile/.test(ua);
  let browser = 'other';
  if (iOS) browser = /CriOS/.test(ua) ? 'ios-chrome' : /FxiOS/.test(ua) ? 'ios-firefox' : /EdgiOS/.test(ua) ? 'ios-edge' : 'ios-safari';
  else if (/SamsungBrowser/.test(ua)) browser = 'samsung';
  else if (/Edg\//.test(ua)) browser = 'edge';
  else if (/OPR\//.test(ua)) browser = 'opera';
  else if (/Firefox/.test(ua)) browser = 'firefox';
  else if (/Chrome\//.test(ua)) browser = 'chrome';
  else if (/Safari\//.test(ua)) browser = 'mac-safari';
  return { iOS, android, mobile, browser };
}

const share = () => h('span', { class: 'ios-share', title: 'Share' }, '⬆');
const menu = () => h('span', { class: 'kbd' }, '⋮');

function steps({ browser, iOS, android }) {
  switch (browser) {
    case 'ios-safari': return [
      ['Tap the Share button', h('span', {}, 'The ', share(), ' icon at the bottom of Safari (top on iPad).')],
      ['Choose “Add to Home Screen”', 'Scroll the list a little if you do not see it.'],
      ['Tap Add', 'The app appears on your home screen with the N$ icon.'],
    ];
    case 'ios-chrome': case 'ios-firefox': case 'ios-edge': return [
      ['Open this page in Safari', 'On iPhone only Safari can add apps to the home screen. Tap the address bar, copy the link, and open it in Safari.'],
      ['Tap the Share button', h('span', {}, 'The ', share(), ' icon at the bottom of Safari.')],
      ['Choose “Add to Home Screen”, then Add', 'The app appears on your home screen.'],
    ];
    case 'samsung': return [
      ['Tap the menu', h('span', {}, 'The ', h('span', { class: 'kbd' }, '≡'), ' button at the bottom right.')],
      ['Choose “Add page to” → “Home screen”', 'Or tap the install icon in the address bar if it is showing.'],
      ['Tap Add', 'The app appears on your home screen.'],
    ];
    case 'firefox': return android ? [
      ['Tap the menu', h('span', {}, 'The ', menu(), ' button at the top right.')],
      ['Choose “Install” (or “Add to Home screen”)', ''],
      ['Tap Add', 'The app appears on your home screen.'],
    ] : [
      ['Firefox on a computer cannot install web apps', 'Use Chrome or Edge on this computer, or install it on your phone instead.'],
    ];
    case 'opera': return [
      ['Tap the menu', h('span', {}, 'The ', menu(), ' or O button.')],
      ['Choose “Add to home screen” / “Install”', ''],
      ['Tap Add', ''],
    ];
    case 'mac-safari': return [
      ['Open the File menu', 'In Safari on a Mac.'],
      ['Choose “Add to Dock…”', 'The app opens in its own window from the Dock.'],
    ];
    case 'chrome': case 'edge': default: return android || iOS ? [
      ['Tap the menu', h('span', {}, 'The ', menu(), ' button at the top right.')],
      ['Choose “Add to Home screen” or “Install app”', ''],
      ['Tap Install', 'The app appears on your home screen.'],
    ] : [
      ['Look for the install icon in the address bar', 'A small screen-with-arrow icon at the right of the address bar.'],
      ['Click it, then Install', 'The app opens in its own window and appears in your apps.'],
    ];
  }
}

export async function installPage() {
  const d = detect();
  const box = h('div', {});
  function draw() {
    if (isStandalone()) { mount(box, h('div', { class: 'banner banner-green' }, h('strong', {}, 'Installed'), 'You are using the app from your home screen. Nothing more to do.')); return; }
    const btn = deferredPrompt ? h('button', { class: 'btn btn-primary btn-block', style: { marginBottom: '14px' } }, 'Install the app') : null;
    if (btn) btn.onclick = async () => { const p = deferredPrompt; deferredPrompt = null; try { await p.prompt(); const { outcome } = await p.userChoice; if (outcome !== 'accepted') deferredPrompt = p; } catch { deferredPrompt = p; } draw(); };
    const list = steps(d);
    mount(box,
      btn ? [btn, h('p', { class: 'hint', style: { marginBottom: '12px' } }, 'One tap. If the button does nothing, follow the steps below.')] : null,
      h('ol', { class: 'steps' }, list.map(([t, sub]) => h('li', {}, h('strong', {}, t), sub ? h('div', { class: 'hint' }, sub) : null))),
      h('p', { class: 'hint', style: { marginTop: '14px' } }, 'Once installed it opens like any app, works without signal for quick counts, and the N$ icon gives you “Snap or upload” with a long press.'));
  }
  listeners.add(draw); draw();
  return h('div', {}, h('h1', {}, 'Put it on your phone'), h('p', { class: 'lead' }, `${d.iOS ? 'iPhone / iPad' : d.android ? 'Android' : 'Computer'} · ${{ 'ios-safari': 'Safari', 'ios-chrome': 'Chrome', 'ios-firefox': 'Firefox', 'ios-edge': 'Edge', samsung: 'Samsung Internet', edge: 'Edge', opera: 'Opera', firefox: 'Firefox', chrome: 'Chrome', 'mac-safari': 'Safari', other: 'your browser' }[d.browser]}`), box);
}

/** A small banner on phones that are not installed yet; dismissable, shown again after 14 days. */
export function installBanner() {
  const d = detect();
  if (!d.mobile || isStandalone()) return null;
  try { const v = localStorage.getItem(DISMISS_KEY); if (v === 'installed') return null; if (v && Date.now() - Number(v) < 14 * 86400000) return null; } catch {}
  const el = h('div', { class: 'banner banner-green install-banner' },
    h('div', {}, h('strong', {}, 'Put it on your home screen'), d.iOS ? 'Opens like an app; one tap to snap a receipt.' : 'One tap to install; opens like an app.'),
    h('div', { class: 'form-actions', style: { margin: 0 } },
      h('button', { class: 'btn btn-quiet btn-sm', onclick: () => { try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch {} el.remove(); } }, 'Not now'),
      h('a', { class: 'btn btn-primary btn-sm', href: '#/install', onclick: async (e) => { if (deferredPrompt) { e.preventDefault(); const p = deferredPrompt; deferredPrompt = null; try { await p.prompt(); const { outcome } = await p.userChoice; if (outcome === 'accepted') el.remove(); else deferredPrompt = p; } catch { deferredPrompt = p; } } } }, d.iOS ? 'Show me how' : 'Install')));
  return el;
}
