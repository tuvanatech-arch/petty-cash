-- 054: item names and units are always tidied when saved: extra spaces gone, a capital first letter, units written
-- out (pck → pack, bx → box, ea → each), and a few common misspellings put right (Rims → Reams).
create or replace function public.tidy_text(p text) returns text language sql immutable as $$
  select nullif(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'), '')
$$;

create or replace function public.tidy_item_name(p text) returns text language plpgsql immutable as $$
declare t text := public.tidy_text(p);
begin
  if t is null then return null; end if;
  t := regexp_replace(t, '\m(?:R|r)(?:ims|eems|eames)\M', 'Reams', 'g');
  t := regexp_replace(t, '\m(?:R|r)(?:im|eem|eame)\M', 'Ream', 'g');
  t := regexp_replace(t, '\mStationary\M', 'Stationery', 'gi');
  t := regexp_replace(t, '\mEnvelops\M', 'Envelopes', 'gi');
  t := regexp_replace(t, '\mTissues?\s+paper\M', 'Tissue paper', 'gi');
  t := regexp_replace(t, '\mToilet\s+rolls?\M', 'Toilet rolls', 'gi');
  return upper(left(t, 1)) || substr(t, 2);
end $$;

create or replace function public.tidy_unit(p text) returns text language plpgsql immutable as $$
declare t text := lower(public.tidy_text(p));
begin
  if t is null then return null; end if;
  return case t when 'pck' then 'pack' when 'pk' then 'pack' when 'pkt' then 'packet' when 'pcs' then 'each' when 'pc' then 'each'
    when 'ea' then 'each' when 'bx' then 'box' when 'btl' then 'bottle' when 'btls' then 'bottle' when 'rl' then 'roll' else t end;
end $$;

create or replace function public.items_tidy() returns trigger language plpgsql as $$
begin
  new.name := public.tidy_item_name(new.name);
  new.unit := public.tidy_unit(new.unit);
  return new;
end $$;
create or replace trigger items_tidy before insert or update of name, unit on public.items for each row execute function public.items_tidy();

create or replace function public.item_suggestions_tidy() returns trigger language plpgsql as $$
begin new.name := public.tidy_item_name(new.name); return new; end $$;
create or replace trigger item_suggestions_tidy before insert or update of name on public.item_suggestions for each row execute function public.item_suggestions_tidy();

-- tidy what is already there
update public.items set name = name, unit = unit;
update public.item_suggestions set name = name;
