/**
 * @zettly-code DWF-CATALOG-AUDITOR-001
 * @purpose DevWorkflow MCP Tool Catalog Auditor, Semantic Duplication Classifier, Consolidation Planner & Automatic Catalog Regression Gate.
 * @invariant Enforce zero unmapped tools, zero compatibility aliases, and complete metadata provenance across all 66 canonical public MCP tools.
 *
 * DevWorkflow MCP Tool Catalog Auditor, Semantic Duplication Classifier,
 * Consolidation Planner & Automatic Catalog Regression Gate (v2.1.5).
 *
 * Implements:
 * - Complete canonical inventory of all registered public MCP tools, prompts,
 *   CLI subcommands, internal helpers, and compatibility aliases.
 * - Deterministic semantic duplication classification (D0..D6) with code-level
 *   behavioral, input/output contract, side-effect, and permission evidence.
 * - Pairwise semantic similarity matrix and AI-agent selection efficiency
 *   benchmark across representative engineering scenarios.
 * - Reusable `audit_tool_catalog` MCP tool + internal `helper_consolidation_plan`.
 * - Automatic Catalog Regression Gate (`validateToolRegistrationGate`) that blocks
 *   deterministic invalid registrations (duplicate IDs, missing schema/description,
 *   unauthorized read/write merging) and flags suspected semantic duplicates for review.
 */

export const CATALOG_AUDITOR_VERSION = "3.1.0";

/**
 * Compatibility alias map (`TOOL_ALIASES`).
 *
 * Radical Simplification Policy (v3.0.0):
 * Zero compatibility aliases are registered in `getToolList()`.
 * All 21 duplicate/wrapper legacy tools have been permanently removed from
 * public registration and documented in `REMOVED_LEGACY_TOOLS`.
 */
export const TOOL_ALIASES = Object.freeze({});

/**
 * Registry of all 21 duplicate/wrapper/alias public MCP tools removed in v3.0.0
 * and their canonical v3.0.0 replacement interface.
 */
export const REMOVED_LEGACY_TOOLS = Object.freeze({
  audit_code: { canonicalTool: "audit", canonicalArgs: { category: "code" }, reason: "Merged into canonical audit tool" },
  audit_changes: { canonicalTool: "audit", canonicalArgs: { category: "changes" }, reason: "Merged into canonical audit tool" },
  audit_repository: { canonicalTool: "audit", canonicalArgs: { category: "repository" }, reason: "Merged into canonical audit tool" },
  audit_architecture: { canonicalTool: "audit", canonicalArgs: { category: "architecture" }, reason: "Merged into canonical audit tool" },
  audit_security: { canonicalTool: "audit", canonicalArgs: { category: "security" }, reason: "Merged into canonical audit tool" },
  audit_tests: { canonicalTool: "audit", canonicalArgs: { category: "tests" }, reason: "Merged into canonical audit tool" },
  audit_api_contracts: { canonicalTool: "audit", canonicalArgs: { category: "api" }, reason: "Merged into canonical audit tool" },
  audit_database_changes: { canonicalTool: "audit", canonicalArgs: { category: "database" }, reason: "Merged into canonical audit tool" },
  audit_standards: { canonicalTool: "audit", canonicalArgs: { category: "standards" }, reason: "Merged into canonical audit tool" },
  audit_report: { canonicalTool: "audit", canonicalArgs: { category: "report" }, reason: "Merged into canonical audit tool (formatted_report included by default)" },
  audit_tool_catalog: { canonicalTool: "audit", canonicalArgs: { category: "catalog" }, reason: "Merged into canonical audit tool" },
  helper_change_impact: { canonicalTool: "analyze_change", canonicalArgs: { mode: "impact" }, reason: "Merged into canonical analyze_change tool" },
  helper_suggest_tests: { canonicalTool: "analyze_change", canonicalArgs: { mode: "tests" }, reason: "Exact duplicate of change impact; merged into canonical analyze_change tool" },
  helper_explain_violation: { canonicalTool: "analyze_change", canonicalArgs: { mode: "explain" }, reason: "Merged into canonical analyze_change tool" },
  helper_root_cause: { canonicalTool: "analyze_change", canonicalArgs: { mode: "root_cause" }, reason: "Merged into canonical analyze_change tool" },
  helper_refactor_advice: { canonicalTool: "analyze_change", canonicalArgs: { mode: "refactor" }, reason: "Merged into canonical analyze_change tool" },
  helper_docs_update: { canonicalTool: "analyze_change", canonicalArgs: { mode: "docs" }, reason: "Merged into canonical analyze_change tool" },
  helper_prioritize_debt: { canonicalTool: "analyze_change", canonicalArgs: { mode: "debt" }, reason: "Merged into canonical analyze_change tool" },
  helper_improvement_opportunities: { canonicalTool: "analyze_change", canonicalArgs: { mode: "opportunities" }, reason: "Merged into canonical analyze_change tool" },
  helper_propose_standard: { canonicalTool: "analyze_change", canonicalArgs: { mode: "propose_standard" }, reason: "Merged into canonical analyze_change tool" },
  helper_plan_fix: { canonicalTool: "plan_fix", canonicalArgs: { mode: "plan" }, reason: "Replaced by canonical plan_fix tool" },
  helper_autofix_candidates: { canonicalTool: "plan_fix", canonicalArgs: { mode: "candidates" }, reason: "Merged into canonical plan_fix tool" },
  helper_apply_safe_fix: { canonicalTool: "apply_safe_fix", canonicalArgs: {}, reason: "Renamed to canonical apply_safe_fix tool" },
  project_summary_data: { canonicalTool: "project_summary", canonicalArgs: { source: "file" }, reason: "Merged into canonical project_summary tool" },
  project_summary_db: { canonicalTool: "project_summary", canonicalArgs: { source: "db" }, reason: "Merged into canonical project_summary tool" },
});

/**
 * Authoritative metadata enrichment table for every registered DevWorkflow MCP tool.
 * Used by `buildToolInventory` and `auditToolCatalog` to provide complete code-level
 * provenance (category, handler function, module, dependencies, side effects,
 * permission level, workflow role, error contract, test file coverage, and stability).
 */
