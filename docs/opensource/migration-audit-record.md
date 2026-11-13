# Open-Source Migration Audit Record

## 1. Executive Summary
This document forms the authoritative audit log for the transition of the DevWorkflow Governance Runtime from an internal private development repository to an open-source publication baseline (`v1.31.0-oss.0`).

- **Authoritative Source Branch**: `chore/oss-clean-history-s3c`
- **Reconciliation Lineage**:
  - `main`: `958b2d02` (Antigravity CLI empty config resilience)
  - `chore/oss-hardening-s2b`: `916fd044` (private IP sanitation & test fixtures)
  - `feat/v131-client-convergence-validation`: `4c0f608a` (7-layer convergence engine)
  - `chore/oss-cutover-s3b`: `34e29f86` (Fleet Doctor registration diagnostics)
  - `chore/oss-clean-history-s3c`: `7bbb4c1a` (source privacy sanitization, 4,745 deletions) + `57c7eedc` (CHANGELOG disclosure)
- **Open-Source Baseline Version Tag**: `v1.31.0-oss.0`
- **Git Strategy**: Single Clean Root Commit (guarantees zero inherited historical commit objects, zero leak of legacy credentials).

---

## 2. Historical Metadata Removal & Categorization
All internal files, private credentials, and topology disclosures were removed from the public tree:
1. **Historical Credential-Bearing Scripts (MUST_REMOVE)**:
   - `scripts/check-db.js` (commit `69e7f38`): PostgreSQL password.
   - `.env.production` (commit `3adb4cb`): Production keys.
   - `scripts/deploy-gcloud.*`: Embedded cloud deployment configurations.
   - `scripts/deploy-monitor.*`, `scripts/probe-*.sh`, `scripts/rotate-monitor-token.sh`.
2. **Private Infrastructure & Host Disclosures (SHOULD_REMOVE)**:
   - Tailscale IPs (`100.77.138.14`) sanitized to `127.0.0.1` or documentation host tokens.
   - Homelab guides (`docs/homelab/*`, `docs/checkpoints/*`).
   - Private runner IDs (`58937956`, `58882401`) removed from public documentation.
3. **Public Core Assets (ACCEPTABLE_PUBLIC)**:
   - MCP Governance Engine (`server.js`, `tools/*`).
   - Fleet Doctor & MCP Client Diagnostics (`managed/mcp-client-doctor.cjs`).
   - SQLite / Zettly Task Tracking.
   - Android Companion application (`mobile-app/*`).
   - Complete regression test suite (`tests/*`).

---

## 3. Credential Lifecycle Attestation
- **PostgreSQL Administrative Status**: `CREDENTIAL_STATUS_UNVERIFIED`
- In accordance with non-destructive security boundaries, no attempt was made to connect to or authenticate against the historical PostgreSQL host with the exposed password. Network timeout is explicitly NOT treated as proof of user deletion.
- Final cloud console verification is pending repository owner administrative confirmation.

---

## 4. Dual Offline Durable Backups
Dual complete offline git bundle backups are stored outside the Git repository:
1. `D:\code\dev-workflow-private-backup-20261112.bundle` (6.4 MB)
2. `D:\code\dev-workflow-private-backup-20261113-s3b.bundle` (278 refs verified)
All internal history from inception through v1.31.0 is preserved offline.
