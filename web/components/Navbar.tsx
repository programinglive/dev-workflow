"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { GithubIcon } from "./GithubIcon";
import { GENERATED_CATALOG } from "@/lib/catalog.generated";

const NAV_LINKS = [
  { href: "/", label: "Overview" },
  { href: "/how-to-use/", label: "How to Use" },
  { href: "/use-cases/", label: "Use Cases" },
  { href: "/docs/", label: "Docs" },
  { href: "/developers/", label: "Developers" },
  { href: "/releases/", label: "Releases" },
];

export default function Navbar() {
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname?.startsWith(href.replace(/\/$/, ""));
  };

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-14">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2 font-semibold text-slate-900 tracking-tight">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-slate-900 text-white text-xs font-mono">
                dw
              </span>
              <span>DevWorkflow</span>
            </Link>
            <span className="hidden sm:inline-block text-xs font-mono text-slate-500 border border-slate-200 rounded px-1.5 py-0.5 bg-slate-50">
              v{GENERATED_CATALOG.version}
            </span>
          </div>

          <nav aria-label="Primary" className="hidden md:flex items-center gap-6">
            {NAV_LINKS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`text-sm transition-colors ${
                  isActive(item.href)
                    ? "text-blue-600 font-medium"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {item.label}
              </Link>
            ))}
            <a
              href={GENERATED_CATALOG.repositoryUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub repository"
              className="inline-flex items-center gap-1.5 text-sm text-slate-700 hover:text-slate-900 border border-slate-200 rounded-md px-2.5 py-1 bg-slate-50 hover:bg-slate-100 transition-colors"
            >
              <GithubIcon className="w-3.5 h-3.5" />
              <span>GitHub</span>
            </a>
          </nav>

          <button
            type="button"
            className="md:hidden p-2 rounded-md text-slate-700 hover:bg-slate-100"
            onClick={() => setIsOpen(!isOpen)}
            aria-label={isOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={isOpen}
          >
            {isOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {isOpen && (
        <nav aria-label="Mobile" className="md:hidden border-t border-slate-200 bg-white px-4 py-3 space-y-2">
          {NAV_LINKS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setIsOpen(false)}
              className={`block py-1.5 text-sm ${
                isActive(item.href) ? "text-blue-600 font-medium" : "text-slate-700"
              }`}
            >
              {item.label}
            </Link>
          ))}
          <a
            href={GENERATED_CATALOG.repositoryUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 py-1.5 text-sm text-slate-700"
          >
            <GithubIcon className="w-4 h-4" />
            <span>GitHub ({GENERATED_CATALOG.repositoryVisibility})</span>
          </a>
        </nav>
      )}
    </header>
  );
}
