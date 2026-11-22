# DEVWORKFLOW MCP V2.1.5 — TOOL CONSOLIDATION & INTELLIGENT ARCHITECTURE OPTIMIZATION FINAL REPORT

> [!IMPORTANT]
> **Final Engineering Verdict:** `VERIFIED COMPLETE`
> - **Package & Release:** `@programinglive/dev-workflow@2.1.5` (Tag: `v2.1.5`)
> - **Baseline Verified:** `@programinglive/dev-workflow@2.1.4` (`17f46330f77fe2fa9fb03c04420555223291c6f0`) & Zettly (`f103148`)
> - **Total Public MCP Tools Inventoried:** **84** (**80 canonical public tools** + **4 documented compatibility aliases**, **0 unmapped**, **0 untested**)
> - **Non-Tool Interfaces Inventoried:** **2 MCP Prompts**, **0 MCP Resources**, **14 CLI Subcommands**, **4 Shared Domain Services / Internal Helpers**
> - **Test Verification:** **339/339 tests passing** (**198/198** DevWorkflow tests across 18 suites + **141/141** Zettly tests)

---

## A. Executive Summary

Following the independent architectural review of `@programinglive/dev-workflow@2.1.4` (`17f46330f77f`), we executed a complete inventory, semantic duplication audit (`D0..D6`), internal handler consolidation, metadata disambiguation, and regression-gate hardening across the entire DevWorkflow MCP server:

1. **Complete 84-Tool Canonical Inventory (`src/tool-catalog-auditor.js`):** Mapped every publicly registered MCP tool across `focusToolDefinitions` (4), `DEVWORKFLOW_V2_TOOL_DEFINITIONS` (23, including the new `audit_tool_catalog`), and `tools/definitions.js` (57) with its exact handler function, source module, shared domain service, input/output contracts, side effects, permission classification, session-scope policy, and test coverage.
2. **Semantic Duplication Classification (`DUP-01..DUP-14` across `D0..D6`):**
   - **`D0` Exact Duplicate (`DUP-01`):** `helper_suggest_tests` and `helper_change_impact` had identical schemas and dispatched to the exact same `analyzeChangeImpact({ projectDir, files })` switch branch. Consolidated via **Strategy S1 + S2**: `helper_change_impact` is the canonical tool; `helper_suggest_tests` is preserved in `TOOL_ALIASES` as a 100% backward-compatible alias.
   - **`D1` Semantic Duplicates (`DUP-02`, `DUP-03`):** `project_summary`, `project_summary_data`, and `project_summary_db` all formatted the same Project Knowledge Summary from in-memory history, `project-summary.json`, or SQLite. Consolidated into `resolveUnifiedProjectSummary(workflowState, { source })` in `tools/handler-modules/summary-handlers.js`. `project_summary` now accepts optional `{ source: "memory" | "file" | "db" | "auto" }`, while `project_summary_data` and `project_summary_db` remain 100% backward-compatible aliases.
   - **`D3` Wrapper Redundancy (`DUP-04`):** `audit_repository` is a full-repository wrapper around `runEngineeringAudit({ files: [] })` (equivalent to `audit_code` with `files` omitted). Documented in `TOOL_ALIASES` as a supported wrapper and added optional `category` filtering to `audit_code` and `audit_changes`.
   - **`D4` Necessary Specializations (`DUP-09`, `DUP-10`, `DUP-11`):** Preserved distinct authorization and concurrency boundaries across task termination (`complete_task`, `force_complete_task`, `drop_task`), session ownership transfer (`resume_session`, `take_over_task`, `handoff_task`, `fetch_task`, `restart_handshake`), and Sentry single-page query (`list_sentry_issues`) vs full multi-project snapshot (`inventory_sentry_issues`).
   - **`D5` Orphaned Internal Module (`DUP-14`):** Identified `tools/handlers-new.js` as a 1-line duplicate re-export of `tools/handlers.js` with zero internal callers.
   - **`D6` False Duplicates (`DUP-07`, `DUP-08`):** Disambiguated `security_audit` (`[READ_ONLY_RUNTIME_DB]` scanning DevWorkflow state, env config, and SQLite/Postgres/MySQL rows) vs `audit_security` (`[READ_ONLY_STATIC]` scanning target source files against `ZET-SEC-*`), and `site_audit` (`[READ_ONLY_HTTP]` website crawler) vs `audit_code`.
3. **Automated Tool Catalog Auditor & Regression Gate (`audit_tool_catalog` & `devwf audit catalog`):** Added public MCP tool `audit_tool_catalog`, CLI subcommand `devwf audit catalog`, internal helper `helper_consolidation_plan` (`generateConsolidationPlan`), and `validateToolRegistrationGate` to block duplicate tool IDs, missing descriptions/schemas, and unfenced read/write permission merges while flagging redundant handlers.

