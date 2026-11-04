-- Petty cash in two places (043): the cash box and the petty cash bank account; withdrawals and deposits; the bank
-- check; paying from the box, the petty cash account or the company account; proof of payment; the supplier and
-- cash-received confirmations; the month-end close and carry-over; the journal. Every line should say ok.
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(what text, cond boolean) returns text language sql as $$ select case when coalesce(cond, false) then 'ok   ' else 'FAIL ' end || what $$;
create function pg_temp.as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, true), set_config('request.jwt.claim.role', 'authenticated', true) $$;
create function pg_temp.req(p_id uuid, p_purpose text, p_amount numeric) returns void language sql as $$
  insert into public.requests (id, type, purpose, estimated_total, requester_id) values (p_id, 'cash', p_purpose, p_amount, auth.uid());
  insert into public.request_lines (request_id, line_no, description, qty, est_unit_price, qty_from_stock) values (p_id, 1, p_purpose, 1, p_amount, 0) $$;
create function pg_temp.quote(p_request uuid, p_supplier text, p_total numeric) returns void language plpgsql as $$
declare ib uuid := gen_random_uuid(); v_path text := p_request::text || '/' || ib::text || '.pdf';
begin
  insert into public.receipt_inbox (id, user_id, storage_path, file_name, mime, extracted)
  values (ib, auth.uid(), 'inbox/' || auth.uid() || '/' || ib || '.pdf', 'quote.pdf', 'application/pdf', jsonb_build_object('supplier', p_supplier, 'total', p_total::text));
  insert into storage.objects (bucket_id, name, owner_id) values ('proofs', v_path, auth.uid()::text);
  perform public.file_inbox_document(ib, p_request, v_path, 'quote');
end $$;
-- the proof of payment, uploaded by whoever records the transfer
create function pg_temp.pop(p_request uuid) returns text language plpgsql as $$
declare v_path text := p_request::text || '/pop-' || gen_random_uuid() || '.pdf';
begin insert into storage.objects (bucket_id, name, owner_id) values ('proofs', v_path, auth.uid()::text); return v_path; end $$;
create function pg_temp.box() returns numeric language sql as $$ select balance from public.v_floats where status = 'open' $$;
create function pg_temp.bank() returns numeric language sql as $$ select bank_balance from public.v_floats where status = 'open' $$;

insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'boss@example.test', '{"full_name":"Ana Boss"}');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000f1', 'money@example.test', '{"full_name":"Filipa Money"}', '{"invited":true,"role":"finance"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@example.test', '{"full_name":"Carlos Staff"}', '{"invited":true,"role":"requester"}'),
  ('00000000-0000-0000-0000-0000000000d1', 'other@example.test', '{"full_name":"Dina Other"}', '{"invited":true,"role":"requester"}');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.open_float(date_trunc('month', current_date)::date, 5000, 'first float')).id is not null as float_opened;
select pg_temp.ok('opened as before: N$5,000 in the box, nothing in the bank', pg_temp.box() = 5000 and pg_temp.bank() = 0);

-- the bank account
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin perform public.set_petty_bank('My account'); raise notice 'FAIL a requester named the bank account';
  exception when others then raise notice 'ok   only finance (or the GM) sets up the bank account'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
do $$ begin perform public.move_cash('withdrawal', 100, 'test'); raise notice 'FAIL a withdrawal with no bank account';
  exception when others then raise notice 'ok   no bank account yet: no withdrawal (%)', left(sqlerrm, 40); end $$;
select pg_temp.ok('finance names it', (public.set_petty_bank('FNB petty cash account')).petty_bank_name = 'FNB petty cash account');

-- money into the bank account: a top-up, authorised by the GM, received into the bank
select (public.request_top_up(3000, 'Supplier payments this month', 5000)).status = 'requested' as top_up_asked;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.decide_top_up((select id from public.top_ups where status = 'requested'), true, 'ok')).status = 'authorised' as top_up_authorised;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select (public.receive_top_up((select id from public.top_ups where status = 'authorised'), 3000, 'bank')).status = 'received' as received;
select pg_temp.ok('the top-up went into the bank: box N$5,000, bank N$3,000', pg_temp.box() = 5000 and pg_temp.bank() = 3000);

