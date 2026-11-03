-- 045: only finance pays from the company account.
-- A direct payment from the company account (outside petty cash) can be recorded only by finance (or whoever
-- finance has delegated to). The GM can still pay in cash from the box, or by transfer from the petty cash account.
do $patch$
declare d text; o text;
begin
  d := pg_get_functiondef('public.pay_by_transfer(uuid, numeric, date, text, text, text, text, text, text)'::regprocedure); o := d;
  d := replace(d, 'raise exception ''Say which account paid it: the petty cash bank account or the company account''; end if;',
                  'raise exception ''Say which account paid it: the petty cash bank account or the company account''; end if;
  if p_from = ''company'' and not public.has_role(''finance'') then raise exception ''Only finance pays from the company account''; end if;');
  if d = o then raise exception 'pay_by_transfer: not changed'; end if;
  execute d;
end $patch$;
