-- 015: account emails (welcome / reset / sign-in link) and deleting an account that never did anything.
create table if not exists public.mail_log (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  kind text not null,                -- welcome | reset | magiclink | *_failed
  at timestamptz not null default now(),
  sent boolean,
  detail text
);
create index if not exists mail_log_email_at on public.mail_log (email, kind, at desc);
alter table public.mail_log enable row level security;   -- only the functions (service role) read or write it
select cron.schedule('prune_mail_log', '25 3 * * *', $$delete from public.mail_log where at < now() - interval '90 days'$$);

-- has this person left any trace? (then they are deactivated, never deleted – the history and the packs refer to them)
create or replace function public.profile_history(p_user uuid) returns int
language sql stable security definer set search_path = public as $$
  select (select count(*) from public.requests where requester_id = p_user or disbursed_to = p_user or disbursed_by = p_user or approved_by = p_user or stock_reviewed_by = p_user or closed_by = p_user)
       + (select count(*) from public.request_events where actor_id = p_user)
       + (select count(*) from public.expenses where spent_by = p_user)
       + (select count(*) from public.stock_movements where created_by = p_user)
       + (select count(*) from public.stock_reports where reported_by = p_user)
       + (select count(*) from public.delegations where from_user = p_user or to_user = p_user)
$$;
