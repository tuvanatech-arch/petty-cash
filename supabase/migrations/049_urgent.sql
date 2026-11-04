-- 049: urgent requests.
--   • The requester ticks "Urgent" on the form and says why (set_urgent on the draft). The GM or the MD can mark a request
--     urgent later (for example while approving, so finance pays it first).
--   • An urgent request is flagged to whoever acts next: the alerts of each stage (notify_stage) start with "Urgent – " and
--     carry the reason; the screens put urgent requests first with a red label.
--   • Nobody acting: one reminder to the same people 2 hours after it reached them (working hours, Mon–Fri 07:00–18:00 local),
--     and 2 hours after that the GM is told (unless it is the GM it is waiting for). Every new stage starts the clock again.
--   • The GM, the MD or finance can take the label off with a note; the requester is told.
--   • Urgent changes only the order and the alerts: never an approval or a limit.

alter table public.requests add column if not exists urgent boolean not null default false;
alter table public.requests add column if not exists urgent_reason text;
alter table public.requests add column if not exists urgent_marked_by uuid references public.profiles(id);
alter table public.requests add column if not exists urgent_marked_at timestamptz;
alter table public.requests add column if not exists urgent_stage_at timestamptz;      -- when it reached the people who act on it now
alter table public.requests add column if not exists urgent_chased_at timestamptz;     -- the one reminder at this stage
alter table public.requests add column if not exists urgent_escalated_at timestamptz;  -- the GM told at this stage
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'requests_urgent_reason') then
    alter table public.requests add constraint requests_urgent_reason check (not urgent or length(trim(coalesce(urgent_reason, ''))) >= 3);
  end if;
end $$;

-- each new stage (sending the draft included) starts the reminder clock again
create or replace function public.requests_urgent_stage() returns trigger language plpgsql set search_path = public as $$
begin
  if new.urgent and new.status is distinct from old.status then
    new.urgent_stage_at := now(); new.urgent_chased_at := null; new.urgent_escalated_at := null;
  end if;
  return new;
end $$;
create or replace trigger requests_urgent_stage before update of status on public.requests for each row execute function public.requests_urgent_stage();
revoke execute on function public.requests_urgent_stage() from public, anon, authenticated;

-- mark or unmark. The requester on their own draft; later the GM or the MD marks, and the GM, the MD or finance unmarks.
create or replace function public.set_urgent(p_request uuid, p_urgent boolean, p_reason text default null)
returns public.requests language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; v_open boolean; v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.urgent = p_urgent and (not p_urgent or r.urgent_reason is not distinct from v_reason) then return r; end if;
  if p_urgent and length(coalesce(v_reason, '')) < 3 then raise exception 'Say why it is urgent'; end if;
  v_open := r.status in ('stock_review', 'pending_approval', 'awaiting_disbursement');
  if r.status = 'draft' then
    if r.requester_id <> auth.uid() then raise exception 'Only the requester can change their draft'; end if;
    update public.requests set urgent = p_urgent, urgent_reason = case when p_urgent then v_reason end,
      urgent_marked_by = case when p_urgent then auth.uid() end, urgent_marked_at = case when p_urgent then now() end,
      urgent_stage_at = null, urgent_chased_at = null, urgent_escalated_at = null
    where id = p_request returning * into r;
    return r;
  end if;
  if not v_open then raise exception 'Only a request that is still waiting can be marked or unmarked urgent'; end if;
  if p_urgent then
    if not (public.has_role('approver') or public.has_role('managing_director')) then raise exception 'Only the GM or the MD can mark a sent request urgent'; end if;
    update public.requests set urgent = true, urgent_reason = v_reason, urgent_marked_by = auth.uid(), urgent_marked_at = now(),
      urgent_stage_at = now(), urgent_chased_at = null, urgent_escalated_at = null
    where id = p_request returning * into r;
    perform public.log_event(p_request, 'marked_urgent', r.status, r.status, v_reason);
    perform public.notify_stage(p_request);   -- whoever acts next hears it now
  else
    if not (public.has_role('approver') or public.has_role('managing_director') or public.has_role('finance')) then raise exception 'Only the GM, the MD or finance can take the urgent label off'; end if;
    if length(coalesce(v_reason, '')) < 3 then raise exception 'Say why it is not urgent'; end if;
    update public.requests set urgent = false, urgent_reason = null, urgent_stage_at = null, urgent_chased_at = null, urgent_escalated_at = null
    where id = p_request returning * into r;
    perform public.log_event(p_request, 'unmarked_urgent', r.status, r.status, v_reason);
    perform public.notify_user(r.requester_id, 'urgent', 'No longer marked urgent: ' || public.req_label(r), v_reason, '#/requests/' || r.id, r.id);
  end if;
  return r;
