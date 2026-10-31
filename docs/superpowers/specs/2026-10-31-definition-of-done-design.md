# Definition of Done for the Local Workflow — Design

**Date:** 2026-10-31
**Status:** Approved in chat, awaiting spec review
**Target repo:** `C:\Users\DHIKA\Documents\code\dev-workflow-mcp-server` (v1.13.16, the copy the MCP server actually runs)
**Planned release:** 1.14.0 (minor)

## Ringkasan (ID)

Factory (`factory.programinglive.com`) sudah punya `definitionOfDone` per task: checklist kondisi konkret yang wajib ada sebelum task boleh `done`. dev-workflow MCP belum punya padanannya — gerbangnya masih boolean yang di-set sendiri oleh agen (`status-handlers.js:46`). Spec ini menambah DoD lokal: item per item, bukti wajib, ada jalan waive dengan alasan, dan mengunci `check_ready_to_commit`, `commit_and_push`, serta `complete_task`.

## Problem

`handleReadyCheck` (`tools/handler-modules/status-handlers.js:46`) decides readiness from six boolean rows that the agent sets for itself: feature flow, bug fixed, tests created, tests passed, documentation created. None of them says *what* must be true. An agent can therefore reach `commit_and_push` while the concrete conditions of the task (build passes, login page verified against a real tenant, migration rolled back cleanly) were never stated, let alone proven.

The Factory board already solves this for board tasks: `definition_of_done` is a separate column, required at creation, and `move_task → done` is rejected while it is empty (`app/api/factory/route.ts:112` in `D:\code\factory`). The dev-workflow MCP only mirrors that for *remote* factory tools (`create_factory_task`, `update_factory_task`) — the local workflow has nothing.

A gap worth naming: `handleCompleteTask` (`tools/handler-modules/commit-handlers.js:304`) currently performs no checks at all. It closes the task on any call.

## Goal

Every local task carries a checklist of concrete conditions. Each condition is either **proven** (marked with evidence) or **waived** (with a written reason). Ready-check, commit, and complete refuse to proceed while any condition is outstanding.

## Non-goals

- No new workflow phase. DoD is a prerequisite inside the existing ready check.
- No push-back of local DoD to the Factory board. Pull only (`claim_factory_task`), because writes to the board already have an official path (`update_factory_task`).
- No human-approval UI. `force_complete_task` stays the audited escape hatch.
- The web dashboard (`web/`) is untouched in this version.

## Data model

New state fields, added in the three places that build a fresh state (`workflow-state.js:637` constructor, `:682` `useSession`, `:1251` `reset`):

```js
definitionOfDone: [],   // items, see below
dodSource: "",          // "" | "manual" | "factory"
dodFactoryTaskId: "",   // Factory recordId when pulled from the board
dodRevision: 0,         // bumped when new working changes land after a commit
```

One item:

```js
{
  id: "dod-1",          // stable: 1 + highest existing numeric suffix
  text: "build lulus",  // 3..300 chars after trim
  status: "open",       // "open" | "done" | "waived"
  evidence: "",         // required (5..500) when status === "done"
  waivedReason: "",     // required (5..500) when status === "waived"
  revision: 0,          // dodRevision at the moment it was proven/waived
  updatedAt: "2026-10-31T10:00:00.000Z"
}
```

A single definition is enough for every consumer:

```
isSatisfied(item) := item.status === "waived"
                  || (item.status === "done" && item.revision === state.dodRevision)
```

Limits: 1–20 items per task; text 3–300 chars after trim; duplicate text rejected case-insensitively; an empty list is never valid.

### Normalization and migration

`load()` already normalizes scalar fields (`workflow-state.js:762`). Add the same treatment for DoD: non-array → `[]`; entries that are not objects or have empty text dropped; unknown status → `"open"`; missing `evidence` / `waivedReason` → `""`; non-numeric `dodRevision` → `0`; duplicate or missing ids reassigned in order.

State files written before this release simply have no DoD fields, so they normalize to empty defaults. That is the legacy case: a task already in progress appears with zero items and is blocked by the gate until `set_definition_of_done` fills it. Nothing is silently granted.

## Staleness: the revision rule

`resetToCommitIfWorkingChanges` (`tools/handler-modules/shared.js:30`) already detects new working changes after a recorded commit and rolls the workflow back to `commit`. Extend it: **increment `dodRevision`** on that transition. Every `done` item then stops satisfying `isSatisfied`, so the agent must re-confirm against the code that is actually being committed. `waived` items survive the bump, because a waiver is a decision, not a proof.

Why a revision counter instead of setting items back to `open`:

