// send-notifications: emails unsent in-app notifications, one digest per person, via Resend.
// Called by pg_cron every 5 minutes with header x-cron-key = app_config.cron_key.
// Secrets: RESEND_API_KEY (optional until set – rows are marked "no_provider" and left alone).
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

type Row = { id: string; user_id: string; kind: string; title: string; body: string | null; link: string | null; created_at: string; email_attempts: number };

function render(name: string, rows: Row[], org: string, appUrl: string) {
  const items = rows.map((r) => {
    const href = appUrl && r.link ? `${appUrl.replace(/\/+$/, "")}/${r.link}` : "";
    return `<tr><td style="padding:10px 0;border-bottom:1px solid #e3e7e2">
      <div style="font-weight:600;color:#19231f">${href ? `<a href="${href}" style="color:#1b5e4b;text-decoration:none">${esc(r.title)}</a>` : esc(r.title)}</div>
      ${r.body ? `<div style="color:#4a5550;font-size:14px;margin-top:2px">${esc(r.body)}</div>` : ""}</td></tr>`;
  }).join("");
  const html = `<!doctype html><html><body style="margin:0;background:#eef1ec;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #d6dbd4;border-radius:8px;padding:24px">
    <div style="font-size:13px;color:#7b857f;margin-bottom:12px">${esc(org)} · Petti</div>
    <div style="font-size:16px;color:#19231f;margin-bottom:8px">Hi ${esc(name.split(" ")[0] || "there")}, ${rows.length === 1 ? "something is" : rows.length + " things are"} waiting on you.</div>
    <table style="width:100%;border-collapse:collapse">${items}</table>
    ${appUrl ? `<p style="margin:18px 0 0"><a href="${esc(appUrl)}" style="display:inline-block;background:#1b5e4b;color:#fff;padding:9px 14px;border-radius:6px;text-decoration:none;font-weight:600">Open the app</a></p>` : ""}
    <p style="font-size:12px;color:#7b857f;margin-top:18px">You can switch these emails off under Account in the app. Petti by Tuvana Tech.</p>
  </div></body></html>`;
  const text = rows.map((r) => `• ${r.title}${r.body ? `\n  ${r.body}` : ""}${appUrl && r.link ? `\n  ${appUrl.replace(/\/+$/, "")}/${r.link}` : ""}`).join("\n\n");
  return { html, text };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const { data: cfg } = await admin.from("app_config").select("value").eq("key", "cron_key").maybeSingle();
  if (!cfg || req.headers.get("x-cron-key") !== cfg.value) return json({ error: "forbidden" }, 403);

  const { data: settings } = await admin.from("settings").select("org_name, email_from, app_url").eq("id", 1).single();
  const since = new Date(Date.now() - 2 * 86400000).toISOString();
  const { data: rows, error } = await admin.from("notifications")
    .select("id, user_id, kind, title, body, link, created_at, email_attempts")
    .is("emailed_at", null).lt("email_attempts", 3).gte("created_at", since).order("created_at").limit(300);
  if (error) return json({ error: error.message }, 500);
  if (!rows?.length) return json({ sent: 0, skipped: 0 });

  const RESEND = Deno.env.get("RESEND_API_KEY");
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const { data: users } = await admin.from("profiles").select("id, email, full_name, email_notifications, active").in("id", userIds);
  const now = new Date().toISOString();
  let sent = 0, skipped = 0, failed = 0;

  for (const u of users ?? []) {
    const mine = (rows as Row[]).filter((r) => r.user_id === u.id);
    const ids = mine.map((r) => r.id);
    if (!u.active || !u.email_notifications || !u.email) {
      await admin.from("notifications").update({ emailed_at: now, email_status: "opted_out" }).in("id", ids);
      skipped += ids.length; continue;
    }
    if (!RESEND) {
      await admin.from("notifications").update({ emailed_at: now, email_status: "no_provider" }).in("id", ids);
      skipped += ids.length; continue;
    }
    const { html, text } = render(u.full_name || "", mine, settings?.org_name || "Petty cash", settings?.app_url || "");
    const subject = mine.length === 1 ? mine[0].title : `${mine.length} things waiting for you in Petti`;
    let ok = false, detail = "";
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: settings?.email_from || "Petty Cash <onboarding@resend.dev>", to: [u.email], subject, html, text }),
      });
      ok = res.ok; detail = ok ? "sent" : `error ${res.status}: ${(await res.text()).slice(0, 180)}`;
    } catch (e) { detail = `error: ${(e as Error).message}`.slice(0, 200); }
    if (ok) {
      await admin.from("notifications").update({ emailed_at: now, email_status: "sent" }).in("id", ids);
      sent += ids.length;
    } else {
      for (const r of mine) await admin.from("notifications").update({ email_status: detail, email_attempts: (r.email_attempts || 0) + 1 }).eq("id", r.id);
      failed += ids.length;
    }
  }
  return json({ sent, skipped, failed });
});
