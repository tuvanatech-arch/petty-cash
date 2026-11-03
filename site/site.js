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

  /* ---------- trial form ---------- */
  const form = document.getElementById('trial-form');
  if (!form || !window.fetch || !window.FormData) return;
  const status = document.getElementById('form-status');
  const button = form.querySelector('button[type="submit"]');
  const rules = {
    name: (v) => (v ? '' : 'Enter your name.'),
    company: (v) => (v ? '' : 'Enter your company’s name.'),
    contact: (v) => {
      if (!v) return 'Enter a phone number or an email address so we can reach you.';
      if (v.includes('@')) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? '' : 'That email address looks incomplete. Check it, for example name@company.com.';
      return v.replace(/\D/g, '').length >= 7 ? '' : 'That phone number looks too short. Include the area or country code.';
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
