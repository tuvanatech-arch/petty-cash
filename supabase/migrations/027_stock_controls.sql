-- 027: office consumables controls (Phase 4). Stock records become checkable: what was bought, what arrived, what was
-- handed out and what went missing are four separate numbers.
--   • Two tracking modes per item: "issued" items (toner, paper, memory sticks – worth more than N$100 each by default)
--     are recorded at each hand-out, so a count difference is a real variance; "counted" items (tea, sugar) are counted,
--     and the count measures use, as before.
--   • Deliveries: goods bought for the store are confirmed by the controller; a shortfall is flagged to the GM and finance.
--     When the controller bought them and the value is above the limit, someone else confirms.
--   • Variances and corrections: a difference on an issued item, or any manual correction, worth up to the schedule's
--     stock adjustment limit (N$200) is applied and logged; above it the GM approves before the balance changes.
--   • Unusual use: an item used well above its normal monthly rate alerts the controller.
--   • Duplicate buying: open orders per item, so a review warns when enough is on hand or already on order.

/* ---------- the schedule: the stock adjustment limit ---------- */
alter table public.settings add column if not exists stock_adjust_limit numeric(12,2) not null default 200;
alter table public.items add column if not exists tracking text not null default 'counted' check (tracking in ('issued', 'counted'));
update public.items set tracking = 'issued' where coalesce(last_unit_price, 0) > 100;

create or replace function public.schedule_keys() returns table (k text, label text, md boolean, kind text, ord int)
language sql immutable as $$
  values
    ('approval_threshold',     'Finance pays alone up to',                         true,  'money',   1),
    ('gm_limit',               'General Manager approves up to',                   true,  'money',   2),
    ('split_window_days',      'Requests counted together over',                   true,  'days',    3),
    ('change_tolerance_pct',   'Pay-out tolerance',                                true,  'pct',     4),
    ('claims_need_approval',   'Every claim needs approval',                       true,  'bool',    5),
    ('budget_mode',            'When a request goes over its budget',              true,  'mode',    6),
    ('block_with_outstanding', 'Hold new pay-outs to someone who owes a receipt',  true,  'bool',    7),
    ('default_monthly_float',  'Usual monthly float',                              true,  'money',   8),
    ('float_rollover',         'Unspent balance carries into the next month',      true,  'bool',    9),
    ('cash_variance_limit',    'Cash difference allowed at a count',               true,  'money',  10),
    ('stock_adjust_limit',     'Stock correction the controller may make alone',   true,  'money',  11),
    ('advance_grace_days',     'Receipt reminder after',                           false, 'days',   12),
    ('advance_escalate_days',  'Overdue: GM and finance told after',               false, 'days',   13),
    ('cash_count_days',        'Cash count reminder',                              false, 'every',  14),
    ('count_day',              'Weekly stock count reminder',                      false, 'weekday',15),
    ('reserve_buffer_pct',     'Safety buffer on the float minimum',               false, 'pct',    16),
    ('schedule_ref',           'Schedule reference',                               false, 'text',   17),
    ('policy_ref',             'Policy reference',                                 false, 'text',   18),
    ('policy_url',             'Link to the policy',                               false, 'text',   19)
$$;

