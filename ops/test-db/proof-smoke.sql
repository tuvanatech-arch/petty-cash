-- Proof of payment: finance decides before pay-out; paper slip must reach finance; no-proof spending needs a note; claims.
\set ON_ERROR_STOP 1
begin;
-- an expected refusal: prints its message instead of aborting the test
create function pg_temp.refused(q text) returns text language plpgsql as $$ begin execute q; return 'NOT REFUSED'; exception when others then return 'refused: ' || sqlerrm; end $$;
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'boss@example.test', '{"full_name":"Ana Boss"}');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000f1', 'money@example.test', '{"full_name":"Filipa Money"}', '{"invited":true,"role":"finance"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@example.test', '{"full_name":"Carlos Staff"}', '{"invited":true,"role":"requester"}');
create function pg_temp.as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, true), set_config('request.jwt.claim.role', 'authenticated', true) $$;
create function pg_temp.req(id uuid, purpose text, amt numeric, typ request_type default 'cash') returns void language sql as $$
  insert into public.requests (id, type, purpose, estimated_total, requester_id) values (id, typ, purpose, amt, '00000000-0000-0000-0000-0000000000c1');
  insert into public.request_lines (request_id, line_no, description, qty, est_unit_price, qty_from_stock) values (id, 1, purpose, 1, amt, 0) $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.open_float(date_trunc('month', current_date)::date, 5000, 'float')).opening_amount is not null as float_open;

-- A: taxi, finance says no proof possible; spender records with a note, no upload; finance confirms
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.req('00000000-0000-0000-0000-00000000000a', 'Taxi to the bank', 120);
select 'A submitted', (public.submit_request('00000000-0000-0000-0000-00000000000a')).status;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select 'A gm cannot decide proof (expect error)', pg_temp.refused($q$select public.set_proof_rule('00000000-0000-0000-0000-00000000000a', 'none', 'taxi')$q$);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select 'A no reason (expect error)', pg_temp.refused($q$select public.set_proof_rule('00000000-0000-0000-0000-00000000000a', 'none', '')$q$);
select 'A finance: no proof', (public.set_proof_rule('00000000-0000-0000-0000-00000000000a', 'none', 'Taxi – no slips')).proof_rule;
select 'A paid', (public.disburse_request('00000000-0000-0000-0000-00000000000a', 120)).status;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select 'A no note (expect error)', pg_temp.refused($q$select public.record_expense('00000000-0000-0000-0000-00000000000a', current_date, '[{"description":"Taxi","qty":1,"unit_price":120}]')$q$);
select 'A spent', (public.record_expense('00000000-0000-0000-0000-00000000000a', current_date, '[{"description":"Taxi","qty":1,"unit_price":120}]', 'Taxi from office to FNB Independence Ave')).total;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select 'A confirmed', (public.finance_review_expense('00000000-0000-0000-0000-00000000000a', 'confirm')).status;

-- B: proof required with a paper slip: stays open until paper received
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.req('00000000-0000-0000-0000-00000000000b', 'Printer paper', 150);
select 'B submitted', (public.submit_request('00000000-0000-0000-0000-00000000000b')).status;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.approve_request('00000000-0000-0000-0000-00000000000b', 'ok')).status where (select status from public.requests where id = '00000000-0000-0000-0000-00000000000b') = 'pending_approval';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select 'B paid', (public.disburse_request('00000000-0000-0000-0000-00000000000b', 150)).status;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select 'B no upload (expect error)', pg_temp.refused($q$select public.record_expense('00000000-0000-0000-0000-00000000000b', current_date, '[{"description":"Paper","qty":1,"unit_price":140}]')$q$);
insert into public.expense_proofs (expense_id, storage_path, file_name, mime, uploaded_by) select id, 'p/x.jpg', 'x.jpg', 'image/jpeg', '00000000-0000-0000-0000-0000000000c1' from public.expenses where request_id = '00000000-0000-0000-0000-00000000000b';
select 'B slip not answered (expect error)', pg_temp.refused($q$select public.record_expense('00000000-0000-0000-0000-00000000000b', current_date, '[{"description":"Paper","qty":1,"unit_price":140}]')$q$);
select public.set_paper_slip('00000000-0000-0000-0000-00000000000b', true);
select 'B spent', (public.record_expense('00000000-0000-0000-0000-00000000000b', current_date, '[{"description":"Paper","qty":1,"unit_price":140}]')).total;
select 'B status', status, (select proof_status from public.expenses where request_id = r.id) from public.requests r where id = '00000000-0000-0000-0000-00000000000b';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select 'B confirm before paper (expect error)', pg_temp.refused($q$select public.finance_review_expense('00000000-0000-0000-0000-00000000000b', 'confirm')$q$);
select 'B paper received', (public.finance_review_expense('00000000-0000-0000-0000-00000000000b', 'physical_received')).status;

-- C: finance cannot waive proof on own request
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
insert into public.requests (id, type, purpose, estimated_total, requester_id) values ('00000000-0000-0000-0000-00000000000c', 'cash', 'Own taxi', 80, '00000000-0000-0000-0000-0000000000f1');
insert into public.request_lines (request_id, line_no, description, qty, est_unit_price, qty_from_stock) values ('00000000-0000-0000-0000-00000000000c', 1, 'Taxi', 1, 80, 0);
select 'C submitted', (public.submit_request('00000000-0000-0000-0000-00000000000c')).status;
select 'C own (expect error)', pg_temp.refused($q$select public.set_proof_rule('00000000-0000-0000-0000-00000000000c', 'none', 'taxi')$q$);

-- D: claim without receipt: sent with reason; not repaid until finance marks no proof
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.req('00000000-0000-0000-0000-00000000000d', 'Parking at client', 30, 'claim');
insert into public.expenses (request_id, spent_by, spent_at, total) values ('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000c1', current_date, 0);
select 'D no receipt, no reason (expect error)', pg_temp.refused($q$select public.submit_request('00000000-0000-0000-0000-00000000000d')$q$);
select public.claim_without_receipt('00000000-0000-0000-0000-00000000000d', 'Street parking attendant, no slips');
select 'D sent', (public.submit_request('00000000-0000-0000-0000-00000000000d')).status;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select 'D approve if needed', (select status from public.requests where id = '00000000-0000-0000-0000-00000000000d');
select (public.approve_request('00000000-0000-0000-0000-00000000000d', 'ok')).status where (select status from public.requests where id = '00000000-0000-0000-0000-00000000000d') = 'pending_approval';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select 'D repay before decision (expect error)', pg_temp.refused($q$select public.disburse_request('00000000-0000-0000-0000-00000000000d', 30)$q$);
select 'D no proof', (public.set_proof_rule('00000000-0000-0000-0000-00000000000d', 'none', 'Parking attendant')).proof_rule;
select 'D repaid', (public.disburse_request('00000000-0000-0000-0000-00000000000d', 30)).status;

select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select 'no-proof list', jsonb_array_length(public.no_proof_list()), public.no_proof_list()->0->>'reason';
rollback;
