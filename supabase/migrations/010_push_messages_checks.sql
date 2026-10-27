-- v3.4: push notifications, questions on a request, receipt pre-checks, stale nudges, Monday digest, weekly backups.

-- ---------- push subscriptions ----------
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  failed_at timestamptz,
  fail_reason text
);
alter table public.push_subscriptions enable row level security;
create policy push_subs_select on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy push_subs_insert on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid());
create policy push_subs_update on public.push_subscriptions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy push_subs_delete on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());
alter table public.notifications add column if not exists pushed_at timestamptz;
alter table public.notifications add column if not exists push_status text;
insert into public.app_config (key, value) values ('vapid_public', 'BBI2qUt-D0O8tjPadnA_u-gEjSgIo7k36alyFH-2JlMQwuACGnhOulX6N18pke5UjzHNdRTfLwdMdjAcUYP6_qc'), ('vapid_private', '6lPlDNSkC6EiIaP7f6YOtwsRBwN1JbB2-j3pB_GD01Q')
on conflict (key) do update set value = excluded.value;

-- every new alert is pushed to the person's phone(s) straight away
create or replace function public.notifications_push_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://ytfgzfaogfrzanrpcpkg.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', (select value from public.app_config where key = 'cron_key')),
    body := jsonb_build_object('id', new.id),
    timeout_milliseconds := 15000);
  return new;
exception when others then
  return new; -- a push hiccup never blocks the alert itself
end $$;
create trigger notifications_push after insert on public.notifications for each row execute function public.notifications_push_trigger();

-- ---------- questions and notes on a request ----------
create table if not exists public.request_messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id),
  author_id uuid not null references public.profiles(id),
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists request_messages_req_idx on public.request_messages (request_id, created_at);
alter table public.request_messages enable row level security;
create policy request_messages_select on public.request_messages for select to authenticated using (public.can_view_request(request_id));

create or replace function public.post_message(p_request uuid, p_body text) returns public.request_messages
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; m public.request_messages%rowtype; v_who text; v_holder public.user_role; u uuid; v_seen uuid[] := array[]::uuid[];
begin
  if not public.can_view_request(p_request) then raise exception 'Request not found'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'Write something first'; end if;
  select * into r from public.requests where id = p_request;
  insert into public.request_messages (request_id, author_id, body) values (p_request, auth.uid(), trim(p_body)) returning * into m;
  select full_name into v_who from public.profiles where id = auth.uid();
  v_holder := case r.status when 'stock_review' then 'stock_manager'::public.user_role when 'pending_approval' then 'approver'::public.user_role else 'finance'::public.user_role end;
  -- the people on this request, plus whoever holds it now; never the author
  for u in
    select r.requester_id union select r.disbursed_to union select r.stock_reviewed_by union select r.approved_by
    union select id from public.profiles where active and role = v_holder
    union select d.to_user from public.delegations d where d.role = v_holder and current_date between d.starts_on and d.ends_on
  loop
    if u is null or u = auth.uid() or u = any(v_seen) then continue; end if;
    v_seen := v_seen || u;
    perform public.notify_user(u, 'message', v_who || ' on ' || public.req_label(r), left(trim(p_body), 160), '#/requests/' || r.id, r.id);
  end loop;
  return m;
end $$;
revoke execute on function public.post_message(uuid, text) from public, anon;

