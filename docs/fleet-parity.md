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

### Why the probe resolves the executable first (16 November 2026)

On Windows the probe used to run a shell string with every token double-quoted:
`"npm" "--version"`. npm, gcloud and wrangler are `.cmd` shims there, and cmd
derives `%~dp0` from `%0` - so a quoted **bare name** made the shim look for its
own internals in the current directory:

```
cmd /c ""npm" "--version""     -> Error: Cannot find module '...\node_modules\npm\bin\npm-prefix.js'
cmd /c "npm --version"         -> 11.19.0
cmd /c ""gcloud" "--version""  -> can't open file '...\..\lib\gcloud.py'
cmd /c "gcloud --version"      -> Google Cloud SDK 569.0.0
```

The panel therefore reported `npm` and `gcloud` as *missing* on both Windows
machines, where both were installed and working. `resolveExecutable()` now finds
the real file on `PATH` (honouring `PATHEXT` on Windows), and the probe runs it
in one of two ways:

| Kind | How it runs |
|---|---|
| native (`gh.exe`, `node`, `/usr/local/bin/glab`) | no shell, argument array |
| batch shim (`npm.cmd`, `gcloud.cmd`) | through cmd with the **absolute path** as one quoted token |

A resolved path is also the evidence a parity report needs: "which file is this
version?", answered by `npm run toolchain:doctor`.

## The target is a decision, not a poll

The reference value used to be the **majority** of what machines last reported.
That is a poll, and on 16 November 2026 the poll was wrong: HELLOWORLD ran the
approved release 1.32.1 while MMCH and Mac had not restarted, so 1.31.0 won the
majority and the panel recommended the stale version while flagging the correct
machine as the odd one out.

Two files now decide, and `targetSource` says which one answered:

| Source | File | Used when |
|---|---|---|
| `approved` | `DEVWF_APPROVED_RELEASE_FILE` (`/var/lib/devwf-releases/current.json`) | the release host promoted a `stable` release |
| `reported-majority` | machine snapshots | no approved release is readable |

The pinned toolchain works the same way: `managed/fleet-toolchain.json` is the
fleet manifest, and a pin beats a majority so machines that have not been updated
yet cannot outvote the version the fleet agreed on. `tools[].pinned` marks which
expectations came from the manifest.

`Installed` and `Running` are separate facts. Nothing reports an installed
version yet, so `Installed` shows `belum dilapor` instead of copying the running
version and pretending an installation was verified.

## Three verdicts, not two

- `same` - the value matches the target (approved release or pin).
- `differs` - the value is different from the target.
- `unreported` - nothing was reported at all.

A machine that reports no toolchain is `unreported`, **not** "in sync". This was
not the first implementation: the live monitor showed three devices as in sync
while not one of them had ever reported a tool version. A green badge that means
"no data" is worse than no badge, because it stops the owner from looking.

When no approved release or manifest is available, the fallback reference is the
**majority**, not the first row. Comparing against the first row makes a single
stale device look like the reference. When there is an even split there is no
majority, and both values are then reported as differing from "nothing".

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
sudo install -m 644 fleet-parity.cjs approved-release.cjs machines-query.cjs session-upsert.cjs \
  sessions-query.cjs /opt/devwf-monitor/
sudo install -m 644 dashboard.cjs /opt/devwf-monitor/monitor.cjs
sudo install -m 644 ../managed/fleet-toolchain.json /opt/devwf-monitor/fleet-toolchain.json

# 3. Point the service at the two files that decide the target (once).
#    DEVWF_APPROVED_RELEASE_FILE=/var/lib/devwf-releases/current.json
#    DEVWF_TOOLCHAIN_MANIFEST=/opt/devwf-monitor/fleet-toolchain.json
sudo systemctl restart devwf-monitor
curl -s http://127.0.0.1:3100/api/sessions | jq '.fleet.targetSource, .fleet.version'
```

`targetSource: "approved"` means the release host decided. Anything else means the
monitor fell back to the reported majority and the panel says so.

The migration must run **before** the new `session-upsert.cjs` is copied,
because the new upsert writes `toolchain_json`.

## Verification

- `tests/toolchain.test.js` — version extraction for every tool's own output
  format, and "missing is reported, never guessed".
- `tests/toolchain-probe.test.js` — executable resolution on Windows and POSIX,
  the batch-shim execution path that caused the false "missing", the manifest
  comparison, and the shipped pins.
- `tests/fleet-parity.test.js` — majority, ties, drift, missing vs unreported,
  and the false-green rule.
- `tests/fleet-parity-target.test.js` — the approved release and the pinned
  manifest decide the target, the fallback is labelled, and the client doctor
  never invents a runtime version.
- `tests/fleet-parity-dashboard.test.js` — the query carries the inputs, the
  dashboard computes and sends the result, and the panel renders it.
- `npm run toolchain:doctor` — the same check on any machine, on demand, with no
  session and no network: exit 0 when every pin matches, 1 on drift.
