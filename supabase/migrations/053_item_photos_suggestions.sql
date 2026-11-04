-- 053: pictures on stock items, and suggesting a new item for the store.
--   • Each item can carry up to 3 photos (items.photos: paths in the private "item-photos" store). The stock controller
--     and the GM add them; everyone signed in sees them. Optional, but the screens ask for one.
--   • Anyone can suggest an item for the store with a reason (suggest_item). The stock controller checks it, then the
--     GM gives the final approval (review_item_suggestion). The GM's own suggestion needs only the stock controller;
--     the stock controller's own goes straight to the GM. Nobody approves their own. Approved: the item is added to the
--     catalogue (with the suggestion's photo); the stock controller then sets the reorder level and supplier.
--   • The person who suggested it is told at each step; declined suggestions stay visible with the reason.

-- ---------- photos ----------
alter table public.items add column if not exists photos text[] not null default '{}';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'items_photos_max3') then
    alter table public.items add constraint items_photos_max3 check (coalesce(array_length(photos, 1), 0) <= 3);
  end if;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-photos', 'item-photos', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'item_photos_read') then
    create policy item_photos_read on storage.objects for select to authenticated using (bucket_id = 'item-photos' and public.my_role() is not null);
  end if;
  -- the stock controller and the GM add item photos; anyone adds a photo to their own suggestion (suggestions/<their id>/…)
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'item_photos_insert') then
    create policy item_photos_insert on storage.objects for insert to authenticated with check (bucket_id = 'item-photos' and (
      public.my_role() in ('stock_manager', 'approver') or name like 'suggestions/' || auth.uid()::text || '/%'));
  end if;
end $$;

-- ---------- suggestions ----------
create or replace function public.person_name(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select coalesce(nullif(btrim(full_name), ''), email) from public.profiles where id = p_user), 'Someone')
$$;
revoke execute on function public.person_name(uuid) from public, anon;
grant execute on function public.person_name(uuid) to authenticated;

