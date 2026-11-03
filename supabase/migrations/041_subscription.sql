-- 041: the company's Petti subscription: its plan's limits, and cancelling.
--
-- Plan: how many people (accounts switched on) and branches the company may have. When the plan is full, Petti will
-- not switch on another person or branch until Tuvana Tech upgrades it. A plan of null means no plan set yet: no
-- limits and nothing shown (a client whose terms are still being agreed). Tuvana Tech sets the plan; the client cannot.
-- Cancelling: the administrator (the GM) cancels in Petti after being offered a download of everything. Nothing is
-- billed after that; Petti stays open for 30 days and can be kept within them; on the 30th day Tuvana Tech removes the
-- company's Petti, its files and its backup copies for good. The daily health check tells Tuvana Tech on the day of
-- cancelling and on the day removal is due.

create table if not exists public.subscription (
  id int primary key default 1 check (id = 1),
  plan text check (plan in ('starter', 'business', 'group')),
  people_limit int check (people_limit > 0),
  branch_limit int check (branch_limit > 0),
  status text not null default 'active' check (status in ('trial', 'active', 'cancelled')),
  trial_ends date,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id),
  remove_on date,
  updated_at timestamptz not null default now()
);
insert into public.subscription (id) values (1) on conflict (id) do nothing;
alter table public.subscription enable row level security;
create policy subscription_read on public.subscription for select to authenticated using (true);
create policy two_step_required on public.subscription as restrictive for all to authenticated
  using (not (select public.two_step_blocked())) with check (not (select public.two_step_blocked()));
-- no write rules: only Tuvana Tech (directly) and the two functions below change it

/** Where the company stands: its plan, places used, and whether it is cancelled. Anyone signed in may read it. */
create or replace function public.plan_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'plan', s.plan,
    'plan_label', case s.plan when 'starter' then 'Starter' when 'business' then 'Business' when 'group' then 'Group' end,
    'people_limit', s.people_limit,
    'people_used', (select count(*) from public.profiles where active),
    'branch_limit', s.branch_limit,
    'branches_used', (select count(*) from public.branches where active),
    'can_add_person', s.people_limit is null or (select count(*) from public.profiles where active) < s.people_limit,
    'can_add_branch', s.branch_limit is null or (select count(*) from public.branches where active) < s.branch_limit,
    'status', s.status,
    'trial_ends', s.trial_ends,
    'cancelled_at', s.cancelled_at,
    'cancelled_by', (select full_name from public.profiles where id = s.cancelled_by),
    'remove_on', s.remove_on,
    'support_phone', '+264 81 495 0605')
  from public.subscription s where s.id = 1
$$;
revoke execute on function public.plan_status() from public, anon;
grant execute on function public.plan_status() to authenticated, service_role;

/** The plan's limits, enforced wherever an account or a branch is switched on. */
create or replace function public.plan_people_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_limit int;
begin
  if not new.active or (tg_op = 'UPDATE' and old.active) then return new; end if;
  select people_limit into v_limit from public.subscription where id = 1;
  if v_limit is not null and (select count(*) from public.profiles where active and id <> new.id) >= v_limit then
    raise exception 'Your plan allows % people and all the places are taken. Switch off someone who has left, or call Tuvana Tech on +264 81 495 0605 to upgrade.', v_limit;
  end if;
  return new;
end $$;
create or replace trigger profiles_plan_guard before insert or update of active on public.profiles for each row execute function public.plan_people_guard();

create or replace function public.plan_branch_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_limit int;
begin
  if not new.active or (tg_op = 'UPDATE' and old.active) then return new; end if;
  select branch_limit into v_limit from public.subscription where id = 1;
  if v_limit is not null and (select count(*) from public.branches where active and id <> new.id) >= v_limit then
    raise exception 'Your plan allows % %. Call Tuvana Tech on +264 81 495 0605 to upgrade.', v_limit, case when v_limit = 1 then 'branch' else 'branches' end;
  end if;
  return new;
end $$;
create or replace trigger branches_plan_guard before insert or update of active on public.branches for each row execute function public.plan_branch_guard();

/** Cancel, by the administrator, who types the company name to confirm. Finance, the GM and the MD are told. */
create or replace function public.cancel_subscription(p_confirm text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_org text; v_on date; p record;
begin
  if public.my_role() is distinct from 'approver' then raise exception 'Only the administrator can cancel Petti'; end if;
  if (select plan from public.subscription where id = 1) is null then raise exception 'There is no subscription to cancel yet. Call Tuvana Tech on +264 81 495 0605.'; end if;
  select org_name into v_org from public.settings where id = 1;
  if lower(btrim(coalesce(p_confirm, ''))) <> lower(btrim(v_org)) then raise exception 'Type the company name exactly as shown to confirm'; end if;
  update public.subscription set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), remove_on = current_date + 30, updated_at = now()
   where id = 1 and status <> 'cancelled' returning remove_on into v_on;
  if v_on is null then raise exception 'Petti is already cancelled'; end if;
  for p in select id from public.profiles where active and role in ('finance', 'approver', 'managing_director') loop
    perform public.notify_user(p.id, 'subscription', 'Petti has been cancelled',
      format('%s cancelled Petti for %s. Everything is removed for good on %s: download what you need before then.', (select full_name from public.profiles where id = auth.uid()), v_org, to_char(v_on, 'FMDD Mon YYYY')),
      '#/admin/settings');
  end loop;
  return public.plan_status();
end $$;
revoke execute on function public.cancel_subscription(text) from public, anon;
grant execute on function public.cancel_subscription(text) to authenticated;

