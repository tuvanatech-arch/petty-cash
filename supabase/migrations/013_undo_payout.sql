-- 013: finance can undo a pay-out recorded by mistake, as long as nothing has been spent against it.
-- The request goes back to "awaiting disbursement", the float balance is restored (it is computed, not stored),
-- the history keeps what happened, and the payee is told. A closed month cannot be changed.
create or replace function public.undo_disbursement(p_request uuid, p_note text) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; e public.expenses%rowtype; f public.floats%rowtype; v_amount numeric; v_to uuid;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can undo a pay-out'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Say why the pay-out is being undone'; end if;
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'disbursed' or r.type = 'claim' then raise exception 'Only a cash pay-out that is still out can be undone'; end if;
  select * into e from public.expenses where request_id = p_request;
  if e.id is not null then
    if coalesce(e.total, 0) > 0 or exists (select 1 from public.expense_lines where expense_id = e.id and not void) then
      raise exception 'Something has already been recorded against this pay-out. Return the expense for correction instead.';
    end if;
    if exists (select 1 from public.expense_proofs where expense_id = e.id and coalesce((extracted->>'pre_payment')::boolean, false) = false) then
      raise exception 'A receipt has already been attached to this pay-out. Return the expense for correction instead.';
    end if;
  end if;
  select * into f from public.floats where id = r.float_id;
  if f.id is not null and f.status <> 'open' then raise exception 'That month is closed; the pay-out cannot be undone'; end if;
  v_amount := r.disbursed_amount; v_to := r.disbursed_to;
  -- the invoice copied in at pay-out is dropped again (the original stays on the request); the empty expense record goes too
  if e.id is not null then delete from public.expenses where id = e.id; end if;
  update public.requests
     set status = 'awaiting_disbursement', disbursed_by = null, disbursed_at = null, disbursed_amount = null, disbursed_to = null, float_id = null, updated_at = now()
   where id = p_request returning * into r;
  perform public.log_event(p_request, 'payout_undone', 'disbursed', 'awaiting_disbursement',
    trim(p_note) || ' (was ' || public.money_text(v_amount) || ' to ' || (select full_name from public.profiles where id = v_to) || ')');
  perform public.notify_user(v_to, 'payout_undone', 'Pay-out undone: ' || public.money_text(v_amount),
    public.req_label(r) || ' – finance undid the pay-out: ' || trim(p_note) || '. Nothing to account for; it will be paid out again.', '#/requests/' || r.id, r.id);
  if v_to <> r.requester_id then
    perform public.notify_user(r.requester_id, 'payout_undone', 'Pay-out undone: ' || public.req_label(r), 'Finance undid the pay-out to ' || (select full_name from public.profiles where id = v_to) || ': ' || trim(p_note), '#/requests/' || r.id, r.id);
  end if;
  return r;
end $$;
revoke execute on function public.undo_disbursement(uuid, text) from public, anon;
