# Public Core vs. Private Enterprise Boundaries

**Document Version:** 1.0.0  
**Pattern:** Open-Core Architecture with Pluggable Enterprise Adapters  

---

## 1. Boundary Architecture

DevWorkflow enforces strict boundaries between what is distributed publicly and what is retained privately:

```text
+---------------------------------------------------------------------------------+
|                       PUBLIC OPEN-SOURCE CORE REPOSITORY                        |
|                                                                                 |
|   +-----------------------+   +-----------------------+   +-----------------+   |
|   |  Task Contract Engine |   | Policy-as-Code Engine |   |  State Machine  |   |
|   +-----------------------+   +-----------------------+   +-----------------+   |
|   +-----------------------+   +-----------------------+   +-----------------+   |
|   |  Evidence Store (TDD) |   |  Git Worktree Manager |   |  Event Journal  |   |
|   +-----------------------+   +-----------------------+   +-----------------+   |
|   +-----------------------+   +-----------------------+   +-----------------+   |
|   |  Local SQLite Store   |   |  Local Mermaid Engine |   |  Local Monitor  |   |
|   +-----------------------+   +-----------------------+   +-----------------+   |
|   +-------------------------------------------------------------------------+   |
|   |  Provider SDK (Generic Interfaces: TaskTracker, VisualFlow, Storage)    |   |
|   +-------------------------------------------------------------------------+   |
+---------------------------------------------------------------------------------+
                                      |
                      [Pluggable Provider SDK Interfaces]
                                      v
+---------------------------------------------------------------------------------+
|                    PRIVATE / ENTERPRISE ADAPTER REPOSITORY                      |
|                                                                                 |
|   +---------------------------+       +-------------------------------------+   |
|   |  Zettly Provider Adapter  |       |  Multi-Machine Tailscale Rollout    |   |
|   |  - DPAPI/Keychain Token   |       |  - rollout.cjs, restart-devices.cjs |   |
|   |  - Zettly Draw v4 Engine  |       |  - build-host.example, HELLOWORLD, Mac, MMCH  |   |
|   +---------------------------+       +-------------------------------------+   |
|   +---------------------------+       +-------------------------------------+   |
|   |  Sentry Issue Pipeline    |       |  Proprietary Homelab CI Config      |   |
|   +---------------------------+       +-------------------------------------+   |
+---------------------------------------------------------------------------------+
```

---

## 2. Component Distribution Classification

| Subsystem / File | Classification | Destination | Rationale |
|---|---|---|---|
| `index.js`, `workflow-state.js` | **PUBLIC CORE** | Public Repo | Core MCP server and state machine. |
| `contracts/` | **PUBLIC CORE** | Public Repo | Task Contract and scope drift engine. |
| `policy/` | **PUBLIC CORE** | Public Repo | Policy-as-Code engine (`devworkflow.yaml`). |
| `evidence/` | **PUBLIC CORE** | Public Repo | Immutable test evidence store. |
| `db/` (SQLite adapter, schema) | **PUBLIC CORE** | Public Repo | Local-first persistence. |
| `tools/` (57 MCP tools) | **PUBLIC CORE** | Public Repo | Workflow discipline gates. |
| `monitor-server/dashboard.cjs` | **PUBLIC CORE** | Public Repo | Standalone local monitor on `localhost:3100`. |
| `bin/cli.js`, `cli/` | **PUBLIC CORE** | Public Repo | Standalone `devworkflow` CLI. |
| `zettly-client.js`, `zettly-workflow.js` | **PUBLIC ADAPTER** | Extensible Plugin | First-party Zettly provider adhering to Provider SDK. |
| `managed/rollout.cjs` | **PRIVATE EXTENSION** | Internal Config | Specific to internal 3-workstation Tailscale topology. |
| `managed/restart-devices.cjs` | **PRIVATE EXTENSION** | Internal Config | Specific to internal machine process management. |
| `docs/homelab/` | **PRIVATE EXTENSION** | Internal Docs | Private runner and network documentation. |
| `.env.example` | **PUBLIC CORE** | Public Repo | Sanitized template containing placeholders only. |
