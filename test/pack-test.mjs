import { JSDOM } from 'jsdom';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
// the preview's pack is stubbed (no CDN there): build with the real module and the local jsPDF / pdf-lib
const realPath = new URL('../demo/js/pack-real.js', import.meta.url);
writeFileSync(realPath, readFileSync(new URL('../web/js/pack.js', import.meta.url), 'utf8')
  .replace("(await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm')).jsPDF", `(await import('${new URL('./node_modules/jspdf/dist/jspdf.node.js', import.meta.url).href}')).jsPDF`)
  .replace("await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm')", `await import('${new URL('./node_modules/pdf-lib/dist/pdf-lib.esm.js', import.meta.url).href}')`));
const html = readFileSync(new URL('../demo/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/app/#/cash', pretendToBeVisual: true });
const w = dom.window;
for (const k of ['window', 'document', 'location', 'HTMLElement', 'Node', 'HashChangeEvent', 'Event', 'Blob', 'getComputedStyle', 'MutationObserver', 'localStorage', 'navigator']) { try { globalThis[k] = w[k]; } catch { Object.defineProperty(globalThis, k, { value: w[k], configurable: true }); } }
const invoice = readFileSync('./invoice-test.pdf');
globalThis.fetch = async (url) => ({ ok: true, json: async () => ({}), blob: async () => ({ arrayBuffer: async () => invoice.buffer.slice(invoice.byteOffset, invoice.byteOffset + invoice.byteLength) }) });
w.scrollTo = () => {};
w.localStorage.setItem('demo_role', 'finance');
const api = await import('../demo/js/api.js');
await api.loadSessionContext();
// use the real builder (the demo copy short-circuits), with the demo data client
const { buildMonthEndPack } = await import('../demo/js/pack-real.js');
const { unwrap } = api;
const floats = unwrap(await api.sb.from('v_floats').select('*').eq('status', 'open').order('period', { ascending: false }));
w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {}; w.HTMLAnchorElement.prototype.click = function () {};
const t0 = Date.now();
const r = await buildMonthEndPack(floats[0], { onProgress: () => {}, save: false });
unlinkSync(realPath);
writeFileSync('pack-out.pdf', r.bytes);
console.log('built', r.name, r.pages, 'pages', r.bytes.byteLength, 'bytes in', Date.now() - t0, 'ms');
console.log(r.pages > 3 && r.bytes.byteLength > 20000 ? 'PACK PDF: PASS' : 'PACK PDF: FAIL');
process.exit(0);
