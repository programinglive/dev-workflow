import Link from "next/link";
import { ArrowLeft, CheckCircle, GitBranch, FileText, TestTube, Rocket, ClipboardCheck } from "lucide-react";
import { WEB_VERSION } from "@/lib/version";

const features = [
    {
        icon: ClipboardCheck,
        color: "text-sky-600 dark:text-sky-400",
        title: "Definition of Done",
        body: "Every task states, up front, which conditions must be true. Each one is proven with evidence or waived with a written reason, and nothing is committed while an item is open.",
    },
    {
        icon: CheckCircle,
        color: "text-indigo-600 dark:text-indigo-400",
        title: "Enforced Discipline",
        body: "Won't let you skip important steps. Follows a strict, proven development workflow.",
    },
    {
        icon: TestTube,
        color: "text-purple-600 dark:text-purple-400",
        title: "Test-Driven",
        body: "Blocks commits if tests fail. Encourages writing tests before marking tasks complete.",
    },
    {
        icon: FileText,
        color: "text-emerald-600 dark:text-emerald-400",
        title: "Documentation",
        body: "Reminds you to update documentation (README, docs, changelog) for every change.",
    },
    {
        icon: GitBranch,
        color: "text-orange-600 dark:text-orange-400",
        title: "State Tracking",
        body: "Remembers exactly where you are in the workflow, even across sessions.",
    },
];

const quickStart = [
    {
        color: "bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400",
        title: "Start a Task",
        body: "Begin your coding session by defining what you're working on, which repo it belongs to, and the concrete conditions that make it done.",
        code: 'start_task { description, type, projectDir, definitionOfDone: [...] }',
    },
    {
        color: "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400",
        title: "Describe Feature Flow",
        body: "Visualize your implementation plan using Mermaid syntax.",
        code: "create_feature_flow",
    },
    {
        color: "bg-purple-100 dark:bg-purple-500/20 text-purple-600 dark:text-purple-400",
        title: "Implement and Prove",
        body: "Once you've implemented the change, mark it fixed, then prove each definition-of-done item with the evidence that proves it.",
        code: 'mark_bug_fixed { summary }  →  mark_dod_item { id, evidence }',
    },
    {
        color: "bg-sky-100 dark:bg-sky-500/20 text-sky-600 dark:text-sky-400",
        title: "Create Tests",
        body: "Write tests to verify your changes work correctly.",
        code: "create_tests",
    },
    {
        color: "bg-orange-100 dark:bg-orange-500/20 text-orange-600 dark:text-orange-400",
        title: "Run Tests",
        body: "Execute your test suite and ensure everything passes.",
        code: "run_tests { passed, testCommand }",
    },
    {
        color: "bg-pink-100 dark:bg-pink-500/20 text-pink-600 dark:text-pink-400",
        title: "Create Documentation",
        body: "Update relevant documentation for your changes.",
        code: "create_documentation",
    },
    {
        color: "bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400",
        title: "Commit and Push",
        body: "Ready check first, then commit and push. Both refuse while a definition-of-done item is still open.",
        code: "check_ready_to_commit  →  commit_and_push",
    },
];

const commands = [
    { cmd: "start_task", desc: "Begin a task and record its definition of done" },
    { cmd: "set_definition_of_done", desc: "Fill the checklist of a task started before the rule existed" },
    { cmd: "mark_dod_item", desc: "Prove one item, with evidence" },
    { cmd: "waive_dod_item", desc: "Exclude one item, with a written reason" },
    { cmd: "create_feature_flow", desc: "Describe the implementation plan with Mermaid" },
    { cmd: "mark_bug_fixed", desc: "Mark feature or bugfix as complete" },
    { cmd: "create_tests", desc: "Record that tests have been created" },
    { cmd: "run_tests", desc: "Record test results; a failure blocks the commit" },
    { cmd: "skip_tests", desc: "Skip tests with a justification" },
    { cmd: "create_documentation", desc: "Record documentation updates" },
    { cmd: "check_ready_to_commit", desc: "Verify every required step, including the definition of done" },
    { cmd: "commit_and_push", desc: "git add, commit and push" },
    { cmd: "perform_release", desc: "Execute the release process" },
    { cmd: "skip_release", desc: "Skip the release step with a justification" },
    { cmd: "complete_task", desc: "Close the task and record its definition-of-done summary" },
    { cmd: "force_complete_task", desc: "Close despite open items, with a recorded reason" },
    { cmd: "drop_task", desc: "Abandon the task without completing it" },
    { cmd: "get_workflow_status", desc: "Check the current workflow state and every DoD item" },
    { cmd: "continue_workflow", desc: "Get guidance on the next step" },
    { cmd: "rerun_workflow", desc: "Restart the current task from the beginning, keeping its DoD" },
    { cmd: "run_full_workflow", desc: "Run every step in one call" },
    { cmd: "view_history", desc: "List completed tasks" },
    { cmd: "project_summary", desc: "Aggregate activity for the project" },
    { cmd: "list_factory_tasks", desc: "List your Factory task queue (requires config)" },
    { cmd: "claim_factory_task", desc: "Claim a Factory task and import its checklist as open items" },
];

