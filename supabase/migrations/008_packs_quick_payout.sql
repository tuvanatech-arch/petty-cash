-- v3.2: month-end pack workflow (build -> bookkeeper review -> send to the accountant), and "pay out now" for finance.

-- ---------- settings ----------
alter table public.settings add column if not exists accountant_email text;
alter table public.settings add column if not exists accountant_name text;

-- ---------- storage for packs (private; signed URLs only) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('packs', 'packs', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;
create policy packs_staff_read on storage.objects for select to authenticated using (bucket_id = 'packs' and public.is_staff());
create policy packs_finance_write on storage.objects for insert to authenticated with check (bucket_id = 'packs' and (public.has_role('finance') or public.has_role('approver')));
create policy packs_finance_update on storage.objects for update to authenticated using (bucket_id = 'packs' and (public.has_role('finance') or public.has_role('approver')));

-- ---------- packs ----------
create table if not exists public.packs (
  id uuid primary key default gen_random_uuid(),
  float_id uuid not null unique references public.floats(id),
  period date not null,
  status text not null default 'review' check (status in ('review', 'sent')),
  storage_path text not null,
  file_name text not null,
  size_bytes bigint,
  pages int,
  summary jsonb,
  built_at timestamptz not null default now(),
  built_by uuid references public.profiles(id),
  note text,
  sent_at timestamptz,
  sent_by uuid references public.profiles(id),
  sent_to text,
  send_status text,
  created_at timestamptz not null default now()
);
alter table public.packs enable row level security;
create policy packs_select on public.packs for select to authenticated using (public.is_staff());
-- writes through the functions below (and the send-pack edge function with the service role)

-- the browser builds the PDF, uploads it, then registers it here; rebuilding replaces the file
create or replace function public.pack_register(p_float uuid, p_path text, p_file_name text, p_size bigint, p_pages int, p_summary jsonb) returns public.packs
language plpgsql security definer set search_path = public as $$
declare f public.floats%rowtype; p public.packs%rowtype; v_first boolean;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can build the month-end pack'; end if;
  select * into f from public.floats where id = p_float;
  if f.id is null then raise exception 'Float not found'; end if;
  if f.status <> 'closed' then raise exception 'Close the month first – the pack is built from the closed float'; end if;
  v_first := not exists (select 1 from public.packs where float_id = p_float);
  insert into public.packs (float_id, period, storage_path, file_name, size_bytes, pages, summary, built_by)
  values (p_float, f.period, p_path, p_file_name, p_size, p_pages, p_summary, auth.uid())
  on conflict (float_id) do update set storage_path = excluded.storage_path, file_name = excluded.file_name, size_bytes = excluded.size_bytes, pages = excluded.pages,
    summary = excluded.summary, built_at = now(), built_by = auth.uid(), status = 'review', sent_at = null, sent_by = null, sent_to = null, send_status = null
  returning * into p;
  if v_first then
    perform public.notify_role('finance', 'pack_review', 'Month-end pack ready to review: ' || to_char(f.period, 'Mon YYYY'),
      'Check the reconciliation and the receipts, then send it to the accountant.', '#/cash/pack/' || f.id, null);
    perform public.notify_role('approver', 'pack_review', 'Month-end pack built: ' || to_char(f.period, 'Mon YYYY'),
      'Finance is reviewing it before it goes to the accountant.', '#/cash/pack/' || f.id, null);
  end if;
  return p;
end $$;
revoke execute on function public.pack_register(uuid, text, text, bigint, int, jsonb) from public, anon;

-- sent by other means (e.g. handed over on a stick); the system still records who and when
create or replace function public.pack_mark_sent(p_pack uuid, p_how text default null) returns public.packs
language plpgsql security definer set search_path = public as $$
declare p public.packs%rowtype;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can submit the pack'; end if;
  update public.packs set status = 'sent', sent_at = now(), sent_by = auth.uid(), sent_to = coalesce(nullif(p_how, ''), 'sent another way'), send_status = 'manual'
   where id = p_pack returning * into p;
  if p.id is null then raise exception 'Pack not found'; end if;
  perform public.notify_role('approver', 'pack_sent', 'Month-end pack submitted: ' || to_char(p.period, 'Mon YYYY'), 'Marked as sent (' || p.sent_to || ') by ' || (select full_name from public.profiles where id = auth.uid()), '#/cash/pack/' || p.float_id, null);
  return p;
end $$;
revoke execute on function public.pack_mark_sent(uuid, text) from public, anon;

-- nudge finance when last month is still open after the 3rd
create or replace function public.remind_month_close() returns int
language plpgsql security definer set search_path = public as $$
declare f record; n int := 0;
begin
  if extract(day from current_date) < 3 then return 0; end if;
  for f in select * from public.floats where status = 'open' and period < date_trunc('month', current_date)::date loop
    if not exists (select 1 from public.notifications where kind = 'month_close' and created_at > now() - interval '6 days' and body like '%' || to_char(f.period, 'Mon YYYY') || '%') then
      perform public.notify_role('finance', 'month_close', 'Close ' || to_char(f.period, 'Mon YYYY') || ' and send the pack',
        'The float for ' || to_char(f.period, 'Mon YYYY') || ' is still open. Reconcile, close it, and the pack builds itself for the accountant.', '#/cash', null);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke execute on function public.remind_month_close() from public, anon;
select cron.schedule('petty-month-close', '0 7 * * *', 'select public.remind_month_close()');

-- ---------- pay out now (finance, under the threshold) ----------
-- An urgent one-off paid on the spot: the request is raised on the payee's behalf and paid in one step.
-- Above the threshold it is refused – raise a request so the approver signs it off.
create or replace function public.quick_payout(p_to uuid, p_amount numeric, p_purpose text, p_category uuid default null, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; f public.floats; v_bal numeric; v_owing numeric; s public.settings%rowtype; v_fin text;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can pay out petty cash'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount'; end if;
  if coalesce(p_purpose, '') = '' then raise exception 'Say what it is for'; end if;
  if p_amount > public.threshold() then raise exception 'Above the % limit – raise a request so the approver can sign it off first', public.money_text(public.threshold()); end if;
  if not exists (select 1 from public.profiles where id = p_to and active) then raise exception 'Choose who receives the cash'; end if;
  f := public.current_float();
  if f.id is null then raise exception 'No open petty cash float. Open this month''s float first.'; end if;
  v_bal := public.float_balance(f.id);
  if v_bal < p_amount then raise exception 'Insufficient float: balance is %', public.money_text(v_bal); end if;
  select * into s from public.settings where id = 1;
  if s.block_with_outstanding then
    select coalesce(sum(disbursed_amount), 0) into v_owing from public.requests where status = 'disbursed' and disbursed_to = p_to;
    if v_owing > 0 then raise exception 'They still have % out with no receipt recorded', public.money_text(v_owing); end if;
  end if;
  select full_name into v_fin from public.profiles where id = auth.uid();
  insert into public.requests (type, requester_id, purpose, category_id, status, estimated_total, approval_required, submitted_at,
                               disbursed_by, disbursed_at, disbursed_amount, disbursed_to, float_id)
  values ('cash', p_to, p_purpose, p_category, 'disbursed', round(p_amount, 2), false, now(), auth.uid(), now(), round(p_amount, 2), p_to, f.id)
  returning * into r;
  insert into public.request_lines (request_id, line_no, description, qty, est_unit_price, qty_to_buy) values (r.id, 1, p_purpose, 1, round(p_amount, 2), 1);
  insert into public.expenses (request_id, spent_by, spent_at, total) values (r.id, p_to, current_date, 0);
  perform public.log_event(r.id, 'submitted', 'draft', 'awaiting_disbursement', 'Paid on the spot by ' || v_fin || ' on behalf of the recipient');
  perform public.log_event(r.id, 'disbursed', 'awaiting_disbursement', 'disbursed', coalesce(p_note, '') || ' (paid ' || p_amount || ')');
  perform public.notify_user(p_to, 'cash_ready', 'Cash paid to you: ' || public.money_text(p_amount), public.req_label(r) || ' – upload the receipt and record what you spent.', '#/requests/' || r.id, r.id);
  return r;
end $$;
revoke execute on function public.quick_payout(uuid, numeric, text, uuid, text) from public, anon;
