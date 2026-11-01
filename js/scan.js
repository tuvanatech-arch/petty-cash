// The receipt scanner: any phone camera picture of a paper slip becomes a clean, straight, cropped, high-contrast
// "scan", and pictures that cannot make a readable scan are refused with the reason. PDFs (e-receipts, invoices)
// are digital originals and pass through untouched.
//
//   const { file, ok, problems } = await scanReceipt(file)
//
// Checks: the slip can be found, the whole slip is in the picture, it is sharp enough, bright enough, and big enough.
// After upload, Petti's receipt reading is the final test: no total or no date = not readable = refused.

const MAX_OUT = 2000;        // longest side of the scan
const ANALYSE = 720;         // working size for finding the slip

const loadImage = (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file); const img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That picture could not be opened. Try again, or upload a PDF.')); };
  img.src = url;
});
const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

function grey(data, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i += 1, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  return g;
}
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) { let s = 0; const row = y * w; for (let x = -r; x <= r; x += 1) s += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x += 1) { tmp[row + x] = s / (2 * r + 1); s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]; } }
  for (let x = 0; x < w; x += 1) { let s = 0; for (let y = -r; y <= r; y += 1) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y += 1) { out[y * w + x] = s / (2 * r + 1); s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; } }
  return out;
}
function otsu(g) {
  const hist = new Array(256).fill(0); for (const v of g) hist[Math.max(0, Math.min(255, v | 0))] += 1;
  const total = g.length; let sum = 0; for (let i = 0; i < 256; i += 1) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t += 1) { wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break; sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2; if (between > best) { best = between; thr = t; } }
  return thr;
}
/** The biggest bright region (the paper): its pixels' extreme corners and how it sits in the frame. */
function findPaper(g, w, h) {
  const thr = otsu(g); const seen = new Uint8Array(w * h); let best = null;
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start += 1) {
    if (seen[start] || g[start] <= thr) continue;
    let top = 0; stack[top++] = start; seen[start] = 1;
    let n = 0, tl = [0, 0, Infinity], tr = [0, 0, -Infinity], br = [0, 0, -Infinity], bl = [0, 0, Infinity], touch = [0, 0, 0, 0];
    while (top) {
      const p = stack[--top]; const x = p % w, y = (p / w) | 0; n += 1;
      if (x + y < tl[2]) tl = [x, y, x + y]; if (x + y > br[2]) br = [x, y, x + y];
      if (x - y > tr[2]) tr = [x, y, x - y]; if (x - y < bl[2]) bl = [x, y, x - y];
      if (y === 0) touch[0] += 1; if (x === w - 1) touch[1] += 1; if (y === h - 1) touch[2] += 1; if (x === 0) touch[3] += 1;
      const nb = [p - 1, p + 1, p - w, p + w];
      for (let k = 0; k < 4; k += 1) { const q = nb[k]; if (q < 0 || q >= w * h) continue; if ((k === 0 && x === 0) || (k === 1 && x === w - 1)) continue;
        if (!seen[q] && g[q] > thr) { seen[q] = 1; stack[top++] = q; } }
    }
    if (!best || n > best.n) best = { n, corners: [tl, tr, br, bl].map(([x, y]) => [x, y]), touch };
  }
  return best ? { ...best, share: best.n / (w * h), thr } : null;
}
// projective transform from the unit square to a quadrilateral (and its use for sampling)
function homography(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den, hh = (dx1 * dy3 - dx3 * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + hh * x3, x0, y1 - y0 + g * y1, y3 - y0 + hh * y3, y0, g, hh];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function sharpness(g, w, h) {   // variance of the Laplacian: low = blurred
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
    const i = y * w + x; const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]; s += l; s2 += l * l; n += 1;
  }
  return n ? s2 / n - (s / n) ** 2 : 0;
}

