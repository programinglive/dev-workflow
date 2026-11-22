import type { Metadata } from "next";
import Link from "next/link";
import UseCasesCatalog from "@/components/UseCasesCatalog";
import { USE_CASES_DATA } from "@/lib/use-cases-data";
import { WEB_VERSION } from "@/lib/version";

export const metadata: Metadata = {
  title: `Use Cases & Real-World Tutorials — DevWorkflow v${WEB_VERSION}`,
  description:
    "Real-world developer workflow tutorials for solo coding, bugfixes, legacy refactoring, security audits, and multi-agent collaboration with DevWorkflow.",
};

export default function UseCasesIndexPage() {
  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-10 sm:py-14 space-y-12">
      {/* Header */}
      <header className="space-y-4 border-b border-slate-200 pb-8">
        <div className="inline-flex flex-wrap items-center gap-2 text-xs font-mono text-slate-600">
          <span className="px-2 py-0.5 rounded border border-slate-200 bg-slate-50">
            v{WEB_VERSION}
          </span>
          <span className="px-2 py-0.5 rounded border border-blue-200 bg-blue-50 text-blue-800 font-medium">
            {USE_CASES_DATA.length} Real-World Tutorials
          </span>
          <span className="px-2 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-800">
            Beginner to Advanced
          </span>
        </div>

        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
          DevWorkflow Use Cases &amp; Tutorials
        </h1>

        <p className="text-base sm:text-lg text-slate-600 leading-relaxed max-w-3xl">
          Practical, step-by-step developer tutorials demonstrating how to apply DevWorkflow to everyday software
          engineering challenges. From solo feature building and bug fixing to security scanning and multi-agent
          worktrees.
        </p>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Link
            href="/how-to-use/"
            className="inline-flex items-center px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            ← 10-Step How to Use Guide
          </Link>
          <Link
            href="/docs/"
            className="inline-flex items-center px-4 py-2 rounded-md border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50 transition-colors"
          >
            Technical Docs
          </Link>
        </div>
      </header>

      {/* Interactive Catalog Component */}
      <UseCasesCatalog />
    </main>
  );
}
