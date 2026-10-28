// Devices: the list on Account (this device marked, the others can be signed out with a second tap), "sign out all
// others" keeps this device, the Account "Sign out" button only signs out this device, a device signed out elsewhere
// lands on the sign-in form with the reason, and the admin can sign another person out everywhere from People.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/app/#/account', pretendToBeVisual: true });
const w = dom.window;
for (const k of ['window', 'document', 'location', 'HTMLElement', 'Node', 'HashChangeEvent', 'Event', 'CustomEvent', 'Blob', 'getComputedStyle', 'localStorage', 'sessionStorage']) { try { globalThis[k] = w[k]; } catch { Object.defineProperty(globalThis, k, { value: w[k], configurable: true }); } }
let fnReply = { status: 200, body: { ok: true } };
const fnCalls = [];
globalThis.fetch = async (url, init) => { fnCalls.push([String(url), init]); if (/\/devices$/.test(String(url))) return { ok: fnReply.status < 300, status: fnReply.status, json: async () => fnReply.body }; return { ok: true, status: 200, json: async () => ({ needs_bootstrap: false }) }; };
globalThis.crypto ??= w.crypto;
w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
const errors = [];
w.addEventListener('error', (e) => errors.push(e.error || e.message));
process.on('unhandledRejection', (e) => errors.push(e));
console.error = (...a) => { errors.push(a.map(String).join(' ')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const $ = (s) => w.document.querySelector(s);
const $$ = (s) => [...w.document.querySelectorAll(s)];
const text = (el = $('#app')) => (el?.textContent || '').replace(/\s+/g, ' ');
const byText = (sel, re) => $$(sel).find((b) => re.test(b.textContent));

const mock = await import('./mock-supabase.mjs');
await import('../web/js/app.js');
await sleep(400);

// boot checked this device in, with a readable device name
const ci = fnCalls.find(([u]) => /\/devices$/.test(u));
check(!!ci && /Bearer h\./.test(ci[1].headers.Authorization) && JSON.parse(ci[1].body).label, `the app checks in on open (${ci ? JSON.parse(ci[1].body).label : 'no call'})`);

// the list
const sheet = $('#devices');
check(!!sheet && /Devices/.test(text(sheet)) && /2 signed in/.test(text(sheet)), 'Account shows a Devices sheet with the count');
const items = $$('#devices .ledger-list li');
check(items.length === 2 && /This device/.test(text(items[0])) && !items[0].querySelector('button'), 'this device is marked and has no sign-out button');
check(/Windows PC · Chrome/.test(text(items[1])) && /place not reported yet/.test(text(items[1])), `a device that never reported is named from its browser (${text(items[1]).slice(0, 80)})`);
check(/Windhoek, Namibia/.test(text(items[0])) && /active now/.test(text(items[0])) && /alerts on/.test(text(items[0])), 'place, activity and alerts are shown');

// sign out one: first tap arms, second acts
const one = items[1].querySelector('button');
one.click(); await sleep(30);
check(/Tap again/.test(one.textContent) && !mock.rpcArgs.some(([f]) => f === 'sign_out_devices'), 'first tap only asks to confirm');
one.click(); await sleep(150);
const a1 = mock.rpcArgs.filter(([f]) => f === 'sign_out_devices').pop();
check(a1 && JSON.stringify(a1[1]) === JSON.stringify({ p_sessions: ['5e550002-0000-4000-8000-000000000000'] }), `second tap signs out exactly that device (${JSON.stringify(a1?.[1])})`);

// sign out all others keeps this one
await sleep(150);
const others = byText('#devices button', /other device/);
others.click(); await sleep(30); others.click(); await sleep(150);
const a2 = mock.rpcArgs.filter(([f]) => f === 'sign_out_devices').pop();
check(a2 && a2[1].p_keep === mock.SID && !a2[1].p_sessions, `"sign out the others" keeps this device (${JSON.stringify(a2?.[1])})`);
check(!!$('#devices details') && /New sign-in: Windows PC/.test(text($('#devices details'))), 'recent sign-in activity is listed');

// the Account "Sign out" button: this device only, and no "signed out elsewhere" note
byText('.page-actions button', /Sign out/).click(); await sleep(300);
check(mock.auth.lastSignOut?.scope === 'local', `Sign out only signs out this device (scope ${mock.auth.lastSignOut?.scope})`);
check(/Sign in/.test(text()) && !/You were signed out on this device/.test(text()), 'after your own sign-out: plain sign-in form');

// sign in again, then this device is signed out from elsewhere
w.document.querySelector('input[type=email]').value = 'admin@example.com';
w.document.querySelector('input[type=password]').value = 'secret12';
$('form').querySelector('button[type=submit]').click(); await sleep(300);
check(!!$('.tabbar'), 'signed in again');
fnReply = { status: 401, body: { error: 'Sign in first', revoked: true } };
const api = await import('../web/js/api.js');
await api.checkIn(true); await sleep(300);
check(mock.auth.lastSignOut?.scope === 'local' && /Sign in/.test(text()) && /You were signed out on this device/.test(text()), 'signed out elsewhere → sign-in form says why');
fnReply = { status: 200, body: { ok: true } };

// admin: People shows device counts; another person's devices can be signed out everywhere
w.document.querySelector('input[type=email]').value = 'admin@example.com';
w.document.querySelector('input[type=password]').value = 'secret12';
$('form').querySelector('button[type=submit]').click(); await sleep(300);
w.location.hash = '#/admin/users'; await sleep(400);
const cnt = $$('button.dev-count'); if (!cnt.length) console.log('PAGE:', w.location.hash, text().slice(0, 400));
check(cnt.length === 2 && /2 devices/.test(cnt[0].textContent) && /1 device/.test(cnt[1].textContent), `People shows how many devices each person has (${cnt.map((b) => b.textContent).join(', ')})`);
cnt[1].click(); await sleep(250);
check(/Fin Person's devices/.test(text($('.modal'))), 'a person’s devices open in a dialog');
const every = byText('.modal button', /out everywhere/);
every.click(); await sleep(30); every.click(); await sleep(200);
const a3 = mock.rpcArgs.filter(([f]) => f === 'sign_out_devices').pop();
check(a3 && a3[1].p_user === '22222222-2222-4222-8222-222222222222' && !a3[1].p_keep, `admin signs that person out everywhere (${JSON.stringify(a3?.[1])})`);

// an alert link opens the person's devices straight away
$('#modal-root').textContent = '';
w.location.hash = '#/admin/users?devices=22222222-2222-4222-8222-222222222222'; await sleep(450);
check(/Fin Person's devices/.test(text($('.modal'))), 'an alert link opens that person’s devices');

check(!errors.length, `no errors (${errors.map(String).join(' | ').slice(0, 300)})`);
console.log(fails.length ? `DEVICES TEST: FAIL (${fails.length})` : 'DEVICES TEST: PASS');
process.exit(fails.length ? 1 : 0);
