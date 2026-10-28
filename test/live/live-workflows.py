# Generates one SQL batch: every workflow the app's buttons trigger, run as the real role, each step in its own
# savepoint, all rolled back at the end. Output: a PASS/FAIL report.
import sys
A = '03960029-37b8-4332-9861-74bf3d883d90'   # approver
S = 'cc3d33ed-8ba3-44b4-a98f-780dfd0cdf87'   # stock manager
F = '09e65d86-8ac7-4b3a-85c5-47e6ed0fa41f'   # finance
R = '42d33e82-c24c-4be6-a9d2-bc753f2cbc17'   # requester
R2 = 'fe9291fb-07f5-4173-9087-93e2832e6ccd'  # requester 2
FLOAT = '6fc22819-e872-433d-9b37-003240fb8863'
CAT = '316fa0be-938d-458f-93d7-522523d9686b'
who = {'A': A, 'S': S, 'F': F, 'R': R, 'R2': R2}

steps = []
def ok(w, name, body): steps.append((w, name, body, 'ok'))
def deny(w, name, body): steps.append((w, name, body, 'deny'))      # must raise
def none(w, name, body): steps.append((w, name, body, 'none'))      # must affect / see 0 rows (body sets n)

# ---------------- stock manager sets up the store ----------------
ok('S', 'add supplier', "insert into suppliers(name) values ('Audit Supplier') returning id into sup1;")
ok('S', 'add category', "insert into categories(name, kind) values ('Audit cat', 'both') returning id into cat1;")
ok('S', 'add item (insert + read back)', "insert into items(name, unit, category_id, recurring, reorder_level) values ('Audit paper', 'ream', cat1, true, 5) returning id into item1;")
ok('S', 'opening stock', f"perform adjust_stock(item1, 10, 'Opening stock');")
ok('S', 'edit item', "update items set reorder_level = 4 where id = item1; get diagnostics n = row_count; if n <> 1 then raise exception 'updated %', n; end if;")
ok('S', 'edit supplier', "update suppliers set contact = 'x' where id = sup1; get diagnostics n = row_count; if n <> 1 then raise exception 'updated %', n; end if;")
ok('S', 'receive stock', "perform receive_stock(item1, 5, 20.00, sup1, 'audit');")
ok('S', 'issue stock', f"perform issue_stock(item1, 2, '{R}', 'audit');")
ok('S', 'record usage', "perform record_usage(item1, 1, current_date, 'audit');")
ok('S', 'quick count', "perform quick_count(jsonb_build_array(jsonb_build_object('item_id', item1, 'counted', 11)), current_date, 'audit');")
ok('S', 'usage stats', "perform * from item_usage_stats();")
ok('S', 'read usage views', "perform * from v_item_monthly_usage; perform * from v_item_runouts;")

