-- 043: where the petty cash is, how each payment is made, and who confirms what.
--  * Each branch's petty cash is held in two places: the cash box and, when the branch has one, the petty cash
--    bank account. Every movement says which. Finance records cash withdrawn from the bank into the box and cash
--    paid from the box into the bank. Cash counts check the box; a bank check compares the bank statement.
--    The month-end close does both, and next month starts with both.
--  * A payment request is paid in cash from the box, by transfer from the petty cash bank account (part of petty
--    cash), or by transfer from the company account (a direct payment outside petty cash: recorded with its
--    paperwork, but kept out of the petty cash balances, budgets and journal).
--  * Every transfer carries its proof of payment. The requester gets it and confirms when the supplier has
--    delivered; that closes the request.
--  * Whoever receives cash from the box confirms it on their phone: "Yes, I received it" or "No" (the GM is told).
--  * Fixed on the way: the journal booked a return of cash to finance the wrong way round (debit petty cash,
--    credit bank); it is now debit bank, credit petty cash.

/* =========================================================================== the two places */
alter table public.branches add column if not exists petty_bank_name text;                 -- e.g. "FNB petty cash account"; empty = cash box only
alter table public.settings add column if not exists petty_bank_account text not null default 'PETTY-CASH-BANK';   -- its code in the journal
alter table public.float_transactions add column if not exists place text not null default 'box';
alter table public.float_transactions add column if not exists slip_path text;              -- photo of the bank slip (withdrawals and deposits)
alter table public.cash_counts add column if not exists place text not null default 'box';   -- box: a cash count; bank: a bank statement check
alter table public.floats add column if not exists closing_bank numeric;                   -- the bank statement balance at the month-end close
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'float_transactions_place_check') then
    alter table public.float_transactions add constraint float_transactions_place_check check (place in ('box', 'bank'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cash_counts_place_check') then
    alter table public.cash_counts add constraint cash_counts_place_check check (place in ('box', 'bank'));
  end if;
end $$;

-- how a request was paid, and the confirmations that follow
alter table public.requests add column if not exists paid_from text not null default 'petty_cash';   -- petty_cash | company (outside petty cash)
alter table public.requests add column if not exists supplier_confirmed_by uuid references public.profiles(id);
alter table public.requests add column if not exists supplier_confirmed_at timestamptz;
alter table public.requests add column if not exists supplier_note text;
alter table public.requests add column if not exists cash_received boolean;                 -- the person handed the cash: yes / no
alter table public.requests add column if not exists cash_received_at timestamptz;
alter table public.requests add column if not exists cash_received_note text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'requests_paid_from_check') then
    alter table public.requests add constraint requests_paid_from_check check (paid_from in ('petty_cash', 'company'));
  end if;
end $$;
-- only cash handed out from now on is confirmed (nobody is asked about last month's pay-outs)
alter table public.settings add column if not exists cash_confirm_from timestamptz;
update public.settings set cash_confirm_from = now() where id = 1 and cash_confirm_from is null;

-- how it was paid is only ever set by finance: whatever a draft carried is cleared when it is sent
create or replace function public.requests_quote_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'draft' and new.status <> 'draft' then
    new.paid_via := 'cash'; new.paid_from := 'petty_cash'; new.payment_ref := null; new.paid_on := null;
    new.supplier_confirmed_by := null; new.supplier_confirmed_at := null; new.supplier_note := null;
    new.cash_received := null; new.cash_received_at := null; new.cash_received_note := null;
    new.no_quote := new.type = 'cash' and not exists (select 1 from public.request_documents where request_id = new.id);
  end if;
  return new;
end $$;

/* =========================================================================== balances */
-- what the movements of a float add up to in one place (amounts stay positive; the kind gives the direction)
create or replace function public.float_place_total(p_float uuid, p_place text) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case
      when t.kind::text = 'withdrawal' then case when p_place = 'box' then t.amount else -t.amount end
      when t.kind::text = 'deposit' then case when p_place = 'bank' then t.amount else -t.amount end
      when t.place <> p_place then 0
      when t.kind::text in ('return', 'shortage') then -t.amount
      else t.amount end), 0)
  from public.float_transactions t where t.float_id = p_float
$$;
revoke execute on function public.float_place_total(uuid, text) from public, anon;
grant execute on function public.float_place_total(uuid, text) to authenticated;

