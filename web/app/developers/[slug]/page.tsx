import { notFound } from "next/navigation";
import Link from "next/link";
import PortalLayout from "@/components/PortalLayout";
import McpCatalogBrowser from "@/components/McpCatalogBrowser";
import { PORTAL_SECTIONS, getPortalSection } from "@/lib/portal-content";
import { GENERATED_CATALOG } from "@/lib/catalog.generated";

export function generateStaticParams() {
  return PORTAL_SECTIONS.map((s) => ({ slug: s.slug }));
}

export default async function DeveloperSectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const section = getPortalSection(slug);
  if (!section) notFound();

  const idx = PORTAL_SECTIONS.findIndex((s) => s.slug === slug);
  const prev = idx > 0 ? PORTAL_SECTIONS[idx - 1] : null;
  const next = idx < PORTAL_SECTIONS.length - 1 ? PORTAL_SECTIONS[idx + 1] : null;

  return (
    <PortalLayout currentSlug={section.slug}>
      <header className="space-y-2 border-b border-slate-200 pb-5">
        <div className="text-xs font-mono text-slate-500">
          Developers / {section.slug} · v{GENERATED_CATALOG.version}
        </div>
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-slate-900">{section.title}</h1>
        <p className="text-base text-slate-600">{section.summary}</p>
      </header>

      <div className="space-y-8">
        {section.blocks.map((block) => (
          <section key={block.heading} className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">{block.heading}</h2>
            {block.body.map((p, i) => (
              <p key={i} className="text-sm sm:text-base text-slate-700 leading-relaxed">
                {p}
              </p>
            ))}
            {block.code && (
              <pre className="p-4 rounded-lg bg-slate-900 text-slate-100 text-xs sm:text-sm leading-relaxed overflow-x-auto">
                <code>{block.code}</code>
              </pre>
            )}
            {block.table && (
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left text-sm border-collapse">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-700">
                    <tr>
                      {block.table.headers.map((h) => (
                        <th key={h} className="py-2.5 px-3 font-semibold">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {block.table.rows.map((row, rIdx) => (
                      <tr key={rIdx}>
                        {row.map((cell, cIdx) => (
                          <td
                            key={cIdx}
                            className={`py-2.5 px-3 ${
                              cIdx === 0 ? "font-mono text-xs font-medium text-slate-900 whitespace-nowrap" : "text-slate-600"
                            }`}
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}

        {section.slug === "cli" && (
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-slate-900">Generated CLI Usage (cli/args.js)</h2>
            <p className="text-sm text-slate-600">
              Registered top-level commands:{" "}
              <code className="text-xs font-mono">{GENERATED_CATALOG.cli.commands.join(", ")}</code> · Fleet verbs:{" "}
              <code className="text-xs font-mono">{GENERATED_CATALOG.cli.fleetVerbs.join(", ")}</code>.
            </p>
            <pre className="p-4 rounded-lg bg-slate-900 text-slate-100 text-xs leading-relaxed overflow-x-auto">
              <code>{GENERATED_CATALOG.cli.usage}</code>
            </pre>
          </section>
        )}

        {section.slug === "mcp" && <McpCatalogBrowser />}
      </div>

      <nav
        aria-label="Section pagination"
        className="pt-6 border-t border-slate-200 flex items-center justify-between gap-4 text-sm"
      >
        {prev ? (
          <Link href={`/developers/${prev.slug}/`} className="text-blue-600 hover:underline">
            ← {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link href={`/developers/${next.slug}/`} className="text-blue-600 hover:underline">
            {next.title} →
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </PortalLayout>
  );
}