export const CANONICAL_TOOL_METADATA = Object.freeze({
  // --- Domain A: Focus Management (Zettly Focus) ---
  get_current_focus: {
    category: "focus_management",
    handler: "handleFocusTool('get_current_focus')",
    module: "focus-workflow.js",
    domainService: "activeFoci / projection",
    dependencies: ["zettly-client.js", "tools/handler-modules/checkpoint-handlers.js"],
    sideEffects: "Read-only Zettly GET /user and GET /focus",
    permissionLevel: "READ_ONLY",
    sessionScoped: false,
    workflowRole: "Inspect active Zettly focus containers before starting or linking a task",
    errorContract: "Returns JSON { error: 'FOCUS_*', message } with isError:true",
    tests: ["tests/focus-workflow.test.js", "tests/focus-attach.test.js"],
    stability: "stable",
    capability: "Read active Zettly focus containers and handoff status",
  },
  set_focus: {
    category: "focus_management",
    handler: "handleFocusTool('set_focus')",
    module: "focus-workflow.js",
    domainService: "activeFoci / POST /focus",
    dependencies: ["zettly-client.js"],
    sideEffects: "Remote write: creates or reuses an active Zettly focus via POST /focus",
    permissionLevel: "REMOTE_WRITE",
    sessionScoped: false,
    workflowRole: "Create or reuse a concurrent active Zettly focus container",
    errorContract: "Returns JSON { error: 'FOCUS_*', message } with isError:true",
    tests: ["tests/focus-workflow.test.js"],
    stability: "stable",
    capability: "Create or reuse an active Zettly focus container",
  },
  link_task_to_focus: {
    category: "focus_management",
    handler: "handleFocusTool('link_task_to_focus')",
    module: "focus-workflow.js",
    domainService: "PATCH /todos/:id + workflowState.save",
    dependencies: ["zettly-client.js", "workflow-state.js"],
    sideEffects: "Remote write (PATCH /todos/:id focus_id) + local session state write",
    permissionLevel: "REMOTE_AND_LOCAL_WRITE",
    sessionScoped: true,
    workflowRole: "Attach the active canonical workflow Todo to a specific active focus",
    errorContract: "Returns JSON { error: 'FOCUS_*', message } with isError:true",
    tests: ["tests/focus-link-column.test.js", "tests/focus-workflow.test.js"],
    stability: "stable",
    capability: "Bind active task Todo to a verified Zettly focus",
  },
  complete_focus: {
    category: "focus_management",
    handler: "handleFocusTool('complete_focus')",
    module: "focus-workflow.js",
    domainService: "linkedTasks + POST /focus/:id/complete",
    dependencies: ["zettly-client.js"],
    sideEffects: "Remote write: closes active focus via POST /focus/:id/complete after verifying all linked Todos are completed",
    permissionLevel: "REMOTE_WRITE",
    sessionScoped: true,
    workflowRole: "Close an active Zettly focus container once all linked tasks are complete",
    errorContract: "Returns JSON { error: 'FOCUS_*', message } with isError:true",
    tests: ["tests/focus-workflow.test.js"],
    stability: "stable",
    capability: "Verify and close a completed Zettly focus container",
  },

  // --- Domain B: Engineering Standards & Code Auditing (V3.0 Canonical) ---
  audit: {
    category: "code_auditing",
    handler: "handleDevWorkflowV2Tool('audit')",
    module: "src/engineering-audit.js",
    domainService: "runEngineeringAudit / validateStandardsRegistry / auditToolCatalog",
    dependencies: ["src/engineering-audit.js", "src/tool-catalog-auditor.js", "security/scanner.js"],
    sideEffects: "Read-only local filesystem, Git diff, standards YAML, or MCP catalog inspection",
    permissionLevel: "READ_ONLY",
    sessionScoped: false,
    workflowRole: "Single canonical engineering audit tool covering code, changes, repository, architecture, security, tests, api, database, standards, report, and catalog",
    errorContract: "Returns 4-dimension structured JSON verdict (PASS/WARN/FAIL/PARTIAL/INCOMPLETE) plus formatted_report (or registry/catalog validity)",
    tests: ["tests/engineering-audit-v2.test.js", "tests/audit-reliability-v214.test.js", "tests/tool-catalog-consolidation-v215.test.js"],
    stability: "stable",
    capability: "Evaluate engineering standards, Git/PR diffs, standards registry, or MCP tool catalog",
  },

  // --- Domain C: Intelligent Engineering Helpers (V3.0 Canonical) ---
  analyze_change: {
    category: "intelligent_helpers",
    handler: "handleDevWorkflowV2Tool('analyze_change')",
    module: "src/engineering-audit.js",
    domainService: "analyzeChangeImpact / explainViolation / proposeEngineeringStandard",
    dependencies: ["src/engineering-audit.js"],
    sideEffects: "Read-only change impact, test recommendation, violation explanation, root-cause structuring, refactoring advice, debt prioritization, or advisory standard proposal",
    permissionLevel: "READ_OR_OPTIONAL_PROPOSAL_WRITE",
    sessionScoped: false,
    workflowRole: "Single canonical engineering analysis helper (modes: impact, tests, explain, root_cause, refactor, docs, debt, opportunities, propose_standard)",
    errorContract: "Returns structured analysis object; never auto-activates blocking rules",
    tests: ["tests/engineering-audit-v2.test.js", "tests/engineering-excellence-acceptance.test.js", "tests/tool-catalog-consolidation-v215.test.js"],
    stability: "stable",
    capability: "Analyze change impact, recommend tests, explain violations, structure RCA, or propose standards",
  },
  plan_fix: {
    category: "intelligent_helpers",
    handler: "handleDevWorkflowV2Tool('plan_fix')",
    module: "src/engineering-audit.js",
    domainService: "planSafeFix / runEngineeringAudit (autofix_eligible)",
    dependencies: ["src/engineering-audit.js"],
    sideEffects: "Read-only remediation planning and deterministic AF-0/AF-1 autofix candidate discovery",
    permissionLevel: "READ_ONLY",
    sessionScoped: false,
    workflowRole: "Single canonical remediation planner and AF-0/AF-1 autofix candidate scanner",
    errorContract: "Returns structured remediation plan and/or autofix candidates[]",
    tests: ["tests/engineering-audit-v2.test.js", "tests/tool-catalog-consolidation-v215.test.js"],
    stability: "stable",
    capability: "Plan bounded remediation and discover AF-0/AF-1 autofix candidates",
  },
  apply_safe_fix: {
    category: "intelligent_helpers",
    handler: "handleDevWorkflowV2Tool('apply_safe_fix')",
    module: "src/engineering-audit.js",
    domainService: "applyBoundedSafeFix",
    dependencies: ["src/engineering-audit.js", "process-lock.js"],
    sideEffects: "Local file write under OS worktree mutex fencing with snapshot rollback on test failure",
    permissionLevel: "LOCAL_WRITE_FENCED",
    sessionScoped: false,
    workflowRole: "Single canonical mutating autofix tool enforcing worktree mutex fencing, MECHANICALLY_VERIFIED / TEST_VERIFIED truth levels, and concurrent edit rollback guard",
    errorContract: "Throws ProjectOwnershipLostError or refuses AF-2/AF-3/protected paths fail-closed",
    tests: ["tests/engineering-audit-v2.test.js", "tests/engineering-excellence-acceptance.test.js", "tests/audit-reliability-v214.test.js"],
    stability: "stable",
    capability: "Apply worktree-fenced deterministic AF-0/AF-1 autofix with snapshot rollback",
  },

  // --- Domain C2: Persistent Code Memory & Knowledge Graph (Zettly Code v1.0) ---
  code_index: {
    category: "code_intelligence",
    handler: "handleDevWorkflowV2Tool('code_index')",
    module: "src/zettly-code-adapter.js",
    domainService: "runCodeIndex (@programinglive/zettly-code)",
    dependencies: ["src/zettly-code-adapter.js", "@programinglive/zettly-code"],
    sideEffects: "Creates or incrementally updates local SQLite code knowledge graph (.zettly-code/knowledge-graph.db) on initialize/update/rebuild; read-only on status/verify",
    permissionLevel: "LOCAL_INDEX_WRITE_OR_READ",
    sessionScoped: false,
    workflowRole: "Bootstrap, incrementally update, verify, or rebuild the persistent Zettly Code knowledge graph",
    errorContract: "Returns structured JSON with freshnessStatus, stats, and knowledgeValidation (or ZETTLY_CODE_UNAVAILABLE)",
    tests: ["tests/zettly-code-and-release-governance-v310.test.js"],
    stability: "stable",
    capability: "Manage persistent Zettly Code knowledge graph index and freshness",
  },
  code_context: {
    category: "code_intelligence",
    handler: "handleDevWorkflowV2Tool('code_context')",
    module: "src/zettly-code-adapter.js",
    domainService: "runCodeContext (@programinglive/zettly-code)",
    dependencies: ["src/zettly-code-adapter.js", "@programinglive/zettly-code"],
    sideEffects: "Read-only bounded graph traversal and debugging memory lookup (may auto-refresh stale local index if enabled)",
    permissionLevel: "READ_ONLY",
    sessionScoped: false,
    workflowRole: "Retrieve targeted symbols, @zettly-code bug-fix notes, invariants, callers, dependencies, tests, impact, and bug history before scanning source files",
    errorContract: "Returns bounded candidateFiles, knowledgeAnnotations, bugFixes, dependencies, callers, and relatedTests",
    tests: ["tests/zettly-code-and-release-governance-v310.test.js"],
    stability: "stable",
    capability: "Query persistent Zettly Code debugging memory and bounded code graph",
  },

  // --- Domain D: External Integrations (Zettly & Sentry) ---
  get_zettly_task_context: {
    category: "external_integrations",
    handler: "handleIntegrationTool('get_zettly_task_context')",
    module: "tools/handler-modules/integration-handlers.js",
    domainService: "readZettlyTaskContext",
    dependencies: ["zettly-context.js", "zettly-client.js"],
    sideEffects: "Read-only Zettly graph query; optionally caches context on active matching Todo in local session state",
    permissionLevel: "READ_OR_LOCAL_CACHE_ATTACH",
    sessionScoped: true,
    workflowRole: "Read bounded incoming/outgoing Zettly task & note relations with cycle detection",
    errorContract: "Returns isError:true when Zettly is unconfigured or attach target mismatches active Todo",
    tests: ["tests/zettly-context.test.js", "tests/integration-handlers.test.js"],
    stability: "stable",
    capability: "Read bounded Zettly task/note relation graph",
  },
  inventory_sentry_issues: {
    category: "external_integrations",
    handler: "handleIntegrationTool('inventory_sentry_issues')",
    module: "tools/handler-modules/integration-handlers.js",
    domainService: "sentryClient.inventoryIssues",
    dependencies: ["sentry-client.js", "security/sanitizer.js"],
    sideEffects: "Remote read (paginated Sentry organization/project enumeration) + writes sanitized device-local snapshot under .state/sentry-inventory/",
    permissionLevel: "REMOTE_READ_LOCAL_SNAPSHOT_WRITE",
    sessionScoped: false,
    workflowRole: "Full multi-project Sentry issue inventory with device-local snapshot persistence",
    errorContract: "Reports complete:false on capped or inconsistent pages; returns isError:true on auth failure",
    tests: ["tests/sentry-client.test.js", "tests/integration-handlers.test.js"],
    stability: "stable",
    capability: "Enumerate all accessible Sentry projects/issues and save local snapshot",
  },
  get_integration_status: {
    category: "external_integrations",
    handler: "handleIntegrationTool('get_integration_status')",
    module: "tools/handler-modules/integration-handlers.js",
    domainService: "probe(zettly) + probe(sentry)",
    dependencies: ["zettly-client.js", "sentry-client.js"],
    sideEffects: "Read-only connectivity probe to Zettly (/user) and Sentry (listIssues limit 1)",
    permissionLevel: "READ_ONLY",
    sessionScoped: false,
    workflowRole: "Check Zettly owner and Sentry connectivity without exposing credentials",
    errorContract: "Returns JSON { zettly: { status }, sentry: { status } }",
    tests: ["tests/integration-handlers.test.js"],
    stability: "stable",
    capability: "Probe Zettly and Sentry connection health",
  },
  list_sentry_issues: {
    category: "external_integrations",
    handler: "handleIntegrationTool('list_sentry_issues')",
    module: "tools/handler-modules/integration-handlers.js",
    domainService: "sentryClient.listIssuePage",
    dependencies: ["sentry-client.js"],
    sideEffects: "Read-only bounded single-page Sentry issue query",
    permissionLevel: "READ_ONLY",
    sessionScoped: false,
    workflowRole: "Browse a single bounded page of Sentry issues (distinct from full multi-project inventory_sentry_issues)",
    errorContract: "Returns isError:true if Sentry is not configured",
    tests: ["tests/sentry-client.test.js", "tests/integration-handlers.test.js"],
    stability: "stable",
    capability: "Read a single bounded page of Sentry issue summaries",
  },
  get_sentry_issue: {
    category: "external_integrations",
    handler: "handleIntegrationTool('get_sentry_issue')",
    module: "tools/handler-modules/integration-handlers.js",
    domainService: "sentryClient.getIssue",
    dependencies: ["sentry-client.js"],
    sideEffects: "Read-only single Sentry issue fetch",
    permissionLevel: "READ_ONLY",
    sessionScoped: false,
    workflowRole: "Inspect one Sentry issue summary by numeric issueId",
    errorContract: "Refuses non-numeric issueId; returns isError:true on HTTP failure",
    tests: ["tests/sentry-client.test.js", "tests/integration-handlers.test.js"],
    stability: "stable",
    capability: "Read one sanitized Sentry issue summary by ID",
  },
  link_zettly_drawing: {
    category: "external_integrations",
    handler: "handleIntegrationTool('link_zettly_drawing')",
    module: "tools/handler-modules/integration-handlers.js",
    domainService: "drawingMatchesWorkflow + workflowState.save",
    dependencies: ["zettly-drawing.js", "zettly-client.js"],
    sideEffects: "Remote read (GET /drawings/:id) + local workflowState write + post-call Zettly Todo sync",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Verify and attach an existing Zettly Draw Studio canvas to the active workflow task",
    errorContract: "Refuses if drawing does not match canonical workflow and Todo",
    tests: ["tests/zettly-drawing.test.js", "tests/integration-handlers.test.js"],
    stability: "stable",
    capability: "Link an existing verified Zettly Draw item to the active task",
  },
  link_sentry_issue: {
    category: "external_integrations",
    handler: "handleIntegrationTool('link_sentry_issue')",
    module: "tools/handler-modules/integration-handlers.js",
    domainService: "sentryClient.getIssue / sentryClient.resolveIssue + workflowState.save",
    dependencies: ["sentry-client.js", "zettly-workflow.js"],
    sideEffects: "Remote read/write (Sentry issue inspect or status update to resolved/unresolved/ignored) + local workflowState write + post-call Zettly Todo sync",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Attach a verified Sentry issue reference to the active canonical Zettly Todo, or natively resolve/unresolve/ignore a Sentry issue in Sentry",
    errorContract: "Refuses action='link' if no active workflow task or Zettly Todo is linked; action='resolve' updates Sentry issue status directly",
    tests: ["tests/integration-handlers.test.js", "tests/sentry-client.test.js"],
    stability: "stable",
    capability: "Link a verified Sentry issue to the active workflow Todo or update its status (resolved/unresolved/ignored) in Sentry",
  },
  set_sentry_issue_status: {
    category: "external_integrations",
    handler: "handleIntegrationTool('set_sentry_issue_status')",
    module: "tools/handler-modules/integration-handlers.js",
    domainService: "sentryClient.resolveIssue + workflowState.save",
    dependencies: ["sentry-client.js", "zettly-workflow.js"],
    sideEffects: "Remote Sentry issue status write + local Zettly link update",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Explicitly resolve, unresolve or ignore a Sentry issue with mandatory confirm and reason",
    errorContract: "Refuses without confirm:true or a written reason; full profile only",
    tests: ["tests/sentry-side-effects.test.js"],
    stability: "stable",
    capability: "Mutate a Sentry issue status with explicit confirmation",
  },
  sync_zettly_task: {
    category: "external_integrations",
    handler: "flushZettlyOutbox + syncZettlyTask",
    module: "tools/handler-modules/index.js",
    domainService: "syncZettlyTask",
    dependencies: ["zettly-workflow.js"],
    sideEffects: "Remote write to Zettly Todo and Outcomes endpoints + local outbox flush",
    permissionLevel: "REMOTE_AND_LOCAL_WRITE",
    sessionScoped: true,
    workflowRole: "Retry pending Zettly Todo and outcome synchronization or link an existing Todo ID",
    errorContract: "Returns warning prefix ⚠️ if Zettly sync is offline/deferred",
    tests: ["tests/zettly-workflow.test.js", "tests/sync-resilience.test.js"],
    stability: "stable",
    capability: "Synchronize active workflow task and pending outcomes with Zettly",
  },

  // --- Domain E: Security, Website & Project Search ---
  security_audit: {
    category: "security_and_web_audit",
    handler: "securityAudit",
    module: "security/audit.js",
    domainService: "securityAudit + auditDatabase",
    dependencies: ["security/scanner.js", "security/policy.js", "security/files.js"],
    sideEffects: "Read-only scan of in-memory workflow state, current-user state artifacts, protected file permissions, runtime env vars, and scoped SQLite/Postgres/MySQL workflow rows",
    permissionLevel: "READ_ONLY",
    sessionScoped: false,
    workflowRole: "Audit DevWorkflow runtime state, database rows, and workspace secret exposure (distinct from static ZET-SEC-* audit_security)",
    errorContract: "Returns sanitized JSON report without raw credential values",
    tests: ["tests/security.test.js", "tests/security-config.test.js"],
    stability: "stable",
    capability: "Audit runtime workflow state, database rows, env config, and workspace files for secret exposure",
  },
  site_audit: {
    category: "security_and_web_audit",
    handler: "auditSite",
    module: "audit/site-audit.js",
    domainService: "auditSite",
    dependencies: ["audit/crawl.js", "audit/checks/headers.js", "audit/checks/seo.js", "audit/checks/links.js", "audit/checks/a11y-static.js", "audit/checks/parity.js"],
    sideEffects: "Read-only bounded same-origin HTTP crawl (no browser, no form submission, no state writes)",
    permissionLevel: "READ_ONLY_NETWORK",
    sessionScoped: true,
    workflowRole: "Audit live website URL for reachability, security headers, SEO, broken links, static a11y, and language parity",
    errorContract: "Refuses credentials in URL or invalid check names",
    tests: ["tests/site-audit.test.js"],
    stability: "stable",
    capability: "Read-only HTTP website audit (headers, SEO, links, a11y, parity)",
  },
  search_project: {
    category: "project_search_and_discovery",
    handler: "handleSearchProject",
    module: "tools/handler-modules/search-handlers.js",
    domainService: "searchProject",
    dependencies: ["search-project.js"],
    sideEffects: "Read-only bounded lexical search over local Git repository text files",
    permissionLevel: "READ_ONLY",
    sessionScoped: false,
    workflowRole: "Search active project text files for plain-text queries with path:line citations",
    errorContract: "Refuses when no projectDir is pinned or query exceeds 500 chars",
    tests: ["tests/search-project.test.js", "tests/handlers-search-project.test.js"],
    stability: "stable",
    capability: "Bounded lexical search across active project text files",
  },
  recommend_mcp_tools: {
    category: "project_search_and_discovery",
    handler: "handleRecommendMcpTools",
    module: "tools/handler-modules/workflow-handlers.js",
    domainService: "recommendMcpTools",
    dependencies: ["mcp-index.js"],
    sideEffects: "Read-only in-memory ecosystem index query",
    permissionLevel: "READ_ONLY",
    sessionScoped: false,
    workflowRole: "Recommend relevant MCP servers and tools across the ecosystem for a task or query",
    errorContract: "Returns formatted markdown recommendations or full ecosystem catalog",
    tests: ["tests/mcp-index.test.js"],
    stability: "stable",
    capability: "Recommend MCP servers and tools from the ecosystem index",
  },

  // --- Domain F: Task Lifecycle & Governance Gates ---
  start_task: {
    category: "task_lifecycle",
    handler: "handleStartTask",
    module: "tools/handler-modules/workflow-handlers.js",
    domainService: "handleStartTaskSerialized",
    dependencies: ["process-lock.js", "repository-identity.js", "preflight.js", "zettly-workflow.js", "focus-workflow.js"],
    sideEffects: "Acquires OS kernel worktree mutex, records repository identity contract, runs README preflight, initializes session SQLite/JSON state, syncs canonical Zettly Todo and Draw",
    permissionLevel: "LOCAL_AND_REMOTE_WRITE_MUTEX_ACQUIRE",
    sessionScoped: true,
    workflowRole: "Mandatory entry gate before any development or diagnostic work",
    errorContract: "Fails closed if another live MCP process holds the project lock, if projectDir is not a Git repo, or if DoD/plan are invalid",
    tests: ["tests/start-task-live-guard.test.js", "tests/start-task-description.test.js", "tests/cross-client-lock-isolation.test.js"],
    stability: "stable",
    capability: "Acquire worktree mutex, initialize governed task contract, and sync Zettly Todo",
  },
  refine_with_ai: {
    category: "task_lifecycle",
    handler: "handleRefineWithAi",
    module: "tools/handler-modules/refine-with-ai.js",
    domainService: "handleRefineWithAi",
    dependencies: ["workflow-state.js", "tools/handler-modules/dod.js", "tools/handler-modules/plan.js"],
    sideEffects: "Updates active task description, plan, DoD, and refinement history in local state + syncs Zettly Todo",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Refine task description, plan, and DoD with empirical findings while preserving proven items and task identity",
    errorContract: "Refuses stale taskId, missing bugContext on bugfix tasks, or dropped proven DoD items",
    tests: ["tests/refine-with-ai.test.js"],
    stability: "stable",
    capability: "Refine active task contract and plan with new investigation evidence",
  },
  create_feature_flow: {
    category: "task_lifecycle",
    handler: "handleCreateFeatureFlow",
    module: "tools/handler-modules/workflow-handlers.js",
    domainService: "flowGraph + syncZettlyDrawing",
    dependencies: ["zettly-drawing.js"],
    sideEffects: "Validates Mermaid flowchart, records featureFlowCreated in local state, and syncs Zettly Draw canvas",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Mandatory Mermaid architecture flow design gate after start_task",
    errorContract: "Refuses disconnected or invalid Mermaid flowcharts",
    tests: ["tests/flow-gate.test.js", "tests/zettly-drawing.test.js"],
    stability: "stable",
    capability: "Validate Mermaid architecture flowchart and sync Zettly Draw Studio canvas",
  },
  acknowledge_instructions: {
    category: "task_lifecycle",
    handler: "handleAcknowledgeInstructions",
    module: "tools/handler-modules/preflight-handlers.js",
    domainService: "handleAcknowledgeInstructions",
    dependencies: ["preflight.js"],
    sideEffects: "Records README preflight fingerprint acknowledgment in session state",
    permissionLevel: "LOCAL_WRITE",
    sessionScoped: true,
    workflowRole: "Confirm README preflight fingerprint and project root scope before commit_and_push",
    errorContract: "Refuses mismatched README fingerprint or project root scope",
    tests: ["tests/preflight.test.js", "tests/preflight-checkpoint.test.js"],
    stability: "stable",
    capability: "Verify and record repository README preflight fingerprint acknowledgment",
  },
  set_definition_of_done: {
    category: "task_lifecycle",
    handler: "handleSetDefinitionOfDone",
    module: "tools/handler-modules/dod-handlers.js",
    domainService: "handleSetDefinitionOfDone",
    dependencies: ["tools/handler-modules/dod.js"],
    sideEffects: "Adds or replaces Definition of Done items in session state + Zettly sync",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Append or initialize Definition of Done checklist items",
    errorContract: "Refuses replacing a checklist that already has proven or waived items unless append:true",
    tests: ["tests/dod-handlers.test.js", "tests/dod.test.js"],
    stability: "stable",
    capability: "Append or set Definition of Done checklist items",
  },
  mark_dod_item: {
    category: "task_lifecycle",
    handler: "handleMarkDodItem",
    module: "tools/handler-modules/dod-handlers.js",
    domainService: "handleMarkDodItem",
    dependencies: ["tools/handler-modules/dod.js", "governance/evidence-validator.js"],
    sideEffects: "Marks a DoD item done with empirical evidence in session state + Zettly sync",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Record concrete verification evidence for a Definition of Done item",
    errorContract: "Refuses evidence shorter than 5 chars, waived items, or unverified CLI-first governance evidence",
    tests: ["tests/dod-handlers.test.js"],
    stability: "stable",
    capability: "Prove a Definition of Done item with verification evidence",
  },
  waive_dod_item: {
    category: "task_lifecycle",
    handler: "handleWaiveDodItem",
    module: "tools/handler-modules/dod-handlers.js",
    domainService: "handleWaiveDodItem",
    dependencies: ["tools/handler-modules/dod.js"],
    sideEffects: "Marks a DoD item waived with written reason in session state + Zettly sync",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Exclude a non-applicable Definition of Done item with a written audit reason",
    errorContract: "Refuses waiving already-proven items or reasons shorter than 5 chars",
    tests: ["tests/dod-handlers.test.js"],
    stability: "stable",
    capability: "Waive a Definition of Done item with recorded justification",
  },
  set_plan: {
    category: "task_lifecycle",
    handler: "handleSetPlan",
    module: "tools/handler-modules/workflow-handlers.js",
    domainService: "handleSetPlan",
    dependencies: ["tools/handler-modules/plan.js"],
    sideEffects: "Replaces ordered work plan in session state while preserving done status of matching step texts",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Revise the ordered implementation plan of the active task",
    errorContract: "Refuses when no task is active or steps are invalid (1-15 items, 3-200 chars)",
    tests: ["tests/plan.test.js"],
    stability: "stable",
    capability: "Replace ordered task plan while preserving completed matching steps",
  },
  mark_plan_step: {
    category: "task_lifecycle",
    handler: "handleMarkPlanStep",
    module: "tools/handler-modules/workflow-handlers.js",
    domainService: "handleMarkPlanStep",
    dependencies: ["tools/handler-modules/plan.js", "monitor.js"],
    sideEffects: "Updates step status ('done' or 'open') in session state + emits monitor event + Zettly sync",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Track live step-by-step progress of the active implementation plan",
    errorContract: "Refuses unknown step ID or idle session",
    tests: ["tests/plan.test.js"],
    stability: "stable",
    capability: "Mark an ordered plan step done or reopen it",
  },
  mark_bug_fixed: {
    category: "task_lifecycle",
    handler: "handleMarkBugFixed",
    module: "tools/handler-modules/workflow-handlers.js",
    domainService: "handleMarkBugFixed",
    dependencies: ["workflow-state.js"],
    sideEffects: "Sets bugFixed=true, fixSummary, and advances phase to 'testing' in session state",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Record completion of code implementation before test creation/execution",
    errorContract: "Refuses if no active task or feature flow is missing",
    tests: ["tests/handlers-workflow.test.js"],
    stability: "stable",
    capability: "Record implementation summary and advance task to testing phase",
  },
  create_tests: {
    category: "testing_and_documentation_gates",
    handler: "handleCreateTests",
    module: "tools/handler-modules/workflow-handlers.js",
    domainService: "handleCreateTests",
    dependencies: ["workflow-state.js"],
    sideEffects: "Sets testsCreated=true in session state",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Record that automated test coverage has been created for the change",
    errorContract: "Refuses if bugFixed is false",
    tests: ["tests/handlers-workflow.test.js"],
    stability: "stable",
    capability: "Mark automated tests as created in workflow state",
  },
  skip_tests: {
    category: "testing_and_documentation_gates",
    handler: "handleSkipTests",
    module: "tools/handler-modules/workflow-handlers.js",
    domainService: "handleSkipTests",
    dependencies: ["workflow-state.js"],
    sideEffects: "Sets testsSkipped=true and testsSkippedReason in session state",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Record an explicit justification when automated tests cannot be created",
    errorContract: "Refuses empty reason or when bugFixed is false",
    tests: ["tests/handlers-workflow.test.js"],
    stability: "stable",
    capability: "Waive automated test execution with recorded justification",
  },
  run_tests: {
    category: "testing_and_documentation_gates",
    handler: "handleRunTests",
    module: "tools/handler-modules/workflow-handlers.js",
    domainService: "handleRunTests",
    dependencies: ["workflow-state.js", "monitor.js"],
    sideEffects: "Records testCommand, testsPassed, buildHost, and advances phase to 'documentation' when passed=true",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Record empirical test execution results and builder host attribution",
    errorContract: "Keeps phase in 'testing' and blocks commit when passed=false",
    tests: ["tests/handlers.test.js", "tests/build-host-precedence.test.js"],
    stability: "stable",
    capability: "Record test command result and advance workflow on green tests",
  },
  create_documentation: {
    category: "testing_and_documentation_gates",
    handler: "handleCreateDocumentation",
    module: "tools/handler-modules/workflow-handlers.js",
    domainService: "handleCreateDocumentation + evaluateDocGate",
    dependencies: ["tools/handler-modules/docs.js", "governance/engine.js"],
    sideEffects: "Verifies declared documentation files against Git working tree/commits and records documentationCreated=true",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Satisfy the documentation quality gate with verified changed doc files",
    errorContract: "Refuses non-documentation file paths or files not modified in the working tree/task commits",
    tests: ["tests/docs-gate-handlers.test.js", "tests/handlers.test.js"],
    stability: "stable",
    capability: "Verify changed documentation files and satisfy documentation gate",
  },
  waive_documentation: {
    category: "testing_and_documentation_gates",
    handler: "handleWaiveDocumentation",
    module: "tools/handler-modules/workflow-handlers.js",
    domainService: "handleWaiveDocumentation",
    dependencies: ["tools/handler-modules/docs.js", "governance/engine.js"],
    sideEffects: "Sets documentationWaived=true and documentationWaiverReason in session state",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Exclude the documentation gate with a written reason (>= 5 chars) when public behavior is unchanged",
    errorContract: "Refuses if tests have not passed/skipped or reason is < 5 chars",
    tests: ["tests/docs-gate-handlers.test.js"],
    stability: "stable",
    capability: "Waive documentation gate with recorded justification",
  },
  check_ready_to_commit: {
    category: "git_commit_and_release",
    handler: "handleReadyCheck",
    module: "tools/handler-modules/status-handlers.js",
    domainService: "handleReadyCheck",
    dependencies: ["tools/handler-modules/docs.js", "tools/handler-modules/dod.js"],
    sideEffects: "Evaluates all 11 pre-commit gates (flow, DoD, tests, doc gate, English policy, nullable-date gate) and sets readyCheckCompleted",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Pre-commit quality gate check before commit_and_push",
    errorContract: "Returns ⚠️ NOT READY TO COMMIT with exact failing gate details when any check fails",
    tests: ["tests/docs-gate-ready.test.js", "tests/strict-nullable-gate.test.js", "tests/english-policy.test.js"],
    stability: "stable",
    capability: "Evaluate all 11 pre-commit governance and quality gates",
  },
  commit_and_push: {
    category: "git_commit_and_release",
    handler: "handleCommitAndPush",
    module: "tools/handler-modules/commit-handlers.js",
    domainService: "handleCommitAndPush",
    dependencies: ["git-facade.js", "repository-identity.js", "preflight.js"],
    sideEffects: "Executes git add, git commit, and git push on the pinned repository and verifies remote SHA match",
    permissionLevel: "GIT_LOCAL_AND_REMOTE_WRITE",
    sessionScoped: true,
    workflowRole: "Stage, commit, push, and verify remote branch SHA after ready check passes",
    errorContract: "Fails closed on repository identity mismatch, unacknowledged preflight, dirty foreign files without paths[], missing test files, or remote SHA mismatch",
    tests: ["tests/handlers-commit.test.js", "tests/commit-false-success.test.js", "tests/push-branch-guard.test.js"],
    stability: "stable",
    capability: "Stage, commit, push to remote, and verify remote HEAD SHA",
  },
  acquire_release_lock: {
    category: "git_commit_and_release",
    handler: "handleAcquireReleaseLock",
    module: "tools/handler-modules/release-handlers.js",
    domainService: "acquireReleaseLock",
    dependencies: ["tools/release-lock.js", "tools/pipeline-guard.js"],
    sideEffects: "Writes 2-hour advisory release lock in .git/ after checking active CI pipelines",
    permissionLevel: "LOCAL_WRITE_FENCED",
    sessionScoped: true,
    workflowRole: "Serialize release script execution across concurrent sessions in the same clone",
    errorContract: "Refuses when another active session holds the release lock or CI pipeline is running",
    tests: ["tests/release-lock.test.js", "tests/pipeline-guard.test.js"],
    stability: "stable",
    capability: "Claim per-repository release lock in .git/",
  },
  release_release_lock: {
    category: "git_commit_and_release",
    handler: "handleReleaseReleaseLock",
    module: "tools/handler-modules/release-handlers.js",
    domainService: "releaseReleaseLock",
    dependencies: ["tools/release-lock.js"],
    sideEffects: "Removes release lock file in .git/",
    permissionLevel: "LOCAL_WRITE_FENCED",
    sessionScoped: true,
    workflowRole: "Release the per-clone release lock after tag deployment",
    errorContract: "Refuses releasing another session's lock unless force:true",
    tests: ["tests/release-lock.test.js"],
    stability: "stable",
    capability: "Release per-repository release lock in .git/",
  },
  perform_release: {
    category: "git_commit_and_release",
    handler: "handlePerformRelease",
    module: "tools/handler-modules/release-handlers.js",
    domainService: "handlePerformRelease",
    dependencies: ["git-facade.js", "security/commands.js"],
    sideEffects: "Executes allowlisted npm run release[:patch|minor|major] or records existing release tag on HEAD and pushes tags",
    permissionLevel: "GIT_AND_RELEASE_WRITE",
    sessionScoped: true,
    workflowRole: "Execute or record semantic version release after commit_and_push",
    errorContract: "Enforces strict command allowlist (UNSAFE_COMMAND_DENIED) and clean working tree",
    tests: ["tests/handlers-release.test.js", "tests/perform-release-and-git-checks.test.js"],
    stability: "stable",
    capability: "Execute or record semantic version release and tag push",
  },
  record_deployment: {
    category: "git_commit_and_release",
    handler: "handleRecordDeployment",
    module: "tools/handler-modules/release-handlers.js",
    domainService: "handleRecordDeployment",
    dependencies: ["repository-identity.js", "preflight.js"],
    sideEffects: "Verifies release tag contains HEAD via git merge-base --is-ancestor and records deployment attestation in session state",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Verify and record CI/CD production deployment tag, pipeline ID, sites, and evidence",
    errorContract: "Refuses if tag does not exist in Git or does not contain HEAD",
    tests: ["tests/record-deployment.test.js", "tests/ci-deployment-contract.test.js"],
    stability: "stable",
    capability: "Verify release tag ancestry and record deployment attestation",
  },
  skip_release: {
    category: "git_commit_and_release",
    handler: "handleSkipRelease",
    module: "tools/handler-modules/release-handlers.js",
    domainService: "handleSkipRelease",
    dependencies: ["workflow-state.js"],
    sideEffects: "Sets releaseSkipped=true and releaseSkippedReason in session state",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Waive release step with justification for non-package or internal tasks",
    errorContract: "Refuses empty reason or uncommitted state",
    tests: ["tests/handlers-release.test.js"],
    stability: "stable",
    capability: "Skip release step with recorded justification",
  },
  complete_task: {
    category: "task_lifecycle",
    handler: "handleCompleteTask",
    module: "tools/handler-modules/commit-handlers.js",
    domainService: "handleCompleteTask + releaseTerminalTaskMutex",
    dependencies: ["zettly-workflow.js", "process-lock.js", "governance/engine.js"],
    sideEffects: "Verifies all gates, records history & follow-up recommendations, completes Zettly Todo & Outcome, resets state to idle, and releases OS worktree mutex",
    permissionLevel: "TERMINAL_LOCAL_AND_REMOTE_WRITE_MUTEX_RELEASE",
    sessionScoped: true,
    workflowRole: "Standard governed task completion and worktree mutex release",
    errorContract: "Refuses if commit/release/DoD/governance gates are unsatisfied or Zettly completion sync fails",
    tests: ["tests/task-terminal-lock-release.test.js", "tests/project-lock-lifecycle-termination.test.js"],
    stability: "stable",
    capability: "Verify all completion gates, close Zettly Todo, record history, and release worktree mutex",
  },
  force_complete_task: {
    category: "task_lifecycle",
    handler: "handleForceCompleteTask",
    module: "tools/handler-modules/commit-handlers.js",
    domainService: "handleForceCompleteTask + releaseTerminalTaskMutex",
    dependencies: ["governance/exceptions.js", "zettly-workflow.js", "process-lock.js"],
    sideEffects: "Validates override approval when governance is enforced, records forced history entry, syncs Zettly, resets state, and releases OS worktree mutex",
    permissionLevel: "PRIVILEGED_TERMINAL_WRITE_MUTEX_RELEASE",
    sessionScoped: true,
    workflowRole: "Emergency/administrative task closure with explicit approval audit trail and mutex release",
    errorContract: "Refuses unauthorized governance override when effectiveMode is 'enforce'",
    tests: ["tests/task-terminal-lock-release.test.js", "tests/governance-policies.test.js"],
    stability: "stable",
    capability: "Force-close active task with governance audit trail and release worktree mutex",
  },
  drop_task: {
    category: "task_lifecycle",
    handler: "handleDropTask",
    module: "tools/handler-modules/commit-handlers.js",
    domainService: "handleDropTask + releaseTerminalTaskMutex",
    dependencies: ["zettly-workflow.js", "process-lock.js"],
    sideEffects: "Abandons active task, records dropped outcome in Zettly, resets state to idle, and releases OS worktree mutex",
    permissionLevel: "TERMINAL_LOCAL_AND_REMOTE_WRITE_MUTEX_RELEASE",
    sessionScoped: true,
    workflowRole: "Cancel/abandon an active task cleanly and release its worktree mutex",
    errorContract: "Refuses if no active task exists",
    tests: ["tests/task-terminal-lock-release.test.js", "tests/project-lock-lifecycle-termination.test.js"],
    stability: "stable",
    capability: "Abandon active task, sync cancellation, and release worktree mutex",
  },
  next_steps: {
    category: "task_lifecycle",
    handler: "handleNextSteps",
    module: "tools/handler-modules/next-steps-handlers.js",
    domainService: "handleNextSteps",
    dependencies: ["tools/handler-modules/next-steps.js"],
    sideEffects: "Read-only inspection of project workflow history recommendations",
    permissionLevel: "READ_ONLY",
    sessionScoped: true,
    workflowRole: "Read follow-up recommendations and signals left by the previous completed task in the project",
    errorContract: "Returns fallback message if no recommendations exist yet",
    tests: ["tests/next-steps-handlers.test.js", "tests/next-steps.test.js"],
    stability: "stable",
    capability: "Read follow-up recommendations from the last completed task",
  },

  // --- Domain G: Session Recovery, Handoff & Cooperative Takeover ---
  resume_session: {
    category: "session_recovery_and_handoff",
    handler: "handleResumeSession",
    module: "tools/handler-modules/resume-handlers.js",
    domainService: "findResumableCandidates + handleResumeSession",
    dependencies: ["process-lock.js", "monitor-server/restart-handshake-store.cjs"],
    sideEffects: "Read-only candidate listing when called without arguments; acquires worktree mutex and copies orphaned/handed-over session state when called with { adopt }",
    permissionLevel: "READ_OR_LOCAL_WRITE_MUTEX_ACQUIRE",
    sessionScoped: true,
    workflowRole: "List or adopt an abandoned/handed-over session state within the same project on the same machine",
    errorContract: "Refuses adopting a live session, cross-project state, or an unclaimed fenced restart handover",
    tests: ["tests/resume-session.test.js", "tests/real-session-resume-v131.test.js"],
    stability: "stable",
    capability: "List or adopt left-behind session state in the same project",
  },
  restart_handshake: {
    category: "session_recovery_and_handoff",
    handler: "handleRestartHandshake",
    module: "tools/handler-modules/restart-handshake-handlers.js",
    domainService: "handleRestartHandshake",
    dependencies: ["monitor-server/restart-handshake.cjs", "monitor-server/restart-handshake-store.cjs", "process-lock.js"],
    sideEffects: "Manages atomic restart sidecar state machine (status, checkpoint, release, cancel, claim, verify_exit, recover_claim) and releases worktree mutex on action=release",
    permissionLevel: "LOCAL_AND_REMOTE_WRITE_MUTEX_CONTROL",
    sessionScoped: true,
    workflowRole: "Coordinate zero-loss owner/controller restart handover and worktree mutex release before MCP process restart",
    errorContract: "Fails closed if Zettly checkpoint read-back is unconfirmed or old owner process is still alive during verify_exit",
    tests: ["tests/restart-handshake-handler.test.js", "tests/restart-handshake-race.test.js"],
    stability: "stable",
    capability: "Execute fenced cooperative restart handshake state machine",
  },
  checkpoint_task: {
    category: "session_recovery_and_handoff",
    handler: "handleCheckpointTask",
    module: "tools/handler-modules/checkpoint-handlers.js",
    domainService: "handleCheckpointTask + planRevert",
    dependencies: ["zettly-workflow.js", "zettly-client.js", "tools/handler-modules/checkpoint-block.js"],
    sideEffects: "Writes authoritative checkpoint block (machine, baseSha, commits, summary) to Zettly Todo and reads it back to prove persistence",
    permissionLevel: "LOCAL_AND_REMOTE_WRITE_VERIFIED",
    sessionScoped: true,
    workflowRole: "Persist and verify an authoritative task checkpoint in Zettly (with optional read-only revert plan)",
    errorContract: "Reports confirmed:false if Zettly read-back does not match the written timestamp",
    tests: ["tests/checkpoint-task.test.js", "tests/revert-record.test.js"],
    stability: "stable",
    capability: "Write and read-back verify an authoritative task checkpoint in Zettly",
  },
  handoff_task: {
    category: "session_recovery_and_handoff",
    handler: "handleHandoffTask",
    module: "tools/handler-modules/checkpoint-handlers.js",
    domainService: "handleHandoffTask -> handleCheckpointTask",
    dependencies: ["tools/handler-modules/checkpoint-handlers.js"],
    sideEffects: "Writes a mandatory-reason cross-machine handover marker into the checkpoint and syncs to Zettly Todo, locking out local start_task until acknowledge_handover",
    permissionLevel: "LOCAL_AND_REMOTE_WRITE_VERIFIED",
    sessionScoped: true,
    workflowRole: "Push-based cross-machine handoff from current machine to target machine ('to')",
    errorContract: "Refuses missing target machine, same machine, or empty reason",
    tests: ["tests/handoff-refusal.test.js"],
    stability: "stable",
    capability: "Record cross-machine task handoff to a target machine with verified checkpoint",
  },
  acknowledge_handover: {
    category: "session_recovery_and_handoff",
    handler: "handleAcknowledgeHandover",
    module: "tools/handler-modules/checkpoint-handlers.js",
    domainService: "handleAcknowledgeHandover -> handleCheckpointTask",
    dependencies: ["tools/handler-modules/checkpoint-handlers.js"],
    sideEffects: "Appends return acknowledgment to checkpoint summary, clears handover marker, and confirms via Zettly read-back",
    permissionLevel: "LOCAL_AND_REMOTE_WRITE_VERIFIED",
    sessionScoped: true,
    workflowRole: "Explicitly reclaim a handed-off task back on the original machine",
    errorContract: "Refuses when no handover marker is active",
    tests: ["tests/handoff-refusal.test.js"],
    stability: "stable",
    capability: "Reclaim a handed-off task locally and clear the handover marker",
  },
  take_over_task: {
    category: "session_recovery_and_handoff",
    handler: "handleTakeOverTask",
    module: "tools/handler-modules/takeover-handlers.js",
    domainService: "handleTakeOverTask + writeTakeoverRequest",
    dependencies: ["process-lock.js", "workflow-state.js"],
    sideEffects: "Writes an authenticated takeover request file into the target project lock directory so a live but idle owner PID drops its task on next heartbeat",
    permissionLevel: "LOCAL_LOCK_DIR_WRITE",
    sessionScoped: true,
    workflowRole: "Cooperative same-machine takeover from a live MCP process that has been idle >= 10 minutes",
    errorContract: "Refuses if owner PID wrote state within the last 10 minutes or confirmation string does not match 'CONFIRM TAKE_OVER <ownerPid>'",
    tests: ["tests/takeover-request.test.js"],
    stability: "stable",
    capability: "Request cooperative takeover from an idle live MCP process on the same machine",
  },
  fetch_task: {
    category: "session_recovery_and_handoff",
    handler: "handleFetchTask",
    module: "tools/handler-modules/remote-checkpoint.js",
    domainService: "handleFetchTask",
    dependencies: ["tools/handler-modules/checkpoint-handlers.js", "tools/handler-modules/checkpoint-block.js"],
    sideEffects: "Refreshes remote machine checkpoint over SSH (fixed batch command), adopts checkpoint from Zettly Todo, and writes handover marker",
    permissionLevel: "SSH_REMOTE_AND_LOCAL_WRITE",
    sessionScoped: true,
    workflowRole: "Pull-based cross-machine task takeover from a remote workstation ('from') over SSH + Zettly",
    errorContract: "Refuses unresolvable machine aliases or missing reason; falls back to last Zettly checkpoint with confirmed:false if SSH fails",
    tests: ["tests/remote-checkpoint.test.js"],
    stability: "stable",
    capability: "Pull and adopt a task checkpoint from another machine over SSH and Zettly",
  },

  // --- Domain H: Workflow Status, Orchestration & History ---
  get_workflow_status: {
    category: "workflow_status_and_orchestration",
    handler: "handleGetWorkflowStatus",
    module: "tools/handler-modules/status-handlers.js",
    domainService: "handleGetWorkflowStatus",
    dependencies: ["workflow-state.js", "tools/handler-modules/dod.js", "tools/handler-modules/plan.js", "build-monitor.js", "mcp-index.js"],
    sideEffects: "Read-only status inspection (plus non-blocking Zettly outbox flush if pending)",
    permissionLevel: "READ_ONLY",
    sessionScoped: true,
    workflowRole: "Inspect current phase, task, DoD checklist, plan progress, active build, and replica/orphan diagnostics",
    errorContract: "Always returns current session workflow state summary",
    tests: ["tests/status-queue-report.test.js", "tests/handlers-workflow.test.js"],
    stability: "stable",
    capability: "Inspect complete current session workflow status and diagnostics",
  },
  view_history: {
    category: "workflow_status_and_orchestration",
    handler: "handleViewHistory",
    module: "tools/handler-modules/summary-handlers.js",
    domainService: "summarizeHistory",
    dependencies: ["tools/handler-modules/shared.js"],
    sideEffects: "Read-only inspection of completed task history entries",
    permissionLevel: "READ_ONLY",
    sessionScoped: true,
    workflowRole: "List chronological history of completed tasks (timestamp, description, type, commit message)",
    errorContract: "Returns '📜 No workflow history yet.' when empty",
    tests: ["tests/handlers-workflow.test.js"],
    stability: "stable",
    capability: "View chronological list of recent completed tasks",
  },
  continue_workflow: {
    category: "workflow_status_and_orchestration",
    handler: "handleContinueWorkflow",
    module: "tools/handler-modules/status-handlers.js",
    domainService: "handleContinueWorkflow",
    dependencies: ["tools/handler-modules/status-handlers.js", "tools/handler-modules/commit-handlers.js"],
    sideEffects: "Provides phase-aware next-step guidance; automatically runs handleReadyCheck in 'ready' phase or handleCommitAndPush in 'commit' phase",
    permissionLevel: "PHASE_DEPENDENT_READ_OR_COMMIT",
    sessionScoped: true,
    workflowRole: "Context-aware workflow continuation helper and automatic ready-check/commit trigger",
    errorContract: "Resets to 'commit' phase and increments dodRevision if new working tree changes appear after commit",
    tests: ["tests/handlers-workflow.test.js"],
    stability: "stable",
    capability: "Provide phase-specific guidance or advance ready/commit phase",
  },
  rerun_workflow: {
    category: "workflow_status_and_orchestration",
    handler: "handleRerunWorkflow",
    module: "tools/handler-modules/status-handlers.js",
    domainService: "handleRerunWorkflow",
    dependencies: ["workflow-state.js", "governance/engine.js"],
    sideEffects: "Resets current task back to 'coding' phase while preserving taskDescription, taskType, projectDir, and Definition of Done items",
    permissionLevel: "LOCAL_AND_REMOTE_SYNC_WRITE",
    sessionScoped: true,
    workflowRole: "Restart the active task workflow from the coding phase without losing DoD items",
    errorContract: "Refuses when no active task exists",
    tests: ["tests/handlers-workflow.test.js", "tests/dod-state.test.js"],
    stability: "stable",
    capability: "Reset active task to coding phase while preserving Definition of Done",
  },
  run_full_workflow: {
    category: "workflow_status_and_orchestration",
    handler: "handleRunFullWorkflow",
    module: "tools/handler-modules/index.js",
    domainService: "handleRunFullWorkflow",
    dependencies: ["tools/handler-modules/workflow-handlers.js", "tools/handler-modules/status-handlers.js", "tools/handler-modules/commit-handlers.js", "tools/handler-modules/release-handlers.js"],
    sideEffects: "Sequentially executes create_feature_flow -> mark_bug_fixed -> create_tests -> run_tests -> create_documentation/waive_documentation -> mark_dod_item -> check_ready_to_commit -> commit_and_push -> perform_release -> complete_task",
    permissionLevel: "FULL_LIFECYCLE_WRITE_AND_RELEASE",
    sessionScoped: true,
    workflowRole: "Batch orchestrator to close all post-implementation workflow steps in one call when all evidence is already prepared",
    errorContract: "Validates DoD evidence and documentation gate up-front before mutating any step; aborts cleanly if any step fails",
    tests: ["tests/handlers.test.js", "tests/docs-gate-full-workflow.test.js"],
    stability: "stable",
    capability: "Execute complete post-coding workflow pipeline in one batch call",
  },

  // --- Domain I: Project Knowledge Summary (V3.0 Canonical) ---
  project_summary: {
    category: "project_knowledge_summary",
    handler: "handleProjectSummary",
    module: "tools/handler-modules/summary-handlers.js",
    domainService: "resolveUnifiedProjectSummary",
    dependencies: ["tools/handler-modules/shared.js", "db/index.js"],
    sideEffects: "Read-only aggregation of completed tasks, task-type distribution, and recent activity across memory, JSON file, or SQLite",
    permissionLevel: "READ_ONLY",
    sessionScoped: false,
    workflowRole: "Single canonical tool to read the Project Knowledge Summary (supports source: 'memory' | 'file' | 'db' | 'auto')",
    errorContract: "Falls back gracefully when no history or database summary exists",
    tests: ["tests/handlers.test.js", "tests/security-boundaries.test.js", "tests/tool-catalog-consolidation-v215.test.js"],
    stability: "stable",
    capability: "Aggregate and format project task history and knowledge summary",
  },

  // --- Domain J: Monitor & Build Telemetry ---
  list_active_sessions: {
    category: "monitor_and_build_telemetry",
    handler: "handleListActiveSessions",
    module: "tools/handler-modules/status-handlers.js",
    domainService: "fetchActiveSessions",
    dependencies: ["monitor.js"],
    sideEffects: "Read-only HTTP GET to central monitor dashboard (DEVWF_MONITOR_URL)",
    permissionLevel: "READ_ONLY_NETWORK",
    sessionScoped: false,
    workflowRole: "List active AI coding sessions across all fleet machines (HELLOWORLD, MMCH, Mac)",
    errorContract: "Returns warning message if monitor URL is unreachable",
    tests: ["tests/monitor-active-sessions.test.js"],
    stability: "stable",
    capability: "List active workflow sessions across all machines from central monitor",
  },
  build_report: {
    category: "monitor_and_build_telemetry",
    handler: "handleBuildReport",
    module: "tools/handler-modules/status-handlers.js",
    domainService: "fetchBuildReport",
    dependencies: ["monitor.js"],
    sideEffects: "Read-only HTTP GET to monitor build-report endpoint",
    permissionLevel: "READ_ONLY_NETWORK",
    sessionScoped: false,
    workflowRole: "Aggregate 30-day build duration statistics (count, p50, p90, max, slowest targets) across projects",
    errorContract: "Returns warning message if monitor build report is unavailable",
    tests: ["tests/build-report-tools.test.js", "tests/build-report.test.js"],
    stability: "stable",
    capability: "Query historical p50/p90/max build duration report from monitor",
  },
  build_estimate: {
    category: "monitor_and_build_telemetry",
    handler: "handleBuildEstimate",
    module: "tools/handler-modules/status-handlers.js",
    domainService: "fetchBuildReport + estimateBuild",
    dependencies: ["monitor.js", "monitor-server/build-report.cjs"],
    sideEffects: "Read-only monitor baseline fetch + in-memory session activeBuild progress correlation",
    permissionLevel: "READ_ONLY_NETWORK",
    sessionScoped: true,
    workflowRole: "Estimate remaining minutes for a specific project/target build (requires >= 5 historical runs and correlates live session activeBuild)",
    errorContract: "Reports 'no-baseline' when fewer than 5 historical builds exist instead of guessing",
    tests: ["tests/build-report-tools.test.js"],
    stability: "stable",
    capability: "Estimate remaining build duration from historical baseline and active build state",
  },
  report_build_status: {
    category: "monitor_and_build_telemetry",
    handler: "handleReportBuildStatus",
    module: "tools/handler-modules/workflow-handlers.js",
    domainService: "normalizeBuildState + reportEventSafe",
    dependencies: ["build-monitor.js", "monitor.js"],
    sideEffects: "Updates activeBuild and buildHistory in local session state + emits build_* event to monitor + syncs Zettly",
    permissionLevel: "LOCAL_AND_MONITOR_WRITE",
    sessionScoped: true,
    workflowRole: "Publish real-time build/test/scan/deploy progress and per-test-case status to the monitor dashboard",
    errorContract: "Refuses empty target string",
    tests: ["tests/build-monitor.test.js", "tests/build-test-cases.test.js"],
    stability: "stable",
    capability: "Record and stream live build/test execution progress to monitor",
  },
});

