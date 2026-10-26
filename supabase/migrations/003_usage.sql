-- Usage tracking: consumption, run-outs, days of cover, fast/slow movers
-- (003 depends on: alter type movement_kind add value 'usage'; stock_movements.occurred_on)

-- Stock consumed (used up, not handed to a named person)
create or replace function public.record_usage(p_item uuid, p_qty numeric, p_on date default current_date, p_note text default null) returns public.stock_movements
language plpgsql security definer set search_path = public as $$
declare m public.stock_movements%rowtype; v_onhand numeric;
begin
  if public.my_role() not in ('stock_manager','approver') then raise exception 'Only the stock manager can record usage'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be positive'; end if;
  if p_on > current_date then raise exception 'Usage cannot be in the future'; end if;
  select qty_on_hand into v_onhand from public.items where id = p_item for update;
  if v_onhand is null then raise exception 'Item not found'; end if;
  if v_onhand < p_qty then raise exception 'Only % on hand – do a quick count instead', v_onhand; end if;
  insert into public.stock_movements (item_id, kind, delta, created_by, note, occurred_on, created_at)
  values (p_item, 'usage', -p_qty, auth.uid(), nullif(p_note, ''), coalesce(p_on, current_date),
          case when p_on < current_date then (p_on + time '12:00')::timestamptz else now() end)
  returning * into m;
  return m;
end $$;

-- Quick count: [{item_id, counted}] – shortfall against the book is recorded as usage, surplus as a count correction
create or replace function public.quick_count(p_lines jsonb, p_on date default current_date, p_note text default null) returns int
language plpgsql security definer set search_path = public as $$
declare l jsonb; v_item uuid; v_counted numeric; v_onhand numeric; v_delta numeric; v_n int := 0; v_at timestamptz;
begin
  if public.my_role() not in ('stock_manager','approver') then raise exception 'Only the stock manager can count stock'; end if;
  if p_on > current_date then raise exception 'A count cannot be in the future'; end if;
  v_at := case when p_on < current_date then (p_on + time '12:00')::timestamptz else now() end;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_item := (l->>'item_id')::uuid;
    v_counted := (l->>'counted')::numeric;
    if v_counted is null or v_counted < 0 then continue; end if;
    select qty_on_hand into v_onhand from public.items where id = v_item for update;
    if v_onhand is null then continue; end if;
    v_delta := v_counted - v_onhand;
    if v_delta = 0 then continue; end if;
    insert into public.stock_movements (item_id, kind, delta, created_by, note, occurred_on, created_at)
    values (v_item, case when v_delta < 0 then 'usage' else 'count' end, v_delta, auth.uid(),
            coalesce(nullif(p_note, ''), case when v_delta < 0 then 'Used since last count' else 'Found more than recorded at count' end),
            coalesce(p_on, current_date), v_at);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- Per-item usage statistics. "pace" compares how long a typical month's order lasts:
--   fast = under 2 weeks, slow = over 4 months (or nothing used in 60 days), dormant = never used
create or replace function public.item_usage_stats() returns table (
  item_id uuid, used_30 numeric, used_90 numeric, since date, last_used date, avg_daily numeric,
  used_per_month numeric, typical_batch numeric, days_per_batch numeric, days_of_cover numeric, runout_date date, pace text)
language sql stable set search_path = public as $$
  with mv as (
    select item_id, occurred_on, delta, kind from public.stock_movements where not void
  ), agg as (
    select i.id as item_id, i.qty_on_hand, i.expected_monthly_qty,
      coalesce(sum(-mv.delta) filter (where mv.kind in ('usage','issue_out') and mv.occurred_on > current_date - 30), 0) as used_30,
      coalesce(sum(-mv.delta) filter (where mv.kind in ('usage','issue_out') and mv.occurred_on > current_date - 90), 0) as used_90,
      min(mv.occurred_on) as since,
      max(mv.occurred_on) filter (where mv.kind in ('usage','issue_out')) as last_used,
      avg(mv.delta) filter (where mv.kind = 'purchase_in' and mv.delta > 0) as avg_purchase
    from public.items i left join mv on mv.item_id = i.id
    group by i.id, i.qty_on_hand, i.expected_monthly_qty
  ), rates as (
    select *,
      -- rate over the last 90 days, or over the history if shorter (never under 14 days, so one count does not inflate it)
      case when since is null then 0 else used_90 / greatest(least(current_date - since, 90), 14) end as avg_daily,
      coalesce(nullif(expected_monthly_qty, 0), avg_purchase, nullif(qty_on_hand, 0)) as typical_batch
    from agg
  )
  select item_id, used_30, used_90, since, last_used,
    round(avg_daily::numeric, 3) as avg_daily,
    round((avg_daily * 30)::numeric, 1) as used_per_month,
    typical_batch,
    case when avg_daily > 0 and typical_batch > 0 then round((typical_batch / avg_daily)::numeric, 0) end as days_per_batch,
    case when avg_daily > 0 then round((qty_on_hand / avg_daily)::numeric, 0) end as days_of_cover,
    case when avg_daily > 0 then (current_date + floor(qty_on_hand / avg_daily)::int)::date end as runout_date,
    case
      when last_used is null then 'dormant'
      when avg_daily = 0 or last_used < current_date - 60 then 'slow'
      when typical_batch > 0 and typical_batch / avg_daily < 14 then 'fast'
      when typical_batch > 0 and typical_batch / avg_daily > 120 then 'slow'
      else 'normal'
    end as pace
  from rates
$$;

-- Days on which an item's balance reached zero
create or replace view public.v_item_runouts with (security_invoker = true) as
with ordered as (
  select item_id, occurred_on, created_at, delta,
         sum(delta) over (partition by item_id order by occurred_on, created_at rows unbounded preceding) as bal
  from public.stock_movements where not void
), marked as (
  select item_id, occurred_on, bal, lag(bal) over (partition by item_id order by occurred_on, created_at) as prev_bal from ordered
)
select item_id, occurred_on as ran_out_on, date_trunc('month', occurred_on)::date as month
from marked where bal <= 0 and coalesce(prev_bal, 1) > 0;

-- Usage and purchases per item per month
create or replace view public.v_item_monthly_usage with (security_invoker = true) as
select item_id, date_trunc('month', occurred_on)::date as month,
  coalesce(sum(-delta) filter (where kind in ('usage','issue_out')), 0) as used,
  coalesce(sum(delta) filter (where kind = 'purchase_in'), 0) as bought
from public.stock_movements where not void
group by item_id, date_trunc('month', occurred_on);

-- Restock order: quantities from measured usage where there is at least two weeks of history
create or replace function public.create_restock_request(p_purpose text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; it record; st record; v_target numeric; v_qty numeric; v_n int := 0;
begin
  if public.my_role() not in ('stock_manager','approver') then raise exception 'Only the stock manager can raise restock orders'; end if;
  insert into public.requests (type, requester_id, purpose, for_store)
  values ('stock', auth.uid(), coalesce(nullif(p_purpose, ''), 'Monthly restock – ' || to_char(now(), 'Mon YYYY')), true)
  returning * into r;
  for it in select * from public.items where active and (recurring or (reorder_level > 0 and qty_on_hand < reorder_level)) order by name loop
    select * into st from public.item_usage_stats() s where s.item_id = it.id;
    if it.recurring then
      if st.avg_daily > 0 and st.since <= current_date - 14 then
        v_target := ceil(st.avg_daily * 30 * 1.15);        -- a month at the measured rate, plus a 15% cushion
      else
        v_target := it.expected_monthly_qty;
      end if;
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

revoke execute on all functions in schema public from public, anon;
