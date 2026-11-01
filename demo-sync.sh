#!/usr/bin/env bash
# Rebuild the preview (demo/) from the real app (web/): same UI, mock data client instead of Supabase.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p demo/js/pages && cp web/js/*.js demo/js/ && cp web/js/pages/*.js demo/js/pages/ && for f in demo/js/pages/*.js; do [ -e "web/js/pages/$(basename "$f")" ] || rm "$f"; done
cp web/styles.css demo/styles.css
mkdir -p demo/updates && cp web/updates/*.png demo/updates/ 2>/dev/null || true
cp web/index.html demo/index.html
# no manifest / service worker in the preview (it runs inside the artifact sandbox)
sed -i '/manifest.webmanifest/d;/apple-touch-icon/d;/apple-mobile-web-app/d' demo/index.html
python3 - <<'EOF'
import re
p='demo/js/api.js'; s=open(p).read()
s=s.replace("import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm';","import { createClient, mockReadReceipt } from './mock-client.js';")
# admin-users and read-receipt edge functions are stubbed
s=re.sub(r"/\*\* Call the admin-users edge function\. \*/\nexport async function adminUsers\(body\) \{.*?\n\}\n", """/** Preview: the admin-users edge function is stubbed. */
export async function adminUsers(body) {
  if (body.action === 'status') return { needs_bootstrap: false };
  const { toast } = await import('./ui.js');
  toast('Preview with sample data – people are not really changed.');
  return { ok: true };
}
""", s, flags=re.S)
s=re.sub(r"/\*\* Ask the read-receipt function[^\n]*\*/\nexport async function readReceipt\(ref\) \{.*?\n\}\n", """/** Preview: receipt reading returns a canned reading. */
export async function readReceipt(ref) { return mockReadReceipt(ref); }
""", s, flags=re.S)
s=re.sub(r"/\*\* Call the account-mail function[^\n]*\*/\nexport async function accountMail\(body\) \{.*?\n\}\n", """/** Preview: invitations and resets are simulated (no email provider). */
export async function accountMail(body) {
  await new Promise((r) => setTimeout(r, 500));
  if (body.action === 'welcome') return { sent: false, reason: 'no_provider', link: 'https://example.test/auth/v1/verify?token=preview&type=recovery', email: 'person@example.test', message: 'Hi there, your account on the petty cash & stock app is ready. Open this link once to set your password and sign in: https://example.test/auth/v1/verify?token=preview&type=recovery' };
  return { sent: false, reason: 'no_provider' };
}
""", s, flags=re.S)
s=re.sub(r"/\*\* Tell the server this device is open[^\n]*\*/\nexport async function checkIn\(force = false\) \{.*?\n\}\n", """/** Preview: no check-in (the sample devices are fixed). */
export async function checkIn() { return null; }
""", s, flags=re.S)
assert 'Preview: no check-in' in s, 'checkIn stub not applied'
assert 'Preview: invitations' in s, 'accountMail stub not applied'
assert 'mockReadReceipt(ref)' in s, 'readReceipt stub not applied'
assert 'mockReadReceipt' in s
open(p,'w').write(s)
# the preview cannot reach the CDN for jsPDF/pdf-lib, nor email: short-circuit both
s=re.sub(r"/\*\* Email the pack to the accountant via the send-pack function\. \*/\nexport async function sendPack\(packId, note\) \{.*?\n\}\n", """/** Preview: sending is simulated. */
export async function sendPack(packId, note) { await new Promise((r) => setTimeout(r, 800)); const { toast } = await import('./ui.js'); toast('Preview: in the real app this emails the PDF to the accountant.'); return { sent_to: 'accounts@tuvana.example', cc: [] }; }
""", s, flags=re.S)
open(p,'w').write(s)
p='demo/js/pack.js'; s=open(p).read()
s=s.replace("  const jsPDF = await loadJsPDF();\n", "  if (true) { await new Promise((r) => setTimeout(r, 900)); return { bytes: new Uint8Array(2048), name: `petty-cash-${String(float.period).slice(0, 7)}.pdf`, pages: 12, summary }; } // preview: no CDN in the sandbox\n  const jsPDF = await loadJsPDF();\n")
open(p,'w').write(s)
p='demo/js/schedule-pdf.js'; s=open(p).read()
s=s.replace("  const jsPDF = await loadJsPDF();\n  const doc = new jsPDF", "  if (true) { await new Promise((r) => setTimeout(r, 500)); const { toast } = await import('./ui.js'); toast('Preview: in the real app this downloads the schedule as a PDF.'); return; } // preview: no CDN in the sandbox\n  const jsPDF = await loadJsPDF();\n  const doc = new jsPDF")
assert 'Preview: in the real app this downloads the schedule' in s, 'schedule pdf stub not applied'
open(p,'w').write(s)
p='demo/js/export.js'; s=open(p).read()
s=s.replace("  const JSZip = await loadZip();\n", "  if (true) { await new Promise((r) => setTimeout(r, 700)); const { toast } = await import('./ui.js'); toast('Preview: in the real app this downloads a zip with every register and the receipts.'); return { files: 10, receipts: 4 }; } // preview: no CDN in the sandbox\n  const JSZip = await loadZip();\n")
assert 'downloads a zip' in s, 'export stub not applied'
open(p,'w').write(s)
# the service worker is not registered in the preview
p='demo/js/app.js'; s=open(p).read()
s=s.replace("if ('serviceWorker' in navigator && location.protocol === 'https:') {","if (false) {")
open(p,'w').write(s)
EOF
echo "demo synced"
