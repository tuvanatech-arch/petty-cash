-- 029: KPIs, the management summary and the accounting export (Phase 6).
--   • The seven KPIs come straight from the records, per branch and added up for the branches being looked at.
--   • The management summary answers the six questions for a month: how much, on what, against budget, whether funds and
--     receipts are accounted for, irregularities, and where costs could fall. It opens the monthly pack, is on the KPI
--     screen, and goes to the GM and MD as an alert (and so by email) once a month.
--   • The accounting export: a journal of the month, one line per receipt line, with the account codes you give each
--     category. Generic CSV until the accounting package is named.

alter table public.categories add column if not exists account_code text;
alter table public.settings add column if not exists petty_cash_account text;          -- the ledger account for the cash box itself
alter table public.settings add column if not exists accounting_package text;          -- named later; the export stays generic until then

/* ---------- currency: one rate a month per non-base company, for the group view ---------- */
create or replace function public.fx_rate(p_branch uuid, p_month date) returns numeric
language sql stable security definer set search_path = public as $$
  select case when c.is_base then 1
              else coalesce((select r.rate from public.fx_rates r where r.company_id = c.id and r.month <= date_trunc('month', p_month)::date order by r.month desc limit 1), 1) end
  from public.branches b join public.companies c on c.id = b.company_id where b.id = p_branch
$$;
grant execute on function public.fx_rate(uuid, date) to authenticated;

