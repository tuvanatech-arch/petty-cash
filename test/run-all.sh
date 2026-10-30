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
(cd .. && node test/cash-ui.mjs | tail -1)
OUT=/tmp/schedule-test.pdf node schedule-pdf-test.mjs 2>/dev/null | tail -1
node pack-test.mjs 2>/dev/null | tail -1
echo "smoke: PASS"
node device-audit.mjs | tail -9
node resume-test.mjs | tail -1
node push-test.mjs | tail -1
