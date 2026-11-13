# Repository identity and cross-project isolation

Status: implemented 13 November 2026, revised after final review.

## The incident this closes

On 13 November 2026 a session pinned to **DBPinball** accepted a **Clinic** task
and replaced its own active task. The investigation found the working directory
never changed and no cross-project commit was made. The defect was in the
orchestration layer: **a natural-language task description was treated as proof
of which repository the task belonged to.**

## 1. The identity model

There are three distinct identities, and they are deliberately not
interchangeable:

| Identity | What it is | Used for |
|---|---|---|
| **Repository** | Normalized Git remote (`host/owner/repo`), or `local:<path>` when there is no remote | Reporting, tag derivation, "is this the same project?" |
| **Workspace** | The canonical checkout directory | **Authorizing continuity** |
| **Checkout family** | The main checkout plus all its linked worktrees, which share one git common directory | Legitimate multi-worktree development |
| **Task** | Project, focus, branch, HEAD and allowed scope, recorded at `start_task` | Mutation guard |

### Comparison rules

`compareIdentity(requested, session)` returns exactly one classification:

| Match | Condition | Consequence |
|---|---|---|
| `SAME_WORKSPACE` | Canonical roots equal | Continue. A branch change or a remote URL change is still the same workspace. |
| `SAME_CHECKOUT_FAMILY` | `git rev-parse --git-common-dir` equal | Continue. A linked worktree shares one object store and refs. |
| `SAME_REPOSITORY_DIFFERENT_CLONE` | Only the remote key equal | **Refuse.** Two clones are independently writable. |
| `DIFFERENT_REPOSITORY` | Neither remote nor path matches | **Refuse.** |
| `UNKNOWN` | Either side missing | No decision |

`sameRepository()` still answers "same remote", and is documented as
**repository identity only**. It must never authorize a switch. The authorization
decision is `compareIdentity` / `evaluateProjectSwitch`.

This is the change the final review required: a matching remote no longer
silently authorizes moving a task between two clones. A worktree does, because it
is the same checkout family, not a second writable copy.

### Authorization to switch

A refused switch becomes allowed only with **all three** of:

```json
{
  "allowProjectSwitch": true,
  "projectSwitchReason": "why this session must move",
  "focusId": 73
}
```

Plus: the target focus must not be bound to another project.

## 2. Enforcement boundary inventory

| Entry point | Mutates | Repository/task context | Guarded |
|---|---|---|---|
| `start_task` | Workflow state, session pin, focus binding | Yes | **Yes** — `evaluateProjectSwitch` + focus binding, before `reset()` |
| `commit_and_push` | Git commit + push | Yes (`projectDir` override) | **Yes** — `assertTaskRepository` |
| `perform_release` | Git tag, release script, deployment | Yes (`projectDir` override) | **Yes** — `assertTaskRepository` |
| `record_deployment` | Deployment record | Yes (`projectDir` override) | **Yes** — `assertTaskRepository` |
| `acquire_release_lock` | Lock file | Yes | No — a lock is not a repository write; it names the repo it locks |
| `mark_dod_item`, `run_tests`, `create_documentation`, `check_ready_to_commit` | Workflow state only | No filesystem write outside state | Not needed |
| `complete_task`, `drop_task`, `force_complete_task` | Workflow state, Zettly | Yes | Not guarded — closing a task does not write to the repository |
| `claim_factory_task`, `create_factory_task`, `update_factory_task` | Factory board | Project name, not a checkout | Not guarded — no repository write |
| `sync_zettly_task`, `create_feature_flow`, `refine_with_ai` | Zettly / state | Yes | Not guarded — remote task metadata only |
| Direct shell / filesystem / `git` outside MCP tools | Anything | None | **Not guarded and not sandboxed** |

The guard is applied where an operation both **writes into a repository** and
**has a task context**. Read-only operations are untouched, so there is no
breaking change to listing, status, context or reporting tools.

### What cannot be guarded without a larger change

- Arbitrary shell commands an agent runs outside the MCP tools.
- Direct file edits made without calling `start_task`.
- `git` invocations in a terminal.

The MCP cannot sandbox the machine. Claiming otherwise would be false.

## 3. Focus binding lifecycle

A focus is a container for one project's work. Its binding is stored at
`<state base>/sessions/focus-<id>.json`.

