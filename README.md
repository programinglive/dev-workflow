# DevWorkflow — Governed AI Development for Any Coding Agent

[![npm version](https://img.shields.io/npm/v/@programinglive/dev-workflow?color=2563EB)](https://www.npmjs.com/package/@programinglive/dev-workflow)
[![GitHub release](https://img.shields.io/github/v/release/programinglive/dev-workflow?color=10B981)](https://github.com/programinglive/dev-workflow/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-slate.svg)](./LICENSE)

> **Let agents write code. Make every change accountable.**  
> **Local-first, MIT-licensed, zero external accounts required.**

---

## What Is DevWorkflow?

**DevWorkflow** (`@programinglive/dev-workflow`) is a local-first **MCP server and CLI** that gives AI coding agents (Claude Code, Codex, OpenCode, Antigravity, or any MCP-compatible client) structured engineering discipline:

```text
Install → Connect AI Client → Start Task → Design Flow → Implement → Test → Audit & Document → Commit → Release
```

- **Free & Local-First:** Persists task contracts, checkpoints, and evidence in local SQLite WAL. Works completely offline.
- **No Mandatory Cloud Services:** You do **not** need Zettly, an Android tablet, Tailscale, or any ProgramingLive infrastructure to use DevWorkflow.
- **Progressive Optional Integrations:** Add Zettly planning sync, the DevWorkflow Android Companion, or team fleet governance later only if you want them.
- **Interactive Guides:** Walk through the [10-Step How to Use Guide](https://devworkflow.programinglive.com/how-to-use/) or explore [13 Real-World Use Cases](https://devworkflow.programinglive.com/use-cases/).

---

## Key Benefits

- **Prevents Hallucination & Scope Creep:** Enforces explicit Task Contracts (`plan`, `definitionOfDone`, and Mermaid flow gates) before implementation.
- **Worktree & Session Isolation:** Prevents concurrent AI sessions from overwriting each other's files.
- **Empirical Quality Gates:** Requires real test runs, documentation updates, and clean Git state before `commit_and_push`.
- **Release Discipline (v3.1.4):** every source change is versioned, tagged and synchronized across GitHub, npm and the public website.
- **Automatic Code Audit & Safe Fixes (v3.1.3 — 65 Canonical Tools):** Built-in canonical `audit`, `analyze_change`, `plan_fix`, and `apply_safe_fix` MCP tools detect security, database, architecture, quality, bug-fix knowledge (`category: "bugfix_knowledge"`), and open-source release documentation drift (`category: "release_docs"`), and apply bounded `AF-0`/`AF-1` autofixes with automatic snapshot rollback.
- **Persistent Code Memory & Debugging Context (v3.1.3):** Canonical `code_index` and `code_context` MCP tools integrate with Zettly Code to maintain an incremental SQLite code knowledge graph, enforce mandatory `@zettly-code` bug-fix knowledge comments, and automatically dual-sync graph snapshots to Zettly Engineering Control Center (`/api/v1/engineering/code-graph/sync`) and PocketBase (`zettly_code_graphs`) when connected. See [docs/guides/zettly-code-integration.md](docs/guides/zettly-code-integration.md).
- **Strict Secret Isolation:** `DEV_WORKFLOW_SECURITY_MODE=strict` blocks raw secret writes and scrubs sensitive tokens from outputs.

---

## Requirements

- **Node.js:** `>=20.0.0` (Windows, macOS, Linux)
- **Git:** `>=2.30`
- **AI Client:** Any MCP-compatible coding client (or standalone CLI usage via `devwf`)

---

## Quick Start (Standalone Local-First)

Install globally from npm:

```bash
npm install -g @programinglive/dev-workflow
devwf setup
devwf doctor
```

That's it. DevWorkflow initializes in `LOCAL_FIRST_STANDALONE` mode with zero network calls and zero external accounts.

For non-interactive / CI setups or contributing from source, see [docs/getting-started/installation.md](docs/getting-started/installation.md).

---

## Choose a Tool Profile

Every MCP session pays for the tool catalog it receives. DevWorkflow can register a **smaller catalog** without changing what the workflow enforces: the same gates, the same evidence requirements, the same handler code. Only the visible tool list changes.

```bash
devwf setup --profile core    # or standard, full
devwf doctor                  # shows the active profile, tool count and estimated prompt budget
```

| Profile | Tools | Prompt budget (estimate) | Choose it when |
|---|---|---|---|
| `core` | 18 | ~5.5k tokens (about 72% smaller) | You only need the task lifecycle: start → flow → fix → test → document → ready → commit → release → complete. The strictest profile: no waiver, force-complete, handoff or Sentry tools. |
| `standard` | 30 | ~9.4k tokens (about 52% smaller) | You also want audit/autofix, code memory (`code_index`, `code_context`), release locking, deployment recording and project discovery. |
| `full` | 65 | ~19.8k tokens | Everything, including waivers, forced completion, focus tools, handoff, Sentry and session tooling. **Default.** |

Token figures are labelled estimates (tools plus server instructions, about three characters per token), not measurements — read them as relative cost, not exact billing.

- Selection order: `DEVWF_TOOL_PROFILE` environment variable, then the `toolProfile` recorded by `devwf setup --profile` in `~/.devworkflow/profile.json`, then `full`.
- An unknown or empty value falls back to `full`, so a typo can never lock a session out of its tools.
- Calling a tool that the active profile hides is refused with a message naming the profile and how to switch, instead of a confusing "unknown tool".
- Guidance adapts: instructions and error messages never tell you to call a tool your profile does not expose.
- Profiles never weaken a gate. `core` simply has no waiver tools, so the smallest profile is also the strictest one.
- Restart the MCP server after changing the profile; clients cache `tools/list` for the life of the process.

---

## Connect an AI Coding Client

Choose your MCP client guide:

- **Claude Code:** [docs/integrations/claude-code.md](docs/integrations/claude-code.md)
- **OpenAI Codex:** [docs/integrations/codex.md](docs/integrations/codex.md)
- **OpenCode:** [docs/integrations/opencode.md](docs/integrations/opencode.md)
- **Antigravity (CLI & IDE):** [docs/integrations/antigravity.md](docs/integrations/antigravity.md)
- **Any Generic MCP Client:** [docs/integrations/generic-mcp-client.md](docs/integrations/generic-mcp-client.md)

After connecting, walk through your first governed task in [docs/getting-started/first-task.md](docs/getting-started/first-task.md).

---

## Capability Layers (Core vs Optional)

| Layer | Capabilities | Required? |
|---|---|---|
| **Layer 1 — Core** | Local-first MCP server, CLI (`devwf`), Task Contracts, SQLite WAL state, TDD/doc/commit gates, Code Audit Engine | **Yes (Included)** |
| **Layer 2 — AI Clients** | Claude Code, Codex, OpenCode, Antigravity, generic MCP stdio clients | **Choose yours** |
| **Layer 3 — Optional Integrations** | Per-user Zettly sync (`devwf zettly connect`), DevWorkflow Android Companion (`devwf pair`), Sentry linking, auto-resolution & P0 ERP Sentry preemption (`link_sentry_issue`, `complete_task`, `start_task`) | **Optional** |
| **Layer 4 — Team / Fleet** | Central Monitor dashboard, `devwf fleet doctor`, managed multi-device rollouts | **Optional** |

---

## Optional Integrations

### Optional Zettly Integration
Connect your own Zettly instance for Eisenhower prioritization, Focus tracking, and Engineering Retrospectives:

```bash
devwf zettly connect --url https://your-zettly-instance.example
devwf zettly status
devwf zettly disconnect --confirm
```

- Per-user credentials only (never stored in shell history; uses interactive prompt, `--token-stdin`, or `ZETTLY_API_TOKEN`).
- Disconnecting preserves all local SQLite history and leaves remote Todos untouched.

### Optional Android Companion
**DevWorkflow Android Companion** is an optional remote engineering cockpit for supported Android devices (adaptive layouts for phones and tablets; landscape desk cockpit tested on Xiaomi Pad 6). See [docs/integrations/android-companion.md](docs/integrations/android-companion.md).

---

## MCP Tools, CLI Commands & Engineering Standards

- **Live Reference & Tool Explorer:** [https://devworkflow.programinglive.com/](https://devworkflow.programinglive.com/)
- **CLI Subcommands & Scripting Contracts (`devwf --help`):**
  - Core & Optional Commands: `devwf setup`, `devwf doctor`, `devwf zettly`, `devwf pair`, `devwf governance`, `devwf audit`, `devwf fleet`, `devwf identity`, `devwf checkpoint`, `devwf list`, `devwf close`, `devwf share`, `devwf drop`, `devwf complete`.
  - Operational rules: `--session` is mandatory for mutating session commands; `--dry-run` prints planned changes without writing; **No process is ever signalled** by the CLI; **Exit code 0 means it really happened** (exit code 1 on refusal or failure). Monitor commands optionally use `DEVWF_MONITOR_URL` and `DEVWF_MONITOR_TOKEN`.
- **Cross-Machine Handoff Contracts:** `checkpoint_task`, `fetch_task`, `handoff_task`, and `acknowledge_handover` coordinate safe handoffs across workstations. A handoff requires an explicit `reason`, the returning machine must call `acknowledge_handover`, and reverts are recorded — **never executed automatically**.
- **Monitor Hygiene:** **Junk sessions are not recorded** — a monitor card requires **both** a task **and** a project (`monitor-server/cleanup-empty-sessions.cjs` cleans up legacy empty rows).
- **Optional Zettly Tags for Zettelkasten Relations:** When Zettly sync is enabled, tasks can be tagged across four axes (`proyek:`, `tipe:`, `area:`, `sumber:`) scoped **per owner**. The tag API returns top-level `{ tags }` / `deletedTags` and HTTP `409` when a tag already exists. Maintenance commands `zettly:backfill-tags --dry-run` and `zettly:normalise-tags` migrate legacy tags safely (legacy tags are **deleted only after every record** has been moved to the canonical axis tag).
- **Engineering Standards & Autofix:** DevWorkflow ships built-in standards (`ZET-ARCH`, `ZET-CODE`, `ZET-SEC`, `ZET-TEST`, `ZET-API`, `ZET-DB`, `ZET-DOC`, `ZET-REL`) plus canonical `audit` (`category: 'code'|'changes'|'repository'|'architecture'|'security'|'tests'|'api'|'database'|'standards'|'catalog'`), `analyze_change`, `plan_fix`, and `apply_safe_fix` (`AF-0`/`AF-1` deterministic fixes with snapshot rollback; protected governance paths are strictly blocked as `AF-3`).

---

## Privacy & Security

- `DEV_WORKFLOW_SECURITY_MODE=strict` is always enforced: raw credentials are rejected on write and redacted on output.
- Describe credential locations using `SecretReference` metadata (`env://VAR`, `op://...`, `vault://...`, `gcp-secret://...`) — DevWorkflow never reads or resolves your secrets.
- Audit your workspace anytime with `npm run security:audit` or MCP `security_audit`.
- See [docs/security-audit.md](docs/security-audit.md) and [docs/security-verification.md](docs/security-verification.md).

---

## Troubleshooting & Documentation

- [Installation Guide](docs/getting-started/installation.md) · [Setup Wizard](docs/getting-started/setup-wizard.md) · [First Governed Task](docs/getting-started/first-task.md)
- [Troubleshooting Installation](docs/troubleshooting/installation.md) · [Troubleshooting MCP Connections](docs/troubleshooting/mcp-connection.md) · [Troubleshooting Authentication](docs/troubleshooting/authentication.md)
- [Developer Portal & Full Docs](https://devworkflow.programinglive.com/docs/) · [Releases & Changelog](CHANGELOG.md)

---

## Contributing & License

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md).  
Licensed under the [MIT License](LICENSE).