end $$;
revoke execute on function public.set_urgent(uuid, boolean, text) from public, anon;
grant execute on function public.set_urgent(uuid, boolean, text) to authenticated;

-- the alert of each stage: "Urgent – " in front and the reason behind, for an urgent request; "Still waiting, urgent – " for the reminder
create or replace function public.notify_stage(p_request uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; v_who text; v_label text; v_link text; v_pre text := ''; v_why text := '';
begin
  select * into r from public.requests where id = p_request;
  v_label := public.req_label(r); v_link := '#/requests/' || r.id;
  select full_name into v_who from public.profiles where id = r.requester_id;
  if r.urgent then
    v_pre := case when current_setting('pcs.urgent_chase', true) = 'on' then 'Still waiting, urgent – ' else 'Urgent – ' end;
    v_why := '. Urgent: ' || r.urgent_reason || case when r.needed_by is not null then ' (needed by ' || to_char(r.needed_by, 'FMDD Mon') || ')' else '' end;
  end if;
  if r.status = 'stock_review' then
    perform public.notify_role('stock_manager', 'stock_review', v_pre || 'Stock request to review', v_label || ' from ' || v_who || ' – estimated ' || public.money_text(r.estimated_total) || v_why, v_link, r.id);
  elsif r.status = 'pending_approval' then
    perform public.notify_role(case when r.approval_level = 'md' then 'managing_director' else 'approver' end::public.user_role, 'approval',
      v_pre || 'Needs your approval: ' || public.money_text(r.estimated_total),
      v_label || ' from ' || v_who || case when r.over_budget then '. ' || r.budget_note else '' end || case when r.route_note is not null then '. ' || r.route_note else '' end || v_why,
      v_link, r.id);
  elsif r.status = 'awaiting_disbursement' then
    perform public.notify_role('finance', 'payout', v_pre || case when r.type = 'claim' then 'Claim to reimburse: ' else 'Ready to pay out: ' end || public.money_text(r.estimated_total), v_label || ' – ' || v_who || v_why, v_link, r.id);
  elsif r.status = 'proof_review' then
    perform public.notify_role('finance', 'proof', 'Receipt to check', v_label || ' – ' || v_who, v_link, r.id);
  end if;
end $$;

-- every 10 minutes: one reminder 2 hours after an urgent request reached the people who act on it, and the GM told 2 hours
-- after that (not when it is the GM it waits for). Working hours only.
create or replace function public.urgent_chase() returns int
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; n int := 0; v_local timestamp := now() at time zone public.app_tz();
begin
  if extract(isodow from v_local) > 5 or extract(hour from v_local) < 7 or extract(hour from v_local) >= 18 then return 0; end if;
  perform set_config('pcs.urgent_chase', 'on', true);
  for r in select * from public.requests where urgent and status in ('stock_review', 'pending_approval', 'awaiting_disbursement')
             and urgent_chased_at is null and urgent_stage_at <= now() - interval '2 hours' loop
    perform public.notify_stage(r.id);
    update public.requests set urgent_chased_at = now() where id = r.id;
    n := n + 1;
  end loop;
  for r in select * from public.requests where urgent and status in ('stock_review', 'pending_approval', 'awaiting_disbursement')
             and urgent_escalated_at is null and urgent_chased_at <= now() - interval '2 hours' loop
    if not (r.status = 'pending_approval' and coalesce(r.approval_level, 'gm') = 'gm') then
      perform public.notify_role('approver', 'urgent', 'Urgent request still waiting: ' || public.req_label(r),
        case r.status when 'stock_review' then 'With the stock controller' when 'pending_approval' then 'Waiting for the MD''s approval' else 'Approved, waiting for finance to pay' end
          || ' since ' || to_char(r.urgent_stage_at at time zone public.app_tz(), 'HH24:MI') || '. Urgent: ' || r.urgent_reason,
        '#/requests/' || r.id, r.id);
    end if;
    update public.requests set urgent_escalated_at = now() where id = r.id;
    n := n + 1;
  end loop;
  perform set_config('pcs.urgent_chase', 'off', true);
  return n;
end $$;
revoke execute on function public.urgent_chase() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'petty-urgent-chase') then perform cron.unschedule('petty-urgent-chase'); end if;
end $$;
select cron.schedule('petty-urgent-chase', '*/10 * * * *', 'select public.urgent_chase()');
