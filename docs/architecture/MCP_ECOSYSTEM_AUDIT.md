# MCP Ecosystem Full Source Audit

> **Status:** AUDIT COMPLETE — AWAITING OWNER APPROVAL  
> **Date:** 2026-11-14  
> **Scope:** Complete source, runtime, tool registration, and configuration audit across all 9 connected MCP servers.  
> **Execution Mode:** Read-Only Audit (Zero Runtime Mutations, Zero Credential Modifications).

---

## 1. Executive Summary

This audit assesses the stability, security, architectural boundaries, and maintenance cost of the 9 Model Context Protocol (MCP) servers currently integrated into the AI agent environment (Antigravity CLI/IDE, OpenCode, Codex).

The objective is to establish an evidence-based consolidation plan to reduce redundant tool registrations, eliminate insecure execution vectors, enforce least-privilege identity access, and establish clear architectural boundaries without breaking active development workflows.

### Summary of Decisions
- **Total Connected Servers Audited:** 9
- **Target Retained Servers:** 6
- **Server Reductions:** 3 (-33% server footprint, eliminating 25+ duplicate or unneeded tool exposures)
- **High-Risk Vulnerabilities Flagged:** 2 (Unrestricted root SSH command execution in `infra-knowledge`; Hardcoded fallback API token & retired Factory modules in `central-mcp-gateway`).

---

## 2. Server Inventory & Launch Configuration

### [VERIFIED FACT] Configuration Matrix
Audited across configuration stores:
- Antigravity: `C:\Users\mahardhika\.gemini\antigravity\mcp_config.json`
- Codex: `C:\Users\mahardhika\.codex\config.toml`
- OpenCode: `C:\Users\mahardhika\.config\opencode\opencode.json`

| Server Name | Transport | Launch Command / Endpoint | Environment Variables (Names Only) | Source Location |
|---|---|---|---|---|
| `central-gateway` | Streamable HTTP / SSE | `http://100.78.134.44:3200/mcp` | None configured on client (server-side configured) | `D:\code\central-mcp-gateway` (deployed on `bw-tools`) |
| `clinic-helper` | stdio | `node D:\code\clinic-helper-mcp-server\index.js` | `CLINIC_CLI_PATH`, `CLINIC_PHP` | `D:\code\clinic-helper-mcp-server` |
| `cloudflare` | Remote HTTP | `https://mcp.cloudflare.com/mcp` | None | Remote Cloudflare endpoint |
| `dev-workflow` | stdio | `node C:\Users\mahardhika\AppData\Local\ProgramingLive\ManagedMCP\bootstrap\device-entry.cjs antigravity` | `DEV_WORKFLOW_STATE_FILE`, `DEVWF_MONITOR_URL`, `DEVWF_MACHINE`, `DEVWF_MONITOR_TOKEN`, `DEVWF_AGENT`, `DEVWF_SENTRY_CONFIG`, `DEVWF_RELEASE_URL` | `D:\code\dev-workflow-mcp-server` (deployed via ManagedMCP releases) |
| `infra-knowledge` | stdio | `node D:\code\infra-knowledge-mcp-server\index.js` | None | `D:\code\infra-knowledge-mcp-server` |
| `mermaid` | stdio | `node C:\Users\mahardhika\AppData\Roaming\npm\node_modules\mcp-mermaid\build\index.js` | None | Global npm package `mcp-mermaid` |
| `playwright` | stdio | `cmd /c npx -y @playwright/mcp@latest --isolated` | `PLAYWRIGHT_BROWSERS_PATH` | Managed npm bundle `@playwright/mcp` |
| `pocketbase` | stdio | `node D:/code/pocketbase-mcp-server/src/index.js` | `POCKETBASE_URL`, `POCKETBASE_TOKEN_FILE`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `CF_ACCESS_AUDIENCE` | `D:\code\pocketbase-mcp-server` |
| `zettly` | stdio | `node D:/code/zettly-mcp-server/src/index.js` | None (reads local DPAPI token / config) | `D:\code\zettly-mcp-server` |

---

## 3. Detailed Audit Findings per Server

### 3.1 Central Gateway (`central-gateway`)
- **Status:** [SOURCE-CODE EVIDENCE] Active remote HTTP/SSE gateway on `bw-tools` (`100.78.134.44:3200`).
- **Implementation:** Node.js, `@modelcontextprotocol/sdk`. Entrypoint: `src/index.js`, server: `src/gateway.js`.
- **Modules Loaded:**
  - `modules/pocketbase.js`: Exposes 7 CRUD tools (`pb_health`, `pb_list_collections`, `pb_list_records`, `pb_get_record`, `pb_create_record`, `pb_update_record`, `pb_delete_record`).
  - `modules/infra.js`: Exposes 4 fleet health tools (`infra_overview`, `list_instances`, `find_instance`, `fleet_health`).
  - `modules/notify.js`: Exposes 4 notification tools (`notify_health`, `notify_send`, `notify_list_logs`, `notify_retry`).
  - `modules/factory.js`: Exposes 3 factory tools (`factory_list_projects`, `factory_list_tasks`, `factory_create_task`).
