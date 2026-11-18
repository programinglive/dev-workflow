# Execution journal — Factory retirement finalization & Next.js security

- **Date:** 2026-11-18
- **Execution:** autonomous, CLI-first
- **Repository:** `programinglive/dev-workflow-mcp-server` (`git@github.com:programinglive/dev-workflow-mcp-server.git`)
- **Main checkout:** `D:\code\dev-workflow-mcp-server` (branch `fix/project-lock-session-isolation`, left untouched)
- **Worktrees:**
  - `D:\code\factory-cleanup-dwf` — branch `chore/factory-cleanup-20261118`
  - `D:\code\dwf-next-security-20261118` — branch `security/nextjs-upgrade-20261118`
  - `D:\code\dwf-baseline`, `D:\code\dwf-pristine2` — throw-away baseline worktrees (removed after use)

## Repository identity (verified)

- Remote `origin` = `git@github.com:programinglive/dev-workflow-mcp-server.git`.
- Base of both task branches: `origin/main` @ `bcfef3a` (`chore(release): 1.32.5`).
- `D:\code\dwf-baseline` confirmed a **linked worktree** of the same repository — not modified.

## Workstreams

### A — Factory retirement

- PR: https://github.com/programinglive/dev-workflow-mcp-server/pull/127 (head `chore/factory-cleanup-20261118`).
- Commits: `59cdad8` (remove Factory integration from current main), `f074335` (restore the generated web catalog that the first commit accidentally deleted).
- Removed: Factory modules, MCP handlers/tools, `/api/factory/*` web endpoints, session keeper, task-provenance/monitor/Zettly/DoD code paths, tests and docs.
- Evidence: `getToolList()` exposes no Factory tool; `list_factory_tasks`, `claim_factory_task`, `create_factory_task`, `link_factory_task`, `sync_task_status` answer `Unknown tool`.
- `web/lib/catalog.generated.ts` is tracked and required by `tests/website-docs-consistency.test.js`; regenerated with `web/scripts/generate-docs-data.mjs` so it matches the post-cleanup runtime catalog.

### B — GCP Load Balancer host rule

- URL map: `beautyworldloadbalancer` (project `winged-ratio-344917`), fingerprint captured before any change.
- Backup of the exported URL map: `%TEMP%\urlmap-beautyworldloadbalancer-20261118.yaml`.
- Finding: `factory.programinglive.com` is **one hostname inside a shared `hostRules` entry with 30 active hostnames**, all routed to path matcher `pm-bwapp`. There is no per-host mutate operation (`gcloud compute url-maps` offers only `add-host-rule` / `remove-host-rule`, which act on a whole rule).
- Decision: **left intact.** Removing one hostname requires a full URL-map replace, and the safety conditions for shared routing configuration were not met. The Cloudflare DNS record was already deleted, so the host rule is dormant.
- Rollback: re-import the backed-up URL map.

### C — Next.js security

- Advisory: **GHSA-pc58-hwjq-p385 / CVE-2026-119348** — `next` `>=16.0.0, <=16.4.4` (and `<=15.5.28`); patched in `16.4.5` / `15.5.29`.
- Repository state: `web/package.json` declares `next: ^16.4.6`; the lockfile resolves **16.4.6** (current `latest`). Reached via `c5bb643` ("bump the minor-and-patch group (#114)") which raised `next` from `^16.0.10`.
- Production: `devworkflow.programinglive.com` deploy `44277873826` built from `main @ bcfef3a`, i.e. the 16.4.6 build.
- The earlier build nudge came from a stale local `node_modules` (16.4.3) reused through a directory junction; a clean `npm ci` installs 16.4.6 and `next build` runs with no nudge.
- Security PR: https://github.com/programinglive/dev-workflow-mcp-server/pull/128 — adds `tests/nextjs-security.test.mjs`, a lockfile guard that fails CI if the resolved `next` re-enters the affected range. No runtime or lockfile change.

## Tests (exact)

- `node --no-deprecation --import ./tests/setup-env.js --test --test-reporter=tap` on the cleanup branch: **2340 tests, 2280 pass, 28 fail**.
- Same command on a pristine `origin/main` worktree: **2498 tests, 2439 pass, 28 fail** — identical failure set (pre-existing, environment/identity related). No new failure introduced.
- `npm run lint`: OK, English policy 0 new violations.
- `npm run build:server`: OK. `npm run build:web`: OK (after the one-time Next.js security-version nudge retry).
- `node --test tests/nextjs-security.test.mjs`: 3 pass, 0 fail.

## CI

- PR #127: `ci / Web build and audit` pass; `ci / Test, lint and build` initially failed on the accidentally deleted generated catalog and was fixed by `f074335`.
- PR #128: CI pending at the time of writing.

## Deployment

- No deployment performed by this execution. Production web deploy remains `44277873826` from `main @ bcfef3a`.
- Factory DNS (`factory.programinglive.com`) is already deleted; portal/Zettly/ERP remain available.

## Locks / approvals

- No DevWorkflow task lock held. The `dev-workflow` MCP namespace was intermittently unavailable in the session catalogue, so task registration could not be performed; tracking is recorded here instead.
- No GCP resource deleted; only a read-only export was taken.

## Blockers / next safe actions

1. PR #127 CI re-run to confirm green after `f074335`, then merge.
2. PR #128 CI, then merge (test-only, no runtime impact).
3. Optional, requires explicit authorization: remove the single `factory.programinglive.com` hostname from the shared URL-map `hostRules` via a full `url-maps import`, with the backed-up file as rollback.
4. Follow-up: the 56 dev-dependency audit findings and the `@next/eslint-plugin-next` advisory with a downgrade-only fix.