export default function DocsPage() {
    return (
        <div className="min-h-screen bg-white dark:bg-[#0a0a0f] text-gray-900 dark:text-white pt-20 px-4 pb-12 transition-colors duration-300">
            <div className="max-w-4xl mx-auto">
                <div className="mb-8">
                    <Link href="/" className="inline-flex items-center gap-2 text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 transition">
                        <ArrowLeft className="w-4 h-4" />
                        Back to Dashboard
                    </Link>
                </div>

                <div className="prose dark:prose-invert max-w-none">
                    <h1 className="text-5xl font-bold mb-4 bg-gradient-to-r from-indigo-600 dark:from-indigo-400 via-purple-600 dark:via-purple-400 to-pink-600 dark:to-pink-400 bg-clip-text text-transparent">
                        Dev Workflow MCP Server
                    </h1>
                    <p className="text-xl text-gray-600 dark:text-gray-400 mb-8">
                        An MCP server that acts as your coding conscience. Every task carries a definition of done
                        that must be proven item by item, tests must be green, and no step in the release process
                        can be skipped.
                    </p>

                    <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 rounded-lg p-4 mb-8">
                        <p className="text-emerald-700 dark:text-emerald-400 font-semibold">Version: {WEB_VERSION}</p>
                    </div>

                    <h2 className="text-3xl font-bold mt-12 mb-6 text-gray-900 dark:text-white">Features</h2>
                    <div className="grid md:grid-cols-2 gap-4 mb-8">
                        {features.map((feature) => (
                            <div key={feature.title} className="p-4 rounded-lg bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10">
                                <div className="flex items-center gap-3 mb-2">
                                    <feature.icon className={`w-5 h-5 ${feature.color}`} />
                                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{feature.title}</h3>
                                </div>
                                <p className="text-gray-600 dark:text-gray-400 text-sm">{feature.body}</p>
                            </div>
                        ))}
                    </div>

                    <h2 className="text-3xl font-bold mt-12 mb-6 text-gray-900 dark:text-white">Installation</h2>
                    <div className="bg-gray-100 dark:bg-[#1a1a24] rounded-lg p-6 border border-gray-300 dark:border-white/10 mb-8">
                        <pre className="text-sm overflow-x-auto">
                            <code className="text-gray-700 dark:text-gray-300">npm install -g @programinglive/dev-workflow-mcp-server</code>
                        </pre>
                    </div>

                    <h2 className="text-3xl font-bold mt-12 mb-6 text-gray-900 dark:text-white">Quick Start</h2>
                    <ol className="space-y-4 mb-8">
                        {quickStart.map((step, index) => (
                            <li key={step.title} className="flex gap-4">
                                <span className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-bold ${step.color}`}>
                                    {index + 1}
                                </span>
                                <div>
                                    <h3 className="font-semibold mb-1 text-gray-900 dark:text-white">{step.title}</h3>
                                    <p className="text-gray-600 dark:text-gray-400">{step.body}</p>
                                    <div className="bg-gray-100 dark:bg-[#1a1a24] rounded-lg p-3 mt-2 border border-gray-300 dark:border-white/10">
                                        <code className="text-sm text-gray-700 dark:text-gray-300">{step.code}</code>
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ol>

                    <h2 className="text-3xl font-bold mt-12 mb-6 text-gray-900 dark:text-white">Definition of Done</h2>
                    <p className="text-gray-600 dark:text-gray-400 mb-4">
                        A task cannot be committed or closed while any item is still open. Each item ends one of two ways:
                        it is <strong>proven</strong> with evidence, or <strong>excluded</strong> with a reason someone else can read.
                    </p>
                    <div className="bg-gray-100 dark:bg-[#1a1a24] rounded-lg p-6 border border-gray-300 dark:border-white/10 mb-4">
                        <pre className="text-sm overflow-x-auto">
                            <code className="text-gray-700 dark:text-gray-300">{`start_task {
  description: "Perbaiki validasi form appointment",
  type: "bugfix",
  projectDir: "D:\\\\code\\\\clinic",
  definitionOfDone: ["build lulus", "validasi menolak input kosong"]
}

mark_dod_item { id: "dod-1", evidence: "php artisan test -> 412 pass" }
waive_dod_item { id: "dod-2", reason: "form ini tidak punya jalur input kosong" }`}</code>
                        </pre>
                    </div>
                    <p className="text-gray-600 dark:text-gray-400 mb-8">
                        When new working changes appear after a commit, previously proven items must be re-confirmed against
                        the code that is actually being committed; waivers survive, because a waiver is a decision rather than
                        a proof. A checklist imported from the Factory board starts fully open for the same reason: a checked
                        box on the board records a plan, not evidence that this machine ran anything.
                    </p>

                    <h2 className="text-3xl font-bold mt-12 mb-6 text-gray-900 dark:text-white">Available Commands</h2>
                    <div className="space-y-3 mb-8">
                        {commands.map((item) => (
                            <div key={item.cmd} className="p-4 rounded-lg bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10 hover:bg-gray-100 dark:hover:bg-white/10 transition">
                                <code className="text-indigo-600 dark:text-indigo-400 font-mono">{item.cmd}</code>
                                <p className="text-gray-600 dark:text-gray-400 text-sm mt-1">{item.desc}</p>
                            </div>
                        ))}
                    </div>

                    <h2 className="text-3xl font-bold mt-12 mb-6 text-gray-900 dark:text-white">Configuration</h2>
                    <p className="text-gray-600 dark:text-gray-400 mb-4">
                        Workflow state lives on your machine, under <code className="text-indigo-600 dark:text-indigo-400 bg-gray-100 dark:bg-white/5 px-2 py-1 rounded">.state/users/&lt;user&gt;/</code>:
                        one file per agent session, with the project history shared between them.
                    </p>
                    <p className="text-gray-600 dark:text-gray-400 mb-8">
                        Set the <code className="text-indigo-600 dark:text-indigo-400 bg-gray-100 dark:bg-white/5 px-2 py-1 rounded">DEV_WORKFLOW_USER_ID</code> environment variable to isolate workflow state per user,
                        and <code className="text-indigo-600 dark:text-indigo-400 bg-gray-100 dark:bg-white/5 px-2 py-1 rounded">WORKFLOW_PROJECT_DIR</code> to pin the repository a session commits to.
                    </p>

                    <h2 className="text-3xl font-bold mt-12 mb-6 text-gray-900 dark:text-white">Requirements</h2>
                    <ul className="space-y-2 mb-8">
                        <li className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                            <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                            Node.js 18 or higher
                        </li>
                        <li className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                            <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                            Git installed and configured
                        </li>
                        <li className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                            <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                            MCP-compatible AI assistant (e.g., Claude Desktop)
                        </li>
                    </ul>

                    <h2 className="text-3xl font-bold mt-12 mb-6 text-gray-900 dark:text-white">License</h2>
                    <p className="text-gray-600 dark:text-gray-400 mb-8">
                        MIT License - Free to use for personal and commercial projects.
                    </p>

                    <div className="bg-gradient-to-r from-indigo-50 dark:from-indigo-500/10 via-purple-50 dark:via-purple-500/10 to-pink-50 dark:to-pink-500/10 border border-gray-300 dark:border-white/10 rounded-lg p-6 mt-12">
                        <div className="flex items-center gap-3 mb-3">
                            <Rocket className="w-6 h-6 text-pink-600 dark:text-pink-400" />
                            <h3 className="text-xl font-bold text-gray-900 dark:text-white">Ready to get started?</h3>
                        </div>
                        <p className="text-gray-600 dark:text-gray-400 mb-4">
                            Install the MCP server and start enforcing best practices in your development workflow today!
                        </p>
                        <Link
                            href="https://github.com/programinglive/dev-workflow-mcp-server"
                            target="_blank"
                            className="inline-flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 dark:from-indigo-600 dark:to-purple-600 rounded-lg font-semibold text-white hover:shadow-lg hover:shadow-indigo-500/50 transition"
                        >
                            View on GitHub
                        </Link>
                    </div>
                </div>
            </div>
        </div>
    );
}
