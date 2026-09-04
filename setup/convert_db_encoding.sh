#!/usr/bin/env bash
set -euo pipefail

# Convert a Canectic database from SQL_ASCII to UTF8.
#
# PostgreSQL cannot change a database's encoding in place, so this dumps the
# source and reloads it into a new UTF8 database.
#
# By default the new database takes over the original name and the original is
# renamed aside as a backup, so .env needs no edit. The renames happen only
# after the restore has been verified, so a failure at any earlier point leaves
# the original exactly where it was.
#
# Pass --target to get a side-by-side copy under a new name instead, leaving
# the original in place and untouched.
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
#   bash setup/convert_db_encoding.sh --source canectic_bbs
#       converts in place: canectic_bbs becomes UTF8, the old one is renamed
#       to canectic_bbs_sqlascii_<timestamp>. No .env change needed.
#
#   bash setup/convert_db_encoding.sh --source canectic_bbs --target canectic_utf8
#       side-by-side copy under a new name; original untouched, .env must be
#       repointed by hand.
#
#   bash setup/convert_db_encoding.sh --source canectic_bbs --preflight-only
#       inspect and audit only, change nothing.
#
#   add --yes to skip the confirmation prompt.
#
# Requirements:
# - psql, pg_dump, pg_restore, createdb
# - you can run: sudo -u postgres psql
#
# Optional env vars:
#   PG_ADMIN_ROLE=postgres   (default)
#   PSQL_BIN=psql            (default)
#   SUDO_BIN="sudo"          (default) how to become the admin role. Set to
#                            "sudo -A" with SUDO_ASKPASS pointing at a helper
#                            to run this without a terminal, e.g. from cron.

PG_ADMIN_ROLE="${PG_ADMIN_ROLE:-postgres}"
PSQL_BIN="${PSQL_BIN:-psql}"

# Split on whitespace so SUDO_BIN can carry flags such as "sudo -A".
read -r -a SUDO_CMD <<< "${SUDO_BIN:-sudo}"

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
  "${SUDO_CMD[@]}" -u "$PG_ADMIN_ROLE" "$PSQL_BIN" -X -q -t -A -v ON_ERROR_STOP=1 "$@"
}

# ---------------------------------------------------------------------------
stage "Inspecting $SOURCE_DB"
# ---------------------------------------------------------------------------

# Confirm admin access first. Without this an auth failure surfaces as an empty
# result from the next query and gets misreported as "database does not exist".
ADMIN_OK="$(admin_q -c "SELECT 1;" 2>/dev/null || true)"
[[ "$ADMIN_OK" == "1" ]] || die "Cannot run psql as '${PG_ADMIN_ROLE}'. Check that this works:
    sudo -u ${PG_ADMIN_ROLE} ${PSQL_BIN} -c 'SELECT 1'
  Set PG_ADMIN_ROLE if your cluster uses a different superuser role, or
  SUDO_BIN=\"sudo -A\" with SUDO_ASKPASS set when there is no terminal."

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

if ! "${SUDO_CMD[@]}" -u "$PG_ADMIN_ROLE" "$PSQL_BIN" -X -q -v ON_ERROR_STOP=1 -d "$SOURCE_DB" -c "$AUDIT_SQL"; then
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
#
# Two modes. Without --target the new database takes over the original name
# and the original is renamed aside, so no config edit is needed. With
# --target the copy is left under its own name and nothing is renamed.

STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ -n "$TARGET_DB" ]]; then
  SWAP=0
  is_ident "$TARGET_DB" || die "Target name must match: ^[A-Za-z_][A-Za-z0-9_]*$"
  [[ "$TARGET_DB" != "$SOURCE_DB" ]] || die "Target must differ from source."
  RESTORE_DB="$TARGET_DB"
  BACKUP_DB=""
else
  SWAP=1
  RESTORE_DB="${SOURCE_DB}_utf8_staging"
  BACKUP_DB="${SOURCE_DB}_sqlascii_${STAMP//-/_}"
fi

for db in "$RESTORE_DB" $BACKUP_DB; do
  EXISTS_CHK="$(admin_q -c "SELECT 1 FROM pg_database WHERE datname = '${db}';" || true)"
  [[ "$EXISTS_CHK" != "1" ]] || die "Database '${db}' already exists. Drop it or pick another name."
done

DUMP_FILE="${SOURCE_DB}-${STAMP}.dump"

note "dump    ${SOURCE_DB} -> ${DUMP_FILE}"
note "create  ${RESTORE_DB} as UTF8, collation C, owner ${OWNER}"
note "restore ${DUMP_FILE} -> ${RESTORE_DB}"
note "verify  row counts table by table"
if [[ "$SWAP" == "1" ]]; then
  note "rename  ${SOURCE_DB} -> ${BACKUP_DB}"
  note "rename  ${RESTORE_DB} -> ${SOURCE_DB}"
  echo
  echo "  The renames happen only after the restore is verified. Nothing is"
  echo "  moved until then, so a failure at any earlier point leaves"
  echo "  ${SOURCE_DB} exactly as it is now."
  echo
  echo "  No .env change is needed: the database keeps its name."
