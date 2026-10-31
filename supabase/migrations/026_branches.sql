-- 026: companies, branches and currencies – the foundation for Lüderitz (a second float in the same company)
-- and later the Angolan company (its own currency). Windhoek is the only branch today, so nothing changes for anyone.
--
-- Rules:
--   company → branch → float. Every float, request, store item, count, top-up and pack belongs to a branch.
--   Limits and rules (the authority schedule) stay at company level; only the usual float amount is per branch.
--   Each person has a home branch and may hold a position in more branches. The GM and the MD see every branch of
--   their company. profiles.view_branch is the branch a person is looking at (null = all of theirs).

-- ---------- tables ----------
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null,
  currency text not null default 'N$',          -- the symbol the screens show
  currency_code char(3) not null default 'NAD', -- ISO code, for exports and conversion
  is_base boolean not null default false,       -- the currency the group view is shown in
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists companies_code_uq on public.companies (lower(code));
alter table public.companies enable row level security;
create policy companies_select on public.companies for select to authenticated using (true);

create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  name text not null,
  code text not null,
  usual_float numeric(12,2),                     -- null: the schedule's usual monthly float
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists branches_code_uq on public.branches (company_id, lower(code));
create unique index if not exists branches_name_uq on public.branches (company_id, lower(name));
alter table public.branches enable row level security;
create policy branches_select on public.branches for select to authenticated using (true);

-- one rate a month per non-base company: 1 unit of its currency = rate units of the base currency (used by the group view)
create table if not exists public.fx_rates (
  company_id uuid not null references public.companies(id),
  month date not null,
  rate numeric(14,6) not null check (rate > 0),
  set_by uuid references public.profiles(id),
  set_at timestamptz not null default now(),
  primary key (company_id, month)
);
alter table public.fx_rates enable row level security;
create policy fx_rates_select on public.fx_rates for select to authenticated using (true);


-- the first company and branch, from what is already set up
do $$
declare c uuid; b uuid; v_org text;
begin
  if not exists (select 1 from public.companies) then
    select coalesce(nullif(org_name, ''), 'Petty cash') into v_org from public.settings where id = 1;
    insert into public.companies (name, code, is_base) values (v_org, coalesce(nullif(upper(left(regexp_replace(v_org, '[^A-Za-z]', '', 'g'), 3)), ''), 'CO'), true) returning id into c;
    insert into public.branches (company_id, name, code) values (c, 'Head office', 'HQ') returning id into b;
  end if;
end $$;

alter table public.profiles add column if not exists branch_id uuid references public.branches(id);
alter table public.profiles add column if not exists view_branch uuid references public.branches(id);
alter table public.profiles add column if not exists extra_branches uuid[] not null default '{}';   -- other branches this person covers
alter table public.floats add column if not exists branch_id uuid references public.branches(id);
alter table public.requests add column if not exists branch_id uuid references public.branches(id);
alter table public.items add column if not exists branch_id uuid references public.branches(id);
alter table public.budgets add column if not exists branch_id uuid references public.branches(id);   -- null: every branch of the company

update public.profiles set branch_id = (select id from public.branches order by created_at limit 1) where branch_id is null;
update public.floats set branch_id = (select id from public.branches order by created_at limit 1) where branch_id is null;
update public.requests set branch_id = (select id from public.branches order by created_at limit 1) where branch_id is null;
update public.items set branch_id = (select id from public.branches order by created_at limit 1) where branch_id is null;
update public.budgets set branch_id = (select id from public.branches order by created_at limit 1) where branch_id is null;
alter table public.profiles alter column branch_id set not null;
alter table public.floats alter column branch_id set not null;
alter table public.requests alter column branch_id set not null;
alter table public.items alter column branch_id set not null;

create index if not exists floats_branch_idx on public.floats (branch_id, period desc);
create index if not exists requests_branch_idx on public.requests (branch_id, status);
create index if not exists items_branch_idx on public.items (branch_id);
-- one float per branch per month, and item names unique within a branch. The old one-branch rules (floats.period unique,
-- items name unique) are dropped in 026b_run_in_supabase.sql; until then only one branch can be used.
create unique index if not exists floats_branch_period_uq on public.floats (branch_id, period);
create unique index if not exists items_branch_name_uq on public.items (branch_id, lower(name));

