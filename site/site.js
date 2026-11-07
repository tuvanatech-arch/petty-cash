// usepetti.com: the menu on small screens, and the trial form (checked here, sent to Netlify Forms without leaving the
// page, and only reported as received when Netlify says so). Without this script the form still posts normally and
// lands on /thanks.html.
(() => {
  document.documentElement.classList.add('js');
  /* ---------- menu ---------- */
  const toggle = document.querySelector('.nav-toggle');
  const links = document.getElementById('nav-links');
  if (toggle && links) {
    const set = (open) => { toggle.setAttribute('aria-expanded', String(open)); links.classList.toggle('open', open); };
    toggle.addEventListener('click', () => set(toggle.getAttribute('aria-expanded') !== 'true'));
    links.addEventListener('click', (e) => { if (e.target.closest('a')) set(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && links.classList.contains('open')) { set(false); toggle.focus(); } });
  }

  /* ---------- text boxes grow as you type (where the browser does not do it from the stylesheet) ---------- */
  if (!(window.CSS && CSS.supports && CSS.supports('field-sizing', 'content'))) {
    document.addEventListener('input', (e) => {
      const t = e.target; if (!(t instanceof HTMLTextAreaElement)) return;
      const y = window.scrollY; t.style.height = '';
      const want = Math.min(t.scrollHeight + t.offsetHeight - t.clientHeight, Math.round(window.innerHeight * 0.6));
      if (want > t.offsetHeight) t.style.height = `${want}px`;
      window.scrollTo(window.scrollX, y);
    });
  }

  /* ---------- trial form ---------- */
  const form = document.getElementById('trial-form');
  if (!form || !window.fetch || !window.FormData) return;
  const status = document.getElementById('form-status');
  const button = form.querySelector('button[type="submit"]');
  const rules = {
    name: (v) => (v ? '' : 'Enter your name.'),
    company: (v) => (v ? '' : 'Enter your company’s name.'),
    registration: (v) => (v ? '' : 'Enter the company’s registration number, or write “Not registered”.'),
    phone: (v) => {
      if (!v) return 'Enter a phone number so we can call you.';
      return v.replace(/\D/g, '').length >= 7 ? '' : 'That phone number looks too short. Include the area or country code.';
    },
    email: (v) => {
      if (!v) return 'Enter your email address.';
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? '' : 'That email address looks incomplete. Check it, for example name@company.com.';
    },
  };
  const showError = (input, msg) => {
    const err = document.getElementById(`${input.id}-err`);
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (err) { err.textContent = msg; err.hidden = !msg; }
  };
  const check = (input) => { const rule = rules[input.name]; const msg = rule ? rule(input.value.trim()) : ''; showError(input, msg); return !msg; };
  for (const name of Object.keys(rules)) {
    const input = form.elements[name];
    input.addEventListener('blur', () => { if (input.value.trim() || input.getAttribute('aria-invalid') === 'true') check(input); });
    input.addEventListener('input', () => { if (input.getAttribute('aria-invalid') === 'true') check(input); });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = ''; status.className = 'form-status';
    const bad = Object.keys(rules).map((n) => form.elements[n]).filter((input) => !check(input));
    if (bad.length) {
      status.textContent = bad.length === 1 ? 'Please correct the field marked above.' : `Please correct the ${bad.length} fields marked above.`;
      status.classList.add('is-error');
      bad[0].focus();
      return;
    }
    button.disabled = true; const label = button.textContent; button.textContent = 'Sending…';
    try {
      const res = await fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(new FormData(form)).toString() });
      if (!res.ok) throw new Error(String(res.status));
      const done = document.createElement('div');
      done.className = 'form-done'; done.setAttribute('role', 'status'); done.tabIndex = -1;
      done.innerHTML = '<h3>Thanks. Your request has been received.</h3><p>We’ll contact you about the next steps.</p><p>Your trial begins after setup, not when you submit this form.</p>';
      form.replaceWith(done); done.focus();
    } catch {
      // nothing typed is lost: the form stays as it was
      status.textContent = 'Your request could not be sent. Check your connection and try again. Nothing you typed has been lost.';
      status.classList.add('is-error'); status.focus();
      button.disabled = false; button.textContent = label;
    }
  });
})();