create or replace function public.set_fx_rate(p_company uuid, p_month date, p_rate numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() is distinct from 'approver' then raise exception 'Only the administrator sets exchange rates'; end if;
  if p_rate is null or p_rate <= 0 then raise exception 'Enter the rate'; end if;
  insert into public.fx_rates (company_id, month, rate, set_by) values (p_company, date_trunc('month', p_month)::date, p_rate, auth.uid())
  on conflict (company_id, month) do update set rate = excluded.rate, set_by = excluded.set_by, set_at = now();
end $$;
revoke execute on function public.set_fx_rate(uuid, date, numeric) from public, anon;
grant execute on function public.set_fx_rate(uuid, date, numeric) to authenticated;

/* ---------- the seven KPIs for a month, over the branches being looked at ---------- */
create or replace function public.kpis(p_month date default date_trunc('month', current_date)::date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s public.settings%rowtype; v_view uuid; m0 date := date_trunc('month', p_month)::date; m1 date; brs uuid[];
  v_spent numeric; v_budget numeric; v_budget_used numeric; v_over int; v_budgets int;
  v_adv_n int; v_adv numeric; v_adv_oldest int; v_overdue int;
  v_closed int; v_with_receipt int; v_on_time int; v_grace int;
  v_counts int; v_count_exc int; v_count_net numeric; v_count_abs numeric; v_unsigned int;
  v_issued_value numeric; v_var_value numeric; v_var_n int; v_items int;
  v_price_items int; v_price_up int; v_price_avg numeric;
  v_median_h numeric; v_decisions int; v_slow int;
  k jsonb := '[]'::jsonb;
  tone text;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  select * into s from public.settings where id = 1;
  select view_branch into v_view from public.profiles where id = auth.uid();
  select array_agg(b) into brs from unnest(public.my_branches()) b where v_view is null or b = v_view;
  m1 := (m0 + interval '1 month')::date;
  v_grace := coalesce(s.advance_grace_days, 5);

  -- 01 expenditure vs budget
  select coalesce(sum(l.line_total * public.fx_rate(l.branch_id, m0)), 0) into v_spent from public.v_spend_lines l where l.branch_id = any(brs) and l.spent_at >= m0 and l.spent_at < m1;
  select count(*), coalesce(sum(b.monthly_limit), 0) into v_budgets, v_budget from public.budgets b where b.active and (b.branch_id is null or b.branch_id = any(brs));
  select coalesce(sum(x.used), 0), count(*) filter (where x.used > x.monthly_limit) into v_budget_used, v_over
    from (select b.monthly_limit, coalesce((select sum(l.line_total) from public.v_spend_lines l where l.spent_at >= m0 and l.spent_at < m1 and l.branch_id = any(brs) and (b.branch_id is null or l.branch_id = b.branch_id)
                                              and ((b.category_id is not null and l.category_id = b.category_id) or (b.person_id is not null and l.requester_id = b.person_id))), 0) as used
          from public.budgets b where b.active and (b.branch_id is null or b.branch_id = any(brs))) x;
  tone := case when v_budget = 0 then 'grey' when v_over > 0 then 'red' when v_budget_used > v_budget * 0.9 then 'amber' else 'green' end;
  k := k || jsonb_build_object('id', '01', 'label', 'Expenditure vs budget', 'value', case when v_budget > 0 then round(v_budget_used / v_budget * 100) || '%' else public.money_text(v_spent) end,
    'text', case when v_budget > 0 then public.money_text(v_budget_used) || ' of ' || public.money_text(v_budget) || ' budgeted' || case when v_over > 0 then ' · ' || v_over || ' budget' || case when v_over = 1 then '' else 's' end || ' over' else '' end || ' · ' || public.money_text(v_spent) || ' spent in all'
                 else public.money_text(v_spent) || ' spent · no budgets set' end, 'tone', tone, 'n', v_spent);

  -- 02 outstanding advances
  select count(*), coalesce(sum(r.disbursed_amount * public.fx_rate(r.branch_id, m0)), 0), coalesce(max(current_date - r.disbursed_at::date), 0), count(*) filter (where current_date - r.disbursed_at::date > v_grace)
    into v_adv_n, v_adv, v_adv_oldest, v_overdue from public.requests r where r.status = 'disbursed' and r.branch_id = any(brs);
  tone := case when v_overdue > 0 then 'amber' when v_adv_n > 0 then 'grey' else 'green' end;
  k := k || jsonb_build_object('id', '02', 'label', 'Outstanding advances', 'value', public.money_text(v_adv),
    'text', case when v_adv_n = 0 then 'every pay-out has its receipt' else v_adv_n || ' out with people · oldest ' || v_adv_oldest || ' days' || case when v_overdue > 0 then ' · ' || v_overdue || ' past the ' || v_grace || '-day grace' else '' end end, 'tone', tone, 'n', v_adv_n);

  -- 03 receipt compliance: closed in the month, with a confirmed receipt, recorded within the grace period
  select count(*), count(*) filter (where e.proof_status = 'confirmed' and exists (select 1 from public.expense_proofs p where p.expense_id = e.id)),
         count(*) filter (where e.spent_at <= r.disbursed_at::date + v_grace)
    into v_closed, v_with_receipt, v_on_time
    from public.requests r join public.expenses e on e.request_id = r.id
   where r.branch_id = any(brs) and r.status = 'closed' and r.closed_at >= m0 and r.closed_at < m1 and r.disbursed_at is not null;
  tone := case when v_closed = 0 then 'grey' when v_with_receipt = v_closed and v_on_time >= v_closed * 0.9 then 'green' when v_with_receipt >= v_closed * 0.95 then 'amber' else 'red' end;
  k := k || jsonb_build_object('id', '03', 'label', 'Receipt compliance', 'value', case when v_closed = 0 then '—' else round(v_with_receipt::numeric / v_closed * 100) || '%' end,
    'text', case when v_closed = 0 then 'nothing closed this month' else v_with_receipt || ' of ' || v_closed || ' closed with a confirmed receipt · ' || round(v_on_time::numeric / v_closed * 100) || '% recorded within ' || v_grace || ' days' end, 'tone', tone, 'n', v_closed);

  -- 04 float reconciliation variance: counts in the month against the book
  select count(*), count(*) filter (where c.exception), coalesce(sum(c.difference * public.fx_rate(f.branch_id, m0)), 0), coalesce(sum(abs(c.difference) * public.fx_rate(f.branch_id, m0)), 0), count(*) filter (where c.status in ('to_review', 'queried'))
    into v_counts, v_count_exc, v_count_net, v_count_abs, v_unsigned
    from public.cash_counts c join public.floats f on f.id = c.float_id where f.branch_id = any(brs) and c.counted_at >= m0 and c.counted_at < m1 and c.status <> 'superseded';
  tone := case when v_counts = 0 then 'amber' when v_count_exc = 0 then 'green' when v_count_abs <= coalesce(s.cash_variance_limit, 0) * v_counts + 50 then 'amber' else 'red' end;
  k := k || jsonb_build_object('id', '04', 'label', 'Float reconciliation variance', 'value', case when v_counts = 0 then 'no count' else public.money_text(v_count_net) end,
    'text', case when v_counts = 0 then 'the box was not counted this month' else v_counts || ' count' || case when v_counts = 1 then '' else 's' end || ' · ' || v_count_exc || ' outside the limit · ' || public.money_text(v_count_abs) || ' of differences in all' || case when v_unsigned > 0 then ' · ' || v_unsigned || ' not yet signed off' else '' end end, 'tone', tone, 'n', v_counts);

  -- 05 inventory accuracy: issued items – variance value against the value on the shelf
  select count(*), coalesce(sum(i.qty_on_hand * coalesce(i.last_unit_price, 0) * public.fx_rate(i.branch_id, m0)), 0) into v_items, v_issued_value from public.items i where i.active and i.tracking = 'issued' and i.branch_id = any(brs);
  select count(*), coalesce(sum(a.value * public.fx_rate(i.branch_id, m0)), 0) into v_var_n, v_var_value from public.stock_adjustments a join public.items i on i.id = a.item_id
   where i.branch_id = any(brs) and a.kind in ('count', 'delivery') and a.requested_at >= m0 and a.requested_at < m1 and a.status <> 'rejected';
  tone := case when v_items = 0 then 'grey' when v_var_n = 0 then 'green' when v_var_value <= greatest(v_issued_value, 1) * 0.02 then 'amber' else 'red' end;
  k := k || jsonb_build_object('id', '05', 'label', 'Inventory accuracy', 'value', case when v_items = 0 then '—' when v_issued_value > 0 then greatest(0, round(100 - v_var_value / v_issued_value * 100)) || '%' else case when v_var_n = 0 then '100%' else '—' end end,
    'text', case when v_items = 0 then 'no issued items yet' else v_items || ' issued item' || case when v_items = 1 then '' else 's' end || ' worth ' || public.money_text(v_issued_value) || ' · ' || v_var_n || ' variance' || case when v_var_n = 1 then '' else 's' end || ' this month worth ' || public.money_text(v_var_value) end, 'tone', tone, 'n', v_var_n);

  -- 06 purchase price trends: items bought this quarter whose latest price is above the first
  select count(*), count(*) filter (where chg > 0.10), coalesce(round(avg(chg) * 100, 1), 0) into v_price_items, v_price_up, v_price_avg
    from (select p.item_id, (max(p.unit_price) filter (where p.rn_last = 1) - max(p.unit_price) filter (where p.rn_first = 1)) / nullif(max(p.unit_price) filter (where p.rn_first = 1), 0) as chg
          from (select h.item_id, h.unit_price, row_number() over (partition by h.item_id order by h.on_date) rn_first, row_number() over (partition by h.item_id order by h.on_date desc) rn_last
                from public.v_price_history h join public.items i on i.id = h.item_id where i.branch_id = any(brs) and h.on_date >= (m1 - interval '3 months')::date and h.on_date < m1) p
          group by p.item_id having count(*) > 1) x;
  tone := case when v_price_items = 0 then 'grey' when v_price_up = 0 then 'green' when v_price_up <= 2 then 'amber' else 'red' end;
  k := k || jsonb_build_object('id', '06', 'label', 'Purchase price trends', 'value', case when v_price_items = 0 then '—' else (case when v_price_avg > 0 then '+' else '' end) || v_price_avg || '%' end,
    'text', case when v_price_items = 0 then 'no item bought twice in the last 3 months' else v_price_items || ' item' || case when v_price_items = 1 then '' else 's' end || ' bought more than once · ' || v_price_up || ' up more than 10%' end, 'tone', tone, 'n', v_price_up);

  -- 07 approval turnaround: submission to decision
  select count(*), round(percentile_cont(0.5) within group (order by extract(epoch from (coalesce(r.approved_at, r.rejected_at) - r.submitted_at)) / 3600)::numeric, 1), count(*) filter (where coalesce(r.approved_at, r.rejected_at) - r.submitted_at > interval '48 hours')
    into v_decisions, v_median_h, v_slow
    from public.requests r where r.branch_id = any(brs) and r.approval_required and coalesce(r.approved_at, r.rejected_at) >= m0 and coalesce(r.approved_at, r.rejected_at) < m1 and r.submitted_at is not null;
  tone := case when v_decisions = 0 then 'grey' when v_median_h <= 24 and v_slow = 0 then 'green' when v_median_h <= 48 then 'amber' else 'red' end;
  k := k || jsonb_build_object('id', '07', 'label', 'Approval turnaround', 'value', case when v_decisions = 0 then '—' when v_median_h < 1 then round(v_median_h * 60) || ' min' when v_median_h < 48 then v_median_h || ' h' else round(v_median_h / 24, 1) || ' days' end,
    'text', case when v_decisions = 0 then 'no decisions this month' else v_decisions || ' decision' || case when v_decisions = 1 then '' else 's' end || ' · median wait' || case when v_slow > 0 then ' · ' || v_slow || ' took over 2 days' else ' · none over 2 days' end end, 'tone', tone, 'n', v_decisions);

  return jsonb_build_object('month', m0, 'branches', (select coalesce(jsonb_agg(public.branch_name(b) order by public.branch_name(b)), '[]'::jsonb) from unnest(brs) b), 'kpis', k);
end $$;
revoke execute on function public.kpis(date) from public, anon;
grant execute on function public.kpis(date) to authenticated;

/* ---------- the management summary: six questions, one month ---------- */
create or replace function public.management_summary(p_month date default date_trunc('month', current_date)::date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s public.settings%rowtype; v_view uuid; m0 date := date_trunc('month', p_month)::date; m1 date; brs uuid[]; prev0 date;
  v_spent numeric; v_prev numeric; v_avg numeric; v_n int; v_cats jsonb; v_people jsonb; v_budget jsonb; v_open_exc int; v_exc jsonb;
  v_funds jsonb; v_savings jsonb; v_kp jsonb; r text; v_boxes jsonb;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  select * into s from public.settings where id = 1;
  select view_branch into v_view from public.profiles where id = auth.uid();
  select array_agg(b) into brs from unnest(public.my_branches()) b where v_view is null or b = v_view;
  m1 := (m0 + interval '1 month')::date; prev0 := (m0 - interval '1 month')::date;

  -- 1. how much
  select coalesce(sum(l.line_total * public.fx_rate(l.branch_id, m0)), 0), count(distinct l.request_id) into v_spent, v_n from public.v_spend_lines l where l.branch_id = any(brs) and l.spent_at >= m0 and l.spent_at < m1;
  select coalesce(sum(l.line_total * public.fx_rate(l.branch_id, prev0)), 0) into v_prev from public.v_spend_lines l where l.branch_id = any(brs) and l.spent_at >= prev0 and l.spent_at < m0;
  select coalesce(avg(t), 0) into v_avg from (select sum(l.line_total * public.fx_rate(l.branch_id, m0)) t from public.v_spend_lines l where l.branch_id = any(brs) and l.spent_at >= (m0 - interval '6 months')::date and l.spent_at < m0 group by date_trunc('month', l.spent_at)) x;
  -- 2. on what
  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'amount', x.amt, 'share', case when v_spent > 0 then round(x.amt / v_spent * 100) else 0 end) order by x.amt desc), '[]'::jsonb) into v_cats
    from (select l.category_name as name, sum(l.line_total * public.fx_rate(l.branch_id, m0)) amt from public.v_spend_lines l where l.branch_id = any(brs) and l.spent_at >= m0 and l.spent_at < m1 group by l.category_name order by 2 desc limit 6) x;
  select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'amount', x.amt) order by x.amt desc), '[]'::jsonb) into v_people
    from (select l.requester_name as name, sum(l.line_total * public.fx_rate(l.branch_id, m0)) amt from public.v_spend_lines l where l.branch_id = any(brs) and l.spent_at >= m0 and l.spent_at < m1 group by l.requester_name order by 2 desc limit 5) x;
  -- 3. against budget
  select coalesce(jsonb_agg(jsonb_build_object('label', x.label, 'limit', x.monthly_limit, 'used', x.used, 'over', x.used > x.monthly_limit) order by x.used / nullif(x.monthly_limit, 0) desc), '[]'::jsonb) into v_budget
    from (select coalesce(c.name, p.full_name) as label, b.monthly_limit,
                 coalesce((select sum(l.line_total) from public.v_spend_lines l where l.spent_at >= m0 and l.spent_at < m1 and l.branch_id = any(brs) and (b.branch_id is null or l.branch_id = b.branch_id)
                           and ((b.category_id is not null and l.category_id = b.category_id) or (b.person_id is not null and l.requester_id = b.person_id))), 0) as used
          from public.budgets b left join public.categories c on c.id = b.category_id left join public.profiles p on p.id = b.person_id
          where b.active and (b.branch_id is null or b.branch_id = any(brs))) x;
  -- 4. funds and receipts accounted for: per branch, the box for that month
  select coalesce(jsonb_agg(jsonb_build_object('branch', public.branch_name(f.branch_id), 'period', f.period, 'status', f.status, 'funds', coalesce(f.allocated, 0) + coalesce(f.topped_up, 0) + coalesce(f.carried_over, 0) - coalesce(f.returned, 0),
      'spent', f.spent, 'outstanding', f.outstanding, 'balance', f.balance, 'counted', f.counted_cash,
      'counts', (select count(*) from public.cash_counts c where c.float_id = f.id and c.status <> 'superseded'),
      'signed_off', (select count(*) from public.cash_counts c where c.float_id = f.id and c.status = 'accepted'),
      'missing_receipts', (select count(*) from public.requests r where r.float_id = f.id and r.status = 'disbursed'),
      'pack', (select p.status from public.packs p where p.float_id = f.id)) order by public.branch_name(f.branch_id)), '[]'::jsonb) into v_boxes
    from public.v_floats f where f.branch_id = any(brs) and f.period = m0;
  -- 5. irregularities: the exception log for the month
  select count(*) filter (where x.state = 'open'), coalesce(jsonb_agg(jsonb_build_object('title', x.title, 'detail', x.detail, 'amount', x.amount, 'state', x.state, 'who', (select full_name from public.profiles where id = x.who)) order by x.at desc) filter (where x.state in ('open', 'reviewed', 'auto')), '[]'::jsonb)
    into v_open_exc, v_exc from public.exceptions_log(m0) x where x.at < m1 and x.kind not in ('schedule', 'admin', 'signout', 'standin', 'not_stock');
  -- 6. where costs could fall: prices up, fast-moving items, budgets over, claims share
  select coalesce(jsonb_agg(jsonb_build_object('kind', 'price', 'text', x.name || ' up ' || round(x.chg * 100) || '% since ' || to_char(x.since, 'DD Mon') || ' (' || public.money_text(x.first) || ' → ' || public.money_text(x.last) || ')')), '[]'::jsonb) into v_savings
    from (select i.name, (max(h.unit_price) filter (where h.rn_last = 1)) as last, (max(h.unit_price) filter (where h.rn_first = 1)) as first, min(h.on_date) as since,
                 (max(h.unit_price) filter (where h.rn_last = 1) - max(h.unit_price) filter (where h.rn_first = 1)) / nullif(max(h.unit_price) filter (where h.rn_first = 1), 0) as chg
          from (select p.item_id, p.unit_price, p.on_date, row_number() over (partition by p.item_id order by p.on_date) rn_first, row_number() over (partition by p.item_id order by p.on_date desc) rn_last
                from public.v_price_history p where p.on_date >= (m1 - interval '6 months')::date and p.on_date < m1) h join public.items i on i.id = h.item_id
          where i.branch_id = any(brs) group by i.name having count(*) > 1 and (max(h.unit_price) filter (where h.rn_last = 1) - max(h.unit_price) filter (where h.rn_first = 1)) / nullif(max(h.unit_price) filter (where h.rn_first = 1), 0) > 0.10
          order by 5 desc limit 4) x;
  v_savings := v_savings || coalesce((select jsonb_agg(jsonb_build_object('kind', 'budget', 'text', (b->>'label') || ' is over budget: ' || public.money_text((b->>'used')::numeric) || ' against ' || public.money_text((b->>'limit')::numeric))) from jsonb_array_elements(v_budget) b where (b->>'over')::boolean), '[]'::jsonb);
  v_savings := v_savings || coalesce((select jsonb_agg(jsonb_build_object('kind', 'claims', 'text', x.person_name || ' spent ' || round(x.share) || '% of their spending before approval (' || public.money_text(x.claimed) || ')')) from public.claims_summary(m0, (m1 - 1)) x where x.share >= 25 and x.claimed >= 100), '[]'::jsonb);
  v_kp := public.kpis(m0);
  return jsonb_build_object('month', m0, 'branches', v_kp->'branches', 'spent', round(v_spent, 2), 'requests', v_n, 'prev', round(v_prev, 2), 'avg6', round(v_avg, 2),
    'categories', v_cats, 'people', v_people, 'budgets', v_budget, 'boxes', v_boxes, 'open_exceptions', v_open_exc, 'exceptions', v_exc, 'savings', v_savings, 'kpis', v_kp->'kpis');
