// account-mail: the emails around an account – welcome / invitation, password reset, sign-in link.
// All go through Resend from the organisation's own address (settings.email_from). Without RESEND_API_KEY the
// function still produces the one-time link so the administrator can pass it on by hand.
// Actions:
//   welcome    { user_id }   approver only  -> { sent, link, email, message }
//   reset      { email }     public         -> { sent, reason }   (one per address every 2 minutes; never says whether the address exists)
//   magiclink  { email }     public         -> { sent, reason }
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY");
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

const ROLE_LABEL: Record<string, string> = { requester: "Requester", stock_manager: "Stock manager", finance: "Finance", approver: "Approver (administrator)" };
const ROLE_TEXT: Record<string, string[]> = {
  requester: [
    "Need something? Ask for cash (or a stock item) from your Home – small amounts go straight to finance, larger ones to the approver.",
    "Bought it? Snap or upload the receipt; the app reads it and files it against your request.",
    "Paid from your own pocket? Snap the receipt – it becomes a claim and you are paid back once it is signed off.",
  ],
  finance: [
    "Everything waiting for you is on your Home: pay-outs, receipts to check, cash out too long.",
    "You pay out from the float, people snap their receipts, and you confirm them in the app.",
    "At month-end you close the month and the pack with every receipt builds itself for your review before it goes to the accountant.",
  ],
  stock_manager: [
    "The team reports what is running low; the reports land on your Home, grouped by item.",
    "You issue from the store or tick what to buy and raise one restock order – approver, then finance.",
    "A quick count once a week keeps the stock figures honest; it works without signal.",
  ],
  approver: [
    "Only approvals are yours; each shows what the float can carry after it.",
    "Claims (money spent before approval) always pass you; Reports shows the month at a glance.",
    "You run Admin: people, stand-ins, budgets and settings.",
  ],
};

