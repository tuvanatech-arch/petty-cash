-- Payment requests (042): a quote attached on the draft or "No quote" recorded, and finance paying either in cash
-- from the box or by bank transfer, which never touches the box (here from the company account; 043 adds the
-- petty cash bank account, see places-smoke.sql). Every line should say ok.
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(what text, cond boolean) returns text language sql as $$ select case when coalesce(cond, false) then 'ok   ' else 'FAIL ' end || what $$;
create function pg_temp.as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, true), set_config('request.jwt.claim.role', 'authenticated', true) $$;
-- a file the requester uploaded to their inbox, then attached to the request
create function pg_temp.quote(p_request uuid, p_supplier text, p_total numeric, p_kind text default 'quote') returns public.request_documents language plpgsql as $$
declare ib uuid := gen_random_uuid(); v_path text := p_request::text || '/' || ib::text || '.pdf';
begin
  insert into public.receipt_inbox (id, user_id, storage_path, file_name, mime, extracted)
  values (ib, auth.uid(), 'inbox/' || auth.uid() || '/' || ib || '.pdf', 'quote.pdf', 'application/pdf', jsonb_build_object('supplier', p_supplier, 'total', p_total::text));
  insert into storage.objects (bucket_id, name, owner_id) values ('proofs', v_path, auth.uid()::text);
  return public.file_inbox_document(ib, p_request, v_path, p_kind);
end $$;
create function pg_temp.pop(p_request uuid) returns text language plpgsql as $$
declare v_path text := p_request::text || '/pop-' || gen_random_uuid() || '.pdf';
begin insert into storage.objects (bucket_id, name, owner_id) values ('proofs', v_path, auth.uid()::text); return v_path; end $$;
create function pg_temp.req(p_id uuid, p_purpose text, p_amount numeric) returns void language sql as $$
  insert into public.requests (id, type, purpose, estimated_total, requester_id) values (p_id, 'cash', p_purpose, p_amount, auth.uid());
  insert into public.request_lines (request_id, line_no, description, qty, est_unit_price, qty_from_stock) values (p_id, 1, p_purpose, 1, p_amount, 0) $$;

insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'boss@example.test', '{"full_name":"Ana Boss"}');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000f1', 'money@example.test', '{"full_name":"Filipa Money"}', '{"invited":true,"role":"finance"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@example.test', '{"full_name":"Carlos Staff"}', '{"invited":true,"role":"requester"}');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.open_float(date_trunc('month', current_date)::date, 5000, 'first float')).id is not null as float_opened;

-- the requester: a plumber with a quote attached on the draft, and a taxi with no quote
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.req('00000000-0000-0000-0000-00000000a001', 'Plumber for the kitchen tap', 900);
select pg_temp.ok('a quote can be attached while the request is still a draft', (pg_temp.quote('00000000-0000-0000-0000-00000000a001', 'Aqua Plumbing', 900)).kind = 'quote');
select pg_temp.ok('attaching to a draft tells nobody yet', not exists (select 1 from public.notifications where kind = 'document'));
do $$ begin perform pg_temp.quote('00000000-0000-0000-0000-00000000a001', 'X', 1, 'receipt'); raise notice 'FAIL attached as something other than a quote or invoice';
  exception when others then raise notice 'ok   only a quote or an invoice can be attached'; end $$;
update public.requests set paid_via = 'transfer', payment_ref = 'made up' where id = '00000000-0000-0000-0000-00000000a001';   -- a draft is the requester's to edit
select (public.submit_request('00000000-0000-0000-0000-00000000a001')).status as sent;
select pg_temp.ok('sending it clears any payment details a draft carried', (select paid_via = 'cash' and payment_ref is null from public.requests where id = '00000000-0000-0000-0000-00000000a001'));
select pg_temp.ok('with a quote attached it is not marked "No quote"', (select not no_quote from public.requests where id = '00000000-0000-0000-0000-00000000a001'));
select pg_temp.req('00000000-0000-0000-0000-00000000a002', 'Taxi to the bank', 80);
select (public.submit_request('00000000-0000-0000-0000-00000000a002')).status as sent;
select pg_temp.ok('sent without a quote: recorded as "No quote"', (select no_quote and status = 'awaiting_disbursement' from public.requests where id = '00000000-0000-0000-0000-00000000a002'));
do $$ begin perform public.pay_by_transfer('00000000-0000-0000-0000-00000000a001', 900, current_date, 'X1', 'company', pg_temp.pop('00000000-0000-0000-0000-00000000a001'), 'pop.pdf', 'application/pdf'); raise notice 'FAIL a requester recorded a transfer';
  exception when others then raise notice 'ok   only finance (or the GM) records a transfer'; end $$;

-- the GM approves the plumber (above the approval line)
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.approve_request('00000000-0000-0000-0000-00000000a001', 'ok')).status = 'awaiting_disbursement' as approved;

