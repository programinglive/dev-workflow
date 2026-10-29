# Dev Workflow MCP Server

An MCP server that enforces development workflow discipline: **tests → documentation → commit → release**, with no way to skip a step.

```mermaid
graph LR
    A[start_task] --> B[Implement]
    B --> C[mark_bug_fixed]
    C --> D[create_tests]
    D --> E[run_tests]
    E -- FAIL --> B
    E -- PASS --> F[create_documentation]
    F --> G[check_ready_to_commit]
    G --> H[commit_and_push]
    H --> I[perform_release / skip_release]
    I --> J[complete_task]
```

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/programinglive/dev-workflow-mcp-server.git
cd dev-workflow-mcp-server
npm install
```

`better-sqlite3` ships prebuilt binaries for Node 22 and newer (ABI 127, 137,
141, 147). On Node 20 there is no prebuild for the current version, so npm falls
back to `node-gyp` and you need [Python 3](https://python.org) and
[Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
on Windows. See [Troubleshooting](#troubleshooting).

### 2. Verify the server runs

```bash
node index.js call get_workflow_status
```

Expected output:

```
📊 Current Workflow Status:

Phase: idle
Task: (none)
Feature flow: ❌
...
```

### 3. Connect an MCP client

See [MCP client configuration](#mcp-client-configuration).

---

## Available Tools

22 tools.

| Tool | Purpose |
|---|---|
| `start_task` | Begin a task (always the first step) |
| `create_feature_flow` | Record the feature flow as Mermaid |
| `mark_bug_fixed` | Mark the implementation done |
| `create_tests` | Mark tests as written |
| `skip_tests` | Skip tests with a justification |
| `run_tests` | Record test results (blocks commit when failing) |
| `create_documentation` | Mark docs as written |
| `check_ready_to_commit` | Verify every required step is complete |
| `commit_and_push` | `git add` → `commit` → `push` |
| `perform_release` | Record a release |
| `skip_release` | Skip the release step with a justification |
| `complete_task` | Finish and reset the workflow |
| `get_workflow_status` | Show the current phase |
| `continue_workflow` | Get guidance on the next step |
| `view_history` | List completed tasks |
| `run_full_workflow` | Run every step in one call |
| `rerun_workflow` | Restart the current task from the beginning |
| `drop_task` | Abandon the task without completing it |
| `force_complete_task` | Complete despite missing steps, with a reason |
| `project_summary` | Aggregate activity for the project |
| `project_summary_data` | Read the persisted `project-summary.json` |
| `project_summary_db` | Read the per-user summary from SQLite |
| `list_factory_tasks` | List your Factory task queue (requires config) |
| `create_factory_task` | Record a new task with a required definition of done |
| `update_factory_task` | Edit a task, including filling a missing definition of done |
| `claim_factory_task` | Claim a Factory task and start a local workflow |
| `sync_task_status` | Report a status change back to Factory |

### Factory task integration

Five tools connect this server to the **Factory** board at
`factory.programinglive.com`. They read and write the real task table
(`factory_tasks`), not the retired PocketBase `activity_tasks` collection
(which still exists but holds 0 records and never reached the board).

They stay **inert** until configured. With no configuration the server behaves
exactly as before, and the tools reply with setup instructions.

```bash
FACTORY_URL=https://factory.programinglive.com
FACTORY_EMAIL=<activity_users email>
FACTORY_PASSWORD=<password>
```

Or supply a ready token instead of a password:

```bash
FACTORY_TOKEN=<PocketBase activity_users token>
```

Optional:

```bash
FACTORY_PB_URL=https://pocketbase.programinglive.com   # where the login happens
FACTORY_MACHINE_ID=<name shown on the device row>       # defaults to the hostname
FACTORY_DEVICE_ID=<fixed device UUID>                   # else derived from the name
FACTORY_AGENT=dev-workflow-mcp                          # max 40 chars
```

Use an **`activity_users` account, not a PocketBase superuser**. Factory accepts
that token as `Authorization: Bearer <token>` for non-browser clients, and the
account only sees its own tasks.

| Tool | Writes? | What it does |
|---|---|---|
| `list_factory_tasks` | no | Reads `GET /api/factory`, maps tasks plus their latest work session, and orders them status → priority. Defaults to `running, queued, backlog, review, blocked` |
| `create_factory_task` | yes | Creates a task (`POST /api/factory {action:create_task}`). Requires `acceptance` and `definitionOfDone`; defaults to `backlog` so recording work never starts a worker run |
| `update_factory_task` | yes | Edits title, description, acceptance or definitionOfDone (`POST /api/factory {action:update_task}`), sending the task's current version so Factory can reject a stale edit with 409 |
| `claim_factory_task` | yes | Opens a work session (`POST /api/work {action:start}`), which is what turns the task `running` on the board, then starts a local workflow |
| `sync_task_status` | yes | Uses the only endpoint that can produce the status; see the table below |

#### Status mapping is not free-form

Factory has no generic "set status" endpoint, so the tool routes each status to
the endpoint that actually supports it:

| Requested status | Endpoint used | Result |
|---|---|---|
| `review`, `blocked`, `paused` | `POST /api/work {action:finish}` | Session closes, task changes accordingly |
| `backlog`, `queued`, `cancelled` | `POST /api/factory {action:move_task}` | Board column changes |
| `running` | — rejected | Point the caller at `claim_factory_task` |
| `done` | — rejected | A human approves the work in Factory |

`review` requires an active work session. Asking for it without one fails with
"no active work session" instead of silently doing nothing - the task must be
claimed first. Full behaviour, limits (summary 2000 chars, step 240 chars) and
troubleshooting live in [docs/factory-integration.md](docs/factory-integration.md).

#### Review is reported once, not twice

Factory reads a second `review` report as an **approval**, so a task can jump to
`done` without a human deciding anything. That happened on 29 October 2026 to
four tasks whose earlier session was already `review` while the board still said
`backlog`.

The client now refuses `review` when the workspace already holds a `work.review`
or `task.done` event for that task, and says what to do instead:

```
Task "..." sudah pernah dilaporkan untuk review (work.review pada ...).
Melaporkan review kedua kali dibaca Factory sebagai approval, ...
Minta pemilik memutuskan: set done bila pekerjaan diterima, atau kembalikan
ke backlog bila perlu dikerjakan ulang.
```

`blocked` and `paused` are unaffected: only `review` carries approval semantics.

#### Task ids are UUIDs

`list_factory_tasks` prints the full UUID, because `sync_task_status` and
`claim_factory_task` reject the 8-character short key. Earlier versions printed
the short key, which forced agents to call `GET /api/factory` by hand.


### Example session

```
"Start a new task: add user authentication, type: feature"
→ start_task, phase moves to coding