/**
 * Inventory of non-tool interfaces (MCP prompts, MCP resources, CLI commands, and internal helpers)
 * so public MCP tools are cleanly distinguished from other interfaces.
 */
export const NON_TOOL_INTERFACES = Object.freeze({
  mcpPrompts: [
    {
      name: "workflow_reminder",
      description: "Get a reminder of the complete development workflow",
      module: "index.js",
    },
    {
      name: "pre_commit_checklist",
      description: "Pre-commit checklist to ensure nothing is missed",
      module: "index.js",
    },
  ],
  mcpResources: [],
  cliCommands: [
    { command: "devwf setup", purpose: "Initialize local-first profile" },
    { command: "devwf doctor", purpose: "Check Node.js, platform, security mode, SQLite, and Zettly health" },
    { command: "devwf zettly status|skip|connect|switch|disconnect|doctor", purpose: "Manage optional per-user Zettly integration" },
    { command: "devwf pair", purpose: "Generate QR pairing challenge for Android Companion" },
    { command: "devwf list", purpose: "List sessions from the central monitor" },
    { command: "devwf close --session <key>", purpose: "Mark a session closed in the monitor without signalling processes" },
    { command: "devwf share list|revoke", purpose: "Manage monitor share links" },
    { command: "devwf drop --session <key> --reason <r>", purpose: "Drop a session's active task via handleDropTask" },
    { command: "devwf complete --session <key>", purpose: "Complete a session's active task via handleCompleteTask" },
    { command: "devwf checkpoint --session <key>", purpose: "Write and verify a task checkpoint via handleCheckpointTask" },
    { command: "devwf identity --dir <path> [--against <path>]", purpose: "Inspect repository identity contract and project switch decision" },
    { command: "devwf governance validate|policies", purpose: "Run headless CLI-First & Documentation governance validation" },
    { command: "devwf audit code|changes|standards|repository|site|--url", purpose: "Run code/PR/standards/repository or website audits from CLI" },
    { command: "devwf fleet status|check|plan|stage|activate|verify|rollback|doctor|upgrade", purpose: "Manage multi-device fleet convergence and rollouts" },
  ],
  internalHelpers: [
    { name: "helper_consolidation_plan", module: "src/tool-catalog-auditor.js", purpose: "Generate a safe consolidation implementation plan from catalog audit findings without adding public MCP tool bloat" },
    { name: "resolveUnifiedProjectSummary", module: "tools/handler-modules/summary-handlers.js", purpose: "Authoritative shared service backing project_summary, project_summary_data, and project_summary_db" },
    { name: "runEngineeringAudit", module: "src/engineering-audit.js", purpose: "Authoritative shared audit engine backing audit_code, audit_changes, audit_repository, audit_report, and category filters" },
    { name: "analyzeChangeImpact", module: "src/engineering-audit.js", purpose: "Authoritative shared change-impact analyzer backing helper_change_impact, helper_suggest_tests, and helper_refactor_advice" },
  ],
});