-- ---------- who sees which branches ----------
/** Every branch this person may work in: home branch, extra branches, all of the company for the GM and MD, and the same for anyone they stand in for. */
create or replace function public.my_branches() returns uuid[]
language sql stable security definer set search_path = public as $$
  with me as (select p.id, p.role, p.branch_id, p.active from public.profiles p where p.id = auth.uid()),
  who as (
    select id, role, branch_id from me where active
    union
    select f.id, d.role, f.branch_id from public.delegations d
      join public.profiles f on f.id = d.from_user and f.active
      where d.to_user = auth.uid() and current_date between d.starts_on and d.ends_on
        and exists (select 1 from me where active)
  ),
  mine as (
    select w.branch_id from who w
    union
    select unnest(p.extra_branches) from public.profiles p join who w on w.id = p.id
    union
    select b.id from who w join public.branches hb on hb.id = w.branch_id join public.branches b on b.company_id = hb.company_id
      where w.role in ('approver', 'managing_director') and b.active
  )
  select coalesce(array_agg(distinct branch_id), '{}'::uuid[]) from mine
$$;
grant execute on function public.my_branches() to authenticated;

/** The branch this person is looking at or acting in: their chosen view if it is one of theirs, otherwise their home branch. */
create or replace function public.my_branch() returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.view_branch from public.profiles p where p.id = auth.uid() and p.view_branch = any(public.my_branches())),
    (select p.branch_id from public.profiles p where p.id = auth.uid()))
$$;
grant execute on function public.my_branch() to authenticated;

create or replace function public.branch_name(p_branch uuid) returns text
language sql stable security definer set search_path = public as $$ select name from public.branches where id = p_branch $$;
grant execute on function public.branch_name(uuid) to authenticated;

/** Choose the branch to look at (null = all of mine). */
create or replace function public.set_view_branch(p_branch uuid) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if p_branch is not null and not (p_branch = any(public.my_branches())) then raise exception 'That branch is not yours to view'; end if;
  update public.profiles set view_branch = p_branch where id = auth.uid();
  return p_branch;
end $$;
grant execute on function public.set_view_branch(uuid) to authenticated;

-- ---------- defaults: a new request or item belongs to the branch its maker is acting in ----------
create or replace function public.branch_default() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.branch_id is null then
    new.branch_id := coalesce(public.my_branch(),
      case when tg_table_name = 'requests' then (select branch_id from public.profiles where id = new.requester_id) end,
      (select id from public.branches where active order by created_at limit 1));
  end if;
  return new;
end $$;
revoke execute on function public.branch_default() from public, anon, authenticated;
create or replace trigger requests_branch_default before insert on public.requests for each row execute function public.branch_default();
create or replace trigger items_branch_default before insert on public.items for each row execute function public.branch_default();

-- ---------- row visibility follows the branches a person may work in ----------
alter policy requests_select on public.requests using (
  requester_id = auth.uid() or disbursed_to = auth.uid()
  or (branch_id = any(public.my_branches())
      and (public.has_role('finance') or public.has_role('approver')
           or (public.has_role('stock_manager') and (type = 'stock' or not_stock)))));
alter policy floats_select on public.floats using (public.is_staff() and branch_id = any(public.my_branches()));
alter policy float_tx_select on public.float_transactions using (public.is_staff() and exists (select 1 from public.floats f where f.id = float_id and f.branch_id = any(public.my_branches())));
alter policy items_select on public.items using (branch_id = any(public.my_branches()));
alter policy items_write on public.items using (public.my_role() in ('stock_manager', 'approver') and branch_id = any(public.my_branches()))
  with check (public.my_role() in ('stock_manager', 'approver') and branch_id = any(public.my_branches()));
alter policy packs_select on public.packs using (public.is_staff() and exists (select 1 from public.floats f where f.id = float_id and f.branch_id = any(public.my_branches())));
alter policy cash_counts_select on public.cash_counts using ((public.has_role('finance') or public.has_role('approver')) and exists (select 1 from public.floats f where f.id = float_id and f.branch_id = any(public.my_branches())));
alter policy top_ups_select on public.top_ups using ((public.has_role('finance') or public.has_role('approver')) and exists (select 1 from public.floats f where f.id = float_id and f.branch_id = any(public.my_branches())));

create or replace function public.can_view_request(p_request uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.requests r
    where r.id = p_request and (
      r.requester_id = auth.uid() or r.disbursed_to = auth.uid()
      or (r.branch_id = any(public.my_branches())
          and (public.has_role('finance') or public.has_role('approver')
               or (public.has_role('stock_manager') and (r.type = 'stock' or r.not_stock))))))
$$;

