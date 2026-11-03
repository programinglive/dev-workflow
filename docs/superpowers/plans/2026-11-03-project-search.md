# Project Search MCP Tool Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in the current session using the project's strict dev-workflow MCP gates. Keep the design spec open while implementing.

**Goal:** Add a local, read-only `search_project` MCP tool that returns bounded, ranked code/documentation excerpts with repository-relative paths and line numbers from the active workflow project's Git worktree.

**Architecture:** A focused Node.js module enumerates tracked and untracked non-ignored files through `git ls-files` with NUL-delimited output, validates paths under the pinned repository root, and performs bounded lexical line matching. A dedicated handler obtains the root from workflow state, formats citations, and relies on the existing sanitizer/output filter. Nothing is persisted or sent over the network.

**Tech Stack:** Node.js ESM, built-in `node:fs/promises`, `node:child_process` `execFile`, existing MCP schema/handler registry, Node built-in test runner, temporary Git repos in tests.

**Spec:** `docs/superpowers/specs/2026-11-03-project-search-design.md`

## Global Constraints

- Keep Node `>=20` and Windows compatibility.
- Add no runtime package dependency.
- Restrict search to the workflow state's pinned `projectDir`; accept no user-provided filesystem path.
- Run Git without a shell, use NUL-delimited paths, reject paths outside the root, and skip symlinks.
- Exclude ignored, protected/sensitive, binary, invalid UTF-8, and oversized files.
- Per-call caps: 20,000 candidate paths, 256 KiB per file, 20 MiB total bytes read, 20 results maximum, 300 characters per excerpt; defaults must be constants and documented.
- Every result passes through existing output sanitization; tests use only synthetic fixtures and fake secret-like strings.
- Do not add persistent indexes, embeddings, network calls, telemetry, MCP client config, or XERJ code.

## Review Focus

- Git path enumeration is NUL-delimited and invoked with argument arrays, so unusual filenames cannot split commands or escape the repository.
- A tracked secret-like file is still excluded even though Git tracks it; ignore rules alone are not a security boundary.
- Symlinks and path traversal never read outside the validated repository root.
- File, total-byte, candidate, result, and excerpt caps stop unbounded work and disclose truncation.
- Sensitive matches are not returned raw through either MCP or CLI response paths.

## File Map

- `search-project.js` — file enumeration, path checks, sensitive/binary filtering, bounded lexical ranking, excerpt creation.
- `tools/definitions.js` — `search_project` input schema and safety-focused tool description.
- `tools/handler-modules/search-handlers.js` — resolve pinned project state, validate query/limit, invoke search, format response.
- `tools/handler-modules/index.js` — dispatch the new tool.
- `tests/search-project.test.js` — scanner behavior against isolated temporary Git repos.
- `tests/handlers-search-project.test.js` — tool schema, handler routing, missing/invalid project, bounded sanitized output.
- `README.md`, `docs/PRD.md`, `docs/mermaid/feature-flow.mmd` — tool inventory, scope/limitations, usage and workflow representation.
- `docs/superpowers/specs/2026-11-03-project-search-design.md` — approved design; only adjust if implementation evidence requires a spec correction.

## Tasks

### Task 1: Add scanner tests first

**Files:** `tests/search-project.test.js`.

- Create a helper that makes a temporary Git repository, writes fixture files, initializes Git without remotes, and cleans up in `finally`.
- Write failing tests for tracked and untracked non-ignored matching lines, correct relative path and 1-based line number, exact phrase ranking above token matches, stable tie order, no match, ignored files, and known sensitive filenames.
- Add failing cases for traversal-shaped filenames/queries, outside-root symlinks (skip only when platform permissions do not allow symlink creation), NUL/binary data, invalid UTF-8, per-file/cumulative/candidate caps, result limit, excerpt limit, and Git errors.
- Run `node --no-deprecation --import ./tests/setup-env.js --test tests/search-project.test.js`; confirm failures report the missing module/behavior, not a fixture setup error.

### Task 2: Implement the bounded scanner

**Files:** `search-project.js`, `tests/search-project.test.js`.