create table if not exists public.item_suggestions (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references public.branches(id),
  name text not null check (length(btrim(name)) >= 2),
  reason text not null check (length(btrim(reason)) >= 20),
  monthly_qty numeric(12,2),
  est_price numeric(12,2),
  where_to_buy text,
  photo_path text,
  category_id uuid references public.categories(id),
  suggested_by uuid not null references public.profiles(id),
  suggested_role public.user_role not null,
  created_at timestamptz not null default now(),
  status text not null default 'with_stock' check (status in ('with_stock', 'with_gm', 'approved', 'declined', 'withdrawn')),
  stock_by uuid references public.profiles(id), stock_at timestamptz, stock_note text,
  gm_by uuid references public.profiles(id), gm_at timestamptz, gm_note text,
  item_id uuid references public.items(id)
);
create index if not exists item_suggestions_branch on public.item_suggestions (branch_id, status);
alter table public.item_suggestions enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'item_suggestions' and policyname = 'item_suggestions_read') then
    create policy item_suggestions_read on public.item_suggestions for select to authenticated using (branch_id = any(public.my_branches()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'item_suggestions' and policyname = 'two_step_required') then
    create policy two_step_required on public.item_suggestions as restrictive for all to authenticated using (not (select public.two_step_blocked())) with check (not (select public.two_step_blocked()));
  end if;
end $$;
create or replace trigger item_suggestions_branch_default before insert on public.item_suggestions for each row execute function public.branch_default();
grant select on public.item_suggestions to authenticated;

-- suggest: the reason is required; an item already in the store, or already suggested and still open, is refused
create or replace function public.suggest_item(p_name text, p_reason text, p_monthly_qty numeric default null, p_price numeric default null,
                                               p_where text default null, p_photo text default null, p_category uuid default null)
returns public.item_suggestions language plpgsql security definer set search_path = public as $$
declare v_role public.user_role := public.my_role(); v_name text := btrim(coalesce(p_name, '')); v_branch uuid := public.my_branch();
        it public.items%rowtype; o public.item_suggestions%rowtype; s public.item_suggestions%rowtype; v_who text;
begin
  if v_role is null then raise exception 'Sign in first'; end if;
  if length(v_name) < 2 then raise exception 'Say what the item is'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 20 then raise exception 'Say why the store should keep it (a full sentence)'; end if;
  if p_monthly_qty is not null and p_monthly_qty <= 0 then raise exception 'How many a month: a number above 0, or leave it empty'; end if;
  if p_price is not null and p_price < 0 then raise exception 'The price cannot be negative'; end if;
  if p_photo is not null and p_photo not like 'suggestions/' || auth.uid()::text || '/%' then raise exception 'Upload the photo again'; end if;
  select * into it from public.items where lower(name) = lower(v_name) and active and branch_id = v_branch limit 1;
  if it.id is not null then raise exception 'Already in the store: %', it.name; end if;
  select * into o from public.item_suggestions where lower(name) = lower(v_name) and branch_id = v_branch and status in ('with_stock', 'with_gm') limit 1;
  if o.id is not null then raise exception 'Already suggested by % on % – it is waiting for %', public.person_name(o.suggested_by), to_char(o.created_at at time zone public.app_tz(), 'FMDD Mon'),
    case o.status when 'with_stock' then 'the stock controller' else 'the GM' end; end if;
  insert into public.item_suggestions (branch_id, name, reason, monthly_qty, est_price, where_to_buy, photo_path, category_id, suggested_by, suggested_role, status,
                                       stock_by, stock_at, stock_note)
  values (v_branch, left(v_name, 80), btrim(p_reason), p_monthly_qty, p_price, nullif(btrim(coalesce(p_where, '')), ''), p_photo,
          (select id from public.categories where id = p_category and kind <> 'cash'), auth.uid(), v_role,
          case when v_role = 'stock_manager' then 'with_gm' else 'with_stock' end,
          case when v_role = 'stock_manager' then auth.uid() end, case when v_role = 'stock_manager' then now() end,
          case when v_role = 'stock_manager' then 'Suggested by the stock controller' end)
  returning * into s;
  v_who := public.person_name(auth.uid());
  if s.status = 'with_stock' then
    perform public.notify_branch_role(s.branch_id, 'stock_manager', 'stock_suggestion', 'Item suggested for the store: ' || s.name, v_who || ': ' || s.reason, '#/stock/suggestions', null);
  else
    perform public.notify_branch_role(s.branch_id, 'approver', 'stock_suggestion', 'Item suggested for the store: ' || s.name, v_who || ': ' || s.reason, '#/stock/suggestions', null);
  end if;
  return s;
end $$;
revoke execute on function public.suggest_item(text, text, numeric, numeric, text, text, uuid) from public, anon;
grant execute on function public.suggest_item(text, text, numeric, numeric, text, text, uuid) to authenticated;

-- review: the stock controller first, then the GM; declining needs a reason; approved adds the item to the catalogue
create or replace function public.review_item_suggestion(p_id uuid, p_ok boolean, p_note text default null)
returns public.item_suggestions language plpgsql security definer set search_path = public as $$
declare s public.item_suggestions%rowtype; it public.items%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_final boolean;
begin
  select * into s from public.item_suggestions where id = p_id for update;
  if s.id is null then raise exception 'Suggestion not found'; end if;
  if s.status not in ('with_stock', 'with_gm') then raise exception 'This suggestion has already been decided'; end if;
  if s.suggested_by = auth.uid() then raise exception 'You cannot approve or decline your own suggestion'; end if;
  if not p_ok and length(coalesce(v_note, '')) < 3 then raise exception 'Say why it is declined – the person who suggested it sees your reason'; end if;
  if s.status = 'with_stock' then
    if not public.has_role('stock_manager') then raise exception 'The stock controller checks suggestions first'; end if;
    update public.item_suggestions set stock_by = auth.uid(), stock_at = now(), stock_note = v_note where id = p_id;
    v_final := s.suggested_role = 'approver';   -- the GM suggested it: the stock controller's yes is the last step
  else
    if not public.has_role('approver') then raise exception 'The GM gives the final approval'; end if;
    update public.item_suggestions set gm_by = auth.uid(), gm_at = now(), gm_note = v_note where id = p_id;
    v_final := true;
  end if;
  if not p_ok then
    update public.item_suggestions set status = 'declined' where id = p_id returning * into s;
    perform public.notify_user(s.suggested_by, 'stock_suggestion', 'Not added to the store: ' || s.name, v_note, '#/stock/suggestions', null);
    return s;
  end if;
  if not v_final then
    update public.item_suggestions set status = 'with_gm' where id = p_id returning * into s;
    perform public.notify_branch_role(s.branch_id, 'approver', 'stock_suggestion', 'Item suggested for the store: ' || s.name,
      public.person_name(s.suggested_by) || ': ' || s.reason || '. The stock controller agrees' || coalesce(' – ' || v_note, '') || '.', '#/stock/suggestions', null);
    perform public.notify_user(s.suggested_by, 'stock_suggestion', 'Your suggestion went to the GM: ' || s.name, 'The stock controller agreed' || coalesce(': ' || v_note, '.'), '#/stock/suggestions', null);
    return s;
  end if;
  -- approved: into the catalogue (an old inactive item of the same name is switched back on instead)
  select * into it from public.items where lower(name) = lower(s.name) and branch_id = s.branch_id limit 1;
  if it.id is null then
    insert into public.items (name, unit, category_id, branch_id, active, expected_monthly_qty, last_unit_price, suggested_by, suggested_at, photos)
    values (s.name, 'each', (select id from public.categories where id = s.category_id and kind <> 'cash'), s.branch_id, true, coalesce(s.monthly_qty, 0), s.est_price,
            s.suggested_by, s.created_at, case when s.photo_path is not null then array[s.photo_path] else '{}' end)
    returning * into it;
  else
    update public.items set active = true, photos = case when coalesce(array_length(photos, 1), 0) = 0 and s.photo_path is not null then array[s.photo_path] else photos end
     where id = it.id returning * into it;
  end if;
  update public.item_suggestions set status = 'approved', item_id = it.id where id = p_id returning * into s;
  perform public.notify_user(s.suggested_by, 'stock_suggestion', 'Added to the store: ' || s.name, 'Approved. The stock controller orders it with the next restock.', '#/stock', null);
  perform public.notify_branch_role(s.branch_id, 'stock_manager', 'stock_suggestion', 'New item in the catalogue: ' || s.name,
    'Approved. Set its unit, reorder level and supplier under Stock → Items, then order it with the next restock.', '#/stock', null);
  return s;
end $$;
revoke execute on function public.review_item_suggestion(uuid, boolean, text) from public, anon;
grant execute on function public.review_item_suggestion(uuid, boolean, text) to authenticated;

-- the person who suggested it can withdraw it while it is still waiting
create or replace function public.withdraw_item_suggestion(p_id uuid) returns public.item_suggestions
language plpgsql security definer set search_path = public as $$
declare s public.item_suggestions%rowtype;
begin
  select * into s from public.item_suggestions where id = p_id for update;
  if s.id is null or s.suggested_by <> auth.uid() then raise exception 'Only the person who suggested it can withdraw it'; end if;
  if s.status not in ('with_stock', 'with_gm') then raise exception 'This suggestion has already been decided'; end if;
  update public.item_suggestions set status = 'withdrawn' where id = p_id returning * into s;
  return s;
end $$;
revoke execute on function public.withdraw_item_suggestion(uuid) from public, anon;
grant execute on function public.withdraw_item_suggestion(uuid) to authenticated;

-- item photos go to Tuvana Tech's off-site copy with the receipts, packs and logo
do $$
declare d text := pg_get_functiondef('public.offsite_pending(timestamptz, int)'::regprocedure); n text;
begin
  n := replace(d, 'o.bucket_id in (''proofs'', ''packs'', ''branding'')', 'o.bucket_id in (''proofs'', ''packs'', ''branding'', ''item-photos'')');
  if n = d and position('item-photos' in d) = 0 then raise exception '053: offsite_pending is not as expected'; end if;
  if n <> d then execute n; end if;
end $$;
