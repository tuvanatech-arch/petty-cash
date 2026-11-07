// usepetti.com (site/): layout at phone, tablet and desktop widths, links and anchors, pictures, the menu, keyboard
// access, and the trial form's checks and states. The form is never really sent: the test answers the POST itself.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve(new URL('../site', import.meta.url).pathname);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
let posts = [];
const server = http.createServer((req, res) => {
  if (req.method === 'POST') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { posts.push(b); res.statusCode = server.answer || 200; res.end('ok'); }); return; }
  let p = path.join(root, decodeURIComponent(req.url.split('?')[0].split('#')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p) && existsSync(p + '.html')) p += '.html';
  if (!existsSync(p)) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch();
const open = async (url, w, extra = {}) => {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 }, ...extra }); const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  // nothing may leave for a real service (Netlify, the app) during the test
  await page.route((u) => !u.href.startsWith(base), (r) => { errs.push(`outside request: ${r.request().url()}`); r.abort(); });
  await page.goto(base + url); return { ctx, page, errs };
};

/* 1. every page at three widths */
const PAGES = ['', 'how-it-works', 'supplies', 'pricing', 'contact', 'security', 'thanks', '404'];
for (const pg of PAGES) for (const w of [390, 820, 1440]) {
  const { ctx, page, errs } = await open(pg, w);
  await page.evaluate(async () => { document.querySelectorAll('img[loading=lazy]').forEach((i) => { i.loading = 'eager'; }); await Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })))); });
  const r = await page.evaluate(() => ({
    side: document.documentElement.scrollWidth > window.innerWidth + 1,
    broken: [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src')),
    noAlt: [...document.images].filter((i) => !i.getAttribute('alt')).length,
    anchors: [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')).filter((h) => h.length > 1 && !document.getElementById(h.slice(1))),
    h1: document.querySelectorAll('h1').length,
    small: [...document.querySelectorAll('a, button, input, select, textarea, summary')].filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.height < 24 && !el.closest('p, li, dd, td, .foot, .toc, figcaption'); }).map((el) => el.textContent.trim().slice(0, 30)),
  }));
  const name = `${pg || 'home'} @${w}`;
  check(!r.side, `${name}: nothing runs off the side`);
  check(!r.broken.length && !r.noAlt, `${name}: every picture loads and has a description ${r.broken.join(' ')}`);
  check(!r.anchors.length, `${name}: every link within the page has a destination ${r.anchors.join(' ')}`);
  check(r.h1 === 1, `${name}: one main heading`);
  check(!r.small.length, `${name}: controls are big enough to tap ${r.small.join(' | ')}`);
  check(!errs.length, `${name}: no errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* 2. links to other pages go somewhere real */
{
  const { ctx } = await open('', 1440);
  let all = [];
  for (const pg of PAGES) all.push(...await (await open(pg, 1440)).page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))));
  all = [...new Set(all)];
  const anchorsOk = [];
  for (const h of all.filter((x) => /^\/[a-z-]*#/.test(x))) { const [pg, id] = h.slice(1).split('#'); const f = readFileSync(path.join(root, (pg || 'index') + '.html'), 'utf8'); if (!f.includes(`id="${id}"`)) anchorsOk.push(h); }
  check(!anchorsOk.length, `links to a section of another page find it ${anchorsOk.join(' ')}`);
  const bits = (f) => { const t = readFileSync(path.join(root, f), 'utf8'); return [t.match(/<nav class="nav wrap"[\s\S]*?<\/nav>/)[0].replace(/ aria-current="page"/g, ''), t.match(/<footer class="foot">[\s\S]*?<\/footer>/)[0]]; };
  const [n0, f0] = bits('index.html');
  const odd = ['how-it-works.html', 'supplies.html', 'pricing.html', 'contact.html', 'security.html'].filter((f) => { const [n, ft] = bits(f); return n !== n0 || ft !== f0; });
  check(!odd.length, `every page has the same menu and footer ${odd.join(' ')}`);
  const local = all.filter((h) => h.startsWith('/')).map((h) => h.split('#')[0]).filter(Boolean);
  const missing = local.filter((h) => { const p = path.join(root, h); return !(existsSync(p + '.html') || existsSync(p) || existsSync(path.join(p, 'index.html'))); });
  check(!missing.length, `links to pages on the site all exist ${missing.join(' ')}`);
  const outside = all.filter((h) => /^https?:/.test(h)).filter((h) => !/^https:\/\/(app\.usepetti\.com\/|supabase\.com\/|privacy\.claude\.com\/|wa\.me\/264814950605)/.test(h));
  check(!outside.length, `outside links are only the app, Supabase, Anthropic's privacy page and our WhatsApp ${outside.join(' ')}`);
  await ctx.close();
}

