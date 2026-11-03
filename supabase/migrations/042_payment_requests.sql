-- 042: payment requests. "Ask for cash" becomes "Request a payment": one form for anything that is not office stock.
--  * The requester attaches the supplier's quote or invoice on the form itself, or says there is none.
--    "No quote" is recorded on the request when it is sent (no_quote), so everyone sees it.
--  * Finance pays as before, in cash from the petty cash box, or records a bank transfer (date and bank reference).
--    A transfer is only possible with a quote or invoice attached. It never touches the box: no float, no count,
--    no cash ledger line. The request closes at once with the quote/invoice as its proof.
--  * Spending reports include transfers (it is still the company's spending); the journal credits Bank, not petty
--    cash; the float outlook (how much cash the box needs) counts only cash from the box.

-- ---------- the request remembers how it was paid ----------
alter table public.requests add column if not exists no_quote boolean not null default false;
alter table public.requests add column if not exists paid_via text not null default 'cash';
alter table public.requests add column if not exists payment_ref text;
alter table public.requests add column if not exists paid_on date;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'requests_paid_via_check') then
    alter table public.requests add constraint requests_paid_via_check check (paid_via in ('cash', 'transfer'));
  end if;
end $$;

-- "No quote" is what was true when the request was sent: no quote or invoice attached.
-- How it was paid is only ever set by finance (pay_by_transfer): whatever a draft carried is cleared when it is sent.
create or replace function public.requests_quote_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'draft' and new.status <> 'draft' then
    new.paid_via := 'cash'; new.payment_ref := null; new.paid_on := null;
    new.no_quote := new.type = 'cash' and not exists (select 1 from public.request_documents where request_id = new.id);
  end if;
  return new;
end $$;
create or replace trigger requests_quote_stamp before update of status on public.requests
  for each row execute function public.requests_quote_stamp();

-- ---------- a quote can be attached while the request is still a draft ----------
alter policy proofs_inbox_move on storage.objects
  with check (bucket_id = 'proofs' and (
    ((storage.foldername(name))[1] = 'inbox' and (storage.foldername(name))[2] = auth.uid()::text)
    or (public.can_view_request(public.try_uuid((storage.foldername(name))[1])) and exists (
      select 1 from public.requests r where r.id = public.try_uuid((storage.foldername(name))[1])
        and (r.status in ('disbursed', 'proof_review', 'physical_required')
          or (r.type = 'claim' and r.status in ('draft', 'pending_approval', 'awaiting_disbursement'))
          or (r.type <> 'claim' and r.requester_id = auth.uid() and r.status in ('draft', 'pending_approval', 'awaiting_disbursement')))))));

