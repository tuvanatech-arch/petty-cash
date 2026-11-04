-- Two-step sign-in by email code (051) and the logo store. Every line should say ok.
\set ON_ERROR_STOP 1
begin;
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'boss@example.test', '{"full_name":"Ana Boss"}');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000f1', 'money@example.test', '{"full_name":"Filipa Money"}', '{"invited":true,"role":"finance"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@example.test', '{"full_name":"Carlos Staff"}', '{"invited":true,"role":"requester"}');
create function pg_temp.as_user(u uuid, sess text default 's1') returns void language sql as $$
  select set_config('request.jwt.claim.sub', u::text, true), set_config('request.jwt.claim.role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', u, 'aal', 'aal1', 'session_id', sess)::text, true) $$;
create function pg_temp.ok(what text, cond boolean) returns text language sql as $$ select case when coalesce(cond, false) then 'ok   ' else 'FAIL ' end || what $$;
create function pg_temp.when_due(d date) returns void language sql as $$ update public.settings set two_step_from = d where id = 1 $$;
-- what account-mail does when it sends a code: store its hash for this sign-in
create function pg_temp.code(u uuid, sess text, c text, mins int default 10) returns void language sql as $$
  insert into public.two_step_codes (user_id, session_id, code_hash, expires_at)
  values (u, sess, encode(sha256(convert_to(c || ':' || sess, 'UTF8')), 'hex'), now() + make_interval(mins => mins)) $$;
create function pg_temp.refused(p_sql text, p_expect text) returns text language plpgsql as $$
begin execute p_sql; return 'FAIL not refused: ' || left(p_sql, 60);
exception when others then return case when sqlerrm like '%' || p_expect || '%' then 'ok   refused: ' || sqlerrm else 'FAIL refused for another reason: ' || sqlerrm end; end $$;

select pg_temp.ok('switched off until email sending works', (select two_step_from from public.settings where id = 1) is null);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok('off: finance works with the password alone', not public.two_step_blocked() and public.has_role('finance'));
select pg_temp.ok('the app is told it is by email, and where the code goes', public.my_two_step() ->> 'method' = 'email' and public.my_two_step() ->> 'email' = 'm•••@example.test');

-- switched on: finance owes a code, a requester does not
reset role; select pg_temp.when_due(current_date - 1);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok('on: finance without the code is blocked', public.two_step_blocked() and not public.has_role('finance') and public.my_role() is null);
set local role authenticated;
select pg_temp.ok('no table opens (settings)', (select count(*) from public.settings) = 0);
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok('a requester is not asked', not public.two_step_blocked() and public.my_role() = 'requester');
-- an authenticator app set up earlier no longer counts either way
insert into auth.mfa_factors (user_id, status) values ('00000000-0000-0000-0000-0000000000c1', 'verified');
select pg_temp.ok('an old authenticator app makes no difference', not public.two_step_blocked());

-- the code
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.refused($$select public.verify_login_code('123456')$$, 'Ask for a code first');
reset role; select pg_temp.code('00000000-0000-0000-0000-0000000000f1', 's1', '482913');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok('a wrong code: no', public.verify_login_code('111111') = false and public.two_step_blocked());
select pg_temp.ok('the right code (spaces allowed): yes', public.verify_login_code('482 913'));
select pg_temp.ok('…and finance works', not public.two_step_blocked() and public.has_role('finance'));
set local role authenticated;
select pg_temp.ok('the tables open', (select count(*) from public.settings) = 1);
reset role;
select pg_temp.ok('a code works once', (select used_at is not null from public.two_step_codes where user_id = '00000000-0000-0000-0000-0000000000f1'));
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1', 's2');
select pg_temp.ok('another sign-in (another phone) needs its own code', public.two_step_blocked());
reset role; select pg_temp.code('00000000-0000-0000-0000-0000000000f1', 's1', '555000');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1', 's2');
select pg_temp.refused($$select public.verify_login_code('555000')$$, 'Ask for a code first');
reset role; select pg_temp.code('00000000-0000-0000-0000-0000000000f1', 's2', '777777', -1);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1', 's2');
select pg_temp.refused($$select public.verify_login_code('777777')$$, 'expired');
reset role; select pg_temp.code('00000000-0000-0000-0000-0000000000f1', 's2', '246810');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1', 's2');
select public.verify_login_code('000001'), public.verify_login_code('000002'), public.verify_login_code('000003'), public.verify_login_code('000004'), public.verify_login_code('000005');
select pg_temp.refused($$select public.verify_login_code('246810')$$, 'Too many tries');
select pg_temp.ok('the codes table is closed to the app', not has_table_privilege('authenticated', 'public.two_step_codes', 'select') or not exists (select 1 from pg_policies where tablename = 'two_step_codes' and permissive = 'PERMISSIVE'));

-- the logo store: public, and only the GM may put a logo there
select pg_temp.ok('the logo store is public', (select public from storage.buckets where id = 'branding'));
select pg_temp.ok('only the GM may upload a logo', exists (select 1 from pg_policies where tablename = 'objects' and policyname = 'branding_admin_insert' and with_check like '%approver%'));
select pg_temp.ok('every table carries the two-step rule', not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.policyname = 'two_step_required')));
rollback;
