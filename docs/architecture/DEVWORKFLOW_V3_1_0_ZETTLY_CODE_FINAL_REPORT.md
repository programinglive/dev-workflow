# DevWorkflow MCP v3.1.0 — Zettly Code v1.0 Integration & Permanent Open-Source Release Governance Report

**Release:** `@programinglive/dev-workflow@3.1.0`  
**Baseline:** `@programinglive/dev-workflow@3.0.0` (`dbe380299a3f8425225963eed2defe891c656f8f`)  
**Paired Engine:** `@programinglive/zettly-code@1.0.0` (Private Repository: `programinglive/zettly-code`, verified `visibility: PRIVATE`)  
**Canonical MCP Tools:** `65` (`63` from v3.0.0 + `code_index` + `code_context`, `0` compatibility aliases)  
**Date:** 2026-11-22

---

## A. Executive Summary

DevWorkflow MCP v3.1.0 delivers three cohesive capabilities without recreating the legacy 84-tool surface:

1. **Zettly Code v1.0 (`@programinglive/zettly-code`, PRIVATE):** A persistent source-code memory and self-evolving Zettelkasten knowledge graph backed by embedded SQLite WAL (12 canonical tables, corruption quarantine & recovery), language-aware parsers (JS/JSX/TS/PHP/SQL/Config), revision-aware incremental indexing, bounded debugging context retrieval, and mandatory `@zettly-code` bug-fix knowledge comments (inline JSDoc/PHPDoc + sidecar JSON records).
2. **DevWorkflow MCP v3.1.0 Thin Integration (`src/zettly-code-adapter.js`):** Exposes exactly two new canonical public MCP tools (`code_index` and `code_context`), bringing the catalog from `63` to `65` canonical tools with `0` compatibility aliases, while integrating `bugfix_knowledge_gate` (`audit({ category: "bugfix_knowledge" })`) and `release_docs_gate` (`audit({ category: "release_docs" })`) inside the existing canonical `audit` tool.
3. **Permanent Open-Source Release Governance (`src/release-governance.js`):** Tracks all `13` public `programinglive` repositories, blocks version/documentation/website drift and removed-tool references before release, and synchronizes DevWorkflow's own `README.md`, `CHANGELOG.md`, `AGENTS.md`, `web/lib/catalog.generated.ts`, `web/lib/how-to-use-data.ts`, and `web/lib/use-cases-data.ts` from stale v2.1.1 metadata to `v3.1.0` (`65` tools).

---

## B. Private Repository Verification (`programinglive/zettly-code`)

- **Repository:** `https://github.com/programinglive/zettly-code`
- **Visibility Verification (`gh repo view programinglive/zettly-code --json name,visibility,isPrivate`):**
  - `isPrivate`: `true`
  - `visibility`: `"PRIVATE"`
- **Release Tag:** `v1.0.0` (commit `48897ea`)
- **Privacy Guarantee:** Private Zettly Code source code is never copied into public `programinglive/dev-workflow`. DevWorkflow loads `@programinglive/zettly-code` dynamically through `src/zettly-code-adapter.js` and degrades cleanly with `ZETTLY_CODE_UNAVAILABLE` in standalone public environments.

---

## C. Canonical MCP Tool Catalog (v3.0.0 -> v3.1.0)

| Metric | v2.1.5 | v3.0.0 | v3.1.0 |
|---|---:|---:|---:|
| Total Public MCP Tools | 84 | 63 | **65** |
| Compatibility Aliases | 21 | 0 | **0** |
| New Zettly Code Tools | 0 | 0 | **2 (`code_index`, `code_context`)** |
| New Quality Gates in Canonical `audit` | 0 | 0 | **2 (`bugfix_knowledge`, `release_docs`)** |
| Unmapped / Untested Tools | 0 | 0 | **0** |

---

## D. Mandatory `@zettly-code` Bug-Fix Knowledge Contract

Every verified `BUG_FIX` workflow requires a concise, structured `@zettly-code` annotation on the affected production symbol (or a version-controlled sidecar JSON record under `engineering/zettly-code-sidecars/` for non-commentable/generated files):