create or replace function public.file_inbox_document(p_inbox uuid, p_request uuid, p_new_path text, p_kind text default 'invoice') returns public.request_documents
language plpgsql security definer set search_path = public as $$
declare ib public.receipt_inbox%rowtype; r public.requests%rowtype; d public.request_documents%rowtype; v_total numeric; v_diff text := ''; v_kind text := coalesce(p_kind, 'invoice');
begin
  if v_kind not in ('invoice', 'quote') then raise exception 'Attach it as a quote or an invoice'; end if;
  select * into ib from public.receipt_inbox where id = p_inbox and user_id = auth.uid() for update;
  if ib.id is null then raise exception 'Receipt not found'; end if;
  if ib.status <> 'unfiled' then raise exception 'This file has already been filed'; end if;
  select * into r from public.requests where id = p_request;
  if r.id is null then raise exception 'Request not found'; end if;
  if not (r.type <> 'claim' and r.requester_id = auth.uid() and r.status in ('draft', 'pending_approval', 'awaiting_disbursement')) then
    raise exception 'A quote or invoice can only be attached to your own request before it is paid';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'proofs' and name = p_new_path and owner_id = auth.uid()::text) then
    raise exception 'The file has not been moved into the request folder';
  end if;
  insert into public.request_documents (request_id, kind, storage_path, file_name, mime, uploaded_by, extracted)
  values (p_request, v_kind, p_new_path, ib.file_name, ib.mime, auth.uid(), ib.extracted) returning * into d;
  update public.receipt_inbox set status = 'filed', filed_request_id = p_request, filed_at = now(), storage_path = p_new_path where id = p_inbox;
  update public.requests set no_quote = false where id = p_request and no_quote;
  v_total := case when ib.extracted->>'total' ~ '^[0-9.]+$' then (ib.extracted->>'total')::numeric end;
  if v_total is not null and r.status <> 'draft' then
    v_diff := case when abs(v_total - r.estimated_total) <= greatest(1, r.estimated_total * 0.02) then ' – matches the ' || public.money_text(r.estimated_total) || ' approved'
                   else ' against ' || public.money_text(r.estimated_total) || ' ' || case when r.status = 'pending_approval' then 'requested' else 'approved' end end;
  end if;
  perform public.log_event(p_request, 'document_attached', r.status, r.status,
    v_kind || ' attached' || case when v_total is not null then ': ' || public.money_text(v_total) else '' end || v_diff);
  if r.status = 'awaiting_disbursement' then
    perform public.notify_role('finance', 'document', initcap(v_kind) || ' attached: ' || public.req_label(r),
      (select full_name from public.profiles where id = auth.uid()) || ' attached a supplier ' || v_kind || case when v_total is not null then ' for ' || public.money_text(v_total) else '' end || v_diff || '.', '#/requests/' || r.id, r.id);
  elsif r.status = 'pending_approval' then
    perform public.notify_role('approver', 'document', initcap(v_kind) || ' attached: ' || public.req_label(r),
      (select full_name from public.profiles where id = auth.uid()) || ' attached a ' || v_kind || case when v_total is not null then ' for ' || public.money_text(v_total) else '' end || v_diff || '.', '#/requests/' || r.id, r.id);
  end if;
  return d;
end $$;
revoke execute on function public.file_inbox_document(uuid, uuid, text, text) from public, anon;
grant execute on function public.file_inbox_document(uuid, uuid, text, text) to authenticated;

