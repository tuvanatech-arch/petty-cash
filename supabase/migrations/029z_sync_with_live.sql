-- 029z: brings the setup files level with MGP's live database (checked object by object with ops/test-db/fingerprint.sql).
-- These pieces were applied straight to the live database and never saved as files. On MGP's database this file changes
-- nothing; on a new installation it makes the result identical to MGP's.

-- columns
alter table public.expense_proofs add column if not exists extracted jsonb;
alter table public.profiles add column if not exists email_notifications boolean not null default true;
alter table public.requests add column if not exists budget_note text;
alter table public.requests add column if not exists over_budget boolean not null default false;
alter table public.settings add column if not exists advance_grace_days integer not null default 3;
alter table public.settings add column if not exists app_url text not null default '';
alter table public.settings add column if not exists block_with_outstanding boolean not null default false;
alter table public.settings add column if not exists budget_mode text not null default 'require_approval';
alter table public.settings add column if not exists count_day integer not null default 5;
alter table public.settings add column if not exists email_from text not null default 'Petty Cash <onboarding@resend.dev>';
alter table public.settings add column if not exists headcount integer not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'settings_budget_mode_check') then
    alter table public.settings add constraint settings_budget_mode_check check (budget_mode = any (array['warn', 'require_approval', 'block']));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'settings_count_day_check') then
    alter table public.settings add constraint settings_count_day_check check (count_day >= 0 and count_day <= 6);
  end if;
end $$;

-- indexes
create index if not exists client_logs_at_idx on public.client_logs (at desc);
create index if not exists stock_movements_item_occurred on public.stock_movements (item_id, occurred_on);

-- functions as they are live
create or replace function public.my_roles() returns public.user_role[]
language sql stable security definer set search_path = public as $$
  select array_agg(distinct r) from (
    select role as r from public.profiles where id = auth.uid() and active
    union
    select d.role from public.delegations d join public.profiles me on me.id = auth.uid() and me.active
      join public.profiles f on f.id = d.from_user and f.active
      where d.to_user = auth.uid() and current_date between d.starts_on and d.ends_on
  ) x
$$;

create or replace function public.reset_request_numbers() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and public.my_role() <> 'approver' then raise exception 'Only the approver can do this'; end if;
  if exists (select 1 from public.requests) then raise exception 'Requests still exist'; end if;
  perform setval('public.request_no_seq', 1001, false);
end $$;

-- staff = anyone holding a staff position, including through a stand-in or as the MD
create or replace function public.is_staff() returns boolean
language sql stable set search_path = public as $$
  select public.has_role('stock_manager') or public.has_role('finance') or public.has_role('approver')
$$;

