-- 028: exceptions and audit (Phase 5).
--   • One Approval and Exception Log, built from the histories the app already keeps: every override, correction and
--     delegated action, with who, why and whether it has been reviewed. The GM clears the open ones.
--   • Every administrator action is logged (people, stand-ins, branches); schedule changes already are.
--   • Closed months are locked: no money figure of a closed float changes; corrections go in the current month.
--   • A quarterly access review the MD signs off: who holds which position, last sign-in, devices.
--   • Backups daily instead of weekly (the function itself is redeployed with the newer tables).

/* ---------- the administrator's actions ---------- */
create table if not exists public.admin_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid references public.profiles(id),
  area text not null,          -- people | standins | branches | companies
  action text not null,        -- created | changed | removed
  subject text,                -- who or what
  detail jsonb
);
create index if not exists admin_log_at_idx on public.admin_log (at desc);
alter table public.admin_log enable row level security;
create policy admin_log_select on public.admin_log for select to authenticated using (public.has_role('approver'));

create or replace function public.admin_log_profiles() returns trigger
language plpgsql security definer set search_path = public as $$
declare ch jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.admin_log (actor_id, area, action, subject, detail) values (auth.uid(), 'people', 'created', coalesce(nullif(new.full_name, ''), new.email), jsonb_build_object('role', new.role, 'branch', public.branch_name(new.branch_id)));
    return new;
  end if;
  if new.role is distinct from old.role then ch := ch || jsonb_build_object('role', jsonb_build_array(old.role, new.role)); end if;
  if new.active is distinct from old.active then ch := ch || jsonb_build_object('active', jsonb_build_array(old.active, new.active)); end if;
  if new.branch_id is distinct from old.branch_id then ch := ch || jsonb_build_object('branch', jsonb_build_array(public.branch_name(old.branch_id), public.branch_name(new.branch_id))); end if;
  if new.extra_branches is distinct from old.extra_branches then ch := ch || jsonb_build_object('also_covers', jsonb_build_array((select coalesce(string_agg(public.branch_name(b), ', '), '—') from unnest(old.extra_branches) b), (select coalesce(string_agg(public.branch_name(b), ', '), '—') from unnest(new.extra_branches) b))); end if;
  if new.email is distinct from old.email then ch := ch || jsonb_build_object('email', jsonb_build_array(old.email, new.email)); end if;
  if new.full_name is distinct from old.full_name then ch := ch || jsonb_build_object('name', jsonb_build_array(old.full_name, new.full_name)); end if;
  if ch <> '{}'::jsonb then
    insert into public.admin_log (actor_id, area, action, subject, detail) values (auth.uid(), 'people', 'changed', coalesce(nullif(new.full_name, ''), new.email), ch);
  end if;
  return new;
end $$;
revoke execute on function public.admin_log_profiles() from public, anon, authenticated;
create or replace trigger admin_log_profiles after insert or update on public.profiles for each row execute function public.admin_log_profiles();

create or replace function public.admin_log_delegations() returns trigger
language plpgsql security definer set search_path = public as $$
declare d public.delegations; v_from text; v_to text;
begin
  d := case when tg_op = 'DELETE' then old else new end;
  select full_name into v_from from public.profiles where id = d.from_user;
  select full_name into v_to from public.profiles where id = d.to_user;
  insert into public.admin_log (actor_id, area, action, subject, detail)
  values (auth.uid(), 'standins', case tg_op when 'INSERT' then 'created' when 'DELETE' then 'removed' else 'changed' end, v_to || ' for ' || v_from,
          jsonb_build_object('role', d.role, 'from', d.starts_on, 'to', d.ends_on, 'note', d.note));
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke execute on function public.admin_log_delegations() from public, anon, authenticated;
create or replace trigger admin_log_delegations after insert or update or delete on public.delegations for each row execute function public.admin_log_delegations();

create or replace function public.admin_log_branches() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.admin_log (actor_id, area, action, subject, detail)
  values (auth.uid(), 'branches', case tg_op when 'INSERT' then 'created' else 'changed' end, new.name,
          case tg_op when 'INSERT' then jsonb_build_object('code', new.code, 'usual_float', new.usual_float)
               else jsonb_strip_nulls(jsonb_build_object('name', case when new.name is distinct from old.name then jsonb_build_array(old.name, new.name) end,
                                                        'usual_float', case when new.usual_float is distinct from old.usual_float then jsonb_build_array(old.usual_float, new.usual_float) end,
                                                        'active', case when new.active is distinct from old.active then jsonb_build_array(old.active, new.active) end)) end);
  return new;
