# MCP Security Remediation & Containment Plan

> **Classification:** CONFIDENTIAL — SECURITY GOVERNANCE  
> **Status:** APPROVED ACTION PLAN (Pending Owner Sign-off)  
> **Rule Compliance:** Zero private credentials, passwords, or token strings are displayed in this document.

---

## 1. Finding 1: Immediate Containment of `ssh_vm` (Infra Knowledge)

### 1.1 Confirmed Vulnerability Profile
- **Component:** `infra-knowledge-mcp-server` ([tools/ssh_vm.js](file:///D:/code/infra-knowledge-mcp-server/tools/ssh_vm.js)).
- **Privilege Level:** `root` on `bw-server-clean`, `bw-app`, `bw-tools`.
- **Classification:** **CRITICAL — IMMEDIATE CONTAINMENT REQUIRED**.
- **Root Cause:**
  `ssh_vm` was registered as a general-purpose MCP tool exposed to all AI agents. It passes arbitrary, unsanitized bash commands to `spawnSync('ssh', ...)` without:
  1. An interactive confirmation phrase.
  2. A command allowlist.
  3. Tailscale session audit logging.
  4. Isolation between read-only inspection and destructive system mutation.

### 1.2 Downstream Caller Analysis
- Traced across all repositories: **Zero** application features, deployment pipelines, or production jobs call `ssh_vm` through MCP.
- The only references within `infra-knowledge` are internal health probe modules (`tools/fleet_health.js` and `tools/release_drift.js`), which execute fixed, hardcoded probe commands (`uptime`, `df`, `free`, `find -newer`).

### 1.3 Narrow, Reversible Mitigation Plan
To neutralize the vulnerability without breaking `fleet_health` or `release_drift`:

1. **Unregister Tool from AI Catalog:**
   - In [tools/definitions.js](file:///D:/code/infra-knowledge-mcp-server/tools/definitions.js): Delete the `ssh_vm` tool schema definition.
   - In [tools/handlers.js](file:///D:/code/infra-knowledge-mcp-server/tools/handlers.js): Remove `case 'ssh_vm': return sshVm(args, deps);`.
2. **Retain Internal Helper for Health Probes:**
   - Keep `tools/ssh_vm.js` strictly as an internal unexported utility (`executeInternalProbe()`) callable only by `fleet_health.js` and `release_drift.js`.
   - Add command validation inside `executeInternalProbe()` restricting execution strictly to approved probe commands (`uptime`, `df`, `free`, `systemctl list-units`, `stat`, `find`).
3. **Rollback Plan:**
   - Git commit can be cleanly reverted in `infra-knowledge-mcp-server`.

---

## 2. Finding 2: Remediation of Legacy Factory Module & Exposed Credential

### 2.1 Confirmed Vulnerability Profile
- **Component:** `central-mcp-gateway` ([src/modules/factory.js](file:///D:/code/central-mcp-gateway/src/modules/factory.js#L41)).
- **Issue:**
  1. Hardcoded fallback worker token (`fwt_...`) committed directly in source code.
  2. Factory infrastructure was retired on 31 October 2026. Dead code and tools (`factory_create_task`, `factory_list_tasks`, `factory_list_projects`) remain active in the gateway.
- **Git Exposure:** Committed on 4 November 2026 in commit `139b11102c1dd0881669749d8b971b5dca6255d9`.

### 2.2 Coordinated Remediation Protocol

#### Phase A: Credential Invalidation & Lifecycle Revocation
1. Log into `bw-app` or access the Factory database.
2. Invalidate/delete the worker token record associated with the exposed token prefix.
3. Verify that requests using this token return HTTP 401 Unauthorized.

#### Phase B: Codebase Purge in `central-mcp-gateway`
1. Delete file `src/modules/factory.js`.
2. Edit `src/gateway.js`:
   - Remove `import { getFactoryTools, handleFactoryCall } from './modules/factory.js';`.
   - Remove `...getFactoryTools()` from `allTools`.
   - Remove `else if (name.startsWith('factory_')) { ... }` from request handler.
3. Edit `tests/gateway.test.js`:
   - Remove assertions expecting `factory_create_task`, `factory_list_tasks`, `factory_list_projects`.
4. Run `npm test` to verify clean build and test pass.

#### Phase C: Git Repository Sanitization
1. If the repository is private and accessible only to the owner, commit the removal with message:
   `chore(security): purge retired factory module and sanitize credentials`.
2. If repository history must be scrubbed, use `git-filter-repo` to redact the commit from historical trees before push.

#### Phase D: Production Deployment on `bw-tools`
1. Pull the clean revision to `/opt/central-mcp-gateway` on `bw-tools`.
2. Restart service: `sudo systemctl restart central-mcp-gateway`.
3. Verify via `curl http://100.x.x.14:3200/health`.

---

## 3. Finding 3: Standalone PocketBase Credential Sprawl & Gateway Unification

### 3.1 Confirmed Vulnerability Profile
- **Component:** `pocketbase-mcp-server` ([src/auth.js](file:///D:/code/pocketbase-mcp-server/src/auth.js)).
- **Issue:** Standalone MCP reads raw `.env` files from local disks to extract superuser tokens (`POCKETBASE_ADMIN_TOKEN`), and requires distributing Cloudflare Access Service Tokens (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`) to all developer laptops.

### 3.2 Remediation & Decommissioning Protocol
1. **Feature Parity in Gateway:**
   - Add `pb_get_collection` and `pb_create_collection` to `central-mcp-gateway/src/modules/pocketbase.js`.
2. **Deactivate Standalone MCP in Client Configs:**
   - Remove the `pocketbase` server entry from `mcp_config.json`, `config.toml`, and `opencode.json`.
3. **Security Gain:**
   - Client machines no longer require PocketBase superuser tokens or Cloudflare Access service tokens in local `.env` files.
   - All database requests flow through Central Gateway over private Tailscale network (`100.x.x.14:3200`), where centralized auditing can be enforced.