end $$;
revoke execute on function public.management_summary(date) from public, anon;
grant execute on function public.management_summary(date) to authenticated;

/* ---------- the monthly summary alert to the GM and MD (and so by email), on the 2nd ---------- */
create or replace function public.send_monthly_summary() returns integer
language plpgsql security definer set search_path = public as $$
declare m0 date := (date_trunc('month', current_date) - interval '1 month')::date; u uuid; n int := 0; v_body text; sm jsonb; v_top text; gm uuid;
begin
  if auth.uid() is not null and not public.has_role('approver') then raise exception 'Not allowed'; end if;
  if exists (select 1 from public.notifications where kind = 'monthly_summary' and created_at >= date_trunc('month', current_date)) then return 0; end if;
  select id into gm from public.profiles where role = 'approver' and active order by created_at limit 1;
  if gm is null then return 0; end if;
  -- computed as the GM sees it (every branch)
  perform set_config('request.jwt.claims', json_build_object('sub', gm, 'role', 'authenticated')::text, true);
  update public.profiles set view_branch = null where id = gm and view_branch is not null;
  sm := public.management_summary(m0);
  select string_agg((c->>'name') || ' ' || public.money_text((c->>'amount')::numeric), ', ') into v_top from (select c from jsonb_array_elements(sm->'categories') c limit 3) x;
  v_body := 'Spent ' || public.money_text((sm->>'spent')::numeric) || ' on ' || (sm->>'requests') || ' requests (last month ' || public.money_text((sm->>'prev')::numeric) || ', usual ' || public.money_text((sm->>'avg6')::numeric) || ').'
    || coalesce(' Mostly ' || v_top || '.', '')
    || case when (sm->>'open_exceptions')::int > 0 then ' ' || (sm->>'open_exceptions') || ' exception' || case when (sm->>'open_exceptions')::int = 1 then '' else 's' end || ' still open.' else ' No open exceptions.' end
    || ' The full summary and the seven KPIs are under Reports → KPIs.';
  for u in select id from public.profiles where active and role in ('approver', 'managing_director') loop
    perform public.notify_user(u, 'monthly_summary', 'Management summary for ' || to_char(m0, 'Mon YYYY'), v_body, '#/reports/kpis', null);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.send_monthly_summary() from public, anon, authenticated;
