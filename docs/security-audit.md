# Credential isolation audit and design

Audit date: 2026-10-29. Baseline: local `a57dba4`, package 1.10.0, HELLOWORLD.
Git working tree was clean. Public repository URL returned 404; the local checkout
and its locally reachable Git history are the audit source. No production database
or remote deployment was inspected. Findings contain no credential values.

## Existing architecture and findings

The Node ESM stdio server (`index.js`) dispatches tools through
`tools/handler-modules/index.js`. `WorkflowState` stores task descriptions, Mermaid,
test details, release commands and history as JSON, mirrors compatibility files,
generates project-summary.json, then synchronizes SQL. SQLite, MySQL and PostgreSQL
adapters also accept direct writes. Factory integration authenticates at runtime
and returns remote project/task content. Two Express servers expose authentication
and workflow history; the Next dashboard is exported separately.

| Severity | Finding and leakage path | Files |
| --- | --- | --- |
| High | Unscreened tool input -> state JSON, compatibility mirrors, SQL history and generated summaries -> MCP/HTTP output | workflow-state.js, tools/handler-modules/*, db/adapters/* |
| High | No classification or final output boundary; legacy DB, Factory content and subprocess errors can reach the model | index.js, factory-client.js, tools/handler-modules/index.js |
| High | Full exceptions and child stdout/stderr can reveal credentials; webhook event field is attacker controlled | exec.js, index.js, web/server.js, web/api-server.js, scripts/* |
| High | Tracked .env.production contains a credential-bearing connection URL and a nonempty password setting with a change marker. Treat as an exposure candidate, not proof of a valid production credential | .env.production, .gitignore |
| High | Hardcoded JWT/session and Compose password fallbacks permit predictable authentication when misconfigured | web/api-server.js, web/server.js, docker-compose.yml |
| High | Root Docker ignore does not exclude all environment/key files; web Docker context has no dedicated ignore | .dockerignore, web/Dockerfile.api |
| Medium | README/deployment examples encourage inline credential URLs in client configuration | README.md, .env.example, docs/GCP_DEPLOYMENT.md |
| Medium | Shared per-user workflow state crosses agent sessions; starting a task can archive another agent's active task | workflow-state.js |
| Medium | CI uploads arbitrary *.log files on failure; those files can contain credentials from dependencies/commands | .github/workflows/ci.yml |

Initial pattern scan located credential URL candidates in environment files,
README, deployment documentation, test-database scripts and synthetic tests.
Provider-prefix and private-key findings require contextual review; pattern matches
alone do not establish credential validity. Historical scan evidence is recorded
in `security-verification.md`. No secret was tested against a provider.

Follow-up review also found an admin creation script printing the password, a
database history helper with an embedded URL and an unauthenticated admin fallback,
and browser JWT material returned in JSON/localStorage. The implementation removes
these patterns; browser login uses an HttpOnly cookie and existing bearer clients
remain accepted. Authentication cookies and password hashes belong to the dedicated
runtime authentication system; they must never be ingested into workflow knowledge.

New history schemas add a classification column with INTERNAL as the legacy default.
Adapter migrations are additive. PostgreSQL web servers add this column on startup
and need the corresponding schema privilege; operators may provision it ahead of
startup instead. Live PostgreSQL/MySQL migrations have not been exercised here.

## Threat model

Assets: runtime environment credentials, secret-manager material, SSH/private keys,
connection URLs, auth headers/cookies, historical knowledge, logs and backups.
Actors: accidental user pastes, malicious repository documents or Factory content,
prompt injection, compromised tools/dependencies, another local agent and an
unauthorized API client. Trust boundaries: model/client input; ingestion; JSON/SQL
writes; subprocess and external HTTP results; log sinks; MCP/HTTP egress; packaging.

Primary scenarios: a pasted incident includes a token; a stack trace embeds a DB
URL; a legacy history entry contains a password; remote Factory content contains a
key; an .env is ingested; a hostile document asks a release tool to read private
files; Docker/npm/CI accidentally distributes private files. MCP input filtering
cannot erase a secret already pasted into the model/client. Runtime credentials
must be provisioned outside that boundary.

## Proposed architecture and alternatives

Keep the existing workflow implementation. Add a small dependency-free `security/`
layer, rather than rebuild the server or adopt a resolver accessible to the model.
An output-only redactor is insufficient because state and logs would retain raw
material. A general secret-manager resolver in MCP would expand privileges.

Flow: normalized input -> scanner -> rejection with sanitized findings OR
classification -> existing duplicate detection -> guarded JSON/SQL storage.
Result -> classification filter -> scanner/sanitizer -> MCP/HTTP. Logs use the
same recursive sanitizer. Storage checks remain independent of tool checks.

Classification: PUBLIC, INTERNAL (default for workflow knowledge), CONFIDENTIAL,
SECRET. SECRET-marked content is rejected at persistence/ingestion and suppressed
at output even if no known pattern matches. Existing unlabelled history stays
compatible and is screened on every output. No automatic destructive DB migration.

SecretReference accepts env, op, vault, aws-secrets, gcp-secret and bitwarden URIs;
validate metadata without resolving. No provider credentials or responses enter
knowledge. Runtime-only DB configuration supports DEV_WORKFLOW_DB_URL_ENV; old
DEV_WORKFLOW_DB_URL remains supported with a value-free deprecation warning.
Strict is the only supported mode; invalid modes fail closed.

Scanner combines key prefixes, structured sensitive fields, contextual assignments,
headers, userinfo URLs, private-key blocks, JWT and context-limited entropy. Safe
references and explicit placeholders are allowed; high-entropy Git hashes alone
are not secrets. Findings expose type, location, severity, a fully sanitized preview
and a generic suggested reference; never matched values or secret fingerprints.

Protected file ingestion returns metadata without reading contents, following
real paths and rejecting aliases to protected files. Release execution is limited
to the established npm release syntax; trusted repository scripts remain privileged
runtime code. Process-level isolation and minimum-privilege runtime credentials
are required for hostile repositories: a regex cannot sandbox executable code.

## Files and incremental plan

1. Add security/{references,scanner,sanitizer,policy,files,audit}.js and tests for
   synthetic secrets, nesting, entropy false positives and safe references.
2. Guard tools/handler-modules/index.js, shared.js and index.js; guard all JSON
   writes/migration copies in workflow-state.js and every adapter write including
   cached summaries. Sanitize legacy reads and subprocess failures.
3. Add security_audit MCP tool and CLI; report scoped SQL/JSON issues and protected
   file/config metadata without returning file contents. Add safe logging to owned
   entrypoints, Factory boundary and HTTP history responses. Authentication remains
   a dedicated runtime flow; never store its material as engineering knowledge.
4. Harden env indirection, predictable auth defaults, Docker contexts, ignore
   files, CI logs and documentation. Remove tracked production environment file;
   operators retain private copies in the existing checkout.
5. Run security tests, full existing suite, dashboard lint, syntax checks, server
   and web builds. Record limitations and evidence, then journal completion.

## Migration and operational remediation

Deploy only after review; this branch does not rotate credentials or rewrite
shared Git history. Inventory/rotate any real credential represented by historical
candidates in a trusted operator session. Revocation comes before optional Git
history cleanup; coordinate forks, tags, caches, package artifacts and backups.
Removing a file from the new tree does not purge history or previous releases.

Provision PROJECT_DATABASE_URL outside client JSON and set
DEV_WORKFLOW_DB_URL_ENV=PROJECT_DATABASE_URL. Set explicit JWT_SECRET and
SESSION_SECRET for web authentication outside knowledge storage. Compose must
receive a password and signing secret explicitly. Replace pasted values with
SecretReference before ingestion. Existing secret-bearing records are blocked or
sanitized on read, not silently deleted: audit a private backup, rotate secrets,
then replace records through a separately reviewed maintenance operation.

Known limitations: heuristic detection cannot prove absence of secrets, especially
encoded, fragmented or novel opaque values; local process/dependency compromise,
DB superuser writes, external logs, auth-session stores, backups and an LLM's
prior context remain outside this layer. Provider resolution, encryption-at-rest,
RBAC changes and automatic history rewriting are deliberately excluded.