-- ---------- receipt pre-checks for finance ----------
-- matches: the scanned receipt's total equals what was recorded; duplicate: the same amount on the same day already sits on another request
create or replace function public.expense_checks(p_request uuid default null)
returns table(request_id uuid, status text, note text, reading_total numeric)
language plpgsql stable security definer set search_path = public as $$
declare r record; v_n int; v_read numeric; v_dup_no int; v_status text; v_note text;
begin
  if p_request is null and not public.is_staff() then raise exception 'Not allowed'; end if;
  if p_request is not null and not public.can_view_request(p_request) then raise exception 'Not allowed'; end if;
  for r in select q.id, q.request_no, e.id as expense_id, e.total, e.spent_at, e.supplier_name from public.requests q join public.expenses e on e.request_id = q.id
           where (p_request is null and q.status in ('proof_review', 'physical_required', 'awaiting_disbursement') and e.total > 0) or q.id = p_request loop
    select count(*), max((p.extracted->>'total')::numeric) filter (where p.extracted ? 'total' and p.extracted->>'total' is not null and p.extracted->>'total' ~ '^[0-9.]+$')
      into v_n, v_read from public.expense_proofs p where p.expense_id = r.expense_id;
    v_status := case when v_n = 0 then 'no_proof' when v_read is null then 'unread'
                     when abs(v_read - r.total) <= greatest(0.5, v_read * 0.01) then 'matches' else 'mismatch' end;
    v_note := case v_status when 'matches' then 'Receipt reads ' || public.money_text(v_read) || ' – matches what was recorded'
                            when 'mismatch' then 'Receipt reads ' || public.money_text(v_read) || ' but ' || public.money_text(r.total) || ' was recorded'
                            when 'unread' then 'Scan attached, not read' else 'No scan attached' end;
    select q2.request_no into v_dup_no from public.expenses e2 join public.requests q2 on q2.id = e2.request_id
      where e2.request_id <> r.id and e2.spent_at = r.spent_at and abs(e2.total - r.total) < 0.01 and e2.total > 0
        and q2.status not in ('rejected', 'cancelled', 'draft')
        and (coalesce(e2.supplier_name, '') = '' or coalesce(r.supplier_name, '') = '' or lower(e2.supplier_name) = lower(r.supplier_name)) limit 1;
    if v_dup_no is not null then v_status := 'duplicate'; v_note := 'Same amount on the same day as #' || v_dup_no || ' – possible duplicate'; end if;
    request_id := r.id; status := v_status; note := v_note; reading_total := v_read;
    return next;
  end loop;
end $$;
revoke execute on function public.expense_checks(uuid) from public, anon;

-- ---------- nothing waits silently ----------
create or replace function public.remind_stale_items() returns int
language plpgsql security definer set search_path = public as $$
declare q record; n int := 0; v_holder public.user_role; v_days int; v_label text;
begin
  for q in select * from public.requests where status in ('stock_review', 'pending_approval', 'awaiting_disbursement', 'proof_review', 'physical_required') and updated_at < now() - interval '24 hours' loop
    if exists (select 1 from public.notifications where request_id = q.id and kind in ('stale', 'stale_escalation') and created_at > now() - interval '20 hours') then continue; end if;
    v_days := floor(extract(epoch from now() - q.updated_at) / 86400);
    v_holder := case q.status when 'stock_review' then 'stock_manager'::public.user_role when 'pending_approval' then 'approver'::public.user_role else 'finance'::public.user_role end;
    v_label := public.req_label(q) || ' (' || public.money_text(q.estimated_total) || ') has been waiting ' || v_days || ' day' || case when v_days = 1 then '' else 's' end;
    perform public.notify_role(v_holder, 'stale', 'Waiting on you: ' || public.req_label(q), v_label || case q.status when 'stock_review' then ' for stock review.' when 'pending_approval' then ' for approval.' when 'awaiting_disbursement' then ' to be paid out.' when 'proof_review' then ' for the receipt check.' else ' for the paper receipt.' end, '#/requests/' || q.id, q.id);
    if q.status = 'physical_required' and q.disbursed_to is not null then
      perform public.notify_user(q.disbursed_to, 'stale', 'Finance still needs your paper receipt', v_label || '. Hand the original to finance.', '#/requests/' || q.id, q.id);
    end if;
    if v_days >= 2 and v_holder <> 'approver' then
      perform public.notify_role('approver', 'stale_escalation', 'Stuck for ' || v_days || ' days: ' || public.req_label(q), 'With ' || replace(v_holder::text, '_', ' ') || ' since ' || to_char(q.updated_at, 'DD Mon') || '.', '#/requests/' || q.id, q.id);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.remind_stale_items() from public, anon;
