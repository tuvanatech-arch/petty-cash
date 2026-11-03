#!/usr/bin/env bash
# Every check in one go: page smoke tests (web + preview, every role) and the device audit (overflow, touch targets, text size).
set -e
cd "$(dirname "$0")"
../demo/sync.sh > /dev/null
node --import ./hook.mjs smoke.mjs > /dev/null
for r in approver managing_director finance stock_manager requester; do ROLE=$r node smoke-demo.mjs > /dev/null; done
node --import ./hook.mjs signin-test.mjs | tail -1
node --import ./hook.mjs devices-test.mjs | tail -1
node --import ./hook.mjs store-route-test.mjs | tail -1
(cd .. && node test/store-route-ui.mjs | tail -1)
(cd .. && node test/authority-ui.mjs | tail -1)
(cd .. && node test/schedule-ui.mjs | tail -1)
(cd .. && node test/overview-ui.mjs | tail -1)
(cd .. && node test/signins-ui.mjs | tail -1)
(cd .. && node test/branches-ui.mjs | tail -1)
(cd .. && node test/stock-controls-ui.mjs | tail -1)
(cd .. && node test/exceptions-ui.mjs | tail -1)
(cd .. && node test/kpis-ui.mjs | tail -1)
(cd .. && node test/client-settings-ui.mjs | tail -1)
(cd .. && node test/updates-ui.mjs | tail -1)
(cd .. && node test/live-ui.mjs | tail -1)
(cd .. && node test/cash-ui.mjs | tail -1)
(cd .. && node test/proof-ui.mjs | tail -1)
(cd .. && node test/forms-ui.mjs | tail -1)
(cd .. && node test/version-ui.mjs | tail -1)
(cd .. && node test/keep-ui.mjs | tail -1)
(cd .. && node test/taps-ui.mjs | tail -1)
(cd .. && node test/twostep-ui.mjs | tail -1)
node logo-pdf-test.mjs | tail -1
node site-test.mjs | tail -1
(cd .. && node test/subscription-ui.mjs | tail -1)
(cd .. && node test/payment-ui.mjs | tail -1)
node export-all-test.mjs 2>/dev/null | tail -1
# the offline copy-keeper on a weak signal, on a copy stamped the way the deploy stamps it
SWT=$(mktemp -d); cp -r ../demo/. "$SWT/"; cp ../web/sw.js "$SWT/sw.js"
(cd "$SWT" && sed -i "s/__BUILD__/aaaa1111/g" sw.js && sed -i 's|js/app.js"|js/app.js?v=aaaa1111"|' index.html && sed -i -E "s#(from '(\./|\.\./)[^']+\.js)'#\1?v=aaaa1111'#g; s#(import\('(\./|\.\./)[^']+\.js)'\)#\1?v=aaaa1111')#g" js/*.js js/pages/*.js)
node sw-weak-signal.mjs "$SWT" | tail -1; rm -rf "$SWT"
OUT=/tmp/schedule-test.pdf node schedule-pdf-test.mjs 2>/dev/null | tail -1
node pack-test.mjs 2>/dev/null | tail -1
echo "smoke: PASS"
node device-audit.mjs | tail -9
node resume-test.mjs | tail -1
node push-test.mjs | tail -1
# the upload to Backblaze (needs Deno: npm i deno, or set DENO=/path/to/deno)
D=${DENO:-$(command -v deno || true)}; if [ -n "$D" ]; then T=$(mktemp -d); mkdir -p "$T/t" "$T/f"; echo '{"nodeModulesDir":"auto"}' > "$T/deno.json"; cp ../functions/offsite/*.ts "$T/f/"; sed 's#../functions/offsite/b2.ts#../f/b2.ts#' offsite-b2-test.ts > "$T/t/test.ts"; (cd "$T" && "$D" run -A t/test.ts 2>/dev/null | tail -1); rm -rf "$T"; else echo "OFFSITE B2: SKIP (no deno)"; fi
