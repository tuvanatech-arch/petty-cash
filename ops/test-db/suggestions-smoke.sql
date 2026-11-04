-- Item photos and suggestions for the store (053). Every line should say ok.
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(what text, cond boolean) returns text language sql as $$ select case when coalesce(cond, false) then 'ok   ' else 'FAIL ' end || what $$;
create function pg_temp.as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, true), set_config('request.jwt.claim.role', 'authenticated', true) $$;
create function pg_temp.refused(p_sql text, p_expect text) returns text language plpgsql as $$
begin execute p_sql; return 'FAIL not refused: ' || left(p_sql, 60);
exception when others then return case when sqlerrm like '%' || p_expect || '%' then 'ok   refused: ' || sqlerrm else 'FAIL refused for another reason: ' || sqlerrm end; end $$;
create function pg_temp.alerts(u uuid, pat text) returns int language sql as $$ select count(*)::int from public.notifications where user_id = u and title like pat $$;
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'boss@example.test', '{"full_name":"Ana Boss"}');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000b1', 'store@example.test', '{"full_name":"Sam Store"}', '{"invited":true,"role":"stock_manager"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff@example.test', '{"full_name":"Carlos Staff"}', '{"invited":true,"role":"requester"}');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
insert into public.items (name, unit, branch_id) values ('Printer paper A4', 'ream', public.my_branch());

-- photos: up to three, added by the stock controller
update public.items set photos = array['items/a.jpg', 'items/b.jpg', 'items/c.jpg'] where name = 'Printer paper A4';
select pg_temp.refused($$update public.items set photos = array['1','2','3','4'] where name = 'Printer paper A4'$$, 'items_photos_max3');
select pg_temp.ok('the photo store is private, pictures only', (select not public and allowed_mime_types @> array['image/jpeg'] from storage.buckets where id = 'item-photos'));

-- a requester suggests: the reason is required, duplicates are refused
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.refused($$select public.suggest_item('Sticky notes', 'need')$$, 'Say why');
select pg_temp.refused($$select public.suggest_item('printer paper a4', 'We go through a lot of paper every single week.')$$, 'Already in the store: Printer paper A4');
select (public.suggest_item('Sticky notes', 'Everyone at reception buys their own sticky notes every week.', 20, 35, 'Pick n Pay')).status;
select pg_temp.ok('the stock controller is told', pg_temp.alerts('00000000-0000-0000-0000-0000000000b1', 'Item suggested for the store: Sticky notes') = 1);
select pg_temp.refused($$select public.suggest_item('Sticky Notes', 'Another person asks for the same thing again.')$$, 'Already suggested by Carlos Staff');
select pg_temp.refused($$select public.review_item_suggestion((select id from public.item_suggestions where name = 'Sticky notes'), true)$$, 'your own');

-- the GM cannot skip the stock controller; the stock controller agrees; the GM approves: the item is in the catalogue
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.refused($$select public.review_item_suggestion((select id from public.item_suggestions where name = 'Sticky notes'), true)$$, 'stock controller checks');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select (public.review_item_suggestion((select id from public.item_suggestions where name = 'Sticky notes'), true, 'Cheaper in bulk')).status as after_stock;
select pg_temp.ok('then the GM is told, and the requester hears it went on', pg_temp.alerts('00000000-0000-0000-0000-0000000000a1', 'Item suggested for the store: Sticky notes') = 1
  and pg_temp.alerts('00000000-0000-0000-0000-0000000000c1', 'Your suggestion went to the GM%') = 1);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.review_item_suggestion((select id from public.item_suggestions where name = 'Sticky notes'), true)).status as after_gm;
select pg_temp.ok('approved: in the catalogue, with the expected monthly use and price', (select active and expected_monthly_qty = 20 and last_unit_price = 35 and suggested_by = '00000000-0000-0000-0000-0000000000c1' from public.items where name = 'Sticky notes'));
select pg_temp.ok('the requester and the stock controller are told', pg_temp.alerts('00000000-0000-0000-0000-0000000000c1', 'Added to the store: Sticky notes') = 1 and pg_temp.alerts('00000000-0000-0000-0000-0000000000b1', 'New item in the catalogue: Sticky notes') = 1);

-- declined: a reason is required, and the person is told why
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select (public.suggest_item('Gold pens', 'Clients would be impressed by gold pens at reception.')).id is not null as suggested;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select pg_temp.refused($$select public.review_item_suggestion((select id from public.item_suggestions where name = 'Gold pens'), false, '')$$, 'Say why');
select (public.review_item_suggestion((select id from public.item_suggestions where name = 'Gold pens'), false, 'Too expensive for every day')).status;
select pg_temp.ok('declined: the requester hears why', (select count(*) = 1 from public.notifications where user_id = '00000000-0000-0000-0000-0000000000c1' and title = 'Not added to the store: Gold pens' and body = 'Too expensive for every day'));

-- the GM's own suggestion needs only the stock controller; the stock controller's own goes straight to the GM
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select (public.suggest_item('Hand sanitiser', 'Visitors and staff need it at the entrance and in the boardroom.')).status as gm_suggests;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select pg_temp.ok('GM suggested, stock controller agrees: added at once', (public.review_item_suggestion((select id from public.item_suggestions where name = 'Hand sanitiser'), true)).status = 'approved');
select pg_temp.ok('the stock controller''s own suggestion goes to the GM', (public.suggest_item('Toner HP 30A', 'The new printer in finance takes this toner, not the old one.')).status = 'with_gm');
select pg_temp.refused($$select public.review_item_suggestion((select id from public.item_suggestions where name = 'Toner HP 30A'), true)$$, 'your own');

-- withdrawing
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select (public.suggest_item('Desk fans', 'The back office gets very hot in the afternoons in summer.')).id is not null as suggested;
select pg_temp.ok('the person can withdraw while it waits', (public.withdraw_item_suggestion((select id from public.item_suggestions where name = 'Desk fans'))).status = 'withdrawn');
set local role authenticated;
select pg_temp.ok('everyone sees the suggestions and their outcome', (select count(*) from public.item_suggestions) = 5);
reset role;
rollback;
