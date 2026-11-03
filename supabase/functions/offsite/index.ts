// offsite: a second copy at another company. Called nightly by the scheduler (x-cron-key), half an hour after "backup".
//  1. Sends the latest nightly copy of the records (the JSON files in "backups") to the Backblaze bucket, under
//     records/<run>/, and proves it can be restored: each file's rows are loaded back into a scratch copy of its table.
//  2. Sends every stored file that is new or changed (receipt photos, month-end packs, the logo) under files/<bucket>/,
//     oldest first, for up to ~100 seconds; whatever is left goes the next night.
// The Backblaze key is "Write Only": it can add files but not read or remove them, so the copies stay safe even if this
// server were misused. Settings (Edge Functions → Secrets), from the owner's Backblaze account:
//   B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_ENDPOINT (the bucket's S3 endpoint, e.g. s3.eu-central-003.backblazeb2.com).
// Until all four are there it does nothing. Every run is written to public.offsite_runs; the daily health check reads it.
import { createClient } from "npm:@supabase/supabase-js@2";
import { b2Settings, uploader } from "./b2.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const env = (k: string) => (Deno.env.get(k) || "").trim();
const errText = (e: unknown) => (e as { message?: string })?.message ?? String(e);
const BUDGET_MS = 100_000;
const BATCH = 50;

async function download(bucket: string, name: string) {
  const { data, error } = await admin.storage.from(bucket).download(name);
  if (error || !data) throw new Error(`${bucket}/${name}: ${error?.message ?? "missing"}`);
  return { bytes: new Uint8Array(await data.arrayBuffer()), type: data.type };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const { data: cfg } = await admin.from("app_config").select("value").eq("key", "cron_key").maybeSingle();
  if (!cfg || req.headers.get("x-cron-key") !== cfg.value) return json({ error: "forbidden" }, 403);
  const s = b2Settings(env);
  if (!s) return json({ skipped: "Backblaze is not set up yet" });
  const put = uploader(s);
  const t0 = Date.now();

  const { data: prev } = await admin.from("offsite_runs").select("records_run, files_upto").order("id", { ascending: false }).limit(1).maybeSingle();
  const { data: run, error: re } = await admin.from("offsite_runs").insert({ records_run: prev?.records_run ?? null, files_upto: prev?.files_upto ?? null }).select("id").single();
  if (re) return json({ error: re.message }, 500);
  const out = { records_run: prev?.records_run ?? null as string | null, files_upto: prev?.files_upto ?? null as string | null, files_sent: 0, bytes_sent: 0, skipped: 0,
    more: false, restore_ok: null as boolean | null, restore_note: null as string | null, error: null as string | null };

  try {
    // 1. the latest nightly copy of the records, once
    const { data: runs, error: le } = await admin.storage.from("backups").list("", { limit: 100, sortBy: { column: "name", order: "desc" } });
    if (le) throw le;
    const latest = (runs || []).map((f) => f.name).filter(Boolean).sort().reverse()[0];
    if (latest && latest !== out.records_run) {
      const { data: files, error: fe } = await admin.storage.from("backups").list(latest, { limit: 200 });
      if (fe) throw fe;
      const notes: string[] = [];
      for (const f of files || []) {
        const { bytes } = await download("backups", `${latest}/${f.name}`);
        await put(`records/${latest}/${f.name}`, bytes, "application/json");
        out.files_sent++; out.bytes_sent += bytes.length;
        // the practice restore of exactly what was sent
        const table = f.name.replace(/\.json$/, "");
        try {
          const rows = JSON.parse(new TextDecoder().decode(bytes));
          const { data: n, error: ce } = await admin.rpc("restore_check", { p_table: table, p_rows: rows });
          if (ce) notes.push(`${table}: ${ce.message}`);
          else if (n !== rows.length) notes.push(`${table}: ${n} of ${rows.length} rows went back`);
        } catch (e) { notes.push(`${table}: ${errText(e)}`); }
      }
      out.records_run = latest;
      out.restore_ok = notes.length === 0;
      out.restore_note = notes.length ? notes.join("; ").slice(0, 1000) : `${(files || []).length} tables restored`;
    }

    // 2. stored files that are new or changed, oldest first, while time allows
    outer: while (true) {
      const { data: batch, error: pe } = await admin.rpc("offsite_pending", { p_since: out.files_upto, p_limit: BATCH });
      if (pe) throw pe;
      for (const o of (batch || []) as { bucket_id: string; name: string; changed_at: string }[]) {
        if (Date.now() - t0 > BUDGET_MS) { out.more = true; break outer; }
        let file: { bytes: Uint8Array; type: string } | null = null;
        try { file = await download(o.bucket_id, o.name); } catch { out.skipped++; }  // removed since it was listed
        if (file) {
          await put(`files/${o.bucket_id}/${o.name}`, file.bytes, file.type);
          out.files_sent++; out.bytes_sent += file.bytes.length;
        }
        out.files_upto = o.changed_at;
      }
      if (!batch || batch.length < BATCH) break;
    }
  } catch (e) {
    out.error = errText(e).slice(0, 500);
  }
  await admin.from("offsite_runs").update({ finished_at: new Date().toISOString(), ...out }).eq("id", run.id);
  return json({ run: run.id, ...out });
});
