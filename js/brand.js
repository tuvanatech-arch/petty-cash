// The company's own logo on its documents (month-end pack, vouchers, authority schedule). One image, set by the
// administrator, kept in a public store (a logo is not secret) and fetched only when a document is made.
import { sb, state } from './api.js';

const BUCKET = 'branding';
let cached = null; // { key, logo }

/** The public address of the current logo, or null. */
export function logoUrl() {
  const s = state.settings || {};
  if (!s.logo_path) return null;
  const { data } = sb.storage.from(BUCKET).getPublicUrl(s.logo_path);
  const url = data?.publicUrl || null;
  if (!url || /^(data|blob):/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(s.logo_updated_at || '')}`;
}

/** The logo as a PNG data URL with its size, ready for a PDF; null when there is none or it cannot be read. */
export async function loadLogo() {
  const url = logoUrl();
  if (!url) return null;
  if (cached?.key === url) return cached.logo;
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image(); i.crossOrigin = 'anonymous';
      i.onload = () => resolve(i); i.onerror = () => reject(new Error('logo did not load')); i.src = url;
    });
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    const logo = { dataUrl: c.toDataURL('image/png'), w: img.naturalWidth, h: img.naturalHeight };
    cached = { key: url, logo };
    return logo;
  } catch { return null; }   // a document without the logo is better than no document
}

/** Draw the logo into a jsPDF document inside a box (mm), keeping its shape; returns the height used. */
export function drawLogo(doc, logo, x, y, maxW, maxH, { alignRight = false } = {}) {
  if (!logo) return 0;
  const k = Math.min(maxW / logo.w, maxH / logo.h);
  const w = logo.w * k, hgt = logo.h * k;
  doc.addImage(logo.dataUrl, 'PNG', alignRight ? x - w : x, y, w, hgt, 'company-logo', 'FAST');
  return hgt;
}

/** Shrink a chosen image to at most 1200 px wide and return it as a PNG blob (transparency kept). */
export async function prepareLogo(file) {
  if (!/^image\/(png|jpeg)$/.test(file.type)) throw new Error('Choose a PNG or JPG image.');
  if (file.size > 8 * 1024 * 1024) throw new Error('That image is over 8 MB. Choose a smaller one.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('That file is not an image we can read.')); i.src = url; });
    const k = Math.min(1, 1200 / img.naturalWidth);
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

/** Save a new logo (administrator only; the database checks). */
export async function saveLogo(blob) {
  const path = 'logo.png';
  const { error } = await sb.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: 'image/png', cacheControl: '3600' });
  if (error) throw new Error(error.message);
  const at = new Date().toISOString();
  const { error: e2 } = await sb.from('settings').update({ logo_path: path, logo_updated_at: at }).eq('id', 1);
  if (e2) throw new Error(e2.message);
  state.settings = { ...state.settings, logo_path: path, logo_updated_at: at };
  cached = null;
}

export async function removeLogo() {
  const { error } = await sb.from('settings').update({ logo_path: null, logo_updated_at: new Date().toISOString() }).eq('id', 1);
  if (error) throw new Error(error.message);
  state.settings = { ...state.settings, logo_path: null };
  cached = null;
}
