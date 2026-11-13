# DevWorkflow Architecture — Architecture Decision Records (ADRs)

**Document Version:** 1.0.0  
**Status:** Approved for Implementation  
**Standard:** MADR 3.0.0 (Markdown Architectural Decision Records)  

---

## ADR-001: Incremental Evolution via Strangler Fig vs Greenfield Rewrite

### Context
DevWorkflow currently has 1,794 automated tests (1,767 passing), 57 active MCP tools, an established fleet rollout process across three workstations, and active integration with real-world development tasks. A greenfield rewrite risks regressions, breaking ongoing engineering sessions, and losing hard-won edge case handling.

### Decision
We choose an **incremental evolution using the Strangler Fig pattern**. New architectural capabilities (Task Contracts, Policy Engine, Evidence Store, Worktree Manager) will be introduced as modular subsystems behind ports-and-adapters interfaces, maintaining 100% backward compatibility with the existing MCP wire protocol.

### Consequences
- **Positive:** Zero disruption to daily development; every milestone is independently testable and deployable; existing test suite guarantees no regressions.
- **Negative:** Requires temporary compatibility adapters and dual-write storage during transition.

---

## ADR-002: Declarative Policy-as-Code (`devworkflow.yaml`) vs Hardcoded Prompt Guidance

### Context
Currently, development rules (English implementation, CLI-first, TDD, documentation requirements) are hardcoded into JavaScript source code and prompt guidance strings. Different projects (libraries, prototypes, microservices) require different governance strictness.

### Decision
We introduce a versioned, machine-readable `devworkflow.yaml` file in the repository root defining governance profiles (`lightweight`, `standard`, `critical`) and path-based overrides. If absent, the engine falls back to the built-in "Standard" profile.

### Consequences
- **Positive:** Repositories declare their own governance; policies can be reviewed in pull requests; agents cannot arbitrarily weaken policy requirements without review.
- **Negative:** Requires maintaining a JSON Schema validator and policy evaluation engine.

---

## ADR-003: Structured Task Contracts with Scope-Drift Detection

### Context
AI coding agents are frequently susceptible to scope drift—modifying files outside their assigned task (e.g. editing global configs or unrelated business logic). The current system only tracks task description and DoD strings without path boundaries.

### Decision
We introduce structured **Task Contracts** supporting explicit `allowedPaths` and `forbiddenPaths` glob patterns. Before allowing commit and push, DevWorkflow deterministically compares changed git files against the contract. Touched files outside `allowedPaths` block the workflow and require explicit scope review.

### Consequences
- **Positive:** Hard boundaries against unintended agent hallucination and runaway edits; auditable change blast radius.
- **Negative:** Agents must declare or refine scope when tasks legitimately require broader refactoring.

---

## ADR-004: Evidence Store with Git Tree Digests vs Boolean Claims

### Context
Currently, test execution relies on boolean flags (`testsPassed: true`) submitted by the agent. An agent can fabricate a passing status, or modify source code *after* running tests without invalidating the passing status (stale evidence).

### Decision
We replace self-reported booleans with an immutable **Evidence Store**. Every test execution records the Git tree SHA, executed command, exit code, output digest, and timestamp. Any change to source files after test execution automatically sets the verification state to `STALE`, blocking commit.

### Consequences
- **Positive:** Genuine verification integrity; impossible for an agent to claim tests passed without verifiable execution against the exact code commit.
- **Negative:** Requires storing execution records in local SQLite and computing tree digests.

---

## ADR-005: Worktree Isolation & Distributed Leases vs Coarse Project Locking

### Context
`process-lock.js` currently places a single lock file (`mcp-process.lock`) on the entire repository folder. Multiple AI agents cannot work concurrently on separate features in the same repository without risking collision or manual lock overrides.

### Decision
We evolve repository concurrency into **Git Worktree Isolation**. Each task is allocated an isolated worktree under `.worktrees/<task-id>`. Access is managed via a Lease Manager with heartbeats and fencing tokens. Shared resources (migrations, releases) are protected via a serialized merge queue.

### Consequences
- **Positive:** Safe parallel multi-agent development on the same repository; clean workspace isolation.
- **Negative:** Increased local disk usage for worktrees; requires robust cleanup routines for merged worktrees.

---

## ADR-006: Ports-and-Adapters Provider SDK for Open-Source Decoupling

### Context
DevWorkflow currently has direct hardcoded imports of proprietary services (Zettly, internal release servers). This prevents open-sourcing the core runtime and hinders offline air-gapped usage.

### Decision
We decouple integrations using a **Ports-and-Adapters Provider SDK**:
- `TaskTrackerProvider`: Default Local SQLite/Markdown, optional GitHub Issues, Linear, Zettly.
- `VisualFlowProvider`: Default Local Mermaid CLI/SVG, optional Zettly Draw, Excalidraw.
- `StorageProvider`: Default SQLite, optional PostgreSQL, MySQL.

### Consequences
- **Positive:** The core runtime can be 100% open-sourced, running locally with zero external network calls; enterprise/internal adapters become clean plugins.
- **Negative:** Requires defining formal provider interfaces and capability discovery contracts.

---

## ADR-007: CLI-First & Headless-First Architecture Parity

### Context
`devwf` currently only handles session maintenance. Core governance commands (starting tasks, reviewing DoD, running verification, checking policies) can only be executed through an active MCP client connection.

### Decision
We implement a comprehensive CLI interface (`devworkflow`) providing full lifecycle parity with the MCP tools. All operations can be executed headlessly in scripts, CI pipelines, or manual terminal sessions.

### Consequences
- **Positive:** Developers and CI runners can enforce and inspect DevWorkflow governance without launching an AI chat interface.
- **Negative:** Must maintain CLI argument parsers and formatted terminal outputs in sync with MCP tool schemas.

---

## ADR-008: Append-Only Event Journal for Reliability & Audit

### Context
Workflow state is currently stored as a mutable JSON blob in an SQLite row. When processes terminate abruptly, state can be left in an uncertain or corrupted state without an audit trail of preceding actions.

### Decision
We introduce an **Append-Only Event Journal** (`event_journal` table). Every state transition, tool call, evidence verification, and policy decision is appended as an immutable event. The current state is deterministically verifiable and recoverable from the event stream.

### Consequences
- **Positive:** Complete auditability; crash resilience; ability to replay and analyze multi-agent trajectories.
- **Negative:** Additional storage footprint for journal records (managed via retention policies).
