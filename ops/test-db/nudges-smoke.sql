-- Follow-up nudges: the confirmation to the person who submits, the chase of whoever holds a waiting request, and the
-- word to the person who asked. Every line should say ok.
\set ON_ERROR_STOP 1
begin;
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'boss@example.test', '{"full_name":"Ana Boss"}');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000f1', 'money@example.test', '{"full_name":"Filipa Money"}', '{"invited":true,"role":"finance"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@example.test', '{"full_name":"Carlos Staff"}', '{"invited":true,"role":"requester"}');
create function pg_temp.as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, true), set_config('request.jwt.claim.role', 'authenticated', true) $$;
create function pg_temp.req(id uuid, purpose text, amt numeric) returns void language sql as $$
  insert into public.requests (id, type, purpose, estimated_total, requester_id) values (id, 'cash', purpose, amt, '00000000-0000-0000-0000-0000000000c1');
  insert into public.request_lines (request_id, line_no, description, qty, est_unit_price, qty_from_stock) values (id, 1, purpose, 1, amt, 0) $$;
create function pg_temp.ok(what text, cond boolean) returns text language sql as $$ select case when coalesce(cond, false) then 'ok   ' else 'FAIL ' end || what $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.open_float(date_trunc('month', current_date)::date, 5000, 'float')).opening_amount is not null as float_open;

-- a small request goes to finance; the person who sent it is told, in the app, without a phone alert
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.req('00000000-0000-0000-0000-0000000000d1', 'Taxi to the bank', 120);
select 'submitted to', (public.submit_request('00000000-0000-0000-0000-0000000000d1')).status;
select pg_temp.ok('confirmation written for the requester, saying finance has it',
  exists (select 1 from public.notifications where user_id = '00000000-0000-0000-0000-0000000000c1' and kind = 'submitted'
    and request_id = '00000000-0000-0000-0000-0000000000d1' and body like '%finance to pay out%' and read_at is null));
select pg_temp.ok('the confirmation is never emailed', (select email_status from public.notifications where kind = 'submitted' limit 1) = 'in_app_only');
select pg_temp.ok('only one confirmation', (select count(*) from public.notifications where kind = 'submitted') = 1);

-- a large one needs the GM
select pg_temp.req('00000000-0000-0000-0000-0000000000d2', 'New laptop for finance', 25000);
select 'large submitted to', (public.submit_request('00000000-0000-0000-0000-0000000000d2')).status, (select approval_level from public.requests where id = '00000000-0000-0000-0000-0000000000d2');
select pg_temp.ok('large request: confirmation names the approver',
  exists (select 1 from public.notifications where kind = 'submitted' and request_id = '00000000-0000-0000-0000-0000000000d2' and body ~ 'the (GM|MD) for approval'));

-- saving a draft says nothing
select pg_temp.req('00000000-0000-0000-0000-0000000000d3', 'Still a draft', 50);
select pg_temp.ok('a draft is silent', not exists (select 1 from public.notifications where request_id = '00000000-0000-0000-0000-0000000000d3'));

-- working days: a Friday-to-Monday gap is one working day, not three
select pg_temp.ok('working days skip the weekend',
  public.working_days_since((date_trunc('week', now() at time zone public.app_tz()) - interval '3 days' + interval '12 hours') at time zone public.app_tz()) between 0 and 5);
select pg_temp.ok('nothing waited yet today', public.working_days_since(now()) = 0);

-- waiting: pretend both have sat for ten days, then run the morning reminder
reset role;
set local session_replication_role = replica;      -- let the test back-date without the usual bookkeeping
update public.requests set updated_at = now() - interval '10 days' where id in ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2');
set local session_replication_role = origin;
select set_config('request.jwt.claim.sub', '', true);
select 'reminders sent', public.remind_stale_items();
select pg_temp.ok(case when extract(isodow from now() at time zone public.app_tz()) > 5
    then 'weekend: nothing is sent' else 'finance told the payout is waiting' end,
  case when extract(isodow from now() at time zone public.app_tz()) > 5
    then not exists (select 1 from public.notifications where kind in ('stale', 'chased', 'stale_escalation'))
    else exists (select 1 from public.notifications where kind = 'stale' and user_id = '00000000-0000-0000-0000-0000000000f1' and request_id = '00000000-0000-0000-0000-0000000000d1') end);
select pg_temp.ok('the person who asked is told it was chased (weekday only)',
  extract(isodow from now() at time zone public.app_tz()) > 5
  or exists (select 1 from public.notifications where kind = 'chased' and user_id = '00000000-0000-0000-0000-0000000000c1' and request_id = '00000000-0000-0000-0000-0000000000d1' and body like '%finance%We have reminded them.'));
select pg_temp.ok('the GM hears the payout is stuck (weekday only)',
  extract(isodow from now() at time zone public.app_tz()) > 5
  or exists (select 1 from public.notifications where kind = 'stale_escalation' and user_id = '00000000-0000-0000-0000-0000000000a1' and request_id = '00000000-0000-0000-0000-0000000000d1'));
-- a second run the same day adds nothing
select count(*) as before_second_run from public.notifications \gset
select 'second run', public.remind_stale_items();
select pg_temp.ok('a second run the same day sends nothing more', (select count(*) from public.notifications) = :before_second_run);

-- the cash-out reminder (it failed unnoticed on live before this release) and the friendly "you still have cash out" message
create function pg_temp.refused(q text) returns text language plpgsql as $$ begin execute q; return 'NOT REFUSED'; exception when others then return 'refused: ' || sqlerrm; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.req('00000000-0000-0000-0000-0000000000d4', 'Courier fee', 90);
select 'd4 submitted', (public.submit_request('00000000-0000-0000-0000-0000000000d4')).status;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select 'd4 approved', (public.approve_request('00000000-0000-0000-0000-0000000000d4', 'ok')).status where (select status from public.requests where id = '00000000-0000-0000-0000-0000000000d4') = 'pending_approval';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select 'd4 paid', (public.disburse_request('00000000-0000-0000-0000-0000000000d4', 90)).status;
reset role;
set local session_replication_role = replica;
update public.requests set disbursed_at = now() - interval '10 days' where id = '00000000-0000-0000-0000-0000000000d4';
set local session_replication_role = origin;
select set_config('request.jwt.claim.sub', '', true);
select 'advance reminders', public.remind_outstanding_advances();
select pg_temp.ok('the person with cash out is reminded to record the receipt',
  exists (select 1 from public.notifications where kind = 'advance_reminder' and user_id = '00000000-0000-0000-0000-0000000000c1' and request_id = '00000000-0000-0000-0000-0000000000d4'));
set local session_replication_role = replica;
update public.settings set block_with_outstanding = true where id = 1;
set local session_replication_role = origin;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.req('00000000-0000-0000-0000-0000000000d5', 'Another taxi', 60);
select pg_temp.ok('submitting while cash is still out gives the plain message, not an error code',
  pg_temp.refused($q$select public.submit_request('00000000-0000-0000-0000-0000000000d5')$q$) like 'refused: You still have%to account for%');
rollback;
