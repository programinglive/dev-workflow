"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Search, SlidersHorizontal, ArrowRight } from "lucide-react";
import { USE_CASES_DATA, Difficulty, UseCaseCategory } from "@/lib/use-cases-data";

export default function UseCasesCatalog() {
  const [search, setSearch] = useState("");
  const [selectedDifficulty, setSelectedDifficulty] = useState<string>("All");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");

  const difficulties: ("All" | Difficulty)[] = ["All", "Beginner", "Intermediate", "Advanced"];
  const categories: ("All" | UseCaseCategory)[] = [
    "All",
    "Development",
    "Quality & Security",
    "Collaboration & Ops",
    "Optional Integrations",
  ];

  const filteredTutorials = useMemo(() => {
    return USE_CASES_DATA.filter((item) => {
      const matchesSearch =
        search === "" ||
        item.title.toLowerCase().includes(search.toLowerCase()) ||
        item.summary.toLowerCase().includes(search.toLowerCase()) ||
        item.problem.toLowerCase().includes(search.toLowerCase()) ||
        item.toolsUsed.some((t) => t.name.toLowerCase().includes(search.toLowerCase()));

      const matchesDifficulty =
        selectedDifficulty === "All" || item.difficulty === selectedDifficulty;

      const matchesCategory =
        selectedCategory === "All" || item.category === selectedCategory;

      return matchesSearch && matchesDifficulty && matchesCategory;
    });
  }, [search, selectedDifficulty, selectedCategory]);

  const getDifficultyColor = (diff: Difficulty) => {
    switch (diff) {
      case "Beginner":
        return "bg-emerald-50 text-emerald-800 border-emerald-200";
      case "Intermediate":
        return "bg-blue-50 text-blue-800 border-blue-200";
      case "Advanced":
        return "bg-purple-50 text-purple-800 border-purple-200";
    }
  };

  return (
    <div className="space-y-8">
      {/* Search and Filters Bar */}
      <div className="p-4 sm:p-5 rounded-xl border border-slate-200 bg-slate-50/80 space-y-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tutorials by keyword, tool, or topic..."
              className="w-full pl-9 pr-4 py-2 text-sm rounded-md border border-slate-300 bg-white placeholder-slate-400 text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-slate-400 hover:text-slate-600"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pt-2 border-t border-slate-200/80 text-xs font-mono">
          {/* Difficulty Filter */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-slate-500 flex items-center gap-1 font-sans mr-1">
              <SlidersHorizontal className="w-3.5 h-3.5" /> Difficulty:
            </span>
            {difficulties.map((diff) => (
              <button
                key={diff}
                type="button"
                onClick={() => setSelectedDifficulty(diff)}
                className={`px-2.5 py-1 rounded transition-colors ${
                  selectedDifficulty === diff
                    ? "bg-slate-900 text-white font-medium shadow-sm"
                    : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
                }`}
              >
                {diff}
              </button>
            ))}
          </div>

          {/* Category Filter */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-slate-500 font-sans mr-1">Category:</span>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`px-2.5 py-1 rounded transition-colors ${
                  selectedCategory === cat
                    ? "bg-blue-600 text-white font-medium shadow-sm"
                    : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results Header */}
      <div className="flex items-center justify-between text-xs font-mono text-slate-500">
        <span>
          Showing {filteredTutorials.length} of {USE_CASES_DATA.length} tutorials
        </span>
        {(search || selectedDifficulty !== "All" || selectedCategory !== "All") && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setSelectedDifficulty("All");
              setSelectedCategory("All");
            }}
            className="text-blue-600 hover:underline"
          >
            Reset all filters
          </button>
        )}
      </div>

      {/* Tutorial Cards Grid */}
      {filteredTutorials.length === 0 ? (
        <div className="p-12 text-center rounded-xl border border-dashed border-slate-300 bg-slate-50 space-y-2">
          <p className="text-sm font-semibold text-slate-800">No matching tutorials found</p>
          <p className="text-xs text-slate-500">
            Try adjusting your search keywords or clearing difficulty and category filters.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {filteredTutorials.map((tutorial) => (
            <Link
              key={tutorial.slug}
              href={`/use-cases/${tutorial.slug}/`}
              className="p-5 sm:p-6 rounded-xl border border-slate-200 bg-white hover:border-blue-400 hover:shadow-md transition-all flex flex-col justify-between space-y-4 group"
            >
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span
                    className={`text-xs font-mono px-2 py-0.5 rounded border ${getDifficultyColor(
                      tutorial.difficulty
                    )}`}
                  >
                    {tutorial.difficulty}
                  </span>
                  <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
                    <span>{tutorial.category}</span>
                    <span>·</span>
                    <span>{tutorial.estimatedTime}</span>
                  </div>
                </div>

                <h3 className="text-lg font-semibold text-slate-900 group-hover:text-blue-600 transition-colors">
                  {tutorial.title}
                </h3>

                <p className="text-sm text-slate-600 leading-relaxed line-clamp-3">
                  {tutorial.summary}
                </p>

                <div className="pt-1">
                  <span className="text-xs font-mono text-slate-500 uppercase tracking-wider block mb-1">
                    Featured Tools:
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {tutorial.toolsUsed.map((tool) => (
                      <span
                        key={tool.name}
                        className="text-xs font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200"
                      >
                        {tool.name}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-sm font-medium text-blue-600 group-hover:text-blue-700">
                <span>Read Full Tutorial</span>
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
