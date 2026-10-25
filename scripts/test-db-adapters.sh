#!/usr/bin/env bash
#
# Runs the database adapter tests against real MySQL and PostgreSQL.
#
# The two adapters are skipped in the default suite because they need a live
# database. This script opens an SSH tunnel to bw-server (where both servers
# run on localhost), runs only the adapter tests, and closes the tunnel.
#
# Usage:
#   ./scripts/test-db-adapters.sh
#
# Requires:
#   - an SSH host alias `bw-tunnel` that can reach 127.0.0.1:3306 and :5432
#     (see ~/.ssh/config; the restricted dbtunnel account is enough)
#   - TEST_MYSQL_URL / TEST_POSTGRES_URL pointing at the forwarded ports,
#     or the defaults below
#
# The test databases are created by scripts/setup-test-dbs.sh on the server.
# Tests write real rows, so never point these at a production database.

set -euo pipefail

LOCAL_PG_PORT="${LOCAL_PG_PORT:-15432}"
LOCAL_MY_PORT="${LOCAL_MY_PORT:-13306}"
SSH_HOST="${SSH_HOST:-bw-tunnel}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v ssh > /dev/null 2>&1; then
  echo "ssh not found; this script needs an SSH tunnel to the database host." >&2
  exit 1
fi

cleanup() {
  if [ -n "${TUNNEL_PID:-}" ] && kill -0 "$TUNNEL_PID" 2> /dev/null; then
    kill "$TUNNEL_PID" 2> /dev/null || true
    wait "$TUNNEL_PID" 2> /dev/null || true
    echo "tunnel closed"
  fi
}
trap cleanup EXIT

echo "opening tunnel to $SSH_HOST ($LOCAL_PG_PORT -> 5432, $LOCAL_MY_PORT -> 3306)"
ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -N \
  -L "${LOCAL_PG_PORT}:127.0.0.1:5432" \
  -L "${LOCAL_MY_PORT}:127.0.0.1:3306" \
  "$SSH_HOST" &
TUNNEL_PID=$!

# Wait for the forwards to accept connections.
for port in "$LOCAL_PG_PORT" "$LOCAL_MY_PORT"; do
  ready=0
  for _ in $(seq 1 20); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2> /dev/null; then
      exec 3>&- 3<&-
      ready=1
      break
    fi
    sleep 0.5
  done
  if [ "$ready" -ne 1 ]; then
    echo "port $port did not open; is $SSH_HOST reachable?" >&2
    exit 1
  fi
done

: "${TEST_POSTGRES_URL:?set TEST_POSTGRES_URL (see scripts/setup-test-dbs.sh)}"
: "${TEST_MYSQL_URL:?set TEST_MYSQL_URL (see scripts/setup-test-dbs.sh)}"

cd "$REPO_ROOT"
node --no-deprecation --test tests/db-adapters.test.js
