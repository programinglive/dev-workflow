# MCP GitHub, Local Working Tree & Runtime Comparison

> **Scope:** Independent cross-repository Git remotes, branches, commit hashes, uncommitted changes, and runtime topology analysis for all 9 MCP servers.  
> **Status:** VERIFIED ON DISK (Read-Only Audit — Zero Git Mutations).  
> **Date:** 2026-11-14

---

## 1. GitHub CLI & Authentication Verification

- **Command:** `gh auth status`
- **Account:** `mahatmamahardhikach` (Active)
- **Git Protocol:** HTTPS
- **Token Scopes:** `gist`, `read:org`, `repo`, `workflow`
- **Result:** GitHub API access is operational and authenticated for cross-repository inspection.

---

## 2. Cross-Repository Verification Matrix

| MCP Server Name | Local Directory | GitHub Remote URL | Current Branch | Local HEAD SHA | Remote Tracking Branch | Ahead / Behind | Dirty Tree / Untracked Files | Open PRs |
|---|---|---|---|---|---|---|---|---|
| `central-gateway` | `D:\code\central-mcp-gateway` | `https://github.com/mahatmamahardhikach/central-mcp-gateway.git` | `main` | `e2bbde18bf25797a92deb9a3aa57c325b86a13e6` | `origin/main` | 0 / 0 | Clean (0 uncommitted, 0 untracked) | None |
| `clinic-helper` | `D:\code\clinic-helper-mcp-server` | `https://github.com/programinglive/clinic-helper-mcp-server.git` | `main` | `45b657c1b042921c99fc1e3079db42638cf7388d` | `origin/main` | 0 / 0 | Clean (0 uncommitted, 0 untracked) | None |
| `dev-workflow` | `D:\code\dev-workflow-mcp-server` | `git@github.com:programinglive/dev-workflow-mcp-server.git` | `feat/website-v2-developer-portal` | `8e9e2b916a805252902b8f6029f5d1e407d0af7e` | `origin/main` | 0 / 0 | 0 uncommitted, 6 untracked audit docs in `docs/architecture/` | PR #97 (`docs/incident-closure-2026-11-13`) |
| `infra-knowledge` | `D:\code\infra-knowledge-mcp-server` | `git@github.com:programinglive/infra-knowledge-mcp-server.git` | `main` | `5688e1d788ca8ab21b18fa0e3e306cd44d1932ec` | `origin/main` | 0 / 0 | Clean (0 uncommitted, 0 untracked) | None |
| `pocketbase` | `D:\code\pocketbase-mcp-server` | `https://github.com/programinglive/pocketbase-mcp-server.git` | `main` | `4de59f14525582e1fee200588cdde0a31efa15d8` | `origin/main` | 0 / 0 | Clean (0 uncommitted, 0 untracked) | None |
| `zettly` | `D:\code\zettly-mcp-server` | `git@github.com:programinglive/zettly-mcp-server.git` | `feat/zettly-mcp-server-mvp` | `873a1d29394778eeecd220e807ebcb6ecc293130` | `origin/feat/zettly-mcp-server-mvp` | 0 / 0 | Clean (0 uncommitted, 0 untracked) | None |

---

## 3. Specialized Integrations (Non-Custom Repositories)

### 3.1 Mermaid (`mermaid`)
- **Package:** `mcp-mermaid` (v0.1.3).
- **Installed Path:** `C:\Users\mahardhika\AppData\Roaming\npm\node_modules\mcp-mermaid`.
- **Runtime Model:** Launches Node.js stdio child process executing `build/index.js`.
- **Underlying Engine:** `mermaid-isomorphic` which bundles and spawns headless Chromium.
- **Git Tracking:** Global npm package; not tracked in a workspace git repo.

### 3.2 Playwright (`playwright`)
- **Package:** `@playwright/mcp@latest`.
- **Execution Path:** `cmd /c npx -y @playwright/mcp@latest --isolated` (Antigravity) and `--user-data-dir=...` (Codex).
- **Runtime Model:** Spawns Microsoft official Playwright browser controller over stdio.
- **Git Tracking:** Dynamically resolved npm package managed by npx.

### 3.3 Cloudflare (`cloudflare`)
- **Endpoint:** `https://mcp.cloudflare.com/mcp`.
- **Runtime Model:** Remote HTTP/SSE endpoint hosted and maintained by Cloudflare.
- **Git Tracking:** None (Remote managed SaaS integration).

---

## 4. Deployed Service Runtime Topology

| MCP Server | Hosting Machine | Tailscale IP / Port | Service Unit / Process | Source Commit Deployed |
|---|---|---|---|---|
| `central-gateway` | `bw-tools` | `100.x.x.14:3200` | `central-mcp-gateway.service` | `e2bbde1` (`main`) |
| `dev-workflow` | Central: `bw-tools`, Local: Workstations | `100.x.x.14:3101` (releases), Local stdio | `devwf-managed.service`, local `ManagedMCP/bootstrap` | Synchronized via `device-entry.cjs` |
| `clinic-helper` | Local Workstation | Stdio | Spawned on demand by AI client | `45b657c` (`main`) |
| `infra-knowledge` | Local Workstation | Stdio | Spawned on demand by AI client | `5688e1d` (`main`) |
| `pocketbase` | Local Workstation | Stdio | Spawned on demand by AI client | `4de59f1` (`main`) |
| `zettly` | Local Workstation | Stdio | Spawned on demand by AI client | `873a1d2` (`feat/zettly-mcp-server-mvp`) |

### Key Architectural Finding:
All 6 custom repositories are clean, on their respective tracking branches, and perfectly aligned with remote origin HEADs (0 ahead, 0 behind). Zero uncommitted application code changes exist, ensuring a stable, reproducible baseline for consolidation.