end $$;
revoke execute on function public.admin_log_branches() from public, anon, authenticated;
create or replace trigger admin_log_branches after insert or update on public.branches for each row execute function public.admin_log_branches();

/* ---------- reviews of exceptions ---------- */
create table if not exists public.exception_reviews (
  kind text not null,
  ref uuid not null,
  outcome text not null check (outcome in ('justified', 'resolved')),
  note text,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz not null default now(),
  primary key (kind, ref)
);
alter table public.exception_reviews enable row level security;
create policy exception_reviews_select on public.exception_reviews for select to authenticated using (public.is_staff());

create or replace function public.review_exception(p_kind text, p_ref uuid, p_outcome text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('approver') then raise exception 'Exceptions are cleared by the General Manager'; end if;
  if p_outcome not in ('justified', 'resolved') then raise exception 'Say whether it was justified or resolved'; end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'Say in a few words why'; end if;
  insert into public.exception_reviews (kind, ref, outcome, note, reviewed_by) values (p_kind, p_ref, p_outcome, btrim(p_note), auth.uid())
  on conflict (kind, ref) do update set outcome = excluded.outcome, note = excluded.note, reviewed_by = excluded.reviewed_by, reviewed_at = now();
end $$;
revoke execute on function public.review_exception(text, uuid, text, text) from public, anon;
grant execute on function public.review_exception(text, uuid, text, text) to authenticated;

/* ---------- the log itself, from the records the app already keeps ---------- */
create or replace function public.exceptions_log(p_from date default (current_date - 90))
returns table (kind text, ref uuid, at timestamptz, title text, detail text, who uuid, amount numeric, request_id uuid, branch_id uuid,
               state text, by_whom uuid, at2 timestamptz, note text, outcome text)
language plpgsql stable security definer set search_path = public as $$
declare s public.settings%rowtype; v_view uuid;
begin
  if not public.is_staff() then return; end if;
  select * into s from public.settings where id = 1;
  select view_branch into v_view from public.profiles where id = auth.uid();
  return query
  with mine as (select b from unnest(public.my_branches()) b where v_view is null or b = v_view),
  base as (
    -- money spent before approval (claims)
    select 'claim'::text as kind, r.id as ref, r.disbursed_at as at, 'Spent before approval'::text as title, r.purpose as detail, r.requester_id as who, r.disbursed_amount as amount, r.id as request_id, r.branch_id,
           case when r.approved_by is not null then 'auto' else 'open' end as state, r.approved_by as by_whom, r.approved_at as at2, r.approval_note as note
    from public.requests r where r.type = 'claim' and r.status = 'closed' and r.disbursed_at >= p_from
    union all
    -- approved over budget
    select 'over_budget', r.id, r.approved_at, 'Approved over budget', r.purpose || coalesce(' – ' || r.budget_note, ''), r.requester_id, r.estimated_total, r.id, r.branch_id, 'auto', r.approved_by, r.approved_at, r.approval_note
    from public.requests r where r.over_budget and r.approved_by is not null and r.approved_at >= p_from
    union all
    -- spent more than was paid out (or paid without approval): reviewed after payment
    select 'review', r.id, coalesce(r.disbursed_at, r.submitted_at), 'Looked at after payment', coalesce(r.review_reason, '') || ' ' || r.purpose, r.requester_id, coalesce((select e.total from public.expenses e where e.request_id = r.id), r.disbursed_amount), r.id, r.branch_id,
           case when r.reviewed_at is not null then 'auto' else 'open' end, r.reviewed_by, r.reviewed_at, r.review_note
    from public.requests r where r.review_reason is not null and coalesce(r.disbursed_at, r.submitted_at) >= p_from
    union all
    -- several small requests by one person on one day that together pass the finance limit
    select 'split', md5(g.requester_id::text || g.day::text)::uuid, g.day::timestamptz, 'Split purchase?', g.n || ' requests on one day adding up to ' || public.money_text(g.total), g.requester_id, g.total, g.first_id, g.branch_id, 'open', null, null, null
    from (select r.requester_id, r.branch_id, (r.submitted_at at time zone 'Africa/Windhoek')::date as day, count(*) as n, sum(r.estimated_total) as total, (array_agg(r.id order by r.submitted_at))[1] as first_id
          from public.requests r where not r.approval_required and r.status not in ('draft', 'cancelled', 'rejected') and r.submitted_at >= p_from
          group by r.requester_id, r.branch_id, (r.submitted_at at time zone 'Africa/Windhoek')::date
          having count(*) > 1 and sum(r.estimated_total) > s.approval_threshold) g
    union all
    -- a pay-out undone
    select 'undone', ev.id, ev.created_at, 'Pay-out undone', coalesce(ev.note, '') || ' · ' || r.purpose, ev.actor_id, r.disbursed_amount, r.id, r.branch_id, 'open', null, null, null
    from public.request_events ev join public.requests r on r.id = ev.request_id where ev.action = 'payout_undone' and ev.created_at >= p_from
    union all
    -- "not from the store" overrides
    select 'not_stock', r.id, r.submitted_at, 'Bought outside the store', r.purpose, r.requester_id, r.estimated_total, r.id, r.branch_id, 'info', r.stock_reviewed_by, r.stock_reviewed_at, r.stock_note
    from public.requests r where r.not_stock and r.submitted_at >= p_from
    union all
    -- stock corrections, count variances and short deliveries
    select 'stock_adjust', a.id, a.requested_at, case a.kind when 'count' then 'Stock count difference' when 'delivery' then 'Short delivery' else 'Stock correction' end,
           i.name || ': ' || public.qty_text(a.qty_before) || ' → ' || public.qty_text(a.qty_after) || ' ' || i.unit || coalesce(' – ' || a.reason, ''), a.requested_by, a.value, null, i.branch_id,
           case a.status when 'to_approve' then 'open' else 'auto' end, coalesce(a.decided_by, case when a.status = 'applied' then a.requested_by end), coalesce(a.decided_at, case when a.status = 'applied' then a.requested_at end),
           case a.status when 'applied' then 'within the limit' when 'rejected' then 'turned down' || coalesce(': ' || a.decision_note, '') else a.decision_note end
    from public.stock_adjustments a join public.items i on i.id = a.item_id where a.requested_at >= p_from
    union all
    -- cash differences at a count
    select 'cash_variance', c.id, c.counted_at, 'Cash count did not match', public.cash_count_text(c) || coalesce(' – ' || c.note, ''), c.counted_by, c.difference, null, f.branch_id,
           case when c.status = 'accepted' then 'auto' when c.status = 'superseded' then 'info' else 'open' end, c.reviewed_by, c.reviewed_at, c.review_note
    from public.cash_counts c join public.floats f on f.id = c.float_id where c.exception and c.counted_at >= p_from
    union all
    -- advances overdue beyond the escalation point
    select 'overdue', r.id, r.disbursed_at + make_interval(days => coalesce(s.advance_escalate_days, 14)), 'Receipt overdue', r.purpose || ' – ' || (current_date - r.disbursed_at::date) || ' days out', r.disbursed_to, r.disbursed_amount, r.id, r.branch_id,
           case when r.status = 'disbursed' then 'open' else 'auto' end, case when r.status <> 'disbursed' then r.disbursed_to end, case when r.status <> 'disbursed' then (select e.spent_at::timestamptz from public.expenses e where e.request_id = r.id) end, case when r.status <> 'disbursed' then 'settled' end
    from public.requests r where r.disbursed_at is not null and r.disbursed_at + make_interval(days => coalesce(s.advance_escalate_days, 14)) <= now()
      and r.disbursed_at >= p_from and (r.status = 'disbursed' or (select e.spent_at from public.expenses e where e.request_id = r.id) > (r.disbursed_at + make_interval(days => coalesce(s.advance_escalate_days, 14)))::date)
    union all
    -- actions taken by a stand-in
    select 'standin', ev.id, ev.created_at, 'Done by a stand-in', ev.action || ' on ' || r.purpose || ' (standing in for ' || p.full_name || ')', ev.actor_id, r.estimated_total, r.id, r.branch_id, 'info', null, null, null
    from public.request_events ev join public.requests r on r.id = ev.request_id
    join public.delegations d on d.to_user = ev.actor_id and (ev.created_at at time zone 'Africa/Windhoek')::date between d.starts_on and d.ends_on
    join public.profiles p on p.id = d.from_user
    where ev.created_at >= p_from and ev.action in ('approved', 'rejected', 'disbursed', 'stock_reviewed', 'proof_confirmed', 'reimbursed', 'payout_undone')
    union all
    -- the schedule, people, stand-ins, branches and device sign-outs
    select 'schedule', v.id, coalesce(v.decided_at, v.proposed_at), 'Schedule changed (version ' || v.version_no || ')', coalesce(v.reason, ''), v.proposed_by, null, null, null, 'info', v.decided_by, v.decided_at, v.decision_note
    from public.schedule_versions v where v.status = 'applied' and coalesce(v.decided_at, v.proposed_at) >= p_from
    union all
    select 'admin', md5('admin' || l.id::text)::uuid, l.at, case l.area when 'people' then 'People: ' when 'standins' then 'Stand-in: ' when 'branches' then 'Branch: ' else l.area || ': ' end || l.action || ' ' || coalesce(l.subject, ''),
           coalesce(l.detail::text, ''), l.actor_id, null, null, null, 'info', null, null, null
    from public.admin_log l where l.at >= p_from
    union all
    select 'signout', md5('signout' || e.id::text)::uuid, e.at, 'Devices signed out', (select full_name from public.profiles where id = e.user_id) || ': ' || coalesce(e.detail->>'count', '?') || ' device(s)', e.actor_id, null, null, null, 'info', null, null, null
    from public.security_events e where e.kind = 'signed_out' and e.actor_id is not null and e.at >= p_from
  )
  select b.kind, b.ref, b.at, b.title, b.detail, b.who, b.amount, b.request_id, b.branch_id,
         case when b.state = 'open' and x.ref is not null then 'reviewed' else b.state end,
         coalesce(x.reviewed_by, b.by_whom), coalesce(x.reviewed_at, b.at2), coalesce(x.note, b.note), x.outcome
  from base b left join public.exception_reviews x on x.kind = b.kind and x.ref = b.ref
  where b.branch_id is null or b.branch_id in (select m.b from mine m)
  order by case when b.state = 'open' and x.ref is null then 0 else 1 end, b.at desc;
end $$;
revoke execute on function public.exceptions_log(date) from public, anon;
grant execute on function public.exceptions_log(date) to authenticated;

/** How many exceptions are open (for the badge, Home and the MD's overview). */
create or replace function public.exceptions_open() returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.exceptions_log(current_date - 365) where state = 'open'
$$;
revoke execute on function public.exceptions_open() from public, anon;
grant execute on function public.exceptions_open() to authenticated;

/* ---------- closed months are locked ---------- */
create or replace function public.lock_closed_float() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_float uuid; v_period date; v_status text;
begin
  if tg_table_name = 'float_transactions' then
    v_float := new.float_id;
    if new.kind in ('shortage', 'surplus') then return new; end if;   -- a month-end count signed off after the close
  elsif tg_table_name = 'requests' then
    if new.disbursed_amount is not distinct from old.disbursed_amount and new.float_id is not distinct from old.float_id and new.disbursed_at is not distinct from old.disbursed_at then return new; end if;
    v_float := coalesce(old.float_id, new.float_id);
  elsif tg_table_name = 'expenses' then
    if new.total is not distinct from old.total and new.spent_at is not distinct from old.spent_at and new.change_returned is not distinct from old.change_returned then return new; end if;
    select float_id into v_float from public.requests where id = new.request_id;
  elsif tg_table_name = 'expense_lines' then
    select r.float_id into v_float from public.expenses e join public.requests r on r.id = e.request_id where e.id = coalesce(new.expense_id, old.expense_id);
  end if;
  if v_float is null then return coalesce(new, old); end if;
  select period, status into v_period, v_status from public.floats where id = v_float;
  if v_status = 'closed' then
    raise exception '% is closed and locked. Record the correction in the current month instead: a return if cash came back, a claim if more was spent.', to_char(v_period, 'Mon YYYY');
  end if;
  return coalesce(new, old);
end $$;
revoke execute on function public.lock_closed_float() from public, anon, authenticated;
create or replace trigger lock_closed_float_tx before insert on public.float_transactions for each row execute function public.lock_closed_float();
create or replace trigger lock_closed_float_req before update on public.requests for each row execute function public.lock_closed_float();
create or replace trigger lock_closed_float_exp before update on public.expenses for each row execute function public.lock_closed_float();
create or replace trigger lock_closed_float_lines before insert or update on public.expense_lines for each row execute function public.lock_closed_float();

/* ---------- the quarterly access review ---------- */
create table if not exists public.access_reviews (
  id uuid primary key default gen_random_uuid(),
  quarter date not null,                 -- first day of the quarter reviewed
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz not null default now(),
  note text,
  snapshot jsonb not null
);
create unique index if not exists access_reviews_quarter_uq on public.access_reviews (quarter);
alter table public.access_reviews enable row level security;
create policy access_reviews_select on public.access_reviews for select to authenticated using (public.has_role('approver'));

/** The list the MD reviews: everyone, their position, branch, last sign-in and devices. */
create or replace function public.access_list()
returns table (user_id uuid, full_name text, email text, role text, branch text, also text, active boolean, last_sign_in timestamptz, devices int)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.email, p.role::text, public.branch_name(p.branch_id),
         (select string_agg(public.branch_name(b), ', ') from unnest(p.extra_branches) b),
         p.active, (select max(at) from public.sign_ins s where s.user_id = p.id),
         (select count(*)::int from public.device_sessions d where d.user_id = p.id)
  from public.profiles p
  where public.has_role('approver')
  order by p.active desc, p.role, p.full_name
$$;
revoke execute on function public.access_list() from public, anon;
grant execute on function public.access_list() to authenticated;

/** This quarter's review: done or due. */
create or replace function public.access_review_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'quarter', date_trunc('quarter', current_date)::date,
    'done', exists (select 1 from public.access_reviews where quarter = date_trunc('quarter', current_date)::date),
    'last', (select jsonb_build_object('quarter', quarter, 'by', reviewed_by, 'at', reviewed_at, 'note', note) from public.access_reviews order by quarter desc limit 1),
    'people', (select count(*) from public.profiles where active))
