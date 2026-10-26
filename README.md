# Petty cash & stock

A small office's petty cash and consumables system: requests, approvals above the threshold, cash-out with scanned proof, finance confirmation, store stock with usage tracking, claims, budgets, alerts, and a month-end PDF pack.

- The app is static (no build step) and runs on GitHub Pages from this repository's root.
- Data, auth, storage and workflow rules live in Supabase (`supabase/` holds the SQL and the edge functions for reference).
- `js/config.js` holds the Supabase URL and the publishable (anon) key — the only key the browser ever sees; row-level security does the rest.
- Installable on a phone (Add to Home Screen); quick stock counts work offline and sync later.
