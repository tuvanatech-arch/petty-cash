// Branches in the preview: the GM and the MD get a switcher and see every branch; finance and requesters see only their own;
// one branch at a time for cash and the store; the Admin → Branches tab.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import path from 'node:path';
const root = path.resolve('demo');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { let p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; if (!existsSync(p)) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(readFileSync(p)); });
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
const fails = []; const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch(); const page = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const as = async (role, hash, view = null) => { await page.goto(base + '#/home'); await page.evaluate(([r, v]) => { localStorage.setItem('demo_role', r); localStorage.setItem('pcs_push_asked', 'later'); if (v) localStorage.setItem('demo_view', v); else localStorage.removeItem('demo_view'); }, [role, view]); await page.goto(base + '#' + hash); await page.reload(); await page.waitForTimeout(800); };
const text = () => page.locator('main').innerText();
const LUD = '00000082-0000-4000-8000-000000000000';

/* ---- the GM, looking at all branches ---- */
await as('approver', '/home');
let t = await text();
check(await page.locator('select.branch-switch.side-branch').count() === 1, 'GM: the branch switcher is in the menu');
check(/Windhoek/.test(t) && /Lüderitz/.test(t) && (t.match(/In the box/g) || []).length === 2, 'GM Home (all branches): one float card per branch');
check(/Harbour permit renewal/.test(t), 'GM Home: a Lüderitz request waits for approval alongside Windhoek ones');
await as('approver', '/requests');
check(await page.locator('.branch-tag').count() > 0, 'GM Requests (all branches): rows carry a branch tag');
await as('approver', '/stock');
check(/Which branch's store/.test(await text()), 'GM Stock (all branches): asked which store');
await as('approver', '/reports');
check(/Reports · all branches/.test(await text()), 'GM Reports: titled for all branches');

/* ---- the GM, looking at Lüderitz only ---- */
await page.locator('select.branch-switch.side-branch').selectOption(LUD); await page.waitForTimeout(900);
check(/Reports · Lüderitz/.test(await text()), 'switcher: Reports narrows to Lüderitz');
await page.goto(base + '#/home'); await page.waitForTimeout(800); t = await text();
check(/Harbour permit renewal/.test(t) && !/Taxi to Bank Windhoek/.test(t) && (t.match(/In the box/g) || []).length === 1, 'GM Home (Lüderitz): only Lüderitz\'s float and requests');
await page.goto(base + '#/cash'); await page.waitForTimeout(800); t = await text();
check(/Petty cash · Lüderitz/.test(t) && /N\$1,360\.00/.test(t), 'GM Petty cash (Lüderitz): the Lüderitz float, no chooser');
await page.goto(base + '#/stock'); await page.waitForTimeout(800); t = await text();
check(/Coffee 750 g/.test(t) && !/Toner HP 26A/.test(t), 'GM Stock (Lüderitz): only the Lüderitz store');
await page.goto(base + '#/requests'); await page.waitForTimeout(800);
check(await page.locator('.branch-tag').count() === 0 && /Harbour permit/.test(await text()), 'GM Requests (Lüderitz): no tags, Lüderitz rows only');

/* ---- Admin → Branches and People ---- */
await as('approver', '/admin/branches');
t = await text();
check(/Windhoek/.test(t) && /Lüderitz/.test(t) && /Nangula Iipinge/.test(t) && /N\$2,000\.00/.test(t) && /How branches work/.test(t), 'Admin → Branches: both branches with custodian and usual float');
await page.locator('main button:has-text("Add branch")').click(); await page.waitForTimeout(300);
check(/Short code/.test(await page.locator('.modal').innerText()) && /Copy the Windhoek catalogue/.test(await page.locator('.modal').innerText()), 'Add branch: name, code, usual float, copy the catalogue');
await page.keyboard.press('Escape');
await as('approver', '/admin');
t = await text();
check(/Branch/.test(t) && /All branches/.test(t) && /Lüderitz/.test(t), 'Admin → People: a branch column (the GM covers all)');
await page.locator('main button:has-text("Edit")').first().click(); await page.waitForTimeout(300);
check(/Home branch/.test(await page.locator('.modal').innerText()) && /Also covers/.test(await page.locator('.modal').innerText()), 'Edit person: home branch and the branches they also cover');
await page.keyboard.press('Escape');

/* ---- the MD ---- */
await as('managing_director', '/home');
t = await text();
check(await page.locator('select.branch-switch.side-branch').count() === 1 && /Overview/.test(t) && /Windhoek N\$/.test(t) && /Lüderitz N\$/.test(t), 'MD: switcher, and the overview adds the branches up');

/* ---- finance and a requester: one branch, nothing new ---- */
await as('finance', '/home');
t = await text();
check(await page.locator('select.branch-switch').count() === 0 && !/Harbour permit/.test(t) && !/Lüderitz/.test(t), 'finance (Windhoek): no switcher, no Lüderitz');
await as('finance', '/cash');
check(/Petty cash/.test(await text()) && !/Which branch/.test(await text()), 'finance: straight into their own petty cash');
await as('requester', '/home');
check(await page.locator('select.branch-switch').count() === 0, 'requester: no switcher');

check(!errs.length, `no page errors (${errs.join(' | ')})`);
await b.close(); server.close();
console.log(fails.length ? `BRANCHES UI: FAIL (${fails.length})` : 'BRANCHES UI: PASS');
process.exit(fails.length ? 1 : 0);
