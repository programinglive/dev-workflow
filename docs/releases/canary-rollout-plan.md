# DevWorkflow v2 — Option B+ Canary & Progressive Rollout Plan

**Status:** `READY_FOR_CANARY` (Awaiting Explicit Owner Confirmation of Canary Target)  
**Branch:** `feature/mobile-companion-cockpit`  
**Verified Automated Tests:** `1,873 passed, 0 failed` (`1,900 total, 27 skipped`)  
**Release APK SHA-256:** `3867aae95599e6c5cb85d8724a2a2f9e2ba0d1007da13d21986d01f0238d5800`

---

## 1. Release Safety Policy & Active Session Protection

Before any deployment action is executed:
1. **No Uncontrolled Fleet Rollout:** Never run `node managed/rollout.cjs` or `node managed/restart-devices.cjs` while active coding sessions are in flight without draining or pausing them.
2. **Observed Active Sessions at Gate Check:**
   - `HELLOWORLD` (`OpenCode` on `clinic` repository) — **ACTIVE**
   - `HELLOWORLD` (`Antigravity` on `dev-workflow-mcp-server`) — **ACTIVE**
   - Historical/idle sessions on `Mac` and `MMCH`.
3. **Zero Remote Mutation Until Approved:** No remote server or fleet configuration has been mutated during Milestone M5–M7 completion.

---

## 2. Phase 1 — Pre-Canary Preparation Checklist

Execute on the selected Canary host **only after owner confirmation**:

```bash
# 1. Record current git commit and active release revision
git rev-parse HEAD > .canary-pre-rollback-sha.txt
node managed/fleet-status.cjs

# 2. Backup SQLite WAL persistence store
cp ~/.dev-workflow/dev-workflow.db ~/.dev-workflow/dev-workflow.db.pre-canary.bak
cp ~/.dev-workflow/dev-workflow.db-wal ~/.dev-workflow/dev-workflow.db-wal.pre-canary.bak 2>/dev/null || true
sha256sum ~/.dev-workflow/dev-workflow.db.pre-canary.bak

# 3. Export active configuration snapshot
env | grep -E '^(DEVWF_|ZETTLY_|POCKETBASE_)' > ~/.dev-workflow/canary-env.snapshot

# 4. Verify zero active mutations in target repository
git status --porcelain
```

---

## 3. Phase 2 — Controlled Canary Deployment (Single Machine + Single Test Repo)

### Recommended Canary Target
- **Machine:** `MMCH` (or `HELLOWORLD` after the `clinic` OpenCode session completes)
- **Test Repository:** `dev-workflow-mcp-server` (non-production sandbox project)

### Canary Verification Steps
1. **Service Startup & Schema Migration:** Verify additive SQLite WAL startup without lock contention (`busy_timeout = 5000`).
2. **MCP Tool Discovery:** Confirm all canonical tools load cleanly in client (`get_workflow_status`, `start_task`, `refine_with_ai`, `complete_task`).
3. **Zettly Integration:** Verify Todo creation/update and Zettly Draw flow synchronization (`relasiFlow`).
4. **PocketBase Authentication:** Verify `IdentityProvider` resolves `activity_users` human claims and rejects `_superusers` or service impersonation.
5. **Central Gateway Guard:** Confirm `pb_list_records` on permitted collections succeeds while `activity_tasks` and `_superusers` remain blocked.
6. **Monitor SSE Stream (`/api/v1/mobile/stream`):** Confirm `< 2s` event propagation, `Last-Event-ID` replay, and 15-second heartbeat.
7. **Xiaomi Pad 6 Companion (`23043RP34G` / `pipa`):**
   - Verify Cockpit, Focus, and Governance modes at `2880×1800` (`400 dpi`).
   - Verify M6 Evidence Inspector displays `VERIFIED` for matching `sourceRevision` and flags `STALE` on post-test edits.
   - Verify M5 HITL Governance approval (`approve_gate`) and Emergency Stop (`STOP_REQUESTED` → `STOP_DISPATCHED` → `STOP_CONFIRMED`).

---

## 4. Phase 3 — Progressive Fleet Rollout (Post-Canary Sign-off)

Once Canary passes all 7 verification checks:

| Stage | Target | Clients | Gate Condition |
|---|---|---|---|
| **Stage 1** | Canary Workstation | Single CLI + Xiaomi Pad 6 | 100% pass on 7 Canary checks |
| **Stage 2** | `bw-tools` (`100.77.138.14:3100`) | Central Monitor & Release Host | Monitor SSE & `/api/v1/mobile/*` healthy |
| **Stage 3** | `HELLOWORLD`, `Mac`, `MMCH` | `OpenCode`, `Codex`, `Antigravity` | `node managed/rollout.cjs` + `node managed/restart-devices.cjs` + all green in `node managed/fleet-status.cjs` |

---

## 5. Rollback Procedure (< 60 Seconds)

Trigger rollback immediately if any of the following occur:
- Task Contract corruption or unexpected state reset
- Unintended session termination
- Database lock failures (`SQLITE_BUSY`)
- Authentication bypass or scope leakage
- Gateway permission regression
- SSE runaway reconnect loops

### Rollback Commands

```bash
# 1. Restore previous release pin
git checkout $(cat .canary-pre-rollback-sha.txt)

# 2. Restore SQLite WAL database backup
cp ~/.dev-workflow/dev-workflow.db.pre-canary.bak ~/.dev-workflow/dev-workflow.db
rm -f ~/.dev-workflow/dev-workflow.db-wal ~/.dev-workflow/dev-workflow.db-shm

# 3. Reload MCP processes and verify green fleet table
node managed/restart-devices.cjs
node managed/fleet-status.cjs
```
