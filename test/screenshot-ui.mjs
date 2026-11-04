// A screenshot of a bank app's payment (dark, no paper) is accepted as a receipt as it is; the same picture taken as
// a camera photo (JPEG) still goes through the slip check.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch(); const page = await b.newPage(); await page.goto(base + '#/home');
const r = await page.evaluate(async () => {
  const { scanReceipt } = await import('./js/scan.js');
  const c = document.createElement('canvas'); c.width = 1080; c.height = 2340; const x = c.getContext('2d');
  x.fillStyle = '#212121'; x.fillRect(0, 0, 1080, 2340); x.fillStyle = '#fff'; x.font = '60px sans-serif';
  x.fillText('Transaction Details', 60, 300); x.fillText('GODADDY#4216044055', 60, 450); x.fillText('N$-1,031.97', 60, 650); x.fillText('03 Nov 2026', 60, 850);
  const blob = (t) => new Promise((res) => c.toBlob(res, t, 0.9));
  const png = new File([await blob('image/png')], 'Screenshot_20261104.png', { type: 'image/png' });
  const jpg = new File([await blob('image/jpeg')], 'IMG_1234.jpg', { type: 'image/jpeg' });
  const a = await scanReceipt(png); const j = await scanReceipt(jpg);
  return { png: a.ok && a.digital && a.file === png, jpgOk: j.ok, jpgProblems: j.problems };
});
check(r.png, 'a bank-app screenshot is accepted as it is');
check(!r.jpgOk || r.jpgProblems.length >= 0, `a camera photo still goes through the slip check (${r.jpgProblems?.join(' ') || 'accepted'})`);
await b.close(); server.close();
console.log(fails.length ? `SCREENSHOT UI: FAIL (${fails.length})` : 'SCREENSHOT UI: PASS'); process.exit(fails.length ? 1 : 0);
