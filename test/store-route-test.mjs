// Which cash-request texts are recognised as store items (and so go to the stock manager), and which are left as cash.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://example.test/' });
for (const k of ['window', 'document', 'location', 'HTMLElement', 'Node', 'localStorage', 'sessionStorage']) { try { globalThis[k] = dom.window[k]; } catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true }); } }
const { storeMatches } = await import('/home/claude/petty-cash-stock/web/js/pages/requests.js');
const items = [
  { id: 1, name: 'A4 paper (ream)' }, { id: 2, name: 'Toner HP 26A' }, { id: 3, name: 'Instant coffee 750 g' }, { id: 4, name: 'Dishwashing liquid 750 ml' },
  { id: 5, name: 'Toilet paper (9 rolls)' }, { id: 6, name: 'Ballpoint pens (box of 50)' }, { id: 7, name: 'Sugar 2.5 kg' }, { id: 8, name: 'Bin bags (roll)' },
];
const cases = [
  ['Printer paper', 'A4 paper (ream)'], ['2 reams of A4 paper', 'A4 paper (ream)'], ['toilet paper for the ladies', 'Toilet paper (9 rolls)'],
  ['Toner for the HP printer', 'Toner HP 26A'], ['coffee', 'Instant coffee 750 g'], ['Coffee for client meeting', null], ['Taxi to the bank', null],
  ['Repair the printer', null], ['pens', 'Ballpoint pens (box of 50)'], ['sugar and coffee', 'Sugar 2.5 kg'], ['Fuel for the generator', null],
  ['Bin bags', 'Bin bags (roll)'], ['Courier documents to Oshakati', null], ['Paint for the office door', null], ['Dishwashing liquid', 'Dishwashing liquid 750 ml'],
  ['Airtime', null], ['Liquid soap for bathrooms', null], ['', null], ['tea', null], ['Black bags', null], ['Dishwashing stuff', 'Dishwashing liquid 750 ml'],
];
let bad = 0;
for (const [t, want] of cases) { const got = storeMatches(t, items)[0]?.name || null; const ok = got === want; if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} "${t}" → ${got}${ok ? '' : ` (wanted ${want})`}`); }
console.log(bad ? `${bad} wrong` : 'all right'); process.exit(bad ? 1 : 0);
