-- 019: a cash request for something the store keeps goes to the stock manager.
-- The app spots a cash request that names a catalogue item and sends it to the stock manager as an ask (item + how
-- many) instead of to finance; she hands it over from the store or buys it. A requester who says "it's not from the
-- store" can still send the cash request; the stock manager is told and can open it.
-- (The by-name path in ask_for_stock and the items.suggested_* columns are not used by the app at the moment.)

alter table public.items add column if not exists suggested_by uuid references public.profiles(id) on delete set null;
alter table public.items add column if not exists suggested_at timestamptz;
alter table public.stock_reports add column if not exists qty numeric;
alter table public.requests add column if not exists not_stock boolean not null default false;

-- ask for stock: a catalogue item, or something new by name; how many is optional
create or replace function public.ask_for_stock(p_item uuid default null, p_name text default null, p_qty numeric default null,
                                                p_level text default 'out', p_note text default null, p_category uuid default null)
returns public.stock_reports language plpgsql security definer set search_path = public as $$
declare it public.items%rowtype; rep public.stock_reports%rowtype; v_who text; v_open int; v_name text := btrim(coalesce(p_name, '')); v_cat uuid;
begin
  if public.my_role() is null then raise exception 'Sign in first'; end if;
  if coalesce(p_level, 'out') not in ('low', 'out') then raise exception 'Level must be low or out'; end if;
  if p_qty is not null and p_qty <= 0 then raise exception 'Enter how many, or leave it empty'; end if;
  if p_item is not null then
    select * into it from public.items where id = p_item;
    if it.id is null then raise exception 'Item not found'; end if;
  else
    if length(v_name) < 2 then raise exception 'Say what you need'; end if;
    select * into it from public.items where lower(name) = lower(v_name);
    if it.id is null then
      select id into v_cat from public.categories where id = p_category and kind <> 'cash';
      insert into public.items (name, unit, category_id, active, suggested_by, suggested_at)
      values (left(v_name, 80), 'each', v_cat, false, auth.uid(), now()) returning * into it;
    end if;
  end if;
  select count(*) into v_open from public.stock_reports where item_id = it.id and resolved_at is null;
  insert into public.stock_reports (item_id, reported_by, level, note, qty)
  values (it.id, auth.uid(), coalesce(p_level, 'out'), nullif(btrim(coalesce(p_note, '')), ''), p_qty) returning * into rep;
  select full_name into v_who from public.profiles where id = auth.uid();
  perform public.notify_role('stock_manager', 'stock_report',
    case when not it.active then 'Asked for (not in the catalogue): '
         when p_qty is not null then 'Needed from the store: '
         when rep.level = 'out' then 'Run out: ' else 'Running low: ' end || it.name,
    'From ' || v_who
      || case when p_qty is not null then ' · needs ' || trim_scale(p_qty)::text || ' ' || it.unit else '' end
      || case when v_open > 0 then ' (' || v_open + 1 || ' asks open)' else '' end
      || case when it.active then ' · ' || trim_scale(it.qty_on_hand)::text || ' ' || it.unit || ' on the books' else '' end
      || case when rep.note is not null then ' – ' || rep.note else '' end,
    '#/stock/reports', null);
  return rep;
end $$;
revoke execute on function public.ask_for_stock(uuid, text, numeric, text, text, uuid) from public, anon;
grant execute on function public.ask_for_stock(uuid, text, numeric, text, text, uuid) to authenticated;

-- restocking from asks: a suggested item joins the catalogue, and the quantity asked for is respected
create or replace function public.restock_from_reports(p_reports uuid[])
returns public.requests language plpgsql security definer set search_path = public as $$
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
    update public.items set active = true where id = v_item and not active and suggested_by is not null;
    select * into it from public.items where id = v_item;
    select * into st from public.item_usage_stats() s where s.item_id = v_item;
    if it.recurring and st.avg_daily > 0 and st.since <= current_date - 14 then v_target := ceil(st.avg_daily * 30 * 1.15);
    elsif it.recurring then v_target := it.expected_monthly_qty;
    else v_target := greatest(it.reorder_level, 1); end if;
    v_qty := greatest(v_target - it.qty_on_hand, 1,
                      coalesce((select max(sr.qty) from public.stock_reports sr where sr.id = any(p_reports) and sr.item_id = v_item), 0));
    v_n := v_n + 1;
    insert into public.request_lines (request_id, line_no, item_id, description, qty, est_unit_price)
    values (r.id, v_n, it.id, it.name, v_qty, coalesce(it.last_unit_price, 0));
  end loop;
  update public.stock_reports set request_id = r.id where id = any(p_reports) and resolved_at is null;
  return r;
end $$;

-- the stock manager can open a cash request the requester marked "not office stock"
create or replace function public.can_view_request(p_request uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.requests r
    where r.id = p_request and (
      r.requester_id = auth.uid()
      or r.disbursed_to = auth.uid()
      or public.has_role('finance') or public.has_role('approver')
      or (public.has_role('stock_manager') and (r.type = 'stock' or r.not_stock))
    )
  )
$$;
alter policy requests_select on public.requests using (
  requester_id = auth.uid() or disbursed_to = auth.uid() or has_role('finance'::user_role) or has_role('approver'::user_role)
  or (has_role('stock_manager'::user_role) and (type = 'stock'::request_type or not_stock)));

-- …and is told when one is sent
create or replace function public.requests_not_stock_notice() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'draft' and new.status <> 'draft' and new.not_stock then
    perform public.notify_role('stock_manager', 'stock_report', 'Sent as cash, not stock: #' || new.request_no || ' ' || new.purpose,
      coalesce((select full_name from public.profiles where id = new.requester_id), 'Someone') || ' said this is not office stock ('
        || public.money_text(new.estimated_total) || '). Open it and add a note if it should come from the store.',
      '#/requests/' || new.id, new.id);
  end if;
  return new;
end $$;
create trigger requests_not_stock_notice after update of status on public.requests for each row execute function public.requests_not_stock_notice();
