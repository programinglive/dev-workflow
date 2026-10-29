# Verification and remaining risks

Branch: `feat/secret-reference-security`, isolated worktree on HELLOWORLD.
Baseline: `a57dba4` / package 1.10.0. No production deployment or credential rotation.

## Audit evidence

Read architecture, tool handlers, JSON state/compatibility mirrors, SQLite/MySQL/
PostgreSQL adapters, Factory HTTP integration, Express APIs, static dashboard,
environment examples, Docker contexts, CI/release workflows and tests.
Initial full suite: 207 passed, 2 external database tests skipped.

Scanned 2,628 locally reachable Git objects across 386 commits using private-key,
provider-prefix, credential URL and assignment patterns. Historical credential URL
candidates occur in `.env.production`, `.env.example`, README, deployment docs,
Compose, test helpers and removed `scripts/check-db.js`, `scripts/recovery-sync.js`
and `verify-db-mysql.js`. Values were never printed or validated against services.
The production template has a change marker; validity is unknown. Assignment
matches included code, placeholders and dependency metadata and require contextual
review. This scan is not proof of absence of historical credentials; dangling
objects, remote-only refs, release artifacts, Git LFS, forks and caches were not
inspected. Do not publish the former production template to collect evidence.

Independent read-only review found conflicting classification labels, known opaque
runtime credential persistence, custom serialization injection and missing standard
credential paths. Regression tests reproduce each and the implementation rejects
or redacts them. Executable/custom objects and non-JSON binary containers are
rejected from knowledge persistence. Runtime credential matching complements
format/context detection. A process marker is metadata, no longer a `token` field;
legacy process-marker migration preserves shared-session reconciliation.

## Checks

Final verification on HELLOWORLD:

| Check | Result |
| --- | --- |
| `npm test` | 248 passed, 0 failed, 2 external DB integrations skipped (250 total) |
| `npm run test:security` | 41 passed, 0 failed |
| `npm run lint` | JavaScript syntax checks passed for 92 files |
| `npm run lint --prefix web` | Blocked before linting: existing typescript-eslint rejects TS 7 |
| `npm run build` | Server bundle and Next static export passed |
| `node scripts/verify-bundle.mjs` | Built MCP started successfully |
| CLI `security_audit`, source and built entrypoints | Strict-mode report shape verified; current-project scoped DB scan completed |
| `npm pack --dry-run --json --ignore-scripts` | 78 package files, security module included, no protected environment/state/key paths matched |
| `git diff --check` | Passed |

The project audit reported source/documentation candidates, including synthetic
security fixtures; those are not proof of real credential exposure. The report
never returns matched values. Tests exercise real stdio MCP, CLI stdout/stderr,
in-memory SQLite, all adapter pre-connect write guards, PostgreSQL summary query
projection, HTTP middleware, generated-document guards and recursive logging.
The live PostgreSQL and MySQL suites were not configured and remain skipped.
The JS pre-connect tests do not substitute for those external integrations.

The final review also caught a PostgreSQL classification projection omission and
inherited Date serialization; both have red-green regression coverage and fixes.
Git commit execution uses argument arrays, preserving multiline messages without
passing their content through a shell. The initial worktree was left uncommitted
for review; release continuation evidence is recorded below.

Root `npm run lint` checks JavaScript syntax; it is not a semantic security audit.
Dashboard ESLint initially failed because typescript-eslint rejects the TypeScript
7 API. The continuation uses Microsoft's documented side-by-side aliases: the
TypeScript 6 compatibility API for ESLint and the TypeScript 7 compiler retained
as @typescript/native. No rules were disabled. Existing React lint errors were
corrected; theme state now subscribes to browser preferences, and login checks
the HttpOnly session. Dashboard lint is also enforced in CI.

## Practical limits and next actions

- Detection is heuristic. Unknown opaque credentials, deliberate encodings,
  fragmented material and secrets disguised as ordinary facts can evade it. Do not
  give the model real credentials in the first place.
- Revocation/rotation and coordinated history cleanup remain operator work if any
  historical candidate was a real credential. Removing the tracked template does
  not remove older commits, published packages, Docker layers, backups or clones.
- Secret references are validated metadata only. No MCP provider resolver exists.
  Runtime DB/auth/Factory code still needs credential access in process memory;
  use least privilege and OS/service-manager provisioning outside model context.
- Trusted npm release scripts and dependencies can execute code with runtime
  privileges. This layer is not an OS sandbox. Run untrusted repositories in an
  isolated account/container without production secrets. Git hooks and external
  tools may have their own logs; this server cannot sanitize external stores.
- Direct SQL access bypasses application write guards. Restrict database users,
  backups and file permissions. Existing contaminated records are not silently
  deleted; audit private backups, rotate, then remediate with a reviewed operation.
- security_audit reads at most 500 eligible project files (1 MiB each, depth 12)
  and 1,000 rows per current-user/project table. It reports truncation, missing
  tables and unreadable files. Protected files return metadata, not scanned content;
  a report is an inventory of candidates, not a certification.
- Auth cookies and password hashes remain in the dedicated authentication system,
  outside engineering knowledge. Cookie migration requires custom-client updates;
  browser third-party-cookie rules and live CORS/CSRF behavior need deployment
  verification. Existing bearer tokens remain usable until expiry; logout clears
  the browser cookie and does not revoke previously issued stateless JWTs.
- PostgreSQL/MySQL live integrations, Docker image execution and production API
  deployment were not tested. Review additive classification migrations and root
  API Docker context change in staging before rollout.
- Dashboard semantic lint passes with zero errors; existing unused-variable and
  internal-navigation warnings remain non-blocking.

## Release continuation, 2026-10-29

Independent review identified CLI security denials exiting successfully, legacy
release-state persistence bypassing policy, and incomplete buffered subprocesses
allowing versioning. Each was reproduced with a failing regression then fixed.
Legacy process-marker migration now precedes policy validation. A real isolated
npm test fixture also reproduced Windows ENOENT; release tooling now invokes the
fixed package-manager test command through cmd on Windows and honors the supplied
working directory. No production credentials or database were used.

Integrated upstream f6a7e02 / package 1.12.3, preserving session isolation, explicit
Git project resolution, Factory heartbeat and task definitions. Its failing stdio
metadata test reproduced the eager creation of a PID fallback at startup. State is
now loaded only after request session selection; the existing E2E test passes.
The new shared-history writer also gets an independent persistence guard, verified
by a failing-then-passing unsafe-write regression.

After integration: full suite 316 passed, 2 external DB skips; server and static
dashboard build passed; source syntax lint passed (103 files); dashboard lint zero
errors (20 existing warnings). Docker is unavailable locally, so live SQL and API
staging remain rollout checks. Publishing npm does not deploy those web services.

Compatibility: browser authentication now uses an HttpOnly cookie instead of a
JSON token; custom browser clients must send credentials and handle CORS. Existing
Bearer authentication remains accepted. Deployment must provide explicit signing
secrets and runtime DB configuration; insecure fallback secrets are rejected.

The changes reduce concrete leakage paths. Passing tests does not establish that
the system is universally secure or ready for unrestricted production credentials.
