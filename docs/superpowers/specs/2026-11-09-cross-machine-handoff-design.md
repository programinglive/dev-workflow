# Cross-machine task handoff — design

**Date:** 2026-11-09
**Status:** Awaiting owner approval (revision 2, after a builder review of revision 1)
**Scope:** foundation only — checkpoint, handoff, handoff marker. Browser/app platform
and automatic revert are direction, not built here.

## Revision note

Revision 1 contained three claims that a code review proved wrong. They are
corrected here rather than quietly dropped, because two of them change the design:

1. **The Zettly block cannot hold the proposed fields as-is.** `blockFor()`
   (`zettly-workflow.js:81-89`) emits only Task ID, Project, Status, language,
   Connected work, AI sessions, Plan, DoD, Commit, Reason, Next action. Anything
   else is erased by `mergeBlock()` on the next sync. Adding fields therefore
   requires changing the renderer, not just the payload.
2. **Nothing reads the block back.** `zettly-context.js:9-11` deliberately strips
   every `dev-workflow` region, and truncates descriptions to 4000 characters
   (`:68`). "Confirm the checkpoint by reading it back" had no implementation.
3. **The staleness evidence was misdiagnosed.** I claimed the renderer showed `[ ]`
   for finished work. It does not: `blockFor` renders `[x]` for any `done` item.
   The real cause is in the state file — see below.

## What the state file actually shows

`.state/projects/infra-knowledge-mcp-server-*/workflow-state.ses_e40e12a0*.json`
for the MMCH runner task:

```
phase: coding
plan items: 5, done: 0        <-- all still "open"
dod items: 1, proven: 0
lastCommitSha: (empty)
machine field: absent
```

The work was done; the marks never landed. The dev-workflow MCP instance serving
this session was replaced mid-work, so `mark_plan_step` calls returned objects
instead of persisting. **The lesson for this design is not "fix the renderer" but
"a checkpoint is only as truthful as the state it reads, and state can silently
fail to record."** A checkpoint write must therefore be verified by read-back, and
must report what it could not confirm.

## What already exists (verified)

| Capability | State |
|---|---|
| Zettly Todo carries task, project, phase, plan, DoD | Yes — Todo #447 inspected |
| `resume_session` | Local disk only, same project only, refuses when `currentPhase !== "idle"` (`resume-handlers.js:137`) |
| `list_active_sessions` | Cross-machine, read-only |
| `owner_pid` recorded by monitor | Yes (`session-upsert.cjs`), not exposed via `/api/sessions` |
| SSH Mac → MMCH / HELLOWORLD | Works (Tailscale aliases) |
| SSH helper to reuse | `managed/rollout.cjs` — `execFileSync` + `ssh -o BatchMode=yes`, absolute interpreter paths because a non-interactive shell has no PATH (`:133, :263-274`) |
| Commit list per session | **Does not exist** — only `lastCommitSha` (`workflow-state.js:1238`) |
| `machine` persisted in state | **No** — computed at `monitor.js:60`, never stored |

## Goals

1. Checkpoint a task into Zettly with plan, DoD, phase, machine, summary, and the
   commits this session made.
2. Refresh that checkpoint on the owning machine over SSH, then adopt it elsewhere.
3. Record a handoff with a mandatory reason.
4. Make the original machine refuse to continue silently after a handoff.
5. Produce a correct record for a later, bounded revert.

## Non-goals

Browser UI, mobile app, moving the chat session, moving disk state, automatic
revert, and any new concurrency model beyond `process-lock`.

## Anti-goals

Silently overwriting another machine's work; treating a stale checkpoint as
current; reverting anyone else's commits; a remote channel that accepts arbitrary
commands.

## Approaches

**A. Monitor owns state.** Largest change, duplicates Zettly, adds a new single
point of failure. Rejected.

**B. Pull the state file over SSH.** Fails precisely when the machine is dead, and
reads another machine's disk across Windows/macOS. Rejected.

**C. Zettly is the checkpoint; SSH only refreshes it.** Chosen. Uses storage that
already holds plan and DoD, survives a dead machine, needs no monitor schema
change. SSH is used for one narrow purpose: ask the owning process to write a
fresh checkpoint, because only that process holds the live state.