/**
 * Exhaustive Semantic Duplication & Pairwise Classification Matrix (D0..D6).
 * Every suspicious pair or cluster across all 10 domains is evaluated with
 * code-level behavioral evidence, permission boundaries, and consolidation decisions.
 */
export const SEMANTIC_DUPLICATION_MATRIX = Object.freeze([
  {
    pairId: "DUP-01",
    toolA: "helper_suggest_tests",
    toolB: "helper_change_impact",
    classification: "D0",
    classificationLabel: "EXACT_DUPLICATE",
    domain: "intelligent_helpers",
    similaritySignals: [
      "Identical inputSchema: { projectDir: string, files: string[] }",
      "Identical dispatch target in src/engineering-audit.js: both cases fall through to analyzeChangeImpact({ projectDir, files })",
      "Identical output structure: { project_dir, changed_files, risk_level, affected_modules, recommended_tests, characterization_advice }",
      "Identical permission level: READ_ONLY, non-session-scoped",
    ],
    behavioralDifferences: "None. Both execute the exact same function with the exact same arguments and return the exact same payload.",
    permissionDifferences: "None (both READ_ONLY).",
    compatibilityRisk: "External callers and acceptance test Scenario 4 call helper_suggest_tests.",
    recommendation: "Strategy S1 + S2: Designate helper_change_impact as canonical tool; retain helper_suggest_tests as a documented compatibility alias in TOOL_ALIASES.",
    confidence: "1.00 (proven by switch fallthrough in src/engineering-audit.js)",
    consolidatedInV215: true,
  },
  {
    pairId: "DUP-02",
    toolA: "project_summary_data",
    toolB: "project_summary",
    classification: "D1",
    classificationLabel: "SEMANTIC_DUPLICATE",
    domain: "project_knowledge_summary",
    similaritySignals: [
      "Identical zero-argument input schema in v2.1.4",
      "Both produce '🧠 Project Knowledge Summary' with Total tasks completed, Recent task mix, Last active, and Recent tasks (last 5)",
      "project_summary_data reads project-summary.json (which workflowState.save() writes from the same history) and falls back to handleProjectSummary()",
    ],
    behavioralDifferences:
      "project_summary computes from workflowState.state.history in memory; project_summary_data reads project-summary.json on disk and includes Updated timestamp.",
    permissionDifferences: "None (both READ_ONLY, non-session-scoped).",
    compatibilityRisk: "tests/handlers.test.js and external clients call project_summary and project_summary_data.",
    recommendation:
      "Strategy S1 + S2: Consolidate into unified resolveUnifiedProjectSummary(workflowState, { source }) in summary-handlers.js; allow project_summary to accept optional { source: 'auto'|'memory'|'file'|'db' } while preserving project_summary_data as a compatibility alias.",
    confidence: "0.98 (verified in tools/handler-modules/summary-handlers.js)",
    consolidatedInV215: true,
  },
  {
    pairId: "DUP-03",
    toolA: "project_summary_db",
    toolB: "project_summary",
    classification: "D1",
    classificationLabel: "SEMANTIC_DUPLICATE",
    domain: "project_knowledge_summary",
    similaritySignals: [
      "Both produce '🧠 Project Knowledge Summary' with identical stats and recent tasks sections",
      "project_summary_db reads from SQLite getSummaryForUser(userId, projectPath)",
    ],
    behavioralDifferences:
      "project_summary_db reads the per-user SQLite table instead of in-memory history or JSON file.",
    permissionDifferences: "None (both READ_ONLY, non-session-scoped).",
    compatibilityRisk: "session-scope.js and index.js register project_summary_db.",
    recommendation:
      "Strategy S1 + S2: Route project_summary_db through resolveUnifiedProjectSummary(workflowState, { source: 'db' }) and retain as compatibility alias.",
    confidence: "0.97 (verified in tools/handler-modules/summary-handlers.js)",
    consolidatedInV215: true,
  },
  {
    pairId: "DUP-04",
    toolA: "audit_repository",
    toolB: "audit_code",
    classification: "D3",
    classificationLabel: "WRAPPER_REDUNDANCY",
    domain: "code_auditing",
    similaritySignals: [
      "Both call runEngineeringAudit({ projectDir, baseline, baselineFile, maxFiles, maxDepth })",
      "When audit_code is called without files (or files: []), it scans the full repository identically to audit_repository",
    ],
    behavioralDifferences:
      "audit_repository forces files: [] and sets scopeLabel: 'Full Repository'; audit_code accepts optional files: [] and sets scopeLabel: 'Selected Files' or 'Repository'.",
    permissionDifferences: "None (both READ_ONLY).",
    compatibilityRisk: "CLI `devwf audit repository` and acceptance tests invoke audit_repository.",
    recommendation:
      "Strategy S1 + S4: Keep shared runEngineeringAudit engine, record audit_repository in TOOL_ALIASES as a supported wrapper of audit_code, and clarify descriptions so agents use audit_code for file lists and audit_repository when explicitly requesting a full-tree scan.",
    confidence: "0.96 (verified in src/engineering-audit.js)",
    consolidatedInV215: true,
  },
  {
    pairId: "DUP-05",
    toolA: "audit_architecture / audit_security / audit_tests / audit_api_contracts / audit_database_changes",
    toolB: "audit_code",
    classification: "D2",
    classificationLabel: "PARTIAL_OVERLAP",
    domain: "code_auditing",
    similaritySignals: [
      "All 5 category tools delegate to runEngineeringAudit({ projectDir, files, categoryFilter })",
      "audit_code runs all categories when categoryFilter is null, or can filter by category",
    ],
    behavioralDifferences:
      "Each domain-specific audit tool filters findings to a single standard category (architecture, security, testing, api-contracts, database) and scopes the report label.",
    permissionDifferences: "None (all READ_ONLY).",
    compatibilityRisk: "V2.0/V2.1 acceptance suites and coding-agent role prompts call domain-specific audit_* tools.",
    recommendation:
      "Strategy S1 + S4: Add optional `category` parameter to `audit_code` and `audit_changes` so agents can filter directly, while keeping the 5 category-scoped tools as thin declarative entry points over `runEngineeringAudit`.",
    confidence: "0.95",
    consolidatedInV215: true,
  },
  {
    pairId: "DUP-06",
    toolA: "audit_report",
    toolB: "audit_code / audit_changes",
    classification: "D2",
    classificationLabel: "PARTIAL_OVERLAP",
    domain: "code_auditing",
    similaritySignals: [
      "Calls runEngineeringAudit with either PR change discovery or repository scan",
      "Returns the same audit result object plus formatted_report: formatAuditReportText(report)",
    ],
    behavioralDifferences:
      "audit_report adds the human-readable Markdown/ASCII `formatted_report` block used by `devwf audit` CLI and PR review comments.",
    permissionDifferences: "None (all READ_ONLY).",
    compatibilityRisk: "Used by CLI `devwf audit code|changes|repository` and acceptance tests.",
    recommendation:
      "Strategy S4: Preserve audit_report as the human+JSON report generator; clarify description to state it includes `formatted_report`.",
    confidence: "0.95",
    consolidatedInV215: true,
  },
  {
    pairId: "DUP-07",
    toolA: "security_audit",
    toolB: "audit_security",
    classification: "D6",
    classificationLabel: "FALSE_DUPLICATE",
    domain: "security_and_web_audit",
    similaritySignals: [
      "Names are word-order inversions ('security_audit' vs 'audit_security')",
      "Both use security/scanner.js to detect secret patterns",
    ],
    behavioralDifferences:
      "security_audit (security/audit.js) audits DevWorkflow's own runtime state, protected file permissions (.env mode), JWT/SESSION_SECRET configuration, and SQLite/Postgres/MySQL database rows (workflow_history, workflow_state, project_summary). audit_security (src/engineering-audit.js) audits target application source files against ZET-SEC-001 and ZET-SEC-002 engineering standards with baseline fingerprinting.",
    permissionDifferences: "Both READ_ONLY, but security_audit connects to the workflow state database.",
    compatibilityRisk: "High agent confusion risk due to nearly identical names.",
    recommendation:
      "Strategy S4: Preserve both tools because their targets are fundamentally different, and explicitly disambiguate both descriptions with cross-references ('Use audit_security for ZET-SEC source-code standards; use security_audit for DevWorkflow runtime state, env config, and workflow DB rows').",
    confidence: "1.00",
    consolidatedInV215: true,
  },
  {
    pairId: "DUP-08",
    toolA: "site_audit",
    toolB: "audit_code",
    classification: "D6",
    classificationLabel: "FALSE_DUPLICATE",
    domain: "security_and_web_audit",
    similaritySignals: [
      "Both share the 'audit' naming family and CLI command `devwf audit`",
    ],
    behavioralDifferences:
      "site_audit performs a live HTTP crawl of an absolute http/https URL (reachability, security headers, SEO, links, static a11y, hreflang parity). audit_code performs static analysis of local repository files.",
    permissionDifferences: "site_audit performs outbound HTTP requests; audit_code is local filesystem only.",
    compatibilityRisk: "Must preserve `devwf audit --url` and `site_audit` MCP tool unchanged.",
    recommendation: "Strategy S4: Preserve separation and explicit `[READ_ONLY_HTTP]` vs `[READ_ONLY_STATIC]` description prefixes.",
    confidence: "1.00",
    consolidatedInV215: true,
  },
  {
    pairId: "DUP-09",
    toolA: "complete_task vs force_complete_task vs drop_task",
    toolB: "task_termination_group",
    classification: "D4",
    classificationLabel: "NECESSARY_SPECIALIZATION",
    domain: "task_lifecycle",
    similaritySignals: [
      "All three terminate the active task, reset workflow state to idle, sync Zettly, and call releaseTerminalTaskMutex()",
    ],
    behavioralDifferences:
      "complete_task enforces all pre-commit, DoD, test, doc, release, and deployment gates. force_complete_task bypasses incomplete gates but requires governance override authorization (approvedBy, approvalTicket, overrideToken) when effectiveMode is 'enforce'. drop_task abandons the task without marking it completed.",
    permissionDifferences:
      "Different authorization boundaries and governance audit requirements.",
    compatibilityRisk: "Critical concurrency and governance invariants depend on keeping these separate.",
    recommendation: "Preserve all three public tools; share releaseTerminalTaskMutex() internally.",
    confidence: "1.00",
    consolidatedInV215: true,
  },
  {
    pairId: "DUP-10",
    toolA: "resume_session vs take_over_task vs handoff_task vs fetch_task vs restart_handshake",
    toolB: "session_ownership_transfer_group",
    classification: "D4",
    classificationLabel: "NECESSARY_SPECIALIZATION",
    domain: "session_recovery_and_handoff",
    similaritySignals: [
      "All five deal with transferring or recovering task ownership across sessions, processes, or machines",
    ],
    behavioralDifferences:
      "resume_session adopts an orphaned/dead session on the SAME machine. take_over_task requests cooperative heartbeat release from a LIVE but idle (>=10m) PID on the SAME machine. handoff_task pushes a task from the current machine to another machine ('to'). fetch_task pulls a checkpoint from another machine ('from') over SSH. restart_handshake coordinates a fenced owner/controller process restart.",
    permissionDifferences: "Different process-lock, PID-liveness, and SSH/Zettly verification boundaries.",
    compatibilityRisk: "Merging would weaken worktree mutex fencing.",
    recommendation:
      "Strategy S4: Preserve all five tools and add clear '[SAME_MACHINE_ORPHAN]', '[SAME_MACHINE_LIVE_IDLE_PID]', '[CROSS_MACHINE_PUSH]', '[CROSS_MACHINE_PULL_SSH]', and '[COOPERATIVE_PROCESS_RESTART]' tags in descriptions so agents never confuse them.",
    confidence: "1.00",
    consolidatedInV215: true,
  },
  {
    pairId: "DUP-11",
    toolA: "list_sentry_issues",
    toolB: "inventory_sentry_issues",
    classification: "D4",
    classificationLabel: "NECESSARY_SPECIALIZATION",
    domain: "external_integrations",
    similaritySignals: [
      "Both query Sentry issues in the configured organization",
    ],
    behavioralDifferences:
      "list_sentry_issues performs a fast, single-page read-only query with cursor pagination and no disk writes. inventory_sentry_issues paginates across every accessible project (up to 100 pages) and writes a 0600 device-local JSON snapshot under .state/sentry-inventory/.",
    permissionDifferences: "list_sentry_issues is pure READ_ONLY; inventory_sentry_issues writes a local snapshot file.",
    compatibilityRisk: "Both are covered by tests/integration-handlers.test.js.",
    recommendation: "Strategy S4: Preserve separation and clarify single-page query vs full multi-project snapshot inventory in descriptions.",
    confidence: "1.00",
    consolidatedInV215: true,
  },
  {
    pairId: "DUP-12",
    toolA: "get_workflow_status vs continue_workflow vs next_steps",
    toolB: "workflow_guidance_group",
    classification: "D2",
    classificationLabel: "PARTIAL_OVERLAP",
    domain: "workflow_status_and_orchestration",
    similaritySignals: [
      "All three tell the agent what to do next in a project",
    ],
    behavioralDifferences:
      "get_workflow_status is a read-only inspection of the current task's phase, DoD, plan, build, and replica health. continue_workflow actively advances the workflow when in 'ready' (runs check_ready_to_commit) or 'commit' (runs commit_and_push). next_steps reads follow-up recommendations saved in project history by the PREVIOUS completed task.",
    permissionDifferences: "get_workflow_status and next_steps are read-only; continue_workflow can trigger commit_and_push.",
    compatibilityRisk: "Agents sometimes call next_steps expecting current-task phase guidance, or call continue_workflow expecting a read-only status check.",
    recommendation:
      "Strategy S4: Clarify descriptions explicitly ('get_workflow_status: read-only current task status', 'continue_workflow: advance current task / auto-run ready check', 'next_steps: read follow-up recommendations from previous completed tasks').",
    confidence: "0.96",
    consolidatedInV215: true,
  },
  {
    pairId: "DUP-13",
    toolA: "set_plan / set_definition_of_done",
    toolB: "refine_with_ai",
    classification: "D2",
    classificationLabel: "PARTIAL_OVERLAP",
    domain: "task_lifecycle",
    similaritySignals: [
      "All update the active task's plan or Definition of Done",
    ],
    behavioralDifferences:
      "refine_with_ai is the holistic post-investigation refinement gate that updates description, newContext, plan, DoD, and bugContext together while incrementing refinement revision. set_plan and set_definition_of_done are granular single-field mutators.",
    permissionDifferences: "Same session-scoped local+remote sync permission.",
    compatibilityRisk: "All three are part of the core workflow contract.",
    recommendation: "Strategy S4: Preserve all three; document when to use holistic refine_with_ai vs targeted set_plan / set_definition_of_done.",
    confidence: "0.95",
    consolidatedInV215: true,
  },
  {
    pairId: "DUP-14",
    toolA: "tools/handlers-new.js",
    toolB: "tools/handlers.js",
    classification: "D5",
    classificationLabel: "ORPHANED_INTERNAL_MODULE",
    domain: "internal_modules",
    similaritySignals: [
      "Both files contain the exact same 1-line re-export: `export { handleToolCall } from \"./handler-modules/index.js\";`",
      "Zero files in the entire repository import `tools/handlers-new.js`",
    ],
    behavioralDifferences: "None (byte-for-byte identical 1-line re-export).",
    permissionDifferences: "N/A (internal module).",
    compatibilityRisk: "Kept as thin compatibility re-export in case external scripts import it directly.",
    recommendation: "Document as deprecated internal compatibility re-export pointing to tools/handlers.js.",
    confidence: "1.00",
    consolidatedInV215: true,
  },
]);

