-- Petty cash & stock management: core schema
-- Roles: requester, stock_manager, finance, approver (approver is also the admin)

create extension if not exists pgcrypto;

create type public.user_role as enum ('requester','stock_manager','finance','approver');
create type public.request_type as enum ('stock','cash');
create type public.request_status as enum (
  'draft','stock_review','pending_approval','awaiting_disbursement','disbursed',
  'proof_review','physical_required','closed','fulfilled_from_stock','rejected','cancelled'
);
create type public.movement_kind as enum ('purchase_in','issue_out','adjustment','count','reversal');
create type public.float_tx_kind as enum ('allocation','top_up','carry_over','return');
create type public.proof_status as enum ('pending','returned','physical_required','confirmed');

-- ---------- people & settings ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  role public.user_role not null default 'requester',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  full_name text not null default '',
  role public.user_role not null default 'requester',
  invited_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);
create index on public.invitations (lower(email));

create table public.settings (
  id int primary key default 1 check (id = 1),
  org_name text not null default 'Petty Cash & Stock',
  currency text not null default 'N$',
  approval_threshold numeric(12,2) not null default 200,
  default_monthly_float numeric(12,2) not null default 0,
  float_rollover boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1);

-- ---------- catalogue ----------
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kind text not null default 'both' check (kind in ('stock','cash','both')),
  active boolean not null default true
);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  contact text,
  notes text,
  active boolean not null default true
);

