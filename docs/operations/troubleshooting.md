# Fleet Update Troubleshooting & Doctor Diagnostics

## Running the Self-Diagnostic Doctor

```bash
devwf fleet doctor
devwf fleet doctor --json
```

## Diagnostic Finding Codes & Remediations

| Finding Code | Meaning | Structured Remediation |
| :--- | :--- | :--- |
| `MISSING_RUNTIME` | No staged or active ManagedMCP runtime exists in the cache root. | Run `devwf fleet stage` to download and verify the target release. |
| `INCORRECT_VERSION` | Running process revision differs from the approved target revision. | Run `devwf fleet stage && devwf fleet activate --authorize`. |
| `STALE_TOOL_REGISTRY` | Running process `toolCatalogDigest` differs from the target manifest's `toolCatalogDigest`. | Run `devwf fleet activate --authorize` when idle or reconnect the client. |
| `ACTIVE_SESSION_BLOCKING` | An active coding session is safely pinned to the previous revision (`PINNED_ACTIVE_SESSION`). | Allow the active session to finish; new sessions already use the staged release. |
| `UNSUPPORTED_CLIENT_REFRESH` | Client (`codex` or `antigravity`) holds a direct stdio child that cannot be hot-reloaded externally. | Reload the MCP connection inside the client when convenient. |
| `OFFLINE_DEVICE` | Target machine could not be reached over SSH or network transport. | Verify network/VPN connectivity and re-run `devwf fleet check`. |
| `FAILED_RELEASE_VERIFICATION` | Archive digest mismatch or post-activation health check failure. | Run `devwf fleet rollback --authorize` to restore the previous verified runtime. |
