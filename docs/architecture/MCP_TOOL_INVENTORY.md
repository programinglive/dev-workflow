# MCP Tool Inventory — Comprehensive Ecosystem Catalog

> **Scope:** Full inventory of all tools across 9 connected MCP servers.  
> **Source Evidence:** Extracted directly from server implementations and cached tool schemas.  
> **Classification:** READ (No state mutation) vs WRITE (State mutated) vs EXEC (Process/Command execution).

---

## 1. Inventory Summary by Server

| MCP Server | Registered Tool Count | Read Tools | Write / Exec Tools | Destructive Potential | Primary Underlying Service |
|---|---|---|---|---|---|
| `central-gateway` | 15 active (+3 legacy) | 8 | 7 | High (pb_delete_record) | PocketBase, Notification Hub, GCP Fleet |
| `clinic-helper` | 9 | 8 | 1 | High (clinic_run on write commands) | Clinic ERP CLI (`clinic.php`), GitLab API |
| `cloudflare` | ~15 | ~10 | ~5 | High (Workers/DNS mutation) | Cloudflare Public API |
| `dev-workflow` | 57 | 18 | 39 | High (commit_and_push, release, drop_task) | Local Git, Zettly API, DevWF Monitor, Sentry |
| `infra-knowledge` | 15 | 14 | 1 | Critical (ssh_vm runs arbitrary root bash) | GCP YAML Knowledge, Tailscale SSH |
| `mermaid` | 1 | 1 | 0 | None (renders base64 image via headless browser) | `mermaid-isomorphic` / Chromium |
| `playwright` | 25 | 10 | 15 | Medium-High (browser_run_code_unsafe) | Headless Chromium/WebKit |
| `pocketbase` | 9 | 5 | 4 | High (pb_delete_record, pb_create_collection) | PocketBase REST API (Direct) |
| `zettly` | 6 | 3 | 3 | High (zettly_api DELETE, upload) | Zettly REST API (`https://zettly.programinglive.com`) |

---

## 2. Tool Catalog

### 2.1 Central Gateway (`central-gateway`)
- **Transport:** HTTP / SSE (`http://100.78.134.44:3200/mcp`)
- **Source:** `D:\code\central-mcp-gateway\src\modules\`

| Tool Name | Class | Purpose | Underlying Service | Required Permissions | Destructive Potential | Equivalent Tools |
|---|---|---|---|---|---|---|
| `pb_health` | READ | Check PocketBase server health and token validity | PocketBase API (`/api/health`) | None | None | `pocketbase.pb_health` (EXACT_DUPLICATE) |
| `pb_list_collections` | READ | List PocketBase collections and schema | PocketBase API (`/api/collections`) | PocketBase Admin / Superuser | None | `pocketbase.pb_list_collections` (EXACT_DUPLICATE) |
| `pb_list_records` | READ | Query collection records with filters & sort | PocketBase API (`/api/collections/:name/records`) | PocketBase Collection Read | None | `pocketbase.pb_list_records` (EXACT_DUPLICATE) |
| `pb_get_record` | READ | Retrieve single record by ID | PocketBase API (`/api/collections/:name/records/:id`) | PocketBase Collection Read | None | `pocketbase.pb_get_record` (EXACT_DUPLICATE) |
| `pb_create_record` | WRITE | Insert new record into collection | PocketBase API | PocketBase Collection Write | Low (Data created) | `pocketbase.pb_create_record` (EXACT_DUPLICATE) |
| `pb_update_record` | WRITE | Update existing record by ID | PocketBase API | PocketBase Collection Write | Medium (Data modified) | `pocketbase.pb_update_record` (EXACT_DUPLICATE) |
| `pb_delete_record` | WRITE | Delete record by ID | PocketBase API | PocketBase Collection Delete | High (Data deleted) | `pocketbase.pb_delete_record` (EXACT_DUPLICATE) |
| `infra_overview` | READ | High level count & freshness of infra fleet | Internal Fleet Constant (`FLEET`) | None | None | `infra-knowledge.infra_overview` (EXACT_DUPLICATE) |
| `list_instances` | READ | List GCP VM instances and roles | Internal Fleet Constant (`FLEET`) | None | None | `infra-knowledge.list_instances` (EXACT_DUPLICATE) |
| `find_instance` | READ | Get technical spec for specific instance | Internal Fleet Constant (`FLEET`) | None | None | `infra-knowledge.find_instance` (EXACT_DUPLICATE) |
| `fleet_health` | READ | Check connectivity of fleet nodes | Internal Fleet Constant (`FLEET`) | Tailscale Network | None | `infra-knowledge.fleet_health` (EXACT_DUPLICATE) |
| `notify_health` | READ | Check Notification Hub gateway health | Notification Hub (`http://127.0.0.1:3099`) | Admin API Key | None | None (UNIQUE_CAPABILITY) |
| `notify_send` | WRITE | Send Discord/Email/Webhook alert | Notification Hub | Admin API Key | Low (Sends notification) | None (UNIQUE_CAPABILITY) |
| `notify_list_logs` | READ | Query notification delivery audit logs | Notification Hub | Admin API Key | None | None (UNIQUE_CAPABILITY) |
| `notify_retry` | WRITE | Retry sending failed notification by ID | Notification Hub | Admin API Key | Low (Retries dispatch) | None (UNIQUE_CAPABILITY) |
| *`factory_list_projects`* | READ | *Legacy Factory: list projects* | *Retired Factory API* | *FACTORY_WORKER_TOKEN* | None | *RETIRED* |
| *`factory_list_tasks`* | READ | *Legacy Factory: list kanban tasks* | *Retired Factory API* | *FACTORY_WORKER_TOKEN* | None | *RETIRED* |
| *`factory_create_task`* | WRITE | *Legacy Factory: create task* | *Retired Factory API* | *FACTORY_WORKER_TOKEN* | Low | *RETIRED* |