$$;
grant execute on function public.access_review_status() to authenticated;

create or replace function public.confirm_access_review(p_note text default null) returns public.access_reviews
language plpgsql security definer set search_path = public as $$
declare a public.access_reviews%rowtype; v_q date := date_trunc('quarter', current_date)::date;
begin
  if not public.has_role('managing_director') then raise exception 'The access review is signed off by the Managing Director'; end if;
  insert into public.access_reviews (quarter, reviewed_by, note, snapshot)
  values (v_q, auth.uid(), nullif(btrim(coalesce(p_note, '')), ''), (select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) from public.access_list() l))
  on conflict (quarter) do update set reviewed_by = excluded.reviewed_by, reviewed_at = now(), note = excluded.note, snapshot = excluded.snapshot
  returning * into a;
  perform public.notify_branch_role(null, 'approver', 'access_review', 'Access review signed off for Q' || extract(quarter from v_q) || ' ' || extract(year from v_q),
    (select full_name from public.profiles where id = auth.uid()) || ' confirmed who holds each position' || coalesce(' – “' || a.note || '”', '') || '.', '#/admin', null);
  return a;
end $$;
revoke execute on function public.confirm_access_review(text) from public, anon;
grant execute on function public.confirm_access_review(text) to authenticated;

/** On the first days of a quarter: remind the MD until it is signed off. */
create or replace function public.remind_access_review() returns integer
language plpgsql security definer set search_path = public as $$
declare v_q date := date_trunc('quarter', current_date)::date;
begin
  if auth.uid() is not null and not public.has_role('approver') then raise exception 'Not allowed'; end if;
  if exists (select 1 from public.access_reviews where quarter = v_q) then return 0; end if;
  if exists (select 1 from public.notifications where kind = 'access_review' and created_at > now() - interval '13 days') then return 0; end if;
  perform public.notify_branch_role(null, 'managing_director', 'access_review', 'Quarterly access review due',
    'Confirm who holds each position, that their last sign-in and devices look right, and that nobody who has left still has access. Under Schedule → Access review.', '#/schedule', null);
  return 1;
end $$;
revoke execute on function public.remind_access_review() from public, anon, authenticated;
select cron.schedule('petty-access-review', '10 7 * * *', 'select public.remind_access_review()');

/* ---------- alerts open the right screen ---------- */
create or replace function public.notification_link(p_kind text, p_request uuid) returns text
language sql immutable set search_path = public as $$
  select case
    when p_kind in ('stock_receipt') then '#/stock/deliveries'
    when p_kind in ('stock_adjust') then '#/stock/adjustments'
    when p_kind = 'access_review' then '#/schedule'
    when p_kind = 'exception' then '#/reports/controls'
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

/* ---------- backups every night ---------- */
select cron.alter_job((select jobid from cron.job where jobname = 'petty-backup'), schedule => '0 2 * * *');
