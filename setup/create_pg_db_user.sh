#!/usr/bin/env bash
set -euo pipefail

# This script creates:
# - a PostgreSQL role (user)
# - a database owned by that role
# - sets/updates the role password
# - grants the role privileges on the database and public schema
#
# It prompts for values at runtime.
#
# Requirements:
# - psql installed
# - you can run: sudo -u postgres psql
#
# Optional env vars:
#   PG_ADMIN_ROLE=postgres   (default)
#   PSQL_BIN=psql            (default)

PG_ADMIN_ROLE="${PG_ADMIN_ROLE:-postgres}"
PSQL_BIN="${PSQL_BIN:-psql}"

die() { echo "Error: $*" >&2; exit 1; }

command -v "$PSQL_BIN" >/dev/null 2>&1 || die "psql not found. Install PostgreSQL client tools."

# Prompt for values
read -r -p "Database name: " DB_NAME
[[ -n "${DB_NAME}" ]] || die "Database name cannot be empty."

read -r -p "Username (role) to create/use: " DB_USER
[[ -n "${DB_USER}" ]] || die "Username cannot be empty."

# Read password silently + confirm
read -r -s -p "Password for '${DB_USER}': " DB_PASS
echo
[[ -n "${DB_PASS}" ]] || die "Password cannot be empty."
read -r -s -p "Confirm password: " DB_PASS2
echo
[[ "${DB_PASS}" == "${DB_PASS2}" ]] || die "Passwords do not match."

# Basic identifier safety (avoid SQL injection via identifiers)
# Allow: letters, numbers, underscore; must start with letter/underscore.
is_ident() { [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; }
is_ident "$DB_NAME" || die "Database name must match: ^[A-Za-z_][A-Za-z0-9_]*$"
is_ident "$DB_USER" || die "Username must match: ^[A-Za-z_][A-Za-z0-9_]*$"

run_psql() {
  # Run SQL as admin role via sudo. Requires you have sudo rights.
  sudo -u "$PG_ADMIN_ROLE" "$PSQL_BIN" -v ON_ERROR_STOP=1 -X -q -c "$1"
}

echo "Using admin role: $PG_ADMIN_ROLE"
echo "Creating/Updating role and database..."

# 1) Create role if it doesn't exist
run_psql "DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN;
  END IF;
END
\$\$;"

# 2) Set/Update password (always)
# Use dollar-quoting to avoid issues with quotes in passwords.
run_psql "ALTER ROLE ${DB_USER} WITH PASSWORD \$pw\$${DB_PASS}\$pw\$;"

# 3) Create database if it doesn't exist, owned by the user
run_psql "DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}') THEN
    CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};
  END IF;
END
\$\$;"

# 4) Ensure ownership and grant privileges on the database
run_psql "ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};"
run_psql "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"

# 5) Grant schema privileges + set sensible defaults for future objects in public schema
# (Run against the target DB, not postgres.)
sudo -u "$PG_ADMIN_ROLE" "$PSQL_BIN" -v ON_ERROR_STOP=1 -X -q -d "$DB_NAME" <<SQL
GRANT USAGE, CREATE ON SCHEMA public TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO ${DB_USER};
SQL

echo "Done."
echo "Database: ${DB_NAME}"
echo "User/Role: ${DB_USER}"