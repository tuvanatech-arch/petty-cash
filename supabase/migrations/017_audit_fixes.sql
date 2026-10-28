-- 017: fixes from the live audit (every workflow run as each real role against the real database).

-- 1. Quick count failed every time: the movement kind was passed as text.
create or replace function public.quick_count(p_lines jsonb, p_on date default current_date, p_note text default null) returns integer
language plpgsql security definer set search_path = public as $$
declare l jsonb; v_item uuid; v_counted numeric; v_onhand numeric; v_delta numeric; v_n int := 0; v_at timestamptz;
begin
  if not (public.has_role('stock_manager') or public.has_role('approver')) then raise exception 'Only the stock manager can count stock'; end if;
  if p_on > current_date then raise exception 'A count cannot be in the future'; end if;
  v_at := case when p_on < current_date then (p_on + time '12:00')::timestamptz else now() end;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_item := (l->>'item_id')::uuid;
    v_counted := (l->>'counted')::numeric;
    if v_counted is null or v_counted < 0 then continue; end if;
    select qty_on_hand into v_onhand from public.items where id = v_item for update;
    if v_onhand is null then continue; end if;
    v_delta := v_counted - v_onhand;
    if v_delta = 0 then continue; end if;
    insert into public.stock_movements (item_id, kind, delta, created_by, note, occurred_on, created_at)
    values (v_item, (case when v_delta < 0 then 'usage' else 'count' end)::public.movement_kind, v_delta, auth.uid(),
            coalesce(nullif(p_note, ''), case when v_delta < 0 then 'Used since last count' else 'Found more than recorded at count' end),
            coalesce(p_on, current_date), v_at);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- 2 + 3. Deleting a draft failed when it came from Snap (inbox link) or from stock reports (report link).
-- Before a draft goes: its snapped photos are released, the reports it was ordering go back to open, questions go too.
create or replace function public.requests_before_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.receipt_inbox set filed_request_id = null, status = 'discarded' where filed_request_id = old.id;
  update public.stock_reports set request_id = null where request_id = old.id;
  delete from public.request_messages where request_id = old.id;
  return old;
end $$;
revoke execute on function public.requests_before_delete() from public, anon, authenticated;
drop trigger if exists requests_before_delete on public.requests;
create trigger requests_before_delete before delete on public.requests for each row execute function public.requests_before_delete();

-- 4. Items are catalogue: the real stock manager or approver only, never a stand-in (same as suppliers and categories).
alter policy items_write on public.items
  using (public.my_role() in ('stock_manager', 'approver')) with check (public.my_role() in ('stock_manager', 'approver'));

-- 5. Scheduled jobs and internals must not be callable by signed-in people (anyone could have sent reminders to everyone).
revoke execute on function public.remind_stale_items() from public, anon, authenticated;
revoke execute on function public.weekly_digest() from public, anon, authenticated;
revoke execute on function public.remind_month_close() from public, anon, authenticated;
revoke execute on function public.remind_weekly_count() from public, anon, authenticated;
revoke execute on function public.remind_outstanding_advances() from public, anon, authenticated;
revoke execute on function public.profile_history(uuid) from public, anon, authenticated;
revoke execute on function public.notifications_push_trigger() from public, anon, authenticated;
revoke execute on function public.requests_stock_guard() from public, anon, authenticated;
revoke execute on function public.stock_reports_on_receipt() from public, anon, authenticated;

-- 6. Deleting an unused account must not trip over its own diagnostics, a person budget or invitations it sent.
alter table public.client_logs drop constraint if exists client_logs_user_id_fkey;
alter table public.client_logs add constraint client_logs_user_id_fkey foreign key (user_id) references public.profiles(id) on delete set null;
alter table public.budgets drop constraint if exists budgets_person_id_fkey;
alter table public.budgets add constraint budgets_person_id_fkey foreign key (person_id) references public.profiles(id) on delete cascade;
alter table public.invitations drop constraint if exists invitations_invited_by_fkey;
alter table public.invitations add constraint invitations_invited_by_fkey foreign key (invited_by) references public.profiles(id) on delete set null;
