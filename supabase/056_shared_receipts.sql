-- 056: one receipt, several requests (Nov 2026).
-- A receipt often covers things from more than one request (one trip to the shop). When it is scanned, Petti reads
-- its lines and sorts each one: on this request; on someone else's open request in the same branch (that person is
-- asked "Is this yours?" and, on yes, the receipt is attached to their request with their share); on no request
-- (start a request for it, or mark it personal, not claimed). The receipt is stored once; each request is checked
-- against its own share, and a shared receipt is not a "duplicate".

create extension if not exists pg_trgm with schema extensions;

alter table public.expense_proofs
  add column if not exists share_amount numeric(12,2),                                  -- this request's share of a shared receipt
  add column if not exists shared_from uuid references public.expense_proofs(id) on delete set null,   -- the receipt as first scanned
  add column if not exists placement jsonb;                                              -- on the first scan: where each line went

create table if not exists public.receipt_shares (
  id uuid primary key default gen_random_uuid(),
  proof_id uuid not null references public.expense_proofs(id) on delete cascade,
  from_request uuid not null references public.requests(id) on delete cascade,
  to_request uuid not null references public.requests(id) on delete cascade,
  lines jsonb not null default '[]'::jsonb,            -- [{i, description, amount}]
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'offered' check (status in ('offered', 'accepted', 'declined', 'withdrawn')),
  offered_by uuid not null default auth.uid() references public.profiles(id),
  offered_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  note text,
  reminded_at timestamptz,
  new_proof_id uuid references public.expense_proofs(id) on delete set null
);
create index if not exists receipt_shares_to on public.receipt_shares (to_request) where status = 'offered';
create index if not exists receipt_shares_proof on public.receipt_shares (proof_id);
alter table public.receipt_shares enable row level security;
create policy receipt_shares_select on public.receipt_shares for select to authenticated
  using (public.can_view_request(from_request) or public.can_view_request(to_request));
create policy two_step_required on public.receipt_shares as restrictive for all to authenticated using (not (select public.two_step_blocked())) with check (not (select public.two_step_blocked()));

/* the words on a receipt line and a request line, compared loosely (receipts shorten names) */
create or replace function public.text_match(a text, b text) returns numeric language sql immutable set search_path = public, extensions as $$
  select round(greatest(extensions.word_similarity(lower(coalesce(a, '')), lower(coalesce(b, ''))), extensions.word_similarity(lower(coalesce(b, '')), lower(coalesce(a, ''))))::numeric, 2)
$$;
create or replace function public.receipt_line_amount(l jsonb) returns numeric language sql immutable as $$
  select round(coalesce(case when l->>'qty' ~ '^[0-9.]+$' then (l->>'qty')::numeric end, 1)
             * coalesce(case when l->>'unit_price' ~ '^-?[0-9.]+$' then (l->>'unit_price')::numeric end, case when l->>'amount' ~ '^-?[0-9.]+$' then (l->>'amount')::numeric end, 0), 2)
$$;
create or replace function public.receipt_date(p public.expense_proofs) returns date language sql stable as $$
  select coalesce(case when p.extracted->>'date' ~ '^\d{4}-\d{2}-\d{2}$' then (p.extracted->>'date')::date end, p.uploaded_at::date)
$$;

/* What is left of a receipt for its own request: the total less what was shared out or marked personal. */
create or replace function public.proof_amount(p_proof uuid) returns numeric language sql stable security definer set search_path = public as $$
  select case when p.share_amount is not null then p.share_amount
              when p.extracted->>'total' ~ '^[0-9.]+$' then (p.extracted->>'total')::numeric
                   - coalesce((select sum(s.amount) from public.receipt_shares s where s.proof_id = p.id and s.status in ('offered', 'accepted')), 0)
                   - coalesce((select sum(public.receipt_line_amount(x)) from jsonb_array_elements(coalesce(p.placement, '[]'::jsonb)) x where x->>'where' = 'personal'), 0)
         end
    from public.expense_proofs p where p.id = p_proof
$$;

