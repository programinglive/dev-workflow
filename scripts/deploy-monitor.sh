#!/usr/bin/env bash
# Deploys the reviewed monitor artifacts to bw-tools through the dedicated
# devwf-monitor-deploy identity and the narrow sudo allowlist.
#
# Rules this script keeps:
# 1. The private key is written to RUNNER_TEMP, is readable only by the
#    running account, and is deleted in a trap whatever happens. It is
#    never printed, echoed into a command line, or committed.
# 2. The host key is pinned in the repository; StrictHostKeyChecking is on.
# 3. Only files this job actually publishes are installed, and every module
#    the changed artifacts require is published too.
# 4. The previous files are copied before installation so a failed
#    verification can restore them.
# 5. Verification happens against the live process (hash, syntax, health,
#    session data, and the close control).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KNOWN_HOSTS="$REPO_ROOT/monitor-server/bw-tools-known-hosts"
KEY_PATH="${RUNNER_TEMP:-/tmp}/devwf-monitor-deploy.key"
TARGET="devwf-monitor-deploy@100.77.138.14"
INCOMING="/home/devwf-monitor-deploy/incoming"
BASE_URL="http://100.77.138.14:3100"

SSH_OPTS=(
  -n -i "$KEY_PATH"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o ConnectTimeout=20
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$KNOWN_HOSTS"
)
SCP_OPTS=(
  -q -i "$KEY_PATH"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o ConnectTimeout=20
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$KNOWN_HOSTS"
)

# artifact tuples: local_file staged_name installed_path previous_name
declare -a LOCALS STAGED INSTALLED PREVIOUS
LOCALS=(
  "$REPO_ROOT/monitor-server/dashboard.cjs"
  "$REPO_ROOT/monitor-server/machines-query.cjs"
  "$REPO_ROOT/monitor-server/task-metadata.cjs"
  "$REPO_ROOT/monitor-server/empty-session.cjs"
  "$REPO_ROOT/monitor-server/project-summary.cjs"
  "$REPO_ROOT/monitor-server/sessions-query.cjs"
  "$REPO_ROOT/monitor-server/session-upsert.cjs"
  "$REPO_ROOT/monitor-server/visible-task-sessions.cjs"
  "$REPO_ROOT/monitor-server/cleanup-empty-sessions.cjs"
  "$REPO_ROOT/monitor-server/history-query.cjs"
)
STAGED=(
  monitor.cjs machines-query.cjs task-metadata.cjs empty-session.cjs
  project-summary.cjs sessions-query.cjs session-upsert.cjs
  visible-task-sessions.cjs cleanup-empty-sessions.cjs history-query.cjs
)
INSTALLED=(
  /opt/devwf-monitor/monitor.cjs
  /opt/devwf-monitor/machines-query.cjs
  /opt/devwf-monitor/task-metadata.cjs
  /opt/devwf-monitor/empty-session.cjs
  /opt/devwf-monitor/project-summary.cjs
  /opt/devwf-monitor/sessions-query.cjs
  /opt/devwf-monitor/session-upsert.cjs
  /opt/devwf-monitor/visible-task-sessions.cjs
  /opt/devwf-monitor/cleanup-empty-sessions.cjs
  /opt/devwf-monitor/history-query.cjs
)
PREVIOUS=(
  monitor.previous.cjs machines-query.previous.cjs task-metadata.previous.cjs
  empty-session.previous.cjs project-summary.previous.cjs
  sessions-query.previous.cjs session-upsert.previous.cjs
  visible-task-sessions.previous.cjs cleanup-empty-sessions.previous.cjs
  history-query.previous.cjs
)

