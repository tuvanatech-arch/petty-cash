-- 026b: run this once in the Supabase SQL editor (Dashboard → SQL) before adding a second branch.
-- It removes the two one-branch rules that the app used to rely on. The per-branch rules (one float per branch per
-- month; item names unique within a branch) are already in place from 026.
alter table public.floats drop constraint if exists floats_period_key;
drop index if exists public.items_name_uq;
