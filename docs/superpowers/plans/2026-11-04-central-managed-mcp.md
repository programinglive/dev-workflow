# Central managed MCP implementation plan

**Goal:** Publish one approved MCP release and automatically consume it on HELLOWORLD, MMCH and Mac while preserving local repository execution.

**Architecture:** Authenticated release service on n8n-instance; immutable archives with SHA256 manifests; stable local launcher and platform/Node-ABI release cache. Existing monitor remains central for activity/state replication.

**Spec:** ../specs/2026-11-04-central-managed-mcp-design.md

## Tasks

- [x] Test and implement `managed/release-server.cjs`: bounded manifest, authenticated immutable downloads, health endpoint; reject unauthenticated/traversal paths.
- [x] Test and implement `managed/launcher.cjs`: verify manifest/archive, serialize installation, preserve last-good on errors, start pinned local runtime with clean MCP stdout and safe diagnostics.
- [x] Test active-task query and dashboard title fallback: anonymous connected MCPs belong to device liveness, not active task cards.
- [x] Run focused tests, then full suite. Document publish/install/rollback and startup/reconnect semantics.
- [x] Publish tracked source archive to n8n-instance under dedicated service account; verify health/auth/hashes.
- [x] Install stable launcher on three devices, retain credential loaders, verify real managed runtime versions and task metadata. Do not kill unrelated active sessions.
- [x] Review actual diff and operational evidence; record checkpoint. Workflow closure and verified Zettly outcome follow the final documentation commit.

## Verification focus

Bad auth must never use a new release. Truncated/corrupt artifacts must not be cached as healthy. Concurrent clients must not race dependency installation. No release may write outside cache through archive entries. Central outage may use only an explicitly verified prior cache, with a visible warning. Anonymous connections must not inflate the count of active work.

## Ledger

2026-11-04: Owner authorized setup and server selection. Chose distribution plus local execution because existing workflow handlers directly access local filesystem and Git. A pure HTTP move of the existing handlers would break local paths; preserving those operations also avoids granting a server remote-shell authority over workstations. This achieves one central update without pretending local execution disappeared.