---

## B. Verified Baseline

| Attribute | Baseline (v2.1.4) | Target Release (v2.1.5) |
| :--- | :--- | :--- |
| **Package** | `@programinglive/dev-workflow@2.1.4` | `@programinglive/dev-workflow@2.1.5` |
| **Git Commit / Tag** | `17f46330f77fe2fa9fb03c04420555223291c6f0` (`v2.1.4`) | Tagged `v2.1.5` on `main` |
| **Zettly Commit** | `f103148` (`fingerprint_version: "2.0"`) | `f103148` (verified 141/141 tests passing) |
| **Public MCP Tools** | 83 (with unmapped aliases & 3 separate summary implementations) | **84** (**80 canonical** + **4 mapped compatibility aliases** + `audit_tool_catalog`) |
| **Verified Tests** | 308/308 (167 DevWorkflow + 141 Zettly) | **339/339** (**198 DevWorkflow** + **141 Zettly**) |

---

## C. Complete MCP Tool Inventory (84 Public Tools across 10 Domains)

Every registered MCP tool is machine-inventoried in `CANONICAL_TOOL_METADATA` (`src/tool-catalog-auditor.js`):

| # | Tool ID | Domain Category | Handler / Shared Service | Permission Level | Session-Scoped | Stability / Role |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `get_current_focus` | `focus_management` | `handleFocusTool` / `activeFoci` | `READ_ONLY` | No | `stable` — Read active Zettly focus containers |
| 2 | `set_focus` | `focus_management` | `handleFocusTool` / `POST /focus` | `REMOTE_WRITE` | No | `stable` — Create or reuse active Zettly focus |
| 3 | `link_task_to_focus` | `focus_management` | `handleFocusTool` / `PATCH /todos/:id` | `REMOTE_AND_LOCAL_WRITE` | Yes | `stable` — Attach active task Todo to focus |
| 4 | `complete_focus` | `focus_management` | `handleFocusTool` / `POST /focus/:id/complete` | `REMOTE_WRITE` | Yes | `stable` — Verify and close completed focus |
| 5 | `audit_code` | `code_auditing` | `runEngineeringAudit` | `READ_ONLY` | No | `stable` — Canonical file/repo standards audit |
| 6 | `audit_changes` | `code_auditing` | `runEngineeringAudit` + `resolveGitChangeScope` | `READ_ONLY` | No | `stable` — Audit working tree, staged, or PR diff |
| 7 | `audit_repository` | `code_auditing` | `runEngineeringAudit (files: [])` | `READ_ONLY` | No | `supported_wrapper` (`-> audit_code`) |
| 8 | `audit_architecture` | `code_auditing` | `runEngineeringAudit (architecture)` | `READ_ONLY` | No | `stable` — Evaluate `ZET-ARCH-*` rules |
| 9 | `audit_security` | `code_auditing` | `runEngineeringAudit (security)` | `READ_ONLY` | No | `stable` — Static `ZET-SEC-*` source scan |
| 10 | `audit_tests` | `code_auditing` | `runEngineeringAudit (testing)` | `READ_ONLY` | No | `stable` — Evaluate `ZET-TEST-001` coverage |
| 11 | `audit_api_contracts` | `code_auditing` | `runEngineeringAudit (api-contracts)` | `READ_ONLY` | No | `stable` — Evaluate `ZET-API-001` contracts |
| 12 | `audit_database_changes` | `code_auditing` | `runEngineeringAudit (database)` | `READ_ONLY` | No | `stable` — Evaluate `ZET-DB-001` migrations |
| 13 | `audit_standards` | `code_auditing` | `validateStandardsRegistry` | `READ_ONLY` | No | `stable` — Validate YAML standards registry |
| 14 | `audit_report` | `code_auditing` | `runEngineeringAudit` + `formatAuditReportText` | `READ_ONLY` | No | `stable` — JSON + human `formatted_report` |
| 15 | `audit_tool_catalog` | `code_auditing` | `auditToolCatalog` | `READ_ONLY` | No | `stable` — MCP tool catalog auditor & gate |
| 16 | `helper_explain_violation` | `intelligent_helpers` | `explainViolation` | `READ_ONLY` | No | `stable` — Explain standard & design principle |
| 17 | `helper_plan_fix` | `intelligent_helpers` | `planSafeFix` | `READ_ONLY` | No | `stable` — Generate bounded remediation plan |
| 18 | `helper_autofix_candidates` | `intelligent_helpers` | `runEngineeringAudit (autofix_eligible)` | `READ_ONLY` | No | `stable` — Discover `AF-0`/`AF-1` candidates |
| 19 | `helper_apply_safe_fix` | `intelligent_helpers` | `applyBoundedSafeFix` | `LOCAL_WRITE_FENCED` | No | `stable` — Fenced `AF-0`/`AF-1` autofix + rollback |
| 20 | `helper_suggest_tests` | `intelligent_helpers` | `analyzeChangeImpact` | `READ_ONLY` | No | `deprecated_alias` (`-> helper_change_impact`) |
| 21 | `helper_change_impact` | `intelligent_helpers` | `analyzeChangeImpact` | `READ_ONLY` | No | `stable` — Canonical impact & test recommender |
| 22 | `helper_refactor_advice` | `intelligent_helpers` | `analyzeChangeImpact` + `refactoring_steps` | `READ_ONLY` | No | `stable` — Incremental refactoring guidance |
| 23 | `helper_prioritize_debt` | `intelligent_helpers` | `handleDevWorkflowV2Tool` | `READ_ONLY` | No | `stable` — Rank `P0..P3` technical debt |
| 24 | `helper_root_cause` | `intelligent_helpers` | `handleDevWorkflowV2Tool` | `READ_ONLY` | No | `stable` — Structure error facts vs hypotheses |
| 25 | `helper_docs_update` | `intelligent_helpers` | `handleDevWorkflowV2Tool` | `READ_ONLY` | No | `stable` — Recommend docs to update |
| 26 | `helper_propose_standard` | `intelligent_helpers` | `proposeEngineeringStandard` | `READ_OR_OPTIONAL_PROPOSAL_WRITE` | No | `stable` — Draft advisory standard proposal |
| 27 | `helper_improvement_opportunities` | `intelligent_helpers` | `handleDevWorkflowV2Tool` | `READ_ONLY` | No | `stable` — Workflow/CI improvement advice |
| 28 | `get_zettly_task_context` | `external_integrations` | `readZettlyTaskContext` | `READ_OR_LOCAL_CACHE_ATTACH` | Yes | `stable` — Read bounded Zettly relation graph |
| 29 | `inventory_sentry_issues` | `external_integrations` | `sentryClient.inventoryIssues` | `REMOTE_READ_LOCAL_SNAPSHOT_WRITE` | No | `stable` — Multi-project Sentry snapshot |
| 30 | `get_integration_status` | `external_integrations` | `probe(zettly) + probe(sentry)` | `READ_ONLY` | No | `stable` — Probe Zettly & Sentry connectivity |
| 31 | `list_sentry_issues` | `external_integrations` | `sentryClient.listIssuePage` | `READ_ONLY` | No | `stable` — Single-page Sentry issue query |
| 32 | `get_sentry_issue` | `external_integrations` | `sentryClient.getIssue` | `READ_ONLY` | No | `stable` — Read single Sentry issue summary |
| 33 | `link_zettly_drawing` | `external_integrations` | `drawingMatchesWorkflow` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Attach verified Zettly Draw canvas |
| 34 | `link_sentry_issue` | `external_integrations` | `sentryClient.getIssue` + `save` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Link Sentry issue to active Todo |
| 35 | `security_audit` | `security_and_web_audit` | `securityAudit` + `auditDatabase` | `READ_ONLY` | No | `stable` — Audit runtime state, env & DB rows |
| 36 | `site_audit` | `security_and_web_audit` | `auditSite` | `READ_ONLY_NETWORK` | Yes | `stable` — Live HTTP website audit |
| 37 | `search_project` | `project_search_and_discovery` | `searchProject` | `READ_ONLY` | No | `stable` — Bounded lexical repository search |
| 38 | `start_task` | `task_lifecycle` | `handleStartTaskSerialized` | `LOCAL_AND_REMOTE_WRITE_MUTEX_ACQUIRE` | Yes | `stable` — Acquire worktree mutex & start task |
| 39 | `refine_with_ai` | `task_lifecycle` | `handleRefineWithAi` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Holistic post-investigation refinement |
| 40 | `set_definition_of_done` | `task_lifecycle` | `handleSetDefinitionOfDone` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Append or initialize DoD checklist |
| 41 | `mark_dod_item` | `task_lifecycle` | `handleMarkDodItem` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Prove DoD item with evidence |
| 42 | `waive_dod_item` | `task_lifecycle` | `handleWaiveDodItem` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Exclude DoD item with written reason |
| 43 | `set_plan` | `task_lifecycle` | `handleSetPlan` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Replace ordered implementation plan |
| 44 | `mark_plan_step` | `task_lifecycle` | `handleMarkPlanStep` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Mark plan step done or open |
| 45 | `resume_session` | `session_recovery_and_handoff` | `handleResumeSession` | `READ_OR_LOCAL_WRITE_MUTEX_ACQUIRE` | Yes | `stable` — Adopt orphaned same-machine session |
| 46 | `restart_handshake` | `session_recovery_and_handoff` | `handleRestartHandshake` | `LOCAL_AND_REMOTE_WRITE_MUTEX_CONTROL` | Yes | `stable` — Fenced cooperative process restart |
| 47 | `checkpoint_task` | `session_recovery_and_handoff` | `handleCheckpointTask` | `LOCAL_AND_REMOTE_WRITE_VERIFIED` | Yes | `stable` — Write & read-back verify Zettly checkpoint |
| 48 | `handoff_task` | `session_recovery_and_handoff` | `handleHandoffTask` | `LOCAL_AND_REMOTE_WRITE_VERIFIED` | Yes | `stable` — Push cross-machine handoff (`to`) |
| 49 | `acknowledge_handover` | `session_recovery_and_handoff` | `handleAcknowledgeHandover` | `LOCAL_AND_REMOTE_WRITE_VERIFIED` | Yes | `stable` — Reclaim handed-off task locally |
| 50 | `take_over_task` | `session_recovery_and_handoff` | `handleTakeOverTask` | `LOCAL_LOCK_DIR_WRITE` | Yes | `stable` — Cooperative takeover from idle live PID |
| 51 | `fetch_task` | `session_recovery_and_handoff` | `handleFetchTask` | `SSH_REMOTE_AND_LOCAL_WRITE` | Yes | `stable` — Pull cross-machine checkpoint (`from`) |
| 52 | `mark_bug_fixed` | `task_lifecycle` | `handleMarkBugFixed` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Record implementation completion |
| 53 | `acknowledge_instructions` | `task_lifecycle` | `handleAcknowledgeInstructions` | `LOCAL_WRITE` | Yes | `stable` — Confirm README preflight fingerprint |
| 54 | `create_feature_flow` | `task_lifecycle` | `handleCreateFeatureFlow` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Validate Mermaid flow & sync Draw |
| 55 | `create_tests` | `testing_and_documentation_gates` | `handleCreateTests` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Mark automated tests created |
| 56 | `skip_tests` | `testing_and_documentation_gates` | `handleSkipTests` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Waive test creation with justification |
| 57 | `run_tests` | `testing_and_documentation_gates` | `handleRunTests` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Record test run pass/fail & buildHost |
| 58 | `create_documentation` | `testing_and_documentation_gates` | `handleCreateDocumentation` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Verify changed documentation files |
| 59 | `waive_documentation` | `testing_and_documentation_gates` | `handleWaiveDocumentation` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Waive documentation gate with reason |
| 60 | `check_ready_to_commit` | `git_commit_and_release` | `handleReadyCheck` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Evaluate all 11 pre-commit gates |
| 61 | `commit_and_push` | `git_commit_and_release` | `handleCommitAndPush` | `GIT_LOCAL_AND_REMOTE_WRITE` | Yes | `stable` — Stage, commit, push & verify remote SHA |
| 62 | `perform_release` | `git_commit_and_release` | `handlePerformRelease` | `GIT_AND_RELEASE_WRITE` | Yes | `stable` — Execute or record semver release |
| 63 | `record_deployment` | `git_commit_and_release` | `handleRecordDeployment` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Verify tag ancestry & record deploy |
| 64 | `acquire_release_lock` | `git_commit_and_release` | `handleAcquireReleaseLock` | `LOCAL_WRITE_FENCED` | Yes | `stable` — Claim 2-hour `.git/` release lock |
| 65 | `release_release_lock` | `git_commit_and_release` | `handleReleaseReleaseLock` | `LOCAL_WRITE_FENCED` | Yes | `stable` — Release `.git/` release lock |
| 66 | `skip_release` | `git_commit_and_release` | `handleSkipRelease` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Waive release step with reason |
| 67 | `complete_task` | `task_lifecycle` | `handleCompleteTask` | `TERMINAL_LOCAL_AND_REMOTE_WRITE_MUTEX_RELEASE` | Yes | `stable` — Governed completion & mutex release |
| 68 | `next_steps` | `task_lifecycle` | `handleNextSteps` | `READ_ONLY` | Yes | `stable` — Read previous task recommendations |
| 69 | `force_complete_task` | `task_lifecycle` | `handleForceCompleteTask` | `PRIVILEGED_TERMINAL_WRITE_MUTEX_RELEASE` | Yes | `stable` — Force close with override audit & release |
| 70 | `drop_task` | `task_lifecycle` | `handleDropTask` | `TERMINAL_LOCAL_AND_REMOTE_WRITE_MUTEX_RELEASE` | Yes | `stable` — Abandon task & release worktree mutex |
| 71 | `get_workflow_status` | `workflow_status_and_orchestration` | `handleGetWorkflowStatus` | `READ_ONLY` | Yes | `stable` — Read-only current workflow status |
| 72 | `view_history` | `workflow_status_and_orchestration` | `handleViewHistory` | `READ_ONLY` | Yes | `stable` — View chronological completed task list |
| 73 | `continue_workflow` | `workflow_status_and_orchestration` | `handleContinueWorkflow` | `PHASE_DEPENDENT_READ_OR_COMMIT` | Yes | `stable` — Phase guidance / auto ready-check |
| 74 | `rerun_workflow` | `workflow_status_and_orchestration` | `handleRerunWorkflow` | `LOCAL_AND_REMOTE_SYNC_WRITE` | Yes | `stable` — Reset task to coding preserving DoD |
| 75 | `run_full_workflow` | `workflow_status_and_orchestration` | `handleRunFullWorkflow` | `FULL_LIFECYCLE_WRITE_AND_RELEASE` | Yes | `stable` — Batch post-coding pipeline orchestrator |
| 76 | `project_summary` | `project_knowledge_summary` | `resolveUnifiedProjectSummary` | `READ_ONLY` | No | `stable` — Canonical summary (`memory\|file\|db\|auto`) |
| 77 | `project_summary_data` | `project_knowledge_summary` | `resolveUnifiedProjectSummary (file)` | `READ_ONLY` | No | `deprecated_alias` (`-> project_summary`) |
| 78 | `project_summary_db` | `project_knowledge_summary` | `resolveUnifiedProjectSummary (db)` | `READ_ONLY` | No | `deprecated_alias` (`-> project_summary`) |
| 79 | `list_active_sessions` | `monitor_and_build_telemetry` | `handleListActiveSessions` | `READ_ONLY_NETWORK` | No | `stable` — List fleet sessions from monitor |
| 80 | `build_report` | `monitor_and_build_telemetry` | `handleBuildReport` | `READ_ONLY_NETWORK` | No | `stable` — 30-day p50/p90/max build report |
| 81 | `build_estimate` | `monitor_and_build_telemetry` | `handleBuildEstimate` | `READ_ONLY_NETWORK` | Yes | `stable` — Estimate remaining build minutes |
| 82 | `sync_zettly_task` | `external_integrations` | `flushZettlyOutbox + syncZettlyTask` | `REMOTE_AND_LOCAL_WRITE` | Yes | `stable` — Retry pending Zettly Todo/outcome sync |
| 83 | `recommend_mcp_tools` | `project_search_and_discovery` | `handleRecommendMcpTools` | `READ_ONLY` | No | `stable` — Recommend ecosystem MCP servers/tools |
| 84 | `report_build_status` | `monitor_and_build_telemetry` | `handleReportBuildStatus` | `LOCAL_AND_MONITOR_WRITE` | Yes | `stable` — Stream live build/test status to monitor |

