/**
 * Workflow data is read through MCP tools, not over HTTP.
 *
 * The previous version of this section listed `GET /api/history` and
 * `GET /api/summary`. Neither is reachable in production: the site is a static
 * export, so the Express routes in `web/server.js` are never deployed and both
 * paths answer 404. Documenting an endpoint that cannot answer is how a site
 * ends up lying quietly.
 */
const tools = [
    {
        name: "view_history",
        description: "List completed tasks, with the commit message and definition-of-done summary recorded for each one.",
    },
    {
        name: "project_summary",
        description: "Aggregate activity for the project: task counts, task types, and the most recent work.",
    },
    {
        name: "project_summary_data",
        description: "Read the persisted project-summary.json written next to the workflow state.",
    },
    {
        name: "project_summary_db",
        description: "Read the per-user summary from the local SQLite database.",
    },
];

export default function ApiReference() {
    return (
        <section id="api" className="py-20 px-4">
            <div className="max-w-7xl mx-auto">
                <h2 className="text-3xl md:text-4xl font-bold mb-8">Reading your workflow data</h2>
                <p className="text-gray-400 mb-12">
                    Your workflow state stays on your own machine. These MCP tools read it; there is no
                    hosted API and nothing is uploaded anywhere.
                </p>
                <div className="grid md:grid-cols-2 gap-6">
                    {tools.map((tool) => (
                        <div key={tool.name} className="p-6 rounded-xl bg-white/5 border border-white/10">
                            <code className="text-indigo-400 font-mono text-sm">{tool.name}</code>
                            <p className="text-gray-400 mt-2">{tool.description}</p>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
