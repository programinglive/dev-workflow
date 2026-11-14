# DevWorkflow MCP — Project Lock & Session Isolation Architecture Specification

- **Document ID:** `DEVWF-DES-2026-11-14-01`
- **Canonical DevWorkflow Task:** `8feef683-f09a-4d2c-9cda-0b91da603a10`
- **Zettly Tracking:** Todo `#756` | Focus `#81` | Draw `#398` / `#400`
- **Implementation Branch:** `fix/project-lock-session-isolation`
- **Target Component:** `workflow-state.js`, `process-lock.js`, `tools/handler-modules/workflow-handlers.js`, `index.js`

---

## 1. Architectural Overview & Objective

DevWorkflow MCP enforces the strict governance invariant:
> **One Active Writer per Working Tree** — preventing silent edit overwrites, race conditions, and Definition-of-Done destruction across multiple sessions or AI clients.

This specification details the permanent design that guarantees:
1. **Startup Working Directory Decoupling:** Multiple AI agents (Antigravity, Codex, OpenCode) launching from a shared root (e.g. `C:\Users\mahardhika`) do not falsely collide when targeting separate projects.
2. **Canonical Project Identity Pre-Resolution:** Canonical project paths and bucket directories are resolved *before* validating project locks or evaluating disk states.
3. **Atomic Lock Operations:** All lock acquisitions, stale takeovers, and corrupt file recoveries use OS-level atomic filesystem operations (`flag: "wx"`, atomic compare-owner tombstone rename).
4. **Lease Token Fencing:** Every lock acquisition or relocation generates a unique cryptographically random, monotonic `leaseId`. Heartbeat refreshes and releases are strictly fenced to the active lease token.
5. **Dynamic Lock Relocation:** When a task starts with an explicit target `projectDir`, the process lock and heartbeat target dynamically migrate from startup CWD to the target project bucket. If the startup lock was held by the current process, it is cleanly released.
6. **Robust Cross-Platform Holder Verification:** Windows process verification queries `tasklist` to detect PID reuse by non-Node processes.

---

## 2. Lock State Transition Model

```mermaid
flowchart TD
    A["MCP Server Startup (process.cwd())"] --> B["Acquire Startup Lock (flag: 'wx', leaseId_1)"]
    B --> C["Client Calls start_task(projectDir)"]
    C --> D["Resolve Canonical Project Identity & Target Bucket"]
    D --> E{"Is Target Project Held by Active Foreign Lock?"}
    E -- Yes (Alive & Fresh) --> F["Refuse start_task (Keep Current State Intact)"]
    E -- No / Stale / Force --> G{"Is Foreign Live Task on Target Disk?"}
    G -- Yes (Active & Writing) --> H["Refuse start_task (Preserve DoD Evidence)"]
    G -- No --> I["Relocate Process Lock (from CWD to Target Project)"]
    I --> J["Acquire Target Lock (flag: 'wx', leaseId_2)"]
    J --> K["Release Old Startup Lock (if owned by this PID)"]
    K --> L["Rebind Heartbeat & rememberedLockDir to Target"]
    L --> M["Reset & Save Task State in Target Project Bucket"]
    M --> N["Active Work / Heartbeat Refresh (leaseId_2)"]
    N --> O["process.on('exit') -> Release Active Relocated Lock"]
```

---

## 3. Core Subsystem Specifications

### 3.1 Canonical Project Identity Resolver (`workflow-state.js`)

#### 3.1.1 Path Normalization Rules
`canonicalProjectPath(candidate)` performs cross-platform path canonicalization:
1. Trims whitespace and strips null bytes.
2. Resolves relative paths via `path.resolve()`.
3. Resolves symlinks and Windows directory junctions via `fs.realpathSync.native()` when the directory exists on disk.
4. Normalizes path separators and strips trailing slashes (except root).
5. Enforces uppercase drive letters on Windows (e.g. `C:\...`).

#### 3.1.2 Target Project State Pre-Resolution
`resolveTargetProjectState({ stateFile, projectDir })`:
Given a startup `stateFile` in `.state/projects/<startup-bucket>/users/...` and a target `projectDir`:
- Computes `bucketKey = projectKey(canonicalTarget)`.
- Derives `targetStateFile = <baseDir>/projects/<bucketKey>/users/<user>/workflow-state.<sessionKey>.json`.
- Identifies `projectDirPath = <baseDir>/projects/<bucketKey>`.
- Allows `handleStartTask` to query `targetLockDir = projectLockDir(targetStateFile)` without mutating disk or memory state.