create or replace function public.schedule_write(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r public.settings%rowtype;
begin
  select * into r from jsonb_populate_record((select s from public.settings s where s.id = 1), p);
  perform set_config('pcs.schedule', 'on', true);
  update public.settings set
    approval_threshold = r.approval_threshold, gm_limit = r.gm_limit, split_window_days = r.split_window_days,
    change_tolerance_pct = r.change_tolerance_pct, claims_need_approval = r.claims_need_approval, budget_mode = r.budget_mode,
    block_with_outstanding = r.block_with_outstanding, default_monthly_float = r.default_monthly_float, float_rollover = r.float_rollover,
    cash_variance_limit = r.cash_variance_limit, cash_count_days = r.cash_count_days, stock_adjust_limit = r.stock_adjust_limit,
    advance_grace_days = r.advance_grace_days, advance_escalate_days = r.advance_escalate_days, count_day = r.count_day,
    reserve_buffer_pct = r.reserve_buffer_pct, schedule_ref = r.schedule_ref, policy_ref = r.policy_ref, policy_url = r.policy_url,
    updated_at = now()
   where id = 1;
  perform set_config('pcs.schedule', 'off', true);
end $$;

create or replace function public.settings_schedule_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('pcs.schedule', true), '') <> 'on' and (
       (new.approval_threshold, new.gm_limit, new.split_window_days, new.change_tolerance_pct, new.claims_need_approval, new.budget_mode,
        new.block_with_outstanding, new.default_monthly_float, new.float_rollover, new.cash_variance_limit, new.cash_count_days, new.stock_adjust_limit,
        new.advance_grace_days, new.advance_escalate_days, new.count_day, new.reserve_buffer_pct, new.schedule_ref, new.policy_ref, new.policy_url)
       is distinct from
       (old.approval_threshold, old.gm_limit, old.split_window_days, old.change_tolerance_pct, old.claims_need_approval, old.budget_mode,
        old.block_with_outstanding, old.default_monthly_float, old.float_rollover, old.cash_variance_limit, old.cash_count_days, old.stock_adjust_limit,
        old.advance_grace_days, old.advance_escalate_days, old.count_day, old.reserve_buffer_pct, old.schedule_ref, old.policy_ref, old.policy_url)) then
    raise exception 'Limits, the float, reminders and the policy are changed on the Schedule screen, so every change is versioned';
  end if;
  return new;
end $$;

/* ---------- deliveries: what was bought against what arrived ---------- */
create table if not exists public.stock_receipts (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id),
  request_id uuid references public.requests(id) on delete set null,
  expense_id uuid references public.expenses(id) on delete set null,
  movement_id uuid references public.stock_movements(id) on delete set null,
  qty_bought numeric(12,2) not null,
  unit_cost numeric(12,2),
  bought_by uuid references public.profiles(id),
  qty_received numeric(12,2),
  status text not null default 'to_check' check (status in ('to_check', 'checked', 'short', 'void')),
  checked_by uuid references public.profiles(id),
  checked_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists stock_receipts_item_idx on public.stock_receipts (item_id, created_at desc);
create index if not exists stock_receipts_status_idx on public.stock_receipts (status);
alter table public.stock_receipts enable row level security;
create policy stock_receipts_select on public.stock_receipts for select to authenticated
  using (public.is_staff() and exists (select 1 from public.items i where i.id = item_id and i.branch_id = any(public.my_branches())));

/* ---------- variances and corrections ---------- */
create table if not exists public.stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id),
  kind text not null check (kind in ('count', 'correction', 'delivery')),   -- a count difference, a manual correction, or a short delivery
  qty_before numeric(12,2) not null,
  qty_after numeric(12,2) not null,
  delta numeric(12,2) not null,
  unit_cost numeric(12,2),
  value numeric(12,2) not null default 0,              -- |delta| × the item's last price
  limit_at numeric(12,2) not null default 0,           -- the schedule's limit when it was raised
  reason text,
  status text not null default 'applied' check (status in ('applied', 'to_approve', 'approved', 'rejected')),
  requested_by uuid references public.profiles(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  decision_note text,
  movement_id uuid references public.stock_movements(id) on delete set null,
  receipt_id uuid references public.stock_receipts(id) on delete set null
);
create index if not exists stock_adjustments_item_idx on public.stock_adjustments (item_id, requested_at desc);
create index if not exists stock_adjustments_status_idx on public.stock_adjustments (status);
alter table public.stock_adjustments enable row level security;
create policy stock_adjustments_select on public.stock_adjustments for select to authenticated
  using (public.is_staff() and exists (select 1 from public.items i where i.id = item_id and i.branch_id = any(public.my_branches())));

create or replace function public.qty_text(q numeric) returns text language sql immutable as $$ select trim_scale(coalesce(q, 0))::text $$;

