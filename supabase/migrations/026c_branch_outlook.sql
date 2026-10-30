-- 026c: the float outlook for any one branch (the Home of someone looking at all branches shows one card per branch),
-- and the action badge follows the branch being looked at.

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
revoke execute on function public.outlook_for(uuid, uuid) from public, anon;
grant execute on function public.outlook_for(uuid, uuid) to authenticated;

create or replace function public.float_outlook(p_request uuid default null) returns jsonb
language sql stable security definer set search_path = public as $$ select public.outlook_for(null, p_request) $$;

/** One outlook per branch being looked at (all of mine, or the chosen one). */
create or replace function public.branch_outlooks() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.outlook_for(b.id, null) order by b.name), '[]'::jsonb)
  from public.branches b
  where b.active and b.id = any(public.my_branches())
    and ((select view_branch from public.profiles where id = auth.uid()) is null or b.id = (select view_branch from public.profiles where id = auth.uid()))
$$;
revoke execute on function public.branch_outlooks() from public, anon;
grant execute on function public.branch_outlooks() to authenticated;

-- the badge and the Home cards count only the branch being looked at
create or replace function public.cash_actions() returns jsonb
language sql stable security definer set search_path = public as $$
  with v as (select view_branch as b from public.profiles where id = auth.uid()),
  fl as (select f.id from public.floats f, v where f.branch_id = any(public.my_branches()) and (v.b is null or f.branch_id = v.b))
  select jsonb_build_object(
    'counts_to_review', case when public.has_role('approver') then (select count(*) from public.cash_counts c where c.status = 'to_review' and c.counted_by <> auth.uid() and c.float_id in (select id from fl)
                          and not exists (select 1 from public.top_ups t where t.count_id = c.id and t.status = 'requested')) else 0 end,
    'counts_queried', case when public.has_role('finance') then (select count(*) from public.cash_counts where status = 'queried' and float_id in (select id from fl)) else 0 end,
    'top_ups_to_decide', (select count(*) from public.top_ups t where t.status = 'requested' and t.requested_by <> auth.uid() and t.float_id in (select id from fl)
                           and ((t.level = 'gm' and public.has_role('approver')) or (t.level = 'md' and public.has_role('managing_director')))),
    'top_ups_to_receive', case when public.has_role('finance') then (select count(*) from public.top_ups where status = 'authorised' and float_id in (select id from fl)) else 0 end)
$$;