async function settings() {
  const { data } = await admin.from("settings").select("org_name, email_from, app_url").eq("id", 1).single();
  return { org: data?.org_name || "Petty cash", from: data?.email_from || null, app: (data?.app_url || "").replace(/\/?$/, "/") };
}
async function caller(req: Request) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: profile } = await admin.from("profiles").select("*").eq("id", data.user.id).single();
  return profile;
}
// The link points at the app itself, which finishes the sign-in with the token – so it never depends on the
// project's "Site URL" / redirect allow-list and can never land on localhost.
async function link(type: "recovery" | "magiclink", email: string, app: string) {
  const { data, error } = await admin.auth.admin.generateLink({ type, email, options: { redirectTo: app } });
  if (error) throw error;
  const th = data.properties?.hashed_token as string;
  if (!th) throw new Error("Could not create a sign-in link");
  return `${app}#/verify?th=${encodeURIComponent(th)}&type=${type}`;
}
async function send(to: string, subject: string, text: string, html: string, from: string | null) {
  if (!RESEND) return { sent: false, reason: "no_provider" };
  if (!from) return { sent: false, reason: "no_sender" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  if (!res.ok) return { sent: false, reason: `resend_${res.status}: ${(await res.text()).slice(0, 200)}` };
  return { sent: true, reason: null };
}
async function tooSoon(email: string, kind: string) {
  const { data } = await admin.from("mail_log").select("at").eq("email", email).eq("kind", kind).gte("at", new Date(Date.now() - 2 * 60 * 1000).toISOString()).limit(1);
  return !!data?.length;
}
function shell(org: string, title: string, bodyHtml: string) {
  return `<!doctype html><html><body style="margin:0;background:#eef1ec;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#19231f">
<div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #d6dbd4;border-radius:8px;padding:24px">
<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px"><span style="display:inline-block;background:#1b5e4b;color:#fff;font-weight:700;border-radius:6px;padding:4px 8px">N$</span><strong>${esc(org)} · Petty cash &amp; stock</strong></div>
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>${bodyHtml}
<p style="color:#7b857f;font-size:12px;margin-top:24px">If you were not expecting this email, you can ignore it.</p></div></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body.action || "");
  try {
    const s = await settings();
    if (!s.app) throw new Error("Set the link to the app under Admin → Settings first");

    if (action === "welcome") {
      const me = await caller(req);
      if (!me || me.role !== "approver" || !me.active) return json({ error: "Only the administrator can send invitations" }, 403);
      const user_id = String(body.user_id || "");
      const { data: u } = await admin.from("profiles").select("id, email, full_name, role, active").eq("id", user_id).single();
      if (!u) throw new Error("Person not found");
      if (!u.active) throw new Error("This account is deactivated");
      const url = await link("recovery", u.email, s.app);
      const first = (u.full_name || "").split(" ")[0] || "there";
      const lines = ROLE_TEXT[u.role] || ROLE_TEXT.requester;
      const subject = `Your ${s.org} Petti account – set your password`;
      const text = `Hi ${first},\n\n${me.full_name || "The administrator"} has set you up on Petti, ${s.org}'s petty cash & stock app, as ${ROLE_LABEL[u.role]}.\n\nWhat that means for you:\n${lines.map((l) => `• ${l}`).join("\n")}\n\nSet your password and sign in here (one-time link):\n${url}\n\nAfterwards the app lives at ${s.app} – add it to your phone's home screen from More → Account → “Put it on your phone”.\n\nIf the link has expired, ask ${me.full_name || "the administrator"} for a new one.`;
      const html = shell(s.org, `Hi ${esc(first)}, your account is ready`,
        `<p>${esc(me.full_name || "The administrator")} has set you up on Petti, <strong>${esc(s.org)}</strong>'s petty cash &amp; stock app, as <strong>${esc(ROLE_LABEL[u.role])}</strong>.</p>
<p><strong>What that means for you</strong></p><ol style="padding-left:20px;color:#4a5550">${lines.map((l) => `<li style="margin:6px 0">${esc(l)}</li>`).join("")}</ol>
<p style="margin:20px 0"><a href="${url}" style="display:inline-block;background:#1b5e4b;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:600">Set your password and sign in</a></p>
<p style="color:#4a5550;font-size:14px">The link works once. Afterwards the app lives at <a href="${s.app}">${s.app}</a> – add it to your phone's home screen from More → Account → “Put it on your phone”.</p>`);
      const r = await send(u.email, subject, text, html, s.from);
      await admin.from("mail_log").insert({ email: u.email, kind: "welcome", sent: r.sent, detail: r.reason });
      // the message the administrator can paste into WhatsApp when email is not available
      const message = `Hi ${first}, your account on Petti, ${s.org}'s petty cash & stock app, is ready (role: ${ROLE_LABEL[u.role]}). Open this link once to set your password and sign in: ${url}  — afterwards the app is at ${s.app}`;
      return json({ sent: r.sent, reason: r.reason, link: url, email: u.email, message });
    }

    if (action === "reset" || action === "magiclink") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!EMAIL.test(email)) throw new Error("Enter a valid email address");
      if (!RESEND || !s.from) return json({ sent: false, reason: "no_provider" });
      if (await tooSoon(email, action)) return json({ sent: true, reason: null });   // quietly: no second email within two minutes
      await admin.from("mail_log").insert({ email, kind: action });
      const { data: u } = await admin.from("profiles").select("id, email, full_name, active").eq("email", email).maybeSingle();
      if (!u || !u.active) return json({ sent: true, reason: null });            // never reveal whether an address exists
      const url = await link(action === "reset" ? "recovery" : "magiclink", u.email, s.app);
      const first = (u.full_name || "").split(" ")[0] || "there";
      const subject = action === "reset" ? `Reset your ${s.org} Petti password` : `Sign in to Petti – ${s.org}`;
      const what = action === "reset" ? "set a new password" : "sign in";
      const text = `Hi ${first},\n\nUse this one-time link to ${what}:\n${url}\n\nIt expires soon; if it has, ask for a new one from the sign-in page.`;
      const html = shell(s.org, action === "reset" ? "Set a new password" : "Sign in", `<p>Hi ${esc(first)}, use this one-time link to ${what}:</p><p style="margin:20px 0"><a href="${url}" style="display:inline-block;background:#1b5e4b;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:600">${action === "reset" ? "Set a new password" : "Sign in"}</a></p><p style="color:#4a5550;font-size:14px">It expires soon; if it has, ask for a new one from the sign-in page.</p>`);
      const r = await send(u.email, subject, text, html, s.from);
      if (!r.sent) await admin.from("mail_log").insert({ email, kind: `${action}_failed`, sent: false, detail: r.reason });
      return json({ sent: r.sent, reason: r.reason });
    }

    return json({ error: `Unknown action "${action}"` }, 400);
  } catch (e) {
    return json({ error: (e as { message?: string })?.message ?? String(e) }, 400);
  }
});
