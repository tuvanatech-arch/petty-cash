# Setting up Petti for a new client

Each client gets its own copy: its own database, server functions and app address. Their records never share a database with another client's.

## 1. Describe the client

Copy `clients/example-lobito.json` to `clients/<slug>.json` and fill it in:

| Field | What it is |
|---|---|
| `slug` | short name used for folders, e.g. `oshana-traders` |
| `org_name`, `company_code` | the company as it appears on every record, and a 2–4 letter code |
| `branch_name`, `branch_code` | the first branch (more are added in the app) |
| `currency`, `currency_code` | the symbol on screen (`N$`, `Kz `, `R`) and the ISO code (`NAD`, `AOA`, `ZAR`) |
| `time_zone`, `number_locale` | e.g. `Africa/Windhoek` + `en-NA`, or `Africa/Luanda` + `pt-AO` |
| `titles` | what they call the two approvers; leave out for GM / MD |
| `schedule_ref`, `policy_ref` | their document numbers for the authority schedule and policy (optional) |
| `supabase_url`, `publishable_key` | from the client's new Supabase project (Settings → API) |
| `app_url` | where the app will live, e.g. `https://app.usepetti.com/oshana/` |

Client files other than the examples are ignored by git: they describe a customer.

## 2. Build and install

```
node ops/new-client.mjs clients/<slug>.json                       # builds out/<slug>/
DATABASE_URL=... SUPABASE_ACCESS_TOKEN=... node ops/new-client.mjs clients/<slug>.json --apply
```

`--apply` loads the database, checks it against `ops/reference-fingerprint.txt` (it must say *matches the reference installation*) and deploys the server functions. `out/<slug>/seed.sql` holds the client's server keys, so never commit or email it.

Then follow `out/<slug>/CHECKLIST.md`. It covers the sign-in settings, secrets, publishing the app, and creating the first administrator straight away.

## 3. Before every release

- `ops/test-db/replay.sh` must end with **REPLAY OK**: every setup file, in order, on a blank database.
- The replay's fingerprint (`psql … -f ops/test-db/fingerprint-summary.sql`) is the new `ops/reference-fingerprint.txt`.
- `ops/test-db/workflow-smoke.sql` runs a request from start to finish (float, request, approval, payout, receipt, reports) and rolls it back.
- A change to the database is always a new numbered file in `db/`, never a change made straight on a live database. That is how MGP's live database and these files drifted apart before `029z`.
