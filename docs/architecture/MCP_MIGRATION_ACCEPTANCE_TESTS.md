# MCP Migration Acceptance & Regression Test Suite

> **Scope:** Definitive verification checklist and executable acceptance tests for the consolidated 6-server MCP architecture.  
> **Execution Gate:** Must pass 100% before owner signs off on completion.

---

## 1. Automated Unit & Integration Tests

Run these test suites in their respective local checkouts:

| Test Suite | Repository / Command | Expected Result | Gate Condition |
|---|---|---|---|
| Central Gateway Suite | `npm test` in `D:\code\central-mcp-gateway` | All tests pass; `factory_*` assert rejected; `pb_*` pass | Required before deployment to `bw-tools` |
| Clinic Helper Doctor | `node index.js doctor` in `D:\code\clinic-helper-mcp-server` | All manifest, PHP, and environment checks pass | Required before client reload |
| DevWorkflow Integrity | `npm test` in `D:\code\dev-workflow-mcp-server` | Workflow state, process locks, and tool handlers pass | Required before fleet rollout |
| Infra Knowledge Probes | `npm test` in `D:\code\infra-knowledge-mcp-server` | `fleet_health` and `release_drift` pass without `ssh_vm` tool | Required before client reload |
| Zettly Read-Only Check | `npm run smoke:readonly` in `D:\code\zettly-mcp-server` | Connects, reads user profile and active focus without error | Required before client reload |

---

## 2. MCP Tool Functional Acceptance Tests

Execute these test tool calls via an AI client session (or `mcp-reconnect.cjs` verification probe):

### Test Group 1: Central Gateway (`central-gateway`)
1. **Health Probe:**
   - Call: `call_mcp_tool` -> `ServerName: "central-gateway"`, `ToolName: "pb_health"`
   - Expected: `{ "ok": true, "status": 200 }`
2. **Record Query:**
   - Call: `call_mcp_tool` -> `ServerName: "central-gateway"`, `ToolName: "pb_list_records"`, `Arguments: { "collection": "users", "perPage": 1 }`
   - Expected: Returns array containing user record with sensitive tokens redacted.
3. **Notification Health:**
   - Call: `call_mcp_tool` -> `ServerName: "central-gateway"`, `ToolName: "notify_health"`
   - Expected: `{ "status": "ok", "service": "notification-hub" }`
4. **Infra Fleet Status:**
   - Call: `call_mcp_tool` -> `ServerName: "central-gateway"`, `ToolName: "infra_overview"`
   - Expected: Returns fleet entity counts for instances, domains, and devices.

### Test Group 2: Decommissioned Security & Dead Tools (Negative Tests)
1. **SSH Execution Blocked:**
   - Call: `call_mcp_tool` -> `ServerName: "infra-knowledge"`, `ToolName: "ssh_vm"`
   - Expected: **ERROR: Tool "ssh_vm" is not registered.** (AI cannot execute root shell).
2. **Factory Tools Blocked:**
   - Call: `call_mcp_tool` -> `ServerName: "central-gateway"`, `ToolName: "factory_list_tasks"`
   - Expected: **ERROR: Tool "factory_list_tasks" is not registered.** (Dead factory purged).
3. **Mermaid Standalone Blocked:**
   - Call: `call_mcp_tool` -> `ServerName: "mermaid"`, `ToolName: "generate_mermaid_diagram"`
   - Expected: **ERROR: Server "mermaid" is not configured.**

### Test Group 3: Retained Core MCPs Acceptance
1. **DevWorkflow State Check:**
   - Call: `call_mcp_tool` -> `ServerName: "dev-workflow"`, `ToolName: "get_workflow_status"`
   - Expected: Current task, active plan step, and DoD list returned.
2. **Zettly Human Briefing:**
   - Call: `call_mcp_tool` -> `ServerName: "zettly"`, `ToolName: "zettly_work_briefing"`
   - Expected: Active todos, journal entries, and active focuses returned without mutation.
3. **Clinic Helper Safe Execution:**
   - Call: `call_mcp_tool` -> `ServerName: "clinic-helper"`, `ToolName: "clinic_doctor"`, `Arguments: { "deep": false }`
   - Expected: Clinic PHP version and manifest integrity reported.
4. **Playwright Isolation Check:**
   - Call: `call_mcp_tool` -> `ServerName: "playwright"`, `ToolName: "browser_navigate"`, `Arguments: { "url": "about:blank" }`
   - Expected: Browser starts in isolated context and reports ready.

---

## 3. Fleet Parity Verification

Run on the release controller host:
```bash
node managed/fleet-status.cjs
```
- **Acceptance Criteria:**
  - `HELLOWORLD`: All 6 servers connected and responsive (Green).
  - `Mac`: All 6 servers connected and responsive (Green).
  - `MMCH`: All 6 servers connected and responsive (Green).
  - Zero transport errors (Code 255 / Connection Refused).