/** Raise a change to an item's balance. Within the limit it is applied at once and logged; above it the GM approves first. */
create or replace function public.stock_adjust_raise(p_item uuid, p_new_qty numeric, p_kind text, p_reason text, p_receipt uuid default null, p_on date default null, p_force boolean default false)
returns public.stock_adjustments language plpgsql security definer set search_path = public as $$
declare it public.items%rowtype; s public.settings%rowtype; a public.stock_adjustments%rowtype; m public.stock_movements%rowtype; v_delta numeric; v_value numeric; v_name text;
begin
  select * into it from public.items where id = p_item for update;
  if it.id is null then raise exception 'Item not found'; end if;
  if not (it.branch_id = any(public.my_branches())) then raise exception 'That item is in another branch''s store'; end if;
  if p_new_qty is null or p_new_qty < 0 then raise exception 'The quantity cannot be negative'; end if;
  select * into s from public.settings where id = 1;
  v_delta := round(p_new_qty - it.qty_on_hand, 2);
  if v_delta = 0 then return null; end if;
  v_value := round(abs(v_delta) * coalesce(it.last_unit_price, 0), 2);
  insert into public.stock_adjustments (item_id, kind, qty_before, qty_after, delta, unit_cost, value, limit_at, reason, status, requested_by, receipt_id)
  values (p_item, p_kind, it.qty_on_hand, p_new_qty, v_delta, it.last_unit_price, v_value, coalesce(s.stock_adjust_limit, 0), nullif(btrim(coalesce(p_reason, '')), ''),
          case when v_value > coalesce(s.stock_adjust_limit, 0) and not public.has_role('approver') and not p_force then 'to_approve' else 'applied' end, auth.uid(), p_receipt)
  returning * into a;
  if a.status = 'applied' then
    insert into public.stock_movements (item_id, kind, delta, created_by, note, occurred_on)
    values (p_item, 'adjustment', v_delta, auth.uid(),
            case p_kind when 'count' then 'Count difference' when 'delivery' then 'Short delivery' else 'Correction' end || coalesce(': ' || a.reason, ''), coalesce(p_on, current_date))
    returning * into m;
    update public.stock_adjustments set movement_id = m.id where id = a.id returning * into a;
  else
    perform public.notify_branch_role(it.branch_id, 'approver', 'stock_adjust', 'Stock correction to approve: ' || it.name,
      format('%s %s → %s (%s worth %s) – %s. Above the %s limit, so the balance waits for your approval.', public.qty_text(it.qty_on_hand), it.unit, public.qty_text(p_new_qty),
             case when v_delta < 0 then public.qty_text(-v_delta) || ' missing' else public.qty_text(v_delta) || ' extra' end, public.money_text(v_value), coalesce(a.reason, 'no reason given'), public.money_text(s.stock_adjust_limit)),
      '#/stock/adjustments', null);
  end if;
  return a;
end $$;
revoke execute on function public.stock_adjust_raise(uuid, numeric, text, text, uuid, date, boolean) from public, anon, authenticated;


/** The GM approves or turns down a correction above the limit. */
create or replace function public.decide_stock_adjustment(p_id uuid, p_approve boolean, p_note text default null)
returns public.stock_adjustments language plpgsql security definer set search_path = public as $$
declare a public.stock_adjustments%rowtype; it public.items%rowtype; m public.stock_movements%rowtype; v_delta numeric; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.has_role('approver') then raise exception 'Stock corrections above the limit are approved by the General Manager'; end if;
  select * into a from public.stock_adjustments where id = p_id for update;
  if a.id is null then raise exception 'Not found'; end if;
  if a.status <> 'to_approve' then raise exception 'This correction has already been decided'; end if;
  if a.requested_by = auth.uid() then raise exception 'Someone else must approve your own correction'; end if;
  if not p_approve and v_note is null then raise exception 'Say why it is turned down'; end if;
  select * into it from public.items where id = a.item_id for update;
  if p_approve then
    -- the balance may have moved since the count: apply the counted difference, not the counted total
    v_delta := a.delta;
    insert into public.stock_movements (item_id, kind, delta, created_by, note, occurred_on)
    values (a.item_id, 'adjustment', v_delta, auth.uid(), case a.kind when 'count' then 'Count difference' when 'delivery' then 'Short delivery' else 'Correction' end || coalesce(': ' || a.reason, '') || ' – approved by ' || (select full_name from public.profiles where id = auth.uid()), current_date)
    returning * into m;
    update public.stock_adjustments set status = 'approved', decided_by = auth.uid(), decided_at = now(), decision_note = v_note, movement_id = m.id where id = p_id returning * into a;
  else
    update public.stock_adjustments set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = v_note where id = p_id returning * into a;
  end if;
  perform public.notify_user(a.requested_by, 'stock_adjust', (case when p_approve then 'Correction approved: ' else 'Correction turned down: ' end) || it.name,
    format('%s %s → %s%s', public.qty_text(a.qty_before), it.unit, public.qty_text(a.qty_after), coalesce(' – “' || v_note || '”', '')) || case when p_approve then '. The balance has been changed.' else '. The balance is unchanged; count it again or talk to the GM.' end,
    '#/stock/adjustments', null);
  return a;