create table public.items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sku text,
  category_id uuid references public.categories(id),
  unit text not null default 'each',
  pack_note text,
  recurring boolean not null default false,
  expected_monthly_qty numeric(12,2) not null default 0,
  reorder_level numeric(12,2) not null default 0,
  qty_on_hand numeric(12,2) not null default 0,
  last_unit_price numeric(12,2),
  preferred_supplier_id uuid references public.suppliers(id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index items_name_uq on public.items (lower(name));

-- ---------- petty cash float ----------
create table public.floats (
  id uuid primary key default gen_random_uuid(),
  period date not null unique,            -- first day of the month
  opening_amount numeric(12,2) not null default 0,
  status text not null default 'open' check (status in ('open','closed')),
  opened_by uuid references public.profiles(id),
  opened_at timestamptz not null default now(),
  closed_by uuid references public.profiles(id),
  closed_at timestamptz,
  counted_cash numeric(12,2),
  notes text
);

create table public.float_transactions (
  id uuid primary key default gen_random_uuid(),
  float_id uuid not null references public.floats(id) on delete cascade,
  kind public.float_tx_kind not null,
  amount numeric(12,2) not null check (amount >= 0),
  created_by uuid references public.profiles(id),
  note text,
  created_at timestamptz not null default now()
);

-- ---------- requests ----------
create sequence public.request_no_seq start 1001;

create table public.requests (
  id uuid primary key default gen_random_uuid(),
  request_no int not null default nextval('public.request_no_seq'),
  type public.request_type not null,
  requester_id uuid not null references public.profiles(id),
  purpose text not null default '',
  needed_by date,
  for_store boolean not null default false,
  status public.request_status not null default 'draft',
  estimated_total numeric(12,2) not null default 0,
  approval_required boolean not null default false,
  submitted_at timestamptz,
  stock_reviewed_by uuid references public.profiles(id),
  stock_reviewed_at timestamptz,
  stock_note text,
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  approval_note text,
  rejected_by uuid references public.profiles(id),
  rejected_at timestamptz,
  rejection_reason text,
  disbursed_by uuid references public.profiles(id),
  disbursed_at timestamptz,
  disbursed_amount numeric(12,2),
  disbursed_to uuid references public.profiles(id),
  float_id uuid references public.floats(id),
  closed_by uuid references public.profiles(id),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.requests (requester_id);
create index on public.requests (status);
create index on public.requests (float_id);

create table public.request_lines (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  line_no int not null default 1,
  item_id uuid references public.items(id),
  description text not null default '',
  qty numeric(12,2) not null check (qty > 0),
  est_unit_price numeric(12,2) not null default 0,
  qty_from_stock numeric(12,2) not null default 0,
  qty_to_buy numeric(12,2)
);
create index on public.request_lines (request_id);

create table public.request_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  actor_id uuid references public.profiles(id),
  action text not null,
  from_status public.request_status,
  to_status public.request_status,
  note text,
  created_at timestamptz not null default now()
);
create index on public.request_events (request_id);

-- ---------- spend & proof ----------
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.requests(id) on delete cascade,
  spent_by uuid not null references public.profiles(id),
  spent_at date not null default current_date,
  total numeric(12,2) not null default 0,
  change_returned numeric(12,2) not null default 0,
  proof_status public.proof_status not null default 'pending',
  notes text,
  finance_note text,
  physical_required_by uuid references public.profiles(id),
  physical_required_at timestamptz,
  physical_received_by uuid references public.profiles(id),
  physical_received_at timestamptz,
  confirmed_by uuid references public.profiles(id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.expense_lines (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete cascade,
  item_id uuid references public.items(id),
  description text not null default '',
  qty numeric(12,2) not null check (qty > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  line_total numeric(12,2) generated always as (round(qty * unit_price, 2)) stored,
  supplier_id uuid references public.suppliers(id),
  supplier_name text
);
create index on public.expense_lines (expense_id);
create index on public.expense_lines (item_id);

create table public.expense_proofs (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime text,
  uploaded_by uuid references public.profiles(id),
  uploaded_at timestamptz not null default now()
);
create index on public.expense_proofs (expense_id);

-- ---------- stock movements ----------
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id),
  kind public.movement_kind not null,
  delta numeric(12,2) not null,                 -- signed change to qty_on_hand
  unit_cost numeric(12,2),
  request_id uuid references public.requests(id) on delete set null,
  expense_id uuid references public.expenses(id) on delete set null,
  issued_to uuid references public.profiles(id),
  created_by uuid references public.profiles(id),
  note text,
  created_at timestamptz not null default now()
);
create index on public.stock_movements (item_id, created_at);
create index on public.stock_movements (expense_id);

-- ---------- triggers ----------
create or replace function public.apply_stock_movement() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.items set qty_on_hand = qty_on_hand + new.delta where id = new.item_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.items set qty_on_hand = qty_on_hand - old.delta where id = old.item_id;
    return old;
  end if;
  return null;
end $$;
create trigger stock_movements_apply
  after insert or delete on public.stock_movements
  for each row execute function public.apply_stock_movement();

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger requests_touch before update on public.requests
  for each row execute function public.touch_updated_at();

-- First user becomes the approver/admin; after that, sign-up only through an
-- admin-created account (app_metadata.invited) or a matching invitation row.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_role public.user_role;
  v_name text;
  v_inv public.invitations%rowtype;
begin
  select count(*) into v_count from public.profiles;
  v_name := coalesce(new.raw_user_meta_data->>'full_name', '');
  if v_count = 0 then
    v_role := 'approver';
  elsif coalesce((new.raw_app_meta_data->>'invited')::boolean, false) then
    v_role := coalesce((new.raw_app_meta_data->>'role')::public.user_role, 'requester');
  else
    select * into v_inv from public.invitations
      where lower(email) = lower(coalesce(new.email,'')) and accepted_at is null
      order by created_at desc limit 1;
    if v_inv.id is null then
      raise exception 'Sign-up is by invitation only. Ask your administrator to add you.';
    end if;
    v_role := v_inv.role;
    if v_name = '' then v_name := v_inv.full_name; end if;
    update public.invitations set accepted_at = now() where id = v_inv.id;
  end if;
  insert into public.profiles (id, email, full_name, role)
  values (new.id, coalesce(new.email,''), v_name, v_role);
  return new;
end $$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- role helpers ----------
create or replace function public.my_role() returns public.user_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function public.is_staff() returns boolean
language sql stable as $$
  select public.my_role() in ('stock_manager','finance','approver')
$$;

create or replace function public.can_view_request(p_request uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.requests r
    where r.id = p_request and (
      r.requester_id = auth.uid()
      or r.disbursed_to = auth.uid()
      or public.my_role() in ('finance','approver')
      or (public.my_role() = 'stock_manager' and r.type = 'stock')
    )
  )
$$;

create or replace function public.threshold() returns numeric
language sql stable as $$ select approval_threshold from public.settings where id = 1 $$;

-- ---------- row level security ----------
alter table public.profiles enable row level security;
alter table public.invitations enable row level security;
alter table public.settings enable row level security;
alter table public.categories enable row level security;
alter table public.suppliers enable row level security;
alter table public.items enable row level security;
alter table public.floats enable row level security;
alter table public.float_transactions enable row level security;
alter table public.requests enable row level security;
alter table public.request_lines enable row level security;
alter table public.request_events enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_lines enable row level security;
alter table public.expense_proofs enable row level security;
alter table public.stock_movements enable row level security;

-- profiles
create policy profiles_select on public.profiles for select to authenticated using (true);
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and role = (select role from public.profiles p where p.id = auth.uid()) and active = (select active from public.profiles p where p.id = auth.uid()));
create policy profiles_update_admin on public.profiles for update to authenticated
  using (public.my_role() = 'approver') with check (public.my_role() = 'approver');

