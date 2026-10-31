-- A request from start to finish on a fresh installation, as three different people, plus the reports.
-- Run on a database built with ops/new-client.mjs (or the replay); everything happens inside one transaction and is rolled back.
\set ON_ERROR_STOP 1
begin;
-- people: the first account becomes the administrator (approver); the others come in by invitation
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'boss@example.test', '{"full_name":"Ana Boss"}');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000f1', 'money@example.test', '{"full_name":"Filipa Money"}', '{"invited":true,"role":"finance"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@example.test', '{"full_name":"Carlos Staff"}', '{"invited":true,"role":"requester"}');
select 'people' as step, string_agg(full_name || '=' || role, ', ' order by full_name) from public.profiles;

create function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', u::text, true), set_config('request.jwt.claim.role', 'authenticated', true) $$;

-- the GM opens this month's float
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select 'float' as step, (public.open_float(date_trunc('month', current_date)::date, 5000, 'first float')).opening_amount;

-- a requester asks for cash above the threshold, so it needs approval
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
insert into public.requests (id, type, purpose, estimated_total, requester_id)
  values ('00000000-0000-0000-0000-00000000aaaa', 'cash', 'Printer toner', 450, '00000000-0000-0000-0000-0000000000c1');
insert into public.request_lines (request_id, line_no, description, qty, est_unit_price, qty_from_stock)
  values ('00000000-0000-0000-0000-00000000aaaa', 1, 'Toner cartridge', 1, 450, 0);
select 'submitted' as step, (public.submit_request('00000000-0000-0000-0000-00000000aaaa')).status;

-- the GM approves, finance pays out, the requester records what was spent
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select 'approved' as step, (public.approve_request('00000000-0000-0000-0000-00000000aaaa', 'ok')).status;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select 'paid' as step, (public.disburse_request('00000000-0000-0000-0000-00000000aaaa', 450)).status;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
insert into public.expense_proofs (expense_id, storage_path, file_name, mime, uploaded_by)
  select e.id, 'proofs/test.jpg', 'test.jpg', 'image/jpeg', '00000000-0000-0000-0000-0000000000c1'
  from public.expenses e where e.request_id = '00000000-0000-0000-0000-00000000aaaa';
select 'spent' as step, (public.record_expense('00000000-0000-0000-0000-00000000aaaa', current_date, '[{"description":"Toner","qty":1,"unit_price":430}]'::jsonb)).total;

-- what everyone was told, and how money reads in this client's currency
select 'alerts' as step, count(*), string_agg(distinct kind, ',') from public.notifications;
select 'money' as step, public.money_text(1234.5);
select 'time zone' as step, public.app_tz();

-- the reports the MD and finance read
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select 'kpis' as step, jsonb_array_length(public.kpis(current_date)->'kpis');
select 'summary' as step, (public.management_summary(current_date)->>'spent');
select 'journal' as step, count(*) from public.journal(current_date);
select 'exceptions' as step, count(*) from public.exceptions_log((current_date - 30));
select 'ledger' as step, count(*) from public.cash_ledger((select id from public.floats limit 1));
rollback;