-- cash withdrawn from the bank into the box
do $$ begin perform public.move_cash('withdrawal', 500, null, null); raise notice 'FAIL a withdrawal with neither slip nor note';
  exception when others then raise notice 'ok   a withdrawal needs the slip photo or a note'; end $$;
do $$ begin perform public.move_cash('withdrawal', 4000, 'too much'); raise notice 'FAIL withdrew more than the bank holds';
  exception when others then raise notice 'ok   no more than the bank holds: %', left(sqlerrm, 50); end $$;
insert into storage.objects (bucket_id, name, owner_id) values ('packs', 'slips/withdrawal-1.jpg', '00000000-0000-0000-0000-0000000000f1');
select (public.move_cash('withdrawal', 1000, null, 'slips/withdrawal-1.jpg')).kind::text = 'withdrawal' as withdrawn;
select pg_temp.ok('withdrawal: box up to N$6,000, bank down to N$2,000, the total unchanged', pg_temp.box() = 6000 and pg_temp.bank() = 2000);
select pg_temp.ok('the GM is told', exists (select 1 from public.notifications where user_id = '00000000-0000-0000-0000-0000000000a1' and kind = 'cash_move' and title like 'Cash withdrawn:%'));
select (public.move_cash('deposit', 200, 'Too much cash on hand')).kind::text = 'deposit' as deposited;
select pg_temp.ok('deposit: box N$5,800, bank N$2,200', pg_temp.box() = 5800 and pg_temp.bank() = 2200);
select pg_temp.ok('the floats view shows both, and the moves', (select withdrawn = 1000 and deposited = 200 and bank_funded = 3000 and topped_up = 0 from public.v_floats where status = 'open'));

-- payment requests: a plumber (quote) and a builder (quote), the GM approves both
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.req('00000000-0000-0000-0000-00000000b001', 'Plumber for the kitchen tap', 900);
select pg_temp.quote('00000000-0000-0000-0000-00000000b001', 'Aqua Plumbing', 900);
select (public.submit_request('00000000-0000-0000-0000-00000000b001')).status as sent;
select pg_temp.req('00000000-0000-0000-0000-00000000b002', 'Roof repair, store room', 2400);
select pg_temp.quote('00000000-0000-0000-0000-00000000b002', 'Namib Roofing', 2400);
select (public.submit_request('00000000-0000-0000-0000-00000000b002')).status as sent;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.approve_request(id, 'ok')).status from public.requests where id in ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000b002');

select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
do $$ begin perform public.pay_by_transfer('00000000-0000-0000-0000-00000000b001', 900, current_date, 'X'); raise notice 'FAIL the old form still records a transfer';
  exception when others then raise notice 'ok   the old form asks to reload: %', left(sqlerrm, 40); end $$;
do $$ begin perform public.pay_by_transfer('00000000-0000-0000-0000-00000000b001', 900, current_date, 'FNB 1', 'petty_cash', null, null, null); raise notice 'FAIL a transfer without proof of payment';
  exception when others then raise notice 'ok   the proof of payment is required'; end $$;
do $$ begin perform public.pay_by_transfer('00000000-0000-0000-0000-00000000b001', 900, current_date, 'FNB 1', 'petty_cash', '00000000-0000-0000-0000-00000000b002/pop.pdf', 'pop.pdf', 'application/pdf'); raise notice 'FAIL a proof filed under another request';
  exception when others then raise notice 'ok   the proof must be uploaded with this request'; end $$;
do $$ begin perform public.pay_by_transfer('00000000-0000-0000-0000-00000000b002', 2400, current_date, 'FNB 2', 'petty_cash', pg_temp.pop('00000000-0000-0000-0000-00000000b002'), 'pop.pdf', 'application/pdf'); raise notice 'FAIL paid more than the petty cash account holds';
  exception when others then raise notice 'ok   not more than the petty cash account holds: %', left(sqlerrm, 60); end $$;
create temp table before1 as select pg_temp.box() as box, pg_temp.bank() as bank;
select pg_temp.ok('from the petty cash account: waiting for the supplier',
  (public.pay_by_transfer('00000000-0000-0000-0000-00000000b001', 900, current_date, 'FNB 4471023', 'petty_cash', pg_temp.pop('00000000-0000-0000-0000-00000000b001'), 'pop-plumber.pdf', 'application/pdf')).status = 'proof_review');
