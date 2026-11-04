-- The outlook counts the box and the bank together (050). Every line should say ok.
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(what text, cond boolean) returns text language sql as $$ select case when coalesce(cond, false) then 'ok   ' else 'FAIL ' end || what $$;
create function pg_temp.as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, true), set_config('request.jwt.claim.role', 'authenticated', true) $$;
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'boss@example.test', '{"full_name":"Ana Boss"}');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000f1', 'money@example.test', '{"full_name":"Filipa Money"}', '{"invited":true,"role":"finance"}');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.open_float(date_trunc('month', current_date)::date, 1000, 'first float')).id is not null as float_opened;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok('no bank account: the outlook is the box, as before',
  (select (o ->> 'after_approval')::numeric = 1000 and (o ->> 'box_after')::numeric = 1000 from (select public.outlook_for(null, null) o) x));
select public.set_petty_bank('FNB petty cash', 2500, 'statement 31 Oct') is not null as bank_added;
select pg_temp.ok('with the bank: left after commitments = box + bank, the box alone shown apart',
  (select (o ->> 'after_approval')::numeric = 3500 and (o ->> 'box_after')::numeric = 1000 and (o ->> 'bank_balance')::numeric = 2500 from (select public.outlook_for(null, null) o) x));
rollback;
