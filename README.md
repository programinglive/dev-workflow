# Dev Workflow MCP Server

MCP server yang memaksa kamu mengikuti disiplin development workflow: **test → dokumentasi → commit → release**, tanpa bisa dilewatkan.

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

## Quick Start — 3 Menit

### 1. Clone & Install

```bash
git clone https://github.com/programinglive/dev-workflow-mcp-server.git
cd dev-workflow-mcp-server
npm install
```

> **Windows**: `better-sqlite3` butuh native build. Install [Python 3](https://python.org) + [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) dulu sebelum `npm install`.

### 2. Test Server Berjalan

```bash
node index.js call get_workflow_status
```

Output:

```
📊 Current Workflow Status:
Phase: idle
Task: (none)
Next step: idle
```

### 3. Hubungkan ke MCP Client

Lihat bagian [Konfigurasi MCP Client](#-konfigurasi-mcp-client) di bawah.

---

## 🛠️ Available Tools

| Tool | Fungsi |
|---|---|
| `start_task` | Mulai task baru (wajib pertama) |
| `create_feature_flow` | Catat alur fitur dengan Mermaid |
| `mark_bug_fixed` | Tandai implementasi selesai |
| `create_tests` | Tandai tests sudah dibuat |
| `skip_tests` | Lewati tests dengan alasan |
| `run_tests` | Catat hasil test (blokir commit jika fail) |
| `create_documentation` | Tandai docs sudah dibuat |
| `check_ready_to_commit` | Verifikasi semua step selesai |
| `commit_and_push` | `git add` → `commit` → `push` otomatis |
| `perform_release` | Catat release version |
| `skip_release` | Lewati release (docs-only task) |
| `complete_task` | Selesai & reset workflow |
| `get_workflow_status` | Cek fase saat ini |
| `view_history` | Lihat riwayat task selesai |
| `run_full_workflow` | Jalankan semua step sekaligus (1 command) |
| `project_summary` | Ringkasan aktivitas project |

### Contoh Percakapan

```
"Start a new task: add user authentication, type: feature"
→ start_task called, phase moves to coding

[kamu ngoding]

"Mark as fixed: login with JWT token"
→ mark_bug_fixed, phase moves to testing

[tulis test]

"Create tests done"
→ create_tests

"Run tests: passed=true, command='npm test', details='12 tests passed'"
→ run_tests, phase moves to documentation

"Create docs: type=README, summary='Added auth section'"
→ create_documentation, phase moves to ready_to_commit

"Check if ready to commit"
→ check_ready_to_commit → ✅ READY

"Commit and push: message='feat(auth): add JWT authentication'"
→ commit_and_push (auto git add/commit/push), phase moves to release

"Perform release: command='npm run release:minor'"
→ perform_release, phase moves to ready_to_complete

"Complete task: commitMessage='feat(auth): add JWT authentication'"
→ complete_task, workflow reset to idle
```

---

## ⚙️ Konfigurasi MCP Client

### OpenCode

Tambahkan ke `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "dev-workflow": {
      "type": "local",
      "command": ["node", "C:\\path\\to\\dev-workflow-mcp-server\\index.js"],
      "enabled": true
    }
  }
}
```

### Claude Desktop

File: `%APPDATA%\Claude\claude_desktop_config.json` (Windows) atau `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)

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

File: `%APPDATA%\Windsurf\config.json` (Windows) atau `~/Library/Application Support/Windsurf/config.json` (macOS)

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

File: `%APPDATA%\Antigravity\mcp_config.json`

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

> **Performance tip**: Gunakan `node index.js` langsung, jangan `npx`, agar startup lebih cepat.

---

## 🔧 Configuration

### Database

Default pakai **SQLite** (file-based, zero config). Bisa ganti ke PostgreSQL/MySQL:

```bash
# .env atau environment variable
DEV_WORKFLOW_DB_TYPE=postgres
DEV_WORKFLOW_DB_URL=postgresql://user:pass@localhost:5432/devworkflow
```

| Var | Default | Deskripsi |
|---|---|---|
| `DEV_WORKFLOW_DB_TYPE` | `sqlite` | `sqlite`, `mysql`, atau `postgres` |
| `DEV_WORKFLOW_DB_URL` | — | Connection string (untuk MySQL/Postgres) |
| `DEV_WORKFLOW_DB_PATH` | `.state/dev-workflow.db` | Path SQLite (opsional) |
| `DEV_WORKFLOW_USER_ID` | auto-generated | ID user untuk isolasi multi-user |
| `DEV_WORKFLOW_STATE_FILE` | auto-resolve | Path override workflow-state.json |

### Project-Specific State

Setiap project punya workflow state sendiri di `.state/users/<user-id>/workflow-state.json`. File ini otomatis di-gitignore.

Untuk isolasi multi-client (misal Windsurf + Antigravity pakai state terpisah):

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

## 🧰 One-Command Stack Setup (OpenCode V2)

`scripts/setup-stack.js` installs the whole AI agent stack: the dev-workflow MCP
server, [obra/superpowers](https://github.com/obra/superpowers) skills, and
[RTK](https://github.com/rtk-ai/rtk) token compression.

```bash
node scripts/setup-stack.js      # any platform
```

Platform wrappers (they only install RTK, run `npm install`, then delegate):

```powershell
pwsh scripts/bootstrap-windows.ps1
```

```bash
bash scripts/bootstrap-unix.sh
```

### What it does

1. **Finds the real config directory.** Runs `opencode debug paths` and uses the
   reported `config` path. OpenCode V2 resolves this to `~/.config/opencode` on
   **every** platform, including Windows - `%APPDATA%\opencode` is not read.
2. **Backs up `opencode.json`** to `secrets/opencode-backup-<timestamp>.json`
   before touching it.
3. **Registers Superpowers** under the V2 `plugins` key (the V1 `plugin` key is
   deprecated and ignored by V2).
4. **Registers the MCP server** under `mcp.servers` via `opencode mcp add`, which
   writes a schema-valid `Mcp.LocalConfigEncoded` entry.
5. **Installs dependencies.** Without `npm install` the server dies at startup
   with `ERR_MODULE_NOT_FOUND: Cannot find package 'dotenv'`.
6. **Smoke tests the server**, then verifies with `opencode mcp list` and
   `opencode plugin list`. Exits non-zero when any check fails, so a broken
   install can no longer report success.
7. **Creates `AGENTS.md`** in the current project if missing.

### Tests

```bash
npm test                            # full suite
node --test tests/setup-stack.test.js
```

`tests/test-helpers.js` exports `stripNpmNotices()`, which removes npm's own
`npm warn`/`npm notice` chatter and Rollup's third-party annotation warnings from
captured stderr before the build test asserts on it. Without it, a clean build
could look broken on machines with a user-level `.npmrc` or with dependency
versions that emit annotation warnings.

### CI

`.github/workflows/ci.yml` runs on the **self-hosted runner on MMCH**, not on
GitHub-hosted minutes:

```yaml
runs-on: [self-hosted, windows, mmch]
```

Two jobs:

| Job | Steps |
|---|---|
| `test` | `npm ci` → `npm test` → `build:server` → `npm audit --omit=dev --audit-level=high` → setup-stack suite |
| `web` | `npm ci` in `web/` → static export build → verify `out/index.html` and CSS size → `npm audit --audit-level=high` |

The `web` job exists because the dashboard is deployed to Netlify from `web/`
and previously had no CI coverage at all. The CSS size check catches a Tailwind
regression that a green build would otherwise hide.

A pull request cannot merge green if either job fails.

Runner provisioning and troubleshooting are documented in
[docs/homelab/ci-runner.md](./docs/homelab/ci-runner.md).

### Dependency hygiene

```bash
npm audit                 # full tree (production + dev)
npm audit --omit=dev      # production only
```

Both report `0 vulnerabilities`. `tar` is pinned via `overrides` in
`package.json`; bump that pin when a new advisory lands rather than relying on
the transitive range.

The root `tailwindcss` devDependency was removed: it was added when the web
dashboard still shipped a static HTML page, but that build step no longer
exists. The dashboard under `web/` has its own Tailwind setup
(`web/tailwind.config.ts`). The root `tailwind.config.js` pointed `content` at
`web/public/**/*.{html,js}`, a directory that holds only SVG icons, so it
generated nothing and was referenced by no script.

---

## 🏠 Homelab Development Guide

Repo ini juga berisi panduan konfigurasi homelab internal **programinglive** — Tailscale + SSH antar 3 mesin (MMCH, HELLOWORLD, Mac).

| Dokumen | Isi |
|---|---|
| [docs/homelab/README.md](./docs/homelab/README.md) | Overview & quick reference |
| [docs/homelab/infra-tailnet-ssh.md](./docs/homelab/infra-tailnet-ssh.md) | Tailnet + SSH setup lengkap |
| [docs/homelab/cli-tools.md](./docs/homelab/cli-tools.md) | CLI tools per machine |
| [docs/homelab/ci-runner.md](./docs/homelab/ci-runner.md) | Self-hosted CI runner di MMCH |
| [docs/homelab/security-rules.md](./docs/homelab/security-rules.md) | Aturan keamanan |
| [.agent/workflows/homelab-setup.md](./.agent/workflows/homelab-setup.md) | Workflow MCP untuk onboarding mesin baru |

> ⚠️ Repo ini **private**. Jangan bagikan ke publik.

---

## 🚫 What This Server Prevents

- ❌ Commit tanpa tests
- ❌ Commit dengan tests yang fail
- ❌ Commit tanpa dokumentasi
- ❌ Lupa langkah workflow
- ❌ Release tanpa commit & push

---

## 💡 Tips

1. Selalu mulai dengan `start_task` — ini yang set intention kamu
2. Jangan skip tests kecuali darurat — pakai `skip_tests` dengan alasan jelas
3. Pakai `get_workflow_status` kapanpun untuk cek progress
4. `run_full_workflow` = shortcut untuk task sederhana yang semua datanya sudah siap
5. Untuk docs-only task, gunakan `skip_release` daripada memaksakan release

---

## 🧪 Run Tests

```bash
npm test
```

```
ℹ tests 112
ℹ pass 110
ℹ fail 0
ℹ skipped 2
```

The two skipped tests are the MySQL and PostgreSQL adapters, which need a real
database connection (`MYSQL_URL` / `PG_URL`). Everything else, including the
SQLite adapter, runs.

If a Windows install fails on a native module, it is almost always a missing
prebuild for your Node ABI rather than a broken test - see
[docs/homelab/ci-runner.md](./docs/homelab/ci-runner.md#troubleshooting).

---

## 📦 Build

```bash
npm run build    # → dist/index.mjs (optimized bundle)
npm run web      # → dashboard di http://localhost:3111
```

Build output主要用于 npm distribution. Untuk MCP usage, gunakan source `index.js` langsung (lebih cepat startup).

---

## 📄 License

MIT
