# Fleet parity: is every device the same?

Date: **10 November 2026**.

## The question this answers

The owner asked for one screen that shows whether every device is on the same
MCP release, whether that MCP is actually running there, and whether the
commands the work depends on are installed everywhere — `gh`, `glab`,
`wrangler`, `gcloud`, and the Node toolchain. Without it, a missing binary only
announces itself in the middle of a task, as a `command not found` in a session
that already spent its context.

Two different questions live here and they are answered separately:

| Question | Source | Field |
|---|---|---|
| Is the MCP the same release everywhere? | `DEVWF_RELEASE_VERSION` / `REVISION` in the snapshot | `versionStatus` |
| Can every device run the same work? | versions of the required tools | `toolsStatus` |

## How the versions are collected

`toolchain.js` probes each required tool once per process with `--version`,
extracts the first version-shaped token, and caches the result for the life of
the process. A missing binary is recorded as `null`, never guessed. Each probe is
bounded by a 4 second timeout and the whole detection is started without being
awaited, so a slow or absent tool costs nothing at startup.

`monitor.js` puts the cached result into every snapshot. `session-upsert.cjs`
stores it in `sessions.toolchain_json` (jsonb, bounded to 20 entries of 40
characters). A sparse report never erases the last known toolchain, the same
rule the release version already followed.

## Three verdicts, not two

- `same` — the value matches the fleet majority.
- `differs` — the value is different from the majority.
- `unreported` — nothing was reported at all.

A machine that reports no toolchain is `unreported`, **not** "in sync". This was
not the first implementation: the live monitor showed three devices as in sync
while not one of them had ever reported a tool version. A green badge that means
"no data" is worse than no badge, because it stops the owner from looking.

The reference value is the **majority**, not the first row. Comparing against the
first row makes a single stale device look like the reference. When there is an
even split there is no majority, and both values are then reported as differing
from "nothing".

## Where it is visible

The **Mesin** tab shows one summary card (majority version, majority revision,
the union of required tools with their majority version) followed by one card per
machine:

```
● Mac                     v1.28.0 · versi sama · alat belum dilapor
  12 sesi · fase terakhir coding · terakhir melapor 2 menit lalu
  gh 2.40.1   glab ✕   wrangler 3.78.12   gcloud 458.0.0   node 20.11.0   npm 10.2.4
```

A `✕` on a tool means it is not installed; a `?` means no machine has reported it
yet; an amber chip means the version differs from the majority.

The KPI strip repeats the verdict in one line ("versi sama di semua mesin" or
"versi menyimpang di 1 mesin"), computed from the rows that are displayed so the
number can never disagree with the screen.

## Deploying a change to this feature

The monitor on `build-host.example` is not a git checkout; it is `/opt/devwf-monitor` with
the entry point `monitor.cjs` (the repository file is `dashboard.cjs`).

```sh
# 1. Back up the sessions table and add the column, in one transaction.
node scripts/apply-monitor-migration.cjs monitor-server/migrations/004-toolchain.sql

# 2. Copy the changed files (keep the .bak-<timestamp> convention).
sudo install -m 644 fleet-parity.cjs machines-query.cjs session-upsert.cjs \
  sessions-query.cjs /opt/devwf-monitor/
sudo install -m 644 dashboard.cjs /opt/devwf-monitor/monitor.cjs

# 3. Restart and read the result back.
sudo systemctl restart devwf-monitor
curl -s http://127.0.0.1:3100/api/sessions | jq '.fleet'
```

The migration must run **before** the new `session-upsert.cjs` is copied,
because the new upsert writes `toolchain_json`.

## Verification

- `tests/toolchain.test.js` — version extraction for every tool's own output
  format, and "missing is reported, never guessed".
- `tests/fleet-parity.test.js` — majority, ties, drift, missing vs unreported,
  and the false-green rule.
- `tests/fleet-parity-dashboard.test.js` — the query carries the inputs, the
  dashboard computes and sends the result, and the panel renders it.
