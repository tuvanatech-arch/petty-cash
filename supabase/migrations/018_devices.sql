-- 018: signed-in devices.
-- Everyone sees which devices are signed in to their account and can sign out any or all of them; the admin sees
-- everyone's. A new device, a new country, or the account used in two places too far apart for the time between them
-- raises an alert. A device that is signed out loses access on its next request, not when its token runs out.

-- link-preview robots (WhatsApp, Facebook, Telegram…) open links and can end up holding a sign-in; they are not devices
create or replace function public.is_link_preview(p_ua text) returns boolean language sql immutable as $$
  select coalesce(p_ua, '') ~* '^(WhatsApp|facebookexternalhit|TelegramBot|Slackbot|Twitterbot|LinkedInBot|SkypeUriPreview|Iframely|Embedly)|Discordbot|Googlebot|bingbot|Applebot'
$$;

create or replace function public.km_between(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371 * asin(least(1, sqrt(power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2))))
$$;

-- where an internet address is, as looked up by the devices function (kept 30 days; only the function reads it)
create table if not exists public.ip_places (
  ip inet primary key,
  country text, country_name text, region text, city text,
  lat double precision, lon double precision,
  org text, approx boolean not null default false,
  source text, looked_up_at timestamptz not null default now()
);
alter table public.ip_places enable row level security;

-- what each signed-in session last reported: which device, and where it was
create table if not exists public.device_sessions (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  label text, user_agent text, tz text, standalone boolean,
  ip inet, country text, place text, lat double precision, lon double precision, approx boolean not null default false,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index if not exists device_sessions_user_idx on public.device_sessions (user_id, last_seen desc);
alter table public.device_sessions enable row level security;

-- the countries each person has used the app from (for "first use from a new country")
create table if not exists public.user_places (
  user_id uuid not null references public.profiles(id) on delete cascade,
  country text not null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (user_id, country)
);
alter table public.user_places enable row level security;

-- the security log: new devices, new countries, far-apart use, sign-outs
create table if not exists public.security_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid,
  kind text not null,
  detail jsonb,
  actor_id uuid references public.profiles(id) on delete set null,
  at timestamptz not null default now()
);
create index if not exists security_events_user_idx on public.security_events (user_id, at desc);
alter table public.security_events enable row level security;
create policy security_events_select on public.security_events for select to authenticated using (user_id = auth.uid() or public.my_role() = 'approver');

-- a phone's alerts belong to its sign-in: signing that device out also stops its alerts
alter table public.push_subscriptions add column if not exists session_id uuid references auth.sessions(id) on delete cascade;
create index if not exists push_subscriptions_session_idx on public.push_subscriptions (session_id);

