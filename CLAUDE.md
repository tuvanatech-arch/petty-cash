# Petti – working rules

Petti is Tuvana Tech's petty cash and office-stock app (Tuvana Tech is part of the Desmic Group). MGP (Namibia) is the first client: Supabase project `ytfgzfaogfrzanrpcpkg`. The app lives at **https://app.usepetti.com** (Netlify project `petti-app`, built from GitHub `tuvanatech-arch/petty-cash` on every push by `netlify-build.sh`; domain usepetti.com at GoDaddy, `app` CNAME to petti-app.netlify.app). The old GitHub Pages address still deploys and shows a "Petti has moved" bar: some Namibian mobile networks cannot reach github.io.

## How to reply

- Start every reply with the model and effort level in bold, e.g. **Model: Claude Opus 5.5 · effort: low.**
- Plain language. The owner is not a developer: no jargon, short questions, and a recommendation rather than a menu.
- Treat instructions as proposals: suggest a better way when there is one, and avoid over-engineering.

## Every update that affects people is announced to them

Whenever a release changes what someone sees or does, tell exactly those people, in the app and on their phone:

1. **Who:** target by role (`requester`, `stock_manager`, `finance`, `approver` = GM, `managing_director` = MD), by branch, or by named person. Use "everyone" only when it really affects everyone.
2. **What changes for them:** one or two plain sentences written for that role. If the impact differs by role, send one note per role.
3. **How to use it:** short numbered steps, with the exact screen and button names from the code (check them before writing).
4. **Show me:** a walk-through on the person's own screen (`tour`: steps of `{at, css, text, say}` that spotlight the real button or section), plus a picture of that screen with the part ringed. `node ops/tour-check.mjs ops/shots/<release>-tours.json` must say `ok` for every step, as that role, before announcing; `node ops/update-shots.mjs ops/shots/<release>.json` makes the pictures into `web/updates/` (deployed with the app).
5. **When:** the next working morning (`public.next_working_morning(10)`, 10:00 local, Mon–Fri), never at night or on weekends, unless it is urgent. A scheduled note can be cancelled under Admin → Updates until it goes out.
6. At most one or two notes per person per release. Combine small things.

```sql
select public.announce_update(
  '9 Nov 2026',                                   -- release label
  'Title people will see',                        -- becomes the alert: "What's new: <title>"
  'What changes for you, in one or two sentences.',
  array['Step one.', 'Step two.'],
  '#/stock/deliveries', 'Open Deliveries',        -- Show me (optional)
  array['stock_manager']::public.user_role[],     -- roles ('{}' = every role)
  '{}', '{}',                                     -- branches, named people
  public.next_working_morning(10));               -- null = send now
select public.set_update_extras('<id>', '[{"at":"#/stock/deliveries","css":"main .tabs button","text":"Deliveries","say":"Tap here."}]'::jsonb, 'updates/deliveries.png');
```

Pop-up appears only when someone lands on Home (never when they arrive from an alert with a job to do) and has a Later. Notes about a role's own duties that stay unread get one reminder after three working days.

Notes appear as an alert (pushed to phones that have alerts on, never emailed), as a one-time window when the app opens, and under What's new. Admin → Updates shows who has read each note.

## At the start of every session

Run `select public.update_feedback(30)` on the live database: what people said about recent notes (thumbs, comments). Fix unclear wording in the next release. The administrator's own notices (`announce_notice`, Admin → Updates → Send a notice) use the same delivery; they are listed there with the software updates.

## Releasing

1. A database change is always a new numbered file in `db/` (applied to live with the same content). Never change the live database by hand without saving the file. That is how the files and live drifted apart before `029z`.
2. `ops/test-db/replay.sh` must end in **REPLAY OK**. Then refresh `ops/reference-fingerprint.txt` and run every `ops/test-db/*-smoke.sql` (each line must say ok, or show the expected refusals).
3. `bash test/run-all.sh`: every line PASS.
4. Deploy: copy to the Pages repo, commit, push, and check that the Pages run and the Netlify deploy (`petti-app`) both succeeded.
5. Announce (above).
6. SQL containing DELETE or DROP is refused by the migration tool: give it to the owner as a "run in Supabase" file instead.

## Website (usepetti.com)

Plain files in `site/` (Netlify project `usepetti`, deploys on every push to main, so a site change goes live when pushed). Every claim on it must match the app; business terms (prices, trial, setup fee) only as the owner approved them. Pictures are real screens from the preview, never edited: `node ops/site-shots.mjs ops/shots/site.json` (fixed clock, "Demo Company"). `node test/site-test.mjs` must say PASS (layout at three widths, links, menu, keyboard, the trial form without sending).

## Health check