select cron.schedule('petty-stale-items', '0 8 * * *', 'select public.remind_stale_items()');

-- ---------- Monday note for the approver ----------
create or replace function public.weekly_digest() returns int
language plpgsql security definer set search_path = public as $$
declare v_this numeric; v_last numeric; v_bal numeric; v_out numeric; v_stuck int; v_outs int; v_over text; v_body text; f public.floats; v_n int := 0; u uuid; v_day int;
begin
  v_day := extract(day from current_date)::int;
  select coalesce(sum(line_total), 0) into v_this from public.v_spend_lines where spent_at >= date_trunc('month', current_date)::date;
  select coalesce(sum(line_total), 0) into v_last from public.v_spend_lines
    where spent_at >= (date_trunc('month', current_date) - interval '1 month')::date and extract(day from spent_at) <= v_day and spent_at < date_trunc('month', current_date)::date;
  f := public.current_float();
  v_bal := case when f.id is null then null else public.float_balance(f.id) end;
  select coalesce(sum(disbursed_amount), 0) into v_out from public.requests where status = 'disbursed';
  select count(*) into v_stuck from public.requests where status in ('stock_review', 'pending_approval', 'awaiting_disbursement', 'proof_review', 'physical_required') and updated_at < now() - interval '48 hours';
  select count(distinct item_id) into v_outs from public.stock_reports where resolved_at is null and level = 'out';
  select string_agg(l || ' ' || round(used / nullif(lim, 0) * 100) || '%', ', ') into v_over from (
    select coalesce(c.name, p.full_name) as l, b.monthly_limit as lim,
      coalesce((select sum(sl.line_total) from public.v_spend_lines sl where sl.spent_at >= date_trunc('month', current_date)::date and ((b.category_id is not null and sl.category_id = b.category_id) or (b.person_id is not null and sl.requester_id = b.person_id))), 0) as used
    from public.budgets b left join public.categories c on c.id = b.category_id left join public.profiles p on p.id = b.person_id where b.active) x where used >= lim * 0.8;
  v_body := 'Spent so far this month ' || public.money_text(v_this) || ' (same point last month ' || public.money_text(v_last) || ').'
    || case when v_bal is null then ' No float is open.' else ' In the box ' || public.money_text(v_bal) || case when v_out > 0 then ', ' || public.money_text(v_out) || ' out with people.' else '.' end end
    || case when v_over is not null then ' Budgets near or over: ' || v_over || '.' else '' end
    || case when v_stuck > 0 then ' ' || v_stuck || ' request' || case when v_stuck = 1 then '' else 's' end || ' stuck for 2+ days.' else ' Nothing stuck.' end
    || case when v_outs > 0 then ' ' || v_outs || ' item' || case when v_outs = 1 then '' else 's' end || ' reported out of stock.' else '' end;
  for u in select id from public.profiles where active and role = 'approver' loop
    perform public.notify_user(u, 'weekly_digest', 'Your Monday petty cash note', v_body, '#/reports', null); v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke execute on function public.weekly_digest() from public, anon;
select cron.schedule('petty-weekly-digest', '30 6 * * 1', 'select public.weekly_digest()');

-- ---------- weekly backup of all tables to private storage ----------
insert into storage.buckets (id, name, public) values ('backups', 'backups', false) on conflict (id) do nothing;
select cron.schedule('petty-backup', '0 2 * * 0', $cron$select net.http_post(
  url := 'https://ytfgzfaogfrzanrpcpkg.supabase.co/functions/v1/backup',
  headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', (select value from public.app_config where key = 'cron_key')),
  body := '{}'::jsonb, timeout_milliseconds := 120000)$cron$);