-- ---------- views carry the branch ----------
create or replace view public.v_floats as
  select id, period, opening_amount, status, opened_by, opened_at, closed_by, closed_at, counted_cash, notes,
    coalesce((select sum(t.amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'allocation'), 0) as allocated,
    coalesce((select sum(t.amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'top_up'), 0) as topped_up,
    coalesce((select sum(t.amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'carry_over'), 0) as carried_over,
    coalesce((select sum(t.amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'return'), 0) as returned,
    coalesce((select sum(r.disbursed_amount) from public.requests r where r.float_id = f.id and r.status = 'disbursed'), 0) as outstanding,
    coalesce((select sum(e.total) from public.expenses e join public.requests r on r.id = e.request_id
               where r.float_id = f.id and r.status in ('proof_review', 'physical_required', 'closed')), 0) as spent,
    public.float_balance(id) as balance,
    coalesce((select sum(case when t.kind = 'surplus' then t.amount else -t.amount end) from public.float_transactions t
               where t.float_id = f.id and t.kind in ('surplus', 'shortage')), 0) as adjusted,
    branch_id
  from public.floats f;

create or replace view public.v_spend_lines with (security_invoker = true) as
select el.id, e.spent_at, date_trunc('month', e.spent_at)::date as month,
  r.id as request_id, r.request_no, r.type, r.for_store, r.requester_id, p.full_name as requester_name,
  r.disbursed_to, r.disbursed_amount, r.approval_required, r.approved_by, r.float_id, r.status,
  el.item_id, coalesce(i.name, el.description) as description, i.unit, el.qty, el.unit_price, el.line_total,
  coalesce(c.id, rc.id) as category_id, coalesce(c.name, rc.name, 'Uncategorised') as category_name,
  el.supplier_id, el.supplier_name, e.total as expense_total, r.branch_id
from public.expense_lines el
join public.expenses e on e.id = el.expense_id
join public.requests r on r.id = e.request_id
join public.profiles p on p.id = r.requester_id
left join public.items i on i.id = el.item_id
left join public.categories c on c.id = i.category_id
left join public.categories rc on rc.id = r.category_id
where not el.void and r.status in ('proof_review','physical_required','closed');

-- ---------- the float of a branch ----------
create or replace function public.branch_float(p_branch uuid) returns public.floats
language sql stable security definer set search_path = public as $$
  select * from public.floats where status = 'open' and branch_id = p_branch order by period desc limit 1
$$;
revoke execute on function public.branch_float(uuid) from public, anon, authenticated;

/** The open float of the branch the caller is acting in. */
create or replace function public.current_float() returns public.floats
language sql stable security definer set search_path = public as $$
  select * from public.branch_float(public.my_branch())
$$;

create or replace function public.open_float(p_period date, p_amount numeric, p_note text default null) returns public.floats
language plpgsql security definer set search_path = public as $$
declare f public.floats%rowtype; prev public.floats%rowtype; v_period date; v_carry numeric; s public.settings%rowtype; b public.branches%rowtype; v_usual numeric;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can open a float'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Enter the float amount'; end if;
  select * into b from public.branches where id = public.my_branch();
  if b.id is null or not b.active then raise exception 'Choose the branch first'; end if;
  select * into s from public.settings where id = 1;
  v_usual := coalesce(b.usual_float, s.default_monthly_float);
  if v_usual > 0 and p_amount > v_usual then
    raise exception 'The usual monthly float for % is %. Open with that and request a top-up for more.', b.name, public.money_text(v_usual);
  end if;
  v_period := date_trunc('month', coalesce(p_period, current_date))::date;
  if exists (select 1 from public.floats where branch_id = b.id and period = v_period) then raise exception 'A float for % already exists for %', to_char(v_period, 'Mon YYYY'), b.name; end if;
  if exists (select 1 from public.floats where branch_id = b.id and status = 'open') then raise exception 'Close the current float before opening a new one'; end if;
  insert into public.floats (period, opening_amount, opened_by, notes, branch_id) values (v_period, round(p_amount, 2), auth.uid(), nullif(p_note, ''), b.id) returning * into f;
  insert into public.float_transactions (float_id, kind, amount, created_by, note) values (f.id, 'allocation', round(p_amount, 2), auth.uid(), 'Monthly allocation from finance');
  if s.float_rollover then
    select * into prev from public.floats where branch_id = b.id and period < v_period and status = 'closed' order by period desc limit 1;
    if prev.id is not null then
      v_carry := coalesce(prev.counted_cash, public.float_balance(prev.id));
      if v_carry > 0 then
        insert into public.float_transactions (float_id, kind, amount, created_by, note)
        values (f.id, 'carry_over', v_carry, auth.uid(), 'Carried over from ' || to_char(prev.period, 'Mon YYYY') || case when prev.counted_cash is not null then ' (cash counted at close)' else '' end);
      end if;
    end if;
  end if;
  return f;
end $$;

-- paying out draws on the float of the request's branch
create or replace function public.disburse_request(p_request uuid, p_amount numeric, p_to uuid default null, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; e public.expenses%rowtype; f public.floats; v_bal numeric; v_to uuid; d record; s public.settings%rowtype; v_cap numeric;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can pay out petty cash'; end if;
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'awaiting_disbursement' then raise exception 'Request is not awaiting disbursement'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount paid out'; end if;
  if not (r.branch_id = any(public.my_branches())) then raise exception 'This request belongs to %, which is not your branch', public.branch_name(r.branch_id); end if;
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
  f := public.branch_float(r.branch_id);
  if f.id is null then raise exception 'No open petty cash float for %. Open this month''s float first.', public.branch_name(r.branch_id); end if;
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

-- the outlook is for the branch being looked at (or the request's branch)
create or replace function public.float_outlook(p_request uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  f record; v_has boolean; v_bal numeric := 0; v_alloc numeric; v_fid uuid; v_period date; v_out numeric := 0; v_spent numeric := 0; v_funds numeric := 0;
  today date := current_date; dim int; dleft int; v_branch uuid;
  v_this numeric := 0; v_awaiting numeric; v_pending numeric; v_after numeric;
  v_expected numeric; v_months int; v_typical numeric; v_reserve numeric; v_buffer numeric; v_basis text; v_status text;
begin
  if not (public.has_role('approver') or public.has_role('finance')) then raise exception 'Not allowed'; end if;
  if p_request is not null then select branch_id, coalesce(estimated_total, 0) into v_branch, v_this from public.requests where id = p_request; end if;
  v_branch := coalesce(v_branch, public.my_branch());
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
    where branch_id = v_branch and spent_at >= (date_trunc('month', today) - interval '6 months')::date and spent_at < date_trunc('month', today)::date
  ), after as (
    select m.m,
      coalesce((select sum(l.line_total) from public.v_spend_lines l where l.branch_id = v_branch and date_trunc('month', l.spent_at)::date = m.m and extract(day from l.spent_at) > extract(day from today)), 0) as rest,
      coalesce((select sum(l.line_total) from public.v_spend_lines l where l.branch_id = v_branch and date_trunc('month', l.spent_at)::date = m.m), 0) as total
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

-- budgets: a budget with no branch applies to every branch; the status is for the branch being looked at
create or replace function public.budget_status()
returns table(budget_id uuid, category_id uuid, person_id uuid, label text, monthly_limit numeric, used numeric, note text, active boolean)
language sql stable security definer set search_path = public as $$
  select b.id, b.category_id, b.person_id,
    coalesce(c.name, p.full_name) as label, b.monthly_limit,
    coalesce((
      select sum(x.amount) from (
        select el.line_total as amount
          from public.expense_lines el join public.expenses e on e.id = el.expense_id join public.requests q on q.id = e.request_id
          left join public.items i on i.id = el.item_id
         where not el.void and q.status in ('proof_review','physical_required','closed') and e.spent_at >= date_trunc('month', current_date)::date
           and (b.branch_id is null or q.branch_id = b.branch_id)
           and (b.category_id is null or coalesce(i.category_id, q.category_id) = b.category_id) and (b.person_id is null or q.requester_id = b.person_id)
        union all
        select q.disbursed_amount from public.requests q
         where q.status = 'disbursed' and q.disbursed_at >= date_trunc('month', current_date) and (b.branch_id is null or q.branch_id = b.branch_id)
           and (b.category_id is null or q.category_id = b.category_id) and (b.person_id is null or q.requester_id = b.person_id)
        union all
        select q.estimated_total from public.requests q
         where q.status in ('pending_approval','awaiting_disbursement') and q.submitted_at >= date_trunc('month', current_date) and (b.branch_id is null or q.branch_id = b.branch_id)
           and (b.category_id is null or q.category_id = b.category_id) and (b.person_id is null or q.requester_id = b.person_id)
      ) x), 0) as used,
    b.note, b.active
  from public.budgets b
  left join public.categories c on c.id = b.category_id
  left join public.profiles p on p.id = b.person_id
  where (public.is_staff() or b.person_id is null or b.person_id = auth.uid())
    and (b.branch_id is null or b.branch_id = any(public.my_branches()))
    and (b.branch_id is null or (select view_branch from public.profiles where id = auth.uid()) is null or b.branch_id = (select view_branch from public.profiles where id = auth.uid()))
$$;

-- a new budget is for the branch the administrator is looking at; looking at all branches makes it company-wide
create or replace function public.schedule_budget(p_budget uuid, p_category uuid, p_person uuid, p_limit numeric, p_note text, p_active boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_reason text := btrim(coalesce(p_reason, '')); b public.budgets%rowtype; v public.schedule_versions%rowtype; v_branch uuid;
begin
  if public.my_role() is distinct from 'approver' then raise exception 'Only the administrator changes budgets'; end if;
  if length(v_reason) < 3 then raise exception 'Say why the budget is changing'; end if;
  if p_limit is null or p_limit <= 0 then raise exception 'Enter a monthly limit'; end if;
  if p_budget is null then
    if (p_category is null) = (p_person is null) then raise exception 'A budget is for one category or one person'; end if;
    select view_branch into v_branch from public.profiles where id = auth.uid();
    if exists (select 1 from public.budgets where category_id is not distinct from p_category and person_id is not distinct from p_person and branch_id is not distinct from v_branch) then
      raise exception 'There is already a budget for that. Edit it instead.';
    end if;
    insert into public.budgets (category_id, person_id, monthly_limit, note, active, branch_id)
    values (p_category, p_person, round(p_limit, 2), nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_active, true), v_branch) returning * into b;
  else
    update public.budgets set monthly_limit = round(p_limit, 2), note = nullif(btrim(coalesce(p_note, '')), ''), active = coalesce(p_active, active)
     where id = p_budget returning * into b;
    if b.id is null then raise exception 'Budget not found'; end if;
  end if;
  v := public.schedule_record('budgets', v_reason, auth.uid(), case when public.role_filled('managing_director') then 'notified' else 'no_md' end);
  return jsonb_build_object('budget', b.id, 'version', v.version_no);
end $$;

-- claims summary for the branch being looked at (all of mine when none is chosen)
create or replace function public.claims_summary(p_from date default null, p_to date default null)
returns table(person_id uuid, person_name text, claims int, claimed numeric, all_spend numeric, share numeric)
language sql stable security definer set search_path = public as $$
  with win as (select coalesce(p_from, date_trunc('month', current_date)::date) as f, coalesce(p_to, current_date) as t),
  v as (select view_branch from public.profiles where id = auth.uid()),
  spend as (
    select q.requester_id, q.type, coalesce(e.total, q.disbursed_amount, 0) as amt
    from public.requests q left join public.expenses e on e.request_id = q.id, win, v
    where q.status in ('disbursed', 'proof_review', 'physical_required', 'closed') and q.disbursed_at::date between win.f and win.t and public.is_staff()
      and q.branch_id = any(public.my_branches()) and (v.view_branch is null or q.branch_id = v.view_branch)
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

-- ---------- alerts go to the right branch ----------
/** Tell everyone holding a position in one branch (the GM and MD hold theirs for every branch). */
create or replace function public.notify_branch_role(p_branch uuid, p_role public.user_role, p_kind text, p_title text, p_body text default null, p_link text default null, p_request uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  for u in
    select p.id from public.profiles p where p.active and p.role = p_role
      and (p_branch is null or p_role in ('approver', 'managing_director') or p.branch_id = p_branch or p_branch = any(p.extra_branches))
    union
    select d.to_user from public.delegations d
      join public.profiles f on f.id = d.from_user and f.active
      join public.profiles t on t.id = d.to_user and t.active
      where d.role = p_role and current_date between d.starts_on and d.ends_on
        and (p_branch is null or p_role in ('approver', 'managing_director') or f.branch_id = p_branch or p_branch = any(f.extra_branches))
  loop
    perform public.notify_user(u, p_kind, p_title, p_body, p_link, p_request);
  end loop;
end $$;
revoke execute on function public.notify_branch_role(uuid, public.user_role, text, text, text, text, uuid) from public, anon, authenticated;

/** An alert about a request goes to that request's branch; one without a request goes to every branch. */
create or replace function public.notify_role(p_role public.user_role, p_kind text, p_title text, p_body text default null, p_link text default null, p_request uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_branch uuid;
begin
  if p_request is not null then select branch_id into v_branch from public.requests where id = p_request; end if;
  perform public.notify_branch_role(v_branch, p_role, p_kind, p_title, p_body, p_link, p_request);
end $$;

create or replace function public.remind_cash_count() returns integer
language plpgsql security definer set search_path = public as $$
declare s public.settings%rowtype; f record; v_last timestamptz; n int := 0;
begin
  if auth.uid() is not null and not public.has_role('approver') then raise exception 'Not allowed'; end if;
  select * into s from public.settings where id = 1;
  if coalesce(s.cash_count_days, 0) <= 0 then return 0; end if;
  for f in select * from public.floats where status = 'open' loop
    select greatest(f.opened_at, max(counted_at)) into v_last from public.cash_counts where float_id = f.id;
    v_last := coalesce(v_last, f.opened_at);
    if v_last > now() - make_interval(days => s.cash_count_days) then continue; end if;
    if exists (select 1 from public.notifications where kind = 'cash_count_due' and created_at > now() - make_interval(days => s.cash_count_days)
               and body like '%' || public.branch_name(f.branch_id) || '%') then continue; end if;
    perform public.notify_branch_role(f.branch_id, 'finance', 'cash_count_due', 'Time for a cash count',
      'The ' || public.branch_name(f.branch_id) || ' box was last counted ' || (current_date - (v_last at time zone 'Africa/Windhoek')::date) || ' days ago. Count it under Petty cash → Count cash; the GM signs it off.', '#/cash', null);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.remind_month_close() returns integer
language plpgsql security definer set search_path = public as $$
declare f record; n int := 0;
begin
  if extract(day from current_date) < 3 then return 0; end if;
  for f in select * from public.floats where status = 'open' and period < date_trunc('month', current_date)::date loop
    if not exists (select 1 from public.notifications where kind = 'month_close' and created_at > now() - interval '6 days'
                   and body like '%' || to_char(f.period, 'Mon YYYY') || '%' and body like '%' || public.branch_name(f.branch_id) || '%') then
      perform public.notify_branch_role(f.branch_id, 'finance', 'month_close', 'Close ' || to_char(f.period, 'Mon YYYY') || ' and send the pack',
        'The ' || public.branch_name(f.branch_id) || ' float for ' || to_char(f.period, 'Mon YYYY') || ' is still open. Reconcile, close it, and the pack builds itself for the accountant.', '#/cash', null);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- the Monday note: one line per open box
create or replace function public.weekly_digest() returns integer
language plpgsql security definer set search_path = public as $$
declare v_this numeric; v_last numeric; v_box text; v_out numeric; v_stuck int; v_outs int; v_over text; v_body text; v_n int := 0; u uuid; v_day int;
begin
  v_day := extract(day from current_date)::int;
  select coalesce(sum(line_total), 0) into v_this from public.v_spend_lines where spent_at >= date_trunc('month', current_date)::date;
  select coalesce(sum(line_total), 0) into v_last from public.v_spend_lines
    where spent_at >= (date_trunc('month', current_date) - interval '1 month')::date and extract(day from spent_at) <= v_day and spent_at < date_trunc('month', current_date)::date;
  select string_agg(case when (select count(*) from public.floats where status = 'open') > 1 then public.branch_name(f.branch_id) || ' ' else '' end || public.money_text(public.float_balance(f.id)), ', ')
    into v_box from public.floats f where f.status = 'open';
  select coalesce(sum(disbursed_amount), 0) into v_out from public.requests where status = 'disbursed';
  select count(*) into v_stuck from public.requests where status in ('stock_review', 'pending_approval', 'awaiting_disbursement', 'proof_review', 'physical_required') and updated_at < now() - interval '48 hours';
  select count(distinct item_id) into v_outs from public.stock_reports where resolved_at is null and level = 'out';
  select string_agg(l || ' ' || round(used / nullif(lim, 0) * 100) || '%', ', ') into v_over from (
    select coalesce(c.name, p.full_name) as l, b.monthly_limit as lim,
      coalesce((select sum(sl.line_total) from public.v_spend_lines sl where sl.spent_at >= date_trunc('month', current_date)::date and (b.branch_id is null or sl.branch_id = b.branch_id)
                and ((b.category_id is not null and sl.category_id = b.category_id) or (b.person_id is not null and sl.requester_id = b.person_id))), 0) as used
    from public.budgets b left join public.categories c on c.id = b.category_id left join public.profiles p on p.id = b.person_id where b.active) x where used >= lim * 0.8;
  v_body := 'Spent so far this month ' || public.money_text(v_this) || ' (same point last month ' || public.money_text(v_last) || ').'
    || case when v_box is null then ' No float is open.' else ' In the box ' || v_box || case when v_out > 0 then ', ' || public.money_text(v_out) || ' out with people.' else '.' end end
    || case when v_over is not null then ' Budgets near or over: ' || v_over || '.' else '' end
    || case when v_stuck > 0 then ' ' || v_stuck || ' request' || case when v_stuck = 1 then '' else 's' end || ' stuck for 2+ days.' else ' Nothing stuck.' end
    || case when v_outs > 0 then ' ' || v_outs || ' item' || case when v_outs = 1 then '' else 's' end || ' reported out of stock.' else '' end;
  for u in select id from public.profiles where active and role = 'approver' loop
    perform public.notify_user(u, 'weekly_digest', 'Your Monday petty cash note', v_body, '#/reports', null); v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- the pack is announced to the finance person of that branch
create or replace function public.pack_register(p_float uuid, p_path text, p_file_name text, p_size bigint, p_pages integer, p_summary jsonb) returns public.packs
language plpgsql security definer set search_path = public as $$
declare f public.floats%rowtype; p public.packs%rowtype; v_first boolean; v_b text;
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
    v_b := case when (select count(*) from public.branches where active) > 1 then public.branch_name(f.branch_id) || ' ' else '' end;
    perform public.notify_branch_role(f.branch_id, 'finance', 'pack_review', v_b || 'month-end pack ready to review: ' || to_char(f.period, 'Mon YYYY'),
      'Check the reconciliation and the receipts, then send it to the accountant.', '#/cash/pack/' || f.id, null);
    perform public.notify_branch_role(f.branch_id, 'approver', 'pack_review', v_b || 'month-end pack built: ' || to_char(f.period, 'Mon YYYY'),
      'Finance is reviewing it before it goes to the accountant.', '#/cash/pack/' || f.id, null);
  end if;
  return p;
end $$;

-- restock orders draw on the store of the branch the controller is acting in
create or replace function public.create_restock_request(p_purpose text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; it record; st record; v_target numeric; v_qty numeric; v_n int := 0; v_branch uuid := public.my_branch();
begin
  if not (public.has_role('stock_manager') or public.has_role('approver')) then raise exception 'Only the stock manager can raise restock orders'; end if;
  insert into public.requests (type, requester_id, purpose, for_store, branch_id)
  values ('stock', auth.uid(), coalesce(nullif(p_purpose, ''), 'Monthly restock – ' || to_char(now(), 'Mon YYYY')), true, v_branch)
  returning * into r;
  for it in select * from public.items where active and branch_id = v_branch and (recurring or (reorder_level > 0 and qty_on_hand < reorder_level)) order by name loop
    select * into st from public.item_usage_stats() s where s.item_id = it.id;
    if it.recurring then
      if st.avg_daily > 0 and st.since <= current_date - 14 then v_target := ceil(st.avg_daily * 30 * 1.15); else v_target := it.expected_monthly_qty; end if;
      v_qty := greatest(v_target - it.qty_on_hand, 0);
    else
      v_qty := greatest(it.reorder_level - it.qty_on_hand, 0);
    end if;
    if v_qty > 0 then
      v_n := v_n + 1;
      insert into public.request_lines (request_id, line_no, item_id, description, qty, est_unit_price)
      values (r.id, v_n, it.id, it.name, v_qty, coalesce(it.last_unit_price, 0));
    end if;
  end loop;
  return r;
end $$;

-- a new person starts in the branch the administrator chose (or the first branch)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_count int; v_role public.user_role; v_name text; v_inv public.invitations%rowtype; v_branch uuid;
begin
  select count(*) into v_count from public.profiles;
  v_name := coalesce(new.raw_user_meta_data->>'full_name', '');
  if v_count = 0 then
    v_role := 'approver';
  elsif coalesce((new.raw_app_meta_data->>'invited')::boolean, false) then
    v_role := coalesce((new.raw_app_meta_data->>'role')::public.user_role, 'requester');
  else
    select * into v_inv from public.invitations where lower(email) = lower(coalesce(new.email,'')) and accepted_at is null order by created_at desc limit 1;
    if v_inv.id is null then raise exception 'Sign-up is by invitation only. Ask your administrator to add you.'; end if;
    v_role := v_inv.role;
    if v_name = '' then v_name := v_inv.full_name; end if;
    update public.invitations set accepted_at = now() where id = v_inv.id;
  end if;
  v_branch := nullif(new.raw_app_meta_data->>'branch_id', '')::uuid;
  if v_branch is null or not exists (select 1 from public.branches where id = v_branch) then
    select id into v_branch from public.branches where active order by created_at limit 1;
  end if;
  insert into public.profiles (id, email, full_name, role, branch_id) values (new.id, coalesce(new.email,''), v_name, v_role, v_branch);
  return new;
end $$;

-- ---------- administration ----------
/** Add or change a branch. A second branch needs the one-branch rules dropped first (026b). */
create or replace function public.save_branch(p_id uuid, p_company uuid, p_name text, p_code text, p_usual_float numeric default null, p_active boolean default true, p_copy_catalogue_from uuid default null) returns public.branches
language plpgsql security definer set search_path = public as $$
declare b public.branches%rowtype; v_name text := btrim(coalesce(p_name, '')); v_code text := upper(btrim(coalesce(p_code, ''))); n int;
begin
  if public.my_role() is distinct from 'approver' then raise exception 'Only the administrator changes branches'; end if;
  if length(v_name) < 2 then raise exception 'Give the branch a name'; end if;
  if length(v_code) < 2 or length(v_code) > 6 then raise exception 'Give the branch a short code (2–6 letters), e.g. LUD'; end if;
  if p_id is null then
    if exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'floats' and indexdef ~ '\(period\)') then
      raise exception 'Before a second branch can be added, run db/026b_run_in_supabase.sql in Supabase (it removes the one-branch rules).';
    end if;
    insert into public.branches (company_id, name, code, usual_float, active)
    values (coalesce(p_company, (select id from public.companies where is_base limit 1)), v_name, v_code, p_usual_float, coalesce(p_active, true)) returning * into b;
    if p_copy_catalogue_from is not null then
      insert into public.items (name, sku, category_id, unit, pack_note, recurring, expected_monthly_qty, reorder_level, qty_on_hand, last_unit_price, preferred_supplier_id, active, branch_id)
      select name, sku, category_id, unit, pack_note, recurring, expected_monthly_qty, reorder_level, 0, last_unit_price, preferred_supplier_id, active, b.id
        from public.items where branch_id = p_copy_catalogue_from and active;
      get diagnostics n = row_count;
    end if;
  else
    update public.branches set name = v_name, code = v_code, usual_float = p_usual_float, active = coalesce(p_active, active) where id = p_id returning * into b;
    if b.id is null then raise exception 'Branch not found'; end if;
    if not b.active and exists (select 1 from public.floats where branch_id = b.id and status = 'open') then raise exception 'Close the open float before closing the branch'; end if;
  end if;
  return b;
end $$;
revoke execute on function public.save_branch(uuid, uuid, text, text, numeric, boolean, uuid) from public, anon;
grant execute on function public.save_branch(uuid, uuid, text, text, numeric, boolean, uuid) to authenticated;

/** A person's home branch and the other branches they cover. */
create or replace function public.set_person_branches(p_user uuid, p_home uuid, p_extra uuid[] default '{}') returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() is distinct from 'approver' then raise exception 'Only the administrator changes branches'; end if;
  if not exists (select 1 from public.branches where id = p_home and active) then raise exception 'Choose the home branch'; end if;
  update public.profiles
     set branch_id = p_home,
         extra_branches = coalesce((select array_agg(distinct x) from unnest(coalesce(p_extra, '{}')) x where x <> p_home and exists (select 1 from public.branches where id = x)), '{}'),
         view_branch = case when view_branch = any(array[p_home] || coalesce(p_extra, '{}')) then view_branch else null end
   where id = p_user;
end $$;
revoke execute on function public.set_person_branches(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.set_person_branches(uuid, uuid, uuid[]) to authenticated;

/** The branches a person may work in, with their company and currency – what the app loads at sign-in. */
create or replace function public.my_branch_list()
returns table(id uuid, name text, code text, company_id uuid, company text, currency text, currency_code char(3), usual_float numeric, active boolean, home boolean)
language sql stable security definer set search_path = public as $$
  select b.id, b.name, b.code, c.id, c.name, c.currency, c.currency_code, b.usual_float, b.active,
         b.id = (select branch_id from public.profiles where id = auth.uid())
  from public.branches b join public.companies c on c.id = b.company_id
  where b.id = any(public.my_branches()) and (b.active or b.id = (select branch_id from public.profiles where id = auth.uid()))
  order by c.name, b.name
$$;
grant execute on function public.my_branch_list() to authenticated;

-- the live screens follow branch changes too
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'branches') then
    alter publication supabase_realtime add table public.branches;
  end if;
end $$;
