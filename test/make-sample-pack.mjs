// The sample month-end pack on usepetti.com: the real pack builder on the preview's sample data, with the clock fixed
// (so every sample date falls in one month), the company called "Demo Company", and every page stamped as a sample.
//   cd test && node make-sample-pack.mjs ../site/sample/petti-sample-month-end-pack.pdf
import { JSDOM } from 'jsdom';
const RealDate = Date; const FIX = new RealDate('2026-11-26T09:30:00Z').getTime();
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [FIX])); } static now() { return FIX; } };
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
// the preview's pack is stubbed (no CDN there): build with the real module and the local jsPDF / pdf-lib
const realPath = new URL('../demo/js/pack-sample-real.js', import.meta.url);
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
w.localStorage.setItem('demo_role', 'finance'); w.localStorage.setItem('demo_settings', JSON.stringify({ org_name: 'Demo Company', schedule_ref: 'DEMO-SCH-PC-001', policy_ref: 'DEMO-POL-PC-001', policy_url: '' }));
const api = await import('../demo/js/api.js');
await api.loadSessionContext();
// use the real builder (the demo copy short-circuits), with the demo data client
const { buildMonthEndPack } = await import('../demo/js/pack-sample-real.js');
const { unwrap } = api;
const floats = unwrap(await api.sb.from('v_floats').select('*').eq('status', 'open').order('period', { ascending: false }));
w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {}; w.HTMLAnchorElement.prototype.click = function () {};
const t0 = Date.now();
const r = await buildMonthEndPack(floats.find((f) => f.id === '00000041-0000-4000-8000-000000000000') || floats[0], { onProgress: () => {}, save: false });
unlinkSync(realPath);
const { PDFDocument, StandardFonts, rgb, degrees } = await import('pdf-lib');
const pdf = await PDFDocument.load(r.bytes); const font = await pdf.embedFont(StandardFonts.HelveticaBold);
for (const p of pdf.getPages()) {
  const { width, height } = p.getSize();
  p.drawText('SAMPLE - fictional data (Demo Company)', { x: width / 2 - 190, y: height / 2 - 120, size: 26, font, color: rgb(0.8, 0.2, 0.15), opacity: 0.22, rotate: degrees(35) });
  p.drawText('Sample month-end pack made from Petti\'s demonstration data. Not a real company.', { x: 30, y: 10, size: 7, font, color: rgb(0.8, 0.2, 0.15) });
}
const out = process.argv[2] || 'sample-pack.pdf';
writeFileSync(out, await pdf.save());
console.log('sample pack', out, r.pages, 'pages');
process.exit(0);