Every weekday at 10:11 (Windhoek) a scheduled task runs `select public.health_report(26)` (db/039) and checks that app.usepetti.com and usepetti.com load. It pushes to the owner's phone only when something is wrong: a failed scheduled job, no nightly copy (or one with fewer tables than the night before), failed calls to the server functions, or 10+ errors from phones. Run it yourself at the start of a session too. A new table that holds records goes into `TABLES` in `functions/backup/index.ts`.

Every night at 02:30 UTC `functions/offsite` (db/040) sends the latest records copy and every new or changed receipt, pack and logo to Tuvana Tech's own Backblaze bucket (EU Central, Amsterdam), with a key that can only add files. It also does a practice restore of exactly what it sent (`restore_check` loads each table's rows into a scratch copy). Runs are in `public.offsite_runs`; the health check reports failures. It does nothing until the four secrets `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_ENDPOINT` are set (the owner adds them; never handle the keys yourself).

## Plans and cancelling (db/041)

Each client's plan limits how many people (accounts switched on) and branches it can have; Admin → People shows the places used and blocks adding beyond them, and the database enforces the same. Tuvana Tech sets the plan, never the client: `update public.subscription set plan = 'business', people_limit = 30, branch_limit = 3, status = 'active' where id = 1;` (starter 10/1, business 30/3, group as agreed; `ops/new-client.mjs` sets it from the client file's `plan`). A plan of null shows nothing and limits nothing. Setting or changing a client's plan changes what its GM sees: announce it to the GM.

The GM cancels under Admin → Settings → Your Petti subscription, after being offered "Download everything". Petti stays open 30 days (the GM can keep it); the daily health check alerts on the day of cancelling (stop billing) and on the removal day: then remove the client's Supabase project and empty its Backblaze bucket, as the terms promise.

## Payment requests (db/042)

"Request a payment" (type `cash`) is one form for anything that is not office stock: the requester attaches the supplier's quote or invoice on the form (filed while the request is still a draft), or ticks "No quote" (`no_quote` is stamped when it is sent).

## Where petty cash is, and how it is paid (db/043)

Each branch's petty cash is in the cash box and, when the branch has one (`branches.petty_bank_name`, set under Petty cash), the petty cash bank account. When the account is added, finance enters what is in it from the statement (db/044: `set_petty_bank(name, opening, note)`, once, before any bank movement; booked as a `carry_over` into the bank, so not in the journal; the GM is told). Every movement has a `place` (box / bank); `withdrawal` (bank → box) and `deposit` (box → bank) move money between them (`move_cash`, with a slip photo or a note; the GM is told). `float_balance` is the box, `float_bank_balance` the bank; `v_floats` keeps its old columns for the box and adds the bank's. Cash counts check the box; `check_bank` compares the statement (a `cash_counts` row with `place = 'bank'`), signed off by the GM the same way. The close (`close_float` with `p_statement`) does both, and the next month carries both over.

Finance pays a request in cash from the box, or by transfer (`pay_by_transfer`, only with a quote or invoice, always with the proof of payment uploaded to the request's folder): from the petty cash bank account (`paid_from = 'petty_cash'`, part of the float) or from the company account (`'company'`, finance only (db/045): a direct payment outside petty cash, not in `v_spend_lines`, budgets or the journal; listed apart in the pack and Reports). A transfer waits in `proof_review` (shown as "Waiting for the supplier") until the requester taps "Supplier confirmed" (`confirm_supplier`; finance can, with a reason). Whoever is handed cash confirms it (`confirm_cash`: Yes, or No with a note → GM and finance told, exceptions log); unanswered by the next working day is chased once. The journal credits the box (`petty_cash_account`) or the bank (`petty_bank_account`, default `PETTY-CASH-BANK`).

## Open items (as of 1 Nov 2026)

- MGP has no plan set yet: the owner decides (Business, or the founding price) before it is set and announced to the GM.
- Privacy notice and terms of service: drafts in Claude Docs, with a Namibian lawyer; publish as usepetti.com/privacy and /terms only once approved, then link them from the footer and the trial form.
- Email via Resend (owner sets up; then redeploy send-notifications, send-push, send-pack, account-mail).
- Owner runs `db/018b_run_in_supabase.sql` and `db/026b_run_in_supabase.sql`. The unused `stock_adjust_raise_v1` can be dropped at the same time.
- MGP's logo: the GM uploads it under Admin → Settings → Company logo (the light-background version). The accounting package name, and Magreth loading the catalogue.
- Two-step sign-in is required for finance, the GM and the MD from the date in settings (`two_step_from`, set to 14 days after release 038). Before that date, confirm someone has set it up successfully on live; if setting up fails, move the date (Admin → Settings) before anyone is locked out. A lost phone: the GM (or the MD) resets it under Admin → People; the GM's own can also be cleared in the Supabase dashboard (Authentication → Users).
