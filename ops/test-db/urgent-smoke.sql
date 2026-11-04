-- Urgent requests (049). Every line should say ok.
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(what text, cond boolean) returns text language sql as $$ select case when coalesce(cond, false) then 'ok   ' else 'FAIL ' end || what $$;
create function pg_temp.as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, true), set_config('request.jwt.claim.role', 'authenticated', true) $$;
create function pg_temp.req(p_id uuid, p_purpose text, p_amount numeric) returns void language sql as $$
  insert into public.requests (id, type, purpose, estimated_total, requester_id, no_quote) values (p_id, 'cash', p_purpose, p_amount, auth.uid(), true);
  insert into public.request_lines (request_id, line_no, description, qty, est_unit_price, qty_from_stock) values (p_id, 1, p_purpose, 1, p_amount, 0) $$;
create function pg_temp.refused(p_sql text, p_expect text) returns text language plpgsql as $$
begin execute p_sql; return 'FAIL not refused: ' || left(p_sql, 60);
exception when others then return case when sqlerrm like '%' || p_expect || '%' then 'ok   refused: ' || sqlerrm else 'FAIL refused for another reason: ' || sqlerrm end; end $$;
create function pg_temp.alerts(u uuid, pat text) returns int language sql as $$ select count(*)::int from public.notifications where user_id = u and title like pat $$;

insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'boss@example.test', '{"full_name":"Ana Boss"}');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000e1', 'md@example.test', '{"full_name":"Mika Director"}', '{"invited":true,"role":"managing_director"}'),
  ('00000000-0000-0000-0000-0000000000f1', 'money@example.test', '{"full_name":"Filipa Money"}', '{"invited":true,"role":"finance"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@example.test', '{"full_name":"Carlos Staff"}', '{"invited":true,"role":"requester"}');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.open_float(date_trunc('month', current_date)::date, 5000, 'first float')).id is not null as float_opened;

-- 1. the requester marks the draft urgent and sends it: the GM's alert says so, with the reason
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.req('10000000-0000-0000-0000-000000000001', 'Plumber, burst pipe', 900);
select pg_temp.refused($$select public.set_urgent('10000000-0000-0000-0000-000000000001', true, '')$$, 'Say why it is urgent');
select (public.set_urgent('10000000-0000-0000-0000-000000000001', true, 'Water leaking in the kitchen')).urgent as marked;
select pg_temp.ok('draft: marked by the requester, the clock not started yet',
  (select urgent and urgent_marked_by = '00000000-0000-0000-0000-0000000000c1' and urgent_stage_at is null from public.requests where id = '10000000-0000-0000-0000-000000000001'));
select (public.submit_request('10000000-0000-0000-0000-000000000001')).status;
select pg_temp.ok('sent: the GM gets "Urgent – Needs your approval" with the reason',
  (select count(*) = 1 from public.notifications where user_id = '00000000-0000-0000-0000-0000000000a1' and title like 'Urgent – Needs your approval%' and body like '%Urgent: Water leaking in the kitchen%'));
select pg_temp.ok('…and the clock starts', (select urgent_stage_at is not null from public.requests where id = '10000000-0000-0000-0000-000000000001'));
select pg_temp.refused($$update public.requests set urgent = true, urgent_reason = null where id = '10000000-0000-0000-0000-000000000001'$$, 'requests_urgent_reason');

-- 2. nobody acts: one reminder after 2 hours, the GM is not told about the GM's own queue
update public.requests set urgent_stage_at = now() - interval '3 hours' where id = '10000000-0000-0000-0000-000000000001';
-- the chase runs only in working hours: run it here as though it were Tuesday 10:00 (a copy with that clock)
create or replace function public.urgent_chase_at_10() returns int language plpgsql as $$
declare d text := pg_get_functiondef('public.urgent_chase'::regproc);
begin
  execute replace(replace(d, 'public.urgent_chase()', 'pg_temp.urgent_chase_t()'), 'now() at time zone public.app_tz()', '(date_trunc(''week'', now()) + interval ''1 day 10 hours'')::timestamp');
  return pg_temp.urgent_chase_t();
