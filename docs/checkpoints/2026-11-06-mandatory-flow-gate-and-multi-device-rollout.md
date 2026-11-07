# Central Managed MCP Rollout & Multi-Device Rule Synchronization — 6 November 2026

## Summary
Promoted approved runtime release `4f5e1f4253c8206afe6fc73c9824e45618b86d94` (SHA256: `f8dbb9c6ac19c5eac9bb6cf9efd5d1112812903c02d9c47843500f2f62b231e6`) containing:
1. Mandatory visual flow gate (automatic Mermaid flowchart generation in `start_task` and Zettly Draw sync).
2. Hard test creation gate blocking development if feature flow is missing.
3. Builder VM auto-detection from SSH/gcloud commands with prominent `[Remote VM]` vs `[Lokal]` dashboard badges.
4. Heartbeat tool-inactivity guard (20 minutes) preventing abandoned sessions from lingering in the monitor.
5. Zettly Draw Studio canvas schema and tldraw compatibility fix.

## Multi-Device Verification

| Device | Node/Runtime | Verified Revision | Rules Synchronized (Codex, OpenCode, AGY) |
|---|---|---|---|
| **HELLOWORLD** | Windows x64, Node ABI 137 | `4f5e1f4253c8` | `GEMINI.md`, `AGENTS.md` (Codex), `AGENTS.md` (OpenCode) |
| **Mac** | macOS x64, Node ABI 137 | `4f5e1f4253c8` | `GEMINI.md`, `AGENTS.md` (Codex), `AGENTS.md` (OpenCode) |
| **MMCH** | Windows x64, Node ABI 137 | `4f5e1f4253c8` | `GEMINI.md`, `AGENTS.md` (Codex), `AGENTS.md` (OpenCode) |

## Central Release Infrastructure
- `docker-alma` (`100.117.87.66:3101`): Primary release service host, immutable archive storage under `/var/lib/devwf-releases/releases/`.
- `n8n-instance` (`100.78.134.44:3101`): Active proxy forwarding requests to `docker-alma:3101`.
- Both `/health` and `/v1/current` endpoints return HTTP 200 with SHA256 verification.
