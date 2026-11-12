# DevWorkflow Architecture — Gap Analysis

**Document Version:** 1.0.0  
**Context:** Evolution from internal discipline tool to Open-Source Governance Runtime  

---

## Overview

This gap analysis compares the **Current State (v1.30.0)** against the **Target State Architecture**. Every gap includes root cause analysis, risk assessment, affected modules, compatibility impact, and concrete acceptance criteria.

---

## Summary Matrix

| Gap ID | Dimension | Current Implementation | Target Implementation | Risk Level |
|---|---|---|---|---|
| **GAP-1** | Task Scope & Contracts | Unstructured description + text DoD | Schema-validated Task Contracts with path boundaries & drift detection | Medium |
| **GAP-2** | Policy-as-Code | Hardcoded rules in code & prompts | Declarative `devworkflow.yaml` with versioned profiles | Low |
| **GAP-3** | State Machine Formality | Single monolithic state object & booleans | Strict FSM with explicit transitions, guards & exceptional states | Medium |
| **GAP-4** | Evidence Verification | Self-reported boolean flags (`testsPassed: true`) | Evidence Store with tree digests, execution IDs & stale detection | Medium |
| **GAP-5** | Concurrency & Isolation | Coarse repository-level process lock | Git worktree isolation + lease coordination + fencing tokens | High |
| **GAP-6** | Documentation Impact | Binary check: source changed $\rightarrow$ README changed | Impact-aware classification (API, CLI, Internal, Config) | Low |
| **GAP-7** | Provider Modularity | Tightly coupled internal services (Zettly, bw-tools) | Ports-and-Adapters Provider SDK (Local default + Plugins) | Medium |
| **GAP-8** | CLI Capabilities | Session cleanup only (`devwf list/close/drop`) | Full lifecycle parity (`devworkflow task start/verify/status`) | Low |
| **GAP-9** | Event Journal & Recovery | SQLite snapshot + heuristic timeout ("mungkin macet") | Append-only event journal + deterministic crash recovery | Medium |
| **GAP-10**| Security & Threat Model | Basic secret regex scanner and strict mode | Layered sandboxing, adversarial testing, approval gates | High |

---

## Detailed Gap Analyses

### GAP-1: Task Scope Boundaries & Scope Drift Detection

- **Current Implementation:** `start_task` accepts `description`, `type`, `definitionOfDone` (array of strings), and `plan`. State stores these as plain text. File paths touched during execution are not constrained.
- **Identified Problem:** An AI agent assigned to fix an authentication bug can silently mutate unrelated configuration, build scripts, or business logic. No mechanism alerts the developer or blocks the commit when files outside the intended scope are touched.
- **Proposed Improvement:**
  - Introduce `TaskContract` schema defining `allowedPaths` (globs) and `forbiddenPaths` (globs).
  - Implement deterministic path analysis before `commit_and_push`.
  - Trigger policy violations and transition to `BLOCKED` when scope drift is detected.
- **Risk Level:** Medium.
- **Affected Modules:** `workflow-state.js`, `tools/handler-modules/workflow-handlers.js`, new `contracts/task-contract.js`.
- **Compatibility Impact:** 100% backward compatible. If `allowedPaths` is omitted, defaults to permissive `["**/*"]` with warnings on critical security paths (`.env*`, `.git*`).
- **Migration Requirements:** Non-breaking; add optional schema fields to `start_task` and `refine_with_ai`.
- **Acceptance Criteria:**
  1. Unit test confirms modifying a file matching `forbiddenPaths` halts `check_ready_to_commit`.
  2. Modifying files outside `allowedPaths` produces structured warning and requires explicit scope expansion.

---

### GAP-2: Policy-as-Code Engine (`devworkflow.yaml`)

