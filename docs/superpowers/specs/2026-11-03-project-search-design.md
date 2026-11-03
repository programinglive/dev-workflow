# Project Search MCP Tool — Design

Date: 2026-11-03
Status: Design approved in conversation; awaiting written-spec review.

## Context and goal

Dev Workflow MCP already pins a project directory for the active workflow task and has a strict security layer for tool output. Add a read-only tool that helps an agent locate relevant source and documentation in that active repository, returning short evidence excerpts with repository-relative paths and line numbers. The implementation is independent of XERJ and must not copy its code or require a new service.

## User-facing behavior

Add `search_project` with:

- `query`: required plain-text question or phrase, trimmed, non-empty, at most 500 characters.
- `limit`: optional integer, default 8, accepted range 1–20.

The tool searches only the repository pinned in the active workflow state. It returns ranked one-line excerpts with relative path and 1-based line number, plus a concise note when configured safety/size limits skip files. Empty or invalid queries receive a clear sanitized error. No result includes surrounding file contents beyond the matching line.

Ranking is deterministic: exact normalized phrase matches rank first; otherwise rank by count of distinct query terms present, then stable path and line order. This is lexical retrieval, not semantic search. The tool must describe that limitation rather than imply XERJ-style neural understanding.

## Scope and security boundaries

- Read-only; no writes, persistent index, database schema, embeddings, network calls, external telemetry, or MCP-client configuration edits.
- Use the workflow state's pinned `projectDir`; never accept a filesystem path from the query or tool arguments.
- Resolve and validate the Git repository root before reading. Enumerate tracked files and untracked non-ignored files using Git's NUL-delimited output with `--exclude-standard`, invoked without a shell. Resolve each candidate and reject paths outside the root; skip symlinks and files that cannot be safely resolved.
- Exclude known sensitive/protected paths and binary files before reading. Reuse existing protected-file policy where available; add conservative tests for `.env`, key/certificate material, and credential-named files. Ignore Git-ignored files.
- Bound work per call: maximum candidate count, per-file bytes, cumulative bytes, result count, and excerpt length. Defaults should be constants with tests; reaching a cap must return partial results with an explicit truncation note.
- Pass every returned excerpt through the existing security output filter/sanitizer. If a result is flagged as sensitive, suppress or redact the excerpt rather than returning raw content.
- If there is no active project, Git is unavailable, or project root validation fails, fail closed with an actionable sanitized response.

## Internal design

1. Register the MCP schema in `tools/definitions.js`.
2. Implement the search in a focused module that can be tested without starting the MCP server. Accept the validated project root and query as arguments; keep filesystem enumeration and reading local.
3. Add a small handler in the existing handler-module architecture. It gets the project directory from workflow state, calls the search module, formats bounded citations, and returns through the established sanitized response path.
4. Preserve line-ending behavior and decode text as UTF-8. Skip files that contain NUL bytes or fail the text checks; do not dump binary or decode-error content.
5. Do not persist caches in `.state`, the repo, or user profile. Every call reflects current files.

## Tests

Add focused automated tests covering:

- schema/handler registration and normal query results with repository-relative path and correct line numbers;
- exact phrase and term ranking, stable ordering, and empty/no-match responses;
- tracked, untracked non-ignored, and ignored files;
- path traversal attempts and symlinks resolving outside the root;
- sensitive-file exclusions and output redaction;
- binary, oversized, and cumulative-scan limits, plus result/excerpt caps;
- missing project directory and Git enumeration errors.

Tests must use temporary synthetic repositories and fabricated secret-like values only. Run relevant focused tests, then the full project suite if feasible, plus syntax/lint and bundle verification required by the repo workflow. Do not run tests against production or customer data.

## Documentation and compatibility

Update the README tool count/table and explain `search_project` scope, limits, lexical ranking, and the fact that no index or network service is used. Update the PRD/user story and workflow diagram if the tool count or usage path makes them inaccurate. Preserve Node >=20, Windows compatibility, strict security mode, and current release/deployment gates. The tool is local-only and requires no package dependency.

## Out of scope

- Persistent or incremental indexes, embeddings/vector search, agent memory, Elasticsearch compatibility, cross-repository search, source-control hosting, writes/patches, client auto-configuration, and external feedback/reporting.
- Copying or reverse-engineering XERJ source/binary. This design is based on the desired user behavior and the repo's own architecture.

## Acceptance criteria

The feature is complete when the tool is discoverable over MCP, only reads bounded safe files inside the pinned repo, returns cited results that pass output scanning, has regression coverage for each stated boundary, is documented, and the existing test/build/security verification remains green.
