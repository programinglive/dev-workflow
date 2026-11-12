# Architectural Addendum #5 — Phase Zero (F0) Root-Cause Audit
## Why DevWorkflow MCP Updates Do Not Consistently Converge Across MMCH, HELLOWORLD, and Mac

- **Audited At:** `2026-11-12T23:30:00+07:00`
- **Audited Components:** `managed/publish.cjs`, `managed/protocol.cjs`, `managed/launcher.cjs`, `managed/device-entry.cjs`, `managed/rollout.cjs`, `managed/restart-devices.cjs`, `managed/fleet-status.cjs`, `managed/mcp-reconnect.cjs`, `bin/cli.js`, `monitor-server/fleet-parity.cjs`, `monitor-server/machines-query.cjs`

---

## 1. Executive Summary of Root Causes

An empirical code audit of `managed/*`, `cli/*`, and `monitor-server/*` revealed **eight structural root causes** explaining why a release can be promoted and prewarmed yet leave `MMCH`, `HELLOWORLD`, and `Mac` on inconsistent runtime versions or stale MCP tool definitions.

| # | Failure Category | Root Cause Identified in Existing Code | Empirical Code Location |
| :--- | :--- | :--- | :--- |
| **RC-1** | **Prewarm Conflated with Running Process Version** | `fleet-status.cjs` counts running `node.exe` processes (`ALIVE=n`), then invokes `device-entry.cjs <client> --resolve-only` in a *new* short-lived process. `--resolve-only` reports what the *next* process launch will load (`STAGED`), NOT what the currently running `ManagedMCP` process has loaded in memory (`ACTIVE`). Thus `fleet-status.cjs` prints `"All devices and clients agree"` even while a long-running session is still executing an old revision in memory. | `managed/fleet-status.cjs:69-100`, `managed/launcher.cjs:143` |
| **RC-2** | **Destructive Force-Kill Blocks Safe Activation** | `restart-devices.cjs` unconditionally kills all `ManagedMCP` processes (`Stop-Process -Force` / `pkill -f ManagedMCP`) AND force-closes `codex`, `agy`, and `antigravity` client processes (`WINDOWS_KILL_CLIENTS` / `MAC_KILL_CLIENTS`) without checking active sessions or task leases. To avoid killing active work (e.g., `dbpinball` on `HELLOWORLD`), operators must skip `restart-devices.cjs`, leaving the fleet permanently in an unactivated state. | `managed/restart-devices.cjs:40-58`, `77-81`, `161-184` |
| **RC-3** | **Missing Tool Catalog Digest & Extended Release Manifest** | `publish.cjs` and `protocol.cjs` only include `{ revision, sha256, size, version }`. There is no `toolCatalogDigest` (SHA-256 of the MCP tool definitions), `schemaVersion`, `releaseId`, `channel`, `minimumCompatibleClient`, or `rolloutStatus`. Neither the runtime nor the client can detect when the MCP tool schema catalog has changed. | `managed/publish.cjs:24-28`, `managed/protocol.cjs:22-33` |
| **RC-4** | **No Per-Process Runtime Registry or Side-by-Side Pinning Ledger** | `launcher.cjs` extracts archives into side-by-side directories (`releases/<sha256>-<runtimeKey>`), which prevents file-in-place corruption, but never records a live process lease (`pid`, `client`, `runningRevision`, `runningVersion`, `toolCatalogDigest`, `sessionKey`, `startedAt`) in a local supervisor state file. Consequently, a machine cannot distinguish `STAGED` vs. `PINNED_ACTIVE_SESSION` vs. `CONVERGED`. | `managed/launcher.cjs:44`, `140-166` |
| **RC-5** | **Client Refresh Capability Mismatch (`OpenCode` vs. `Codex` vs. `Antigravity`)** | MCP stdio processes load their ES module graph once at process start; MCP `notifications/tools/list_changed` notifies a client to re-fetch `tools/list`, but cannot hot-swap old JS code inside a running child process unless the child process is restarted or routed. `OpenCode` supports `opencode service restart` + `/api/experimental/mcp/<name>/connect`, whereas `Codex` and `Antigravity` own the stdio child directly and require `CLIENT_RECONNECT_REQUIRED` (never `Stop-Process -Force` on the user's IDE!). | `managed/restart-devices.cjs:17-20`, `managed/mcp-reconnect.cjs:187-191` |
| **RC-6** | **Hardcoded macOS Node Path in `rollout.cjs`** | `rollout.cjs` line 65 hardcodes `/Users/mahardhika/.nvm/versions/node/v24.22.1/bin/node` for Mac prewarming, whereas `fleet-status.cjs` uses a dynamic fallback chain (`command -v node`, `~/.nvm/versions/node/*/bin/node`, `/opt/homebrew/bin/node`). Any Node patch upgrade on `Mac` silently breaks `rollout.cjs` prewarming. | `managed/rollout.cjs:65` vs. `managed/fleet-status.cjs:87-90` |
| **RC-7** | **Fragmented CLI Surface for Operators & Agents** | Fleet operations are split across 5 internal scripts (`publish.cjs`, `rollout.cjs`, `restart-devices.cjs`, `fleet-status.cjs`, `mcp-reconnect.cjs`) and are completely absent from the canonical `devwf` CLI (`bin/cli.js`). Agents guess commands instead of calling a unified `devwf fleet <subcommand>`. | `bin/cli.js:1-73`, `cli/args.js:17` |
| **RC-8** | **Monitor Dashboard Shows Last-Session Version, Not Live Convergence** | `monitor-server/machines-query.cjs` and `fleet-parity.cjs` only read `release_version` and `release_revision` from the latest `sessions` row in PostgreSQL. An idle machine that just staged an update (`MMCH` or `Mac`), or a machine with 1 pinned session and 1 staged update (`HELLOWORLD`), shows outdated or incomplete status on `http://100.77.138.14:3100`. | `monitor-server/machines-query.cjs:78-80`, `monitor-server/fleet-parity.cjs:66-160` |

---

## 2. Actual Process & Client Ownership Model

```text
+-------------------------------------------------------------------------+
| Central Release Controller (bw-tools:3101 OR Local-First File Store)     |
|  - /var/lib/devwf-releases/current.json (Release Manifest v1)           |
|  - /var/lib/devwf-releases/releases/<sha256>.tar.gz (Immutable Archive) |
|  - /var/lib/devwf-releases/rollback-<shortSha>.json (Approved Rollback) |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
| Per-Machine ManagedMCP Cache & Update Supervisor                        |
|  - Root: %LOCALAPPDATA%/ProgramingLive/ManagedMCP (Win)                 |
|          ~/.local/share/ProgramingLive/ManagedMCP (macOS/Linux)         |
|  - releases/<sha256>-<platform>-<arch>-<abi>/ (Side-by-Side Immutable)  |
|  - supervisor/state.json (Update State, Installed/Staged/Target/Rollback|
|  - supervisor/processes/<pid>.json (Live Running Process Registry)      |
+-------------------------------------------------------------------------+
           |                        |                        |
           v                        v                        v
+--------------------+   +--------------------+   +-----------------------+
| OpenCode           |   | Codex CLI          |   | Antigravity (CLI/IDE) |
| - Daemon service   |   | - Direct stdio     |   | - Direct stdio        |
| - Refresh adapter: |   |   child process    |   |   child process       |
|   service restart  |   | - Refresh adapter: |   | - Refresh adapter:    |
|   + /api/mcp heal  |   |   next spawn uses  |   |   next spawn uses     |
|   WHEN NO ACTIVE   |   |   staged runtime;  |   |   staged runtime;     |
|   CRITICAL SESSION |   |   live session ->  |   |   live session ->     |
|                    |   |   CLIENT_RECONNECT |   |   CLIENT_RECONNECT    |
+--------------------+   +--------------------+   +-----------------------+
```

---

## 3. Client Refresh Compatibility Matrix

| Client | Process Ownership Model | Hot-Reload CLI / API Available? | MCP `notifications/tools/list_changed` Behavior | Safe Refresh Strategy |
| :--- | :--- | :--- | :--- | :--- |
| **`opencode`** | Background service spawns `device-entry.cjs opencode` per active project directory | **Yes:** `opencode service restart` + `opencode api post /api/experimental/mcp/dev-workflow/connect` | Refreshes tool list on reconnect | **Automatic Safe Refresh when idle** (`0` active critical coding sessions on machine); **`WAITING_FOR_SAFE_CUTOVER` / `PINNED_ACTIVE_SESSION`** when a coding session is active |
| **`codex`** | `codex` process spawns `device-entry.cjs codex` over stdio for the session lifetime | **No** external reload CLI | Refreshes tool schema metadata only if same process emits notification; cannot swap loaded ESM runtime code in-process | **Side-by-Side Pinning:** New `codex` invocations immediately resolve the new staged runtime; existing running `codex` process is never force-killed and reports **`CLIENT_RECONNECT_REQUIRED`** |
| **`antigravity`** | `agy` / Antigravity IDE spawns `device-entry.cjs antigravity` over stdio | **No** external reload CLI (never kill the user's IDE!) | Same as Codex: stdio process is bound to startup runtime directory | **Side-by-Side Pinning:** New conversations/window reloads immediately use the staged runtime; active IDE session is protected and reports **`CLIENT_RECONNECT_REQUIRED`** |
| **`local-standalone`** | Direct `node index.js` or local `devwf` without `bw-tools` | N/A (Local-First OSS mode) | N/A | Operates 100% offline using local `package.json` + local supervisor state without requiring `bw-tools` |

---

## 4. Migration & Implementation Plan (Milestones F1–F7)

1. **F1 — Release Manifest v1 & Tool Catalog Digest (`managed/protocol.cjs`, `managed/publish.cjs`, `managed/fleet-update-manager.cjs`):**
   - Compute deterministic `toolCatalogDigest` (`sha256:<hex>`) over the canonical MCP tool registry (`index.js` / tool schemas).
   - Extend the release manifest contract in `protocol.cjs` and `publish.cjs` (backward-compatible with existing readers) to include `schemaVersion: 1`, `releaseId`, `version`, `revision`, `sha256`, `artifactDigest` (`sha256:...`), `size`, `channel`, `minimumCompatibleClient`, `toolCatalogDigest`, and `rolloutStatus`.
   - Enforce forward-only lineage, downgrade protection, and SHA-256 digest validation.
2. **F2 & F3 — Per-Machine Update Supervisor & Session-Safe Side-by-Side Cutover (`managed/fleet-update-manager.cjs`, `managed/launcher.cjs`):**
   - Implement the 10-state Update Supervisor state machine (`UP_TO_DATE`, `UPDATE_AVAILABLE`, `DOWNLOADING`, `STAGED`, `WAITING_FOR_SAFE_CUTOVER`, `ACTIVATING`, `VERIFYING`, `ACTIVE`, `FAILED`, `ROLLBACK_REQUIRED`).
   - Record live running MCP process leases (`pid`, `client`, `revision`, `version`, `toolCatalogDigest`, `sessionKey`, `startedAt`) so `launcher.cjs` and the supervisor know exactly which revisions are currently running in memory versus staged on disk.
   - Never overwrite an active runtime directory in place or kill an active coding session (`PINNED_ACTIVE_SESSION`).
3. **F4 — MCP Tool Catalog Synchronization & Client Refresh Adapters (`managed/fleet-update-manager.cjs`, `managed/restart-devices.cjs`):**
   - Expose runtime version, revision, and `toolCatalogDigest` from the MCP runtime and supervisor.
   - Replace unconditional `WINDOWS_KILL_CLIENTS` / `MAC_KILL_CLIENTS` in safe mode with session-aware cutover: never force-kill `codex` or `antigravity` without explicit `--force-close-clients` authorization; instead report `CLIENT_RECONNECT_REQUIRED`.
4. **F5 & F6 — CLI-First `devwf fleet` Interface & Monitor Dashboard Visibility (`bin/cli.js`, `cli/args.js`, `cli/commands.js`, `monitor-server/dashboard.cjs`):**
   - Implement `devwf fleet status | check | plan | stage | activate | verify | rollback | doctor` supporting `--json`, `--mode <manual|safe-auto|scheduled|security>`, `--dry-run`, and `--authorize`.
   - Extend `monitor-server/dashboard.cjs` (`#tab-mesin` and `/api/v1/fleet/convergence`) to display per-machine `Installed Version`, `Running Version`, `Target Version`, `Tool Catalog Digest`, `Convergence Status` (`CONVERGED`, `STAGED`, `PINNED_ACTIVE_SESSION`, `CLIENT_REFRESH_REQUIRED`, `OFFLINE`, `VERSION_MISMATCH`, `FAILED`), `Active Sessions`, and `Doctor Remediation`.
5. **F7 — 20-Scenario Automated Verification (`tests/fleet-update-manager-f0-f7.test.js`):**
   - Verify all 20 required scenarios in isolated temporary directories and disposable processes without disrupting active sessions on `HELLOWORLD`, `Mac`, or `MMCH`.
