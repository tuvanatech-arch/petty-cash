-- 054: item names and units tidied on save
select case when public.tidy_item_name('  paper   rims ') = 'Paper Reams' then 'ok' else 'FAIL '||public.tidy_item_name('  paper   rims ') end as rims;
select case when public.tidy_item_name('memory stickers') = 'Memory stickers' then 'ok' else 'FAIL' end as capital;
select case when public.tidy_item_name('International  Minutes') = 'International Minutes' then 'ok' else 'FAIL' end as spaces;
select case when public.tidy_unit('Pck') = 'pack' and public.tidy_unit('Box') = 'box' then 'ok' else 'FAIL' end as units;
select case when public.tidy_item_name('Primer') = 'Primer' and public.tidy_item_name('Trims') = 'Trims' then 'ok' else 'FAIL' end as no_false_fix;