/* 3. words and figures: prices as approved, no placeholders, no promises the product cannot keep */
{
  const text = ['index', 'how-it-works', 'supplies', 'pricing', 'contact', 'security', 'thanks', '404'].map((f) => readFileSync(path.join(root, f + '.html'), 'utf8')).join('\n');
  check(/N\$<\/span>750/.test(text) && /N\$<\/span>1,500/.test(text) && /N\$<\/span>3,000/.test(text) && /N\$2,500/.test(text) && /two months free/.test(text), 'prices: N$750, N$1,500, from N$3,000, setup N$2,500, two months free a year');
  const banned = text.match(/revolutionis|unlock|seamless|game-changing|powerhouse|always balances|lorem|TODO|TBD|\[\[|placeholder text|trusted by|guarantee[sd]? (recovery|delivery)|immutable|compliant|certified/gi);
  check(!banned, `no banned or unsupported wording ${banned ? banned.join(', ') : ''}`);
  check(!/MGP/.test(text), 'no client name on the public site');
}

/* 4. the menu on a phone, and the keyboard */
{
  const { ctx, page } = await open('', 390);
  const btn = page.locator('.nav-toggle');
  check(await page.locator('#nav-links').isHidden(), 'phone: the section links sit behind Menu');
  await btn.click();
  check(await btn.getAttribute('aria-expanded') === 'true' && await page.locator('#nav-links a', { hasText: 'Pricing' }).isVisible(), 'Menu opens the links');
  await page.keyboard.press('Escape');
  check(await btn.getAttribute('aria-expanded') === 'false' && await page.locator('#nav-links').isHidden(), 'Escape closes it again');
  await btn.click(); await page.locator('#nav-links a', { hasText: 'Pricing' }).click(); await page.waitForTimeout(1500);
  check(/\/pricing$/.test(new URL(page.url()).pathname) && await page.locator('#nav-links').isHidden() && await page.locator('h1', { hasText: 'Pricing' }).isVisible(), 'a link in the menu opens that page, with the menu closed');
  await ctx.close();
  const k = await open('', 1440);
  await k.page.keyboard.press('Tab');
  check(await k.page.evaluate(() => document.activeElement.classList.contains('skip')), 'keyboard: the first Tab offers "Skip to the content"');
  await k.page.keyboard.press('Tab');
  const outline = await k.page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  check(outline && outline !== 'none', 'keyboard: the focused control is outlined');
  await k.page.goto(base + 'pricing'); await k.page.locator('summary', { hasText: 'Is there a setup fee?' }).focus(); await k.page.keyboard.press('Enter');
  check(await k.page.locator('details:has(summary:has-text("Is there a setup fee?"))').evaluate((d) => d.open), 'keyboard: a question opens with Enter');
  await k.ctx.close();
  const nojs = await open('', 390, { javaScriptEnabled: false });
  check(await nojs.page.locator('#nav-links a', { hasText: 'Pricing' }).isVisible(), 'without scripts the section links still show on a phone');
  await nojs.ctx.close();
}

/* 5. the trial form */
{
  const { ctx, page, errs } = await open('contact', 390);
  const form = page.locator('#trial-form');
  await form.locator('button[type=submit]').click(); await page.waitForTimeout(200);
  check((await Promise.all(['name', 'company', 'registration', 'phone', 'email'].map((f) => page.locator(`#f-${f}-err`).isVisible()))).every(Boolean), 'empty: each required field says what is missing');
  check(await page.evaluate(() => document.activeElement.id) === 'f-name', 'empty: the cursor goes to the first one');
  check(/correct the 5 fields/.test(await page.locator('#form-status').innerText()) && !posts.length, 'empty: nothing is sent, and the count of fields to fix is given');
  await page.fill('#f-name', 'Test Person'); await page.fill('#f-company', 'Test Company'); await page.fill('#f-registration', 'CC/2019/01234'); await page.fill('#f-phone', '+264 81 123 4567'); await page.fill('#f-email', 'someone@nowhere');
  await form.locator('button[type=submit]').click(); await page.waitForTimeout(200);
  check(/email address looks incomplete/.test(await page.locator('#f-email-err').innerText()) && !posts.length, 'an incomplete email address is caught');
  await page.fill('#f-phone', '081 12'); await page.locator('#f-phone').blur();
  check(/phone number looks too short/.test(await page.locator('#f-phone-err').innerText()), 'a phone number that is too short is caught');
  await page.fill('#f-phone', '+264 81 123 4567'); await page.fill('#f-email', 'someone@company.com.na'); await page.fill('#f-message', 'Two branches');
  check(await page.locator('#f-phone-err').isHidden() && await page.locator('#f-email-err').isHidden(), 'the message clears once the field is right');
  server.answer = 500;
  await form.locator('button[type=submit]').click(); await page.waitForTimeout(500);
  check(/could not be sent/.test(await page.locator('#form-status').innerText()) && await page.inputValue('#f-name') === 'Test Person' && await page.inputValue('#f-message') === 'Two branches', 'a failed send says so and keeps everything typed');
  check(await page.locator('.form-done').count() === 0, 'no success message after a failed send');
  server.answer = 200; posts = [];
  await form.locator('button[type=submit]').click(); await page.waitForTimeout(500);
  const sent = new URLSearchParams(posts[0] || '');
  check(sent.get('form-name') === 'enquiry' && sent.get('name') === 'Test Person' && sent.get('registration') === 'CC/2019/01234' && sent.get('phone') === '+264 81 123 4567' && sent.get('email') === 'someone@company.com.na' && sent.get('size') === '11 to 30' && sent.get('branches') === '1', 'sent as the "enquiry" form with every field');
  const done = await page.locator('.form-done').innerText().catch(() => '');
  check(/Thanks\. Your request has been received\./.test(done) && /contact you about the next steps/.test(done) && /begins after setup/.test(done), 'success only after the send succeeded, in the agreed words');
  check(await page.evaluate(() => document.activeElement.classList.contains('form-done')), 'the success message takes the focus, so screen readers announce it');
  check(!errs.filter((e) => !/500/.test(e)).length, `form: no errors ${errs.join(' | ')}`);
  await ctx.close();
  // without scripts the form still posts to the thank-you page
  const nojs = await open('contact', 390, { javaScriptEnabled: false });
  check(await nojs.page.locator('#trial-form').getAttribute('action') === '/thanks.html' && await nojs.page.locator('#trial-form').getAttribute('data-netlify') === 'true', 'without scripts: a normal Netlify form post to /thanks.html');
  await nojs.ctx.close();
}

await b.close(); server.close();
console.log(fails.length ? `SITE: FAIL (${fails.length})` : 'SITE: PASS'); process.exit(fails.length ? 1 : 0);
