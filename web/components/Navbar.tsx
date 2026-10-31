"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X, Moon, Sun } from "lucide-react";
import { GithubIcon } from "./GithubIcon";
import Image from "next/image";
import { useTheme } from "./ThemeProvider";

/**
 * There is deliberately no Login link here.
 *
 * The site is a static export (`output: "export"`), so no server runs with it:
 * the Express auth routes in `web/server.js` are never deployed, and the old
 * login page posted to a Cloudflare quick tunnel that no longer exists. A button
 * that can only fail is worse than no button. Workflow history is served by the
 * MCP tools on the user's own machine (`view_history`, `project_summary`).
 */
export default function Navbar() {
    const [isOpen, setIsOpen] = useState(false);
    const { theme, toggleTheme } = useTheme();

    return (
        <nav className="fixed top-0 left-0 right-0 z-50 bg-white/80 dark:bg-[#0a0a0f]/80 backdrop-blur-lg border-b border-gray-200 dark:border-white/10 transition-colors duration-300">
            <div className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-8">
                <div className="flex items-center justify-between h-14 sm:h-16">
                    <Link href="/" className="flex items-center gap-2">
                        <Image src="/assets/logo.png" alt="Dev Workflow" width={28} height={28} className="rounded-lg w-7 h-7 sm:w-8 sm:h-8" />
                        <span className="text-sm sm:text-lg font-bold text-gray-900 dark:text-white">Dev Workflow</span>
                    </Link>
                    <div className="hidden md:flex items-center gap-3 lg:gap-6">
                        <Link href="/#features" className="text-xs lg:text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition">Features</Link>
                        <Link href="/#api" className="text-xs lg:text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition">API</Link>
                        <Link href="/docs" className="text-xs lg:text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition">Docs</Link>
                        <button
                            onClick={toggleTheme}
                            className="flex items-center justify-center w-8 h-8 rounded-lg bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 transition text-gray-900 dark:text-white"
                            aria-label="Toggle theme"
                        >
                            {theme === "dark" ? (
                                <Sun className="w-4 h-4" />
                            ) : (
                                <Moon className="w-4 h-4" />
                            )}
                        </button>
                        <a
                            href="https://github.com/programinglive/dev-workflow-mcp-server"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 px-3 py-1.5 lg:px-4 lg:py-2 bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 rounded-lg transition text-xs lg:text-sm text-gray-900 dark:text-white"
                        >
                            <GithubIcon className="w-3.5 h-3.5 lg:w-4 lg:h-4" />
                            GitHub
                        </a>
                    </div>
                    <div className="md:hidden flex items-center gap-2">
                        <button
                            onClick={toggleTheme}
                            className="p-2 rounded-lg bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 transition text-gray-900 dark:text-white"
                            aria-label="Toggle theme"
                        >
                            {theme === "dark" ? (
                                <Sun className="w-5 h-5" />
                            ) : (
                                <Moon className="w-5 h-5" />
                            )}
                        </button>
                        <button
                            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/5 transition text-gray-900 dark:text-white"
                            onClick={() => setIsOpen(!isOpen)}
                        >
                            {isOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
                        </button>
                    </div>
                </div>
            </div>
            {/* Mobile Menu */}
            {isOpen && (
                <div className="md:hidden border-t border-gray-200 dark:border-white/10 bg-white dark:bg-[#0a0a0f] transition-colors duration-300">
                    <div className="px-4 py-4 space-y-3">
                        <Link href="/#features" className="block text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition" onClick={() => setIsOpen(false)}>Features</Link>
                        <Link href="/#api" className="block text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition" onClick={() => setIsOpen(false)}>API</Link>
                        <Link href="/docs" className="block text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition" onClick={() => setIsOpen(false)}>Docs</Link>
                        <a
                            href="https://github.com/programinglive/dev-workflow-mcp-server"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition"
                        >
                            <GithubIcon className="w-4 h-4" />
                            GitHub
                        </a>
                    </div>
                </div>
            )}
        </nav>
    );
}
