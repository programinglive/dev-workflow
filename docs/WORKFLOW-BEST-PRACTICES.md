# Workflow Best Practices

## Correct Release Workflow Order

To avoid needing `--force` flag for releases, follow this exact order:

1. **Start Task**: `mcp0_start_task`
2. **Fix/Implement**: Make your code changes
3. **Mark Fixed**: `mcp0_mark_bug_fixed`
4. **Tests**: `mcp0_create_tests` + `mcp0_run_tests` (or `mcp0_skip_tests` with reason)
5. **Documentation**: `mcp0_create_documentation`
6. **Ready Check**: `mcp0_check_ready_to_commit`
7. **Commit & Push**: `mcp0_commit_and_push`
8. **Release**: `mcp0_perform_release` ⚠️ **MUST come BEFORE complete_task**
9. **Complete**: `mcp0_complete_task`

## Common Mistakes

### ❌ Wrong Order (causes forced releases)
```
check_ready → commit → complete → release  // WRONG!
```

### ✅ Correct Order
```
check_ready → commit → release → complete  // CORRECT!
```

## Why This Matters

- `complete_task` **resets the workflow state**
- `perform_release` **checks the workflow state** before running
- If you complete before releasing, the state is cleared and release guards fail
- Using `--force` bypasses guards but doesn't fix the root cause

## State Transitions

1. After `commit_and_push`: `currentPhase = "release"`
2. After `perform_release`: `currentPhase = "ready_to_complete"`, `released = true`
3. After `complete_task`: State is reset to idle

## Solution

Always call `perform_release` BEFORE `complete_task`. Never use `--force` unless absolutely necessary.

## Documentation Phase Expectations

During the documentation step (`mcp0_create_documentation`), make sure the core project docs are created or updated as needed:

1. `docs/product/PRD.md` – Product Requirements Document
2. `README.md` – Project overview and usage
3. `docs/release-notes/RELEASE_NOTES.md` – Release notes for changes in this task/version

If one or more of these files already exist, **update them** instead of creating new variants. Use the `documentationType` argument to reflect what you touched:

- `"PRD"` when you added/updated the PRD
- `"README"` when you updated the main README
- `"RELEASE_NOTES"` when you updated the release notes

### The label is not the evidence

Since 1.16.0, `documentationType` is only a label for humans. The gate reads the working tree: pass `files: ["README.md"]` naming the documentation files you actually changed, and each path is verified against the working tree. While source code changed and no documentation file did, `check_ready_to_commit` and `commit_and_push` both refuse.

That refusal is the point. Until 1.16.0, `documentationType: "inline-comments"` closed the documentation step exactly as well as `"README"`, nothing read the files, and READMEs fell behind for months while the ready check reported success.

### Waiving is a decision, not a shortcut

When a change genuinely alters nothing the documentation describes — an internal refactor, a dependency bump, a typo in a comment — call `waive_documentation { reason }` instead of hunting for a file to touch. The reason is recorded in the state, reported by `commit_and_push`, and shown again in the next session's recommendations.

Two rules keep that honest:

- The reason is written down and read back later. "tidak perlu" is not a reason; the tool rejects anything under 5 characters, and a habit of waiving every task becomes visible in the history rather than silent.
- A documentation file that was **already dirty before the task started** does not count as evidence, because it cannot be told apart from another session's work. Naming it in `files` claims it explicitly, and that claim is recorded.

### Leaving a trail for the next session

`complete_task` reports what to do next, built from facts the session produced: waived DoD items and their reasons, skipped tests, waived documentation, files left uncommitted, `TODO` comments that entered the diff, a run of bugfix tasks, an unusually large diff. Add your own with `nextSteps` (1-5 items, 10-200 characters).

`next_steps` shows the stored list again at any time. Use it when starting a session on a project you have not touched recently — the previous session already knew which corners were left rough, and that knowledge survives only if it is written down.
