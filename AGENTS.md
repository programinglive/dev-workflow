# Dev Workflow Enforcement Rules

## 🛑 MANDATORY MCP WORKFLOW DISCIPLINE

You are connected to the `dev-workflow` MCP server. **You MUST NOT perform any coding task, bug fix, or feature implementation without going through the strict workflow enforced by the dev-workflow MCP tools.**

### The Rule of Operation
Before taking any action or answering user requests regarding code changes, check your workflow status and follow these exact steps in sequence:

1. **Start Task**: Call `start_task` with a clear description, type (`feature`, `bugfix`, `refactor`, or `other`), `projectDir`, **a `definitionOfDone` checklist, and a `plan`** (1-15 ordered steps). The DoD says what must be true before it counts as finished; the plan is the order you will actually work in, and it is what lets a human watch progress.
2. **Resume if needed**: if this session is new and a previous one left work behind, `resume_session` lists it and `{ adopt: "ses_..." }` continues from that state instead of restarting the task.

   `start_task` **refuses** when another live MCP process is working the same project (heartbeat within the last 10 minutes). Two sessions on one working tree overwrite each other's files silently - on 31 October 2026 a session lost every edit in `tools/handler-modules/index.js` that way. Close the other window, use a git worktree, or pass `force: true` when you know the other session is idle. The check runs before any state is touched, so a refused call changes nothing.

   `start_task` also **refuses when the state already holds a running task owned by another live process**, and `force` does not override that one. Starting a task there would clear that task's Definition of Done, and its evidence cannot be recovered from history. Finish it from the owning session (`complete_task` / `drop_task`), use a worktree, or retry with `force: true` once that process is gone. State is stored per session since 1.17.0, so two windows on one repo no longer share a file.

   `start_task` also **refuses a cross-project switch**. It resolves the canonical Git root and remote of the requested `projectDir`, compares them with the repository this session already established, and refuses when they differ. Three identities are separate: the **repository** (normalized remote), the **workspace** (this exact checkout) and the **checkout family** (the main checkout plus its linked worktrees). A matching remote alone does not authorize continuing in another clone, because two clones are independently writable; a linked worktree of the same checkout family does. A task description is not proof of which repository it belongs to: on 13 November 2026 a session pinned to DBPinball accepted a Clinic task and replaced its own active task because nothing compared the two. A genuine switch needs all three of `allowProjectSwitch: true`, a written `projectSwitchReason` (≥ 10 characters) and an explicit `focusId`. A refusal happens before any state is touched, so the active task and its evidence are unchanged. See `docs/repository-identity.md`.

   `commit_and_push`, `perform_release` and `record_deployment` apply the same identity contract before they write: a task is bound to the exact checkout it started in, so a `projectDir` override cannot move a commit or a release into another clone or another worktree. A task started before identity contracts existed is **not** allowed through: its identity is backfilled only from evidence the task itself recorded (`state.repository` or its declared `projectDir`) and only when that evidence matches the live checkout; otherwise the mutation is refused. A missing identity is not permission to write. A state that never declared a repository has no repository context and the handler's own resolution applies.


   A focus is bound to the first repository that uses it. Reusing a focus that another project owns is refused, because a focus that reports foreign work is a focus that lies. The claim is serialized by an OS-level exclusive lock with a bounded wait. Ownership is decided by process liveness, not by a clock: a confirmed-dead owner is recovered, a live owner keeps the lock however old the record looks, and unknown liveness is treated as live.

   A linked worktree of the same repository is a **workspace transition**, not automatic continuity: starting a task there requires `allowWorkspaceTransition: true` and a `workspaceTransitionReason`, and an existing task may not commit or release into a different worktree.

2. **Implement**: Write your code changes.
3. **Mark Fixed**: Call `mark_bug_fixed` with a summary of the implementation.
4. **Prove the Definition of Done**: For each item, call `mark_dod_item` with `evidence` (5-500 characters naming what you actually ran or checked, e.g. `npm test -> 505 pass`). An item that turned out not to apply is excluded with `waive_dod_item` and a written reason - never silently dropped.
5. **Create Tests**: Create appropriate unit/integration tests covering your changes.
6. **Run Tests**: Execute your test suite and call `run_tests` with `passed: true` and the test command. **Never commit if tests fail!**
7. **Document**: Update documentation (README, PRD, release notes) and call `create_documentation` **with `files`** — the paths you actually changed, e.g. `files: ["README.md"]`. They are verified against the working tree, and the commit is blocked while source code changed without a documentation change. If the change genuinely alters nothing the documentation describes, call `waive_documentation { reason }` instead; the reason is recorded and shown again later.
8. **Ready Check**: Call `check_ready_to_commit` to verify all steps. It fails while any definition-of-done item is still open, and while source changed without a documentation change or a waiver.
9. **Commit & Push**: Call `commit_and_push` with a conventional commit message. It refuses while any item is open.

   If the repo also contains another session's uncommitted work, `commit_and_push`
   refuses to stage the whole tree. Pass `paths` with only the files this task
   touched (recommended), or `includeForeign: true` after verifying that work
   belongs in this commit. Never resolve it by overwriting the other session's
   files.
