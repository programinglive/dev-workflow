# Fleet Upgrade Operations (`devwf fleet`)

## Unified One-Trigger Upgrade

To stage, checkpoint, activate, and verify updates across all enrolled machines:

```bash
# Preview the upgrade plan without mutating any machine
devwf fleet upgrade --all --resume --dry-run

# Execute session-safe fleet upgrade with automatic resume where supported
devwf fleet upgrade --all --resume --authorize

# Emit machine-readable JSON output for automation pipelines
devwf fleet upgrade --all --resume --authorize --json
```

## Granular Fleet Subcommands

```bash
devwf fleet status [--json]                  # Inspect live convergence across machines
devwf fleet check [--json]                   # Poll release controller for new manifests
devwf fleet plan [--json]                    # Show step-by-step cutover plan for current machine
devwf fleet stage [--dry-run] [--json]       # Download, verify SHA-256, and stage side-by-side
devwf fleet activate [--authorize] [--json]  # Activate staged runtime if safe
devwf fleet verify [--json]                  # Verify running process versions and tool digests
devwf fleet doctor [--json]                  # Run self-diagnostic checks and get remediation
```

## Handling Active Sessions During Upgrade

When an AI coding session is active on a target machine, `devwf fleet upgrade --all --resume` stages the new release so any newly opened session uses the new version immediately, while pinning the active session (`PINNED_ACTIVE_SESSION`) until its task completes.

## Enrolled Fleet Discovery & Idempotent No-Op Behavior

- When `--all` is passed on a workstation with a managed bootstrap (`ManagedMCP/bootstrap/device-entry.cjs`), `devwf fleet upgrade --all --resume` automatically discovers enrolled fleet nodes (`HELLOWORLD`, `MMCH`, `Mac`) unless `DEVWF_FLEET_LOCAL_ONLY=1` or `DEVWF_PUBLIC_LOCAL_FIRST=1` is set.
- Standalone open-source installations default to `PUBLIC_LOCAL_FIRST` (`1` local machine) with zero external dependencies.
- If all target machines are already converged on the target revision and `toolCatalogDigest`, `devwf fleet upgrade --all --resume --authorize` executes a safe idempotent no-op (`noOp: true`, `downloads: 0`, `restarts: 0`, `checkpointsCreated: 0`).