end $$;
revoke execute on function public.decide_stock_adjustment(uuid, boolean, text) from public, anon;
grant execute on function public.decide_stock_adjustment(uuid, boolean, text) to authenticated;

/** A manual correction with a reason: within the limit it applies; above it the GM approves first. */
create or replace function public.adjust_stock(p_item uuid, p_new_qty numeric, p_note text) returns public.stock_movements
language plpgsql security definer set search_path = public as $$
declare a public.stock_adjustments%rowtype; m public.stock_movements%rowtype;
begin
  if not (public.has_role('stock_manager') or public.has_role('approver')) then raise exception 'Only the stock manager can adjust stock'; end if;
  if p_new_qty is null or p_new_qty < 0 then raise exception 'Counted quantity cannot be negative'; end if;
  if coalesce(btrim(p_note), '') = '' then raise exception 'Give a reason for the adjustment'; end if;
  a := public.stock_adjust_raise(p_item, p_new_qty, 'correction', p_note);
  if a.id is null then raise exception 'That is already the quantity on hand'; end if;
  if a.status = 'to_approve' then return null; end if;   -- waiting for the GM: the screen says so
  select * into m from public.stock_movements where id = a.movement_id;
  return m;
end $$;

/** The quick count: counted items' differences are use; issued items' differences are variances (applied within the limit, else to the GM). */
create or replace function public.quick_count(p_lines jsonb, p_on date default current_date, p_note text default null) returns integer
language plpgsql security definer set search_path = public as $$
declare l jsonb; v_item uuid; v_counted numeric; it public.items%rowtype; v_delta numeric; v_n int := 0; v_at timestamptz; a public.stock_adjustments%rowtype; v_wait int := 0;
begin
  if not (public.has_role('stock_manager') or public.has_role('approver')) then raise exception 'Only the stock manager can count stock'; end if;
  if p_on > current_date then raise exception 'A count cannot be in the future'; end if;
  v_at := case when p_on < current_date then (p_on + time '12:00')::timestamptz else now() end;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_item := (l->>'item_id')::uuid;
    v_counted := (l->>'counted')::numeric;
    if v_counted is null or v_counted < 0 then continue; end if;
    select * into it from public.items where id = v_item for update;
    if it.id is null or not (it.branch_id = any(public.my_branches())) then continue; end if;
    v_delta := v_counted - it.qty_on_hand;
    if v_delta = 0 then continue; end if;
    if it.tracking = 'issued' then
      a := public.stock_adjust_raise(v_item, v_counted, 'count', coalesce(nullif(p_note, ''), l->>'note'), null, p_on);
      if a.status = 'to_approve' then v_wait := v_wait + 1; end if;
    else
      insert into public.stock_movements (item_id, kind, delta, created_by, note, occurred_on, created_at)
      values (v_item, (case when v_delta < 0 then 'usage' else 'count' end)::public.movement_kind, v_delta, auth.uid(),
              coalesce(nullif(p_note, ''), case when v_delta < 0 then 'Used since last count' else 'Found more than recorded at count' end),
              coalesce(p_on, current_date), v_at);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n + v_wait * 1000;   -- the screen reads: n = changes recorded, thousands = waiting for the GM
end $$;

