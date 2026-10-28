// devices: the app checks in when it opens – which device this is, and roughly where it is – so each person can see the
// devices signed in to their account (Account → Devices), and is told about a new device, a new country, or the account
// being used in two places too far apart for the time between them. The rules live in record_checkin; signing out is
// sign_out_devices. Places are looked up from the internet address (city-level, approximate) and kept 30 days per address.
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

// relays and VPNs (iCloud Private Relay runs on Cloudflare, Akamai and Fastly) only show a rough region: never used to judge distance
const ROUGH = /cloudflare|akamai|fastly|apple|icloud|private relay|vpn|proxy/i;

function claims(token: string): Record<string, unknown> {
  try { const p = token.split(".")[1]; return JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((p.length + 3) % 4))); } catch { return {}; }
}
function countryName(code?: string | null) {
  if (!code) return null;
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) || code; } catch { return code; }
}
function clientIp(req: Request) {
  const xff = (req.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || xff[xff.length - 1] || null;
}

type Place = { country: string | null; country_name: string | null; region: string | null; city: string | null; lat: number | null; lon: number | null; org: string | null; approx: boolean; source: string };

async function lookup(ip: string | null, cfCountry: string | null): Promise<Place> {
  const fallback: Place = { country: cfCountry, country_name: countryName(cfCountry), region: null, city: null, lat: null, lon: null, org: null, approx: false, source: "cloudflare" };
  if (!ip) return fallback;
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data: hit } = await admin.from("ip_places").select("country, country_name, region, city, lat, lon, org, approx, source").eq("ip", ip).gte("looked_up_at", since).maybeSingle();
  if (hit) return hit as Place;
  let p: Omit<Place, "approx"> | null = null;
  try {
    const r = await fetch(`https://ipapi.co/${ip}/json/`, { headers: { "User-Agent": "petty-cash-app/1.0" }, signal: AbortSignal.timeout(3500) });
    const j = await r.json();
    if (r.ok && !j.error && j.country_code) p = { country: j.country_code, country_name: j.country_name, region: j.region || null, city: j.city || null, lat: j.latitude ?? null, lon: j.longitude ?? null, org: j.org || null, source: "ipapi.co" };
  } catch { /* try the next one */ }
  if (!p) {
    try {
      const r = await fetch(`https://ipwho.is/${ip}`, { signal: AbortSignal.timeout(3500) });
      const j = await r.json();
      if (j.success && j.country_code) p = { country: j.country_code, country_name: j.country, region: j.region || null, city: j.city || null, lat: j.latitude ?? null, lon: j.longitude ?? null, org: j.connection?.org || j.connection?.isp || null, source: "ipwho.is" };
    } catch { /* fall back to the country */ }
  }
  if (!p) return fallback; // not cached: the next check-in tries again
  const place: Place = { ...p, approx: ROUGH.test(p.org || "") };
  await admin.from("ip_places").upsert({ ip, ...place, looked_up_at: new Date().toISOString() });
  return place;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Sign in first" }, 401);
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) {
    // a device that was signed out elsewhere: tell the app so it can show why
    const gone = /session/i.test(error?.message || "") || (error as { code?: string } | null)?.code === "session_not_found";
    return json({ error: "Sign in first", revoked: gone }, 401);
  }
  const sid = String(claims(token).session_id || "");
  if (!sid) return json({ error: "No session" }, 400);
  let body: { label?: string; tz?: string; standalone?: boolean } = {};
  try { body = await req.json(); } catch { /* empty is fine */ }

  const ip = clientIp(req);
  const cf = (req.headers.get("cf-ipcountry") || "").toUpperCase();
  const p = await lookup(ip, /^[A-Z]{2}$/.test(cf) && cf !== "XX" && cf !== "T1" ? cf : null);
  const place = [p.city, p.country_name || countryName(p.country)].filter(Boolean).join(", ") || null;
  const { data, error: e } = await admin.rpc("record_checkin", {
    p_user: user.id, p_session: sid,
    p_where: { ip, country: p.country, country_name: p.country_name || countryName(p.country), place, lat: p.lat, lon: p.lon, approx: p.approx },
    p_device: { label: String(body.label || "").slice(0, 80), ua: (req.headers.get("user-agent") || "").slice(0, 300), tz: String(body.tz || "").slice(0, 60), standalone: !!body.standalone },
  });
  if (e) return json({ error: e.message }, 500);
  return json({ ...(data as Record<string, unknown>), place, source: p.source });
});
