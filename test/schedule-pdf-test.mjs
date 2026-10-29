// Draws a schedule version to a PDF with the real jsPDF (the preview copy is stubbed) and checks its text.
import { JSDOM } from 'jsdom';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
// the preview's copy is stubbed (no CDN there): draw with the real module and the local jsPDF
const realPath = new URL('../demo/js/schedule-pdf-real.js', import.meta.url);
writeFileSync(realPath, readFileSync(new URL('../web/js/schedule-pdf.js', import.meta.url), 'utf8')
  .replace("(await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm')).jsPDF", `(await import('${new URL('./node_modules/jspdf/dist/jspdf.node.js', import.meta.url).href}')).jsPDF`));
const html = readFileSync(new URL('../demo/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/app/#/schedule', pretendToBeVisual: true });
const w = dom.window;
for (const k of ['window', 'document', 'location', 'HTMLElement', 'Node', 'HashChangeEvent', 'Event', 'Blob', 'getComputedStyle', 'MutationObserver', 'localStorage', 'navigator']) { try { globalThis[k] = w[k]; } catch { Object.defineProperty(globalThis, k, { value: w[k], configurable: true }); } }
w.scrollTo = () => {};
w.localStorage.setItem('demo_role', 'approver');
const api = await import('../demo/js/api.js');
await api.loadSessionContext();
const { drawSchedule } = await import('../demo/js/schedule-pdf-real.js');
const { jsPDF } = await import('./node_modules/jspdf/dist/jspdf.node.js');
const versions = api.unwrap(await api.sb.from('schedule_versions').select('*'));
const v = versions.find((x) => x.version_no === 3);
const doc = new jsPDF({ unit: 'mm', format: 'a4' });
drawSchedule(doc, v, { monthChanges: versions.filter((x) => x.status === 'applied') });
const bytes = doc.output('arraybuffer');
unlinkSync(realPath);
writeFileSync(process.env.OUT || 'schedule-out.pdf', Buffer.from(bytes));
const ok = doc.getNumberOfPages() >= 1 && bytes.byteLength > 5000;
console.log('pages', doc.getNumberOfPages(), 'bytes', bytes.byteLength);
console.log(ok ? 'SCHEDULE PDF: PASS' : 'SCHEDULE PDF: FAIL');
process.exit(0);