- **Current Implementation:** Rules are hardcoded in `workflow-guidance.js` (`ENGLISH_IMPLEMENTATION_RULE`, `CLI_FIRST_RULE`) and injected into prompts or `MANAGED_RULE_BLOCK`.
- **Identified Problem:** Different repositories have different engineering standards (e.g. library repos need 100% coverage; prototype scripts need lightweight rules). Changing rules requires rebuilding and redistributing the MCP server package.
- **Proposed Improvement:**
  - Create `devworkflow.yaml` specification supporting `lightweight`, `standard`, and `critical` profiles.
  - Implement a policy evaluator resolving effective rules based on path matching and task risk.
- **Risk Level:** Low.
- **Affected Modules:** new `policy/policy-engine.js`, `workflow-guidance.js`.
- **Compatibility Impact:** Backward compatible. If `devworkflow.yaml` is absent in repository root, the engine applies the built-in "Standard" profile (matching current v1.30.0 behavior).
- **Migration Requirements:** None required for existing projects; opt-in configuration file.
- **Acceptance Criteria:**
  1. `devworkflow.yaml` validated against JSON Schema.
  2. Overriding rules based on file paths (e.g. `src/auth/**` -> `critical`) successfully escalates required gates.

---

### GAP-3: Strict State Machine & Lifecycle Decoupling

- **Current Implementation:** `workflow-state.js` (2,766 lines) acts as state machine, database client, monitor reporter, and serializer all in one. States are represented as string `currentPhase` plus boolean flags (`bugFixed`, `testsPassed`, etc.).
- **Identified Problem:** Transitions are scattered across individual tool handlers. Impossible to guarantee state machine invariants or test transitions in isolation.
- **Proposed Improvement:**
  - Formalize primary states: `CREATED`, `PLANNED`, `EXECUTING`, `VERIFYING`, `READY`, `INTEGRATED`.
  - Add exceptional states: `PAUSED`, `BLOCKED`, `FAILED`, `CANCELLED`.
  - Transition guards that evaluate contracts, evidence, and policies before allowing state changes.
- **Risk Level:** Medium.
- **Affected Modules:** `workflow-state.js`, `tools/handlers.js`, `tools/handler-modules/`.
- **Compatibility Impact:** Existing MCP tools (`start_task`, `mark_bug_fixed`, etc.) remain identical on the wire; internally they dispatch commands to the FSM.
- **Migration Requirements:** Provide a state translation adapter so legacy state rows in SQLite deserialize into valid FSM states.
- **Acceptance Criteria:**
  1. Invalid state transitions (e.g. `CREATED` straight to `READY`) throw structured `InvalidTransitionError`.
  2. Existing 1,767 tests continue passing without regression.

---

### GAP-4: Evidence Store & Verification Engine

- **Current Implementation:** `run_tests` accepts `{ passed: boolean, testCommand: string, testOutput: string }`. If `passed: true`, `workflowState.state.testsPassed` is set to `true`.
- **Identified Problem:** An agent can hallucinate or forge test results by simply submitting `{ passed: true }` without actually running a test runner. Furthermore, if source files are edited after running tests, `testsPassed` remains `true` (stale evidence).
- **Proposed Improvement:**
  - Create an immutable `EvidenceStore`.
  - Record execution metadata: `gitTreeSha`, timestamp, exit code, test counts, stdout digest.
  - Invalidate test evidence whenever the Git index or working tree changes.
- **Risk Level:** Medium.
- **Affected Modules:** `tools/handler-modules/test-handlers.js`, `workflow-state.js`, new `evidence/evidence-store.js`.
- **Compatibility Impact:** Backward compatible with existing MCP callers; adds validation layer.
- **Migration Requirements:** SQLite migration adding `task_evidence` table.
- **Acceptance Criteria:**
  1. Changing a source file after running tests sets verification state to `STALE`.
  2. Commit gate rejects stale evidence.

---

### GAP-5: Multi-Agent Concurrency & Worktree Isolation

