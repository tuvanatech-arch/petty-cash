-- 046: finance pays, the GM approves.
-- Only finance (or whoever finance has handed the role to while away) pays out: cash on a request or claim, a quick
-- pay-out from Petty cash, and a bank transfer from either account. The GM and the MD approve but no longer pay.
-- Finance's own requests already go to the GM for approval whatever the amount (approval_route), and once someone
-- else has approved, finance may pay them, so nothing waits for a payer who is not there.
do $patch$
declare d text; o text; fn text;
begin
  foreach fn in array array['public.disburse_request(uuid, numeric, uuid, text)', 'public.quick_payout(uuid, numeric, text, uuid, text)'] loop
    d := pg_get_functiondef(fn::regprocedure); o := d;
    d := replace(d, 'if not (public.has_role(''finance'') or public.has_role(''approver'')) then raise exception ''Only finance can pay out petty cash''; end if;',
                    'if not public.has_role(''finance'') then raise exception ''Only finance pays out. The GM approves; finance pays.''; end if;');
    if d = o then raise exception '%: not changed', fn; end if;
    execute d;
  end loop;
  d := pg_get_functiondef('public.pay_by_transfer(uuid, numeric, date, text, text, text, text, text, text)'::regprocedure); o := d;
  d := replace(d, 'if not (public.has_role(''finance'') or public.has_role(''approver'')) then raise exception ''Only finance can pay a request''; end if;',
                  'if not public.has_role(''finance'') then raise exception ''Only finance pays out. The GM approves; finance pays.''; end if;');
  if d = o then raise exception 'pay_by_transfer: not changed'; end if;
  execute d;
end $patch$;
