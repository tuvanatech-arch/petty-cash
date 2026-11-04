-- 048: the end of a free trial is noticed. The daily health check alerts Tuvana Tech 7 days before a trial ends,
-- every Monday of that last week, on the day it ends, and every working day after it has ended while the client is
-- still on 'trial' (set status = 'active' once they subscribe). The GM sees a notice on Home in the last week.
do $patch$
declare d text; o text;
begin
  d := pg_get_functiondef('public.health_report(integer)'::regprocedure); o := d;
  d := replace(d, '  if v_sub.status = ''cancelled'' and v_sub.remove_on <= current_date then',
'  if v_sub.status = ''trial'' and v_sub.trial_ends is not null then
    if v_sub.trial_ends < current_date then
      v := v || jsonb_build_object(''problem'', ''A free trial has ended'',
        ''detail'', format(''It ended on %s and the client is still on trial. Once they pay, set the status to active; if they do not continue, cancel it.'', v_sub.trial_ends));
    elsif v_sub.trial_ends - current_date = 0 or v_sub.trial_ends - current_date = 7
       or (v_sub.trial_ends - current_date < 7 and extract(isodow from current_date) = 1) then
      v := v || jsonb_build_object(''problem'', case when v_sub.trial_ends = current_date then ''A free trial ends today'' else ''A free trial ends soon'' end,
        ''detail'', format(''The trial ends on %s. Call the client about subscribing.'', v_sub.trial_ends));
    end if;
  end if;
  if v_sub.status = ''cancelled'' and v_sub.remove_on <= current_date then');
  if d = o then raise exception 'health_report: not changed'; end if;
  execute d;
end $patch$;