create or replace function public.journal(p_month date)
returns table(entry_date date, reference text, account text, account_name text, description text, debit numeric, credit numeric, branch text, currency text, request_no integer)
language sql stable security definer set search_path = public as $$
  with v as (select view_branch as b from public.profiles where id = auth.uid()),
  brs as (select x.bid from unnest(public.my_branches()) x(bid), v where v.b is null or x.bid = v.b),
  m as (select date_trunc('month', p_month)::date as m0, (date_trunc('month', p_month) + interval '1 month')::date as m1),
  cash_acct as (select coalesce(nullif(s.petty_cash_account, ''), 'PETTY-CASH') as code from public.settings s where s.id = 1),
  lines as (
    select l.spent_at as entry_date, 'PC-' || l.request_no as reference, coalesce(nullif(c.account_code, ''), 'UNMAPPED-' || upper(replace(coalesce(l.category_name, 'uncategorised'), ' ', '-'))) as account, coalesce(l.category_name, 'Uncategorised') as account_name,
           l.description || ' – ' || l.requester_name || coalesce(' @ ' || l.supplier_name, '') as description, l.line_total as debit, 0::numeric as credit,
           public.branch_name(l.branch_id) as branch, co.currency_code::text as currency, l.request_no
    from public.v_spend_lines l left join public.categories c on c.id = l.category_id join public.branches b on b.id = l.branch_id join public.companies co on co.id = b.company_id, m
    where l.branch_id in (select bid from brs) and l.spent_at >= m.m0 and l.spent_at < m.m1 and public.is_staff()
    union all
    select l.spent_at, 'PC-' || l.request_no, (select code from cash_acct), 'Petty cash', 'Voucher #' || l.request_no || ' – ' || l.requester_name, 0, sum(l.line_total),
           public.branch_name(l.branch_id), co.currency_code::text, l.request_no
    from public.v_spend_lines l join public.branches b on b.id = l.branch_id join public.companies co on co.id = b.company_id, m
    where l.branch_id in (select bid from brs) and l.spent_at >= m.m0 and l.spent_at < m.m1 and public.is_staff()
    group by l.spent_at, l.request_no, l.requester_name, l.branch_id, co.currency_code
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

create or replace function public.review_cash_count(p_id uuid, p_accept boolean, p_note text default null, p_write_off boolean default false)
returns public.cash_counts language plpgsql security definer set search_path = public as $$
declare c public.cash_counts%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_latest uuid;
begin
  if not public.has_role('approver') then raise exception 'Cash counts are signed off by the General Manager'; end if;
  select * into c from public.cash_counts where id = p_id for update;
  if c.id is null then raise exception 'Count not found'; end if;
  if c.counted_by = auth.uid() then raise exception 'Someone else must sign off your own count'; end if;
  if c.status not in ('to_review', 'queried') then raise exception 'This count is no longer waiting for sign-off'; end if;
  if not p_accept then
    if v_note is null then raise exception 'Write the question for finance'; end if;
    update public.cash_counts set status = 'queried', reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_note where id = p_id returning * into c;
    perform public.notify_user(c.counted_by, 'cash_count', 'Question on your cash count', v_note, '#/cash', null);
    return c;
  end if;
  if c.exception and v_note is null then
    raise exception 'The difference is above the % allowed: say how it was resolved', public.money_text(c.variance_limit);
  end if;
  if p_write_off and abs(c.difference) >= 0.005 then
    select id into v_latest from public.cash_counts where float_id = c.float_id and status <> 'superseded' order by counted_at desc limit 1;
    if v_latest <> c.id then raise exception 'A later count exists – write off the difference on that one'; end if;
    insert into public.float_transactions (float_id, kind, amount, created_by, note)
    values (c.float_id, case when c.difference < 0 then 'shortage'::public.float_tx_kind else 'surplus'::public.float_tx_kind end, abs(c.difference), auth.uid(),
            case when c.difference < 0 then 'Cash short' else 'Cash over' end || ' at the count of ' || to_char(c.counted_at at time zone 'Africa/Windhoek', 'DD Mon') || ', written off'
              || coalesce(' – ' || v_note, ''));
  end if;
  update public.cash_counts set status = 'accepted', reviewed_by = auth.uid(), reviewed_at = now(), review_note = coalesce(v_note, review_note),
         written_off = case when p_write_off and abs(c.difference) >= 0.005 then c.difference end
   where id = p_id returning * into c;
  perform public.notify_user(c.counted_by, 'cash_count', 'Cash count signed off',
    'Counted ' || to_char(c.counted_at at time zone 'Africa/Windhoek', 'DD Mon') || ': ' || public.cash_count_text(c) || case when c.written_off is not null then ' – the difference was written off.' else '.' end, '#/cash', null);
  return c;
end $$;

-- small helpers get a fixed search path, as live
alter function public.req_label(public.requests) set search_path = public;
alter function public.threshold() set search_path = public;
alter function public.touch_updated_at() set search_path = public;
alter function public.try_uuid(text) set search_path = public;

-- who may call what, exactly as live (internal helpers: the server only)
do $$
declare g jsonb := '{
  "apply_stock_movement": "service_role", "current_float": "service_role", "handle_new_user": "service_role", "touch_updated_at": "service_role",
  "budget_status": "authenticated,service_role", "my_roles": "authenticated,service_role", "reset_request_numbers": "authenticated,service_role",
  "check_session": "PUBLIC,authenticated,service_role,anon"
}'::jsonb;
  r record; k text; who text;
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and g ? p.proname loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.oid::regprocedure);
    foreach who in array string_to_array(g ->> r.proname, ',') loop
      execute format('grant execute on function %s to %s', r.oid::regprocedure, case when who = 'PUBLIC' then 'public' else quote_ident(who) end);
    end loop;
  end loop;
end $$;

-- receipts may be attached while a claim (money spent before approval) is still being raised, as live
alter policy expense_proofs_insert on public.expense_proofs with check (
  uploaded_by = auth.uid() and exists (select 1 from public.expenses e join public.requests r on r.id = e.request_id
    where e.id = expense_proofs.expense_id and public.can_view_request(r.id)
      and (r.status in ('disbursed', 'proof_review', 'physical_required')
           or (r.type = 'claim' and r.status in ('draft', 'pending_approval', 'awaiting_disbursement')))));
alter policy proofs_insert on storage.objects with check (
  bucket_id = 'proofs' and public.can_view_request(public.try_uuid((storage.foldername(name))[1]))
  and exists (select 1 from public.requests r where r.id = public.try_uuid((storage.foldername(objects.name))[1])
    and (r.status in ('disbursed', 'proof_review', 'physical_required')
         or (r.type = 'claim' and r.status in ('draft', 'pending_approval', 'awaiting_disbursement')))));
