// The phone's bottom bar (Nov 2026): icons, the screen you are on highlighted, a round "New" in the middle that slides
// up the things to start, and "More" that slides up everything else (Stock included for the GM and the MD, nothing
// twice). Numbers sit on the screen where the work is. Also: the #/more page, the computer's side menu, a phone on its side.
// SHOTS=dir saves pictures of each role's bar and sheets.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const SHOTS = process.env.SHOTS || null;
const b = await chromium.launch();
async function open(role, hash, { w = 390, hgt = 844, dark = false } = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: SHOTS ? 2 : 1, colorScheme: dark ? 'dark' : 'light', hasTouch: w < 900, isMobile: w < 900 });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '#/home');
  await page.evaluate((r) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); localStorage.setItem('demo_updates_unseen', '0'); sessionStorage.setItem('pcs_update_shown', '1'); localStorage.setItem('demo_two_step', 'off'); localStorage.setItem('pcs_install_later', String(Date.now())); }, role);
  await page.goto(base + hash); await page.reload(); await page.waitForTimeout(1800);
  return { ctx, page, errs };
}
const labels = (page) => page.$$eval('.tabbar .tab .tab-label', (els) => els.map((e) => e.textContent));
const sheetLabels = (page) => page.$$eval('.bs-panel .bs-row strong', (els) => els.map((e) => e.textContent));
const shot = async (page, name) => { if (!SHOTS) return; await page.addStyleTag({ content: '#toast-root{display:none!important}' }); await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

const EXPECT = {
  requester: ['Home', 'Requests', 'New', 'Stock', 'More'],
  stock_manager: ['Home', 'Stock', 'New', 'Requests', 'More'],
  finance: ['Home', 'Requests', 'New', 'Petty cash', 'More'],
  approver: ['Home', 'Requests', 'New', 'Petty cash', 'More'],
  managing_director: ['Home', 'Requests', 'New', 'Reports', 'More'],
};
for (const [role, want] of Object.entries(EXPECT)) {
  const { ctx, page, errs } = await open(role, '#/home', { dark: true });
  const got = await labels(page);
  check(JSON.stringify(got) === JSON.stringify(want), `${role}: the bar is ${want.join(' · ')} (got ${got.join(' · ')})`);
  check(await page.locator('.tabbar .tab svg.ic').count() === 5, `${role}: every button has an icon`);
  check(await page.locator('.tabbar .tab.active .tab-label').innerText() === 'Home', `${role}: Home is highlighted on Home`);
  await shot(page, `${role}-home`);
  // New
  await page.click('#tab-new'); await page.waitForTimeout(450);
  const news = await sheetLabels(page);
  check(news[0] === 'Snap or upload' && news.includes('Request a payment') && news.includes('Claim back') && news.includes('Suggest an item')
    && (['stock_manager', 'approver', 'managing_director'].includes(role) ? news.includes('Stock item') && !news.includes('Report low stock') : news.includes('Report low stock') && !news.includes('Stock item')), `${role}: New offers ${news.join(', ')} (as on Home: who buys stock, or reports it)`);
  check(await page.locator('#tab-new.open').count() === 1 && (await page.locator('#tab-new').getAttribute('aria-expanded')) === 'true', `${role}: the + turns while New is open`);
  await shot(page, `${role}-new`);
  await page.keyboard.press('Escape'); await page.waitForTimeout(350);
  check(await page.locator('.bs-back').count() === 0, `${role}: Escape closes it`);
  // More
  await page.click('#tab-more'); await page.waitForTimeout(450);
  const more = await sheetLabels(page);
  const bar = want.filter((x) => !['New', 'More'].includes(x));
  check(more.length && !more.some((x) => bar.includes(x)), `${role}: More holds nothing already on the bar (${more.join(', ')})`);
  if (role !== 'requester' && role !== 'stock_manager') check(more.includes('Stock'), `${role}: Stock is under More`);
  check(more.includes('Account') && more.includes('What’s new') && more.includes('How it works') && more.includes('Reload the app'), `${role}: Account, What’s new, How it works, Reload`);
  await shot(page, `${role}-more`);
  // tap outside closes
  await page.mouse.click(200, 60); await page.waitForTimeout(350);
  check(await page.locator('.bs-back').count() === 0, `${role}: tapping outside closes More`);
  check(!errs.length, `${role}: no page errors ${errs.join(' | ')}`);
  await ctx.close();
}

/* GM: Stock reached from More; the bar then lights More */
{
  const { ctx, page } = await open('approver', '#/home');
  await page.click('#tab-more'); await page.waitForTimeout(400);
  await page.locator('.bs-row', { hasText: 'Stock' }).first().click(); await page.waitForTimeout(1500);
  check(/#\/stock/.test(page.url()) && await page.locator('main h1', { hasText: 'Stock' }).count() > 0 && await page.locator('.bs-back').count() === 0, 'GM: More → Stock opens Stock and the sheet goes');
  check(await page.locator('.tabbar .tab.active .tab-label').innerText() === 'More', 'GM: on Stock the bar highlights More');
  await shot(page, 'approver-stock');
  // New → Request a payment
  await page.click('#tab-new'); await page.waitForTimeout(400);
  await page.locator('.bs-row', { hasText: 'Request a payment' }).click(); await page.waitForTimeout(1500);
  check(/#\/requests\/new\/cash/.test(page.url()) && /Request a payment/.test(await page.locator('main h1').first().innerText()), 'GM: New → Request a payment opens the form');
  // New → Suggest an item opens the window
  await page.click('#tab-new'); await page.waitForTimeout(400);
  await page.locator('.bs-row', { hasText: 'Suggest an item' }).click(); await page.waitForTimeout(800);
  check(await page.locator('.modal h2', { hasText: 'Suggest an item' }).count() === 1, 'GM: New → Suggest an item opens the window');
  await ctx.close();
}

/* numbers: on the screen where the work is */
{
  const { ctx, page } = await open('approver', '#/home');
  const reqN = await page.locator('.tabbar .tab[data-key="requests"] .count').evaluate((e) => (e.style.display === 'none' ? 0 : Number(e.textContent)));
  check(reqN > 0, `GM: Requests shows what waits for the GM (${reqN})`);
  check(await page.locator('.tabbar .tab[data-key="home"] .count').count() === 0, 'GM: no number on Home (Home lists it all)');
  await ctx.close();
}

/* #/more page (e.g. an old link) lists the same, Stock included */
{
  const { ctx, page } = await open('approver', '#/more');
  const t = await page.$$eval('main .bs-row strong', (els) => els.map((e) => e.textContent));
  check(t.includes('Stock') && !t.includes('Requests'), `#/more page: ${t.join(', ')}`);
  await ctx.close();
}

/* a computer: no bottom bar, the side menu with icons */
{
  const { ctx, page } = await open('approver', '#/home', { w: 1280, hgt: 800 });
  check(!(await page.locator('.tabbar').isVisible()) && await page.locator('.side .nav a svg.ic').count() >= 7, 'computer: side menu with icons, no bottom bar');
  check(/^Stock$/.test((await page.locator('.side .nav a[href="#/stock"] .nav-l').innerText()).trim()), 'computer: the side menu still reads Stock');
  await ctx.close();
}

/* a phone on its side: the bar is a rail on the left, New included */
{
  const { ctx, page } = await open('finance', '#/home', { w: 844, hgt: 390 });
  const r = await page.locator('.tabbar').boundingBox();
  check(r && r.width < 100 && r.height > 300 && await page.locator('#tab-new').isVisible(), 'phone on its side: a rail with New');
  await ctx.close();
}

/* small phone: nothing spills sideways */
{
  const { ctx, page } = await open('finance', '#/home', { w: 320, hgt: 640 });
  const ok = await page.evaluate(() => [...document.querySelectorAll('.tabbar .tab')].every((t) => t.getBoundingClientRect().right <= window.innerWidth + 1) && document.documentElement.scrollWidth <= window.innerWidth + 1);
  check(ok, '320px phone: the five buttons fit');
  await ctx.close();
}

/* typing: the bar steps aside, spelling is checked; an opened item list sits above the bar */
{
  const { ctx, page } = await open('stock_manager', '#/requests/new/stock', { w: 390, hgt: 700 });
  const box = page.locator('main textarea:visible, main input.input:visible').first();
  await box.focus(); await page.waitForTimeout(400);
  check(await page.evaluate(() => document.documentElement.classList.contains('typing') && document.querySelector('.tabbar').getBoundingClientRect().top >= window.innerHeight - 2), 'typing: the bar steps aside');
  check((await box.getAttribute('spellcheck')) === 'true', 'typing: spelling is checked');
  await page.locator('main h1').click(); await page.waitForTimeout(500);
  check(!(await page.evaluate(() => document.documentElement.classList.contains('typing'))), 'done typing: the bar comes back');
  const face = page.locator('.picker-face').first();
  if (await face.count()) {
    await face.click(); await page.waitForTimeout(900);
    await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(500);
    const ok = await page.evaluate(() => { const p = document.querySelector('.picker.open .picker-panel'); const bar = document.querySelector('.tabbar').getBoundingClientRect().top; return p && p.getBoundingClientRect().bottom <= bar + 1; });
    check(ok, 'an opened item list sits above the bar');
  } else check(false, 'item list found on the stock request');
  await ctx.close();
}

await b.close(); server.close();
console.log(fails.length ? `FAIL tabbar-ui (${fails.length})` : 'PASS tabbar-ui');
process.exit(fails.length ? 1 : 0);
