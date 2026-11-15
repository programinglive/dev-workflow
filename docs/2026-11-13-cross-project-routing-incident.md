# Incident closure — 13 November 2026 cross-project routing

Status: **resolved** at the DevWorkflow task-routing and controlled-mutation
boundaries.

This record closes the incident in which a session pinned to one repository
accepted a task belonging to another repository and replaced its own active
task. It states what was proven, what was changed, and what remains outside the
guard's reach.

## 1. Root cause

`start_task` resolved the requested `projectDir` and never compared it with the
repository the session had already established. A natural-language task
description was therefore treated as proof of which repository the task belonged
to. The working directory never changed, and no cross-project commit was made;
the defect was in task routing, not in git.

A second, related gap: `commit_and_push`, `perform_release` and
`record_deployment` accepted a `projectDir` override and ran git in it without
checking that the task owned that checkout.

## 2. Confirmed affected workspaces

| Workspace | Effect |
|---|---|
| DBPinball (`programinglive/dbpinball`) | The session's active task was replaced; no DBPinball file was modified by the Clinic work |
| Clinic (`beautyworld_repository/clinic`) | Files were modified by this session after the switch; all changes remained uncommitted and were preserved |
| DevWorkflow (`programinglive/dev-workflow-mcp-server`) | The routing layer that allowed the switch |

No commit, push, merge, deploy or production database operation crossed the
boundary.

## 3. Implemented controls

| Control | Where | Behaviour |
|---|---|---|
| Repository identity contract | `repository-identity.js` | Records project, repository, workspace, checkout family, branch, HEAD and focus at `start_task` |
| Project switch guard | `start_task` | Refuses a different repository unless `allowProjectSwitch`, a written reason and an explicit `focusId` are all supplied |
| Workspace transition guard | `start_task` | A linked worktree is a transition, not automatic continuity; requires `allowWorkspaceTransition` and a reason |
| Mutation guard | `commit_and_push`, `perform_release`, `record_deployment` | Requires the exact workspace the task started in |
| Legacy fail-closed | `evaluateMutationIdentity` | A missing or malformed contract is backfilled only from verified evidence; otherwise refused |
| No-binding refusal | `assertMutationRepository` | A caller-supplied `projectDir` is not a task binding; refuses with `IDENTITY_UNVERIFIABLE_NO_TASK_BINDING` |
| Focus ownership | `claimFocusBinding` | OS-level exclusive lock, bounded wait, liveness-based recovery, atomic recovery rename |
| Focus↔project binding | `readFocusBinding` / `writeFocusBinding` | A focus cannot be reused by an unrelated project |
| Deployment identity | `record_deployment` | Records repository, tag SHA, task, environment and an unverified attestation |
| Headless verification | `devwf identity` | Same evaluation logic as the MCP handler, versioned JSON, documented exit codes |

## 4. Regression evidence

| Check | Result |
|---|---|
| Focused identity suite | 46 tests, 46 pass, 0 fail |
| Full suite | 1973 tests, 1946 pass, 0 fail, 27 skipped |
| Cross-process focus claim | Two real OS processes, exactly one winner |
| Live lock holder | Not displaced by an old timestamp |
| Dead lock owner | Recovered |
| Other-host lock | Not stolen (unknown liveness) |
| Legacy task, no binding | Refused, zero git commands run |
| Incident reproduction | `devwf identity --dir Clinic --against DBPinball` → `REFUSED`, exit 1 |
| Lint / syntax / build | exit 0 / exit 0 / exit 0 |

## 5. Merge commits

| Repository | PR | Merge commit |
|---|---|---|
| DevWorkflow | #95 | `37000c77e29233afecd1de7df0b533746357e994` |
| DBPinball | #4 | `e026758738b8a2e115e98500b43bce8480f32dd6` |

## 6. Remaining non-enforced bypass paths

These are documented rather than hidden. The guard is an authorization boundary
inside the MCP tools; it is **not** a sandbox.

1. An agent that edits files without calling `start_task`.
2. `allowProjectSwitch` / `allowWorkspaceTransition` with a plausible reason — a decision is required, intent cannot be verified.
3. `git` or shell commands run outside the MCP tools. **Arbitrary filesystem and shell operations are not sandboxed.**
4. A state with no contract and no `projectDir` has no repository context; the handler's own resolution applies, and the mutation guard refuses it.
5. A repository with no remote keeps a `local:<path>` identity, so a directory move looks like a new project.
6. PID reuse makes a dead lock owner look alive; the contender times out instead of stealing (fail-closed).

## 7. Recovery and troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `PROJECT_SWITCH_REQUIRES_AUTHORIZATION` | Task targets a different repository | Repeat with `allowProjectSwitch: true`, a written reason and the target `focusId` |
| `WORKSPACE_SWITCH_REQUIRES_AUTHORIZATION` | Task targets another clone of the same remote | Use a linked worktree, or authorize the switch |
| `WORKSPACE_TRANSITION_REQUIRES_AUTHORIZATION` | Task targets a linked worktree | Repeat with `allowWorkspaceTransition: true` and a reason |
| `WORKTREE_WRITE_REQUIRES_TRANSITION` | A task tries to commit/release in another worktree | Start a new task in that worktree |
| `IDENTITY_UNVERIFIABLE_NO_TASK_BINDING` | No contract and no declared `projectDir` | Start the task again with the intended `projectDir` |
| `IDENTITY_UNVERIFIABLE_*` | Recorded evidence contradicts the live checkout | Verify the checkout; start a new task if the project moved |
| `FOCUS_BOUND_TO_ANOTHER_PROJECT` | Focus belongs to another project | Choose the correct focus, or retire the binding |
| `FOCUS_CLAIM_TIMEOUT` | A live process holds the focus lock | Wait, or confirm the holder is gone; a dead holder is recovered automatically |
| `devwf identity` exits 1 | The switch would be refused | Read the `decision.code` in the JSON output |

## Deployment note

No production deployment is recorded by this incident closure. The DevWorkflow
merge triggered the repository's standard main-branch CI, which includes a
`deploy-monitor` job; that is the repository's own pipeline, not a release of the
package. No tag or release was created by this work.
