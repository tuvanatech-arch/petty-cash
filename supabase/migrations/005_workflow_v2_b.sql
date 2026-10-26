-- v2 workflow (part B): expenses with price watch, finance review (claims aware), stock & float on has_role, reminders

create or replace function public.record_expense(p_request uuid, p_spent_at date, p_lines jsonb, p_notes text default null) returns public.expenses
language plpgsql security definer set search_path = public as $$
declare
  r public.requests%rowtype; e public.expenses%rowtype; l jsonb; m public.stock_movements%rowtype;
  v_item uuid; v_desc text; v_qty numeric; v_price numeric; v_sup uuid; v_supname text; v_total numeric := 0;
  v_issue numeric; rec record; v_last numeric; v_name text; v_pct int;
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'disbursed' then raise exception 'An expense can only be recorded while the request is in the "disbursed" stage'; end if;
  if auth.uid() <> r.disbursed_to and not (public.has_role('finance') or public.has_role('approver')) then
    raise exception 'Only the person who received the cash can record this expense';
  end if;
  select * into e from public.expenses where request_id = p_request;
  if e.id is null then
    insert into public.expenses (request_id, spent_by, spent_at, total) values (p_request, auth.uid(), p_spent_at, 0) returning * into e;
  end if;
  if not exists (select 1 from public.expense_proofs where expense_id = e.id) then
    raise exception 'Upload a scanned copy of the receipt before submitting the expense';
  end if;

  for m in select * from public.stock_movements where expense_id = e.id and not void loop
    insert into public.stock_movements (item_id, kind, delta, request_id, expense_id, created_by, note, void)
    values (m.item_id, 'reversal', -m.delta, p_request, e.id, auth.uid(), 'Reversed: expense re-recorded', true);
    update public.stock_movements set void = true where id = m.id;
  end loop;
  update public.expense_lines set void = true where expense_id = e.id and not void;

  for l in select * from jsonb_array_elements(p_lines) loop
    v_item    := public.try_uuid(l->>'item_id');
    v_desc    := coalesce(l->>'description', '');
    v_qty     := (l->>'qty')::numeric;
    v_price   := (l->>'unit_price')::numeric;
    v_sup     := public.try_uuid(l->>'supplier_id');
    v_supname := nullif(l->>'supplier_name', '');
    if v_qty is null or v_qty <= 0 or v_price is null or v_price < 0 then raise exception 'Each line needs a quantity and a unit price'; end if;
    if v_item is not null and v_desc = '' then select name into v_desc from public.items where id = v_item; end if;
    if v_sup is not null and v_supname is null then select name into v_supname from public.suppliers where id = v_sup; end if;
    if v_desc = '' then raise exception 'Each line needs a description'; end if;
    insert into public.expense_lines (expense_id, item_id, description, qty, unit_price, supplier_id, supplier_name)
    values (e.id, v_item, v_desc, v_qty, v_price, v_sup, v_supname);
    v_total := v_total + round(v_qty * v_price, 2);
    if v_item is not null and r.type = 'stock' then
      insert into public.stock_movements (item_id, kind, delta, unit_cost, request_id, expense_id, supplier_id, created_by, note, occurred_on)
      values (v_item, 'purchase_in', v_qty, v_price, p_request, e.id, v_sup, auth.uid(), 'Bought on request #' || r.request_no, coalesce(p_spent_at, current_date));
      -- price watch: more than 10% above the last price paid
      select last_unit_price, name into v_last, v_name from public.items where id = v_item;
      if v_last > 0 and v_price > v_last * 1.10 then
        v_pct := round((v_price / v_last - 1) * 100);
        perform public.notify_role('stock_manager', 'price_jump', 'Price up ' || v_pct || '%: ' || v_name,
          public.money_text(v_last) || ' → ' || public.money_text(v_price) || coalesce(' at ' || v_supname, '') || ' on ' || public.req_label(r), '#/stock/usage', p_request);
        perform public.notify_role('approver', 'price_jump', 'Price up ' || v_pct || '%: ' || v_name,
          public.money_text(v_last) || ' → ' || public.money_text(v_price) || coalesce(' at ' || v_supname, '') || ' on ' || public.req_label(r), '#/stock/usage', p_request);
      end if;
      update public.items set last_unit_price = v_price, preferred_supplier_id = coalesce(v_sup, preferred_supplier_id) where id = v_item;
    end if;
  end loop;
  if v_total <= 0 then raise exception 'Add at least one line with an amount'; end if;

  if r.type = 'stock' and not r.for_store then
    for rec in
      select rl.item_id, sum(rl.qty_to_buy) as to_buy,
             (select coalesce(sum(el.qty), 0) from public.expense_lines el where el.expense_id = e.id and el.item_id = rl.item_id and not el.void) as bought
        from public.request_lines rl where rl.request_id = p_request and rl.item_id is not null and rl.qty_to_buy > 0
       group by rl.item_id
    loop
      v_issue := least(rec.to_buy, rec.bought);
      if v_issue > 0 then
        insert into public.stock_movements (item_id, kind, delta, request_id, expense_id, issued_to, created_by, note, occurred_on)
        values (rec.item_id, 'issue_out', -v_issue, p_request, e.id, r.requester_id, auth.uid(), 'Issued to requester on request #' || r.request_no, coalesce(p_spent_at, current_date));
      end if;
    end loop;
  end if;

  update public.expenses
     set spent_by = auth.uid(), spent_at = coalesce(p_spent_at, current_date), notes = nullif(p_notes, ''),
         total = round(v_total, 2), change_returned = greatest(round(r.disbursed_amount - v_total, 2), 0),
         proof_status = 'pending', finance_note = null
   where id = e.id returning * into e;
  update public.requests set status = 'proof_review' where id = p_request;
  perform public.log_event(p_request, 'expense_recorded', 'disbursed', 'proof_review',
    'Spent ' || v_total || case when v_total > r.disbursed_amount then ' (over by ' || (v_total - r.disbursed_amount) || ')' else ', change ' || greatest(r.disbursed_amount - v_total, 0) end);
  perform public.notify_stage(p_request);
  return e;
