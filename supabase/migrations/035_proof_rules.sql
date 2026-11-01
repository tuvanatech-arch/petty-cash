-- 035: proof of payment, decided by finance before the money goes out.
--   • Finance (alone, by the purpose of the spending) marks a request "Proof required" (the default) or "No proof possible",
--     with the reason. Never on a request of their own. For a claim (money already spent) at review.
--   • Proof required: a digital copy is always uploaded (receipt, invoice, e-receipt or PDF; paper is scanned in Petti and
--     refused if unreadable). Whoever uploads says whether there is a paper slip; if there is, it must be handed in and the
--     request stays open until finance marks "Paper received".
--   • No proof possible: the spender says in the expense note where the money was spent and on what.
--   • Everything spent without proof is listed for the GM, the MD and the month-end pack (information, not an approval).

alter table public.requests add column if not exists proof_rule text not null default 'required' check (proof_rule in ('required', 'none'));
alter table public.requests add column if not exists proof_reason text;      -- why no proof is possible (taxi, informal seller, tip, parking, other: …)
alter table public.requests add column if not exists proof_set_by uuid references public.profiles(id);
alter table public.requests add column if not exists proof_set_at timestamptz;
alter table public.expenses add column if not exists paper_slip boolean;      -- null = not answered yet
alter table public.expenses add column if not exists no_receipt_note text;    -- a claimant who has no receipt says why