/** The controller confirms a delivery. A shortfall becomes a stock correction and the GM and finance are told. */
create or replace function public.confirm_stock_receipt(p_id uuid, p_received numeric, p_note text default null) returns public.stock_receipts
language plpgsql security definer set search_path = public as $$
declare r public.stock_receipts%rowtype; it public.items%rowtype; s public.settings%rowtype; q public.requests%rowtype; v_short numeric; a public.stock_adjustments%rowtype; v_val numeric; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not (public.has_role('stock_manager') or public.has_role('approver') or public.has_role('finance')) then raise exception 'Deliveries are checked by the stock controller'; end if;
  select * into r from public.stock_receipts where id = p_id for update;
  if r.id is null then raise exception 'Not found'; end if;
  if r.status <> 'to_check' then raise exception 'This delivery has already been checked'; end if;
  if p_received is null or p_received < 0 then raise exception 'Enter how many arrived'; end if;
  if p_received > r.qty_bought then raise exception 'More arrived than was bought? Record the extra as a correction with a reason.'; end if;
  select * into it from public.items where id = r.item_id;
  select * into s from public.settings where id = 1;
  select * into q from public.requests where id = r.request_id;
  v_val := round(r.qty_bought * coalesce(r.unit_cost, it.last_unit_price, 0), 2);
  -- the person who bought it does not also sign it in, above the limit
  if (r.bought_by = auth.uid() or q.disbursed_to = auth.uid() or q.requester_id = auth.uid()) and v_val > coalesce(s.stock_adjust_limit, 0) then
    raise exception 'You bought this (%). Above %, someone else – the GM or finance – confirms what arrived.', public.money_text(v_val), public.money_text(s.stock_adjust_limit);
  end if;
  v_short := round(r.qty_bought - p_received, 2);
  if v_short > 0 and v_note is null then raise exception 'Say what happened to the % missing', public.qty_text(v_short); end if;
  update public.stock_receipts set qty_received = p_received, status = case when v_short > 0 then 'short' else 'checked' end, checked_by = auth.uid(), checked_at = now(), note = v_note
   where id = p_id returning * into r;
  if v_short > 0 then
    -- the shelf holds what arrived: the purchase was posted in full, so the shortfall comes off (within the limit at once, else once the GM approves)
    a := public.stock_adjust_raise(r.item_id, greatest(it.qty_on_hand - v_short, 0), 'delivery', format('%s of %s arrived on %s%s', public.qty_text(p_received), public.qty_text(r.qty_bought), case when q.id is null then 'a purchase' else public.req_label(q) end, coalesce(' – ' || v_note, '')), r.id, null,
                                     public.has_role('approver') or public.has_role('finance'));   -- confirmed by someone independent: applied at once
    perform public.notify_branch_role(it.branch_id, 'approver', 'stock_receipt', 'Short delivery: ' || it.name,
      format('%s of %s bought on %s arrived (%s worth %s). %s', public.qty_text(p_received), public.qty_text(r.qty_bought), case when q.id is null then 'a purchase' else public.req_label(q) end, public.qty_text(v_short), public.money_text(round(v_short * coalesce(r.unit_cost, it.last_unit_price, 0), 2)), coalesce('“' || v_note || '”', '')),
      '#/stock/deliveries', r.request_id);
    perform public.notify_branch_role(it.branch_id, 'finance', 'stock_receipt', 'Short delivery: ' || it.name,
      format('%s of %s bought on %s arrived. Petty cash paid for %s that did not reach the store.', public.qty_text(p_received), public.qty_text(r.qty_bought), case when q.id is null then 'a purchase' else public.req_label(q) end, public.qty_text(v_short)),
      '#/stock/deliveries', r.request_id);
  end if;
  return r;
end $$;
revoke execute on function public.confirm_stock_receipt(uuid, numeric, text) from public, anon;
grant execute on function public.confirm_stock_receipt(uuid, numeric, text) to authenticated;

/* ---------- open orders per item: enough on hand, or already on order ---------- */
create or replace function public.item_open_orders() returns table (item_id uuid, on_order numeric, request_nos int[], request_ids uuid[])
language sql stable security definer set search_path = public as $$
  select rl.item_id, sum(coalesce(nullif(rl.qty_to_buy, 0), rl.qty)) as on_order, array_agg(distinct r.request_no), array_agg(distinct r.id)
  from public.request_lines rl join public.requests r on r.id = rl.request_id
  where r.type = 'stock' and r.status in ('stock_review', 'pending_approval', 'awaiting_disbursement', 'disbursed') and rl.item_id is not null
    and r.branch_id = any(public.my_branches())
  group by rl.item_id
$$;
revoke execute on function public.item_open_orders() from public, anon;
grant execute on function public.item_open_orders() to authenticated;

