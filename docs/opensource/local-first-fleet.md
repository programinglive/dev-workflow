# Local-First Standalone Operation (Open-Source Edition)

## Zero External Infrastructure Required

In its default open-source configuration (when `DEVWF_FLEET_HOSTS` and `DEVWF_RELEASE_URL` are unset), DevWorkflow operates in **`PUBLIC_LOCAL_FIRST`** mode:

- **No Tailscale Required:** All governance, task contracts, TDD gates, and SQLite WAL persistence run locally on `localhost`.
- **No SSH Required:** `createFleetInventory()` automatically selects `LocalTransportProvider` for the local workstation and marks `ssh`, `tailscale`, `zettly`, and `pocketbase` as optional (`SKIPPED`).
- **No Central Release Server Required:** `devwf fleet status` and `devwf fleet doctor` inspect the local installation and report `CONVERGED` (`localFirstStandalone: true`) without making external network calls.

## Verifying Local-First Mode

```bash
devwf doctor
devwf fleet status --json
devwf fleet doctor
```