-- finance
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
create temp table box0 as select balance, spent, outstanding from public.v_floats where status = 'open';
do $$ begin perform public.pay_by_transfer('00000000-0000-0000-0000-00000000a002', 80, current_date, 'X2', 'company', pg_temp.pop('00000000-0000-0000-0000-00000000a002'), 'pop.pdf', 'application/pdf'); raise notice 'FAIL a transfer without a quote';
  exception when others then raise notice 'ok   no quote, no transfer: %', left(sqlerrm, 60); end $$;
do $$ begin perform public.pay_by_transfer('00000000-0000-0000-0000-00000000a001', 900, current_date + 1, 'X3', 'company', pg_temp.pop('00000000-0000-0000-0000-00000000a001'), 'pop.pdf', 'application/pdf'); raise notice 'FAIL a transfer dated tomorrow';
  exception when others then raise notice 'ok   a transfer cannot be dated in the future'; end $$;
do $$ begin perform public.pay_by_transfer('00000000-0000-0000-0000-00000000a001', 900, current_date, '  ', 'company', pg_temp.pop('00000000-0000-0000-0000-00000000a001'), 'pop.pdf', 'application/pdf'); raise notice 'FAIL a transfer without a reference';
  exception when others then raise notice 'ok   the bank reference is required'; end $$;
do $$ begin perform public.pay_by_transfer('00000000-0000-0000-0000-00000000a001', 1200, current_date, 'X4', 'company', pg_temp.pop('00000000-0000-0000-0000-00000000a001'), 'pop.pdf', 'application/pdf'); raise notice 'FAIL paid more than approved';
  exception when others then raise notice 'ok   no more than was approved: %', left(sqlerrm, 50); end $$;
select pg_temp.ok('paid by bank transfer: waiting for the supplier to be confirmed',
  (public.pay_by_transfer('00000000-0000-0000-0000-00000000a001', 900, current_date, 'FNB 4471023', 'company', pg_temp.pop('00000000-0000-0000-0000-00000000a001'), 'pop.pdf', 'application/pdf', 'EFT from the main account')).status = 'proof_review');
select pg_temp.ok('the request says how, when and with which reference', (select paid_via = 'transfer' and paid_on = current_date and payment_ref = 'FNB 4471023' and float_id is null and disbursed_by = '00000000-0000-0000-0000-0000000000f1' from public.requests where id = '00000000-0000-0000-0000-00000000a001'));
select pg_temp.ok('the petty cash box is untouched: balance, spent and outstanding the same',
  (select f.balance = b.balance and f.spent = b.spent and f.outstanding = b.outstanding from public.v_floats f, box0 b where f.status = 'open'));
select pg_temp.ok('no cash ledger line for it', not exists (select 1 from public.cash_ledger((select id from public.floats limit 1)) l where l.request_id = '00000000-0000-0000-0000-00000000a001'));
select pg_temp.ok('the spending is recorded: one line, the supplier from the quote, confirmed',
  (select count(*) = 1 and min(l.line_total) = 900 and min(l.supplier_name) = 'Aqua Plumbing' and bool_and(e.proof_status = 'confirmed')
     from public.expenses e join public.expense_lines l on l.expense_id = e.id and not l.void where e.request_id = '00000000-0000-0000-0000-00000000a001'));
select pg_temp.ok('the quote (attached before payment) and the proof of payment are its proofs',
  (select count(*) = 2 and count(*) filter (where (p.extracted->>'pre_payment')::boolean) = 1 and count(*) filter (where p.extracted->>'kind' = 'pop') = 1 from public.expense_proofs p join public.expenses e on e.id = p.expense_id where e.request_id = '00000000-0000-0000-0000-00000000a001'));
