-- The approval steps on the Schedule and four safeguards (047). Every line should say ok.
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(what text, cond boolean) returns text language sql as $$ select case when coalesce(cond, false) then 'ok   ' else 'FAIL ' end || what $$;
create function pg_temp.as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, true), set_config('request.jwt.claim.role', 'authenticated', true) $$;
create function pg_temp.req(p_id uuid, p_purpose text, p_amount numeric) returns void language sql as $$
  insert into public.requests (id, type, purpose, estimated_total, requester_id) values (p_id, 'cash', p_purpose, p_amount, auth.uid());
  insert into public.request_lines (request_id, line_no, description, qty, est_unit_price, qty_from_stock) values (p_id, 1, p_purpose, 1, p_amount, 0) $$;
create function pg_temp.quote(p_request uuid, p_total numeric) returns void language plpgsql as $$
declare ib uuid := gen_random_uuid(); v_path text := p_request::text || '/' || ib::text || '.pdf';
begin
  insert into public.receipt_inbox (id, user_id, storage_path, file_name, mime, extracted)
  values (ib, auth.uid(), 'inbox/' || auth.uid() || '/' || ib || '.pdf', 'quote.pdf', 'application/pdf', jsonb_build_object('supplier', 'Supplier ' || p_total, 'total', p_total::text));
  insert into storage.objects (bucket_id, name, owner_id) values ('proofs', v_path, auth.uid()::text);
  perform public.file_inbox_document(ib, p_request, v_path, 'quote');
end $$;
create function pg_temp.pop(p_request uuid) returns text language plpgsql as $$
declare v_path text := p_request::text || '/pop-' || gen_random_uuid() || '.pdf';
begin insert into storage.objects (bucket_id, name, owner_id) values ('proofs', v_path, auth.uid()::text); return v_path; end $$;
-- a schedule value set the way the Schedule screen does it, without the MD round (that path is tested once below)
create function pg_temp.set_rule(p jsonb) returns void language plpgsql as $$
begin perform public.schedule_check((public.schedule_snapshot() -> 'values') || p); perform public.schedule_write(p); end $$;
create function pg_temp.level(p uuid) returns text language sql as $$ select coalesce(approval_level, 'none') from public.requests where id = p $$;
create function pg_temp.refused(p_sql text, p_expect text) returns text language plpgsql as $$
begin execute p_sql; return 'FAIL not refused: ' || left(p_sql, 60);
exception when others then return case when sqlerrm like '%' || p_expect || '%' then 'ok   refused: ' || sqlerrm else 'FAIL refused for another reason: ' || sqlerrm end; end $$;

insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'boss@example.test', '{"full_name":"Ana Boss"}');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000e1', 'md@example.test', '{"full_name":"Mika Director"}', '{"invited":true,"role":"managing_director"}'),
  ('00000000-0000-0000-0000-0000000000f1', 'money@example.test', '{"full_name":"Filipa Money"}', '{"invited":true,"role":"finance"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@example.test', '{"full_name":"Carlos Staff"}', '{"invited":true,"role":"requester"}'),
  ('00000000-0000-0000-0000-0000000000d1', 'other@example.test', '{"full_name":"Dina Other"}', '{"invited":true,"role":"requester"}');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.open_float(date_trunc('month', current_date)::date, 5000, 'first float')).id is not null as float_opened;

-- 1. nothing changes until someone edits the Schedule
select pg_temp.ok('starts as before: GM step on, MD step on, "Pay out now" up to what finance pays alone',
  (select gm_step and md_step and quick_payout_limit = approval_threshold from public.settings where id = 1));
select pg_temp.ok('N$150: nobody · N$1,000: the GM · N$6,000: the MD',
  public.approval_level_for(150) is null and public.approval_level_for(1000) = 'gm' and public.approval_level_for(6000) = 'md');
select pg_temp.ok('the steps show on the Schedule (and its history and PDF)',
  (select count(*) = 3 from public.schedule_keys() where k in ('gm_step', 'md_step', 'quick_payout_limit')));
