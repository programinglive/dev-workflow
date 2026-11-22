# Zettly Code v1.0 Integration Guide

DevWorkflow v3.1+ integrates **Zettly Code** — a persistent source-code memory and self-evolving knowledge graph — through a clean, decoupled adapter (`src/zettly-code-adapter.js`).

## Distribution & Privacy Model

- **Public Core (`@programinglive/dev-workflow`):** Distributed publicly on npm under the MIT license. Contains zero private Zettly Code source code.
- **Optional Zettly Code Engine (`@programinglive/zettly-code`):** Maintained separately in a private repository (`programinglive/zettly-code`). Resolved automatically when installed or configured via `ZETTLY_CODE_MODULE_PATH`.
- **Standalone Graceful Degradation:** When running DevWorkflow in public standalone environments without Zettly Code installed, `code_index`, `code_context`, and `audit({ category: "bugfix_knowledge" })` return a clean structured `ZETTLY_CODE_UNAVAILABLE` response without crashing or blocking standard workflows.

## Canonical MCP Tools

DevWorkflow exposes only two canonical public MCP tools for Zettly Code (keeping the full public catalog at **65 canonical tools** with **0 compatibility aliases**):

| Tool | Modes | Purpose |
|---|---|---|
| `code_index` | `status`, `initialize`, `update`, `verify`, `rebuild` | Manage the local SQLite WAL code knowledge graph and verify freshness |
| `code_context` | `debug`, `symbol`, `dependencies`, `callers`, `tests`, `impact`, `history` | Retrieve bounded debugging context, `@zettly-code` notes, invariants, callers, tests, and past bug fixes before scanning files |

## Mandatory Bug-Fix Knowledge Gate

Integrated directly into canonical `audit`:

```json
{
  "category": "bugfix_knowledge",
  "projectDir": "/path/to/repo",
  "files": ["src/checkout.js"],
  "taskType": "BUG_FIX",
  "bugId": "BUG-1001"
}
```

Every verified bug fix leaves behind a concise `@zettly-code` comment (or sidecar JSON record under `engineering/zettly-code-sidecars/` for non-commentable files) containing:

- `@zettly-code <ID>` — stable unique knowledge identifier
- `@purpose` — responsibility of the owning symbol
- `@bug-fix` — bug or issue identifier
- `@root-cause` (confirmed) or `@hypothesis` (unconfirmed) — strict root-cause truthfulness
- `@fix` — summary of the verified change
- `@related` / `@tests` — cross-checked against indexed symbols and tests

## Security Boundaries

- Secret files (`.env*`, `*.pem`, `*.key`, `credentials.json`) are excluded from indexing.
- Path traversal (`../`) and symlink escapes outside `projectDir` are blocked.
- Credential tokens and personal data (PII) are blocked inside `@zettly-code` comments and redacted from retrieval snippets.