select pg_temp.ok('the bank account goes down by N$900, the box is untouched', (select pg_temp.bank() = b.bank - 900 and pg_temp.box() = b.box from before1 b));
select pg_temp.ok('it belongs to this month''s petty cash, paid from the account', (select float_id is not null and paid_from = 'petty_cash' and paid_via = 'transfer' from public.requests where id = '00000000-0000-0000-0000-00000000b001'));
select pg_temp.ok('the quote and the proof of payment are its proofs',
  (select count(*) = 2 and count(*) filter (where p.extracted->>'kind' = 'pop') = 1 from public.expense_proofs p join public.expenses e on e.id = p.expense_id where e.request_id = '00000000-0000-0000-0000-00000000b001'));
select pg_temp.ok('the requester is told, with the reference', exists (select 1 from public.notifications where user_id = '00000000-0000-0000-0000-0000000000c1' and kind = 'transfer_paid' and body like '%FNB 4471023%'));
select pg_temp.ok('the bank ledger shows the transfer and adds up to the bank balance',
  (select bool_or(l.kind = 'transfer' and l.cash_out = 900) and sum(l.cash_in - l.cash_out) = pg_temp.bank() from public.bank_ledger((select id from public.v_floats where status = 'open')) l));
select pg_temp.ok('the cash ledger shows the withdrawal, not the transfer, and adds up to the box balance',
  (select bool_or(l.kind = 'withdrawal' and l.cash_in = 1000) and not bool_or(coalesce(l.request_id = '00000000-0000-0000-0000-00000000b001', false)) and sum(l.cash_in - l.cash_out) = pg_temp.box()
     from public.cash_ledger((select id from public.v_floats where status = 'open')) l));
do $$ begin perform public.finance_review_expense('00000000-0000-0000-0000-00000000b001', 'confirm', 'ok'); raise notice 'FAIL finance closed a transfer as a receipt check';
  exception when others then raise notice 'ok   a transfer is not closed by the receipt check'; end $$;

-- the roof: a direct payment from the company account, outside petty cash. Only finance pays out (045, 046): the GM
-- approves but pays nothing – not from the company account, not from the box, not by a quick pay-out.
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin perform public.pay_by_transfer('00000000-0000-0000-0000-00000000b002', 2400, current_date, 'Main 99812', 'company', pg_temp.pop('00000000-0000-0000-0000-00000000b002'), 'pop-roof.pdf', 'application/pdf');
  raise notice 'FAIL the GM paid from the company account';
  exception when others then raise notice '%', case when sqlerrm = 'Only finance pays out. The GM approves; finance pays.' then 'ok   the GM cannot pay from the company account' else 'FAIL GM refused for another reason: ' || sqlerrm end; end $$;
do $$ begin perform public.disburse_request('00000000-0000-0000-0000-00000000b002', 100, null, null);
  raise notice 'FAIL the GM paid out cash';
  exception when others then raise notice '%', case when sqlerrm = 'Only finance pays out. The GM approves; finance pays.' then 'ok   the GM cannot pay out cash' else 'FAIL GM refused for another reason: ' || sqlerrm end; end $$;
do $$ begin perform public.quick_payout('00000000-0000-0000-0000-0000000000c1', 20, 'Taxi', null, null);
  raise notice 'FAIL the GM made a quick pay-out';
  exception when others then raise notice '%', case when sqlerrm = 'Only finance pays out. The GM approves; finance pays.' then 'ok   the GM cannot make a quick pay-out' else 'FAIL GM refused for another reason: ' || sqlerrm end; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
create temp table before2 as select pg_temp.box() as box, pg_temp.bank() as bank;
select pg_temp.ok('from the company account',
  (public.pay_by_transfer('00000000-0000-0000-0000-00000000b002', 2400, current_date, 'Main 99812', 'company', pg_temp.pop('00000000-0000-0000-0000-00000000b002'), 'pop-roof.pdf', 'application/pdf')).paid_from = 'company');
