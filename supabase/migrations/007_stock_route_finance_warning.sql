-- v3.1: stock is asked for by reporting it (only the stock manager raises stock purchase requests),
-- and finance is warned the moment an approval is made that leaves the float short.

-- ---------- only the stock manager raises stock requests ----------
create or replace function public.requests_stock_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'stock' and not (public.has_role('stock_manager') or public.has_role('approver')) then
    raise exception 'Stock is requested by reporting it to the stock manager, who raises the purchase';
  end if;
  return new;
end $$;
create trigger requests_stock_guard before insert on public.requests for each row execute function public.requests_stock_guard();

-- ---------- approval: warn finance when the float will run short ----------
create or replace function public.approve_request(p_request uuid, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; o jsonb; v_status text;
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
  -- the float after this approval, against what is usually still spent this month
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
