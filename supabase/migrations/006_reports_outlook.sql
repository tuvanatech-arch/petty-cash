-- v3: team low-stock reports (requester -> stock manager) and the approver's petty-cash outlook.

-- ---------- settings ----------
alter table public.settings add column if not exists reserve_buffer_pct integer not null default 15;

-- ---------- low-stock reports ----------
create table if not exists public.stock_reports (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id),
  reported_by uuid not null references public.profiles(id),
  level text not null check (level in ('low', 'out')),
  note text,
  created_at timestamptz not null default now(),
  request_id uuid references public.requests(id),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id),
  resolution text
);
create index if not exists stock_reports_open_idx on public.stock_reports (item_id) where resolved_at is null;
alter table public.stock_reports enable row level security;
create policy stock_reports_select on public.stock_reports for select to authenticated using (true);
-- writes go through the functions below

create or replace function public.report_stock(p_item uuid, p_level text, p_note text default null) returns public.stock_reports
language plpgsql security definer set search_path = public as $$
declare it public.items%rowtype; rep public.stock_reports%rowtype; v_who text; v_open int;
begin
  select * into it from public.items where id = p_item and active;
  if it.id is null then raise exception 'Item not found'; end if;
  if p_level not in ('low', 'out') then raise exception 'Level must be low or out'; end if;
  select count(*) into v_open from public.stock_reports where item_id = p_item and resolved_at is null;
  insert into public.stock_reports (item_id, reported_by, level, note) values (p_item, auth.uid(), p_level, nullif(p_note, '')) returning * into rep;
  select full_name into v_who from public.profiles where id = auth.uid();
  perform public.notify_role('stock_manager', 'stock_report',
    case when p_level = 'out' then 'Run out: ' else 'Running low: ' end || it.name,
    'Reported by ' || v_who || case when v_open > 0 then ' (' || v_open + 1 || ' reports open)' else '' end
      || ' · ' || it.qty_on_hand || ' ' || it.unit || ' on the books' || case when p_note is not null and p_note <> '' then ' – ' || p_note else '' end,
    '#/stock/reports', null);
  return rep;
end $$;
revoke execute on function public.report_stock(uuid, text, text) from public, anon;

create or replace function public.resolve_report(p_report uuid, p_note text default null) returns public.stock_reports
language plpgsql security definer set search_path = public as $$
declare rep public.stock_reports%rowtype; it_name text;
begin
  if not (public.has_role('stock_manager') or public.has_role('approver')) then raise exception 'Only the stock manager can resolve reports'; end if;
  select * into rep from public.stock_reports where id = p_report for update;
  if rep.id is null then raise exception 'Report not found'; end if;
  if rep.resolved_at is not null then return rep; end if;
  update public.stock_reports set resolved_at = now(), resolved_by = auth.uid(), resolution = coalesce(nullif(p_note, ''), 'Sorted by the stock manager') where id = p_report returning * into rep;
  select name into it_name from public.items where id = rep.item_id;
  perform public.notify_user(rep.reported_by, 'stock_report_resolved', it_name || ': ' || rep.resolution, null, '#/stock', null);
  return rep;
end $$;
revoke execute on function public.resolve_report(uuid, text) from public, anon;

-- a purchase into the store closes the open reports for that item
create or replace function public.stock_reports_on_receipt() returns trigger
language plpgsql security definer set search_path = public as $$
declare rep record; it_name text;
begin
  if new.kind = 'purchase_in' and new.delta > 0 and not new.void then
    select name into it_name from public.items where id = new.item_id;
    for rep in update public.stock_reports set resolved_at = now(), resolved_by = new.created_by, resolution = 'Restocked'
               where item_id = new.item_id and resolved_at is null returning * loop
      perform public.notify_user(rep.reported_by, 'stock_report_resolved', it_name || ' has been restocked', null, '#/stock', null);
    end loop;
  end if;
  return new;
end $$;
create trigger stock_reports_on_receipt after insert on public.stock_movements for each row execute function public.stock_reports_on_receipt();

-- the stock manager turns reports into a purchase request (their draft restock order; created if needed)
create or replace function public.restock_from_reports(p_reports uuid[]) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; it record; st record; v_target numeric; v_qty numeric; v_n int; v_item uuid;
begin
  if not (public.has_role('stock_manager') or public.has_role('approver')) then raise exception 'Only the stock manager can raise restock orders'; end if;
  select * into r from public.requests where requester_id = auth.uid() and for_store and status = 'draft' order by created_at desc limit 1;
  if r.id is null then
    insert into public.requests (type, requester_id, purpose, for_store)
    values ('stock', auth.uid(), 'Restock – ' || to_char(now(), 'DD Mon'), true) returning * into r;
  end if;
  select coalesce(max(line_no), 0) into v_n from public.request_lines where request_id = r.id;
  for v_item in select distinct sr.item_id from public.stock_reports sr where sr.id = any(p_reports) and sr.resolved_at is null loop
    if exists (select 1 from public.request_lines where request_id = r.id and item_id = v_item) then continue; end if;
    select * into it from public.items where id = v_item;
    select * into st from public.item_usage_stats() s where s.item_id = v_item;
    if it.recurring and st.avg_daily > 0 and st.since <= current_date - 14 then v_target := ceil(st.avg_daily * 30 * 1.15);
    elsif it.recurring then v_target := it.expected_monthly_qty;
    else v_target := greatest(it.reorder_level, 1); end if;
    v_qty := greatest(v_target - it.qty_on_hand, 1);
    v_n := v_n + 1;
    insert into public.request_lines (request_id, line_no, item_id, description, qty, est_unit_price)
    values (r.id, v_n, it.id, it.name, v_qty, coalesce(it.last_unit_price, 0));
  end loop;
  update public.stock_reports set request_id = r.id where id = any(p_reports) and resolved_at is null;
  return r;
