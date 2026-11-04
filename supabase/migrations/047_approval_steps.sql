-- 047: the approval steps can be changed on the Schedule, and four safeguards.
-- 1. Who approves what by amount is set under Schedule → Who approves what: finance pays alone up to an amount; above it
--    the GM approves up to the GM limit and the MD above (as before), or the GM step or the MD step is switched off
--    (gm_step / md_step). One function, approval_level_for, gives the approver for an amount; routing, top-ups and
--    a pay-out above what was approved all use it. A change waits for the MD like any other limit.
-- 2. A top-up always needs approval: the GM, or the MD where the steps say so.
-- 3. "Pay out now" (cash with no request) has its own limit, never above what finance pays alone.
-- 4. A payment from the company account always needs approval first, whatever the amount.
-- 5. A stand-in can never let one person both approve and pay: the GM or the MD cannot cover finance, and finance
--    cannot cover the GM or the MD (also not by holding two stand-ins at the same time).
-- Every value starts as it is today, so nothing changes until someone edits the Schedule.

alter table public.settings add column if not exists gm_step boolean not null default true;
alter table public.settings add column if not exists md_step boolean not null default true;
alter table public.settings add column if not exists quick_payout_limit numeric(12,2);
update public.settings set quick_payout_limit = approval_threshold where quick_payout_limit is null;
alter table public.settings alter column quick_payout_limit set default 200;
alter table public.settings alter column quick_payout_limit set not null;

/* ------------------------------------------------------------------ who approves an amount */
create or replace function public.approval_level_for(p_amount numeric) returns text
language sql stable security definer set search_path = public as $$
  select case when p_amount <= s.approval_threshold then null
              when s.gm_step and (not s.md_step or p_amount <= s.gm_limit) then 'gm'
              when s.md_step then 'md'
              else 'gm' end
    from public.settings s where s.id = 1
$$;
revoke execute on function public.approval_level_for(numeric) from public, anon;
grant execute on function public.approval_level_for(numeric) to authenticated;

-- "Pay out now": its own limit, never above what finance pays alone
create or replace function public.quick_limit() returns numeric
language sql stable security definer set search_path = public as $$
  select least(quick_payout_limit, approval_threshold) from public.settings where id = 1
$$;
revoke execute on function public.quick_limit() from public, anon;
grant execute on function public.quick_limit() to authenticated;

