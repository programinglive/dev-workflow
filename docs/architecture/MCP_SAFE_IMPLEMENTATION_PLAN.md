# MCP Safe Implementation & Migration Plan

> **Scope:** Exact file modifications, line-level code changes, test gates, approval checkpoints, and rollback steps.  
> **Constraint:** Zero downtime, zero disruption to active AI sessions, zero destructive actions during planning.

---

## 1. Active Session Assessment & Maintenance Window

As verified by `list_active_sessions`, **8 active development sessions** are currently running across `HELLOWORLD`, `Mac`, and `MMCH` (e.g., `zettly-editor`, `dbpinball`, `bw-server-grooming`, `clinic-wt-s1b`).

**Safety Rule:** No services will be restarted and no client configs reloaded until active sessions reach idle or a designated maintenance window is approved by the owner.

---

## 2. File-by-File Code Modification Specifications

### 2.1 Repository: `central-mcp-gateway` (Deployed on `bw-tools`)

#### File 1: `src/modules/factory.js`
- **Action:** **DELETE FILE ENTIRELY**.
- **Impact:** Removes hardcoded fallback token and 3 dead tools (`factory_list_projects`, `factory_list_tasks`, `factory_create_task`).

#### File 2: `src/gateway.js`
- **Changes:**
  - Remove line 17: `import { getFactoryTools, handleFactoryCall } from './modules/factory.js';`
  - Remove line 29: `...getFactoryTools(),` from `allTools` array.
  - Remove lines 46-48:
    ```javascript
    } else if (name.startsWith('factory_')) {
      result = await handleFactoryCall(name, args || {});
    ```

#### File 3: `src/modules/pocketbase.js`
- **Changes:** Add `pb_get_collection` and `pb_create_collection` to `getPocketBaseTools()` and `handlePocketBaseCall()`:
  ```javascript
  {
    name: 'pb_get_collection',
    description: 'Get schema and detailed information for a specific collection.',
    inputSchema: {
      type: 'object',
      properties: { nameOrId: { type: 'string', description: 'Collection name or ID' } },
      required: ['nameOrId']
    }
  },
  {
    name: 'pb_create_collection',
    description: 'Create a new collection with field schema and rules.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        type: { type: 'string', enum: ['base', 'auth', 'view'], default: 'base' },
        fields: { type: 'array' },
        listRule: { type: 'string' },
        viewRule: { type: 'string' },
        createRule: { type: 'string' },
        updateRule: { type: 'string' },
        deleteRule: { type: 'string' }
      },
      required: ['name']
    }
  }
  ```

#### File 4: `tests/gateway.test.js`
- **Changes:** Remove tests expecting `factory_*` tools; add unit tests asserting `factory_*` calls throw `Tool not registered`.

---

### 2.2 Repository: `infra-knowledge-mcp-server`

#### File 1: `tools/definitions.js`
- **Changes:** Remove the `ssh_vm` definition block (lines 142-162).

#### File 2: `tools/handlers.js`
- **Changes:** Remove `case 'ssh_vm': return sshVm(args, deps);`. Keep `sshVm` as an internal helper strictly for `fleet_health.js` and `release_drift.js`.

---

### 2.3 Client Configuration Files (HELLOWORLD, Mac, MMCH)

#### File 1: `~/.gemini/antigravity/mcp_config.json`
- **Changes:**
  - Remove `"mermaid"` block.
  - Remove `"pocketbase"` block.
  - Remove `"infra-knowledge"` block.
  - Verify remaining 6: `"dev-workflow"`, `"clinic-helper"`, `"zettly"`, `"playwright"`, `"cloudflare"`, `"central-gateway"`.

#### File 2: `~/.codex/config.toml`
- **Changes:**
  - Remove `[mcp_servers.mermaid]`.
  - Remove `[mcp_servers.pocketbase]`.
  - Remove `[mcp_servers.infra-knowledge]`.

#### File 3: `~/.config/opencode/opencode.json`
- **Changes:**
  - Remove `"mermaid"`, `"pocketbase"`, `"infra-knowledge"` from `mcp.servers`.

---

## 3. Ordered Implementation Sequence

1. **Step 1 (Pre-flight):** Take timestamped backups of all 3 client configuration files on `HELLOWORLD`, `Mac`, and `MMCH`.
2. **Step 2 (Backend Refactor):** In `central-mcp-gateway`, delete `factory.js`, add PB schema tools, run `npm test`.
3. **Step 3 (Remote Deploy):** Push `central-mcp-gateway` changes to GitHub, pull on `bw-tools`, restart `central-mcp-gateway.service`.
4. **Step 4 (Containment):** In `infra-knowledge-mcp-server`, unregister `ssh_vm` from tool list and handlers, run tests.
5. **Step 5 (Config Alignment):** Update client configuration files across devices to remove `mermaid`, `pocketbase`, `infra-knowledge`.
6. **Step 6 (Maintenance Reload):** During an approved idle window, run `node managed/mcp-reconnect.cjs` and verify `fleet-status.cjs`.

---

## 4. Rollback Plan

- **Central Gateway:** `git revert HEAD` in `/opt/central-mcp-gateway` on `bw-tools` and restart service.
- **Client Configurations:** Copy timestamped backup files (`mcp_config.json.bak-<timestamp>`, etc.) back into place.
- **Infra Knowledge:** `git checkout main` to restore `ssh_vm` if emergency access is required.