- **Critical Issues Identified:**
  1. [SOURCE-CODE EVIDENCE] `src/modules/factory.js` line 41 contains a hardcoded fallback worker token (`fwt_5TJtuFtnsf9J43g8m3pJApdBu2XhvAWsCZpciTduzdo`).
  2. [VERIFIED FACT] Factory infrastructure has been officially retired. The factory module reintroduces dead workflows and stores sensitive credentials in code.
  3. [SOURCE-CODE EVIDENCE] `modules/infra.js` contains a static, hardcoded JS array `FLEET` (lines 14-49) instead of querying live or structured metadata, creating risk of drift against real GCP inventory.
- **Verdict:** `KEEP_WITH_REFACTOR` (Remove `modules/factory.js`, adopt dynamic/structured infra catalog).

### 3.2 DevWorkflow Core (`dev-workflow`)
- **Status:** [VERIFIED FACT] Active AI governance platform. Registered as canonical workflow manager across all three CLI runtimes (Codex, OpenCode, Antigravity).
- **Implementation:** Node.js, `@modelcontextprotocol/sdk`, SQLite local state, MySQL/Postgres adapters, central monitor sync at `http://100.x.x.14:3100`.
- **Tool Count:** 57 registered tools spanning task lifecycle (`start_task`, `set_plan`, `mark_plan_step`, `mark_dod_item`), git lifecycle (`check_ready_to_commit`, `commit_and_push`, `perform_release`), Zettly Focus synchronization, and Sentry issue tracking.
- **Architectural Integrity:** [VERIFIED FACT] Strictly adheres to the AI Governance Plane boundary. Enforces sequential plan advancement, DoD proof verification, and process locking (`.state/workflow-state.json`).
- **Verdict:** `KEEP`.

### 3.3 Zettly (`zettly`)
- **Status:** [VERIFIED FACT] Active human planning plane server. Connects to `https://zettly.programinglive.com`.
- **Implementation:** Node.js, `@modelcontextprotocol/server`, Zod v4.
- **Tool Count:** 6 tools (`zettly_api`, `zettly_work_briefing`, `zettly_recommend_next_work`, `zettly_record_work_outcome`, `zettly_upload_attachment`, `zettly_download_attachment`).
- **Security & Confirmation:** [SOURCE-CODE EVIDENCE] `src/api-tool.js` strictly enforces high-impact confirmation string checking (`CONFIRM <METHOD> <path>`) for all destructive calls (DELETE, profile mutation, admin endpoints).
- **Verdict:** `KEEP`.

### 3.4 Clinic Helper (`clinic-helper`)
- **Status:** [VERIFIED FACT] Specialized ERP adapter wrapping `clinic.php` CLI for Beautyworld Clinic.
- **Implementation:** Node.js, `@modelcontextprotocol/sdk`. Entrypoint: `index.js`.
- **Tool Count:** 9 tools (`clinic_commands`, `clinic_help`, `clinic_run`, `clinic_auth_status`, `clinic_scope`, `clinic_doctor`, `clinic_release_status`, `clinic_release_plan`, `clinic_knowledge`).
- **Architectural Integrity:** [SOURCE-CODE EVIDENCE] Exposes pure CLI-first domain operations. All destructive commands default to `dry_run: true`, require explicit CLI-generated confirmation phrases (`src/guards.js`), and lock out production environments without explicit double opt-in.
- **Verdict:** `KEEP`.

### 3.5 Playwright (`playwright`)
- **Status:** [VERIFIED FACT] Official Microsoft Playwright MCP bundle (`@playwright/mcp@latest`).
- **Implementation:** Node.js / Playwright browser controller.
- **Tool Count:** 25 tools (`browser_navigate`, `browser_click`, `browser_snapshot`, `browser_take_screenshot`, `browser_evaluate`, etc.).
- **Isolation:** Configured with `--isolated` under Antigravity and `--user-data-dir=...` under Codex.
- **Verdict:** `KEEP`.

### 3.6 Cloudflare (`cloudflare`)
- **Status:** [VERIFIED FACT] Remote official MCP at `https://mcp.cloudflare.com/mcp`.
- **Scope:** Cloudflare public API, Worker deployments, KV/D1/R2, DNS zones, and documentation search.
- **Isolation:** Completely decoupled from local filesystem and internal GCP fleet.
- **Verdict:** `KEEP`.

