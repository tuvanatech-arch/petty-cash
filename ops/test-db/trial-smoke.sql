-- The end of a free trial is noticed by the daily health check (048). Every line should say ok.
\set ON_ERROR_STOP 1
begin;
create function pg_temp.ok(what text, cond boolean) returns text language sql as $$ select case when coalesce(cond, false) then 'ok   ' else 'FAIL ' end || what $$;
create function pg_temp.says(p_days int) returns text language plpgsql as $$
begin
  update public.subscription set status = 'trial', trial_ends = current_date + p_days where id = 1;
  return coalesce((select string_agg(e ->> 'problem', '; ') from jsonb_array_elements(public.health_report(26) -> 'problems') e where e ->> 'problem' ilike '%trial%'), '');
end $$;
insert into public.subscription (id) values (1) on conflict do nothing;
select pg_temp.ok('7 days before: "ends soon"', pg_temp.says(7) = 'A free trial ends soon');
select pg_temp.ok('3 days before: only on a Monday', pg_temp.says(3) = case when extract(isodow from current_date) = 1 then 'A free trial ends soon' else '' end);
select pg_temp.ok('on the day: "ends today"', pg_temp.says(0) = 'A free trial ends today');
select pg_temp.ok('after the end, still on trial: "has ended"', pg_temp.says(-2) = 'A free trial has ended');
select pg_temp.ok('20 days to go: nothing', pg_temp.says(20) = '');
update public.subscription set status = 'active' where id = 1;
select pg_temp.ok('once active: nothing', coalesce((select count(*) from jsonb_array_elements(public.health_report(26) -> 'problems') e where e ->> 'problem' ilike '%trial%'), 0) = 0);
rollback;
