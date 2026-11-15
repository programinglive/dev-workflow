# DevWorkflow MCP — Project Lock & Session Isolation Root Cause Analysis

- **Document ID:** `DEVWF-RCA-2026-11-14-01`
- **Canonical DevWorkflow Task:** `8feef683-f09a-4d2c-9cda-0b91da603a10`
- **Zettly Tracking:** Todo `#756` | Focus `#81` | Draw `#398` / `#400`
- **Affected Release:** DevWorkflow MCP Managed Release `1.31.0` (commit `c30d24fb90c096fe89bd3766ea7d569aa1d409d3` / `7fa2a5f0fc6a91344b150b5f98f15d12e90ba6fb`)
- **Impacted Systems:** Multi-AI developer workstations (`MMCH`, `HELLOWORLD`, `Mac`) running concurrent AI sessions (Antigravity CLI, Codex CLI, OpenCode).

---

## 1. Executive Incident Summary

On November 14, 2026, an operational blocker occurred on workstation `MMCH` during concurrent development:
- **Client 1 (Antigravity):** Launched from directory `C:\Users\mahardhika`. Assigned PID `16732`. Completed DevWorkflow task `63821490-bbb3-4c75-981d-39cfc48b6b08` in target repository `D:\code\dev-workflow-mcp-server`.
- **Client 2 (Codex):** Launched from directory `C:\Users\mahardhika`. Assigned PID `18200`. Called `start_task(projectDir: "D:/code/dev-workflow-mcp-server", ...)` under Focus `#82`.
- **Observed Failure:** Codex was immediately rejected with:
  ```text
  ⚠️ Dibatalkan: sesi lain sedang mengerjakan proyek ini.
  Proses MCP PID 16732 di MMCH berdetak 1 menit lalu (hidup sejak 2026-11-14T01:23:40.683Z).
  Dua sesi pada satu working tree saling menimpa berkas...
  ```
- **False Lock Identification:** Even when Codex specified a distinct project directory or worktree, it was blocked because DevWorkflow validated the process lock of the **startup working directory** (`C:\Users\mahardhika` $\rightarrow$ `projects/mahardhika-363ba16a79/mcp-process.lock`) rather than the target project directory. Furthermore, Antigravity's process continued heartbeating on the startup directory lock long after completing its task and pinning to `dev-workflow-mcp-server`.

---

## 2. In-Depth Root Cause Analysis

Five distinct yet interlocking architectural defects in DevWorkflow MCP's process lifecycle, lock resolution, and filesystem concurrency semantics caused this collision.

### 2.1 Flaw 1: Premature Lock Validation on Startup Working Directory

In `tools/handler-modules/workflow-handlers.js` (`handleStartTask`), lines 221–246:
```javascript
// BEFORE FIX: Checked workflowState.stateFile BEFORE parsing args.projectDir!
const foreignLock = activeForeignLock({
  dir: projectLockDir(workflowState.stateFile),
  isAlive: currentIsAlive(),
});

if (foreignLock && args.force !== true) {
  return textResponse(`⚠️ Dibatalkan: sesi lain sedang mengerjakan proyek ini...`);
}
```
At server bootstrap (`index.js`), `workflowState.stateFile` defaults to the location derived from `process.cwd()`. On workstations like Windows where IDEs and CLIs launch MCP servers in the user's home directory (`C:\Users\mahardhika`), `workflowState.stateFile` resolves to:
`.state/projects/mahardhika-363ba16a79/users/user-.../workflow-state.proc-...json`

When a second client started in `C:\Users\mahardhika` and called `start_task` with an explicit `projectDir` (e.g. `D:\code\dev-workflow-mcp-server`), `handleStartTask` checked `activeForeignLock` on `projectLockDir(workflowState.stateFile)` (i.e. `mahardhika-363ba16a79`) **before** resolving `projectDir`!
Because Process 1 was holding `mahardhika-363ba16a79/mcp-process.lock`, Process 2 was rejected, even though Process 2 intended to work on a completely different project.

### 2.2 Flaw 2: State File Relocation Without Lock Re-acquisition or Cleanup

