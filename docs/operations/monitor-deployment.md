# Monitor deployment and Session Reaper rollout

**Status:** procedure ready; every step below is a production mutation and needs
its own explicit owner approval. CI never performs any of it.

CI verifies the code and then prints a notice. A green CI run means "the commit
is verified", never "production was changed".

## 0. Facts this procedure depends on

| Item | Value |
|---|---|
| Monitor host | `bw-tools` (`monitor-host.example`) |
| Service | `devwf-monitor.service` |
| Deploy directory | `/opt/devwf-monitor` (root-owned) |
| Environment file | `/etc/devwf-monitor.env` (root, mode 600) |
| **Entrypoint** | `/usr/bin/env node /opt/devwf-monitor/monitor.cjs` |
| Listen address | `monitor-host.example:3100` (Tailscale only) |
| Database | `db-host.example:5432/devwf_monitor` (PostgreSQL 16, ~11 MB) |
| Runner user | `dhika`, with `sudo` |

The repository ships `monitor-server/dashboard.cjs`; the unit runs
`monitor.cjs`. The deployment copies the file to **both** names. Deploying only
`dashboard.cjs` leaves the running service on the old code.

## 1. Backup (mandatory before any write)

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
sudo -n sh -c '. /dev/null; set -a; while IFS= read -r line; do
  case "$line" in \#*|"") continue;; esac
  key=${line%%=*}; val=${line#*=}; export "$key=$val"; done < /etc/devwf-monitor.env
  pg_dump "$DATABASE_URL" | gzip -9 > /var/backups/devwf_monitor_$STAMP.sql.gz'
sudo -n sha256sum /var/backups/devwf_monitor_$STAMP.sql.gz
sudo -n gzip -t /var/backups/devwf_monitor_$STAMP.sql.gz && echo "gzip ok"
sudo -n cp -a /opt/devwf-monitor /var/backups/devwf-monitor_$STAMP
```

Record the path, size and sha256 in the task before the first write. Copy the
archive off the host. Never `source /etc/devwf-monitor.env`: it contains values
with spaces (`IDLE_TTL=30 minutes`) and sourcing runs `minutes` as a command.

## 2. Migration 005 (additive)

```bash
sudo -n sh -c 'set -a; while IFS= read -r line; do
  case "$line" in \#*|"") continue;; esac
  key=${line%%=*}; val=${line#*=}; export "$key=$val"; done < /etc/devwf-monitor.env
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /opt/devwf-monitor/migrations/005-reaper-owner.sql'
```

The migration is `ADD COLUMN IF NOT EXISTS` with defaults, so it is idempotent
and safe to re-run. It adds `owner_started_at`, `owner_executable`,
`lease_owner`, `lease_generation`, `lease_fencing_token`.

## 3. Deploy the backend

```bash
cd /path/to/verified/checkout
sudo -n install -m 644 monitor-server/dashboard.cjs        /opt/devwf-monitor/dashboard.cjs
sudo -n install -m 644 monitor-server/dashboard.cjs        /opt/devwf-monitor/monitor.cjs
sudo -n install -m 644 monitor-server/session-upsert.cjs   /opt/devwf-monitor/session-upsert.cjs
sudo -n install -m 644 monitor-server/sessions-query.cjs   /opt/devwf-monitor/sessions-query.cjs
sudo -n install -m 644 monitor-server/reaper-query.cjs     /opt/devwf-monitor/reaper-query.cjs
sudo -n install -m 644 monitor-server/reaper-scheduler.cjs /opt/devwf-monitor/reaper-scheduler.cjs
sudo -n install -m 644 monitor-server/reaper-actions.cjs   /opt/devwf-monitor/reaper-actions.cjs
sudo -n install -m 644 monitor-server/migrations/005-reaper-owner.sql /opt/devwf-monitor/migrations/005-reaper-owner.sql
```

`scripts/verify-monitor-deployment.mjs` derives the full dependency closure from
`monitor.cjs`, so a missing module is reported instead of discovered at runtime.

## 4. Credentials (per machine)

Do not use one shared secret. Write a JSON map, one entry per machine:

```bash
sudo -n sh -c 'umask 077; cat > /etc/devwf-monitor.env.d/reaper <<EOF
DEVWF_REAPER_SECRETS={"MMCH":"<32+ random>","HELLOWORLD":"<32+ random>","Mac":"<32+ random>"}
EOF'
```

Then add `EnvironmentFile=/etc/devwf-monitor.env.d/reaper` to the unit, or append
the single line to `/etc/devwf-monitor.env` (mode 600). Rotating one machine means
replacing one value and restarting; revoking one machine means deleting one key.
`DEVWF_REAPER_SECRET` remains supported as a single-machine fallback.

Leave `DEVWF_REAPER_DRY_RUN` unset for the canary.

## 5. Restart and verify

```bash
sudo -n systemctl restart devwf-monitor
sudo -n systemctl is-active devwf-monitor
node scripts/verify-monitor-deployment.mjs \
  --base-url http://monitor-host.example:3100 \
  --dir /opt/devwf-monitor \
  --env-file /etc/devwf-monitor.env \
  --machine MMCH \
  --db "$DATABASE_URL"
```

The verifier is read-only. It checks `/health`, the dependency closure, the
environment file, the privileged endpoint (unsigned 401, signed 200), the public
payload (no owner or lease field), and the migration columns.

## 6. Machine controllers

Install on each machine with that machine's own secret:

| Machine | OS | Secret key |
|---|---|---|
| MMCH | Windows | `MMCH` |
| HELLOWORLD | Windows | `HELLOWORLD` |
| Mac | macOS | `Mac` |

The controller verifies PID + creation time + executable locally, refuses a
session from another machine (`REMOTE_SESSION_REFUSED`), and refuses a PID shared
by more than one session (`SHARED_PROCESS_REFUSED`). It never escalates to a
force kill.

## 7. Canary (read-only)

1. Keep `DEVWF_REAPER_DRY_RUN` unset.
2. Wait one scheduler interval (default 5 minutes) or run one cycle manually.
3. Confirm the dashboard shows `reaper:` states and that the 12 legacy rows
   without `owner_pid` are `RECOVERY_REQUIRED`.
4. Confirm active sessions are `ACTIVE` and no card was archived.
5. Confirm the Xiaomi Pad shows the same states.

## 8. Enable verified-orphan archival

Only after the canary passes and with explicit approval:

```bash
sudo -n sh -c 'printf "\nDEVWF_REAPER_DRY_RUN=0\n" >> /etc/devwf-monitor.env'
sudo -n systemctl restart devwf-monitor
```

Only a confirmed `ORPHANED` row is archived, and archiving is a `phase` update,
never a delete. Lease release stays with the machine controller and its
compare-and-swap on owner + generation + fencing token.

## 9. Rollback

```bash
sudo -n sh -c 'sed -i "/^DEVWF_REAPER_DRY_RUN=/d" /etc/devwf-monitor.env'
sudo -n cp -a /var/backups/devwf-monitor_<STAMP>/. /opt/devwf-monitor/
sudo -n systemctl restart devwf-monitor
```

The scheduler returns to observation. Migration 005 is additive and may stay; a
database restore is only needed if a write is proven wrong, and then it is
`gunzip -c /var/backups/devwf_monitor_<STAMP>.sql.gz | psql "$DATABASE_URL"`.

## 10. What this procedure never does

- It never terminates a process automatically.
- It never releases a lease without a matching owner, generation and fencing token.
- It never archives an ambiguous or active session.
- It never exposes a credential to a browser.
- It never runs from CI.
