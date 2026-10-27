-- 014: stand-ins do the day-to-day only, and the app remembers per person which tips they have seen.

-- suppliers and categories are catalogue: the real stock manager (or approver), never a stand-in – same rule as items
alter policy suppliers_write on public.suppliers using (public.my_role() in ('stock_manager','approver')) with check (public.my_role() in ('stock_manager','approver'));
alter policy categories_write on public.categories using (public.my_role() in ('stock_manager','approver')) with check (public.my_role() in ('stock_manager','approver'));

-- tips, welcome strips and the set-up checklist: remembered on the server so a phone and a laptop do not both ask
alter table public.profiles add column if not exists seen_tips jsonb not null default '{}'::jsonb;

create or replace function public.mark_tip(p_key text, p_seen boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if p_key is null or p_key = '' then
    update public.profiles set seen_tips = '{}'::jsonb where id = auth.uid() returning seen_tips into v;   -- "show tips again"
  elsif p_seen then
    update public.profiles set seen_tips = seen_tips || jsonb_build_object(p_key, true) where id = auth.uid() returning seen_tips into v;
  else
    update public.profiles set seen_tips = seen_tips - p_key where id = auth.uid() returning seen_tips into v;
  end if;
  return coalesce(v, '{}'::jsonb);
end $$;
revoke execute on function public.mark_tip(text, boolean) from public, anon;

-- what the set-up checklist ticks off (approver only): one call, no extra tables
create or replace function public.setup_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.has_role('approver') then jsonb_build_object(
    'company', (select org_name is not null and org_name not in ('', 'Petty cash') and approval_threshold > 0 and default_monthly_float > 0 from public.settings where id = 1),
    'people', (select count(*) filter (where role = 'finance') > 0 and count(*) > 1 from public.profiles where active),
    'finance_named', (select string_agg(full_name, ', ') from public.profiles where active and role = 'finance'),
    'stock_manager_named', (select string_agg(full_name, ', ') from public.profiles where active and role = 'stock_manager'),
    'items', (select count(*) from public.items where active),
    'float', (select count(*) > 0 from public.floats where status = 'open'),
    'alerts', (select count(*) > 0 from public.push_subscriptions where user_id = auth.uid())
  ) else '{}'::jsonb end;
$$;
revoke execute on function public.setup_status() from public, anon;
