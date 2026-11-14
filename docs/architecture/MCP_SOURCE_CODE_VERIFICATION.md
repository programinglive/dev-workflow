# MCP Complete Source Code & Implementation Verification

> **Scope:** In-depth verification of MCP tool implementation code, internal dependencies, operational behavior, and downstream consumers.  
> **Source Repositories Inspected:** `central-mcp-gateway`, `clinic-helper-mcp-server`, `dev-workflow-mcp-server`, `infra-knowledge-mcp-server`, `pocketbase-mcp-server`, `zettly-mcp-server`.

---

## 1. PocketBase Behavioral Comparison: Standalone vs Central Gateway

### [SOURCE-CODE EVIDENCE] Implementation Code Analysis

#### Standalone `pocketbase-mcp-server` (`src/client.js` & `src/tools.js`):
- Connects using `fetch()` with credentials resolved from `auth.js` (`POCKETBASE_ADMIN_TOKEN` or local `.env`).
- Incorporates `cfaccess.js` to attach static request headers:
  ```javascript
  'CF-Access-Client-Id': clientId,
  'CF-Access-Client-Secret': clientSecret
  ```
- Exposes 9 tools:
  - `pb_health`: GET `/api/health`.
  - `pb_list_collections`: GET `/api/collections`.
  - `pb_get_collection`: GET `/api/collections/:nameOrId` (Retrieves full JSON schema of fields, indexes, rules).
  - `pb_create_collection`: POST `/api/collections` (Creates collection with schema fields and access rules).
  - `pb_list_records`: GET `/api/collections/:collection/records`.
  - `pb_get_record`: GET `/api/collections/:collection/records/:id`.
  - `pb_create_record`: POST `/api/collections/:collection/records`.
  - `pb_update_record`: PATCH `/api/collections/:collection/records/:id`.
  - `pb_delete_record`: DELETE `/api/collections/:collection/records/:id`.

#### Central Gateway `central-mcp-gateway` (`src/modules/pocketbase.js`):
- Connects using internal Tailscale endpoint (`http://100.103.72.86:8090` on `bw-app`) or `POCKETBASE_URL`.
- Uses server-side `POCKETBASE_ADMIN_TOKEN`.
- Exposes 7 tools:
  - `pb_health`, `pb_list_collections`, `pb_list_records`, `pb_get_record`, `pb_create_record`, `pb_update_record`, `pb_delete_record`.
- **Behavioral Parity:**
  - The 7 CRUD tools execute identical REST calls, return identical JSON responses, and accept identical pagination and filter arguments (`page`, `perPage`, `filter`, `sort`).
- **Gaps in Central Gateway:**
  - Central Gateway currently lacks `pb_get_collection` and `pb_create_collection`.
- **Downstream Consumer Trace:**
  - A comprehensive scan of all projects across `D:\code` revealed **zero** active features, test suites, or production scripts calling `pb_create_collection` or `pb_get_collection`. They exist solely for ad-hoc administrative inspection.
  - Adding `pb_get_collection` and `pb_create_collection` to `central-mcp-gateway/src/modules/pocketbase.js` achieves 100% functional parity.

---

## 2. Infrastructure Knowledge Verification: Standalone vs Central Gateway

### [SOURCE-CODE EVIDENCE] Implementation Code Analysis

#### Standalone `infra-knowledge-mcp-server`:
- Reads authoritative YAML files in `knowledge/`:
  - `instances.yaml` (GCP VMs, internal/external IPs, roles, Tailscale addresses).
  - `domains.yaml` (Production & staging domains, upstream targets, Cloudflare proxy status).
  - `services.yaml` (Systemd units, port bindings, reverse proxy mappings).
  - `repos.yaml` (Git repositories, remotes, deployment paths).
  - `devices.yaml` (HELLOWORLD, Mac, MMCH workstation specs and attached printers).
  - `billing.yaml` & `accounts.yaml` (GCP billing and service account mappings).
