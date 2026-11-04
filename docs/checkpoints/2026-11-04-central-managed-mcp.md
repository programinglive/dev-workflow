# Central managed MCP rollout — 4 November 2026

Task/session: `central-managed-mcp-20261104`. Implementation branch: `feat/central-managed-mcp`.

## Result

Approved runtime source: `0cb7df2361d77288fc66c5aa77904501e2c3beb3` (initial implementation `2aa0049c5f9c1622a3538f3532bbd58b2cde7fe3`). Final source archive SHA256: `6adab17b7d7024df03d8c8512f22e4c770af454c8eee823bf6dc17f5e8ad1f33`, 3,945,220 bytes.

Private release service runs on n8n-instance at `http://100.78.134.44:3101` as `devwf-managed.service`, OS user `devwf-releases`. Health responds 200; unauthenticated manifest requests return 401. Memory observed 24–43 MiB against a 128 MiB service limit. Existing n8n and Factory endpoints remained HTTP 200 after deployment.

This is centrally managed release distribution with local execution. Future updates are promoted once in the server manifest; new MCP connections on all three devices consume the same source automatically. Existing processes pin their version until reconnect. Git, tests, paths, credentials and existing state stores remain on the originating device. No remote shell API was introduced.

## Device verification

| Device | Node/runtime | Verified revision | Protocol and task lifecycle |
|---|---|---|---|
| HELLOWORLD | Windows x64, Node ABI 137 | `0cb7df2361d7` | 39 tools; status, task registration, diagnostic closure passed |
| MMCH | Windows x64, Node ABI 137 | `0cb7df2361d7` | 39 tools; status, task registration, diagnostic closure passed |
| Mac | macOS x64, Node ABI 137 | `0cb7df2361d7` | 39 tools; status, task registration, diagnostic closure passed |

Stable bootstrap directory: `%LOCALAPPDATA%/ProgramingLive/ManagedMCP/bootstrap` on Windows and `~/.local/share/ProgramingLive/ManagedMCP/bootstrap` on Mac. Codex, OpenCode and available Antigravity configurations were migrated. MMCH's shared wrapper and HELLOWORLD's keyring-based Factory wrapper were retained. Device-local `.before-managed-*` backups permit rollback; their credential contents must remain private.

## Monitor correction

The monitor on bw-server-clean retains its existing layout. Only task query, visible-task helper and related render/count wiring were changed. Anonymous connections contribute device last-seen data, not active task cards. Titled sessions retain their actual title. Ended sessions do not inflate the visible task count.

Browser verification at approximately 15:49 WIB showed **3 task cards**, a matching **3 task** counter, and **0 '(tanpa task)' cards**. Actual titles included the printer work, GCP analysis and this deployment task. The served browser script parsed successfully. No unrelated session was stopped or relabeled.

## Tests and review

Fresh final full suite: **1,150 tests, 1,130 passed, 20 skipped, 0 failed**. Focused tests exercise authenticated downloads, corrupt archives, install serialization, owner-process death recovery, Windows/TOML and client-format preservation, real SDK catalog validation, and visible task counting.

Independent review findings were repaired: unsafe stale-directory lock cleanup, ownerless locks, Antigravity command schema, multiline Codex arguments. Deployment probes additionally found literal Windows Node path detection and a pre-existing output-filter bug that corrupted `start_task` JSON schema. The exact static tool catalog is now preserved; dynamic tool results and errors remain scanned. Final focused independent review found no blockers.

## Operations and rollback

See `docs/central-managed-mcp.md` for build/publish/promote instructions. `/var/lib/devwf-releases/previous.json` preserves the earlier approved manifest; immutable archives remain available. Restore a previous manifest atomically to roll back a runtime; reconnect affected clients. Bootstrap installation is a one-time device setup, not part of routine runtime updates.

Remaining action: existing client connections may reconnect when their current tasks permit. Source branch is pushed separately; no shared dirty checkout was overwritten or merged. No public npm release was made.