select pg_temp.refused($$update public.settings set md_step = false where id = 1$$, 'changed on the Schedule screen');

-- 2. changing the steps: the GM proposes, the MD approves, then it applies
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.refused($$select public.change_schedule('{"gm_step": false, "md_step": false}', 'test')$$, 'keep the GM step or the MD step');
select pg_temp.refused($$select public.change_schedule('{"quick_payout_limit": 300}', 'test')$$, 'cannot be more than finance pays alone');
select pg_temp.ok('the GM proposes leaving the GM step out', (public.change_schedule('{"gm_step": false}', 'MD approves above petty cash')) ->> 'pending' is not null);
select pg_temp.ok('…which waits for the MD', (select gm_step from public.settings where id = 1));
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok('the MD approves it', (public.decide_schedule((select id from public.schedule_versions where status = 'pending'), true, null)).status = 'applied');
select pg_temp.ok('now N$1,000 goes straight to the MD', public.approval_level_for(1000) = 'md' and public.approval_level_for(150) is null);

-- 3. requests follow the steps; the fixed safeguards stay
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.req('00000000-0000-0000-0000-00000000c001', 'Printer', 1000);
select (public.submit_request('00000000-0000-0000-0000-00000000c001')).status as sent;
select pg_temp.ok('a requester''s N$1,000: the MD', pg_temp.level('00000000-0000-0000-0000-00000000c001') = 'md');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.req('00000000-0000-0000-0000-00000000c002', 'Stamps', 50);
select (public.submit_request('00000000-0000-0000-0000-00000000c002')).status as sent;
select pg_temp.ok('finance''s own N$50: still the GM (fixed)', pg_temp.level('00000000-0000-0000-0000-00000000c002') = 'gm');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.set_rule('{"gm_step": true, "md_step": false}');
select pg_temp.ok('MD step off: N$6,000 is the GM''s', public.approval_level_for(6000) = 'gm');
select pg_temp.req('00000000-0000-0000-0000-00000000c003', 'Laptop', 6000);
select (public.submit_request('00000000-0000-0000-0000-00000000c003')).status as sent;
select pg_temp.ok('…but the GM''s own N$6,000 still goes to the MD (fixed)', pg_temp.level('00000000-0000-0000-0000-00000000c003') = 'md');
select pg_temp.set_rule('{"gm_step": true, "md_step": true}');
-- small requests that add up: the total decides who approves
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
select pg_temp.req('00000000-0000-0000-0000-00000000c004', 'Cables', 150);
select (public.submit_request('00000000-0000-0000-0000-00000000c004')).status as sent;
select pg_temp.req('00000000-0000-0000-0000-00000000c005', 'More cables', 150);
select (public.submit_request('00000000-0000-0000-0000-00000000c005')).status as sent;
select pg_temp.ok('two N$150 requests in a week: the second goes to the GM', pg_temp.level('00000000-0000-0000-0000-00000000c004') = 'none' and pg_temp.level('00000000-0000-0000-0000-00000000c005') = 'gm');

-- 4. paying more than approved: the MD only where the steps send that amount to the MD
select pg_temp.set_rule('{"gm_limit": 1000}');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.req('00000000-0000-0000-0000-00000000c006', 'Chairs', 950);
select (public.submit_request('00000000-0000-0000-0000-00000000c006')).status as sent;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.approve_request('00000000-0000-0000-0000-00000000c006', null)).status as approved;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.refused($$select public.disburse_request('00000000-0000-0000-0000-00000000c006', 1040, null, null)$$, 'needs the Managing Director');
select pg_temp.set_rule('{"md_step": false}');
select pg_temp.ok('MD step off: the GM''s approval covers N$1,040 (within the 10%)', (public.disburse_request('00000000-0000-0000-0000-00000000c006', 1040, null, null)).status = 'disbursed');
select pg_temp.set_rule('{"md_step": true, "gm_limit": 5000}');

