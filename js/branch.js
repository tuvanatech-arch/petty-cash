// Branches on the screens: a chooser for pages that act on one branch's cash or store, and a small tag on rows
// when more than one branch is being looked at.
import { state, multiBranch, setView, branchName } from './api.js';
import { h, money, toast, refresh } from './ui.js';

/** "Looking at all branches" on a page that acts on one: pick one first (the choice is remembered). */
export function branchGate(what, extras = {}) {
  if (!multiBranch() || state.view) return null;
  const pick = async (id) => { try { await setView(id); refresh(); } catch (e) { toast(e.message || 'Could not switch branch'); } };
  return h('div', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, h('h2', {}, `Which branch's ${what}?`), h('span', { class: 'sub' }, 'you are looking at all branches')),
    h('div', { class: 'branch-pick' }, state.branches.filter((b) => b.active).map((b) => {
      const x = extras[b.id] || {};
      return h('div', { class: 'box', role: 'button', tabindex: 0, onclick: () => pick(b.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(b.id); } } },
        h('span', { class: 'k' }, b.company), h('span', { class: 'v' }, b.name), x.line ? h('span', { class: 'd' }, x.line) : null);
    })),
    h('p', { class: 'hint' }, 'Or choose the branch from the switcher in the menu.'));
}

/** A small tag naming the row's branch, shown only when more than one branch is on screen. */
export function branchTag(id) { return multiBranch() && !state.view && id ? h('span', { class: 'branch-tag' }, branchName(id)) : null; }

/** "Windhoek · " in front of a title when several branches are on screen. */
export function branchPrefix(id) { return multiBranch() && !state.view && id ? `${branchName(id)} · ` : ''; }

export { money };
