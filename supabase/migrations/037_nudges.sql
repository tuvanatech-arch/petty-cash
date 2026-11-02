-- Follow-up nudges: (1) the person who submits is told who has it now; (2) a request that waits is chased with the
-- right person (the MD when it is the MD's to approve) and, after two working days, the person who asked is told
-- it was chased. Reminders now go out on working days only, and "days" means working days.

-- working days (Monday to Friday, in the organisation's time zone) since a moment
create or replace function public.working_days_since(p_from timestamptz) returns integer
language sql stable set search_path = public as $$
  select count(*)::int
  from generate_series((p_from at time zone public.app_tz())::date + 1, (now() at time zone public.app_tz())::date, interval '1 day') d
  where extract(isodow from d) <= 5
$$;

-- 1. the person who submitted sees who has it now (in the app only: they have just tapped Send, so no phone buzz)
create or replace function public.submitted_note() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_with text;
begin
  v_with := case new.status
    when 'stock_review' then 'the stock manager to review'
    when 'pending_approval' then case when new.approval_level = 'md' then 'the MD' else 'the GM' end || ' for approval'
    when 'awaiting_disbursement' then 'finance to ' || case when new.type = 'claim' then 'reimburse' else 'pay out' end
    else null end;
  if v_with is null then return new; end if;
  insert into public.notifications (user_id, kind, title, body, link, request_id, emailed_at, email_status)
  values (new.requester_id, 'submitted', 'Sent: ' || public.req_label(new),
    'It is with ' || v_with || '. You will be told as soon as it moves, and we remind them if it waits.',
    '#/requests/' || new.id, new.id, now(), 'in_app_only');
  return new;
end $$;
revoke execute on function public.submitted_note() from public, anon, authenticated;
create or replace trigger requests_submitted_note after update of status on public.requests
  for each row when (old.status = 'draft' and new.status <> 'draft') execute function public.submitted_note();

-- the "sent" confirmation is not pushed to the phone; everything else still is
create or replace function public.notifications_push_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'submitted' then return new; end if;
  perform public.call_function('send-push', jsonb_build_object('id', new.id), 15000);
  return new;
exception when others then
  return new; -- a push hiccup never blocks the alert itself
end $$;
revoke execute on function public.notifications_push_trigger() from public, anon, authenticated;

-- 2. nothing waits silently: remind whoever holds it, tell the GM when it is stuck, and tell the person who asked
create or replace function public.remind_stale_items() returns int
language plpgsql security definer set search_path = public as $$
declare q public.requests%rowtype; n int := 0; v_holder public.user_role; v_days int; v_label text; v_who text; v_plural text;
begin
  if extract(isodow from now() at time zone public.app_tz()) > 5 then return 0; end if;   -- never on a weekend
  for q in select * from public.requests where status in ('stock_review', 'pending_approval', 'awaiting_disbursement', 'proof_review', 'physical_required') and updated_at < now() - interval '24 hours' loop
    v_days := public.working_days_since(q.updated_at);
    if v_days < 1 then continue; end if;
    if exists (select 1 from public.notifications where request_id = q.id and kind in ('stale', 'stale_escalation') and created_at > now() - interval '20 hours') then continue; end if;
    v_plural := v_days || ' working day' || case when v_days = 1 then '' else 's' end;
    v_holder := case q.status
      when 'stock_review' then 'stock_manager'::public.user_role
      when 'pending_approval' then case when q.approval_level = 'md' then 'managing_director'::public.user_role else 'approver'::public.user_role end
      else 'finance'::public.user_role end;
    v_label := public.req_label(q) || ' (' || public.money_text(q.estimated_total) || ') has been waiting ' || v_plural;
    perform public.notify_role(v_holder, 'stale', 'Waiting on you: ' || public.req_label(q), v_label || case q.status when 'stock_review' then ' for stock review.' when 'pending_approval' then ' for approval.' when 'awaiting_disbursement' then ' to be paid out.' when 'proof_review' then ' for the receipt check.' else ' for the paper receipt.' end, '#/requests/' || q.id, q.id);
    if q.status = 'physical_required' and q.disbursed_to is not null then
      perform public.notify_user(q.disbursed_to, 'stale', 'Finance still needs your paper receipt', v_label || '. Hand the original to finance.', '#/requests/' || q.id, q.id);
    end if;
    if v_days >= 2 and v_holder <> 'approver' then
      perform public.notify_role('approver', 'stale_escalation', 'Stuck for ' || v_plural || ': ' || public.req_label(q), 'With ' || replace(v_holder::text, '_', ' ') || ' since ' || to_char(q.updated_at, 'DD Mon') || '.', '#/requests/' || q.id, q.id);
    end if;
    -- the person who asked hears that it was chased, once for each time it sits with someone
    if v_days >= 2 and q.status <> 'physical_required'
       and not exists (select 1 from public.notifications where request_id = q.id and user_id = q.requester_id and kind = 'chased' and created_at > q.updated_at) then
      v_who := case q.status when 'stock_review' then 'the stock manager' when 'pending_approval' then case when q.approval_level = 'md' then 'the MD' else 'the GM' end else 'finance' end;
      perform public.notify_user(q.requester_id, 'chased', 'Still waiting: ' || public.req_label(q),
        'It has been with ' || v_who || ' for ' || v_plural || '. We have reminded them.', '#/requests/' || q.id, q.id);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.remind_stale_items() from public, anon, authenticated;

-- a fault found while testing: the daily "cash is out, record your receipt" reminder has failed since 1 Nov
-- ("cannot cast type record to requests"), so nobody was reminded; the same slip would turn the friendly
-- "you still have N$… to account for" message in submit_request into an error. Both now use a proper request row.
do $$
declare d text; o text;
begin
  d := pg_get_functiondef('public.remind_outstanding_advances()'::regprocedure); o := d;
  d := replace(d, 'declare q record;', 'declare q public.requests%rowtype;');
  if d = o then raise exception 'remind_outstanding_advances: declaration not found – not changed'; end if;
  execute d;
  d := pg_get_functiondef('public.submit_request(uuid)'::regprocedure); o := d;
  d := replace(d, 'o record;', 'o public.requests%rowtype;');
  if d = o then raise exception 'submit_request: declaration not found – not changed'; end if;
  execute d;
end $$;

-- both reminders run on weekday mornings only (the first at 09:00 and 10:00 Namibian time)
select cron.schedule('petty-advance-reminders', '0 7 * * 1-5', 'select public.remind_outstanding_advances()');
select cron.schedule('petty-stale-items', '0 8 * * 1-5', 'select public.remind_stale_items()');
