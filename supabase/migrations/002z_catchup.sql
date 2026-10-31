-- 002z: changes that were applied straight to MGP's database between 002 and 003 and never saved as a file.
-- Recovered from the live database so that a new installation replays to the same result.
alter type public.movement_kind add value if not exists 'usage';
alter type public.request_type add value if not exists 'claim';
alter type public.user_role add value if not exists 'managing_director';
alter table public.stock_movements add column if not exists occurred_on date not null default current_date;
-- the first has_role (020 extends it for the MD and stand-ins)
create or replace function public.has_role(p public.user_role) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = p)
$$;

-- tables that were created straight on MGP's database (definitions as they are live; later files add the rest)
create table if not exists public.app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;   -- no policies: only the server reads it
revoke all on public.app_config from anon, authenticated;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  link text,
  request_id uuid references public.requests(id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  emailed_at timestamptz,
  email_status text,
  email_attempts integer not null default 0
);
create index if not exists notifications_user_unread on public.notifications (user_id, read_at, created_at desc);
create index if not exists notifications_unsent on public.notifications (emailed_at) where emailed_at is null;
alter table public.notifications enable row level security;
create policy notifications_select on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notifications_update on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.categories(id),
  person_id uuid references public.profiles(id) on delete cascade,
  monthly_limit numeric(12,2) not null check (monthly_limit > 0),
  active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  constraint budgets_check check (category_id is not null or person_id is not null)
);
create unique index if not exists budgets_scope_uq on public.budgets (coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(person_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table public.budgets enable row level security;
create policy budgets_select on public.budgets for select to authenticated using (true);
create policy budgets_write on public.budgets for all to authenticated using (false) with check (false);

create table if not exists public.delegations (
  id uuid primary key default gen_random_uuid(),
  role public.user_role not null,
  from_user uuid not null references public.profiles(id),
  to_user uuid not null references public.profiles(id),
  starts_on date not null default current_date,
  ends_on date not null,
  note text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint delegations_check check (ends_on >= starts_on),
  constraint delegations_check1 check (from_user <> to_user)
);
create index if not exists delegations_to_user on public.delegations (to_user, role, starts_on, ends_on);
alter table public.delegations enable row level security;
create policy delegations_select on public.delegations for select to authenticated using (true);
create policy delegations_write on public.delegations for all to authenticated
  using ((public.my_role() = 'approver' and role <> 'managing_director') or (from_user = auth.uid() and role = public.my_role()))
  with check ((public.my_role() = 'approver' and role <> 'managing_director') or (from_user = auth.uid() and role = public.my_role()));
