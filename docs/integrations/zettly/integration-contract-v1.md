# Zettly ↔ DevWorkflow Integration Contract v1
**Specification Version:** 1.0.0  
**Effective Date:** 2026-11-12  
**Status:** Canonical First-Party Integration Specification  

---

## 1. System Boundaries & Role Separation

DevWorkflow MCP Server and Zettly are distinct, independently deployable systems joined by a structured contract:

```text
+---------------------------------------------------------------------------------+
|                       ZETTLY — Human Planning & Control Plane                   |
|  - Human requirements capture         - Eisenhower priority matrix              |
|  - Notes & contextual knowledge       - Visual architecture & dependency graphs |
|  - User-facing status & dashboards    - Human review & release approval         |
+---------------------------------------------------------------------------------+
                                      ^
                                      | [Bidirectional Events / REST / Outbox]
                                      v
+---------------------------------------------------------------------------------+
|                   DEVWORKFLOW — AI Execution & Governance Plane                 |
|  - Machine-readable Task Contracts    - Finite state machine enforcement        |
|  - Policy-as-Code evaluation          - Git worktree isolation & leases         |
|  - Empirical test & evidence store    - Scope drift & path boundary guards      |
|  - Conventional commit & release lock - Immutable event audit journal           |
+---------------------------------------------------------------------------------+
                                      ^
                                      | [MCP stdio / JSON-RPC / CLI]
                                      v
+---------------------------------------------------------------------------------+
|                     AI CODING AGENTS — Worker Execution Layer                   |
|         (Antigravity CLI/IDE, OpenCode, Codex, Claude Code, Cursor)             |
+---------------------------------------------------------------------------------+
```

### Core Invariants:
1. **Zero Hard Coupling:** DevWorkflow functions 100% offline and locally without Zettly. Zettly functions 100% normally without DevWorkflow.
2. **Clear Ownership:** Neither system overwrites fields owned by the other.
3. **No Silent Governance Bypass:** Marking a Zettly Todo as completed in the UI does **not** bypass DevWorkflow's TDD, documentation, or release gates.

---

## 2. Data Ownership Matrix

| Domain Field | Authoritative Source of Truth | Secondary Consumer |
|---|---|---|
| Todo Title & Description | **Zettly** | DevWorkflow (read as Task Intent) |
| Priority & Eisenhower Quadrant | **Zettly** | DevWorkflow (maps to initial risk hint) |
| Notes & Zettelkasten Knowledge Context | **Zettly** | DevWorkflow (injected as untrusted context) |
| Visual Canvas / TLDraw Diagram | **Zettly** | DevWorkflow (visual plan representation) |
| **Task Contract (Scope & Boundaries)** | **DevWorkflow** | Zettly (rendered for human audit) |
| **Execution State & Phase** | **DevWorkflow** | Zettly (rendered in dashboard badge) |
| **Policy Engine Decisions & Gates** | **DevWorkflow** | Zettly (approval queue prerequisite) |
| **Test Evidence & Digests** | **DevWorkflow** | Zettly (verification report card) |
| **Git Worktree & Lease Status** | **DevWorkflow** | Zettly (active worker display) |
| **Human Approval Decision** | **Zettly (Authorized Approver)** | DevWorkflow (unlocks `READY` $\rightarrow$ `INTEGRATED`) |
| **Git / CI/CD Deployment Record** | **DevWorkflow / VCS Runner** | Zettly (recorded as final outcome) |

---

## 3. Stable Cross-System Task Identity Mapping

Cross-system relationships are anchored by immutable, persistent identifiers rather than mutable text strings:

```json
{
  "taskId": "task-uuid-v4-or-cuid",
  "zettly": {
    "todoId": 634,
    "focusId": 67,
    "drawingId": 42,
    "noteIds": [128, 129]
  },
  "execution": {
    "executionId": "exec-uuid",
    "sessionId": "opencode-pid-12345",
    "worktree": ".worktrees/task-uuid",
    "leaseEpoch": 3
  },
  "git": {
    "repo": "dev-workflow-mcp-server",
    "baseSha": "ebdc8a4fa4e9",
    "commitSha": "cdaa50567123",
    "branch": "feat/cli-first-architecture-support"
  }
}
```

### Embedded Synchronization Marker in Zettly
When DevWorkflow synchronizes progress to a Zettly Todo description, it uses an isolated, machine-delimited HTML comment section that leaves human notes untouched:

```html
<!-- dev-workflow:task-uuid:start -->
<section data-dev-workflow-id="task-uuid">
  <h3>Dev Workflow Governance</h3>
  <p>Task ID: <code>task-uuid</code> | Phase: <code>VERIFYING</code></p>
  <h4>Definition of Done</h4>
  <pre>[x] dod-1: CLI command verified — output digest sha256:abcd...</pre>
  <h4>Evidence & Quality Gates</h4>
  <p>Tests: 1767 passed, 0 failed | Doc Gate: PASS</p>
</section>
<!-- dev-workflow:task-uuid:end -->
```

