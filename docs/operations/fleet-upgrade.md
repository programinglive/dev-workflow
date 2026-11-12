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
