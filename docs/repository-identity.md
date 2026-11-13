# Repository identity and cross-project isolation

Status: implemented 13 November 2026, revised for P0 closure.

## The incident this closes

On 13 November 2026 a session pinned to **DBPinball** accepted a **Clinic** task
and replaced its own active task. The working directory never changed and no
cross-project commit was made. The defect was in the orchestration layer: **a
natural-language task description was treated as proof of which repository the
task belonged to.**

## 1. The identity model

| Identity | What it is | Used for |
|---|---|---|
| **Repository** | Normalized Git remote (`host/owner/repo`), or `local:<path>` when there is no remote | Reporting, tag derivation |
| **Workspace** | The canonical checkout directory | **Write authorization** |
| **Checkout family** | The main checkout plus its linked worktrees, which share one git common directory | Read continuity and explicit transitions |
| **Task** | Project, focus, branch, HEAD and allowed scope, recorded at `start_task` | Mutation guard |

`compareIdentity(requested, session)` returns exactly one classification:

| Match | Condition | Task start | Mutation |
|---|---|---|---|
| `SAME_WORKSPACE` | Canonical roots equal | Allowed | Allowed |
| `SAME_CHECKOUT_FAMILY` | Same git common directory | **Explicit transition required** | **Refused** |
| `SAME_REPOSITORY_DIFFERENT_CLONE` | Only the remote key matches | **Refused** | **Refused** |
| `DIFFERENT_REPOSITORY` | Neither remote nor path matches | **Refused** | **Refused** |

`sameRepository()` answers "same remote" and is documented as **repository
identity only**. It never authorizes a switch.

### Worktree write-ownership policy

Two worktrees of one repository share an object store, but they are two writable
trees. They must not share mutable task ownership:

- **Starting** a task in a different worktree is a workspace transition. It
  requires `allowWorkspaceTransition: true` and a `workspaceTransitionReason`
  (≥ 10 characters). The new task records a new identity contract for that
  worktree.
- **Mutating** (commit, push, release, deployment record) requires the exact
  workspace the task started in. A family match is refused with
  `WORKTREE_WRITE_REQUIRES_TRANSITION`.
- Read-only inspection is unaffected, so multi-worktree development still works:
  each worktree gets its own task.

### Authorization to switch project

A refused project switch becomes allowed only with all three of
`allowProjectSwitch: true`, `projectSwitchReason` (≥ 10 characters) and an
explicit `focusId`, plus a target focus not bound to another live project.

## 2. Legacy task migration (P0)

A task started before identity contracts existed is **not** allowed through.

`evaluateMutationIdentity` applies this order:

1. **Valid contract** → compare against the exact workspace.
2. **Missing or malformed contract** → attempt a validated backfill.
3. **Backfill fails** → refuse with `IDENTITY_UNVERIFIABLE_*`.

The backfill is derivation, not fabrication. It uses only evidence the task
itself recorded:

| Evidence | Source | Validation |
|---|---|---|
| `state.repository.path` + `state.repository.remote` | captured by `save()` while the task ran | must equal the live checkout root and remote |
| `state.projectDir` | the task's own declared workspace | must equal the live checkout root |

Refusal codes:

| Code | Meaning |
|---|---|
| `IDENTITY_UNVERIFIABLE_NO_TASK_BINDING` | no contract and no task-declared `projectDir`; a checkout resolved by the caller is not proof |
| `IDENTITY_UNVERIFIABLE_NO_EVIDENCE` | no recorded repository and no declared projectDir |
| `IDENTITY_UNVERIFIABLE_NOT_A_REPO` | the target is not a Git repository |
| `IDENTITY_UNVERIFIABLE_WORKSPACE_MISMATCH` | evidence points at a different checkout |
| `IDENTITY_UNVERIFIABLE_REMOTE_MISMATCH` | recorded remote differs from the live remote |
| `IDENTITY_UNVERIFIABLE_CONFLICT` | `state.repository.path` and `state.projectDir` disagree |
| `IDENTITY_CONTRACT_MALFORMED` | a contract exists but cannot be read |