/* ---------- the hero's app picture: each button tapped in turn, showing what it opens ---------- */
(() => {
  const box = document.getElementById('cycle');
  if (!box || !('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // phones keep the still picture: the moving version costs about 700 KB of mobile data
  if (window.matchMedia('(max-width: 640px)').matches) return;
  const url = document.getElementById('hero-url'); const home = url ? url.textContent : '';
  const cursor = box.querySelector('.cycle-cursor'), tap = box.querySelector('.cycle-tap');
  const phone = window.matchMedia('(max-width: 640px)');
  // each button's place on the screen, in % of the picture: left, top, width, height (measured when the pictures were taken)
  const BOXES = {
    desk: {'month-end': [21.12, 14.59, 13.71, 5.63], payout: [35.46, 14.59, 10.64, 5.63], count: [46.73, 14.59, 10.06, 5.63], bank: [57.41, 14.59, 12.85, 5.63], move: [70.89, 14.59, 9.73, 5.63], return: [81.24, 14.59, 10.45, 5.63], close: [21.12, 21.32, 13.98, 5.63]},
    phone: {'month-end': [4.1, 23.24, 41.19, 5.43], payout: [47.35, 23.24, 31.96, 5.43], count: [4.1, 29.83, 30.23, 5.43], bank: [36.38, 29.83, 38.59, 5.43], move: [4.1, 36.43, 29.24, 5.43], return: [35.4, 36.43, 31.39, 5.43], close: [4.1, 43.03, 42, 5.43]},
  };
  const ORDER = ['month-end', 'payout', 'count', 'bank', 'move', 'return', 'close'];
  const frames = {};
  const size = () => (phone.matches ? 'phone' : 'desk');
  const frame = (k) => {
    const key = `${size()}-${k}`;
    if (!frames[key]) {
      const img = new Image(); img.className = 'cycle-frame'; img.alt = ''; img.setAttribute('aria-hidden', 'true'); img.decoding = 'async';
      img.src = `img/cycle/${key}.webp`; box.insertBefore(img, tap); frames[key] = img;
    }
    return frames[key];
  };
  let i = 0, timer = null, visible = false, started = false;
  const wait = (ms) => new Promise((r) => { timer = setTimeout(r, ms); });
  async function step() {
    if (!visible || document.hidden) { timer = null; return; }
    const k = ORDER[i % ORDER.length], b = BOXES[size()][k], img = frame(k);
    frame(ORDER[(i + 1) % ORDER.length]);                 // load only the next one, ready for its turn
    box.classList.add('running');
    cursor.style.left = `${b[0] + b[2] / 2}%`; cursor.style.top = `${b[1] + b[3] * .6}%`;
    await wait(1000);
    Object.assign(tap.style, { left: `${b[0]}%`, top: `${b[1]}%`, width: `${b[2]}%`, height: `${b[3]}%` });
    tap.classList.remove('on'); void tap.offsetWidth; tap.classList.add('on');
    cursor.classList.add('press'); await wait(180); cursor.classList.remove('press');
    try { await img.decode(); } catch { /* not loaded yet: show the page instead */ }
    await wait(300);
    if (img.complete && img.naturalWidth) img.classList.add('on');
    if (url && k === 'month-end') url.textContent = 'petty-cash-2026-11.pdf';
    await wait(6000);   // each window stays 6 seconds
    img.classList.remove('on'); if (url) url.textContent = home;
    i += 1;
    await wait(900);
    step();
  }
  const go = () => { if (visible && !document.hidden && !timer) step(); };
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible && !started) { started = true; setTimeout(go, 1500); } else go(); }, { threshold: .4 }).observe(box);
  document.addEventListener('visibilitychange', go);
})();
