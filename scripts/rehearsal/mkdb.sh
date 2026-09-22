#!/usr/bin/env bash
# Creates the Canectic role and database the way docs/sysop/INSTALL.md Option B does.
# Reads the sudo password from stdin; generates the DB password into ~/.canectic-dbpass.
set -euo pipefail
IFS= read -r SUDOPW
umask 077
[ -s ~/.canectic-dbpass ] || openssl rand -hex 16 > ~/.canectic-dbpass
DBPASS=$(cat ~/.canectic-dbpass)
printf '%s\n' "$SUDOPW" | sudo -S -p '' -v
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'canectic') THEN
    CREATE ROLE canectic LOGIN PASSWORD '$DBPASS';
  END IF;
END \$\$;
SQL
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='canectic_bbs'" | grep -q 1; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE canectic_bbs OWNER canectic TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'"
fi
sudo -u postgres psql -tAc "SELECT datname, pg_encoding_to_char(encoding), datcollate FROM pg_database WHERE datname='canectic_bbs'"
PGPASSWORD="$DBPASS" psql -h localhost -U canectic -d canectic_bbs -tAc "SELECT 'canectic can log in over TCP: ' || current_user"
