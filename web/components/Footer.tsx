import Link from "next/link";
import { WEB_VERSION } from "@/lib/version";
import { GENERATED_CATALOG } from "@/lib/catalog.generated";

export default function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-slate-50 text-slate-600">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs">
        <div className="space-y-1">
          <p className="font-medium text-slate-800">
            DevWorkflow MCP Server · v{WEB_VERSION} ({GENERATED_CATALOG.ossBaselineTag})
          </p>
          <p>
            Local-first engineering workflow infrastructure · {GENERATED_CATALOG.license} License · Repository:{" "}
            {GENERATED_CATALOG.repositoryVisibility}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Link href="/docs/" className="hover:text-slate-900">
            Docs
          </Link>
          <Link href="/developers/cli/" className="hover:text-slate-900">
            CLI
          </Link>
          <Link href="/developers/mcp/" className="hover:text-slate-900">
            MCP ({GENERATED_CATALOG.mcpToolCount} tools)
          </Link>
          <Link href="/releases/" className="hover:text-slate-900">
            Releases
          </Link>
          <Link href="/developers/security/" className="hover:text-slate-900">
            Security
          </Link>
        </div>
      </div>
    </footer>
  );
}
