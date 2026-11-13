import Link from "next/link";
import { GENERATED_CATALOG } from "@/lib/catalog.generated";
import { WEB_VERSION } from "@/lib/version";

const CAPABILITIES = [
  {
    title: "Local-first state",
    description:
      "Task contracts, checkpoints, and workflow history persist in local SQLite WAL databases with zero mandatory cloud database dependency.",
    href: "/developers/storage/",
  },
  {
    title: "CLI + MCP",
    description: `${GENERATED_CATALOG.cli.commands.length} deterministic devwf CLI commands and ${GENERATED_CATALOG.mcpToolCount} MCP stdio tools share one headless domain core.`,
    href: "/developers/mcp/",
  },
  {
    title: "Task Contracts",
    description:
      "Every task tracks ordered plan steps, Definition of Done criteria, and architectural flow diagrams before code changes are committed.",
    href: "/developers/task-contracts/",
  },
  {
    title: "Evidence and release governance",
    description:
      "Completion gates verify test execution, security checks, clean working trees, and release locks before version bumps or pushes.",
    href: "/developers/security/",
  },
  {
    title: "Fleet diagnostics and upgrades",
    description:
      "Inspect client MCP registrations with devwf fleet doctor, verify runtime parity with fleet status, and stage controlled upgrades.",
    href: "/developers/fleet/",
  },
];

export default function Home() {
  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-12 sm:py-16 space-y-16">
      {/* Hero */}
      <section className="max-w-3xl space-y-5">
        <div className="inline-flex flex-wrap items-center gap-2 text-xs font-mono text-slate-600">
          <span className="px-2 py-0.5 rounded border border-slate-200 bg-slate-50">
            Runtime v{WEB_VERSION}
          </span>
          <span className="px-2 py-0.5 rounded border border-slate-200 bg-slate-50">
            Baseline {GENERATED_CATALOG.ossBaselineTag}
          </span>
          <span className="px-2 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-800">
            Repo: {GENERATED_CATALOG.repositoryVisibility} (npm public release pending)
          </span>
        </div>

        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
          Engineering workflow infrastructure for AI coding agents.
        </h1>

        <p className="text-base sm:text-lg text-slate-600 leading-relaxed">
          Local-first task state, evidence-driven workflows, and release checks for developers working across coding
          agents and machines.
        </p>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Link
            href="/docs/"
            className="inline-flex items-center px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            Documentation
          </Link>
          <Link
            href="/developers/getting-started/"
            className="inline-flex items-center px-4 py-2 rounded-md border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50 transition-colors"
          >
            Developer Guide
          </Link>
          <a
            href={GENERATED_CATALOG.repositoryUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center px-3 py-2 text-sm text-slate-600 hover:text-slate-900 underline underline-offset-4"
          >
            GitHub ({GENERATED_CATALOG.repositoryVisibility} access required)
          </a>
        </div>
      </section>

      {/* Quick Start */}
      <section className="border border-slate-200 rounded-lg bg-slate-50 p-5 sm:p-6 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900">Quick Start</h2>
          <span className="text-xs font-mono text-slate-500">
            Node.js {GENERATED_CATALOG.nodeEngine} · Source checkout ({GENERATED_CATALOG.repositoryVisibility})
          </span>
        </div>
        <p className="text-sm text-slate-600">
          Public npm publication is not yet active for{" "}
          <code className="text-xs bg-white border border-slate-200 px-1.5 py-0.5 rounded">
            {GENERATED_CATALOG.packageName}
          </code>
          . Clone the repository with authorized access and verify your local runtime:
        </p>
        <pre className="p-4 rounded-md bg-slate-900 text-slate-100 text-xs sm:text-sm leading-relaxed overflow-x-auto">
          <code>{`git clone ${GENERATED_CATALOG.repositoryUrl}.git
cd dev-workflow-mcp-server
npm ci
npx devwf doctor`}</code>
        </pre>
      </section>

      {/* Core Capabilities */}
      <section className="space-y-5">
        <div className="flex items-baseline justify-between border-b border-slate-200 pb-3">
          <h2 className="text-lg font-semibold text-slate-900">Core Capabilities</h2>
          <Link href="/developers/" className="text-sm text-blue-600 hover:underline">
            Explore Developer Portal →
          </Link>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {CAPABILITIES.map((cap) => (
            <Link
              key={cap.title}
              href={cap.href}
              className="block p-4 rounded-lg border border-slate-200 bg-white hover:border-blue-300 transition-colors space-y-1.5"
            >
              <h3 className="text-sm font-semibold text-slate-900">{cap.title}</h3>
              <p className="text-sm text-slate-600 leading-relaxed">{cap.description}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* Architecture */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-900">System Architecture</h2>
          <p className="text-sm text-slate-600 leading-relaxed">
            DevWorkflow separates local core execution from optional coordination services. Coding agents connect over
            MCP stdio or the <code className="text-xs font-mono">devwf</code> CLI, backed by SQLite WAL state on the
            developer workstation.
          </p>
          <p className="text-sm text-slate-600 leading-relaxed">
            Optional integrations—Central Monitor, Zettly planning sync, Sentry issue linking, Fleet updates, and the
            Android Companion—attach without turning local-first development into a cloud dependency.
          </p>
          <Link href="/developers/architecture/" className="inline-block text-sm text-blue-600 hover:underline">
            Read Architecture Guide →
          </Link>
        </div>
        <pre className="p-4 rounded-lg border border-slate-200 bg-slate-50 text-slate-800 text-xs sm:text-sm leading-relaxed overflow-x-auto">
          <code>{`Coding Agents (OpenCode, Codex, Antigravity IDE / CLI)
    |
CLI (devwf) / MCP stdio (index.js)
    |
DevWorkflow Core (Task Contracts, Evidence, Release Gates)
    |
SQLite WAL Local State

Optional Extensions:
Monitor | Zettly | Sentry | Fleet | Android Companion`}</code>
        </pre>
      </section>
    </main>
  );
}