end $$;
select public.urgent_chase_at_10() as chased;
select pg_temp.ok('reminder: "Still waiting, urgent – " to the GM', pg_temp.alerts('00000000-0000-0000-0000-0000000000a1', 'Still waiting, urgent – Needs your approval%') = 1);
select pg_temp.urgent_chase_t() as again;
select pg_temp.ok('only one reminder per stage', pg_temp.alerts('00000000-0000-0000-0000-0000000000a1', 'Still waiting, urgent%') = 1);
update public.requests set urgent_chased_at = now() - interval '3 hours' where id = '10000000-0000-0000-0000-000000000001';
select pg_temp.urgent_chase_t() as escalate;
select pg_temp.ok('waiting for the GM: no "still waiting" alert to the GM on top', pg_temp.alerts('00000000-0000-0000-0000-0000000000a1', 'Urgent request still waiting%') = 0);

-- 3. approved: finance hears "Urgent – Ready to pay out", the clock starts again; nobody pays: the GM is told
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.approve_request('10000000-0000-0000-0000-000000000001', null)).status;
select pg_temp.ok('finance: "Urgent – Ready to pay out" with the reason',
  (select count(*) = 1 from public.notifications where user_id = '00000000-0000-0000-0000-0000000000f1' and title like 'Urgent – Ready to pay out%' and body like '%Water leaking%'));
select pg_temp.ok('a new stage: the reminder clock starts again',
  (select urgent_chased_at is null and urgent_escalated_at is null and urgent_stage_at > now() - interval '1 minute' from public.requests where id = '10000000-0000-0000-0000-000000000001'));
update public.requests set urgent_stage_at = now() - interval '3 hours' where id = '10000000-0000-0000-0000-000000000001';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');   -- the scheduled job runs as nobody in particular
select pg_temp.urgent_chase_t() as chased;
select pg_temp.ok('finance reminded', pg_temp.alerts('00000000-0000-0000-0000-0000000000f1', 'Still waiting, urgent – Ready to pay out%') = 1);
update public.requests set urgent_chased_at = now() - interval '3 hours' where id = '10000000-0000-0000-0000-000000000001';
select pg_temp.urgent_chase_t() as escalated;
select pg_temp.ok('still not paid: the GM is told it waits for finance',
  (select count(*) = 1 from public.notifications where user_id = '00000000-0000-0000-0000-0000000000a1' and title like 'Urgent request still waiting%' and body like 'Approved, waiting for finance%'));
select pg_temp.ok('the MD is not told about petty cash routine', pg_temp.alerts('00000000-0000-0000-0000-0000000000e1', '%rgent%') = 0);

select pg_temp.ok('outside working hours the real job does nothing', case when extract(isodow from now() at time zone public.app_tz()) > 5 or extract(hour from now() at time zone public.app_tz()) not between 7 and 17 then public.urgent_chase() = 0 else true end);

-- 4. taking the label off: finance with a reason; the requester is told; the history shows it
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.refused($$select public.set_urgent('10000000-0000-0000-0000-000000000001', false, '')$$, 'Say why it is not urgent');
select (public.set_urgent('10000000-0000-0000-0000-000000000001', false, 'Plumber comes Monday')).urgent as still_urgent;
select pg_temp.ok('the requester is told, with the reason',
  (select count(*) = 1 from public.notifications where user_id = '00000000-0000-0000-0000-0000000000c1' and title like 'No longer marked urgent%' and body = 'Plumber comes Monday'));
select pg_temp.ok('the history shows it', (select count(*) = 1 from public.request_events where request_id = '10000000-0000-0000-0000-000000000001' and action = 'unmarked_urgent'));
select pg_temp.refused($$select public.set_urgent('10000000-0000-0000-0000-000000000001', true, 'Again')$$, 'Only the GM or the MD');

-- 5. the GM marks an approved request urgent: finance hears it at once; a requester cannot mark a sent request
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.set_urgent('10000000-0000-0000-0000-000000000001', true, 'Client visit tomorrow')).urgent as marked;
select pg_temp.ok('finance: a second "Urgent – Ready to pay out"', pg_temp.alerts('00000000-0000-0000-0000-0000000000f1', 'Urgent – Ready to pay out%') = 2);
select pg_temp.ok('marked by the GM, in the history', (select urgent_marked_by = '00000000-0000-0000-0000-0000000000a1' from public.requests where id = '10000000-0000-0000-0000-000000000001')
  and (select count(*) = 1 from public.request_events where request_id = '10000000-0000-0000-0000-000000000001' and action = 'marked_urgent'));
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.refused($$select public.set_urgent('10000000-0000-0000-0000-000000000001', false, 'Not any more')$$, 'Only the GM, the MD or finance');
select pg_temp.ok('urgent never skips approval: a N$900 urgent request still went to the GM',
  (select count(*) = 1 from public.request_events where request_id = '10000000-0000-0000-0000-000000000001' and action = 'approved'));
rollback;