The binding must come from the **task**, not from the caller. `commit_and_push`,
`perform_release` and `record_deployment` accept a `projectDir` argument, and the
handler writes that argument into `state.projectDir` before the guard runs. The
guard therefore uses the value captured **before** the override. A caller that
names a valid checkout cannot manufacture a task binding by doing so.

A successful backfill is written back to the task state with
`backfilled: true`, `backfilledAt` and `backfilledFrom`, so the migration is
visible rather than silent.

A state that never declared a repository at all (no contract **and** no
`projectDir`) is not a legacy task; the handler's own repository resolution
applies and refuses when it cannot determine one.

## 3. Enforcement boundary inventory

| Entry point | Repo write | Guarded |
|---|---|---|
| `start_task` | state, pin, focus | **Yes** — project switch, workspace transition, focus claim |
| `commit_and_push` | commit, push | **Yes** — exact workspace |
| `perform_release` | tag, release script | **Yes** — exact workspace |
| `record_deployment` | deployment record | **Yes** — exact workspace + identity binding |
| `acquire_release_lock` | lock file | No — names the repo it locks |
| `mark_dod_item`, `run_tests`, `create_documentation`, `check_ready_to_commit` | state only | Not needed |
| `complete_task`, `drop_task`, `force_complete_task` | state, Zettly | No — no repository write |
| `claim/create/update_factory_task` | Factory board | No — no repository write |
| `sync_zettly_task`, `create_feature_flow`, `refine_with_ai` | Zettly / state | No — remote metadata |
| Direct shell, filesystem, terminal `git` | anything | **No — and not sandboxed** |

## 4. Focus binding lifecycle (P0)

A focus is a container for one project's work. Its binding lives at
`<state base>/sessions/focus-<id>.json`, guarded by
`<state base>/sessions/focus-<id>.lock`.

| Phase | Behaviour |
|---|---|
| Claim | The lock record is written to a temp file and **hard-linked** into place. `link(2)` is atomic and fails when the target exists, and the content is complete before the name appears, so a crash cannot leave an unreadable lock. |
| Bounded wait | A contender polls for up to 2 s, then returns `FOCUS_CLAIM_TIMEOUT`. |
| Conflict | A different live project → `FOCUS_BOUND_TO_ANOTHER_PROJECT`; the task is refused before `reset()`. |
| Liveness rule | Elapsed time alone never proves abandonment. A **confirmed dead** owner is recoverable; a **confirmed live** owner keeps the lock regardless of how old the record looks. **Unknown** liveness (another host, unreadable record, invalid PID) is treated as live. |
| Concurrent recovery | Recovering a stale lock requires winning an atomic `rename` of the lock file, so two processes cannot both recover it. The loser retries the atomic create and finds the winner's lock. |
| PID reuse | A reused PID makes a dead owner look alive, which is fail-closed: the contender times out instead of stealing. |
| Restoration | The record lives outside session state, so a restored session reads the same binding. |
| Stale recovery | If the bound project directory no longer exists, the next legitimate use rebinds it (`REBOUND_STALE`). |
| Retirement | `retireFocusBinding` takes the same lock and removes the record explicitly. |

Atomic rename alone was insufficient for two reasons. First, rename is atomic per
write but not first-writer-wins: two processes that both read "no binding" would
both rename and the second would silently replace the first. Second, a
time-based staleness rule would let a contender displace a live owner. The lock
makes the read-decide-write one critical section across operating-system
processes, and ownership is decided by process liveness, not by a clock.

## 5. Deployment record integrity (P1)

`record_deployment` now records and verifies:

