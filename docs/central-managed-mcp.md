# One release for HELLOWORLD, MMCH and Mac

The managed deployment has one approved source release hosted on `docker-alma` (`100.117.87.66:3101`) and proxied by `n8n-instance` (`100.78.134.44:3101`), reachable only through Tailscale. It distributes immutable, authenticated archives. The existing live monitor remains at `http://100.107.65.21:3100`.

This is centrally managed distribution with local execution. Git, files, tests, Factory credentials and repository paths remain on the device. It does not move development repositories onto a production server. There is no remote command-execution API.

## Daily updates & Multi-Device Rollout

To publish, promote, and propagate rules to all three devices (**HELLOWORLD**, **Mac**, **MMCH**) and three AI CLIs (**Codex**, **OpenCode**, **AGY**) in a single automated step:

1. Commit and test changes in an isolated development branch.
2. Run `node managed/rollout.cjs` from the reviewed checkout.
   - Publishes the archive from the committed Git tree and calculates SHA256.
   - Deploys and promotes atomically on both `docker-alma` and `n8n-instance`.
   - Copies updated bootstrap files (`launcher.cjs`, `protocol.cjs`, `device-entry.cjs`) to all three devices.
   - Prewarms and verifies runtime resolution on HELLOWORLD, Mac, and MMCH.
   - Synchronizes AI CLI rules in `.gemini/GEMINI.md`, `.codex/AGENTS.md`, and `.config/opencode/AGENTS.md` across all devices.

Running processes keep their original release until reconnect. A release that adds tools may also require the client to refresh its tool list. Do not kill unrelated active sessions to update them.

## Initial device setup

Copy `managed/launcher.cjs`, `managed/protocol.cjs` and, when needed, `managed/device-entry.cjs` to a stable per-user directory. Keep credential-loading wrappers; replace only the old `index.js` entry with the managed launcher. Direct clients can use `node <managed>/device-entry.cjs codex` or `opencode`, preserving their original environment settings.

Set `DEVWF_RELEASE_URL=http://100.78.134.44:3101`. Existing `DEVWF_MONITOR_TOKEN` authenticates downloads; neither tokens nor Factory secrets belong in a release archive. The optional adapter reads the device's existing OpenCode shared environment in memory, without printing credentials. Set the correct `DEVWF_MACHINE` per device and `DEVWF_AGENT` per client.

The cache is `%LOCALAPPDATA%/ProgramingLive/ManagedMCP` on Windows and `~/.local/share/ProgramingLive/ManagedMCP` elsewhere. It is separated by OS, architecture and Node ABI. `DEVWF_MANAGED_CACHE` can override its location. Concurrent startup of the same release is serialized.

The installation mutex is owned by the OS: a Windows named pipe or Unix loopback listener, released automatically if its process dies. Windows does not depend on a dynamically reserved TCP port. The installer understands both OpenCode array commands and Antigravity string commands, and preserves Codex literal paths and multiline arguments.

## Failure and rollback

Network unavailability may use the previously verified cache, with an explicit stderr warning. Invalid authentication, manifests, archive paths, hashes or dependency installs fail closed and do not promote a release. MCP stdout is reserved for protocol traffic.

To roll back centrally, atomically restore a previously verified manifest; retain immutable archives and reconnect the affected clients. For an initial migration rollback, restore the backed-up client configuration/launcher. No state database migration is performed by this setup.

The service runs as `devwf-releases` under `devwf-managed.service`, with a 128 MiB memory limit and read-only filesystem protection. Store its token in `/etc/devwf-managed.env` mode 600, not the unit. Inspect `systemctl status devwf-managed` and `/health`; unauthenticated `/v1/current` must return 401.

## Meaningful monitoring

Connection heartbeats update device last-seen information. Active task cards require a real task description or a known session title. Anonymous idle connections are excluded; they cannot prove any work is in progress. MCP instructions require `start_task` with project, DoD and plan before development. This does not automatically infer an unregistered task from a running process.

The built-in `tools/list` catalog is static protocol metadata. Its exact static response is preserved at the transport boundary so JSON schema properties named `classification` are not mistaken for classified records. Dynamic tool results and protocol errors continue through the output scanner. A real SDK client regression test validates the catalog, including `start_task`.