- **Current Implementation:** `process-lock.js` locks the entire repository folder (`mcp-process.lock`). If session B starts while session A is running, session B is rejected unless `{ force: true }`.
- **Identified Problem:** Precludes multi-agent collaboration on large repositories. Forcing the lock risks clobbering uncommitted work.
- **Proposed Improvement:**
  - Implement Git worktree isolation: each task runs in `.worktrees/<task-id>`.
  - Implement lease management with heartbeat renewal and fencing tokens (`leaseEpoch`).
  - Serialized integration queue for merging completed worktrees back to main.
- **Risk Level:** High.
- **Affected Modules:** `process-lock.js`, `exec.js`, `git-facade.js`, new `worktree/worktree-manager.js`.
- **Compatibility Impact:** Single-directory repositories without worktree support can remain in legacy single-lock mode (`DEVWF_ISOLATION_MODE=directory|worktree`).
- **Migration Requirements:** Clean up existing `.state/projects/*/*.lock` files upon upgrade.
- **Acceptance Criteria:**
  1. Two separate agents execute distinct tasks on the same repository in separate worktrees simultaneously.
  2. Stale leases are safely expired without deleting user files.

---

### GAP-6: Documentation Impact Engine

- **Current Implementation:** `evaluateDocGate` in `tools/handler-modules/docs.js` checks if any file in git status is "source" and whether any file is "doc" (`README.md`, `docs/`, `PRD.md`).
- **Identified Problem:** Pure internal refactoring or test cleanup triggers documentation requirements. Conversely, major public CLI changes can be satisfied by touching an unrelated markdown file.
- **Proposed Improvement:**
  - Classify changes into tiers: `PUBLIC_API`, `CLI_INTERFACE`, `CONFIGURATION`, `INTERNAL_REFACTOR`, `DOCS_ONLY`.
  - Rules determine required documentation: `CLI_INTERFACE` requires updating CLI reference; `DOCS_ONLY` skips the gate automatically.
- **Risk Level:** Low.
- **Affected Modules:** `tools/handler-modules/docs.js`.
- **Compatibility Impact:** 100% backward compatible; waivers still supported.
- **Migration Requirements:** None.
- **Acceptance Criteria:**
  1. Documentation-only commits automatically pass the documentation gate without manual waiver.
  2. Public API changes require documentation updates in the corresponding module.

---

### GAP-7: Provider Modularity (Decoupling Proprietary Services)

- **Current Implementation:** Zettly, Zettly Draw, and `bw-tools` are directly imported and invoked in `tools/handler-modules/index.js` and `managed/rollout.cjs`.
- **Identified Problem:** Prevents the project from being used by the open-source community or in air-gapped corporate environments.
- **Proposed Improvement:**
  - Define Ports-and-Adapters Provider SDK:
    - `TaskTrackerProvider`: `LocalProvider` (built-in SQLite), `GitHubProvider`, `ZettlyProvider`.
    - `VisualFlowProvider`: `MermaidCliProvider` (local SVG), `ZettlyDrawProvider`.
  - Default out-of-the-box configuration uses 100% local providers.
- **Risk Level:** Medium.
- **Affected Modules:** `index.js`, `tools/handler-modules/index.js`, new `providers/`.
- **Compatibility Impact:** Existing Zettly functionality remains fully supported via its registered adapter.
- **Migration Requirements:** Environment variable `DEVWF_TASK_TRACKER=local|zettly|github`.
- **Acceptance Criteria:**
  1. MCP server starts and executes complete workflow with zero network calls and no configured external credentials.
  2. Zettly synchronization continues functioning when `DEVWF_TASK_TRACKER=zettly`.

---

### GAP-8: CLI Parity (`devworkflow`)

- **Current Implementation:** `bin/cli.js` (`devwf`) handles session close/drop and share link inspection.
- **Identified Problem:** Cannot start tasks, plan, inspect evidence, or check policies via terminal without an active AI agent.
- **Proposed Improvement:**
  - Add commands: `devworkflow doctor`, `devworkflow init`, `devworkflow task start/plan/status/verify/evidence/pause/resume/cancel`, `devworkflow policy check`.
