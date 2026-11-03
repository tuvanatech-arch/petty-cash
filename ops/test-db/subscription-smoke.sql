-- The subscription: the plan's limits on people and branches, cancelling and keeping Petti, and what the daily
-- health check says. Every line should say ok.
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(what text, cond boolean) returns text language sql as $$ select case when coalesce(cond, false) then 'ok   ' else 'FAIL ' end || what $$;
create function pg_temp.as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, true), set_config('request.jwt.claim.role', 'authenticated', true) $$;
create function pg_temp.has(p text) returns boolean language sql as $$ select exists (select 1 from jsonb_array_elements(public.health_report()->'problems') x where x->>'problem' like p) $$;
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'boss@example.test', '{"full_name":"Ana Boss"}');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000f1', 'money@example.test', '{"full_name":"Filipa Money"}', '{"invited":true,"role":"finance"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@example.test', '{"full_name":"Carlos Staff"}', '{"invited":true,"role":"requester"}');
update public.settings set org_name = 'Example Trading' where id = 1;

-- no plan yet: no limits, nothing to cancel
select pg_temp.ok('no plan yet: no limit, a person can be added', public.plan_status()->>'plan' is null and (public.plan_status()->>'can_add_person')::boolean and (public.plan_status()->>'people_used')::int = 3);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin perform public.cancel_subscription('Example Trading'); raise notice 'FAIL cancelled without a plan';
  exception when others then raise notice 'ok   without a plan there is nothing to cancel (%)', left(sqlerrm, 45); end $$;
reset role; select set_config('request.jwt.claim.sub', '', true);

-- a Starter plan of 3 people and 1 branch: full
update public.subscription set plan = 'starter', people_limit = 3, branch_limit = 1 where id = 1;
select pg_temp.ok('Starter, 3 of 3 places used: no more can be added', public.plan_status()->>'plan_label' = 'Starter' and not (public.plan_status()->>'can_add_person')::boolean);
do $$ begin
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ('00000000-0000-0000-0000-0000000000d1', 'four@example.test', '{"full_name":"Dina Four"}', '{"invited":true,"role":"requester"}');
  raise notice 'FAIL a fourth person was added to a full plan';
exception when others then raise notice 'ok   a fourth person is refused, with the reason: %', left(sqlerrm, 70); end $$;
update public.profiles set active = false where id = '00000000-0000-0000-0000-0000000000c1';
select pg_temp.ok('switching someone off frees their place', (public.plan_status()->>'can_add_person')::boolean);
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ('00000000-0000-0000-0000-0000000000d1', 'four@example.test', '{"full_name":"Dina Four"}', '{"invited":true,"role":"requester"}');
select pg_temp.ok('so someone new can be added', exists (select 1 from public.profiles where id = '00000000-0000-0000-0000-0000000000d1' and active));
do $$ begin update public.profiles set active = true where id = '00000000-0000-0000-0000-0000000000c1'; raise notice 'FAIL switched someone back on beyond the plan';
  exception when others then raise notice 'ok   switching someone back on beyond the plan is refused'; end $$;
update public.profiles set full_name = 'Filipa M.' where id = '00000000-0000-0000-0000-0000000000f1';
select pg_temp.ok('editing a person who is already on is not affected by a full plan', (select full_name = 'Filipa M.' from public.profiles where id = '00000000-0000-0000-0000-0000000000f1'));
do $$ begin insert into public.branches (company_id, name, code) select company_id, 'Second', 'SEC' from public.branches limit 1; raise notice 'FAIL a second branch went in';
  exception when others then raise notice 'ok   a second branch is refused on a one-branch plan: %', left(sqlerrm, 50); end $$;

-- cancelling
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
do $$ begin perform public.cancel_subscription('Example Trading'); raise notice 'FAIL a requester cancelled';
  exception when others then raise notice 'ok   only the administrator can cancel'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin perform public.cancel_subscription('Example'); raise notice 'FAIL cancelled with the wrong name';
  exception when others then raise notice 'ok   the company name must be typed exactly (%)', left(sqlerrm, 40); end $$;
select pg_temp.ok('cancelled, with the name typed in any case', (public.cancel_subscription(' example trading ')->>'status') = 'cancelled');
select pg_temp.ok('removal set 30 days ahead, with who cancelled', (select remove_on = current_date + 30 and cancelled_by = '00000000-0000-0000-0000-0000000000a1' from public.subscription));
select pg_temp.ok('finance is told, with the date', exists (select 1 from public.notifications where user_id = '00000000-0000-0000-0000-0000000000f1' and kind = 'subscription' and body like '%removed for good on%'));
select pg_temp.ok('anyone signed in sees it is cancelled and when', (public.plan_status()->>'status') = 'cancelled' and public.plan_status()->>'remove_on' is not null and public.plan_status()->>'cancelled_by' = 'Ana Boss');
do $$ begin perform public.cancel_subscription('Example Trading'); raise notice 'FAIL cancelled twice';
  exception when others then raise notice 'ok   cancelling twice is refused'; end $$;
set local role authenticated;
do $$ declare n int; begin update public.subscription set people_limit = 99; get diagnostics n = row_count; raise notice '%', case when n = 0 then 'ok   the subscription cannot be changed from the app' else 'FAIL the app changed the subscription' end;
  exception when insufficient_privilege then raise notice 'ok   the subscription cannot be changed from the app'; end $$;
reset role; select set_config('request.jwt.claim.sub', '', true);
select pg_temp.ok('the health check tells Tuvana Tech on the day', pg_temp.has('The client cancelled Petti') and not pg_temp.has('Removal is due%'));

-- keeping Petti
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok('kept within the 30 days: active again', (public.keep_subscription()->>'status') = 'active');
select pg_temp.ok('and no removal date', (select remove_on is null and cancelled_at is null from public.subscription));
reset role; select set_config('request.jwt.claim.sub', '', true);
select pg_temp.ok('and the health check is quiet about it', not pg_temp.has('%cancelled Petti%'));

-- the removal date arrives
update public.subscription set status = 'cancelled', cancelled_at = now() - interval '30 days', remove_on = current_date where id = 1;
select pg_temp.ok('on the removal date the health check says to remove it', pg_temp.has('Removal is due%') and not pg_temp.has('The client cancelled Petti'));
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin perform public.keep_subscription(); raise notice 'FAIL kept after the removal date';
  exception when others then raise notice 'ok   it can no longer be kept once the date has come'; end $$;
rollback;
