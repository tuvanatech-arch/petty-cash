// Backblaze (S3-compatible) settings and uploads for the offsite function; kept apart so it can be tested on its own.
import { AwsClient } from "npm:aws4fetch@1.0.20";

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function b2Settings(get: (k: string) => string) {
  const keyId = get("B2_KEY_ID"), appKey = get("B2_APP_KEY"), bucket = get("B2_BUCKET");
  const endpoint = get("B2_ENDPOINT").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!keyId || !appKey || !bucket || !endpoint) return null;
  // s3.<region>.backblazeb2.com
  const region = endpoint.split(".")[1] || "us-east-1";
  return { keyId, appKey, bucket, endpoint, region };
}

/** One file into the bucket. The body's fingerprint is signed, so Backblaze refuses anything that arrives changed. */
export function uploader(s: NonNullable<ReturnType<typeof b2Settings>>, fetchImpl?: typeof fetch) {
  const client = new AwsClient({ accessKeyId: s.keyId, secretAccessKey: s.appKey, service: "s3", region: s.region });
  return async (key: string, body: Uint8Array, type: string) => {
    const url = `https://${s.endpoint}/${encodeURIComponent(s.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const signed = await client.sign(url, { method: "PUT", body: body as BodyInit, headers: { "Content-Type": type || "application/octet-stream", "X-Amz-Content-Sha256": hex(await crypto.subtle.digest("SHA-256", body as BufferSource)) } });
    const r = await (fetchImpl ?? fetch)(signed);
    if (!r.ok) throw new Error(`Backblaze said ${r.status}: ${(await r.text()).replace(/\s+/g, " ").slice(0, 200)}`);
  };
}
