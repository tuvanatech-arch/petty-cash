-- v2 workflow (part A): notification helpers, budget check, request lifecycle

-- ---------- notifications ----------
create or replace function public.notify_user(p_user uuid, p_kind text, p_title text, p_body text default null, p_link text default null, p_request uuid default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_user is null or p_user = auth.uid() then return; end if;
  if not exists (select 1 from public.profiles where id = p_user and active) then return; end if;
  insert into public.notifications (user_id, kind, title, body, link, request_id) values (p_user, p_kind, p_title, p_body, p_link, p_request);
end $$;
revoke execute on function public.notify_user(uuid, text, text, text, text, uuid) from public, anon, authenticated;

-- everyone holding the role today, stand-ins included
create or replace function public.notify_role(p_role public.user_role, p_kind text, p_title text, p_body text default null, p_link text default null, p_request uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  for u in
    select id from public.profiles where active and role = p_role
    union
    select d.to_user from public.delegations d
      join public.profiles f on f.id = d.from_user and f.active
      join public.profiles t on t.id = d.to_user and t.active
      where d.role = p_role and current_date between d.starts_on and d.ends_on
  loop
    perform public.notify_user(u, p_kind, p_title, p_body, p_link, p_request);
  end loop;
end $$;
revoke execute on function public.notify_role(public.user_role, text, text, text, text, uuid) from public, anon, authenticated;

create or replace function public.mark_notifications_read(p_ids uuid[] default null) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.notifications set read_at = now()
   where user_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids));
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.cur() returns text language sql stable set search_path = public as $$ select currency from public.settings where id = 1 $$;
create or replace function public.req_label(r public.requests) returns text language sql immutable as $$ select '#' || r.request_no || ' ' || r.purpose $$;
create or replace function public.money_text(v numeric) returns text language sql stable set search_path = public as $$ select public.cur() || to_char(coalesce(v, 0), 'FM999,999,990.00') $$;

