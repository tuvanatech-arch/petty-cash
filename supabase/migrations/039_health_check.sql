-- 039: a daily health check. The cash-out reminder failed for two days in November 2026 and nobody noticed;
-- this lists anything that went wrong in the last day so Tuvana Tech hears about it the same morning
-- (read each weekday morning by a scheduled check that alerts the owner's phone).

/** What went wrong in the last p_hours: failed scheduled jobs, a missing nightly copy, failed calls to Petti's own
    server functions (alerts, emails, backup) and errors reported by phones. ok = true when there is nothing to report. */
create or replace function public.health_report(p_hours int default 26) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb := '[]'::jsonb; r record; v_backup timestamptz; v_files int; v_http int; v_errors int; v_short boolean; v_since timestamptz := now() - make_interval(hours => p_hours);
begin
  for r in select j.jobname, count(*) as n, max(d.start_time) as last_at, (array_agg(left(d.return_message, 200) order by d.start_time desc))[1] as msg
           from cron.job_run_details d join cron.job j on j.jobid = d.jobid
           where d.start_time > v_since and d.status = 'failed' group by j.jobname loop
    v := v || jsonb_build_object('problem', 'Scheduled job failed: ' || r.jobname, 'times', r.n, 'last', r.last_at, 'detail', r.msg);
  end loop;
  select max(created_at), count(*) filter (where created_at > v_since) into v_backup, v_files from storage.objects where bucket_id = 'backups';
  if v_backup is null or v_backup < v_since then
    v := v || jsonb_build_object('problem', 'No nightly copy of the records in the last day', 'last', v_backup);
  end if;
  -- a copy with fewer files than the one before means a table could not be copied
  with runs as (select split_part(name, '/', 1) as run, count(*) as n from storage.objects where bucket_id = 'backups' group by 1 order by 1 desc limit 2)
  select coalesce((array_agg(n order by run desc))[1] < (array_agg(n order by run desc))[2], false) into v_short from runs;
  if v_short then v := v || jsonb_build_object('problem', 'The last nightly copy is missing some tables'); end if;
  select count(*) into v_http from net._http_response where created > v_since and (status_code >= 400 or error_msg is not null);
  if v_http > 0 then v := v || jsonb_build_object('problem', 'Calls to Petti''s server functions failed', 'times', v_http); end if;
  select count(*) into v_errors from public.client_logs where level = 'error' and at > v_since;
  if v_errors >= 10 then v := v || jsonb_build_object('problem', 'Many errors reported by phones', 'times', v_errors); end if;
  return jsonb_build_object('checked_at', now(), 'ok', jsonb_array_length(v) = 0, 'problems', v,
    'last_backup', v_backup, 'backup_files', v_files, 'phone_errors', v_errors);
end $$;
revoke execute on function public.health_report(int) from public, anon, authenticated;
grant execute on function public.health_report(int) to service_role;
