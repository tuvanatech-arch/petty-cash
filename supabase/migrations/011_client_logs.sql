-- 011: client-side diagnostics. Phones write errors, slow boots and user reports here; the approver can read them.
create table if not exists public.client_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id),
  at timestamptz not null default now(),
  level text not null default 'error',          -- error | warn | info | report
  message text not null,
  detail text,
  url text,
  build text,
  device jsonb,
  user_agent text
);
create index if not exists client_logs_at on public.client_logs (at desc);
alter table public.client_logs enable row level security;
drop policy if exists client_logs_insert on public.client_logs;
create policy client_logs_insert on public.client_logs for insert to authenticated with check (user_id = auth.uid() or user_id is null);
drop policy if exists client_logs_insert_anon on public.client_logs;
create policy client_logs_insert_anon on public.client_logs for insert to anon with check (user_id is null);
drop policy if exists client_logs_select on public.client_logs;
create policy client_logs_select on public.client_logs for select to authenticated using (has_role('approver'));
-- keep a month
select cron.schedule('prune_client_logs', '15 3 * * *', $$delete from public.client_logs where at < now() - interval '30 days'$$);
