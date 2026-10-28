-- Devices: the part that signs devices out. Paste all of this into Supabase → SQL Editor → Run. Safe to run twice.

-- sign out one device, all your other devices, or (admin) everyone's devices for one person
create or replace function public.sign_out_devices(p_sessions uuid[] default null, p_user uuid default null, p_keep uuid default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  is_admin boolean := public.my_role() = 'approver';
  v_targets uuid[]; v_owners uuid[];
  o uuid; n int; v_labels text; v_count int;
begin
  if me is null or public.my_role() is null then raise exception 'Sign in first'; end if;
  if p_sessions is not null then
    select array_agg(s.id), array_agg(distinct s.user_id) into v_targets, v_owners from auth.sessions s where s.id = any(p_sessions);
  else
    select array_agg(s.id), array_agg(distinct s.user_id) into v_targets, v_owners from auth.sessions s
     where s.user_id = coalesce(p_user, me) and s.id is distinct from p_keep;
  end if;
  if v_targets is null then return 0; end if;
  if not is_admin and exists (select 1 from unnest(v_owners) x where x <> me) then raise exception 'You can only sign out your own devices'; end if;
  foreach o in array v_owners loop
    select string_agg(coalesce(d.label, 'a device'), ', '), count(*) into v_labels, v_count
      from auth.sessions s left join public.device_sessions d on d.session_id = s.id
     where s.id = any(v_targets) and s.user_id = o and not public.is_link_preview(s.user_agent);
    if v_count > 0 then
      insert into public.security_events (user_id, kind, detail, actor_id) values (o, 'signed_out', jsonb_build_object('devices', v_labels, 'count', v_count, 'everywhere', p_sessions is null and p_keep is null), me);
      if o <> me then
        perform public.notify_user(o, 'security', 'Signed out by the administrator',
          format('%s signed out %s on your account. Sign in again there if you still use it.', (select full_name from public.profiles where id = me), v_labels), '#/account?devices=1');
      end if;
    end if;
  end loop;
  if p_sessions is null and p_keep is null then delete from public.push_subscriptions where user_id = coalesce(p_user, me) and session_id is null; end if;
  delete from auth.sessions where id = any(v_targets);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.sign_out_devices(uuid[], uuid, uuid) from public, anon;
grant execute on function public.sign_out_devices(uuid[], uuid, uuid) to authenticated;

-- deactivating someone signs them out everywhere at once and stops their alerts
create or replace function public.profiles_signout_inactive() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.active and not new.active then
    delete from public.push_subscriptions where user_id = new.id;
    delete from auth.sessions where user_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists profiles_signout_inactive on public.profiles;
create trigger profiles_signout_inactive after update of active on public.profiles for each row execute function public.profiles_signout_inactive();

-- daily 03:35: link-preview robots' sign-ins go, devices unused for 60 days are signed out, old lookups are dropped
create or replace function public.tidy_sessions() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from auth.sessions s where public.is_link_preview(s.user_agent) or greatest(s.created_at, s.updated_at) < now() - interval '60 days';
  get diagnostics n = row_count;
  delete from public.ip_places where looked_up_at < now() - interval '30 days';
  delete from public.security_events where at < now() - interval '400 days';
  return n;
end $$;
revoke execute on function public.tidy_sessions() from public, anon, authenticated;
select cron.schedule('tidy_sessions', '35 3 * * *', 'select public.tidy_sessions()');

-- one-off clean-up: WhatsApp's two link-preview sign-ins, a header probe, and the temporary test account
select public.tidy_sessions();
drop function if exists public.zz_echo_headers();
delete from public.notifications where user_id in (select id from public.profiles where email = 'zz-device-check@tuvana.invalid');
delete from auth.users where email = 'zz-device-check@tuvana.invalid';

select 'Done – devices can now be signed out from the app.' as result;
