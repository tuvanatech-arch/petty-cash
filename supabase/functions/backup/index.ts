// backup: copies every application table to the private "backups" bucket as JSON, one folder per run; keeps the last 30 runs.
// Called nightly by the scheduler with x-cron-key. Receipts and packs already live in Storage and are not duplicated.
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const TABLES = ["settings", "profiles", "categories", "suppliers", "items", "stock_movements", "stock_reports", "requests", "request_lines", "request_events", "request_messages",
  "expenses", "expense_lines", "expense_proofs", "receipt_inbox", "floats", "float_transactions", "packs", "budgets", "delegations", "notifications", "push_subscriptions", "invitations",
  "companies", "branches", "fx_rates", "schedule_versions", "cash_counts", "top_ups", "stock_receipts", "stock_adjustments", "exception_reviews", "admin_log", "access_reviews",
  "security_events", "sign_ins", "device_sessions", "request_documents"];

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const { data: cfg } = await admin.from("app_config").select("value").eq("key", "cron_key").maybeSingle();
  if (!cfg || req.headers.get("x-cron-key") !== cfg.value) return json({ error: "forbidden" }, 403);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const result: Record<string, number | string> = {};
  for (const t of TABLES) {
    const rows: unknown[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from(t).select("*").range(from, from + 999);
      if (error) { result[t] = `error: ${error.message}`; break; }
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    if (typeof result[t] === "string") continue;
    const { error: ue } = await admin.storage.from("backups").upload(`${stamp}/${t}.json`, new Blob([JSON.stringify(rows)], { type: "application/json" }), { contentType: "application/json", upsert: true });
    result[t] = ue ? `upload error: ${ue.message}` : rows.length;
  }
  // keep the last 30 runs
  const { data: folders } = await admin.storage.from("backups").list("", { limit: 100, sortBy: { column: "name", order: "desc" } });
  const old = (folders || []).map((f) => f.name).filter((n) => n && n !== stamp).sort().reverse().slice(29);
  for (const f of old) {
    const { data: files } = await admin.storage.from("backups").list(f, { limit: 200 });
    if (files?.length) await admin.storage.from("backups").remove(files.map((x) => `${f}/${x.name}`));
  }
  return json({ run: stamp, tables: result, removed_runs: old });
});
