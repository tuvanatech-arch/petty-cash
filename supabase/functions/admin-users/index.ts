// admin-users: user management for the petty cash & stock app.
// Actions:
//   status          -> { needs_bootstrap }            (no auth)
//   bootstrap       -> create the first administrator (only while no users exist)
//   create          -> create a user with a role and temporary password   (approver only)
//   update          -> change full name / role / email                    (approver only; roles include managing_director)
//   reset_password  -> set a new temporary password                       (approver only)
//   set_active      -> deactivate / reactivate (blocks sign-in)           (approver only)
//   delete          -> remove an account that never did anything           (approver only)
// After any change to people, the authority schedule records who now holds each position.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ROLES = ["requester", "stock_manager", "finance", "approver", "managing_director"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function userCount() {
  const { count, error } = await admin.from("profiles").select("*", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

async function caller(req: Request) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: profile } = await admin.from("profiles").select("*").eq("id", data.user.id).single();
  return profile;
}

// who holds each position is part of the authority schedule: record a new version when it changes (no-op otherwise)
async function syncPositions(by: string) {
  try { await admin.rpc("schedule_positions_sync", { p_by: by }); } catch { /* the next schedule version picks it up */ }
}

function checkPassword(p: unknown) {
  if (typeof p !== "string" || p.length < 8) throw new Error("Password must be at least 8 characters");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const action = String(body.action || "");

  try {
    if (action === "status") {
      return json({ needs_bootstrap: (await userCount()) === 0 });
    }

    if (action === "bootstrap") {
      if ((await userCount()) > 0) return json({ error: "The system already has users. Ask the administrator to add you." }, 403);
      const email = String(body.email || "").trim().toLowerCase();
      const full_name = String(body.full_name || "").trim();
      if (!EMAIL.test(email)) throw new Error("Enter a valid email address");
      if (!full_name) throw new Error("Enter your name");
      checkPassword(body.password);
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: body.password as string,
        email_confirm: true,
        user_metadata: { full_name },
        app_metadata: { invited: true, role: "approver" },
      });
      if (error) throw error;
      return json({ ok: true, user_id: data.user.id });
    }

    const me = await caller(req);
    if (!me || me.role !== "approver" || !me.active) {
      return json({ error: "Only the administrator can manage users" }, 403);
    }

    if (action === "create") {
      const email = String(body.email || "").trim().toLowerCase();
      const full_name = String(body.full_name || "").trim();
      const role = String(body.role || "requester");
      if (!EMAIL.test(email)) throw new Error("Enter a valid email address");
      if (!full_name) throw new Error("Enter the person's name");
      if (!ROLES.includes(role)) throw new Error("Unknown role");
      checkPassword(body.password);
      // The profile trigger reads the role from an open invitation (app_metadata is not yet
      // set when the trigger fires), so record one first.
      const { data: inv, error: invErr } = await admin.from("invitations").insert({ email, full_name, role, invited_by: me.id }).select("id").single();
      if (invErr) throw invErr;
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: body.password as string,
        email_confirm: true,
        user_metadata: { full_name },
        app_metadata: { invited: true, role },
      });
      if (error) {
        await admin.from("invitations").delete().eq("id", inv.id);
        throw new Error(/already/i.test(error.message) ? "That email already has an account" : error.message);
      }
      // the home branch the administrator chose (the profile trigger gave the first branch)
      const branch_id = typeof body.branch_id === "string" && /^[0-9a-f-]{36}$/.test(body.branch_id) ? body.branch_id : null;
      if (branch_id) await admin.from("profiles").update({ branch_id }).eq("id", data.user.id);
      await syncPositions(me.id);
      return json({ ok: true, user_id: data.user.id });
    }

    if (action === "reset") {
      // Wipe workflow data (and optionally the catalogue / test users) before going live.
      if (body.confirm !== "RESET") throw new Error('Type RESET to confirm');
      const all = (t: string) => admin.from(t).delete().not("id", "is", null);
      const { data: proofs } = await admin.from("expense_proofs").select("storage_path");
      if (proofs?.length) await admin.storage.from("proofs").remove(proofs.map((p) => p.storage_path));
      for (const t of ["expense_proofs", "expense_lines", "stock_movements", "expenses", "request_events", "request_lines", "requests", "float_transactions", "floats"]) {
        const { error } = await all(t); if (error) throw new Error(`${t}: ${error.message}`);
      }
      if (body.catalogue) {
        for (const t of ["items", "suppliers"]) { const { error } = await all(t); if (error) throw new Error(`${t}: ${error.message}`); }
      } else {
        await admin.from("items").update({ qty_on_hand: 0 }).not("id", "is", null);
      }
      await admin.rpc("reset_request_numbers").then(() => {}, () => {});
      const removed: string[] = [];
      if (typeof body.remove_users_matching === "string" && body.remove_users_matching.length > 2) {
        const { data: users } = await admin.from("profiles").select("id, email").ilike("email", `%${body.remove_users_matching}`);
        for (const u of users ?? []) {
          if (u.id === me.id) continue;
          const { error } = await admin.auth.admin.deleteUser(u.id);
          if (!error) removed.push(u.email);
        }
      }
      return json({ ok: true, removed_users: removed });
    }

    const user_id = String(body.user_id || "");
    if (!user_id) throw new Error("user_id is required");

    if (action === "update") {
      const patch: Record<string, unknown> = {};
      if (typeof body.full_name === "string") patch.full_name = body.full_name.trim();
      if (typeof body.role === "string") {
        if (!ROLES.includes(body.role)) throw new Error("Unknown role");
        if (user_id === me.id && body.role !== "approver") throw new Error("You cannot remove your own administrator role");
        patch.role = body.role;
      }
      if (typeof body.email === "string" && body.email.trim()) {
        const email = body.email.trim().toLowerCase();
        if (!EMAIL.test(email)) throw new Error("Enter a valid email address");
        const { data: cur } = await admin.from("profiles").select("email").eq("id", user_id).single();
        if (cur && cur.email !== email) {
          // the administrator vouches for the address, so no confirmation round-trip; they sign in with the new one from now on
          const { error: ae } = await admin.auth.admin.updateUserById(user_id, { email, email_confirm: true });
          if (ae) throw new Error(/already/i.test(ae.message) ? "That email already has an account" : ae.message);
          patch.email = email;
        }
      }
      const { error } = await admin.from("profiles").update(patch).eq("id", user_id);
      if (error) throw error;
      if (patch.role) await admin.auth.admin.updateUserById(user_id, { app_metadata: { invited: true, role: patch.role } });
      if (patch.full_name !== undefined) await admin.auth.admin.updateUserById(user_id, { user_metadata: { full_name: patch.full_name } });
      await syncPositions(me.id);
      return json({ ok: true });
    }

    if (action === "reset_password") {
      checkPassword(body.password);
      const { error } = await admin.auth.admin.updateUserById(user_id, { password: body.password as string });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "set_active") {
      const active = Boolean(body.active);
      if (user_id === me.id && !active) throw new Error("You cannot deactivate yourself");
      const { error } = await admin.from("profiles").update({ active }).eq("id", user_id);
      if (error) throw error;
      // a banned user cannot sign in; "none" lifts the ban
      const { error: e2 } = await admin.auth.admin.updateUserById(user_id, { ban_duration: active ? "none" : "876000h" });
      if (e2) throw e2;
      // profiles.active = false also makes my_role() return null, so every policy and function denies at once
      await syncPositions(me.id);
      return json({ ok: true });
    }

    if (action === "delete") {
      // only an account that never did anything; anyone with history is deactivated instead, so the records stay whole
      if (user_id === me.id) throw new Error("You cannot delete yourself");
      const { data: n, error: he } = await admin.rpc("profile_history", { p_user: user_id });
      if (he) throw he;
      if (Number(n) > 0) throw new Error("This person has history in the app (requests, pay-outs or counts). Deactivate them instead – their records stay in the packs.");
      await admin.from("notifications").delete().eq("user_id", user_id);
      await admin.from("push_subscriptions").delete().eq("user_id", user_id);
      await admin.from("receipt_inbox").delete().eq("user_id", user_id);
      const { error } = await admin.auth.admin.deleteUser(user_id);
      if (error) throw error;
      await syncPositions(me.id);
      return json({ ok: true });
    }

    return json({ error: `Unknown action "${action}"` }, 400);
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? String(e);
    return json({ error: msg }, 400);
  }
});