- Exposes 15 tools:
  - 4 Fleet Tools: `infra_overview`, `list_instances`, `find_instance`, `fleet_health`.
  - 9 Knowledge Retrieval Tools: `find_account`, `find_repo`, `find_domain`, `deploy_path`, `find_billing`, `list_devices`, `find_device`, `search_knowledge`, `knowledge_freshness`.
  - 1 Version Drift Tool: `release_drift`.
  - 1 Shell Tool: `ssh_vm` (Unrestricted remote root bash execution).

#### Central Gateway `central-mcp-gateway` (`src/modules/infra.js`):
- Currently hardcodes a static constant array `FLEET` (bw-server-clean, bw-app, bw-tools).
- Exposes 4 tools: `infra_overview`, `list_instances`, `find_instance`, `fleet_health`.
- **Behavioral Comparison:**
  - For the 4 fleet tools, Central Gateway and Infra Knowledge return identical instance names and IPs.
  - However, Central Gateway's hardcoded array lacks the rich metadata in `instances.yaml` (disk sizes, access notes, service list) and completely lacks domain, repo, and device queries.
- **Consolidation Requirement:**
  - Central Gateway must import the YAML files from `infra-knowledge/knowledge` (or maintain a structured copy on `bw-tools`) so that all 9 read-only knowledge tools survive consolidation under Central Gateway.
  - `ssh_vm` must NOT be imported into Central Gateway; it must be retired.

---

## 3. Zettly MCP Implementation & Confirmation Gates

### [SOURCE-CODE EVIDENCE] `zettly-mcp-server/src/api-tool.js`
- Exposes `zettly_api` which allows calling any `/api/v1/*` endpoint.
- **High-Impact Protection Mechanism:**
  ```javascript
  export function isHighImpact(method, path) {
    const upper = String(method).toUpperCase();
    const route = String(path).toLowerCase();
    if (upper === 'DELETE') return true;
    return upper !== 'GET' && /(?:^|\/)(?:profile|admin)(?:\/|$)|auth\/token|.../.test(route);
  }
  ```
  If `isHighImpact()` evaluates to true, the call is rejected unless `confirmation === "CONFIRM <METHOD> <path>"`.
- **Separation from DevWorkflow:**
  - `dev-workflow` uses internal module `zettly-client.js` to automatically push task status and draw canvases.
  - `zettly-mcp-server` allows the agent to interactively inspect human todos, daily journal entries, and query next-work recommendations.
  - Zero tool collisions exist between Zettly and DevWorkflow.

---

## 4. Clinic Helper Implementation & Safety Guards

### [SOURCE-CODE EVIDENCE] `clinic-helper-mcp-server/src/guards.js` & `cli-runner.js`
- Wraps `clinic.php` via Node child process.
- **Enforced Safety Controls:**
  - `dry_run: true` is hardcoded as default for all write commands.
  - Commands flagged as `kind: write` require a confirmation string derived from the CLI's internal hash.
  - Production environment execution requires explicit multi-factor parameters.
  - Completely decoupled from Playwright (zero browser automation in clinic-helper; zero PHP CLI execution in playwright).

---

## 5. Downstream Caller Trace Summary

| Tool Name | Downstream Callers Found | Removal / Consolidation Impact |
|---|---|---|
| `generate_mermaid_diagram` | 0 codebase callers; 0 scripts | **ZERO IMPACT**. Safe to delete immediately. |
| `factory_*` (all 3 tools) | 0 codebase callers; 0 scripts | **ZERO IMPACT**. Safe to purge immediately. |
| `pb_create_collection` | 0 codebase callers | **ZERO IMPACT**. Standalone disablement is safe. |
| `pb_get_collection` | 0 codebase callers | **ZERO IMPACT**. Standalone disablement is safe. |
| `ssh_vm` | Only internal test scripts in `infra-knowledge` | **HIGH SECURITY BENEFIT**. Zero production scripts broken. |
| `pb_list_records`, `pb_get_record`, etc. | Multiple agent sessions and documentation | **SEAMLESS**. Handled by `central-gateway` with identical schemas. |
