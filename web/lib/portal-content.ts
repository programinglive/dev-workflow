export interface PortalBlock {
  heading: string;
  body: string[];
  code?: string;
  table?: { headers: string[]; rows: string[][] };
}

export interface PortalSection {
  slug: string;
  title: string;
  summary: string;
  blocks: PortalBlock[];
}

export const PORTAL_SECTIONS: PortalSection[] = [
  {
    slug: "getting-started",
    title: "Getting Started",
    summary: "Install DevWorkflow, verify diagnostics, register an AI coding client, and start your first task.",
    blocks: [
      {
        heading: "1. What DevWorkflow Does",
        body: [
          "DevWorkflow is local-first engineering workflow infrastructure for AI coding agents. It persists task contracts, ordered execution plans, Definition of Done evidence, and session checkpoints in local SQLite WAL storage.",
          "For a hands-on walkthrough, follow the interactive 10-Step How to Use Guide (/how-to-use/) or explore 13 Real-World Use Cases (/use-cases/).",
        ],
      },
      {
        heading: "2. Runtime Requirements & Installation Modes",
        body: [
          "Requires Node.js >= 20.0.0. Install directly from npm (`@programinglive/dev-workflow`) for standalone local-first use, or clone from source for development:",
        ],
        code: `npm install -g @programinglive/dev-workflow
devwf setup
devwf doctor`,
        table: {
          headers: ["Mode", "Command", "When to Use"],
          rows: [
            ["Public npm registry (Recommended)", "npm install -g @programinglive/dev-workflow", "Install the published package globally with zero private GitHub access required"],
            ["Local-first init", "devwf setup", "Initialize LOCAL_FIRST_STANDALONE profile (preserves existing Zettly)"],
            ["Skip Zettly", "devwf setup --skip-zettly", "Explicitly skip Zettly on fresh install (never resets connected accounts)"],
            ["Environment diagnostics", "devwf doctor", "Verify Node.js, Git, SQLite storage, and optional integrations"],
            ["Source checkout", "git clone https://github.com/programinglive/dev-workflow.git && cd dev-workflow && npm ci", "Reproducible install from package-lock.json for contributors"],
          ],
        },
      },
      {
        heading: "2b. Optional Per-User Zettly Integration & Isolation",
        body: [
          "DevWorkflow requires no Zettly account, PocketBase, Tailscale, or external monitor. If you choose to connect your own Zettly account, credentials are stored per-user in ~/.devworkflow/ (or DEVWF_PROFILE_DIR) with zero shared owner defaults. Supply tokens securely via interactive hidden prompt, --token-stdin, or ZETTLY_API_TOKEN (raw --token CLI arguments are disabled).",
        ],
        code: `npx devwf zettly status --json
printf '%s' "$ZETTLY_API_TOKEN" | npx devwf zettly connect --url https://your-zettly.example --token-stdin
printf '%s' "$ZETTLY_NEW_TOKEN" | npx devwf zettly switch --url https://other-zettly.example --token-stdin --confirm
npx devwf zettly disconnect --confirm`,
      },
      {
        heading: "3. Register an AI Coding Client & Verify MCP Tools",
        body: [
          "Point your coding client's MCP stdio configuration to node /path/to/dev-workflow/index.js, then run devwf fleet doctor --json (with DEVWF_PUBLIC_LOCAL_FIRST=1 for local-first standalone checks) to verify client registration and stdio initialize/tools/list resolution.",
        ],
        code: `DEVWF_PUBLIC_LOCAL_FIRST=1 npx devwf fleet doctor --json`,
      },
      {
        heading: "4. Create and Inspect a Workflow Task",
        body: [
          "From your coding agent, invoke start_task with description, type, projectDir, plan, and definitionOfDone. Inspect progress at any time with get_workflow_status or check_ready_to_commit.",
        ],
      },
    ],
  },
  {
    slug: "cli",
    title: "CLI Reference",
    summary: "Complete reference for the devwf CLI, flags, exit codes, and JSON output contracts.",
    blocks: [
      {
        heading: "CLI-First Contract",
        body: [
          "Every operational workflow capability is exposed through the devwf CLI (bin/cli.js, cli/args.js, cli/commands.js) before or alongside web/mobile UIs.",
          "Exit codes: 0 on success, 1 on refusal, validation failure, or runtime error.",
        ],
        table: {
          headers: ["Command", "Purpose", "Key Flags"],
          rows: [
            ["devwf doctor", "Verify Node.js, security mode, SQLite storage, and local-first execution", "--json"],
            ["devwf setup", "Initialize local-first profile while preserving any existing Zettly connection", "--skip-zettly, --dry-run, --json"],
            ["devwf zettly status|skip|connect|switch|disconnect|doctor", "Manage optional per-user Zettly integration without affecting local history", "--url <url>, --token-stdin, --confirm, --json"],
            ["devwf pair", "Generate pairing challenge for the optional Android Companion", "--url <url>, --json"],
            ["devwf fleet doctor", "Inspect MCP client configs and stdio health", "--json"],
            ["devwf fleet status", "Inspect machine convergence and toolCatalogDigest", "--json"],
            ["devwf fleet upgrade", "Stage or apply controlled runtime upgrades", "--all, --resume, --dry-run, --authorize, --json"],
            ["devwf list", "List sessions from configured monitor", "--json"],
            ["devwf close", "Mark one explicit session closed", "--session <key>, --dry-run"],
            ["devwf drop", "Drop a task with an explicit reason", "--session <key>, --reason <r>, --dry-run"],
            ["devwf complete", "Complete a task whose DoD is proven", "--session <key>, --next-steps <s>, --dry-run"],
            ["devwf share list|revoke", "List or revoke read-only share links", "--token <t>, --orphans, --dry-run"],
          ],
        },
      },
    ],
  },
  {
    slug: "mcp",
    title: "MCP Reference",
    summary: "Canonical runtime reference for MCP tools, prompts, and safety boundaries.",
    blocks: [
      {
        heading: "Runtime Transport & Discovery",
        body: [
          "DevWorkflow exposes its MCP server over stdio (node index.js). All tool names, descriptions, and input schemas below are generated directly from tools/definitions.js getToolList().",
          "Prompts exposed over MCP: workflow_reminder and pre_commit_checklist. Resources are not currently exposed as separate MCP resource URIs.",
        ],
      },
    ],
  },
  {
    slug: "configuration",
    title: "Configuration & Client Guides",
    summary: "Setup instructions for OpenCode, Codex, Antigravity IDE, Antigravity CLI, and environment variables.",
    blocks: [
      {
        heading: "Environment Variables",
        body: [
          "Local-first execution works out of the box with zero external services. Optional variables enable Central Monitor, Zettly sync, or Sentry integration.",
        ],
        table: {
          headers: ["Variable", "Required", "Purpose"],
          rows: [
            ["WORKFLOW_PROJECT_DIR", "No", "Fallback project directory when session cwd is not a git repo"],
            ["DEVWF_PUBLIC_LOCAL_FIRST", "No", "Set to 1 to force local-first standalone mode in fleet checks"],
            ["DEVWF_MONITOR_URL", "Optional", "Base URL for optional Central Monitor API / devwf monitor commands"],
            ["DEVWF_MONITOR_TOKEN", "Optional", "Bearer write token when pushing state to Central Monitor"],
            ["DEVWF_SECURITY_MODE", "No", "Defaults to strict (blocks unsafe secret persistence)"],
          ],
        },
      },
      {
        heading: "OpenCode (~/.config/opencode/opencode.json)",
        body: ["Register dev-workflow as a local stdio MCP server pointing to your clone's index.js:"],
        code: `{
  "mcp": {
    "dev-workflow": {
      "type": "local",
      "command": ["node", "<PATH_TO_REPO>/index.js"],
      "enabled": true
    }
  }
}`,
      },
      {
        heading: "Codex (~/.codex/config.toml)",
        body: ["Add an mcp_servers.dev-workflow entry to Codex config.toml:"],
        code: `[mcp_servers.dev-workflow]
command = "node"
args = ["<PATH_TO_REPO>/index.js"]`,
      },
      {
        heading: "Antigravity IDE & Antigravity CLI",
        body: [
          "Configure mcpServers.dev-workflow in your Antigravity mcp_config.json (IDE or CLI config directory). Never commit or share non-empty user tokens; verify with devwf fleet doctor --json.",
        ],
        code: `{
  "mcpServers": {
    "dev-workflow": {
      "command": "node",
      "args": ["<PATH_TO_REPO>/index.js"]
    }
  }
}`,
      },
    ],
  },
  {
    slug: "architecture",
    title: "Architecture",
    summary: "Required core modules vs optional integrations across CLI, MCP, SQLite, Monitor, and Companion.",
    blocks: [
      {
        heading: "Required Core vs Optional Components",
        body: [
          "DevWorkflow Core runs completely locally with Node.js + SQLite WAL. Optional extensions layer on top without creating hard runtime dependencies.",
        ],
        table: {
          headers: ["Component", "Classification", "Responsibility"],
          rows: [
            ["DevWorkflow Core (workflow-state.js, tools/)", "Required", "Task contracts, plan tracking, DoD gates, security redaction"],
            ["devwf CLI (bin/cli.js, cli/)", "Required", "Headless CLI interface for diagnostics, session ops, and fleet control"],
            ["SQLite WAL Store (db/adapters/sqlite.js)", "Required", "Local-first transactional persistence (.state/workflow.db)"],
            ["MCP Stdio Server (index.js)", "Required", "JSON-RPC stdio bridge for AI coding agents"],
            ["Monitor Server (monitor-server/)", "Optional", "Multi-session dashboard, share links, and fleet parity view"],
            ["Zettly / Sentry Integrations", "Optional", "Human planning Todo sync and Sentry issue linking"],
            ["Android Companion (mobile-app/)", "Optional", "Read-heavy cockpit and pairing client for tablet monitoring"],
          ],
        },
      },
    ],
  },
  {
    slug: "task-contracts",
    title: "Task Contracts",
    summary: "Initialization, lifecycle states, evidence collection, checkpoints, and completion gates.",
    blocks: [
      {
        heading: "Lifecycle & Mandatory Gates",
        body: [
          "1. start_task: Initializes a task with description, type, projectDir, ordered plan, Definition of Done items, and a Mermaid flowchart.",
          "2. Execution: Agents mark plan steps (mark_plan_step) and prove each DoD item with observed command/test evidence (mark_dod_item).",
          "3. Verification & Release: check_ready_to_commit verifies clean DoD + tests + docs before commit_and_push and complete_task.",
          "4. Continuity: checkpoint_task, handoff_task, and resume_session preserve durable state across machine or context switches.",
        ],
      },
    ],
  },
  {
    slug: "storage",
    title: "Storage & Migrations",
    summary: "Local-first SQLite WAL persistence, schema migrations, and optional relational adapters.",
    blocks: [
      {
        heading: "SQLite WAL Primary Engine",
        body: [
          "SQLite with Write-Ahead Logging (better-sqlite3) is the default and only required database engine. State lives locally inside the project's .state/ directory.",
          "Schema migrations in db/migrations/ run automatically on startup and are validated by security regression tests so secret values are rejected before persistence.",
          "PostgreSQL and MySQL adapters exist strictly as optional remote-store adapters and are never required for OSS or local usage.",
        ],
      },
    ],
  },
  {
    slug: "fleet",
    title: "Fleet Diagnostics & Upgrades",
    summary: "Inspect client registrations, monitor version convergence, and run safe dry-run upgrades.",
    blocks: [
      {
        heading: "Fleet Doctor & Status",
        body: [
          "devwf fleet doctor checks local client configurations (OpenCode, Codex, Antigravity IDE, Antigravity CLI) and verifies stdio initialize resolution.",
          "devwf fleet status reports convergence state (CONVERGED, STAGED, CLIENT_REFRESH_REQUIRED, VERSION_MISMATCH) without restarting active AI sessions.",
        ],
        code: `DEVWF_PUBLIC_LOCAL_FIRST=1 npx devwf fleet status --json
DEVWF_PUBLIC_LOCAL_FIRST=1 npx devwf fleet upgrade --all --resume --dry-run --json`,
      },
    ],
  },
  {
    slug: "monitor",
    title: "Monitor & Companion",
    summary: "Optional web monitor, read-only share links, and Android Companion pairing.",
    blocks: [
      {
        heading: "Optional Central / Local Monitor",
        body: [
          "monitor-server/ provides an optional web UI and HTTP API for viewing active agent sessions, task plans, and fleet parity across devices.",
          "The static website (web/out) does not bundle monitor credentials or connect to private monitor servers; local CLI commands (devwf list, devwf share) talk to DEVWF_MONITOR_URL only when explicitly configured.",
        ],
      },
    ],
  },
  {
    slug: "security",
    title: "Security & Privacy Boundaries",
    summary: "Strict secret rejection, sanitized persistence, production safeguards, and disclosure.",
    blocks: [
      {
        heading: "Built-In Security Controls",
        body: [
          "Strict security mode scans tool inputs and persistence payloads before writing to SQLite or JSON state, rejecting raw credentials and tokens.",
          "Production database writes require verified backups, and release locks prevent concurrent unverified deployments.",
          "Public OSS builds exclude private infrastructure topology, local workstation paths, and internal rollout credentials, enforced by tests/security*.test.js.",
        ],
      },
    ],
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    summary: "Diagnosing empty MCP configs, unregistered clients, SQLite locks, and role/permission incidents.",
    blocks: [
      {
        heading: "Common Diagnostics",
        body: [
          "Empty or zero-byte MCP config: Run devwf fleet doctor --json to detect malformed or empty mcp_config.json files and restore valid JSON pointing to node <REPO>/index.js.",
          "Missing tools in agent session: Reconnect the MCP server in the client after runtime updates; inspect server stderr for Node >= 20 or dependency errors.",
          "SQLite initialization errors: Ensure write permissions in the repository's .state/ directory and run devwf doctor.",
          "Role/permission eligibility mismatches (generalized pattern): When an active user is missing from a downstream selector, verify account status (active vs soft-deleted), assigned roles, duplicate soft-deleted records, and permission-cache freshness before mutating roles or downstream records.",
        ],
      },
    ],
  },
  {
    slug: "contributing",
    title: "Contributing & Release Governance",
    summary: "Clean-history OSS workflow, TDD discipline, test suites, and pull request requirements.",
    blocks: [
      {
        heading: "Development & PR Standards",
        body: [
          "DevWorkflow follows Conventional Commits, strict TDD, and branch isolation. Every change must pass npm run lint, npm run test:security, and npm test before opening a PR.",
          "OSS baseline tags (v*-oss*) are intentionally isolated from npm and Android APK release workflows.",
        ],
        code: `npm run lint
npm run test:security
npm test
npm run build --prefix web`,
      },
    ],
  },
];

export function getPortalSection(slug: string): PortalSection | undefined {
  return PORTAL_SECTIONS.find((s) => s.slug === slug);
}