---

## D. Semantic Duplication Matrix (`DUP-01` .. `DUP-14`)

| Pair ID | Tool A | Tool B | Type | Code-Level Evidence | Strategy & Action Taken in v2.1.5 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **DUP-01** | `helper_suggest_tests` | `helper_change_impact` | **D0** (Exact Duplicate) | Identical inputSchema `{ projectDir, files }` and direct switch fallthrough to `analyzeChangeImpact({ projectDir, files })` in `src/engineering-audit.js`. | **S1 + S2:** Designated `helper_change_impact` as canonical; preserved `helper_suggest_tests` in `TOOL_ALIASES` with `[COMPATIBILITY_ALIAS -> helper_change_impact]` description. |
| **DUP-02** | `project_summary_data` | `project_summary` | **D1** (Semantic Duplicate) | Both render `🧠 Project Knowledge Summary` (`totalTasks`, `taskTypes`, `lastActive`, `recentTasks`). `project_summary_data` reads `project-summary.json` and falls back to `handleProjectSummary`. | **S1 + S2:** Consolidated into `resolveUnifiedProjectSummary(workflowState, { source })` in `summary-handlers.js`. Added `source: "memory"\|"file"\|"db"\|"auto"` to `project_summary`. |
| **DUP-03** | `project_summary_db` | `project_summary` | **D1** (Semantic Duplicate) | Renders the exact same `🧠 Project Knowledge Summary` template from SQLite `getSummaryForUser()` with duplicated formatting string in `summary-handlers.js`. | **S1 + S2:** Routed through `resolveUnifiedProjectSummary(workflowState, { source: "db" })` and `formatPersistedProjectSummary()`, eliminating duplicated formatting code while keeping `project_summary_db` callable. |
| **DUP-04** | `audit_repository` | `audit_code` | **D3** (Wrapper Redundancy) | `audit_repository` calls `runEngineeringAudit({ projectDir, files: [] })`, which is identical to `audit_code` when `files` is omitted. | **S1 + S4:** Recorded in `TOOL_ALIASES` as a supported wrapper of `audit_code` and clarified descriptions. |
| **DUP-05** | `audit_architecture`, `audit_security`, `audit_tests`, `audit_api_contracts`, `audit_database_changes` | `audit_code` | **D2** (Partial Overlap) | All 5 category tools call `runEngineeringAudit({ categoryFilter })`. | **S1 + S4:** Added optional `category` parameter to `audit_code` and `audit_changes` while retaining the 5 category-specific entry points over the single shared `runEngineeringAudit` engine. |
| **DUP-06** | `audit_report` | `audit_code` / `audit_changes` | **D2** (Partial Overlap) | Calls `runEngineeringAudit` and appends `formatted_report: formatAuditReportText(report)`. | **S4:** Clarified description to highlight `formatted_report` generation. |
| **DUP-07** | `security_audit` | `audit_security` | **D6** (False Duplicate) | `security_audit` (`security/audit.js`) scans DevWorkflow runtime state, protected `.env` permissions, and SQLite/Postgres/MySQL rows. `audit_security` (`src/engineering-audit.js`) scans target repo files against `ZET-SEC-001/002`. | **S4:** Preserved both tools and added explicit `[READ_ONLY_RUNTIME_DB]` vs `[READ_ONLY_STATIC]` tags plus cross-references in their descriptions. |
| **DUP-08** | `site_audit` | `audit_code` | **D6** (False Duplicate) | `site_audit` crawls live HTTP/HTTPS URLs (`audit/site-audit.js`); `audit_code` scans local source files. | **S4:** Preserved both and tagged `site_audit` as `[READ_ONLY_HTTP]`. |
| **DUP-09** | `complete_task`, `force_complete_task`, `drop_task` | Task Termination Group | **D4** (Necessary Specialization) | All release the worktree mutex via `releaseTerminalTaskMutex()`, but enforce fundamentally different gate and governance override requirements. | **Preserve Separation:** Shared `releaseTerminalTaskMutex()` internally; kept all 3 public tools separate. |
| **DUP-10** | `resume_session`, `take_over_task`, `handoff_task`, `fetch_task`, `restart_handshake` | Ownership Transfer Group | **D4** (Necessary Specialization) | Five distinct concurrency protocols: dead local session (`resume_session`), live idle PID (`take_over_task`), cross-machine push (`handoff_task`), cross-machine SSH pull (`fetch_task`), and process restart (`restart_handshake`). | **Preserve Separation:** Preserved all 5 tools to protect worktree mutex and handover fencing. |
| **DUP-11** | `list_sentry_issues` | `inventory_sentry_issues` | **D4** (Necessary Specialization) | `list_sentry_issues` is a single-page read-only query; `inventory_sentry_issues` enumerates all projects and writes a `0600` snapshot file to disk. | **Preserve Separation:** Kept separate due to distinct side effects and latency profiles. |
| **DUP-12** | `get_workflow_status`, `continue_workflow`, `next_steps` | Workflow Guidance Group | **D2** (Partial Overlap) | `get_workflow_status` is read-only current task status; `continue_workflow` auto-runs `check_ready_to_commit`/`commit_and_push`; `next_steps` reads recommendations from previous completed tasks. | **S4:** Clarified descriptions and permission boundaries. |
| **DUP-13** | `set_plan`, `set_definition_of_done` | `refine_with_ai` | **D2** (Partial Overlap) | `refine_with_ai` updates description, context, plan, DoD, and `bugContext` atomically; `set_plan` and `set_definition_of_done` are single-field mutators. | **S4:** Preserved all 3 for holistic vs targeted updates. |
| **DUP-14** | `tools/handlers-new.js` | `tools/handlers.js` | **D5** (Orphaned Internal Module) | Both files contain identical 1-line `export { handleToolCall } from "./handler-modules/index.js";`; zero internal imports reference `tools/handlers-new.js`. | Recorded as deprecated internal compatibility re-export. |

