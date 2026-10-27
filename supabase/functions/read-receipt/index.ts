// read-receipt: reads a scanned receipt with the Claude API and returns supplier, date, total and lines.
// Caller must be signed in and able to see the proof (row-level security decides).
// Secrets: ANTHROPIC_API_KEY (required), RECEIPT_MODEL (optional, default claude-haiku-5-5).
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const PROMPT = `This image or document is a till slip, receipt or invoice, probably from Namibia (currency N$, Namibian dollars, sometimes shown as NAD or just $). Extract what it says and reply with ONLY a JSON object, no prose, no code fences:
{"supplier": "shop or company name", "date": "YYYY-MM-DD or null", "currency": "N$", "total": number or null,
 "lines": [{"description": "item as printed, tidied up", "qty": number, "unit_price": number}],
 "vat_included": true or false or null, "confidence": number between 0 and 1, "notes": "anything unclear, e.g. blurry total"}
Rules: unit_price is the price per unit; if a line shows only a line total, divide by qty. Skip subtotal, VAT, change, card and loyalty lines – they are not purchased items. If you cannot read a value, use null rather than guessing.`;

function toB64(bytes: Uint8Array) {
  let s = ""; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "Receipt reading is not switched on yet – the administrator still has to add the API key." }, 503);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  let body: { proof_id?: string; inbox_id?: string; ping?: boolean };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  // {ping:true}: a one-word call to confirm the key and credits work. Allowed with a signed-in user or the cron key.
  if (body.ping) {
    const { data: cfg } = await admin.from("app_config").select("value").eq("key", "cron_key").maybeSingle();
    const viaCron = !!cfg && req.headers.get("x-cron-key") === cfg.value;
    if (!viaCron && !token) return json({ error: "Sign in first" }, 401);
    const model = Deno.env.get("RECEIPT_MODEL") || "claude-haiku-5-5";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content: "Reply with the single word OK." }] }),
    });
    const t = await res.text();
    if (!res.ok) return json({ ok: false, status: res.status, detail: t.slice(0, 200) }, 502);
    return json({ ok: true, model, reply: (JSON.parse(t).content || []).map((c: { text?: string }) => c.text || "").join("").trim() });
  }

  if (!token) return json({ error: "Sign in first" }, 401);
  if (!body.proof_id && !body.inbox_id) return json({ error: "proof_id or inbox_id is required" }, 400);

  // visibility is decided by row-level security, as the caller
  const asUser = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const table = body.inbox_id ? "receipt_inbox" : "expense_proofs";
  const { data: proof, error: pe } = await asUser.from(table).select("id, storage_path, mime, file_name").eq("id", body.inbox_id || body.proof_id).maybeSingle();
  if (pe || !proof) return json({ error: "That file is not available to you" }, 403);

  const mime = (proof.mime || "").toLowerCase();
  const isPdf = mime === "application/pdf";
  if (!isPdf && !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime)) {
    return json({ error: `Cannot read ${mime || "this file type"} – upload a JPEG, PNG or PDF.` }, 415);
  }
  const { data: file, error: de } = await admin.storage.from("proofs").download(proof.storage_path);
  if (de || !file) return json({ error: "Could not fetch the file" }, 500);
  const b64 = toB64(new Uint8Array(await file.arrayBuffer()));

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: Deno.env.get("RECEIPT_MODEL") || "claude-haiku-5-5",
      max_tokens: 1200,
      messages: [{ role: "user", content: [
        isPdf ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
              : { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
        { type: "text", text: PROMPT },
      ] }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    return json({ error: `The reading service refused the request (${res.status}). ${t.slice(0, 160)}` }, 502);
  }
  const out = await res.json();
  const text = (out.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
  let parsed: Record<string, unknown>;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : text);
  } catch {
    if (table === "receipt_inbox") await admin.from("receipt_inbox").update({ read_error: "Could not make sense of the receipt" }).eq("id", proof.id);
    return json({ error: "Could not make sense of the receipt. Try a clearer photo.", raw: text.slice(0, 300) }, 422);
  }
  parsed.read_at = new Date().toISOString();
  await admin.from(table).update(table === "receipt_inbox" ? { extracted: parsed, read_error: null } : { extracted: parsed }).eq("id", proof.id);
  return json(parsed);
});
