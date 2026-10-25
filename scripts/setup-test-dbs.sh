#!/usr/bin/env bash
#
# Creates isolated test databases and users on the database host.
#
# Run this on bw-server (it uses sudo locally). It creates:
#   - PostgreSQL database `devworkflow_test` and role `devworkflow_test`
#   - MySQL database `devworkflow_test` and user `dwftest`
#
# It never touches an existing database, and the role is granted access only to
# its own database. The adapter tests INSERT and UPDATE real rows, so pointing
# them at a production database would corrupt real history data.
#
# Prints the two connection URLs at the end.

set -euo pipefail

PG_DB=devworkflow_test
PG_USER=devworkflow_test
PG_PASS="$(openssl rand -hex 16)"

MY_DB=devworkflow_test
MY_USER=dwftest
MY_PASS="$(openssl rand -hex 16)"

echo "=== PostgreSQL ==="
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
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

sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" | grep -q 1 \
  || sudo -u postgres createdb -O "${PG_USER}" "${PG_DB}"

sudo -u postgres psql -d "${PG_DB}" -c "GRANT ALL ON SCHEMA public TO ${PG_USER};" > /dev/null
sudo -u postgres psql -d "${PG_DB}" -c "ALTER SCHEMA public OWNER TO ${PG_USER};" > /dev/null

echo "=== MySQL ==="
sudo mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`${MY_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${MY_USER}'@'localhost' IDENTIFIED BY '${MY_PASS}';
ALTER USER '${MY_USER}'@'localhost' IDENTIFIED BY '${MY_PASS}';
GRANT ALL PRIVILEGES ON \`${MY_DB}\`.* TO '${MY_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

echo "=== verification ==="
mysql -h 127.0.0.1 -u "${MY_USER}" -p"${MY_PASS}" -N -B -e "SELECT 'mysql ok'" "${MY_DB}"

echo
echo "Add these to your shell before running scripts/test-db-adapters.sh"
echo "(ports are the local tunnel ports):"
echo
echo "TEST_POSTGRES_URL=postgresql://${PG_USER}:${PG_PASS}@127.0.0.1:15432/${PG_DB}"
echo "TEST_MYSQL_URL=mysql://${MY_USER}:${MY_PASS}@127.0.0.1:13306/${MY_DB}"
