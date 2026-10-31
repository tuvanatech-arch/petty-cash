#!/usr/bin/env node
// Sets up Petti for a new client from one description file.
//
//   node ops/new-client.mjs clients/<slug>.json            builds out/<slug>/ (database setup, client settings, the app, a checklist)
//   node ops/new-client.mjs clients/<slug>.json --apply    also loads the database (needs DATABASE_URL, the client's Postgres connection string)
//                                                          and deploys the server functions (needs SUPABASE_ACCESS_TOKEN)
//
// What it produces in out/<slug>/:
//   install.sql   every setup file in order: the same database MGP runs (verified with ops/test-db)
//   seed.sql      this client's name, company, branch, region, titles, and its own server keys   (contains secrets: never commit)
//   web/          the app, pointed at this client's server
//   CHECKLIST.md  the few steps that need a person (dashboard settings, the first administrator, email)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [, , cfgPath, ...flags] = process.argv;
if (!cfgPath) { console.error('usage: node ops/new-client.mjs clients/<slug>.json [--apply]'); process.exit(1); }
const apply = flags.includes('--apply');
const c = JSON.parse(readFileSync(cfgPath, 'utf8'));

// ---------- check the description ----------
const need = ['slug', 'org_name', 'company_code', 'branch_name', 'branch_code', 'currency', 'currency_code', 'time_zone', 'number_locale', 'supabase_url', 'publishable_key', 'app_url'];
const missing = need.filter((k) => !c[k]);
if (missing.length) { console.error(`missing in ${cfgPath}: ${missing.join(', ')}`); process.exit(1); }
if (!/^[a-z0-9-]+$/.test(c.slug)) { console.error('slug: lowercase letters, digits and hyphens only'); process.exit(1); }
if (!/^[A-Z]{3}$/.test(c.currency_code)) { console.error('currency_code: three capital letters (NAD, AOA, ZAR, BWP…)'); process.exit(1); }
try { new Intl.DateTimeFormat('en', { timeZone: c.time_zone }); } catch { console.error(`time_zone "${c.time_zone}" is not a real time zone`); process.exit(1); }
try { (1).toLocaleString(c.number_locale); } catch { console.error(`number_locale "${c.number_locale}" is not valid`); process.exit(1); }
const titles = { gm: 'GM', gm_long: 'General Manager', md: 'MD', md_long: 'Managing Director', ...(c.titles || {}) };
const url = c.supabase_url.replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url)) { console.error('supabase_url should look like https://<project>.supabase.co'); process.exit(1); }

const out = join(root, 'out', c.slug);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// ---------- install.sql: the setup files, in order ----------
const files = readdirSync(join(root, 'db')).filter((f) => f.endsWith('.sql')).sort();
const install = [`-- Petti installation for ${c.org_name}, built ${new Date().toISOString()} from ${files.length} setup files`, 'set check_function_bodies = on;']
  .concat(files.map((f) => `\n-- ===== ${f} =====\n${readFileSync(join(root, 'db', f), 'utf8')}`)).join('\n');
writeFileSync(join(out, 'install.sql'), install);

// ---------- this installation's own keys ----------
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pubJwk = publicKey.export({ format: 'jwk' }); const privJwk = privateKey.export({ format: 'jwk' });
const vapidPublic = b64url(Buffer.concat([Buffer.from([4]), Buffer.from(pubJwk.x, 'base64url'), Buffer.from(pubJwk.y, 'base64url')]));
const vapidPrivate = b64url(Buffer.from(privJwk.d, 'base64url'));
const cronKey = b64url(randomBytes(24));
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ---------- seed.sql: who this client is ----------
const seed = `-- ${c.org_name}: settings, company, branch and server keys. Contains secrets: keep out of git.
begin;
-- the document references belong to the schedule; setup sets them the way the schedule does
select set_config('pcs.schedule', 'on', true);
update public.settings set org_name = ${q(c.org_name)}, currency = ${q(c.currency)}, number_locale = ${q(c.number_locale)},
  time_zone = ${q(c.time_zone)}, titles = ${q(JSON.stringify(titles))}::jsonb, schedule_ref = ${q(c.schedule_ref || '')}, policy_ref = ${q(c.policy_ref || '')},
  app_url = ${q(c.app_url)}, email_from = ${q(c.email_from || `${c.org_name} <onboarding@resend.dev>`)}, headcount = ${Number(c.headcount) || 0}, updated_at = now()
where id = 1;
update public.companies set name = ${q(c.org_name)}, code = ${q(c.company_code)}, currency = ${q(c.currency)}, currency_code = ${q(c.currency_code)} where is_base;
update public.branches set name = ${q(c.branch_name)}, code = ${q(c.branch_code)} where company_id = (select id from public.companies where is_base);

-- one starting schedule instead of MGP's history of how its schedule grew
do $$
declare v_last uuid := (select id from public.schedule_versions order by version_no desc limit 1);
begin
  delete from public.schedule_versions where id <> v_last;
  update public.schedule_versions set version_no = 1, area = 'start', reason = 'Starting schedule for ${c.org_name.replace(/'/g, "''")}', changes = '[]'::jsonb,
    snapshot = jsonb_set(jsonb_set(snapshot, '{values,schedule_ref}', to_jsonb(${q(c.schedule_ref || '')}::text)), '{values,policy_ref}', to_jsonb(${q(c.policy_ref || '')}::text))
  where id = v_last;
end $$;

insert into public.app_config (key, value) values
  ('functions_url', ${q(url + '/functions/v1')}),
  ('cron_key', ${q(cronKey)}),
  ('vapid_public', ${q(vapidPublic)}),
  ('vapid_private', ${q(vapidPrivate)})
on conflict (key) do update set value = excluded.value, updated_at = now();
commit;
`;
writeFileSync(join(out, 'seed.sql'), seed);