/** Keep Petti after all, any time before the removal date. */
create or replace function public.keep_subscription() returns jsonb
language plpgsql security definer set search_path = public as $$
declare p record;
begin
  if public.my_role() is distinct from 'approver' then raise exception 'Only the administrator can keep Petti'; end if;
  update public.subscription set status = 'active', cancelled_at = null, cancelled_by = null, remove_on = null, updated_at = now()
   where id = 1 and status = 'cancelled' and remove_on > current_date;
  if not found then raise exception 'Petti is not cancelled, or the removal date has passed'; end if;
  for p in select id from public.profiles where active and role in ('finance', 'approver', 'managing_director') loop
    perform public.notify_user(p.id, 'subscription', 'Petti is staying', format('%s cancelled the cancellation. Nothing will be removed.', (select full_name from public.profiles where id = auth.uid())), '#/admin/settings');
  end loop;
  return public.plan_status();
end $$;
revoke execute on function public.keep_subscription() from public, anon;
grant execute on function public.keep_subscription() to authenticated;

-- the daily health check: tell Tuvana Tech the day a client cancels, and when its removal is due
create or replace function public.health_report(p_hours int default 26) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb := '[]'::jsonb; r record; v_backup timestamptz; v_files int; v_http int; v_errors int; v_short boolean; v_since timestamptz := now() - make_interval(hours => p_hours);
  v_off record; v_off_ok timestamptz; v_sub public.subscription;
begin
  for r in select j.jobname, count(*) as n, max(d.start_time) as last_at, (array_agg(left(d.return_message, 200) order by d.start_time desc))[1] as msg
           from cron.job_run_details d join cron.job j on j.jobid = d.jobid
           where d.start_time > v_since and d.status = 'failed' group by j.jobname loop
    v := v || jsonb_build_object('problem', 'Scheduled job failed: ' || r.jobname, 'times', r.n, 'last', r.last_at, 'detail', r.msg);
  end loop;
  select max(created_at), count(*) filter (where created_at > v_since) into v_backup, v_files from storage.objects where bucket_id = 'backups';
  if v_backup is null or v_backup < v_since then
    v := v || jsonb_build_object('problem', 'No nightly copy of the records in the last day', 'last', v_backup);
  end if;
  -- a copy with fewer files than the one before means a table could not be copied
  with runs as (select split_part(name, '/', 1) as run, count(*) as n from storage.objects where bucket_id = 'backups' group by 1 order by 1 desc limit 2)
  select coalesce((array_agg(n order by run desc))[1] < (array_agg(n order by run desc))[2], false) into v_short from runs;
  if v_short then v := v || jsonb_build_object('problem', 'The last nightly copy is missing some tables'); end if;
  -- the copy at the other company (quiet until it has been set up and has run once)
  select * into v_off from public.offsite_runs order by id desc limit 1;
  if found then
    select max(finished_at) into v_off_ok from public.offsite_runs where error is null and finished_at is not null;
    if v_off.error is not null and v_off.started_at > v_since then
      v := v || jsonb_build_object('problem', 'The copy to Backblaze failed', 'last', v_off.started_at, 'detail', left(v_off.error, 200));
    elsif v_off_ok is null or v_off_ok < now() - interval '50 hours' then
      v := v || jsonb_build_object('problem', 'No copy sent to Backblaze in the last two days', 'last', v_off_ok);
    end if;
    if exists (select 1 from public.offsite_runs where restore_ok = false and started_at > v_since) then
      v := v || jsonb_build_object('problem', 'The practice restore of the copy failed',
        'detail', (select left(restore_note, 200) from public.offsite_runs where restore_ok = false order by id desc limit 1));
    end if;
  end if;
  -- the subscription: cancelled today, or due for removal
  select * into v_sub from public.subscription where id = 1;
  if v_sub.status = 'cancelled' and v_sub.cancelled_at > v_since then
    v := v || jsonb_build_object('problem', 'The client cancelled Petti', 'last', v_sub.cancelled_at,
      'detail', format('Stop billing. Its records are to be removed on %s.', v_sub.remove_on));
  end if;
  if v_sub.status = 'cancelled' and v_sub.remove_on <= current_date then
    v := v || jsonb_build_object('problem', 'Removal is due for a cancelled client',
      'detail', format('Cancelled on %s. Remove its Supabase project and empty its Backblaze bucket.', v_sub.cancelled_at::date));
  end if;
  select count(*) into v_http from net._http_response where created > v_since and (status_code >= 400 or error_msg is not null);
  if v_http > 0 then v := v || jsonb_build_object('problem', 'Calls to Petti''s server functions failed', 'times', v_http); end if;
  select count(*) into v_errors from public.client_logs where level = 'error' and at > v_since;
  if v_errors >= 10 then v := v || jsonb_build_object('problem', 'Many errors reported by phones', 'times', v_errors); end if;
  return jsonb_build_object('checked_at', now(), 'ok', jsonb_array_length(v) = 0, 'problems', v,
    'last_backup', v_backup, 'backup_files', v_files, 'phone_errors', v_errors,
    'offsite_last', v_off_ok, 'offsite_restore_ok', (select restore_ok from public.offsite_runs where restore_ok is not null order by id desc limit 1),
    'subscription', jsonb_build_object('plan', v_sub.plan, 'status', v_sub.status, 'remove_on', v_sub.remove_on));
end $$;
revoke execute on function public.health_report(int) from public, anon, authenticated;
grant execute on function public.health_report(int) to service_role;
