import { JSDOM } from 'jsdom';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
// "Download everything" before cancelling: the real export module on the preview's sample data, with the local zip library
const realPath = new URL('../demo/js/export-real.js', import.meta.url);
writeFileSync(realPath, readFileSync(new URL('../web/js/export.js', import.meta.url), 'utf8')
  .replace("(await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm')).default", 'globalThis.__JSZip'));
const html = readFileSync(new URL('../demo/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/app/#/cash', pretendToBeVisual: true });
const w = dom.window;
for (const k of ['window', 'document', 'location', 'HTMLElement', 'Node', 'HashChangeEvent', 'Event', 'Blob', 'getComputedStyle', 'MutationObserver', 'localStorage', 'navigator']) { try { globalThis[k] = w[k]; } catch { Object.defineProperty(globalThis, k, { value: w[k], configurable: true }); } }
const invoice = readFileSync('./invoice-test.pdf');
globalThis.fetch = async (url) => ({ ok: true, json: async () => ({}), blob: async () => ({ arrayBuffer: async () => invoice.buffer.slice(invoice.byteOffset, invoice.byteOffset + invoice.byteLength) }) });
w.scrollTo = () => {};
w.localStorage.setItem('demo_role', 'approver');
const api = await import('../demo/js/api.js');
await api.loadSessionContext();

const { unwrap } = api;
const floats = unwrap(await api.sb.from('v_floats').select('*').eq('status', 'open').order('period', { ascending: false }));
w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {}; w.HTMLAnchorElement.prototype.click = function () {};
const { createRequire } = await import('node:module'); globalThis.__JSZip = createRequire(import.meta.url)('jszip');
let saved = null;
globalThis.Blob = (await import('node:buffer')).Blob; URL.createObjectURL = (blob) => { saved = blob; return 'blob:x'; }; URL.revokeObjectURL = () => {}; w.URL.createObjectURL = URL.createObjectURL; w.HTMLAnchorElement.prototype.click = function () { saved.name = this.download; };
const { exportEverything } = await import('../demo/js/export-real.js');
const steps = [];
const r = await exportEverything((t) => steps.push(t));
unlinkSync(realPath);
const zip = await globalThis.__JSZip.loadAsync(Buffer.from(await saved.arrayBuffer()));
const names = Object.keys(zip.files);
const months = [...new Set(names.filter((n) => /^petty-cash-\d{4}-\d{2}/.test(n)).map((n) => n.split('/')[0]))];
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
check(/^petti-.*-everything-\d{4}-\d{2}-\d{2}\.zip$/.test(saved.name), `one file, named for the company and the day: ${saved.name}`);
check(r.months === months.length && months.length >= 3, `a folder for every month of every branch: ${months.length} (${months.join(', ')})`);
check(months.every((m) => names.includes(`${m}/vouchers.csv`) && names.includes(`${m}/cash-ledger.csv`) && names.includes(`${m}/cash-counts.csv`)), 'each month has its vouchers, ledger and cash counts');
check(names.includes('people.csv') && names.includes('stock-catalogue.csv') && names.includes('README.txt'), 'plus the people, the stock catalogue and a README');
const people = await zip.file('people.csv').async('string');
check(/Fiona Shikongo/.test(people) && /Maria dos Santos/.test(people), 'people includes those switched off');
check(steps.some((t) => /of \d+:/.test(t)) && steps.at(-1) === '', 'progress is reported month by month, then cleared');
console.log(fails.length ? `EXPORT ALL: FAIL (${fails.length})` : 'EXPORT ALL: PASS');
process.exit(fails.length ? 1 : 0);