else
  note "${SOURCE_DB} is left untouched"
  echo
  echo "  You will need to point dbname in .env at ${TARGET_DB} yourself."
fi

echo
echo "Stop the Canectic processes first:  pm2 stop all"
if [[ "$SWAP" == "1" ]]; then
  echo "This is required, not advisory: PostgreSQL cannot rename a database"
  echo "while anything is connected to it."
fi

if [[ "$ASSUME_YES" != "1" ]]; then
  echo
  read -r -p "Proceed? [y/N] " REPLY
  [[ "$REPLY" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

# Fail early rather than after a long dump if the rename cannot succeed.
#
# Counting connections is only a point-in-time sample: a pooled application
# whose connections happen to be idle reports zero, then reconnects part way
# through. Anything it writes after the dump would end up in the backup rather
# than the live database, and be silently lost at the rename. So refuse if
# anything is connected, then lock the door behind us.
#
# CONNECTION LIMIT 0 blocks new non-superuser connections for the duration.
# The trap puts it back on whichever name the database ends up under, so an
# abort never leaves the application locked out.
if [[ "$SWAP" == "1" ]]; then
  CONNS="$(admin_q -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '${SOURCE_DB}';")"
  if [[ "${CONNS:-0}" -gt 0 ]]; then
    die "${CONNS} connection(s) still open to ${SOURCE_DB}.
  Stop everything that talks to it first:  pm2 stop all
  Note that an idle connection pool can report zero and still reconnect, so
  stop the processes rather than waiting for the count to drop."
  fi

  LOCKED_DB="$SOURCE_DB"
  unlock_source() {
    local rc=$?
    if [[ -n "${LOCKED_DB:-}" ]]; then
      admin_q -c "ALTER DATABASE ${LOCKED_DB} CONNECTION LIMIT -1;" >/dev/null 2>&1 || true
    fi
    return $rc
  }
  trap unlock_source EXIT

  admin_q -c "ALTER DATABASE ${SOURCE_DB} CONNECTION LIMIT 0;" >/dev/null
  note "new connections to ${SOURCE_DB} blocked for the duration"
fi

# ---------------------------------------------------------------------------
stage "Dumping"
# ---------------------------------------------------------------------------

"${SUDO_CMD[@]}" -u "$PG_ADMIN_ROLE" pg_dump -Fc "$SOURCE_DB" > "$DUMP_FILE"
note "wrote ${DUMP_FILE} ($(du -h "$DUMP_FILE" | cut -f1))"

# ---------------------------------------------------------------------------
stage "Creating ${RESTORE_DB}"
# ---------------------------------------------------------------------------

admin_q -c "CREATE DATABASE ${RESTORE_DB} OWNER ${OWNER}
              TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';" >/dev/null
note "encoding: $(admin_q -c "SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = '${RESTORE_DB}';")"

# ---------------------------------------------------------------------------
stage "Restoring"
# ---------------------------------------------------------------------------
#
# pg_restore validates every byte against UTF8 on the way in. The audit above
# should mean this cannot fail on encoding, but the exit status is still
# checked: a partial restore must not be reported as success.
#
# The archive is fed on stdin rather than named as an argument. pg_restore runs
# as the admin role, which usually cannot traverse into the invoking user's
# directory (a mode 700 home is enough to stop it), whereas the redirect is
# performed by this shell as the invoking user.

RESTORE_LOG="${DUMP_FILE%.dump}-restore.log"
if ! "${SUDO_CMD[@]}" -u "$PG_ADMIN_ROLE" pg_restore -d "$RESTORE_DB" < "$DUMP_FILE" > "$RESTORE_LOG" 2>&1; then
  echo
  echo "pg_restore reported errors. See ${RESTORE_LOG}."
  echo "${SOURCE_DB} is untouched. Drop the partial copy and investigate:"
  echo "  ${SUDO_CMD[*]} -u ${PG_ADMIN_ROLE} ${PSQL_BIN} -c 'DROP DATABASE ${RESTORE_DB};'"
  exit 1
fi
note "restore completed, log: ${RESTORE_LOG}"

# ---------------------------------------------------------------------------
stage "Verifying row counts"
# ---------------------------------------------------------------------------
#
# The check most people skip. Compares every public table's row count between
# source and target and refuses to go further on any mismatch. In swap mode
# this gate is what stands between a good copy and renaming the original away.

COUNT_SQL="SELECT string_agg(t.table_name || '=' || (
             xpath('/row/c/text()',
               query_to_xml(format('SELECT count(*) AS c FROM %I', t.table_name),
                            false, true, ''))
           )[1]::text, E'\n' ORDER BY t.table_name)
           FROM information_schema.tables t
          WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE';"

SRC_COUNTS="$(admin_q -d "$SOURCE_DB" -c "$COUNT_SQL")"
DST_COUNTS="$(admin_q -d "$RESTORE_DB" -c "$COUNT_SQL")"

