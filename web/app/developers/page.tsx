import Link from "next/link";
import PortalLayout from "@/components/PortalLayout";
import { PORTAL_SECTIONS } from "@/lib/portal-content";
import { GENERATED_CATALOG } from "@/lib/catalog.generated";

export default function DevelopersIndexPage() {
  return (
    <PortalLayout currentSlug="">
      <header className="space-y-3 border-b border-slate-200 pb-6">
        <div className="text-xs font-mono text-slate-500">
          Developer Portal · v{GENERATED_CATALOG.version}
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Developer Portal</h1>
        <p className="text-base text-slate-600 max-w-2xl">
          Implementation-accurate guides for installing DevWorkflow, configuring AI coding clients, running CLI
          commands, and invoking all {GENERATED_CATALOG.mcpToolCount} MCP tools.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {PORTAL_SECTIONS.map((sec) => (
          <Link
            key={sec.slug}
            href={`/developers/${sec.slug}/`}
            className="block p-4 rounded-lg border border-slate-200 bg-white hover:border-blue-300 transition-colors space-y-1"
          >
            <h2 className="text-sm font-semibold text-slate-900">{sec.title}</h2>
            <p className="text-sm text-slate-600">{sec.summary}</p>
          </Link>
        ))}
      </div>
    </PortalLayout>
  );
}