- **Risk Level:** Low.
- **Affected Modules:** `cli/`, `bin/cli.js`.
- **Compatibility Impact:** Fully backward compatible; preserves `devwf` binary and flags.
- **Migration Requirements:** None.
- **Acceptance Criteria:**
  1. `devworkflow doctor` verifies environment, node version, git, and database health.
  2. A task can be created, verified, and completed entirely via CLI without opening an MCP client.

---

### GAP-9: Append-Only Event Journal & Recovery

- **Current Implementation:** State is updated via in-place SQLite row updates (`UPDATE workflow_state SET state_json = ?`).
- **Identified Problem:** If the process crashes mid-transition, the state may be corrupt or leave orphaned tasks labelled as "mungkin macet".
- **Proposed Improvement:**
  - Create `event_journal` table recording every state transition, tool invocation, and policy decision.
  - Implement event-sourced recovery rebuilding state from journal on boot.
- **Risk Level:** Medium.
- **Affected Modules:** `db/schema.js`, `workflow-state.js`.
- **Compatibility Impact:** Additive database migration.
- **Migration Requirements:** DDL migration creating `event_journal`.
- **Acceptance Criteria:**
  1. Abrupt process termination (`SIGKILL`) is cleanly recovered upon next launch by replaying the event journal.
  2. Every lifecycle transition produces an immutable journal entry.

---

### GAP-10: Security Hardening & Threat Model Controls

- **Current Implementation:** Basic regex secret scanning in `security/scanner.js` and output redaction via `securityOutputFilter`.
- **Identified Problem:** Lacks structured adversarial regression testing against prompt injection, symlink traversal, command argument escaping, and policy self-weakening.
- **Proposed Improvement:**
  - Build automated adversarial test suite covering 10 common AI agent bypass vectors.
  - Implement strict path traversal and command argument validators.
- **Risk Level:** High.
- **Affected Modules:** `security/`, `exec.js`, `utils.js`, `tests/adversarial/`.
- **Compatibility Impact:** Transparent security enforcement.
- **Acceptance Criteria:**
  1. Adversarial test suite verifies zero bypasses for unauthorized file writes, stolen credentials, or unearned gates.

---

### GAP-11: Zettly Integration Evolution & Change Management Protocol

- **Current Implementation:** Direct synchronous/asynchronous HTTP calls in post-tool hooks (`tools/handler-modules/index.js`); requirement changes made in Zettly while an agent is running are not detected until the next manual reload.
- **Identified Problem:**
  1. If a human modifies requirements in Zettly mid-flight, an agent could complete an outdated Task Contract.
  2. Hardcoded Zettly dependencies impede local-first open source operation.
  3. Marking a Zettly Todo as done could create the illusion that the code is complete even if DevWorkflow gates were skipped.
- **Proposed Improvement:**
  - Implement `Zettly ↔ DevWorkflow Integration Contract v1`.
  - Add requirement change detection pausing execution when acceptance criteria change.
  - Formalize Zettly as an official `TaskTrackerProvider` and `ApprovalProvider` in the Provider SDK.
  - Enforce transactional outbox so Zettly API delays never block or time out local MCP operations.
- **Risk Level:** Medium.
- **Affected Modules:** `zettly-client.js`, `zettly-workflow.js`, `zettly-drawing.js`, `tools/handler-modules/index.js`.
- **Compatibility Impact:** 100% backward compatible with existing Zettly Todo, Draw, Focus, and Tag APIs.
- **Acceptance Criteria:**
  1. Changes to Zettly Todo requirements mid-execution flag task as `PAUSED` and request scope reconciliation.
  2. Zettly network latency does not cause MCP tool timeouts (>5s timeout race with background outbox fallback).
