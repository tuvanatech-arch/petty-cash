-- 022: cash controls. Finance proves the float on any day and the GM signs the proof off.
--  · A cash count compares the cash in the box with the book balance; a difference above the schedule's limit needs a
--    reason from finance and a resolution from the GM, who can write it off (cash short / cash over).
--  · The month-end close is a count like any other.
--  · Top-ups are requested by finance with a count attached, authorised by the GM (the MD above the GM limit) and
--    recorded when the cash arrives; only one can be open at a time.
--  · The ledger lists every movement of cash with a running balance.
--  · A receipt photo or a receipt (same supplier, date and amount) already used on another request is flagged,
--    and accepting it needs a written explanation.
-- (022a added the float_tx_kind values 'shortage' and 'surplus'.)

/* ======================================================================= the schedule gains two items */
alter table public.settings add column if not exists cash_variance_limit numeric not null default 0;
alter table public.settings add column if not exists cash_count_days integer not null default 7;

create or replace function public.schedule_keys() returns table (k text, label text, md boolean, kind text, ord int)
language sql immutable as $$
  values
    ('approval_threshold',     'Finance pays alone up to',                         true,  'money',   1),
    ('gm_limit',               'General Manager approves up to',                   true,  'money',   2),
    ('split_window_days',      'Requests counted together over',                   true,  'days',    3),
    ('change_tolerance_pct',   'Pay-out tolerance',                                true,  'pct',     4),
    ('claims_need_approval',   'Every claim needs approval',                       true,  'bool',    5),
    ('budget_mode',            'When a request goes over its budget',              true,  'mode',    6),
    ('block_with_outstanding', 'Hold new pay-outs to someone who owes a receipt',  true,  'bool',    7),
    ('default_monthly_float',  'Usual monthly float',                              true,  'money',   8),
    ('float_rollover',         'Unspent balance carries into the next month',      true,  'bool',    9),
    ('cash_variance_limit',    'Cash difference allowed at a count',               true,  'money',  10),
    ('advance_grace_days',     'Receipt reminder after',                           false, 'days',   11),
    ('advance_escalate_days',  'Overdue: GM and finance told after',               false, 'days',   12),
    ('cash_count_days',        'Cash count reminder',                              false, 'every',  13),
    ('count_day',              'Weekly stock count reminder',                      false, 'weekday',14),
    ('reserve_buffer_pct',     'Safety buffer on the float minimum',               false, 'pct',    15),
    ('schedule_ref',           'Schedule reference',                               false, 'text',   16),
    ('policy_ref',             'Policy reference',                                 false, 'text',   17),
    ('policy_url',             'Link to the policy',                               false, 'text',   18)
$$;

