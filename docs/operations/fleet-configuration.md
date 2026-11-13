# Fleet Configuration Guide

## Environment Variables

All fleet endpoints and machine enrollments are configured via environment variables so no private IP addresses or workstation paths are hardcoded in public source files.

```bash
# Optional: Central Monitor & Release Controller URLs (omit for Local-First Standalone Mode)
DEVWF_MONITOR_URL=https://monitor.example.internal
DEVWF_RELEASE_URL=https://releases.example.internal
DEVWF_MONITOR_TOKEN=your-monitor-write-token

# Optional: Enrolled SSH Fleet Nodes (format: Label:sshHost:platform)
DEVWF_FLEET_HOSTS=workstation-a:node-a.example.internal:win32,workstation-b:node-b.example.internal:darwin,workstation-c:node-c.example.internal:win32

# Optional: Custom ManagedMCP Cache Directory
DEVWF_MANAGED_CACHE=/var/lib/devwf-managed-cache
```

## Update Automation Modes

- `MANUAL`: Discovers and stages updates side-by-side, but requires explicit `--authorize` before activating.
- `SAFE_AUTOMATIC` *(Default for enrolled fleet nodes)*: Automatically stages approved stable releases and activates them only when zero active coding sessions would be interrupted.
- `SCHEDULED`: Defers activation to a configured maintenance window.
- `CRITICAL_SECURITY`: Prioritizes staging and operator alerting while preserving active-session pinning unless `--force --authorize` is explicitly supplied by an authorized operator.