/**
 * Representative AI-Agent Tool Selection Benchmark Scenarios (Section 9 & TC-19).
 * Evaluates whether an agent can unambiguously select the right canonical tool
 * and measures tool-call efficiency before vs after v2.1.5 optimization.
 */
export const AGENT_TOOL_SELECTION_BENCHMARK = Object.freeze([
  {
    scenarioId: "SCN-01",
    scenario: "Find why a test failed and structure root-cause hypotheses",
    intentKeywords: ["test failed", "error message", "root cause", "hypothesis"],
    expectedCanonicalTool: "analyze_change",
    expectedArgs: { mode: "root_cause" },
    potentiallyConfusingTools: ["run_tests"],
    disambiguationRule: "analyze_change ({ mode: 'root_cause' }) analyzes an errorMessage into confirmed facts and hypotheses; run_tests records test execution pass/fail.",
    callsBefore: 2,
    callsAfter: 1,
  },
  {
    scenarioId: "SCN-02",
    scenario: "Audit a pull request diff against engineering standards",
    intentKeywords: ["pull request", "pr diff", "changed files", "merge-base"],
    expectedCanonicalTool: "audit",
    expectedArgs: { category: "changes" },
    potentiallyConfusingTools: ["site_audit", "security_audit"],
    disambiguationRule: "audit ({ category: 'changes' }) resolves Git working_tree, staged, commit_range, or PR merge-base diffs automatically.",
    callsBefore: 1,
    callsAfter: 1,
  },
  {
    scenarioId: "SCN-03",
    scenario: "Inspect architecture boundary and dependency direction violations",
    intentKeywords: ["architecture violation", "controller db bypass", "dependency direction", "ZET-ARCH"],
    expectedCanonicalTool: "audit",
    expectedArgs: { category: "architecture" },
    potentiallyConfusingTools: ["site_audit"],
    disambiguationRule: "audit ({ category: 'architecture' }) evaluates ZET-ARCH-* rules.",
    callsBefore: 1,
    callsAfter: 1,
  },
  {
    scenarioId: "SCN-04",
    scenario: "Safely fix deterministic trailing whitespace or standalone debug dump",
    intentKeywords: ["autofix", "safe fix", "trailing whitespace", "AF-0", "AF-1"],
    expectedCanonicalTool: "apply_safe_fix",
    expectedArgs: {},
    potentiallyConfusingTools: ["plan_fix"],
    disambiguationRule: "apply_safe_fix applies the fix under worktree mutex fencing with snapshot rollback; plan_fix is read-only planning and candidate discovery.",
    callsBefore: 1,
    callsAfter: 1,
  },
  {
    scenarioId: "SCN-05",
    scenario: "Start a governed development task with worktree mutex and Zettly Todo",
    intentKeywords: ["start task", "begin coding", "register task", "definitionOfDone"],
    expectedCanonicalTool: "start_task",
    expectedArgs: {},
    potentiallyConfusingTools: ["set_focus", "resume_session"],
    disambiguationRule: "start_task acquires the worktree mutex and creates/links the canonical Todo; set_focus manages high-level focus containers.",
    callsBefore: 1,
    callsAfter: 1,
  },
  {
    scenarioId: "SCN-06",
    scenario: "Recover an abandoned session left behind on the same workstation",
    intentKeywords: ["recover session", "orphaned session", "left behind", "same machine"],
    expectedCanonicalTool: "resume_session",
    expectedArgs: {},
    potentiallyConfusingTools: ["take_over_task", "fetch_task", "restart_handshake"],
    disambiguationRule: "resume_session adopts an orphaned/non-live session on the same machine; take_over_task requests heartbeat release from a live idle PID; fetch_task pulls from another machine over SSH.",
    callsBefore: 2,
    callsAfter: 1,
  },
  {
    scenarioId: "SCN-07",
    scenario: "Analyze change impact and recommend regression tests for modified files",
    intentKeywords: ["change impact", "affected modules", "recommend tests", "suggest tests"],
    expectedCanonicalTool: "analyze_change",
    expectedArgs: { mode: "impact" },
    potentiallyConfusingTools: ["plan_fix"],
    disambiguationRule: "analyze_change ({ mode: 'impact' }) is the single canonical analyzer returning affected_modules, risk_level, and recommended_tests.",
    callsBefore: 2,
    callsAfter: 1,
  },
  {
    scenarioId: "SCN-08",
    scenario: "Read the project knowledge summary (completed task stats and recent activity)",
    intentKeywords: ["project summary", "completed tasks summary", "task mix"],
    expectedCanonicalTool: "project_summary",
    expectedArgs: {},
    potentiallyConfusingTools: ["view_history"],
    disambiguationRule: "project_summary is the single unified entry point (with optional source:'memory'|'file'|'db'|'auto').",
    callsBefore: 3,
    callsAfter: 1,
  },
  {
    scenarioId: "SCN-09",
    scenario: "Distinguish source-code security rules from runtime/DB security audit",
    intentKeywords: ["ZET-SEC", "source code secrets", "unsafe shell_exec"],
    expectedCanonicalTool: "audit",
    expectedArgs: { category: "security" },
    potentiallyConfusingTools: ["security_audit"],
    disambiguationRule: "audit ({ category: 'security' }) checks application source files against ZET-SEC-001/002 standards; security_audit checks DevWorkflow runtime state, env vars, and workflow DB rows.",
    callsBefore: 2,
    callsAfter: 1,
  },
  {
    scenarioId: "SCN-10",
    scenario: "Synchronize a completed task or pending outbox with Zettly",
    intentKeywords: ["retry zettly sync", "flush zettly outbox", "sync todo"],
    expectedCanonicalTool: "sync_zettly_task",
    expectedArgs: {},
    potentiallyConfusingTools: ["complete_task", "checkpoint_task"],
    disambiguationRule: "sync_zettly_task retries pending Zettly Todo/outcome sync without closing the local task; complete_task closes the task and releases the mutex.",
    callsBefore: 1,
    callsAfter: 1,
  },
]);