# ---------------- requester: report, ask, chat ----------------
ok('R', 'report low stock', "select (report_stock(item1, 'low', null)).id into rep1;")
deny('R', 'requester cannot add items', "insert into items(name, unit) values ('nope', 'each');")
deny('R', 'requester cannot add suppliers', "insert into suppliers(name) values ('nope');")
ok('R', 'new cash request (insert + read back)', f"insert into requests(type, purpose, requester_id, for_store) values ('cash', 'Audit taxi', '{R}', false) returning id into req1;")
ok('R', 'add request lines', "insert into request_lines(request_id, line_no, description, qty, est_unit_price) values (req1, 1, 'Taxi', 1, 150);")
ok('R', 'edit draft', "update requests set purpose = 'Audit taxi to bank' where id = req1; get diagnostics n = row_count; if n <> 1 then raise exception 'updated %', n; end if;")
ok('R', 'replace draft lines (delete + insert)', "delete from request_lines where request_id = req1; insert into request_lines(request_id, line_no, description, qty, est_unit_price) values (req1, 1, 'Taxi', 1, 150);")
ok('R', 'submit (under threshold → finance)', "select status::text into info from submit_request(req1); if info <> 'awaiting_disbursement' then raise exception 'status %', info; end if;")
ok('R', 'ask a question on it', "perform post_message(req1, 'Audit question');")
none('R2', 'another requester cannot see it', "select count(*) into n from requests where id = req1;")
none('R2', 'nor its lines', "select count(*) into n from request_lines where request_id = req1;")
deny('R', 'cannot raise a restock order', f"insert into requests(type, purpose, requester_id, for_store) values ('stock', 'x', '{R}', true);")
deny('R', 'cannot approve', "perform approve_request(req1, null);")
deny('R', 'cannot pay out', f"perform disburse_request(req1, 150, '{R}', null);")
none('R', 'cannot change settings', "update settings set org_name = 'hack'; get diagnostics n = row_count;")
deny('R', 'cannot make themselves approver', f"update profiles set role = 'approver' where id = '{R}';")
ok('R', 'change own name', f"update profiles set full_name = full_name where id = '{R}'; get diagnostics n = row_count; if n <> 1 then raise exception 'updated %', n; end if;")
none('R', 'cannot rename someone else', f"update profiles set full_name = 'x' where id = '{A}'; get diagnostics n = row_count;")
ok('R', 'email copies toggle', f"update profiles set email_notifications = false where id = '{R}';")
ok('R', 'turn on phone alerts (upsert)', f"insert into push_subscriptions(user_id, endpoint, p256dh, auth) values ('{R}', 'https://audit.example/ep', 'k', 'a') on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh;")
ok('R', 'turn on alerts again (upsert existing)', f"insert into push_subscriptions(user_id, endpoint, p256dh, auth) values ('{R}', 'https://audit.example/ep', 'k2', 'a') on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh;")
ok('R', 'turn off alerts', "delete from push_subscriptions where endpoint = 'https://audit.example/ep';")
ok('R', 'mark alerts read', "perform mark_notifications_read(null);")
ok('R', 'dismiss a tip', "perform mark_tip('audit', true); perform mark_tip(null, true);")
ok('R', 'diagnostics log', f"insert into client_logs(user_id, level, message) values ('{R}', 'info', 'audit');")
none('R', 'cannot read diagnostics', "select count(*) into n from client_logs;")
ok('R', 'draft then delete it', f"insert into requests(type, purpose, requester_id, for_store) values ('cash', 'Audit draft', '{R}', false) returning id into req5; insert into request_lines(request_id, line_no, description, qty, est_unit_price) values (req5, 1, 'x', 1, 10); delete from requests where id = req5; get diagnostics n = row_count; if n <> 1 then raise exception 'deleted %', n; end if;")

# ---------------- snap: inbox → claim; claim → approver → finance ----------------
ok('R', 'snap: upload to inbox (storage)', f"insert into storage.objects(bucket_id, name, owner, owner_id) values ('proofs', 'inbox/{R}/audit-1.jpg', '{R}', '{R}');")
ok('R', 'snap: inbox row (insert + read back)', f"insert into receipt_inbox(user_id, storage_path, file_name, mime, extracted) values ('{R}', 'inbox/{R}/audit-1.jpg', 'audit-1.jpg', 'image/jpeg', '{{\"supplier\":\"Shop\",\"total\":80,\"date\":\"2026-10-28\"}}') returning id into ib1;")
ok('R', 'snap → claim draft', "select id into claim1 from save_claim(null, 'Audit milk', null, current_date, 'Shop', null);")
ok('R', 'claim lines', "insert into request_lines(request_id, line_no, description, qty, est_unit_price) values (claim1, 1, 'Milk', 1, 80);")
ok('R', 'snap: move file into the claim (storage)', f"update storage.objects set name = claim1::text || '/audit-1.jpg' where bucket_id = 'proofs' and name = 'inbox/{R}/audit-1.jpg'; get diagnostics n = row_count; if n <> 1 then raise exception 'moved %', n; end if;")
ok('R', 'snap: file it on the claim', "perform file_inbox_receipt(ib1, claim1, claim1::text || '/audit-1.jpg');")
ok('R', 'submit claim (→ approver)', "select status::text into info from submit_request(claim1); if info <> 'pending_approval' then raise exception 'status %', info; end if;")
ok('R', 'claim draft from snap, then delete it', f"insert into storage.objects(bucket_id, name, owner, owner_id) values ('proofs', 'inbox/{R}/audit-2.jpg', '{R}', '{R}'); insert into receipt_inbox(user_id, storage_path, file_name, mime) values ('{R}', 'inbox/{R}/audit-2.jpg', 'audit-2.jpg', 'image/jpeg') returning id into ib2; select id into claim2 from save_claim(null, 'Audit 2', null, current_date, null, null); update storage.objects set name = claim2::text || '/audit-2.jpg' where bucket_id = 'proofs' and name = 'inbox/{R}/audit-2.jpg'; perform file_inbox_receipt(ib2, claim2, claim2::text || '/audit-2.jpg'); delete from requests where id = claim2; get diagnostics n = row_count; if n <> 1 then raise exception 'deleted %', n; end if;")
ok('R', 'discard an inbox photo', f"insert into receipt_inbox(user_id, storage_path, file_name) values ('{R}', 'inbox/{R}/audit-3.jpg', 'a.jpg') returning id into ib3; update receipt_inbox set status = 'discarded' where id = ib3; get diagnostics n = row_count; if n <> 1 then raise exception 'updated %', n; end if;")
ok('A', 'approve the claim', "perform approve_request(claim1, 'audit');")
ok('F', 'reimburse the claim', "perform disburse_request(claim1, 80, null, null); select status::text into info from requests where id = claim1; if info <> 'closed' then raise exception 'status %', info; end if;")

