-- 031: "What's new" – every update that affects people is announced to exactly those people:
-- what changes for them, and how to use it. Each announcement becomes an in-app alert (and a push to their phone);
-- the full note lives under More → What's new. Announcements can wait for working hours, the administrator sees
-- who has read them, and a scheduled one can be cancelled until it goes out. Updates are never emailed.

create table if not exists public.updates (
  id uuid primary key default gen_random_uuid(),
  release text not null,                       -- groups the notes of one update, e.g. '2 Nov 2026 · What's new'
  title text not null,
  impact text not null,                        -- what changes for the people it goes to
  steps text[] not null default '{}',          -- how to use it, step by step
  link text,                                   -- "Show me": the screen it is about
  link_label text,
  roles public.user_role[] not null default '{}',   -- empty = every role
  branches uuid[] not null default '{}',            -- empty = every branch
  users uuid[] not null default '{}',               -- these people as well, whatever their role or branch
  send_at timestamptz not null default now(),
  status text not null default 'scheduled' check (status in ('scheduled', 'sent', 'cancelled')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  cancelled_by uuid references public.profiles(id),
  cancelled_at timestamptz
);
create index if not exists updates_due on public.updates (send_at) where status = 'scheduled';

create table if not exists public.update_recipients (
  update_id uuid not null references public.updates(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  delivered_at timestamptz not null default now(),
  seen_at timestamptz,
  primary key (update_id, user_id)
);
create index if not exists update_recipients_user on public.update_recipients (user_id, seen_at);

alter table public.updates enable row level security;
alter table public.update_recipients enable row level security;
-- people read the notes sent to them; the administrator and the MD read all of them
create policy updates_select on public.updates for select to authenticated using (
  public.my_role() in ('approver', 'managing_director')
  or (status = 'sent' and exists (select 1 from public.update_recipients r where r.update_id = updates.id and r.user_id = auth.uid())));
create policy update_recipients_select on public.update_recipients for select to authenticated using (
  user_id = auth.uid() or public.my_role() in ('approver', 'managing_director'));
revoke insert, update, delete on public.updates, public.update_recipients from anon, authenticated;

-- the next working morning in the organisation's time zone (08:00, Monday to Friday)
create or replace function public.next_working_morning(p_hour int default 8) returns timestamptz
language plpgsql stable set search_path = public as $$
declare v_local timestamp := now() at time zone public.app_tz(); v_day date := v_local::date;
begin
  if v_local::time >= make_time(p_hour, 0, 0) then v_day := v_day + 1; end if;
  while extract(isodow from v_day) > 5 loop v_day := v_day + 1; end loop;
  return (v_day + make_time(p_hour, 0, 0)) at time zone public.app_tz();
end $$;

-- send the announcements that are due: work out who they are for, record them, alert each person
create or replace function public.dispatch_updates() returns int
language plpgsql security definer set search_path = public as $$
declare u public.updates%rowtype; n int := 0;
begin
  for u in select * from public.updates where status = 'scheduled' and send_at <= now() order by send_at for update skip locked loop
    insert into public.update_recipients (update_id, user_id)
    select u.id, p.id from public.profiles p
    where p.active and (
      ((cardinality(u.roles) = 0 or p.role = any (u.roles))
        and (cardinality(u.branches) = 0 or p.branch_id = any (u.branches) or coalesce(p.extra_branches, '{}') && u.branches)
        and (cardinality(u.roles) > 0 or cardinality(u.branches) > 0 or cardinality(u.users) = 0))
      or p.id = any (u.users))
    on conflict do nothing;
    -- an in-app alert, pushed to their phones; never emailed (marked as handled for the email digest)
    insert into public.notifications (user_id, kind, title, body, link, emailed_at, email_status)
    select r.user_id, 'update', 'What''s new: ' || u.title, u.impact, '#/updates/' || u.id, now(), 'in_app_only'
    from public.update_recipients r where r.update_id = u.id;
    update public.updates set status = 'sent', sent_at = now() where id = u.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.dispatch_updates() from public, anon, authenticated;

-- announce an update (Tuvana runs this when releasing; send_at null = straight away)
create or replace function public.announce_update(p_release text, p_title text, p_impact text, p_steps text[] default '{}',
  p_link text default null, p_link_label text default null, p_roles public.user_role[] default '{}', p_branches uuid[] default '{}',
  p_users uuid[] default '{}', p_send_at timestamptz default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if coalesce(btrim(p_title), '') = '' or coalesce(btrim(p_impact), '') = '' then raise exception 'An update needs a title and what changes'; end if;
  insert into public.updates (release, title, impact, steps, link, link_label, roles, branches, users, send_at)
  values (p_release, p_title, p_impact, coalesce(p_steps, '{}'), p_link, p_link_label, coalesce(p_roles, '{}'), coalesce(p_branches, '{}'), coalesce(p_users, '{}'), coalesce(p_send_at, now()))
  returning id into v_id;
  if coalesce(p_send_at, now()) <= now() then perform public.dispatch_updates(); end if;
  return v_id;
end $$;
revoke execute on function public.announce_update(text, text, text, text[], text, text, public.user_role[], uuid[], uuid[], timestamptz) from public, anon, authenticated;

-- my notes, newest first, with whether I have read them
create or replace function public.my_updates() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'release', u.release, 'title', u.title, 'impact', u.impact, 'steps', to_jsonb(u.steps),
    'link', u.link, 'link_label', u.link_label, 'sent_at', u.sent_at, 'seen_at', r.seen_at) order by u.sent_at desc, u.title), '[]'::jsonb)
  from public.update_recipients r join public.updates u on u.id = r.update_id
  where r.user_id = auth.uid() and u.status = 'sent'