-- 5. top-ups always need approval
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok('a N$100 top-up needs the GM', (public.request_top_up(100, 'Small', (select balance from public.v_floats where status = 'open'))).level = 'gm');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.decide_top_up((select id from public.top_ups where status = 'requested'), false, 'no')).status as decided;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok('a N$6,000 top-up needs the MD', (public.request_top_up(6000, 'Big', (select balance from public.v_floats where status = 'open'))).level = 'md');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
select (public.decide_top_up((select id from public.top_ups where status = 'requested'), false, 'no')).status as decided;
select pg_temp.set_rule('{"gm_step": false}');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok('GM step off: a N$1,000 top-up needs the MD', (public.request_top_up(1000, 'Mid', (select balance from public.v_floats where status = 'open'))).level = 'md');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
select (public.decide_top_up((select id from public.top_ups where status = 'requested'), false, 'no')).status as decided;
select pg_temp.set_rule('{"gm_step": true}');

-- 6. "Pay out now" has its own limit
select pg_temp.set_rule('{"quick_payout_limit": 50}');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.refused($$select public.quick_payout('00000000-0000-0000-0000-0000000000c1', 80, 'Taxi', null, null)$$, '“Pay out now” is for up to N$50');
select pg_temp.ok('within it, paid', (public.quick_payout('00000000-0000-0000-0000-0000000000d1', 40, 'Taxi', null, null)).status = 'disbursed');
select pg_temp.set_rule('{"quick_payout_limit": 200}');

-- 7. a payment from the company account always needs approval first
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.req('00000000-0000-0000-0000-00000000c007', 'Courier', 120);
select pg_temp.quote('00000000-0000-0000-0000-00000000c007', 120);
select (public.submit_request('00000000-0000-0000-0000-00000000c007')).status as sent;
select pg_temp.ok('N$120 needs no approval for petty cash', (select status = 'awaiting_disbursement' and approved_by is null from public.requests where id = '00000000-0000-0000-0000-00000000c007'));
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.refused($$select public.pay_by_transfer('00000000-0000-0000-0000-00000000c007', 120, current_date, 'C1', 'company', pg_temp.pop('00000000-0000-0000-0000-00000000c007'), 'pop.pdf', 'application/pdf')$$, 'needs approval first');
select pg_temp.ok('finance sends it for approval', (public.escalate_request('00000000-0000-0000-0000-00000000c007', 120, 'From the company account')).status = 'pending_approval');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.approve_request('00000000-0000-0000-0000-00000000c007', null)).status as approved;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok('once approved, finance pays it from the company account',
  (public.pay_by_transfer('00000000-0000-0000-0000-00000000c007', 120, current_date, 'C1', 'company', pg_temp.pop('00000000-0000-0000-0000-00000000c007'), 'pop.pdf', 'application/pdf')).paid_from = 'company');

-- 8. stand-ins never join approving and paying
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.refused($$insert into public.delegations (from_user, to_user, role, starts_on, ends_on) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'finance', current_date, current_date + 7)$$, 'cannot also stand in for finance');
select pg_temp.refused($$insert into public.delegations (from_user, to_user, role, starts_on, ends_on) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', 'finance', current_date, current_date + 7)$$, 'cannot also stand in for finance');
select pg_temp.refused($$insert into public.delegations (from_user, to_user, role, starts_on, ends_on) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', 'approver', current_date, current_date + 7)$$, 'cannot also stand in for the GM');
insert into public.delegations (from_user, to_user, role, starts_on, ends_on) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1', 'finance', current_date, current_date + 7);
select pg_temp.ok('someone else can stand in for finance', exists (select 1 from public.delegations where to_user = '00000000-0000-0000-0000-0000000000d1' and role = 'finance'));
select pg_temp.refused($$insert into public.delegations (from_user, to_user, role, starts_on, ends_on) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'approver', current_date + 3, current_date + 10)$$, 'already stands in for');
insert into public.delegations (from_user, to_user, role, starts_on, ends_on) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'approver', current_date + 8, current_date + 14);
select pg_temp.ok('…and for the GM at another time', exists (select 1 from public.delegations where to_user = '00000000-0000-0000-0000-0000000000d1' and role = 'approver'));
rollback;
