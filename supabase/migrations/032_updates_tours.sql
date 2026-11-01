-- 032: updates get a picture and a guided walk-through, and people who have not read a note about their own
-- duties get one reminder after three working days.

alter table public.updates add column if not exists tour jsonb not null default '[]'::jsonb;   -- [{at, css, text, say}]
alter table public.updates add column if not exists image text;                               -- path of a picture in the app, e.g. updates/deliveries.png
alter table public.update_recipients add column if not exists reminded_at timestamptz;

-- the picture and the walk-through of a note (set when announcing, or any time before it goes out)
create or replace function public.set_update_extras(p_id uuid, p_tour jsonb default null, p_image text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_tour is not null and jsonb_typeof(p_tour) <> 'array' then raise exception 'The walk-through must be a list of steps'; end if;
  update public.updates set tour = coalesce(p_tour, tour), image = coalesce(p_image, image) where id = p_id;
  if not found then raise exception 'Update not found'; end if;
end $$;
revoke execute on function public.set_update_extras(uuid, jsonb, text) from public, anon, authenticated;

create or replace function public.my_updates() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'release', u.release, 'title', u.title, 'impact', u.impact, 'steps', to_jsonb(u.steps),
    'link', u.link, 'link_label', u.link_label, 'tour', u.tour, 'image', u.image, 'sent_at', u.sent_at, 'seen_at', r.seen_at) order by u.sent_at desc, u.title), '[]'::jsonb)
  from public.update_recipients r join public.updates u on u.id = r.update_id
  where r.user_id = auth.uid() and u.status = 'sent'
$$;

-- a note about someone's own duties (sent to their role) still unread after three working days: one reminder, at 10 in the morning
create or replace function public.remind_unread_updates() returns int
language plpgsql security definer set search_path = public as $$
declare v_local timestamp := now() at time zone public.app_tz(); n int := 0; r record;
begin
  if extract(isodow from v_local) > 5 or extract(hour from v_local) <> 10 then return 0; end if;
  for r in
    select rc.update_id, rc.user_id, u.title
    from public.update_recipients rc join public.updates u on u.id = rc.update_id join public.profiles p on p.id = rc.user_id
    where u.status = 'sent' and cardinality(u.roles) > 0 and rc.seen_at is null and rc.reminded_at is null and p.active
      and u.sent_at < now() - interval '3 days'
      and (select count(*) from generate_series(u.sent_at::date + 1, v_local::date - 1, '1 day') d where extract(isodow from d) <= 5) >= 3
  loop
    insert into public.notifications (user_id, kind, title, body, link, emailed_at, email_status)
    values (r.user_id, 'update', 'Still to read – what''s new: ' || r.title, 'A change to how you work in Petti is waiting for you under What''s new. It takes a minute.', '#/updates/' || r.update_id, now(), 'in_app_only');
    update public.update_recipients set reminded_at = now() where update_id = r.update_id and user_id = r.user_id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.remind_unread_updates() from public, anon, authenticated;
select cron.schedule('petty-update-reminders', '5 * * * *', 'select public.remind_unread_updates()');
