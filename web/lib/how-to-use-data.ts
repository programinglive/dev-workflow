export interface OnboardingStep {
  step: number;
  slug: string;
  title: string;
  shortTitle: string;
  summary: string;
  actor: "Developer (CLI)" | "AI Agent (MCP)" | "Client Config" | "DevWorkflow Runtime";
  explanation: string[];
  command?: string;
  expectedOutput?: string;
  codeSample?: string;
  codeTitle?: string;
  tips?: string[];
}

export interface RoleComparison {
  component: string;
  primaryActor: string;
  howItRuns: string;
  keyResponsibilities: string[];
  exampleOperations: string[];
}

export interface OptionalIntegration {
  name: string;
  badge: string;
  summary: string;
  standaloneNote: string;
  setupCommands: string;
  verificationCommands: string;
  benefits: string[];
}

export const HOW_TO_USE_STEPS: OnboardingStep[] = [
  {
    step: 1,
    slug: "install-npm",
    title: "1. Install DevWorkflow from npm",
    shortTitle: "Install CLI",
    summary: "Install the published @programinglive/dev-workflow package globally using standard npm.",
    actor: "Developer (CLI)",
    explanation: [
      "DevWorkflow is distributed publicly on npm as an MIT-licensed package. You do not need private repository access, deploy tokens, or external accounts to install or run the core tools.",
      "Requires Node.js >= 20.0.0. The global installation provides both the `devwf` command-line executable and the headless MCP server entry point.",
    ],
    command: "npm install -g @programinglive/dev-workflow",
    expectedOutput: `+ @programinglive/dev-workflow@3.1.2
added 1 package in 2.4s`,
    tips: [
      "Ensure Node.js 20 or newer is in your PATH (`node --version`).",
      "You can also run without global installation using `npx @programinglive/dev-workflow <command>`.",
    ],
  },
  {
    step: 2,
    slug: "run-setup-and-diagnostics",
    title: "2. Run Setup and System Diagnostics",
    shortTitle: "Setup & Doctor",
    summary: "Initialize your standalone local-first configuration and verify that Node, Git, and SQLite storage are healthy.",
    actor: "Developer (CLI)",
    explanation: [
      "`devwf setup` initializes your local profile in `~/.devworkflow/` (or `DEVWF_PROFILE_DIR`). By default, it selects the standalone mode with zero external services.",
      "`devwf doctor` checks runtime prerequisites: Node.js version, Git binary, SQLite WAL capabilities, file system permissions, and optional integration statuses.",
    ],
    command: `devwf setup
devwf doctor`,
    expectedOutput: `[setup] Mode: LOCAL_FIRST_STANDALONE
[setup] Profile directory initialized: ~/.devworkflow
[setup] Storage: SQLite WAL local persistence ready

[doctor] Node.js: v22.23.4 (>=20.0.0 required) - OK
[doctor] Git: git version 2.47.1 - OK
[doctor] Storage: SQLite WAL mode enabled - OK
[doctor] Security mode: strict - OK
[doctor] Environment: Standalone local-first (0 cloud dependencies)
All core health checks PASSED.`,
    tips: [
      "If you want to explicitly avoid prompts about optional Zettly integration on setup, run `devwf setup --skip-zettly`.",
      "Add `--json` to `devwf doctor` for machine-parseable output in CI/CD scripts.",
    ],
  },
  {
    step: 3,
    slug: "connect-coding-agent",
    title: "3. Choose and Connect an MCP-Compatible Coding Agent",
    shortTitle: "Connect Agent",
    summary: "Configure your preferred AI coding client (Claude Code, OpenCode, Codex, or Antigravity) to communicate with DevWorkflow over stdio.",
    actor: "Client Config",
    explanation: [
      "DevWorkflow implements the standard Model Context Protocol (MCP) server over standard input/output (stdio).",
      "Any AI assistant supporting MCP can register DevWorkflow as a tool provider. Configure the client to execute `npx -y @programinglive/dev-workflow` or `node /path/to/dev-workflow/index.js`.",
    ],
    codeTitle: "Client Configuration Examples",
    codeSample: `// OpenCode (~/.config/opencode/opencode.json)
{
  "mcp": {
    "dev-workflow": {
      "type": "local",
      "command": ["npx", "-y", "@programinglive/dev-workflow"],
      "enabled": true
    }
  }
}

// Claude Code (~/.claude/claude_desktop_config.json)
{
  "mcpServers": {
    "dev-workflow": {
      "command": "npx",
      "args": ["-y", "@programinglive/dev-workflow"]
    }
  }
}

// Antigravity IDE (Settings -> MCP Servers)
{
  "name": "dev-workflow",
  "command": "devwf",
  "args": ["mcp"],
  "env": { "DEVWF_SECURITY_MODE": "strict" }
}`,
    tips: [
      "If you installed globally via npm, you can use `devwf` with args `['mcp']` or run `npx @programinglive/dev-workflow` directly.",
      "DevWorkflow communicates via JSON-RPC 2.0 over stdin/stdout without opening any network ports.",
    ],
  },
  {
    step: 4,
    slug: "verify-mcp-discovery",
    title: "4. Verify MCP Tool Discovery",
    shortTitle: "Verify Tools",
    summary: "Check that your AI coding client detects DevWorkflow tools and passes stdio handshake checks.",
    actor: "Developer (CLI)",
    explanation: [
      "Run `devwf fleet doctor` to inspect local client configuration files and simulate the MCP stdio handshake.",
      "This confirms that tools such as `start_task`, `create_feature_flow`, `run_tests`, and `complete_task` are visible to your agent before you begin coding.",
    ],
    command: "DEVWF_PUBLIC_LOCAL_FIRST=1 devwf fleet doctor --json",
    expectedOutput: `{
  "status": "healthy",
  "clients": [
    { "client": "opencode", "configPath": "~/.config/opencode/opencode.json", "registered": true },
    { "client": "claude", "configPath": "~/.claude/claude_desktop_config.json", "registered": true }
  ],
  "mcpStdio": {
    "handshake": "OK",
    "protocolVersion": "2024-11-05",
    "toolsDiscovered": 65
  }
}`,
    tips: [
      "In Claude Code or OpenCode, you can also type `/mcp` inside the conversation to view registered tools interactively.",
      "If tools are missing, verify that your client process was restarted after updating the configuration file.",
    ],
  },
  {
    step: 5,
    slug: "start-first-task",
    title: "5. Create and Start Your First Task",
    shortTitle: "Start Task",
    summary: "Initialize a governed task contract with a concrete scope, target repository, and initial execution plan.",
    actor: "AI Agent (MCP)",
    explanation: [
      "Instead of writing code blindly, the AI agent invokes `start_task`. This pins the session to the target git repository, creates a local SQLite state record, and starts the governance tracker.",
      "The task contract requires an English description, a task type (`feature`, `bugfix`, `refactor`, or `other`), an ordered plan, and a concrete Definition of Done.",
    ],
    codeTitle: "AI Tool Call: start_task",
    codeSample: `{
  "description": "Add email format validation to checkout registration form",
  "type": "feature",
  "projectDir": "/path/to/my-project",
  "plan": [
    "Write failing unit test for invalid email domains",
    "Implement RFC-5322 regex validator in validator.js",
    "Run unit tests and verify 100% green suite",
    "Review git diff and check commit readiness"
  ],
  "definitionOfDone": [
    "Failing test created and verified failing on invalid email inputs",
    "Validator accepts valid emails and rejects malformed addresses",
    "npm test passes 100% with no regressions"
  ]
}`,
    tips: [
      "You can also start a task from the terminal via the CLI: `devwf task create --description '...' --type feature`.",
      "DevWorkflow's guard plugin strictly blocks shell mutation tools until `start_task` is called, preventing unmanaged edits.",
    ],
  },
  {
    step: 6,
    slug: "define-scope-and-flow",
    title: "6. Define Scope, Plan, and Definition of Done",
    shortTitle: "Architect Flow",
    summary: "Record architectural data flow with Mermaid diagrams and refine task boundaries before writing any implementation.",
    actor: "AI Agent (MCP)",
    explanation: [
      "Immediately after task creation, the AI invokes `create_feature_flow` with a connected Mermaid flowchart (`flowchart TD` / `graph TD`).",
      "This architecture design gate locks scope, prevents model hallucinations, and syncs a visual diagram to the task contract. If requirements shift during exploration, call `refine_with_ai` to update the plan and criteria.",
    ],
    codeTitle: "AI Tool Call: create_feature_flow",
    codeSample: `{
  "description": "Email validation and error feedback pipeline",
  "mermaidCode": "flowchart TD\\n    FormInput[User Form Input] --> Check[RFC-5322 Email Validator]\\n    Check -->|Valid| Submit[Dispatch Registration Event]\\n    Check -->|Invalid| Error[Render Inline Form Alert]"
}`,
    tips: [
      "DevWorkflow enforces 2–12 connected nodes in feature flows to keep diagrams concise, clear, and focused.",
      "Use `set_plan` and `mark_plan_step` throughout development so observers can track step-by-step progress.",
    ],
  },
  {
    step: 7,
    slug: "execute-governed-coding",
    title: "7. Execute Coding Through the AI Agent",
    shortTitle: "Execute Code",
    summary: "Write code following strict Test-Driven Development (TDD) while protected by the pre-tool guard.",
    actor: "AI Agent (MCP)",
    explanation: [
      "The AI agent implements code inside the pinned `projectDir`. The developer and AI work together through the Red-Green-Refactor cycle: write a failing test first, implement the minimum passing logic, and refactor cleanly.",
      "The DevWorkflow guard plugin ensures that exploratory commands (`cat`, `ls`, `git diff`) and mutations (`edit`, `write`) remain bound to the active task contract.",
    ],
    command: "git status && git diff --stat",
    expectedOutput: `On branch feat/email-validation
Changes not staged for commit:
  modified:   src/validator.js
  modified:   tests/validator.test.js

2 files changed, 48 insertions(+), 3 deletions(-)`,
    tips: [
      "Always work on an isolated branch (`git checkout -b <type>/<task-slug>`) rather than dirty shared branches.",
      "Mark each plan step completed using `mark_plan_step` as you advance through the code.",
    ],
  },
  {
    step: 8,
    slug: "run-testing-and-audit",
    title: "8. Run Testing and Engineering Audits",
    shortTitle: "Test & Audit",
    summary: "Run automated test suites and invoke code quality, security, and contract audits before committing.",
    actor: "AI Agent (MCP)",
    explanation: [
      "Before changes can be committed, tests must pass. The AI invokes `run_tests` (or executes your project test runner).",
      "Next, invoke `audit` (`category: 'changes'` or `category: 'security'`) to inspect git diffs for leaked secrets, dead branches, high cyclomatic complexity, or missing error handlers.",
    ],
    codeTitle: "AI Tool Call: run_tests & audit",
    codeSample: `{
  "command": "npm test"
}

// Output:
// ✔ Validator rejects addresses without @ symbol (1.2ms)
// ✔ Validator accepts standard user@example.com (0.8ms)
// ✔ Validator handles international domain extensions (1.1ms)
// ℹ tests 14 · pass 14 · fail 0`,
    tips: [
      "Never claim tests pass without inspecting the actual command execution output.",
      "Prove your Definition of Done criteria using `mark_dod_item` with concrete command evidence.",
    ],
  },
  {
    step: 9,
    slug: "review-and-commit",
    title: "9. Review Changes and Commit",
    shortTitle: "Review & Commit",
    summary: "Perform pre-commit governance validation, verify reversibility, and commit changes with Conventional Commits.",
    actor: "AI Agent (MCP)",
    explanation: [
      "The AI calls `check_ready_to_commit`. DevWorkflow scans for open DoD items, unhandled errors, uncommitted artifacts, and reversibility dimensions.",
      "Once readiness is green, invoke `commit_and_push` with a Conventional Commit message (`feat: ...`, `fix: ...`).",
    ],
    codeTitle: "AI Tool Call: commit_and_push",
    codeSample: `{
  "commitMessage": "feat(validator): add RFC-5322 email validation to registration flow"
}

// Output:
// [feat/email-validation a1b2c3d] feat(validator): add RFC-5322 email validation
// 2 files changed, 48 insertions(+), 3 deletions(-)
// Pushed to origin/feat/email-validation`,
    tips: [
      "`check_ready_to_commit` fails closed if any Definition of Done item remains unverified.",
      "All commit messages should follow Conventional Commits formatting.",
    ],
  },
  {
    step: 10,
    slug: "complete-task",
    title: "10. Complete the Task with Verified Evidence",
    shortTitle: "Complete Task",
    summary: "Close the task, record durable verification evidence into local SQLite history, and report follow-up recommendations.",
    actor: "AI Agent (MCP)",
    explanation: [
      "Call `complete_task` with the commit message and any observed follow-up items (`nextSteps`).",
      "DevWorkflow persists the completed task into local history, updates session metrics, releases project locks, and resets the workflow for your next assignment.",
    ],
    codeTitle: "AI Tool Call: complete_task",
    codeSample: `{
  "commitMessage": "feat(validator): add RFC-5322 email validation",
  "nextSteps": [
    "Consider adding MX DNS record pre-validation in the backend service",
    "Update user onboarding documentation with new email formats"
  ]
}

// Output:
// ✅ Task completed successfully!
// Outcome saved to local SQLite history (~/.devworkflow/history.sqlite3)
// Workflow state reset to idle. Ready for next task.`,
    tips: [
      "View past task outcomes anytime with `devwf list` or `get_workflow_status`.",
      "Follow-up items recorded in `nextSteps` are readable later via `next_steps`.",
    ],
  },
];

