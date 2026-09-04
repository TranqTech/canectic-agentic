#!/usr/bin/env bash
set -euo pipefail

# Convert a Canectic database from SQL_ASCII to UTF8.
#
# PostgreSQL cannot change a database's encoding in place, so this dumps the
# source and reloads it into a newly created UTF8 database. The original is
# left untouched, so rollback is just pointing dbname in .env back at it.
#
# Why this matters: a bare CREATE DATABASE inherits template1, and a cluster
# whose initdb ran under a C or POSIX locale defaults to SQL_ASCII. SQL_ASCII
# performs no encoding validation at all, so invalid byte sequences are stored
# silently and handed back unchanged. Installs created before setup/
# create_pg_db_user.sh set ENCODING explicitly are affected.
#
# Collation is kept as C, matching how Canectic databases are created, so sort
# order and case folding are byte-identical after the conversion. The only
# behavioural change is that PostgreSQL starts rejecting invalid bytes on write.
#
# Usage:
#   bash setup/convert_db_encoding.sh                        # prompts
#   bash setup/convert_db_encoding.sh --source canectic_bbs --target canectic_utf8
#   bash setup/convert_db_encoding.sh --source canectic_bbs --preflight-only
#   bash setup/convert_db_encoding.sh --source X --target Y --yes   # no prompts
#
# Requirements:
# - psql, pg_dump, pg_restore, createdb
# - you can run: sudo -u postgres psql
#
# Optional env vars:
#   PG_ADMIN_ROLE=postgres   (default)
#   PSQL_BIN=psql            (default)

PG_ADMIN_ROLE="${PG_ADMIN_ROLE:-postgres}"
PSQL_BIN="${PSQL_BIN:-psql}"

SOURCE_DB=""
TARGET_DB=""
ASSUME_YES=0
PREFLIGHT_ONLY=0

die() { echo "Error: $*" >&2; exit 1; }
note() { echo "  $*"; }
stage() { echo; echo "== $* =="; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)          SOURCE_DB="${2:-}"; shift 2 ;;
    --target)          TARGET_DB="${2:-}"; shift 2 ;;
    --yes|-y)          ASSUME_YES=1; shift ;;
    --preflight-only)  PREFLIGHT_ONLY=1; shift ;;
    -h|--help)         sed -n '3,32p' "$0"; exit 0 ;;
    *)                 die "Unknown option: $1" ;;
  esac
done

for bin in "$PSQL_BIN" pg_dump pg_restore createdb; do
  command -v "$bin" >/dev/null 2>&1 || die "$bin not found. Install PostgreSQL client tools."
done

