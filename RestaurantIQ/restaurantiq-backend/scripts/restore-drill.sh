#!/usr/bin/env bash
#
# restore-drill.sh - verify that a database backup actually restores.
#
# Implements the "Backup verification" procedure in docs/operations.md:
#   dump the source DB -> restore into a throwaway local DB -> compare row counts.
#
# A backup you've never restored is a hope, not a backup. Run this monthly, and
# before go-live (pilot-checklist.md section 0, section 4).
#
# Usage
# -----
#   ./scripts/restore-drill.sh                    # source = DATABASE_URL from .env
#   SOURCE_DATABASE_URL=postgres://... ./scripts/restore-drill.sh
#   KEEP_SCRATCH=1 ./scripts/restore-drill.sh     # don't drop the scratch DB at the end
#
# Safety
# ------
# The restore target is FORCED to localhost. If SCRATCH_DATABASE_URL points at
# any remote host the script aborts before touching it - pg_restore into the
# wrong database is exactly the accident this drill exists to prevent.
#
# Client version
# --------------
# pg_dump refuses to dump from a server newer than itself. Supabase runs a
# recent major; the Homebrew default on PATH may be older. We pick the newest
# pg_dump available rather than whatever `which` finds first.

set -euo pipefail

cd "$(dirname "$0")/.."

SCRATCH_DB="${SCRATCH_DB:-riq_restore_drill}"
SCRATCH_DATABASE_URL="${SCRATCH_DATABASE_URL:-postgresql://localhost:5432/${SCRATCH_DB}}"
ADMIN_URL="${ADMIN_URL:-postgresql://localhost:5432/postgres}"
# Default OUTSIDE the repo: a dump holds all customer data and encrypted
# integration tokens, and must never land somewhere it could be committed.
_TMPBASE="${TMPDIR:-/tmp}"
BACKUP_DIR="${BACKUP_DIR:-${_TMPBASE%/}/riq-backups}"
DUMP_FILE="${DUMP_FILE:-${BACKUP_DIR%/}/riq-backup-$(date +%Y%m%d-%H%M).dump}"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-20}"

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

# --- Pick the newest available client binaries -------------------------------
pick() {
  local name="$1" best="" best_v=0 cand v
  for cand in /opt/homebrew/opt/postgresql@*/bin/"$name" /usr/local/opt/postgresql@*/bin/"$name" "$(command -v "$name" 2>/dev/null || true)"; do
    [ -x "$cand" ] || continue
    v=$("$cand" --version 2>/dev/null | grep -oE '[0-9]+' | head -1) || continue
    if [ "${v:-0}" -gt "$best_v" ]; then best_v="$v"; best="$cand"; fi
  done
  [ -n "$best" ] || fail "no $name found"
  echo "$best"
}
PG_DUMP=$(pick pg_dump); PG_RESTORE=$(pick pg_restore); PSQL=$(pick psql)

# --- Resolve the source URL --------------------------------------------------
if [ -z "${SOURCE_DATABASE_URL:-}" ]; then
  [ -f .env ] || fail "no .env and no SOURCE_DATABASE_URL set"
  SOURCE_DATABASE_URL=$(grep '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')
fi
[ -n "$SOURCE_DATABASE_URL" ] || fail "SOURCE_DATABASE_URL is empty"

# --- Safety guard: the restore target must be local --------------------------
SCRATCH_HOST=$(python3 -c "import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).hostname or '')" "$SCRATCH_DATABASE_URL")
case "$SCRATCH_HOST" in
  localhost|127.0.0.1|::1|"") ;;
  *) fail "refusing to restore into remote host '$SCRATCH_HOST' - the drill only ever writes to localhost" ;;
esac

# ADMIN_URL runs CREATE/DROP DATABASE and role DDL, so it needs the same guard.
# Without it, ADMIN_URL=<prod> would drop and recreate databases on production
# even though the restore target itself was correctly pinned to localhost.
ADMIN_HOST=$(python3 -c "import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).hostname or '')" "$ADMIN_URL")
case "$ADMIN_HOST" in
  localhost|127.0.0.1|::1|"") ;;
  *) fail "refusing to run admin DDL against remote host '$ADMIN_HOST' - the drill only ever writes to localhost" ;;
esac

