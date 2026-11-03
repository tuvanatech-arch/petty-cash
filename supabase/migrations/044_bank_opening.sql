-- 044: the petty cash bank account starts at what is already in it.
-- When finance adds the account, Petti asks for the balance on the bank statement and starts the account at that
-- amount. It is booked as a carry-over into the bank (like the start of a month), not as new money: the money is
-- already in the company's books, and the journal skips carry-overs. Allowed only before the account has any
-- movement in Petti; after that, "Check the bank" brings the book in line with the statement. The GM is told.

create or replace function public.set_petty_bank(p_name text, p_opening numeric, p_note text)
returns public.branches language plpgsql security definer set search_path = public as $$
declare b public.branches%rowtype; f public.floats%rowtype; v_open numeric := round(coalesce(p_opening, 0), 2);
        v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_open < 0 then raise exception 'The balance on the statement cannot be below zero'; end if;
  b := public.set_petty_bank(p_name);
  if v_open = 0 then return b; end if;
  if b.petty_bank_name is null then raise exception 'Enter the name of the account first'; end if;
  f := public.branch_float(b.id);
  if f.id is null then raise exception 'Open the float first, then add what is in the bank account'; end if;
  if exists (select 1 from public.float_transactions where float_id = f.id and (place = 'bank' or kind in ('withdrawal', 'deposit')))
     or exists (select 1 from public.cash_counts where float_id = f.id and place = 'bank')
     or exists (select 1 from public.requests where float_id = f.id and paid_via = 'transfer') then
    raise exception 'The bank account already has movements in Petti. Use “Check the bank” to bring it in line with the statement.';
  end if;
  insert into public.float_transactions (float_id, kind, amount, created_by, note, place)
  values (f.id, 'carry_over', v_open, auth.uid(), 'Opening balance of ' || b.petty_bank_name || ' (bank statement)' || coalesce(' – ' || v_note, ''), 'bank');
  perform public.notify_role('approver', 'cash_move', 'Petty cash bank account added: ' || public.money_text(v_open),
    b.petty_bank_name || ' starts at ' || public.money_text(v_open) || ' from the bank statement, recorded by '
      || coalesce((select full_name from public.profiles where id = auth.uid()), 'finance') || coalesce(' – ' || v_note, '') || '.', '#/cash', null);
  return b;
end $$;
revoke execute on function public.set_petty_bank(text, numeric, text) from public, anon;
grant execute on function public.set_petty_bank(text, numeric, text) to authenticated;