create or replace function public.approval_route(p_request uuid, p_amount numeric, p_needs boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$

declare r public.requests%rowtype; s public.settings%rowtype; rr public.user_role;
  v_lvl text; v_note text; v_other numeric; v_related text; v_win int; v_who text;
  v_review public.user_role; v_reason text;
begin
  select * into r from public.requests where id = p_request;
  select * into s from public.settings where id = 1;
  select role, full_name into rr, v_who from public.profiles where id = r.requester_id;
  v_win := coalesce(s.split_window_days, 7);
  v_lvl := public.approval_level_for(p_amount);   -- the approval steps on the Schedule (047)

  if v_lvl is null then
    -- small requests that together pass the finance limit need the GM (splitting to avoid approval)
    select coalesce(sum(q.estimated_total), 0), string_agg('#' || q.request_no, ', ' order by q.request_no) into v_other, v_related
      from public.requests q
     where q.requester_id = r.requester_id and q.id <> r.id and not q.for_store and not q.approval_required and q.review_reason is null
       and q.estimated_total <= s.approval_threshold
       and q.status not in ('draft', 'rejected', 'cancelled') and q.submitted_at > now() - make_interval(days => v_win);
    if v_other > 0 and p_amount + v_other > s.approval_threshold then
      v_lvl := coalesce(public.approval_level_for(p_amount + v_other), 'gm');
      v_note := format('Together with %s from the last %s days, %s has asked for %s without approval – above the %s limit.',
                       v_related, v_win, v_who, public.money_text(p_amount + v_other), public.money_text(s.approval_threshold));
    end if;
  elsif v_lvl = 'gm' then
    -- GM-level requests that together pass the GM limit: the GM is shown them and can send it to the MD
    select coalesce(sum(q.estimated_total), 0), string_agg('#' || q.request_no, ', ' order by q.request_no) into v_other, v_related
      from public.requests q
     where q.requester_id = r.requester_id and q.id <> r.id and not q.for_store and q.approval_required and coalesce(q.approval_level, 'gm') = 'gm'
       and q.estimated_total > s.approval_threshold and q.estimated_total <= s.gm_limit and q.review_reason is null
       and q.status not in ('draft', 'rejected', 'cancelled') and q.submitted_at > now() - make_interval(days => v_win);
    if s.gm_step and s.md_step and v_other > 0 and p_amount + v_other > s.gm_limit then
      v_note := format('Together with %s from the last %s days, %s has asked for %s at GM level – above the %s GM limit. If these are parts of one purchase, send it to the MD.',
                       v_related, v_win, v_who, public.money_text(p_amount + v_other), public.money_text(s.gm_limit));
    end if;
  end if;

  if p_needs and v_lvl is null then v_lvl := 'gm'; end if;
  if rr = 'finance' and v_lvl is null then v_lvl := 'gm'; v_note := coalesce(v_note, 'Finance''s own request: approved by the GM, whatever the amount.'); end if;
  if rr = 'approver' and v_lvl = 'gm' then v_lvl := 'md'; v_note := coalesce(v_note, 'The GM''s own request: approved by the Managing Director.'); end if;
  if rr = 'managing_director' and v_lvl is not null then
    v_lvl := null; v_review := 'approver'; v_note := null;
    v_reason := 'The Managing Director''s own request, paid without approval – for the GM to review.';
  end if;
  if v_lvl = 'md' and not public.role_filled('managing_director') then
    if rr = 'approver' then
      v_lvl := null; v_review := 'managing_director'; v_note := null;
      v_reason := 'The GM''s own request, paid without approval because no Managing Director is set up yet – for the MD to review.';
    else
      v_lvl := 'gm';
      v_note := coalesce(v_note || ' ', '') || 'No Managing Director is set up yet, so the GM approves.';
    end if;
  end if;
  return jsonb_build_object('level', v_lvl, 'note', v_note, 'review_role', v_review, 'review_reason', v_reason);
end 
$$;

/* ------------------------------------------------------------------ the schedule knows the new items */
create or replace function public.schedule_keys() returns table (k text, label text, md boolean, kind text, ord int)
language sql immutable as $$
  values
    ('approval_threshold',     'Finance pays alone up to',                         true,  'money',   1),
    ('gm_step',                'The GM approves above that',                       true,  'bool',    2),
    ('gm_limit',               'General Manager approves up to',                   true,  'money',   3),
    ('md_step',                'The MD approves above the GM limit',               true,  'bool',    4),
    ('quick_payout_limit',     '“Pay out now” (cash without a request) up to',     true,  'money',   5),
    ('split_window_days',      'Requests counted together over',                   true,  'days',    6),
    ('change_tolerance_pct',   'Pay-out tolerance',                                true,  'pct',     7),
    ('claims_need_approval',   'Every claim needs approval',                       true,  'bool',    8),
    ('budget_mode',            'When a request goes over its budget',              true,  'mode',    9),
    ('block_with_outstanding', 'Hold new pay-outs to someone who owes a receipt',  true,  'bool',   10),
    ('default_monthly_float',  'Usual monthly float',                              true,  'money',  11),
    ('float_rollover',         'Unspent balance carries into the next month',      true,  'bool',   12),
    ('cash_variance_limit',    'Cash difference allowed at a count',               true,  'money',  13),
    ('stock_adjust_limit',     'Stock correction the controller may make alone',   true,  'money',  14),
    ('advance_grace_days',     'Receipt reminder after',                           false, 'days',   15),
    ('advance_escalate_days',  'Overdue: GM and finance told after',               false, 'days',   16),
    ('cash_count_days',        'Cash count reminder',                              false, 'every',  17),
    ('count_day',              'Weekly stock count reminder',                      false, 'weekday',18),
    ('reserve_buffer_pct',     'Safety buffer on the float minimum',               false, 'pct',    19),
    ('schedule_ref',           'Schedule reference',                               false, 'text',   20),
    ('policy_ref',             'Policy reference',                                 false, 'text',   21),
    ('policy_url',             'Link to the policy',                               false, 'text',   22)
$$;

create or replace function public.schedule_check(v jsonb) returns void
language plpgsql stable set search_path = public as $$
begin
  if not coalesce((v ->> 'gm_step')::boolean, true) and not coalesce((v ->> 'md_step')::boolean, true) then
    raise exception 'Someone must approve amounts above what finance pays alone: keep the GM step or the MD step';
  end if;
  if coalesce((v ->> 'gm_step')::boolean, true) and coalesce((v ->> 'md_step')::boolean, true)
     and (v ->> 'gm_limit')::numeric < (v ->> 'approval_threshold')::numeric then
    raise exception 'The General Manager''s limit (%) cannot be below what finance pays alone (%)', public.money_text((v ->> 'gm_limit')::numeric), public.money_text((v ->> 'approval_threshold')::numeric);
  end if;
  if (v ->> 'quick_payout_limit')::numeric > (v ->> 'approval_threshold')::numeric then
    raise exception '“Pay out now” (%) cannot be more than finance pays alone (%)', public.money_text((v ->> 'quick_payout_limit')::numeric), public.money_text((v ->> 'approval_threshold')::numeric);
  end if;
  if (v ->> 'advance_escalate_days')::int < (v ->> 'advance_grace_days')::int then
    raise exception 'The overdue alert (% days) cannot come before the first reminder (% days)', v ->> 'advance_escalate_days', v ->> 'advance_grace_days';
  end if;
end $$;

create or replace function public.schedule_write(p jsonb) returns void
language plpgsql security definer set search_path = public as $$

declare r public.settings%rowtype;
begin
  select * into r from jsonb_populate_record((select s from public.settings s where s.id = 1), p);
  perform set_config('pcs.schedule', 'on', true);
  update public.settings set
    approval_threshold = r.approval_threshold, gm_limit = r.gm_limit, split_window_days = r.split_window_days,
    change_tolerance_pct = r.change_tolerance_pct, claims_need_approval = r.claims_need_approval, budget_mode = r.budget_mode,
    block_with_outstanding = r.block_with_outstanding, default_monthly_float = r.default_monthly_float, float_rollover = r.float_rollover,
    cash_variance_limit = r.cash_variance_limit, cash_count_days = r.cash_count_days, stock_adjust_limit = r.stock_adjust_limit,
    advance_grace_days = r.advance_grace_days, advance_escalate_days = r.advance_escalate_days, count_day = r.count_day,
    reserve_buffer_pct = r.reserve_buffer_pct, schedule_ref = r.schedule_ref, policy_ref = r.policy_ref, policy_url = r.policy_url,
    gm_step = r.gm_step, md_step = r.md_step, quick_payout_limit = r.quick_payout_limit,
    updated_at = now()
   where id = 1;
  perform set_config('pcs.schedule', 'off', true);
end 
$$;

create or replace function public.settings_schedule_guard() returns trigger
language plpgsql set search_path = public as $$

begin
  if coalesce(current_setting('pcs.schedule', true), '') <> 'on' and (
       (new.approval_threshold, new.gm_limit, new.split_window_days, new.change_tolerance_pct, new.claims_need_approval, new.budget_mode,
        new.block_with_outstanding, new.default_monthly_float, new.float_rollover, new.cash_variance_limit, new.cash_count_days, new.stock_adjust_limit,
        new.advance_grace_days, new.advance_escalate_days, new.count_day, new.reserve_buffer_pct, new.schedule_ref, new.policy_ref, new.policy_url,
        new.gm_step, new.md_step, new.quick_payout_limit)
       is distinct from
       (old.approval_threshold, old.gm_limit, old.split_window_days, old.change_tolerance_pct, old.claims_need_approval, old.budget_mode,
        old.block_with_outstanding, old.default_monthly_float, old.float_rollover, old.cash_variance_limit, old.cash_count_days, old.stock_adjust_limit,
        old.advance_grace_days, old.advance_escalate_days, old.count_day, old.reserve_buffer_pct, old.schedule_ref, old.policy_ref, old.policy_url,
        old.gm_step, old.md_step, old.quick_payout_limit)) then
    raise exception 'Limits, the float, reminders and the policy are changed on the Schedule screen, so every change is versioned';
  end if;
  return new;
end 
$$;

/* ------------------------------------------------------------------ pay-outs, top-ups, "Pay out now" follow the steps */
do $patch$
declare d text; o text; fn text;
begin
  -- paying more than was approved at GM level needs the MD only where the steps send that amount to the MD
  foreach fn in array array['public.disburse_request(uuid, numeric, uuid, text)', 'public.pay_by_transfer(uuid, numeric, date, text, text, text, text, text, text)'] loop
    d := pg_get_functiondef(fn::regprocedure); o := d;
    d := replace(d, 'if r.approved_by is not null and coalesce(r.approval_level, ''gm'') = ''gm'' and p_amount > s.gm_limit then',
                    'if r.approved_by is not null and coalesce(r.approval_level, ''gm'') = ''gm'' and public.approval_level_for(p_amount) = ''md'' then');
    d := replace(d, 'raise exception ''That is above the GM limit (%). Send it back so the Managing Director approves the new amount.'', public.money_text(s.gm_limit);',
                    'raise exception ''That amount needs the Managing Director''''s approval. Send it back so the MD approves the new amount.'';');
    if d = o then raise exception '%: not changed', fn; end if;
    execute d;
  end loop;

  -- a payment from the company account always has an approval first (the MD's own requests are reviewed after, as before)
  d := pg_get_functiondef('public.pay_by_transfer(uuid, numeric, date, text, text, text, text, text, text)'::regprocedure); o := d;
  d := replace(d, 'raise exception ''A bank transfer needs a quote or invoice attached. Without one, pay it in cash from the petty cash box.'';
  end if;',
                  'raise exception ''A bank transfer needs a quote or invoice attached. Without one, pay it in cash from the petty cash box.'';
  end if;
  if p_from = ''company'' and r.approved_by is null and r.review_reason is null then
    raise exception ''A payment from the company account needs approval first, whatever the amount. Tap “Send for approval”.'';
  end if;');
  if d = o then raise exception 'pay_by_transfer (company approval): not changed'; end if;
  execute d;

  -- a top-up always needs approval: the GM, or the MD where the steps say so
  d := pg_get_functiondef('public.request_top_up(numeric, text, numeric, text)'::regprocedure); o := d;
  d := replace(d, 'if p_amount > s.gm_limit then', 'if coalesce(public.approval_level_for(p_amount), ''gm'') = ''md'' then');
  d := replace(d, 'v_note := ''Above the GM limit; no Managing Director is set up yet, so the GM authorises.'';',
                  'v_note := ''The steps send this amount to the MD; no Managing Director is set up yet, so the GM authorises.'';');
  if d = o then raise exception 'request_top_up: not changed'; end if;
  execute d;

  -- "Pay out now" has its own limit
  d := pg_get_functiondef('public.quick_payout(uuid, numeric, text, uuid, text)'::regprocedure); o := d;
  d := replace(d, 'if p_amount > public.threshold() then raise exception ''Above the % limit – raise a request so the approver can sign it off first'', public.money_text(public.threshold()); end if;',
                  'if p_amount > public.quick_limit() then raise exception ''“Pay out now” is for up to % – raise a request instead'', public.money_text(public.quick_limit()); end if;');
  if d = o then raise exception 'quick_payout: not changed'; end if;
  execute d;
end $patch$;

/* ------------------------------------------------------------------ stand-ins never join approving and paying */
create or replace function public.delegations_conflict_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_to public.user_role; v_name text;
begin
  select role, coalesce(nullif(full_name, ''), email) into v_to, v_name from public.profiles where id = new.to_user;
  if new.role = 'finance' and v_to in ('approver', 'managing_director') then
    raise exception '% approves, so cannot also stand in for finance, who pays. Choose someone else.', v_name;
  end if;
  if new.role in ('approver', 'managing_director') and v_to = 'finance' then
    raise exception '% pays, so cannot also stand in for the %, who approves. Choose someone else.', v_name, case when new.role = 'approver' then 'GM' else 'MD' end;
  end if;
  -- the same person covering finance and an approver at the same time
  if exists (select 1 from public.delegations d
              where d.to_user = new.to_user and d.id is distinct from new.id
                and d.starts_on <= new.ends_on and new.starts_on <= d.ends_on
                and ((new.role = 'finance' and d.role in ('approver', 'managing_director'))
                  or (new.role in ('approver', 'managing_director') and d.role = 'finance'))) then
    raise exception '% already stands in for % at that time. One person cannot both approve and pay. Choose someone else.',
      v_name, case when new.role = 'finance' then 'an approver' else 'finance' end;
  end if;
  return new;
end $$;
create trigger delegations_conflict_guard before insert or update on public.delegations
  for each row execute function public.delegations_conflict_guard();