select pg_temp.ok('the requester is told it was paid, with the reference', exists (select 1 from public.notifications where user_id = '00000000-0000-0000-0000-0000000000c1' and title like 'Paid by bank transfer:%' and body like '%FNB 4471023%'));
select pg_temp.ok('the history says it', exists (select 1 from public.request_events where request_id = '00000000-0000-0000-0000-00000000a001' and action = 'paid_by_transfer' and note like 'Ref FNB 4471023%'));
select pg_temp.ok('paid from the company account: not in petty cash spending', not exists (select 1 from public.v_spend_lines where request_id = '00000000-0000-0000-0000-00000000a001'));
do $$ begin perform public.pay_by_transfer('00000000-0000-0000-0000-00000000a001', 900, current_date, 'again', 'company', pg_temp.pop('00000000-0000-0000-0000-00000000a001'), 'pop.pdf', 'application/pdf'); raise notice 'FAIL paid twice';
  exception when others then raise notice 'ok   it cannot be paid twice'; end $$;

-- the same supplier, date and amount again: finance says why, or it stops
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.req('00000000-0000-0000-0000-00000000a003', 'Plumber, second visit', 180);
select (pg_temp.quote('00000000-0000-0000-0000-00000000a003', 'Aqua Plumbing', 180)).kind = 'quote' as quoted;
select (public.submit_request('00000000-0000-0000-0000-00000000a003')).status as sent;
select pg_temp.req('00000000-0000-0000-0000-00000000a004', 'Plumber, third visit', 180);
select (pg_temp.quote('00000000-0000-0000-0000-00000000a004', 'Aqua Plumbing', 180, 'invoice')).kind = 'invoice' as invoiced;
select (public.submit_request('00000000-0000-0000-0000-00000000a004')).status as sent;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');   -- the routing sends repeat visits to the GM
select (public.approve_request(id, 'ok')).status from public.requests where id in ('00000000-0000-0000-0000-00000000a003', '00000000-0000-0000-0000-00000000a004') and status = 'pending_approval';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select (public.pay_by_transfer('00000000-0000-0000-0000-00000000a003', 180, current_date, 'FNB 1', 'company', pg_temp.pop('00000000-0000-0000-0000-00000000a003'), 'pop.pdf', 'application/pdf')).status = 'proof_review' as first_paid;
do $$ begin perform public.pay_by_transfer('00000000-0000-0000-0000-00000000a004', 180, current_date, 'FNB 2', 'company', pg_temp.pop('00000000-0000-0000-0000-00000000a004'), 'pop.pdf', 'application/pdf'); raise notice 'FAIL a look-alike payment went through without a word';
  exception when others then raise notice 'ok   a look-alike payment needs a reason: %', left(sqlerrm, 45); end $$;
select pg_temp.ok('with the reason it goes through', (public.pay_by_transfer('00000000-0000-0000-0000-00000000a004', 180, current_date, 'FNB 2', 'company', pg_temp.pop('00000000-0000-0000-0000-00000000a004'), 'pop.pdf', 'application/pdf', 'Two separate call-outs on the same day')).status = 'proof_review');
select pg_temp.ok('and the reason is kept on it', (select duplicate_note = 'Two separate call-outs on the same day' from public.expenses where request_id = '00000000-0000-0000-0000-00000000a004'));

-- cash from the box still works as before
select pg_temp.ok('the taxi is paid in cash from the box', (public.disburse_request('00000000-0000-0000-0000-00000000a002', 80)).status = 'disbursed');
select pg_temp.ok('and the box goes down by exactly that', (select f.balance = b.balance - 80 from public.v_floats f, box0 b where f.status = 'open'));
select pg_temp.ok('a cash pay-out stays marked as cash', (select paid_via = 'cash' from public.requests where id = '00000000-0000-0000-0000-00000000a002'));

-- the journal: a payment from the company account is outside petty cash, so not in its journal
select pg_temp.ok('journal: nothing for a payment from the company account',
  not exists (select 1 from public.journal(current_date) j where j.description like '%FNB 4471023%' or j.description like '%Plumber%'));
select pg_temp.ok('journal: debits and credits balance', (select sum(debit) = sum(credit) from public.journal(current_date)));
select pg_temp.ok('the float outlook still works', (public.float_outlook()->>'has_float')::boolean);
rollback;
