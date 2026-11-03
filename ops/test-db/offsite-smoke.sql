-- The copy at another company: which stored files still have to go, the practice restore of the records, and what the
-- health check says about it. Every line should say ok.
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(what text, cond boolean) returns text language sql as $$ select case when coalesce(cond, false) then 'ok   ' else 'FAIL ' end || what $$;
create function pg_temp.has(p text) returns boolean language sql as $$ select exists (select 1 from jsonb_array_elements(public.health_report()->'problems') x where x->>'problem' like p) $$;
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'boss@example.test', '{"full_name":"Ana Boss"}');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000c1', 'staff@example.test', '{"full_name":"Carlos Staff"}', '{"invited":true,"role":"requester"}');
insert into storage.buckets (id, name) values ('backups', 'backups'), ('mgp-files', 'mgp-files') on conflict do nothing;
insert into storage.objects (bucket_id, name, created_at, updated_at, metadata) values
  ('proofs', 'r1/slip.jpg', now() - interval '3 days', now() - interval '3 days', '{"size": 1000}'),
  ('proofs', 'r2/slip.jpg', now() - interval '1 day', now() - interval '1 day', '{"size": 2000}'),
  ('branding', 'logo.png', now() - interval '2 hours', now() - interval '2 hours', '{"size": 300}'),
  ('backups', 'run/requests.json', now(), now(), '{"size": 10}'),
  ('mgp-files', 'other.pdf', now(), now(), '{"size": 10}');

-- what still has to be sent
select pg_temp.ok('first run: every receipt, pack and logo, oldest first; not the records folder, not other apps'' files',
  (select array_agg(bucket_id || '/' || name order by changed_at) from public.offsite_pending(null)) = array['proofs/r1/slip.jpg', 'proofs/r2/slip.jpg', 'branding/logo.png']);
select pg_temp.ok('next run: only what changed since', (select array_agg(name) from public.offsite_pending(now() - interval '2 days')) = array['r2/slip.jpg', 'logo.png']);
select pg_temp.ok('in batches', (select count(*) from public.offsite_pending(null, 2)) = 2);
select pg_temp.ok('sizes come along', (select sum(size) from public.offsite_pending(null)) = 3300);

-- the practice restore: the copied rows go back into the real table shape
select pg_temp.ok('people restore (2 rows)', public.restore_check('profiles', (select jsonb_agg(to_jsonb(p)) from public.profiles p)) = 2);
select pg_temp.ok('settings restore, lists and dates included', public.restore_check('settings', (select jsonb_agg(to_jsonb(s)) from public.settings s)) = 1);
select pg_temp.ok('an empty table restores as empty', public.restore_check('requests', '[]'::jsonb) = 0);
select pg_temp.ok('the scratch copies leave the real tables alone', (select count(*) from public.profiles) = 2);
do $$ begin perform public.restore_check('profiles', '[{"id": "not-an-id"}]'); raise notice 'FAIL a broken row went in';
  exception when others then raise notice 'ok   a broken row is refused, with the reason (%)', left(sqlerrm, 40); end $$;
do $$ begin perform public.restore_check('no_such_table', '[]'); raise notice 'FAIL an unknown table was accepted';
  exception when others then raise notice 'ok   an unknown table is refused'; end $$;

-- the health check: quiet before Backblaze is set up, then it reports on each night's copy
insert into storage.objects (bucket_id, name, created_at) values ('backups', 'b-today/requests.json', now() - interval '1 hour');
select pg_temp.ok('not set up yet: nothing said about Backblaze', not pg_temp.has('%Backblaze%') and not pg_temp.has('%restore%'));
insert into public.offsite_runs (started_at, finished_at, records_run, files_sent, restore_ok) values (now() - interval '3 days', now() - interval '3 days', 'old', 5, true);
select pg_temp.ok('no copy for three days is flagged', pg_temp.has('No copy sent to Backblaze%'));
insert into public.offsite_runs (started_at, finished_at, error) values (now() - interval '1 hour', now() - interval '1 hour', 'Backblaze said 403: bad key');
select pg_temp.ok('a failed copy is flagged, with the reason', pg_temp.has('The copy to Backblaze failed') and (select x->>'detail' from jsonb_array_elements(public.health_report()->'problems') x where x->>'problem' = 'The copy to Backblaze failed') like '%403%');
insert into public.offsite_runs (started_at, finished_at, records_run, files_sent, restore_ok, restore_note) values (now() - interval '30 minutes', now() - interval '29 minutes', 'b-today', 3, false, 'requests: invalid input syntax');
select pg_temp.ok('a failed practice restore is flagged', pg_temp.has('The practice restore%') and not pg_temp.has('%Backblaze%'));
insert into public.offsite_runs (started_at, finished_at, records_run, files_sent, restore_ok) values (now() - interval '10 minutes', now() - interval '9 minutes', 'b-today', 3, true);
select pg_temp.ok('the latest copy is shown, and restores', (public.health_report()->>'offsite_restore_ok')::boolean and public.health_report()->>'offsite_last' is not null);

-- only the server
set local role authenticated;
do $$ begin perform public.restore_check('profiles', '[]'); raise notice 'FAIL a signed-in person ran the restore check';
  exception when insufficient_privilege then raise notice 'ok   a signed-in person cannot run the restore check'; end $$;
do $$ begin perform * from public.offsite_pending(null); raise notice 'FAIL a signed-in person listed the files';
  exception when insufficient_privilege then raise notice 'ok   nor list the files waiting to be sent'; end $$;
do $$ begin perform * from public.offsite_runs; raise notice 'ok   the copy log shows nothing to a signed-in person (% rows)', (select count(*) from public.offsite_runs);
  exception when insufficient_privilege then raise notice 'ok   the copy log is closed to a signed-in person'; end $$;
rollback;
