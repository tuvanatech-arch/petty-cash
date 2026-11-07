-- 058: a pay-back date for a claim (an option; finance can still pay it straight away).
-- Finance proposes a date; the claimer accepts it or proposes another with a reason; back and forth until one side accepts.
-- On the agreed day finance is reminded in the morning. Proposing never changes the claim's status or amount.

alter table public.requests
  add column if not exists payback_date date,
  add column if not exists payback_state text check (payback_state in ('proposed', 'agreed')),
  add column if not exists payback_by uuid references public.profiles(id),
  add column if not exists payback_note text,
  add column if not exists payback_at timestamptz,
  add column if not exists payback_reminded date;

create or replace function public.local_today() returns date
language sql stable set search_path = public as $$
  select (now() at time zone coalesce((select time_zone from public.settings where id = 1), 'Africa/Windhoek'))::date
$$;

create or replace function public.propose_payback(p_request uuid, p_date date, p_note text default null)
returns public.requests
language plpgsql security definer set search_path = public as $$
declare q public.requests; v_fin boolean := public.has_role('finance');
begin
  select * into q from public.requests where id = p_request for update;
  if q.id is null then raise exception 'Request not found'; end if;
  if q.type <> 'claim' or q.status <> 'awaiting_disbursement' then raise exception 'Only an approved claim waiting to be paid back can get a pay-back date'; end if;
  if p_date is null or p_date < public.local_today() then raise exception 'Choose a date from today on'; end if;
  if q.requester_id = auth.uid() then
    if q.payback_state is distinct from 'proposed' or q.payback_by = auth.uid() then raise exception 'Finance proposes the first date; you can then accept it or suggest another'; end if;
    if length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Say why the other date suits you better'; end if;
  elsif not v_fin then raise exception 'Only finance or the claimer can propose a pay-back date';
  end if;
  update public.requests set payback_date = p_date, payback_state = 'proposed', payback_by = auth.uid(), payback_note = nullif(trim(coalesce(p_note, '')), ''), payback_at = now(), payback_reminded = null
   where id = p_request returning * into q;
  if q.requester_id = auth.uid() then
    perform public.notify_role('finance', 'claim', 'New pay-back date suggested: ' || public.req_label(q),
      public.person_name(auth.uid()) || ' suggests ' || to_char(p_date, 'Dy DD Mon') || ': ' || q.payback_note || '. Accept it or suggest another.', '#/requests/' || q.id, q.id);
  else
    perform public.notify_user(q.requester_id, 'claim', 'Pay-back date for your claim: ' || to_char(p_date, 'Dy DD Mon'),
      'Finance proposes to pay back ' || public.req_label(q) || ' on ' || to_char(p_date, 'Dy DD Mon') || coalesce(' (' || q.payback_note || ')', '') || '. Accept it, or suggest another date.', '#/requests/' || q.id, q.id);
  end if;
  return q;
end $$;

create or replace function public.accept_payback(p_request uuid)
returns public.requests
language plpgsql security definer set search_path = public as $$
declare q public.requests;
begin
  select * into q from public.requests where id = p_request for update;
  if q.id is null or q.payback_state is distinct from 'proposed' then raise exception 'There is no proposed date to accept'; end if;
  if q.payback_by = auth.uid() then raise exception 'The other side accepts your date'; end if;
  if not (q.requester_id = auth.uid() or public.has_role('finance')) then raise exception 'Only finance or the claimer can accept the date'; end if;
  update public.requests set payback_state = 'agreed', payback_at = now() where id = p_request returning * into q;
  if q.requester_id = auth.uid() then
    perform public.notify_role('finance', 'claim', 'Pay-back date agreed: ' || public.req_label(q),
      public.person_name(auth.uid()) || ' accepted ' || to_char(q.payback_date, 'Dy DD Mon') || '. Petti reminds you that morning.', '#/requests/' || q.id, q.id);
  else
    perform public.notify_user(q.requester_id, 'claim', 'Pay-back date agreed: ' || to_char(q.payback_date, 'Dy DD Mon'),
      'Finance accepted your date for ' || public.req_label(q) || '.', '#/requests/' || q.id, q.id);
  end if;
  return q;
end $$;

-- the morning of the agreed day (and each working morning after, while still unpaid): remind finance once a day
create or replace function public.payback_chase() returns int
language plpgsql security definer set search_path = public as $$
declare q public.requests; n int := 0;
begin
  for q in select * from public.requests where type = 'claim' and status = 'awaiting_disbursement' and payback_state = 'agreed'
             and payback_date <= public.local_today() and payback_reminded is distinct from public.local_today() loop
    perform public.notify_role('finance', 'claim', case when q.payback_date = public.local_today() then 'Pay back today: ' else 'Pay-back date passed: ' end || public.req_label(q),
      'You agreed to pay ' || public.person_name(q.requester_id) || ' back on ' || to_char(q.payback_date, 'Dy DD Mon') || '.', '#/requests/' || q.id, q.id);
    update public.requests set payback_reminded = public.local_today() where id = q.id; n := n + 1;
  end loop;
  return n;
end $$;
select cron.schedule('petty-payback-chase', '0 6 * * 1-5', 'select public.payback_chase()');   -- 08:00 Windhoek, weekdays

revoke execute on function public.propose_payback(uuid, date, text), public.accept_payback(uuid), public.payback_chase() from public, anon;
grant execute on function public.propose_payback(uuid, date, text), public.accept_payback(uuid) to authenticated;
revoke execute on function public.payback_chase() from authenticated;
grant execute on function public.local_today() to authenticated;
