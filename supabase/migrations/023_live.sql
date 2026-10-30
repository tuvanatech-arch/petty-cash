-- 023: live screens. Supabase streams a change on these tables to the screens that are open,
-- and each person only receives the rows they are allowed to read (row-level security still applies).
do $$
declare t text;
begin
  foreach t in array array['requests', 'expenses', 'floats', 'float_transactions', 'cash_counts', 'top_ups', 'schedule_versions', 'stock_reports'] loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