select pg_temp.ok('petty cash is untouched: box and bank the same, no float', (select pg_temp.box() = b.box and pg_temp.bank() = b.bank from before2 b)
  and (select float_id is null from public.requests where id = '00000000-0000-0000-0000-00000000b002'));

-- the supplier delivers
do $$ begin perform public.confirm_supplier('00000000-0000-0000-0000-00000000b001'); raise notice 'FAIL finance confirmed for the requester without a reason';
  exception when others then raise notice 'ok   finance confirms for the requester only with a reason'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
do $$ begin perform public.confirm_supplier('00000000-0000-0000-0000-00000000b001', 'yes'); raise notice 'FAIL someone else confirmed the supplier';
  exception when others then raise notice 'ok   only the requester (or finance, with a reason) confirms'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok('the requester confirms: closed', (public.confirm_supplier('00000000-0000-0000-0000-00000000b001', 'Tap fixed')).status = 'closed');
select pg_temp.ok('who and when are kept, and finance is told', (select supplier_confirmed_by = '00000000-0000-0000-0000-0000000000c1' and supplier_confirmed_at is not null from public.requests where id = '00000000-0000-0000-0000-00000000b001')
  and exists (select 1 from public.notifications where user_id = '00000000-0000-0000-0000-0000000000f1' and title like 'Supplier confirmed:%'));

-- spending, budgets and the journal
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok('petty cash spending includes the plumber, not the roof',
  exists (select 1 from public.v_spend_lines where request_id = '00000000-0000-0000-0000-00000000b001') and not exists (select 1 from public.v_spend_lines where request_id = '00000000-0000-0000-0000-00000000b002'));
select (public.float_transaction((select id from public.v_floats where status = 'open'), 'return', 100, 'Back to finance')).place = 'box' as returned;
select pg_temp.ok('journal: the plumber is credited to the petty cash bank account', exists (select 1 from public.journal(current_date) j where j.account = 'PETTY-CASH-BANK' and j.credit = 900 and j.description like 'Bank transfer #%'));
select pg_temp.ok('journal: the withdrawal is debit petty cash, credit the petty cash bank account',
  exists (select 1 from public.journal(current_date) j where j.account = 'PETTY-CASH' and j.debit = 1000) and exists (select 1 from public.journal(current_date) j where j.account = 'PETTY-CASH-BANK' and j.credit = 1000));
select pg_temp.ok('journal: the top-up into the bank is debit the petty cash bank account, credit Bank', exists (select 1 from public.journal(current_date) j where j.account = 'PETTY-CASH-BANK' and j.debit = 3000) and exists (select 1 from public.journal(current_date) j where j.account = 'BANK' and j.credit = 3000));
select pg_temp.ok('journal: a return to finance is debit Bank, credit petty cash (fixed)', exists (select 1 from public.journal(current_date) j where j.account = 'BANK' and j.debit = 100) and exists (select 1 from public.journal(current_date) j where j.account = 'PETTY-CASH' and j.credit = 100 and j.description = 'Back to finance'));
select pg_temp.ok('journal: nothing for the roof (outside petty cash)', not exists (select 1 from public.journal(current_date) j where j.description like '%Roof%' or j.description like '%Main 99812%'));
select pg_temp.ok('journal: debits and credits balance', (select sum(debit) = sum(credit) from public.journal(current_date)));

-- the bank check, signed off by the GM, with bank charges written off
do $$ begin perform public.check_bank(1290); raise notice 'FAIL a bank difference without a note';
  exception when others then raise notice 'ok   a bank difference needs a note: %', left(sqlerrm, 50); end $$;
select (public.check_bank(1290, 'Bank charges N$10')).place = 'bank' as checked;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
create temp table before3 as select pg_temp.box() as box, pg_temp.bank() as bank;
select (public.review_cash_count((select id from public.cash_counts where place = 'bank' and status = 'to_review'), true, 'Monthly bank fee', true)).status = 'accepted' as signed_off;
select pg_temp.ok('written off in the bank account only: bank down N$10, box the same', (select pg_temp.bank() = b.bank - 10 and pg_temp.box() = b.box from before3 b));
select pg_temp.ok('the finance person is told it was signed off', exists (select 1 from public.notifications where user_id = '00000000-0000-0000-0000-0000000000f1' and title = 'Bank check signed off'));