$$;
grant execute on function public.my_updates() to authenticated;

-- read: the note and its alert both count as seen
create or replace function public.mark_update_seen(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.update_recipients set seen_at = now() where user_id = auth.uid() and update_id = any (p_ids) and seen_at is null;
  get diagnostics n = row_count;
  update public.notifications set read_at = now() where user_id = auth.uid() and kind = 'update' and read_at is null
    and link = any (select '#/updates/' || x from unnest(p_ids) x);
  return n;
end $$;
grant execute on function public.mark_update_seen(uuid[]) to authenticated;

-- for the administrator: every announcement, who it went to and who has read it
create or replace function public.update_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.my_role() not in ('approver', 'managing_director') then '[]'::jsonb else
    coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'release', u.release, 'title', u.title, 'impact', u.impact, 'status', u.status,
      'send_at', u.send_at, 'sent_at', u.sent_at, 'roles', to_jsonb(u.roles), 'users', to_jsonb(u.users), 'branches', to_jsonb(u.branches),
      'recipients', (select count(*) from public.update_recipients r where r.update_id = u.id),
      'seen', (select count(*) from public.update_recipients r where r.update_id = u.id and r.seen_at is not null),
      'not_seen', (select coalesce(jsonb_agg(p.full_name order by p.full_name), '[]'::jsonb) from public.update_recipients r join public.profiles p on p.id = r.user_id
                   where r.update_id = u.id and r.seen_at is null))
      order by coalesce(u.sent_at, u.send_at) desc), '[]'::jsonb) end
  from public.updates u where u.status <> 'cancelled' or u.cancelled_at > now() - interval '30 days'
$$;
grant execute on function public.update_status() to authenticated;

-- the administrator may stop an announcement that has not gone out yet
create or replace function public.cancel_update(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() <> 'approver' then raise exception 'Only the administrator can cancel an update'; end if;
  update public.updates set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now() where id = p_id and status = 'scheduled';
  if not found then raise exception 'This update has already gone out or was cancelled'; end if;
end $$;
grant execute on function public.cancel_update(uuid) to authenticated;

-- an update alert opens its note
create or replace function public.notification_link(p_kind text, p_request uuid) returns text
language sql immutable set search_path = public as $$
  select case
    when p_request is not null then '#/requests/' || p_request
    when p_kind in ('cash_count', 'cash_count_due', 'top_up', 'float_warning', 'month_close', 'pack_review', 'pack_sent') then '#/cash'
    when p_kind = 'schedule' then '#/schedule'
    when p_kind in ('stock_report', 'stock_report_resolved', 'weekly_count', 'price_jump') then '#/stock'
    when p_kind = 'weekly_digest' then '#/reports'
    when p_kind = 'security' then '#/account?devices=1'
    when p_kind = 'account_ready' then '#/admin'
    when p_kind = 'update' then '#/updates'
    else '#/home'
  end
$$;

-- scheduled announcements go out within ten minutes of their time
select cron.schedule('petty-updates', '*/10 * * * *', 'select public.dispatch_updates()');