| Field | Source |
|---|---|
| `repository.root`, `repository.remote`, `repository.repoKey`, `repository.workspaceKey` | live capture of the task workspace |
| `tagSha` | `git rev-parse <tag>^{commit}` in the task workspace |
| `headSha` | task workspace HEAD, verified to be an ancestor of the tag |
| `task.taskId`, `task.projectId`, `task.focusId` | the task's identity contract |
| `environment` | explicit argument, default `production`, slug-validated |
| `evidence` | required, ≥ 5 characters |
| `attestation` | `{ by: "agent", verified: false, note }` |

**Evidence semantics.** The `evidence` string is an **attestation by the agent or
user** that the deployment happened. This tool does not query the deployment
system, so it records `attestation.verified: false` and never presents the string
as independent proof. What the tool *does* verify is the repository identity, the
tag's existence in that workspace, and that HEAD is an ancestor of the tag. It
does not verify that a production host is serving the tag.

A different checkout cannot manufacture a record merely because its remote
matches: the exact-workspace guard runs first, and the record names the
workspace that produced it.

## 6. CLI contract

```bash
devwf identity --dir <path> [--against <path>] [--json]
```

| Exit | Meaning |
|---|---|
| `0` | Identity read succeeded; with `--against`, the switch is allowed |
| `1` | Refusal: cross-project/workspace switch, invalid path, not a repository, or missing `--dir` |

The `--json` payload is stable and versioned (`schemaVersion: 1`) and includes
`root`, `remote`, `repoKey`, `workspaceKey`, `commonDirKey`, `branch`, `head`,
`detached`, `worktree`, `remotes`, and with `--against` the `against` block and
`decision { ok, code, match, switched }`.

The CLI and the MCP handler call the same functions in `repository-identity.js`.
`identity` is read-only: a test asserts the working tree and HEAD are unchanged.

## 7. Concurrency

- One writer per repository: the `mcp-process.lock` heartbeat refuses a second
  live MCP process on the same project.
- The identity guard runs before the lock check, so a cross-project attempt is
  refused even when the target repository is idle.
- Focus claims are serialized by an OS-level exclusive lock with bounded wait
  and stale-lock recovery.
- Filesystem timestamps are not the primary concurrency protection.

## 8. Recovery

| Situation | Action |
|---|---|
| Refused a legitimate project switch | `allowProjectSwitch: true` + reason + `focusId` |
| Need a second session on the same repository | `git worktree add`, then `start_task` with `allowWorkspaceTransition: true` + reason |
| Focus bound to the wrong project | `retireFocusBinding`, then set a new focus |
| Legacy task refused | Start the task again in the intended repository so a contract is recorded |
| Session pointer stale | Ignored automatically |
| Inspect without starting a task | `devwf identity --dir <path> [--against <path>]` |

## 9. Residual bypass paths

1. An agent that edits files without calling `start_task`.
2. `allowProjectSwitch` / `allowWorkspaceTransition` with a plausible reason — a decision is required, intent cannot be verified.
3. `git` or shell commands run outside the MCP tools — not sandboxed.
4. A state with no contract and no `projectDir` has no repository context; the handler's own resolution applies.
5. A repository with no remote keeps a `local:<path>` identity, so a move looks like a new project.

## 10. Verification

```bash
node --no-deprecation --import ./tests/setup-env.js --test tests/repository-identity-guard.test.js
npm test
npm run lint
npm run check
npm run build:server
```

The focused suite covers: correct repository accepted, wrong repository refused,
wrong focus refused, missing focus refused, active task preserved, directory
rename, same remote different clone refused, worktree transition required,
changed branch, changed remote URL, fork vs upstream, multiple remotes, no
remote, detached HEAD, single-writer lock, stale pointer, no mutation on
refusal, focus binding persistence, explicit retirement, stale focus recovery,
concurrent focus claims, **cross-process focus claims**, stale lock recovery,
legacy backfill, malformed/stale/conflicting contracts, worktree write refusal,
deployment identity binding, CLI read-only behaviour, CLI JSON contract and CLI
usage errors.