# ---------------- finance: float, pay out, undo, receipt, review ----------------
ok('F', 'top up the float', f"perform float_transaction('{FLOAT}', 'top_up', 3000, 'audit');")
ok('F', 'see the float', "select count(*) into n from v_floats where status = 'open'; if n <> 1 then raise exception 'open floats %', n; end if;")
ok('F', 'float outlook', "perform float_outlook(null); perform float_outlook(req1);")
ok('F', 'pay out', f"perform disburse_request(req1, 150, '{R}', null);")
ok('F', 'undo the pay-out', "perform undo_disbursement(req1, 'audit typo'); select status::text into info from requests where id = req1; if info <> 'awaiting_disbursement' then raise exception 'status %', info; end if;")
ok('F', 'pay out again', f"perform disburse_request(req1, 150, '{R}', null);")
ok('R', 'upload receipt (storage)', f"insert into storage.objects(bucket_id, name, owner, owner_id) values ('proofs', req1::text || '/r.jpg', '{R}', '{R}');")
ok('R', 'receipt row (insert + read back)', f"insert into expense_proofs(expense_id, storage_path, file_name, mime, uploaded_by) select e.id, req1::text || '/r.jpg', 'r.jpg', 'image/jpeg', '{R}' from expenses e where e.request_id = req1 returning id into pr1;")
ok('R', 'remove a receipt again', f"insert into expense_proofs(expense_id, storage_path, file_name, uploaded_by) select e.id, req1::text || '/r2.jpg', 'r2.jpg', '{R}' from expenses e where e.request_id = req1 returning id into pr2; delete from expense_proofs where id = pr2; get diagnostics n = row_count; if n <> 1 then raise exception 'deleted %', n; end if;")
ok('R', 'record what was spent', "perform record_expense(req1, current_date, '[{\"item_id\":null,\"description\":\"Taxi\",\"qty\":1,\"unit_price\":140,\"supplier_id\":null,\"supplier_name\":\"City Cabs\"}]'::jsonb, 'audit'); select status::text into info from requests where id = req1; if info <> 'proof_review' then raise exception 'status %', info; end if;")
deny('F', 'cannot undo once spent', "perform undo_disbursement(req1, 'x');")
ok('F', 'receipt checks', "perform * from expense_checks(null); perform * from expense_checks(req1);")
ok('F', 'ask for the paper receipt', "perform finance_review_expense(req1, 'require_physical', 'audit');")
ok('F', 'paper receipt received → closed', "perform finance_review_expense(req1, 'physical_received', 'audit'); select status::text into info from requests where id = req1; if info <> 'closed' then raise exception 'status %', info; end if;")
ok('F', 'pay out now (no request)', f"select id into req11 from quick_payout('{R}', 50, 'Audit courier', '{CAT}', null);")
ok('R', 'record what the pay-out-now was spent on', "perform record_expense(req11, current_date, '[{\"item_id\":null,\"description\":\"Courier\",\"qty\":1,\"unit_price\":50,\"supplier_id\":null,\"supplier_name\":null}]'::jsonb, null);")
ok('F', 'confirm & close it', "perform finance_review_expense(req11, 'confirm', 'audit'); select status::text into info from requests where id = req11; if info <> 'closed' then raise exception 'status %', info; end if;")
ok('A', 'approver got an alert for the claim', f"select count(*) into n from notifications where user_id = '{A}' and request_id = claim1; if n = 0 then raise exception 'no alert'; end if;")
ok('R', 'requester got the reimbursed alert', "select count(*) into n from notifications where request_id = claim1 and kind = 'reimbursed'; if n = 0 then raise exception 'no alert'; end if;")