if [[ "$SRC_COUNTS" != "$DST_COUNTS" ]]; then
  echo
  echo "ROW COUNTS DIFFER. Stopping before anything is renamed."
  diff <(printf '%s\n' "$SRC_COUNTS") <(printf '%s\n' "$DST_COUNTS") || true
  echo
  echo "${SOURCE_DB} is untouched. Investigate, then drop ${RESTORE_DB}."
  exit 1
fi

TABLES=$(printf '%s\n' "$SRC_COUNTS" | grep -c '=' || true)
ROWS=$(printf '%s\n' "$SRC_COUNTS" | awk -F= '{s+=$2} END {print s+0}')
note "${TABLES} table(s), ${ROWS} row(s), identical in both databases"

# ---------------------------------------------------------------------------
if [[ "$SWAP" == "1" ]]; then
stage "Swapping names"
# ---------------------------------------------------------------------------
#
# Both renames are metadata-only and near instant. Re-check connections
# immediately beforehand, since the dump and restore took time and something
# may have reconnected.

  CONNS="$(admin_q -c "SELECT count(*) FROM pg_stat_activity WHERE datname IN ('${SOURCE_DB}','${RESTORE_DB}');")"
  if [[ "${CONNS:-0}" -gt 0 ]]; then
    echo
    echo "${CONNS} connection(s) opened during the copy, so the rename cannot run."
    echo "The verified copy is ready as ${RESTORE_DB}. Stop everything, then finish with:"
    echo "  ${SUDO_CMD[*]} -u ${PG_ADMIN_ROLE} ${PSQL_BIN} -c 'ALTER DATABASE ${SOURCE_DB} RENAME TO ${BACKUP_DB};'"
    echo "  ${SUDO_CMD[*]} -u ${PG_ADMIN_ROLE} ${PSQL_BIN} -c 'ALTER DATABASE ${RESTORE_DB} RENAME TO ${SOURCE_DB};'"
    exit 1
  fi

  admin_q -c "ALTER DATABASE ${SOURCE_DB} RENAME TO ${BACKUP_DB};" >/dev/null
  note "${SOURCE_DB} -> ${BACKUP_DB}"

  # If this second rename fails the cluster has no database at the original
  # name, so say exactly how to put it back.
  if ! admin_q -c "ALTER DATABASE ${RESTORE_DB} RENAME TO ${SOURCE_DB};" >/dev/null; then
    echo
    echo "The second rename failed. There is currently no database named ${SOURCE_DB}."
    echo "Your data is safe in ${BACKUP_DB}. Put it back with:"
    echo "  ${SUDO_CMD[*]} -u ${PG_ADMIN_ROLE} ${PSQL_BIN} -c 'ALTER DATABASE ${BACKUP_DB} RENAME TO ${SOURCE_DB};'"
    exit 1
  fi
  note "${RESTORE_DB} -> ${SOURCE_DB}"

  # The connection limit travelled with the old database under its new name.
  # Point the trap at it and lift the block so the backup stays usable.
  LOCKED_DB="$BACKUP_DB"
  admin_q -c "ALTER DATABASE ${BACKUP_DB} CONNECTION LIMIT -1;" >/dev/null
  LOCKED_DB=""
  trap - EXIT

  FINAL_ENC="$(admin_q -c "SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = '${SOURCE_DB}';")"
  [[ "$FINAL_ENC" == "UTF8" ]] || die "Unexpected: ${SOURCE_DB} reports encoding ${FINAL_ENC} after the swap."
  note "${SOURCE_DB} is now ${FINAL_ENC}"
fi

# ---------------------------------------------------------------------------
stage "Done"
# ---------------------------------------------------------------------------

if [[ "$SWAP" == "1" ]]; then
cat <<EOF
  ${SOURCE_DB} is now UTF8 and matches the original row for row.
  No .env change is needed.

    pm2 start ecosystem.config.cjs

  The original is kept as ${BACKUP_DB}. To roll back, stop everything and:
    ${SUDO_CMD[*]} -u ${PG_ADMIN_ROLE} ${PSQL_BIN} -c 'ALTER DATABASE ${SOURCE_DB} RENAME TO ${SOURCE_DB}_utf8_staging;'
    ${SUDO_CMD[*]} -u ${PG_ADMIN_ROLE} ${PSQL_BIN} -c 'ALTER DATABASE ${BACKUP_DB} RENAME TO ${SOURCE_DB};'

  Once you are satisfied, reclaim the space:
    ${SUDO_CMD[*]} -u ${PG_ADMIN_ROLE} ${PSQL_BIN} -c 'DROP DATABASE ${BACKUP_DB};'

  Keep ${DUMP_FILE} until then.
EOF
else
cat <<EOF
  ${TARGET_DB} is UTF8 and matches ${SOURCE_DB} row for row.

  To switch over:
    1. pm2 stop all
    2. set dbname=${TARGET_DB} in .env
    3. pm2 start ecosystem.config.cjs

  ${SOURCE_DB} is still in place. Once you are satisfied, remove it with:
    ${SUDO_CMD[*]} -u ${PG_ADMIN_ROLE} ${PSQL_BIN} -c 'DROP DATABASE ${SOURCE_DB};'

  Keep ${DUMP_FILE} until then.
EOF
fi