-- ---------- check-in (called by the devices function with the address already looked up) ----------
create or replace function public.record_checkin(p_user uuid, p_session uuid, p_where jsonb, p_device jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me public.profiles%rowtype;
  s_created timestamptz;
  is_new boolean;
  d record;
  v_lat double precision := nullif(p_where->>'lat', '')::double precision;
  v_lon double precision := nullif(p_where->>'lon', '')::double precision;
  v_approx boolean := coalesce((p_where->>'approx')::boolean, false);
  v_country text := upper(nullif(p_where->>'country', ''));
  v_country_name text := coalesce(nullif(p_where->>'country_name', ''), v_country);
  v_place text := coalesce(nullif(p_where->>'place', ''), v_country_name);
  v_label text := left(coalesce(nullif(p_device->>'label', ''), 'A device'), 80);
  km double precision; hrs double precision;
  far_km double precision := 0; far_place text; far_label text; far_mins int; far_same boolean;
  pair text;
  others int;
  new_country boolean := false;
  kinds text[] := array[]::text[];
  t text; b text; ago text;
  link_me text := '#/account?devices=1';
begin
  select * into me from public.profiles where id = p_user;
  if not found or not me.active then return jsonb_build_object('ok', false, 'reason', 'inactive'); end if;
  select created_at into s_created from auth.sessions where id = p_session and user_id = p_user;
  if not found then return jsonb_build_object('ok', false, 'reason', 'signed_out'); end if;
  is_new := not exists (select 1 from public.device_sessions where session_id = p_session);

  -- two places too far apart for the time between them (this device's last place, or another device of the same person)
  if v_lat is not null and v_lon is not null and not v_approx then
    for d in select x.session_id, x.place, x.label, x.lat, x.lon, x.last_seen from public.device_sessions x
             where x.user_id = p_user and x.lat is not null and not x.approx and x.last_seen > now() - interval '12 hours' loop
      km := public.km_between(d.lat, d.lon, v_lat, v_lon);
      hrs := greatest(extract(epoch from now() - d.last_seen) / 3600, 0.05);
      if km > 300 and km / hrs > 800 and km > far_km then
        far_km := km; far_place := d.place; far_label := d.label; far_mins := round(extract(epoch from now() - d.last_seen) / 60); far_same := d.session_id = p_session;
      end if;
    end loop;
  end if;
  -- no coordinates: two countries within the hour counts too
  if far_km = 0 and v_country is not null then
    select x.place, x.label, x.session_id = p_session, round(extract(epoch from now() - x.last_seen) / 60)
      into far_place, far_label, far_same, far_mins
      from public.device_sessions x
     where x.user_id = p_user and x.country is not null and x.country <> v_country and x.last_seen > now() - interval '1 hour'
     order by x.last_seen desc limit 1;
    if found then far_km := -1; end if;
  end if;
  if far_km <> 0 then
    pair := least(coalesce(far_place, '?'), v_place) || ' | ' || greatest(coalesce(far_place, '?'), v_place);
    -- the same two places at most once a month (a phone on a roaming SIM keeps showing its home country)
    if exists (select 1 from public.security_events e where e.user_id = p_user and e.kind = 'far_apart' and e.detail->>'pair' = pair and e.at > now() - interval '30 days') then
      far_km := 0;
    end if;
  end if;

  -- a new country for this person (once they have a history)
  if v_country is not null then
    new_country := exists (select 1 from public.user_places where user_id = p_user)
      and not exists (select 1 from public.user_places where user_id = p_user and country = v_country and last_seen > now() - interval '30 days');
  end if;

  -- a fresh sign-in on a new device while other devices are signed in (they get the buzz)
  select count(*) into others from auth.sessions s
   where s.user_id = p_user and s.id <> p_session and not public.is_link_preview(s.user_agent) and greatest(s.created_at, s.updated_at) > now() - interval '60 days';
  if is_new and s_created > now() - interval '12 hours' and others > 0 then kinds := array_append(kinds, 'new_device'); end if;
  if new_country then kinds := array_append(kinds, 'new_country'); end if;
  if far_km <> 0 then kinds := array_append(kinds, 'far_apart'); end if;

  -- one alert per check-in, the most serious first
  if far_km <> 0 then
    ago := case when far_mins < 1 then 'moments' when far_mins < 60 then far_mins || ' min' else round(far_mins / 60.0, 1) || ' h' end;
    b := format('%s near %s, %s after %s near %s%s.', v_label, v_place, ago, case when far_same then 'the same device' else coalesce(far_label, 'another device') end, coalesce(far_place, 'another place'),
                case when far_km > 0 then format(' (%s km apart)', to_char(far_km, 'FM999,990')) else '' end);
    perform public.notify_user(p_user, 'security', 'Your account in two far-apart places', b || ' If one of them is not you, sign it out under Account → Devices.', link_me);
    -- the administrator is told too (unless it is the administrator's own account)
    perform public.notify_user(a.id, 'security', format('%s''s account in two far-apart places', me.full_name), b || ' Check their devices under Admin → People.', '#/admin/users?devices=' || p_user)
       from public.profiles a where a.role = 'approver' and a.active and a.id <> p_user;
  elsif 'new_device' = any(kinds) then
    perform public.notify_user(p_user, 'security', 'New sign-in on your account', format('%s near %s. If this was not you, sign it out under Account → Devices and change your password.', v_label, coalesce(v_place, 'an unknown place')), link_me);
  elsif new_country then
    perform public.notify_user(p_user, 'security', format('Your account used from %s', v_country_name), format('%s near %s. If this was not you, sign it out under Account → Devices.', v_label, v_place), link_me);
  end if;
  foreach t in array kinds loop
    insert into public.security_events (user_id, session_id, kind, detail) values (p_user, p_session, t,
      jsonb_build_object('label', v_label, 'place', v_place, 'country', v_country, 'ip', p_where->>'ip')
      || case when t = 'far_apart' then jsonb_build_object('pair', pair, 'other_place', far_place, 'other_label', far_label, 'km', case when far_km > 0 then round(far_km) end, 'minutes', far_mins) else '{}'::jsonb end);
  end loop;

  insert into public.device_sessions as x (session_id, user_id, label, user_agent, tz, standalone, ip, country, place, lat, lon, approx)
  values (p_session, p_user, v_label, left(p_device->>'ua', 300), left(p_device->>'tz', 60), (p_device->>'standalone')::boolean,
          nullif(p_where->>'ip', '')::inet, v_country, v_place, v_lat, v_lon, v_approx)
  on conflict (session_id) do update set label = excluded.label, user_agent = excluded.user_agent, tz = excluded.tz, standalone = excluded.standalone,
    ip = excluded.ip, country = coalesce(excluded.country, x.country), place = coalesce(excluded.place, x.place),
    lat = coalesce(excluded.lat, case when excluded.ip is distinct from x.ip then null else x.lat end),
    lon = coalesce(excluded.lon, case when excluded.ip is distinct from x.ip then null else x.lon end),
    approx = excluded.approx, last_seen = now();
  if v_country is not null then
    insert into public.user_places (user_id, country) values (p_user, v_country)
    on conflict (user_id, country) do update set last_seen = now();
  end if;
  return jsonb_build_object('ok', true, 'new', is_new, 'alerts', to_jsonb(kinds));
end $$;
revoke execute on function public.record_checkin(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.record_checkin(uuid, uuid, jsonb, jsonb) to service_role;

-- ---------- the list ----------
create or replace function public.devices(p_user uuid default null)
returns table (session_id uuid, label text, user_agent text, place text, country text, approx boolean, ip text, tz text, standalone boolean,
               signed_in_at timestamptz, last_active timestamptz, alerts boolean, reported boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare u uuid := coalesce(p_user, auth.uid());
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if u <> auth.uid() and public.my_role() is distinct from 'approver' then raise exception 'Only the administrator can see other people''s devices'; end if;
  return query
    select s.id, d.label, s.user_agent, d.place, d.country, coalesce(d.approx, false), host(coalesce(d.ip, s.ip)), d.tz, d.standalone,
           s.created_at, greatest(s.created_at, s.updated_at, d.last_seen),
           exists (select 1 from public.push_subscriptions ps where ps.session_id = s.id), d.session_id is not null
      from auth.sessions s left join public.device_sessions d on d.session_id = s.id
     where s.user_id = u and not public.is_link_preview(s.user_agent)
     order by greatest(s.created_at, s.updated_at, d.last_seen) desc;
end $$;
revoke execute on function public.devices(uuid) from public, anon;
grant execute on function public.devices(uuid) to authenticated;

-- how many devices each person is signed in on (People list)
create or replace function public.device_counts()
returns table (user_id uuid, devices int, last_active timestamptz, places text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if public.my_role() is distinct from 'approver' then return; end if;
  return query
    select s.user_id, count(*)::int, max(greatest(s.created_at, s.updated_at, d.last_seen)), string_agg(distinct d.place, ' · ')
      from auth.sessions s left join public.device_sessions d on d.session_id = s.id
     where not public.is_link_preview(s.user_agent)
     group by s.user_id;
end $$;
revoke execute on function public.device_counts() from public, anon;
grant execute on function public.device_counts() to authenticated;

-- signing out, the deactivation trigger and the daily tidy: see 018b_run_in_supabase.sql

-- ---------- instant cut-off: every API request from a signed-out device is refused ----------
create or replace function public.check_session() returns void
language plpgsql stable security definer set search_path = '' as $$
declare c jsonb;
begin
  c := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  if c is null or (c ->> 'role') is distinct from 'authenticated' or coalesce(c ->> 'session_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return; end if;
  if not exists (select 1 from auth.sessions where id = (c ->> 'session_id')::uuid) then
    raise exception using errcode = 'PT401', message = 'session_revoked', detail = 'This device was signed out from another device.';
  end if;
end $$;
grant execute on function public.check_session() to anon, authenticated;
alter role authenticator set pgrst.db_pre_request to 'public.check_session';
notify pgrst, 'reload config';
