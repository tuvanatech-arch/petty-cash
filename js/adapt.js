// Sense the device and the way it is being used, and say so on <html> so the stylesheet can adapt:
//   data-pointer  coarse | fine | none        what the main pointing device is (touch screen, mouse/trackpad, none)
//   data-input    touch | pen | mouse | keyboard   the last thing the person actually used
//   data-device   phone | tablet | desktop | tv
//   data-orient   portrait | landscape          plus data-short when the screen is short (landscape phone)
// Nothing is listed per device model; everything is read from what the browser reports and what the person does.

const root = document.documentElement;
const mq = (q) => !!window.matchMedia?.(q)?.matches;

function sense() {
  const w = window.innerWidth, hgt = window.innerHeight;
  const coarse = mq('(pointer: coarse)'), fine = mq('(pointer: fine)'), hover = mq('(hover: hover)');
  const pointer = coarse ? 'coarse' : fine ? 'fine' : 'none';
  const ua = navigator.userAgent || '';
  const tvUA = /\b(SmartTV|SMART-TV|Tizen|Web0S|WebOS|NetCast|BRAVIA|Roku|AppleTV|CrKey|GoogleTV|Viera|AFTT|AFTS)\b/i.test(ua);
  const short = Math.min(w, hgt);
  let device;
  if (tvUA || (!hover && w >= 1280 && pointer !== 'coarse') || (!hover && w >= 1600)) device = 'tv';
  else if (coarse && short < 600) device = 'phone';
  else if (coarse && short >= 600) device = 'tablet';
  else device = 'desktop';
  root.dataset.pointer = pointer;
  root.dataset.device = device;
  root.dataset.orient = w > hgt ? 'landscape' : 'portrait';
  root.toggleAttribute('data-short', hgt < 520);
  root.toggleAttribute('data-hover', hover);
  if (!root.dataset.input) root.dataset.input = device === 'tv' ? 'keyboard' : coarse ? 'touch' : fine ? 'mouse' : 'keyboard';
}

function setInput(kind) {
  if (root.dataset.input !== kind) root.dataset.input = kind;
}

export function startAdapting() {
  sense();
  let t; const resense = () => { clearTimeout(t); t = setTimeout(sense, 120); };
  window.addEventListener('resize', resense);
  window.addEventListener('orientationchange', resense);
  for (const q of ['(pointer: coarse)', '(hover: hover)']) { try { window.matchMedia(q).addEventListener('change', resense); } catch {} }

  // what the person is actually using: the first pointer event of each kind wins, and keys switch to keyboard
  window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'pen') setInput('pen'); else if (e.pointerType === 'touch') setInput('touch'); else if (e.pointerType === 'mouse') setInput('mouse'); }, { capture: true, passive: true });
  window.addEventListener('pointermove', (e) => { if (e.pointerType === 'pen') setInput('pen'); }, { capture: true, passive: true });
  window.addEventListener('keydown', (e) => {
    if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(e.key) && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) setInput('keyboard');
  }, { capture: true });

  // keyboard and remote: rows and cards become reachable, Enter/Space act, arrows move through the list
  const enhance = () => {
    for (const el of document.querySelectorAll('.ledger-list li.click, tr.click, tr.item-row, .snap-card .what')) {
      if (!el.hasAttribute('tabindex')) { el.setAttribute('tabindex', '0'); if (!el.getAttribute('role')) el.setAttribute('role', 'button'); }
    }
  };
  // tables that do not fit a phone become labelled cards (one card per row) instead of scrolling sideways
  const stackTables = () => {
    const narrow = window.innerWidth <= 600;
    for (const t of document.querySelectorAll('.table-wrap > table.ledger')) {
      const heads = [...t.querySelectorAll('thead th')].map((th) => (th.innerText || th.textContent || '').trim());
      for (const tr of t.querySelectorAll('tbody tr')) [...tr.children].forEach((td, i) => { if (!td.hasAttribute('data-label')) td.setAttribute('data-label', heads[i] || ''); });
      t.classList.remove('stacked');
      if (narrow && !t.closest('.lines-edit') && !t.classList.contains('compact') && t.scrollWidth > t.parentElement.clientWidth + 2) t.classList.add('stacked');
    }
  };
  const tidy = () => { enhance(); stackTables(); };
  tidy();
  window.addEventListener('resize', () => { clearTimeout(tidy._r); tidy._r = setTimeout(stackTables, 150); });
  if (typeof MutationObserver !== 'undefined') new MutationObserver(() => { clearTimeout(enhance._t); enhance._t = setTimeout(tidy, 30); }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    const isRow = el.matches('.ledger-list li.click, tr.click, tr.item-row');
    if (isRow && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); el.click(); return; }
    const arrows = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'];
    if (arrows.includes(e.key)) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      const modal = document.querySelector('.modal');
      const scope = modal || document;
      const inNav = !!el.closest('.side, .tabbar, .topbar');
      const sel = 'a[href], button:not([disabled]), [tabindex="0"], input, select, summary';
      const visible = (f) => f.getBoundingClientRect().height > 0;
      const navList = modal ? [] : [...document.querySelectorAll('.side a[href], .tabbar a[href], .topbar a[href]')].filter(visible);
      const mainList = [...(modal || document.querySelector('main')).querySelectorAll(sel)].filter(visible);
      // left/right hop between the navigation and the page; up/down walk within the one you are in
      if (e.key === 'ArrowRight' && inNav && mainList.length) { e.preventDefault(); mainList[0].focus(); return; }
      if (e.key === 'ArrowLeft' && !inNav && navList.length) { e.preventDefault(); (navList.find((a) => a.classList.contains('active')) || navList[0]).focus(); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return;
      const list = inNav ? navList : mainList;
      const i = list.indexOf(el);
      if (i === -1) { if (list.length) { e.preventDefault(); list[0].focus(); } return; }
      const next = list[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) { e.preventDefault(); next.focus(); next.scrollIntoView?.({ block: 'nearest' }); }
    }
    if (e.key === 'Escape') { const back = document.querySelector('.modal-back'); if (!back && location.hash !== '#/home' && (root.dataset.device === 'tv')) history.back(); }
  });
}

/** True when the screen is being driven from a sofa (TV or remote). */
export function isTenFoot() { return root.dataset.device === 'tv'; }
