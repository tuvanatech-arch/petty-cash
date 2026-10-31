-- 030: one codebase, many clients.
--   • Region: the time zone (day and month boundaries, the dates written into messages) and how numbers are written.
--   • Position titles: what this organisation calls the GM and the MD. The database keeps saying "GM"/"MD";
--     the screens, documents, alerts and emails swap in these words (titled() in the app, the same in the mail functions).
--   • Server address and keys per installation: the edge functions are called through app_config (functions_url,
--     cron_key), and the phone-alert public key is read from the server instead of being written into the app.
--   • The scheduled jobs that were added by hand on MGP's database are now part of the setup.
-- Safe to run on MGP's live database: every default is MGP's current behaviour.

alter table public.settings add column if not exists time_zone text not null default 'Africa/Windhoek';
alter table public.settings add column if not exists number_locale text not null default 'en-NA';
alter table public.settings add column if not exists titles jsonb not null
  default '{"gm": "GM", "gm_long": "General Manager", "md": "MD", "md_long": "Managing Director"}'::jsonb;

-- a time zone the database does not know would break every date: refuse it when saved
create or replace function public.settings_check_region() returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.time_zone) then
    raise exception 'Unknown time zone "%". Pick one from the list.', new.time_zone;
  end if;
  return new;
end $$;
create or replace trigger settings_check_region before insert or update of time_zone on public.settings for each row execute function public.settings_check_region();
revoke execute on function public.settings_check_region() from public, anon, authenticated;

-- the organisation's time zone, for every date the database works out
create or replace function public.app_tz() returns text language sql stable security definer set search_path = public as $$
  select coalesce((select time_zone from public.settings where id = 1), 'Africa/Windhoek')
$$;
grant execute on function public.app_tz() to authenticated, service_role;

-- every function that named Windhoek's time zone now asks app_tz() instead (definitions otherwise unchanged)
do $$
declare r record; d text; n int := 0;
begin
  for r in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where s.nspname = 'public' and p.prokind = 'f' and p.prosrc like '%''Africa/Windhoek''%' and p.proname <> 'app_tz' loop
    d := replace(pg_get_functiondef(r.oid), '''Africa/Windhoek''', 'public.app_tz()');
    execute d;
    n := n + 1;
  end loop;
  raise notice 'time zone now read from settings in % functions', n;
end $$;

-- the helper the alert trigger and the scheduled jobs use to call this installation's edge functions
create or replace function public.call_function(p_name text, p_body jsonb default '{}'::jsonb, p_timeout int default 15000) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_url text := (select value from public.app_config where key = 'functions_url');
begin
  if v_url is null then return null; end if;
  return net.http_post(url := rtrim(v_url, '/') || '/' || p_name,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', (select value from public.app_config where key = 'cron_key')),
    body := p_body, timeout_milliseconds := p_timeout);
end $$;
revoke execute on function public.call_function(text, jsonb, int) from public, anon, authenticated;

-- every new alert goes to the person's phone(s) straight away
create or replace function public.notifications_push_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.call_function('send-push', jsonb_build_object('id', new.id), 15000);
  return new;
exception when others then
  return new; -- a push hiccup never blocks the alert itself
end $$;
revoke execute on function public.notifications_push_trigger() from public, anon, authenticated;

-- the public half of the phone-alert key, for the app to sign phones up with
create or replace function public.push_public_key() returns text language sql stable security definer set search_path = public as $$
  select value from public.app_config where key = 'vapid_public'
$$;
revoke execute on function public.push_public_key() from public, anon;
grant execute on function public.push_public_key() to authenticated;

-- the scheduled jobs, all of them, by name (scheduling a name again replaces it)
select cron.schedule('petty-send-notifications', '*/5 * * * *', $cron$select public.call_function('send-notifications', '{}'::jsonb, 15000)$cron$);
select cron.schedule('petty-backup', '0 2 * * *', $cron$select public.call_function('backup', '{}'::jsonb, 120000)$cron$);
select cron.schedule('petty-advance-reminders', '0 7 * * *', 'select public.remind_outstanding_advances()');
select cron.schedule('petty-weekly-count', '0 6 * * *', 'select public.remind_weekly_count()');

-- the reminder jobs are for the scheduler only (remind_cash_count was open to anyone)
revoke execute on function public.remind_cash_count() from public, anon, authenticated;

-- amounts written into alerts and emails follow the organisation's number format
-- (en-NA and most English: 1,234.50; Portuguese, French and South African: 1 234,50)
create or replace function public.money_text(v numeric) returns text language sql stable set search_path = public as $$
  select public.cur() || case when (select number_locale from public.settings where id = 1) ~ '^(pt|fr|en-ZA)'
    then translate(to_char(coalesce(v, 0), 'FM999,999,990.00'), ',.', ' ,')
    else to_char(coalesce(v, 0), 'FM999,999,990.00') end
$$;
