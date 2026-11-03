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

## Health check

Every weekday at 10:11 (Windhoek) a scheduled task runs `select public.health_report(26)` (db/039) and checks that app.usepetti.com and usepetti.com load. It pushes to the owner's phone only when something is wrong: a failed scheduled job, no nightly copy (or one with fewer tables than the night before), failed calls to the server functions, or 10+ errors from phones. Run it yourself at the start of a session too. A new table that holds records goes into `TABLES` in `functions/backup/index.ts`.

## Open items (as of 1 Nov 2026)

- Email via Resend (owner sets up; then redeploy send-notifications, send-push, send-pack, account-mail).
- Owner runs `db/018b_run_in_supabase.sql` and `db/026b_run_in_supabase.sql`. The unused `stock_adjust_raise_v1` can be dropped at the same time.
- MGP's logo: the GM uploads it under Admin → Settings → Company logo (the light-background version). The accounting package name, and Magreth loading the catalogue.
- Two-step sign-in is required for finance, the GM and the MD from the date in settings (`two_step_from`, set to 14 days after release 038). Before that date, confirm someone has set it up successfully on live; if setting up fails, move the date (Admin → Settings) before anyone is locked out. A lost phone: the GM (or the MD) resets it under Admin → People; the GM's own can also be cleared in the Supabase dashboard (Authentication → Users).