end $$;
revoke execute on function public.restock_from_reports(uuid[]) from public, anon;

-- ---------- petty-cash outlook for the approver ----------
-- What approving a request does to the float, and the minimum the float should hold at this point in the month,
-- from the last six months' spending pattern (how much usually gets spent between today's date and month-end).
create or replace function public.float_outlook(p_request uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  f record; v_has boolean; v_bal numeric := 0; v_alloc numeric; v_fid uuid; v_period date; v_out numeric := 0; v_spent numeric := 0; v_funds numeric := 0;
  today date := current_date; dim int; dleft int;
  v_this numeric := 0; v_awaiting numeric; v_pending numeric; v_after numeric;
  v_expected numeric; v_months int; v_typical numeric; v_reserve numeric; v_buffer numeric; v_basis text; v_status text;
begin
  if not (public.has_role('approver') or public.has_role('finance')) then raise exception 'Not allowed'; end if;
  select * into f from public.v_floats where status = 'open' order by period desc limit 1;
  v_has := found;
  if v_has then
    v_bal := coalesce(f.balance, 0); v_alloc := f.allocated; v_fid := f.id; v_period := f.period; v_out := coalesce(f.outstanding, 0); v_spent := coalesce(f.spent, 0);
    v_funds := coalesce(f.allocated, 0) + coalesce(f.topped_up, 0) + coalesce(f.carried_over, 0) - coalesce(f.returned, 0);
  end if;
  dim := extract(day from (date_trunc('month', today) + interval '1 month - 1 day'))::int;
  dleft := dim - extract(day from today)::int;
  select coalesce(reserve_buffer_pct, 15) / 100.0 into v_buffer from public.settings where id = 1;

  if p_request is not null then select coalesce(estimated_total, 0) into v_this from public.requests where id = p_request; end if;
  select coalesce(sum(estimated_total), 0) into v_awaiting from public.requests where status = 'awaiting_disbursement';
  select coalesce(sum(estimated_total), 0) into v_pending from public.requests where status = 'pending_approval' and (p_request is null or id <> p_request);

  -- months with any spend in the last six full months; for each, what was spent after today's day-of-month
  with months as (
    select distinct date_trunc('month', spent_at)::date as m from public.v_spend_lines
    where spent_at >= (date_trunc('month', today) - interval '6 months')::date and spent_at < date_trunc('month', today)::date
  ), after as (
    select m.m,
      coalesce((select sum(l.line_total) from public.v_spend_lines l where date_trunc('month', l.spent_at)::date = m.m and extract(day from l.spent_at) > extract(day from today)), 0) as rest,
      coalesce((select sum(l.line_total) from public.v_spend_lines l where date_trunc('month', l.spent_at)::date = m.m), 0) as total
    from months m
  )
  select round(avg(rest), 2), count(*), round(avg(total), 2) into v_expected, v_months, v_typical from after;

  if coalesce(v_months, 0) = 0 then
    -- nothing to go on yet: assume the float is spent evenly through the month
    v_expected := round(coalesce(v_alloc, (select default_monthly_float from public.settings where id = 1), 0) * dleft / dim, 2);
    v_typical := null; v_basis := 'no history yet – pro-rata of the float';
  else
    v_basis := v_months || ' month' || case when v_months = 1 then '' else 's' end || ' of spending';
  end if;
  v_reserve := round(v_expected * (1 + v_buffer), 2);
  v_after := v_bal - v_awaiting - v_this;
  v_status := case when not v_has then 'no_float'
                   when v_after < 0 then 'overdrawn'
                   when v_after < v_expected then 'short'
                   when v_after < v_reserve then 'caution'
                   else 'ok' end;
  return jsonb_build_object(
    'has_float', v_has, 'float_id', v_fid, 'period', v_period,
    'balance', v_bal, 'outstanding', v_out, 'spent', v_spent, 'funds', v_funds,
    'awaiting', v_awaiting, 'pending_other', v_pending, 'this_request', v_this,
    'after_approval', round(v_after, 2), 'after_all_pending', round(v_after - v_pending, 2),
    'days_left', dleft, 'days_in_month', dim,
    'expected_remaining', v_expected, 'reserve', v_reserve, 'buffer_pct', round(v_buffer * 100),
    'typical_month', v_typical, 'months', coalesce(v_months, 0), 'basis', v_basis,
    'status', v_status);
end $$;
revoke execute on function public.float_outlook(uuid) from public, anon;
