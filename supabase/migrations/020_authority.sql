-- 020: approval by position and segregation of duties (upgrade Phase 1).
--   Finance pays alone up to the approval threshold (N$200); the General Manager (role 'approver') approves up to the
--   GM limit (N$5,000); above it the Managing Director approves instead of the GM. No one approves, pays out or confirms
--   their own spending. Requests split to stay under a limit are added together. Paying out more than was approved is
--   refused; spending more than was paid out is flagged for review. The MD's own requests are paid, then reviewed by the GM.
--   The MD holds every operational power of the GM (has_role('approver')) but not administration (my_role() = 'approver').

-- (run first, on its own) alter type public.user_role add value if not exists 'managing_director';

alter table public.settings add column if not exists gm_limit numeric not null default 5000;
alter table public.settings add column if not exists split_window_days int not null default 7;
alter table public.settings add column if not exists change_tolerance_pct numeric not null default 10;
alter table public.requests add column if not exists approval_level text check (approval_level in ('gm', 'md'));
alter table public.requests add column if not exists route_note text;
alter table public.requests add column if not exists review_reason text;
alter table public.requests add column if not exists review_role public.user_role;
alter table public.requests add column if not exists reviewed_by uuid references public.profiles(id);
alter table public.requests add column if not exists reviewed_at timestamptz;
alter table public.requests add column if not exists review_note text;

-- the MD holds the GM's operational powers; administration keeps checking my_role() = 'approver'
create or replace function public.has_role(p public.user_role) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and (role = p or (p = 'approver' and role = 'managing_director')))
      or exists (select 1 from public.delegations d join public.profiles me on me.id = auth.uid() and me.active
                 join public.profiles f on f.id = d.from_user and f.active
                 where d.to_user = auth.uid() and (d.role = p or (p = 'approver' and d.role = 'managing_director'))
                   and current_date between d.starts_on and d.ends_on)
$$;

create or replace function public.role_filled(p public.user_role) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where active and role = p)
$$;