-- the cash box: what should be in it (cash handed out and spent from it is off the book)
create or replace function public.float_balance(p_float uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select round(
      public.float_place_total(p_float, 'box')
    - coalesce((select sum(disbursed_amount) from public.requests
                where float_id = p_float and status = 'disbursed' and paid_via = 'cash'), 0)
    - coalesce((select sum(e.total) from public.expenses e
                join public.requests r on r.id = e.request_id
                where r.float_id = p_float and r.paid_via = 'cash' and r.status in ('proof_review','physical_required','closed')), 0)
  , 2)
$$;

-- the petty cash bank account: what the statement should show
create or replace function public.float_bank_balance(p_float uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select round(
      public.float_place_total(p_float, 'bank')
    - coalesce((select sum(disbursed_amount) from public.requests
                where float_id = p_float and paid_via = 'transfer' and disbursed_at is not null), 0)
  , 2)
$$;
revoke execute on function public.float_bank_balance(uuid) from public, anon;
grant execute on function public.float_bank_balance(uuid) to authenticated;

-- the columns that were there stay as they were, now for the cash box; the bank account's figures follow
create or replace view public.v_floats as
  select id, period, opening_amount, status, opened_by, opened_at, closed_by, closed_at, counted_cash, notes,
    coalesce((select sum(t.amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'allocation' and t.place = 'box'), 0) as allocated,
    coalesce((select sum(t.amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'top_up' and t.place = 'box'), 0) as topped_up,
    coalesce((select sum(t.amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'carry_over' and t.place = 'box'), 0) as carried_over,
    coalesce((select sum(t.amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'return' and t.place = 'box'), 0) as returned,
    coalesce((select sum(r.disbursed_amount) from public.requests r where r.float_id = f.id and r.status = 'disbursed' and r.paid_via = 'cash'), 0) as outstanding,
    coalesce((select sum(e.total) from public.expenses e join public.requests r on r.id = e.request_id
               where r.float_id = f.id and r.paid_via = 'cash' and r.status in ('proof_review', 'physical_required', 'closed')), 0) as spent,
    public.float_balance(id) as balance,
    coalesce((select sum(case when t.kind = 'surplus' then t.amount else -t.amount end) from public.float_transactions t
               where t.float_id = f.id and t.kind in ('surplus', 'shortage') and t.place = 'box'), 0) as adjusted,
    branch_id,
    coalesce((select sum(t.amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'withdrawal'), 0) as withdrawn,
    coalesce((select sum(t.amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'deposit'), 0) as deposited,
    coalesce((select sum(t.amount) from public.float_transactions t where t.float_id = f.id and t.place = 'bank' and t.kind in ('allocation', 'top_up', 'carry_over')), 0) as bank_funded,
    coalesce((select sum(t.amount) from public.float_transactions t where t.float_id = f.id and t.place = 'bank' and t.kind = 'return'), 0) as bank_returned,
    coalesce((select sum(r.disbursed_amount) from public.requests r where r.float_id = f.id and r.paid_via = 'transfer' and r.disbursed_at is not null), 0) as bank_paid,
    coalesce((select sum(case when t.kind = 'surplus' then t.amount else -t.amount end) from public.float_transactions t
               where t.float_id = f.id and t.kind in ('surplus', 'shortage') and t.place = 'bank'), 0) as bank_adjusted,
    public.float_bank_balance(id) as bank_balance,
    closing_bank
  from public.floats f;

-- finance (or the GM) names the branch's petty cash bank account; it can only be switched off when it is empty
create or replace function public.set_petty_bank(p_name text) returns public.branches
language plpgsql security definer set search_path = public as $$
declare b public.branches%rowtype; f public.floats%rowtype; v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Finance sets up the petty cash bank account'; end if;
  if length(v_name) > 80 then raise exception 'Keep the name short (80 characters at most)'; end if;
  select * into b from public.branches where id = public.my_branch() for update;
  if b.id is null then raise exception 'Choose the branch first'; end if;
  f := public.branch_float(b.id);
  if v_name is null and f.id is not null and abs(public.float_bank_balance(f.id)) >= 0.005 then
    raise exception 'The bank account still holds % on the book. Move it to the box or return it first.', public.money_text(public.float_bank_balance(f.id));
  end if;
  update public.branches set petty_bank_name = v_name where id = b.id returning * into b;
  return b;
end $$;
revoke execute on function public.set_petty_bank(text) from public, anon;
grant execute on function public.set_petty_bank(text) to authenticated;

/* =========================================================================== counting the box, checking the bank */
create or replace function public.cash_count_text(c public.cash_counts) returns text
language sql stable set search_path = public as $$
  select case when abs(c.difference) < 0.005 then 'matches the book (' || public.money_text(c.counted) || ')'
              when c.difference < 0 then public.money_text(-c.difference) || case when c.place = 'bank' then ' below the book (statement ' else ' short (counted ' end
                   || public.money_text(c.counted) || ', book ' || public.money_text(c.expected) || ')'
              else public.money_text(c.difference) || case when c.place = 'bank' then ' above the book (statement ' else ' over (counted ' end
                   || public.money_text(c.counted) || ', book ' || public.money_text(c.expected) || ')' end
$$;

-- the one place a count (box) or a bank check (bank) is recorded
create or replace function public.cash_count_place(p_float uuid, p_counted numeric, p_note text, p_kind text, p_tell boolean, p_place text)
returns public.cash_counts language plpgsql security definer set search_path = public as $$
declare c public.cash_counts%rowtype; s public.settings%rowtype; v_expected numeric; v_out numeric := 0; v_note text := nullif(btrim(coalesce(p_note, '')), '');
        v_bank boolean := p_place = 'bank';
begin
  if p_place not in ('box', 'bank') then raise exception 'Count the box or check the bank'; end if;
  if p_counted is null or p_counted < 0 then
    raise exception '%', case when v_bank then 'Enter the balance on the bank statement' else 'Enter the cash counted in the box' end;
  end if;
  select * into s from public.settings where id = 1;
  if v_bank then
    v_expected := public.float_bank_balance(p_float);
  else
    v_expected := public.float_balance(p_float);
    select coalesce(sum(disbursed_amount), 0) into v_out from public.requests where float_id = p_float and status = 'disbursed' and paid_via = 'cash';
  end if;
  if abs(round(p_counted, 2) - v_expected) > coalesce(s.cash_variance_limit, 0) + 0.004 and v_note is null then
    if v_bank then
      raise exception 'The bank statement is % % the book balance of %. Say what caused it (for example bank charges) – the GM sees your note.',
        public.money_text(abs(round(p_counted, 2) - v_expected)), case when p_counted < v_expected then 'below' else 'above' end, public.money_text(v_expected);
    end if;
    raise exception 'The box is % % the book balance of %. Say what you think caused it – the GM sees your note.',
      public.money_text(abs(round(p_counted, 2) - v_expected)), case when p_counted < v_expected then 'short of' else 'over' end, public.money_text(v_expected);
  end if;
  -- an earlier count of the same place still waiting for sign-off is replaced by this one
  update public.cash_counts set status = 'superseded' where float_id = p_float and place = p_place and status in ('to_review', 'queried');
  insert into public.cash_counts (float_id, kind, counted, expected, outstanding, variance_limit, exception, note, counted_by, place)
  values (p_float, p_kind, round(p_counted, 2), v_expected, v_out, coalesce(s.cash_variance_limit, 0),
          abs(round(p_counted, 2) - v_expected) > coalesce(s.cash_variance_limit, 0) + 0.004, v_note, auth.uid(), p_place)
  returning * into c;
  if p_tell then
    perform public.notify_role('approver', 'cash_count',
      case when v_bank then
             case when c.exception then 'Bank check to sign off: ' || case when c.difference < 0 then public.money_text(-c.difference) || ' below the book' else public.money_text(c.difference) || ' above the book' end
                  else 'Bank check to sign off' end
           else
             case when c.exception then 'Cash count to sign off: ' || case when c.difference < 0 then public.money_text(-c.difference) || ' short' else public.money_text(c.difference) || ' over' end
                  else 'Cash count to sign off' end end,
      case when v_bank then case c.kind when 'month_end' then 'Month-end bank check' else 'Bank check' end
           else case c.kind when 'month_end' then 'Month-end count' else 'Cash count' end end
        || ' by ' || coalesce((select full_name from public.profiles where id = auth.uid()), 'finance') || ': '
        || public.cash_count_text(c) || coalesce(' – “' || c.note || '”', ''),
      '#/cash', null);
  end if;
  return c;
end $$;
revoke execute on function public.cash_count_place(uuid, numeric, text, text, boolean, text) from public, anon, authenticated;

-- the box, as before
create or replace function public.cash_count_record(p_float uuid, p_counted numeric, p_note text, p_kind text, p_tell boolean default true)
returns public.cash_counts language plpgsql security definer set search_path = public as $$
begin
  return public.cash_count_place(p_float, p_counted, p_note, p_kind, p_tell, 'box');
end $$;
revoke execute on function public.cash_count_record(uuid, numeric, text, text, boolean) from public, anon, authenticated;

-- finance checks the bank account against its statement, any day
create or replace function public.check_bank(p_statement numeric, p_note text default null) returns public.cash_counts
language plpgsql security definer set search_path = public as $$
declare f public.floats%rowtype;
begin
  if not public.has_role('finance') then raise exception 'The bank account is checked by finance'; end if;
  f := public.current_float();
  if f.id is null then raise exception 'No float is open'; end if;
  if (select petty_bank_name from public.branches where id = f.branch_id) is null then
    raise exception 'This branch has no petty cash bank account. Add it under Petty cash first.';
  end if;
  return public.cash_count_place(f.id, p_statement, p_note, 'spot', true, 'bank');
end $$;
revoke execute on function public.check_bank(numeric, text) from public, anon;
grant execute on function public.check_bank(numeric, text) to authenticated;

-- the GM signs a count or a bank check off (never their own), or asks finance a question about it
create or replace function public.review_cash_count(p_id uuid, p_accept boolean, p_note text default null, p_write_off boolean default false)
returns public.cash_counts language plpgsql security definer set search_path = public as $$
declare c public.cash_counts%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_latest uuid; v_what text;
begin
  if not public.has_role('approver') then raise exception 'Cash counts are signed off by the General Manager'; end if;
  select * into c from public.cash_counts where id = p_id for update;
  if c.id is null then raise exception 'Count not found'; end if;
  v_what := case when c.place = 'bank' then 'bank check' else 'cash count' end;
  if c.counted_by = auth.uid() then raise exception 'Someone else must sign off your own %', v_what; end if;
  if c.status not in ('to_review', 'queried') then raise exception 'This % is no longer waiting for sign-off', v_what; end if;
  if not p_accept then
    if v_note is null then raise exception 'Write the question for finance'; end if;
    update public.cash_counts set status = 'queried', reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_note where id = p_id returning * into c;
    perform public.notify_user(c.counted_by, 'cash_count', 'Question on your ' || v_what, v_note, '#/cash', null);
    return c;
  end if;
  if c.exception and v_note is null then
    raise exception 'The difference is above the % allowed: say how it was resolved', public.money_text(c.variance_limit);
  end if;
  if p_write_off and abs(c.difference) >= 0.005 then
    select id into v_latest from public.cash_counts where float_id = c.float_id and place = c.place and status <> 'superseded' order by counted_at desc limit 1;
    if v_latest <> c.id then raise exception 'A later % exists – write off the difference on that one', v_what; end if;
    insert into public.float_transactions (float_id, kind, amount, created_by, note, place)
    values (c.float_id, case when c.difference < 0 then 'shortage'::public.float_tx_kind else 'surplus'::public.float_tx_kind end, abs(c.difference), auth.uid(),
            case when c.place = 'bank' then case when c.difference < 0 then 'Bank statement below the book' else 'Bank statement above the book' end
                 else case when c.difference < 0 then 'Cash short' else 'Cash over' end end
              || ' at the ' || case when c.place = 'bank' then 'check' else 'count' end || ' of ' || to_char(c.counted_at at time zone public.app_tz(), 'DD Mon') || ', written off'
              || coalesce(' – ' || v_note, ''), c.place);
  end if;
  update public.cash_counts set status = 'accepted', reviewed_by = auth.uid(), reviewed_at = now(), review_note = coalesce(v_note, review_note),
         written_off = case when p_write_off and abs(c.difference) >= 0.005 then c.difference end
   where id = p_id returning * into c;
  perform public.notify_user(c.counted_by, 'cash_count', case when c.place = 'bank' then 'Bank check signed off' else 'Cash count signed off' end,
    case when c.place = 'bank' then 'Checked ' else 'Counted ' end || to_char(c.counted_at at time zone public.app_tz(), 'DD Mon') || ': ' || public.cash_count_text(c)
      || case when c.written_off is not null then ' – the difference was written off.' else '.' end, '#/cash', null);
  return c;
end $$;
revoke execute on function public.review_cash_count(uuid, boolean, text, boolean) from public, anon;
grant execute on function public.review_cash_count(uuid, boolean, text, boolean) to authenticated;

/* =========================================================================== the month: open, close, money in and out */
-- the month-end close counts the box and, when there is one, checks the bank statement
create or replace function public.close_float(p_float uuid, p_counted_cash numeric, p_notes text, p_statement numeric) returns public.floats
language plpgsql security definer set search_path = public as $$
declare f public.floats%rowtype; v_open int; v_bank boolean;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can close a float'; end if;
  select * into f from public.floats where id = p_float for update;
  if f.id is null or f.status <> 'open' then raise exception 'Float is not open'; end if;
  select count(*) into v_open from public.requests where float_id = p_float and status = 'disbursed';
  if v_open > 0 then raise exception '% advance(s) still have no expense recorded. Chase those before closing.', v_open; end if;
  v_bank := exists (select 1 from public.branches where id = f.branch_id and petty_bank_name is not null)
         or exists (select 1 from public.float_transactions where float_id = p_float and (place = 'bank' or kind in ('withdrawal', 'deposit')))
         or exists (select 1 from public.requests where float_id = p_float and paid_via = 'transfer');
  if v_bank and p_statement is null then raise exception 'Enter the closing balance on the bank statement of the petty cash account'; end if;
  perform public.cash_count_place(p_float, p_counted_cash, p_notes, 'month_end', true, 'box');
  if v_bank then perform public.cash_count_place(p_float, p_statement, p_notes, 'month_end', true, 'bank'); end if;
  update public.floats set status = 'closed', closed_by = auth.uid(), closed_at = now(), counted_cash = round(p_counted_cash, 2),
         closing_bank = case when v_bank then round(p_statement, 2) end,
         notes = coalesce(nullif(p_notes, ''), notes) where id = p_float returning * into f;
  return f;
end $$;
revoke execute on function public.close_float(uuid, numeric, text, numeric) from public, anon;
grant execute on function public.close_float(uuid, numeric, text, numeric) to authenticated;

create or replace function public.close_float(p_float uuid, p_counted_cash numeric, p_notes text default null) returns public.floats
language plpgsql security definer set search_path = public as $$
begin
  return public.close_float(p_float, p_counted_cash, p_notes, null::numeric);
end $$;

-- a new month: the allocation goes into the box or the bank account; both carry over what was there at the close
create or replace function public.open_float(p_period date, p_amount numeric, p_note text, p_place text) returns public.floats
language plpgsql security definer set search_path = public as $$
declare f public.floats%rowtype; prev public.floats%rowtype; v_period date; v_carry numeric; v_carry_bank numeric; s public.settings%rowtype; b public.branches%rowtype; v_usual numeric;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can open a float'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Enter the float amount'; end if;
  if coalesce(p_place, '') not in ('box', 'bank') then raise exception 'Say where the money goes: the cash box or the bank account'; end if;
  select * into b from public.branches where id = public.my_branch();
  if b.id is null or not b.active then raise exception 'Choose the branch first'; end if;
  if p_place = 'bank' and b.petty_bank_name is null then raise exception '% has no petty cash bank account. Add it under Petty cash first.', b.name; end if;
  select * into s from public.settings where id = 1;
  v_usual := coalesce(b.usual_float, s.default_monthly_float);
  if v_usual > 0 and p_amount > v_usual then
    raise exception 'The usual monthly float for % is %. Open with that and request a top-up for more.', b.name, public.money_text(v_usual);
  end if;
  v_period := date_trunc('month', coalesce(p_period, current_date))::date;
  if exists (select 1 from public.floats where branch_id = b.id and period = v_period) then raise exception 'A float for % already exists for %', to_char(v_period, 'Mon YYYY'), b.name; end if;
  if exists (select 1 from public.floats where branch_id = b.id and status = 'open') then raise exception 'Close the current float before opening a new one'; end if;
  insert into public.floats (period, opening_amount, opened_by, notes, branch_id) values (v_period, round(p_amount, 2), auth.uid(), nullif(p_note, ''), b.id) returning * into f;
  insert into public.float_transactions (float_id, kind, amount, created_by, note, place)
  values (f.id, 'allocation', round(p_amount, 2), auth.uid(), case when p_place = 'bank' then 'Monthly allocation from finance, into the bank account' else 'Monthly allocation from finance' end, p_place);
  if s.float_rollover then
    select * into prev from public.floats where branch_id = b.id and period < v_period and status = 'closed' order by period desc limit 1;
    if prev.id is not null then
      v_carry := coalesce(prev.counted_cash, public.float_balance(prev.id));
      if v_carry > 0 then
        insert into public.float_transactions (float_id, kind, amount, created_by, note)
        values (f.id, 'carry_over', v_carry, auth.uid(), 'Carried over from ' || to_char(prev.period, 'Mon YYYY') || case when prev.counted_cash is not null then ' (cash counted at close)' else '' end);
      end if;
      v_carry_bank := coalesce(prev.closing_bank, public.float_bank_balance(prev.id));
      if v_carry_bank > 0 then
        insert into public.float_transactions (float_id, kind, amount, created_by, note, place)
        values (f.id, 'carry_over', v_carry_bank, auth.uid(), 'Carried over from ' || to_char(prev.period, 'Mon YYYY') || ' in the bank account' || case when prev.closing_bank is not null then ' (statement at close)' else '' end, 'bank');
      end if;
    end if;
  end if;
  return f;
end $$;
revoke execute on function public.open_float(date, numeric, text, text) from public, anon;
grant execute on function public.open_float(date, numeric, text, text) to authenticated;

create or replace function public.open_float(p_period date, p_amount numeric, p_note text default null) returns public.floats
language plpgsql security definer set search_path = public as $$
begin
  return public.open_float(p_period, p_amount, p_note, 'box');
end $$;

-- a top-up arrives as cash in the box or as money in the bank account (never more than was authorised)
create or replace function public.receive_top_up(p_id uuid, p_amount numeric, p_place text) returns public.top_ups
language plpgsql security definer set search_path = public as $$
declare t public.top_ups%rowtype; f public.floats%rowtype; tx public.float_transactions%rowtype;
begin
  if not public.has_role('finance') then raise exception 'Finance records the money received'; end if;
  if coalesce(p_place, '') not in ('box', 'bank') then raise exception 'Say where the money arrived: the cash box or the bank account'; end if;
  select * into t from public.top_ups where id = p_id for update;
  if t.id is null or t.status <> 'authorised' then raise exception 'This top-up is not authorised'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount received'; end if;
  if round(p_amount, 2) > t.amount then raise exception 'Only % was authorised', public.money_text(t.amount); end if;
  f := public.current_float();
  if f.id is null then raise exception 'No float is open'; end if;
  if p_place = 'bank' and (select petty_bank_name from public.branches where id = f.branch_id) is null then
    raise exception 'This branch has no petty cash bank account. Add it under Petty cash first.';
  end if;
  insert into public.float_transactions (float_id, kind, amount, created_by, note, place)
  values (f.id, 'top_up', round(p_amount, 2), auth.uid(),
          'Authorised by ' || coalesce((select full_name from public.profiles where id = t.decided_by), 'the GM') || ' on ' || to_char(t.decided_at at time zone public.app_tz(), 'DD Mon') || ' – ' || t.reason
            || case when p_place = 'bank' then ' (into the bank account)' else '' end, p_place)
  returning * into tx;
  update public.top_ups set status = 'received', received_by = auth.uid(), received_at = now(), received_amount = round(p_amount, 2),
         transaction_id = tx.id, float_id = f.id where id = p_id returning * into t;
  return t;
end $$;
revoke execute on function public.receive_top_up(uuid, numeric, text) from public, anon;
grant execute on function public.receive_top_up(uuid, numeric, text) to authenticated;

create or replace function public.receive_top_up(p_id uuid, p_amount numeric) returns public.top_ups
language plpgsql security definer set search_path = public as $$
begin
  return public.receive_top_up(p_id, p_amount, 'box');
end $$;

-- money returned to finance, from the box or from the bank account
create or replace function public.float_transaction(p_float uuid, p_kind public.float_tx_kind, p_amount numeric, p_note text, p_place text)
returns public.float_transactions language plpgsql security definer set search_path = public as $$
declare t public.float_transactions%rowtype; f public.floats%rowtype;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can change the float'; end if;
  if p_kind = 'top_up' then raise exception 'A top-up is requested first and authorised by the GM; record it under Petty cash when the cash arrives'; end if;
  if p_kind <> 'return' then raise exception 'Only returns to the finance office are recorded by hand'; end if;
  if coalesce(p_place, '') not in ('box', 'bank') then raise exception 'Say where the money comes from: the cash box or the bank account'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount'; end if;
  select * into f from public.floats where id = p_float for update;
  if f.id is null or f.status <> 'open' then raise exception 'Float is not open'; end if;
  if (case when p_place = 'bank' then public.float_bank_balance(f.id) else public.float_balance(f.id) end) < p_amount then
    raise exception 'Cannot return more than the balance%', case when p_place = 'bank' then ' of the bank account' else ' of the box' end;
  end if;
  insert into public.float_transactions (float_id, kind, amount, created_by, note, place) values (f.id, p_kind, round(p_amount, 2), auth.uid(), nullif(p_note, ''), p_place) returning * into t;
  return t;
end $$;
revoke execute on function public.float_transaction(uuid, public.float_tx_kind, numeric, text, text) from public, anon;
grant execute on function public.float_transaction(uuid, public.float_tx_kind, numeric, text, text) to authenticated;

create or replace function public.float_transaction(p_float uuid, p_kind public.float_tx_kind, p_amount numeric, p_note text default null)
returns public.float_transactions language plpgsql security definer set search_path = public as $$
begin
  return public.float_transaction(p_float, p_kind, p_amount, p_note, 'box');
end $$;

-- cash withdrawn from the bank into the box, or cash from the box paid into the bank (the total stays the same)
create or replace function public.move_cash(p_kind text, p_amount numeric, p_note text default null, p_slip_path text default null) returns public.float_transactions
language plpgsql security definer set search_path = public as $$
declare f public.floats%rowtype; b public.branches%rowtype; t public.float_transactions%rowtype;
        v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_slip text := nullif(btrim(coalesce(p_slip_path, '')), '');
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Finance records money moved between the box and the bank'; end if;
  if coalesce(p_kind, '') not in ('withdrawal', 'deposit') then raise exception 'Choose a cash withdrawal or a deposit'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount'; end if;
  f := public.current_float();
  if f.id is null then raise exception 'No float is open'; end if;
  select * into b from public.branches where id = f.branch_id;
  if b.petty_bank_name is null then raise exception '% has no petty cash bank account. Add it under Petty cash first.', b.name; end if;
  if p_kind = 'withdrawal' and public.float_bank_balance(f.id) < round(p_amount, 2) then
    raise exception 'The bank account shows only % on the book. Record the money paid into it first.', public.money_text(public.float_bank_balance(f.id));
  end if;
  if p_kind = 'deposit' and public.float_balance(f.id) < round(p_amount, 2) then
    raise exception 'The box holds only % on the book.', public.money_text(public.float_balance(f.id));
  end if;
  if v_slip is null and v_note is null then raise exception 'Add a photo of the bank slip, or say why there is none'; end if;
  if v_slip is not null and not exists (select 1 from storage.objects where bucket_id = 'packs' and name = v_slip) then
    raise exception 'The slip photo did not upload. Try again.';
  end if;
  insert into public.float_transactions (float_id, kind, amount, created_by, note, place, slip_path)
  values (f.id, p_kind::public.float_tx_kind, round(p_amount, 2), auth.uid(), v_note, case when p_kind = 'withdrawal' then 'box' else 'bank' end, v_slip)
  returning * into t;
  perform public.notify_role('approver', 'cash_move',
    case when p_kind = 'withdrawal' then 'Cash withdrawn: ' else 'Cash paid into the bank: ' end || public.money_text(t.amount),
    case when p_kind = 'withdrawal' then 'From ' || b.petty_bank_name || ' into the cash box' else 'From the cash box into ' || b.petty_bank_name end
      || ', recorded by ' || coalesce((select full_name from public.profiles where id = auth.uid()), 'finance') || coalesce(' – ' || v_note, '') || '.', '#/cash', null);
  return t;
end $$;
revoke execute on function public.move_cash(text, numeric, text, text) from public, anon;
grant execute on function public.move_cash(text, numeric, text, text) to authenticated;

/* =========================================================================== the two ledgers */
-- the cash box: every movement of cash, with a running balance
create or replace function public.cash_ledger(p_float uuid)
returns table (at timestamptz, kind text, request_id uuid, ref text, description text, person uuid, cash_in numeric, cash_out numeric, balance numeric)
language sql stable security definer set search_path = public as $$
  with moves as (
    select t.created_at as at, t.kind::text as kind,
           case t.kind::text when 'allocation' then 0 when 'carry_over' then 0 when 'top_up' then 1 when 'withdrawal' then 1 when 'return' then 4 when 'deposit' then 4 else 5 end as ord,
           null::uuid as request_id, null::text as ref,
           case t.kind::text when 'allocation' then coalesce(t.note, 'Monthly allocation from finance')
                       when 'carry_over' then coalesce(t.note, 'Carried over')
                       when 'shortage' then coalesce(t.note, 'Cash short, written off')
                       when 'surplus' then coalesce(t.note, 'Cash over, taken in')
                       when 'withdrawal' then 'Cash withdrawn from the bank' || coalesce(' – ' || t.note, '')
                       when 'deposit' then 'Paid into the bank' || coalesce(' – ' || t.note, '')
                       else case t.kind::text when 'top_up' then 'Top-up' else 'Returned to finance' end || coalesce(' – ' || t.note, '') end as description,
           t.created_by as person,
           case when t.kind::text in ('return', 'shortage', 'deposit') then 0 else t.amount end as cash_in,
           case when t.kind::text in ('return', 'shortage', 'deposit') then t.amount else 0 end as cash_out
      from public.float_transactions t where t.float_id = p_float and (t.place = 'box' or t.kind::text in ('withdrawal', 'deposit'))
    union all
    select q.disbursed_at, case when q.type = 'claim' then 'claim' else 'payout' end, 2, q.id, '#' || q.request_no,
           case when q.type = 'claim' then 'Claim reimbursed: ' else 'Paid out: ' end || q.purpose, q.disbursed_to, 0, q.disbursed_amount
      from public.requests q where q.float_id = p_float and q.disbursed_at is not null and q.paid_via = 'cash'
    union all
    select greatest(q.disbursed_at, coalesce((select max(ev.created_at) from public.request_events ev where ev.request_id = q.id and ev.action = 'expense_recorded'), e.created_at)),
           case when e.total < q.disbursed_amount then 'change' else 'paid_back' end, 3, q.id, '#' || q.request_no,
           case when e.total < q.disbursed_amount then 'Change returned: ' else 'Spent more than paid out, paid back: ' end || q.purpose, q.disbursed_to,
           greatest(q.disbursed_amount - e.total, 0), greatest(e.total - q.disbursed_amount, 0)
      from public.requests q join public.expenses e on e.request_id = q.id
     where q.float_id = p_float and q.type <> 'claim' and q.paid_via = 'cash' and q.status in ('proof_review', 'physical_required', 'closed') and abs(e.total - q.disbursed_amount) >= 0.005
  )
  select m.at, m.kind, m.request_id, m.ref, m.description, m.person, round(m.cash_in, 2), round(m.cash_out, 2),
         round(sum(m.cash_in - m.cash_out) over (order by m.at, m.ord, m.ref rows between unbounded preceding and current row), 2)
    from moves m
   where public.has_role('finance') or public.has_role('approver')
   order by m.at, m.ord, m.ref
$$;

-- the petty cash bank account: every movement, with a running balance (what the statement should show)
create or replace function public.bank_ledger(p_float uuid)
returns table (at timestamptz, kind text, request_id uuid, ref text, description text, person uuid, cash_in numeric, cash_out numeric, balance numeric)
language sql stable security definer set search_path = public as $$
  with moves as (
    select t.created_at as at, t.kind::text as kind,
           case t.kind::text when 'allocation' then 0 when 'carry_over' then 0 when 'top_up' then 1 when 'deposit' then 1 when 'withdrawal' then 4 when 'return' then 4 else 5 end as ord,
           null::uuid as request_id, null::text as ref,
           case t.kind::text when 'allocation' then coalesce(t.note, 'Monthly allocation from finance')
                       when 'carry_over' then coalesce(t.note, 'Carried over')
                       when 'shortage' then coalesce(t.note, 'Bank statement below the book, written off')
                       when 'surplus' then coalesce(t.note, 'Bank statement above the book, taken in')
                       when 'withdrawal' then 'Cash withdrawn into the box' || coalesce(' – ' || t.note, '')
                       when 'deposit' then 'Cash paid in from the box' || coalesce(' – ' || t.note, '')
                       when 'top_up' then 'Top-up' || coalesce(' – ' || t.note, '')
                       else 'Returned to the company account' || coalesce(' – ' || t.note, '') end as description,
           t.created_by as person,
           case when t.kind::text in ('return', 'shortage', 'withdrawal') then 0 else t.amount end as cash_in,
           case when t.kind::text in ('return', 'shortage', 'withdrawal') then t.amount else 0 end as cash_out
      from public.float_transactions t where t.float_id = p_float and (t.place = 'bank' or t.kind::text in ('withdrawal', 'deposit'))
    union all
    select q.disbursed_at, 'transfer', 2, q.id, '#' || q.request_no,
           'Paid by transfer: ' || q.purpose || coalesce(' (ref ' || q.payment_ref || ')', ''), q.disbursed_to, 0, q.disbursed_amount
      from public.requests q where q.float_id = p_float and q.paid_via = 'transfer' and q.disbursed_at is not null
  )
  select m.at, m.kind, m.request_id, m.ref, m.description, m.person, round(m.cash_in, 2), round(m.cash_out, 2),
         round(sum(m.cash_in - m.cash_out) over (order by m.at, m.ord, m.ref rows between unbounded preceding and current row), 2)
    from moves m
   where public.has_role('finance') or public.has_role('approver')
   order by m.at, m.ord, m.ref
$$;
revoke execute on function public.bank_ledger(uuid) from public, anon;
grant execute on function public.bank_ledger(uuid) to authenticated;

/* =========================================================================== paying by transfer */
-- finance (or the GM) uploads the proof of payment into the request's folder before recording the transfer
alter policy proofs_insert on storage.objects
  with check (bucket_id = 'proofs' and public.can_view_request(public.try_uuid((storage.foldername(name))[1])) and exists (
    select 1 from public.requests r where r.id = public.try_uuid((storage.foldername(name))[1])
      and (r.status in ('disbursed', 'proof_review', 'physical_required')
        or (r.type = 'claim' and r.status in ('draft', 'pending_approval', 'awaiting_disbursement'))
        or (r.type = 'cash' and r.status = 'awaiting_disbursement' and (public.has_role('finance') or public.has_role('approver'))))));

-- the earlier form (no proof of payment, no choice of account) is no longer used
create or replace function public.pay_by_transfer(p_request uuid, p_amount numeric, p_paid_on date, p_reference text, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Petti has been updated: reload the page, then record the transfer with its proof of payment.';
end $$;

-- a transfer from the petty cash bank account (petty cash) or from the company account (outside petty cash),
-- with its proof of payment; the requester then confirms the supplier delivered
create or replace function public.pay_by_transfer(p_request uuid, p_amount numeric, p_paid_on date, p_reference text, p_from text,
                                                  p_pop_path text, p_pop_name text, p_pop_mime text, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare
  r public.requests%rowtype; e public.expenses%rowtype; s public.settings%rowtype; f public.floats%rowtype; d record; dup jsonb;
  v_cap numeric; v_supplier text; v_bank text; v_ref text := nullif(btrim(coalesce(p_reference, '')), ''); v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can pay a request'; end if;
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.type <> 'cash' then raise exception 'Only a payment request can be paid by bank transfer'; end if;
  if r.status <> 'awaiting_disbursement' then raise exception 'This request is not waiting to be paid'; end if;
  if not (r.branch_id = any(public.my_branches())) then raise exception 'This request belongs to %, which is not your branch', public.branch_name(r.branch_id); end if;
  if coalesce(p_from, '') not in ('petty_cash', 'company') then raise exception 'Say which account paid it: the petty cash bank account or the company account'; end if;
  if not exists (select 1 from public.request_documents where request_id = p_request) then
    raise exception 'A bank transfer needs a quote or invoice attached. Without one, pay it in cash from the petty cash box.';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount paid'; end if;
  if p_paid_on is null then raise exception 'Enter the date of the transfer'; end if;
  if p_paid_on > current_date then raise exception 'The transfer date cannot be in the future'; end if;
  if p_paid_on < current_date - 60 then raise exception 'That date is more than 60 days ago. Check the date of the transfer.'; end if;
  if v_ref is null then raise exception 'Enter the bank reference of the transfer'; end if;
  if length(v_ref) > 60 then raise exception 'The bank reference is too long (60 characters at most)'; end if;
  if nullif(btrim(coalesce(p_pop_path, '')), '') is null then raise exception 'Attach the proof of payment'; end if;
  if split_part(p_pop_path, '/', 1) <> p_request::text
     or not exists (select 1 from storage.objects where bucket_id = 'proofs' and name = p_pop_path and owner_id = auth.uid()::text) then
    raise exception 'The proof of payment did not upload. Try again.';
  end if;
  select * into s from public.settings where id = 1;
  if r.approved_by is null and r.review_reason is null then
    if p_amount > s.approval_threshold then raise exception 'The amount is above the approval threshold. Send it for approval first.'; end if;
  else
    v_cap := round(r.estimated_total * (1 + coalesce(s.change_tolerance_pct, 0) / 100), 2);
    if p_amount > v_cap then
      raise exception 'That is more than was % (%). Send it back for approval with the new amount.',
        case when r.approved_by is not null then 'approved' else 'requested' end, public.money_text(r.estimated_total);
    end if;
    if r.approved_by is not null and coalesce(r.approval_level, 'gm') = 'gm' and p_amount > s.gm_limit then
      raise exception 'That is above the GM limit (%). Send it back so the Managing Director approves the new amount.', public.money_text(s.gm_limit);
    end if;
  end if;
  if r.requester_id = auth.uid() and (r.approved_by is null or r.approved_by = auth.uid()) then
    raise exception 'Someone else must pay your own request';
  end if;
  if p_from = 'petty_cash' then
    select petty_bank_name into v_bank from public.branches where id = r.branch_id;
    if v_bank is null then raise exception '% has no petty cash bank account. Pay it from the company account, or add the account under Petty cash.', public.branch_name(r.branch_id); end if;
    f := public.branch_float(r.branch_id);
    if f.id is null then raise exception 'No open petty cash float for %. Open this month''s float first.', public.branch_name(r.branch_id); end if;
    if public.float_bank_balance(f.id) < round(p_amount, 2) then
      raise exception 'The petty cash bank account shows only % on the book. Record the money paid into it first, or pay from the company account.', public.money_text(public.float_bank_balance(f.id));
    end if;
  end if;

  select nullif(btrim(extracted->>'supplier'), '') into v_supplier from public.request_documents
   where request_id = p_request and nullif(btrim(extracted->>'supplier'), '') is not null order by created_at desc limit 1;

  update public.requests
     set status = 'proof_review', paid_via = 'transfer', paid_from = p_from, payment_ref = v_ref, paid_on = p_paid_on,
         disbursed_by = auth.uid(), disbursed_at = now(), disbursed_amount = round(p_amount, 2), disbursed_to = r.requester_id,
         float_id = case when p_from = 'petty_cash' then f.id end
   where id = p_request returning * into r;
  insert into public.expenses (request_id, spent_by, spent_at, total, change_returned, supplier_name, notes)
  values (p_request, r.requester_id, p_paid_on, round(p_amount, 2), 0, v_supplier, v_note)
  on conflict (request_id) do update set spent_by = excluded.spent_by, spent_at = excluded.spent_at, total = excluded.total, change_returned = 0,
    supplier_name = excluded.supplier_name, notes = excluded.notes, proof_status = 'pending', finance_note = null
  returning * into e;
  update public.expense_lines set void = true where expense_id = e.id and not void;
  insert into public.expense_lines (expense_id, description, qty, unit_price, supplier_name) values (e.id, r.purpose, 1, round(p_amount, 2), v_supplier);
  for d in select * from public.request_documents where request_id = p_request order by created_at loop
    if not exists (select 1 from public.expense_proofs p where p.expense_id = e.id and p.storage_path = d.storage_path) then
      insert into public.expense_proofs (expense_id, storage_path, file_name, mime, uploaded_by, extracted)
      values (e.id, d.storage_path, coalesce(d.file_name, d.kind), d.mime, d.uploaded_by, coalesce(d.extracted, '{}'::jsonb) || jsonb_build_object('pre_payment', true, 'kind', d.kind));
    end if;
  end loop;
  insert into public.expense_proofs (expense_id, storage_path, file_name, mime, uploaded_by, extracted)
  values (e.id, p_pop_path, coalesce(nullif(btrim(coalesce(p_pop_name, '')), ''), 'proof-of-payment'), p_pop_mime, auth.uid(), jsonb_build_object('kind', 'pop'));
  -- the same supplier, date and amount already paid: say why both are right, or stop
  dup := public.receipt_duplicate_of(e.id);
  if dup is not null then
    if v_note is null then
      raise exception 'This looks like #% (%), already recorded. If both payments are right, say why in the note.', dup->>'request_no', dup->>'why';
    end if;
    update public.expenses set duplicate_note = v_note where id = e.id;
  end if;
  update public.expenses set proof_status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now() where id = e.id;

  perform public.log_event(p_request, 'paid_by_transfer', 'awaiting_disbursement', 'proof_review',
    'Ref ' || v_ref || ', ' || to_char(p_paid_on, 'DD Mon YYYY') || ', from ' || case when p_from = 'petty_cash' then v_bank else 'the company account' end || coalesce(' – ' || v_note, ''));
  perform public.notify_user(r.requester_id, 'transfer_paid', 'Paid by bank transfer: ' || public.money_text(p_amount),
    public.req_label(r) || ' – paid' || coalesce(' to ' || v_supplier, '') || ' on ' || to_char(p_paid_on, 'DD Mon YYYY') || ' (ref ' || v_ref || '). '
      || 'The proof of payment is on the request if the supplier needs it. Tap “Supplier confirmed” once the goods or the work are in.',
    '#/requests/' || r.id, r.id);
  if not public.has_role('finance') then   -- the GM paid it: finance hears about it
    perform public.notify_role('finance', 'closed', 'Paid by bank transfer: ' || public.money_text(p_amount),
      public.req_label(r) || ' – recorded by ' || (select full_name from public.profiles where id = auth.uid()) || ' (ref ' || v_ref || ').', '#/requests/' || r.id, r.id);
  end if;
  return r;
end $$;
revoke execute on function public.pay_by_transfer(uuid, numeric, date, text, text, text, text, text, text) from public, anon;
grant execute on function public.pay_by_transfer(uuid, numeric, date, text, text, text, text, text, text) to authenticated;

-- the requester confirms the supplier delivered (finance or the GM can do it for them, with a reason); that closes it
create or replace function public.confirm_supplier(p_request uuid, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_self boolean; v_who text;
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.paid_via <> 'transfer' or r.status <> 'proof_review' then raise exception 'This request is not waiting for the supplier'; end if;
  v_self := r.requester_id = auth.uid();
  if not v_self then
    if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'The person who asked for it confirms the supplier delivered'; end if;
    if v_note is null then raise exception 'Say why you are confirming instead of %', (select full_name from public.profiles where id = r.requester_id); end if;
  end if;
  update public.requests set status = 'closed', supplier_confirmed_by = auth.uid(), supplier_confirmed_at = now(), supplier_note = v_note,
         closed_by = auth.uid(), closed_at = now()
   where id = p_request returning * into r;
  select full_name into v_who from public.profiles where id = auth.uid();
  perform public.log_event(p_request, 'supplier_confirmed', 'proof_review', 'closed', v_note);
  if v_self then
    perform public.notify_user(r.disbursed_by, 'closed', 'Supplier confirmed: ' || public.req_label(r),
      v_who || ' confirmed the supplier delivered' || coalesce(': “' || v_note || '”', '.'), '#/requests/' || r.id, r.id);
  else
    perform public.notify_user(r.requester_id, 'closed', 'Closed: ' || public.req_label(r),
      v_who || ' confirmed the supplier delivered: “' || v_note || '”', '#/requests/' || r.id, r.id);
  end if;
  return r;
end $$;
revoke execute on function public.confirm_supplier(uuid, text) from public, anon;
grant execute on function public.confirm_supplier(uuid, text) to authenticated;

/* =========================================================================== cash handed over */
-- the person who was handed the cash says whether they received it
create or replace function public.confirm_cash(p_request uuid, p_received boolean, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_who text; v_body text;
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.disbursed_to is distinct from auth.uid() then raise exception 'Only the person who was handed the cash confirms it'; end if;
  if r.paid_via <> 'cash' or r.disbursed_at is null then raise exception 'No cash was handed out on this request'; end if;
  if r.cash_received is not null then raise exception 'You already answered this'; end if;
  if p_received is null then raise exception 'Say whether you received the cash'; end if;
  if not p_received and v_note is null then raise exception 'Say what happened – the GM and finance see your note'; end if;
  update public.requests set cash_received = p_received, cash_received_at = now(), cash_received_note = v_note where id = p_request returning * into r;
  select full_name into v_who from public.profiles where id = auth.uid();
  if p_received then
    perform public.log_event(p_request, 'cash_received', r.status, r.status, public.money_text(r.disbursed_amount) || ' received' || coalesce(' – ' || v_note, ''));
  else
    perform public.log_event(p_request, 'cash_not_received', r.status, r.status, v_note);
    v_body := v_who || ' says they did not receive the ' || public.money_text(r.disbursed_amount) || ' for ' || public.req_label(r) || ': “' || v_note || '”';
    perform public.notify_role('approver', 'cash_dispute', 'Cash not received: ' || public.money_text(r.disbursed_amount), v_body, '#/requests/' || r.id, r.id);
    perform public.notify_role('finance', 'cash_dispute', 'Cash not received: ' || public.money_text(r.disbursed_amount), v_body, '#/requests/' || r.id, r.id);
  end if;
  return r;
end $$;
revoke execute on function public.confirm_cash(uuid, boolean, text) from public, anon;
grant execute on function public.confirm_cash(uuid, boolean, text) to authenticated;

/* =========================================================================== reminders */
-- nothing waits silently: remind whoever holds it; a transfer waits on the requester (the supplier); cash handed
-- over and not confirmed by the next working day is chased once
create or replace function public.remind_stale_items() returns int
language plpgsql security definer set search_path = public as $$
declare q public.requests%rowtype; n int := 0; v_holder public.user_role; v_days int; v_label text; v_who text; v_plural text; v_from timestamptz;
begin
  if extract(isodow from now() at time zone public.app_tz()) > 5 then return 0; end if;   -- never on a weekend
  for q in select * from public.requests where status in ('stock_review', 'pending_approval', 'awaiting_disbursement', 'proof_review', 'physical_required') and updated_at < now() - interval '24 hours' loop
    v_days := public.working_days_since(q.updated_at);
    if v_days < 1 then continue; end if;
    v_plural := v_days || ' working day' || case when v_days = 1 then '' else 's' end;
    -- paid by transfer: the requester confirms the supplier delivered (every second working day), finance hears after five
    if q.status = 'proof_review' and q.paid_via = 'transfer' then
      if v_days >= 2 and not exists (select 1 from public.notifications where request_id = q.id and kind = 'supplier_reminder' and created_at > now() - interval '44 hours') then
        perform public.notify_user(q.requester_id, 'supplier_reminder', 'Has the supplier delivered? ' || public.req_label(q),
          'Paid by bank transfer ' || v_plural || ' ago. Once the goods or the work are in, tap “Supplier confirmed” on the request.', '#/requests/' || q.id, q.id);
        n := n + 1;
      end if;
      if v_days >= 5 and not exists (select 1 from public.notifications where request_id = q.id and kind = 'supplier_overdue') then
        perform public.notify_role('finance', 'supplier_overdue', 'Supplier not confirmed: ' || public.req_label(q),
          'Paid by bank transfer ' || v_plural || ' ago and ' || (select full_name from public.profiles where id = q.requester_id) || ' has not confirmed the supplier delivered.', '#/requests/' || q.id, q.id);
      end if;
      continue;
    end if;
    if exists (select 1 from public.notifications where request_id = q.id and kind in ('stale', 'stale_escalation') and created_at > now() - interval '20 hours') then continue; end if;
    v_holder := case q.status
      when 'stock_review' then 'stock_manager'::public.user_role
      when 'pending_approval' then case when q.approval_level = 'md' then 'managing_director'::public.user_role else 'approver'::public.user_role end
      else 'finance'::public.user_role end;
    v_label := public.req_label(q) || ' (' || public.money_text(q.estimated_total) || ') has been waiting ' || v_plural;
    perform public.notify_role(v_holder, 'stale', 'Waiting on you: ' || public.req_label(q), v_label || case q.status when 'stock_review' then ' for stock review.' when 'pending_approval' then ' for approval.' when 'awaiting_disbursement' then ' to be paid out.' when 'proof_review' then ' for the receipt check.' else ' for the paper receipt.' end, '#/requests/' || q.id, q.id);
    if q.status = 'physical_required' and q.disbursed_to is not null then
      perform public.notify_user(q.disbursed_to, 'stale', 'Finance still needs your paper receipt', v_label || '. Hand the original to finance.', '#/requests/' || q.id, q.id);
    end if;
    if v_days >= 2 and v_holder <> 'approver' then
      perform public.notify_role('approver', 'stale_escalation', 'Stuck for ' || v_plural || ': ' || public.req_label(q), 'With ' || replace(v_holder::text, '_', ' ') || ' since ' || to_char(q.updated_at, 'DD Mon') || '.', '#/requests/' || q.id, q.id);
    end if;
    -- the person who asked hears that it was chased, once for each time it sits with someone
    if v_days >= 2 and q.status <> 'physical_required'
       and not exists (select 1 from public.notifications where request_id = q.id and user_id = q.requester_id and kind = 'chased' and created_at > q.updated_at) then
      v_who := case q.status when 'stock_review' then 'the stock manager' when 'pending_approval' then case when q.approval_level = 'md' then 'the MD' else 'the GM' end else 'finance' end;
      perform public.notify_user(q.requester_id, 'chased', 'Still waiting: ' || public.req_label(q),
        'It has been with ' || v_who || ' for ' || v_plural || '. We have reminded them.', '#/requests/' || q.id, q.id);
    end if;
    n := n + 1;
  end loop;
  -- cash handed over and not confirmed by the next working day: the person is asked again, and whoever paid it out is told (once)
  select cash_confirm_from into v_from from public.settings where id = 1;
  for q in select * from public.requests where paid_via = 'cash' and disbursed_at is not null and cash_received is null
             and disbursed_at >= coalesce(v_from, now()) and disbursed_to is distinct from disbursed_by loop
    if public.working_days_since(q.disbursed_at) < 1 then continue; end if;
    if exists (select 1 from public.notifications where request_id = q.id and kind = 'cash_unconfirmed') then continue; end if;
    perform public.notify_user(q.disbursed_to, 'cash_unconfirmed', 'Did you receive ' || public.money_text(q.disbursed_amount) || '?',
      public.req_label(q) || ': finance recorded handing you the cash. Open the request and tap Yes or No.', '#/requests/' || q.id, q.id);
    perform public.notify_user(q.disbursed_by, 'cash_unconfirmed', 'Not confirmed yet: ' || public.money_text(q.disbursed_amount) || ' to ' || (select full_name from public.profiles where id = q.disbursed_to),
      public.req_label(q) || ': they have not yet confirmed receiving the cash.', '#/requests/' || q.id, q.id);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.remind_stale_items() from public, anon, authenticated;

/* =========================================================================== spending, budgets, journal, outlook */
-- petty cash spending only (the box and the petty cash bank account); direct payments from the company account are listed on their own
create or replace view public.v_spend_lines with (security_invoker = true) as
select el.id, e.spent_at, date_trunc('month', e.spent_at)::date as month,
  r.id as request_id, r.request_no, r.type, r.for_store, r.requester_id, p.full_name as requester_name,
  r.disbursed_to, r.disbursed_amount, r.approval_required, r.approved_by, r.float_id, r.status,
  el.item_id, coalesce(i.name, el.description) as description, i.unit, el.qty, el.unit_price, el.line_total,
  coalesce(c.id, rc.id) as category_id, coalesce(c.name, rc.name, 'Uncategorised') as category_name,
  el.supplier_id, el.supplier_name, e.total as expense_total, r.branch_id,
  r.paid_via, r.payment_ref, r.paid_from
from public.expense_lines el
join public.expenses e on e.id = el.expense_id
join public.requests r on r.id = e.request_id
join public.profiles p on p.id = r.requester_id
left join public.items i on i.id = el.item_id
left join public.categories c on c.id = i.category_id
left join public.categories rc on rc.id = r.category_id
where not el.void and r.status in ('proof_review','physical_required','closed') and r.paid_from = 'petty_cash';

-- the journal: spending credits the box or the petty cash bank account; money in, out and between the two is
-- booked both ways; a return to finance is debit Bank, credit petty cash (it was booked the other way round)
create or replace function public.journal(p_month date)
returns table(entry_date date, reference text, account text, account_name text, description text, debit numeric, credit numeric, branch text, currency text, request_no integer)
language sql stable security definer set search_path = public as $$
  with v as (select view_branch as b from public.profiles where id = auth.uid()),
  brs as (select x.bid from unnest(public.my_branches()) x(bid), v where v.b is null or x.bid = v.b),
  m as (select date_trunc('month', p_month)::date as m0, (date_trunc('month', p_month) + interval '1 month')::date as m1),
  acct as (select coalesce(nullif(s.petty_cash_account, ''), 'PETTY-CASH') as cash, coalesce(nullif(s.petty_bank_account, ''), 'PETTY-CASH-BANK') as bank
             from public.settings s where s.id = 1),
  lines as (
    select l.spent_at as entry_date, 'PC-' || l.request_no as reference, coalesce(nullif(c.account_code, ''), 'UNMAPPED-' || upper(replace(coalesce(l.category_name, 'uncategorised'), ' ', '-'))) as account, coalesce(l.category_name, 'Uncategorised') as account_name,
           l.description || ' – ' || l.requester_name || coalesce(' @ ' || l.supplier_name, '') as description, l.line_total as debit, 0::numeric as credit,
           public.branch_name(l.branch_id) as branch, co.currency_code::text as currency, l.request_no
    from public.v_spend_lines l left join public.categories c on c.id = l.category_id join public.branches b on b.id = l.branch_id join public.companies co on co.id = b.company_id, m
    where l.branch_id in (select bid from brs) and l.spent_at >= m.m0 and l.spent_at < m.m1 and public.is_staff()
    union all
    select l.spent_at, 'PC-' || l.request_no,
           case when l.paid_via = 'transfer' then (select bank from acct) else (select cash from acct) end,
           case when l.paid_via = 'transfer' then 'Petty cash bank account' else 'Petty cash' end,
           case when l.paid_via = 'transfer' then 'Bank transfer #' || l.request_no || ' – ' || l.requester_name || coalesce(' (ref ' || l.payment_ref || ')', '')
                else 'Voucher #' || l.request_no || ' – ' || l.requester_name end,
           0, sum(l.line_total),
           public.branch_name(l.branch_id), co.currency_code::text, l.request_no
    from public.v_spend_lines l join public.branches b on b.id = l.branch_id join public.companies co on co.id = b.company_id, m
    where l.branch_id in (select bid from brs) and l.spent_at >= m.m0 and l.spent_at < m.m1 and public.is_staff()
    group by l.spent_at, l.request_no, l.requester_name, l.branch_id, co.currency_code, l.paid_via, l.payment_ref
    union all
    select t.created_at::date, 'PC-FLOAT-' || to_char(f.period, 'YYYYMM'), x.account, x.account_name, coalesce(t.note, t.kind::text), x.debit, x.credit,
           public.branch_name(f.branch_id), co.currency_code::text, null::integer
    from public.float_transactions t join public.floats f on f.id = t.float_id join public.branches b on b.id = f.branch_id join public.companies co on co.id = b.company_id, m, acct,
    lateral (select case when t.place = 'bank' then acct.bank else acct.cash end as here,
                    case when t.place = 'bank' then 'Petty cash bank account' else 'Petty cash' end as here_name) p,
    lateral (values
      (case t.kind::text when 'return' then 'BANK' when 'shortage' then 'CASH-SHORTAGE' when 'withdrawal' then acct.cash when 'deposit' then acct.bank else p.here end,
       case t.kind::text when 'return' then 'Bank' when 'shortage' then 'Cash shortage' when 'withdrawal' then 'Petty cash' when 'deposit' then 'Petty cash bank account' else p.here_name end,
       t.amount, 0::numeric),
      (case t.kind::text when 'allocation' then 'BANK' when 'top_up' then 'BANK' when 'surplus' then 'CASH-SURPLUS' when 'withdrawal' then acct.bank when 'deposit' then acct.cash else p.here end,
       case t.kind::text when 'allocation' then 'Bank' when 'top_up' then 'Bank' when 'surplus' then 'Cash surplus' when 'withdrawal' then 'Petty cash bank account' when 'deposit' then 'Petty cash' else p.here_name end,
       0::numeric, t.amount)) x(account, account_name, debit, credit)
    where f.branch_id in (select bid from brs) and t.created_at >= m.m0 and t.created_at < m.m1 and t.kind <> 'carry_over' and public.is_staff()
  )
  select * from lines order by entry_date, reference, debit desc
$$;
revoke execute on function public.journal(date) from public, anon;
grant execute on function public.journal(date) to authenticated;

-- how much cash the box needs (cash from the box only), and what the bank account holds besides
create or replace function public.outlook_for(p_branch uuid, p_request uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  f record; v_has boolean; v_bal numeric := 0; v_alloc numeric; v_fid uuid; v_period date; v_out numeric := 0; v_spent numeric := 0; v_funds numeric := 0; v_bank numeric := 0;
  today date := current_date; dim int; dleft int; v_branch uuid := p_branch;
  v_this numeric := 0; v_awaiting numeric; v_pending numeric; v_after numeric;
  v_expected numeric; v_months int; v_typical numeric; v_reserve numeric; v_buffer numeric; v_basis text; v_status text;
begin
  if not (public.has_role('approver') or public.has_role('finance')) then raise exception 'Not allowed'; end if;
  if p_request is not null then select branch_id, coalesce(estimated_total, 0) into v_branch, v_this from public.requests where id = p_request; end if;
  v_branch := coalesce(v_branch, public.my_branch());
  if not (v_branch = any(public.my_branches())) then raise exception 'Not your branch'; end if;
  select * into f from public.v_floats where status = 'open' and branch_id = v_branch order by period desc limit 1;
  v_has := found;
  if v_has then
    v_bal := coalesce(f.balance, 0); v_alloc := f.allocated; v_fid := f.id; v_period := f.period; v_out := coalesce(f.outstanding, 0); v_spent := coalesce(f.spent, 0);
    v_funds := coalesce(f.allocated, 0) + coalesce(f.topped_up, 0) + coalesce(f.carried_over, 0) - coalesce(f.returned, 0);
    v_bank := coalesce(f.bank_balance, 0);
  end if;
  dim := extract(day from (date_trunc('month', today) + interval '1 month - 1 day'))::int;
  dleft := dim - extract(day from today)::int;
  select coalesce(reserve_buffer_pct, 15) / 100.0 into v_buffer from public.settings where id = 1;
  select coalesce(sum(estimated_total), 0) into v_awaiting from public.requests where status = 'awaiting_disbursement' and branch_id = v_branch;
  select coalesce(sum(estimated_total), 0) into v_pending from public.requests where status = 'pending_approval' and branch_id = v_branch and (p_request is null or id <> p_request);
  with months as (
    select distinct date_trunc('month', spent_at)::date as m from public.v_spend_lines
    where branch_id = v_branch and paid_via = 'cash' and spent_at >= (date_trunc('month', today) - interval '6 months')::date and spent_at < date_trunc('month', today)::date
  ), after as (
    select m.m,
      coalesce((select sum(l.line_total) from public.v_spend_lines l where l.branch_id = v_branch and l.paid_via = 'cash' and date_trunc('month', l.spent_at)::date = m.m and extract(day from l.spent_at) > extract(day from today)), 0) as rest,
      coalesce((select sum(l.line_total) from public.v_spend_lines l where l.branch_id = v_branch and l.paid_via = 'cash' and date_trunc('month', l.spent_at)::date = m.m), 0) as total
    from months m
  )
  select round(avg(rest), 2), count(*), round(avg(total), 2) into v_expected, v_months, v_typical from after;
  if coalesce(v_months, 0) = 0 then
    v_expected := round(coalesce(v_alloc, (select coalesce(b.usual_float, s.default_monthly_float) from public.settings s, public.branches b where s.id = 1 and b.id = v_branch), 0) * dleft / dim, 2);
    v_typical := null; v_basis := 'no history yet – pro-rata of the float';
  else
    v_basis := v_months || ' month' || case when v_months = 1 then '' else 's' end || ' of spending';
  end if;
  v_reserve := round(v_expected * (1 + v_buffer), 2);
  v_after := v_bal - v_awaiting - v_this;
  v_status := case when not v_has then 'no_float' when v_after < 0 then 'overdrawn' when v_after < v_expected then 'short' when v_after < v_reserve then 'caution' else 'ok' end;
  return jsonb_build_object(
    'has_float', v_has, 'float_id', v_fid, 'period', v_period, 'branch_id', v_branch, 'branch', public.branch_name(v_branch),
    'balance', v_bal, 'outstanding', v_out, 'spent', v_spent, 'funds', v_funds,
    'awaiting', v_awaiting, 'pending_other', v_pending, 'this_request', v_this,
    'after_approval', round(v_after, 2), 'after_all_pending', round(v_after - v_pending, 2),
    'days_left', dleft, 'days_in_month', dim,
    'expected_remaining', v_expected, 'reserve', v_reserve, 'buffer_pct', round(v_buffer * 100),
    'typical_month', v_typical, 'months', coalesce(v_months, 0), 'basis', v_basis, 'status', v_status,
    'bank_balance', v_bank, 'bank_name', (select petty_bank_name from public.branches where id = v_branch));
end $$;
revoke execute on function public.outlook_for(uuid, uuid) from public, anon;
grant execute on function public.outlook_for(uuid, uuid) to authenticated;

-- budgets, the management summary, the exceptions log and the receipt check, adjusted where they stand
do $$
declare d text; o text;
begin
  -- petty cash budgets count petty cash spending, not direct payments from the company account
  d := pg_get_functiondef('public.budget_check(uuid)'::regprocedure); o := d;
  d := replace(d, 'where not el.void and q.id <> p_request and q.status in (''proof_review'',''physical_required'',''closed'') and e.spent_at >= v_month',
                  'where not el.void and q.id <> p_request and q.status in (''proof_review'',''physical_required'',''closed'') and q.paid_from = ''petty_cash'' and e.spent_at >= v_month');
  if d = o then raise exception 'budget_check: not changed'; end if;
  execute d;
  d := pg_get_functiondef('public.budget_status()'::regprocedure); o := d;
  d := replace(d, 'where not el.void and q.status in (''proof_review'',''physical_required'',''closed'') and e.spent_at >= date_trunc(''month'', current_date)::date',
                  'where not el.void and q.status in (''proof_review'',''physical_required'',''closed'') and q.paid_from = ''petty_cash'' and e.spent_at >= date_trunc(''month'', current_date)::date');
  if d = o then raise exception 'budget_status: not changed'; end if;
  execute d;
  -- question 4 of the management summary shows the bank account next to the box
  d := pg_get_functiondef('public.management_summary(date)'::regprocedure); o := d;
  d := replace(d, '''balance'', f.balance, ''counted'', f.counted_cash,',
                  '''balance'', f.balance, ''counted'', f.counted_cash, ''bank_balance'', f.bank_balance, ''bank_funds'', f.bank_funded - f.bank_returned, ''bank_paid'', f.bank_paid, ''bank_statement'', f.closing_bank,');
  if d = o then raise exception 'management_summary: not changed'; end if;
  execute d;
  -- cash someone says they never received is an exception for the GM (anchored on code: live has no comments here)
  d := pg_get_functiondef('public.exceptions_log(date)'::regprocedure); o := d;
  d := replace(d, 'select ''undone'', ev.id, ev.created_at, ''Pay-out undone''',
'select ''cash_not_received'', ev.id, ev.created_at, ''Cash not received'', coalesce(ev.note, '''') || '' · '' || r.purpose, r.disbursed_to, r.disbursed_amount, r.id, r.branch_id, ''open'', null, null, null
    from public.request_events ev join public.requests r on r.id = ev.request_id where ev.action = ''cash_not_received'' and ev.created_at >= p_from
    union all
    select ''undone'', ev.id, ev.created_at, ''Pay-out undone''');
  if d = o then raise exception 'exceptions_log: not changed'; end if;
  execute d;
  -- a transfer is closed by the supplier confirmation, not by the receipt check
  d := pg_get_functiondef('public.finance_review_expense(uuid, text, text)'::regprocedure); o := d;
  d := replace(d, 'then raise exception ''There is no expense awaiting review on this request''; end if;',
                  'then raise exception ''There is no expense awaiting review on this request''; end if;
  if r.paid_via = ''transfer'' then raise exception ''A bank transfer closes when the supplier is confirmed (“Supplier confirmed” on the request)''; end if;');
  if d = o then raise exception 'finance_review_expense: not changed'; end if;
  execute d;
end $$;
