// A plain name for a device, read from what the browser says about itself: "iPhone · installed app", "Windows PC · Edge".

export function isStandaloneApp() {
  try { return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true; } catch { return false; }
}

export function deviceKind(ua = '', touch = 0) {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'Device';
}

export function browserName(ua = '') {
  if (/EdgA?\/|Edg\//.test(ua)) return 'Edge';
  if (/SamsungBrowser/.test(ua)) return 'Samsung Internet';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox|FxiOS/.test(ua)) return 'Firefox';
  if (/CriOS|Chrome\//.test(ua)) return 'Chrome';
  if (/Safari/.test(ua)) return 'Safari';
  return 'browser';
}

/** For a sign-in that never reported itself: the name from its browser string alone. */
export function labelFromAgent(ua) {
  if (!ua) return 'Unknown device';
  return `${deviceKind(ua)} · ${browserName(ua)}`;
}

/** This device, as precisely as the browser allows (Android Chrome also gives the phone model). */
export async function thisDeviceLabel() {
  const ua = navigator.userAgent || '';
  let kind = deviceKind(ua, navigator.maxTouchPoints || 0);
  try {
    if (/Android/.test(ua) && navigator.userAgentData?.getHighEntropyValues) {
      const { model } = await navigator.userAgentData.getHighEntropyValues(['model']);
      if (model && model !== 'K') kind += ` (${model})`;
    }
  } catch { /* not offered */ }
  return `${kind} · ${isStandaloneApp() ? 'installed app' : browserName(ua)}`;
}
