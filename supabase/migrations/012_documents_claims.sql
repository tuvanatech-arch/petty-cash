-- 012: digital invoices before the pay-out, and claims under control.
--  * request_documents: an invoice or quote attached to an approved (or pending) request before any cash moves.
--    When finance pays out, the invoice becomes the proof automatically (marked as attached before payment).
--  * claims_need_approval: a claim is money spent without prior approval, so by default every claim passes the approver.

-- ---------- documents attached before the pay-out ----------
create table if not exists public.request_documents (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  kind text not null default 'invoice',          -- invoice | quote
  storage_path text not null,
  file_name text,
  mime text,
  uploaded_by uuid not null references public.profiles(id),
  extracted jsonb,
  created_at timestamptz not null default now()
);
create index if not exists request_documents_request on public.request_documents (request_id);
alter table public.request_documents enable row level security;
create policy request_documents_select on public.request_documents for select to authenticated using (public.can_view_request(request_id));

-- moving a snapped file into the folder of my own approved/pending request is allowed too
alter policy proofs_inbox_move on storage.objects
  with check (bucket_id = 'proofs' and (
    ((storage.foldername(name))[1] = 'inbox' and (storage.foldername(name))[2] = auth.uid()::text)
    or (public.can_view_request(public.try_uuid((storage.foldername(name))[1])) and exists (
      select 1 from public.requests r where r.id = public.try_uuid((storage.foldername(name))[1])
        and (r.status in ('disbursed', 'proof_review', 'physical_required')
          or (r.type = 'claim' and r.status in ('draft', 'pending_approval', 'awaiting_disbursement'))
          or (r.type <> 'claim' and r.requester_id = auth.uid() and r.status in ('pending_approval', 'awaiting_disbursement')))))));

create or replace function public.file_inbox_document(p_inbox uuid, p_request uuid, p_new_path text, p_kind text default 'invoice') returns public.request_documents
language plpgsql security definer set search_path = public as $$
declare ib public.receipt_inbox%rowtype; r public.requests%rowtype; d public.request_documents%rowtype; v_total numeric; v_diff text;
begin
  select * into ib from public.receipt_inbox where id = p_inbox and user_id = auth.uid() for update;
  if ib.id is null then raise exception 'Receipt not found'; end if;
  if ib.status <> 'unfiled' then raise exception 'This file has already been filed'; end if;
  select * into r from public.requests where id = p_request;
  if r.id is null then raise exception 'Request not found'; end if;
  if not (r.type <> 'claim' and r.requester_id = auth.uid() and r.status in ('pending_approval', 'awaiting_disbursement')) then
    raise exception 'An invoice can only be attached to your own request that is approved or waiting for approval';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'proofs' and name = p_new_path and owner_id = auth.uid()::text) then
    raise exception 'The file has not been moved into the request folder';
  end if;
  insert into public.request_documents (request_id, kind, storage_path, file_name, mime, uploaded_by, extracted)
  values (p_request, coalesce(p_kind, 'invoice'), p_new_path, ib.file_name, ib.mime, auth.uid(), ib.extracted) returning * into d;
  update public.receipt_inbox set status = 'filed', filed_request_id = p_request, filed_at = now(), storage_path = p_new_path where id = p_inbox;
  v_total := case when ib.extracted->>'total' ~ '^[0-9.]+$' then (ib.extracted->>'total')::numeric end;
  v_diff := case when v_total is null then ''
                 when abs(v_total - r.estimated_total) <= greatest(1, r.estimated_total * 0.02) then ' – matches the ' || public.money_text(r.estimated_total) || ' approved'
                 else ' against ' || public.money_text(r.estimated_total) || ' ' || case when r.status = 'pending_approval' then 'requested' else 'approved' end end;
  perform public.log_event(p_request, 'document_attached', r.status, r.status,
    coalesce(p_kind, 'invoice') || ' attached' || case when v_total is not null then ': ' || public.money_text(v_total) else '' end || v_diff);
  if r.status = 'awaiting_disbursement' then
    perform public.notify_role('finance', 'document', 'Invoice attached: ' || public.req_label(r),
      (select full_name from public.profiles where id = auth.uid()) || ' attached a supplier invoice' || case when v_total is not null then ' for ' || public.money_text(v_total) else '' end || v_diff || '.', '#/requests/' || r.id, r.id);
  else
    perform public.notify_role('approver', 'document', 'Quote attached: ' || public.req_label(r),
      (select full_name from public.profiles where id = auth.uid()) || ' attached a ' || coalesce(p_kind, 'invoice') || case when v_total is not null then ' for ' || public.money_text(v_total) else '' end || v_diff || '.', '#/requests/' || r.id, r.id);
  end if;
  return d;
end $$;
revoke execute on function public.file_inbox_document(uuid, uuid, text, text) from public, anon;

-- ---------- claims: approval policy ----------
alter table public.settings add column if not exists claims_need_approval boolean not null default true;