create or replace function public.schedule_fmt(p_kind text, p_v jsonb) returns text
language sql stable set search_path = public as $$
  select case
    when p_v is null or jsonb_typeof(p_v) = 'null' then '—'
    when p_kind = 'money' then public.money_text((p_v #>> '{}')::numeric)
    when p_kind = 'days' then (p_v #>> '{}') || case when (p_v #>> '{}') = '1' then ' day' else ' days' end
    when p_kind = 'every' then case (p_v #>> '{}')::int when 0 then 'Off' when 1 then 'Every day' when 7 then 'Every week' when 14 then 'Every two weeks' else 'Every ' || (p_v #>> '{}') || ' days' end
    when p_kind = 'pct' then trim_scale((p_v #>> '{}')::numeric)::text || '%'
    when p_kind = 'bool' then case when (p_v #>> '{}')::boolean then 'Yes' else 'No' end
    when p_kind = 'mode' then case p_v #>> '{}' when 'warn' then 'Flag it, let it through' when 'require_approval' then 'Send it for approval' when 'block' then 'Block it' else p_v #>> '{}' end
    when p_kind = 'weekday' then case (p_v #>> '{}')::int when 0 then 'No reminder' when 1 then 'Monday' when 2 then 'Tuesday' when 3 then 'Wednesday' when 4 then 'Thursday' when 5 then 'Friday' else p_v #>> '{}' end
    else coalesce(nullif(p_v #>> '{}', ''), '—') end
$$;

create or replace function public.schedule_clean(p jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare v_k text; v jsonb; meta record; o jsonb := '{}'::jsonb; n numeric; t text;
begin
  for v_k, v in select * from jsonb_each(coalesce(p, '{}'::jsonb)) loop
    select * into meta from public.schedule_keys() sk where sk.k = v_k;
    if meta.k is null then raise exception 'Unknown schedule item: %', v_k; end if;
    if meta.kind in ('money', 'days', 'pct', 'weekday', 'every') then
      begin n := (v #>> '{}')::numeric; exception when others then raise exception '% must be a number', meta.label; end;
      if n is null then raise exception '% must be a number', meta.label; end if;
      if meta.kind = 'money' then
        if n < 0 then raise exception '% cannot be negative', meta.label; end if;
        o := o || jsonb_build_object(v_k, round(n, 2));
      elsif v_k = 'split_window_days' then
        if n < 1 or n > 31 then raise exception '% must be 1 to 31 days', meta.label; end if; o := o || jsonb_build_object(v_k, round(n)::int);
      elsif v_k = 'advance_grace_days' then
        if n < 1 or n > 60 then raise exception '% must be 1 to 60 days', meta.label; end if; o := o || jsonb_build_object(v_k, round(n)::int);
      elsif v_k = 'advance_escalate_days' then
        if n < 1 or n > 90 then raise exception '% must be 1 to 90 days', meta.label; end if; o := o || jsonb_build_object(v_k, round(n)::int);
      elsif v_k = 'cash_count_days' then
        if n < 0 or n > 31 then raise exception '% must be 0 (off) to 31 days', meta.label; end if; o := o || jsonb_build_object(v_k, round(n)::int);
      elsif v_k = 'change_tolerance_pct' then
        if n < 0 or n > 50 then raise exception '% must be 0 to 50%%', meta.label; end if; o := o || jsonb_build_object(v_k, round(n, 1));
      elsif v_k = 'reserve_buffer_pct' then
        if n < 0 or n > 100 then raise exception '% must be 0 to 100%%', meta.label; end if; o := o || jsonb_build_object(v_k, round(n)::int);
      elsif v_k = 'count_day' then
        if n not in (0, 1, 2, 3, 4, 5) then raise exception 'Pick a weekday for the count reminder'; end if; o := o || jsonb_build_object(v_k, n::int);
      end if;
    elsif meta.kind = 'bool' then
      if jsonb_typeof(v) <> 'boolean' then raise exception '% must be yes or no', meta.label; end if;
      o := o || jsonb_build_object(v_k, v);
    elsif meta.kind = 'mode' then
      if v #>> '{}' not in ('warn', 'require_approval', 'block') then raise exception 'Choose what happens when a request goes over its budget'; end if;
      o := o || jsonb_build_object(v_k, v #>> '{}');
    else
      t := btrim(coalesce(v #>> '{}', ''));
      if v_k = 'policy_url' then
        if t <> '' and t !~* '^https?://\S+$' then raise exception 'The policy link must start with https://'; end if;
        o := o || jsonb_build_object(v_k, nullif(t, ''));
      else
        if t = '' then raise exception '% cannot be empty', meta.label; end if;
        o := o || jsonb_build_object(v_k, left(t, 40));
      end if;
    end if;
  end loop;
  return o;
end $$;
revoke execute on function public.schedule_clean(jsonb) from public, anon, authenticated;

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
    cash_variance_limit = r.cash_variance_limit, cash_count_days = r.cash_count_days,
    advance_grace_days = r.advance_grace_days, advance_escalate_days = r.advance_escalate_days, count_day = r.count_day,
    reserve_buffer_pct = r.reserve_buffer_pct, schedule_ref = r.schedule_ref, policy_ref = r.policy_ref, policy_url = r.policy_url,
    updated_at = now()
   where id = 1;
  perform set_config('pcs.schedule', 'off', true);
end $$;
revoke execute on function public.schedule_write(jsonb) from public, anon, authenticated;

create or replace function public.settings_schedule_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('pcs.schedule', true), '') <> 'on' and (
       (new.approval_threshold, new.gm_limit, new.split_window_days, new.change_tolerance_pct, new.claims_need_approval, new.budget_mode,
        new.block_with_outstanding, new.default_monthly_float, new.float_rollover, new.cash_variance_limit, new.cash_count_days,
        new.advance_grace_days, new.advance_escalate_days, new.count_day, new.reserve_buffer_pct, new.schedule_ref, new.policy_ref, new.policy_url)
       is distinct from
       (old.approval_threshold, old.gm_limit, old.split_window_days, old.change_tolerance_pct, old.claims_need_approval, old.budget_mode,
        old.block_with_outstanding, old.default_monthly_float, old.float_rollover, old.cash_variance_limit, old.cash_count_days,
        old.advance_grace_days, old.advance_escalate_days, old.count_day, old.reserve_buffer_pct, old.schedule_ref, old.policy_ref, old.policy_url)) then
    raise exception 'Limits, the float, reminders and the policy are changed on the Schedule screen, so every change is versioned';
  end if;
  return new;
end $$;

/* ======================================================================= the book balance and the float view */
create or replace function public.float_balance(p_float uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select round(
      coalesce((select sum(case when kind in ('return', 'shortage') then -amount else amount end)
                from public.float_transactions where float_id = p_float), 0)
    - coalesce((select sum(disbursed_amount) from public.requests
                where float_id = p_float and status = 'disbursed'), 0)
    - coalesce((select sum(e.total) from public.expenses e
                join public.requests r on r.id = e.request_id
                where r.float_id = p_float and r.status in ('proof_review','physical_required','closed')), 0)
  , 2)
$$;

create or replace view public.v_floats as
  select id, period, opening_amount, status, opened_by, opened_at, closed_by, closed_at, counted_cash, notes,
    coalesce((select sum(t.amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'allocation'), 0) as allocated,
    coalesce((select sum(t.amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'top_up'), 0) as topped_up,
    coalesce((select sum(t.amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'carry_over'), 0) as carried_over,
    coalesce((select sum(t.amount) from public.float_transactions t where t.float_id = f.id and t.kind = 'return'), 0) as returned,
    coalesce((select sum(r.disbursed_amount) from public.requests r where r.float_id = f.id and r.status = 'disbursed'), 0) as outstanding,
    coalesce((select sum(e.total) from public.expenses e join public.requests r on r.id = e.request_id
               where r.float_id = f.id and r.status in ('proof_review', 'physical_required', 'closed')), 0) as spent,
    public.float_balance(id) as balance,
    coalesce((select sum(case when t.kind = 'surplus' then t.amount else -t.amount end) from public.float_transactions t
               where t.float_id = f.id and t.kind in ('surplus', 'shortage')), 0) as adjusted
  from public.floats f;

-- by hand, finance only returns cash to the finance office; top-ups go through request → authorise → receive
create or replace function public.float_transaction(p_float uuid, p_kind public.float_tx_kind, p_amount numeric, p_note text default null)
returns public.float_transactions language plpgsql security definer set search_path = public as $$
declare t public.float_transactions%rowtype; f public.floats%rowtype;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can change the float'; end if;
  if p_kind = 'top_up' then raise exception 'A top-up is requested first and authorised by the GM; record it under Petty cash when the cash arrives'; end if;
  if p_kind <> 'return' then raise exception 'Only returns to the finance office are recorded by hand'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount'; end if;
  select * into f from public.floats where id = p_float for update;
  if f.id is null or f.status <> 'open' then raise exception 'Float is not open'; end if;
  if public.float_balance(f.id) < p_amount then raise exception 'Cannot return more than the balance'; end if;
  insert into public.float_transactions (float_id, kind, amount, created_by, note) values (f.id, p_kind, round(p_amount, 2), auth.uid(), nullif(p_note, '')) returning * into t;
  return t;
end $$;

/* ======================================================================= cash counts */
create table if not exists public.cash_counts (
  id uuid primary key default gen_random_uuid(),
  float_id uuid not null references public.floats(id),
  kind text not null default 'spot' check (kind in ('spot', 'month_end', 'top_up')),
  counted numeric not null check (counted >= 0),
  expected numeric not null,                                   -- the book balance when counted
  outstanding numeric not null default 0,                      -- cash out with people then (already off the book)
  difference numeric generated always as (counted - expected) stored,
  variance_limit numeric not null default 0,                   -- the schedule's limit when counted
  exception boolean not null default false,                    -- difference above that limit
  note text,                                                   -- finance: what caused a difference
  counted_by uuid not null references public.profiles(id),
  counted_at timestamptz not null default now(),
  status text not null default 'to_review' check (status in ('to_review', 'queried', 'accepted', 'superseded')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_note text,                                            -- the GM's question, or the resolution on acceptance
  answer_note text,                                            -- finance's answer to a question
  written_off numeric                                          -- difference written off on acceptance (signed)
);
create index if not exists cash_counts_float on public.cash_counts (float_id, counted_at desc);
alter table public.cash_counts enable row level security;
create policy cash_counts_select on public.cash_counts for select to authenticated using (public.has_role('finance') or public.has_role('approver'));

create or replace function public.cash_count_text(c public.cash_counts) returns text
language sql stable set search_path = public as $$
  select case when abs(c.difference) < 0.005 then 'matches the book (' || public.money_text(c.counted) || ')'
              when c.difference < 0 then public.money_text(-c.difference) || ' short (counted ' || public.money_text(c.counted) || ', book ' || public.money_text(c.expected) || ')'
              else public.money_text(c.difference) || ' over (counted ' || public.money_text(c.counted) || ', book ' || public.money_text(c.expected) || ')' end
$$;

-- the one place a count is recorded (spot count, month-end close, top-up request)
create or replace function public.cash_count_record(p_float uuid, p_counted numeric, p_note text, p_kind text, p_tell boolean default true)
returns public.cash_counts language plpgsql security definer set search_path = public as $$
declare c public.cash_counts%rowtype; s public.settings%rowtype; v_expected numeric; v_out numeric; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_counted is null or p_counted < 0 then raise exception 'Enter the cash counted in the box'; end if;
  select * into s from public.settings where id = 1;
  v_expected := public.float_balance(p_float);
  select coalesce(sum(disbursed_amount), 0) into v_out from public.requests where float_id = p_float and status = 'disbursed';
  if abs(round(p_counted, 2) - v_expected) > coalesce(s.cash_variance_limit, 0) + 0.004 and v_note is null then
    raise exception 'The box is % % the book balance of %. Say what you think caused it – the GM sees your note.',
      public.money_text(abs(round(p_counted, 2) - v_expected)), case when p_counted < v_expected then 'short of' else 'over' end, public.money_text(v_expected);
  end if;
  -- an earlier count still waiting for sign-off is replaced by this one
  update public.cash_counts set status = 'superseded' where float_id = p_float and status in ('to_review', 'queried');
  insert into public.cash_counts (float_id, kind, counted, expected, outstanding, variance_limit, exception, note, counted_by)
  values (p_float, p_kind, round(p_counted, 2), v_expected, v_out, coalesce(s.cash_variance_limit, 0),
          abs(round(p_counted, 2) - v_expected) > coalesce(s.cash_variance_limit, 0) + 0.004, v_note, auth.uid())
  returning * into c;
  if p_tell then
    perform public.notify_role('approver', 'cash_count',
      case when c.exception then 'Cash count to sign off: ' || case when c.difference < 0 then public.money_text(-c.difference) || ' short' else public.money_text(c.difference) || ' over' end
           else 'Cash count to sign off' end,
      case c.kind when 'month_end' then 'Month-end count' else 'Cash count' end || ' by ' || coalesce((select full_name from public.profiles where id = auth.uid()), 'finance') || ': '
        || public.cash_count_text(c) || coalesce(' – “' || c.note || '”', ''),
      '#/cash', null);
  end if;
  return c;
end $$;
revoke execute on function public.cash_count_record(uuid, numeric, text, text, boolean) from public, anon, authenticated;

-- finance counts the box, any day
create or replace function public.count_cash(p_counted numeric, p_note text default null) returns public.cash_counts
language plpgsql security definer set search_path = public as $$
declare f public.floats%rowtype;
begin
  if not public.has_role('finance') then raise exception 'The cash is counted by finance, who holds it'; end if;
  f := public.current_float();
  if f.id is null then raise exception 'No float is open'; end if;
  return public.cash_count_record(f.id, p_counted, p_note, 'spot');
end $$;
revoke execute on function public.count_cash(numeric, text) from public, anon;
grant execute on function public.count_cash(numeric, text) to authenticated;

-- the GM signs a count off (never their own), or asks finance a question about it
create or replace function public.review_cash_count(p_id uuid, p_accept boolean, p_note text default null, p_write_off boolean default false)
returns public.cash_counts language plpgsql security definer set search_path = public as $$
declare c public.cash_counts%rowtype; f public.floats%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_latest uuid;
begin
  if not public.has_role('approver') then raise exception 'Cash counts are signed off by the General Manager'; end if;
  select * into c from public.cash_counts where id = p_id for update;
  if c.id is null then raise exception 'Count not found'; end if;
  if c.counted_by = auth.uid() then raise exception 'Someone else must sign off your own count'; end if;
  if c.status not in ('to_review', 'queried') then raise exception 'This count is no longer waiting for sign-off'; end if;
  if not p_accept then
    if v_note is null then raise exception 'Write the question for finance'; end if;
    update public.cash_counts set status = 'queried', reviewed_by = auth.uid(), reviewed_at = now(), review_note = v_note where id = p_id returning * into c;
    perform public.notify_user(c.counted_by, 'cash_count', 'Question on your cash count', v_note, '#/cash', null);
    return c;
  end if;
  if c.exception and v_note is null then
    raise exception 'The difference is above the % allowed: say how it was resolved', public.money_text(c.variance_limit);
  end if;
  if p_write_off and abs(c.difference) >= 0.005 then
    select id into v_latest from public.cash_counts where float_id = c.float_id and status <> 'superseded' order by counted_at desc limit 1;
    if v_latest <> c.id then raise exception 'A later count exists – write off the difference on that one'; end if;
    select * into f from public.floats where id = c.float_id;
    insert into public.float_transactions (float_id, kind, amount, created_by, note)
    values (c.float_id, case when c.difference < 0 then 'shortage'::public.float_tx_kind else 'surplus'::public.float_tx_kind end, abs(c.difference), auth.uid(),
            case when c.difference < 0 then 'Cash short' else 'Cash over' end || ' at the count of ' || to_char(c.counted_at at time zone 'Africa/Windhoek', 'DD Mon') || ', written off'
              || coalesce(' – ' || v_note, ''));
  end if;
  update public.cash_counts set status = 'accepted', reviewed_by = auth.uid(), reviewed_at = now(), review_note = coalesce(v_note, review_note),
         written_off = case when p_write_off and abs(c.difference) >= 0.005 then c.difference end
   where id = p_id returning * into c;
  perform public.notify_user(c.counted_by, 'cash_count', 'Cash count signed off',
    'Counted ' || to_char(c.counted_at at time zone 'Africa/Windhoek', 'DD Mon') || ': ' || public.cash_count_text(c) || case when c.written_off is not null then ' – the difference was written off.' else '.' end, '#/cash', null);
  return c;
end $$;
revoke execute on function public.review_cash_count(uuid, boolean, text, boolean) from public, anon;
grant execute on function public.review_cash_count(uuid, boolean, text, boolean) to authenticated;

create or replace function public.answer_cash_count(p_id uuid, p_note text) returns public.cash_counts
language plpgsql security definer set search_path = public as $$
declare c public.cash_counts%rowtype;
begin
  if not public.has_role('finance') then raise exception 'Finance answers questions on its counts'; end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'Write your answer'; end if;
  update public.cash_counts set status = 'to_review', answer_note = btrim(p_note) where id = p_id and status = 'queried' returning * into c;
  if c.id is null then raise exception 'This count has no open question'; end if;
  perform public.notify_role('approver', 'cash_count', 'Finance answered on the cash count', btrim(p_note), '#/cash', null);
  return c;
end $$;
revoke execute on function public.answer_cash_count(uuid, text) from public, anon;
grant execute on function public.answer_cash_count(uuid, text) to authenticated;

-- the month-end close is a count like any other, signed off the same way
create or replace function public.close_float(p_float uuid, p_counted_cash numeric, p_notes text default null) returns public.floats
language plpgsql security definer set search_path = public as $$
declare f public.floats%rowtype; v_open int;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can close a float'; end if;
  select * into f from public.floats where id = p_float for update;
  if f.id is null or f.status <> 'open' then raise exception 'Float is not open'; end if;
  select count(*) into v_open from public.requests where float_id = p_float and status = 'disbursed';
  if v_open > 0 then raise exception '% advance(s) still have no expense recorded. Chase those before closing.', v_open; end if;
  perform public.cash_count_record(p_float, p_counted_cash, p_notes, 'month_end');
  update public.floats set status = 'closed', closed_by = auth.uid(), closed_at = now(), counted_cash = round(p_counted_cash, 2),
         notes = coalesce(nullif(p_notes, ''), notes) where id = p_float returning * into f;
  return f;
end $$;

-- a new month: the allocation is the schedule's usual float (more is a top-up); what was carried is the cash counted
create or replace function public.open_float(p_period date, p_amount numeric, p_note text default null) returns public.floats
language plpgsql security definer set search_path = public as $$
declare f public.floats%rowtype; prev public.floats%rowtype; v_period date; v_carry numeric; s public.settings%rowtype;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Only finance can open a float'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Enter the float amount'; end if;
  select * into s from public.settings where id = 1;
  if s.default_monthly_float > 0 and p_amount > s.default_monthly_float then
    raise exception 'The usual monthly float in the schedule is %. Open with that and request a top-up for more.', public.money_text(s.default_monthly_float);
  end if;
  v_period := date_trunc('month', coalesce(p_period, current_date))::date;
  if exists (select 1 from public.floats where period = v_period) then raise exception 'A float for % already exists', to_char(v_period, 'Mon YYYY'); end if;
  if exists (select 1 from public.floats where status = 'open') then raise exception 'Close the current float before opening a new one'; end if;
  insert into public.floats (period, opening_amount, opened_by, notes) values (v_period, round(p_amount, 2), auth.uid(), nullif(p_note, '')) returning * into f;
  insert into public.float_transactions (float_id, kind, amount, created_by, note) values (f.id, 'allocation', round(p_amount, 2), auth.uid(), 'Monthly allocation from finance');
  if s.float_rollover then
    select * into prev from public.floats where period < v_period and status = 'closed' order by period desc limit 1;
    if prev.id is not null then
      v_carry := coalesce(prev.counted_cash, public.float_balance(prev.id));
      if v_carry > 0 then
        insert into public.float_transactions (float_id, kind, amount, created_by, note)
        values (f.id, 'carry_over', v_carry, auth.uid(), 'Carried over from ' || to_char(prev.period, 'Mon YYYY') || case when prev.counted_cash is not null then ' (cash counted at close)' else '' end);
      end if;
    end if;
  end if;
  return f;
end $$;

-- finance is reminded when the box has not been counted for the schedule's number of days
create or replace function public.remind_cash_count() returns integer
language plpgsql security definer set search_path = public as $$
declare s public.settings%rowtype; f public.floats%rowtype; v_last timestamptz;
begin
  if auth.uid() is not null and not public.has_role('approver') then raise exception 'Not allowed'; end if;
  select * into s from public.settings where id = 1;
  f := public.current_float();
  if coalesce(s.cash_count_days, 0) <= 0 or f.id is null then return 0; end if;
  select greatest(f.opened_at, max(counted_at)) into v_last from public.cash_counts;
  v_last := coalesce(v_last, f.opened_at);
  if v_last > now() - make_interval(days => s.cash_count_days) then return 0; end if;
  if exists (select 1 from public.notifications where kind = 'cash_count_due' and created_at > now() - make_interval(days => s.cash_count_days)) then return 0; end if;
  perform public.notify_role('finance', 'cash_count_due', 'Time for a cash count',
    'The box was last counted ' || (current_date - (v_last at time zone 'Africa/Windhoek')::date) || ' days ago. Count it under Petty cash → Count cash; the GM signs it off.', '#/cash', null);
  return 1;
end $$;
select cron.schedule('petty-cash-count', '20 6 * * *', 'select public.remind_cash_count()');

/* ======================================================================= top-ups */
create table if not exists public.top_ups (
  id uuid primary key default gen_random_uuid(),
  float_id uuid not null references public.floats(id),
  amount numeric not null check (amount > 0),
  reason text not null,
  count_id uuid references public.cash_counts(id),             -- the reconciliation it rests on
  level text not null default 'gm' check (level in ('gm', 'md')),
  route_note text,
  status text not null default 'requested' check (status in ('requested', 'authorised', 'rejected', 'received', 'cancelled')),
  requested_by uuid not null references public.profiles(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  decision_note text,
  received_by uuid references public.profiles(id),
  received_at timestamptz,
  received_amount numeric,
  transaction_id uuid references public.float_transactions(id)
);
create unique index if not exists top_ups_one_open on public.top_ups (float_id) where status in ('requested', 'authorised');
alter table public.top_ups enable row level security;
create policy top_ups_select on public.top_ups for select to authenticated using (public.has_role('finance') or public.has_role('approver'));

-- finance asks for more cash, counting the box at the same time
create or replace function public.request_top_up(p_amount numeric, p_reason text, p_counted numeric, p_count_note text default null) returns public.top_ups
language plpgsql security definer set search_path = public as $$
declare f public.floats%rowtype; s public.settings%rowtype; c public.cash_counts%rowtype; t public.top_ups%rowtype; v_level text := 'gm'; v_note text;
begin
  if not public.has_role('finance') then raise exception 'Top-ups are requested by finance'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount needed'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'Say why the top-up is needed'; end if;
  f := public.current_float();
  if f.id is null then raise exception 'No float is open'; end if;
  if exists (select 1 from public.top_ups where float_id = f.id and status in ('requested', 'authorised')) then
    raise exception 'A top-up is already open for this float – finish or cancel it first';
  end if;
  select * into s from public.settings where id = 1;
  if p_amount > s.gm_limit then
    if public.role_filled('managing_director') then v_level := 'md';
    else v_note := 'Above the GM limit; no Managing Director is set up yet, so the GM authorises.'; end if;
  end if;
  c := public.cash_count_record(f.id, p_counted, p_count_note, 'top_up', false);
  insert into public.top_ups (float_id, amount, reason, count_id, level, route_note, requested_by)
  values (f.id, round(p_amount, 2), btrim(p_reason), c.id, v_level, v_note, auth.uid()) returning * into t;
  perform public.notify_role(case when v_level = 'md' then 'managing_director'::public.user_role else 'approver'::public.user_role end, 'top_up',
    'Top-up to authorise: ' || public.money_text(t.amount),
    t.reason || ' · cash count: ' || public.cash_count_text(c) || coalesce(' – “' || c.note || '”', ''), '#/cash', null);
  return t;
end $$;
revoke execute on function public.request_top_up(numeric, text, numeric, text) from public, anon;
grant execute on function public.request_top_up(numeric, text, numeric, text) to authenticated;

-- the GM (the MD above the GM limit) authorises or turns it down; authorising also signs off the count attached
create or replace function public.decide_top_up(p_id uuid, p_approve boolean, p_note text default null) returns public.top_ups
language plpgsql security definer set search_path = public as $$
declare t public.top_ups%rowtype; c public.cash_counts%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into t from public.top_ups where id = p_id for update;
  if t.id is null or t.status <> 'requested' then raise exception 'This top-up is not waiting for a decision'; end if;
  if t.level = 'md' and not public.has_role('managing_director') then raise exception 'Above the GM limit the Managing Director authorises top-ups'; end if;
  if t.level = 'gm' and not public.has_role('approver') then raise exception 'Top-ups are authorised by the General Manager'; end if;
  if t.requested_by = auth.uid() then raise exception 'Someone else must authorise your own top-up'; end if;
  if not p_approve then
    if v_note is null then raise exception 'Say why it is turned down'; end if;
    update public.top_ups set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = v_note where id = p_id returning * into t;
    perform public.notify_user(t.requested_by, 'top_up', 'Top-up turned down: ' || public.money_text(t.amount), v_note, '#/cash', null);
    return t;
  end if;
  select * into c from public.cash_counts where id = t.count_id;
  if c.id is not null and c.status in ('to_review', 'queried') then
    if c.exception and v_note is null then
      raise exception 'The count attached is % – say how that was resolved before authorising', public.cash_count_text(c);
    end if;
    if c.counted_by <> auth.uid() then
      update public.cash_counts set status = 'accepted', reviewed_by = auth.uid(), reviewed_at = now(), review_note = coalesce(v_note, 'Signed off with the top-up') where id = c.id;
    end if;
  end if;
  update public.top_ups set status = 'authorised', decided_by = auth.uid(), decided_at = now(), decision_note = v_note where id = p_id returning * into t;
  perform public.notify_user(t.requested_by, 'top_up', 'Top-up authorised: ' || public.money_text(t.amount), 'Record it under Petty cash when the cash arrives.', '#/cash', null);
  return t;
end $$;
revoke execute on function public.decide_top_up(uuid, boolean, text) from public, anon;
grant execute on function public.decide_top_up(uuid, boolean, text) to authenticated;

-- finance records the cash when it arrives (never more than was authorised)
create or replace function public.receive_top_up(p_id uuid, p_amount numeric) returns public.top_ups
language plpgsql security definer set search_path = public as $$
declare t public.top_ups%rowtype; f public.floats%rowtype; tx public.float_transactions%rowtype;
begin
  if not public.has_role('finance') then raise exception 'Finance records the cash received'; end if;
  select * into t from public.top_ups where id = p_id for update;
  if t.id is null or t.status <> 'authorised' then raise exception 'This top-up is not authorised'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the cash received'; end if;
  if round(p_amount, 2) > t.amount then raise exception 'Only % was authorised', public.money_text(t.amount); end if;
  f := public.current_float();
  if f.id is null then raise exception 'No float is open'; end if;
  insert into public.float_transactions (float_id, kind, amount, created_by, note)
  values (f.id, 'top_up', round(p_amount, 2), auth.uid(),
          'Authorised by ' || coalesce((select full_name from public.profiles where id = t.decided_by), 'the GM') || ' on ' || to_char(t.decided_at at time zone 'Africa/Windhoek', 'DD Mon') || ' – ' || t.reason)
  returning * into tx;
  update public.top_ups set status = 'received', received_by = auth.uid(), received_at = now(), received_amount = round(p_amount, 2),
         transaction_id = tx.id, float_id = f.id where id = p_id returning * into t;
  return t;
end $$;
revoke execute on function public.receive_top_up(uuid, numeric) from public, anon;
grant execute on function public.receive_top_up(uuid, numeric) to authenticated;

create or replace function public.cancel_top_up(p_id uuid) returns public.top_ups
language plpgsql security definer set search_path = public as $$
declare t public.top_ups%rowtype;
begin
  if not public.has_role('finance') then raise exception 'Finance cancels its own top-up requests'; end if;
  update public.top_ups set status = 'cancelled', decided_at = coalesce(decided_at, now()) where id = p_id and status in ('requested', 'authorised') returning * into t;
  if t.id is null then raise exception 'This top-up can no longer be cancelled'; end if;
  return t;
end $$;
revoke execute on function public.cancel_top_up(uuid) from public, anon;
grant execute on function public.cancel_top_up(uuid) to authenticated;

-- what is waiting on the person asking, for Home and the badge
create or replace function public.cash_actions() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'counts_to_review', case when public.has_role('approver') then (select count(*) from public.cash_counts c where c.status = 'to_review' and c.counted_by <> auth.uid()
                          and not exists (select 1 from public.top_ups t where t.count_id = c.id and t.status = 'requested')) else 0 end,
    'counts_queried', case when public.has_role('finance') then (select count(*) from public.cash_counts where status = 'queried') else 0 end,
    'top_ups_to_decide', (select count(*) from public.top_ups t where t.status = 'requested' and t.requested_by <> auth.uid()
                           and ((t.level = 'gm' and public.has_role('approver')) or (t.level = 'md' and public.has_role('managing_director')))),
    'top_ups_to_receive', case when public.has_role('finance') then (select count(*) from public.top_ups where status = 'authorised') else 0 end)
$$;
revoke execute on function public.cash_actions() from public, anon;
grant execute on function public.cash_actions() to authenticated;

/* ======================================================================= the petty cash ledger */
create or replace function public.cash_ledger(p_float uuid)
returns table (at timestamptz, kind text, request_id uuid, ref text, description text, person uuid, cash_in numeric, cash_out numeric, balance numeric)
language sql stable security definer set search_path = public as $$
  with moves as (
    select t.created_at as at, t.kind::text as kind,
           case t.kind when 'allocation' then 0 when 'carry_over' then 0 when 'top_up' then 1 when 'return' then 4 else 5 end as ord,
           null::uuid as request_id, null::text as ref,
           case t.kind when 'allocation' then coalesce(t.note, 'Monthly allocation from finance')
                       when 'carry_over' then coalesce(t.note, 'Carried over')
                       when 'shortage' then coalesce(t.note, 'Cash short, written off')
                       when 'surplus' then coalesce(t.note, 'Cash over, taken in')
                       else case t.kind when 'top_up' then 'Top-up' else 'Returned to finance' end || coalesce(' – ' || t.note, '') end as description,
           t.created_by as person,
           case when t.kind in ('return', 'shortage') then 0 else t.amount end as cash_in,
           case when t.kind in ('return', 'shortage') then t.amount else 0 end as cash_out
      from public.float_transactions t where t.float_id = p_float
    union all
    select q.disbursed_at, case when q.type = 'claim' then 'claim' else 'payout' end, 2, q.id, '#' || q.request_no,
           case when q.type = 'claim' then 'Claim reimbursed: ' else 'Paid out: ' end || q.purpose, q.disbursed_to, 0, q.disbursed_amount
      from public.requests q where q.float_id = p_float and q.disbursed_at is not null
    union all
    select greatest(q.disbursed_at, coalesce((select max(ev.created_at) from public.request_events ev where ev.request_id = q.id and ev.action = 'expense_recorded'), e.created_at)),
           case when e.total < q.disbursed_amount then 'change' else 'paid_back' end, 3, q.id, '#' || q.request_no,
           case when e.total < q.disbursed_amount then 'Change returned: ' else 'Spent more than paid out, paid back: ' end || q.purpose, q.disbursed_to,
           greatest(q.disbursed_amount - e.total, 0), greatest(e.total - q.disbursed_amount, 0)
      from public.requests q join public.expenses e on e.request_id = q.id
     where q.float_id = p_float and q.type <> 'claim' and q.status in ('proof_review', 'physical_required', 'closed') and abs(e.total - q.disbursed_amount) >= 0.005
  )
  select m.at, m.kind, m.request_id, m.ref, m.description, m.person, round(m.cash_in, 2), round(m.cash_out, 2),
         round(sum(m.cash_in - m.cash_out) over (order by m.at, m.ord, m.ref rows between unbounded preceding and current row), 2)
    from moves m
   where public.has_role('finance') or public.has_role('approver')
   order by m.at, m.ord, m.ref
$$;
revoke execute on function public.cash_ledger(uuid) from public, anon;
grant execute on function public.cash_ledger(uuid) to authenticated;

/* ======================================================================= no receipt used twice */
alter table public.expense_proofs add column if not exists sha256 text;
alter table public.receipt_inbox add column if not exists sha256 text;
alter table public.expenses add column if not exists duplicate_note text;
create index if not exists expense_proofs_sha256 on public.expense_proofs (sha256) where sha256 is not null;

-- the request a receipt was already used on: the same photo, or the same supplier, date and amount
create or replace function public.receipt_duplicate_of(p_expense uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('request_no', q2.request_no, 'request_id', q2.id, 'why', 'the same receipt photo')
       from public.expense_proofs p join public.expense_proofs p2 on p2.sha256 = p.sha256 and p2.expense_id <> p.expense_id
       join public.expenses e2 on e2.id = p2.expense_id join public.requests q2 on q2.id = e2.request_id
      where p.expense_id = p_expense and p.sha256 is not null and q2.status not in ('rejected', 'cancelled', 'draft')
      order by q2.request_no limit 1),
    (select jsonb_build_object('request_no', q2.request_no, 'request_id', q2.id, 'why', 'the same supplier, date and amount')
       from public.expenses e join public.expenses e2 on e2.id <> e.id and e2.spent_at = e.spent_at and abs(e2.total - e.total) < 0.005 and e2.total > 0
       join public.requests q2 on q2.id = e2.request_id
      where e.id = p_expense and coalesce(btrim(e.supplier_name), '') <> '' and lower(btrim(e2.supplier_name)) = lower(btrim(e.supplier_name))
        and q2.status not in ('rejected', 'cancelled', 'draft')
      order by q2.request_no limit 1))
$$;
revoke execute on function public.receipt_duplicate_of(uuid) from public, anon, authenticated;

-- checked while uploading: is this photo already on another request?
create or replace function public.proof_used(p_sha256 text, p_request uuid default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('request_no', q.request_no)
    from public.expense_proofs p join public.expenses e on e.id = p.expense_id join public.requests q on q.id = e.request_id
   where p.sha256 = p_sha256 and p_sha256 ~ '^[0-9a-f]{64}$' and q.id is distinct from p_request and q.status not in ('rejected', 'cancelled', 'draft')
   order by q.request_no limit 1
$$;
revoke execute on function public.proof_used(text, uuid) from public, anon;
grant execute on function public.proof_used(text, uuid) to authenticated;

create or replace function public.expense_checks(p_request uuid default null)
returns table (request_id uuid, status text, note text, reading_total numeric)
language plpgsql stable security definer set search_path = public as $$
declare r record; v_n int; v_pre int; v_read numeric; v_dup jsonb; v_soft int; v_status text; v_note text;
begin
  if p_request is null and not public.is_staff() then raise exception 'Not allowed'; end if;
  if p_request is not null and not public.can_view_request(p_request) then raise exception 'Not allowed'; end if;
  for r in select q.id, q.request_no, e.id as expense_id, e.total, e.spent_at, e.supplier_name, e.duplicate_note from public.requests q join public.expenses e on e.request_id = q.id
           where (p_request is null and q.status in ('proof_review', 'physical_required', 'awaiting_disbursement') and e.total > 0) or q.id = p_request loop
    select count(*), count(*) filter (where (p.extracted->>'pre_payment')::boolean),
           max((p.extracted->>'total')::numeric) filter (where p.extracted ? 'total' and p.extracted->>'total' is not null and p.extracted->>'total' ~ '^[0-9.]+$')
      into v_n, v_pre, v_read from public.expense_proofs p where p.expense_id = r.expense_id;
    v_status := case when v_n = 0 then 'no_proof' when v_read is null then 'unread'
                     when abs(v_read - r.total) <= greatest(0.5, v_read * 0.01) then 'matches' else 'mismatch' end;
    v_note := case v_status when 'matches' then 'Receipt reads ' || public.money_text(v_read) || ' – matches what was recorded'
                            when 'mismatch' then 'Receipt reads ' || public.money_text(v_read) || ' but ' || public.money_text(r.total) || ' was recorded'
                            when 'unread' then 'Scan attached, not read' else 'No scan attached' end;
    if v_pre > 0 and v_n = v_pre then v_note := v_note || ' · the invoice was attached before the pay-out: confirm it was actually paid'; end if;
    v_dup := public.receipt_duplicate_of(r.expense_id);
    if v_dup is not null then
      v_status := 'duplicate';
      v_note := 'Already used on #' || (v_dup->>'request_no') || ' – ' || (v_dup->>'why')
                || case when r.duplicate_note is not null then ' · explained: ' || r.duplicate_note else ' · accepting it needs an explanation' end;
    else
      -- same amount on the same day without a supplier to tell them apart: worth a look, not a block
      select q2.request_no into v_soft from public.expenses e2 join public.requests q2 on q2.id = e2.request_id
        where e2.request_id <> r.id and e2.spent_at = r.spent_at and abs(e2.total - r.total) < 0.01 and e2.total > 0
          and q2.status not in ('rejected', 'cancelled', 'draft') limit 1;
      if v_soft is not null then v_note := v_note || ' · same amount on the same day as #' || v_soft || ' – check it is not the same purchase'; end if;
    end if;
    request_id := r.id; status := v_status; note := v_note; reading_total := v_read;
    return next;
  end loop;
end $$;

-- finance explains why a flagged receipt is right before accepting it
create or replace function public.explain_duplicate(p_request uuid, p_note text) returns public.expenses
language plpgsql security definer set search_path = public as $$
declare e public.expenses%rowtype; r public.requests%rowtype;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Finance explains flagged receipts'; end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'Write why this receipt is right'; end if;
  select * into r from public.requests where id = p_request;
  if r.requester_id = auth.uid() or r.disbursed_to = auth.uid() then raise exception 'Someone else must accept your own receipt'; end if;
  update public.expenses set duplicate_note = btrim(p_note) where request_id = p_request returning * into e;
  if e.id is null then raise exception 'There is no expense on this request'; end if;
  perform public.log_event(p_request, 'duplicate_explained', r.status, r.status, btrim(p_note));
  return e;
end $$;
revoke execute on function public.explain_duplicate(uuid, text) from public, anon;
grant execute on function public.explain_duplicate(uuid, text) to authenticated;

-- a flagged receipt cannot be accepted (confirmed, closed or reimbursed) without that explanation
create or replace function public.expenses_duplicate_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare d jsonb;
begin
  if new.proof_status = 'confirmed' and old.proof_status is distinct from 'confirmed' and new.duplicate_note is null then
    d := public.receipt_duplicate_of(new.id);
    if d is not null then
      raise exception 'This receipt is already used on #% (%). Explain why it is right before accepting it.', d->>'request_no', d->>'why';
    end if;
  end if;
  return new;
end $$;
create trigger expenses_duplicate_guard before update of proof_status on public.expenses for each row execute function public.expenses_duplicate_guard();

-- a snapped receipt keeps its fingerprint when it is filed on a request
create or replace function public.file_inbox_receipt(p_inbox uuid, p_request uuid, p_new_path text) returns public.expense_proofs
language plpgsql security definer set search_path = public as $$
declare ib public.receipt_inbox%rowtype; r public.requests%rowtype; e public.expenses%rowtype; pr public.expense_proofs%rowtype;
begin
  select * into ib from public.receipt_inbox where id = p_inbox and user_id = auth.uid() for update;
  if ib.id is null then raise exception 'Receipt not found'; end if;
  if ib.status <> 'unfiled' then raise exception 'This receipt has already been filed'; end if;
  select * into r from public.requests where id = p_request;
  if r.id is null then raise exception 'Request not found'; end if;
  if not ((r.disbursed_to = auth.uid() and r.status in ('disbursed', 'proof_review', 'physical_required'))
          or (r.type = 'claim' and r.requester_id = auth.uid() and r.status in ('draft', 'pending_approval', 'awaiting_disbursement'))) then
    raise exception 'That request is not waiting for a receipt from you';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'proofs' and name = p_new_path and owner_id = auth.uid()::text) then
    raise exception 'The file has not been moved into the request folder';
  end if;
  select * into e from public.expenses where request_id = p_request;
  if e.id is null then raise exception 'The request has no expense record yet'; end if;
  insert into public.expense_proofs (expense_id, storage_path, file_name, mime, uploaded_by, extracted, sha256)
  values (e.id, p_new_path, ib.file_name, ib.mime, auth.uid(), ib.extracted, ib.sha256) returning * into pr;
  update public.receipt_inbox set status = 'filed', filed_request_id = p_request, filed_at = now(), storage_path = p_new_path where id = p_inbox;
  return pr;
end $$;

/* ======================================================================= record the new schedule items as a version */
select public.schedule_record('rules', 'Cash counts added to the schedule: the difference allowed at a count and the count reminder',
                              (select id from public.profiles where role = 'approver' and active order by created_at limit 1),
                              case when public.role_filled('managing_director') then 'notified' else 'no_md' end);
