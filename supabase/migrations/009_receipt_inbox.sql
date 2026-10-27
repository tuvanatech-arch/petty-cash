-- v3.3: snap-first receipts. A photo lands in the user's inbox, is read, and is then filed against a request
-- (or becomes a claim) with one confirmation. Unfiled photos wait in the inbox.

-- ---------- inbox files live in the proofs bucket under inbox/<user>/... ----------
create policy proofs_inbox_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'proofs' and (storage.foldername(name))[1] = 'inbox' and (storage.foldername(name))[2] = auth.uid()::text);
create policy proofs_inbox_select on storage.objects for select to authenticated
  using (bucket_id = 'proofs' and (storage.foldername(name))[1] = 'inbox' and (storage.foldername(name))[2] = auth.uid()::text);
-- filing = moving the object from inbox/<user>/ to <request>/ ; the destination must satisfy the same rule as a direct upload
create policy proofs_inbox_move on storage.objects for update to authenticated
  using (bucket_id = 'proofs' and owner_id = auth.uid()::text)
  with check (bucket_id = 'proofs' and (
    ((storage.foldername(name))[1] = 'inbox' and (storage.foldername(name))[2] = auth.uid()::text)
    or (public.can_view_request(public.try_uuid((storage.foldername(name))[1])) and exists (
      select 1 from public.requests r where r.id = public.try_uuid((storage.foldername(name))[1])
        and (r.status in ('disbursed', 'proof_review', 'physical_required') or (r.type = 'claim' and r.status in ('draft', 'pending_approval', 'awaiting_disbursement')))))));

-- ---------- inbox rows ----------
create table if not exists public.receipt_inbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  storage_path text not null,
  file_name text not null,
  mime text,
  extracted jsonb,
  read_error text,
  status text not null default 'unfiled' check (status in ('unfiled', 'filed', 'discarded')),
  filed_request_id uuid references public.requests(id),
  filed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists receipt_inbox_user_idx on public.receipt_inbox (user_id) where status = 'unfiled';
alter table public.receipt_inbox enable row level security;
create policy receipt_inbox_select on public.receipt_inbox for select to authenticated using (user_id = auth.uid());
create policy receipt_inbox_insert on public.receipt_inbox for insert to authenticated with check (user_id = auth.uid());
create policy receipt_inbox_update on public.receipt_inbox for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- after the client has moved the file into the request's folder, this attaches it as a proof and closes the inbox row
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
  insert into public.expense_proofs (expense_id, storage_path, file_name, mime, uploaded_by, extracted)
  values (e.id, p_new_path, ib.file_name, ib.mime, auth.uid(), ib.extracted) returning * into pr;
  update public.receipt_inbox set status = 'filed', filed_request_id = p_request, filed_at = now(), storage_path = p_new_path where id = p_inbox;
  return pr;
end $$;
revoke execute on function public.file_inbox_receipt(uuid, uuid, text) from public, anon;