[you write code]

"Mark as fixed: login with JWT token"
→ mark_bug_fixed, phase moves to testing

[you write tests]

"Create tests done"
→ create_tests

"Run tests: passed=true, command='npm test', details='12 tests passed'"
→ run_tests, phase moves to documentation

"Create docs: type=README, summary='Added auth section'"
→ create_documentation, phase moves to ready_to_commit

"Check if ready to commit"
→ check_ready_to_commit → READY

"Commit and push: message='feat(auth): add JWT authentication'"
→ commit_and_push, phase moves to release

"Perform release: command='npm run release:minor'"
→ perform_release, phase moves to ready_to_complete

"Complete task: commitMessage='feat(auth): add JWT authentication'"
→ complete_task, workflow reset to idle
```

---

## MCP client configuration

### OpenCode

OpenCode V2 nests servers under `mcp.servers` and does **not** accept an
`enabled` key there. Config path is reported by `opencode debug paths`
(`~/.config/opencode` on every platform, including Windows).

```json
{
  "mcp": {
    "servers": {
      "dev-workflow": {
        "type": "local",
        "command": ["node", "C:\\path\\to\\dev-workflow-mcp-server\\index.js"]
      }
    }
  }
}
```

The simplest way to write this correctly is to let OpenCode do it:

```bash
opencode mcp add dev-workflow --global -- node "C:\path\to\dev-workflow-mcp-server\index.js"
```

### Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "dev-workflow": {
      "command": "node",
      "args": ["C:\\path\\to\\dev-workflow-mcp-server\\index.js"]
    }
  }
}
```

