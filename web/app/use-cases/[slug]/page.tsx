import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, CheckCircle2, AlertTriangle, ShieldCheck } from "lucide-react";
import CodeBlock from "@/components/CodeBlock";
import { USE_CASES_DATA, UseCaseTutorial } from "@/lib/use-cases-data";
import { WEB_VERSION } from "@/lib/version";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return USE_CASES_DATA.map((t) => ({
    slug: t.slug,
  }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const tutorial = USE_CASES_DATA.find((t) => t.slug === slug);
  if (!tutorial) {
    return { title: "Tutorial Not Found — DevWorkflow" };
  }
  return {
    title: `${tutorial.title} — DevWorkflow Use Cases v${WEB_VERSION}`,
    description: tutorial.summary,
  };
}

export default async function UseCaseDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const index = USE_CASES_DATA.findIndex((t) => t.slug === slug);
  if (index === -1) {
    notFound();
  }

  const tutorial = USE_CASES_DATA[index];
  const prevTutorial = index > 0 ? USE_CASES_DATA[index - 1] : null;
  const nextTutorial = index < USE_CASES_DATA.length - 1 ? USE_CASES_DATA[index + 1] : null;

  const getDifficultyColor = (diff: string) => {
    switch (diff) {
      case "Beginner":
        return "bg-emerald-50 text-emerald-800 border-emerald-200";
      case "Intermediate":
        return "bg-blue-50 text-blue-800 border-blue-200";
      case "Advanced":
        return "bg-purple-50 text-purple-800 border-purple-200";
      default:
        return "bg-slate-50 text-slate-800 border-slate-200";
    }
  };

  return (
    <main className="max-w-4xl mx-auto px-4 sm:px-6 py-10 sm:py-14 space-y-12">
      {/* Breadcrumbs & Back link */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs font-mono text-slate-500">
        <Link href="/use-cases/" className="hover:text-blue-600 transition-colors flex items-center gap-1">
          <ArrowLeft className="w-3.5 h-3.5" /> All Use Cases
        </Link>
        <span>/</span>
        <span className="text-slate-800 truncate">{tutorial.title}</span>
      </nav>

      {/* Header */}
      <header className="space-y-4 border-b border-slate-200 pb-8">
        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
          <span className={`px-2 py-0.5 rounded border ${getDifficultyColor(tutorial.difficulty)}`}>
            {tutorial.difficulty}
          </span>
          <span className="px-2 py-0.5 rounded border border-slate-200 bg-slate-50 text-slate-700">
            {tutorial.category}
          </span>
          <span className="px-2 py-0.5 rounded border border-slate-200 bg-slate-50 text-slate-500">
            Est. Time: {tutorial.estimatedTime}
          </span>
        </div>

        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
          {tutorial.title}
        </h1>

        <p className="text-base sm:text-lg text-slate-600 leading-relaxed">
          {tutorial.summary}
        </p>
      </header>

      {/* Section 1: Problem & Target Audience */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="p-5 rounded-xl border border-rose-100 bg-rose-50/50 space-y-2">
          <h2 className="text-sm font-semibold font-mono uppercase tracking-wider text-rose-900 flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 text-rose-600" /> The Problem
          </h2>
          <p className="text-sm text-rose-950/80 leading-relaxed">{tutorial.problem}</p>
        </div>

        <div className="p-5 rounded-xl border border-blue-100 bg-blue-50/50 space-y-2">
          <h2 className="text-sm font-semibold font-mono uppercase tracking-wider text-blue-900 flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-blue-600" /> Who It Is For
          </h2>
          <p className="text-sm text-blue-950/80 leading-relaxed">{tutorial.whoItIsFor}</p>
        </div>
      </section>

      {/* Section 2: Prerequisites & Tools Used */}
      <section className="space-y-6">
        <div className="border-b border-slate-200 pb-2">
          <h2 className="text-xl font-semibold text-slate-900">Prerequisites &amp; Tools</h2>
        </div>

        <div className="space-y-4">
          <div className="p-4 rounded-lg border border-slate-200 bg-slate-50 text-xs sm:text-sm text-slate-700 space-y-1.5">
            <span className="font-semibold text-slate-900 font-mono uppercase tracking-wider block text-xs">
              Prerequisites Checklist:
            </span>
            <ul className="list-disc list-inside space-y-1">
              {tutorial.prerequisites.map((req, idx) => (
                <li key={idx}>{req}</li>
              ))}
            </ul>
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-left text-sm text-slate-700 border-collapse">
              <thead className="bg-slate-50 text-xs font-mono uppercase text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="p-3">Tool / Command</th>
                  <th className="p-3">Type</th>
                  <th className="p-3">Role in Tutorial</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs sm:text-sm">
                {tutorial.toolsUsed.map((tool) => (
                  <tr key={tool.name} className="hover:bg-slate-50/50">
                    <td className="p-3 font-mono font-semibold text-slate-900">{tool.name}</td>
                    <td className="p-3 font-mono uppercase text-xs">
                      <span
                        className={`px-1.5 py-0.5 rounded border ${
                          tool.type === "cli"
                            ? "bg-slate-100 text-slate-800 border-slate-300"
                            : "bg-blue-50 text-blue-800 border-blue-200"
                        }`}
                      >
                        {tool.type}
                      </span>
                    </td>
                    <td className="p-3 text-slate-600">{tool.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Section 3: Example Task Contract */}
      <section className="space-y-4">
        <div className="border-b border-slate-200 pb-2">
          <h2 className="text-xl font-semibold text-slate-900">Example Task Contract</h2>
          <p className="text-xs text-slate-500 mt-1">
            Exact start_task payload representing this workflow in DevWorkflow local-first governance.
          </p>
        </div>

        <CodeBlock
          code={JSON.stringify(
            {
              description: tutorial.exampleTask.description,
              type: tutorial.exampleTask.type,
              plan: tutorial.exampleTask.plan,
              definitionOfDone: tutorial.exampleTask.definitionOfDone,
            },
            null,
            2
          )}
          language="json"
          title="AI Tool Call: start_task payload"
        />
      </section>

      {/* Section 4: Step-by-Step Workflow */}
      <section className="space-y-6">
        <div className="border-b border-slate-200 pb-2">
          <h2 className="text-xl font-semibold text-slate-900">Step-by-Step Tutorial Workflow</h2>
          <p className="text-xs text-slate-500 mt-1">
            Follow these sequential actions with validated copyable commands and expected outputs.
          </p>
        </div>

        <div className="space-y-6">
          {tutorial.steps.map((step) => (
            <div
              key={step.number}
              className="p-5 rounded-xl border border-slate-200 bg-white shadow-sm space-y-3"
            >
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-blue-600 text-white font-mono text-xs flex items-center justify-center font-bold">
                  {step.number}
                </span>
                <h3 className="text-base font-semibold text-slate-900">{step.title}</h3>
              </div>

              <p className="text-sm text-slate-600 leading-relaxed">{step.explanation}</p>

              {step.command && (
                <div className="space-y-1.5 pt-1">
                  <div className="text-xs font-mono text-slate-500 uppercase tracking-wider">
                    Copyable Command
                  </div>
                  <CodeBlock code={step.command} language="bash" title="Terminal Command" />
                </div>
              )}

              {step.expectedOutput && (
                <div className="space-y-1.5">
                  <div className="text-xs font-mono text-slate-500 uppercase tracking-wider">
                    Expected Terminal Output
                  </div>
                  <pre className="p-3 rounded-lg bg-slate-950 text-slate-200 text-xs sm:text-sm font-mono leading-relaxed overflow-x-auto border border-slate-800">
                    <code>{step.expectedOutput}</code>
                  </pre>
                </div>
              )}

              {step.codeSample && (
                <div className="space-y-1.5 pt-1">
                  <div className="text-xs font-mono text-slate-500 uppercase tracking-wider">
                    Code / Tool Payload
                  </div>
                  <CodeBlock code={step.codeSample} language="json" title="Execution Payload" />
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Section 5: Verification Steps */}
      <section className="space-y-4">
        <div className="border-b border-slate-200 pb-2">
          <h2 className="text-xl font-semibold text-slate-900">Verification Steps</h2>
          <p className="text-xs text-slate-500 mt-1">
            Verify that your work genuinely satisfies the task contract before closing.
          </p>
        </div>

        <div className="p-5 rounded-xl border border-emerald-200 bg-emerald-50/50 space-y-2">
          {tutorial.verificationSteps.map((v, idx) => (
            <div key={idx} className="flex items-start gap-2.5 text-sm text-emerald-950">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              <span>{v}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Section 6: Limitations & Troubleshooting */}
      <section className="space-y-4">
        <div className="border-b border-slate-200 pb-2">
          <h2 className="text-xl font-semibold text-slate-900">Limitations &amp; Troubleshooting</h2>
        </div>

        <div className="space-y-3">
          {tutorial.limitationsAndTroubleshooting.map((item, idx) => (
            <div
              key={idx}
              className="p-4 rounded-lg border border-slate-200 bg-white text-xs sm:text-sm space-y-1"
            >
              <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                <span className="text-rose-600 font-mono">Issue:</span> {item.issue}
              </div>
              <div className="text-slate-600 pl-4 border-l-2 border-blue-400">
                <span className="font-semibold text-slate-800">Resolution:</span> {item.resolution}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Previous / Next Tutorial Navigation */}
      <nav aria-label="Tutorial pagination" className="pt-8 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-4">
        {prevTutorial ? (
          <Link
            href={`/use-cases/${prevTutorial.slug}/`}
            className="p-4 rounded-lg border border-slate-200 bg-white hover:border-blue-300 transition-colors space-y-1 block"
          >
            <span className="text-xs font-mono text-slate-400 flex items-center gap-1">
              <ArrowLeft className="w-3.5 h-3.5" /> Previous Tutorial
            </span>
            <div className="text-sm font-semibold text-slate-900 truncate">{prevTutorial.title}</div>
          </Link>
        ) : (
          <div className="hidden sm:block" />
        )}

        {nextTutorial && (
          <Link
            href={`/use-cases/${nextTutorial.slug}/`}
            className="p-4 rounded-lg border border-slate-200 bg-white hover:border-blue-300 transition-colors space-y-1 block sm:text-right"
          >
            <span className="text-xs font-mono text-slate-400 flex items-center justify-start sm:justify-end gap-1">
              Next Tutorial <ArrowRight className="w-3.5 h-3.5" />
            </span>
            <div className="text-sm font-semibold text-slate-900 truncate">{nextTutorial.title}</div>
          </Link>
        )}
      </nav>
    </main>
  );
}