is_ident() { [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; }

if [[ -z "$SOURCE_DB" ]]; then
  read -r -p "Database to convert: " SOURCE_DB
fi
is_ident "$SOURCE_DB" || die "Database name must match: ^[A-Za-z_][A-Za-z0-9_]*$"

# Run SQL as the admin role. Quiet, tuples-only, unaligned: output is a value.
admin_q() {
  sudo -u "$PG_ADMIN_ROLE" "$PSQL_BIN" -X -q -t -A -v ON_ERROR_STOP=1 "$@"
}

# ---------------------------------------------------------------------------
stage "Inspecting $SOURCE_DB"
# ---------------------------------------------------------------------------

EXISTS="$(admin_q -c "SELECT 1 FROM pg_database WHERE datname = '${SOURCE_DB}';" || true)"
[[ "$EXISTS" == "1" ]] || die "Database '${SOURCE_DB}' does not exist."

read -r ENCODING COLLATE CTYPE OWNER <<<"$(admin_q -F' ' -c \
  "SELECT pg_encoding_to_char(d.encoding), d.datcollate, d.datctype, r.rolname
     FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba
    WHERE d.datname = '${SOURCE_DB}';")"

note "encoding:  ${ENCODING}"
note "collation: ${COLLATE} / ${CTYPE}"
note "owner:     ${OWNER}"
note "size:      $(admin_q -c "SELECT pg_size_pretty(pg_database_size('${SOURCE_DB}'));")"

if [[ "$ENCODING" == "UTF8" ]]; then
  echo
  echo "Already UTF8. Nothing to do."
  exit 0
fi

# ---------------------------------------------------------------------------
stage "Checking for bytes that are not valid UTF-8"
# ---------------------------------------------------------------------------
#
# Every text value has to survive the reload, and pg_restore validates on the
# way in. Finding invalid bytes now turns a failed restore into a clean refusal.
#
# In a SQL_ASCII database convert_to(col,'SQL_ASCII') is the identity
# conversion, handing back the raw stored bytes; convert_from(..., 'UTF8') then
# raises on an invalid sequence. Only rows containing a byte above 0x7F can
# possibly fail, so the scan filters on that first.

AUDIT_SQL=$(cat <<'SQL'
DO $audit$
DECLARE
  r record;
  bad_cols int := 0;
  scanned  int := 0;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'
       AND c.data_type IN ('text','character varying','character')
     ORDER BY c.table_name, c.column_name
  LOOP
    scanned := scanned + 1;
    BEGIN
      EXECUTE format(
        'SELECT count(*) FROM %I WHERE %I IS NOT NULL '
        'AND %I ~ ''[^\x00-\x7F]'' '
        'AND convert_from(convert_to(%I, ''SQL_ASCII''), ''UTF8'') IS NOT NULL',
        r.table_name, r.column_name, r.column_name, r.column_name);
    EXCEPTION WHEN others THEN
      RAISE WARNING 'invalid UTF-8 in %.%  (%)', r.table_name, r.column_name, SQLERRM;
      bad_cols := bad_cols + 1;
    END;
  END LOOP;

  RAISE NOTICE 'scanned % text column(s)', scanned;
  IF bad_cols > 0 THEN
    RAISE EXCEPTION 'AUDIT FAILED: % column(s) contain invalid UTF-8', bad_cols;
  END IF;
  RAISE NOTICE 'all text columns decode cleanly as UTF-8';
END
$audit$;
SQL
)

if ! sudo -u "$PG_ADMIN_ROLE" "$PSQL_BIN" -X -q -v ON_ERROR_STOP=1 -d "$SOURCE_DB" -c "$AUDIT_SQL"; then
  echo
  echo "Refusing to convert: the source contains bytes that are not valid UTF-8."
  echo "Those values would fail the reload. Repair the columns listed above first."
  exit 1
fi

if [[ "$PREFLIGHT_ONLY" == "1" ]]; then
  echo
  echo "Preflight only. The database is safe to convert."
  exit 0
fi

# ---------------------------------------------------------------------------
stage "Plan"
# ---------------------------------------------------------------------------

if [[ -z "$TARGET_DB" ]]; then
  read -r -p "New UTF8 database name [${SOURCE_DB}_utf8]: " TARGET_DB
  TARGET_DB="${TARGET_DB:-${SOURCE_DB}_utf8}"
fi
is_ident "$TARGET_DB" || die "Target name must match: ^[A-Za-z_][A-Za-z0-9_]*$"
[[ "$TARGET_DB" != "$SOURCE_DB" ]] || die "Target must differ from source."

TARGET_EXISTS="$(admin_q -c "SELECT 1 FROM pg_database WHERE datname = '${TARGET_DB}';" || true)"
[[ "$TARGET_EXISTS" != "1" ]] || die "Database '${TARGET_DB}' already exists. Drop it or pick another name."

DUMP_FILE="${SOURCE_DB}-$(date +%Y%m%d-%H%M%S).dump"

note "dump    ${SOURCE_DB} -> ${DUMP_FILE}"
note "create  ${TARGET_DB} as UTF8, collation C, owner ${OWNER}"
note "restore ${DUMP_FILE} -> ${TARGET_DB}"
note "${SOURCE_DB} is left untouched"
echo
echo "Stop the Canectic processes first. A dump taken while the system is"
echo "writing will be internally consistent but will miss anything committed"
echo "after it starts:  pm2 stop all"

if [[ "$ASSUME_YES" != "1" ]]; then
  echo
  read -r -p "Proceed? [y/N] " REPLY
  [[ "$REPLY" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

# ---------------------------------------------------------------------------
stage "Dumping"
# ---------------------------------------------------------------------------

sudo -u "$PG_ADMIN_ROLE" pg_dump -Fc "$SOURCE_DB" > "$DUMP_FILE"
note "wrote ${DUMP_FILE} ($(du -h "$DUMP_FILE" | cut -f1))"

# ---------------------------------------------------------------------------
stage "Creating ${TARGET_DB}"
# ---------------------------------------------------------------------------

admin_q -c "CREATE DATABASE ${TARGET_DB} OWNER ${OWNER}
              TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';" >/dev/null
note "encoding: $(admin_q -c "SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = '${TARGET_DB}';")"

# ---------------------------------------------------------------------------
stage "Restoring"
# ---------------------------------------------------------------------------
#
# pg_restore validates every byte against UTF8 on the way in. The audit above
# should mean this cannot fail on encoding, but the exit status is still
# checked: a partial restore must not be reported as success.

RESTORE_LOG="${DUMP_FILE%.dump}-restore.log"
if ! sudo -u "$PG_ADMIN_ROLE" pg_restore -d "$TARGET_DB" "$DUMP_FILE" > "$RESTORE_LOG" 2>&1; then
  echo
  echo "pg_restore reported errors. See ${RESTORE_LOG}."
  echo "${SOURCE_DB} is untouched. Drop ${TARGET_DB} and investigate before retrying:"
  echo "  sudo -u ${PG_ADMIN_ROLE} psql -c 'DROP DATABASE ${TARGET_DB};'"
  exit 1
fi
note "restore completed, log: ${RESTORE_LOG}"

# ---------------------------------------------------------------------------
stage "Verifying row counts"
# ---------------------------------------------------------------------------
#
# The check most people skip. Compares every public table's row count between
# source and target and refuses to declare success on any mismatch.

COUNT_SQL="SELECT string_agg(t.table_name || '=' || (
             xpath('/row/c/text()',
               query_to_xml(format('SELECT count(*) AS c FROM %I', t.table_name),
                            false, true, ''))
           )[1]::text, E'\n' ORDER BY t.table_name)
           FROM information_schema.tables t
          WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE';"

SRC_COUNTS="$(admin_q -d "$SOURCE_DB" -c "$COUNT_SQL")"
DST_COUNTS="$(admin_q -d "$TARGET_DB" -c "$COUNT_SQL")"

if [[ "$SRC_COUNTS" == "$DST_COUNTS" ]]; then
  TABLES=$(printf '%s\n' "$SRC_COUNTS" | grep -c '=' || true)
  ROWS=$(printf '%s\n' "$SRC_COUNTS" | awk -F= '{s+=$2} END {print s+0}')
  note "${TABLES} table(s), ${ROWS} row(s), identical in both databases"
else
  echo
  echo "ROW COUNTS DIFFER. Not safe to switch over."
  diff <(printf '%s\n' "$SRC_COUNTS") <(printf '%s\n' "$DST_COUNTS") || true
  echo
  echo "${SOURCE_DB} is untouched. Investigate before changing .env."
  exit 1
fi

# ---------------------------------------------------------------------------
stage "Done"
# ---------------------------------------------------------------------------

cat <<EOF
  ${TARGET_DB} is UTF8 and matches ${SOURCE_DB} row for row.

  To switch over:
    1. pm2 stop all
    2. set dbname=${TARGET_DB} in .env
    3. pm2 start ecosystem.config.cjs

  ${SOURCE_DB} is still in place. Once you are satisfied, remove it with:
    sudo -u ${PG_ADMIN_ROLE} psql -c 'DROP DATABASE ${SOURCE_DB};'

  Keep ${DUMP_FILE} until then.
EOF