/** Turn a picture into a scan, or say what is wrong with it. */
export async function scanReceipt(file) {
  if (!file) return { ok: false, problems: ['No file.'] };
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) return { ok: true, file, problems: [], pdf: true };
  if (!/^image\//.test(file.type || '')) return { ok: false, file, problems: ['Upload a scan (picture) or a PDF.'] };
  const img = await loadImage(file);
  const W = img.naturalWidth, H = img.naturalHeight;
  if (Math.min(W, H) < 600) return { ok: false, file, problems: ['The picture is too small to read. Move closer, or use the camera instead of a screenshot.'] };

  // 1. find the slip on a small copy
  const k = ANALYSE / Math.max(W, H); const aw = Math.round(W * k), ah = Math.round(H * k);
  const ac = canvasOf(aw, ah); const actx = ac.getContext('2d', { willReadFrequently: true }); actx.drawImage(img, 0, 0, aw, ah);
  const ag = boxBlur(grey(actx.getImageData(0, 0, aw, ah).data, aw, ah), aw, ah, 2);
  const paper = findPaper(ag, aw, ah);
  const problems = [];
  let quad;
  const sides = ['top', 'right', 'bottom', 'left']; const len = [aw, ah, aw, ah];
  const touching = paper ? sides.filter((_, i) => paper.touch[i] > len[i] * 0.12) : [];
  // paper on all four edges = an already flat scan (or a slip filling the frame): nothing to crop
  const fullFrame = !paper || paper.share > 0.9 || (touching.length === 4 && paper.share > 0.6);
  if (fullFrame) quad = [[0, 0], [W, 0], [W, H], [0, H]];
  else {
    if (paper.share < 0.012) return { ok: false, file, problems: ['Petti cannot find the slip in the picture. Lay it flat on a dark surface and fill the frame with it.'] };
    if (paper.share < 0.08) return { ok: false, file, problems: ['The slip is too small in the picture. Move the phone closer so the slip fills the screen.'] };
    // the slip runs off the picture = part of it is missing (a slip exactly as wide or as tall as the picture is fine)
    const opposite = touching.length === 2 && ((touching.includes('left') && touching.includes('right')) || (touching.includes('top') && touching.includes('bottom')));
    if (touching.length && !opposite) problems.push(`The slip is cut off at the ${touching.join(' and ')}. Get the whole slip in the picture, with a little space around it.`);
    quad = paper.corners.map(([x, y]) => [x / k, y / k]);
  }

  // 2. straighten and crop: map the slip onto a flat rectangle
  const outW0 = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2])), outH0 = Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));
  const s = Math.min(1, MAX_OUT / Math.max(outW0, outH0)); const ow = Math.max(1, Math.round(outW0 * s)), oh = Math.max(1, Math.round(outH0 * s));
  if (Math.min(ow, oh) < 380) problems.push('The slip is too small in the picture. Move the phone closer so the slip fills the screen.');
  const srcScale = Math.min(1, 2600 / Math.max(W, H)); const sw = Math.round(W * srcScale), sh = Math.round(H * srcScale);
  const sc = canvasOf(sw, sh); const sctx = sc.getContext('2d', { willReadFrequently: true }); sctx.drawImage(img, 0, 0, sw, sh);
  const src = sctx.getImageData(0, 0, sw, sh).data;
  const [a, b, c, d, e, f, g, hh] = homography(quad.map(([x, y]) => [x * srcScale, y * srcScale]));
  const out = canvasOf(ow, oh); const octx = out.getContext('2d'); const od = octx.createImageData(ow, oh);
  const gOut = new Float32Array(ow * oh);
  for (let y = 0; y < oh; y += 1) {
    const v = y / (oh - 1 || 1);
    for (let x = 0; x < ow; x += 1) {
      const u = x / (ow - 1 || 1); const den = g * u + hh * v + 1;
      const X = (a * u + b * v + c) / den, Y = (d * u + e * v + f) / den;
      const xi = Math.min(sw - 2, Math.max(0, X | 0)), yi = Math.min(sh - 2, Math.max(0, Y | 0)); const fx = X - xi, fy = Y - yi;
      const i00 = (yi * sw + xi) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const lum = (i) => 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
      gOut[y * ow + x] = lum(i00) * (1 - fx) * (1 - fy) + lum(i10) * fx * (1 - fy) + lum(i01) * (1 - fx) * fy + lum(i11) * fx * fy;
    }
  }

  // 3. quality of the straightened slip
  let mean = 0; for (const v of gOut) mean += v; mean /= gOut.length;
  // sharpness is judged on an evened-out copy, so a dim picture is not mistaken for a blurred one
  const sorted = Float32Array.from(gOut).sort(); const lo = sorted[Math.floor(sorted.length * 0.05)], hi = sorted[Math.floor(sorted.length * 0.95)];
  const span = Math.max(1, hi - lo); const gN = gOut.map((v) => Math.max(0, Math.min(255, ((v - lo) / span) * 255)));
  const sharp = sharpness(gN, ow, oh);
  if (sharp < 60) problems.push('The picture is blurred. Hold the phone still (rest your elbows on the table) and tap the slip on the screen to focus.');
  if (mean < 85) problems.push('The picture is too dark. Move to better light, or turn on the room light.');

  // 4. the scan look: even out the light, white paper, dark print
  const bg = boxBlur(gOut, ow, oh, Math.max(12, Math.round(Math.min(ow, oh) / 30)));
  for (let i = 0, j = 0; i < gOut.length; i += 1, j += 4) {
    let v = (gOut[i] / Math.max(1, bg[i])) * 255;          // divide out shadows and uneven light
    v = v >= 235 ? 255 : Math.max(0, (v - 70) * (255 / 165)); // paper to white, ink to black
    od.data[j] = od.data[j + 1] = od.data[j + 2] = v; od.data[j + 3] = 255;
  }
  octx.putImageData(od, 0, 0);
  const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.85));
  const name = (file.name || 'receipt').replace(/\.[^.]+$/, '') + '-scan.jpg';
  const scanned = new File([blob], name, { type: 'image/jpeg' });
  return { ok: problems.length === 0, file: scanned, problems, metrics: { sharp: Math.round(sharp), mean: Math.round(mean), share: paper?.share, size: [ow, oh] } };
}

/** Petti's reading of the receipt decides whether it is readable: a total and a date must come out of it. */
export function unreadable(reading) {
  if (!reading) return null;   // reading not available (service off): do not block on it
  const missing = [];
  if (reading.total == null || Number.isNaN(Number(reading.total))) missing.push('the total');
  if (!reading.date) missing.push('the date');
  if (!missing.length && typeof reading.confidence === 'number' && reading.confidence < 0.35) missing.push('enough of the print');
  return missing.length ? `Petti cannot read ${missing.join(' or ')} on this slip. Scan it again: flat, in good light, the whole slip in the picture.` : null;
}