---

### 2.2 Clinic Helper (`clinic-helper`)
- **Transport:** stdio (`node D:\code\clinic-helper-mcp-server\index.js`)
- **Source:** `D:\code\clinic-helper-mcp-server\src\tools.js`

| Tool Name | Class | Purpose | Underlying Service | Required Permissions | Destructive Potential | Equivalent Tools |
|---|---|---|---|---|---|---|
| `clinic_commands` | READ | Search available Clinic CLI commands in manifest | Local Catalog (`src/catalog.js`) | None | None | None (UNIQUE_CAPABILITY) |
| `clinic_help` | READ | View CLI usage string and parameter documentation | Local Catalog / `clinic.php` | None | None | None (UNIQUE_CAPABILITY) |
| `clinic_run` | EXEC | Execute validated Clinic CLI command with guards | PHP CLI (`clinic.php`) | Local PHP execution / Profile token | High (on write commands; guarded by dry-run & phrase confirmation) | None (UNIQUE_CAPABILITY) |
| `clinic_auth_status` | READ | Check session authentication across profiles | Profile Token Cache | Local Filesystem | None | None (UNIQUE_CAPABILITY) |
| `clinic_scope` | READ | List companies and branches for tenant scoping | Clinic DB / CLI cache | None | None | None (UNIQUE_CAPABILITY) |
| `clinic_doctor` | READ | Environment diagnostic (PHP, Node, versions) | Local System Checks | None | None | None (UNIQUE_CAPABILITY) |
| `clinic_release_status`| READ | Inspect GitLab CI release pipeline for tag | GitLab REST API | `GITLAB_TOKEN` | None | None (UNIQUE_CAPABILITY) |
| `clinic_release_plan` | READ | Build & validate release steps for clinic tag | Local Release Logic / Git | None | None | None (UNIQUE_CAPABILITY) |
| `clinic_knowledge` | READ | Query clinic domain roles & business rules | Local Knowledge Loader | None | None | None (UNIQUE_CAPABILITY) |

---

### 2.3 DevWorkflow Core (`dev-workflow`)
- **Transport:** stdio (`ManagedMCP/bootstrap/device-entry.cjs`)
- **Source:** `D:\code\dev-workflow-mcp-server\tools\definitions.js`

