# Fleet Update & Convergence Verification Report (Addendums #5–#8)

## Verification Summary

All 27 test scenarios required by Consolidated Architectural Addendums #5–#8 have been executed using isolated temporary directories and disposable provider harnesses without disrupting active production coding sessions.

## Test Outcome Classification Matrix

| Scenario Category | Test Scenario | Outcome Status | Verification Evidence |
| :--- | :--- | :--- | :--- |
| **Local-First & Optional Providers** | Local-only installation without Tailscale, Zettly, or PocketBase | **`PASS`** | `tests/fleet-addendum-6-8.test.js` (`PUBLIC_LOCAL_FIRST` mode) |
| **Optional Providers** | Missing SSH / Tailscale / Zettly / PocketBase providers | **`SKIPPED`** (Graceful) | Marked `enabled: false, status: "SKIPPED"` in `createFleetInventory` |
| **Optional Providers** | Docker runtime container provider | **`NOT_SUPPORTED`** | Explicitly reported as `NOT_SUPPORTED` until required |
| **Remote Transport** | Windows PowerShell `-EncodedCommand` remote execution | **`PASS`** | Verified UTF-16LE Base64 + `StrictHostKeyChecking=yes` |
| **Remote Transport** | macOS / POSIX `base64 -d \| sh` remote execution | **`PASS`** | Verified UTF-8 Base64 pipeline |
| **Remote Transport Faults** | SSH connectivity failure & SSH host identity mismatch | **`PASS`** | Classified as `SSH_CONNECTIVITY_FAILURE` & `SSH_HOST_IDENTITY_MISMATCH` |
| **Artifact Security** | Interrupted download & SHA-256 checksum mismatch | **`PASS`** | Rejected prior to staging in `tests/fleet-update-manager-f0-f7.test.js` |
| **Idempotency & Guards** | Duplicate stage/upgrade requests & downgrade protection | **`PASS`** | Idempotent no-op on same revision; blocks unauthorized downgrades |
| **Authorization** | 6-tier permission separation & unauthorized force restart | **`PASS`** | Coding agents blocked from `stage`/`activate`/`interrupt`/`force_restart`/`publish` |
| **Tool Sync** | Stale running MCP processes & stale `toolCatalogDigest` | **`PASS`** | Sets `staleToolCatalogDetected: true` and `STALE_TOOL_REGISTRY` finding |
| **Session Lifecycle** | Active session checkpointing, identity check & stale worktree lease | **`PASS`** | Rejects mismatched sessionKey and expired `worktreeLease` (`STALE_WORKTREE_LEASE`) |
| **Client Recovery** | OpenCode & Codex session resume | **`PASS`** | Checkpointed and resumed with `recoveryVerified: true` |
| **Client Recovery** | Antigravity forced automatic IDE restart | **`NOT_SUPPORTED`** | Accurately reports `NOT_SUPPORTED` (`manualResumeRequired: true`) without killing IDE |
| **Resilience** | Partial fleet outage, concurrent upgrade lock, controller recovery & rollback | **`PASS`** | Isolates unreachable nodes, blocks concurrent upgrades, and rolls back on failed health check |
