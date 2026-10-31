#!/usr/bin/env bash
# Replays the whole setup (db/*.sql in order) on a fresh local database with the Supabase stand-in; stops at the first error.
set -uo pipefail
cd "$(dirname "$0")/../.."
P="psql -h ${PGHOST:-/var/tmp/pettipg} -p ${PGPORT:-54329} -U postgres"
$P -qc "drop database if exists ${DB:-petti}" -c "create database ${DB:-petti}" >/dev/null 2>&1
$P -d "${DB:-petti}" -v ON_ERROR_STOP=1 -q -f ops/test-db/supabase-stub.sql >/dev/null 2>&1 || { echo "stub failed"; exit 1; }
for f in $(ls db/*.sql | sort); do
  [ -n "${STOP_BEFORE:-}" ] && [[ "$(basename "$f")" > "${STOP_BEFORE}" ]] && break
  out=$($P -d "${DB:-petti}" -v ON_ERROR_STOP=1 -q -f "$f" 2>&1)
  if echo "$out" | grep -q ERROR; then echo "FAILED at $f"; echo "$out" | grep -A4 ERROR | head -8; exit 1; fi
done
echo "REPLAY OK: $(ls db/*.sql | wc -l) files"