# ---------------- escalate / approve / reject / cancel ----------------
ok('R', 'request 2', f"insert into requests(type, purpose, requester_id, for_store) values ('cash', 'Audit 2', '{R}', false) returning id into req3; insert into request_lines(request_id, line_no, description, qty, est_unit_price) values (req3, 1, 'x', 1, 100); perform submit_request(req3);")
ok('F', 'send for approval with a new amount', "perform escalate_request(req3, 300, 'more');")
ok('A', 'approve it', "perform approve_request(req3, 'audit'); select status::text into info from requests where id = req3; if info <> 'awaiting_disbursement' then raise exception 'status %', info; end if;")
ok('R', 'request 3 (above threshold)', f"insert into requests(type, purpose, requester_id, for_store) values ('cash', 'Audit 3', '{R}', false) returning id into req4; insert into request_lines(request_id, line_no, description, qty, est_unit_price) values (req4, 1, 'x', 1, 900); select status::text into info from submit_request(req4); if info <> 'pending_approval' then raise exception 'status %', info; end if;")
ok('A', 'reject it', "perform reject_request(req4, 'audit');")
ok('R', 'request 4 then withdraw it', f"insert into requests(type, purpose, requester_id, for_store) values ('cash', 'Audit 4', '{R}', false) returning id into req5; insert into request_lines(request_id, line_no, description, qty, est_unit_price) values (req5, 1, 'x', 1, 20); perform submit_request(req5); perform cancel_request(req5, 'audit');")
ok('F', 'decline a request', f"insert into requests(type, purpose, requester_id, for_store) values ('cash', 'Audit F', '{F}', false) returning id into req7; insert into request_lines(request_id, line_no, description, qty, est_unit_price) values (req7, 1, 'x', 1, 20); perform submit_request(req7); perform reject_request(req7, 'audit');")

# ---------------- supplier invoice before pay-out ----------------
ok('R', 'invoice: request to attach to', f"insert into requests(type, purpose, requester_id, for_store) values ('cash', 'Audit invoice', '{R}', false) returning id into req6; insert into request_lines(request_id, line_no, description, qty, est_unit_price) values (req6, 1, 'x', 1, 120); perform submit_request(req6);")
ok('R', 'invoice: upload + move + attach', f"insert into storage.objects(bucket_id, name, owner, owner_id) values ('proofs', 'inbox/{R}/inv.pdf', '{R}', '{R}'); insert into receipt_inbox(user_id, storage_path, file_name, mime, extracted) values ('{R}', 'inbox/{R}/inv.pdf', 'inv.pdf', 'application/pdf', '{{\"total\":125}}') returning id into ib4; update storage.objects set name = req6::text || '/inv.pdf' where bucket_id = 'proofs' and name = 'inbox/{R}/inv.pdf'; get diagnostics n = row_count; if n <> 1 then raise exception 'moved %', n; end if; perform file_inbox_document(ib4, req6, req6::text || '/inv.pdf', 'invoice');")
ok('F', 'invoice visible to finance', "select count(*) into n from request_documents where request_id = req6; if n <> 1 then raise exception 'docs %', n; end if;")
ok('F', 'pay out → invoice becomes the proof', f"perform disburse_request(req6, 125, '{R}', null); select count(*) into n from expense_proofs p join expenses e on e.id = p.expense_id where e.request_id = req6; if n <> 1 then raise exception 'proofs %', n; end if;")

ok('R', 'record spend on the invoiced purchase', "perform record_expense(req6, current_date, '[{\"item_id\":null,\"description\":\"x\",\"qty\":1,\"unit_price\":125,\"supplier_id\":null,\"supplier_name\":null}]'::jsonb, null);")
ok('F', 'receipt check reads the invoice total', "select status into info from expense_checks(req6); if info <> 'matches' then raise exception 'check %', info; end if;")
ok('F', 'return for correction', "perform finance_review_expense(req6, 'return', 'audit'); select proof_status::text into info from expenses where request_id = req6; if info <> 'returned' then raise exception 'proof %', info; end if;")
ok('R', 'correct and resubmit', "perform record_expense(req6, current_date, '[{\"item_id\":null,\"description\":\"x\",\"qty\":1,\"unit_price\":125,\"supplier_id\":null,\"supplier_name\":null}]'::jsonb, 'fixed');")
ok('F', 'confirm & close', "perform finance_review_expense(req6, 'confirm', null);")