- Export `searchProject({ projectDir, query, limit })` and named constants for all caps.
- Resolve `projectDir` and `git rev-parse --show-toplevel`; fail closed unless the real root matches the pinned directory.
- Enumerate with `execFile('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'])`; impose a bounded Git output buffer and parse NULs without trimming valid names.
- Reject absolute/parent paths, skip symlinks, resolve each candidate and ensure it remains under the root; stat before reading and apply candidate, byte, protected-name, and binary limits.
- Detect binary by NUL and decode with fatal UTF-8 `TextDecoder`; skip decode failures.
- Normalize query and distinct terms; rank exact phrase lines first, then descending distinct-term coverage, then path and line; emit only the matching line, truncated to 300 characters.
- Stop at the result cap and report skipped/truncated counts in structured metadata; preserve stable output across runs.
- Re-run the scanner test file until all scanner assertions pass.

### Task 3: Wire the MCP tool with failing handler tests first

**Files:** `tests/handlers-search-project.test.js`, `tools/definitions.js`, `tools/handler-modules/search-handlers.js`, `tools/handler-modules/index.js`.

- Add tests first for schema discoverability, valid query handling, query/limit validation, projectDir taken from workflow state rather than arguments, no active project, invalid Git root, no results, and sanitizer-safe output.
- Register `search_project` with required `query` (1–500 chars) and optional integer `limit` (1–20, default 8); reject extra arguments.
- Add `handleSearchProject(args, workflowState)` in the focused handler module; do not accept paths in args; format path:line excerpts, count/limit notices, and lexical-only limitation.
- Add the dispatch case in `tools/handler-modules/index.js` and ensure all outputs use `textResponse` so sanitization remains applied.
- Re-run handler and scanner tests; verify the MCP tool list includes `search_project` exactly once.

### Task 4: Add security and boundary regressions

**Files:** `tests/search-project.test.js`, `tests/handlers-search-project.test.js`.

- Add a tracked fixture named `.env.production`, a private-key/certificate-named fixture, and credential-named fixtures containing synthetic values; verify none of their matching contents are returned.
- Exercise fake secret-like strings in an otherwise searchable source line and assert response scanner redacts or suppresses the line.
- Verify symlinks outside root, paths containing spaces/newlines, and ignored directories cannot bypass root or ignore checks.
- Verify partial results carry an explicit truncation note when limits are reached and never exceed excerpt/result caps.
- Run both focused files and inspect failure output for accidental fixture content leakage.

### Task 5: Update public documentation

**Files:** `README.md`, `docs/PRD.md`, `docs/mermaid/feature-flow.mmd`.

- Change the tool count from 37 to 38 where current and describe `search_project` in the tool table.
- Document an example query, pinned-repository scope, result citations, lexical ranking limitation, caps, sensitive-file exclusions, and local/no-index/no-network behavior.
- Add the search capability as an optional discovery step before implementation in the workflow diagram without changing the enforced lifecycle order.
- Update PRD goals/user story and non-goals to state that search is lexical, local, and read-only; do not claim semantic embeddings.
- Confirm README and documentation gate reflect actual changed paths.

### Task 6: Verify, review, and close through dev-workflow

**Files:** all task files above.

- Run focused tests, then `npm test`, `npm run lint`, `npm run check`, `npm run verify:bundle`, and `git diff --check`; fix failures caused by this change.
- Verify the built MCP bundle exposes the new tool and a safe synthetic-repo search returns a path and line without network use.
- Inspect final diff, ensure no generated index/data, `.env`, secrets, or unrelated edits are included.
- Record implementation/test/doc evidence in dev-workflow DoD, complete its docs/test/ready gates, and use only the repo's authorized commit/release procedure; do not publish/deploy as part of this feature unless the established release workflow requires it and the user authorizes that external action.

## Completion Criteria

`search_project` is registered and read-only, searches only the pinned repository with documented bounds, honors ignore and sensitive-file exclusions, returns sanitized path/line citations, has regression coverage for all review-focus cases, and passes the project's required test/lint/bundle checks.