In `tools/handler-modules/workflow-handlers.js`, `pinSessionProject` (lines 514–529) relocated `workflowState.stateFile`:
```javascript
if (workflowState.state.projectDir) {
  const pinned = pinSessionProject({
    stateFile: workflowState.stateFile,
    projectDir: workflowState.state.projectDir,
    focusId: hasRequestedFocus ? requestedFocusId : null,
  });

  if (pinned && pinned.stateFile !== workflowState.stateFile) {
    workflowState.stateFile = pinned.stateFile;
    // ...
  }
}
```
While `workflowState.stateFile` moved to `projects/dev-workflow-mcp-server-9aef7dd0b5/users/...`, `pinSessionProject` performed **no lock relocation**:
1. It did NOT acquire `projects/dev-workflow-mcp-server-9aef7dd0b5/mcp-process.lock`.
2. It did NOT release the startup lock on `projects/mahardhika-363ba16a79/mcp-process.lock`.
3. It did NOT update `rememberedLockDir` in `process-lock.js`.

Consequently, the server continued heartbeating on the startup directory lock forever, holding a phantom lock on `C:\Users\mahardhika` and preventing any other client from using that directory, while leaving the actual target repository (`dev-workflow-mcp-server`) unprotected by an active process lock!

### 2.3 Flaw 3: Non-Atomic Lock File Creation Race Condition

In `process-lock.js`, `acquireProcessLock` previously checked for lock existence and then wrote the file:
```javascript
// BEFORE FIX: Non-atomic write!
writeFileSync(lockFile, JSON.stringify(payload), "utf8");
```
This allowed a classic Time-of-Check to Time-of-Use (TOCTOU) race condition:
- Two concurrent MCP processes simultaneously read that the lock file did not exist (or was stale).
- Both processes evaluated that they could proceed.
- Process 2 overwrote the lock file written milliseconds earlier by Process 1 without fencing or conflict detection.

### 2.4 Flaw 4: Lack of Lease Token Fencing Against Mismatched Heartbeats

In `process-lock.js`, `refreshProcessLock` checked only that `existing.pid === pid`.
If Process 1 had a timer firing, or if a lock was recovered by another process, or if the process had relocated directories, a delayed heartbeat timer could overwrite the heartbeat of a new lease or foreign owner.
Without a cryptographically random, monotonic lease token (`leaseId`) uniquely bound to each acquisition and relocation event, heartbeat timers operated without fencing.

### 2.5 Flaw 5: Windows Process Holder Verification Blind Spot

In `process-lock.js`:
```javascript
// BEFORE FIX:
function defaultIsHolderProcess(pid, existing) {
  if (process.platform === "win32") {
    return null; // Always null on Windows!
  }
  // Linux/macOS checked /proc/<pid>/cmdline
}
```
On Windows, `defaultIsHolderProcess` returned `null` unconditionally. Because it returned `null`, DevWorkflow could not distinguish between:
1. A legitimate running `dev-workflow-mcp-server` node process.
2. A dead MCP server whose PID was reassigned by the Windows OS kernel to an unrelated process (e.g. `chrome.exe`, `svchost.exe`, `explorer.exe`).

Under `fail-closed` locking, a reused PID on Windows permanently blocked task registration until manually cleared or forced.

---

## 3. Reproduction Evidence

A deterministic reproduction fixture was created in `tests/cross-client-lock-isolation.test.js` (Scenario A):
1. Spawned Process A in temporary shared home directory `base/shared-home`.
2. Process A acquired startup lock on `shared-home`.
3. Process A started task on `repoA`.
4. Spawned Process B in `base/shared-home` targeting `repoB`.
5. Under baseline code (`7fa2a5f0`), Process B failed with:
   `⚠️ Dibatalkan: sesi lain sedang mengerjakan proyek ini. Proses MCP PID <A>...`
6. Under the permanent fix, Process B seamlessly pre-resolves `repoB`'s target bucket, validates `repoB`'s independent lock directory, acquires its lock, and starts work with zero collision.

---

## 4. Conclusion

The cross-client lock collision was not an environmental anomaly or a reason to terminate background AI sessions. It was a structural architectural bug in DevWorkflow MCP's project identity lifecycle and lock concurrency model. The fix permanently decouples the startup CWD from project locking, enforces atomic `wx` acquisition and dynamic lock relocation with lease fencing, and provides robust holder verification on Windows.