-- which approval a request needs: by amount, by the requester's own position, and counting split requests together
create or replace function public.approval_route(p_request uuid, p_amount numeric, p_needs boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r public.requests%rowtype; s public.settings%rowtype; rr public.user_role;
  v_lvl text; v_note text; v_other numeric; v_related text; v_win int; v_who text;
  v_review public.user_role; v_reason text;
begin
  select * into r from public.requests where id = p_request;
  select * into s from public.settings where id = 1;
  select role, full_name into rr, v_who from public.profiles where id = r.requester_id;
  v_win := coalesce(s.split_window_days, 7);
  v_lvl := case when p_amount <= s.approval_threshold then null when p_amount <= s.gm_limit then 'gm' else 'md' end;

  if v_lvl is null then
    -- small requests that together pass the finance limit need the GM (splitting to avoid approval)
    select coalesce(sum(q.estimated_total), 0), string_agg('#' || q.request_no, ', ' order by q.request_no) into v_other, v_related
      from public.requests q
     where q.requester_id = r.requester_id and q.id <> r.id and not q.for_store and not q.approval_required and q.review_reason is null
       and q.estimated_total <= s.approval_threshold
       and q.status not in ('draft', 'rejected', 'cancelled') and q.submitted_at > now() - make_interval(days => v_win);
    if v_other > 0 and p_amount + v_other > s.approval_threshold then
      v_lvl := 'gm';
      v_note := format('Together with %s from the last %s days, %s has asked for %s without approval – above the %s limit.',
                       v_related, v_win, v_who, public.money_text(p_amount + v_other), public.money_text(s.approval_threshold));
    end if;
  elsif v_lvl = 'gm' then
    -- GM-level requests that together pass the GM limit: the GM is shown them and can send it to the MD
    select coalesce(sum(q.estimated_total), 0), string_agg('#' || q.request_no, ', ' order by q.request_no) into v_other, v_related
      from public.requests q
     where q.requester_id = r.requester_id and q.id <> r.id and not q.for_store and q.approval_required and coalesce(q.approval_level, 'gm') = 'gm'
       and q.estimated_total > s.approval_threshold and q.estimated_total <= s.gm_limit and q.review_reason is null
       and q.status not in ('draft', 'rejected', 'cancelled') and q.submitted_at > now() - make_interval(days => v_win);
    if v_other > 0 and p_amount + v_other > s.gm_limit then
      v_note := format('Together with %s from the last %s days, %s has asked for %s at GM level – above the %s GM limit. If these are parts of one purchase, send it to the MD.',
                       v_related, v_win, v_who, public.money_text(p_amount + v_other), public.money_text(s.gm_limit));
    end if;
  end if;

  if p_needs and v_lvl is null then v_lvl := 'gm'; end if;
  if rr = 'finance' and v_lvl is null then v_lvl := 'gm'; v_note := coalesce(v_note, 'Finance''s own request: approved by the GM, whatever the amount.'); end if;
  if rr = 'approver' and v_lvl = 'gm' then v_lvl := 'md'; v_note := coalesce(v_note, 'The GM''s own request: approved by the Managing Director.'); end if;
  if rr = 'managing_director' and v_lvl is not null then
    v_lvl := null; v_review := 'approver'; v_note := null;
    v_reason := 'The Managing Director''s own request, paid without approval – for the GM to review.';
  end if;
  if v_lvl = 'md' and not public.role_filled('managing_director') then
    if rr = 'approver' then
      v_lvl := null; v_review := 'managing_director'; v_note := null;
      v_reason := 'The GM''s own request, paid without approval because no Managing Director is set up yet – for the MD to review.';
    else
      v_lvl := 'gm';
      v_note := coalesce(v_note || ' ', '') || 'No Managing Director is set up yet, so the GM approves.';
    end if;
  end if;
  return jsonb_build_object('level', v_lvl, 'note', v_note, 'review_role', v_review, 'review_reason', v_reason);
end $$;
revoke execute on function public.approval_route(uuid, numeric, boolean) from public, anon, authenticated;

-- the GM sends a request on to the Managing Director (for example when it is part of a larger purchase)
create or replace function public.refer_to_md(p_request uuid, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype;
begin
  if not public.has_role('approver') then raise exception 'Only the General Manager can send a request to the Managing Director'; end if;
  if not public.role_filled('managing_director') then raise exception 'No Managing Director is set up yet'; end if;
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'pending_approval' or r.approval_level = 'md' then raise exception 'This request is not waiting for the GM'; end if;
  update public.requests set approval_level = 'md', route_note = concat_ws(' ', route_note, 'Sent to the MD by the GM' || coalesce(': ' || nullif(p_note, ''), '.'))
   where id = p_request returning * into r;
  perform public.log_event(p_request, 'referred_to_md', 'pending_approval', 'pending_approval', p_note);
  perform public.notify_stage(p_request);
  return r;
end $$;
revoke execute on function public.refer_to_md(uuid, text) from public, anon;
grant execute on function public.refer_to_md(uuid, text) to authenticated;

-- applies a route to a request and returns the next status
create or replace function public.apply_route(p_request uuid, p_amount numeric, p_needs boolean)
returns public.request_status language plpgsql security definer set search_path = public as $$
declare v jsonb := public.approval_route(p_request, p_amount, p_needs);
begin
  update public.requests
     set approval_level = v->>'level', route_note = v->>'note', approval_required = (v->>'level') is not null,
         review_role = coalesce((v->>'review_role')::public.user_role, review_role),
         review_reason = coalesce(v->>'review_reason', review_reason)
   where id = p_request;
  return case when (v->>'level') is not null then 'pending_approval'::public.request_status else 'awaiting_disbursement'::public.request_status end;
end $$;
revoke execute on function public.apply_route(uuid, numeric, boolean) from public, anon, authenticated;

-- tell whoever must review a request after the fact
create or replace function public.notify_review(p_request uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype;
begin
  select * into r from public.requests where id = p_request;
  if r.review_reason is null or r.reviewed_at is not null or r.review_role is null then return; end if;
  perform public.notify_role(r.review_role, 'review', 'To review: ' || public.req_label(r), r.review_reason, '#/requests/' || r.id, r.id);
end $$;
revoke execute on function public.notify_review(uuid) from public, anon, authenticated;

-- ---------- submit ----------
create or replace function public.submit_request(p_request uuid) returns public.requests
language plpgsql security definer set search_path = public as $$
declare
  r public.requests%rowtype; e public.expenses%rowtype; s public.settings%rowtype; o record;
  v_total numeric; v_lines int; v_next public.request_status; v_needs boolean; v_own_store boolean;
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
  if s.block_with_outstanding and r.type <> 'claim' then
    select q.* into o from public.requests q where q.disbursed_to = auth.uid() and q.status = 'disbursed'
      and q.disbursed_at < now() - make_interval(days => s.advance_grace_days) order by q.disbursed_at limit 1;
    if o.id is not null then
      raise exception 'You still have % from % to account for (paid out % days ago). Record that expense first.',
        public.money_text(o.disbursed_amount), public.req_label(o), current_date - o.disbursed_at::date;
    end if;
  end if;
  -- the stock manager does not review her own stock request
  v_own_store := r.type = 'stock' and not r.for_store and (select role from public.profiles where id = auth.uid()) = 'stock_manager';
  update public.requests set route_note = null, approval_level = null, review_role = null, review_reason = null where id = p_request;

  if r.type = 'stock' and not r.for_store and not v_own_store then
    v_next := 'stock_review';
    update public.requests set estimated_total = round(v_total, 2), approval_required = false where id = p_request;
  else
    v_needs := false;
    if r.type = 'claim' then
      select * into e from public.expenses where request_id = p_request;
      if e.id is null then raise exception 'Save the claim first'; end if;
      if not exists (select 1 from public.expense_proofs where expense_id = e.id) then raise exception 'Upload the receipt before submitting the claim'; end if;
      if exists (select 1 from public.request_lines where request_id = p_request and est_unit_price <= 0) then raise exception 'Enter the price on every line'; end if;
      update public.expense_lines set void = true where expense_id = e.id and not void;
      insert into public.expense_lines (expense_id, item_id, description, qty, unit_price, supplier_name)
        select e.id, null, description, qty, est_unit_price, e.supplier_name from public.request_lines where request_id = p_request order by line_no;
      update public.request_lines set qty_to_buy = qty, qty_from_stock = 0 where request_id = p_request;
      update public.expenses set total = round(v_total, 2), change_returned = 0, proof_status = 'pending', spent_by = auth.uid() where id = e.id;
      v_needs := coalesce(s.claims_need_approval, true);
    else
      if exists (select 1 from public.request_lines where request_id = p_request and est_unit_price <= 0) then
        raise exception 'Enter an estimated price for every line';
      end if;
      update public.request_lines set qty_to_buy = qty, qty_from_stock = 0 where request_id = p_request;
    end if;
    update public.requests set estimated_total = round(v_total, 2) where id = p_request;
    v_needs := v_needs or public.apply_budget(p_request, 'awaiting_disbursement') = 'pending_approval';
    v_next := public.apply_route(p_request, v_total, v_needs);
  end if;

  update public.requests set status = v_next, submitted_at = now() where id = p_request returning * into r;
  perform public.log_event(p_request, 'submitted', 'draft', v_next, r.route_note);
  perform public.notify_stage(p_request);
  perform public.notify_review(p_request);
  return r;
end $$;

-- ---------- stock review ----------
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
  if r.requester_id = auth.uid() then raise exception 'Someone else must review your own stock request'; end if;

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
  update public.requests set estimated_total = round(v_total, 2) where id = p_request;
  if not exists (select 1 from public.request_lines where request_id = p_request and qty_to_buy > 0) then
    v_next := 'fulfilled_from_stock';
    update public.requests set approval_required = false where id = p_request;
  else
    v_next := public.apply_route(p_request, v_total, public.apply_budget(p_request, 'awaiting_disbursement') = 'pending_approval');
  end if;

  update public.requests
     set status = v_next, stock_reviewed_by = auth.uid(), stock_reviewed_at = now(), stock_note = nullif(p_note, ''),
         closed_by = case when v_next = 'fulfilled_from_stock' then auth.uid() end,
         closed_at = case when v_next = 'fulfilled_from_stock' then now() end
   where id = p_request returning * into r;
  perform public.log_event(p_request, 'stock_reviewed', 'stock_review', v_next, concat_ws(' – ', nullif(p_note, ''), r.route_note));
  if v_next = 'fulfilled_from_stock' then
    perform public.notify_user(r.requester_id, 'closed', 'Issued from stock', public.req_label(r) || ' – everything was in the store. Collect it from the stock manager.', '#/requests/' || r.id, r.id);
  else
    perform public.notify_stage(p_request);
    perform public.notify_review(p_request);
  end if;
  return r;
end $$;

-- ---------- approve / reject / escalate ----------
create or replace function public.approve_request(p_request uuid, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; o jsonb; v_status text;
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'pending_approval' then raise exception 'Request is not awaiting approval'; end if;
  if r.requester_id = auth.uid() then raise exception 'You cannot approve your own request'; end if;
  if r.approval_level = 'md' then
    if not public.has_role('managing_director') then raise exception 'This request needs the Managing Director''s approval'; end if;
  elsif not public.has_role('approver') then
    raise exception 'Only the General Manager or the Managing Director can approve requests';
  end if;
  update public.requests set status = 'awaiting_disbursement', approved_by = auth.uid(), approved_at = now(), approval_note = nullif(p_note, '')
   where id = p_request returning * into r;
  perform public.log_event(p_request, 'approved', 'pending_approval', 'awaiting_disbursement', p_note);
  perform public.notify_user(r.requester_id, 'approved', 'Approved: ' || public.money_text(r.estimated_total), public.req_label(r) || case when p_note <> '' then ' – ' || p_note else '' end, '#/requests/' || r.id, r.id);
  perform public.notify_stage(p_request);
  o := public.float_outlook();
  v_status := o->>'status';
  if v_status in ('short', 'overdrawn') then
    perform public.notify_role('finance', 'float_warning',
      case when v_status = 'overdrawn' then 'Top-up needed: the float cannot cover what is approved' else 'Top-up likely needed before month-end' end,
      'After ' || public.req_label(r) || ' (' || public.money_text(r.estimated_total) || ') the float holds ' || public.money_text((o->>'after_approval')::numeric)
        || ' against about ' || public.money_text((o->>'expected_remaining')::numeric) || ' usually spent in the remaining ' || (o->>'days_left') || ' days.'
        || case when nullif(p_note, '') is not null then ' Approver: ' || p_note else '' end,
      '#/cash', r.id);
    perform public.log_event(p_request, 'float_warning', 'awaiting_disbursement', 'awaiting_disbursement',
      'Finance warned: ' || public.money_text((o->>'after_approval')::numeric) || ' left after this against ~' || public.money_text((o->>'expected_remaining')::numeric) || ' usually still spent');
  end if;
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
       (public.has_role('approver') and r.status in ('stock_review', 'awaiting_disbursement'))
    or (r.status = 'pending_approval' and case when r.approval_level = 'md' then public.has_role('managing_director') else public.has_role('approver') end)
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

create or replace function public.escalate_request(p_request uuid, p_new_estimate numeric, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; v_next public.request_status;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'awaiting_disbursement' then raise exception 'Only requests awaiting disbursement can be escalated'; end if;
  if p_new_estimate is null or p_new_estimate <= 0 then raise exception 'Enter the revised amount'; end if;
  update public.requests set estimated_total = round(p_new_estimate, 2), approved_by = null, approved_at = null where id = p_request;
  perform public.apply_budget(p_request, 'pending_approval');
  v_next := public.apply_route(p_request, p_new_estimate, true);
  update public.requests set status = v_next where id = p_request returning * into r;
  perform public.log_event(p_request, 'escalated', 'awaiting_disbursement', v_next,
    concat_ws(' ', nullif(p_note, ''), '(revised estimate ' || p_new_estimate || ')', r.route_note));
  perform public.notify_stage(p_request);
  perform public.notify_review(p_request);
  return r;
end $$;

-- ---------- after the fact ----------
create or replace function public.review_request(p_request uuid, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype;
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.review_reason is null then raise exception 'Nothing to review on this request'; end if;
  if r.reviewed_at is not null then return r; end if;
  if not public.has_role(r.review_role) then
    raise exception 'Only the % can review this', case when r.review_role = 'managing_director' then 'Managing Director' else 'General Manager' end;
  end if;
  if r.requester_id = auth.uid() or r.disbursed_to = auth.uid() then raise exception 'Someone else must review your own request'; end if;
  update public.requests set reviewed_by = auth.uid(), reviewed_at = now(), review_note = nullif(p_note, '') where id = p_request returning * into r;
  perform public.log_event(p_request, 'reviewed', r.status, r.status, p_note);
  return r;
end $$;
revoke execute on function public.review_request(uuid, text) from public, anon;
grant execute on function public.review_request(uuid, text) to authenticated;

-- ---------- who is told ----------
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
    perform public.notify_role(case when r.approval_level = 'md' then 'managing_director' else 'approver' end::public.user_role, 'approval',
      'Needs your approval: ' || public.money_text(r.estimated_total),
      v_label || ' from ' || v_who || case when r.over_budget then '. ' || r.budget_note else '' end || case when r.route_note is not null then '. ' || r.route_note else '' end,
      v_link, r.id);
  elsif r.status = 'awaiting_disbursement' then
    perform public.notify_role('finance', 'payout', case when r.type = 'claim' then 'Claim to reimburse: ' else 'Ready to pay out: ' end || public.money_text(r.estimated_total), v_label || ' – ' || v_who, v_link, r.id);
  elsif r.status = 'proof_review' then
    perform public.notify_role('finance', 'proof', 'Receipt to check', v_label || ' – ' || v_who, v_link, r.id);
  end if;
end $$;

-- ---------- pay out: within what was approved, never to yourself without someone else's approval ----------
create or replace function public.disburse_request(p_request uuid, p_amount numeric, p_to uuid default null, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; e public.expenses%rowtype; f public.floats; v_bal numeric; v_to uuid; d record; s public.settings%rowtype; v_cap numeric;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can pay out petty cash'; end if;
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'awaiting_disbursement' then raise exception 'Request is not awaiting disbursement'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount paid out'; end if;
  select * into s from public.settings where id = 1;
  if r.approved_by is null and r.review_reason is null then
    if p_amount > s.approval_threshold then raise exception 'The amount is above the approval threshold. Escalate the request for approval first.'; end if;
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
  v_to := case when r.type = 'claim' then r.requester_id
               else coalesce(p_to, case when r.type = 'stock' and not r.for_store then coalesce(r.stock_reviewed_by, r.requester_id) else r.requester_id end) end;
  if (r.requester_id = auth.uid() or v_to = auth.uid()) and (r.approved_by is null or r.approved_by = auth.uid()) then
    raise exception 'Someone else must pay out your own request';
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

  if not exists (select 1 from public.profiles where id = v_to and active) then raise exception 'Recipient is not an active user'; end if;
  update public.requests
     set status = 'disbursed', disbursed_by = auth.uid(), disbursed_at = now(), disbursed_amount = round(p_amount, 2), disbursed_to = v_to, float_id = f.id
   where id = p_request returning * into r;
  insert into public.expenses (request_id, spent_by, spent_at, total) values (p_request, v_to, current_date, 0)
  on conflict (request_id) do update set spent_by = excluded.spent_by, proof_status = 'pending', finance_note = null
  returning * into e;
  for d in select * from public.request_documents where request_id = p_request and kind = 'invoice' loop
    if not exists (select 1 from public.expense_proofs p where p.expense_id = e.id and p.storage_path = d.storage_path) then
      insert into public.expense_proofs (expense_id, storage_path, file_name, mime, uploaded_by, extracted)
      values (e.id, d.storage_path, d.file_name, d.mime, d.uploaded_by, coalesce(d.extracted, '{}'::jsonb) || jsonb_build_object('pre_payment', true));
    end if;
  end loop;
  perform public.log_event(p_request, 'disbursed', 'awaiting_disbursement', 'disbursed', coalesce(p_note, '') || ' (paid ' || p_amount || ')');
  perform public.notify_user(v_to, 'cash_ready', 'Cash ready: ' || public.money_text(p_amount), public.req_label(r) || ' – collect it from finance, then upload the receipt and record what you spent.', '#/requests/' || r.id, r.id);
  if v_to <> r.requester_id then
    perform public.notify_user(r.requester_id, 'in_progress', 'Being bought: ' || public.req_label(r), 'Finance has paid out ' || public.money_text(p_amount) || ' to ' || (select full_name from public.profiles where id = v_to) || ' to buy this for you.', '#/requests/' || r.id, r.id);
  end if;
  return r;
end $$;

-- ---------- receipts: never confirmed by the person who spent the money ----------
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

  if r.status not in ('proof_review', 'physical_required') then raise exception 'There is no expense awaiting review on this request'; end if;
  if p_action in ('confirm', 'physical_received') and (coalesce(e.spent_by, r.disbursed_to) = auth.uid() or r.requester_id = auth.uid()) then
    raise exception 'Someone else must confirm your own receipt';
  end if;

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

-- ---------- spending more than was paid out is flagged for review ----------
create or replace function public.record_expense(p_request uuid, p_spent_at date, p_lines jsonb, p_notes text default null) returns public.expenses
language plpgsql security definer set search_path = public as $$
declare
  r public.requests%rowtype; e public.expenses%rowtype; l jsonb; m public.stock_movements%rowtype;
  v_item uuid; v_desc text; v_qty numeric; v_price numeric; v_sup uuid; v_supname text; v_total numeric := 0;
  v_issue numeric; rec record; v_last numeric; v_name text; v_pct int; v_tol numeric; v_why text;
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

  -- more spent than was paid out, beyond the tolerance: someone senior looks at it afterwards
  select 1 + coalesce(change_tolerance_pct, 0) / 100 into v_tol from public.settings where id = 1;
  if v_total > round(r.disbursed_amount * v_tol, 2) then
    v_why := format('Spent %s against %s paid out.', public.money_text(v_total), public.money_text(r.disbursed_amount));
    update public.requests
       set review_role = case when (select role from public.profiles where id = r.requester_id) = 'approver'
                                or (select role from public.profiles where id = auth.uid()) = 'approver'
                              then 'managing_director'::public.user_role else 'approver'::public.user_role end,
           review_reason = case when reviewed_at is null and review_reason is not null then review_reason || ' ' || v_why else v_why end,
           reviewed_by = null, reviewed_at = null, review_note = null
     where id = p_request;
    perform public.notify_review(p_request);
  end if;
  perform public.notify_stage(p_request);
  return e;
end $$;