export const ROLE_COMPARISON_TABLE: RoleComparison[] = [
  {
    component: "DevWorkflow CLI (`devwf`)",
    primaryActor: "Developer / Terminal / CI",
    howItRuns: "Direct command-line executable (`bin/cli.js`), shell scripts, or CI/CD pipelines.",
    keyResponsibilities: [
      "Environment setup & configuration (`setup`, `doctor`)",
      "Fleet diagnostics across multiple AI client configs (`fleet doctor`)",
      "Session inspection, share token generation, and manual task administration (`list`, `close`, `drop`)",
      "Optional service integration management (`zettly connect`, `pair`)",
    ],
    exampleOperations: ["devwf setup", "devwf doctor", "devwf fleet doctor --json", "devwf list"],
  },
  {
    component: "DevWorkflow MCP Server",
    primaryActor: "AI Assistant (Automated)",
    howItRuns: "JSON-RPC 2.0 stdio server (`index.js`) spawned directly by coding clients.",
    keyResponsibilities: [
      "Task contracts, plans, and Definition of Done gates (`start_task`, `set_plan`, `mark_dod_item`)",
      "Architecture diagram recording and visual flow sync (`create_feature_flow`)",
      "Quality enforcement, test execution, and code auditing (`run_tests`, `audit`, `code_context`)",
      "Release locking, pre-commit readiness checks, and task completion (`check_ready_to_commit`, `complete_task`)",
    ],
    exampleOperations: ["start_task", "create_feature_flow", "run_tests", "complete_task"],
  },
  {
    component: "External AI Coding Client",
    primaryActor: "Claude Code / OpenCode / Codex / Antigravity",
    howItRuns: "Interactive developer UI or terminal agent running model reasoning and tool dispatch.",
    keyResponsibilities: [
      "Code generation, file editing, and test authoring based on developer prompts",
      "Dispatching DevWorkflow MCP tool calls in adherence with system rules",
      "Analyzing test output, error traces, and git diffs during development",
      "Explaining decisions and proposing follow-up recommendations to human developer",
    ],
    exampleOperations: ["Read instructions", "Write test cases", "Call start_task", "Propose git commits"],
  },
  {
    component: "DevWorkflow Runtime & Storage",
    primaryActor: "Local OS Kernel / SQLite Engine",
    howItRuns: "Embedded SQLite WAL databases and process-level file mutexes on the local machine.",
    keyResponsibilities: [
      "Local-first atomic persistence of task states, plans, and DoD checklists",
      "Process concurrency fencing to prevent split-brain edits on the same worktree",
      "Durable history logging across machine restarts with zero cloud database dependency",
      "Pre-tool guard plugin enforcement to prevent unmanaged bash or file mutation",
    ],
    exampleOperations: ["~/.devworkflow/history.sqlite3", "Kernel mutex locks", "Pre-tool execution guards"],
  },
];