## Design

### 1. Machine-readable payload inside the block

`blockFor()` gains one extra element, emitted last:

```
<script type="application/json" data-dev-workflow-state="<id>">{...}</script>
```

Rendered by `blockFor` and therefore preserved by `mergeBlock`. The JSON carries
only what the human-readable part cannot: `machine`, `checkpointedAt`, `summary`,
`baseSha`, `commits[]`, `handover{}`. Plan and DoD stay in the human part so they
remain visible in Zettly; the JSON does not duplicate them.

A new reader module reads the **raw** description through the Zettly API and
extracts this element. It must not use `zettly-context.js`, which strips the
block by design.

### 2. `checkpoint_task`

Writes the current state and then **reads it back** to confirm. Reports three
outcomes distinctly: written and confirmed, written but unreadable, and failed.
Never reports success on the strength of the PATCH alone.

Also writes automatically at phase transitions and immediately before
`complete_task`, so the checkpoint is never stale at the moment it matters. The
owner's "device died, take the last checkpoint" path depends on this.

### 3. Refreshing from another machine

`fetch_task({ from: "Mac" })`:

1. Normalise the machine name to an SSH alias. `DEVWF_MACHINE` (`Mac`), monitor
   names, and SSH aliases (`mac`) differ today; on ambiguity the tool asks instead
   of guessing.
2. Run the checkpoint command over SSH **with an explicit session key**. This is
   the review's most important finding: `dev-workflow-mcp call` builds a
   `WorkflowState` with no session id and falls back to `proc-<uuid>`
   (`db/session-key.js:30`), so without the key the remote process would
   checkpoint an empty state or create a second Todo. The key is already visible
   in the block's AI-sessions line and in `list_active_sessions`.
3. If the machine is unreachable, do not silently continue: report it, and offer
   the checkpoint already in Zettly. Taking that path requires a reason.

### 4. Handoff marker

Written into the JSON payload: `{ from, to, reason, at, sessionKey }`.

`get_current_focus`, `start_task` and `continue_workflow` read it. A session whose
task was handed over refuses to continue and prints the reason and the receiving
machine. Resuming locally needs an explicit acknowledgement, so a rebooted machine
cannot quietly redo the work.

It is a record, not a lock: it cannot stop someone editing the same files, only
the silent double-work.

### 5. Revert record

The checkpoint stores `baseSha` (recorded at `start_task`) and the commits this
session created (`git rev-list baseSha..HEAD` filtered to this session's author
identity). A later revert must refuse when:

- a commit is not in that list;
- a commit is already reachable from the remote default branch;
- a commit's author is not this session's identity;
- the working tree is dirty — list it, never discard it.

Database changes are out of scope unless the session recorded them inside a
transaction.

**Detection is not destruction.** The returning machine reports and offers; it
never reverts unattended.

## Decisions I made (owner may overrule)

- Machine-readable payload lives inside the existing block as a JSON element,
  rather than a second Todo or a tag, so one Todo stays the single record.
- Checkpoint cadence is automatic at phase transitions plus on demand, rather
  than handoff-only, because a stale checkpoint is the failure the owner fears.
- SSH carries a fixed command with an explicit session key, never a free-form
  shell string.
- Revert is prepared, never executed automatically.

## Constraints

- Non-interactive SSH has no PATH: use absolute interpreter paths, as
  `managed/rollout.cjs` already does.
- `sanitize()` (`security/sanitizer.js:11-12`) JSON-parses any string starting
  with `{` or `[`, so a summary beginning with a brace is silently mangled —
  encode before passing.
- `lastPayloadHash` (`zettly-workflow.js:109-110`) can skip a write when the
  rendered block is unchanged; a checkpoint must bypass that short-circuit.
- Zettly is the source of truth, so a checkpoint that cannot be read back is a
  failure, not a warning.

## Left to the builder

Exact tool names and argument shape; how the handoff record is preserved when
Zettly is unreachable; test strategy for the payload shape, the handoff refusal,
the SSH allowlist, and the revert refusals.

## Direction beyond this document

The browser and mobile platform reads these same checkpoints and handoff records.
It is a second front end over this data, not a second model — which is why the
foundation must write complete, verifiable checkpoints now.