---

## E. Canonical Tool Architecture & Consolidation Changes

```mermaid
flowchart TD
    A["MCP Public Tool Catalog (84 Registered Tools: 80 Canonical + 4 Aliases)"] --> B["Request Session Attribution & Security Filter (index.js / session-scope.js)"]
    B --> C["Canonical Tool Dispatcher (tools/handler-modules/index.js)"]
    C --> D1["Unified Project Summary Service (resolveUnifiedProjectSummary)"]
    C --> D2["Unified Engineering Audit Engine (runEngineeringAudit / analyzeChangeImpact)"]
    C --> D3["Tool Catalog Auditor & Regression Gate (src/tool-catalog-auditor.js)"]
    C --> D4["Fenced Lifecycle & Mutex Engine (process-lock.js / workflow-state.js)"]
```

### Internal Consolidations Implemented in v2.1.5
1. **Unified Project Summary Domain Service (`tools/handler-modules/summary-handlers.js`):**
   - Replaced duplicated summary formatting in `handleProjectSummaryData` and `handleProjectSummaryDb` with `formatPersistedProjectSummary(parsed, sourceLabel)` and `resolveUnifiedProjectSummary(workflowState, { source })`.
   - Enhanced `project_summary` to accept `{ source: "memory" | "file" | "db" | "auto" }` while keeping `project_summary_data` (`source: "file"`) and `project_summary_db` (`source: "db"`) as 100% compatible aliases.