DEPLOYED=false
COUNT=${#LOCALS[@]}

deploy_ssh() { ssh "${SSH_OPTS[@]}" "$TARGET" "$1"; }
deploy_scp() { scp "${SCP_OPTS[@]}" "$1" "${TARGET}:$2"; }

cleanup() {
  if [[ -f "$KEY_PATH" ]]; then rm -f "$KEY_PATH"; fi
}
trap cleanup EXIT

# Preflight checks
if [[ -z "${MONITOR_DEPLOY_SSH_KEY:-}" ]]; then
  echo "ERROR: MONITOR_DEPLOY_SSH_KEY is missing." >&2; exit 1
fi
if [[ ! -f "$KNOWN_HOSTS" ]]; then
  echo "ERROR: The pinned host key file is missing: $KNOWN_HOSTS" >&2; exit 1
fi
for ((i=0; i<COUNT; i++)); do
  if [[ ! -f "${LOCALS[$i]}" ]]; then
    echo "ERROR: Reviewed artifact is missing: ${LOCALS[$i]}" >&2; exit 1
  fi
done

# Write & lock the SSH key (chmod 600 is what OpenSSH requires on Linux)
printf '%s\n' "${MONITOR_DEPLOY_SSH_KEY%$'\n'}" > "$KEY_PATH"
chmod 600 "$KEY_PATH"

deploy_ssh "mkdir -p $INCOMING"

# Snapshot the installed files before anything is replaced
for ((i=0; i<COUNT; i++)); do
  deploy_ssh "cp ${INSTALLED[$i]} $INCOMING/${PREVIOUS[$i]}"
done

# Upload, verify hash, and syntax-check each artifact
for ((i=0; i<COUNT; i++)); do
  deploy_scp "${LOCALS[$i]}" "$INCOMING/${STAGED[$i]}"

  remote_hash=$(deploy_ssh "sha256sum $INCOMING/${STAGED[$i]}" | awk '{print $1}')
  local_hash=$(sha256sum "${LOCALS[$i]}" | awk '{print $1}')
  if [[ "$remote_hash" != "$local_hash" ]]; then
    echo "ERROR: Hash mismatch for ${STAGED[$i]} (local=$local_hash remote=$remote_hash)" >&2; exit 1
  fi

  deploy_ssh "node --check $INCOMING/${STAGED[$i]}"
done

# Install and restart
DEPLOYED=true
for ((i=0; i<COUNT; i++)); do
  deploy_ssh "sudo -n /usr/bin/install -m 644 $INCOMING/${STAGED[$i]} ${INSTALLED[$i]}"
done
deploy_ssh "sudo -n /usr/bin/systemctl restart devwf-monitor.service"

# Health check with retries
health_ok=false
for attempt in $(seq 1 10); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$BASE_URL/health" 2>/dev/null || true)
  if [[ "$code" == "200" ]]; then health_ok=true; break; fi
  echo "Health attempt $attempt/10: HTTP $code, waiting 2s..."
  sleep 2
done
if [[ "$health_ok" != "true" ]]; then
  echo "ERROR: Monitor health endpoint did not return HTTP 200 after the restart." >&2
  if [[ "$DEPLOYED" == "true" ]]; then
    echo "Rolling back..." >&2
    for ((i=0; i<COUNT; i++)); do
      deploy_ssh "sudo -n /usr/bin/install -m 644 $INCOMING/${PREVIOUS[$i]} ${INSTALLED[$i]}" || true
    done
    deploy_ssh "sudo -n /usr/bin/systemctl restart devwf-monitor.service" || true
    echo "Rollback complete." >&2
  fi
  exit 1
fi

# Verify retired test machine is gone
sessions=$(curl -s --max-time 15 "$BASE_URL/api/sessions")
if echo "$sessions" | grep -q '"machine":"uji"'; then
  echo "ERROR: The retired test machine is still visible in /api/sessions." >&2; exit 1
fi

# Verify close-control reset in dashboard
page=$(curl -s --max-time 15 "$BASE_URL/")
if ! echo "$page" | grep -q 'closeBtn\.disabled = false'; then
  echo "ERROR: The live dashboard does not contain the close-control reset." >&2; exit 1
fi

echo "Monitor deployment verified: health 200, retired test machine absent, close control reset present."
