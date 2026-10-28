-- 016: saving a new request failed for everyone ("new row violates row-level security policy").
-- The read rule looked the request up by id through can_view_request(); during INSERT ... RETURNING the new row is not
-- yet visible to that lookup, so the returned row was refused. The rule now checks the row's own fields (same meaning).
alter policy requests_select on public.requests using (
  requester_id = auth.uid() or disbursed_to = auth.uid()
  or public.has_role('finance') or public.has_role('approver')
  or (public.has_role('stock_manager') and type = 'stock'));
-- the failed attempts had used up numbers; continue straight after the last real request
select setval('public.request_no_seq', (select max(request_no) from public.requests));