- `mergeMonotonicProgress` (`workflow-state.js:863`) merges *forward-only* progress across MCP processes for the same task. Mutating status downwards would fight that merge, and the "highest status wins" rule below would resurrect the old `done`.
- A task-level counter is compared against a value stored on the item, so nothing has to be rewritten and no evidence is destroyed.
- Display stays honest: the item keeps its `done` status *and* the old evidence, and is reported as `perlu konfirmasi ulang` until re-marked.

Re-marking an item that is merely stale is the same call the agent already makes: `mark_dod_item`. No other transition bumps `dodRevision`; `mark_bug_fixed`, `run_tests` and `create_documentation` leave DoD alone, because they are steps *within* the same body of work, not new changes after a commit.

Cross-process merge: add `mergeDefinitionOfDone(reconciled)` alongside `mergeMonotonicProgress`, applied only when the disk task description matches ours. Per item id, keep the entry that ranks higher by `(statusRank, revision)`, where `done = 2, waived = 1, open = 0`. Items present only in memory are kept; items present only on disk are kept. This prevents a stale process from erasing evidence another process just recorded.

## Tool surface

| Tool | Change |
|---|---|
| `start_task` | New **required** field `definitionOfDone: string[]` (1–20 items). Validated by `validateItems`; failures return the rule list and a two-line example. `projectDir` behaviour is unchanged. |
| `set_definition_of_done` **(new)** | `{ items: string[], append?: boolean, reason?: string }`. Rejects when the workflow is idle. Default (`append` false) replaces the whole list and is **refused** when any existing item is `done` or `waived` — the message offers `append: true` or a waiver instead of silently discarding proof. `append: true` adds items up to the 20-item cap. Sets `dodSource: "manual"` unless the source is already `"factory"`, in which case `dodFactoryTaskId` is preserved. Clears `readyCheckCompleted`. |
| `mark_dod_item` **(new)** | `{ id, evidence }`. `evidence` required, 5–500 chars. `open → done`. Re-marking a `done` item is idempotent and refreshes evidence plus `revision` (this is how a stale item is re-confirmed). A `waived` item is refused: reinstate it through `set_definition_of_done` with `append: true` if it genuinely matters again. Clears `readyCheckCompleted`. |
| `waive_dod_item` **(new)** | `{ id, reason }`. `reason` required, 5–500 chars. `open → waived`. A `done` item is refused (`sudah terbukti, tidak ada yang perlu dikecualikan`). Clears `readyCheckCompleted`. |
| `get_workflow_status` | New block: `DoD: 2/4 selesai, 1 dilewati, 1 terbuka` then one line per item with evidence or waiver reason. Source shown when it came from the board. |
| `check_ready_to_commit` | Two new rows: `Definition of done recorded (>= 1 item)` and `Definition of done satisfied (0 open or stale items)`. |
| `commit_and_push` | Explicit guard before `git add .`: refuse with the ids and texts of outstanding items. The existing ready-check call already covers this transitively; the explicit guard exists so the message names the items instead of just "NOT READY". |
| `complete_task` | New guard: refuse while any item is outstanding or the list is empty. `force_complete_task` remains the bypass and records `forced: true` plus the DoD summary. |
| `claim_factory_task` | Parse the board's `definitionOfDone` into items: `dodSource: "factory"`, `dodFactoryTaskId: recordId`, `dodRevision: 0`. Notice line in the response states how many items were imported. |
| `run_full_workflow` | Accepts and forwards `definitionOfDone`, because it drives the same steps. |
| `rerun_workflow` | Currently calls `reset()` and restores only the task description and type (`status-handlers.js:138`), which would silently drop every DoD item and block the task forever. New behaviour: carry `definitionOfDone`, `dodSource`, `dodFactoryTaskId` and `dodRevision` across the reset, and say in the response that proven items are kept. |

When a task closes, `complete_task`, `force_complete_task` and `drop_task` record `dodSummary: { total, done, waived, open, waivedReasons }` on the history entry, so the project summary and `view_history` can show what was actually proven.

### Gate rows after the change

```
Task started
Feature flow described
Definition of done recorded (>= 1 item)          <- new
Feature/bug fixed
Tests created / Tests passed
Documentation created
Definition of done satisfied (0 outstanding)     <- new
```

`allDone` requires both new rows. DoD never moves `currentPhase` by itself; it only decides whether ready-check passes.

## Factory pull

`claim_factory_task` already reads `task.definitionOfDone` for display (`factory-handlers.js:153`). Replace that display with a real import through `parseFactoryChecklist`:

- `^\s*[-*+]\s*\[[ xX]\]\s*(.+)$` → item, **always imported as `open`**. A board checklist is a plan, not proof; the agent still has to prove each line locally.
- `^\s*[-*+]\s+(.+)$` → item.
- `^#{1,6}\s` headings, blank lines and prose paragraphs → ignored.
- Text trimmed, truncated to 300 chars, capped at 20 items. When capping or truncating happens, the response says so explicitly instead of dropping silently.
- Empty result → `dodSource: ""` and a warning that the board task has no DoD, so the agent must run `set_definition_of_done`.

