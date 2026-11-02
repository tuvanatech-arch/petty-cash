-- Two-step sign-in and the logo store: who is let in, at which sign-in level, before and after the date. Every line should say ok.
\set ON_ERROR_STOP 1
begin;
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'boss@example.test', '{"full_name":"Ana Boss"}');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000f1', 'money@example.test', '{"full_name":"Filipa Money"}', '{"invited":true,"role":"finance"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@example.test', '{"full_name":"Carlos Staff"}', '{"invited":true,"role":"requester"}');
create function pg_temp.as_user(u uuid, aal text default 'aal1') returns void language sql as $$
  select set_config('request.jwt.claim.sub', u::text, true), set_config('request.jwt.claim.role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', u, 'aal', aal)::text, true) $$;
create function pg_temp.ok(what text, cond boolean) returns text language sql as $$ select case when coalesce(cond, false) then 'ok   ' else 'FAIL ' end || what $$;
create function pg_temp.when_due(d date) returns void language sql as $$
  update public.settings set two_step_from = d where id = 1 $$;

select pg_temp.ok('two-step becomes required two weeks after the release', (select two_step_from from public.settings where id = 1) = current_date + 14);
select pg_temp.ok('for finance, the GM and the MD', (select two_step_roles from public.settings where id = 1) = '{finance,approver,managing_director}');

-- before the date: everyone works as before
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok('before the date, finance without two-step still works', public.has_role('finance') and public.my_role() = 'finance' and not public.two_step_blocked());
select pg_temp.ok('the app is told it is required, by when', (public.my_two_step() ->> 'required')::boolean and (public.my_two_step() ->> 'from')::date = current_date + 14 and not (public.my_two_step() ->> 'enabled')::boolean);

-- after the date: finance without it is blocked everywhere, a requester is not
reset role; select pg_temp.when_due(current_date - 1);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok('after the date, finance without two-step is blocked', public.two_step_blocked() and not public.has_role('finance') and public.my_role() is null and public.my_roles() is null);
select pg_temp.ok('the app can still read why', (public.my_two_step() ->> 'blocked')::boolean);
set local role authenticated;
select pg_temp.ok('no table opens for a blocked sign-in (settings)', (select count(*) from public.settings) = 0);
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok('a requester is not required to have it', not public.two_step_blocked() and public.my_role() = 'requester');
set local role authenticated;
select pg_temp.ok('a requester still reads the settings', (select count(*) from public.settings) = 1);
reset role;

-- finance sets it up: a sign-in without the code is blocked, with the code it works
insert into auth.mfa_factors (user_id, status) values ('00000000-0000-0000-0000-0000000000f1', 'verified');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1', 'aal1');
select pg_temp.ok('with two-step set up, password alone opens nothing', public.two_step_blocked() and not public.has_role('finance'));
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1', 'aal2');
select pg_temp.ok('with the code given, finance works again', not public.two_step_blocked() and public.has_role('finance') and public.my_role() = 'finance');
set local role authenticated;
select pg_temp.ok('and the tables open', (select count(*) from public.settings) = 1);
reset role;

-- a requester who chose to set it up is held to it too
insert into auth.mfa_factors (user_id, status) values ('00000000-0000-0000-0000-0000000000c1', 'verified');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1', 'aal1');
select pg_temp.ok('anyone who set it up needs the code', public.two_step_blocked());
-- an unfinished set-up does not count
reset role;
insert into auth.mfa_factors (user_id, status) values ('00000000-0000-0000-0000-0000000000a1', 'unverified');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal1');
select pg_temp.ok('a set-up never finished does not count as set up', (public.my_two_step() ->> 'enabled')::boolean = false);

-- the GM sees who has it; others do not
reset role; select pg_temp.when_due(current_date + 30);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1', 'aal1');
select pg_temp.ok('the GM sees who has two-step sign-in', (select count(*) from public.two_step_people() where enabled) = 2);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1', 'aal2');
select pg_temp.ok('finance does not', (select count(*) from public.two_step_people()) = 0);

-- the logo store: public, and only the GM may put a logo there
select pg_temp.ok('the logo store is public', (select public from storage.buckets where id = 'branding'));
select pg_temp.ok('only the GM may upload a logo', exists (select 1 from pg_policies where tablename = 'objects' and policyname = 'branding_admin_insert' and with_check like '%approver%'));
select pg_temp.ok('every table carries the two-step rule', not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.policyname = 'two_step_required')));
rollback;
