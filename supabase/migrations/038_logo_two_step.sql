-- 038: the company's logo on its documents, and two-step sign-in.
--
-- Logo: one image in a public "branding" store (a logo is not secret); the administrator replaces or removes it.
-- Two-step sign-in: a code from an authenticator app after the password. Once someone has set it up, every sign-in
-- of theirs needs the code before any data opens. For the positions that release money (finance, the GM and the MD,
-- and anyone standing in for them) it becomes required from a date the administrator sets; until they set it up after
-- that date, the database opens nothing for them. Enforced here, not only on the screen.

-- ---------- the logo ----------
alter table public.settings add column if not exists logo_path text;
alter table public.settings add column if not exists logo_updated_at timestamptz;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('branding', 'branding', true, 2097152, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;
create policy branding_read on storage.objects for select to authenticated using (bucket_id = 'branding');
create policy branding_admin_insert on storage.objects for insert to authenticated with check (bucket_id = 'branding' and public.my_role() = 'approver');
create policy branding_admin_update on storage.objects for update to authenticated using (bucket_id = 'branding' and public.my_role() = 'approver');
-- "Remove" only clears settings.logo_path: the file stays until a new logo replaces it

-- ---------- two-step sign-in ----------
alter table public.settings add column if not exists two_step_roles public.user_role[] not null default '{finance,approver,managing_director}';
alter table public.settings add column if not exists two_step_from date;
-- required two weeks after this release; the administrator can move the date under Admin
update public.settings set two_step_from = current_date + 14 where two_step_from is null;

/** Whether a sign-in may open any data: not while someone who has two-step sign-in has not given the code, and not
    when it is required for a position they hold (or stand in for) and they have not set it up by the date. */
create or replace function public.two_step_blocked_for(p_user uuid, p_aal text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_user is null then false
    when coalesce(p_aal, 'aal1') = 'aal2' then false
    when exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified') then true
    else coalesce((select s.two_step_from <= current_date from public.settings s where s.id = 1), false)
      and (exists (select 1 from public.profiles p join public.settings s on s.id = 1
                   where p.id = p_user and p.active and p.role = any (s.two_step_roles))
        or exists (select 1 from public.delegations d join public.settings s on s.id = 1
                   where d.to_user = p_user and d.role = any (s.two_step_roles) and current_date between d.starts_on and d.ends_on))
  end
$$;
revoke execute on function public.two_step_blocked_for(uuid, text) from public, anon, authenticated;
grant execute on function public.two_step_blocked_for(uuid, text) to service_role;

create or replace function public.two_step_blocked() returns boolean
language sql stable security definer set search_path = public as $$
  select public.two_step_blocked_for(auth.uid(), auth.jwt() ->> 'aal')
$$;
revoke execute on function public.two_step_blocked() from public, anon;
grant execute on function public.two_step_blocked() to authenticated;

-- the three checks every rule and function relies on now say "no position" for a sign-in that is blocked
create or replace function public.my_role() returns public.user_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active and not public.two_step_blocked()
$$;

create or replace function public.has_role(p public.user_role) returns boolean
language sql stable security definer set search_path = public as $$
  select not public.two_step_blocked() and (
    exists (select 1 from public.profiles where id = auth.uid() and active and (role = p or (p = 'approver' and role = 'managing_director')))
    or exists (select 1 from public.delegations d join public.profiles me on me.id = auth.uid() and me.active
               join public.profiles f on f.id = d.from_user and f.active
               where d.to_user = auth.uid() and (d.role = p or (p = 'approver' and d.role = 'managing_director'))
                 and current_date between d.starts_on and d.ends_on))
$$;

create or replace function public.my_roles() returns public.user_role[]
language sql stable security definer set search_path = public as $$
  select array_agg(distinct r) from (
    select role as r from public.profiles where id = auth.uid() and active
    union
    select d.role from public.delegations d join public.profiles me on me.id = auth.uid() and me.active
      join public.profiles f on f.id = d.from_user and f.active
      where d.to_user = auth.uid() and current_date between d.starts_on and d.ends_on
  ) x where not public.two_step_blocked()
$$;

-- and no table, nor any stored file, opens for a blocked sign-in (the service and the cron jobs are not affected)
do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t.relname and policyname = 'two_step_required') then
      execute format('create policy two_step_required on public.%I as restrictive for all to authenticated using (not (select public.two_step_blocked())) with check (not (select public.two_step_blocked()))', t.relname);
    end if;
  end loop;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'two_step_required') then
    create policy two_step_required on storage.objects as restrictive for all to authenticated
      using (not (select public.two_step_blocked())) with check (not (select public.two_step_blocked()));
  end if;
end $$;

/** For the app: where this sign-in stands with two-step sign-in (readable even while blocked, so the app can say why). */
create or replace function public.my_two_step() returns jsonb
language sql stable security definer set search_path = public as $$
  with s as (select two_step_roles, two_step_from from public.settings where id = 1),
       f as (select count(*) filter (where status = 'verified') as n, min(created_at) filter (where status = 'verified') as since
             from auth.mfa_factors where user_id = auth.uid())
  select jsonb_build_object(
    'enabled', (select n from f) > 0,
    'since', (select since from f),
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'),
    'required', exists (select 1 from public.profiles p, s where p.id = auth.uid() and p.active and p.role = any (s.two_step_roles))
             or exists (select 1 from public.delegations d, s where d.to_user = auth.uid() and d.role = any (s.two_step_roles)
                          and current_date between d.starts_on and d.ends_on),
    'from', (select two_step_from from s),
    'blocked', public.two_step_blocked())
$$;
revoke execute on function public.my_two_step() from public, anon;
grant execute on function public.my_two_step() to authenticated;

/** For the GM and the MD: who has two-step sign-in, and since when. */
create or replace function public.two_step_people() returns table (user_id uuid, enabled boolean, since timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id,
         exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified'),
         (select min(f.created_at) from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified')
  from public.profiles p
  where public.has_role('approver')
$$;
revoke execute on function public.two_step_people() from public, anon;
grant execute on function public.two_step_people() to authenticated;
