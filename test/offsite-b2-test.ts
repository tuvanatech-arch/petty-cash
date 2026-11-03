// The upload to Backblaze, checked without Backblaze: the address, the headers, the body's fingerprint, and the signature
// re-computed here independently (AWS Signature Version 4, which Backblaze's S3 interface uses).
// Run: deno run --allow-net test/offsite-b2-test.ts
import { b2Settings, uploader } from "../functions/offsite/b2.ts";

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (d: Uint8Array | string) => hex(await crypto.subtle.digest("SHA-256", typeof d === "string" ? enc.encode(d) : d));
const hmac = async (key: Uint8Array | ArrayBuffer, msg: string) =>
  crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(msg));
const fails: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };

const env: Record<string, string> = { B2_KEY_ID: "003abc", B2_APP_KEY: "K003secret", B2_BUCKET: "tuvana-petti-mgp", B2_ENDPOINT: " https://s3.eu-central-003.backblazeb2.com/ " };
const s = b2Settings((k) => (env[k] || "").trim())!;
check(s.endpoint === "s3.eu-central-003.backblazeb2.com" && s.region === "eu-central-003", "the endpoint is read as pasted (with or without https://), and the region from it");
check(b2Settings((k) => (k === "B2_APP_KEY" ? "" : env[k])) === null, "nothing is sent until all four settings are there");

let seen: Request | null = null; let seenBody = new Uint8Array();
const fake = (async (r: Request) => { seen = r; seenBody = new Uint8Array(await r.arrayBuffer()); return new Response("", { status: 200 }); }) as typeof fetch;
const body = enc.encode('[{"id":1,"purpose":"Taxi – bank"}]');
await uploader(s, fake)("records/2026-11-03-02-00-00/requests.json", body, "application/json");
const r = seen as unknown as Request;
check(r.method === "PUT" && r.url === "https://s3.eu-central-003.backblazeb2.com/tuvana-petti-mgp/records/2026-11-03-02-00-00/requests.json", "PUT to the bucket, under records/<night>/");
check(seenBody.length === body.length && seenBody.every((b, i) => b === body[i]), "the file arrives byte for byte");
check(r.headers.get("x-amz-content-sha256") === await sha(body), "the body's fingerprint is sent (Backblaze refuses a file that changed on the way)");

// the signature, independently
const auth = r.headers.get("authorization") || "";
const m = auth.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/);
check(!!m && m[1] === "003abc" && m[3] === "eu-central-003", "signed with the key ID, for the bucket's region");
if (m) {
  const [, , day, region, signedHeaders, signature] = m;
  const amzDate = r.headers.get("x-amz-date")!;
  const url = new URL(r.url);
  const canonHeaders = signedHeaders.split(";").map((h) => `${h}:${(h === "host" ? url.host : r.headers.get(h) || "").trim()}\n`).join("");
  const canonical = ["PUT", url.pathname, "", canonHeaders, signedHeaders, await sha(body)].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha(canonical)].join("\n");
  let k: ArrayBuffer = await hmac(enc.encode("AWS4" + env.B2_APP_KEY), day);
  for (const part of [region, "s3", "aws4_request"]) k = await hmac(k, part);
  check(hex(await hmac(k, toSign)) === signature, "the signature checks out, computed independently");
  check(signedHeaders.split(";").includes("x-amz-content-sha256") && signedHeaders.split(";").includes("host"), "the fingerprint and the address are part of what is signed");
}

// a file name with a space, as phones sometimes give
await uploader(s, fake)("files/proofs/r1/slip 1.jpg", enc.encode("x"), "image/jpeg");
check((seen as unknown as Request).url.endsWith("/files/proofs/r1/slip%201.jpg"), "file names with spaces are sent safely");

// a refusal comes back in plain words
const refuse = (async () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })) as typeof fetch;
let msg = "";
try { await uploader(s, refuse)("records/x.json", body, "application/json"); } catch (e) { msg = (e as Error).message; }
check(/^Backblaze said 403: .*AccessDenied/.test(msg), "a refusal stops the run with Backblaze's reason");

console.log(fails.length ? `OFFSITE B2: FAIL (${fails.length})` : "OFFSITE B2: PASS");
Deno.exit(fails.length ? 1 : 0);