/* For each line of a scanned receipt: the open requests in the same branch it may belong to (best first). */
create or replace function public.receipt_line_matches(p_proof uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare p public.expense_proofs%rowtype; v_req public.requests%rowtype; v_date date; l jsonb; i int := 0; v_amt numeric; c jsonb; v_out jsonb := '[]'::jsonb;
begin
  select * into p from public.expense_proofs where id = p_proof;
  if p.id is null then raise exception 'Receipt not found'; end if;
  select q.* into v_req from public.requests q join public.expenses e on e.request_id = q.id where e.id = p.expense_id;
  if not public.can_view_request(v_req.id) then raise exception 'Not allowed'; end if;
  v_date := public.receipt_date(p);
  for l in select * from jsonb_array_elements(coalesce(p.extracted->'lines', '[]'::jsonb)) loop
    v_amt := public.receipt_line_amount(l);
    select coalesce(jsonb_agg(x order by (x->>'score')::numeric desc), '[]'::jsonb) into c from (
      select distinct on (q.id) jsonb_build_object('request_id', q.id, 'request_no', q.request_no, 'purpose', q.purpose, 'person', pr.full_name,
               'mine', q.requester_id = auth.uid(), 'line', coalesce(it.name, rl.description), 'line_amount', round(rl.qty * rl.est_unit_price, 2),
               'score', public.text_match(coalesce(it.name, rl.description), l->>'description')
                        + case when v_amt > 0 and abs(round(rl.qty * rl.est_unit_price, 2) - v_amt) <= greatest(1, v_amt * 0.05) then 0.5 else 0 end) x
        from public.requests q join public.request_lines rl on rl.request_id = q.id
        left join public.items it on it.id = rl.item_id
        join public.profiles pr on pr.id = q.requester_id
       where q.id <> v_req.id and q.branch_id is not distinct from v_req.branch_id
         and q.status not in ('draft', 'closed', 'fulfilled_from_stock', 'rejected', 'cancelled')
         and q.created_at::date between v_date - 60 and v_date + 7
         and (public.text_match(coalesce(it.name, rl.description), l->>'description') >= 0.4
              or (v_amt > 0 and abs(round(rl.qty * rl.est_unit_price, 2) - v_amt) <= greatest(0.5, v_amt * 0.02)))
       order by q.id, public.text_match(coalesce(it.name, rl.description), l->>'description') desc) z
     limit 3;
    v_out := v_out || jsonb_build_object('i', i, 'description', l->>'description', 'amount', v_amt, 'candidates', c);
    i := i + 1;
  end loop;
  return v_out;
end $$;

/* Mark a receipt line: on this request, personal (not claimed), or not placed again. */
create or replace function public.place_receipt_line(p_proof uuid, p_index int, p_where text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.expense_proofs%rowtype; v_req uuid; v_line jsonb; v_pl jsonb;
begin
  select * into p from public.expense_proofs where id = p_proof for update;
  select e.request_id into v_req from public.expenses e where e.id = p.expense_id;
  if p.id is null or not public.can_view_request(v_req) then raise exception 'Not allowed'; end if;
  if p.shared_from is not null then raise exception 'This is a share of a receipt scanned on another request: its lines are sorted there'; end if;
  if p_where not in ('own', 'personal', 'clear') then raise exception 'Choose where the line goes'; end if;
  v_line := p.extracted->'lines'->p_index;
  if v_line is null then raise exception 'That line is not on the receipt'; end if;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_pl from jsonb_array_elements(coalesce(p.placement, '[]'::jsonb)) x where (x->>'i')::int <> p_index;
  if p_where <> 'clear' then
    v_pl := v_pl || jsonb_build_object('i', p_index, 'description', v_line->>'description', 'qty', v_line->'qty', 'unit_price', v_line->'unit_price', 'where', p_where);
  end if;
  update public.expense_proofs set placement = v_pl where id = p.id;
  return v_pl;
end $$;

/* Offer part of a receipt to another request ("Is this yours?"). To one's own request it is attached straight away. */
create or replace function public.share_receipt_lines(p_proof uuid, p_to_request uuid, p_lines int[]) returns public.receipt_shares
language plpgsql security definer set search_path = public as $$
declare p public.expense_proofs%rowtype; v_from public.requests%rowtype; v_to public.requests%rowtype; s public.receipt_shares%rowtype;
        v_lines jsonb := '[]'::jsonb; v_amt numeric := 0; i int; l jsonb;
begin
  select * into p from public.expense_proofs where id = p_proof for update;
  select q.* into v_from from public.requests q join public.expenses e on e.request_id = q.id where e.id = p.expense_id;
  if p.id is null or not public.can_view_request(v_from.id) then raise exception 'Not allowed'; end if;
  if p.shared_from is not null then raise exception 'This is a share of a receipt scanned on another request: share it from there'; end if;
  select * into v_to from public.requests where id = p_to_request;
  if v_to.id is null or v_to.id = v_from.id then raise exception 'Choose the other request'; end if;
  if v_to.branch_id is distinct from v_from.branch_id then raise exception 'A receipt can only be shared within its branch'; end if;
  if v_to.status in ('closed', 'fulfilled_from_stock', 'rejected', 'cancelled') then raise exception 'That request is finished'; end if;
  if coalesce(array_length(p_lines, 1), 0) = 0 then raise exception 'Choose the lines that belong to it'; end if;
  foreach i in array p_lines loop
    l := p.extracted->'lines'->i;
    if l is null then raise exception 'That line is not on the receipt'; end if;
    if exists (select 1 from public.receipt_shares x where x.proof_id = p.id and x.status in ('offered', 'accepted') and x.lines @> jsonb_build_array(jsonb_build_object('i', i))) then
      raise exception 'Line % is already shared', i + 1; end if;
    v_lines := v_lines || jsonb_build_object('i', i, 'description', l->>'description', 'amount', public.receipt_line_amount(l));
    v_amt := v_amt + public.receipt_line_amount(l);
  end loop;
  if v_amt <= 0 then raise exception 'Those lines have no amount'; end if;
  insert into public.receipt_shares (proof_id, from_request, to_request, lines, amount)
  values (p.id, v_from.id, v_to.id, v_lines, v_amt) returning * into s;
  -- the lines are no longer "on this request" or "personal"
  update public.expense_proofs set placement = (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(coalesce(placement, '[]'::jsonb)) x where not ((x->>'i')::int = any(p_lines)))
   where id = p.id;
  if auth.uid() in (v_to.requester_id, v_to.disbursed_to) then
    s := public.decide_receipt_share(s.id, true, null);
  else
    perform public.notify_user(v_to.requester_id, 'document', 'Is this yours? A receipt for ' || public.req_label(v_to),
      public.person_name(auth.uid()) || ' bought ' || (select string_agg(x->>'description', ', ') from jsonb_array_elements(v_lines) x) || ' (' || public.money_text(v_amt)
        || ') on one receipt and thinks it belongs to your request. Open it to say yes or no.', '#/requests/' || v_to.id, v_to.id);
    perform public.log_event(v_to.id, 'receipt_offered', v_to.status, v_to.status, public.money_text(v_amt) || ' of a receipt from ' || public.req_label(v_from));
  end if;
  return s;
end $$;

/* "Yes, it's mine" (the receipt is attached to my request with my share) or "Not mine" (with a reason). */
create or replace function public.decide_receipt_share(p_share uuid, p_accept boolean, p_note text default null) returns public.receipt_shares
language plpgsql security definer set search_path = public as $$
declare s public.receipt_shares%rowtype; p public.expense_proofs%rowtype; v_to public.requests%rowtype; v_from public.requests%rowtype; e public.expenses%rowtype; v_new uuid;
begin
  select * into s from public.receipt_shares where id = p_share for update;
  if s.id is null then raise exception 'Not found'; end if;
  if s.status <> 'offered' then raise exception 'This was already answered'; end if;
  select * into v_to from public.requests where id = s.to_request;
  select * into v_from from public.requests where id = s.from_request;
  if auth.uid() not in (v_to.requester_id, coalesce(v_to.disbursed_to, v_to.requester_id)) then raise exception 'Only the person whose request it is can answer'; end if;
  if not p_accept then
    if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'Say why it is not yours'; end if;
    update public.receipt_shares set status = 'declined', decided_by = auth.uid(), decided_at = now(), note = btrim(p_note) where id = s.id returning * into s;
    perform public.notify_user(s.offered_by, 'document', 'Not theirs: part of your receipt on ' || public.req_label(v_from),
      public.person_name(auth.uid()) || ' says ' || public.money_text(s.amount) || ' is not on ' || public.req_label(v_to) || ': ' || btrim(p_note) || '. Open the receipt to place those lines again.', '#/requests/' || v_from.id, v_from.id);
    return s;
  end if;
  select * into p from public.expense_proofs where id = s.proof_id;
  select * into e from public.expenses where request_id = v_to.id;
  if e.id is null then
    insert into public.expenses (request_id, spent_by, spent_at, total, supplier_name) values (v_to.id, s.offered_by, public.receipt_date(p), 0, p.extracted->>'supplier') returning * into e;
  end if;
  insert into public.expense_proofs (expense_id, storage_path, file_name, mime, uploaded_by, extracted, sha256, share_amount, shared_from)
  values (e.id, p.storage_path, p.file_name, p.mime, s.offered_by, p.extracted, p.sha256, s.amount, p.id) returning id into v_new;
  update public.receipt_shares set status = 'accepted', decided_by = auth.uid(), decided_at = now(), new_proof_id = v_new, note = nullif(btrim(coalesce(p_note, '')), '') where id = s.id returning * into s;
  perform public.log_event(v_to.id, 'receipt_shared', v_to.status, v_to.status, public.money_text(s.amount) || ' of a receipt shared with ' || public.req_label(v_from));
  if s.offered_by <> auth.uid() then
    perform public.notify_user(s.offered_by, 'document', 'Receipt shared: ' || public.req_label(v_to),
      public.person_name(auth.uid()) || ' confirmed ' || public.money_text(s.amount) || ' of your receipt is on their request.', '#/requests/' || v_from.id, v_from.id);
  end if;
  return s;
end $$;

/* A receipt shared with another request cannot be removed (the other request uses the same file): take the share back first. */
create or replace function public.expense_proofs_shared_guard() returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.receipt_shares s where s.proof_id = old.id and s.status in ('offered', 'accepted')) then
    raise exception 'This receipt is shared with another request, so it cannot be removed. Take the share back first, or ask finance.';
  end if;
  return old;
end $$;
create or replace trigger expense_proofs_shared_guard before delete on public.expense_proofs for each row execute function public.expense_proofs_shared_guard();

/* The person who offered it can take an unanswered share back. */
create or replace function public.withdraw_receipt_share(p_share uuid) returns public.receipt_shares
language plpgsql security definer set search_path = public as $$
declare s public.receipt_shares%rowtype;
begin
  update public.receipt_shares set status = 'withdrawn', decided_by = auth.uid(), decided_at = now()
   where id = p_share and status = 'offered' and offered_by = auth.uid() returning * into s;
  if s.id is null then raise exception 'Only an unanswered share you offered can be taken back'; end if;
  return s;
end $$;

/* One reminder the next working day for an unanswered "Is this yours?". */
create or replace function public.receipt_share_chase() returns int language plpgsql security definer set search_path = public as $$
declare s record; n int := 0;
begin
  for s in select rs.*, q.requester_id, q.id as qid from public.receipt_shares rs join public.requests q on q.id = rs.to_request
            where rs.status = 'offered' and rs.reminded_at is null and rs.offered_at < now() - interval '20 hours' loop
    perform public.notify_user(s.requester_id, 'chased', 'Reminder: is this receipt yours?',
      public.person_name(s.offered_by) || ' is waiting for your answer about ' || public.money_text(s.amount) || ' of a receipt.', '#/requests/' || s.qid, s.qid);
    update public.receipt_shares set reminded_at = now() where id = s.id; n := n + 1;
  end loop;
  return n;
end $$;
select cron.schedule('petty-receipt-share-chase', '15 7 * * 1-5', 'select public.receipt_share_chase()');   -- 09:15 Windhoek, weekdays

/* A receipt shared this way is not a duplicate: only reuse without sharing is. */
create or replace function public.receipt_duplicate_of(p_expense uuid)
 returns jsonb language sql stable security definer set search_path to 'public' as $function$
  select coalesce(
    (select jsonb_build_object('request_no', q2.request_no, 'request_id', q2.id, 'why', 'the same receipt photo')
       from public.expense_proofs p join public.expense_proofs p2 on p2.sha256 = p.sha256 and p2.expense_id <> p.expense_id
       join public.expenses e2 on e2.id = p2.expense_id join public.requests q2 on q2.id = e2.request_id
      where p.expense_id = p_expense and p.sha256 is not null and q2.status not in ('rejected', 'cancelled', 'draft')
        and coalesce(p.shared_from, p.id) is distinct from coalesce(p2.shared_from, p2.id)
      order by q2.request_no limit 1),
    (select jsonb_build_object('request_no', q2.request_no, 'request_id', q2.id, 'why', 'the same supplier, date and amount')
       from public.expenses e join public.expenses e2 on e2.id <> e.id and e2.spent_at = e.spent_at and abs(e2.total - e.total) < 0.005 and e2.total > 0
       join public.requests q2 on q2.id = e2.request_id
      where e.id = p_expense and coalesce(btrim(e.supplier_name), '') <> '' and lower(btrim(e2.supplier_name)) = lower(btrim(e.supplier_name))
        and q2.status not in ('rejected', 'cancelled', 'draft')
      order by q2.request_no limit 1))
$function$;

/* "Already on #…" when scanning: not when the same receipt is the one being shared. */
create or replace function public.proof_used(p_sha256 text, p_request uuid default null)
 returns jsonb language sql stable security definer set search_path to 'public' as $function$
  select jsonb_build_object('request_no', q.request_no)
    from public.expense_proofs p join public.expenses e on e.id = p.expense_id join public.requests q on q.id = e.request_id
   where p.sha256 = p_sha256 and p_sha256 ~ '^[0-9a-f]{64}$' and q.id is distinct from p_request and q.status not in ('rejected', 'cancelled', 'draft')
     and not exists (select 1 from public.receipt_shares s where s.status in ('offered', 'accepted') and s.proof_id = coalesce(p.shared_from, p.id) and s.to_request = p_request)
   order by q.request_no limit 1
$function$;

/* The receipt check compares each request with its own share of a shared receipt. */
create or replace function public.expense_checks(p_request uuid default null)
 returns table(request_id uuid, status text, note text, reading_total numeric)
 language plpgsql stable security definer set search_path to 'public' as $function$
declare r record; v_n int; v_pre int; v_read numeric; v_dup jsonb; v_soft int; v_status text; v_note text; v_shared int;
begin
  if p_request is null and not public.is_staff() then raise exception 'Not allowed'; end if;
  if p_request is not null and not public.can_view_request(p_request) then raise exception 'Not allowed'; end if;
  for r in select q.id, q.request_no, e.id as expense_id, e.total, e.spent_at, e.supplier_name, e.duplicate_note from public.requests q join public.expenses e on e.request_id = q.id
           where (p_request is null and q.status in ('proof_review', 'physical_required', 'awaiting_disbursement') and e.total > 0) or q.id = p_request loop
    select count(*), count(*) filter (where (p.extracted->>'pre_payment')::boolean),
           sum(public.proof_amount(p.id)) filter (where public.proof_amount(p.id) is not null),
           count(*) filter (where p.shared_from is not null or exists (select 1 from public.receipt_shares s where s.proof_id = p.id and s.status in ('offered', 'accepted')))
      into v_n, v_pre, v_read, v_shared from public.expense_proofs p where p.expense_id = r.expense_id;
    v_status := case when v_n = 0 then 'no_proof' when v_read is null then 'unread'
                     when abs(v_read - r.total) <= greatest(0.5, v_read * 0.01) then 'matches' else 'mismatch' end;
    v_note := case v_status when 'matches' then 'Receipt reads ' || public.money_text(v_read) || ' – matches what was recorded'
                            when 'mismatch' then 'Receipt reads ' || public.money_text(v_read) || ' but ' || public.money_text(r.total) || ' was recorded'
                            when 'unread' then 'Scan attached, not read' else 'No scan attached' end;
    if v_shared > 0 and v_status in ('matches', 'mismatch') then v_note := replace(v_note, 'Receipt reads', 'This request''s share of a shared receipt is'); end if;
    if v_pre > 0 and v_n = v_pre then v_note := v_note || ' · the invoice was attached before the pay-out: confirm it was actually paid'; end if;
    v_dup := public.receipt_duplicate_of(r.expense_id);
    if v_dup is not null then
      v_status := 'duplicate';
      v_note := 'Already used on #' || (v_dup->>'request_no') || ' – ' || (v_dup->>'why')
                || case when r.duplicate_note is not null then ' · explained: ' || r.duplicate_note else ' · accepting it needs an explanation' end;
    else
      select q2.request_no into v_soft from public.expenses e2 join public.requests q2 on q2.id = e2.request_id
        where e2.request_id <> r.id and e2.spent_at = r.spent_at and abs(e2.total - r.total) < 0.01 and e2.total > 0
          and q2.status not in ('rejected', 'cancelled', 'draft') limit 1;
      if v_soft is not null then v_note := v_note || ' · same amount on the same day as #' || v_soft || ' – check it is not the same purchase'; end if;
    end if;
    request_id := r.id; status := v_status; note := v_note; reading_total := v_read;
    return next;
  end loop;
end $function$;

/* The shares of a receipt (from its request), or the receipts offered to a request (to its person), with names. */
create or replace function public.receipt_shares_info(p_proof uuid default null, p_request uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_from uuid;
begin
  if p_proof is not null then
    select e.request_id into v_from from public.expense_proofs ep join public.expenses e on e.id = ep.expense_id where ep.id = p_proof;
    if v_from is null or not public.can_view_request(v_from) then raise exception 'Not allowed'; end if;
    return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'status', s.status, 'lines', s.lines, 'amount', s.amount, 'offered_by', s.offered_by, 'note', s.note,
              'to_request', s.to_request, 'request_no', q.request_no, 'purpose', q.purpose, 'person', public.person_name(q.requester_id), 'mine', q.requester_id = auth.uid()) order by s.offered_at)
            from public.receipt_shares s join public.requests q on q.id = s.to_request where s.proof_id = p_proof), '[]'::jsonb);
  end if;
  if not public.can_view_request(p_request) then raise exception 'Not allowed'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'status', s.status, 'lines', s.lines, 'amount', s.amount, 'offered_by', s.offered_by, 'offered_at', s.offered_at,
            'by', public.person_name(s.offered_by), 'from_request_no', q.request_no, 'storage_path', p.storage_path, 'mime', p.mime, 'supplier', p.extracted->>'supplier', 'total', p.extracted->>'total') order by s.offered_at)
          from public.receipt_shares s join public.expense_proofs p on p.id = s.proof_id join public.requests q on q.id = s.from_request
         where s.to_request = p_request and s.status = 'offered'), '[]'::jsonb);
