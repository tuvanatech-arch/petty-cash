-- 040: a second copy at another company. Every night the latest copy of the records, and every stored file that is new
-- or changed (receipt photos, month-end packs, the logo), goes to Tuvana Tech's private Backblaze bucket in Amsterdam
-- (functions/offsite). Its key can only add files, so even someone misusing this server could not remove the copies.
-- Each night it also proves the copy can be restored: every table's rows are loaded back into a scratch copy of the table.

create table if not exists public.offsite_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  records_run text,                    -- the nightly records copy (folder in "backups") the other company now holds
  files_upto timestamptz,              -- every stored file changed up to this moment has been sent
  files_sent int not null default 0,
  bytes_sent bigint not null default 0,
  skipped int not null default 0,      -- files removed between listing and sending
  more boolean not null default false, -- ran out of time; the next run carries on
  restore_ok boolean,                  -- the records sent tonight load back into every table (null: none sent tonight)
  restore_note text,
  error text
);
alter table public.offsite_runs enable row level security;
-- no rules that open it: only the server writes and reads it (the health check reports on it)
create policy two_step_required on public.offsite_runs as restrictive for all to authenticated
  using (not (select public.two_step_blocked())) with check (not (select public.two_step_blocked()));

/** Stored files that are new or changed since a moment, oldest first: what the nightly copy still has to send. */
create or replace function public.offsite_pending(p_since timestamptz, p_limit int default 50)
returns table (bucket_id text, name text, size bigint, changed_at timestamptz)
language sql stable security definer set search_path = public as $$
  select o.bucket_id, o.name, coalesce((o.metadata ->> 'size')::bigint, 0), coalesce(o.updated_at, o.created_at)
  from storage.objects o
  where o.bucket_id in ('proofs', 'packs', 'branding')
    and coalesce(o.updated_at, o.created_at) > coalesce(p_since, '-infinity'::timestamptz)
  order by coalesce(o.updated_at, o.created_at), o.name
  limit greatest(1, least(p_limit, 500))
$$;
revoke execute on function public.offsite_pending(timestamptz, int) from public, anon, authenticated;
grant execute on function public.offsite_pending(timestamptz, int) to service_role;

/** The practice restore: load one table's copied rows into a scratch copy of that table (same columns, types and
    checks; undone straight after) and say how many went in. Fails, with the reason, if any row would not go back. */
create or replace function public.restore_check(p_table text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int; v_tmp text := 'restore_' || p_table;
begin
  if to_regclass(format('public.%I', p_table)) is null then raise exception 'Petti has no table called %', p_table; end if;
  begin
    execute format('create temp table %I (like public.%I including defaults including constraints)', v_tmp, p_table);
    execute format('insert into pg_temp.%I select * from jsonb_populate_recordset(null::public.%I, $1)', v_tmp, p_table) using coalesce(p_rows, '[]'::jsonb);
    get diagnostics n = row_count;
    raise exception 'petti_restore_done';   -- undoes the scratch copy; the count is kept
  exception when raise_exception then
    if sqlerrm <> 'petti_restore_done' then raise; end if;
  end;
  return n;
end $$;
revoke execute on function public.restore_check(text, jsonb) from public, anon, authenticated;
grant execute on function public.restore_check(text, jsonb) to service_role;

-- the health check now also says when the copy at the other company failed, stopped, or could not be restored
create or replace function public.health_report(p_hours int default 26) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb := '[]'::jsonb; r record; v_backup timestamptz; v_files int; v_http int; v_errors int; v_short boolean; v_since timestamptz := now() - make_interval(hours => p_hours);
  v_off record; v_off_ok timestamptz;
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
  -- the copy at the other company (quiet until it has been set up and has run once)
  select * into v_off from public.offsite_runs order by id desc limit 1;
  if found then
    select max(finished_at) into v_off_ok from public.offsite_runs where error is null and finished_at is not null;
    if v_off.error is not null and v_off.started_at > v_since then
      v := v || jsonb_build_object('problem', 'The copy to Backblaze failed', 'last', v_off.started_at, 'detail', left(v_off.error, 200));
    elsif v_off_ok is null or v_off_ok < now() - interval '50 hours' then
      v := v || jsonb_build_object('problem', 'No copy sent to Backblaze in the last two days', 'last', v_off_ok);
    end if;
    if exists (select 1 from public.offsite_runs where restore_ok = false and started_at > v_since) then
      v := v || jsonb_build_object('problem', 'The practice restore of the copy failed',
        'detail', (select left(restore_note, 200) from public.offsite_runs where restore_ok = false order by id desc limit 1));
    end if;
  end if;
  select count(*) into v_http from net._http_response where created > v_since and (status_code >= 400 or error_msg is not null);
  if v_http > 0 then v := v || jsonb_build_object('problem', 'Calls to Petti''s server functions failed', 'times', v_http); end if;
  select count(*) into v_errors from public.client_logs where level = 'error' and at > v_since;
  if v_errors >= 10 then v := v || jsonb_build_object('problem', 'Many errors reported by phones', 'times', v_errors); end if;
  return jsonb_build_object('checked_at', now(), 'ok', jsonb_array_length(v) = 0, 'problems', v,
    'last_backup', v_backup, 'backup_files', v_files, 'phone_errors', v_errors,
    'offsite_last', v_off_ok, 'offsite_restore_ok', (select restore_ok from public.offsite_runs where restore_ok is not null order by id desc limit 1));
end $$;
revoke execute on function public.health_report(int) from public, anon, authenticated;
grant execute on function public.health_report(int) to service_role;

-- every night at 02:30 UTC, half an hour after the records are copied; it does nothing until the Backblaze key is added
select cron.schedule('petty-offsite', '30 2 * * *', $cron$select public.call_function('offsite', '{}'::jsonb, 150000)$cron$);