### Windsurf

`%APPDATA%\Windsurf\config.json` (Windows) or
`~/Library/Application Support/Windsurf/config.json` (macOS):

```json
{
  "mcpServers": {
    "dev-workflow": {
      "command": "node",
      "cwd": "C:\\path\\to\\dev-workflow-mcp-server",
      "args": ["index.js"]
    }
  }
}
```

### Antigravity

`%APPDATA%\Antigravity\mcp_config.json`:

```json
{
  "mcpServers": {
    "dev-workflow": {
      "command": "node",
      "args": ["C:\\path\\to\\dev-workflow-mcp-server\\index.js"]
    }
  }
}
```

> **Performance:** run `node index.js` directly rather than through `npx`.
> Startup is noticeably faster.

---

## Configuration

### Database

Defaults to **SQLite** (file-based, zero config). PostgreSQL and MySQL are also
supported:

```bash
# .env or environment variable
DEV_WORKFLOW_DB_TYPE=postgres
DEV_WORKFLOW_DB_URL=postgresql://user:pass@localhost:5432/devworkflow
```

| Variable | Default | Description |
|---|---|---|
| `DEV_WORKFLOW_DB_TYPE` | `sqlite` | `sqlite`, `mysql`, or `postgres` |
| `DEV_WORKFLOW_DB_URL` | — | Connection string (MySQL/Postgres) |
| `DEV_WORKFLOW_DB_PATH` | `.state/dev-workflow.db` | SQLite path (optional) |
| `DEV_WORKFLOW_USER_ID` | auto-generated | User ID for multi-user isolation |
| `DEV_WORKFLOW_STATE_FILE` | auto-resolved | Override for `workflow-state.json` |
| `FACTORY_URL` | - | Factory base URL, e.g. `https://factory.programinglive.com` |
| `FACTORY_TOKEN` | - | PocketBase `activity_users` token sent as a Bearer header |
| `FACTORY_EMAIL` | - | `activity_users` email, exchanged for a token on demand |
| `FACTORY_PASSWORD` | - | Password for that account |
| `FACTORY_PB_URL` | `https://pocketbase.programinglive.com` | Where the token is obtained |
| `FACTORY_MACHINE_ID` | hostname | Device name shown on the Factory board |
| `FACTORY_DEVICE_ID` | derived from the name | Stable device UUID |

### Project-specific state

Each project keeps its own state in `.state/users/<user-id>/workflow-state.json`.
The `.state/` directory is gitignored.

For multi-client isolation (for example separate state for Windsurf and
Antigravity), set a different user ID per client:

```json
{
  "mcpServers": {
    "dev-workflow": {
      "command": "node",
      "args": ["path/to/index.js"],
      "env": { "DEV_WORKFLOW_USER_ID": "windsurf" }
    }
  }
}
```

---

## One-command stack setup (OpenCode V2)