// ---------- web/: the app pointed at this client's server ----------
cpSync(join(root, 'web'), join(out, 'web'), { recursive: true });
writeFileSync(join(out, 'web', 'js', 'config.js'),
  `export const SUPABASE_URL = ${JSON.stringify(url)};\nexport const SUPABASE_KEY = ${JSON.stringify(c.publishable_key)};\nexport const FUNCTIONS_URL = \`\${SUPABASE_URL}/functions/v1\`;\n// the phone-alert key comes from the server (push_public_key)\nexport const VAPID_PUBLIC_KEY = null;\n`);
for (const f of ['netlify.toml', '_redirects']) rmSync(join(out, 'web', f), { force: true });

// ---------- the checklist ----------
const fns = readdirSync(join(root, 'functions'), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'app' && existsSync(join(root, 'functions', d.name, 'index.ts'))).map((d) => d.name);
writeFileSync(join(out, 'CHECKLIST.md'), `# Petti for ${c.org_name}

Server: ${url}  ·  App: ${c.app_url}

1. **Database** – run \`install.sql\` then \`seed.sql\` against the client's database (\`--apply\` does this), then check it:
   \`psql "$DATABASE_URL" -At -F' ' -f ops/test-db/fingerprint-summary.sql\` must match \`ops/reference-fingerprint.txt\`.
2. **Server functions** – deploy ${fns.join(', ')} with JWT checking off (\`--apply\` does this with SUPABASE_ACCESS_TOKEN).
3. **Secrets** (Supabase → Edge Functions → Secrets): \`ANTHROPIC_API_KEY\` (receipt reading), \`RESEND_API_KEY\` (email, once the client's sending domain is verified).
4. **Sign-in settings** (Supabase → Authentication): turn off "Allow new users to sign up"; Site URL = ${c.app_url}.
5. **Publish the app** – the \`web/\` folder, at ${c.app_url}.
6. **First administrator – straight away**: open ${c.app_url}; the first visit creates the administrator. Do it before sharing the link.
7. In the app: Admin → Settings (accountant, accounting package), Admin → Schedule (limits, float, budgets), then invite the team.
`);

console.log(`built out/${c.slug}: install.sql (${files.length} files), seed.sql, web/, CHECKLIST.md`);

// ---------- --apply ----------
if (apply) {
  const db = process.env.DATABASE_URL;
  if (!db) { console.error('--apply needs DATABASE_URL (Supabase → Project settings → Database → connection string)'); process.exit(1); }
  for (const f of ['install.sql', 'seed.sql']) {
    console.log(`loading ${f}…`);
    execFileSync('psql', [db, '-v', 'ON_ERROR_STOP=1', '-q', '-f', join(out, f)], { stdio: 'inherit' });
  }
  const fp = execFileSync('psql', [db, '-At', '-F', ' ', '-f', join(root, 'ops/test-db/fingerprint-summary.sql')]).toString();
  const ref = readFileSync(join(root, 'ops/reference-fingerprint.txt'), 'utf8');
  console.log(fp.trim() === ref.trim() ? 'database matches the reference installation' : `database DIFFERS from the reference:\n${fp}`);
  if (process.env.SUPABASE_ACCESS_TOKEN) {
    const ref = url.replace('https://', '').replace('.supabase.co', '');
    // the Supabase tool looks for supabase/functions/<name>/index.ts
    for (const f of fns) cpSync(join(root, 'functions', f), join(out, 'supabase', 'functions', f), { recursive: true });
    for (const f of fns) execFileSync('npx', ['-y', 'supabase@2', 'functions', 'deploy', f, '--project-ref', ref, '--no-verify-jwt'], { cwd: out, stdio: 'inherit' });
  } else console.log('SUPABASE_ACCESS_TOKEN not set: deploy the server functions by hand (CHECKLIST step 2).');
}