/* ---------- unusual use: well above the item's normal monthly rate ---------- */
create or replace function public.remind_unusual_use() returns integer
language plpgsql security definer set search_path = public as $$
declare it record; n int := 0; v_norm numeric; v_used numeric;
begin
  if auth.uid() is not null and not public.has_role('approver') then raise exception 'Not allowed'; end if;
  for it in
    select i.id, i.name, i.unit, i.branch_id, i.expected_monthly_qty,
      coalesce(sum(-m.delta) filter (where m.kind in ('usage', 'issue_out') and m.occurred_on > current_date - 30), 0) as used_30,
      coalesce(sum(-m.delta) filter (where m.kind in ('usage', 'issue_out') and m.occurred_on > current_date - 120 and m.occurred_on <= current_date - 30), 0) / 3 as prev_month_avg
    from public.items i left join public.stock_movements m on m.item_id = i.id and not m.void
    where i.active group by i.id
  loop
    v_norm := coalesce(nullif(it.expected_monthly_qty, 0), nullif(it.prev_month_avg, 0));
    v_used := it.used_30;
    if v_norm is null or v_used < 3 or v_used <= v_norm * 1.5 then continue; end if;
    if exists (select 1 from public.notifications where kind = 'stock_use' and created_at > now() - interval '30 days' and title like '%' || it.name || '%') then continue; end if;
    perform public.notify_branch_role(it.branch_id, 'stock_manager', 'stock_use', 'Unusual use: ' || it.name,
      format('%s %s used in the last 30 days against a normal %s a month. Worth a look at who is taking it.', public.qty_text(v_used), it.unit, public.qty_text(round(v_norm, 1))), '#/stock/usage', null);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.remind_unusual_use() from public, anon, authenticated;
select cron.schedule('petty-stock-use', '40 6 * * *', 'select public.remind_unusual_use()');

/* ---------- what waits for whom (the badge and Home) ---------- */
create or replace function public.stock_actions() returns jsonb
language sql stable security definer set search_path = public as $$
  with v as (select view_branch as b from public.profiles where id = auth.uid()),
  mine as (select i.id from public.items i, v where i.branch_id = any(public.my_branches()) and (v.b is null or i.branch_id = v.b))
  select jsonb_build_object(
    'receipts_to_check', case when public.has_role('stock_manager') or public.has_role('approver') then (select count(*) from public.stock_receipts r where r.status = 'to_check' and r.item_id in (select id from mine)) else 0 end,
    'adjustments_to_approve', case when public.has_role('approver') then (select count(*) from public.stock_adjustments a where a.status = 'to_approve' and a.requested_by <> auth.uid() and a.item_id in (select id from mine)) else 0 end)
$$;
revoke execute on function public.stock_actions() from public, anon;
grant execute on function public.stock_actions() to authenticated;

/* ---------- alerts open the right screen ---------- */
create or replace function public.notification_link(p_kind text, p_request uuid) returns text
language sql immutable set search_path = public as $$
  select case
    when p_kind in ('stock_receipt') then '#/stock/deliveries'
    when p_kind in ('stock_adjust') then '#/stock/adjustments'
    when p_request is not null then '#/requests/' || p_request
    when p_kind in ('cash_count', 'cash_count_due', 'top_up', 'float_warning', 'month_close', 'pack_review', 'pack_sent') then '#/cash'
    when p_kind = 'schedule' then '#/schedule'
    when p_kind in ('stock_report', 'stock_report_resolved', 'weekly_count', 'price_jump', 'stock_use') then '#/stock'
    when p_kind = 'weekly_digest' then '#/reports'
    when p_kind = 'security' then '#/account?devices=1'
    when p_kind = 'account_ready' then '#/admin'
    else '#/home'
  end
$$;

