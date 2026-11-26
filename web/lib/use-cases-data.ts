export type Difficulty = "Beginner" | "Intermediate" | "Advanced";
export type UseCaseCategory = "Development" | "Quality & Security" | "Collaboration & Ops" | "Optional Integrations";

export interface ToolItem {
  name: string;
  type: "cli" | "mcp" | "ide";
  description: string;
}

export interface StepItem {
  number: number;
  title: string;
  explanation: string;
  command?: string;
  expectedOutput?: string;
  codeSample?: string;
}

export interface ExampleTask {
  description: string;
  type: string;
  plan: string[];
  definitionOfDone: string[];
}

export interface TroubleshootingItem {
  issue: string;
  resolution: string;
}

export interface UseCaseTutorial {
  slug: string;
  title: string;
  difficulty: Difficulty;
  category: UseCaseCategory;
  summary: string;
  estimatedTime: string;
  problem: string;
  whoItIsFor: string;
  prerequisites: string[];
  toolsUsed: ToolItem[];
  steps: StepItem[];
  exampleTask: ExampleTask;
  verificationSteps: string[];
  limitationsAndTroubleshooting: TroubleshootingItem[];
}

export const USE_CASES_DATA: UseCaseTutorial[] = [
  {
    slug: "solo-ai-developer",
    title: "Solo AI Coding Developer",
    difficulty: "Beginner",
    category: "Development",
    summary:
      "Maintain complete task discipline, prevent context drift, and ship verified features when working solo with an AI coding agent.",
    estimatedTime: "15-20 min",
    problem:
      "Solo developers using AI assistants often suffer from hallucinated edits, wandering scope, and forgotten test runs. Without a structured workflow, the AI edits files impulsively, leaving broken tests and uncommitted debt.",
    whoItIsFor: "Independent software engineers, indie hackers, and open-source maintainers using Claude Code, OpenCode, Codex, or Antigravity.",
    prerequisites: [
      "Node.js >= 20.0.0 installed locally",
      "Git initialized in your local repository",
      "@programinglive/dev-workflow installed globally via npm",
    ],
    toolsUsed: [
      { name: "devwf doctor", type: "cli", description: "Verify local storage and environment before starting" },
      { name: "start_task", type: "mcp", description: "Pin projectDir and lock task scope" },
      { name: "create_feature_flow", type: "mcp", description: "Record architecture flowchart before touching code" },
      { name: "complete_task", type: "mcp", description: "Safely persist outcomes and reset workflow state" },
    ],
    steps: [
      {
        number: 1,
        title: "Initialize Standalone Profile",
        explanation: "Run devwf setup to ensure local SQLite WAL persistence is ready with zero cloud dependencies.",
        command: "devwf setup && devwf doctor",
        expectedOutput: `[setup] Mode: LOCAL_FIRST_STANDALONE ready
All core health checks PASSED.`,
      },
      {
        number: 2,
        title: "Create Branch & Start Task Contract",
        explanation: "Always branch first. Then instruct your AI assistant to call start_task with your intent.",
        command: "git checkout -b feat/user-search",
        codeSample: `// Prompt to your AI agent:
"Please start a task: Add debounced username search filter to Users table."`,
      },
      {
        number: 3,
        title: "Enforce TDD & Verify",
        explanation: "Work with the agent to implement test-first logic. Inspect git diffs and verify test outputs.",
        command: "npm test",
        expectedOutput: `ℹ tests 8 · pass 8 · fail 0 · duration_ms 42.1`,
      },
      {
        number: 4,
        title: "Close Task with Evidence",
        explanation: "Call complete_task to record the commit message and next steps in local history.",
        codeSample: `{
  "commitMessage": "feat(users): add 300ms debounced username filter"
}`,
      },
    ],
    exampleTask: {
      description: "Implement debounced username search filter in the Users table component",
      type: "feature",
      plan: [
        "Add unit test asserting search query fires 300ms after last keystroke",
        "Add useDebounce hook and bind search input to table state",
        "Run component tests and verify clean render",
      ],
      definitionOfDone: [
        "Search input triggers query only after 300ms idle",
        "Table renders loading state and updates user rows accurately",
        "npm test passes 100% with no warnings",
      ],
    },
    verificationSteps: [
      "Run `git log -1` to confirm clean Conventional Commit on the feature branch",
      "Run `devwf list` to verify the task is logged as completed in local SQLite history",
    ],
    limitationsAndTroubleshooting: [
      {
        issue: "AI agent begins editing files before calling start_task",
        resolution: "The DevWorkflow pre-tool guard plugin blocks bash/mutation tools automatically until start_task is registered.",
      },
    ],
  },
  {
    slug: "bug-fix",
    title: "AI-Assisted Bug Fix",
    difficulty: "Beginner",
    category: "Development",
    summary:
      "Isolate verified root causes, write reproducing regression tests, and fix defects systematically without guesswork.",
    estimatedTime: "20-30 min",
    problem:
      "When facing bugs, AI agents frequently guess symptom patches (adding optional chaining `?.`, suppressive try-catch blocks) rather than diagnosing root causes, introducing silent technical debt.",
    whoItIsFor: "Developers debugging user-reported bugs, Sentry exceptions, or failing CI pipelines.",
    prerequisites: ["Reproducible bug report or failing test scenario", "Target repository with test suite configured"],
    toolsUsed: [
      { name: "start_task", type: "mcp", description: "Register bugfix contract with reproduction steps" },
      { name: "mark_bug_fixed", type: "mcp", description: "Record root cause analysis and evidence before code changes" },
      { name: "run_tests", type: "mcp", description: "Verify regression test failure, then verify green" },
    ],
    steps: [
      {
        number: 1,
        title: "Register Bugfix Task",
        explanation: "Pass `type: 'bugfix'` with reproduction steps, expected behavior, and observed failure.",
        codeSample: `{
  "description": "Fix null pointer crash when user session expires during checkout",
  "type": "bugfix",
  "plan": [
    "Write reproducing test simulating expired auth token on checkout API",
    "Identify root cause in token refresh interceptor",
    "Implement graceful redirect to login with cart preservation",
    "Run paratest / jest suite to confirm regression is fixed"
  ],
  "definitionOfDone": [
    "Reproduction test fails before fix and passes after fix",
    "Cart state remains preserved in storage on 401 response",
    "All tests pass with zero regressions"
  ]
}`,
      },
      {
        number: 2,
        title: "Reproduce with a Failing Test First",
        explanation: "Never touch production code before reproducing the defect with a failing automated test.",
        command: "npm test -- -t 'handles expired session'",
        expectedOutput: `FAIL tests/checkout.test.js
  ✕ handles expired session (TypeError: Cannot read properties of null)`,
      },
      {
        number: 3,
        title: "Apply Minimal Root-Cause Fix",
        explanation: "Fix the underlying bug at the source. Re-run tests to confirm green status.",
        command: "npm test -- -t 'handles expired session'",
        expectedOutput: `PASS tests/checkout.test.js
  ✓ handles expired session (12.4ms)`,
      },
    ],
    exampleTask: {
      description: "Prevent session crash and redirect to login when JWT expires during checkout",
      type: "bugfix",
      plan: [
        "Add unit test in tests/authInterceptor.test.js",
        "Update handleExpiredSession to emit reauth event and save cart draft",
        "Verify all authentication tests pass",
      ],
      definitionOfDone: [
        "Reproduction test verified failing before implementation",
        "Failing test passes cleanly after fix",
        "No unhandled Promise rejections on expired tokens",
      ],
    },
    verificationSteps: [
      "Verify git diff touches only the root cause file and new regression test",
      "Run full test suite to guarantee zero regression",
    ],
    limitationsAndTroubleshooting: [
      {
        issue: "AI agent wants to fix by adding try/catch without writing test",
        resolution: "Enforce the TDD discipline rule: reject the proposal until a reproduction test exists.",
      },
    ],
  },
  {
    slug: "feature-development",
    title: "Feature Development",
    difficulty: "Beginner",
    category: "Development",
    summary:
      "Build complex features end-to-end with visual architecture flow locking, incremental DoD checkpoints, and clean commits.",
    estimatedTime: "30-45 min",
    problem:
      "AI models easily lose track of multi-file dependencies, leading to unfinished interfaces, broken contracts, or abandoned edge cases.",
    whoItIsFor: "Full-stack engineers building new endpoints, UI components, or domain services.",
    prerequisites: ["Working local development environment", "DevWorkflow MCP server connected"],
    toolsUsed: [
      { name: "create_feature_flow", type: "mcp", description: "Record architecture Mermaid diagram" },
      { name: "set_plan", type: "mcp", description: "Break feature down into 4-8 incremental steps" },
      { name: "mark_dod_item", type: "mcp", description: "Prove each criterion with concrete output" },
      { name: "commit_and_push", type: "mcp", description: "Commit feature branch safely" },
    ],
    steps: [
      {
        number: 1,
        title: "Architect the Feature Flow",
        explanation: "Record data and state transitions in a Mermaid diagram to prevent token waste and hallucinations.",
        codeSample: `{
  "description": "User profile avatar upload flow",
  "mermaidCode": "flowchart TD\\n    A[Upload Dropzone] --> B[Client Image Resizer]\\n    B --> C[Presigned URL S3 Upload]\\n    C --> D[Backend Webhook Verification]\\n    D --> E[User Profile Cache Invalidation]"
}`,
      },
      {
        number: 2,
        title: "Build Incremental Steps",
        explanation: "Implement domain logic, unit tests, and API routes step by step. Mark progress with mark_plan_step.",
        command: "npm test && git status -s",
        expectedOutput: `M src/services/avatarUploader.js
M src/routes/user.js
?? tests/avatarUploader.test.js`,
      },
      {
        number: 3,
        title: "Prove Definition of Done",
        explanation: "Mark each DoD item with actual proof before running pre-commit checks.",
        codeSample: `{
  "id": "dod-1",
  "evidence": "npm test passes 18/18 tests including 10MB image limit rejection test."
}`,
      },
    ],
    exampleTask: {
      description: "Implement user profile avatar upload with client-side thumbnail resizing",
      type: "feature",
      plan: [
        "Add AvatarUploader domain service with max size validation",
        "Add image resizing utility using canvas API",
        "Add API endpoint route with auth guard",
        "Write integration tests and verify clean upload cycle",
      ],
      definitionOfDone: [
        "Avatar files exceeding 5MB are rejected with readable error",
        "Resized thumbnail is generated at 256x256 dimensions",
        "Integration tests pass with zero memory leaks",
      ],
    },
    verificationSteps: [
      "Run `check_ready_to_commit` to confirm all DoD items are checked",
      "Run `npm run build` to confirm static and production builds compile cleanly",
    ],
    limitationsAndTroubleshooting: [
      {
        issue: "check_ready_to_commit reports open DoD items",
        resolution: "Call `mark_dod_item` with concrete evidence or `waive_dod_item` with a written reason for items that genuinely no longer apply.",
      },
    ],
  },
  {
    slug: "code-review-audit",
    title: "Code Review & Standards Audit",
    difficulty: "Intermediate",
    category: "Quality & Security",
    summary:
      "Perform automated architectural, security, and contract audits on pull requests and local working trees before merge.",
    estimatedTime: "15-20 min",
    problem:
      "Human reviewers miss subtle edge cases (unhandled async rejections, SQL injection vulnerabilities, broken API contract changes), while manual review bottlenecks release velocity.",
    whoItIsFor: "Tech leads, senior engineers, and PR reviewers automating pre-merge code reviews.",
    prerequisites: ["Git repository with staged or uncommitted changes", "Configured DevWorkflow MCP"],
    toolsUsed: [
      { name: "audit", type: "mcp", description: "Audit working tree, diffs, API contracts, and security against engineering standards" },
      { name: "analyze_change", type: "mcp", description: "Explain rule violations, change impact, and recommended tests" },
      { name: "apply_safe_fix", type: "mcp", description: "Apply worktree-fenced deterministic AF-0/AF-1 fixes with rollback" },
    ],
    steps: [
      {
        number: 1,
        title: "Run Code & Contract Audit",
        explanation: "Instruct the AI to inspect current changes for standards violations and security flaws.",
        codeSample: `{
  "target": "HEAD~1..HEAD"
}`,
      },
      {
        number: 2,
        title: "Review Audit Report",
        explanation: "Examine detected smells, contract breaking changes, and cyclomatic complexity warnings.",
        command: "git diff --stat HEAD~1",
        expectedOutput: `4 files changed, 112 insertions(+), 18 deletions(-)
Audit: 0 critical vulnerabilities · 0 contract breaks · 1 refactor opportunity`,
      },
      {
        number: 3,
        title: "Apply Safe Automated Fixes",
        explanation: "Use apply_safe_fix or refactor the highlighted regions before committing.",
        command: "npm test",
        expectedOutput: `All tests passed.`,
      },
    ],
    exampleTask: {
      description: "Audit checkout service pull request for API contract stability and security compliance",
      type: "refactor",
      plan: [
        "Audit modified endpoint schemas in routes/checkout.js",
        "Verify absence of unparameterized database queries",
        "Confirm backward compatibility for mobile clients",
      ],
      definitionOfDone: [
        "Zero SQL injection or secret leak vulnerabilities detected",
        "API contract audit passes without breaking existing schema",
        "Automated review summary posted to PR notes",
      ],
    },
    verificationSteps: [
      "Run `audit` with `category: 'report'` to generate a structured JSON and formatted audit summary",
      "Confirm clean static analysis and zero linting errors",
    ],
    limitationsAndTroubleshooting: [
      {
        issue: "Audit flags legacy files outside PR scope",
        resolution: "Target specific commit ranges (e.g. `origin/main...HEAD`) to constrain audits to touched files.",
      },
    ],
  },
  {
    slug: "legacy-refactoring",
    title: "Legacy Code Refactoring",
    difficulty: "Intermediate",
    category: "Quality & Security",
    summary:
      "Modernize monolithic, untyped, or high-complexity legacy code safely with characterization tests and zero behavioral changes.",
    estimatedTime: "30-50 min",
    problem:
      "Refactoring legacy code without tests often introduces subtle regressions. AI agents can easily break implicit assumptions or edge cases buried in dense legacy functions.",
    whoItIsFor: "Backend and frontend engineers migrating legacy codebases, modernizing frameworks, or reducing technical debt.",
    prerequisites: ["Existing codebase with working execution environment", "Characterization or unit test harness"],
    toolsUsed: [
      { name: "analyze_change", type: "mcp", description: "Analyze complexity and propose incremental decomposition strategy (mode: refactor)" },
      { name: "audit", type: "mcp", description: "Audit architecture boundaries and dependency direction (category: architecture)" },
      { name: "run_tests", type: "mcp", description: "Run test suite continuously throughout refactor" },
    ],
    steps: [
      {
        number: 1,
        title: "Write Golden Characterization Tests",
        explanation: "Lock down existing observed behavior with snapshot or unit tests before altering any implementation.",
        command: "npm test -- --coverage",
        expectedOutput: `Coverage on target legacy module: 94%`,
      },
      {
        number: 2,
        title: "Decompose in Small Atomic Steps",
        explanation: "Extract pure domain functions, separate I/O from computation, and maintain test passing state at every step.",
        codeSample: `// Prompt to AI:
"Extract date formatting logic into pure helper function. Keep all existing tests green."`,
      },
      {
        number: 3,
        title: "Verify Zero Behavioral Regression",
        explanation: "Execute the entire test suite to guarantee 100% parity with legacy outputs.",
        command: "npm test",
        expectedOutput: `ℹ pass 64 · fail 0 · 100% green`,
      },
    ],
    exampleTask: {
      description: "Refactor 800-line legacy OrderCalculator into modular discount and tax domain services",
      type: "refactor",
      plan: [
        "Write characterization tests for OrderCalculator covering all tax tiers",
        "Extract TaxCalculator into independent pure class",
        "Extract DiscountEngine into separate strategy service",
        "Verify all characterization tests pass without alteration",
      ],
      definitionOfDone: [
        "OrderCalculator cyclomatic complexity reduced below 10",
        "100% characterization tests pass without modifying expected snapshots",
        "Memory footprint and CPU benchmarks show no regression",
      ],
    },
    verificationSteps: [
      "Compare test snapshots before and after refactoring",
      "Check `git diff` to ensure no public method signatures were removed",
    ],
    limitationsAndTroubleshooting: [
      {
        issue: "Characterization test fails after refactoring",
        resolution: "Revert the last atomic edit immediately. Do not guess; inspect the exact diff to find the broken assumption.",
      },
    ],
  },
  {
    slug: "security-audit",
    title: "Security Audit & Secret Scanning",
    difficulty: "Intermediate",
    category: "Quality & Security",
    summary:
      "Detect hardcoded credentials, evaluate dependency vulnerabilities, and enforce least-privilege security modes.",
    estimatedTime: "15-20 min",
    problem:
      "Accidental credential commits (`.env` files, API keys, private tokens) cause severe security breaches. Coding agents often paste sample credentials into code without realizing.",
    whoItIsFor: "DevSecOps engineers, security auditors, and developers preparing repositories for open-source or production release.",
    prerequisites: ["Git repository with commit history", "dev-workflow CLI installed"],
    toolsUsed: [
      { name: "audit", type: "mcp", description: "Scan workspace and diffs for secrets and unsafe patterns (category: security)" },
      { name: "devwf doctor", type: "cli", description: "Verify strict security mode in local profile" },
    ],
    steps: [
      {
        number: 1,
        title: "Verify Security Mode",
        explanation: "Ensure DevWorkflow security mode is set to strict to reject unencrypted secret persistence.",
        command: "devwf doctor --json",
        expectedOutput: `{"securityMode": "strict", "status": "healthy"}`,
      },
      {
        number: 2,
        title: "Run Workspace Security Scan",
        explanation: "Trigger security audit tool via MCP or terminal to scan for high-entropy tokens and credentials.",
        codeSample: `// AI Tool Call: audit
{ "category": "security" }`,
      },
      {
        number: 3,
        title: "Inspect Clean Results",
        explanation: "Verify that zero unmasked secrets, private keys, or insecure endpoints are present in the repository.",
        command: "git diff --name-only | grep -E '\\.env|secret|key'",
        expectedOutput: `(no output - clean)`,
      },
    ],
    exampleTask: {
      description: "Perform comprehensive security audit and credential leak scan before public npm publication",
      type: "other",
      plan: [
        "Scan working tree for hardcoded API keys and bearer tokens",
        "Verify .gitignore excludes .env, local credentials, and SQLite databases",
        "Verify strict security mode active in runtime configuration",
      ],
      definitionOfDone: [
        "Zero secrets or sensitive environment variables committed to git",
        ".gitignore properly fences ~/.devworkflow and credential files",
        "audit (category: security) reports 0 critical or high findings",
      ],
    },
    verificationSteps: [
      "Run `git log -p -n 5` to confirm recent commits contain zero unmasked secrets",
      "Verify `DEVWF_SECURITY_MODE=strict` in environment",
    ],
    limitationsAndTroubleshooting: [
      {
        issue: "Secret scanner flags test fixtures with mock API keys",
        resolution: "Use documented mock dummy values (e.g., `sk_test_mock_12345`) or add false-positive ignore rules in configuration.",
      },
    ],
  },
  {
    slug: "automated-testing",
    title: "Automated Testing & TDD Cycle",
    difficulty: "Intermediate",
    category: "Quality & Security",
    summary:
      "Automate the Red-Green-Refactor development cycle with strict test verification and zero unverified claims.",
    estimatedTime: "25-35 min",
    problem:
      "AI models frequently claim tests are passing without actually running the test binary. Unchecked assertions and obsolete test suites create a false sense of security.",
    whoItIsFor: "Engineers who prioritize high software quality, high test coverage, and bulletproof regressions.",
    prerequisites: ["Configured test runner (Node Test Runner, Jest, Vitest, PHPUnit, Paratest, PyTest)"],
    toolsUsed: [
      { name: "create_tests", type: "mcp", description: "Draft comprehensive test scenarios before coding" },
      { name: "run_tests", type: "mcp", description: "Execute test runner and capture stdout/stderr evidence" },
      { name: "analyze_change", type: "mcp", description: "Analyze change impact and suggest targeted regression tests (mode: tests)" },
    ],
    steps: [
      {
        number: 1,
        title: "Draft Test Scenarios (Red Phase)",
        explanation: "Create test files first. Run the test command and verify that the tests fail as expected.",
        command: "node --test tests/calculator.test.js",
        expectedOutput: `✖ calculateDiscount throws expected error (0.4ms)
  AssertionError: expected 15, got undefined`,
      },
      {
        number: 2,
        title: "Implement Passing Logic (Green Phase)",
        explanation: "Write the minimum code required to turn all tests green.",
        command: "node --test tests/calculator.test.js",
        expectedOutput: `✔ calculateDiscount applies tier percentage (1.1ms)
ℹ tests 6 · pass 6 · fail 0`,
      },
      {
        number: 3,
        title: "Refactor & Verify (Refactor Phase)",
        explanation: "Clean up code structure without altering public behavior. Ensure tests remain 100% green.",
        command: "npm test",
        expectedOutput: `All test suites passing.`,
      },
    ],
    exampleTask: {
      description: "Implement coupon code validation service using strict TDD",
      type: "feature",
      plan: [
        "Write failing tests for expired, invalid, and minimum-spend coupon codes",
        "Implement CouponValidator domain service",
        "Run test runner and verify 100% green suite",
      ],
      definitionOfDone: [
        "Failing test verified failing before implementation",
        "All coupon validation rules covered by unit tests",
        "Test suite passes with 0 failures and >90% coverage",
      ],
    },
    verificationSteps: [
      "Inspect test execution logs directly to verify actual pass count",
      "Verify tests test assertions, not empty mocks",
    ],
    limitationsAndTroubleshooting: [
      {
        issue: "Paratest / Parallel test runner conflict on SQLite database",
        resolution: "Use unique memory databases (`:memory:`) or transaction rollback wrappers per test process.",
      },
    ],
  },
  {
    slug: "pr-release-safety",
    title: "PR & Release Safety Verification",
    difficulty: "Intermediate",
    category: "Quality & Security",
    summary:
      "Evaluate reversibility across 8 dimensions, verify CI status, and release SemVer tags safely with automated rollback readiness.",
    estimatedTime: "20-30 min",
    problem:
      "Rushing releases without checking reversibility (e.g., destructive database migrations, external third-party API mutations) leads to prolonged downtime when bugs emerge in production.",
    whoItIsFor: "Release managers, operations engineers, and full-stack developers shipping production tags.",
    prerequisites: ["Git remote configured", "Automated CI/CD pipeline (GitHub Actions, GitLab CI)"],
    toolsUsed: [
      { name: "acquire_release_lock", type: "mcp", description: "Prevent concurrent overlapping releases" },
      { name: "perform_release", type: "mcp", description: "Execute release script and record release notes" },
      { name: "record_deployment", type: "mcp", description: "Log deployment evidence, version, and health status" },
    ],
    steps: [
      {
        number: 1,
        title: "Evaluate 8 Reversibility Dimensions",
        explanation: "Before tagging, assess source revert, build artifact, DB schema, data recovery, and side effects.",
        codeSample: `// Reversibility Assessment:
// - Source code revert: REVERSIBLE (clean git revert)
// - Build artifact: REVERSIBLE (atomic swap)
// - Database schema: REVERSIBLE (additive column, default null)
// Classification: REVERSIBLE`,
      },
      {
        number: 2,
        title: "Check Ready to Commit",
        explanation: "Verify clean working tree, passed tests, and completed Definition of Done criteria.",
        codeSample: `// AI Tool Call: check_ready_to_commit
{}
// Result: Ready to commit. 0 open DoD items.`,
      },
      {
        number: 3,
        title: "Release SemVer Tag & Push",
        explanation: "Bump version via conventional commiter and push tag to origin to trigger CI/CD deployment.",
        command: "npm run release:patch",
        expectedOutput: `Generating v2.1.2 from HEAD
✔ bumping version in package.json from 3.2.0 to 3.3.0
✔ outputting changes to CHANGELOG.md
✅ Release v2.1.2 complete; annotated tag verified on origin.`,
      },
    ],
    exampleTask: {
      description: "Release patch version v2.1.2 with verified CI pipeline and post-deploy health check",
      type: "other",
      plan: [
        "Verify working tree is clean and all tests pass",
        "Run npm run release:patch to bump SemVer and generate changelog",
        "Monitor GitHub Actions CI runner on bw-tools",
        "Verify live production deployment answers HTTP 200",
      ],
      definitionOfDone: [
        "SemVer tag created and pushed to origin",
        "CI/CD build and secret scan pipelines pass green",
        "Production website serves new release version",
      ],
    },
    verificationSteps: [
      "Run `git describe --tags` to verify local tag matches remote",
      "Run `curl -I https://your-production-url.example` to verify HTTP 200 response",
    ],
    limitationsAndTroubleshooting: [
      {
        issue: "Release tag rejected by protected tags policy",
        resolution: "Ensure CI token or GitHub App has write permissions on `v*` protected tags, or run release through automated release script.",
      },
    ],
  },
  {
    slug: "multi-agent-collaboration",
    title: "Multi-Agent Collaboration & Parallel Workers",
    difficulty: "Advanced",
    category: "Collaboration & Ops",
    summary:
      "Coordinate multiple concurrent AI sessions across isolated git worktrees with kernel mutex fencing and zero collision.",
    estimatedTime: "30-60 min",
    problem:
      "Running multiple AI agents concurrently on the same directory causes devastating file overwrites, conflicting git index states, and corrupted sessions.",
    whoItIsFor: "Advanced engineering teams dispatching multiple parallel AI agents for rapid feature delivery.",
    prerequisites: ["Git repository", "DevWorkflow 2.1+ with kernel mutex support"],
    toolsUsed: [
      { name: "start_task", type: "mcp", description: "Acquires OS kernel mutex capability on target worktree" },
      { name: "checkpoint_task", type: "mcp", description: "Save progress checkpoint before context switch" },
      { name: "handoff_task", type: "mcp", description: "Transfer active task state to another machine or agent" },
      { name: "resume_session", type: "mcp", description: "Adopt existing workflow state safely" },
    ],
    steps: [
      {
        number: 1,
        title: "Create Isolated Git Worktree",
        explanation: "Always run parallel agents in distinct worktrees to provide complete file isolation.",
        command: "git worktree add ../my-project-worker-2 feat/analytics-pipeline",
        expectedOutput: `Preparing worktree (new branch 'feat/analytics-pipeline')
HEAD is now at a1b2c3d chore: initial commit`,
      },
      {
        number: 2,
        title: "Fenced Task Registration",
        explanation: "Each agent starts its task in its designated worktree path. DevWorkflow's kernel mutex prevents collision.",
        codeSample: `// Agent 2 Tool Call: start_task
{
  "description": "Build analytics export pipeline",
  "projectDir": "/path/to/my-project-worker-2",
  "type": "feature"
}`,
      },
      {
        number: 3,
        title: "Checkpoint & Handoff",
        explanation: "If you need to switch tasks, call checkpoint_task. The state is serialized atomically into SQLite.",
        codeSample: `// AI Tool Call: checkpoint_task
{
  "summary": "Completed schema migration; ready for API endpoint implementation"
}`,
      },
    ],
    exampleTask: {
      description: "Dispatch parallel worker to implement analytics pipeline in dedicated git worktree",
      type: "feature",
      plan: [
        "Create isolated worktree at ../worker-analytics",
        "Bind session to worktree and acquire process lock",
        "Implement data aggregation service and unit tests",
        "Commit changes and prepare PR for review",
      ],
      definitionOfDone: [
        "Worktree runs without file collision with main tree",
        "Kernel mutex capability acquired and held during session",
        "Branch merged cleanly into main upon review",
      ],
    },
    verificationSteps: [
      "Run `git worktree list` to inspect active trees",
      "Run `devwf list` to view concurrent active agent sessions",
    ],
    limitationsAndTroubleshooting: [
      {
        issue: "Agent refuses task with 'Project ownership lost'",
        resolution: "Do not force. Verify whether another agent process holds the lock, or adopt the session via `resume_session { adopt: sessionKey }`.",
      },
    ],
  },
  {
    slug: "optional-zettly-planning",
    title: "Optional Zettly Planning & Task Tracking",
    difficulty: "Intermediate",
    category: "Optional Integrations",
    summary:
      "Connect DevWorkflow to Zettly for visual architecture canvases, Pareto 80/20 priority ranking, and automated journal logs.",
    estimatedTime: "15-25 min",
    problem:
      "Engineering leaders need high-level visibility into AI agent progress, priority queues, and architecture diagrams without interrupting developers.",
    whoItIsFor: "Teams using Zettly for project management, personal knowledge bases, and sprint planning.",
    prerequisites: ["Running Zettly instance (self-hosted or cloud)", "Zettly API access token"],
    toolsUsed: [
      { name: "devwf zettly connect", type: "cli", description: "Connect per-user Zettly credentials securely" },
      { name: "sync_zettly_task", type: "mcp", description: "Synchronize active task and DoD checklist to Zettly Todo" },
      { name: "create_feature_flow", type: "mcp", description: "Sync visual flowchart to Zettly Draw canvas" },
    ],
    steps: [
      {
        number: 1,
        title: "Connect Zettly Account Securely",
        explanation: "Supply your API token via hidden stdin. Raw tokens are never logged or stored in shell history.",
        command: "printf '%s' \"$ZETTLY_API_TOKEN\" | devwf zettly connect --url https://zettly.example.com --token-stdin",
        expectedOutput: `[zettly] Account connected: mahar (ID: 1)
[zettly] Workspace URL: https://zettly.example.com
Connection verified successfully.`,
      },
      {
        number: 2,
        title: "Verify Sync & Focus Binding",
        explanation: "Tasks started under active focuses automatically link to canonical Zettly Todos and Draw canvases.",
        command: "devwf zettly doctor --json",
        expectedOutput: `{"status": "healthy", "user": "mahar", "activeFocuses": 4}`,
      },
      {
        number: 3,
        title: "Inspect Visual Canvas in Zettly Draw",
        explanation: "Feature flows created via create_feature_flow sync directly to https://zettly.example.com/draw/{id}.",
        codeSample: `// AI Tool Call: create_feature_flow
// Canvas URL generated: https://zettly.example.com/draw/742`,
      },
    ],
    exampleTask: {
      description: "Connect Zettly workspace and synchronize feature flow with Draw canvas #742",
      type: "feature",
      plan: [
        "Connect Zettly API token via devwf zettly connect",
        "Start task under focus #186",
        "Sync architecture flow to Zettly Draw",
        "Complete task and record daily outcome in Zettly Journal",
      ],
      definitionOfDone: [
        "Zettly Todo synchronized with active plan and DoD",
        "Zettly Draw canvas updated with valid Mermaid diagram",
        "Work outcome recorded in daily activity journal upon completion",
      ],
    },
    verificationSteps: [
      "Open your Zettly dashboard to verify linked Todo #1086 is committed in Today",
      "Open Zettly Draw URL to verify visual flowchart nodes",
    ],
    limitationsAndTroubleshooting: [
      {
        issue: "Zettly token expired or revoked",
        resolution: "Run `printf '%s' '$NEW_TOKEN' | devwf zettly switch --url <url> --token-stdin --confirm` to update credentials without losing local history.",
      },
    ],
  },
  {
    slug: "optional-android-companion",
    title: "Optional Android Companion Remote Monitoring",
    difficulty: "Intermediate",
    category: "Optional Integrations",
    summary:
      "Monitor active AI agent sessions, build status, and machine fleet health in real-time from a secondary Android tablet or phone.",
    estimatedTime: "10-15 min",
    problem:
      "Developers switching windows constantly lose sight of background test builds, long-running agent tasks, or fleet machine states.",
    whoItIsFor: "Developers with a desk-mounted tablet, secondary Android phone, or multi-device workstation setup.",
    prerequisites: ["Android device running Android 10+", "DevWorkflow Companion APK installed", "Tailscale or local Wi-Fi connectivity"],
    toolsUsed: [
      { name: "devwf pair", type: "cli", description: "Generate encrypted pairing challenge for Android device" },
      { name: "devwf doctor", type: "cli", description: "Verify monitor service connectivity" },
    ],
    steps: [
      {
        number: 1,
        title: "Generate Pairing Challenge",
        explanation: "Run devwf pair from your workstation terminal to generate an encrypted pairing challenge.",
        command: "devwf pair --url http://192.168.1.50:3100 --json",
        expectedOutput: `{
  "pairingCode": "DW-8492-7104",
  "qrPayload": "devwf://pair?server=http%3A%2F%2F192.168.1.50%3A3100&code=DW-8492-7104",
  "expiresIn": 300
}`,
      },
      {
        number: 2,
        title: "Pair Device in Companion App",
        explanation: "Open the DevWorkflow Companion app on your Android device and scan the QR code or enter the pairing code.",
        codeSample: `// On Android Tablet:
// 1. Open DevWorkflow Companion
// 2. Tap "Pair New Workstation"
// 3. Scan QR code or enter code DW-8492-7104`,
      },
      {
        number: 3,
        title: "Live Cockpit Monitoring",
        explanation: "The companion displays active sessions, build progress, test outcomes, and connected machines in real time.",
        command: "devwf list --json",
        expectedOutput: `{"activeSessions": 3, "connectedMachines": ["workstation-main", "workstation-mac", "workstation-server"]}`,
      },
    ],
    exampleTask: {
      description: "Pair Xiaomi Pad 6 tablet as dedicated live engineering monitor cockpit",
      type: "other",
      plan: [
        "Generate pairing code on main developer workstation",
        "Input pairing challenge on Xiaomi Pad 6 Companion app",
        "Verify live session and build telemetry updates",
      ],
      definitionOfDone: [
        "Android device displays green LIVE connection indicator",
        "Active session cards reflect real-time plan step changes",
        "Companion runs in read-only telemetry mode with zero impact on workstation performance",
      ],
    },
    verificationSteps: [
      "Check companion screen to confirm live session card shows active task",
      "Trigger test run on workstation and observe progress bar updating on tablet",
    ],
    limitationsAndTroubleshooting: [
      {
        issue: "Android app goes to sleep when running in background",
        resolution: "Configure MIUI/Android Battery Saver settings to 'No restrictions' for the DevWorkflow Companion app.",
      },
    ],
  },
  {
    slug: "engineering-retrospectives",
    title: "Engineering Retrospectives & Outcome Tracking",
    difficulty: "Advanced",
    category: "Collaboration & Ops",
    summary:
      "Leverage durable SQLite execution history to generate evidence-backed retrospectives, measure cycle time, and reduce recurring defects.",
    estimatedTime: "20-30 min",
    problem:
      "Sprint retrospectives often rely on vague memories, opinions, and biased impressions rather than concrete metrics on where engineering time and AI tokens were actually spent.",
    whoItIsFor: "Engineering leads, agile coaches, and teams running sprint retrospectives or continuous improvement reviews.",
    prerequisites: ["History of completed tasks in ~/.devworkflow/history.sqlite3"],
    toolsUsed: [
      { name: "view_history", type: "mcp", description: "Query past task durations, DoD completion rates, and next steps" },
      { name: "build_report", type: "mcp", description: "Aggregate build durations, test failure rates, and flakiness" },
      { name: "analyze_change", type: "mcp", description: "Analyze technical debt priorities and improvement opportunities (mode: debt)" },
    ],
    steps: [
      {
        number: 1,
        title: "Query Task History Metrics",
        explanation: "Inspect completed tasks over the past sprint cycle using view_history.",
        codeSample: `// AI Tool Call: view_history
{
  "limit": 20
}`,
      },
      {
        number: 2,
        title: "Analyze Technical Debt Backlog",
        explanation: "Extract recurring nextSteps recorded during previous complete_task invocations to discover systemic debt.",
        codeSample: `// AI Tool Call: analyze_change
{ "mode": "debt" }`,
      },
      {
        number: 3,
        title: "Synthesize Retrospective Action Items",
        explanation: "Convert verified execution evidence into actionable engineering improvements for the next sprint.",
        command: "devwf list --json",
        expectedOutput: `Summary: 28 tasks completed, 0 unhandled regressions, 4 tech debt candidates prioritized`,
      },
    ],
    exampleTask: {
      description: "Generate sprint 46 engineering retrospective report from local DevWorkflow execution telemetry",
      type: "other",
      plan: [
        "Extract completed task records from SQLite history",
        "Aggregate average time from task start to completion",
        "Synthesize recurring nextSteps into prioritized technical debt items",
      ],
      definitionOfDone: [
        "Sprint velocity and DoD pass rate calculated from empirical data",
        "Top 3 technical debt bottlenecks identified with source citations",
        "Actionable retro summary documented in engineering notes",
      ],
    },
    verificationSteps: [
      "Verify all retrospective claims reference valid task IDs and outcomes in history.sqlite3",
    ],
    limitationsAndTroubleshooting: [
      {
        issue: "History database moved across machines",
        resolution: "Use `devwf fleet status` or copy `~/.devworkflow/history.sqlite3` when migrating workstations.",
      },
    ],
  },
  {
    slug: "organization-governance",
    title: "Organization-Wide Governance & Policy Enforcement",
    difficulty: "Advanced",
    category: "Collaboration & Ops",
    summary:
      "Roll out centralized MCP configurations, pre-tool guard plugins, and standardized engineering rules across entire developer fleets.",
    estimatedTime: "30-45 min",
    problem:
      "When developers across an organization configure AI coding assistants independently, rules drift, security policies are ignored, and agents write rogue code without tracking.",
    whoItIsFor: "VP of Engineering, platform engineering teams, and security officers managing AI tool adoption across engineering fleets.",
    prerequisites: ["Central release host or repository", "Multiple developer machines or workstations"],
    toolsUsed: [
      { name: "devwf fleet status", type: "cli", description: "Inspect toolCatalogDigest convergence across fleet" },
      { name: "devwf fleet upgrade", type: "cli", description: "Deploy staged runtime upgrades across machines" },
      { name: "node managed/rollout.cjs", type: "cli", description: "Synchronize AI rules and guard plugins fleet-wide" },
    ],
    steps: [
      {
        number: 1,
        title: "Check Fleet Convergence",
        explanation: "Run devwf fleet status to inspect whether all workstations share the same tool catalog digest and release tag.",
        command: "devwf fleet status --json",
        expectedOutput: `{
  "converged": true,
  "fleetRelease": "v3.3.0",
  "machines": [
    { "name": "workstation-main", "status": "online", "version": "3.3.0" },
    { "name": "workstation-mac", "status": "online", "version": "3.2.0" },
    { "name": "workstation-server", "status": "online", "version": "3.2.0" }
  ]
}`,
      },
      {
        number: 2,
        title: "Deploy Guard Plugin Fleet-Wide",
        explanation: "Synchronize pre-tool guard plugins across OpenCode, Codex, and Claude Code configurations.",
        command: "node managed/rollout.cjs --rules-only",
        expectedOutput: `[rollout] workstation-main: .gemini/GEMINI.md, codex/AGENTS.md, opencode/AGENTS.md UPDATED
[rollout] workstation-mac: .gemini/GEMINI.md, codex/AGENTS.md, opencode/AGENTS.md UPDATED
[rollout] workstation-server: .gemini/GEMINI.md, codex/AGENTS.md, opencode/AGENTS.md UPDATED
Fleet rollout complete. 3/3 machines synchronized.`,
      },
      {
        number: 3,
        title: "Verify Enforcement",
        explanation: "Test that rogue agent executions without start_task are blocked immediately by the guard hook.",
        command: "node --test tests/opencode-guard-plugin.test.js",
        expectedOutput: `✔ blocks mutating tools when session has not registered task (1.2ms)
ℹ tests 5 · pass 5 · fail 0`,
      },
    ],
    exampleTask: {
      description: "Deploy DevWorkflow 2.1 pre-tool guard plugin and rules fleet-wide across all developer workstations",
      type: "feature",
      plan: [
        "Build and test managed/plugins/dev-workflow-guard.ts",
        "Run unit tests verifying OpenCode 1.x and 2.x hook compatibility",
        "Execute node managed/rollout.cjs --rules-only to sync all devices",
        "Verify convergence with devwf fleet status --json",
      ],
      definitionOfDone: [
        "Pre-tool guard plugin blocks mutating tools until start_task is registered",
        "Unit test suite passes 5/5 tests",
        "All 3 fleet workstations (workstation-main, workstation-mac, workstation-server) report synchronized status",
      ],
    },
    verificationSteps: [
      "Run `devwf fleet status --json` to verify `converged: true`",
      "Run test suite on each machine to confirm guard plugin blocks unmanaged edits",
    ],
    limitationsAndTroubleshooting: [
      {
        issue: "Machine offline during rollout",
        resolution: "Run `node managed/rollout.cjs` with `--resume` to re-attempt sync only on remaining offline nodes.",
      },
    ],
  },
];
