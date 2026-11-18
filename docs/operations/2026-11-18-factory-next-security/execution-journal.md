# Execution journal — Factory retirement finalization & Next.js security

- **Date:** 2026-11-18
- **Execution:** autonomous, CLI-first
- **Repository:** `programinglive/dev-workflow-mcp-server` (`git@github.com:programinglive/dev-workflow-mcp-server.git`)
- **Main checkout:** `D:\code\dev-workflow-mcp-server` (branch `fix/project-lock-session-isolation`, left untouched)
- **Final state:** all workstreams complete; see "Final outcome" below. Earlier intermediate states are preserved for the audit trail.

## Repository identity (verified)

- Remote `origin` = `git@github.com:programinglive/dev-workflow-mcp-server.git`.
- Base of both task branches: `origin/main` @ `bcfef3a` (`chore(release): 1.32.5`).
- Throw-away worktrees were removed after use.

## Workstreams

### A — Factory retirement

- PR: https://github.com/programinglive/dev-workflow-mcp-server/pull/127 — **MERGED** (`b521d77`).
- Commits: `59cdad8` (remove Factory integration from current main), `f074335` (restore the generated web catalog that the first commit accidentally deleted), `6754086` (this journal).
- Removed: Factory modules, MCP handlers/tools, `/api/factory/*` web endpoints, session keeper, task-provenance/monitor/Zettly/DoD code paths, tests and docs.
- Evidence: `getToolList()` exposes no Factory tool; `list_factory_tasks`, `claim_factory_task`, `create_factory_task`, `link_factory_task`, `sync_task_status` answer `Unknown tool`.
- `web/lib/catalog.generated.ts` is tracked and required by `tests/website-docs-consistency.test.js`; regenerated with `web/scripts/generate-docs-data.mjs`.
- Follow-up doc PR #129 (`6a84022`) aligned `monitor-server/task-metadata.md` with the cleaned code.

### B — GCP Load Balancer host rule, certificate and DNS

- URL map: `beautyworldloadbalancer` (project `winged-ratio-344917`), fingerprint captured before any change.
- Backups: `%TEMP%\urlmap-beautyworldloadbalancer-20261118.yaml`, `%TEMP%\urlmap-before-hostremoval.yaml`, `%TEMP%\cert-factory-backup-20261118-*.json`.
- Finding: `factory.programinglive.com` was one hostname inside a shared `hostRules` entry with 30 active hostnames, all routed to path matcher `pm-bwapp`. `gcloud compute url-maps` has no per-host mutate operation, so removal required a full `url-maps import` of the exported file with only that host line removed.
- **Completed:** full URL-map import removed the Factory host (31 -> 30 hostnames); fingerprint changed `FQAmi6G01VQ=` -> `H0fDXl3MSBY=`. The TLS certificate `cert-factory-programinglive-com` was detached from target proxy `beautyworldloadbalancer-target-proxy-2` (14 -> 13 certificates) and deleted. Cloudflare DNS `factory.programinglive.com` is NXDOMAIN.
- Verification: a scan of ssl-certificates, target HTTP(S) proxies, forwarding rules, backend services, health checks, instance groups, url-maps and addresses reports **0** Factory resources; the exported URL map contains **0** occurrences of `factory`.
- Shared infrastructure untouched: load balancer, IP `34.160.181.191`, certificate map/path matcher `pm-bwapp`, and all 30 active hostnames. Services portal / Zettly / ERP / HRIS / devworkflow remain HTTP 200.
- Rollback: re-import the backed-up URL map and re-create/attach the backed-up certificate.

### C — Next.js security

- Advisory: **GHSA-pc58-hwjq-p385 / CVE-2026-119348** — `next` `>=16.0.0, <=16.4.4` (and `<=15.5.28`); patched in `16.4.5` / `15.5.29`.
- Repository state: `web/package.json` declares `next: ^16.4.6`; the lockfile resolves **16.4.6** (current `latest`). Reached via `c5bb643` ("bump the minor-and-patch group (#114)") which raised `next` from `^16.0.10`.
- The earlier build nudge came from a stale local `node_modules` (16.4.3) reused through a directory junction; a clean `npm ci` installs 16.4.6 and `next build` runs with no nudge.
- Security PR: https://github.com/programinglive/dev-workflow-mcp-server/pull/128 — **MERGED** (`0afd5c6`); adds `tests/nextjs-security.test.mjs`, a lockfile guard that fails CI if the resolved `next` re-enters the affected range. No runtime or lockfile change.

### D — Production npm audit baseline

- CI's final step `npm audit --omit=dev --audit-level=high` failed with 6 findings (hono moderate; `picomatch <=4.0.7` high via `vite -> tinyglobby -> fdir`).
- Root cause: `vite` was declared in `dependencies` although it is only a build tool (`vite.config.js`, `vite.web.config.js`, `build:server`); the bundled `dist/index.mjs` has 0 references to vite. Because it sat in the production graph, `--omit=dev` still loaded the picomatch chain. `picomatch` has no patched release (GHSA-fc5q-39xc-vjpf / CVE-2026-112366).
- **Completed** via PR #131 — **MERGED** (`5fcb3e6`): moved `vite` to `devDependencies` and applied `npm audit fix` for hono. Commit `b781b58` regenerated the catalog after the 1.32.8 release so the consistency test passes.
- Verification: `npm audit --omit=dev --audit-level=high` -> **found 0 vulnerabilities (exit 0)**.

## Tests (exact)

- Cleanup branch: **2340 tests, 2280 pass, 28 fail**.
- Pristine `origin/main`: **2498 tests, 2439 pass, 28 fail** — identical failure set (pre-existing, environment/identity related). No new failure introduced.
- Final dependency branch: **2343 tests, 2282 pass, 29 fail, 32 skip** — the two extra failures are `run_full_workflow` cases blocked by the legitimate "release already running" guard (active GitHub Actions), and one prior failure disappeared because #127 fixed the catalog. No code regression.
- `npm run lint`: OK, English policy 0 new violations. `npm run build:server`: OK. `npm run build:web`: OK.
- `node --test tests/nextjs-security.test.mjs`: 3 pass, 0 fail.

## CI

- PR #127: `Web build and audit` pass; `Test, lint and build` failed only at the pre-existing audit step (documented).
- PR #128: same pre-existing audit step only; no test failure.
- PR #131: **both jobs pass** (`44349863913`).
- `main` after merge: CI `44351375745` **success**; Deploy web `44351374950` **success** from `5fcb3e6`.

## Deployment

- Production web deploy from clean `main @ 5fcb3e6` succeeded (`44351374950`). Portal / Zettly / ERP / HRIS / devworkflow all HTTP 200.
- No PocketBase credentials, portal collectors or P0-portal workstream files were touched.

## Locks / approvals

- No DevWorkflow task lock held. The `dev-workflow` MCP namespace was intermittently unavailable in the session catalogue, so task registration could not be performed; tracking is recorded here instead.
- GCP certificate deletion and URL-map import were performed only after backups were taken and the shared-routing impact was verified to be zero.

## Final outcome

All Factory remnants in code, DNS and GCP are removed; Next.js is on the patched 16.4.6 with a regression guard; the production audit baseline is 0; `main` CI is green and the web is deployed. Remaining references to "factory" exist only in guard tests and historical CHANGELOG/docs. Worktree `D:\repo-archive-2026-11\factory` is intact (52,660 files / 706 MB); its stored credentials were never read.
