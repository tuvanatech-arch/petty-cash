-- 021: the authority schedule (MGP-SCH-PC-001) lives in the app, versioned.
-- Every limit, float amount, reminder period and budget is changed through one set of functions that records a numbered
-- version with who, when, why and – for limits, approval rules and the float – the Managing Director's approval.
-- Budgets, reminder periods, documents and position holders apply at once and the MD is told.
-- While no MD is set up, everything applies at once and is marked for the MD to review later.
-- Requests record the version they were routed and approved under.

alter table public.settings add column if not exists advance_escalate_days integer not null default 7;
alter table public.settings add column if not exists schedule_ref text not null default 'MGP-SCH-PC-001';
alter table public.settings add column if not exists policy_ref text not null default 'MGP-POL-PC-001';
alter table public.settings add column if not exists policy_url text;
alter table public.requests add column if not exists schedule_version integer;

create table if not exists public.schedule_versions (
  id uuid primary key default gen_random_uuid(),
  version_no integer unique,                                   -- set when the change takes effect
  status text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'withdrawn')),
  area text not null default 'rules' check (area in ('start', 'rules', 'budgets', 'positions')),
  changes jsonb not null default '[]'::jsonb,                  -- [{key, label, md, from, to}] in words
  proposed jsonb not null default '{}'::jsonb,                 -- values waiting for the MD
  snapshot jsonb,                                              -- the whole schedule once in effect
  reason text,
  proposed_by uuid references public.profiles(id),
  proposed_at timestamptz not null default now(),
  md_status text check (md_status in ('approved', 'rejected', 'notified', 'by_md', 'no_md', 'reviewed')),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  decision_note text,
  effective_at timestamptz
);
create index if not exists schedule_versions_recent on public.schedule_versions (proposed_at desc);
create unique index if not exists schedule_versions_one_pending on public.schedule_versions ((true)) where status = 'pending';
alter table public.schedule_versions enable row level security;
create policy schedule_versions_select on public.schedule_versions for select to authenticated using (public.my_role() is not null);
-- no write policies: every change goes through the functions below

-- ---------- what the schedule holds ----------
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
    ('advance_grace_days',     'Receipt reminder after',                           false, 'days',   10),
    ('advance_escalate_days',  'Overdue: GM and finance told after',               false, 'days',   11),
    ('count_day',              'Weekly stock count reminder',                      false, 'weekday',12),
    ('reserve_buffer_pct',     'Safety buffer on the float minimum',               false, 'pct',    13),
    ('schedule_ref',           'Schedule reference',                               false, 'text',   14),
    ('policy_ref',             'Policy reference',                                 false, 'text',   15),
    ('policy_url',             'Link to the policy',                               false, 'text',   16)
$$;