create or replace function public.submit_request(p_request uuid) returns public.requests
language plpgsql security definer set search_path = public as $$
declare
  r public.requests%rowtype; e public.expenses%rowtype; s public.settings%rowtype; o record;
  v_total numeric; v_lines int; v_next public.request_status; v_needs boolean;
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

  v_needs := v_total > s.approval_threshold;
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
    -- a claim is money spent before anyone approved it: by default it always passes the approver
    v_needs := v_needs or coalesce(s.claims_need_approval, true);
    v_next := case when v_needs then 'pending_approval' else 'awaiting_disbursement' end;
  else
    if exists (select 1 from public.request_lines where request_id = p_request and est_unit_price <= 0) then
      raise exception 'Enter an estimated price for every line';
    end if;
    update public.request_lines set qty_to_buy = qty, qty_from_stock = 0 where request_id = p_request;
    v_next := case when v_needs then 'pending_approval' else 'awaiting_disbursement' end;
  end if;

  update public.requests set estimated_total = round(v_total, 2), approval_required = v_needs where id = p_request;
  if v_next <> 'stock_review' then v_next := public.apply_budget(p_request, v_next); end if;
  update public.requests set status = v_next, submitted_at = now() where id = p_request returning * into r;
  perform public.log_event(p_request, 'submitted', 'draft', v_next, null);
  perform public.notify_stage(p_request);
  return r;
end $$;

-- ---------- paying out: an invoice attached beforehand becomes the proof ----------
create or replace function public.disburse_request(p_request uuid, p_amount numeric, p_to uuid default null, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; e public.expenses%rowtype; f public.floats; v_bal numeric; v_to uuid; d record;
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
  on conflict (request_id) do update set spent_by = excluded.spent_by, proof_status = 'pending', finance_note = null
  returning * into e;
  -- an invoice attached before the pay-out is carried over as the proof, marked so finance knows it came first
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

-- ---------- finance's receipt checks know about invoices that came first ----------
create or replace function public.expense_checks(p_request uuid default null)
returns table(request_id uuid, status text, note text, reading_total numeric)
language plpgsql stable security definer set search_path = public as $$
declare r record; v_n int; v_pre int; v_read numeric; v_dup_no int; v_status text; v_note text;
begin
  if p_request is null and not public.is_staff() then raise exception 'Not allowed'; end if;
  if p_request is not null and not public.can_view_request(p_request) then raise exception 'Not allowed'; end if;
  for r in select q.id, q.request_no, e.id as expense_id, e.total, e.spent_at, e.supplier_name from public.requests q join public.expenses e on e.request_id = q.id
           where (p_request is null and q.status in ('proof_review', 'physical_required', 'awaiting_disbursement') and e.total > 0) or q.id = p_request loop
    select count(*), count(*) filter (where (p.extracted->>'pre_payment')::boolean),
           max((p.extracted->>'total')::numeric) filter (where p.extracted ? 'total' and p.extracted->>'total' is not null and p.extracted->>'total' ~ '^[0-9.]+$')
      into v_n, v_pre, v_read from public.expense_proofs p where p.expense_id = r.expense_id;
    v_status := case when v_n = 0 then 'no_proof' when v_read is null then 'unread'
                     when abs(v_read - r.total) <= greatest(0.5, v_read * 0.01) then 'matches' else 'mismatch' end;
    v_note := case v_status when 'matches' then 'Receipt reads ' || public.money_text(v_read) || ' – matches what was recorded'
                            when 'mismatch' then 'Receipt reads ' || public.money_text(v_read) || ' but ' || public.money_text(r.total) || ' was recorded'
                            when 'unread' then 'Scan attached, not read' else 'No scan attached' end;
    if v_pre > 0 and v_n = v_pre then v_note := v_note || ' · the invoice was attached before the pay-out: confirm it was actually paid'; end if;
    select q2.request_no into v_dup_no from public.expenses e2 join public.requests q2 on q2.id = e2.request_id
      where e2.request_id <> r.id and e2.spent_at = r.spent_at and abs(e2.total - r.total) < 0.01 and e2.total > 0
        and q2.status not in ('rejected', 'cancelled', 'draft')
        and (coalesce(e2.supplier_name, '') = '' or coalesce(r.supplier_name, '') = '' or lower(e2.supplier_name) = lower(r.supplier_name)) limit 1;
    if v_dup_no is not null then v_status := 'duplicate'; v_note := 'Same amount on the same day as #' || v_dup_no || ' – possible duplicate'; end if;
    request_id := r.id; status := v_status; note := v_note; reading_total := v_read;
    return next;
  end loop;
end $$;

-- ---------- reports: money spent before approval, per person ----------
create or replace function public.claims_summary(p_from date default null, p_to date default null)
returns table(person_id uuid, person_name text, claims int, claimed numeric, all_spend numeric, share numeric)
language sql stable security definer set search_path = public as $$
  with win as (select coalesce(p_from, date_trunc('month', current_date)::date) as f, coalesce(p_to, current_date) as t),
  spend as (
    select q.requester_id, q.type, coalesce(e.total, q.disbursed_amount, 0) as amt
    from public.requests q left join public.expenses e on e.request_id = q.id, win
    where q.status in ('disbursed', 'proof_review', 'physical_required', 'closed') and q.disbursed_at::date between win.f and win.t and public.is_staff()
  )
  select p.id, p.full_name,
         count(*) filter (where s.type = 'claim')::int,
         round(coalesce(sum(amt) filter (where s.type = 'claim'), 0), 2),
         round(coalesce(sum(amt), 0), 2),
         case when coalesce(sum(amt), 0) > 0 then round(100 * coalesce(sum(amt) filter (where s.type = 'claim'), 0) / sum(amt), 1) else 0 end
  from spend s join public.profiles p on p.id = s.requester_id
  group by p.id, p.full_name
  having count(*) filter (where s.type = 'claim') > 0
  order by 4 desc;
$$;
revoke execute on function public.claims_summary(date, date) from public, anon;
