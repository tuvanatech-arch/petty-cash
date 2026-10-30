-- 024: (1) the administrator is told when someone signs in for the first time (their account is set up);
--      (2) every alert carries a link to what it is about, so tapping it (in the app, a phone buzz or an email) opens that.

-- (2) a link for every alert: the request when there is one, otherwise the screen for that kind of alert
create or replace function public.notification_link(p_kind text, p_request uuid) returns text
language sql immutable set search_path = public as $$
  select case
    when p_request is not null then '#/requests/' || p_request
    when p_kind in ('cash_count', 'cash_count_due', 'top_up', 'float_warning', 'month_close', 'pack_review', 'pack_sent') then '#/cash'
    when p_kind = 'schedule' then '#/schedule'
    when p_kind in ('stock_report', 'stock_report_resolved', 'weekly_count', 'price_jump') then '#/stock'
    when p_kind = 'weekly_digest' then '#/reports'
    when p_kind = 'security' then '#/account?devices=1'
    when p_kind = 'account_ready' then '#/admin'
    else '#/home'
  end
$$;

create or replace function public.notifications_link_fill() returns trigger
language plpgsql set search_path = public as $$
begin
  new.link := nullif(btrim(coalesce(new.link, '')), '');
  if new.link is null then new.link := public.notification_link(new.kind, new.request_id);
  elsif left(new.link, 1) = '/' then new.link := '#' || new.link;
  elsif left(new.link, 2) <> '#/' then new.link := '#/' || new.link;
  end if;
  return new;
end $$;
revoke execute on function public.notifications_link_fill() from public, anon, authenticated;
create or replace trigger notifications_link_fill before insert on public.notifications
  for each row execute function public.notifications_link_fill();

update public.notifications set link = public.notification_link(kind, request_id) where link is null or btrim(link) = '';

-- (1) first sign-in = the account is set up: tell the administrator(s), never the person themself
create or replace function public.account_ready_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare p public.profiles%rowtype; a record;
begin
  if old.last_sign_in_at is not null or new.last_sign_in_at is null then return new; end if;
  select * into p from public.profiles where id = new.id;
  if p.id is null then return new; end if;
  for a in select id from public.profiles where active and role = 'approver' and id <> new.id loop
    insert into public.notifications (user_id, kind, title, body, link)
    values (a.id, 'account_ready', coalesce(nullif(p.full_name, ''), p.email) || ' has set up their account',
            'Signed in for the first time as ' || replace(p.role::text, '_', ' ') || '.', '#/admin');
  end loop;
  return new;
exception when others then return new;   -- an alert must never stop someone signing in
end $$;
revoke execute on function public.account_ready_notify() from public, anon, authenticated;
create or replace trigger account_ready_notify after update of last_sign_in_at on auth.users
  for each row execute function public.account_ready_notify();
