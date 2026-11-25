# Zettly Code v1.0 Integration Guide

DevWorkflow v3.1+ integrates **Zettly Code** (`@programinglive/zettly-code`, open-source MIT repository: `https://github.com/programinglive/zettly-code`) — a persistent source-code memory and self-evolving Zettelkasten knowledge graph — as an official core component of the **Zettly** and **DevWorkflow** ecosystem (`src/zettly-code-adapter.js`).

## Distribution & Open-Source Model

- **Public Open-Source Engine (`@programinglive/zettly-code`):** Published as open-source software under the MIT license at `https://github.com/programinglive/zettly-code` and bundled directly inside `@programinglive/dev-workflow` (`src/vendor/zettly-code/`).
- **Zero-Config Availability:** Every DevWorkflow installation (ManagedMCP fleet workstations, standalone npm installs, and CI runners) resolves Zettly Code automatically out of the box.
- **Custom Override Support:** Can also be overridden via `ZETTLY_CODE_MODULE_PATH` for custom testing or external checkouts.

## Canonical MCP Tools

DevWorkflow exposes two canonical public MCP tools for Zettly Code (keeping the full public catalog at **66 canonical tools** with **0 compatibility aliases**):

| Tool | Modes | Purpose |
|---|---|---|
| `code_index` | `status`, `initialize`, `update`, `verify`, `rebuild` | Manage the local SQLite WAL code knowledge graph and verify freshness |
| `code_context` | `debug`, `symbol`, `dependencies`, `callers`, `tests`, `impact`, `history` | Retrieve bounded debugging context, `@zettly-code` notes, invariants, callers, tests, and past bug fixes before scanning files |

## Mandatory Workflow & Pre-Commit Gate (`check_ready_to_commit`)

Zettly Code is **mandatory** in our engineering workflow:

1. **Pre-Investigation Retrieval (`code_context`):** Always query `code_context` before broad file scanning when debugging or assessing change impact.
2. **Automatic Pre-Commit Gate in `check_ready_to_commit`:**
   - On every `bugfix` task that modifies production source files in a Git repository, `check_ready_to_commit` automatically refreshes `.zettly-code/knowledge-graph.db` and evaluates the `bugfix_knowledge_gate` (`evaluateZettlyCodeGate`).
   - Also available on demand via canonical `audit`:
     ```json
     {
       "category": "bugfix_knowledge",
       "projectDir": "/path/to/repo",
       "files": ["src/checkout.js"],
       "taskType": "BUG_FIX",
       "bugId": "BUG-1001"
     }
     ```
3. **Mandatory `@zettly-code` Bug-Fix Annotations:**
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