| Phase | Behaviour |
|---|---|
| **Claim** | Written at `start_task` before any state reset, atomically (temp file + rename). |
| **Reuse** | Same repository key or same workspace root → allowed. |
| **Conflict** | A different live project → `FOCUS_BOUND_TO_ANOTHER_PROJECT`; the task is refused before `reset()`. |
| **Restoration** | The record lives outside session state, so a restored session reads the same binding. |
| **Stale recovery** | If the bound project directory no longer exists, the next legitimate use rebinds it (`REBOUND_STALE`). A deleted checkout cannot block recovery forever. |
| **Retirement** | `retireFocusBinding({ stateFile, focusId, reason })` removes the record explicitly. Nothing else deletes it. |
| **Concurrency** | Two simultaneous claims: the atomic rename means one wins; the loser re-reads and reports the conflict instead of overwriting. |

## 4. CLI contract

```bash
devwf identity --dir <path> [--against <path>] [--json]
```

| Exit | Meaning |
|---|---|
| `0` | Identity read succeeded; with `--against`, the switch is **allowed** |
| `1` | Refusal: cross-project/workspace switch, invalid path, not a git repository, or missing `--dir` |

The `--json` payload is stable and versioned:

```json
{
  "schemaVersion": 1,
  "root": "D:\\code\\dbpinball",
  "remote": "https://github.com/programinglive/dbpinball.git",
  "repoKey": "github.com/programinglive/dbpinball",
  "workspaceKey": "d:/code/dbpinball",
  "commonDirKey": "d:/code/dbpinball/.git",
  "branch": "feat/cli-first-m2-cli-foundation",
  "head": "1015379f105fcc912c3e2bfa0ea6306b319d6932",
  "detached": false,
  "worktree": false,
  "remotes": [{ "name": "origin", "url": "...", "key": "..." }],
  "against": { "root": "...", "remote": "...", "repoKey": "...", "workspaceKey": "...", "commonDirKey": "..." },
  "decision": { "ok": false, "code": "PROJECT_SWITCH_REQUIRES_AUTHORIZATION", "match": "DIFFERENT_REPOSITORY", "switched": false }
}
```

The CLI and the MCP handler call the **same** functions in
`repository-identity.js`. There is no second comparison implementation.

`identity` is read-only: no file, index, ref or state is written. A test asserts
the working tree and HEAD are unchanged after a run.

## 5. Concurrency

- One writer per repository: the `mcp-process.lock` heartbeat refuses a second
  live MCP process on the same project.
- The identity guard runs **before** the lock check, so a cross-project attempt
  is refused even when the target repository is idle.
- Focus records use atomic rename, not read-modify-write.
- Filesystem timestamps are **not** used as the primary concurrency protection.
  The lock heartbeat and the atomic state/focus writes are the sources of truth.
- A task is bound to the checkout it started in for the whole task, so a later
  `projectDir` override cannot move a mutation to another clone.

## 6. Recovery

| Situation | Action |
|---|---|
| Refused a legitimate switch | Repeat with `allowProjectSwitch: true`, a written reason, and the target `focusId` |
| Need a second session on the same repository | Use a linked worktree (`git worktree add`); it is continuity, not a switch |
| Focus bound to the wrong project | `retireFocusBinding`, then set a new focus |
| Session pointer stale (project moved/deleted) | Ignored automatically; start in the new location |
| Two sessions on one repository | Close the other window, use a worktree, or `force: true` when it is idle |
| Inspect without starting a task | `devwf identity --dir <path> [--against <path>]` |

## 7. Residual bypass paths

1. An agent that edits files without calling `start_task`.
2. `allowProjectSwitch: true` with a plausible reason — a decision is required, intent cannot be verified.
3. `git` or shell commands run outside the MCP tools.
4. A task started before identity contracts existed has no contract and is allowed through as `legacy`.
5. A repository with no remote keeps a `local:<path>` identity; a move looks like a new project.

## 8. Verification

```bash
node --no-deprecation --import ./tests/setup-env.js --test tests/repository-identity-guard.test.js
npm test
npm run lint
npm run check
npm run build:server
```

The focused suite covers: correct repository accepted, wrong repository refused,
wrong focus refused, missing focus refused, active task preserved, directory
rename, **same remote different clone refused**, **same checkout family accepted**,
changed branch, changed remote URL, fork vs upstream, multiple remotes, no remote,
worktree, detached HEAD, single-writer lock, stale pointer, no mutation on
refusal, focus binding persistence, explicit retirement, stale focus recovery,
concurrent focus claims, CLI read-only behaviour, CLI JSON contract and CLI usage
errors.