-- finance decides, before paying out (or when reviewing a claim)
create or replace function public.set_proof_rule(p_request uuid, p_rule text, p_reason text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_to uuid;
begin
  if not public.has_role('finance') then raise exception 'Only finance decides what proof is needed'; end if;
  if p_rule not in ('required', 'none') then raise exception 'Choose “Proof required” or “No proof possible”'; end if;
  select * into r from public.requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  -- before the money goes out; or in the minutes after "Pay out now", which creates and pays the request in one step
  if r.status not in ('pending_approval', 'awaiting_disbursement')
     and not (r.status = 'disbursed' and r.disbursed_by = auth.uid() and r.disbursed_at > now() - interval '10 minutes'
              and not exists (select 1 from public.expenses x where x.request_id = r.id and x.total > 0)) then
    raise exception 'What proof is needed is decided before the money goes out';
  end if;
  if p_rule = 'none' then
    if v_reason is null then raise exception 'Say why no proof is possible (for example: taxi, informal seller)'; end if;
    v_to := case when r.type = 'stock' and not r.for_store then coalesce(r.stock_reviewed_by, r.requester_id) else r.requester_id end;
    if r.requester_id = auth.uid() or v_to = auth.uid() then raise exception 'Your own request always needs proof – someone else cannot check it otherwise'; end if;
  end if;
  update public.requests set proof_rule = p_rule, proof_reason = case when p_rule = 'none' then v_reason end, proof_set_by = auth.uid(), proof_set_at = now()
   where id = p_request returning * into r;
  perform public.log_event(p_request, case when p_rule = 'none' then 'no_proof' else 'proof_required' end, r.status, r.status,
    case when p_rule = 'none' then 'No proof possible: ' || v_reason else 'Proof required' end);
  return r;
end $$;
grant execute on function public.set_proof_rule(uuid, text, text) to authenticated;

-- the person who spent (or claims) says whether there is a paper slip
create or replace function public.set_paper_slip(p_request uuid, p_has boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype;
begin
  select * into r from public.requests where id = p_request;
  if r.id is null then raise exception 'Request not found'; end if;
  if auth.uid() not in (r.requester_id, coalesce(r.disbursed_to, r.requester_id)) and not public.has_role('finance') then raise exception 'Only the person who spent the money says this'; end if;
  insert into public.expenses (request_id, spent_by, spent_at, total) values (p_request, auth.uid(), current_date, 0) on conflict (request_id) do nothing;
  update public.expenses set paper_slip = p_has where request_id = p_request;
end $$;
grant execute on function public.set_paper_slip(uuid, boolean) to authenticated;

-- a claimant with no receipt at all says why; finance then decides (No proof possible, or return it)
create or replace function public.claim_without_receipt(p_request uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype;
begin
  select * into r from public.requests where id = p_request;
  if r.id is null or r.type <> 'claim' then raise exception 'Only a claim can be sent without a receipt'; end if;
  if r.requester_id <> auth.uid() then raise exception 'Only the claimant can say this'; end if;
  if r.status <> 'draft' then raise exception 'Only a claim not yet sent can be changed'; end if;
  insert into public.expenses (request_id, spent_by, spent_at, total) values (p_request, auth.uid(), current_date, 0) on conflict (request_id) do nothing;
  update public.expenses set no_receipt_note = nullif(btrim(coalesce(p_note, '')), ''), paper_slip = case when nullif(btrim(coalesce(p_note, '')), '') is null then paper_slip else false end where request_id = p_request;
end $$;
grant execute on function public.claim_without_receipt(uuid, text) to authenticated;

-- the existing checks learn the new rules: edited in place so nothing else in these functions changes
do $$
declare d text; o text;
begin
  -- recording what was spent
  d := pg_get_functiondef('public.record_expense(uuid, date, jsonb, text)'::regprocedure); o := d;
  d := replace(d, $x$  if not exists (select 1 from public.expense_proofs where expense_id = e.id) then
    raise exception 'Upload a scanned copy of the receipt before submitting the expense';
  end if;$x$, $x$  if r.proof_rule = 'none' then
    if nullif(btrim(coalesce(p_notes, '')), '') is null then raise exception 'No receipt is needed for this one: say in the note where you spent the money and on what'; end if;
  elsif not exists (select 1 from public.expense_proofs where expense_id = e.id) then
    raise exception 'Upload the receipt (scan it in Petti) before submitting the expense';
  elsif e.paper_slip is null then
    raise exception 'Say whether you have the paper slip';
  end if;$x$);
  if d = o then raise exception 'record_expense: receipt check not found – not changed'; end if;
  execute d;

  -- finance confirming
  d := pg_get_functiondef('public.finance_review_expense(uuid, text, text)'::regprocedure); o := d;
  d := replace(d, $x$if v_proofs = 0 then raise exception 'No scanned proof has been uploaded'; end if;$x$,
                  $x$if v_proofs = 0 and r.proof_rule <> 'none' then raise exception 'No scanned proof has been uploaded'; end if;$x$);
  if d = o then raise exception 'finance_review_expense: proof check not found – not changed'; end if;
  execute d;

  -- sending a claim
  d := pg_get_functiondef('public.submit_request(uuid)'::regprocedure); o := d;
  d := replace(d, $x$if not exists (select 1 from public.expense_proofs where expense_id = e.id) then raise exception 'Upload the receipt before submitting the claim'; end if;$x$,
                  $x$if not exists (select 1 from public.expense_proofs where expense_id = e.id) and e.no_receipt_note is null then raise exception 'Upload the receipt before submitting the claim, or say why there is none'; end if;
      if exists (select 1 from public.expense_proofs where expense_id = e.id) and e.paper_slip is null then raise exception 'Say whether you have the paper slip'; end if;$x$);
  if d = o then raise exception 'submit_request: claim receipt check not found – not changed'; end if;
  execute d;

  -- paying back a claim that came without a receipt: only once finance has marked it "No proof possible"
  d := pg_get_functiondef('public.disburse_request(uuid, numeric, uuid, text)'::regprocedure); o := d;
  d := replace(d, $x$if e.id is null then raise exception 'The claim has no expense attached'; end if;$x$,
                  $x$if e.id is null then raise exception 'The claim has no expense attached'; end if;
    if r.proof_rule <> 'none' and not exists (select 1 from public.expense_proofs where expense_id = e.id) then
      raise exception 'This claim has no receipt. Mark it “No proof possible” (with the reason) or return it.';
    end if;$x$);
  if d = o then raise exception 'disburse_request: claim check not found – not changed'; end if;
  execute d;
end $$;

-- a paper slip exists: it must reach finance before the request can close
create or replace function public.paper_slip_due() returns trigger
language plpgsql security definer set search_path = public as $$
declare e public.expenses%rowtype;
begin
  if new.status is not distinct from old.status then return new; end if;
  if not (new.status = 'proof_review' or (new.type = 'claim' and old.status = 'draft' and new.status <> 'draft')) then return new; end if;
  select * into e from public.expenses where request_id = new.id;
  if e.id is null or not coalesce(e.paper_slip, false) or e.physical_received_at is not null then return new; end if;
  update public.expenses set proof_status = 'physical_required', physical_required_at = now() where id = e.id;
  if new.type <> 'claim' then
    update public.requests set status = 'physical_required' where id = new.id;   -- the paper-receipt stage finance already works with
    perform public.log_event(new.id, 'physical_required', new.status, 'physical_required', 'Paper slip to hand in');
  end if;
  perform public.notify_user(coalesce(new.disbursed_to, new.requester_id), 'physical', 'Hand the paper slip to finance: ' || public.req_label(new),
    'You said there is a paper slip. It closes once finance has it.', '#/requests/' || new.id, new.id);
  return new;
end $$;
revoke execute on function public.paper_slip_due() from public, anon, authenticated;
create or replace trigger requests_paper_slip_due after update of status on public.requests for each row execute function public.paper_slip_due();

-- spending without proof, for the GM, the MD and the month-end pack
create or replace function public.no_proof_list(p_from date default null, p_to date default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'request_no', r.request_no, 'purpose', r.purpose, 'reason', r.proof_reason,
    'who', (select full_name from public.profiles where id = coalesce(r.disbursed_to, r.requester_id)),
    'decided_by', (select full_name from public.profiles where id = r.proof_set_by), 'decided_at', r.proof_set_at,
    'amount', coalesce(e.total, r.disbursed_amount, r.estimated_total), 'status', r.status, 'note', e.notes, 'branch_id', r.branch_id) order by r.proof_set_at desc), '[]'::jsonb)
  from public.requests r left join public.expenses e on e.request_id = r.id
  where r.proof_rule = 'none' and public.is_staff() and r.branch_id = any (public.my_branches())
    and (p_from is null or r.proof_set_at >= p_from) and (p_to is null or r.proof_set_at < p_to)
$$;
grant execute on function public.no_proof_list(date, date) to authenticated;
