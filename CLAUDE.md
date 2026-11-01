# Petti – working rules

Petti is Tuvana Tech's petty cash and office-stock app. MGP (Namibia) is the first client: Supabase project `ytfgzfaogfrzanrpcpkg`, app on GitHub Pages (`tuvanatech-arch/petty-cash`).

## How to reply

- Start every reply with the model and effort level in bold, e.g. **Model: Claude Opus 5.5 · effort: low.**
- Plain language. The owner is not a developer: no jargon, short questions, and a recommendation rather than a menu.
- Treat instructions as proposals: suggest a better way when there is one, and avoid over-engineering.

## Every update that affects people is announced to them

Whenever a release changes what someone sees or does, tell exactly those people, in the app and on their phone:

1. **Who:** target by role (`requester`, `stock_manager`, `finance`, `approver` = GM, `managing_director` = MD), by branch, or by named person. Use "everyone" only when it really affects everyone.
2. **What changes for them:** one or two plain sentences written for that role. If the impact differs by role, send one note per role.
3. **How to use it:** short numbered steps, with the exact screen and button names from the code (check them before writing).
4. **Show me:** a link to the screen it is about.
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
```

Notes appear as an alert (pushed to phones that have alerts on, never emailed), as a one-time window when the app opens, and under What's new. Admin → Updates shows who has read each note.

## Releasing

1. A database change is always a new numbered file in `db/` (applied to live with the same content). Never change the live database by hand without saving the file. That is how the files and live drifted apart before `029z`.
2. `ops/test-db/replay.sh` must end in **REPLAY OK**. Then refresh `ops/reference-fingerprint.txt` and run `ops/test-db/workflow-smoke.sql` and `ops/test-db/updates-smoke.sql`.
3. `bash test/run-all.sh`: every line PASS.
4. Deploy: copy to the Pages repo, commit, push, and check that the Pages run succeeded.
5. Announce (above).
6. SQL containing DELETE or DROP is refused by the migration tool: give it to the owner as a "run in Supabase" file instead.

## Open items (as of 1 Nov 2026)

- Email via Resend (owner sets up; then redeploy send-notifications, send-push, send-pack, account-mail).
- Owner runs `db/018b_run_in_supabase.sql` and `db/026b_run_in_supabase.sql`. The unused `stock_adjust_raise_v1` can be dropped at the same time.
- Domain: usepetti.com (app at app.usepetti.com) once bought.
- MGP's logo, the accounting package name, and Magreth loading the catalogue.