### 3.7 Infra Knowledge (`infra-knowledge`)
- **Status:** [VERIFIED FACT] Read-only and operational infrastructure knowledge server.
- **Implementation:** Node.js, `@modelcontextprotocol/sdk`, YAML loaders.
- **Tool Count:** 15 tools.
- **Critical Issues Identified:**
  1. [SOURCE-CODE EVIDENCE] `tools/ssh_vm.js` exposes raw bash command execution as root over Tailscale SSH without any interactive confirmation, command allowlist, or audit logging.
  2. [SOURCE-CODE EVIDENCE] 4 tools (`infra_overview`, `list_instances`, `find_instance`, `fleet_health`) completely duplicate the tools in `central-gateway`.
  3. [INFERENCE] Knowledge files in `knowledge/` (`instances.yaml`, `repos.yaml`, `services.yaml`) provide high-value architectural context that should be served via Central Gateway rather than maintaining a separate standalone daemon process.
- **Verdict:** `CONSOLIDATE`.

### 3.8 PocketBase Standalone (`pocketbase`)
- **Status:** [VERIFIED FACT] Standalone local stdio server connecting to `https://pocketbase.programinglive.com`.
- **Implementation:** Node.js, `@modelcontextprotocol/sdk`. Entrypoint: `src/index.js`.
- **Tool Count:** 9 tools.
- **Duplication & Security:**
  1. [SOURCE-CODE EVIDENCE] 7 of its 9 tools (`pb_health`, `pb_list_collections`, `pb_list_records`, `pb_get_record`, `pb_create_record`, `pb_update_record`, `pb_delete_record`) are 100% exact functional duplicates of Central Gateway.
  2. [SOURCE-CODE EVIDENCE] `src/auth.js` attempts to read plaintext superuser tokens from candidate files including `D:/code/pocketbase/.env`.
  3. [RECOMMENDATION] Centralizing PocketBase database access through Central Gateway avoids dispersing superuser tokens across multiple developer workstations and client configuration files.
- **Verdict:** `DISABLE`.

### 3.9 Mermaid (`mermaid`)
- **Status:** [VERIFIED FACT] Standalone local stdio server wrapping `mcp-mermaid` (v0.1.3).
- **Tool Count:** 1 tool (`generate_mermaid_diagram`).
- **Redundancy:**
  1. [SOURCE-CODE EVIDENCE] `build/utils/render.js` spawns a full headless browser via `mermaid-isomorphic` to render diagrams to base64 PNGs.
  2. [VERIFIED FACT] Antigravity chat, OpenCode IDE, GitHub, and GitLab render Mermaid diagrams natively from standard Markdown code blocks without any server rendering step.
  3. [VERIFIED FACT] DevWorkflow automatically synchronizes all architectural Mermaid diagrams with Zettly Draw Studio (`https://zettly.programinglive.com/draw/<id>`).
  4. [VERIFIED FACT] No tools, workflows, or scripts depend on `generate_mermaid_diagram`.
- **Verdict:** `REMOVE`.

---

## 4. Architectural Boundaries Assessment

```mermaid
graph TD
    subgraph Human Plane [Zettly — Human Planning Plane]
        Z1[User Todos & Notes]
        Z2[Active Focus Management]
        Z3[Zettly Draw Studio]
        Z4[zettly-mcp-server]
    end

    subgraph Governance Plane [DevWorkflow — AI Governance Plane]
        D1[Task Lifecycle & State Machine]
        D2[Definition of Done Proofs]
        D3[Git Commit & Release Gates]
        D4[dev-workflow-mcp-server]
    end

    subgraph Integration Plane [Central Gateway — Controlled Integration Plane]
        G1[PocketBase Record Access]
        G2[Notification Hub]
        G3[Infra Catalog & Health]
        G4[central-mcp-gateway]
    end

    subgraph Specialized Plane [Specialized Domain & Testing MCPs]
        C1[clinic-helper - Clinic ERP CLI Wrapper]
        P1[playwright - E2E Browser Testing]
        CF1[cloudflare - Edge & Cloud Resources]
    end

    Human Plane <--> Governance Plane
    Governance Plane --> Integration Plane
    Governance Plane --> Specialized Plane
```

The target topology preserves absolute separation between:
1. **Human Planning** (Zettly owns goals, daily outcomes, and visual boards).
2. **AI Execution Governance** (DevWorkflow owns task contracts, evidence, and release locks).
3. **Internal Data & Integration** (Central Gateway acts as the audited gateway).
4. **Specialized Tools** (Clinic ERP, Playwright, Cloudflare remain cleanly isolated).