#### 3.1.3 Multi-Session Foreign Live Task Inspection
`findActiveForeignTaskInProject({ projectDirPath, targetStateFile, ownPid, now, staleMs, isAlive })`:
- Scans `targetStateFile`, root `workflow-state.json`, and all sibling session state files in `projectDirPath/users/*`.
- Detects whether any active live task (`phase !== "idle" && description !== ""`) is currently owned by an active foreign PID with fresh heartbeat (`updatedAt < 10m`).
- Blocks `start_task` even if `force: true` is passed, protecting uncompleted Definitions of Done from destruction.

---

### 3.2 Atomic Lock Acquisition & Recovery (`process-lock.js`)

#### 3.2.1 Atomic Creation via `flag: "wx"`
```javascript
const payload = { pid, leaseId: effectiveLeaseId, startedAt: now, heartbeatAt: now, host };
writeFileSync(lockFile, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
```
- If the file does not exist, `flag: "wx"` atomically creates it in kernel space. No other process can interleave.
- If the file exists, the call throws `EEXIST`, triggering detailed inspection (`readProcessLockDetailed`).

#### 3.2.2 Atomic Stale / Corrupt Takeover via Tombstone Rename
When a lock file is corrupt or held by a dead / stale PID:
```javascript
function tryClaimStaleOrCorruptLock(lockFile, expectedHolder) {
  const tombstone = `${lockFile}.tomb.${process.pid}.${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    renameSync(lockFile, tombstone);
    try { unlinkSync(tombstone); } catch {}
    return true;
  } catch {
    return false; // Another concurrent process won the atomic rename
  }
}
```
- The atomic rename (`renameSync`) guarantees that among $N$ concurrent processes attempting recovery, exactly one wins.
- Losers safely retry the acquisition loop to inspect the winner's new lock.

---

### 3.3 Dynamic Lock Relocation Protocol

When moving from `currentLockDir` to `targetLockDir`:
```javascript
export function relocateProcessLock({ fromDir, toDir, pid = process.pid, force = false, ... }) {
  if (path.resolve(fromDir) === path.resolve(toDir)) {
    // Same directory: simply refresh or re-acquire
    return { ok: true, sameDir: true };
  }
  // Step 1: Acquire target lock atomically with new lease token
  const targetAcquire = acquireProcessLock({ dir: toDir, pid, force, remember: true, ... });
  if (!targetAcquire.acquired) {
    return { ok: false, holder: targetAcquire.holder };
  }
  // Step 2: Release previous lock only if owned by this process and active lease matches
  if (fromDir) {
    releaseProcessLock({ dir: fromDir, pid, preserveRemembered: true });
  }
  return { ok: true, leaseId: targetAcquire.leaseId };
}
```
- If target lock acquisition fails, the startup lock remains active and unchanged.
- If target lock acquisition succeeds, the startup lock is unlinked only if owned by our PID, freeing the shared CWD for other processes.

---

### 3.4 Lease Token Fencing Against Delayed Timers

1. **Lease Generation:** `generateLeaseId(pid, now)` produces `lease-<pid>-<now>-<random8>`.
2. **Heartbeat Fencing:** `refreshProcessLock({ dir, pid, leaseId })`:
   - Compares lock file's `pid` and `leaseId`.
   - If `existing.leaseId !== rememberedLease.leaseId`, the heartbeat refresh is denied.
   - An outdated or desynchronized timer can never mutate a newly relocated lock or foreign owner's lock.

---

### 3.5 Clean Shutdown Protocol (`index.js`)

At process initialization:
```javascript
const lockDir = projectLockDir(workflowState.stateFile);
acquireProcessLock({ dir: lockDir });
process.once('exit', () => releaseActiveProcessLock({ fallbackDir: lockDir }));
```
`releaseActiveProcessLock({ fallbackDir })`:
- Reads `rememberedLockDir` (which points to the relocated target directory if relocation occurred).
- If relocation never occurred, falls back to `fallbackDir`.
- Releases the lock only if `existing.pid === process.pid` and `existing.leaseId === rememberedLockLease.leaseId`.

---

## 4. Verification Matrix

| Requirement | Design Solution | Test Verification |
| :--- | :--- | :--- |
| Decouple shared startup CWD | `resolveTargetProjectState` pre-resolution | Scenario A, F, I |
| Mutual exclusion on target project | Atomic `flag: "wx"` on target bucket | Scenario B |
| Clean lock migration | `relocateProcessLock` | Scenario C |
| Safe failure on held target | Atomicity check + unchanged startup lock | Scenario D |
| Crash & PID reuse recovery | Tombstone rename + `defaultIsHolderProcess` | Scenario E |
| Lease token fencing | Monotonic `leaseId` check in heartbeat/release | Scenario H |
| Backward compatibility | Normalized `projectKey` & bucket resolution | Scenario G |
| Multi-process CLI validation | Child processes executing CLI `start_task` | Scenario I |
| R2-1 Gate recovery safety | Fail-closed `LOCK_GATE_ABANDONED` + explicit `recoverAbandonedLockGate` under `mcp-process.gate.recover.lock` | R2-1 (two-process IPC barrier) |
| R2-2 Async reentrant release | Unified `releaseGateEntry` on `entry.count === 0` | R2-2 (out-of-order inner/outer async release) |
| R2-3 Async execution-context isolation | `AsyncLocalStorage` (`gateExecutionStorage` & `serializedExecutionStorage`) + `inProcessGateQueues` | R2-3 (concurrent Request A & Request B at `await`) |
| R2-4 Durable transition & crash recovery | `<base>/sessions/transition-<sessionKey>.journal.json` + `markTransitionJournalCommitted` + `rollbackTransitionJournal` + `reconcilePendingTransitionJournals` | R2-4 (post-save failure + `SIGKILL` crash recovery) |
| R2-5 Legacy exclusion & fleet quiescence | Unconditional `<base>/projects/*/mcp-process.lock` scan + `verifyLegacyFleetQuiescence` | R2-5 (missing/outdated session pointer + quiescence gate) |

---

## 5. Round 2 Concurrency & Durability Hardening (`R2-1` – `R2-5`)

### 5.1 R2-1: Fail-Closed Gate Acquisition & Controlled Abandoned-Gate Recovery
- **Elimination of Pathname Recovery Races in Normal Acquisition:** `acquireLockGate` **never** calls `renameSync` or `unlinkSync` on an existing `mcp-process.gate.lock`. If the recorded gate holder process is confirmed dead (or the gate remains unreadable past `gateCorruptGraceMs`), `acquireLockGate` fails closed and returns `{ acquired: false, error: "LOCK_GATE_ABANDONED", abandoned: true, holder }`.
- **Controlled Operator-Authorized Recovery (`recoverAbandonedLockGate`):** Recovery of an abandoned gate requires an explicit call to `recoverAbandonedLockGate({ dir, expectedToken, authorizeAbandonedGateRecovery: true })`:
  1. Enforces `authorizeAbandonedGateRecovery === true` and a non-empty `expectedToken` matching the abandoned gate's `gateToken`.
  2. Acquires an exclusive recovery mutex file `mcp-process.gate.recover.lock` (`GATE_RECOVER_FILENAME`) via `publishCompleteJsonFile`. Normal `acquireLockGate` yields while `mcp-process.gate.recover.lock` is held by a live recovery process.
  3. Re-reads `mcp-process.gate.lock` inside the recovery lock, re-verifies `existing.gateToken === expectedToken`, confirms the holder is dead, and only then renames `mcp-process.gate.lock` to a tombstone and unlinks it. A delayed second recovery process sees `gate_token_mismatch` and cannot affect a successor's newly acquired gate.

### 5.2 R2-2 & R2-3: Execution-Context-Scoped Async Ownership & Last-Holder Gate Cleanup
- **`AsyncLocalStorage` Execution Context Scoping:**
  - `process-lock.js` uses `gateExecutionStorage = new AsyncLocalStorage()` instead of a process-wide `Map` for re-entrancy detection. `acquireLockGate` and `withLockGate` recognize a call as re-entrant **only** if `gateExecutionStorage.getStore()?.get(resolvedDir)` is present in the caller's async execution chain and its `entry.closed === false`.
  - `workflow-state.js` uses `serializedExecutionStorage = new AsyncLocalStorage()` in `WorkflowState.prototype.runSerialized(fn)` instead of an instance-wide `this._inSerializedOp` counter. Independent requests arriving while an operation is suspended at an `await` never bypass `this._opQueue` or `inProcessGateQueues`.
- **Last-Holder Gate Release (`releaseGateEntry`):**
  - Both outer (`reentrant: false`) and nested (`reentrant: true`) gate handles invoke `releaseGateEntry(resolvedDir, entry)` with an idempotent per-handle guard.
  - When any handle releases, `entry.count` is decremented (`entry.count -= 1`). When and only when `entry.count === 0` (the last valid holder in the execution tree exits), `entry.closed = true` is set and `mcp-process.gate.lock` is verified by `gateToken` and unlinked.

### 5.3 R2-4: Durable Transition Journal, Authoritative Commit Point, and Crash Recovery
- **Pre-Mutation Durable Journal (`beginTransitionJournal`):** Before `handleStartTask` mutates session pointers, focus bindings, or target/source state files, it writes a durable transition journal to `<base>/sessions/transition-<sessionKey>.journal.json` containing:
  - `status: "pending"`
  - Pre-transition snapshots of source and target JSON files (`sourceStateSnap`, `targetStateSnap`, `targetHistorySnap`, `targetSummarySnap`)
  - Pre-transition SQLite row snapshots (`sourceDbSnapshot` and `targetDbSnapshot` read from `workflow.db`)
  - `priorSessionPointer`, `priorFocusBinding`, and `stagedLock` metadata (`fromDir`, `toDir`, `targetLease`, `priorLease`).
- **Explicit Authoritative Commit Point:**
  - After `workflowState.save({ allowReplaceRunningTask: true })` and optional `afterSave` verification complete, `handleStartTask` reaches the single authoritative commit point:
    1. `markTransitionJournalCommitted(transitionJournal)` atomically persists `status: "committed"` to the journal file.
    2. `commitProcessLockTransition(stagedLock)` releases the prior startup/source project lock lease and binds the target project lease.
    3. `completeTransitionJournal(transitionJournal)` removes the completed journal file.
- **Post-Save Rollback & Automatic Restart Reconciliation:**
  - If any error is thrown before `markTransitionJournalCommitted` (including after `workflowState.save()` has already written to `targetStateFile` and target `workflow.db`), `rollbackTransitionJournal` restores **both** the target project (`targetDbSnapshot`, `targetStateSnap`, `targetHistorySnap`, `targetSummarySnap`) and the source project (`sourceDbSnapshot`, `sourceStateSnap`), restores `priorSessionPointer` and `priorFocusBinding`, and rolls back `stagedLock` so zero phantom tasks or locks remain in `targetLockDir`.
  - If a process crashes (`SIGKILL`) before `markTransitionJournalCommitted`, the next process calling `resolveStateFile` (`reconcilePendingTransitionJournalsSync`) or `WorkflowState.load()` (`reconcilePendingTransitionJournals`) detects the orphaned `status: "pending"` journal whose `pid` is no longer alive (or is the current recovering session) and deterministically rolls back all uncommitted target/source artifacts before serving state.

### 5.4 R2-5: Full-Root Legacy Writer Exclusion & Fleet Quiescence Verification
- **Unconditional Shared-Root Legacy Lock Scan (`detectIncompatibleLegacyWriters`):**
  - Because legacy v1 processes (which write `mcp-process.lock` without `leaseId` or `protocolVersion: 2`) may run in an unpinned startup bucket without ever creating `<base>/sessions/<sessionId>.json`, or may have an outdated session pointer pointing to a previous repository, `detectIncompatibleLegacyWriters` unconditionally enumerates **all** `<base>/projects/*/mcp-process.lock` files whenever `toDir` is inside a `.state/projects/<bucket>` layout (in addition to scanning `<base>/sessions/*.json` and foreign state files in `toDir`).
  - Any live legacy v1 lock anywhere under `<base>/projects/*` causes `acquireProcessLock`, `stageProcessLockTransition`, and `handleStartTask` to fail closed with `reason: "legacy_writer_active"`.
- **Pre-Cutover Fleet Quiescence Verifier (`verifyLegacyFleetQuiescence`):**
  - Scans `<base>/projects/*` and `<base>/sessions/*` and reports `{ quiescent, legacyWriters, abandonedGates, pendingJournals }` so release automation or operators can verify zero active legacy v1 processes, zero abandoned gates, and zero pending transition journals before or after fleet cutover.
