// send-push: delivers one in-app notification to the person's phone(s) via Web Push.
// Called by a database trigger (x-cron-key) with {id}; a signed-in user may also POST {test:true} to buzz their own devices.
// Keys live in app_config (vapid_public / vapid_private); nothing to configure by hand.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

// alerts that need the person to act stay on screen until dealt with
const URGENT = new Set(["approval", "payout", "cash_ready", "proof", "stock_review", "returned", "physical", "advance_overdue"]);
async function unreadFor(userId: string) {
  const { count } = await admin.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", userId).is("read_at", null);
  return count ?? 0;
}

async function config() {
  const { data } = await admin.from("app_config").select("key, value").in("key", ["cron_key", "vapid_public", "vapid_private"]);
  return Object.fromEntries((data || []).map((r) => [r.key, r.value])) as Record<string, string>;
}

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };
async function pushTo(subs: Sub[], payload: Record<string, unknown>) {
  let sent = 0, gone = 0, failed = 0;
  const body = JSON.stringify(payload);
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 86400, urgency: "high" }); // a phone out of signal still gets it within a day
      sent++;
      await admin.from("push_subscriptions").update({ last_used_at: new Date().toISOString(), failed_at: null, fail_reason: null }).eq("id", s.id);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) { gone++; await admin.from("push_subscriptions").delete().eq("id", s.id); }
      else { failed++; await admin.from("push_subscriptions").update({ failed_at: new Date().toISOString(), fail_reason: String((e as Error).message || code).slice(0, 200) }).eq("id", s.id); }
    }
  }
  return { sent, gone, failed };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const cfg = await config();
  if (!cfg.vapid_public || !cfg.vapid_private) return json({ error: "Push keys are not configured" }, 503);
  const { data: settings } = await admin.from("settings").select("org_name, app_url").eq("id", 1).single();
  webpush.setVapidDetails("mailto:petty-cash@tuvana.tech", cfg.vapid_public, cfg.vapid_private);
  let body: { id?: string; test?: boolean };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  // a signed-in person testing their own phone
  if (body.test) {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Sign in first" }, 401);
    const asUser = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "Sign in first" }, 401);
    const { data: subs } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", user.id);
    if (!subs?.length) return json({ error: "No phone is switched on for alerts yet" }, 404);
    const r = await pushTo(subs as Sub[], { title: "Alerts are on", body: `${settings?.org_name || "Petty cash"} will buzz you here when something needs you.`, link: "#/notifications", tag: "test", unread: await unreadFor(user.id), at: new Date().toISOString() });
    return json(r);
  }

  if (req.headers.get("x-cron-key") !== cfg.cron_key) return json({ error: "forbidden" }, 403);
  if (!body.id) return json({ error: "id is required" }, 400);
  const { data: n } = await admin.from("notifications").select("id, user_id, kind, title, body, link, request_id, created_at").eq("id", body.id).maybeSingle();
  if (!n) return json({ error: "Notification not found" }, 404);
  const { data: subs } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", n.user_id);
  if (!subs?.length) { await admin.from("notifications").update({ push_status: "no_device" }).eq("id", n.id); return json({ sent: 0, reason: "no_device" }); }
  const r = await pushTo(subs as Sub[], {
    title: n.title, body: n.body || "", link: n.link || "#/notifications", id: n.id, at: n.created_at,
    tag: n.request_id ? `r-${n.request_id}` : `n-${n.id}`,   // one alert per request on the lock screen; others stack
    urgent: URGENT.has(n.kind), unread: await unreadFor(n.user_id),
  });
  await admin.from("notifications").update({ pushed_at: r.sent ? new Date().toISOString() : null, push_status: r.sent ? `sent:${r.sent}` : `failed:${r.failed} gone:${r.gone}` }).eq("id", n.id);
  return json(r);
});
