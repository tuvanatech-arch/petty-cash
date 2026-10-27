// Starts signed out: the sign-in form shows, signing in lands on Home, a repeated SIGNED_IN (what supabase sends on every
// return from the background) leaves the page alone, and signing out returns to the form.
process.env.SIGNED_OUT = '1';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/app/#/home', pretendToBeVisual: true });
const w = dom.window;
for (const k of ['window', 'document', 'location', 'HTMLElement', 'Node', 'HashChangeEvent', 'Event', 'Blob', 'getComputedStyle']) { try { globalThis[k] = w[k]; } catch { Object.defineProperty(globalThis, k, { value: w[k], configurable: true }); } }
globalThis.fetch = async () => ({ ok: true, json: async () => ({ needs_bootstrap: false }) });
globalThis.crypto ??= w.crypto;
w.scrollTo = () => {};
const errors = [];
w.addEventListener('error', (e) => errors.push(e.error || e.message));
process.on('unhandledRejection', (e) => errors.push(e));
console.error = (...a) => { errors.push(a.map(String).join(' ')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const text = () => (w.document.querySelector('#app')?.textContent || '').replace(/\s+/g, ' ');

const mock = await import('./mock-supabase.mjs');
await import('../web/js/app.js');
await sleep(120);
check(/Sign in/.test(text()) && !!w.document.querySelector('input[type=password]') && !w.document.querySelector('.tabbar'), 'starts on the sign-in form');

const form = w.document.querySelector('form');
w.document.querySelector('input[type=email]').value = 'admin@example.com';
w.document.querySelector('input[type=password]').value = 'secret12';
form.querySelector('button[type=submit]').click();
await sleep(250);
check(mock.auth.session && !!w.document.querySelector('.tabbar') && !w.document.querySelector('input[type=password]'), 'signing in renders the app');

const marker = w.document.createElement('i'); marker.id = 'marker'; w.document.querySelector('main')?.append(marker);
mock.emitAuth('SIGNED_IN'); await sleep(150);
check(!!w.document.getElementById('marker'), 'a repeated SIGNED_IN (back from background) does not redraw');
mock.emitAuth('TOKEN_REFRESHED'); await sleep(100);
check(!!w.document.getElementById('marker'), 'TOKEN_REFRESHED does not redraw');

await mock.createClient().auth.signOut(); await sleep(200);
check(/Sign in/.test(text()) && !w.document.getElementById('marker'), 'signing out returns to the form');
check(!errors.length, `no errors (${errors.map(String).join(' | ').slice(0, 200)})`);
console.log(fails.length ? `SIGN-IN TEST: FAIL (${fails.length})` : 'SIGN-IN TEST: PASS');
process.exit(fails.length ? 1 : 0);