export const OPTIONAL_INTEGRATIONS_DATA: OptionalIntegration[] = [
  {
    name: "Zettly Integration",
    badge: "Optional · Planning & Retrospectives",
    summary:
      "Connect DevWorkflow to your self-hosted or cloud Zettly workspace to synchronize Todos, Eisenhower priority queues, visual Draw canvases, and daily engineering journal outcomes.",
    standaloneNote:
      "DevWorkflow is 100% functional without Zettly. No account, PocketBase store, or token is required for local-first standalone operations.",
    setupCommands: `# Check current connection status
devwf zettly status --json

# Connect securely using hidden token stdin (never pass raw tokens on CLI args)
printf '%s' "$ZETTLY_API_TOKEN" | devwf zettly connect --url https://your-zettly.example --token-stdin

# Switch accounts or disconnect cleanly
devwf zettly disconnect --confirm`,
    verificationCommands: "devwf zettly doctor --json",
    benefits: [
      "Synchronizes active tasks with Zettly Today and Priority Queue (/priority)",
      "Syncs architecture diagrams from create_feature_flow to Zettly Draw canvases",
      "Records completed task summaries into daily engineering activity journal",
      "Enforces Eisenhower / Pareto 80/20 prioritization across multiple projects",
    ],
  },
  {
    name: "DevWorkflow Android Companion",
    badge: "Optional · Mobile Engineering Cockpit",
    summary:
      "Pair an Android tablet or phone running the DevWorkflow Companion app (com.programinglive.devwfmonitor) to monitor active AI sessions, build progress, and fleet convergence on a secondary screen.",
    standaloneNote:
      "The Android Companion is completely optional. Terminal and browser interfaces provide full operational oversight on any desktop OS.",
    setupCommands: `# Generate an encrypted pairing challenge QR / code for your Android device
devwf pair --url http://your-monitor-host:3100 --json`,
    verificationCommands: "devwf doctor --json",
    benefits: [
      "Real-time session monitor showing active coding tasks, DoD status, and plan steps",
      "Live build and test suite execution progress indicators with background alerts",
      "Fleet status view showing connected machines (workstation, laptop, server)",
      "Zero interference with local coding: companion runs in read-only telemetry mode",
    ],
  },
  {
    name: "Zettly Code v1.0 (Persistent Code Memory)",
    badge: "Optional · Private / Local Knowledge Graph",
    summary:
      "Connect the optional Zettly Code engine via DevWorkflow's canonical `code_index` and `code_context` MCP tools to maintain a local SQLite WAL source-code knowledge graph and enforce mandatory `@zettly-code` bug-fix knowledge comments.",
    standaloneNote:
      "Zettly Code is maintained in a private repository and resolved optionally at runtime. DevWorkflow's public npm package works 100% standalone without it.",
    setupCommands: `# Optional: point DevWorkflow to a local Zettly Code checkout
export ZETTLY_CODE_MODULE_PATH="/path/to/zettly-code/src/index.js"`,
    verificationCommands: "code_index ({ mode: 'status' })",
    benefits: [
      "Incremental SQLite WAL knowledge graph with revision-aware freshness checks",
      "Bounded `code_context` retrieval (debug, symbol, dependencies, callers, tests, impact, history)",
      "Enforces `@zettly-code` bug-fix comments via `audit({ category: 'bugfix_knowledge' })`",
      "Strict workspace containment and secret/PII redaction",
    ],
  },
];