`sync_task_status` already re-reads the board checklist after a status change; no change needed.

## Module layout

- `tools/handler-modules/dod.js` — pure functions, no MCP and no filesystem: `validateItems`, `normalizeItems`, `parseFactoryChecklist`, `renderChecklist`, `summarize`, `openItems`, `isSatisfied`, `nextItemId`, `mergeDefinitionOfDone`.
- `tools/handler-modules/dod-handlers.js` — `handleSetDefinitionOfDone`, `handleMarkDodItem`, `handleWaiveDodItem`. Thin: validate, mutate `workflowState.state`, `save()`, return `textResponse`.
- Wiring: `tools/definitions.js` (schemas), `tools/handler-modules/index.js` (switch cases), `workflow-state.js` (fields, normalization, merge, revision bump), `status-handlers.js` (gate rows, status display), `commit-handlers.js` (guards, history summaries), `factory-handlers.js` (claim import).

## Error messages

Every rejection is actionable and in the voice already used by the server (Indonesian, concrete): state the rule, show the offending value, and name the next call. For example:

```
⚠️ Item DoD "dod-3" masih terbuka: "migrasi bisa di-rollback".
Buktikan dengan 'mark_dod_item' { id: "dod-3", evidence: "..." },
atau kecualikan dengan 'waive_dod_item' { id: "dod-3", reason: "..." }.
```

## Tests

New:

- `tests/dod.test.js` — pure functions: Factory checklist parsing across `- [ ]`, `- [x]`, `* [ ]`, plain bullets, headings, prose, over-long lines, more than 20 lines; duplicate detection case-insensitive; id reassignment; `isSatisfied` across statuses and revisions; `renderChecklist` round-trip.
- `tests/dod-handlers.test.js` — the whole gate story: `start_task` with empty/missing/duplicate items; `mark_dod_item` without evidence; `waive_dod_item` on a `done` item; `set_definition_of_done` refusing to discard proven items; ready check failing on one open item and passing once proven; `commit_and_push` refusing before staging; `complete_task` refusing on an open item; `force_complete_task` succeeding and recording `forced: true` with a DoD summary; `claim_factory_task` importing from a mocked Factory client; legacy state (no DoD fields) blocked then unblocked by `set_definition_of_done`; revision bump on new working changes forcing re-confirmation, while waivers survive.

Updated: the 23 existing `start_task` call sites across `tests/handlers.test.js`, `workflowState.test.js`, `session-state.test.js`, `shared-state.test.js`, `handlers-commit.test.js`, `handlers-release.test.js`, `duplicate-review-guard.test.js`, `session-metadata*.test.js` — through a helper in `tests/test-helpers.js` so the fixture list lives in one place. Assertions that match the ready-check checklist text gain the two new rows.

`npm test` must be green before commit; the MCP server itself enforces this, which is the point.

## Documentation

`AGENTS.md` (repo) — the ten steps become twelve: DoD supplied in `start_task`, items proven during implementation. `README.md`, `docs/software-factory.md` (parity with the Factory board, and where the two differ: local DoD is per item and evidence-backed), `CHANGELOG.md`, `docs/PRD.md` (required by `create_documentation`).

The copy of the rules at `C:\Users\DHIKA\Documents\Default Project\AGENTS.md` also describes the ten steps. It is outside this repo; updating it is a separate, explicitly agreed follow-up.

## Risks

- **Friction.** A strict per-item gate can slow trivial work. Mitigations already in the design: `waive_dod_item` with a reason, and `force_complete_task` which records `forced: true`.
- **Test churn.** 23 call sites change; using one helper keeps the diff mechanical.
- **Evidence quality.** Evidence is free text; nothing verifies that a cited command actually ran. The gate raises the cost of a false claim and leaves a trail in `history`, which is the realistic ceiling for a local MCP server. Automatic verification would need the worker, not this server.
- **Two MCP processes, same task.** Handled by `mergeDefinitionOfDone`; the alternative (arrays merged by last write) can erase evidence.

## Done when

- `npm test` green with the new suites included.
- `start_task` without `definitionOfDone` fails with a message that names the field and the rules.
- A task with one open item cannot pass `check_ready_to_commit`, cannot `commit_and_push`, and cannot `complete_task`.
- Waiving that item with a reason lets all three proceed, and the waiver appears in `get_workflow_status`, in the `history` entry's `dodSummary`, and in the documentation step of the task.
- A task claimed from the board arrives with its DoD items imported as `open`.
- New working changes after a commit make every proven item stale, and the ready check says so.