# ---------------- stock requests and restock ----------------
ok('A', 'stock request (approver)', f"insert into requests(type, purpose, requester_id, for_store) values ('stock', 'Audit stock', '{A}', false) returning id into req8; insert into request_lines(request_id, line_no, item_id, description, qty, est_unit_price) values (req8, 1, item1, 'Audit paper', 3, 20); select status::text into info from submit_request(req8); if info <> 'stock_review' then raise exception 'status %', info; end if;")
ok('S', 'stock manager sees it', "select count(*) into n from requests where id = req8; if n <> 1 then raise exception 'seen %', n; end if;")
none('S', 'stock manager does not see cash requests', "select count(*) into n from requests where id = req1;")
ok('S', 'stock review (all from store)', "select jsonb_agg(jsonb_build_object('line_id', id, 'qty_from_stock', qty, 'qty_to_buy', 0, 'est_unit_price', est_unit_price)) into x from request_lines where request_id = req8; perform stock_review(req8, x, 'audit');")
ok('S', 'restock order from usage', "perform create_restock_request('Audit restock');")
ok('S', 'restock order from the report', "select id into req9 from restock_from_reports(array[rep1]); perform 1;")
ok('S', 'resolve a report', f"select (report_stock(item1, 'out', null)).id into rep2; perform resolve_report(rep2, 'audit');")
ok('S', 'delete a draft restock order made from reports', f"select id into req10 from restock_from_reports(array[(report_stock(item1, 'low', null)).id]); delete from requests where id = req10; get diagnostics n = row_count; if n <> 1 then raise exception 'deleted %', n; end if;")

# ---------------- approver admin ----------------
ok('A', 'budget add + switch off', f"insert into budgets(category_id, monthly_limit) values ('{CAT}', 500) returning id into bud1; update budgets set active = false where id = bud1;")
ok('A', 'budget status', "perform * from budget_status();")
ok('A', 'settings save', "update settings set org_name = org_name where id = 1; get diagnostics n = row_count; if n <> 1 then raise exception 'updated %', n; end if;")
ok('A', 'set-up checklist', "perform setup_status();")
ok('A', 'reports: claims table', "perform * from claims_summary(null, null); perform * from claims_summary('2025-11-01', null);")
ok('A', 'reports: spend views', "perform * from v_spend_lines limit 5; perform * from v_price_history limit 5;")
ok('A', 'diagnostics visible', "select count(*) into n from client_logs;")
ok('A', 'stand-in: finance covered by R2', f"insert into delegations(role, from_user, to_user, starts_on, ends_on, created_by) values ('finance', '{F}', '{R2}', current_date, current_date + 7, '{A}');")
ok('R2', 'stand-in sees the finance queue', "select count(*) into n from requests where status = 'awaiting_disbursement'; if n = 0 then raise exception 'saw nothing'; end if;")
ok('R2', 'finance stand-in pays out', f"perform disburse_request(req3, 300, '{R}', null);")
ok('R', 'record that spend', "perform record_expense(req3, current_date, '[{\"item_id\":null,\"description\":\"x\",\"qty\":1,\"unit_price\":300,\"supplier_id\":null,\"supplier_name\":null}]'::jsonb, null);")
ok('A', 'stand-in: stock manager covered by R2', f"insert into delegations(role, from_user, to_user, starts_on, ends_on, created_by) values ('stock_manager', '{S}', '{R2}', current_date, current_date + 7, '{A}');")
ok('R2', 'stand-in can count stock', "perform quick_count(jsonb_build_array(jsonb_build_object('item_id', item1, 'counted', 9)), current_date, 'audit');")
deny('R2', 'stand-in cannot add items (catalogue)', "insert into items(name, unit) values ('standin', 'each');")
deny('R2', 'stand-in cannot add suppliers', "insert into suppliers(name) values ('standin');")
ok('F', 'own stand-in from Account', f"insert into delegations(role, from_user, to_user, starts_on, ends_on, created_by) values ('finance', '{F}', '{R}', current_date + 30, current_date + 37, '{F}') returning id into del1; delete from delegations where id = del1;")
deny('R', 'requester cannot add stand-ins for others', f"insert into delegations(role, from_user, to_user, starts_on, ends_on, created_by) values ('finance', '{F}', '{R}', current_date, current_date + 1, '{R}');")