-- ---------- finance records a bank transfer: the box is not touched ----------
create or replace function public.pay_by_transfer(p_request uuid, p_amount numeric, p_paid_on date, p_reference text, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare
  r public.requests%rowtype; e public.expenses%rowtype; s public.settings%rowtype; d record; dup jsonb;
  v_cap numeric; v_supplier text; v_ref text := nullif(btrim(coalesce(p_reference, '')), ''); v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can pay a request'; end if;
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.type <> 'cash' then raise exception 'Only a payment request can be paid by bank transfer'; end if;
  if r.status <> 'awaiting_disbursement' then raise exception 'This request is not waiting to be paid'; end if;
  if not (r.branch_id = any(public.my_branches())) then raise exception 'This request belongs to %, which is not your branch', public.branch_name(r.branch_id); end if;
  if not exists (select 1 from public.request_documents where request_id = p_request) then
    raise exception 'A bank transfer needs a quote or invoice attached. Without one, pay it in cash from the petty cash box.';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount paid'; end if;
  if p_paid_on is null then raise exception 'Enter the date of the transfer'; end if;
  if p_paid_on > current_date then raise exception 'The transfer date cannot be in the future'; end if;
  if p_paid_on < current_date - 60 then raise exception 'That date is more than 60 days ago. Check the date of the transfer.'; end if;
  if v_ref is null then raise exception 'Enter the bank reference of the transfer'; end if;
  if length(v_ref) > 60 then raise exception 'The bank reference is too long (60 characters at most)'; end if;
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

  select nullif(btrim(extracted->>'supplier'), '') into v_supplier from public.request_documents
   where request_id = p_request and nullif(btrim(extracted->>'supplier'), '') is not null order by created_at desc limit 1;

  update public.requests
     set status = 'closed', paid_via = 'transfer', payment_ref = v_ref, paid_on = p_paid_on,
         disbursed_by = auth.uid(), disbursed_at = now(), disbursed_amount = round(p_amount, 2), disbursed_to = r.requester_id, float_id = null,
         closed_by = auth.uid(), closed_at = now()
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
  -- the same supplier, date and amount already paid: say why both are right, or stop
  dup := public.receipt_duplicate_of(e.id);
  if dup is not null then
    if v_note is null then
      raise exception 'This looks like #% (%), already recorded. If both payments are right, say why in the note.', dup->>'request_no', dup->>'why';
    end if;
    update public.expenses set duplicate_note = v_note where id = e.id;
  end if;
  update public.expenses set proof_status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now() where id = e.id;

  perform public.log_event(p_request, 'paid_by_transfer', 'awaiting_disbursement', 'closed', 'Ref ' || v_ref || ', ' || to_char(p_paid_on, 'DD Mon YYYY') || coalesce(' – ' || v_note, ''));
  perform public.notify_user(r.requester_id, 'closed', 'Paid by bank transfer: ' || public.money_text(p_amount),
    public.req_label(r) || ' – paid' || coalesce(' to ' || v_supplier, '') || ' on ' || to_char(p_paid_on, 'DD Mon YYYY') || ' (ref ' || v_ref || '). Nothing more to do.',
    '#/requests/' || r.id, r.id);
  -- the GM paid it: finance hears about it
  if not public.has_role('finance') then
    perform public.notify_role('finance', 'closed', 'Paid by bank transfer: ' || public.money_text(p_amount),
      public.req_label(r) || ' – recorded by ' || (select full_name from public.profiles where id = auth.uid()) || ' (ref ' || v_ref || ').', '#/requests/' || r.id, r.id);
  end if;
  return r;
end $$;
revoke execute on function public.pay_by_transfer(uuid, numeric, date, text, text) from public, anon;
grant execute on function public.pay_by_transfer(uuid, numeric, date, text, text) to authenticated;

-- ---------- spending lines say how they were paid ----------
create or replace view public.v_spend_lines with (security_invoker = true) as
select el.id, e.spent_at, date_trunc('month', e.spent_at)::date as month,
  r.id as request_id, r.request_no, r.type, r.for_store, r.requester_id, p.full_name as requester_name,
  r.disbursed_to, r.disbursed_amount, r.approval_required, r.approved_by, r.float_id, r.status,
  el.item_id, coalesce(i.name, el.description) as description, i.unit, el.qty, el.unit_price, el.line_total,
  coalesce(c.id, rc.id) as category_id, coalesce(c.name, rc.name, 'Uncategorised') as category_name,
  el.supplier_id, el.supplier_name, e.total as expense_total, r.branch_id,
  r.paid_via, r.payment_ref
from public.expense_lines el
join public.expenses e on e.id = el.expense_id
join public.requests r on r.id = e.request_id
join public.profiles p on p.id = r.requester_id
left join public.items i on i.id = el.item_id
left join public.categories c on c.id = i.category_id
left join public.categories rc on rc.id = r.category_id
where not el.void and r.status in ('proof_review','physical_required','closed');

-- ---------- the journal: a transfer is paid from the bank, not from petty cash ----------
create or replace function public.journal(p_month date)
returns table(entry_date date, reference text, account text, account_name text, description text, debit numeric, credit numeric, branch text, currency text, request_no integer)
language sql stable security definer set search_path = public as $$
  with v as (select view_branch as b from public.profiles where id = auth.uid()),
  brs as (select x.bid from unnest(public.my_branches()) x(bid), v where v.b is null or x.bid = v.b),
  m as (select date_trunc('month', p_month)::date as m0, (date_trunc('month', p_month) + interval '1 month')::date as m1),
  cash_acct as (select coalesce(nullif(s.petty_cash_account, ''), 'PETTY-CASH') as code from public.settings s where s.id = 1),
  lines as (
    select l.spent_at as entry_date, case when l.paid_via = 'transfer' then 'PAY-' else 'PC-' end || l.request_no as reference, coalesce(nullif(c.account_code, ''), 'UNMAPPED-' || upper(replace(coalesce(l.category_name, 'uncategorised'), ' ', '-'))) as account, coalesce(l.category_name, 'Uncategorised') as account_name,
           l.description || ' – ' || l.requester_name || coalesce(' @ ' || l.supplier_name, '') as description, l.line_total as debit, 0::numeric as credit,
           public.branch_name(l.branch_id) as branch, co.currency_code::text as currency, l.request_no
    from public.v_spend_lines l left join public.categories c on c.id = l.category_id join public.branches b on b.id = l.branch_id join public.companies co on co.id = b.company_id, m
    where l.branch_id in (select bid from brs) and l.spent_at >= m.m0 and l.spent_at < m.m1 and public.is_staff()
    union all
    select l.spent_at, case when l.paid_via = 'transfer' then 'PAY-' else 'PC-' end || l.request_no,
           case when l.paid_via = 'transfer' then 'BANK' else (select code from cash_acct) end,
           case when l.paid_via = 'transfer' then 'Bank' else 'Petty cash' end,
           case when l.paid_via = 'transfer' then 'Bank transfer #' || l.request_no || ' – ' || l.requester_name || coalesce(' (ref ' || l.payment_ref || ')', '')
                else 'Voucher #' || l.request_no || ' – ' || l.requester_name end,
           0, sum(l.line_total),
           public.branch_name(l.branch_id), co.currency_code::text, l.request_no
    from public.v_spend_lines l join public.branches b on b.id = l.branch_id join public.companies co on co.id = b.company_id, m
    where l.branch_id in (select bid from brs) and l.spent_at >= m.m0 and l.spent_at < m.m1 and public.is_staff()
    group by l.spent_at, l.request_no, l.requester_name, l.branch_id, co.currency_code, l.paid_via, l.payment_ref
    union all
    select t.created_at::date, 'PC-FLOAT-' || to_char(f.period, 'YYYYMM'), case when t.kind in ('allocation', 'top_up', 'carry_over') then (select code from cash_acct) when t.kind = 'return' then 'BANK' else 'CASH-' || upper(t.kind::text) end,
           case when t.kind in ('allocation', 'top_up', 'carry_over') then 'Petty cash' when t.kind = 'return' then 'Bank' else 'Cash ' || t.kind::text end,
           coalesce(t.note, t.kind::text), case when t.kind in ('allocation', 'top_up', 'carry_over', 'shortage') then t.amount else 0 end, case when t.kind in ('return', 'surplus') then t.amount else 0 end,
           public.branch_name(f.branch_id), co.currency_code::text, null
    from public.float_transactions t join public.floats f on f.id = t.float_id join public.branches b on b.id = f.branch_id join public.companies co on co.id = b.company_id, m
    where f.branch_id in (select bid from brs) and t.created_at >= m.m0 and t.created_at < m.m1 and t.kind <> 'carry_over' and public.is_staff()
    union all
    select t.created_at::date, 'PC-FLOAT-' || to_char(f.period, 'YYYYMM'), case when t.kind in ('allocation', 'top_up') then 'BANK' else (select code from cash_acct) end,
           case when t.kind in ('allocation', 'top_up') then 'Bank' else 'Petty cash' end,
           coalesce(t.note, t.kind::text), case when t.kind in ('return', 'surplus') then t.amount else 0 end, case when t.kind in ('allocation', 'top_up', 'shortage') then t.amount else 0 end,
           public.branch_name(f.branch_id), co.currency_code::text, null
    from public.float_transactions t join public.floats f on f.id = t.float_id join public.branches b on b.id = f.branch_id join public.companies co on co.id = b.company_id, m
    where f.branch_id in (select bid from brs) and t.created_at >= m.m0 and t.created_at < m.m1 and t.kind <> 'carry_over' and public.is_staff()
  )
  select * from lines order by entry_date, reference, debit desc
$$;
revoke execute on function public.journal(date) from public, anon;
grant execute on function public.journal(date) to authenticated;

-- ---------- how much cash the box needs: only what was paid from the box ----------
create or replace function public.outlook_for(p_branch uuid, p_request uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  f record; v_has boolean; v_bal numeric := 0; v_alloc numeric; v_fid uuid; v_period date; v_out numeric := 0; v_spent numeric := 0; v_funds numeric := 0;
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
    'typical_month', v_typical, 'months', coalesce(v_months, 0), 'basis', v_basis, 'status', v_status);
end $$;
revoke execute on function public.outlook_for(uuid, uuid) from public, anon;
grant execute on function public.outlook_for(uuid, uuid) to authenticated;