| Key Tool Category | Tools Count | Primary Tools | Class | Destructive Potential | Purpose |
|---|---|---|---|---|---|
| Task Lifecycle & State | 25 | `start_task`, `set_plan`, `mark_plan_step`, `set_definition_of_done`, `mark_dod_item`, `waive_dod_item`, `complete_task`, `force_complete_task`, `drop_task`, `fetch_task`, `resume_session`, `get_workflow_status`, `refine_with_ai` | WRITE / READ | Medium (Modifies active workflow state; `drop_task` cancels task) | AI execution governance, plan tracking, and DoD compliance enforcement |
| Git & Release Gates | 10 | `check_ready_to_commit`, `commit_and_push`, `perform_release`, `skip_release`, `acquire_release_lock`, `release_release_lock`, `record_deployment` | WRITE / EXEC | High (`commit_and_push` pushes code; `perform_release` pushes tags) | Git automation, branch isolation, and release locking |
| Zettly Synchronization | 7 | `get_current_focus`, `set_focus`, `link_task_to_focus`, `complete_focus`, `sync_zettly_task`, `get_zettly_task_context`, `link_zettly_drawing` | WRITE / READ | Medium (Updates Zettly Todos & Foci) | Headless synchronization with Human Planning Plane |
| Sentry Integrations | 5 | `inventory_sentry_issues`, `list_sentry_issues`, `get_sentry_issue`, `link_sentry_issue`, `mark_bug_fixed` | WRITE / READ | Low (Annotates Sentry issues) | Sentry error triage and resolution tracking |
| Quality, Testing & Audit | 10 | `create_feature_flow`, `create_tests`, `run_tests`, `skip_tests`, `create_documentation`, `security_audit`, `search_project`, `recommend_mcp_tools`, `build_report` | WRITE / READ / EXEC | Medium (`run_tests` executes test runner) | Testing requirements, documentation verification, and tool recommendations |

---

