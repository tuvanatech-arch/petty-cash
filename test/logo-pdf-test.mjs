// The company logo in a real PDF: drawn on every page with the real jsPDF, stored in the file only once.
import { readFileSync } from 'node:fs';
const { jsPDF } = await import(new URL('./node_modules/jspdf/dist/jspdf.node.js', import.meta.url).href);
// drawLogo from the app, without its browser-only imports
const src = readFileSync(new URL('../web/js/brand.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('export function drawLogo'), src.indexOf('/** Shrink a chosen image'));
const drawLogo = new Function(`${body.replace('export function', 'function')}; return drawLogo;`)();
const png = 'data:image/png;base64,' + readFileSync(new URL('./logo-test.png', import.meta.url)).toString('base64');
const logo = { dataUrl: png, w: 200, h: 80 };
const doc = new jsPDF({ unit: 'mm', format: 'a4' });
const heights = [];
for (let p = 0; p < 3; p++) { if (p) doc.addPage(); heights.push(drawLogo(doc, logo, 16, 12, 70, 16)); drawLogo(doc, logo, 194, 285, 26, 6, { alignRight: true }); doc.text('page', 16, 40); }
const out = Buffer.from(doc.output('arraybuffer')).toString('latin1');
const images = (out.match(/\/Subtype \/Image/g) || []).length;
const masks = (out.match(/\/SMask/g) || []).length;
// one picture plus its transparency mask, however many pages it is drawn on
const ok = images === 2 && masks === 1 && heights.every((x) => Math.abs(x - 16) < 0.01) && drawLogo(doc, null, 0, 0, 10, 10) === 0;
console.log(`image objects stored: ${images} (one logo + its transparency mask: ${masks}), heights: ${heights.join(', ')}`);
console.log(ok ? 'LOGO PDF: PASS' : 'LOGO PDF: FAIL');
process.exit(ok ? 0 : 1);