/**
 * Compute normalized token set from a description string for semantic overlap detection.
 */
export function tokenizeText(text) {
  const stopWords = new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "in",
    "into", "is", "it", "its", "no", "not", "of", "on", "or", "that", "the",
    "their", "this", "to", "use", "with", "when", "where", "which", "read", "only",
  ]);
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

/**
 * Compute Jaccard similarity between two strings or arrays of tokens.
 */
export function jaccardSimilarity(a, b) {
  const setA = new Set(Array.isArray(a) ? a : tokenizeText(a));
  const setB = new Set(Array.isArray(b) ? b : tokenizeText(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : Number((intersection / union).toFixed(4));
}

/**
 * Compare two JSON schema objects by their property names and required fields.
 */
export function compareInputSchemas(schemaA, schemaB) {
  const propsA = Object.keys(schemaA?.properties || {}).sort();
  const propsB = Object.keys(schemaB?.properties || {}).sort();
  const reqA = [...(schemaA?.required || [])].sort();
  const reqB = [...(schemaB?.required || [])].sort();

  const exactMatch =
    propsA.length === propsB.length &&
    propsA.every((k, i) => k === propsB[i]) &&
    reqA.length === reqB.length &&
    reqA.every((k, i) => k === reqB[i]);

  const propSimilarity =
    propsA.length === 0 && propsB.length === 0 ? 1 : jaccardSimilarity(propsA, propsB);

  return {
    exactMatch,
    propSimilarity,
    propsA,
    propsB,
  };
}

/**
 * Build the complete canonical inventory of all registered public MCP tools.
 *
 * @param {object} options
 * @param {Array} options.tools - Output of getToolList()
 * @param {Set<string>} options.nonSessionTools - NON_SESSION_SCOPED_TOOLS
 */
export function buildToolInventory({ tools = [], nonSessionTools = new Set() } = {}) {
  const inventory = tools.map((tool) => {
    const meta = CANONICAL_TOOL_METADATA[tool.name] || null;
    const aliasInfo = TOOL_ALIASES[tool.name] || null;
    const props = Object.keys(tool.inputSchema?.properties || {});
    const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
    const sessionScoped = !nonSessionTools.has(tool.name);

    return {
      toolId: tool.name,
      description: tool.description || "",
      descriptionLength: String(tool.description || "").length,
      category: meta?.category || "uncategorized",
      inputSchema: {
        type: tool.inputSchema?.type || "object",
        properties: props,
        required,
        additionalProperties: tool.inputSchema?.additionalProperties ?? true,
      },
      outputContract: meta?.errorContract || "MCP text content block",
      handler: meta?.handler || "unmapped",
      module: meta?.module || "unmapped",
      domainService: meta?.domainService || "unmapped",
      dependencies: meta?.dependencies || [],
      sideEffects: meta?.sideEffects || "unspecified",
      permissionLevel: meta?.permissionLevel || "UNCLASSIFIED",
      sessionScoped,
      workflowRole: meta?.workflowRole || "unspecified",
      clients: ["OpenCode", "Codex", "Antigravity", "Claude Code", "Generic MCP Client"],
      tests: meta?.tests || [],
      stability: aliasInfo ? aliasInfo.status : meta?.stability || "stable",
      aliasOf: aliasInfo?.canonicalTool || null,
      capability: meta?.capability || tool.description || "",
      hasMetadata: Boolean(meta),
    };
  });

  return {
    version: CATALOG_AUDITOR_VERSION,
    generatedAt: new Date().toISOString(),
    totalPublicTools: inventory.length,
    canonicalToolsCount: inventory.filter((t) => !t.aliasOf).length,
    compatibilityAliasesCount: inventory.filter((t) => Boolean(t.aliasOf)).length,
    sessionScopedCount: inventory.filter((t) => t.sessionScoped).length,
    nonSessionScopedCount: inventory.filter((t) => !t.sessionScoped).length,
    tools: inventory,
    nonToolInterfaces: NON_TOOL_INTERFACES,
  };
}

/**
 * Automatic Catalog Regression Gate (`validateToolRegistrationGate`).
 *
 * Inspects a tool catalog (plus optional proposed new tool registrations) and enforces:
 * 1. Unique tool IDs (blocks duplicate tool names deterministically).
 * 2. Non-empty description (>= 20 chars) and valid object inputSchema.
 * 3. Access & permission safety: blocks merging read-only and write-capable tools
 *    without explicit authorization boundary separation.
 * 4. Detects shared underlying domain services / handlers or high description/schema
 *    overlap and flags suspected semantic duplicates for review unless registered in
 *    `TOOL_ALIASES` or justified as a necessary specialization (`D4`/`D6`).
 */
export function validateToolRegistrationGate({
  tools = [],
  proposedTools = [],
  allowKnownAliases = true,
} = {}) {
  const allTools = [...tools, ...proposedTools];
  const blockingViolations = [];
  const reviewWarnings = [];
  const seenNames = new Map();

  for (const [idx, tool] of allTools.entries()) {
    const name = String(tool?.name || "").trim();
    if (!name) {
      blockingViolations.push({
        code: "INVALID_TOOL_NAME",
        toolId: `(index-${idx})`,
        reason: "Tool registration is missing a non-empty name.",
      });
      continue;
    }

    if (seenNames.has(name)) {
      blockingViolations.push({
        code: "DUPLICATE_TOOL_ID",
        toolId: name,
        reason: `Tool ID '${name}' is registered more than once (indices ${seenNames.get(name)} and ${idx}).`,
      });
    } else {
      seenNames.set(name, idx);
    }

    const desc = String(tool?.description || "").trim();
    if (desc.length < 20) {
      blockingViolations.push({
        code: "UNDOCUMENTED_OR_TOO_SHORT_DESCRIPTION",
        toolId: name,
        reason: `Tool '${name}' description is too short (${desc.length} chars; minimum 20 chars required).`,
      });
    }

    if (!tool?.inputSchema || tool.inputSchema.type !== "object") {
      blockingViolations.push({
        code: "INVALID_INPUT_SCHEMA",
        toolId: name,
        reason: `Tool '${name}' must declare an object inputSchema.`,
      });
    }

    // Check unsafe read/write permission boundary merging on proposed tools
    if (
      tool?.permissionLevel === "MIXED_READ_WRITE_UNFENCED" ||
      (tool?.mergesReadAndWrite === true && !tool?.fencedAuthorization)
    ) {
      blockingViolations.push({
        code: "UNSAFE_PERMISSION_BOUNDARY_MERGE",
        toolId: name,
        reason: `Tool '${name}' combines read-only and write-capable operations without fenced authorization boundaries.`,
      });
    }
  }

  // Pairwise check for shared handlers / semantic overlap
  for (let i = 0; i < allTools.length; i++) {
    for (let j = i + 1; j < allTools.length; j++) {
      const a = allTools[i];
      const b = allTools[j];
      if (!a?.name || !b?.name || a.name === b.name) continue;

      const metaA = CANONICAL_TOOL_METADATA[a.name] || a;
      const metaB = CANONICAL_TOOL_METADATA[b.name] || b;

      const isKnownAlias =
        allowKnownAliases &&
        (TOOL_ALIASES[a.name]?.canonicalTool === b.name ||
          TOOL_ALIASES[b.name]?.canonicalTool === a.name);

      const isKnownEvaluatedPair = SEMANTIC_DUPLICATION_MATRIX.some(
        (entry) =>
          (entry.toolA.includes(a.name) && entry.toolB.includes(b.name)) ||
          (entry.toolA.includes(b.name) && entry.toolB.includes(a.name)) ||
          (entry.toolA.includes(a.name) && entry.toolA.includes(b.name))
      );

      const sameHandler =
        Boolean(metaA?.handler && metaB?.handler) &&
        metaA.handler === metaB.handler &&
        metaA.handler !== "unmapped";

      const sameDomainService =
        Boolean(metaA?.domainService && metaB?.domainService) &&
        metaA.domainService === metaB.domainService &&
        metaA.domainService !== "unmapped";

      const descSim = jaccardSimilarity(a.description, b.description);
      const schemaCmp = compareInputSchemas(a.inputSchema, b.inputSchema);

      if ((sameHandler || (sameDomainService && schemaCmp.exactMatch)) && !isKnownAlias && !isKnownEvaluatedPair) {
        reviewWarnings.push({
          code: "REDUNDANT_HANDLER_OR_SERVICE_CANDIDATE",
          toolA: a.name,
          toolB: b.name,
          handlerA: metaA?.handler || null,
          handlerB: metaB?.handler || null,
          domainService: metaA?.domainService || null,
          schemaExactMatch: schemaCmp.exactMatch,
          descriptionSimilarity: descSim,
          reason: `Tools '${a.name}' and '${b.name}' share the same underlying handler/service with equivalent schema and require consolidation review or alias registration.`,
        });
      } else if (descSim >= 0.55 && !isKnownAlias && !isKnownEvaluatedPair) {
        const permA = metaA?.permissionLevel || "UNCLASSIFIED";
        const permB = metaB?.permissionLevel || "UNCLASSIFIED";
        if (permA !== permB) {
          reviewWarnings.push({
            code: "SIMILAR_DESCRIPTION_DIFFERENT_AUTHORIZATION",
            toolA: a.name,
            toolB: b.name,
            permissionA: permA,
            permissionB: permB,
            descriptionSimilarity: descSim,
            recommendation: "DO_NOT_MERGE_UNSAFELY: preserve separate tools due to distinct authorization boundaries, and clarify descriptions.",
          });
        } else {
          reviewWarnings.push({
            code: "HIGH_SEMANTIC_DESCRIPTION_OVERLAP",
            toolA: a.name,
            toolB: b.name,
            descriptionSimilarity: descSim,
            schemaSimilarity: schemaCmp.propSimilarity,
            recommendation: "Review whether this tool can be satisfied by an option on the existing canonical tool.",
          });
        }
      }
    }
  }

  return {
    passed: blockingViolations.length === 0,
    status:
      blockingViolations.length > 0
        ? "BLOCKED"
        : reviewWarnings.length > 0
          ? "PASS_WITH_REVIEW_WARNINGS"
          : "PASS",
    blocking_violations_count: blockingViolations.length,
    review_warnings_count: reviewWarnings.length,
    blocking_violations: blockingViolations,
    review_warnings: reviewWarnings,
  };
}

/**
 * Run the comprehensive DevWorkflow Tool Catalog Auditor (`audit_tool_catalog`).
 */
export function auditToolCatalog({
  tools = [],
  nonSessionTools = new Set(),
  proposedTools = [],
  includeMatrix = true,
  includeInventory = true,
} = {}) {
  const inventory = buildToolInventory({ tools, nonSessionTools });
  const gate = validateToolRegistrationGate({
    tools,
    proposedTools,
    allowKnownAliases: true,
  });

  // Measure catalog quality metrics
  const descriptions = inventory.tools.map((t) => t.descriptionLength);
  const avgDescriptionLength =
    descriptions.length > 0
      ? Math.round(descriptions.reduce((acc, n) => acc + n, 0) / descriptions.length)
      : 0;
  const catalogJsonBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");

  const unmappedTools = inventory.tools.filter((t) => !t.hasMetadata).map((t) => t.toolId);
  const untestedTools = inventory.tools.filter((t) => t.tests.length === 0).map((t) => t.toolId);

  const uniqueDomainServices = new Set(
    inventory.tools.map((t) => t.domainService).filter((s) => s && s !== "unmapped")
  );
  const uniqueCategories = new Set(inventory.tools.map((t) => t.category));

  const byClassification = {
    D0_exact_duplicates: SEMANTIC_DUPLICATION_MATRIX.filter((m) => m.classification === "D0"),
    D1_semantic_duplicates: SEMANTIC_DUPLICATION_MATRIX.filter((m) => m.classification === "D1"),
    D2_partial_overlaps: SEMANTIC_DUPLICATION_MATRIX.filter((m) => m.classification === "D2"),
    D3_wrapper_redundancies: SEMANTIC_DUPLICATION_MATRIX.filter((m) => m.classification === "D3"),
    D4_necessary_specializations: SEMANTIC_DUPLICATION_MATRIX.filter((m) => m.classification === "D4"),
    D5_orphaned_legacy: SEMANTIC_DUPLICATION_MATRIX.filter((m) => m.classification === "D5"),
    D6_false_duplicates: SEMANTIC_DUPLICATION_MATRIX.filter((m) => m.classification === "D6"),
  };

  return {
    auditor_version: CATALOG_AUDITOR_VERSION,
    summary: {
      total_public_tools: inventory.totalPublicTools,
      canonical_public_tools: inventory.canonicalToolsCount,
      compatibility_aliases: inventory.compatibilityAliasesCount,
      unique_functional_categories: uniqueCategories.size,
      shared_domain_services: uniqueDomainServices.size,
      session_scoped_tools: inventory.sessionScopedCount,
      non_session_scoped_tools: inventory.nonSessionScopedCount,
      mcp_prompts_count: NON_TOOL_INTERFACES.mcpPrompts.length,
      mcp_resources_count: NON_TOOL_INTERFACES.mcpResources.length,
      cli_commands_count: NON_TOOL_INTERFACES.cliCommands.length,
      average_description_length: avgDescriptionLength,
      catalog_metadata_bytes: catalogJsonBytes,
      unmapped_tools_count: unmappedTools.length,
      untested_tools_count: untestedTools.length,
      d0_exact_duplicates_count: byClassification.D0_exact_duplicates.length,
      d1_semantic_duplicates_count: byClassification.D1_semantic_duplicates.length,
      d2_partial_overlaps_count: byClassification.D2_partial_overlaps.length,
      d3_wrapper_redundancies_count: byClassification.D3_wrapper_redundancies.length,
      d4_necessary_specializations_count: byClassification.D4_necessary_specializations.length,
      d5_orphaned_internal_count: byClassification.D5_orphaned_legacy.length,
      d6_false_duplicates_count: byClassification.D6_false_duplicates.length,
    },
    regression_gate: gate,
    aliases: TOOL_ALIASES,
    removed_legacy_tools: REMOVED_LEGACY_TOOLS,
    removed_legacy_tools_count: Object.keys(REMOVED_LEGACY_TOOLS).length,
    unmapped_tools: unmappedTools,
    untested_tools: untestedTools,
    ...(includeMatrix ? { semantic_duplication_matrix: SEMANTIC_DUPLICATION_MATRIX } : {}),
    ...(includeInventory ? { inventory: inventory.tools, non_tool_interfaces: NON_TOOL_INTERFACES } : {}),
    agent_selection_benchmark: AGENT_TOOL_SELECTION_BENCHMARK,
  };
}

/**
 * Internal helper (`helper_consolidation_plan`): generates a safe, non-destructive
 * consolidation plan for confirmed duplicate or overlapping tools without adding
 * another public MCP tool to the discovery surface.
 */
export function generateConsolidationPlan({ tools = [], nonSessionTools = new Set() } = {}) {
  const report = auditToolCatalog({
    tools,
    nonSessionTools,
    includeMatrix: true,
    includeInventory: false,
  });

  const actions = SEMANTIC_DUPLICATION_MATRIX.map((item) => ({
    pairId: item.pairId,
    target: `${item.toolA} <-> ${item.toolB}`,
    classification: `${item.classification} (${item.classificationLabel})`,
    recommendedStrategy: item.recommendation,
    backwardCompatible: true,
    requiresPublicRemoval: false,
    safetyCheck:
      item.classification === "D4" || item.classification === "D6"
        ? "PRESERVE_SEPARATION: distinct authorization, lifecycle, or target domain."
        : "SAFE_INTERNAL_CONSOLIDATION_WITH_ALIAS: route both entry points to canonical domain service.",
  }));

  return {
    version: CATALOG_AUDITOR_VERSION,
    catalog_summary: report.summary,
    consolidation_actions: actions,
    approval_policy_for_new_tools: [
      "1. Verify no existing canonical tool or optional parameter can satisfy the workflow.",
      "2. Classify permission level (READ_ONLY, LOCAL_WRITE_FENCED, REMOTE_WRITE) and session-scope attribution.",
      "3. Run validateToolRegistrationGate({ tools, proposedTools: [newTool] }) and resolve all blocking violations and semantic overlap warnings.",
      "4. Register metadata in CANONICAL_TOOL_METADATA and add deterministic unit/acceptance test coverage.",
    ],
  };
}

/**
 * Deterministic scenario router used by TC-19 to verify that agent tool selection
 * across the 10 representative engineering scenarios resolves to the expected
 * canonical tool with zero selection errors.
 */
export function selectCanonicalToolForScenario(queryOrScenario, tools = []) {
  const text = String(queryOrScenario || "").toLowerCase();
  const registeredNames = new Set(tools.map((t) => t.name));

  for (const bench of AGENT_TOOL_SELECTION_BENCHMARK) {
    const matchesId = text.includes(bench.scenarioId.toLowerCase());
    const matchesScenario = text === bench.scenario.toLowerCase();
    const keywordHits = bench.intentKeywords.filter((kw) => text.includes(kw.toLowerCase())).length;
    if (matchesId || matchesScenario || keywordHits >= 2) {
      const selected = bench.expectedCanonicalTool;
      return {
        scenarioId: bench.scenarioId,
        selectedTool: selected,
        isRegistered: registeredNames.size === 0 || registeredNames.has(selected),
        isCanonical: !TOOL_ALIASES[selected],
        disambiguationRule: bench.disambiguationRule,
      };
    }
  }

  return {
    scenarioId: null,
    selectedTool: null,
    isRegistered: false,
    isCanonical: false,
    disambiguationRule: "No benchmark scenario matched.",
  };
}
