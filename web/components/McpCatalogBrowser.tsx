"use client";

import { useState, useMemo } from "react";
import { GENERATED_CATALOG } from "@/lib/catalog.generated";

export default function McpCatalogBrowser() {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GENERATED_CATALOG.mcpTools;
    return GENERATED_CATALOG.mcpTools.filter(
      (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="text-sm text-slate-600">
          Showing <span className="font-mono font-semibold text-slate-900">{filtered.length}</span> of{" "}
          <span className="font-mono font-semibold text-slate-900">{GENERATED_CATALOG.mcpToolCount}</span> runtime MCP
          tools
        </div>
        <label className="block w-full sm:w-72">
          <span className="sr-only">Filter MCP tools</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter tools by name or description..."
            className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md bg-white text-slate-900 placeholder:text-slate-400"
          />
        </label>
      </div>

      {/* Prompts */}
      <div className="border border-slate-200 rounded-lg p-4 bg-slate-50 space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">
          MCP Prompts ({GENERATED_CATALOG.mcpPrompts.length})
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {GENERATED_CATALOG.mcpPrompts.map((p) => (
            <div key={p.name} className="p-3 rounded border border-slate-200 bg-white">
              <div className="font-mono text-xs font-semibold text-slate-900">{p.name}</div>
              <p className="text-xs text-slate-600 mt-1">{p.description}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Tools */}
      <div className="space-y-3">
        {filtered.map((tool) => (
          <article key={tool.name} className="border border-slate-200 rounded-lg p-4 bg-white space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-mono text-sm font-semibold text-slate-900">{tool.name}</h3>
              {tool.required.length > 0 && (
                <span className="text-xs font-mono text-slate-500">
                  required: {tool.required.join(", ")}
                </span>
              )}
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">{tool.description}</p>
            {tool.params.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-blue-600 hover:underline font-medium">
                  Input schema ({tool.params.length} parameters)
                </summary>
                <div className="mt-2 overflow-x-auto border border-slate-200 rounded">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-700">
                      <tr>
                        <th className="py-1.5 px-2.5 font-semibold">Parameter</th>
                        <th className="py-1.5 px-2.5 font-semibold">Type</th>
                        <th className="py-1.5 px-2.5 font-semibold">Required</th>
                        <th className="py-1.5 px-2.5 font-semibold">Description</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {tool.params.map((param) => (
                        <tr key={param.name}>
                          <td className="py-1.5 px-2.5 font-mono text-slate-900">{param.name}</td>
                          <td className="py-1.5 px-2.5 font-mono text-slate-600">
                            {param.type}
                            {param.enumValues.length > 0 ? ` (${param.enumValues.join(" | ")})` : ""}
                          </td>
                          <td className="py-1.5 px-2.5 font-mono text-slate-600">{param.required ? "yes" : "no"}</td>
                          <td className="py-1.5 px-2.5 text-slate-600">{param.description || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