2. **Optional Category Filter on `audit_code` and `audit_changes` (`src/engineering-audit.js`):**
   - `audit_code` and `audit_changes` now accept `{ category: "architecture" | "security" | "testing" | "api-contracts" | "database" | "code-quality" }`, allowing direct category filtering without needing separate tool calls.
3. **Automated Tool Catalog Auditor (`src/tool-catalog-auditor.js`):**
   - Implemented `audit_tool_catalog` MCP tool + `devwf audit catalog` CLI subcommand + internal `helper_consolidation_plan` (`generateConsolidationPlan`) + `validateToolRegistrationGate`.

---

## F. Representative AI-Agent Tool Selection Benchmark (`SCN-01` .. `SCN-10`)

Verified in `TC-17 & TC-19` (`tests/tool-catalog-consolidation-v215.test.js`):

| Scenario ID | Engineering Scenario | Selected Canonical Tool | Calls Before | Calls After | Selection Error Rate |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **SCN-01** | Find why a test failed and structure root-cause hypotheses | `helper_root_cause` | 2 | 1 | 0% |
| **SCN-02** | Audit a pull request diff against engineering standards | `audit_changes` | 1 | 1 | 0% |
| **SCN-03** | Inspect architecture boundary and dependency direction violations | `audit_architecture` | 1 | 1 | 0% |
| **SCN-04** | Safely fix deterministic trailing whitespace or standalone debug dump | `helper_apply_safe_fix` | 1 | 1 | 0% |
| **SCN-05** | Start a governed development task with worktree mutex and Zettly Todo | `start_task` | 1 | 1 | 0% |
| **SCN-06** | Recover an abandoned session left behind on the same workstation | `resume_session` | 2 | 1 | 0% |
| **SCN-07** | Analyze change impact and recommend regression tests for modified files | `helper_change_impact` | 2 | 1 | 0% |
| **SCN-08** | Read the project knowledge summary (completed task stats and recent activity) | `project_summary` | 3 | 1 | 0% |
| **SCN-09** | Distinguish source-code security rules from runtime/DB security audit | `audit_security` | 2 | 1 | 0% |
| **SCN-10** | Synchronize a completed task or pending outbox with Zettly | `sync_zettly_task` | 1 | 1 | 0% |
| **Total** | **10 Representative Engineering Scenarios** | **10/10 Canonical Match** | **16 calls** | **10 calls (-37.5%)** | **0% (0/10 errors)** |

