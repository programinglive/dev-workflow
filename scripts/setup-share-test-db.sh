#!/usr/bin/env bash
# Menyiapkan role + database uji terpisah di host database.
#
# TIDAK menyentuh database produksi: nama role dan database diawali
# `devwf_share_test`, dan role hanya diberi hak pada database itu sendiri.
set -euo pipefail

PG_DB=devwf_share_test
PG_USER=devwf_share_test
PG_PASS="$(openssl rand -hex 16)"

sudo -u postgres psql -v ON_ERROR_STOP=1 >/dev/null <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${PG_USER}') THEN
    CREATE ROLE ${PG_USER} WITH LOGIN PASSWORD '${PG_PASS}';
  ELSE
    ALTER ROLE ${PG_USER} WITH LOGIN PASSWORD '${PG_PASS}';
  END IF;
END
\$\$;
SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" | grep -q 1; then
  sudo -u postgres createdb -O "${PG_USER}" "${PG_DB}"
fi

sudo -u postgres psql -d "${PG_DB}" -c "ALTER SCHEMA public OWNER TO ${PG_USER};" >/dev/null

echo "TEST_POSTGRES_URL=postgresql://${PG_USER}:${PG_PASS}@127.0.0.1:5432/${PG_DB}"
