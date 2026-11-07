-- 057: cash hand-outs that fit real errands (Nov 2026).
--  1. A request says whether the price is known ("I know the price") or a rough estimate.
--  2. Finance is told how much cash to hand out: the price plus a margin, rounded up to a note, learnt from what that
--     supplier's receipts came to before (suggest_cash). The GM sets the standard margin and rounding (Schedule).
--  3. Counts list the notes and coins (cash_counts.denominations).
--  4. Hand out together: one amount to one person for several approved requests (anyone's, same branch), split per
--     request; the others are told who is buying for them and tap "Received" when they have the item.
--  5. Cash with a person: what they hold across requests, the change to hand back, what is owed to them; finance takes
--     all the change back at once (return_change) and differences are flagged.
--  6. Price went up: the holder asks for more before buying (to whoever approves that amount); finance hands out the
--     difference (top_up_request) or, if the person paid it themselves, pays it back (pay_difference).
--  7. A supplier book that fills itself from receipts, quotes and invoices, with their details and bank account; an
--     invoice whose bank details differ from the ones on file is flagged before paying.

/* ---------- settings, columns ---------- */
alter table public.settings
  add column if not exists cash_margin_pct numeric not null default 10 check (cash_margin_pct between 0 and 50),
  add column if not exists cash_round_to numeric not null default 10 check (cash_round_to in (1, 5, 10, 20, 50, 100));
alter table public.requests
  add column if not exists price_known boolean not null default false,
  add column if not exists handout_id uuid,
  add column if not exists goods_received_at timestamptz,
  add column if not exists goods_received_by uuid references public.profiles(id),
  add column if not exists price_rise jsonb;
alter table public.expenses
  add column if not exists supplier_id uuid,
  add column if not exists change_back_at timestamptz,
  add column if not exists change_back_by uuid references public.profiles(id),
  add column if not exists change_back_id uuid,
  add column if not exists difference_paid_at timestamptz,
  add column if not exists difference_paid_by uuid references public.profiles(id);
alter table public.cash_counts add column if not exists denominations jsonb;
alter table public.request_documents add column if not exists supplier_id uuid;

/* ---------- the supplier book ---------- */
alter table public.suppliers
  add column if not exists aliases text[] not null default '{}',
  add column if not exists vat_no text,
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists address text,
  add column if not exists bank jsonb,
  add column if not exists bank_confirmed_by uuid references public.profiles(id),
  add column if not exists bank_confirmed_at timestamptz,
  add column if not exists status text not null default 'confirmed',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists merged_into uuid references public.suppliers(id);
do $$ begin
  alter table public.suppliers add constraint suppliers_status_check check (status in ('suggested', 'confirmed'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.expenses add constraint expenses_supplier_fk foreign key (supplier_id) references public.suppliers(id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.request_documents add constraint request_documents_supplier_fk foreign key (supplier_id) references public.suppliers(id) on delete set null;
exception when duplicate_object then null; end $$;

/* a shop's name without the legal words, for matching ("Econo Foods Namibia CC t/a perfectwater WestLane" ~ "Perfectwater") */
create or replace function public.supplier_key(p text) returns text language sql immutable as $$
  select btrim(regexp_replace(regexp_replace(lower(coalesce(p, '')),
    '\m(pty|ltd|cc|t/a|ta|trading as|namibia|nam|limited|inc|the|store|stores|shop|branch)\M|[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g'))
$$;
/* the trading name: after "t/a" if there is one, else the name */
create or replace function public.supplier_display(p text) returns text language sql immutable as $$
  select public.tidy_text(initcap(coalesce(nullif(btrim(substring(p from '(?i)t/a\s+(.*)$')), ''), p)))
$$;

/* The supplier for a name read or typed on a document: an existing one (by name, alias or likeness), else a new one to confirm. */
create or replace function public.supplier_for(p_name text, p_doc jsonb default null) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_key text := public.supplier_key(p_name); v_id uuid; v_bank jsonb := nullif(p_doc->'bank', 'null'::jsonb);
begin
  if v_key = '' or length(v_key) < 3 then return null; end if;
  select s.id into v_id from public.suppliers s
   where s.merged_into is null and (public.supplier_key(s.name) = v_key or v_key = any(select public.supplier_key(a) from unnest(s.aliases) a)
          or extensions.similarity(public.supplier_key(s.name), v_key) >= 0.55
          or extensions.word_similarity(public.supplier_key(s.name), v_key) >= 0.8)
   order by (public.supplier_key(s.name) = v_key) desc, extensions.similarity(public.supplier_key(s.name), v_key) desc limit 1;
  if v_id is null then
    insert into public.suppliers (name, aliases, status, phone, email, vat_no, address, bank)
    values (public.supplier_display(p_name), array[p_name], 'suggested', p_doc->>'phone', p_doc->>'email', p_doc->>'vat_no', p_doc->>'address',
            case when v_bank is not null and coalesce(v_bank->>'account', v_bank->>'account_number', '') <> '' then v_bank end)
    returning id into v_id;
  else
    update public.suppliers set
      aliases = case when p_name = any(aliases) or lower(p_name) = lower(name) then aliases else aliases || p_name end,
      phone = coalesce(phone, p_doc->>'phone'), email = coalesce(email, p_doc->>'email'), vat_no = coalesce(vat_no, p_doc->>'vat_no'), address = coalesce(address, p_doc->>'address'),
      bank = coalesce(bank, case when v_bank is not null and coalesce(v_bank->>'account', v_bank->>'account_number', '') <> '' then v_bank end)
     where id = v_id;
  end if;
  return v_id;
end $$;

/* every read receipt, quote and invoice is linked to its supplier */
create or replace function public.link_proof_supplier() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.extracted ? 'supplier' and coalesce(new.extracted->>'supplier', '') <> '' then
    update public.expenses set supplier_id = public.supplier_for(new.extracted->>'supplier', new.extracted)
     where id = new.expense_id and supplier_id is null;
  end if;
  return new;
end $$;
create or replace trigger expense_proofs_supplier after insert or update of extracted on public.expense_proofs for each row execute function public.link_proof_supplier();
create or replace function public.link_doc_supplier() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.supplier_id is null and new.extracted ? 'supplier' and coalesce(new.extracted->>'supplier', '') <> '' then
    new.supplier_id := public.supplier_for(new.extracted->>'supplier', new.extracted);
  end if;
  return new;
end $$;
create or replace trigger request_documents_supplier before insert or update of extracted on public.request_documents for each row execute function public.link_doc_supplier();
create or replace function public.link_expense_supplier() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.supplier_id is null and coalesce(btrim(new.supplier_name), '') <> '' then new.supplier_id := public.supplier_for(new.supplier_name, null); end if;
  return new;
end $$;
create or replace trigger expenses_supplier before insert or update of supplier_name on public.expenses for each row execute function public.link_expense_supplier();

/* finance or the stock controller: confirm a suggested supplier, edit details, or merge two that are the same shop */
create or replace function public.save_supplier(p_id uuid, p_values jsonb) returns public.suppliers
language plpgsql security definer set search_path = public as $$
declare s public.suppliers%rowtype; v_bank_changed boolean;
begin
  if not (public.has_role('finance') or public.has_role('approver') or public.has_role('stock_manager')) then raise exception 'Only finance, the GM or the stock controller keep the supplier book'; end if;
  select * into s from public.suppliers where id = p_id for update;
  if s.id is null then raise exception 'Supplier not found'; end if;
  v_bank_changed := p_values ? 'bank' and (p_values->'bank') is distinct from s.bank;
  update public.suppliers set
    name = coalesce(nullif(btrim(p_values->>'name'), ''), name), contact = case when p_values ? 'contact' then nullif(btrim(p_values->>'contact'), '') else contact end,
    phone = case when p_values ? 'phone' then nullif(btrim(p_values->>'phone'), '') else phone end,
    email = case when p_values ? 'email' then nullif(btrim(p_values->>'email'), '') else email end,
    vat_no = case when p_values ? 'vat_no' then nullif(btrim(p_values->>'vat_no'), '') else vat_no end,
    address = case when p_values ? 'address' then nullif(btrim(p_values->>'address'), '') else address end,
    notes = case when p_values ? 'notes' then nullif(btrim(p_values->>'notes'), '') else notes end,
    bank = case when p_values ? 'bank' then nullif(p_values->'bank', 'null'::jsonb) else bank end,
    bank_confirmed_by = case when v_bank_changed or (p_values->>'confirm_bank')::boolean then auth.uid() else bank_confirmed_by end,
    bank_confirmed_at = case when v_bank_changed or (p_values->>'confirm_bank')::boolean then now() else bank_confirmed_at end,
    status = 'confirmed'
   where id = p_id returning * into s;
  if v_bank_changed then
    perform public.notify_role('approver', 'security', 'Supplier bank details changed: ' || s.name, public.person_name(auth.uid()) || ' changed the bank account on file for ' || s.name || '. Check it was expected.', '#/stock/suppliers', null);
  end if;
  return s;
end $$;
create or replace function public.merge_suppliers(p_keep uuid, p_into_keep uuid) returns public.suppliers
language plpgsql security definer set search_path = public as $$
declare k public.suppliers%rowtype; d public.suppliers%rowtype;
begin
  if not (public.has_role('finance') or public.has_role('approver') or public.has_role('stock_manager')) then raise exception 'Only finance, the GM or the stock controller keep the supplier book'; end if;
  if p_keep = p_into_keep then raise exception 'Choose two different suppliers'; end if;
  select * into k from public.suppliers where id = p_keep for update; select * into d from public.suppliers where id = p_into_keep for update;
  if k.id is null or d.id is null then raise exception 'Supplier not found'; end if;
  update public.expenses set supplier_id = k.id where supplier_id = d.id;
  update public.request_documents set supplier_id = k.id where supplier_id = d.id;
  update public.expense_lines set supplier_id = k.id where supplier_id = d.id;
  update public.items set preferred_supplier_id = k.id where preferred_supplier_id = d.id;
  update public.suppliers set aliases = (select array_agg(distinct a) from unnest(k.aliases || d.aliases || d.name) a),
         phone = coalesce(phone, d.phone), email = coalesce(email, d.email), vat_no = coalesce(vat_no, d.vat_no), address = coalesce(address, d.address), bank = coalesce(bank, d.bank)
   where id = k.id returning * into k;
  update public.suppliers set merged_into = k.id, active = false where id = d.id;
  return k;
end $$;

/* Bank details on an invoice against the supplier's on file: "differs" is a warning before paying. */
create or replace function public.supplier_bank_check(p_doc uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d public.request_documents%rowtype; s public.suppliers%rowtype; a text; b text;
begin
  select * into d from public.request_documents where id = p_doc;
  if d.id is null or not public.can_view_request(d.request_id) then raise exception 'Not allowed'; end if;
  select * into s from public.suppliers where id = d.supplier_id;
  if s.id is null then return jsonb_build_object('known', false); end if;
  a := regexp_replace(coalesce(d.extracted->'bank'->>'account', d.extracted->'bank'->>'account_number', ''), '\D', '', 'g');
  b := regexp_replace(coalesce(s.bank->>'account', s.bank->>'account_number', ''), '\D', '', 'g');
  return jsonb_build_object('known', b <> '', 'supplier', s.name, 'supplier_id', s.id, 'on_file', s.bank, 'confirmed', s.bank_confirmed_at is not null,
    'differs', a <> '' and b <> '' and a <> b, 'first_time', a <> '' and b = '');
end $$;

/* The supplier book with what was bought: spent this month and year, last used, how receipts compare with estimates. */
create or replace function public.supplier_book() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by (x->>'status') = 'confirmed', x->>'name'), '[]'::jsonb) from (
    select jsonb_build_object('id', s.id, 'name', s.name, 'status', s.status, 'active', s.active, 'contact', s.contact, 'notes', s.notes, 'aliases', s.aliases,
             'phone', s.phone, 'email', s.email, 'vat_no', s.vat_no, 'address', s.address, 'bank', s.bank, 'bank_confirmed', s.bank_confirmed_at is not null,
             'receipts', count(e.id), 'last_used', max(e.spent_at),
             'month', coalesce(sum(e.total) filter (where e.spent_at >= date_trunc('month', current_date)), 0),
             'year', coalesce(sum(e.total) filter (where e.spent_at >= date_trunc('year', current_date)), 0),
             'gap_pct', round(avg(e.total / nullif(q.estimated_total, 0) - 1) filter (where q.type <> 'claim' and q.estimated_total > 0) * 100)) x
      from public.suppliers s
      left join public.expenses e on e.supplier_id = s.id and e.total > 0
      left join public.requests q on q.id = e.request_id and q.status not in ('rejected', 'cancelled')
     where s.merged_into is null and (public.is_staff() or public.has_role('stock_manager'))
     group by s.id) t
$$;

/* ---------- what that supplier's receipts came to before, and the cash to hand out ---------- */
create or replace function public.request_supplier(p_request uuid) returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select d.supplier_id from public.request_documents d where d.request_id = p_request and d.supplier_id is not null order by d.created_at desc limit 1),
    (select e.supplier_id from public.expenses e where e.request_id = p_request and e.supplier_id is not null),
    (select i.preferred_supplier_id from public.request_lines rl join public.items i on i.id = rl.item_id where rl.request_id = p_request and i.preferred_supplier_id is not null limit 1))
$$;

create or replace function public.suggest_cash(p_request uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r public.requests%rowtype; st public.settings%rowtype; v_sup uuid; v_name text; v_n int; v_avg numeric; v_max numeric; v_margin numeric; v_amt numeric; v_cap numeric;
        v_why text; v_base numeric; v_last numeric; v_item text; v_coins boolean; v_trend numeric;
begin
  select * into r from public.requests where id = p_request;
  if r.id is null or not public.can_view_request(p_request) then raise exception 'Not allowed'; end if;
  select * into st from public.settings where id = 1;
  v_base := coalesce(r.estimated_total, 0);
  if v_base <= 0 then return null; end if;
  v_sup := public.request_supplier(p_request);
  select name into v_name from public.suppliers where id = v_sup;
  -- how far that supplier's receipts came from the estimate (last 10 bought with cash)
  select count(*), avg(e.total / nullif(q.estimated_total, 0) - 1), max(e.total / nullif(q.estimated_total, 0) - 1)
    into v_n, v_avg, v_max
    from (select e.* from public.expenses e join public.requests q2 on q2.id = e.request_id
           where e.supplier_id = v_sup and e.total > 0 and q2.estimated_total > 0 and q2.id <> p_request and q2.type <> 'claim'
           order by e.spent_at desc limit 10) e join public.requests q on q.id = e.request_id;
  -- a single catalogue item: the last price paid for it
  select el.unit_price, coalesce(i.name, el.description) into v_last, v_item
    from public.request_lines rl join public.expense_lines el on el.item_id = rl.item_id and not el.void
    left join public.items i on i.id = rl.item_id
   where rl.request_id = p_request and rl.item_id is not null order by el.id desc limit 1;
  -- the price trend at that supplier (last 90 days against the 90 before)
  select (avg(el.unit_price) filter (where e.spent_at >= current_date - 90)) / nullif(avg(el.unit_price) filter (where e.spent_at < current_date - 90 and e.spent_at >= current_date - 180), 0) - 1
    into v_trend from public.expense_lines el join public.expenses e on e.id = el.expense_id
    join public.request_lines rl on rl.request_id = p_request and ((rl.item_id is not null and rl.item_id = el.item_id) or lower(rl.description) = lower(el.description))
   where e.supplier_id = v_sup and not el.void;
  if v_n >= 3 then
    v_margin := greatest(0, least(coalesce(st.change_tolerance_pct, 10) / 100, greatest(coalesce(v_avg, 0), coalesce(v_max, 0) * 0.8)));
    v_why := format('%s: the last %s receipts came to %s%% %s the estimate on average', v_name, v_n, round(abs(coalesce(v_avg, 0)) * 100), case when coalesce(v_avg, 0) >= 0 then 'above' else 'below' end);
    if r.price_known and coalesce(v_max, 0) <= 0.02 then v_margin := 0; v_why := format('%s: the price has held on the last %s receipts', v_name, v_n); end if;
  else
    v_margin := case when r.price_known then least(st.cash_margin_pct, 5) / 100.0 else st.cash_margin_pct / 100.0 end;
    v_why := case when r.price_known then 'Known price, small margin in case it changed' else format('Estimate: the standard %s%% margin', st.cash_margin_pct) end
             || case when v_name is not null then format(' (no history yet at %s)', v_name) else '' end;
  end if;
  v_amt := ceil(v_base * (1 + v_margin) / st.cash_round_to) * st.cash_round_to;
  v_cap := round(v_base * (1 + coalesce(st.change_tolerance_pct, 0) / 100), 2);
  if v_amt > v_cap then v_amt := greatest(v_base, floor(v_cap / st.cash_round_to) * st.cash_round_to); if v_amt < v_base then v_amt := v_base; end if; end if;
  -- the box: when the last count had no coins, round to a whole note
  select coalesce(sum((x->>'count')::int) filter (where (x->>'value')::numeric < 10), 0) = 0 into v_coins
    from public.cash_counts c, jsonb_array_elements(coalesce(c.denominations, '[]'::jsonb)) x
   where c.id = (select id from public.cash_counts where denominations is not null and coalesce(place, 'box') = 'box' order by counted_at desc limit 1);
  if v_coins and v_amt <> round(v_amt) then v_amt := ceil(v_amt / 10) * 10; v_why := v_why || '; the box had no coins at the last count'; end if;
  return jsonb_build_object('amount', v_amt, 'estimate', v_base, 'margin_pct', round(v_margin * 100), 'cap', v_cap, 'why', v_why, 'supplier', v_name, 'history', v_n,
    'last_price', v_last, 'last_item', v_item, 'trend_pct', case when v_trend is not null then round(v_trend * 100) end);
end $$;

/* ---------- counts by notes and coins ---------- */
create or replace function public.set_count_denominations(p_count uuid, p_denoms jsonb) returns public.cash_counts
language plpgsql security definer set search_path = public as $$
declare c public.cash_counts%rowtype; v_sum numeric;
begin
  select * into c from public.cash_counts where id = p_count for update;
  if c.id is null or c.counted_by <> auth.uid() then raise exception 'Only the person who counted can add the notes and coins'; end if;
  select coalesce(sum((x->>'value')::numeric * (x->>'count')::int), 0) into v_sum from jsonb_array_elements(p_denoms) x;
  if abs(v_sum - c.counted) > 0.004 then raise exception 'The notes and coins add up to %, not %', public.money_text(v_sum), public.money_text(c.counted); end if;
  update public.cash_counts set denominations = p_denoms where id = c.id returning * into c;
  return c;
end $$;

/* ---------- hand out together ---------- */
create table if not exists public.handouts (
  id uuid primary key default gen_random_uuid(),
  to_user uuid not null references public.profiles(id),
  amount numeric(12,2) not null check (amount > 0),
  denominations jsonb,
  requests uuid[] not null,
  note text,
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.handouts enable row level security;
create policy handouts_select on public.handouts for select to authenticated using (to_user = auth.uid() or public.has_role('finance') or public.has_role('approver'));
create policy two_step_required on public.handouts as restrictive for all to authenticated using (not (select public.two_step_blocked())) with check (not (select public.two_step_blocked()));

/* p_parts: [{request, amount}] – each request's share; together they are what was handed over. */
create or replace function public.hand_out_together(p_to uuid, p_parts jsonb, p_denoms jsonb default null, p_note text default null) returns public.handouts
language plpgsql security definer set search_path = public as $$
declare h public.handouts%rowtype; x jsonb; v_total numeric := 0; v_ids uuid[] := '{}'; r public.requests%rowtype; v_sum numeric;
begin
  if not public.has_role('finance') then raise exception 'Only finance pays out. The GM approves; finance pays.'; end if;
  if jsonb_array_length(coalesce(p_parts, '[]'::jsonb)) < 2 then raise exception 'Choose at least two requests (one request: use Pay out)'; end if;
  for x in select * from jsonb_array_elements(p_parts) loop
    v_total := v_total + (x->>'amount')::numeric; v_ids := v_ids || (x->>'request')::uuid;
  end loop;
  if p_denoms is not null then
    select coalesce(sum((d->>'value')::numeric * (d->>'count')::int), 0) into v_sum from jsonb_array_elements(p_denoms) d;
    if abs(v_sum - v_total) > 0.004 then raise exception 'The notes and coins add up to %, not %', public.money_text(v_sum), public.money_text(v_total); end if;
  end if;
  insert into public.handouts (to_user, amount, denominations, requests, note) values (p_to, round(v_total, 2), p_denoms, v_ids, nullif(btrim(coalesce(p_note, '')), '')) returning * into h;
  for x in select * from jsonb_array_elements(p_parts) loop
    select * into r from public.requests where id = (x->>'request')::uuid;
    if r.type = 'claim' then raise exception '#% is a claim: it is paid back to its claimant, not handed out together', r.request_no; end if;
    perform public.disburse_request(r.id, (x->>'amount')::numeric, p_to, 'Handed out together: ' || public.money_text(v_total) || ' to ' || public.person_name(p_to) || ' for ' || jsonb_array_length(p_parts) || ' requests');
    update public.requests set handout_id = h.id where id = r.id;
  end loop;
  return h;
end $$;

/* The holder confirms once for the whole hand-out. */
create or replace function public.confirm_handout(p_handout uuid, p_received boolean, p_note text default null) returns int
language plpgsql security definer set search_path = public as $$
declare h public.handouts%rowtype; v uuid; n int := 0;
begin
  select * into h from public.handouts where id = p_handout;
  if h.id is null or h.to_user <> auth.uid() then raise exception 'Only the person who was handed the cash confirms it'; end if;
  foreach v in array h.requests loop
    if (select cash_received from public.requests where id = v) is null then perform public.confirm_cash(v, p_received, p_note); n := n + 1; end if;
  end loop;
  return n;
end $$;

/* The requester: "Received" – the item bought for them by someone else arrived. */
create or replace function public.confirm_goods(p_request uuid) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype;
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null or r.requester_id <> auth.uid() then raise exception 'Only the person who asked for it confirms it arrived'; end if;
  if r.disbursed_to is null or r.disbursed_to = r.requester_id then raise exception 'Nobody else was buying this for you'; end if;
  if r.goods_received_at is not null then return r; end if;
  update public.requests set goods_received_at = now(), goods_received_by = auth.uid() where id = r.id returning * into r;
  perform public.log_event(r.id, 'goods_received', r.status, r.status, 'Received by the requester');
  perform public.notify_user(r.disbursed_to, 'document', 'Received: ' || public.req_label(r), public.person_name(auth.uid()) || ' has the item you bought.', '#/requests/' || r.id, r.id);
  return r;
end $$;

/* ---------- cash with a person ---------- */
create or replace function public.cash_with(p_person uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_p uuid := coalesce(p_person, auth.uid()); v_rows jsonb;
begin
  if v_p <> auth.uid() and not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Not allowed'; end if;
  select coalesce(jsonb_agg(x order by (x->>'request_no')::int), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('request_id', q.id, 'request_no', q.request_no, 'purpose', q.purpose, 'requester', public.person_name(q.requester_id),
             'mine', q.requester_id = v_p, 'status', q.status, 'handed', q.disbursed_amount, 'spent', case when q.status <> 'disbursed' then e.total end,
             'holding', case when q.status = 'disbursed' then q.disbursed_amount else 0 end,
             'change', case when q.status <> 'disbursed' and e.change_back_at is null then greatest(q.disbursed_amount - e.total, 0) else 0 end,
             'owed', case when q.status <> 'disbursed' and e.difference_paid_at is null then greatest(e.total - q.disbursed_amount, 0) else 0 end,
             'handout_id', q.handout_id, 'price_rise', q.price_rise) x
      from public.requests q left join public.expenses e on e.request_id = q.id
     where q.disbursed_to = v_p and q.paid_via = 'cash' and q.type <> 'claim'
       and (q.status in ('disbursed', 'proof_review', 'physical_required')
            or (q.status = 'closed' and e.change_back_at is null and q.disbursed_amount > e.total and q.closed_at > now() - interval '60 days')
            or (q.status = 'closed' and e.difference_paid_at is null and e.total > q.disbursed_amount and q.closed_at > now() - interval '60 days'))) t;
  return jsonb_build_object('person', v_p, 'name', public.person_name(v_p), 'rows', v_rows,
    'holding', (select coalesce(sum((x->>'holding')::numeric), 0) from jsonb_array_elements(v_rows) x),
    'change', (select coalesce(sum((x->>'change')::numeric), 0) from jsonb_array_elements(v_rows) x),
    'owed', (select coalesce(sum((x->>'owed')::numeric), 0) from jsonb_array_elements(v_rows) x));
end $$;

/* Finance: everyone holding petty cash or owed some, for the Petty cash page. */
create or replace function public.cash_with_people() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb := '[]'::jsonb; p uuid; c jsonb;
begin
  if not (public.has_role('finance') or public.has_role('approver')) then raise exception 'Not allowed'; end if;
  for p in select distinct q.disbursed_to from public.requests q
            where q.disbursed_to is not null and q.paid_via = 'cash' and q.type <> 'claim' and q.branch_id = any(public.my_branches())
              and q.status in ('disbursed', 'proof_review', 'physical_required', 'closed') and coalesce(q.closed_at, now()) > now() - interval '60 days' loop
    c := public.cash_with(p);
    if (c->>'holding')::numeric + (c->>'change')::numeric + (c->>'owed')::numeric > 0 then v := v || c; end if;
  end loop;
  return v;
end $$;

/* Finance takes the change back at once: the requests it covers, what was counted (by notes and coins). */
create or replace function public.return_change(p_person uuid, p_requests uuid[], p_counted numeric, p_denoms jsonb default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_due numeric := 0; v uuid; r public.requests%rowtype; e public.expenses%rowtype; v_id uuid := gen_random_uuid(); v_diff numeric; v_sum numeric;
begin
  if not public.has_role('finance') then raise exception 'Only finance takes change back'; end if;
  if p_person = auth.uid() then raise exception 'Someone else must take your change back'; end if;
  if coalesce(array_length(p_requests, 1), 0) = 0 then raise exception 'Choose the requests the change is for'; end if;
  if p_denoms is not null then
    select coalesce(sum((d->>'value')::numeric * (d->>'count')::int), 0) into v_sum from jsonb_array_elements(p_denoms) d;
    if abs(v_sum - p_counted) > 0.004 then raise exception 'The notes and coins add up to %, not %', public.money_text(v_sum), public.money_text(p_counted); end if;
  end if;
  foreach v in array p_requests loop
    select * into r from public.requests where id = v for update; select * into e from public.expenses where request_id = v for update;
    if r.disbursed_to is distinct from p_person or e.id is null or r.status = 'disbursed' then raise exception '#% has no receipt recorded yet: its change is not known', r.request_no; end if;
    if e.change_back_at is not null then raise exception 'The change for #% was already taken back', r.request_no; end if;
    v_due := v_due + greatest(r.disbursed_amount - e.total, 0);
    update public.expenses set change_back_at = now(), change_back_by = auth.uid(), change_back_id = v_id where id = e.id;
    perform public.log_event(v, 'change_back', r.status, r.status, public.money_text(greatest(r.disbursed_amount - e.total, 0)) || ' change handed back');
  end loop;
  v_diff := round(p_counted - v_due, 2);
  if abs(v_diff) >= 0.01 then
    perform public.notify_role('approver', 'cash_dispute', 'Change ' || case when v_diff < 0 then 'short' else 'over' end || ': ' || public.money_text(abs(v_diff)),
      public.person_name(p_person) || ' handed back ' || public.money_text(p_counted) || ' against ' || public.money_text(v_due) || ' due' || coalesce(' – ' || nullif(btrim(p_note), ''), '') || '. The next cash count will show it.', '#/cash', null);
  end if;
  return jsonb_build_object('due', v_due, 'counted', p_counted, 'difference', v_diff, 'id', v_id, 'denominations', p_denoms);
end $$;

/* ---------- price went up ---------- */
create or replace function public.price_went_up(p_request uuid, p_new_total numeric, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; v_level text; v_role public.user_role;
begin
  select * into r from public.requests where id = p_request for update;
  if r.id is null or r.disbursed_to is distinct from auth.uid() then raise exception 'Only the person buying it can say the price went up'; end if;
  if r.status <> 'disbursed' then raise exception 'Only before the receipt is recorded'; end if;
  if p_new_total is null or p_new_total <= r.disbursed_amount then raise exception 'The new price must be more than the % you have', public.money_text(r.disbursed_amount); end if;
  v_level := coalesce(public.approval_level_for(p_new_total), 'gm');
  v_role := case when v_level = 'md' or (select role from public.profiles where id = r.requester_id) = 'approver' or (select role from public.profiles where id = auth.uid()) = 'approver'
                 then 'managing_director'::public.user_role else 'approver'::public.user_role end;
  update public.requests set price_rise = jsonb_build_object('new_total', round(p_new_total, 2), 'was', r.estimated_total, 'handed', r.disbursed_amount, 'note', nullif(btrim(coalesce(p_note, '')), ''), 'by', auth.uid(), 'at', now()),
         review_role = v_role, review_reason = format('Price went up: %s instead of %s.', public.money_text(p_new_total), public.money_text(r.estimated_total)) || coalesce(' ' || nullif(btrim(p_note), ''), ''),
         reviewed_by = null, reviewed_at = null, review_note = null, urgent = true, urgent_reason = coalesce(urgent_reason, 'Price went up at the shop'), urgent_stage_at = now()
   where id = r.id returning * into r;
  perform public.log_event(r.id, 'price_went_up', r.status, r.status, public.money_text(p_new_total));
  perform public.notify_review(r.id);
  perform public.notify_role('finance', 'urgent', 'Price went up: ' || public.req_label(r), public.person_name(auth.uid()) || ' needs ' || public.money_text(p_new_total - r.disbursed_amount) || ' more once it is approved.', '#/requests/' || r.id, r.id);
  return r;
end $$;

/* Finance hands out more on a request still being bought: within the margin, or once the higher price is approved. */
create or replace function public.top_up_request(p_request uuid, p_amount numeric, p_note text default null) returns public.requests
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; s public.settings%rowtype; v_cap numeric; v_bal numeric;
begin
  if not public.has_role('finance') then raise exception 'Only finance pays out'; end if;
  select * into r from public.requests where id = p_request for update;
  if r.id is null or r.status <> 'disbursed' or r.paid_via <> 'cash' then raise exception 'Only on a request still being bought with cash'; end if;
  if r.disbursed_to = auth.uid() or r.requester_id = auth.uid() then raise exception 'Someone else must pay out your own request'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount'; end if;
  select * into s from public.settings where id = 1;
  v_cap := case when r.price_rise is not null and r.reviewed_at is not null then round((r.price_rise->>'new_total')::numeric * (1 + coalesce(s.change_tolerance_pct, 0) / 100), 2)
                else round(r.estimated_total * (1 + coalesce(s.change_tolerance_pct, 0) / 100), 2) end;
  if r.disbursed_amount + p_amount > v_cap then
    raise exception 'That makes % in all, more than allowed (%). %', public.money_text(r.disbursed_amount + p_amount), public.money_text(v_cap),
      case when r.price_rise is not null and r.reviewed_at is null then 'The higher price is waiting for approval.' else 'Use “Price went up” first.' end;
  end if;
  v_bal := public.float_balance(r.float_id);
  if v_bal < p_amount then raise exception 'Insufficient float: balance is %', public.money_text(v_bal); end if;
  update public.requests set disbursed_amount = round(disbursed_amount + p_amount, 2), cash_received = null, cash_received_at = null where id = r.id returning * into r;
  perform public.log_event(r.id, 'topped_up', r.status, r.status, coalesce(p_note, '') || ' (+' || p_amount || ')');
  perform public.notify_user(r.disbursed_to, 'cash_ready', 'More cash: ' || public.money_text(p_amount), public.req_label(r) || ' – now ' || public.money_text(r.disbursed_amount) || ' in all.', '#/requests/' || r.id, r.id);
  return r;
end $$;

/* The person paid the extra themselves: finance pays it back (within the margin, or once a higher amount was checked). */
create or replace function public.pay_difference(p_request uuid, p_note text default null) returns public.expenses
language plpgsql security definer set search_path = public as $$
declare r public.requests%rowtype; e public.expenses%rowtype; v_diff numeric; f public.floats; v_bal numeric;
begin
  if not public.has_role('finance') then raise exception 'Only finance pays out'; end if;
  select * into r from public.requests where id = p_request for update; select * into e from public.expenses where request_id = p_request for update;
  if r.id is null or e.id is null or r.status = 'disbursed' or r.paid_via <> 'cash' then raise exception 'There is no recorded receipt on this request'; end if;
  if r.disbursed_to = auth.uid() or r.requester_id = auth.uid() then raise exception 'Someone else must pay back your own request'; end if;
  v_diff := round(e.total - r.disbursed_amount, 2);
  if v_diff <= 0 then raise exception 'Nothing is owed: the receipt is within what was handed out'; end if;
  if e.difference_paid_at is not null then raise exception 'The difference was already paid back'; end if;
  if r.review_reason is not null and r.reviewed_at is null then raise exception 'The higher amount is waiting to be checked by the % first', case when r.review_role = 'managing_director' then 'MD' else 'GM' end; end if;
  v_bal := public.float_balance(r.float_id);
  update public.expenses set difference_paid_at = now(), difference_paid_by = auth.uid() where id = e.id returning * into e;
  perform public.log_event(r.id, 'difference_paid', r.status, r.status, public.money_text(v_diff) || ' paid back to ' || public.person_name(r.disbursed_to) || coalesce(' – ' || nullif(p_note, ''), ''));
  perform public.notify_user(r.disbursed_to, 'reimbursed', 'Paid back: ' || public.money_text(v_diff), public.req_label(r) || ' – what you paid above the cash you were given. Collect it from finance.', '#/requests/' || r.id, r.id);
  return e;
end $$;

/* ---------- back-fill: what is already there ---------- */
-- receipts already confirmed: their change is taken as handed back
update public.expenses e set change_back_at = q.closed_at, change_back_by = q.closed_by
  from public.requests q where q.id = e.request_id and q.status = 'closed' and e.change_back_at is null;
update public.expenses e set difference_paid_at = q.closed_at, difference_paid_by = q.closed_by
  from public.requests q where q.id = e.request_id and q.status = 'closed' and e.total > q.disbursed_amount and e.difference_paid_at is null;
-- link the receipts, quotes and invoices already read to suppliers
update public.request_documents set extracted = extracted where supplier_id is null and extracted ? 'supplier';
update public.expense_proofs set extracted = extracted where extracted ? 'supplier';
update public.expenses set supplier_name = supplier_name where supplier_id is null and coalesce(supplier_name, '') <> '';

revoke execute on function public.supplier_for(text, jsonb) from public, anon, authenticated;
revoke execute on function public.save_supplier(uuid, jsonb), public.merge_suppliers(uuid, uuid), public.supplier_bank_check(uuid), public.suggest_cash(uuid),
  public.set_count_denominations(uuid, jsonb), public.hand_out_together(uuid, jsonb, jsonb, text), public.confirm_handout(uuid, boolean, text), public.confirm_goods(uuid),
  public.cash_with(uuid), public.cash_with_people(), public.return_change(uuid, uuid[], numeric, jsonb, text), public.price_went_up(uuid, numeric, text),
  public.top_up_request(uuid, numeric, text), public.pay_difference(uuid, text), public.supplier_book() from public, anon;
grant execute on function public.save_supplier(uuid, jsonb), public.merge_suppliers(uuid, uuid), public.supplier_bank_check(uuid), public.suggest_cash(uuid),
  public.set_count_denominations(uuid, jsonb), public.hand_out_together(uuid, jsonb, jsonb, text), public.confirm_handout(uuid, boolean, text), public.confirm_goods(uuid),
  public.cash_with(uuid), public.cash_with_people(), public.return_change(uuid, uuid[], numeric, jsonb, text), public.price_went_up(uuid, numeric, text),
  public.top_up_request(uuid, numeric, text), public.pay_difference(uuid, text), public.supplier_book() to authenticated;
