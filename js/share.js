// "Share → Petty cash" on Android: the share arrives as a POST that the service worker stores in a small cache;
// the Snap page then collects it here. (iPhone does not offer sharing into installed web apps.)
export const SHARE_CACHE = 'pcs-share';

export async function takeSharedFile() {
  if (!('caches' in window)) return null;
  const cache = await caches.open(SHARE_CACHE);
  const res = await cache.match('shared-file');
  if (!res) return null;
  await cache.delete('shared-file');
  const blob = await res.blob();
  const name = decodeURIComponent(res.headers.get('X-File-Name') || '') || `shared.${(blob.type.split('/')[1] || 'bin').replace('jpeg', 'jpg')}`;
  return new File([blob], name, { type: res.headers.get('Content-Type') || blob.type });
}
