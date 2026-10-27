// send-pack: emails a month-end pack (the stored PDF) to the senior accountant, cc the approver(s), and records it.
// Caller must be finance or the approver. Secrets: RESEND_API_KEY (required to send).
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const monthLabel = (d: string) => new Date(d.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

function toB64(bytes: Uint8Array) {
  let s = ""; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Sign in first" }, 401);
  let body: { pack_id?: string; note?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (!body.pack_id) return json({ error: "pack_id is required" }, 400);

  // who is calling, and may they send?
  const asUser = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: roles } = await asUser.rpc("my_roles");
  const allowed = Array.isArray(roles) && (roles.includes("finance") || roles.includes("approver"));
  if (!allowed) return json({ error: "Only finance or the approver can send the pack" }, 403);
  const { data: { user } } = await asUser.auth.getUser();
  const { data: sender } = await admin.from("profiles").select("id, full_name, email").eq("id", user!.id).single();

  const { data: pack } = await admin.from("packs").select("*").eq("id", body.pack_id).maybeSingle();
  if (!pack) return json({ error: "Pack not found" }, 404);
  const { data: settings } = await admin.from("settings").select("org_name, currency, email_from, app_url, accountant_email, accountant_name").eq("id", 1).single();
  if (!settings?.accountant_email) return json({ error: "No accountant email is set. Add it under Admin → Settings first." }, 400);
  const RESEND = Deno.env.get("RESEND_API_KEY");
  if (!RESEND) return json({ error: "Email is not switched on yet (no RESEND_API_KEY). Download the pack and send it yourself, then mark it as sent." }, 503);

  const { data: file, error: de } = await admin.storage.from("packs").download(pack.storage_path);
  if (de || !file) return json({ error: "Could not fetch the pack file" }, 500);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > 38 * 1024 * 1024) return json({ error: "The pack is larger than the email limit (38 MB). Download it and send it another way, then mark it as sent." }, 413);

  const { data: approvers } = await admin.from("profiles").select("email").eq("role", "approver").eq("active", true);
  const cc = [...new Set([...(approvers || []).map((a) => a.email), sender?.email].filter(Boolean))] as string[];
  const month = monthLabel(pack.period);
  const s = pack.summary || {};
  const cur = settings.currency || "N$";
  const money = (v: unknown) => `${cur}${Number(v || 0).toLocaleString("en-NA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const rows = [
    ["Allocated", money(s.allocated)], s.topped_up > 0 ? ["Top-ups", money(s.topped_up)] : null, s.carried_over > 0 ? ["Carried over", money(s.carried_over)] : null,
    ["Spent", money(s.spent)], ["Closing balance (book)", money(s.balance)], s.counted_cash != null ? ["Cash counted", money(s.counted_cash)] : null,
    s.counted_cash != null ? ["Difference", money(Number(s.counted_cash) - Number(s.balance))] : null,
    ["Vouchers", String(s.vouchers ?? "")], s.missing_proofs > 0 ? ["Vouchers without a scanned receipt", String(s.missing_proofs)] : null,
  ].filter(Boolean) as string[][];
  const html = `<!doctype html><html><body style="margin:0;background:#eef1ec;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #d6dbd4;border-radius:8px;padding:24px">
    <div style="font-size:13px;color:#7b857f;margin-bottom:12px">${esc(settings.org_name)} · petty cash</div>
    <div style="font-size:18px;font-weight:600;color:#19231f;margin-bottom:6px">Petty cash pack – ${esc(month)}</div>
    <p style="color:#4a5550;margin:0 0 14px">Hi ${esc((settings.accountant_name || "").split(" ")[0] || "there")}, attached is the petty cash pack for ${esc(month)}: reconciliation, every voucher and the receipts, reviewed by ${esc(sender?.full_name || "finance")}.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `<tr><td style="padding:6px 0;border-bottom:1px solid #e3e7e2;color:#4a5550">${esc(k)}</td><td style="padding:6px 0;border-bottom:1px solid #e3e7e2;text-align:right;color:#19231f;font-weight:600">${esc(v)}</td></tr>`).join("")}</table>
    ${body.note ? `<p style="margin:14px 0 0;color:#19231f"><strong>Note from ${esc(sender?.full_name || "finance")}:</strong> ${esc(body.note)}</p>` : ""}
    <p style="font-size:12px;color:#7b857f;margin-top:18px">Sent from the petty cash system${settings.app_url ? ` (${esc(settings.app_url)})` : ""}.</p>
  </div></body></html>`;
  const text = `Petty cash pack – ${month}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}${body.note ? `\n\nNote: ${body.note}` : ""}\n\nThe pack is attached as a PDF.`;

  let ok = false, detail = "";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: settings.email_from || "Petty Cash <onboarding@resend.dev>", to: [settings.accountant_email], cc,
        subject: `Petty cash pack – ${month} – ${settings.org_name}`, html, text,
        attachments: [{ filename: pack.file_name, content: toB64(bytes) }],
      }),
    });
    ok = res.ok; detail = ok ? "sent" : `error ${res.status}: ${(await res.text()).slice(0, 200)}`;
  } catch (e) { detail = `error: ${(e as Error).message}`.slice(0, 200); }
  if (!ok) {
    await admin.from("packs").update({ send_status: detail }).eq("id", pack.id);
    return json({ error: `The email could not be sent (${detail}). Fix the email setup or download the pack and send it another way.` }, 502);
  }
  const now = new Date().toISOString();
  await admin.from("packs").update({ status: "sent", sent_at: now, sent_by: sender?.id, sent_to: settings.accountant_email, send_status: "sent", note: body.note || null }).eq("id", pack.id);
  const title = `Month-end pack sent to the accountant: ${month}`;
  const bodyTxt = `Emailed to ${settings.accountant_email} by ${sender?.full_name || "finance"}.`;
  const { data: staff } = await admin.from("profiles").select("id, role").eq("active", true).in("role", ["approver", "finance"]);
  for (const p of staff || []) await admin.from("notifications").insert({ user_id: p.id, kind: "pack_sent", title, body: bodyTxt, link: `#/cash/pack/${pack.float_id}` });
  return json({ ok: true, sent_to: settings.accountant_email, cc });
});