create or replace function public.schedule_fmt(p_kind text, p_v jsonb) returns text
language sql stable set search_path = public as $$
  select case
    when p_v is null or jsonb_typeof(p_v) = 'null' then '—'
    when p_kind = 'money' then public.money_text((p_v #>> '{}')::numeric)
    when p_kind = 'days' then (p_v #>> '{}') || case when (p_v #>> '{}') = '1' then ' day' else ' days' end
    when p_kind = 'pct' then trim_scale((p_v #>> '{}')::numeric)::text || '%'
    when p_kind = 'bool' then case when (p_v #>> '{}')::boolean then 'Yes' else 'No' end
    when p_kind = 'mode' then case p_v #>> '{}' when 'warn' then 'Flag it, let it through' when 'require_approval' then 'Send it for approval' when 'block' then 'Block it' else p_v #>> '{}' end
    when p_kind = 'weekday' then case (p_v #>> '{}')::int when 0 then 'No reminder' when 1 then 'Monday' when 2 then 'Tuesday' when 3 then 'Wednesday' when 4 then 'Thursday' when 5 then 'Friday' else p_v #>> '{}' end
    else coalesce(nullif(p_v #>> '{}', ''), '—') end
$$;

-- the whole schedule as it stands (values can be overlaid to preview a change)
create or replace function public.schedule_snapshot(p_values jsonb default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'values', (select jsonb_object_agg(k.k, to_jsonb(s.*) -> k.k) from public.schedule_keys() k cross join public.settings s where s.id = 1) || coalesce(p_values, '{}'::jsonb),
    'budgets', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'label', coalesce(c.name, nullif(p.full_name, ''), p.email, '—'),
                   'scope', case when b.category_id is not null then 'category' else 'person' end, 'monthly_limit', b.monthly_limit, 'active', b.active, 'note', b.note)
                   order by b.person_id is not null, coalesce(c.name, p.full_name))
                 from public.budgets b left join public.categories c on c.id = b.category_id left join public.profiles p on p.id = b.person_id), '[]'::jsonb),
    'positions', (select jsonb_agg(jsonb_build_object('role', r.role, 'label', r.label,
                   'holders', coalesce((select jsonb_agg(coalesce(nullif(p.full_name, ''), p.email) order by p.full_name) from public.profiles p where p.active and p.role::text = r.role), '[]'::jsonb))
                   order by r.ord)
                 from (values ('approver', 'General Manager – approves, administers the app', 1), ('managing_director', 'Managing Director', 2),
                              ('finance', 'Finance – custodian of the float', 3), ('stock_manager', 'Stock controller', 4)) r(role, label, ord)),
    'standins', coalesce((select jsonb_agg(jsonb_build_object('role', d.role, 'away', coalesce(nullif(fp.full_name, ''), fp.email), 'covers', coalesce(nullif(tp.full_name, ''), tp.email),
                   'starts_on', d.starts_on, 'ends_on', d.ends_on) order by d.starts_on)
                 from public.delegations d join public.profiles fp on fp.id = d.from_user join public.profiles tp on tp.id = d.to_user
                where d.ends_on >= current_date and d.role in ('approver', 'managing_director', 'finance', 'stock_manager')), '[]'::jsonb))
$$;
revoke execute on function public.schedule_snapshot(jsonb) from public, anon;

-- what changed between two snapshots, in words (stand-ins are shown, not versioned)
create or replace function public.schedule_diff(a jsonb, b jsonb) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(x.item order by x.o1, x.o2, x.item->>'label'), '[]'::jsonb) from (
    select 1 o1, k.ord o2, jsonb_build_object('key', k.k, 'label', k.label, 'md', k.md,
           'from', public.schedule_fmt(k.kind, a -> 'values' -> k.k), 'to', public.schedule_fmt(k.kind, b -> 'values' -> k.k)) item
      from public.schedule_keys() k
     where (a -> 'values' -> k.k) is distinct from (b -> 'values' -> k.k)
    union all
    select 2, 0, jsonb_build_object('key', 'budget', 'label', 'Budget – ' || coalesce(nb ->> 'label', ob ->> 'label'), 'md', false,
           'from', case when ob is null then '—' when not (ob ->> 'active')::boolean then 'Off' else public.money_text((ob ->> 'monthly_limit')::numeric) end,
           'to',   case when nb is null then '—' when not (nb ->> 'active')::boolean then 'Off' else public.money_text((nb ->> 'monthly_limit')::numeric) end)
      from jsonb_array_elements(coalesce(a -> 'budgets', '[]'::jsonb)) ob
      full join jsonb_array_elements(coalesce(b -> 'budgets', '[]'::jsonb)) nb on nb ->> 'id' = ob ->> 'id'
     where ob -> 'monthly_limit' is distinct from nb -> 'monthly_limit' or ob -> 'active' is distinct from nb -> 'active'
    union all
    select 3, 0, jsonb_build_object('key', 'position', 'label', coalesce(np ->> 'label', op ->> 'label'), 'md', false,
           'from', coalesce((select string_agg(h #>> '{}', ', ') from jsonb_array_elements(op -> 'holders') h), 'Not set up'),
           'to',   coalesce((select string_agg(h #>> '{}', ', ') from jsonb_array_elements(np -> 'holders') h), 'Not set up'))
      from jsonb_array_elements(coalesce(a -> 'positions', '[]'::jsonb)) op
      full join jsonb_array_elements(coalesce(b -> 'positions', '[]'::jsonb)) np on np ->> 'role' = op ->> 'role'
     where op -> 'holders' is distinct from np -> 'holders'
  ) x
$$;

create or replace function public.schedule_version_no() returns integer
language sql stable security definer set search_path = public as $$
  select max(version_no) from public.schedule_versions where status = 'applied'
$$;

-- ---------- checking and writing values ----------
-- turn what the screen sends into clean values; anything out of range is refused with a plain reason
create or replace function public.schedule_clean(p jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare v_k text; v jsonb; meta record; o jsonb := '{}'::jsonb; n numeric; t text;
begin
  for v_k, v in select * from jsonb_each(coalesce(p, '{}'::jsonb)) loop
    select * into meta from public.schedule_keys() sk where sk.k = v_k;
    if meta.k is null then raise exception 'Unknown schedule item: %', v_k; end if;
    if meta.kind in ('money', 'days', 'pct', 'weekday') then
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

-- the values must hang together once applied
create or replace function public.schedule_check(v jsonb) returns void
language plpgsql stable set search_path = public as $$
begin
  if (v ->> 'gm_limit')::numeric < (v ->> 'approval_threshold')::numeric then
    raise exception 'The General Manager''s limit (%) cannot be below what finance pays alone (%)', public.money_text((v ->> 'gm_limit')::numeric), public.money_text((v ->> 'approval_threshold')::numeric);
  end if;
  if (v ->> 'advance_escalate_days')::int < (v ->> 'advance_grace_days')::int then
    raise exception 'The overdue alert (% days) cannot come before the first reminder (% days)', v ->> 'advance_escalate_days', v ->> 'advance_grace_days';
  end if;
end $$;
revoke execute on function public.schedule_check(jsonb) from public, anon, authenticated;

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
    advance_grace_days = r.advance_grace_days, advance_escalate_days = r.advance_escalate_days, count_day = r.count_day,
    reserve_buffer_pct = r.reserve_buffer_pct, schedule_ref = r.schedule_ref, policy_ref = r.policy_ref, policy_url = r.policy_url,
    updated_at = now()
   where id = 1;
  perform set_config('pcs.schedule', 'off', true);
end $$;
revoke execute on function public.schedule_write(jsonb) from public, anon, authenticated;

-- schedule values only change through the functions here, so nothing escapes the version history
create or replace function public.settings_schedule_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('pcs.schedule', true), '') <> 'on' and (
       (new.approval_threshold, new.gm_limit, new.split_window_days, new.change_tolerance_pct, new.claims_need_approval, new.budget_mode,
        new.block_with_outstanding, new.default_monthly_float, new.float_rollover, new.advance_grace_days, new.advance_escalate_days,
        new.count_day, new.reserve_buffer_pct, new.schedule_ref, new.policy_ref, new.policy_url)
       is distinct from
       (old.approval_threshold, old.gm_limit, old.split_window_days, old.change_tolerance_pct, old.claims_need_approval, old.budget_mode,
        old.block_with_outstanding, old.default_monthly_float, old.float_rollover, old.advance_grace_days, old.advance_escalate_days,
        old.count_day, old.reserve_buffer_pct, old.schedule_ref, old.policy_ref, old.policy_url)) then
    raise exception 'Limits, the float, reminders and the policy are changed on the Schedule screen, so every change is versioned';
  end if;
  return new;
end $$;
create trigger settings_schedule_guard before update on public.settings for each row execute function public.settings_schedule_guard();

-- budgets likewise: no direct writes from the app, only through schedule_budget()
alter policy budgets_write on public.budgets using (false) with check (false);

-- ---------- telling people ----------
create or replace function public.schedule_tell(v public.schedule_versions) returns void
language plpgsql security definer set search_path = public as $$
declare v_text text; v_title text;
begin
  select string_agg((c ->> 'label') || ': ' || (c ->> 'from') || ' → ' || (c ->> 'to'), '; ') into v_text from jsonb_array_elements(v.changes) c;
  v_text := coalesce(v_text, 'No values changed') || coalesce(' – ' || nullif(v.reason, ''), '');
  if v.status = 'pending' then
    perform public.notify_role('managing_director', 'schedule', 'Schedule change to approve', v_text, '#/schedule', null);
    return;
  end if;
  if v.status = 'rejected' then
    perform public.notify_user(v.proposed_by, 'schedule', 'The MD did not approve the schedule change',
      coalesce(nullif(v.decision_note, ''), 'No reason given') || ' · ' || v_text, '#/schedule', null);
    return;
  end if;
  v_title := 'Schedule version ' || v.version_no || ' in effect';
  if v.md_status = 'approved' then
    perform public.notify_user(v.proposed_by, 'schedule', 'The MD approved: ' || v_title, v_text, '#/schedule', null);
  elsif v.md_status = 'notified' then
    perform public.notify_role('managing_director', 'schedule', v_title, v_text, '#/schedule', null);
  elsif v.md_status = 'by_md' then
    perform public.notify_role('approver', 'schedule', v_title, v_text, '#/schedule', null);
  end if;
  -- finance works to the limits and the float, so they hear when those change
  if v.area = 'rules' and exists (select 1 from jsonb_array_elements(v.changes) c where (c ->> 'md')::boolean) then
    perform public.notify_role('finance', 'schedule', v_title, v_text, '#/schedule', null);
  end if;
end $$;
revoke execute on function public.schedule_tell(public.schedule_versions) from public, anon, authenticated;

-- ---------- recording a version ----------
-- compares with the previous version, so anything that changed in between (for example a new position holder) shows too
create or replace function public.schedule_record(p_area text, p_reason text, p_by uuid, p_md text,
                                                  p_decided_by uuid default null, p_note text default null, p_pending uuid default null)
returns public.schedule_versions language plpgsql security definer set search_path = public as $$
declare v public.schedule_versions%rowtype; v_prev jsonb; v_after jsonb := public.schedule_snapshot(); v_changes jsonb; v_no int;
begin
  perform pg_advisory_xact_lock(hashtext('public.schedule_versions'));
  select snapshot into v_prev from public.schedule_versions where status = 'applied' order by version_no desc limit 1;
  v_changes := case when v_prev is null then '[]'::jsonb else public.schedule_diff(v_prev, v_after) end;
  if v_prev is not null and v_changes = '[]'::jsonb then
    if p_pending is not null then
      update public.schedule_versions set status = 'withdrawn', decided_by = p_decided_by, decided_at = now(), decision_note = 'Nothing left to change'
       where id = p_pending returning * into v;
    end if;
    return v;
  end if;
  select coalesce(max(version_no), 0) + 1 into v_no from public.schedule_versions;
  if p_pending is null then
    insert into public.schedule_versions (version_no, status, area, changes, snapshot, reason, proposed_by, md_status, decided_by, decided_at, decision_note, effective_at)
    values (v_no, 'applied', p_area, v_changes, v_after, p_reason, p_by, p_md, p_decided_by, case when p_decided_by is not null then now() end, p_note, now())
    returning * into v;
  else
    update public.schedule_versions
       set version_no = v_no, status = 'applied', changes = v_changes, snapshot = v_after, md_status = p_md,
           decided_by = p_decided_by, decided_at = now(), decision_note = p_note, effective_at = now()
     where id = p_pending returning * into v;
  end if;
  perform public.schedule_tell(v);
  return v;
end $$;
revoke execute on function public.schedule_record(text, text, uuid, text, uuid, text, uuid) from public, anon, authenticated;

-- ---------- changing values (the Schedule screen) ----------
-- limits, approval rules and the float wait for the MD; reminders and documents apply at once and the MD is told
create or replace function public.change_schedule(p_values jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_reason text := btrim(coalesce(p_reason, '')); v_clean jsonb; v_cur jsonb; v_now jsonb := '{}'::jsonb; v_md jsonb := '{}'::jsonb;
  v_k text; val jsonb; v_is_md boolean; v_md_in boolean := public.role_filled('managing_director');
  v_applied public.schedule_versions%rowtype; v_pend public.schedule_versions%rowtype; v_merged jsonb;
begin
  if public.my_role() is distinct from 'approver' then raise exception 'Only the administrator changes the schedule'; end if;
  if length(v_reason) < 3 then raise exception 'Say why the schedule is changing'; end if;
  v_clean := public.schedule_clean(p_values);
  v_cur := public.schedule_snapshot() -> 'values';
  for v_k, val in select * from jsonb_each(v_clean) loop
    if val is distinct from v_cur -> v_k then
      select sk.md into v_is_md from public.schedule_keys() sk where sk.k = v_k;
      if v_is_md then v_md := v_md || jsonb_build_object(v_k, val); else v_now := v_now || jsonb_build_object(v_k, val); end if;
    end if;
  end loop;
  if v_md = '{}'::jsonb and v_now = '{}'::jsonb then raise exception 'Nothing has changed'; end if;
  perform public.schedule_check(v_cur || v_now);
  perform public.schedule_check(v_cur || v_now || v_md);
  if not v_md_in then v_now := v_now || v_md; v_md := '{}'::jsonb; end if;

  if v_now <> '{}'::jsonb then
    perform public.schedule_write(v_now);
    v_applied := public.schedule_record('rules', v_reason, auth.uid(), case when v_md_in then 'notified' else 'no_md' end);
  end if;

  if v_md <> '{}'::jsonb then
    -- one change waits for the MD at a time; a further change is added to it
    select * into v_pend from public.schedule_versions where status = 'pending' for update;
    v_merged := coalesce(v_pend.proposed, '{}'::jsonb) || v_md;
    if v_pend.id is null then
      insert into public.schedule_versions (status, area, proposed, reason, proposed_by)
      values ('pending', 'rules', v_merged, v_reason, auth.uid()) returning * into v_pend;
    else
      update public.schedule_versions set proposed = v_merged, proposed_by = auth.uid(), proposed_at = now(),
             reason = case when reason = v_reason then reason else reason || ' · ' || v_reason end
       where id = v_pend.id returning * into v_pend;
    end if;
    update public.schedule_versions
       set changes = public.schedule_diff(public.schedule_snapshot(), public.schedule_snapshot(v_merged))
     where id = v_pend.id returning * into v_pend;
    perform public.schedule_tell(v_pend);
  end if;
  return jsonb_build_object('version', v_applied.version_no, 'applied', coalesce(v_applied.changes, '[]'::jsonb),
                            'pending', v_pend.id, 'waiting', coalesce(v_pend.changes, '[]'::jsonb));
end $$;
revoke execute on function public.change_schedule(jsonb, text) from public, anon;
grant execute on function public.change_schedule(jsonb, text) to authenticated;

-- the MD approves or turns down the change waiting for them (never their own)
create or replace function public.decide_schedule(p_id uuid, p_approve boolean, p_note text default null) returns public.schedule_versions
language plpgsql security definer set search_path = public as $$
declare v public.schedule_versions%rowtype;
begin
  if not public.has_role('managing_director') then raise exception 'Only the Managing Director decides schedule changes'; end if;
  select * into v from public.schedule_versions where id = p_id for update;
  if v.id is null or v.status <> 'pending' then raise exception 'This change is no longer waiting – it was decided or withdrawn'; end if;
  if v.proposed_by = auth.uid() then raise exception 'You cannot approve your own change to the schedule'; end if;
  if p_approve then
    perform public.schedule_check((public.schedule_snapshot() -> 'values') || v.proposed);
    perform public.schedule_write(v.proposed);
    v := public.schedule_record(v.area, v.reason, v.proposed_by, 'approved', auth.uid(), nullif(btrim(coalesce(p_note, '')), ''), v.id);
  else
    update public.schedule_versions set status = 'rejected', md_status = 'rejected', decided_by = auth.uid(), decided_at = now(),
           decision_note = nullif(btrim(coalesce(p_note, '')), '')
     where id = p_id returning * into v;
    perform public.schedule_tell(v);
  end if;
  return v;
end $$;
revoke execute on function public.decide_schedule(uuid, boolean, text) from public, anon;
grant execute on function public.decide_schedule(uuid, boolean, text) to authenticated;

create or replace function public.withdraw_schedule(p_id uuid) returns public.schedule_versions
language plpgsql security definer set search_path = public as $$
declare v public.schedule_versions%rowtype;
begin
  select * into v from public.schedule_versions where id = p_id for update;
  if v.id is null or v.status <> 'pending' then raise exception 'This change is no longer waiting'; end if;
  if public.my_role() is distinct from 'approver' and v.proposed_by is distinct from auth.uid() then raise exception 'Only the administrator can withdraw it'; end if;
  update public.schedule_versions set status = 'withdrawn', decided_by = auth.uid(), decided_at = now() where id = p_id returning * into v;
  return v;
end $$;
revoke execute on function public.withdraw_schedule(uuid) from public, anon;
grant execute on function public.withdraw_schedule(uuid) to authenticated;

-- the MD reviews what was changed before there was an MD to approve it
create or replace function public.review_schedule(p_ids uuid[] default null, p_note text default null) returns integer
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.has_role('managing_director') then raise exception 'Only the Managing Director reviews schedule changes'; end if;
  update public.schedule_versions set md_status = 'reviewed', decided_by = auth.uid(), decided_at = now(),
         decision_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), decision_note)
   where status = 'applied' and md_status = 'no_md' and (p_ids is null or id = any(p_ids)) and proposed_by is distinct from auth.uid();
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.review_schedule(uuid[], text) from public, anon;
grant execute on function public.review_schedule(uuid[], text) to authenticated;

-- budgets: add, change or switch off; applies at once and the MD is told
create or replace function public.schedule_budget(p_budget uuid, p_category uuid, p_person uuid, p_limit numeric, p_note text,
                                                  p_active boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_reason text := btrim(coalesce(p_reason, '')); b public.budgets%rowtype; v public.schedule_versions%rowtype;
begin
  if public.my_role() is distinct from 'approver' then raise exception 'Only the administrator changes budgets'; end if;
  if length(v_reason) < 3 then raise exception 'Say why the budget is changing'; end if;
  if p_limit is null or p_limit <= 0 then raise exception 'Enter a monthly limit'; end if;
  if p_budget is null then
    if (p_category is null) = (p_person is null) then raise exception 'A budget is for one category or one person'; end if;
    if exists (select 1 from public.budgets where category_id is not distinct from p_category and person_id is not distinct from p_person) then
      raise exception 'There is already a budget for that. Edit it instead.';
    end if;
    insert into public.budgets (category_id, person_id, monthly_limit, note, active)
    values (p_category, p_person, round(p_limit, 2), nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_active, true)) returning * into b;
  else
    update public.budgets set monthly_limit = round(p_limit, 2), note = nullif(btrim(coalesce(p_note, '')), ''), active = coalesce(p_active, active)
     where id = p_budget returning * into b;
    if b.id is null then raise exception 'Budget not found'; end if;
  end if;
  v := public.schedule_record('budgets', v_reason, auth.uid(), case when public.role_filled('managing_director') then 'notified' else 'no_md' end);
  return jsonb_build_object('budget', b.id, 'version', v.version_no);
end $$;
revoke execute on function public.schedule_budget(uuid, uuid, uuid, numeric, text, boolean, text) from public, anon;
grant execute on function public.schedule_budget(uuid, uuid, uuid, numeric, text, boolean, text) to authenticated;

-- who holds each position: recorded whenever People changes (called by the admin-users function after a change)
create or replace function public.schedule_positions_sync(p_by uuid default null, p_reason text default null) returns integer
language plpgsql security definer set search_path = public as $$
declare v public.schedule_versions%rowtype;
begin
  if auth.uid() is not null and public.my_role() is distinct from 'approver' then raise exception 'Not allowed'; end if;
  v := public.schedule_record('positions', coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'People changed under Admin → People'),
                              coalesce(auth.uid(), p_by), case when public.role_filled('managing_director') then 'notified' else 'no_md' end);
  return v.version_no;
end $$;
revoke execute on function public.schedule_positions_sync(uuid, text) from public, anon;
grant execute on function public.schedule_positions_sync(uuid, text) to authenticated, service_role;

-- ---------- every request records the schedule version it was routed and approved under ----------
create or replace function public.requests_schedule_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (old.status = 'draft' and new.status <> 'draft') or (new.approved_at is not null and new.approved_at is distinct from old.approved_at) then
    new.schedule_version := public.schedule_version_no();
  end if;
  return new;
end $$;
create trigger requests_schedule_stamp before update on public.requests for each row execute function public.requests_schedule_stamp();

-- ---------- rules read from the schedule ----------
-- the overdue alert to finance and the GM comes after the schedule's number of days (was fixed at 7)
create or replace function public.remind_outstanding_advances() returns integer
language plpgsql security definer set search_path = public as $$
declare q record; s public.settings%rowtype; n int := 0; v_days int;
begin
  if auth.uid() is not null and not public.has_role('approver') then raise exception 'Not allowed'; end if;
  select * into s from public.settings where id = 1;
  for q in select * from public.requests where status = 'disbursed' loop
    v_days := current_date - q.disbursed_at::date;
    if v_days >= s.advance_grace_days and not exists (select 1 from public.notifications where request_id = q.id and kind = 'advance_reminder' and created_at > now() - interval '3 days') then
      perform public.notify_user(q.disbursed_to, 'advance_reminder', 'Cash out for ' || v_days || ' days – record what you spent',
        public.req_label(q) || ': ' || public.money_text(q.disbursed_amount) || ' paid out on ' || to_char(q.disbursed_at, 'DD Mon') || '. Upload the receipt and record the expense.', '#/requests/' || q.id, q.id);
      n := n + 1;
    end if;
    if v_days >= greatest(s.advance_escalate_days, s.advance_grace_days)
       and not exists (select 1 from public.notifications where request_id = q.id and kind = 'advance_overdue' and created_at > now() - interval '7 days') then
      perform public.notify_role('finance', 'advance_overdue', 'Advance overdue ' || v_days || ' days: ' || (select full_name from public.profiles where id = q.disbursed_to),
        public.req_label(q) || ' – ' || public.money_text(q.disbursed_amount) || ' still unaccounted for.', '#/requests/' || q.id, q.id);
      perform public.notify_role('approver', 'advance_overdue', 'Advance overdue ' || v_days || ' days: ' || (select full_name from public.profiles where id = q.disbursed_to),
        public.req_label(q) || ' – ' || public.money_text(q.disbursed_amount) || ' still unaccounted for.', '#/requests/' || q.id, q.id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- only the MD names their own stand-in: the administrator cannot hand the MD's approving authority to anyone (themselves included)
alter policy delegations_write on public.delegations
  using ((public.my_role() = 'approver' and role <> 'managing_director') or (from_user = auth.uid() and role = public.my_role()))
  with check ((public.my_role() = 'approver' and role <> 'managing_director') or (from_user = auth.uid() and role = public.my_role()));

-- someone who proposed or decided a schedule change has history and is deactivated, not removed
create or replace function public.profile_history(p_user uuid) returns integer
language sql stable security definer set search_path = public as $$
  select (select count(*) from public.requests where requester_id = p_user or disbursed_to = p_user or disbursed_by = p_user or approved_by = p_user or stock_reviewed_by = p_user or closed_by = p_user)
       + (select count(*) from public.request_events where actor_id = p_user)
       + (select count(*) from public.expenses where spent_by = p_user)
       + (select count(*) from public.stock_movements where created_by = p_user)
       + (select count(*) from public.stock_reports where reported_by = p_user)
       + (select count(*) from public.delegations where from_user = p_user or to_user = p_user)
       + (select count(*) from public.schedule_versions where proposed_by = p_user or decided_by = p_user)
$$;

-- ---------- version 1: the schedule as it stands today ----------
select public.schedule_record('start', 'Starting schedule, taken from the app''s settings when the schedule was introduced',
                              (select id from public.profiles where role = 'approver' and active order by created_at limit 1), 'no_md')
 where not exists (select 1 from public.schedule_versions);
