# MCP Tool Catalog Synchronization

## Why Version Strings Are Not Enough

During rapid development, new MCP tools or input schema refinements may be committed before a major/minor package version bump, or an AI coding client may cache the `tools/list` response from an older stdio process.

## Deterministic `toolCatalogDigest`

`computeToolCatalogDigest()` computes a deterministic `sha256:<hex>` digest over the canonical MCP tool registry in `index.js`.

Every Release Manifest v1 embeds:
- `version`: Semantic version (`1.31.0`)
- `revision`: Full 40-character Git SHA
- `artifactDigest`: `sha256:<hex>` of the release archive
- `toolCatalogDigest`: `sha256:<hex>` of the MCP tool catalog

## Runtime & Supervisor Detection

1. When `managed/launcher.cjs` spawns `index.js`, it passes `DEVWF_RELEASE_VERSION`, `DEVWF_RELEASE_REVISION`, and `DEVWF_TOOL_CATALOG_DIGEST` in the process environment and records them in `supervisor/processes.json`.
2. When `devwf fleet status` or `devwf fleet doctor` inspects a machine, it compares each running process's `toolCatalogDigest` against the target manifest's `toolCatalogDigest`.
3. Any mismatch sets `staleToolCatalogDetected: true`, transitions convergence status to `CLIENT_REFRESH_REQUIRED`, and emits the `STALE_TOOL_REGISTRY` diagnostic finding with exact remediation steps.