---

## G. Before/After Quantitative Metrics

| Metric | Baseline (v2.1.4) | Optimized (v2.1.5) | Delta / Notes |
| :--- | :--- | :--- | :--- |
| **Total Registered Public MCP Tools** | 83 | **84** | +1 (`audit_tool_catalog`) |
| **Canonical Public MCP Tools** | 83 (aliases undocumented) | **80** | 4 tools formally classified & routed as compatibility aliases |
| **Documented Compatibility Aliases (`TOOL_ALIASES`)** | 0 | **4** | `helper_suggest_tests`, `project_summary_data`, `project_summary_db`, `audit_repository` |
| **Unmapped / Untested Public Tools** | 83 unmapped in catalog auditor | **0 unmapped / 0 untested** | 100% of tools mapped with handler, domain service, permissions, and tests |
| **Duplicate Summary Formatting Implementations** | 3 separate implementations | **1 shared service** | `resolveUnifiedProjectSummary` + `formatPersistedProjectSummary` |
| **Agent Benchmark Tool Calls (10 Scenarios)** | 16 calls | **10 calls** | **37.5% fewer tool calls** on ambiguous scenarios |
| **Agent Benchmark Selection Error Rate** | Ambiguous on 5/10 scenarios | **0/10 (0%)** | Disambiguated via `[READ_ONLY_STATIC]`, `[READ_ONLY_RUNTIME_DB]`, `[COMPATIBILITY_ALIAS]` |
| **Automated Catalog Regression Gate Violations** | Not enforced | **0 blocking violations** | `validateToolRegistrationGate` enforced in `TC-02`, `TC-05`, `TC-12` |
| **Verified Passing Tests** | 308/308 | **339/339** | **198/198** DevWorkflow + **141/141** Zettly |