# ---------------- cron-only functions must not be callable by users ----------------
deny('R', 'requester cannot trigger reminders', "perform remind_stale_items();")
deny('R', 'requester cannot trigger the weekly digest', "perform weekly_digest();")
deny('R', 'requester cannot trigger month-close reminders', "perform remind_month_close();")
deny('R', 'requester cannot trigger advance reminders', "perform remind_outstanding_advances();")
deny('R', 'requester cannot trigger count reminders', "perform remind_weekly_count();")
deny('R', 'requester cannot read others\' history counts', f"perform profile_history('{A}');")
none('R', 'requester cannot see floats', "select count(*) into n from floats;")
none('R', 'requester cannot see month-end packs', "select count(*) into n from packs;")
none('R', 'requester sees no one else\'s alerts', f"select count(*) into n from notifications where user_id <> '{R}';")
none('R', 'requester sees no one else\'s inbox', f"select count(*) into n from receipt_inbox where user_id <> '{R}';")

# ---------------- month end ----------------
ok('F', 'pack file upload (storage)', f"insert into storage.objects(bucket_id, name, owner, owner_id) values ('packs', '2026-10/audit.pdf', '{F}', '{F}');")
deny('R', 'requester cannot upload packs', f"insert into storage.objects(bucket_id, name, owner, owner_id) values ('packs', '2026-10/x.pdf', '{R}', '{R}');")
ok('F', 'close the month', f"perform close_float('{FLOAT}', 100, 'audit');")
ok('F', 'register the pack', f"select id into pk from pack_register('{FLOAT}', '2026-10/audit.pdf', 'audit.pdf', 1000, 3, '{{}}'::jsonb);")
ok('F', 'mark the pack sent', "perform pack_mark_sent(pk, 'by hand');")
ok('F', 'open next month', "perform open_float((date_trunc('month', current_date) + interval '1 month')::date, 3000, 'audit');")


decl = ['n int', 'info text', 'x jsonb', "res jsonb := '[]'::jsonb"]
for v in 'req11 sup1 cat1 item1 rep1 rep2 req1 req3 req4 req5 req6 req7 req8 req9 req10 claim1 claim2 ib1 ib2 ib3 ib4 pr1 pr2 pk bud1 del1'.split():
    decl.append(f'{v} uuid')
esc = lambda s: s.replace("'", "''")
out = ["begin;",
  "create temp table audit_steps(n int, label text, expect text);",
  "insert into audit_steps values " + ','.join(f"({i},'{esc(w + ': ' + name)}','{exp}')" for i, (w, name, body, exp) in enumerate(steps, 1)) + ";",
  "create temp table audit_res(r jsonb);",
  "create function pg_temp.su(w text) returns void language plpgsql as $f$ begin perform set_config('request.jwt.claims', json_build_object('sub', case w " + ' '.join(f"when '{k}' then '{v}'" for k, v in who.items()) + " end, 'role', 'authenticated')::text, true); set local role authenticated; end $f$;",
  "do $audit$", "declare " + '; '.join(decl) + ";", "begin"]
for i, (w, name, body, exp) in enumerate(steps, 1):
    out.append(f"begin perform pg_temp.su('{w}'); n:=null; {body} reset role; res:=res||jsonb_build_object('n',{i},'rows',n); exception when others then res:=res||jsonb_build_object('n',{i},'err',sqlerrm); end;")
out.append("insert into audit_res values (res); end $audit$;")
out.append("""select s.n, case when s.expect='ok' and e->>'err' is null then 'PASS' when s.expect='deny' and e->>'err' is not null then 'PASS' when s.expect='none' and e->>'err' is null and coalesce((e->>'rows')::int,0)=0 then 'PASS' else 'FAIL' end as result, s.label as step, left(coalesce(e->>'err', case when s.expect='deny' then 'was allowed but must be refused' when s.expect='none' and coalesce((e->>'rows')::int,0)>0 then (e->>'rows') || ' row(s), must be 0' end, ''), 170) as detail from audit_steps s left join lateral (select x as e from audit_res, jsonb_array_elements(r) x where (x->>'n')::int = s.n) j on true order by s.n;""")
out.append("rollback;")
print('\n'.join(out))