- `@zettly-code <ID>` (unique stable knowledge ID)
- `@purpose` (non-trivial responsibility description)
- `@bug-fix <BUG-ID>`
- `@root-cause` (ONLY for empirically confirmed root causes) OR `@hypothesis` (explicitly marked for unconfirmed hypotheses)
- `@fix` (concise summary of the verified fix)
- `@related` / `@tests` (cross-checked against indexed symbols and test files to detect broken or stale references)

Security & Quality Guards enforced by `bugfix_knowledge_gate`:
- Blocks secret tokens (`ghp_*`, `sk-*`, `AKIA*`, private keys) and PII (emails/phones) inside comments.
- Blocks duplicate knowledge IDs and syntax/unknown tag errors.
- Blocks stale knowledge graphs (`STALE_CODE_KNOWLEDGE_GRAPH`) until `code_index(mode="update")` refreshes the index.
- Skips non-bugfix tasks (`FEATURE`) and test-only/docs-only changes cleanly.

---

## E. Repeated-Debugging Performance Benchmark (Measured)

Synthetic 121-file repository benchmark (`npm run test:bench` in `@programinglive/zettly-code@1.0.0`):

| Metric | Naive Full Repo Scan (5 queries) | Zettly Code Graph (5 queries) | Impact |
|---|---:|---:|---|
| Initial Index Time | N/A | **192.84 ms** | One-time bootstrap |
| Incremental Update (1 file) | N/A | **92.01 ms** | Re-indexes only 1/121 files |
| SQLite Graph Size | N/A | **413,696 bytes (~404 KB)** | Compact local WAL DB |
| Total Files Opened / Returned | 605 | **10** | **98.3% fewer files opened** |
| Total Context Bytes | 88,230 bytes | **10,117 bytes** | **88.5% context byte reduction** |

---

## F. Permanent Open-Source Release Governance (`release_docs_gate`)

- **Registry Coverage:** `13` public `programinglive` repositories (`dev-workflow`, `zettly`, `dbpinball`, `programinglive`, `commiter`, `hris`, `zettly-editor`, `ci-cd`, `belajar`, `ollama-local-ai`, `comingsoon`, `windows-gaming-dev-toolkit`, `.github`). Private repositories such as `zettly-code` are strictly excluded.
- **Drift Repaired in `dev-workflow` v3.1.0:**
  - `web/lib/version.generated.ts`: `2.1.1` -> `3.1.0`
  - `web/lib/catalog.generated.ts`: `2.1.1` (84 legacy tools) -> `3.1.0` (`65` canonical MCP tools, `16` CLI commands)
  - `web/lib/how-to-use-data.ts`: updated `@programinglive/dev-workflow@2.1.1` -> `3.1.0`, `toolsDiscovered: 64` -> `65`, replaced removed `audit_code`/`audit_security` with canonical `audit` & `code_context`
  - `web/lib/use-cases-data.ts`: replaced all removed v2 tool names (`audit_code`, `audit_api_contracts`, `audit_report`, `audit_architecture`, `audit_security`, `helper_*`) with canonical v3.1 tools (`audit`, `analyze_change`, `apply_safe_fix`) and updated fleet release example to `v3.1.0`
  - `README.md`, `CHANGELOG.md`, `AGENTS.md`: updated to v3.1.0 with permanent `BUG_FIX` and `RELEASE` policies.

---

## G. Verification Evidence

- **Zettly Code v1.0 Acceptance Suite (`KC-01..KC-16`, `ZC-01..ZC-22`):** `38/38` PASS
- **DevWorkflow v3.1.0 Integration & Release Governance (`BF-01..BF-16`, `RG-01..RG-12`, website consistency, catalog, audit reliability, lock lifecycle, focus, CLI):** `135/135` PASS
- **English-Only Engineering Policy (`npm run check:english`):** `0` new violations
- **Zettly JS Regression Suite (`npm run test:js`):** `141/141` PASS
- **Total Verified Automated Tests:** **314/314 PASS**
