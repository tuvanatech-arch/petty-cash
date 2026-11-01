-- 033: people say whether a note was clear (thumbs up/down, optional comment), and the administrator writes
-- notices of their own from Admin → Updates, delivered exactly like a software update.

alter table public.update_recipients add column if not exists clear boolean;
alter table public.update_recipients add column if not exists comment text;
alter table public.update_recipients add column if not exists rated_at timestamptz;
alter table public.updates add column if not exists created_by uuid references public.profiles(id);   -- null = Tuvana (a software update)

-- "Was this clear?" on a note I received
create or replace function public.rate_update(p_id uuid, p_clear boolean, p_comment text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.update_recipients set clear = p_clear, comment = nullif(btrim(coalesce(p_comment, '')), ''), rated_at = now()
   where update_id = p_id and user_id = auth.uid();
  if not found then raise exception 'This note was not sent to you'; end if;
end $$;
grant execute on function public.rate_update(uuid, boolean, text) to authenticated;

-- the administrator's own notice: same delivery as an update (alert, pop-up, What's new), their name on it
create or replace function public.announce_notice(p_title text, p_impact text, p_steps text[] default '{}', p_link text default null,
  p_roles public.user_role[] default '{}', p_branches uuid[] default '{}', p_users uuid[] default '{}', p_send_at timestamptz default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; me public.profiles%rowtype;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null or not me.active or me.role <> 'approver' then raise exception 'Only the administrator can send a notice'; end if;
  if coalesce(btrim(p_title), '') = '' or coalesce(btrim(p_impact), '') = '' then raise exception 'A notice needs a title and a message'; end if;
  if length(p_title) > 80 then raise exception 'Keep the title under 80 characters'; end if;
  insert into public.updates (release, title, impact, steps, link, link_label, roles, branches, users, send_at, created_by)
  values ('Notice from ' || coalesce(me.full_name, 'the administrator'), btrim(p_title), btrim(p_impact),
          coalesce((select array_agg(btrim(s)) from unnest(coalesce(p_steps, '{}')) s where btrim(s) <> ''), '{}'),
          nullif(btrim(coalesce(p_link, '')), ''), case when nullif(btrim(coalesce(p_link, '')), '') is null then null else 'Show me' end,
          coalesce(p_roles, '{}'), coalesce(p_branches, '{}'), coalesce(p_users, '{}'), coalesce(p_send_at, now()), me.id)
  returning id into v_id;
  if coalesce(p_send_at, now()) <= now() then perform public.dispatch_updates(); end if;
  return v_id;
end $$;
grant execute on function public.announce_notice(text, text, text[], text, public.user_role[], uuid[], uuid[], timestamptz) to authenticated;

-- a notice from the administrator reads "Notice: …", a software update "What's new: …"
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
    insert into public.notifications (user_id, kind, title, body, link, emailed_at, email_status)
    select r.user_id, 'update', case when u.created_by is null then 'What''s new: ' else 'Notice: ' end || u.title, u.impact, '#/updates/' || u.id, now(), 'in_app_only'
    from public.update_recipients r where r.update_id = u.id;
    update public.updates set status = 'sent', sent_at = now() where id = u.id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.my_updates() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'release', u.release, 'title', u.title, 'impact', u.impact, 'steps', to_jsonb(u.steps),
    'link', u.link, 'link_label', u.link_label, 'tour', u.tour, 'image', u.image, 'sent_at', u.sent_at, 'seen_at', r.seen_at,
    'notice', u.created_by is not null, 'from', (select full_name from public.profiles where id = u.created_by), 'clear', r.clear, 'comment', r.comment) order by u.sent_at desc, u.title), '[]'::jsonb)
  from public.update_recipients r join public.updates u on u.id = r.update_id
  where r.user_id = auth.uid() and u.status = 'sent'
$$;

-- the administrator's view now carries the feedback
create or replace function public.update_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.my_role() not in ('approver', 'managing_director') then '[]'::jsonb else
    coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'release', u.release, 'title', u.title, 'impact', u.impact, 'status', u.status,
      'send_at', u.send_at, 'sent_at', u.sent_at, 'roles', to_jsonb(u.roles), 'users', to_jsonb(u.users), 'branches', to_jsonb(u.branches),
      'notice', u.created_by is not null,
      'recipients', (select count(*) from public.update_recipients r where r.update_id = u.id),
      'seen', (select count(*) from public.update_recipients r where r.update_id = u.id and r.seen_at is not null),
      'clear', (select count(*) from public.update_recipients r where r.update_id = u.id and r.clear),
      'unclear', (select count(*) from public.update_recipients r where r.update_id = u.id and r.clear = false),
      'comments', (select coalesce(jsonb_agg(jsonb_build_object('who', p.full_name, 'clear', r.clear, 'text', r.comment) order by r.rated_at), '[]'::jsonb)
                   from public.update_recipients r join public.profiles p on p.id = r.user_id where r.update_id = u.id and r.comment is not null),
      'not_seen', (select coalesce(jsonb_agg(p.full_name order by p.full_name), '[]'::jsonb) from public.update_recipients r join public.profiles p on p.id = r.user_id
                   where r.update_id = u.id and r.seen_at is null))
      order by coalesce(u.sent_at, u.send_at) desc), '[]'::jsonb) end
  from public.updates u where u.status <> 'cancelled' or u.cancelled_at > now() - interval '30 days'
$$;

-- for Tuvana at the start of a session: what people said about recent notes
create or replace function public.update_feedback(p_days int default 30) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('title', u.title, 'who', p.full_name, 'role', p.role, 'clear', r.clear, 'comment', r.comment, 'at', r.rated_at) order by r.rated_at desc), '[]'::jsonb)
  from public.update_recipients r join public.updates u on u.id = r.update_id join public.profiles p on p.id = r.user_id
  where r.rated_at > now() - make_interval(days => p_days) and (public.my_role() in ('approver', 'managing_director') or auth.uid() is null)
$$;
revoke execute on function public.update_feedback(int) from public, anon;
grant execute on function public.update_feedback(int) to authenticated;