-- invitations
create policy invitations_admin on public.invitations for all to authenticated
  using (public.my_role() = 'approver') with check (public.my_role() = 'approver');

-- settings
create policy settings_select on public.settings for select to authenticated using (true);
create policy settings_update on public.settings for update to authenticated
  using (public.my_role() = 'approver') with check (public.my_role() = 'approver');

-- catalogue (everyone reads; stock manager / approver / finance maintain)
create policy categories_select on public.categories for select to authenticated using (true);
create policy categories_write on public.categories for all to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy suppliers_select on public.suppliers for select to authenticated using (true);
create policy suppliers_write on public.suppliers for all to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy items_select on public.items for select to authenticated using (true);
create policy items_write on public.items for all to authenticated
  using (public.my_role() in ('stock_manager','approver')) with check (public.my_role() in ('stock_manager','approver'));

-- float: staff only, writes via functions
create policy floats_select on public.floats for select to authenticated using (public.is_staff());
create policy float_tx_select on public.float_transactions for select to authenticated using (public.is_staff());

-- requests
create policy requests_select on public.requests for select to authenticated
  using (public.can_view_request(id));
create policy requests_insert on public.requests for insert to authenticated
  with check (requester_id = auth.uid() and status = 'draft' and (for_store = false or public.my_role() in ('stock_manager','approver')));
create policy requests_update_draft on public.requests for update to authenticated
  using (requester_id = auth.uid() and status = 'draft')
  with check (requester_id = auth.uid() and status = 'draft');

create policy request_lines_select on public.request_lines for select to authenticated
  using (public.can_view_request(request_id));
create policy request_lines_write on public.request_lines for all to authenticated
  using (exists (select 1 from public.requests r where r.id = request_id and r.requester_id = auth.uid() and r.status = 'draft'))
  with check (exists (select 1 from public.requests r where r.id = request_id and r.requester_id = auth.uid() and r.status = 'draft'));

create policy request_events_select on public.request_events for select to authenticated
  using (public.can_view_request(request_id));

-- expenses & proofs
create policy expenses_select on public.expenses for select to authenticated
  using (public.can_view_request(request_id));
create policy expense_lines_select on public.expense_lines for select to authenticated
  using (exists (select 1 from public.expenses e where e.id = expense_id and public.can_view_request(e.request_id)));
create policy expense_proofs_select on public.expense_proofs for select to authenticated
  using (exists (select 1 from public.expenses e where e.id = expense_id and public.can_view_request(e.request_id)));
create policy expense_proofs_insert on public.expense_proofs for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and exists (
      select 1 from public.expenses e join public.requests r on r.id = e.request_id
      where e.id = expense_id and public.can_view_request(r.id)
        and r.status in ('disbursed','proof_review','physical_required')
    )
  );
create policy expense_proofs_delete on public.expense_proofs for delete to authenticated
  using (uploaded_by = auth.uid() and exists (
    select 1 from public.expenses e where e.id = expense_id and e.proof_status in ('pending','returned')));

-- stock movements: everyone can read (stock levels are not secret), writes via functions
create policy stock_movements_select on public.stock_movements for select to authenticated using (true);
