-- 034: an open request redraws itself when someone writes in its conversation or attaches a document.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'request_messages') then
    alter publication supabase_realtime add table public.request_messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'request_documents') then
    alter publication supabase_realtime add table public.request_documents;
  end if;
end $$;