-- ---------- budgets ----------
-- Returns a note describing every budget this request would push over its monthly limit, or null.
create or replace function public.budget_check(p_request uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare r public.requests%rowtype; v_month date := date_trunc('month', current_date)::date; b record; v_used numeric; v_share numeric; v_note text := '';
begin
  select * into r from public.requests where id = p_request;
  if r.id is null then return null; end if;
  for b in select bg.*, c.name as cat_name, p.full_name as person_name
             from public.budgets bg left join public.categories c on c.id = bg.category_id left join public.profiles p on p.id = bg.person_id
            where bg.active loop
    if b.person_id is not null and r.requester_id <> b.person_id then continue; end if;
    -- this request's share of the budget
    if b.category_id is null then
      v_share := r.estimated_total;
    elsif r.type = 'stock' then
      select coalesce(sum(coalesce(rl.qty_to_buy, rl.qty) * rl.est_unit_price), 0) into v_share
        from public.request_lines rl join public.items i on i.id = rl.item_id
       where rl.request_id = p_request and i.category_id = b.category_id;
    elsif r.category_id = b.category_id then
      v_share := r.estimated_total;
    else
      v_share := 0;
    end if;
    if v_share <= 0 then continue; end if;
    -- already committed this month in the same scope (recorded spend, cash out, and requests in the pipeline)
    select coalesce(sum(x.amount), 0) into v_used from (
      select el.line_total as amount
        from public.expense_lines el join public.expenses e on e.id = el.expense_id join public.requests q on q.id = e.request_id
        left join public.items i on i.id = el.item_id
       where not el.void and q.id <> p_request and q.status in ('proof_review','physical_required','closed') and e.spent_at >= v_month
         and (b.category_id is null or coalesce(i.category_id, q.category_id) = b.category_id)
         and (b.person_id is null or q.requester_id = b.person_id)
      union all
      select q.disbursed_amount from public.requests q
       where q.id <> p_request and q.status = 'disbursed' and q.disbursed_at >= v_month
         and (b.category_id is null or q.category_id = b.category_id) and (b.person_id is null or q.requester_id = b.person_id)
      union all
      select q.estimated_total from public.requests q
       where q.id <> p_request and q.status in ('pending_approval','awaiting_disbursement') and q.submitted_at >= v_month
         and (b.category_id is null or q.category_id = b.category_id) and (b.person_id is null or q.requester_id = b.person_id)
    ) x;
    if v_used + v_share > b.monthly_limit then
      v_note := v_note || format('%s budget: %s of %s already used this month; this takes it to %s. ',
        coalesce(b.cat_name, b.person_name || '''s'), public.money_text(v_used), public.money_text(b.monthly_limit), public.money_text(v_used + v_share));
    end if;
  end loop;
  return nullif(trim(v_note), '');
end $$;

-- Applies the budget rule to a request about to move to p_next; may change the next status or raise.
create or replace function public.apply_budget(p_request uuid, p_next public.request_status) returns public.request_status
language plpgsql security definer set search_path = public as $$
declare v_note text; v_mode text; v_next public.request_status := p_next;
begin
  select budget_mode into v_mode from public.settings where id = 1;
  v_note := public.budget_check(p_request);
  if v_note is null then
    update public.requests set over_budget = false, budget_note = null where id = p_request;
    return v_next;
  end if;
  if v_mode = 'block' then raise exception 'Over budget. %', v_note; end if;
  if v_mode = 'require_approval' and v_next = 'awaiting_disbursement' then v_next := 'pending_approval'; end if;
  update public.requests set over_budget = true, budget_note = v_note,
         approval_required = (approval_required or (v_mode = 'require_approval'))
   where id = p_request;
  return v_next;
end $$;
revoke execute on function public.apply_budget(uuid, public.request_status) from public, anon, authenticated;

-- notify whoever the request is now waiting on
create or replace function public.notify_stage(p_request uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; v_who text; v_label text; v_link text;
begin
  select * into r from public.requests where id = p_request;
  v_label := public.req_label(r); v_link := '#/requests/' || r.id;
  select full_name into v_who from public.profiles where id = r.requester_id;
  if r.status = 'stock_review' then
    perform public.notify_role('stock_manager', 'stock_review', 'Stock request to review', v_label || ' from ' || v_who || ' – estimated ' || public.money_text(r.estimated_total), v_link, r.id);
  elsif r.status = 'pending_approval' then
    perform public.notify_role('approver', 'approval', 'Needs your approval: ' || public.money_text(r.estimated_total),
      v_label || ' from ' || v_who || case when r.over_budget then '. ' || r.budget_note else '' end, v_link, r.id);
  elsif r.status = 'awaiting_disbursement' then
    perform public.notify_role('finance', 'payout', case when r.type = 'claim' then 'Claim to reimburse: ' else 'Ready to pay out: ' end || public.money_text(r.estimated_total), v_label || ' – ' || v_who, v_link, r.id);
  elsif r.status = 'proof_review' then
    perform public.notify_role('finance', 'proof', 'Receipt to check', v_label || ' – ' || v_who, v_link, r.id);
  end if;
end $$;
revoke execute on function public.notify_stage(uuid) from public, anon, authenticated;

-- ---------- claims ----------
alter table public.expenses add column if not exists supplier_name text;
create or replace function public.save_claim(p_request uuid, p_purpose text, p_category uuid, p_spent_at date, p_supplier text default null, p_notes text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype;
begin
  if coalesce(p_purpose, '') = '' then raise exception 'Say what the claim is for'; end if;
  if p_spent_at is null or p_spent_at > current_date then raise exception 'Enter the date you paid'; end if;
  if p_request is null then
    insert into public.requests (type, requester_id, purpose, category_id) values ('claim', auth.uid(), p_purpose, p_category) returning * into r;
    insert into public.expenses (request_id, spent_by, spent_at, total, notes) values (r.id, auth.uid(), p_spent_at, 0, nullif(p_notes, ''));
  else
    select * into r from public.requests where id = p_request for update;
    if r.id is null or r.requester_id <> auth.uid() then raise exception 'Claim not found'; end if;
    if r.status <> 'draft' then raise exception 'Only a draft claim can be edited'; end if;
    update public.requests set purpose = p_purpose, category_id = p_category where id = r.id returning * into r;
    update public.expenses set spent_at = p_spent_at, notes = nullif(p_notes, '') where request_id = r.id;
  end if;
  update public.expenses set supplier_name = nullif(p_supplier, ''), finance_note = case when proof_status = 'returned' then null else finance_note end,
         proof_status = case when proof_status = 'returned' then 'pending' else proof_status end
   where request_id = r.id;
  return r;
end $$;

-- ---------- request lifecycle ----------
create or replace function public.submit_request(p_request uuid) returns public.requests
language plpgsql security definer set search_path = public as $$
declare
  r public.requests%rowtype; e public.expenses%rowtype; s public.settings%rowtype; o record;
  v_total numeric; v_lines int; v_next public.request_status;
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.requester_id <> auth.uid() then raise exception 'Only the requester can submit this request'; end if;
  if r.status <> 'draft' then raise exception 'Only draft requests can be submitted'; end if;
  select * into s from public.settings where id = 1;
  select count(*), coalesce(sum(qty * est_unit_price), 0) into v_lines, v_total from public.request_lines where request_id = p_request;
  if v_lines = 0 then raise exception 'Add at least one line before submitting'; end if;
  if r.for_store and not (public.has_role('stock_manager') or public.has_role('approver')) then
    raise exception 'Only the stock manager can raise restock orders';
  end if;
  -- outstanding advances block new requests for cash (not claims: those are the person's own money)
  if s.block_with_outstanding and r.type <> 'claim' then
    select q.* into o from public.requests q where q.disbursed_to = auth.uid() and q.status = 'disbursed'
      and q.disbursed_at < now() - make_interval(days => s.advance_grace_days) order by q.disbursed_at limit 1;
    if o.id is not null then
      raise exception 'You still have % from % to account for (paid out % days ago). Record that expense first.',
        public.money_text(o.disbursed_amount), public.req_label(o), current_date - o.disbursed_at::date;
    end if;
  end if;

  if r.type = 'stock' and not r.for_store then
    v_next := 'stock_review';
  elsif r.type = 'claim' then
    select * into e from public.expenses where request_id = p_request;
    if e.id is null then raise exception 'Save the claim first'; end if;
    if not exists (select 1 from public.expense_proofs where expense_id = e.id) then raise exception 'Upload the receipt before submitting the claim'; end if;
    if exists (select 1 from public.request_lines where request_id = p_request and est_unit_price <= 0) then raise exception 'Enter the price on every line'; end if;
    update public.expense_lines set void = true where expense_id = e.id and not void;
    insert into public.expense_lines (expense_id, item_id, description, qty, unit_price, supplier_name)
      select e.id, null, description, qty, est_unit_price, e.supplier_name from public.request_lines where request_id = p_request order by line_no;
    update public.request_lines set qty_to_buy = qty, qty_from_stock = 0 where request_id = p_request;
    update public.expenses set total = round(v_total, 2), change_returned = 0, proof_status = 'pending', spent_by = auth.uid() where id = e.id;
    v_next := case when v_total > s.approval_threshold then 'pending_approval' else 'awaiting_disbursement' end;
  else
    if exists (select 1 from public.request_lines where request_id = p_request and est_unit_price <= 0) then
      raise exception 'Enter an estimated price for every line';
    end if;
    update public.request_lines set qty_to_buy = qty, qty_from_stock = 0 where request_id = p_request;
    v_next := case when v_total > s.approval_threshold then 'pending_approval' else 'awaiting_disbursement' end;
  end if;

  update public.requests set estimated_total = round(v_total, 2), approval_required = (v_total > s.approval_threshold) where id = p_request;
  if v_next <> 'stock_review' then v_next := public.apply_budget(p_request, v_next); end if;
  update public.requests set status = v_next, submitted_at = now() where id = p_request returning * into r;
  perform public.log_event(p_request, 'submitted', 'draft', v_next, null);
  perform public.notify_stage(p_request);
  return r;
end $$;

create or replace function public.stock_review(p_request uuid, p_lines jsonb, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare
  r public.requests%rowtype; ln public.request_lines%rowtype; l jsonb;
  v_from numeric; v_buy numeric; v_price numeric; v_total numeric; v_next public.request_status; v_onhand numeric;
begin
  if not (public.has_role('stock_manager') or public.has_role('approver')) then raise exception 'Only the stock manager can review stock requests'; end if;
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
  update public.requests set estimated_total = round(v_total, 2), approval_required = (v_total > public.threshold()) where id = p_request;
  if v_next <> 'fulfilled_from_stock' then v_next := public.apply_budget(p_request, v_next); end if;

  update public.requests
     set status = v_next, stock_reviewed_by = auth.uid(), stock_reviewed_at = now(), stock_note = nullif(p_note, ''),
         closed_by = case when v_next = 'fulfilled_from_stock' then auth.uid() end,
         closed_at = case when v_next = 'fulfilled_from_stock' then now() end
   where id = p_request returning * into r;
  perform public.log_event(p_request, 'stock_reviewed', 'stock_review', v_next, p_note);
  if v_next = 'fulfilled_from_stock' then
    perform public.notify_user(r.requester_id, 'closed', 'Issued from stock', public.req_label(r) || ' – everything was in the store. Collect it from the stock manager.', '#/requests/' || r.id, r.id);
  else
    perform public.notify_stage(p_request);
  end if;
  return r;
end $$;

create or replace function public.approve_request(p_request uuid, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype;
begin
  if not public.has_role('approver') then raise exception 'Only the approver can approve requests'; end if;
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'pending_approval' then raise exception 'Request is not awaiting approval'; end if;
  update public.requests set status = 'awaiting_disbursement', approved_by = auth.uid(), approved_at = now(), approval_note = nullif(p_note, '')
   where id = p_request returning * into r;
  perform public.log_event(p_request, 'approved', 'pending_approval', 'awaiting_disbursement', p_note);
  perform public.notify_user(r.requester_id, 'approved', 'Approved: ' || public.money_text(r.estimated_total), public.req_label(r) || case when p_note <> '' then ' – ' || p_note else '' end, '#/requests/' || r.id, r.id);
  perform public.notify_stage(p_request);
  return r;
end $$;

create or replace function public.reject_request(p_request uuid, p_reason text) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; v_from public.request_status;
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if coalesce(p_reason, '') = '' then raise exception 'Give a reason for rejecting'; end if;
  if not (
       (public.has_role('approver') and r.status in ('stock_review','pending_approval','awaiting_disbursement'))
    or (public.has_role('stock_manager') and r.status = 'stock_review')
    or (public.has_role('finance') and r.status = 'awaiting_disbursement')
  ) then raise exception 'You cannot reject this request at this stage'; end if;
  v_from := r.status;
  update public.requests set status = 'rejected', rejected_by = auth.uid(), rejected_at = now(), rejection_reason = p_reason
   where id = p_request returning * into r;
  perform public.log_event(p_request, 'rejected', v_from, 'rejected', p_reason);
  perform public.notify_user(r.requester_id, 'rejected', 'Rejected: ' || public.req_label(r), p_reason, '#/requests/' || r.id, r.id);
  return r;
end $$;

create or replace function public.cancel_request(p_request uuid, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; v_from public.request_status;
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.requester_id <> auth.uid() and not public.has_role('approver') then raise exception 'Only the requester can cancel this request'; end if;
  if r.status not in ('draft','stock_review','pending_approval','awaiting_disbursement') then
    raise exception 'A request cannot be cancelled once cash has been paid out';
  end if;
  v_from := r.status;
  update public.requests set status = 'cancelled' where id = p_request returning * into r;
  perform public.log_event(p_request, 'cancelled', v_from, 'cancelled', p_note);
  if r.requester_id <> auth.uid() then
    perform public.notify_user(r.requester_id, 'cancelled', 'Cancelled: ' || public.req_label(r), p_note, '#/requests/' || r.id, r.id);
  end if;
  return r;
end $$;

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
  perform public.apply_budget(p_request, 'pending_approval');
  perform public.log_event(p_request, 'escalated', 'awaiting_disbursement', 'pending_approval',
    coalesce(p_note, '') || ' (revised estimate ' || p_new_estimate || ')');
  perform public.notify_stage(p_request);
  return r;
end $$;

create or replace function public.disburse_request(p_request uuid, p_amount numeric, p_to uuid default null, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; e public.expenses%rowtype; f public.floats; v_bal numeric; v_to uuid;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can pay out petty cash'; end if;
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

  if r.type = 'claim' then
    select * into e from public.expenses where request_id = p_request;
    if e.id is null then raise exception 'The claim has no expense attached'; end if;
    if round(p_amount, 2) <> round(e.total, 2) then raise exception 'A claim is reimbursed for exactly what was claimed (%). Return it for correction if the amount is wrong.', public.money_text(e.total); end if;
    if e.proof_status = 'physical_required' and e.physical_received_at is null then raise exception 'The physical receipt was required but has not been marked as received'; end if;
    update public.requests
       set status = 'closed', disbursed_by = auth.uid(), disbursed_at = now(), disbursed_amount = round(p_amount, 2), disbursed_to = r.requester_id,
           float_id = f.id, closed_by = auth.uid(), closed_at = now()
     where id = p_request returning * into r;
    update public.expenses set proof_status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(), change_returned = 0 where id = e.id;
    perform public.log_event(p_request, 'reimbursed', 'awaiting_disbursement', 'closed', coalesce(p_note, '') || ' (reimbursed ' || p_amount || ')');
    perform public.notify_user(r.requester_id, 'reimbursed', 'Reimbursed: ' || public.money_text(p_amount), public.req_label(r) || ' – collect the cash from finance.', '#/requests/' || r.id, r.id);
    return r;
  end if;

  v_to := coalesce(p_to, case when r.type = 'stock' and not r.for_store then coalesce(r.stock_reviewed_by, r.requester_id) else r.requester_id end);
  if not exists (select 1 from public.profiles where id = v_to and active) then raise exception 'Recipient is not an active user'; end if;
  update public.requests
     set status = 'disbursed', disbursed_by = auth.uid(), disbursed_at = now(), disbursed_amount = round(p_amount, 2), disbursed_to = v_to, float_id = f.id
   where id = p_request returning * into r;
  insert into public.expenses (request_id, spent_by, spent_at, total) values (p_request, v_to, current_date, 0)
  on conflict (request_id) do update set spent_by = excluded.spent_by, proof_status = 'pending', finance_note = null;
  perform public.log_event(p_request, 'disbursed', 'awaiting_disbursement', 'disbursed', coalesce(p_note, '') || ' (paid ' || p_amount || ')');
  perform public.notify_user(v_to, 'cash_ready', 'Cash ready: ' || public.money_text(p_amount), public.req_label(r) || ' – collect it from finance, then upload the receipt and record what you spent.', '#/requests/' || r.id, r.id);
  if v_to <> r.requester_id then
    perform public.notify_user(r.requester_id, 'in_progress', 'Being bought: ' || public.req_label(r), 'Finance has paid out ' || public.money_text(p_amount) || ' to ' || (select full_name from public.profiles where id = v_to) || ' to buy this for you.', '#/requests/' || r.id, r.id);
  end if;
  return r;
end $$;
