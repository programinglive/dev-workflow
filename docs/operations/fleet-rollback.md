# Fleet Rollback Operations

## Automatic Health-Check Rollback

When `activateRelease` transitions through `VERIFYING`, it executes the runtime health and native SQLite (`better-sqlite3`) ABI verification probe. If verification fails:
1. The supervisor aborts cutover to the broken release.
2. It automatically restores `activeManifest` to the retained `rollbackManifest` candidate.
3. It records the failure reason in `lastError` and preserves all local SQLite WAL task data.

## Operator-Triggered Rollback (`devwf fleet rollback`)

Because downgrading a runtime can affect protocol compatibility, rollback requires explicit operator authorization (`--authorize`):

```bash
# Preview which retained candidate will be restored
devwf fleet rollback --dry-run

# Execute authorized rollback on the local machine
devwf fleet rollback --authorize

# Emit structured JSON output
devwf fleet rollback --authorize --json
```

## Database Preservation Guarantee

Runtime rollbacks only switch the immutable code directory under `releases/<sha256>-<runtimeKey>`. They never delete or truncate `~/.dev-workflow/dev-workflow.db` or its WAL journal.
