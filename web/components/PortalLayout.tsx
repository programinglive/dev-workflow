import Link from "next/link";
import { PORTAL_SECTIONS } from "@/lib/portal-content";

interface PortalLayoutProps {
  currentSlug: string;
  children: React.ReactNode;
}

export default function PortalLayout({ currentSlug, children }: PortalLayoutProps) {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
      <div className="lg:grid lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-10">
        {/* Sidebar (desktop) + compact jump bar (mobile/tablet) */}
        <aside className="mb-8 lg:mb-0">
          <div className="lg:sticky lg:top-20 space-y-3">
            <div className="text-xs font-mono uppercase tracking-wider text-slate-500">Developer Portal</div>
            <nav aria-label="Developer Portal navigation" className="flex lg:flex-col gap-1 overflow-x-auto pb-2 lg:pb-0">
              {PORTAL_SECTIONS.map((sec) => {
                const active = sec.slug === currentSlug;
                return (
                  <Link
                    key={sec.slug}
                    href={`/developers/${sec.slug}/`}
                    className={`px-2.5 py-1.5 rounded text-sm whitespace-nowrap transition-colors ${
                      active
                        ? "bg-blue-50 text-blue-700 font-medium border border-blue-200"
                        : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                    }`}
                  >
                    {sec.title}
                  </Link>
                );
              })}
            </nav>
          </div>
        </aside>

        <main className="min-w-0 space-y-8">{children}</main>
      </div>
    </div>
  );
}
