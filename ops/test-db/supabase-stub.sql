-- A stand-in for the parts of a Supabase database that Petti's setup relies on (sign-in users and sessions,
-- file storage, scheduled jobs, outgoing web calls, realtime), so the whole setup can be replayed on a plain
-- local Postgres and checked before it is run for a real client. Only the shapes Petti uses are here.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_storage_admin') then create role supabase_storage_admin nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator noinherit login; end if;
end $$;
grant anon, authenticated, service_role to postgres;
create schema extensions; create extension pgcrypto schema extensions; create extension "uuid-ossp" schema extensions;
select 1; -- search path set per database below
-- alter database petti set search_path = "$user", public, extensions;
do $$ begin execute format('alter database %I set search_path = "$user", public, extensions', current_database()); end $$;
set search_path = "$user", public, extensions;

create schema auth;
create table auth.users (
  instance_id uuid, id uuid primary key default gen_random_uuid(), aud varchar, role varchar, email varchar unique, encrypted_password varchar,
  email_confirmed_at timestamptz, invited_at timestamptz, confirmation_token varchar, confirmation_sent_at timestamptz, recovery_token varchar,
  recovery_sent_at timestamptz, last_sign_in_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb, is_super_admin boolean,
  created_at timestamptz default now(), updated_at timestamptz default now(), phone text, confirmed_at timestamptz, banned_until timestamptz,
  is_sso_user boolean default false, deleted_at timestamptz, is_anonymous boolean default false);
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz default now(), updated_at timestamptz default now(), factor_id uuid, aal text, not_after timestamptz,
  refreshed_at timestamp, user_agent text, ip inet, tag text);
create table auth.refresh_tokens (id bigserial primary key, token varchar, user_id varchar, revoked boolean, created_at timestamptz, updated_at timestamptz, parent varchar, session_id uuid);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant usage on schema auth to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (id text primary key, name text, owner uuid, created_at timestamptz default now(), updated_at timestamptz default now(),
  public boolean default false, avif_autodetection boolean default false, file_size_limit bigint, allowed_mime_types text[], owner_id text);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid,
  created_at timestamptz default now(), updated_at timestamptz default now(), last_accessed_at timestamptz default now(), metadata jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored, version text, owner_id text, user_metadata jsonb);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to authenticated, service_role;

create schema cron;
create table cron.job (jobid bigserial primary key, schedule text, command text, nodename text default 'localhost', nodeport int default 5432,
  database text default current_database(), username text default current_user, active boolean default true, jobname text unique);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create function cron.unschedule(job_name text) returns boolean language sql as $$ delete from cron.job where jobname = job_name returning true $$;
create function cron.alter_job(job_id bigint, schedule text default null, command text default null, database text default null, username text default null, active boolean default null)
  returns void language sql as $$ update cron.job set schedule = coalesce($2, schedule), command = coalesce($3, command), active = coalesce($6, active) where jobid = $1 $$;

create schema net;
create table net.calls (id bigserial primary key, url text, headers jsonb, body jsonb, at timestamptz default now());
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{"Content-Type": "application/json"}', timeout_milliseconds int default 5000)
  returns bigint language sql as $$ insert into net.calls (url, headers, body) values (url, headers, body) returning id $$;

create schema vault;
create publication supabase_realtime;
-- Supabase gives the API roles access to everything new in public; row level security does the rest
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
