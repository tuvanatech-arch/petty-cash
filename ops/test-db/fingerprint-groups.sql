with x as (
select * from (with fp(kind, name, def) as (
  select 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g') || '|' || pg_get_function_result(p.oid) || '|' || p.provolatile::text || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || l.lanname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
  where n.nspname = 'public' and p.prokind in ('f', 'p')
  union all
  select 'grant-fn', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         coalesce((select string_agg(case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end, ',' order by 1)
                   from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.privilege_type = 'EXECUTE'
                     and (a.grantee = 0 or a.grantee::regrole::text in ('anon', 'authenticated', 'service_role'))), '')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f'
  union all
  select 'column', c.relname || '.' || a.attname,
         format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || '|' || a.attidentity::text || a.attgenerated::text
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relkind in ('r', 'v') and a.attnum > 0 and not a.attisdropped
  union all
  select 'constraint', c.relname || '.' || k.conname, pg_get_constraintdef(k.oid)
  from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
  union all
  select 'index', i.indexname, i.indexdef from pg_indexes i where i.schemaname = 'public'
  union all
  select 'rls', c.relname, c.relrowsecurity::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'
  union all
  select 'policy', schemaname || '.' || tablename || '.' || policyname, permissive || '|' || cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')
  from pg_policies where schemaname in ('public', 'storage')
  union all
  select 'trigger', c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname in ('users', 'sessions')))
  union all
  select 'view', viewname, definition from pg_views where schemaname = 'public'
  union all
  select 'enum', t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder)
  from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' group by t.typname
  union all
  select 'cron', jobname, schedule || '|' || command from cron.job
  union all
  select 'realtime', tablename, 'on' from pg_publication_tables where pubname = 'supabase_realtime'
  union all
  select 'bucket', id, public::text || '|' || coalesce(file_size_limit::text, '') || '|' || coalesce(array_to_string(allowed_mime_types, ','), '') from storage.buckets
)
select kind, name, left(md5(def), 8) as h from fp
where name !~ '^(mgp_|app_files)' and name not in ('mgp-files', 'site')
) y)
select kind || ':' || case when kind in ('column','constraint') then split_part(name, '.', 1) else left(name, 2) end g, left(md5(string_agg(name || ':' || h, ',' order by name)), 6) agg from x where kind not in ('bucket','enum','realtime','rls','view') group by 1 order by 1;