### 2.4 Infra Knowledge (`infra-knowledge`)
- **Transport:** stdio (`node D:\code\infra-knowledge-mcp-server\index.js`)
- **Source:** `D:\code\infra-knowledge-mcp-server\tools\`

| Tool Name | Class | Purpose | Underlying Service | Required Permissions | Destructive Potential | Equivalent Tools |
|---|---|---|---|---|---|---|
| `infra_overview` | READ | Entity counts & freshness across infra files | YAML Knowledge Base | Local FS | None | `central-gateway.infra_overview` (EXACT_DUPLICATE) |
| `list_instances` | READ | List GCP VM instances and specs | `knowledge/instances.yaml` | Local FS | None | `central-gateway.list_instances` (EXACT_DUPLICATE) |
| `find_instance` | READ | Find specific instance configuration | `knowledge/instances.yaml` | Local FS | None | `central-gateway.find_instance` (EXACT_DUPLICATE) |
| `find_account` | READ | Find service accounts and credentials metadata | `knowledge/accounts.yaml` | Local FS | None | None (Candidate for Central Gateway consolidation) |
| `find_repo` | READ | Find repository ownership & deployment target | `knowledge/repos.yaml` | Local FS | None | None (Candidate for Central Gateway consolidation) |
| `find_domain` | READ | Find domain DNS and SSL configurations | `knowledge/domains.yaml` | Local FS | None | None (Candidate for Central Gateway consolidation) |
| `deploy_path` | READ | Look up application deployment path on VM | `knowledge/instances.yaml` | Local FS | None | None (Candidate for Central Gateway consolidation) |
| `find_billing` | READ | Find GCP/provider billing account metadata | `knowledge/billing.yaml` | Local FS | None | None (Candidate for Central Gateway consolidation) |
| `list_devices` | READ | List fleet devices (HELLOWORLD, Mac, MMCH) | `knowledge/devices.yaml` | Local FS | None | None (Candidate for Central Gateway consolidation) |
| `find_device` | READ | Find device specification and IP | `knowledge/devices.yaml` | Local FS | None | None (Candidate for Central Gateway consolidation) |
| `search_knowledge` | READ | Full-text search across knowledge base | All YAML knowledge files | Local FS | None | None (Candidate for Central Gateway consolidation) |
| `knowledge_freshness`| READ | Audit staleness of knowledge base files | YAML metadata | Local FS | None | None (Candidate for Central Gateway consolidation) |
| `ssh_vm` | EXEC | Execute shell command on VM over SSH | Local SSH client / Tailscale | Host root / SSH key | CRITICAL (Unrestricted remote root shell execution) | None (HAZARDOUS — SHOULD BE RETIRED) |
| `release_drift` | READ | Check version drift across fleet nodes | Tailscale network / git | Network | None | None |
| `fleet_health` | READ | Verify online status of fleet nodes | Tailscale Ping | Network | None | `central-gateway.fleet_health` (EXACT_DUPLICATE) |

---

### 2.5 PocketBase Standalone (`pocketbase`)
- **Transport:** stdio (`node D:/code/pocketbase-mcp-server/src/index.js`)
- **Source:** `D:\code\pocketbase-mcp-server\src\tools.js`

| Tool Name | Class | Purpose | Underlying Service | Required Permissions | Destructive Potential | Equivalent Tools |
|---|---|---|---|---|---|---|
| `pb_health` | READ | Check PocketBase server health | PocketBase API | None | None | `central-gateway.pb_health` (EXACT_DUPLICATE) |
| `pb_list_collections` | READ | List collections and schema definitions | PocketBase API | Admin token | None | `central-gateway.pb_list_collections` (EXACT_DUPLICATE) |
| `pb_get_collection` | READ | Get schema for specific collection | PocketBase API | Admin token | None | Standalone only (Low usage) |
| `pb_create_collection`| WRITE | Create new collection and schema fields | PocketBase API | Admin token | High (Schema modification) | Standalone only |
| `pb_list_records` | READ | Query records with filter & sort | PocketBase API | Collection Read | None | `central-gateway.pb_list_records` (EXACT_DUPLICATE) |
| `pb_get_record` | READ | Fetch single record by ID | PocketBase API | Collection Read | None | `central-gateway.pb_get_record` (EXACT_DUPLICATE) |
| `pb_create_record` | WRITE | Create new record | PocketBase API | Collection Write | Low (Data created) | `central-gateway.pb_create_record` (EXACT_DUPLICATE) |
| `pb_update_record` | WRITE | Modify existing record | PocketBase API | Collection Write | Medium (Data modified) | `central-gateway.pb_update_record` (EXACT_DUPLICATE) |
| `pb_delete_record` | WRITE | Delete record by ID | PocketBase API | Collection Delete | High (Data deleted) | `central-gateway.pb_delete_record` (EXACT_DUPLICATE) |

---

### 2.6 Zettly (`zettly`)
- **Transport:** stdio (`node D:/code/zettly-mcp-server/src/index.js`)
- **Source:** `D:\code\zettly-mcp-server\src\`

| Tool Name | Class | Purpose | Underlying Service | Required Permissions | Destructive Potential | Equivalent Tools |
|---|---|---|---|---|---|---|
| `zettly_api` | READ/WRITE | Direct call to any Zettly `/api/v1/*` endpoint | Zettly REST API | Zettly User Token (DPAPI) | High (Guarded by `CONFIRM <METHOD> <path>`) | None (UNIQUE_CAPABILITY) |
| `zettly_work_briefing`| READ | Summarize today's todos, sessions, journal | Zettly Context API | Zettly User Token | None | None (UNIQUE_CAPABILITY) |
| `zettly_recommend_next_work` | READ | Rank unfinished todos by urgency & priority | Zettly Context API | Zettly User Token | None | None (UNIQUE_CAPABILITY) |
| `zettly_record_work_outcome` | WRITE | Record daily journal entry and link Todo | Zettly Journal API | Zettly User Token | Low (Appends journal entry) | None (UNIQUE_CAPABILITY) |
| `zettly_upload_attachment` | WRITE | Upload local file to a Todo | Zettly Attachment API | Zettly User Token | Low (Guarded by explicit phrase) | None (UNIQUE_CAPABILITY) |
| `zettly_download_attachment` | READ/WRITE | Download attachment to local disk | Zettly Attachment API | Zettly User Token | Low (Guarded by overwrite flag) | None (UNIQUE_CAPABILITY) |

---

### 2.7 Mermaid (`mermaid`)
- **Transport:** stdio (`mcp-mermaid`)
- **Source:** `C:\Users\mahardhika\AppData\Roaming\npm\node_modules\mcp-mermaid`

| Tool Name | Class | Purpose | Underlying Service | Required Permissions | Destructive Potential | Equivalent Tools |
|---|---|---|---|---|---|---|
| `generate_mermaid_diagram` | READ | Render mermaid syntax to base64 PNG/SVG | `mermaid-isomorphic` / Chromium | Local execution | None (High memory/CPU usage) | Native Markdown rendering in chat UI & Zettly Draw Studio |

---

### 2.8 Playwright (`playwright`)
- **Transport:** stdio (`@playwright/mcp@latest`)
- **Tools Count:** 25 tools (`browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_take_screenshot`, `browser_evaluate`, `browser_run_code_unsafe`, `browser_wait_for`, `browser_tabs`, etc.)
- **Class:** READ / WRITE / EXEC
- **Purpose:** Full browser automated testing and accessibility tree inspection.
- **Destructive Potential:** Medium-High (`browser_run_code_unsafe` runs arbitrary JS). Isolated context limits profile contamination.

---

### 2.9 Cloudflare (`cloudflare`)
- **Transport:** Remote HTTP (`https://mcp.cloudflare.com/mcp`)
- **Scope:** Official Cloudflare tools for zone management, Workers KV/R2/D1 inspection, and Cloudflare developer documentation lookups.
- **Class:** READ / WRITE
- **Destructive Potential:** High (on zone/worker modification requests).