select cron.schedule('petty-monthly-summary', '15 7 2 * *', 'select public.send_monthly_summary()');

/* ---------- the accounting export: one journal for a month ---------- */
create or replace function public.journal(p_month date) returns table (
  entry_date date, reference text, account text, account_name text, description text, debit numeric, credit numeric, branch text, currency text, request_no int)
language sql stable security definer set search_path = public as $$
  with v as (select view_branch as b from public.profiles where id = auth.uid()),
  brs as (select x.bid from unnest(public.my_branches()) x(bid), v where v.b is null or x.bid = v.b),
  m as (select date_trunc('month', p_month)::date as m0, (date_trunc('month', p_month) + interval '1 month')::date as m1),
  cash_acct as (select coalesce(nullif(s.petty_cash_account, ''), 'PETTY-CASH') as code from public.settings s where s.id = 1),
  -- spending: debit the category's account, credit petty cash (one line per receipt line, one credit per voucher)
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
    -- the float: allocations, top-ups and returns move between the bank and petty cash; write-offs go to an expense account
    select t.created_at::date, 'PC-FLOAT-' || to_char(f.period, 'YYYYMM'), case when t.kind in ('allocation', 'top_up', 'carry_over') then (select code from cash_acct) when t.kind = 'return' then 'BANK' else 'CASH-' || upper(t.kind::text) end,
           case when t.kind in ('allocation', 'top_up', 'carry_over') then 'Petty cash' when t.kind = 'return' then 'Bank' else 'Cash ' || t.kind end,
           coalesce(t.note, t.kind::text), case when t.kind in ('allocation', 'top_up', 'carry_over', 'shortage') then t.amount else 0 end, case when t.kind in ('return', 'surplus') then t.amount else 0 end,
           public.branch_name(f.branch_id), co.currency_code::text, null
    from public.float_transactions t join public.floats f on f.id = t.float_id join public.branches b on b.id = f.branch_id join public.companies co on co.id = b.company_id, m
    where f.branch_id in (select bid from brs) and t.created_at >= m.m0 and t.created_at < m.m1 and t.kind <> 'carry_over' and public.is_staff()
    union all
    select t.created_at::date, 'PC-FLOAT-' || to_char(f.period, 'YYYYMM'), case when t.kind in ('allocation', 'top_up') then 'BANK' when t.kind = 'return' then (select code from cash_acct) else (select code from cash_acct) end,
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

/* ---------- alerts open the right screen ---------- */
create or replace function public.notification_link(p_kind text, p_request uuid) returns text
language sql immutable set search_path = public as $$
  select case
    when p_kind in ('stock_receipt') then '#/stock/deliveries'
    when p_kind in ('stock_adjust') then '#/stock/adjustments'
    when p_kind = 'access_review' then '#/schedule'
    when p_kind = 'exception' then '#/reports/controls'
    when p_kind = 'monthly_summary' then '#/reports/kpis'
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