end $$;

/* The receipt file: seen by anyone who can see a request that carries it (so a shared receipt opens on each). */
create or replace function public.can_view_proof_file(p_name text) returns boolean language sql stable security definer set search_path = public as $$
  select public.can_view_request(public.try_uuid((storage.foldername(p_name))[1]))
      or exists (select 1 from public.expense_proofs ep join public.expenses e on e.id = ep.expense_id
                  where ep.storage_path = p_name and ep.shared_from is not null and public.can_view_request(e.request_id))
      or exists (select 1 from public.receipt_shares s join public.expense_proofs ep on ep.id = s.proof_id
                  where ep.storage_path = p_name and s.status = 'offered' and public.can_view_request(s.to_request))
$$;
alter policy proofs_select on storage.objects using (bucket_id = 'proofs' and public.can_view_proof_file(name));

revoke execute on function public.receipt_line_matches(uuid), public.place_receipt_line(uuid, int, text), public.share_receipt_lines(uuid, uuid, int[]),
  public.decide_receipt_share(uuid, boolean, text), public.withdraw_receipt_share(uuid), public.proof_amount(uuid), public.receipt_shares_info(uuid, uuid) from public, anon;
grant execute on function public.receipt_line_matches(uuid), public.place_receipt_line(uuid, int, text), public.share_receipt_lines(uuid, uuid, int[]),
  public.decide_receipt_share(uuid, boolean, text), public.withdraw_receipt_share(uuid), public.proof_amount(uuid), public.receipt_shares_info(uuid, uuid) to authenticated;
revoke execute on function public.receipt_share_chase() from public, anon, authenticated;
