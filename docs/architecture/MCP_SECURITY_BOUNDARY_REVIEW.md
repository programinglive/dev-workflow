# MCP Security Boundary & Privilege Review

> **Classification:** INTERNAL AUDIT — SECURITY & GOVERNANCE  
> **Scope:** Authentication, authorization boundaries, credential exposure, destructive capabilities, and audit trails across the 9 MCP servers.  
> **Rule Compliance:** Zero credential, token, or connection string values are revealed in this document.

---

## 1. Executive Security Assessment

The audit identified two critical security vectors requiring immediate architectural remediation:
1. **Unrestricted Remote Root Command Execution:** Found in `infra-knowledge-mcp-server` (`ssh_vm.js`).
2. **Hardcoded Fallback API Token & Dead Architecture:** Found in `central-mcp-gateway` (`src/modules/factory.js`).

Additionally, running a standalone PocketBase MCP directly on client workstations bypasses Central Gateway's governance boundary and disperses superuser administrative tokens across developer machines.

---

## 2. Threat & Vulnerability Findings

### Finding 1: Unrestricted Root Shell Execution (`ssh_vm`)
- **Location:** `D:\code\infra-knowledge-mcp-server\tools\ssh_vm.js`
- **Severity:** `CRITICAL`
- **Source Evidence:**
  The `ssh_vm` tool accepts `{ name, command, timeout_seconds }`. It reads `instances.yaml` and executes:
  ```javascript
  spawnSync('ssh', [
    '-p', String(port),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    `${user}@${host}`,
    command
  ]);
  ```
  For instance `bw-server-clean`, `user` resolves to `root` over Tailscale IP (`100.x.x.21`).
- **Risk Analysis:**
  - Any connected AI model or subagent can invoke `ssh_vm` with arbitrary bash commands (e.g. `rm -rf`, `systemctl stop mariadb`, `mysqldump ... | drop`).
  - No interactive confirmation phrase is required.
  - No command allowlist is enforced.
  - No audit logging is piped to a centralized SIEM or monitor.
  - Bypasses the universal Linux CI/CD runner model on `bw-tools`.
- **Remediation:**
  Decommission `ssh_vm` from all MCP tool registrations immediately. Remote operations must run through audited CI/CD runner pipelines (`tags: [bw-tools]`) or via explicit, interactive operator CLI scripts executed outside ambient AI toolsets.

---

### Finding 2: Hardcoded Fallback Token & Retired Factory Code
- **Location:** `D:\code\central-mcp-gateway\src\modules\factory.js`
- **Severity:** `HIGH`
- **Source Evidence:**
  In `factory.js` line 41:
  ```javascript
  const token = process.env.FACTORY_WORKER_TOKEN || '<hardcoded_fallback_worker_token>';
  ```
- **Risk Analysis:**
  - Hardcoding credential fallbacks in source code commits secrets to Git repositories.
  - Violates Target Architecture Section 2.F: Factory infrastructure is permanently retired.
  - Exposes 3 dead tools (`factory_list_projects`, `factory_list_tasks`, `factory_create_task`) that point to retired endpoints.
- **Remediation:**
  Delete `src/modules/factory.js` entirely from `central-mcp-gateway`. Unregister the module in `src/gateway.js`. Purge any referencing environment variables.

---

### Finding 3: Credential Sprawl & Direct Database Access in Standalone PocketBase
- **Location:** `D:\code\pocketbase-mcp-server\src\auth.js`
- **Severity:** `MEDIUM-HIGH`
- **Source Evidence:**
  `auth.js` inspects local filesystem paths to extract `POCKETBASE_ADMIN_TOKEN`:
  ```javascript
  const candidateFiles = [
    process.env.POCKETBASE_TOKEN_FILE,
    'D:/code/pocketbase/.env',
    'D:\\code\\pocketbase\\.env'
  ].filter(Boolean);
  ```
- **Risk Analysis:**
  - Reading raw `.env` files from local disk distributes database superuser credentials across developer workstations.
  - Grants standalone AI sessions full schema-alteration and collection-deletion capabilities without going through Central Gateway's audited pathway.
  - Having two parallel routes to PocketBase (direct stdio vs Central Gateway HTTP) complicates access monitoring.
- **Remediation:**
  Disable standalone `pocketbase-mcp-server`. Direct all database queries through `central-mcp-gateway`, which runs within the controlled Tailscale environment on `bw-tools` and holds centralized credentials.

---

## 3. Review of Retained Security Controls

### 3.1 Zettly MCP High-Impact Safeguards
- **Location:** `D:\code\zettly-mcp-server\src\api-tool.js`
- **Assessment:** `ROBUST`
- **Source Evidence:**
  ```javascript
  export function isHighImpact(method, path) {
    const upper = String(method).toUpperCase();
    const route = String(path).toLowerCase();
    if (upper === 'DELETE') return true;
    return upper !== 'GET' && /(?:^|\/)(?:profile|admin)(?:\/|$)|auth\/token|.../.test(route);
  }
  ```
  Any high-impact operation rejected unless caller provides exact confirmation string: `CONFIRM <METHOD> <path>`.

### 3.2 Clinic Helper Dry-Run & Phrase Confirmation
- **Location:** `D:\code\clinic-helper-mcp-server\src\guards.js`
- **Assessment:** `ROBUST`
- **Source Evidence:**
  - All write commands enforce `dry_run: true` by default.
  - Destructive writes require matching confirmation phrase generated dynamically by the CLI catalog.
  - Production environments are blocked by default unless explicit profile confirmation is supplied.

### 3.3 DevWorkflow State Locking & Release Gates
- **Location:** `D:\code\dev-workflow-mcp-server\tools\definitions.js` and `process-lock.js`
- **Assessment:** `ROBUST`
- **Source Evidence:**
  - Requires `check_ready_to_commit` before git commit & push.
  - Requires release locks (`acquire_release_lock`) to prevent concurrent release tag stomping across machines.
  - Enforces mandatory verification of Definition of Done items before task closure.

---

## 4. Security Recommendations Summary

1. **Purge Retired Factory Module:** Remove `factory.js` from `central-mcp-gateway`.
2. **Eliminate SSH Root Tool:** Remove `ssh_vm` from `infra-knowledge` / MCP tools.
3. **Consolidate DB Credentials:** Disable standalone `pocketbase-mcp-server` and route all DB traffic through `central-mcp-gateway`.
4. **Enforce Least Privilege:** Keep write permissions guarded by dry-runs and explicit confirmation phrases across all MCP servers.
