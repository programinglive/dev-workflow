# Managed Runtime Lifecycle & Supervisor State Machine

## 10 Supervisor Update States

| State | Meaning |
| :--- | :--- |
| `UP_TO_DATE` | Installed and running runtime match the approved target manifest and `toolCatalogDigest`. |
| `UPDATE_AVAILABLE` | A newer approved release manifest was discovered on the release channel. |
| `DOWNLOADING` | Fetching the immutable release archive and validating byte length and SHA-256 digest. |
| `STAGED` | Extracted into a side-by-side runtime directory (`releases/<sha256>-<runtimeKey>`) with native dependencies verified. |
| `WAITING_FOR_SAFE_CUTOVER` | Target runtime is staged for new sessions, while one or more active coding sessions remain pinned to the previous runtime. |
| `ACTIVATING` | Promoting the staged runtime to active and triggering supported idle client refresh adapters. |
| `VERIFYING` | Running post-activation health and SQLite ABI checks. |
| `ACTIVE` | Target runtime is active and verified. |
| `FAILED` | Download, digest verification, or dependency build failed; previous runtime remains untouched. |
| `ROLLBACK_REQUIRED` | Post-activation health check failed and requires or triggered rollback to the retained candidate. |

## 7 Fleet Convergence Statuses

- `CONVERGED`: Installed, running, and client tool catalog digests all match the target release.
- `STAGED`: Target artifact is staged on disk; awaiting activation or next session start.
- `PINNED_ACTIVE_SESSION`: Target artifact is staged and used by new sessions; existing active coding session continues safely on its pinned revision.
- `CLIENT_REFRESH_REQUIRED`: Runtime is active, but an AI client holding an older stdio connection or stale `toolCatalogDigest` requires reconnect.
- `OFFLINE`: Machine is unreachable over the configured transport.
- `VERSION_MISMATCH`: Running or installed revision differs from the approved target.
- `FAILED`: Update or verification error occurred.