end $$;

create or replace function public.finance_review_expense(p_request uuid, p_action text, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; e public.expenses%rowtype; v_proofs int; v_from public.request_status; v_link text;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can review proofs'; end if;
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  select * into e from public.expenses where request_id = p_request;
  if e.id is null then raise exception 'There is no expense on this request'; end if;
  select count(*) into v_proofs from public.expense_proofs where expense_id = e.id;
  v_from := r.status; v_link := '#/requests/' || r.id;

  -- claims are reviewed before they are reimbursed
  if r.type = 'claim' then
    if r.status <> 'awaiting_disbursement' then raise exception 'This claim is not waiting for finance'; end if;
    if p_action = 'return' then
      if coalesce(p_note, '') = '' then raise exception 'Tell the claimant what needs correcting'; end if;
      update public.expenses set proof_status = 'returned', finance_note = p_note where id = e.id;
      update public.requests set status = 'draft', submitted_at = null where id = p_request returning * into r;
      perform public.log_event(p_request, 'expense_returned', v_from, 'draft', p_note);
      perform public.notify_user(r.requester_id, 'returned', 'Claim returned: ' || public.req_label(r), p_note, v_link, r.id);
    elsif p_action = 'require_physical' then
      update public.expenses set proof_status = 'physical_required', physical_required_by = auth.uid(), physical_required_at = now(), finance_note = nullif(p_note, '') where id = e.id;
      perform public.log_event(p_request, 'physical_required', v_from, v_from, p_note);
      perform public.notify_user(r.requester_id, 'physical', 'Finance needs the paper receipt: ' || public.req_label(r), coalesce(p_note, 'Hand the original to finance to be reimbursed.'), v_link, r.id);
    elsif p_action = 'physical_received' then
      update public.expenses set physical_received_by = auth.uid(), physical_received_at = now() where id = e.id;
      perform public.log_event(p_request, 'physical_received', v_from, v_from, p_note);
    else
      raise exception 'Use "Reimburse" to confirm and close a claim';
    end if;
    return r;
  end if;

  if r.status not in ('proof_review','physical_required') then raise exception 'There is no expense awaiting review on this request'; end if;

  if p_action = 'confirm' then
    if v_proofs = 0 then raise exception 'No scanned proof has been uploaded'; end if;
    if e.proof_status = 'physical_required' and e.physical_received_at is null then
      raise exception 'Physical proof was required but has not been marked as received';
    end if;
    update public.expenses set proof_status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(),
           finance_note = coalesce(nullif(p_note, ''), finance_note) where id = e.id;
    update public.requests set status = 'closed', closed_by = auth.uid(), closed_at = now() where id = p_request returning * into r;
    perform public.log_event(p_request, 'proof_confirmed', v_from, 'closed', p_note);
    perform public.notify_user(r.disbursed_to, 'closed', 'Closed: ' || public.req_label(r), 'Finance confirmed the receipt. Nothing more to do.', v_link, r.id);
    if r.requester_id <> r.disbursed_to then perform public.notify_user(r.requester_id, 'closed', 'Closed: ' || public.req_label(r), 'Bought and confirmed by finance.', v_link, r.id); end if;

  elsif p_action = 'require_physical' then
    update public.expenses set proof_status = 'physical_required', physical_required_by = auth.uid(), physical_required_at = now(),
           finance_note = nullif(p_note, '') where id = e.id;
    update public.requests set status = 'physical_required' where id = p_request returning * into r;
    perform public.log_event(p_request, 'physical_required', v_from, 'physical_required', p_note);
    perform public.notify_user(r.disbursed_to, 'physical', 'Finance needs the paper receipt: ' || public.req_label(r), coalesce(p_note, 'Hand the original receipt to finance.'), v_link, r.id);

  elsif p_action = 'physical_received' then
    if v_proofs = 0 then raise exception 'A scanned copy must be on file before closing'; end if;
    update public.expenses set physical_received_by = auth.uid(), physical_received_at = now(),
           proof_status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(),
           finance_note = coalesce(nullif(p_note, ''), finance_note) where id = e.id;
    update public.requests set status = 'closed', closed_by = auth.uid(), closed_at = now() where id = p_request returning * into r;
    perform public.log_event(p_request, 'physical_received', v_from, 'closed', p_note);
    perform public.notify_user(r.disbursed_to, 'closed', 'Closed: ' || public.req_label(r), 'Finance received the paper receipt. Nothing more to do.', v_link, r.id);

  elsif p_action = 'return' then
    if coalesce(p_note, '') = '' then raise exception 'Tell the spender what needs correcting'; end if;
    update public.expenses set proof_status = 'returned', finance_note = p_note where id = e.id;
    update public.requests set status = 'disbursed' where id = p_request returning * into r;
    perform public.log_event(p_request, 'expense_returned', v_from, 'disbursed', p_note);
    perform public.notify_user(r.disbursed_to, 'returned', 'Returned for correction: ' || public.req_label(r), p_note, v_link, r.id);
  else
    raise exception 'Unknown action %', p_action;
  end if;
  return r;
end $$;

-- ---------- stock (stand-in aware) ----------
create or replace function public.issue_stock(p_item uuid, p_qty numeric, p_to uuid, p_note text default null) returns public.stock_movements
language plpgsql security definer set search_path = public as $$
declare m public.stock_movements%rowtype; v_onhand numeric;
begin
  if not (public.has_role('stock_manager') or public.has_role('approver')) then raise exception 'Only the stock manager can issue stock'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be positive'; end if;
  select qty_on_hand into v_onhand from public.items where id = p_item for update;
  if v_onhand is null then raise exception 'Item not found'; end if;
  if v_onhand < p_qty then raise exception 'Only % on hand', v_onhand; end if;
  insert into public.stock_movements (item_id, kind, delta, issued_to, created_by, note)
  values (p_item, 'issue_out', -p_qty, p_to, auth.uid(), nullif(p_note, '')) returning * into m;
  return m;
end $$;

create or replace function public.receive_stock(p_item uuid, p_qty numeric, p_unit_cost numeric default null, p_supplier uuid default null, p_note text default null) returns public.stock_movements
language plpgsql security definer set search_path = public as $$
declare m public.stock_movements%rowtype;
begin
  if not (public.has_role('stock_manager') or public.has_role('approver')) then raise exception 'Only the stock manager can receive stock'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be positive'; end if;
  insert into public.stock_movements (item_id, kind, delta, unit_cost, supplier_id, created_by, note)
  values (p_item, 'purchase_in', p_qty, p_unit_cost, p_supplier, auth.uid(), coalesce(nullif(p_note, ''), 'Received outside petty cash')) returning * into m;
  if p_unit_cost is not null then update public.items set last_unit_price = p_unit_cost where id = p_item; end if;
  return m;
end $$;

create or replace function public.adjust_stock(p_item uuid, p_new_qty numeric, p_note text) returns public.stock_movements
language plpgsql security definer set search_path = public as $$
declare m public.stock_movements%rowtype; v_onhand numeric;
begin
  if not (public.has_role('stock_manager') or public.has_role('approver')) then raise exception 'Only the stock manager can adjust stock'; end if;
  if p_new_qty is null or p_new_qty < 0 then raise exception 'Counted quantity cannot be negative'; end if;
  if coalesce(p_note, '') = '' then raise exception 'Give a reason for the adjustment'; end if;
  select qty_on_hand into v_onhand from public.items where id = p_item for update;
  if v_onhand is null then raise exception 'Item not found'; end if;
  insert into public.stock_movements (item_id, kind, delta, created_by, note)
  values (p_item, 'count', p_new_qty - v_onhand, auth.uid(), p_note) returning * into m;
  return m;
end $$;

create or replace function public.record_usage(p_item uuid, p_qty numeric, p_on date default current_date, p_note text default null) returns public.stock_movements
language plpgsql security definer set search_path = public as $$
declare m public.stock_movements%rowtype; v_onhand numeric;
begin
  if not (public.has_role('stock_manager') or public.has_role('approver')) then raise exception 'Only the stock manager can record usage'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be positive'; end if;
  if p_on > current_date then raise exception 'Usage cannot be in the future'; end if;
  select qty_on_hand into v_onhand from public.items where id = p_item for update;
  if v_onhand is null then raise exception 'Item not found'; end if;
  if v_onhand < p_qty then raise exception 'Only % on hand – do a quick count instead', v_onhand; end if;
  insert into public.stock_movements (item_id, kind, delta, created_by, note, occurred_on, created_at)
  values (p_item, 'usage', -p_qty, auth.uid(), nullif(p_note, ''), coalesce(p_on, current_date),
          case when p_on < current_date then (p_on + time '12:00')::timestamptz else now() end)
  returning * into m;
  return m;
end $$;

create or replace function public.quick_count(p_lines jsonb, p_on date default current_date, p_note text default null) returns int
language plpgsql security definer set search_path = public as $$
declare l jsonb; v_item uuid; v_counted numeric; v_onhand numeric; v_delta numeric; v_n int := 0; v_at timestamptz;
begin
  if not (public.has_role('stock_manager') or public.has_role('approver')) then raise exception 'Only the stock manager can count stock'; end if;
  if p_on > current_date then raise exception 'A count cannot be in the future'; end if;
  v_at := case when p_on < current_date then (p_on + time '12:00')::timestamptz else now() end;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_item := (l->>'item_id')::uuid;
    v_counted := (l->>'counted')::numeric;
    if v_counted is null or v_counted < 0 then continue; end if;
    select qty_on_hand into v_onhand from public.items where id = v_item for update;
    if v_onhand is null then continue; end if;
    v_delta := v_counted - v_onhand;
    if v_delta = 0 then continue; end if;
    insert into public.stock_movements (item_id, kind, delta, created_by, note, occurred_on, created_at)
    values (v_item, case when v_delta < 0 then 'usage' else 'count' end, v_delta, auth.uid(),
            coalesce(nullif(p_note, ''), case when v_delta < 0 then 'Used since last count' else 'Found more than recorded at count' end),
            coalesce(p_on, current_date), v_at);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function public.create_restock_request(p_purpose text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; it record; st record; v_target numeric; v_qty numeric; v_n int := 0;
begin
  if not (public.has_role('stock_manager') or public.has_role('approver')) then raise exception 'Only the stock manager can raise restock orders'; end if;
  insert into public.requests (type, requester_id, purpose, for_store)
  values ('stock', auth.uid(), coalesce(nullif(p_purpose, ''), 'Monthly restock – ' || to_char(now(), 'Mon YYYY')), true)
  returning * into r;
  for it in select * from public.items where active and (recurring or (reorder_level > 0 and qty_on_hand < reorder_level)) order by name loop
    select * into st from public.item_usage_stats() s where s.item_id = it.id;
    if it.recurring then
      if st.avg_daily > 0 and st.since <= current_date - 14 then v_target := ceil(st.avg_daily * 30 * 1.15); else v_target := it.expected_monthly_qty; end if;
      v_qty := greatest(v_target - it.qty_on_hand, 0);
    else
      v_qty := greatest(it.reorder_level - it.qty_on_hand, 0);
    end if;
    if v_qty > 0 then
      v_n := v_n + 1;
      insert into public.request_lines (request_id, line_no, item_id, description, qty, est_unit_price)
      values (r.id, v_n, it.id, it.name, v_qty, coalesce(it.last_unit_price, 0));
    end if;
  end loop;
  return r;
end $$;

-- ---------- float (stand-in aware) ----------
create or replace function public.open_float(p_period date, p_amount numeric, p_note text default null) returns public.floats
language plpgsql security definer set search_path = public as $$
declare f public.floats%rowtype; prev public.floats%rowtype; v_period date; v_carry numeric; s public.settings%rowtype;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can open a float'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Enter the float amount'; end if;
  v_period := date_trunc('month', coalesce(p_period, current_date))::date;
  if exists (select 1 from public.floats where period = v_period) then raise exception 'A float for % already exists', to_char(v_period, 'Mon YYYY'); end if;
  if exists (select 1 from public.floats where status = 'open') then raise exception 'Close the current float before opening a new one'; end if;
  select * into s from public.settings where id = 1;
  insert into public.floats (period, opening_amount, opened_by, notes) values (v_period, round(p_amount, 2), auth.uid(), nullif(p_note, '')) returning * into f;
  insert into public.float_transactions (float_id, kind, amount, created_by, note) values (f.id, 'allocation', round(p_amount, 2), auth.uid(), 'Monthly allocation from finance');
  if s.float_rollover then
    select * into prev from public.floats where period < v_period and status = 'closed' order by period desc limit 1;
    if prev.id is not null then
      v_carry := public.float_balance(prev.id);
      if v_carry > 0 then
        insert into public.float_transactions (float_id, kind, amount, created_by, note)
        values (f.id, 'carry_over', v_carry, auth.uid(), 'Carried over from ' || to_char(prev.period, 'Mon YYYY'));
      end if;
    end if;
  end if;
  return f;
end $$;

create or replace function public.float_transaction(p_float uuid, p_kind public.float_tx_kind, p_amount numeric, p_note text default null) returns public.float_transactions
language plpgsql security definer set search_path = public as $$
declare t public.float_transactions%rowtype; f public.floats%rowtype;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can change the float'; end if;
  if p_kind not in ('top_up','return') then raise exception 'Only top-ups and returns can be added by hand'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount'; end if;
  select * into f from public.floats where id = p_float for update;
  if f.id is null or f.status <> 'open' then raise exception 'Float is not open'; end if;
  if p_kind = 'return' and public.float_balance(f.id) < p_amount then raise exception 'Cannot return more than the balance'; end if;
  insert into public.float_transactions (float_id, kind, amount, created_by, note) values (f.id, p_kind, round(p_amount, 2), auth.uid(), nullif(p_note, '')) returning * into t;
  return t;
end $$;

create or replace function public.close_float(p_float uuid, p_counted_cash numeric, p_notes text default null) returns public.floats
language plpgsql security definer set search_path = public as $$
declare f public.floats%rowtype; v_open int;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can close a float'; end if;
  select * into f from public.floats where id = p_float for update;
  if f.id is null or f.status <> 'open' then raise exception 'Float is not open'; end if;
  select count(*) into v_open from public.requests where float_id = p_float and status = 'disbursed';
  if v_open > 0 then raise exception '% advance(s) still have no expense recorded. Chase those before closing.', v_open; end if;
  update public.floats set status = 'closed', closed_by = auth.uid(), closed_at = now(), counted_cash = p_counted_cash,
         notes = coalesce(nullif(p_notes, ''), notes) where id = p_float returning * into f;
  return f;
end $$;

-- ---------- reminders (run by the scheduler; an approver may also trigger them) ----------
create or replace function public.remind_outstanding_advances() returns int
language plpgsql security definer set search_path = public as $$
declare q record; s public.settings%rowtype; n int := 0; v_days int;
begin
  if auth.uid() is not null and not public.has_role('approver') then raise exception 'Not allowed'; end if;
  select * into s from public.settings where id = 1;
  for q in select * from public.requests where status = 'disbursed' loop
    v_days := current_date - q.disbursed_at::date;
    if v_days >= s.advance_grace_days and not exists (select 1 from public.notifications where request_id = q.id and kind = 'advance_reminder' and created_at > now() - interval '3 days') then
      perform public.notify_user(q.disbursed_to, 'advance_reminder', 'Cash out for ' || v_days || ' days – record what you spent',
        public.req_label(q) || ': ' || public.money_text(q.disbursed_amount) || ' paid out on ' || to_char(q.disbursed_at, 'DD Mon') || '. Upload the receipt and record the expense.', '#/requests/' || q.id, q.id);
      n := n + 1;
    end if;
    if v_days >= 7 and not exists (select 1 from public.notifications where request_id = q.id and kind = 'advance_overdue' and created_at > now() - interval '7 days') then
      perform public.notify_role('finance', 'advance_overdue', 'Advance overdue ' || v_days || ' days: ' || (select full_name from public.profiles where id = q.disbursed_to),
        public.req_label(q) || ' – ' || public.money_text(q.disbursed_amount) || ' still unaccounted for.', '#/requests/' || q.id, q.id);
      perform public.notify_role('approver', 'advance_overdue', 'Advance overdue ' || v_days || ' days: ' || (select full_name from public.profiles where id = q.disbursed_to),
        public.req_label(q) || ' – ' || public.money_text(q.disbursed_amount) || ' still unaccounted for.', '#/requests/' || q.id, q.id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function public.remind_weekly_count() returns int
language plpgsql security definer set search_path = public as $$
declare s public.settings%rowtype;
begin
  if auth.uid() is not null and not public.has_role('approver') then raise exception 'Not allowed'; end if;
  select * into s from public.settings where id = 1;
  if extract(dow from current_date) <> s.count_day then return 0; end if;
  if exists (select 1 from public.notifications where kind = 'weekly_count' and created_at::date = current_date) then return 0; end if;
  perform public.notify_role('stock_manager', 'weekly_count', 'Time for the weekly stock count',
    'Open Stock → Quick count and type what is on the shelf. Two minutes keeps the usage figures honest.', '#/stock');
  return 1;
end $$;

revoke execute on all functions in schema public from public, anon;