export const ZETTLY_CODE_DEBUGGING_JOURNEY: OnboardingStep[] = [
  {
    step: 1,
    slug: "zc-start-bugfix",
    title: "1. Start Bug-Fix Task",
    shortTitle: "Start Bugfix",
    summary: "Open a governed bug-fix task with `start_task` (`type: 'bugfix'`) and concrete Definition of Done.",
    actor: "AI Agent (MCP)",
    explanation: ["Pin the target repository and declare the bug reproduction and regression test criteria."],
    codeSample: `// AI Tool Call: start_task
{ "description": "Fix negative invoice discount calculation", "type": "bugfix", "projectDir": "/path/to/repo" }`,
  },
  {
    step: 2,
    slug: "zc-query-context",
    title: "2. Query `code_context` Before Scanning Files",
    shortTitle: "Query Context",
    summary: "Retrieve relevant symbols, invariants, past bug fixes, and covering tests from the knowledge graph.",
    actor: "AI Agent (MCP)",
    explanation: ["Avoid blind full-repository grep by querying persistent code memory first."],
    codeSample: `// AI Tool Call: code_context
{ "mode": "debug", "query": "calculateInvoice" }`,
  },
  {
    step: 3,
    slug: "zc-check-freshness",
    title: "3. Check `code_index` Freshness",
    shortTitle: "Check Index",
    summary: "Verify the local SQLite knowledge graph is fresh or incrementally update changed files.",
    actor: "AI Agent (MCP)",
    explanation: ["Run `code_index` with `mode: 'status'` or `mode: 'update'` so graph edges match current HEAD."],
    codeSample: `// AI Tool Call: code_index
{ "mode": "status" }`,
  },
  {
    step: 4,
    slug: "zc-fix-and-document",
    title: "4. Fix, Test & Add `@zettly-code` Knowledge Comment",
    shortTitle: "Fix & Annotate",
    summary: "Apply the minimal verified fix, run regression tests, and record `@purpose`, `@bug-fix`, `@root-cause` (or `@hypothesis`), and `@fix`.",
    actor: "AI Agent (MCP)",
    explanation: ["Every verified bug fix leaves behind traceable knowledge for future debugging sessions."],
    codeSample: `/**
 * @zettly-code ZC-BILLING-001
 * @purpose Calculate monthly invoice amount safely
 * @bug-fix BUG-1001
 * @root-cause Unclamped discount produced negative invoice totals
 * @fix Clamped discount to subtotal maximum
 * @tests billing.test.js
 */`,
  },
  {
    step: 5,
    slug: "zc-refresh-and-gate",
    title: "5. Refresh Index & Pass `bugfix_knowledge` Audit",
    shortTitle: "Verify Gate",
    summary: "Incrementally update the index and verify the mandatory bug-fix knowledge gate before closing.",
    actor: "AI Agent (MCP)",
    explanation: ["Run `code_index({ mode: 'update' })` followed by `audit({ category: 'bugfix_knowledge' })`, then close with `complete_task`."],
    codeSample: `// AI Tool Call: audit
{ "category": "bugfix_knowledge", "files": ["src/billing.js"], "taskType": "BUG_FIX", "bugId": "BUG-1001" }`,
  },
];
