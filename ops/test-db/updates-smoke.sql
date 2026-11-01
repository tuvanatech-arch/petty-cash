-- "What's new": targeting by role, person and everyone; scheduling; reading clears the alert; the administrator's view.
\set ON_ERROR_STOP 1
begin;
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'boss@example.test', '{"full_name":"Ana Boss"}');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000f1', 'money@example.test', '{"full_name":"Filipa Money"}', '{"invited":true,"role":"finance"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@example.test', '{"full_name":"Carlos Staff"}', '{"invited":true,"role":"requester"}'),
  ('00000000-0000-0000-0000-0000000000c2', 'stock@example.test', '{"full_name":"Sofia Stock"}', '{"invited":true,"role":"stock_manager"}');
select 'finance only', public.announce_update('t', 'Pay-outs', 'Finance thing', array['Step one','Step two'], '#/cash', 'Open petty cash', array['finance']::user_role[]) is not null;
select 'one person', public.announce_update('t', 'Just Carlos', 'Only you', '{}', null, null, '{}', '{}', array['00000000-0000-0000-0000-0000000000c1']::uuid[]) is not null;
select 'everyone', public.announce_update('t', 'Everyone', 'All of you') is not null;
select 'later', public.announce_update('t', 'Monday', 'Later', '{}', null, null, '{}', '{}', '{}', public.next_working_morning()) is not null;
select 'next working morning (local)', to_char(public.next_working_morning() at time zone public.app_tz(), 'Dy DD Mon HH24:MI');
select 'alerts', p.full_name, string_agg(n.title, '; ' order by n.title), bool_and(n.emailed_at is not null) as not_emailed, min(n.link) from public.notifications n join public.profiles p on p.id = n.user_id where n.kind = 'update' group by p.full_name order by 2;
select 'scheduled waiting', count(*) from public.updates where status = 'scheduled';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
select 'filipa sees', jsonb_array_length(public.my_updates());
select 'marked', public.mark_update_seen(array(select id from public.updates where title = 'Pay-outs'));
select 'alert read', count(*) from public.notifications where user_id = '00000000-0000-0000-0000-0000000000f1' and kind = 'update' and read_at is not null;
select 'filipa: admin view empty', public.update_status() = '[]'::jsonb;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
select 'admin view', jsonb_path_query_array(public.update_status(), '$[*].title'), jsonb_path_query_array(public.update_status(), '$[*].seen');
select public.cancel_update((select id from public.updates where title = 'Monday'));
select 'status after cancel', status from public.updates where title = 'Monday';
rollback;
