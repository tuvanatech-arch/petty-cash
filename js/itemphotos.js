// Pictures of stock items (053): up to 3 per item, in the private "item-photos" store. The stock controller and the GM
// add them; everyone signed in sees them where items are picked. Phone photos are made smaller before upload, so they
// load fast on mobile data.
import { sb, state } from './api.js';
import { h, mount, toast, busy, confirmDialog } from './ui.js';

const BUCKET = 'item-photos';
export const MAX_PHOTOS = 3;
const urls = new Map();

/** A short-lived address for a stored photo (kept for this visit). */
export async function photoUrl(path) {
  if (!path) return null;
  if (urls.has(path)) return urls.get(path);
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
  const u = error ? null : data?.signedUrl || null;
  urls.set(path, u);
  return u;
}

/** A small picture of the item's first photo, or a plain placeholder. */
export function itemThumb(item, { size = 36 } = {}) {
  const box = h('span', { class: 'item-thumb', style: { width: `${size}px`, height: `${size}px` }, 'aria-hidden': 'true' });
  const p = (item?.photos || [])[0];
  if (p) photoUrl(p).then((u) => { if (u) mount(box, h('img', { src: u, alt: '', loading: 'lazy' })); });
  else box.classList.add('empty');
  return box;
}

/** Make a phone photo smaller: at most 1280 px on the long side, as a JPEG. */
export async function shrinkPhoto(file) {
  if (!/^image\//.test(file.type || '')) throw new Error('Choose a photo (JPEG or PNG).');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That photo could not be opened.')); i.src = url; });
    const k = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
    return blob || file;
  } finally { URL.revokeObjectURL(url); }
}

/** Upload one photo under a folder of the store; returns its path. */
export async function uploadPhoto(file, folder) {
  const blob = await shrinkPhoto(file);
  const path = `${folder}/${crypto.randomUUID()}.jpg`;
  const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw new Error(error.message || 'The photo could not be uploaded.');
  return path;
}

/** The photos of an item, large; with "Add a photo" and "Remove" for the stock controller and the GM. */
export function itemPhotos(item, { canEdit = false, onChange = () => {} } = {}) {
  const box = h('div', { class: 'item-photos', id: 'item-photos' });
  async function draw() {
    const photos = item.photos || [];
    const tiles = await Promise.all(photos.map(async (p, i) => {
      const u = await photoUrl(p);
      const rm = canEdit ? h('button', { type: 'button', class: 'btn btn-sm btn-quiet btn-danger' }, 'Remove') : null;
      if (rm) rm.onclick = busy(rm, async () => {
        if (!(await confirmDialog('Remove this photo?', `It is taken off ${item.name}.`, { ok: 'Remove', danger: true }))) return;
        await save(photos.filter((_, j) => j !== i));
      });
      return h('figure', { class: 'item-photo' }, u ? h('a', { href: u, target: '_blank', rel: 'noopener' }, h('img', { src: u, alt: `${item.name}, photo ${i + 1}` })) : h('span', { class: 'muted' }, 'Photo'), rm);
    }));
    let add = null;
    if (canEdit && photos.length < MAX_PHOTOS) {
      const input = h('input', { type: 'file', accept: 'image/*' });
      const label = h('label', { class: 'upload item-photo-add', id: 'add-item-photo' }, input, photos.length ? '📷 Add another photo' : '📷 Add a photo');
      input.onchange = async () => {
        const f = input.files?.[0]; if (!f) return;
        label.lastChild.textContent = 'Uploading…';
        try { const path = await uploadPhoto(f, `items/${item.id}`); await save([...photos, path]); toast('Photo added.'); }
        catch (e) { toast(e.message, { error: true }); draw(); }
      };
      add = label;
    }
    mount(box, tiles.length ? h('div', { class: 'item-photo-row' }, tiles) : null, add,
      !tiles.length ? h('p', { class: 'hint' }, canEdit ? 'No photo yet. A photo helps everyone pick the right item (recommended).' : 'No photo yet.') : null);
  }
  async function save(photos) {
    const { error } = await sb.from('items').update({ photos }).eq('id', item.id);
    if (error) throw new Error(error.message);
    item.photos = photos; onChange(item); await draw();
  }
  draw();
  return box;
}

export const canEditPhotos = () => ['stock_manager', 'approver'].includes(state.me?.role);