-- cash handed over: the person confirms
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.req('00000000-0000-0000-0000-00000000b003', 'Taxi to the bank', 80);
select (public.submit_request('00000000-0000-0000-0000-00000000b003')).status as sent;
select pg_temp.req('00000000-0000-0000-0000-00000000b004', 'Milk for the kitchen', 60);
select (public.submit_request('00000000-0000-0000-0000-00000000b004')).status as sent;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select (public.disburse_request('00000000-0000-0000-0000-00000000b003', 80)).status as paid;
select (public.disburse_request('00000000-0000-0000-0000-00000000b004', 60)).status as paid;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
do $$ begin perform public.confirm_cash('00000000-0000-0000-0000-00000000b003', true); raise notice 'FAIL someone else confirmed the cash';
  exception when others then raise notice 'ok   only the person handed the cash confirms it'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok('"Yes, I received it" is kept', (public.confirm_cash('00000000-0000-0000-0000-00000000b003', true)).cash_received);
do $$ begin perform public.confirm_cash('00000000-0000-0000-0000-00000000b003', false, 'changed my mind'); raise notice 'FAIL answered twice';
  exception when others then raise notice 'ok   answered once only'; end $$;
do $$ begin perform public.confirm_cash('00000000-0000-0000-0000-00000000b004', false); raise notice 'FAIL "No" without saying what happened';
  exception when others then raise notice 'ok   "No" needs a note'; end $$;
select pg_temp.ok('"No" is kept with the note', not (public.confirm_cash('00000000-0000-0000-0000-00000000b004', false, 'Finance was out, nothing handed to me')).cash_received);
select pg_temp.ok('the GM and finance are told', (select count(distinct user_id) = 2 from public.notifications where kind = 'cash_dispute'));
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok('it is in the exceptions log for the GM', exists (select 1 from public.exceptions_log(current_date - 1) x where x.kind = 'cash_not_received' and x.state = 'open'));

-- the month-end close: the box counted, the bank checked; next month starts with both
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select (public.undo_disbursement(id, 'test: not handed over')).status from public.requests where id in ('00000000-0000-0000-0000-00000000b003', '00000000-0000-0000-0000-00000000b004');
create temp table atclose as select id, pg_temp.box() as box, pg_temp.bank() as bank from public.v_floats where status = 'open';
do $$ begin perform public.close_float((select id from atclose), (select box from atclose), 'month end'); raise notice 'FAIL closed without the bank statement';
  exception when others then raise notice 'ok   the close asks for the bank statement: %', left(sqlerrm, 50); end $$;
select (public.close_float((select id from atclose), (select box from atclose), 'month end', (select bank from atclose))).closing_bank = (select bank from atclose) as closed;
select pg_temp.ok('the close recorded a box count and a bank check', (select count(*) = 2 and count(distinct place) = 2 from public.cash_counts where float_id = (select id from atclose) and kind = 'month_end'));
select set_config('pcs.schedule', 'on', true); update public.settings set float_rollover = true where id = 1; select set_config('pcs.schedule', '', true);   -- what is left carries over (a schedule setting)
select (public.open_float((date_trunc('month', current_date) + interval '1 month')::date, 0, 'next month', 'box')).id is not null as next_opened;
select pg_temp.ok('next month starts with the box and the bank as they were at the close', (select pg_temp.box() = a.box and pg_temp.bank() = a.bank from atclose a));
-- finance's own request: always the GM's approval first; then finance pays it (nobody else pays any more)
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.req('00000000-0000-0000-0000-00000000b0f1', 'Printer cable', 50);
select public.submit_request('00000000-0000-0000-0000-00000000b0f1') is not null as sent;
select pg_temp.ok('finance''s own N$50 request goes to the GM', (select status = 'pending_approval' and approval_level = 'gm' from public.requests where id = '00000000-0000-0000-0000-00000000b0f1'));
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select public.approve_request('00000000-0000-0000-0000-00000000b0f1', null) is not null as approved;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok('once the GM approves, finance pays it out', (public.disburse_request('00000000-0000-0000-0000-00000000b0f1', 50, null, null)).status = 'disbursed');

rollback;