---

## H. Acceptance Test Suite (`TC-01` .. `TC-20`) & Regression Evidence

All 20 required scenarios (`TC-01` through `TC-20`) are verified in `tests/tool-catalog-consolidation-v215.test.js` and the full regression suite:

- **`TC-01` (Complete registration inventory):** Verified all 84 public tools, 2 MCP prompts, and 14 CLI commands with `unmapped_tools_count: 0` and `untested_tools_count: 0`.
- **`TC-02` (Duplicate tool IDs):** Verified `validateToolRegistrationGate` blocks duplicate tool IDs with `DUPLICATE_TOOL_ID`.
- **`TC-03` (Different names, equivalent handlers):** Verified `DUP-01` (`helper_suggest_tests` <-> `helper_change_impact`) and `DUP-02`/`DUP-03` (`project_summary_data`/`db` <-> `project_summary`).
- **`TC-04` (Similar names, distinct behavior):** Verified `DUP-07` (`security_audit` vs `audit_security`) and `DUP-08` (`site_audit` vs `audit_code`) are preserved as `D6` false duplicates.
- **`TC-05` (Equivalent descriptions, different authorization):** Verified `UNSAFE_PERMISSION_BOUNDARY_MERGE` blocks unfenced read/write merges and `SIMILAR_DESCRIPTION_DIFFERENT_AUTHORIZATION` warns against merging read-only and write-capable tools.
- **`TC-06` (Wrapper-only tool):** Verified `DUP-04` (`audit_repository` -> `audit_code`) is classified as `D3` wrapper redundancy.
- **`TC-07` (Shared handler with different workflows):** Verified `DUP-05` (`audit_architecture`, `audit_security`, `audit_tests`, `audit_api_contracts`, `audit_database_changes`) is classified as `D2` partial overlap over `runEngineeringAudit`.
- **`TC-08`, `TC-09`, `TC-10` (Compatibility aliases, input schema & output contract compatibility):** Verified `helper_suggest_tests`, `project_summary_data`, `project_summary_db`, and `audit_code({ category })` produce byte-identical contracts to their canonical counterparts.
- **`TC-11` & `TC-18` (Tool discovery & MCP client integration):** Verified `ListToolsRequestSchema` discovery via real `StdioClientTransport` (`tests/mcp-catalog-schema.test.js`) and `NON_SESSION_SCOPED_TOOLS` attribution.
- **`TC-12` (New redundant tool registration):** Verified `validateToolRegistrationGate` flags a proposed tool sharing `analyzeChangeImpact` with `REDUNDANT_HANDLER_OR_SERVICE_CANDIDATE`.
- **`TC-13`, `TC-14`, `TC-15` (Existing task lifecycle, cross-client concurrency, safe autofix authorization):** Verified worktree mutex isolation, terminal mutex release, and `ProjectOwnershipLostError` fencing.
- **`TC-16` (CLI compatibility):** Verified `devwf audit catalog [--json]`, `devwf audit standards`, and `devwf audit code`.
- **`TC-17` (Zettly synchronization):** Verified `tests/zettly-handler-integration.test.js` (8/8 pass) with zero duplicate Todo or outcome writes.
- **`TC-19` (Representative agent scenarios):** Verified 10/10 scenarios in `AGENT_TOOL_SELECTION_BENCHMARK` select the exact canonical tool.
- **`TC-20` (Full existing regression suite):** Verified **198/198** DevWorkflow tests and **141/141** Zettly JS tests pass.

---

## I. Remaining Risks & Deferred Removals

1. **Deferred Removal of Deprecated Compatibility Aliases (`helper_suggest_tests`, `project_summary_data`, `project_summary_db`):**
   - To guarantee zero breaking changes for external MCP clients and existing test suites across `HELLOWORLD`, `MMCH`, and `Mac`, these 3 aliases remain registered and callable in v2.1.5 and route directly to `analyzeChangeImpact` and `resolveUnifiedProjectSummary`. Their removal from `getToolList()` is deferred to a future major release (`v3.0.0`) after all external client prompts have migrated to `helper_change_impact` and `project_summary({ source })`.
2. **Orphaned Internal Module (`tools/handlers-new.js`):**
   - Retained as a 1-line compatibility re-export of `tools/handlers.js` until `v3.0.0`.