---

## 4. Bidirectional Event Contracts

Synchronization communicates via structured, versioned event schemas with idempotency keys (`eventId` / `dedupeKey`):

### 4.1 Zettly $\rightarrow$ DevWorkflow Events
- `zettly.todo.created`: Human defines a new task with intent and optional tags.
- `zettly.todo.updated`: Human updates title, description, or acceptance criteria.
- `zettly.todo.priority_changed`: Priority change triggers dynamic risk re-evaluation.
- `zettly.approval.granted`: Human manager authorizes release/merge for a specific Task Contract revision.
- `zettly.approval.rejected`: Human rejects task completion with reviewer comments.

### 4.2 DevWorkflow $\rightarrow$ Zettly Events
- `devworkflow.task.planned`: Task Contract, DoD checklist, and Mermaid dependency graph recorded.
- `devworkflow.task.executing`: Agent acquired worktree lease and commenced implementation.
- `devworkflow.task.verifying`: Tests executed; evidence digests recorded.
- `devworkflow.task.blocked`: Scope drift or security violation halted execution; requires human attention.
- `devworkflow.task.ready`: All quality gates satisfied; approval requested.
- `devworkflow.task.integrated`: Branch merged and release published; final outcome recorded.
- `devworkflow.task.failed`: Execution aborted or cancelled.

---

## 5. Requirements Change Management Protocol

If a human modifies a Zettly Todo description or acceptance criteria while an AI agent is actively executing:
1. **Change Detection:** DevWorkflow's synchronization poll or webhook detects `updated_at > task.contract.syncedAt`.
2. **Digest Comparison:** The engine compares the incoming requirement hash with `contract.intentDigest`.
3. **Scope Impact Evaluation:**
   - If change is purely cosmetic or supplementary, update context without pausing.
   - If change alters acceptance criteria or expands scope:
     a. Transition state from `EXECUTING` to `PAUSED` / `BLOCKED`.
     b. Invalidate currently accumulated test evidence (`STALE_REQUIREMENTS`).
     c. Alert the active AI agent via MCP error prompt.
     d. Require agent to call `refine_with_ai` and produce a revised Task Contract.
     e. Require human confirmation before resuming execution.

---

## 6. Visual Planning & Zettly Draw Contract

Zettly Draw provides visual flowcharting backed by the TLDraw v4 store schema.
1. **Authoritative Flow Representation:** The text-based Mermaid code in the Task Contract is the source of truth for the dependency graph.
2. **Canvas Generation:** `zettly-drawing.js` compiles the Mermaid flow into TLDraw shapes using:
   - Fractional indexing (`fractionalIndex()`: `a0`, `a1`, etc.).
   - ProseMirror richText formatting (`{ type: 'doc', content: [...] }`).
   - Metadata tags (`meta: { zettlyTodoId, workflowTaskId }`).
3. **Visual Revisions:** If a human edits shapes in Zettly Draw, the updated canvas proposes a revised plan graph; the AI agent must validate and adopt the graph before executing code.

---

## 7. Human Approval Protocol Specification

For tasks classified as `CRITICAL` or touching protected production paths:

```json
{
  "approvalId": "appr-uuid-v4",
  "taskId": "task-uuid-v4",
  "contractRevision": 2,
  "policyDigest": "sha256:7f83b165...",
  "requestedScope": ["src/auth/**", "database/migrations/**"],
  "evidenceReferences": [
    { "type": "test_report", "digest": "sha256:e3b0c442..." },
    { "type": "security_audit", "status": "CLEAN" }
  ],
  "approver": {
    "userId": 1,
    "email": "mahatma.mahardhika@programinglive.com",
    "role": "lead_architect"
  },
  "decision": "APPROVED",
  "decisionTimestamp": "2026-11-12T19:30:00Z",
  "expiresAt": "2026-11-13T19:30:00Z"
}
```

- **Replay Protection:** If the agent subsequently modifies any file after approval is granted, the Git tree SHA changes, instantly invalidating the approval.

---

## 8. Failure Isolation & Transactional Outbox

- **Local Transactional Outbox:** Outbound Zettly synchronizations are written to the local SQLite `sync_queue` table inside the same transaction as the state mutation.
- **Background Worker:** A background promise flushes the queue with exponential backoff (`attempts`, `next_attempt_at`).
- **Resilience Invariant:** If Zettly's API is unreachable (HTTP 503, DNS failure, timeout), the local MCP session proceeds normally without error. The outbox retries automatically when connectivity resumes.
