import Link from "next/link";
import { GENERATED_CATALOG } from "@/lib/catalog.generated";
import { WEB_VERSION } from "@/lib/version";

export default function ReleasesPage() {
  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-12 space-y-10">
      <header className="space-y-3 border-b border-slate-200 pb-6">
        <div className="text-xs font-mono text-slate-500">Release Governance & Version Policy</div>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Releases & Channels</h1>
        <p className="text-base text-slate-600 max-w-2xl">
          DevWorkflow separates source-code baselines, runtime package versions, npm publication, and Android Companion
          APK builds so a Git tag never misrepresents what has been published.
        </p>
      </header>

      <section className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-left text-sm border-collapse">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-700">
            <tr>
              <th className="py-3 px-4 font-semibold">Artifact / Channel</th>
              <th className="py-3 px-4 font-semibold">Current Identifier</th>
              <th className="py-3 px-4 font-semibold">Status</th>
              <th className="py-3 px-4 font-semibold">Trigger Contract</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 bg-white">
            <tr>
              <td className="py-3 px-4 font-medium text-slate-900">DevWorkflow Core Runtime</td>
              <td className="py-3 px-4 font-mono text-xs">v{WEB_VERSION}</td>
              <td className="py-3 px-4">
                <span className="px-2 py-0.5 rounded text-xs font-mono bg-emerald-50 text-emerald-800 border border-emerald-200">
                  ACTIVE_SOURCE_VERSION
                </span>
              </td>
              <td className="py-3 px-4 text-slate-600">
                Driven by root <code className="text-xs font-mono">package.json</code>
              </td>
            </tr>
            <tr>
              <td className="py-3 px-4 font-medium text-slate-900">OSS Clean-History Baseline</td>
              <td className="py-3 px-4 font-mono text-xs">{GENERATED_CATALOG.ossBaselineTag}</td>
              <td className="py-3 px-4">
                <span className="px-2 py-0.5 rounded text-xs font-mono bg-blue-50 text-blue-800 border border-blue-200">
                  OSS_SOURCE_BASELINE ({GENERATED_CATALOG.repositoryVisibility})
                </span>
              </td>
              <td className="py-3 px-4 text-slate-600">
                Git baseline tag only; excluded from <code className="text-xs font-mono">github-release.yml</code> &{" "}
                <code className="text-xs font-mono">android-release.yml</code>
              </td>
            </tr>
            <tr>
              <td className="py-3 px-4 font-medium text-slate-900">Public npm Registry</td>
              <td className="py-3 px-4 font-mono text-xs">{GENERATED_CATALOG.packageName}@{WEB_VERSION}</td>
              <td className="py-3 px-4">
                <span className="px-2 py-0.5 rounded text-xs font-mono bg-emerald-50 text-emerald-800 border border-emerald-200">
                  PUBLISHED_OIDC_PROVENANCE
                </span>
              </td>
              <td className="py-3 px-4 text-slate-600">
                Automated via GitHub Actions OIDC Trusted Publisher on tag <code className="text-xs font-mono">vX.Y.Z</code>
              </td>
            </tr>
            <tr>
              <td className="py-3 px-4 font-medium text-slate-900">Android Companion APK</td>
              <td className="py-3 px-4 font-mono text-xs">mobile-app v1.0.0</td>
              <td className="py-3 px-4">
                <span className="px-2 py-0.5 rounded text-xs font-mono bg-slate-100 text-slate-700 border border-slate-200">
                  NOT_LIVE_VERIFIED (workflow & 44 tests pass)
                </span>
              </td>
              <td className="py-3 px-4 text-slate-600">
                Dedicated tags <code className="text-xs font-mono">mobile-v*</code> /{" "}
                <code className="text-xs font-mono">android-v*</code> or{" "}
                <code className="text-xs font-mono">workflow_dispatch</code>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-900">Recent Changelog Versions</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          {GENERATED_CATALOG.changelogEntries.map((entry) => (
            <div key={entry.version} className="p-4 rounded-lg border border-slate-200 bg-white space-y-1">
              <div className="font-mono text-sm font-semibold text-slate-900">{entry.version}</div>
              <div className="text-xs text-slate-500">{entry.date || "Recorded in CHANGELOG.md"}</div>
            </div>
          ))}
        </div>
        <p className="text-sm text-slate-600">
          See{" "}
          <Link href="/developers/contributing/" className="text-blue-600 hover:underline">
            Contributing & Release Governance
          </Link>{" "}
          for how release locks and <code className="text-xs font-mono">perform_release</code> prevent unverified
          publications.
        </p>
      </section>
    </main>
  );
}
