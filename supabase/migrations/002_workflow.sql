-- Petty cash & stock management: workflow functions, views, storage
-- Routing:
--   stock request  : requester -> stock manager review -> approver (if to-buy total > threshold) -> finance disburses
--   restock order  : stock manager (for_store) -> approver (if > threshold) -> finance disburses
--   cash request   : requester -> approver (if > threshold) -> finance disburses
--   after cash     : spender uploads scanned proof + records expense -> finance confirms (may require physical) -> closed

alter table public.requests add column if not exists category_id uuid references public.categories(id);
alter table public.stock_movements add column if not exists supplier_id uuid references public.suppliers(id);

create policy requests_delete_draft on public.requests for delete to authenticated
  using (requester_id = auth.uid() and status = 'draft');

-- ---------- helpers ----------
create or replace function public.try_uuid(p text) returns uuid
language plpgsql immutable as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

create or replace function public.log_event(p_request uuid, p_action text, p_from public.request_status, p_to public.request_status, p_note text default null)
returns void language sql security definer set search_path = public as $$
  insert into public.request_events (request_id, actor_id, action, from_status, to_status, note)
  values (p_request, auth.uid(), p_action, p_from, p_to, nullif(p_note, ''))
$$;
revoke execute on function public.log_event(uuid, text, public.request_status, public.request_status, text) from public, anon, authenticated;

