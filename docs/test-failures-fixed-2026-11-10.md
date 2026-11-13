# Eight failing tests: what they were and what changed

Date: **10 November 2026**.

The suite had eight failures that predated this work. They were not noise: two
of them were hiding a product bug that could delete a working checkout.

## Category 1 — the same directory, spelled two ways (a real bug)

Five `branch-cleanup` tests failed with `Cannot read properties of undefined` and
`the main worktree must be listed`. Both came from `planCleanup` not recognising
the main worktree.

The cause:

```
git worktree list         →  C:/Users/mahardhika/AppData/Local/Temp/...   (long)
fs.realpathSync(path)     →  C:\Users\MAHARD~1\AppData\Local\Temp\...     (8.3 short)
```

`samePath` compared the raw strings, so the same directory looked different.

**Why this mattered outside the tests:** `planCleanup` marks a worktree
`"remove"` when its path does not match the main checkout. A main worktree that
fails to match is a worktree the cleanup is willing to delete — the checkout
somebody is working in.

Fix: resolve both sides through `realpathSync.native`, which returns the long
form consistently, before comparing. The 8.3 form is a Windows feature that can
be disabled per volume, which is why this reproduced here and not on CI.

## Category 2 — a SQLite handle outliving its test (three failures)

`WorkflowState` had no way to close its database adapter. Adapter SQLite holds
`.db`, `-wal` and `-shm` open; without a close, deleting the temporary directory
races the driver and throws `EBUSY` on Windows.

Fix: `WorkflowState.close()`, idempotent, delegating to the adapter's own
`close()`. The test helper calls it before removing the directory.

This is a library gap, not a test artefact: any script that creates a temporary
`WorkflowState` and deletes it would hit the same lock.

## Category 3 — a test comparing with the wrong realpath

One `branch-cleanup` assertion still failed after the product fix, because the
test itself called `fs.realpathSync` (short form) while production used
`.native` (long form). The test now uses the same call as the code it checks.

## Category 4 — the test's own path assertion

Three `workflowState` tests compared a resolved path against a prefix built from
`tmpdir()`, which also returns the short form. `samePathPrefix` now resolves the
nearest existing ancestor through `realpathSync.native` and appends the rest, so
a path that does not exist yet still compares correctly.

## Proof the new test catches the bug

`samePath treats the short and long spellings of one directory as equal` was run
against the old comparison:

```
RED  not ok 10 - samePath treats the short and long spellings of one directory as equal
RED  # fail 1
```

With the fix restored: `# pass 14`, `# fail 0`.

## Result

```
before : 1694 tests, 1658 pass, 8 fail
after  : 1694 tests, 1667 pass, 0 fail
```

`workflowState.test.js`: 20/20. `branch-cleanup.test.js`: 14/14.

## Files changed

| File | Change |
|---|---|
| `branch-cleanup.js` | `samePath` and `realOrSame` resolve through `realpathSync.native` |
| `workflow-state.js` | added `close()` |
| `tests/branch-cleanup.test.js` | compare with the same realpath the code uses; new short-vs-long test |
| `tests/workflowState.test.js` | resolve paths through native realpath; close the adapter before deleting; retry the delete |

Nothing was skipped or silenced. Every one of the eight now runs and passes.