`scripts/setup-stack.js` installs the whole agent stack: this MCP server,
[obra/superpowers](https://github.com/obra/superpowers) skills, and
[RTK](https://github.com/rtk-ai/rtk) token compression.

```bash
node scripts/setup-stack.js      # any platform
```

Platform wrappers install RTK, run `npm install`, then delegate to the same
script:

```powershell
pwsh scripts/bootstrap-windows.ps1
```

```bash
bash scripts/bootstrap-unix.sh
```

### What it does

1. **Finds the real config directory.** Runs `opencode debug paths` and uses the
   reported `config` path, falling back to `~/.config/opencode`. OpenCode V2
   uses that path on Windows too — `%APPDATA%\opencode` is not read.
2. **Backs up `opencode.json`** to `secrets/opencode-backup-<timestamp>.json`
   before touching it.
3. **Registers Superpowers** under the V2 `plugins` key. The V1 `plugin` key is
   deprecated and ignored by V2.
4. **Registers the MCP server** via `opencode mcp add`, which writes a
   schema-valid `mcp.servers` entry.
5. **Installs dependencies.** Without `npm install` the server dies at startup
   with `ERR_MODULE_NOT_FOUND: Cannot find package 'dotenv'`.
6. **Smoke tests the server**, then verifies with `opencode mcp list` and
   `opencode plugin list`. Exits non-zero when a check fails.
7. **Creates `AGENTS.md`** in the current project if missing.

---

## Tests

```bash
npm test                            # full suite
node --test tests/setup-stack.test.js
```

```
ℹ tests 112
ℹ pass 110
ℹ fail 0
ℹ skipped 2
```

The two skipped tests are the MySQL and PostgreSQL adapters. They run only when a
database is reachable:

```bash
TEST_MYSQL_URL=mysql://user:pass@localhost:3306/db npm test
TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/db npm test
```

To exercise them against real servers without exposing them publicly:

```bash
# on the database host, once: creates isolated devworkflow_test databases
./scripts/setup-test-dbs.sh

# locally: opens an SSH tunnel, runs only the adapter tests, closes the tunnel
TEST_POSTGRES_URL=... TEST_MYSQL_URL=... ./scripts/test-db-adapters.sh
```

Both adapters pass against live MySQL and PostgreSQL this way (19/19 tests, none
skipped). The tests **write real rows**, so `setup-test-dbs.sh` creates separate
`devworkflow_test` databases and grants the test role access only to those. Never
point these variables at a production database.

Everything else, including the SQLite adapter, always runs.

`tests/test-helpers.js` exports `stripNpmNotices()`, which removes npm's own
`npm warn`/`npm notice` output and Rollup's third-party annotation warnings from
captured stderr before the build test asserts on it.

---

## CI

`.github/workflows/ci.yml` runs on the **self-hosted runner on MMCH**, not on
GitHub-hosted minutes:

```yaml
runs-on: [self-hosted, windows, mmch]
```

| Job | Steps |
|---|---|
| `test` | `npm ci` → `npm test` → `build:server` → **verify the bundle starts** → `npm audit --omit=dev --audit-level=high` → setup-stack suite |
| `web` | `npm ci` in `web/` → static export build → verify `out/index.html` and CSS size → `npm audit --audit-level=high` |

The bundle verification step exists because a successful build does not mean
the artefact runs. `dist/index.mjs` is the published package entry, and a
bundler upgrade once produced a green build whose output crashed on startup.
`scripts/verify-bundle.mjs` starts the bundle and requires the stdio startup
banner, so that class of failure fails the pull request instead of the release.

The `web` job exists because the dashboard is deployed to Netlify from `web/`.
The CSS size check catches a Tailwind regression that a green build would
otherwise hide.

### Tailwind stays on v3

`web/` uses Tailwind 3.4 and is **not** being migrated to v4. Tailwind 4 is a
rewrite of the CSS pipeline: the `@tailwind` directives become
`@import "tailwindcss"`, the config moves into CSS, and the PostCSS plugin is
replaced by `@tailwindcss/postcss`. The dashboard is finished and stable, so
rewriting its styling pipeline risks the entire visual design for no functional
gain.

`dependabot.yml` ignores `tailwindcss`, `@tailwindcss/postcss` and
`@tailwindcss/cli` entirely — not just majors — so no v4 pull request
reappears.

Runner provisioning and troubleshooting: [docs/homelab/ci-runner.md](./docs/homelab/ci-runner.md).

---

## Release workflow

`.github/workflows/github-release.yml` runs on a `v*` tag, split in two:

| Job | Runner | Work |
|---|---|---|
| `build` | self-hosted MMCH | `npm ci` → `npm test` → `build:server` → verify the bundle starts → `npm pack` → upload tarball |
| `publish` | `ubuntu-latest` | download tarball → `npm publish` → create/update the GitHub release |

Publishing uses **Trusted Publishing (OIDC)**: no long-lived npm token is stored
anywhere, and `id-token: write` plus `registry-url` on `setup-node` is the whole
configuration. The trusted publisher is registered with `npm trust`:

```bash
npm trust github @programinglive/dev-workflow-mcp-server \
  --file .github/workflows/github-release.yml \
  --repo programinglive/dev-workflow-mcp-server \
  --allow-publish -y
```

The `file` must match the workflow filename exactly, or OIDC is rejected.

### No provenance

`--provenance` is intentionally **not** used. npm rejects provenance bundles
whose source repository is private:

```
422 Unprocessable Entity - Unsupported GitHub Actions source repository
visibility: "private". Only public source repositories are supported when
publishing with provenance.
```

This repository is private by policy, so provenance is unavailable. Consumers
cannot cryptographically verify which commit produced a published tarball.

### What ships in the package

`.npmignore` limits the tarball to the runtime server: about 60 files and 66 kB.
It excludes `.env*` (only `.env.example` ships), `.state/`, tests, CI config,
`web/`, and docs.

`scripts/install-husky.js` runs from `prepare`. It installs git hooks only when a
`.git` directory is present, so installing the package as a dependency does not
fail on husky.

---

## What this server prevents

- Committing without tests
- Committing with failing tests
- Committing without documentation
- Forgetting a workflow step
- Releasing without committing and pushing

---

## Tips

1. Always start with `start_task` — it sets the intent for the session
2. Do not skip tests unless it is genuinely impossible — use `skip_tests` with a clear reason
3. Call `get_workflow_status` whenever you lose track of the phase
4. `run_full_workflow` is a shortcut for simple tasks where all the data is already known
5. For docs-only work, use `skip_release` rather than forcing a release

---

## Troubleshooting

**`ERR_MODULE_NOT_FOUND: Cannot find package 'dotenv'`** — dependencies are not
installed. Run `npm install` in the repo.

**`gyp ERR! find VS` on Windows** — the native module is compiling from source
because there is no prebuild for your Node ABI. Either switch to a Node version
that has one, or install Visual Studio Build Tools.

**`EPERM ... better_sqlite3.node`** - a running process holds the file. Stop it,
then reinstall.

**`commit_and_push` says "No changes detected" while the project clearly has
changes** - git ran in the wrong repository. The server used to fall back to its
own package directory, which is also a git repo, so commits landed there (or
nowhere) instead of in your project. It now refuses to run git in the package
repo and asks for the project explicitly:

```bash
export WORKFLOW_PROJECT_DIR=/path/to/your/project
```

Point it at any directory inside the project; the repo root is discovered
upward. Non-git commands are unaffected.

**A task jumped straight to `done` after reporting `review`** - it was reported
twice. Factory treats the second report as approval. Current versions block that
at the client, but if it already happened, review the task and move it back to
`backlog` if the work is not accepted.

**OpenCode does not load the server** — check the config shape. V2 requires
`mcp.servers` and rejects `enabled`:

```bash
opencode mcp list          # should show: dev-workflow  connected
```

---

## Build

```bash
npm run build    # → dist/index.mjs (optimized bundle, used for npm distribution)
npm run web      # → dashboard on http://localhost:3000
```

For MCP use, point the client at `index.js` directly — startup is faster than the
bundled `dist/index.mjs`.

---

## Homelab Development Guide

This repository also documents the internal **programinglive** homelab: Tailscale
plus SSH across three machines (MMCH, HELLOWORLD, Mac).

| Document | Contents |
|---|---|
| [docs/homelab/README.md](./docs/homelab/README.md) | Overview and quick reference |
| [docs/homelab/infra-tailnet-ssh.md](./docs/homelab/infra-tailnet-ssh.md) | Tailnet and SSH setup |
| [docs/homelab/cli-tools.md](./docs/homelab/cli-tools.md) | CLI tools per machine |
| [docs/homelab/ci-runner.md](./docs/homelab/ci-runner.md) | Self-hosted CI runner on MMCH |
| [docs/homelab/security-rules.md](./docs/homelab/security-rules.md) | Security rules |
| [.agent/workflows/homelab-setup.md](./.agent/workflows/homelab-setup.md) | MCP workflow for onboarding a new machine |

> ⚠️ This repository is **private**. Do not share it publicly.

---

## License

MIT
