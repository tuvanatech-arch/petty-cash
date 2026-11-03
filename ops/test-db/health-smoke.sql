-- The daily health check: quiet when all is well, and it names each thing that went wrong. Every line should say ok.
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(what text, cond boolean) returns text language sql as $$ select case when coalesce(cond, false) then 'ok   ' else 'FAIL ' end || what $$;
insert into storage.buckets (id, name) values ('backups', 'backups') on conflict do nothing;
insert into storage.objects (bucket_id, name, created_at) values ('backups', 'b-today/requests.csv', now() - interval '3 hours'), ('backups', 'b-today/expenses.csv', now() - interval '3 hours');
insert into cron.job_run_details (jobid, status, return_message, start_time) select jobid, 'succeeded', '1 row', now() - interval '2 hours' from cron.job where jobname = 'petty-stale-items';
insert into net._http_response (status_code, created) values (200, now() - interval '1 hour');
select pg_temp.ok('all well: ok, nothing listed, and the last copy is shown', (public.health_report()->>'ok')::boolean and jsonb_array_length(public.health_report()->'problems') = 0 and (public.health_report()->>'backup_files')::int = 2);

insert into cron.job_run_details (jobid, status, return_message, start_time) select jobid, 'failed', 'ERROR: cannot cast type record to requests', now() - interval '1 hour' from cron.job where jobname = 'petty-stale-items';
insert into net._http_response (status_code, error_msg, created) values (500, null, now() - interval '1 hour'), (null, 'timeout', now() - interval '30 minutes');
insert into public.client_logs (message, at) select 'boom', now() - interval '1 hour' from generate_series(1, 12);
select pg_temp.ok('a failed job is named, with its message', exists (select 1 from jsonb_array_elements(public.health_report()->'problems') p where p->>'problem' = 'Scheduled job failed: petty-stale-items' and p->>'detail' like '%cannot cast%'));
select pg_temp.ok('failed calls are counted (2)', exists (select 1 from jsonb_array_elements(public.health_report()->'problems') p where p->>'problem' like 'Calls to Petti%' and (p->>'times')::int = 2));
select pg_temp.ok('many phone errors are flagged', exists (select 1 from jsonb_array_elements(public.health_report()->'problems') p where p->>'problem' like 'Many errors%'));
select pg_temp.ok('and ok is false', not (public.health_report()->>'ok')::boolean);
insert into storage.objects (bucket_id, name, created_at) values ('backups', 'a-older/requests.csv', now() - interval '27 hours'), ('backups', 'a-older/expenses.csv', now() - interval '27 hours'), ('backups', 'a-older/floats.csv', now() - interval '27 hours');
select pg_temp.ok('a copy with fewer tables than the one before is flagged', exists (select 1 from jsonb_array_elements(public.health_report()->'problems') p where p->>'problem' like '%missing some tables%'));
update storage.objects set created_at = now() - interval '3 days' where bucket_id = 'backups';
select pg_temp.ok('no copy in the last day is flagged', exists (select 1 from jsonb_array_elements(public.health_report()->'problems') p where p->>'problem' like 'No nightly copy%'));
select pg_temp.ok('an older failure falls outside the window', not exists (select 1 from jsonb_array_elements(public.health_report(0)->'problems') p where p->>'problem' like 'Scheduled job%'));

set local role authenticated;
do $$ begin perform public.health_report(); raise notice 'FAIL a signed-in person ran it'; exception when insufficient_privilege then raise notice 'ok   a signed-in person cannot run it'; end $$;
rollback;
