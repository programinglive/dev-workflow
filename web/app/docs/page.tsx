import Link from "next/link";
import { PORTAL_SECTIONS } from "@/lib/portal-content";
import { GENERATED_CATALOG } from "@/lib/catalog.generated";
import { WEB_VERSION } from "@/lib/version";

export default function DocsHubPage() {
  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-12 space-y-10">
      <header className="space-y-3 border-b border-slate-200 pb-6">
        <div className="text-xs font-mono text-slate-500">
          Documentation · v{WEB_VERSION} · {GENERATED_CATALOG.mcpToolCount} MCP Tools ·{" "}
          {GENERATED_CATALOG.cli.commands.length} CLI Commands
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">DevWorkflow Documentation</h1>
        <p className="text-base text-slate-600 max-w-2xl">
          Authoritative technical guides and runtime references generated directly from the DevWorkflow source tree.
        </p>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {PORTAL_SECTIONS.map((section) => (
          <Link
            key={section.slug}
            href={`/developers/${section.slug}/`}
            className="block p-5 rounded-lg border border-slate-200 bg-white hover:border-blue-300 transition-colors space-y-1.5"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">{section.title}</h2>
              <span className="text-xs font-mono text-slate-400">/developers/{section.slug}/</span>
            </div>
            <p className="text-sm text-slate-600">{section.summary}</p>
          </Link>
        ))}
      </section>

      <section className="p-5 rounded-lg border border-slate-200 bg-slate-50 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-slate-900">Version & Release Policy</h2>
          <p className="text-sm text-slate-600">
            Review how runtime versions ({WEB_VERSION}), OSS source baselines ({GENERATED_CATALOG.ossBaselineTag}), and
            package distribution are separated.
          </p>
        </div>
        <Link
          href="/releases/"
          className="px-4 py-2 rounded-md border border-slate-300 bg-white text-sm font-medium text-slate-800 hover:bg-slate-100 whitespace-nowrap"
        >
          View Releases
        </Link>
      </section>
    </main>
  );
}
