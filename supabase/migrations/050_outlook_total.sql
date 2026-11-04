-- 050: the petty cash outlook counts the box and the petty cash bank account together. Finance can take cash out of
-- the bank, so "left after commitments" and the verdict (comfortable / tight / short / overcommitted) use the total.
-- box_after says what the box alone would hold after the approved pay-outs, so the screens can say when cash has to
-- come out of the bank first. Cash counts and bank checks stay separate (each against its own evidence).
do $$
declare d text := pg_get_functiondef('public.outlook_for(uuid, uuid)'::regprocedure); n text;
begin
  n := replace(d, 'v_after := v_bal - v_awaiting - v_this;', 'v_after := v_bal + v_bank - v_awaiting - v_this;');
  n := replace(n, '''bank_balance'', v_bank, ''bank_name''', '''box_after'', round(v_bal - v_awaiting - v_this, 2), ''bank_balance'', v_bank, ''bank_name''');
  if n = d or position('box_after' in n) = 0 or position('v_bal + v_bank' in n) = 0 then raise exception '050: outlook_for is not as expected'; end if;
  execute n;
end $$;