/* ---------- live screens follow these too ---------- */
do $$ declare t text; begin
  foreach t in array array['stock_receipts', 'stock_adjustments', 'items', 'stock_movements'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

/* ---------- purchases for the store enter as deliveries to check ---------- */
create or replace function public.record_expense(p_request uuid, p_spent_at date, p_lines jsonb, p_notes text default null) returns public.expenses
language plpgsql security definer set search_path = public as $$
declare
  r public.requests%rowtype; e public.expenses%rowtype; l jsonb; m public.stock_movements%rowtype;
  v_item uuid; v_desc text; v_qty numeric; v_price numeric; v_sup uuid; v_supname text; v_total numeric := 0;
  v_issue numeric; rec record; v_last numeric; v_name text; v_pct int; v_tol numeric; v_why text; v_rcpt int := 0;
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status <> 'disbursed' then raise exception 'An expense can only be recorded while the request is in the "disbursed" stage'; end if;
  if auth.uid() <> r.disbursed_to and not (public.has_role('finance') or public.has_role('approver')) then
    raise exception 'Only the person who received the cash can record this expense';
  end if;
  select * into e from public.expenses where request_id = p_request;
  if e.id is null then
    insert into public.expenses (request_id, spent_by, spent_at, total) values (p_request, auth.uid(), p_spent_at, 0) returning * into e;
  end if;
  if not exists (select 1 from public.expense_proofs where expense_id = e.id) then
    raise exception 'Upload a scanned copy of the receipt before submitting the expense';
  end if;

  for m in select * from public.stock_movements where expense_id = e.id and not void loop
    insert into public.stock_movements (item_id, kind, delta, request_id, expense_id, created_by, note, void)
    values (m.item_id, 'reversal', -m.delta, p_request, e.id, auth.uid(), 'Reversed: expense re-recorded', true);
    update public.stock_movements set void = true where id = m.id;
  end loop;
  update public.expense_lines set void = true where expense_id = e.id and not void;
  update public.stock_receipts set status = 'void' where expense_id = e.id and status <> 'void';

  for l in select * from jsonb_array_elements(p_lines) loop
    v_item    := public.try_uuid(l->>'item_id');
    v_desc    := coalesce(l->>'description', '');
    v_qty     := (l->>'qty')::numeric;
    v_price   := (l->>'unit_price')::numeric;
    v_sup     := public.try_uuid(l->>'supplier_id');
    v_supname := nullif(l->>'supplier_name', '');
    if v_qty is null or v_qty <= 0 or v_price is null or v_price < 0 then raise exception 'Each line needs a quantity and a unit price'; end if;
    if v_item is not null and v_desc = '' then select name into v_desc from public.items where id = v_item; end if;
    if v_sup is not null and v_supname is null then select name into v_supname from public.suppliers where id = v_sup; end if;
    if v_desc = '' then raise exception 'Each line needs a description'; end if;
    insert into public.expense_lines (expense_id, item_id, description, qty, unit_price, supplier_id, supplier_name)
    values (e.id, v_item, v_desc, v_qty, v_price, v_sup, v_supname);
    v_total := v_total + round(v_qty * v_price, 2);
    if v_item is not null and r.type = 'stock' then
      insert into public.stock_movements (item_id, kind, delta, unit_cost, request_id, expense_id, supplier_id, created_by, note, occurred_on)
      values (v_item, 'purchase_in', v_qty, v_price, p_request, e.id, v_sup, auth.uid(), 'Bought on request #' || r.request_no, coalesce(p_spent_at, current_date))
      returning * into m;
      -- goods for the store are checked in by the controller: what was bought against what arrived
      if r.for_store then
        insert into public.stock_receipts (item_id, request_id, expense_id, movement_id, qty_bought, unit_cost, bought_by)
        values (v_item, p_request, e.id, m.id, v_qty, v_price, auth.uid());
        v_rcpt := v_rcpt + 1;
      end if;
      select last_unit_price, name into v_last, v_name from public.items where id = v_item;
      if v_last > 0 and v_price > v_last * 1.10 then
        v_pct := round((v_price / v_last - 1) * 100);
        perform public.notify_role('stock_manager', 'price_jump', 'Price up ' || v_pct || '%: ' || v_name,
          public.money_text(v_last) || ' → ' || public.money_text(v_price) || coalesce(' at ' || v_supname, '') || ' on ' || public.req_label(r), '#/stock/usage', p_request);
        perform public.notify_role('approver', 'price_jump', 'Price up ' || v_pct || '%: ' || v_name,
          public.money_text(v_last) || ' → ' || public.money_text(v_price) || coalesce(' at ' || v_supname, '') || ' on ' || public.req_label(r), '#/stock/usage', p_request);
      end if;
      update public.items set last_unit_price = v_price, preferred_supplier_id = coalesce(v_sup, preferred_supplier_id) where id = v_item;
    end if;
  end loop;
  if v_total <= 0 then raise exception 'Add at least one line with an amount'; end if;
  if v_rcpt > 0 then
    perform public.notify_branch_role(r.branch_id, 'stock_manager', 'stock_receipt', 'Delivery to check: ' || public.req_label(r),
      v_rcpt || ' item' || case when v_rcpt = 1 then '' else 's' end || ' bought for the store. Confirm what actually arrived under Stock → Deliveries.', '#/stock/deliveries', p_request);
    -- the controller bought it: above the limit someone else signs the goods in
    if public.has_role('stock_manager') and v_total > (select coalesce(stock_adjust_limit, 0) from public.settings where id = 1) then
      perform public.notify_branch_role(r.branch_id, 'approver', 'stock_receipt', 'Delivery to confirm: ' || public.req_label(r),
        'The stock controller bought ' || public.money_text(v_total) || ' of store items. Above the limit, you or finance confirm what arrived under Stock → Deliveries.', '#/stock/deliveries', p_request);
      perform public.notify_branch_role(r.branch_id, 'finance', 'stock_receipt', 'Delivery to confirm: ' || public.req_label(r),
        'The stock controller bought ' || public.money_text(v_total) || ' of store items. Above the limit, you or the GM confirm what arrived under Stock → Deliveries.', '#/stock/deliveries', p_request);
    end if;
  end if;

  if r.type = 'stock' and not r.for_store then
    for rec in
      select rl.item_id, sum(rl.qty_to_buy) as to_buy,
             (select coalesce(sum(el.qty), 0) from public.expense_lines el where el.expense_id = e.id and el.item_id = rl.item_id and not el.void) as bought
        from public.request_lines rl where rl.request_id = p_request and rl.item_id is not null and rl.qty_to_buy > 0
       group by rl.item_id
    loop
      v_issue := least(rec.to_buy, rec.bought);
      if v_issue > 0 then
        insert into public.stock_movements (item_id, kind, delta, request_id, expense_id, issued_to, created_by, note, occurred_on)
        values (rec.item_id, 'issue_out', -v_issue, p_request, e.id, r.requester_id, auth.uid(), 'Issued to requester on request #' || r.request_no, coalesce(p_spent_at, current_date));
      end if;
    end loop;
  end if;

  update public.expenses
     set spent_by = auth.uid(), spent_at = coalesce(p_spent_at, current_date), notes = nullif(p_notes, ''),
         total = round(v_total, 2), change_returned = greatest(round(r.disbursed_amount - v_total, 2), 0),
         proof_status = 'pending', finance_note = null
   where id = e.id returning * into e;
  update public.requests set status = 'proof_review' where id = p_request;
  perform public.log_event(p_request, 'expense_recorded', 'disbursed', 'proof_review',
    'Spent ' || v_total || case when v_total > r.disbursed_amount then ' (over by ' || (v_total - r.disbursed_amount) || ')' else ', change ' || greatest(r.disbursed_amount - v_total, 0) end);

  -- more spent than was paid out, beyond the tolerance: someone senior looks at it afterwards
  select 1 + coalesce(change_tolerance_pct, 0) / 100 into v_tol from public.settings where id = 1;
  if v_total > round(r.disbursed_amount * v_tol, 2) then
    v_why := format('Spent %s against %s paid out.', public.money_text(v_total), public.money_text(r.disbursed_amount));
    update public.requests
       set review_role = case when (select role from public.profiles where id = r.requester_id) = 'approver'
                                or (select role from public.profiles where id = auth.uid()) = 'approver'
                              then 'managing_director'::public.user_role else 'approver'::public.user_role end,
           review_reason = case when reviewed_at is null and review_reason is not null then review_reason || ' ' || v_why else v_why end,
           reviewed_by = null, reviewed_at = null, review_note = null
     where id = p_request;
    perform public.notify_review(p_request);
  end if;
  perform public.notify_stage(p_request);
  return e;
end $$;
/* ---------- the schedule records the new limit as a version ---------- */
select public.schedule_record('rules', 'Stock controls added to the schedule: the correction the stock controller may make alone (above it the GM approves)',
                              (select id from public.profiles where role = 'approver' and active order by created_at limit 1),
                              case when public.role_filled('managing_director') then 'notified' else 'no_md' end);
