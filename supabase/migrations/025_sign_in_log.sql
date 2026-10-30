-- 025: a sign-in log for the administrator. One row per sign-in (a new session), with the device and the
-- approximate place from the internet address, and what was unusual about it. Device sessions disappear when
-- someone signs out; this log stays (12 months).

create table if not exists public.sign_ins (
  session_id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  at timestamptz not null default now(),
  label text, user_agent text, ip inet, country text, place text, approx boolean not null default false,
  flags text[] not null default '{}'
);
create index if not exists sign_ins_at_idx on public.sign_ins (at desc);
create index if not exists sign_ins_user_idx on public.sign_ins (user_id, at desc);
alter table public.sign_ins enable row level security;
create policy sign_ins_select on public.sign_ins for select to authenticated using (user_id = auth.uid() or public.has_role('approver'));

-- a new device session is a sign-in; anything already flagged for it comes along
create or replace function public.sign_ins_from_session() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.sign_ins (session_id, user_id, at, label, user_agent, ip, country, place, approx, flags)
  values (new.session_id, new.user_id, coalesce((select created_at from auth.sessions where id = new.session_id), new.first_seen),
          new.label, new.user_agent, new.ip, new.country, new.place, new.approx,
          coalesce((select array_agg(distinct kind) from public.security_events where session_id = new.session_id), '{}'))
  on conflict (session_id) do nothing;
  return new;
exception when others then return new;
end $$;
revoke execute on function public.sign_ins_from_session() from public, anon, authenticated;
create or replace trigger sign_ins_from_session after insert on public.device_sessions
  for each row execute function public.sign_ins_from_session();

-- something unusual found later on the same sign-in (e.g. far-apart use) is added to it
create or replace function public.sign_ins_flag() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.session_id is not null and new.kind in ('new_device', 'new_country', 'far_apart') then
    update public.sign_ins set flags = array_append(flags, new.kind) where session_id = new.session_id and not (new.kind = any(flags));
  end if;
  return new;
exception when others then return new;
end $$;
revoke execute on function public.sign_ins_flag() from public, anon, authenticated;
create or replace trigger sign_ins_flag after insert on public.security_events
  for each row execute function public.sign_ins_flag();

-- what is known so far
insert into public.sign_ins (session_id, user_id, at, label, user_agent, ip, country, place, approx, flags)
select d.session_id, d.user_id, coalesce(s.created_at, d.first_seen), d.label, d.user_agent, d.ip, d.country, d.place, d.approx,
       coalesce((select array_agg(distinct kind) from public.security_events e where e.session_id = d.session_id), '{}')
from public.device_sessions d left join auth.sessions s on s.id = d.session_id
on conflict (session_id) do nothing;

-- the log as the administrator sees it: who, when, device, place, unusual, and whether still signed in
create or replace function public.sign_in_log(p_from timestamptz default now() - interval '30 days')
returns table (session_id uuid, user_id uuid, person text, role text, at timestamptz, label text, place text, country text, approx boolean,
               ip text, flags text[], signed_in boolean, last_seen timestamptz, current_place text)
language sql stable security definer set search_path = public as $$
  select l.session_id, l.user_id, p.full_name, p.role::text, l.at, l.label, l.place, l.country, l.approx, host(l.ip), l.flags,
         d.session_id is not null, d.last_seen, d.place
  from public.sign_ins l
  join public.profiles p on p.id = l.user_id
  left join public.device_sessions d on d.session_id = l.session_id
  where public.has_role('approver') and l.at >= p_from
  order by l.at desc
  limit 1000
$$;
revoke execute on function public.sign_in_log(timestamptz) from public, anon;
grant execute on function public.sign_in_log(timestamptz) to authenticated;

-- kept for 12 months
create or replace function public.prune_sign_ins() returns void
language sql security definer set search_path = public as $$
  delete from public.sign_ins where at < now() - interval '12 months';
$$;
revoke execute on function public.prune_sign_ins() from public, anon, authenticated;
select cron.schedule('prune_sign_ins', '35 3 * * *', 'select public.prune_sign_ins()');