SOURCE_HOST=$(python3 -c "import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).hostname or '')" "$SOURCE_DATABASE_URL")
log "Restore drill"
echo "  pg_dump    : $PG_DUMP ($("$PG_DUMP" --version | awk '{print $3}'))"
echo "  source host: $SOURCE_HOST  (read-only)"
echo "  scratch    : $SCRATCH_DATABASE_URL"
echo "  dump file  : $DUMP_FILE"

# --- 1. Dump -----------------------------------------------------------------
log "1/4  Dumping source (read-only)"
mkdir -p "$(dirname "$DUMP_FILE")"
if ! "$PG_DUMP" "$SOURCE_DATABASE_URL" --format=custom --no-owner --no-privileges --file="$DUMP_FILE"; then
  # A failed dump can still have written a partial file containing real data.
  rm -f "$DUMP_FILE"
  fail "pg_dump failed - is the database reachable? (partial dump removed)"
fi
echo "  wrote $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

# --- 2. Fresh scratch DB -----------------------------------------------------
log "2/4  Recreating scratch database"
"$PSQL" "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\";" \
                     -c "CREATE DATABASE \"$SCRATCH_DB\";" || fail "could not create scratch DB"

# Supabase dumps reference roles and an auth schema that a vanilla Postgres
# lacks. Shim them so the restore isn't drowned in irrelevant errors.
"$PSQL" "$ADMIN_URL" -q <<'SQL' || true
DO $$ BEGIN
  CREATE ROLE anon NOLOGIN;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE service_role NOLOGIN;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
SQL
"$PSQL" "$SCRATCH_DATABASE_URL" -q -c "CREATE SCHEMA IF NOT EXISTS auth;" \
  -c "CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY);" || true

# --- 3. Restore --------------------------------------------------------------
log "3/4  Restoring into scratch"
set +e
"$PG_RESTORE" --no-owner --no-privileges --dbname "$SCRATCH_DATABASE_URL" "$DUMP_FILE" 2> >(tee /tmp/riq-restore-err.log >&2)
RESTORE_RC=$?
set -e
[ $RESTORE_RC -eq 0 ] || echo "  pg_restore exited $RESTORE_RC (see errors above - ownership/role noise is expected locally)"

# --- 4. Verify ---------------------------------------------------------------
log "4/4  Verifying row counts (source vs restored)"
COUNT_SQL="select 'restaurants', count(*) from restaurants
 union all select 'menu_items', count(*) from menu_items
 union all select 'orders', count(*) from orders
 union all select 'order_items', count(*) from order_items
 union all select 'daily_summaries', count(*) from daily_summaries
 union all select 'alerts', count(*) from alerts
 order by 1;"

SRC=$("$PSQL" "$SOURCE_DATABASE_URL"  -At -F'|' -c "$COUNT_SQL") || fail "could not read source counts"
DST=$("$PSQL" "$SCRATCH_DATABASE_URL" -At -F'|' -c "$COUNT_SQL") || fail "could not read restored counts"

printf '\n  %-18s %10s %10s   %s\n' TABLE SOURCE RESTORED RESULT
DRIFT=0
while IFS='|' read -r t sc; do
  dc=$(echo "$DST" | awk -F'|' -v t="$t" '$1==t{print $2}')
  if [ "$sc" = "${dc:-}" ]; then r=$'\033[32mmatch\033[0m'; else r=$'\033[31mMISMATCH\033[0m'; DRIFT=1; fi
  printf '  %-18s %10s %10s   %b\n' "$t" "$sc" "${dc:-<missing>}" "$r"
done <<< "$SRC"

echo
"$PSQL" "$SCRATCH_DATABASE_URL" -At -c "select 'latest daily_summaries date: '||coalesce(max(date)::text,'(none)') from daily_summaries;" || true
"$PSQL" "$SCRATCH_DATABASE_URL" -At -c "select 'newest order created_at: '||coalesce(max(created_at)::text,'(none)') from orders;" || true

if [ "${KEEP_SCRATCH:-0}" != "1" ]; then
  "$PSQL" "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\";"
  echo "  scratch database dropped (KEEP_SCRATCH=1 to keep it)"
fi

if [ "$DRIFT" -ne 0 ]; then fail "row counts differ - the backup did NOT restore faithfully"; fi
log "DRILL PASSED - dump restored with matching row counts"
echo "  Dump retained at: $DUMP_FILE"
echo "  This file contains ALL customer data and encrypted integration tokens."
echo "  Store it encrypted off-platform, or delete it: rm $DUMP_FILE"