10. **Release**: Call `perform_release` with the release command (or `skip_release` if non-Node/docs-only).
11. **Complete**: Call `complete_task` to finish the session and reset the workflow. It refuses while any item is open, and records `dodSummary` in history. Pass `nextSteps` (1-5 items, 10-200 characters) with the follow-ups you noticed while working; the tool adds its own from facts the session produced. `next_steps` shows the stored list again in a later session.

### Definition of Done

`start_task` **requires** `definitionOfDone`: 1-20 items, each 3-300 characters, no duplicates. The workflow will not let you commit or close a task while an item is still open.

- `mark_dod_item { id, evidence }` proves an item. Re-marking a proven item refreshes its evidence.
- `waive_dod_item { id, reason }` excludes an item with a written reason. A proven item cannot be waived.
- `set_definition_of_done { items, append }` fills the checklist of a task started before this rule existed. Replacing a list that already has proven items is refused unless `append: true`.
- When new working changes appear after a commit, `dodRevision` goes up and previously proven items must be re-confirmed against the code that is actually being committed. Waivers survive.

`force_complete_task` remains the audited escape hatch: it records `forced: true` with your reason and the DoD summary.

### Quick Shortcuts
- If you have all information ready, you can use `run_full_workflow` to execute all steps safely in sequence.
  It requires `dodEvidence` for every definition-of-done item that is still open — for example
  `"dodEvidence": { "dod-1": "npm test -> 533 pass" }`. Without it the call stops **before the first step** and
  lists the items it needs, because it cannot invent proof. The evidence is recorded just before the ready check,
  so it describes code that has already been written.
- Use `get_workflow_status` at any time to check what step is next.

**Do not bypass these steps. The MCP server will block commits and releases if any required step is skipped.**

### Stale-session reaper (server-enforced)

`session-reaper.js` classifies sessions as `ACTIVE`, `IDLE`, `SUSPECTED_STALE`,
`UNREACHABLE`, `TERMINATED`, `ORPHANED`, `RECOVERY_REQUIRED` or `ARCHIVED`.
A PID is not proof of ownership: process creation time and executable identity
are compared, and a mismatch is `RECOVERY_REQUIRED`. A disconnected machine is
`UNREACHABLE`, never `TERMINATED`. A release lock, an active child, or
uncommitted work keeps a session `ACTIVE`. Lease release is compare-and-swap on
owner + generation + fencing token; if ownership changes during cleanup the
plan aborts. Confirmed orphans are archived after the lease is released; idle
sessions are stopped gracefully only when explicitly auto-disposable. Every
action is audited and canonical checkpoints are never deleted.

The Monitor (`monitor-server/`) is the only place that reads process ownership.
`POST /api/reaper/sessions` is HMAC-signed with `DEVWF_REAPER_SECRET` and a
60-second replay window; the public `/api/sessions` payload carries only
`reaper_state`, `reaper_reason` and `reaper_actions`, never the owner PID,
creation time, executable or fencing token. `reaper-scheduler.cjs` runs one
idempotent cycle per interval, refuses to overlap itself, defaults to dry-run
(`DEVWF_REAPER_DRY_RUN=0` enables archiving), and archives only a confirmed
`ORPHANED` session. `reaper-actions.cjs` is the single authorization table the
endpoint and the UI share. The machine-local controller
(`session-controller-adapters.js`) verifies PID + creation time + executable
before any stop and refuses a PID shared by more than one session; it never
escalates to a force kill.

### README-first preflight (server-enforced)

`start_task` records a bounded preflight automatically: the project root,
`README.md`, root and nested `AGENTS.md`, and documented CLI entrypoints. The
record contains paths and SHA-256 fingerprints, never document bodies or secret
values. `start_task` also returns a bounded instruction summary: purpose, rules,
build/test/release commands, prohibited operations, task scope and documentation
paths. `resume_session` revalidates the fingerprints and reports
`README_CHANGED` / `AGENTS_CHANGED`.

`acknowledge_instructions` records the README fingerprint and task scope; the
server validates both against the current preflight. `commit_and_push` requires
that acknowledgment when a preflight exists. The same scope check applies to
`perform_release` and `record_deployment`: a governed write must target the
checkout the task preflight recorded (`SCOPE_MISMATCH`). Legacy tasks without a
preflight remain governed by the repository identity contract. Discovered CLI
references are advisory (`verified: false`) and are never executed
automatically.
