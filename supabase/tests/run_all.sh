#!/bin/bash
# Rebuild the local test DB from scratch and apply every migration in order.
set -e
PSQL="psql -h /tmp -p 5433 -U postgres -v ON_ERROR_STOP=1 -q"
cd "$(dirname "$0")/.."   # -> supabase/
$PSQL -d postgres -c "drop database if exists pc_test" -c "create database pc_test"
$PSQL -d pc_test -f tests/00_supabase_stub.sql
for f in migrations/*.sql; do
  echo "apply $(basename $f)"
  $PSQL -d pc_test -f "$f"
done
echo "ALL MIGRATIONS APPLIED"
