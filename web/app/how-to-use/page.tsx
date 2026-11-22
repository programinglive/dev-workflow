import type { Metadata } from "next";
import Link from "next/link";
import CodeBlock from "@/components/CodeBlock";
import {
  HOW_TO_USE_STEPS,
  ROLE_COMPARISON_TABLE,
  OPTIONAL_INTEGRATIONS_DATA,
  ZETTLY_CODE_DEBUGGING_JOURNEY,
} from "@/lib/how-to-use-data";
import { GENERATED_CATALOG } from "@/lib/catalog.generated";
import { WEB_VERSION } from "@/lib/version";

export const metadata: Metadata = {
  title: `How to Use DevWorkflow v${WEB_VERSION} — 10-Step Practical User Guide`,
  description:
    "End-to-end practical onboarding journey from npm installation through MCP tool discovery to task completion and engineering audits. 100% standalone and local-first.",
};

export default function HowToUsePage() {
  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-10 sm:py-14 space-y-16">
      {/* Header / Hero */}
      <header className="space-y-4 border-b border-slate-200 pb-8">
        <div className="inline-flex flex-wrap items-center gap-2 text-xs font-mono text-slate-600">
          <span className="px-2 py-0.5 rounded border border-slate-200 bg-slate-50">
            v{WEB_VERSION}
          </span>
          <span className="px-2 py-0.5 rounded border border-blue-200 bg-blue-50 text-blue-800 font-medium">
            10-Step Practical Guide
          </span>
          <span className="px-2 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-800">
            100% Local-First Standalone
          </span>
          <span className="px-2 py-0.5 rounded border border-slate-200 bg-slate-50 text-slate-600">
            Zero Cloud Dependency
          </span>
        </div>

        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
          How to Use DevWorkflow
        </h1>

        <p className="text-base sm:text-lg text-slate-600 leading-relaxed max-w-3xl">
          An end-to-end practical guide for developers connecting AI coding assistants (Claude Code, OpenCode, Codex, or
          Antigravity) to DevWorkflow. Follow this 10-step journey from global npm installation to verified task
          completion.
        </p>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <a
            href="#steps"
            className="inline-flex items-center px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            Start the 10-Step Journey ↓
          </a>
          <Link
            href="/use-cases/"
            className="inline-flex items-center px-4 py-2 rounded-md border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50 transition-colors"
          >
            View Real-World Use Cases →
          </Link>
          <a
            href="#role-breakdown"
            className="inline-flex items-center px-3 py-2 text-sm text-slate-600 hover:text-slate-900 underline underline-offset-4"
          >
            CLI vs MCP vs Agent Roles
          </a>
        </div>
      </header>

      {/* Quick Jump Bar */}
      <section className="p-4 rounded-lg border border-slate-200 bg-slate-50 space-y-2">
        <div className="text-xs font-mono uppercase tracking-wider text-slate-500 font-semibold">
          Step-by-Step Overview
        </div>
        <div className="flex flex-wrap gap-1.5 sm:gap-2">
          {HOW_TO_USE_STEPS.map((s) => (
            <a
              key={s.slug}
              href={`#${s.slug}`}
              className="px-2.5 py-1 rounded border border-slate-200 bg-white text-xs font-mono text-slate-700 hover:text-blue-600 hover:border-blue-300 transition-colors whitespace-nowrap"
            >
              {s.shortTitle}
            </a>
          ))}
          <a
            href="#optional-integrations"
            className="px-2.5 py-1 rounded border border-purple-200 bg-purple-50 text-xs font-mono text-purple-700 hover:bg-purple-100 transition-colors whitespace-nowrap"
          >
            Optional Integrations
          </a>
        </div>
      </section>

      {/* 10-Step Journey */}
      <section id="steps" className="space-y-12">
        <div className="border-b border-slate-200 pb-3">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
            The 10-Step Onboarding Journey
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Every step includes validated commands, expected output, and actor responsibilities.
          </p>
        </div>

        <div className="space-y-10">
          {HOW_TO_USE_STEPS.map((step) => (
            <article
              key={step.slug}
              id={step.slug}
              className="scroll-mt-20 p-5 sm:p-6 rounded-xl border border-slate-200 bg-white shadow-sm space-y-4 hover:border-slate-300 transition-colors"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 pb-3">
                <h3 className="text-lg sm:text-xl font-semibold text-slate-900">
                  {step.title}
                </h3>
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                  Actor: {step.actor}
                </span>
              </div>

              <div className="space-y-2 text-sm text-slate-600 leading-relaxed">
                {step.explanation.map((para, idx) => (
                  <p key={idx}>{para}</p>
                ))}
              </div>

              {step.command && (
                <div className="space-y-2 pt-1">
                  <div className="text-xs font-mono text-slate-500 uppercase tracking-wider">
                    Terminal Command
                  </div>
                  <CodeBlock code={step.command} language="bash" title="Terminal Execution" />
                </div>
              )}

              {step.expectedOutput && (
                <div className="space-y-2">
                  <div className="text-xs font-mono text-slate-500 uppercase tracking-wider">
                    Expected Terminal Output
                  </div>
                  <pre className="p-3.5 rounded-lg bg-slate-950 text-slate-200 text-xs sm:text-sm font-mono leading-relaxed overflow-x-auto border border-slate-800">
                    <code>{step.expectedOutput}</code>
                  </pre>
                </div>
              )}

              {step.codeSample && (
                <div className="space-y-2 pt-1">
                  <div className="text-xs font-mono text-slate-500 uppercase tracking-wider">
                    {step.codeTitle || "Configuration / Tool Invocation"}
                  </div>
                  <CodeBlock
                    code={step.codeSample}
                    language="json"
                    title={step.codeTitle || "Configuration Code"}
                  />
                </div>
              )}

              {step.tips && step.tips.length > 0 && (
                <div className="p-3.5 rounded-lg bg-blue-50/60 border border-blue-100 text-xs text-blue-900 space-y-1">
                  <span className="font-semibold block font-mono uppercase tracking-wider text-blue-700">
                    💡 Pro Tips
                  </span>
                  <ul className="list-disc list-inside space-y-0.5 text-blue-800">
                    {step.tips.map((tip, idx) => (
                      <li key={idx}>{tip}</li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      {/* Role Breakdown Table */}
      <section id="role-breakdown" className="space-y-6 scroll-mt-20">
        <div className="border-b border-slate-200 pb-3">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
            Component Role Breakdown: CLI vs MCP vs AI Client
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Understanding the boundaries between developer commands, AI model tool calls, and local runtime storage.
          </p>
        </div>

        <div className="overflow-x-auto border border-slate-200 rounded-lg">
          <table className="w-full text-left text-sm text-slate-700 border-collapse">
            <thead className="bg-slate-50 text-xs font-mono uppercase text-slate-500 border-b border-slate-200">
              <tr>
                <th className="p-3.5 sm:p-4">Component</th>
                <th className="p-3.5 sm:p-4">Primary Actor</th>
                <th className="p-3.5 sm:p-4">Execution Medium</th>
                <th className="p-3.5 sm:p-4">Key Responsibilities</th>
                <th className="p-3.5 sm:p-4">Example Invocations</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {ROLE_COMPARISON_TABLE.map((row) => (
                <tr key={row.component} className="hover:bg-slate-50/60">
                  <td className="p-3.5 sm:p-4 font-semibold text-slate-900 align-top whitespace-nowrap">
                    {row.component}
                  </td>
                  <td className="p-3.5 sm:p-4 text-xs font-mono text-slate-600 align-top whitespace-nowrap">
                    {row.primaryActor}
                  </td>
                  <td className="p-3.5 sm:p-4 text-xs text-slate-600 align-top">
                    {row.howItRuns}
                  </td>
                  <td className="p-3.5 sm:p-4 text-xs text-slate-600 align-top space-y-1">
                    <ul className="list-disc list-inside space-y-0.5">
                      {row.keyResponsibilities.map((resp, idx) => (
                        <li key={idx}>{resp}</li>
                      ))}
                    </ul>
                  </td>
                  <td className="p-3.5 sm:p-4 text-xs font-mono text-blue-700 align-top">
                    <div className="space-y-1">
                      {row.exampleOperations.map((op, idx) => (
                        <div key={idx} className="bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                          {op}
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Optional Integrations */}
      <section id="optional-integrations" className="space-y-6 scroll-mt-20">
        <div className="border-b border-slate-200 pb-3">
          <div className="inline-flex items-center gap-2 text-xs font-mono text-purple-700 bg-purple-50 border border-purple-200 px-2 py-0.5 rounded mb-2">
            Optional Enhancements
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
            Optional Integrations: Zettly &amp; Android Companion
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            DevWorkflow works 100% standalone out of the box. If your workflow involves higher-level sprint planning or
            a multi-screen desk cockpit, you can enable these integrations at any time without altering local history.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {OPTIONAL_INTEGRATIONS_DATA.map((integration) => (
            <div
              key={integration.name}
              className="p-5 sm:p-6 rounded-xl border border-slate-200 bg-white shadow-sm space-y-4 flex flex-col justify-between"
            >
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-lg font-semibold text-slate-900">{integration.name}</h3>
                  <span className="text-xs font-mono text-purple-700 bg-purple-50 border border-purple-200 px-2 py-0.5 rounded">
                    {integration.badge}
                  </span>
                </div>

                <p className="text-sm text-slate-600 leading-relaxed">{integration.summary}</p>

                <div className="p-3 rounded bg-amber-50/70 border border-amber-200 text-xs text-amber-900">
                  <span className="font-semibold block font-mono">Standalone Guarantee:</span>
                  {integration.standaloneNote}
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-mono text-slate-500 uppercase tracking-wider">
                    Setup Commands
                  </div>
                  <CodeBlock code={integration.setupCommands} language="bash" title="Setup Commands" />
                </div>

                <div className="space-y-1 text-xs text-slate-600">
                  <span className="font-semibold text-slate-800 block">Benefits &amp; Capabilities:</span>
                  <ul className="list-disc list-inside space-y-0.5">
                    {integration.benefits.map((b, idx) => (
                      <li key={idx}>{b}</li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs font-mono text-slate-500">
                <span>Verification:</span>
                <code className="text-slate-700 bg-slate-50 px-1.5 py-0.5 rounded border border-slate-200">
                  {integration.verificationCommands}
                </code>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Zettly Code v1.0 Debugging Journey */}
      <section id="zettly-code-journey" className="space-y-6">
        <div className="border-b border-slate-200 pb-3">
          <div className="text-xs font-mono text-indigo-600 uppercase tracking-wider font-semibold">
            Optional Extension · Zettly Code v1.0
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
            Context-Aware Bug-Fix &amp; Debugging Journey
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            When the optional Zettly Code engine is connected, DevWorkflow pairs persistent SQLite code memory
            (<code className="font-mono text-xs">code_context</code>, <code className="font-mono text-xs">code_index</code>)
            with mandatory <code className="font-mono text-xs">@zettly-code</code> bug-fix knowledge comments.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {ZETTLY_CODE_DEBUGGING_JOURNEY.map((step) => (
            <article
              key={step.slug}
              className="p-5 rounded-xl border border-slate-200 bg-white shadow-sm space-y-3"
            >
              <h3 className="text-base font-semibold text-slate-900">{step.title}</h3>
              <p className="text-sm text-slate-600">{step.summary}</p>
              {step.codeSample && (
                <CodeBlock code={step.codeSample} language="json" title={step.shortTitle} />
              )}
            </article>
          ))}
        </div>
      </section>

      {/* Bottom CTA / Navigation */}
      <section className="p-6 sm:p-8 rounded-xl border border-slate-200 bg-slate-50 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold text-slate-900">Ready for Real-World Workflows?</h2>
          <p className="text-sm text-slate-600 max-w-xl">
            Explore 13 real-world developer tutorials covering solo coding, bugfixes, legacy refactoring, security
            audits, and multi-agent coordination.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/use-cases/"
            className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors whitespace-nowrap"
          >
            Explore Use Cases →
          </Link>
          <Link
            href="/docs/"
            className="px-4 py-2 rounded-md border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-100 transition-colors whitespace-nowrap"
          >
            API &amp; MCP Reference
          </Link>
        </div>
      </section>
    </main>
  );
}