create or replace function public.float_balance(p_float uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select round(
      coalesce((select sum(case when kind = 'return' then -amount else amount end)
                from public.float_transactions where float_id = p_float), 0)
    - coalesce((select sum(disbursed_amount) from public.requests
                where float_id = p_float and status = 'disbursed'), 0)
    - coalesce((select sum(e.total) from public.expenses e
                join public.requests r on r.id = e.request_id
                where r.float_id = p_float and r.status in ('proof_review','physical_required','closed')), 0)
  , 2)
$$;

create or replace function public.current_float() returns public.floats
language sql stable security definer set search_path = public as $$
  select * from public.floats where status = 'open' order by period desc limit 1
$$;

-- ---------- request lifecycle ----------
create or replace function public.submit_request(p_request uuid) returns public.requests
language plpgsql security definer set search_path = public as $$
declare
  r public.requests%rowtype;
  v_total numeric; v_lines int; v_next public.request_status;
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.requester_id <> auth.uid() then raise exception 'Only the requester can submit this request'; end if;
  if r.status <> 'draft' then raise exception 'Only draft requests can be submitted'; end if;
  select count(*), coalesce(sum(qty * est_unit_price), 0) into v_lines, v_total
    from public.request_lines where request_id = p_request;
  if v_lines = 0 then raise exception 'Add at least one line before submitting'; end if;
  if r.for_store and public.my_role() not in ('stock_manager','approver') then
    raise exception 'Only the stock manager can raise restock orders';
  end if;

  if r.type = 'stock' and not r.for_store then
    v_next := 'stock_review';
  else
    if exists (select 1 from public.request_lines where request_id = p_request and est_unit_price <= 0) then
      raise exception 'Enter an estimated price for every line';
    end if;
    update public.request_lines set qty_to_buy = qty, qty_from_stock = 0 where request_id = p_request;
    v_next := case when v_total > public.threshold() then 'pending_approval' else 'awaiting_disbursement' end;
  end if;

  update public.requests
     set status = v_next, submitted_at = now(), estimated_total = round(v_total, 2),
         approval_required = (v_total > public.threshold())
   where id = p_request returning * into r;
  perform public.log_event(p_request, 'submitted', 'draft', v_next, null);
  return r;
end $$;

-- p_lines: [{line_id, qty_from_stock, qty_to_buy, est_unit_price}]
create or replace function public.stock_review(p_request uuid, p_lines jsonb, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare
  r public.requests%rowtype; ln public.request_lines%rowtype; l jsonb;
  v_from numeric; v_buy numeric; v_price numeric; v_total numeric; v_next public.request_status; v_onhand numeric;
begin
  if public.my_role() not in ('stock_manager','approver') then raise exception 'Only the stock manager can review stock requests'; end if;
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'stock_review' then raise exception 'Request is not awaiting stock review'; end if;

  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    select * into ln from public.request_lines where id = (l->>'line_id')::uuid and request_id = p_request;
    if ln.id is null then raise exception 'Line not found on this request'; end if;
    v_from  := coalesce((l->>'qty_from_stock')::numeric, 0);
    v_buy   := coalesce((l->>'qty_to_buy')::numeric, greatest(ln.qty - v_from, 0));
    v_price := coalesce((l->>'est_unit_price')::numeric, ln.est_unit_price);
    if v_from < 0 or v_buy < 0 then raise exception 'Quantities cannot be negative'; end if;
    if v_buy > 0 and v_price <= 0 then raise exception 'Enter an estimated price for "%"', ln.description; end if;
    if v_from > 0 then
      if ln.item_id is null then raise exception 'Cannot issue "%" from stock: it is not a catalogue item', ln.description; end if;
      select qty_on_hand into v_onhand from public.items where id = ln.item_id;
      if v_onhand < v_from then raise exception 'Only % on hand for "%"', v_onhand, ln.description; end if;
      insert into public.stock_movements (item_id, kind, delta, request_id, issued_to, created_by, note)
      values (ln.item_id, 'issue_out', -v_from, p_request, r.requester_id, auth.uid(), 'Issued on request #' || r.request_no);
    end if;
    update public.request_lines set qty_from_stock = v_from, qty_to_buy = v_buy, est_unit_price = v_price where id = ln.id;
  end loop;
  -- lines the reviewer did not touch are bought in full
  update public.request_lines set qty_to_buy = qty where request_id = p_request and qty_to_buy is null;
  if exists (select 1 from public.request_lines where request_id = p_request and qty_to_buy > 0 and est_unit_price <= 0) then
    raise exception 'Enter an estimated price for every line that must be bought';
  end if;

  select coalesce(sum(qty_to_buy * est_unit_price), 0) into v_total from public.request_lines where request_id = p_request;
  if not exists (select 1 from public.request_lines where request_id = p_request and qty_to_buy > 0) then
    v_next := 'fulfilled_from_stock';
  elsif v_total > public.threshold() then
    v_next := 'pending_approval';
  else
    v_next := 'awaiting_disbursement';
  end if;

  update public.requests
     set status = v_next, stock_reviewed_by = auth.uid(), stock_reviewed_at = now(), stock_note = nullif(p_note, ''),
         estimated_total = round(v_total, 2), approval_required = (v_total > public.threshold()),
         closed_by = case when v_next = 'fulfilled_from_stock' then auth.uid() end,
         closed_at = case when v_next = 'fulfilled_from_stock' then now() end
   where id = p_request returning * into r;
  perform public.log_event(p_request, 'stock_reviewed', 'stock_review', v_next, p_note);
  return r;
end $$;

create or replace function public.approve_request(p_request uuid, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype;
begin
  if public.my_role() <> 'approver' then raise exception 'Only the approver can approve requests'; end if;
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'pending_approval' then raise exception 'Request is not awaiting approval'; end if;
  update public.requests set status = 'awaiting_disbursement', approved_by = auth.uid(), approved_at = now(), approval_note = nullif(p_note, '')
   where id = p_request returning * into r;
  perform public.log_event(p_request, 'approved', 'pending_approval', 'awaiting_disbursement', p_note);
  return r;
end $$;

create or replace function public.reject_request(p_request uuid, p_reason text) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; v_role public.user_role := public.my_role(); v_from public.request_status;
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if coalesce(p_reason, '') = '' then raise exception 'Give a reason for rejecting'; end if;
  if not (
       (v_role = 'approver' and r.status in ('stock_review','pending_approval','awaiting_disbursement'))
    or (v_role = 'stock_manager' and r.status = 'stock_review')
    or (v_role = 'finance' and r.status = 'awaiting_disbursement')
  ) then raise exception 'You cannot reject this request at this stage'; end if;
  v_from := r.status;
  update public.requests set status = 'rejected', rejected_by = auth.uid(), rejected_at = now(), rejection_reason = p_reason
   where id = p_request returning * into r;
  perform public.log_event(p_request, 'rejected', v_from, 'rejected', p_reason);
  return r;
end $$;

create or replace function public.cancel_request(p_request uuid, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; v_from public.request_status;
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.requester_id <> auth.uid() and public.my_role() <> 'approver' then raise exception 'Only the requester can cancel this request'; end if;
  if r.status not in ('draft','stock_review','pending_approval','awaiting_disbursement') then
    raise exception 'A request cannot be cancelled once cash has been paid out';
  end if;
  v_from := r.status;
  update public.requests set status = 'cancelled' where id = p_request returning * into r;
  perform public.log_event(p_request, 'cancelled', v_from, 'cancelled', p_note);
  return r;
end $$;

-- finance / stock manager: the real amount needed is above the threshold, send up for approval
create or replace function public.escalate_request(p_request uuid, p_new_estimate numeric, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'awaiting_disbursement' then raise exception 'Only requests awaiting disbursement can be escalated'; end if;
  if p_new_estimate is null or p_new_estimate <= 0 then raise exception 'Enter the revised amount'; end if;
  update public.requests set status = 'pending_approval', estimated_total = round(p_new_estimate, 2), approval_required = true,
         approved_by = null, approved_at = null
   where id = p_request returning * into r;
  perform public.log_event(p_request, 'escalated', 'awaiting_disbursement', 'pending_approval',
    coalesce(p_note, '') || ' (revised estimate ' || p_new_estimate || ')');
  return r;
end $$;

create or replace function public.disburse_request(p_request uuid, p_amount numeric, p_to uuid default null, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; f public.floats; v_bal numeric; v_to uuid;
begin
  if public.my_role() not in ('finance','approver') then raise exception 'Only finance can pay out petty cash'; end if;
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'awaiting_disbursement' then raise exception 'Request is not awaiting disbursement'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount paid out'; end if;
  if p_amount > public.threshold() and r.approved_by is null then
    raise exception 'The amount is above the approval threshold. Escalate the request for approval first.';
  end if;
  f := public.current_float();
  if f.id is null then raise exception 'No open petty cash float. Open this month''s float first.'; end if;
  v_bal := public.float_balance(f.id);
  if v_bal < p_amount then raise exception 'Insufficient float: balance is %, requested %', v_bal, p_amount; end if;
  v_to := coalesce(p_to,
    case when r.type = 'stock' and not r.for_store then coalesce(r.stock_reviewed_by, r.requester_id) else r.requester_id end);
  if not exists (select 1 from public.profiles where id = v_to and active) then raise exception 'Recipient is not an active user'; end if;

  update public.requests
     set status = 'disbursed', disbursed_by = auth.uid(), disbursed_at = now(), disbursed_amount = round(p_amount, 2),
         disbursed_to = v_to, float_id = f.id
   where id = p_request returning * into r;
  -- expense shell so scanned proofs can be attached straight away
  insert into public.expenses (request_id, spent_by, spent_at, total) values (p_request, v_to, current_date, 0)
  on conflict (request_id) do update set spent_by = excluded.spent_by, proof_status = 'pending', finance_note = null;
  perform public.log_event(p_request, 'disbursed', 'awaiting_disbursement', 'disbursed',
    coalesce(p_note, '') || ' (paid ' || p_amount || ')');
  return r;
end $$;

-- p_lines: [{item_id?, description, qty, unit_price, supplier_id?, supplier_name?}]
-- Re-recording (after finance returns an expense for correction) voids the earlier lines and
-- reverses their stock movements rather than removing anything, keeping the audit trail.
alter table public.expense_lines add column if not exists void boolean not null default false;
alter table public.stock_movements add column if not exists void boolean not null default false;

create or replace function public.record_expense(p_request uuid, p_spent_at date, p_lines jsonb, p_notes text default null) returns public.expenses
language plpgsql security definer set search_path = public as $$
declare
  r public.requests%rowtype; e public.expenses%rowtype; l jsonb; m public.stock_movements%rowtype;
  v_item uuid; v_desc text; v_qty numeric; v_price numeric; v_sup uuid; v_supname text; v_total numeric := 0;
  v_issue numeric; rec record;
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'disbursed' then raise exception 'An expense can only be recorded while the request is in the "disbursed" stage'; end if;
  if auth.uid() <> r.disbursed_to and public.my_role() not in ('finance','approver') then
    raise exception 'Only the person who received the cash can record this expense';
  end if;
  select * into e from public.expenses where request_id = p_request;
  if e.id is null then
    insert into public.expenses (request_id, spent_by, spent_at, total) values (p_request, auth.uid(), p_spent_at, 0) returning * into e;
  end if;
  if not exists (select 1 from public.expense_proofs where expense_id = e.id) then
    raise exception 'Upload a scanned copy of the receipt before submitting the expense';
  end if;

  -- void whatever was recorded before
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
      insert into public.stock_movements (item_id, kind, delta, unit_cost, request_id, expense_id, supplier_id, created_by, note)
      values (v_item, 'purchase_in', v_qty, v_price, p_request, e.id, v_sup, auth.uid(), 'Bought on request #' || r.request_no);
      update public.items set last_unit_price = v_price, preferred_supplier_id = coalesce(v_sup, preferred_supplier_id) where id = v_item;
    end if;
  end loop;
  if v_total <= 0 then raise exception 'Add at least one line with an amount'; end if;

  -- hand the bought items to the requester (restock orders stay in the store)
  if r.type = 'stock' and not r.for_store then
    for rec in
      select rl.item_id, sum(rl.qty_to_buy) as to_buy,
             (select coalesce(sum(el.qty), 0) from public.expense_lines el where el.expense_id = e.id and el.item_id = rl.item_id and not el.void) as bought
        from public.request_lines rl where rl.request_id = p_request and rl.item_id is not null and rl.qty_to_buy > 0
       group by rl.item_id
    loop
      v_issue := least(rec.to_buy, rec.bought);
      if v_issue > 0 then
        insert into public.stock_movements (item_id, kind, delta, request_id, expense_id, issued_to, created_by, note)
        values (rec.item_id, 'issue_out', -v_issue, p_request, e.id, r.requester_id, auth.uid(), 'Issued to requester on request #' || r.request_no);
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
  return e;
end $$;

-- p_action: confirm | require_physical | physical_received | return
create or replace function public.finance_review_expense(p_request uuid, p_action text, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; e public.expenses%rowtype; v_proofs int; v_from public.request_status;
begin
  if public.my_role() not in ('finance','approver') then raise exception 'Only finance can review proofs'; end if;
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status not in ('proof_review','physical_required') then raise exception 'There is no expense awaiting review on this request'; end if;
  select * into e from public.expenses where request_id = p_request;
  select count(*) into v_proofs from public.expense_proofs where expense_id = e.id;
  v_from := r.status;

  if p_action = 'confirm' then
    if v_proofs = 0 then raise exception 'No scanned proof has been uploaded'; end if;
    if e.proof_status = 'physical_required' and e.physical_received_at is null then
      raise exception 'Physical proof was required but has not been marked as received';
    end if;
    update public.expenses set proof_status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(),
           finance_note = coalesce(nullif(p_note, ''), finance_note) where id = e.id;
    update public.requests set status = 'closed', closed_by = auth.uid(), closed_at = now() where id = p_request returning * into r;
    perform public.log_event(p_request, 'proof_confirmed', v_from, 'closed', p_note);

  elsif p_action = 'require_physical' then
    update public.expenses set proof_status = 'physical_required', physical_required_by = auth.uid(), physical_required_at = now(),
           finance_note = nullif(p_note, '') where id = e.id;
    update public.requests set status = 'physical_required' where id = p_request returning * into r;
    perform public.log_event(p_request, 'physical_required', v_from, 'physical_required', p_note);

  elsif p_action = 'physical_received' then
    if v_proofs = 0 then raise exception 'A scanned copy must be on file before closing'; end if;
    update public.expenses set physical_received_by = auth.uid(), physical_received_at = now(),
           proof_status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(),
           finance_note = coalesce(nullif(p_note, ''), finance_note) where id = e.id;
    update public.requests set status = 'closed', closed_by = auth.uid(), closed_at = now() where id = p_request returning * into r;
    perform public.log_event(p_request, 'physical_received', v_from, 'closed', p_note);

  elsif p_action = 'return' then
    if coalesce(p_note, '') = '' then raise exception 'Tell the spender what needs correcting'; end if;
    update public.expenses set proof_status = 'returned', finance_note = p_note where id = e.id;
    update public.requests set status = 'disbursed' where id = p_request returning * into r;
    perform public.log_event(p_request, 'expense_returned', v_from, 'disbursed', p_note);
  else
    raise exception 'Unknown action %', p_action;
  end if;
  return r;
end $$;

-- ---------- stock ----------
create or replace function public.issue_stock(p_item uuid, p_qty numeric, p_to uuid, p_note text default null) returns public.stock_movements
language plpgsql security definer set search_path = public as $$
declare m public.stock_movements%rowtype; v_onhand numeric;
begin
  if public.my_role() not in ('stock_manager','approver') then raise exception 'Only the stock manager can issue stock'; end if;
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
  if public.my_role() not in ('stock_manager','approver') then raise exception 'Only the stock manager can receive stock'; end if;
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
  if public.my_role() not in ('stock_manager','approver') then raise exception 'Only the stock manager can adjust stock'; end if;
  if p_new_qty is null or p_new_qty < 0 then raise exception 'Counted quantity cannot be negative'; end if;
  if coalesce(p_note, '') = '' then raise exception 'Give a reason for the adjustment'; end if;
  select qty_on_hand into v_onhand from public.items where id = p_item for update;
  if v_onhand is null then raise exception 'Item not found'; end if;
  insert into public.stock_movements (item_id, kind, delta, created_by, note)
  values (p_item, 'count', p_new_qty - v_onhand, auth.uid(), p_note) returning * into m;
  return m;
end $$;

-- Draft restock order from recurring items and anything below its reorder level
create or replace function public.create_restock_request(p_purpose text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; it record; v_qty numeric; v_n int := 0;
begin
  if public.my_role() not in ('stock_manager','approver') then raise exception 'Only the stock manager can raise restock orders'; end if;
  insert into public.requests (type, requester_id, purpose, for_store)
  values ('stock', auth.uid(), coalesce(nullif(p_purpose, ''), 'Monthly restock – ' || to_char(now(), 'Mon YYYY')), true)
  returning * into r;
  for it in select * from public.items where active and (recurring or (reorder_level > 0 and qty_on_hand < reorder_level)) order by name loop
    v_qty := case when it.recurring then greatest(it.expected_monthly_qty - it.qty_on_hand, 0) else greatest(it.reorder_level - it.qty_on_hand, 0) end;
    if v_qty > 0 then
      v_n := v_n + 1;
      insert into public.request_lines (request_id, line_no, item_id, description, qty, est_unit_price)
      values (r.id, v_n, it.id, it.name, v_qty, coalesce(it.last_unit_price, 0));
    end if;
  end loop;
  return r;
end $$;

-- ---------- petty cash float ----------
create or replace function public.open_float(p_period date, p_amount numeric, p_note text default null) returns public.floats
language plpgsql security definer set search_path = public as $$
declare f public.floats%rowtype; prev public.floats%rowtype; v_period date; v_carry numeric; s public.settings%rowtype;
begin
  if public.my_role() not in ('finance','approver') then raise exception 'Only finance can open a float'; end if;
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
  if public.my_role() not in ('finance','approver') then raise exception 'Only finance can change the float'; end if;
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
  if public.my_role() not in ('finance','approver') then raise exception 'Only finance can close a float'; end if;
  select * into f from public.floats where id = p_float for update;
  if f.id is null or f.status <> 'open' then raise exception 'Float is not open'; end if;
  select count(*) into v_open from public.requests where float_id = p_float and status = 'disbursed';
  if v_open > 0 then raise exception '% advance(s) still have no expense recorded. Chase those before closing.', v_open; end if;
  update public.floats set status = 'closed', closed_by = auth.uid(), closed_at = now(), counted_cash = p_counted_cash,
         notes = coalesce(nullif(p_notes, ''), notes) where id = p_float returning * into f;
  return f;
end $$;

-- ---------- reporting views (RLS of the caller applies) ----------
create or replace view public.v_floats with (security_invoker = true) as
select f.*,
  coalesce((select sum(amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'allocation'), 0) as allocated,
  coalesce((select sum(amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'top_up'), 0) as topped_up,
  coalesce((select sum(amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'carry_over'), 0) as carried_over,
  coalesce((select sum(amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'return'), 0) as returned,
  coalesce((select sum(r.disbursed_amount) from public.requests r where r.float_id = f.id and r.status = 'disbursed'), 0) as outstanding,
  coalesce((select sum(e.total) from public.expenses e join public.requests r on r.id = e.request_id
            where r.float_id = f.id and r.status in ('proof_review','physical_required','closed')), 0) as spent,
  public.float_balance(f.id) as balance
from public.floats f;

create or replace view public.v_spend_lines with (security_invoker = true) as
select el.id, e.spent_at, date_trunc('month', e.spent_at)::date as month,
  r.id as request_id, r.request_no, r.type, r.for_store, r.requester_id, p.full_name as requester_name,
  r.disbursed_to, r.disbursed_amount, r.approval_required, r.approved_by, r.float_id, r.status,
  el.item_id, coalesce(i.name, el.description) as description, i.unit, el.qty, el.unit_price, el.line_total,
  coalesce(c.id, rc.id) as category_id, coalesce(c.name, rc.name, 'Uncategorised') as category_name,
  el.supplier_id, el.supplier_name, e.total as expense_total
from public.expense_lines el
join public.expenses e on e.id = el.expense_id
join public.requests r on r.id = e.request_id
join public.profiles p on p.id = r.requester_id
left join public.items i on i.id = el.item_id
left join public.categories c on c.id = i.category_id
left join public.categories rc on rc.id = r.category_id
where not el.void and r.status in ('proof_review','physical_required','closed');

create or replace view public.v_price_history with (security_invoker = true) as
select el.id, e.spent_at as on_date, el.item_id, i.name as item_name, i.unit, el.qty, el.unit_price,
       el.supplier_id, el.supplier_name, r.request_no, r.id as request_id
from public.expense_lines el
join public.expenses e on e.id = el.expense_id
join public.requests r on r.id = e.request_id
join public.items i on i.id = el.item_id
where not el.void and r.status in ('proof_review','physical_required','closed')
union all
select m.id, m.created_at::date, m.item_id, i.name, i.unit, m.delta, m.unit_cost, m.supplier_id, s.name, null, null
from public.stock_movements m
join public.items i on i.id = m.item_id
left join public.suppliers s on s.id = m.supplier_id
where m.kind = 'purchase_in' and m.expense_id is null and m.unit_cost is not null and not m.void;

-- ---------- proof storage ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proofs', 'proofs', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do nothing;

-- object path: <request_id>/<file>
create policy proofs_select on storage.objects for select to authenticated
  using (bucket_id = 'proofs' and public.can_view_request(public.try_uuid((storage.foldername(name))[1])));
create policy proofs_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'proofs'
    and public.can_view_request(public.try_uuid((storage.foldername(name))[1]))
    and exists (select 1 from public.requests r where r.id = public.try_uuid((storage.foldername(name))[1])
                and r.status in ('disbursed','proof_review','physical_required'))
  );
create policy proofs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'proofs' and owner_id = auth.uid()::text);

-- ---------- lock down ----------
revoke execute on all functions in schema public from anon;
