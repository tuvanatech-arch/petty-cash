-- The petty cash bank account starts at what is already in it (044). Every line should say ok.
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(what text, cond boolean) returns text language sql as $$ select case when coalesce(cond, false) then 'ok   ' else 'FAIL ' end || what $$;
create function pg_temp.as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, true), set_config('request.jwt.claim.role', 'authenticated', true) $$;
create function pg_temp.box() returns numeric language sql as $$ select balance from public.v_floats where status = 'open' $$;
create function pg_temp.bank() returns numeric language sql as $$ select bank_balance from public.v_floats where status = 'open' $$;

insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'boss@example.test', '{"full_name":"Ana Boss"}');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000f1', 'money@example.test', '{"full_name":"Filipa Money"}', '{"invited":true,"role":"finance"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@example.test', '{"full_name":"Carlos Staff"}', '{"invited":true,"role":"requester"}');

-- no float open yet: a name is fine, an opening balance is not
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
do $$ begin perform public.set_petty_bank('FNB petty cash account', 3000, null); raise notice 'FAIL an opening balance with no float open';
  exception when others then raise notice 'ok   no float open: "%"', sqlerrm; end $$;
select pg_temp.ok('…and nothing was saved', (select petty_bank_name from public.branches limit 1) is null);

select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.open_float(date_trunc('month', current_date)::date, 5000, 'first float')).id is not null as float_opened;

select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin perform public.set_petty_bank('My account', 100, null); raise notice 'FAIL a requester added the bank account';
  exception when others then raise notice 'ok   only finance (or the GM) adds the account'; end $$;

select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
do $$ begin perform public.set_petty_bank('FNB petty cash account', -5, null); raise notice 'FAIL a negative balance';
  exception when others then raise notice 'ok   a balance below zero is refused'; end $$;
select pg_temp.ok('finance adds the account with N$3,250.40 in it', (public.set_petty_bank('FNB petty cash account', 3250.40, 'statement of 3 Nov')).petty_bank_name = 'FNB petty cash account');
select pg_temp.ok('the bank starts at N$3,250.40; the box is untouched', pg_temp.bank() = 3250.40 and pg_temp.box() = 5000);
select pg_temp.ok('booked as an opening balance in the bank, with the note',
  exists (select 1 from public.float_transactions where kind = 'carry_over' and place = 'bank' and amount = 3250.40 and note = 'Opening balance of FNB petty cash account (bank statement) – statement of 3 Nov'));
select pg_temp.ok('the GM is told', exists (select 1 from public.notifications where kind = 'cash_move' and title = 'Petty cash bank account added: N$3,250.40'));
select pg_temp.ok('the bank ledger shows it', exists (select 1 from public.bank_ledger((select id from public.v_floats where status = 'open')) l where l.cash_in = 3250.40 and l.balance = 3250.40));
select pg_temp.ok('not new money: nothing in the journal', not exists (select 1 from public.journal(date_trunc('month', current_date)::date) j where j.debit = 3250.40 or j.credit = 3250.40));

-- once the account has a balance, it cannot be started again
do $$ begin perform public.set_petty_bank('FNB petty cash account', 100, null); raise notice 'FAIL a second opening balance';
  exception when others then raise notice 'ok   only once: "%"', sqlerrm; end $$;
select pg_temp.ok('a rename with no amount still works', (public.set_petty_bank('FNB petty cash', 0, null)).petty_bank_name = 'FNB petty cash');
select pg_temp.ok('…and the one-argument form too', (public.set_petty_bank('FNB petty cash account')).petty_bank_name = 'FNB petty cash account');
rollback;
