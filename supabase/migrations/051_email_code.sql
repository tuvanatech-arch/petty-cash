-- 051: two-step sign-in by email code instead of an authenticator app.
--   • The authenticator app is no longer used (nobody had set one up on MGP's live database).
--   • When two-step is required (settings.two_step_from, for the positions in two_step_roles), after the password Petti
--     emails a 6-digit code (account-mail "login_code": stored only as a hash, for this sign-in only, 10 minutes,
--     5 tries); verify_login_code() marks this sign-in (the session in the token) as done, and the database opens.
--   • Switched off for now (two_step_from = null): codes need email sending (Resend) first. The GM sets the date under
--     Admin → Settings once email works.

create table if not exists public.two_step_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  session_id text not null,
  code_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  attempts int not null default 0,
  used_at timestamptz
);
create index if not exists two_step_codes_user on public.two_step_codes (user_id, created_at desc);
alter table public.two_step_codes enable row level security;   -- no policies: only the server functions below read it

create table if not exists public.two_step_sessions (
  session_id text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  verified_at timestamptz not null default now()
);
alter table public.two_step_sessions enable row level security;
-- like every other table, nothing opens for a sign-in that still owes its code
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'two_step_codes' and policyname = 'two_step_required') then
    create policy two_step_required on public.two_step_codes as restrictive for all to authenticated using (not (select public.two_step_blocked())) with check (not (select public.two_step_blocked()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'two_step_sessions' and policyname = 'two_step_required') then
    create policy two_step_required on public.two_step_sessions as restrictive for all to authenticated using (not (select public.two_step_blocked())) with check (not (select public.two_step_blocked()));
  end if;
end $$;

-- the rule, for a given sign-in (session): required for the position, from the date, and this sign-in has not given its code
create or replace function public.two_step_blocked_session(p_user uuid, p_aal text, p_session text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_user is null then false
    when coalesce(p_aal, 'aal1') = 'aal2' then false
    when p_session is not null and exists (select 1 from public.two_step_sessions t where t.session_id = p_session and t.user_id = p_user) then false
    else coalesce((select s.two_step_from <= current_date from public.settings s where s.id = 1), false)
      and (exists (select 1 from public.profiles p join public.settings s on s.id = 1
                   where p.id = p_user and p.active and p.role = any (s.two_step_roles))
        or exists (select 1 from public.delegations d join public.settings s on s.id = 1
                   where d.to_user = p_user and d.role = any (s.two_step_roles) and current_date between d.starts_on and d.ends_on))
  end
$$;
revoke execute on function public.two_step_blocked_session(uuid, text, text) from public, anon, authenticated;
grant execute on function public.two_step_blocked_session(uuid, text, text) to service_role;

-- the older form (no session known): an authenticator app no longer counts
create or replace function public.two_step_blocked_for(p_user uuid, p_aal text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.two_step_blocked_session(p_user, p_aal, null)
$$;

create or replace function public.two_step_blocked() returns boolean
language sql stable security definer set search_path = public as $$
  select public.two_step_blocked_session(auth.uid(), auth.jwt() ->> 'aal', auth.jwt() ->> 'session_id')
$$;

-- what the screens need: required or not, from when, blocked now, and where the code goes
create or replace function public.my_two_step() returns jsonb
language sql stable security definer set search_path = public as $$
  with s as (select two_step_roles, two_step_from from public.settings where id = 1)
  select jsonb_build_object(
    'method', 'email',
    'required', exists (select 1 from public.profiles p, s where p.id = auth.uid() and p.active and p.role = any (s.two_step_roles))
             or exists (select 1 from public.delegations d, s where d.to_user = auth.uid() and d.role = any (s.two_step_roles)
                        and current_date between d.starts_on and d.ends_on),
    'from', (select two_step_from from s),
    'blocked', public.two_step_blocked(),
    'email', (select regexp_replace(email, '^(.)[^@]*(@.*)$', '\1•••\2') from public.profiles where id = auth.uid()))
$$;

-- the code typed in: right → this sign-in is done; 5 wrong tries → a new code is needed
create or replace function public.verify_login_code(p_code text) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_session text := auth.jwt() ->> 'session_id'; c public.two_step_codes%rowtype;
begin
  if auth.uid() is null or v_session is null then raise exception 'Sign in again'; end if;
  select * into c from public.two_step_codes where user_id = auth.uid() and session_id = v_session and used_at is null
   order by created_at desc, expires_at desc limit 1 for update;
  if c.id is null then raise exception 'Ask for a code first'; end if;
  if c.expires_at < now() then raise exception 'That code has expired. Tap “Send a new code”.'; end if;
  if c.attempts >= 5 then raise exception 'Too many tries. Tap “Send a new code”.'; end if;
  update public.two_step_codes set attempts = attempts + 1 where id = c.id;
  if encode(sha256(convert_to(regexp_replace(coalesce(p_code, ''), '\D', '', 'g') || ':' || v_session, 'UTF8')), 'hex') <> c.code_hash then return false; end if;
  update public.two_step_codes set used_at = now() where id = c.id;
  insert into public.two_step_sessions (session_id, user_id) values (v_session, auth.uid()) on conflict (session_id) do nothing;
  return true;
end $$;
revoke execute on function public.verify_login_code(text) from public, anon;
grant execute on function public.verify_login_code(text) to authenticated;

-- off until email sending works (the GM sets the date under Admin → Settings)
update public.settings set two_step_from = null where id = 1;
