// Devices signed in to an account: what they are, roughly where, when last used – and signing any or all of them out.
// Used on Account (your own) and from Admin → People (anyone's).
import { sb, state, rpc, currentSessionId, signOutHere, personName, unwrap } from './api.js';
import { h, mount, toast, fmtDate, modal, more, refresh } from './ui.js';
import { labelFromAgent } from './device-label.js';

function activeText(iso) {
  const min = (Date.now() - new Date(iso).getTime()) / 60000;
  if (min < 5) return 'active now';
  if (min < 60) return `active ${Math.round(min)} min ago`;
  if (min < 24 * 60) return `active ${Math.round(min / 60)} h ago`;
  return `last active ${fmtDate(iso)}`;
}

/** A button that asks once more before it acts (no second dialog, so it also works inside one). */
function twoTap(label, sure, action, cls = 'btn btn-sm btn-quiet btn-danger') {
  const b = h('button', { type: 'button', class: cls }, label);
  let armed = false, t;
  b.onclick = async () => {
    if (!armed) { armed = true; b.textContent = sure; b.classList.add('armed'); t = setTimeout(() => { armed = false; b.textContent = label; b.classList.remove('armed'); }, 4000); return; }
    clearTimeout(t); b.disabled = true; b.textContent = 'Signing out…';
    try { await action(); } catch (e) { toast(e.message, { error: true }); b.disabled = false; armed = false; b.textContent = label; b.classList.remove('armed'); }
  };
  return b;
}

function eventText(e) {
  const d = e.detail || {};
  const who = e.actor_id === state.me.id ? 'You' : personName(e.actor_id);
  if (e.kind === 'new_device') return `New sign-in: ${d.label || 'a device'}${d.place ? ` near ${d.place}` : ''}`;
  if (e.kind === 'new_country') return `First use from ${d.place || d.country}: ${d.label || 'a device'}`;
  if (e.kind === 'far_apart') return `Two far-apart places: ${d.other_place || '?'} and ${d.place || '?'}${d.km ? ` (${Number(d.km).toLocaleString()} km)` : ''}, ${d.minutes ?? '?'} min apart`;
  if (e.kind === 'signed_out') return `${who} signed out ${d.everywhere ? 'every device' : d.devices || 'a device'}`;
  return e.kind;
}

/**
 * The list for one person (default: me). Redraws itself after every sign-out.
 * onCount(n) is told how many devices are signed in (for a heading elsewhere).
 */
export function devicesBlock(userId = null, { onCount } = {}) {
  const uid = userId || state.me.id;
  const mine = uid === state.me.id;
  const box = h('div', { class: 'devices' }, h('p', { class: 'hint' }, 'Looking up devices…'));
  const draw = async () => {
    let rows, events = [];
    try {
      [rows, events] = await Promise.all([
        rpc('devices', mine ? {} : { p_user: uid }),
        sb.from('security_events').select('*').eq('user_id', uid).order('at', { ascending: false }).limit(6).then(unwrap).catch(() => []),
      ]);
    } catch (e) { mount(box, h('div', { class: 'error' }, e.message)); return; }
    onCount?.(rows.length);
    const sid = mine ? currentSessionId() : null;
    const others = rows.filter((r) => r.session_id !== sid);
    const name = mine ? null : personName(uid);
    const item = (r) => {
      const here = r.session_id === sid;
      const where = r.place ? `${r.approx ? 'roughly ' : ''}${r.place}` : 'place not reported yet';
      return h('li', { class: here ? 'this-device' : '' },
        h('div', { class: 'what' },
          h('strong', {}, r.label || labelFromAgent(r.user_agent), here ? h('span', { class: 'pill pill-green', style: { marginLeft: '8px' } }, 'This device') : null),
          h('span', {}, [where, activeText(r.last_active), `signed in ${fmtDate(r.signed_in_at)}`, r.alerts ? 'alerts on' : null].filter(Boolean).join(' · '))),
        here ? null : twoTap('Sign out', 'Tap again to sign out', async () => {
          await rpc('sign_out_devices', { p_sessions: [r.session_id] });
          toast(mine ? 'Signed out. That device has to sign in again.' : `Signed out. ${name} has to sign in again there.`);
          draw();
        }));
    };
    const actions = [];
    if (mine && others.length) {
      actions.push(twoTap(others.length === 1 ? 'Sign out the other device' : `Sign out all ${others.length} other devices`, 'Tap again – only this one stays', async () => {
        await rpc('sign_out_devices', { p_keep: sid });
        toast('Done. Only this device is still signed in.');
        draw();
      }, 'btn btn-sm'));
    }
    if (mine && rows.length) actions.push(twoTap('Sign out everywhere', 'Tap again – including this one', async () => {
      await rpc('sign_out_devices', {});
      await signOutHere().catch(() => {});
    }, 'btn btn-sm btn-quiet btn-danger'));
    if (!mine && rows.length) actions.push(twoTap(`Sign ${name.split(' ')[0]} out everywhere`, 'Tap again to sign out every device', async () => {
      await rpc('sign_out_devices', { p_user: uid });
      toast(`${name} is signed out everywhere and has to sign in again.`);
      draw();
    }, 'btn btn-sm btn-danger'));
    mount(box,
      rows.length ? h('ul', { class: 'ledger-list' }, rows.map(item)) : h('p', { class: 'hint' }, mine ? 'No device is signed in.' : `${name} is not signed in on any device.`),
      actions.length ? h('div', { class: 'form-actions', style: { justifyContent: 'flex-start' } }, actions) : null,
      h('p', { class: 'hint' }, mine
        ? 'Don’t recognise one? Sign it out, then change your password. You get an alert when your account is signed in on a new device, used from a new country, or used in two places too far apart.'
        : 'Signing out takes effect straight away; their alerts stop on that device too. They are told, and can sign in again with their password.'),
      events.length ? more('Recent sign-in activity', h('ul', { class: 'plain-list' }, events.map((e) => h('li', {}, h('span', { class: 'muted' }, `${fmtDate(e.at, { time: true })} · `), eventText(e))))) : null);
  };
  draw();
  return box;
}

/** Admin → People: one person's devices in a dialog. */
export function devicesDialog(p) {
  modal(p.id === state.me.id ? 'Your devices' : `${p.full_name || p.email}'s devices`, (close) => h('div', {},
    devicesBlock(p.id),
    h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => { close(); if (/devices=/.test(location.hash)) location.hash = location.hash.split('?')[0]; else refresh(); } }, 'Done'))));
}
