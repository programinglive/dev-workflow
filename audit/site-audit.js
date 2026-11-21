/**
 * The site audit orchestrator.
 *
 * One report, one entry point, two thin adapters (CLI and MCP). The engine is
 * read-only by construction: it owns no workflow state and every check returns
 * findings instead of mutating anything.
 */

import { crawlSite } from "./crawl.js";
import { fetchPage, validateAuditUrl } from "./fetch-page.js";
import { getLinks, getMetaByProperty, imageDimensions } from "./html.js";
import { checkA11y } from "./checks/a11y-static.js";
import { checkHeaders } from "./checks/headers.js";
import { checkLinks } from "./checks/links.js";
import { checkParity } from "./checks/parity.js";
import { checkReachability } from "./checks/reachability.js";
import { checkSeo } from "./checks/seo.js";
import { buildReport, SEVERITY_ORDER } from "./report.js";

export const CHECK_NAMES = Object.freeze([
  "reachability",
  "headers",
  "seo",
  "links",
  "a11y",
  "parity",
]);

const CHECK_ALIASES = Object.freeze({
  perf: "reachability",
  performance: "reachability",
  accessibility: "a11y",
});

export const DEFAULT_MAX_PAGES = 8;
export const DEFAULT_TIMEOUT_MS = 15000;
export const MAX_PAGES_LIMIT = 25;
export const TIMEOUT_LIMIT_MS = 60000;

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function normalizeChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return [...CHECK_NAMES];

  const selected = [];
  for (const raw of checks) {
    const name = CHECK_ALIASES[String(raw).toLowerCase()] || String(raw).toLowerCase();
    if (!CHECK_NAMES.includes(name)) {
      throw new Error(`Unknown check "${raw}". Valid checks: ${CHECK_NAMES.join(", ")}`);
    }
    if (!selected.includes(name)) selected.push(name);
  }
  return selected;
}

export function detectParityPrefix(page) {
  if (!page?.body) return null;

  for (const link of getLinks(page.body)) {
    if (link.rel !== "alternate" || link.hreflang !== "id" || !link.href) continue;
    try {
      const pathname = new URL(link.href, page.finalUrl).pathname;
      // Use the first path segment so /id/about still yields /id.
      const segment = pathname.split("/").filter(Boolean)[0];
      if (segment) return `/${segment}`;
    } catch {
      // An unparseable alternate is not a parity signal.
    }
  }
  return null;
}

async function inspectSocialImage(page, fetchOptions) {
  const raw = getMetaByProperty(page.body, "og:image");
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw, page.finalUrl).href;
  } catch {
    return { url: raw, actualWidth: 0, actualHeight: 0, status: 0 };
  }

  const image = await fetchPage(url, {
    ...fetchOptions,
    asBuffer: true,
    maxBodyBytes: 512 * 1024,
  });
  const dimensions = image.ok ? imageDimensions(image.buffer) : null;

  return {
    url,
    status: image.status,
    actualWidth: dimensions?.width || 0,
    actualHeight: dimensions?.height || 0,
  };
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.id}|${finding.url}|${finding.evidence || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortFindings(findings) {
  return [...findings].sort((left, right) => {
    const severity = SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity);
    if (severity !== 0) return severity;
    const category = left.category.localeCompare(right.category);
    if (category !== 0) return category;
    return left.id.localeCompare(right.id);
  });
}

/**
 * @param {{
 *   url: string,
 *   checks?: string[],
 *   maxPages?: number,
 *   timeoutMs?: number,
 *   includeExternal?: boolean,
 *   parityPrefix?: string | null,
 *   fetchImpl?: typeof fetch
 * }} options
 */
export async function auditSite(options = {}) {
  const startedAt = new Date().toISOString();
  const started = Date.now();

  const start = validateAuditUrl(options.url);
  const checks = normalizeChecks(options.checks);
  const maxPages = clamp(Number(options.maxPages) || DEFAULT_MAX_PAGES, 1, MAX_PAGES_LIMIT);
  const timeoutMs = clamp(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000, TIMEOUT_LIMIT_MS);
  const includeExternal = Boolean(options.includeExternal);

  const fetchOptions = {
    fetchImpl: options.fetchImpl,
    timeoutMs,
  };

  const crawl = await crawlSite({
    startUrl: start.href,
    maxPages,
    ...fetchOptions,
  });

  const startPage = crawl.pages[0];
  const parityPrefix = options.parityPrefix === undefined
    ? (checks.includes("parity") ? detectParityPrefix(startPage) : null)
    : options.parityPrefix;

  const findings = [];

  if (checks.includes("reachability")) {
    findings.push(...checkReachability({ pages: crawl.pages, startPage }));
  }

  if (checks.includes("headers") && startPage) {
    findings.push(...checkHeaders({ url: startPage.finalUrl, headers: startPage.headers }));
  }

  if (checks.includes("seo") && startPage) {
    const image = await inspectSocialImage(startPage, fetchOptions);
    findings.push(...checkSeo({
      page: startPage,
      origin: crawl.origin,
      sitemap: crawl.sitemap,
      robots: crawl.robots,
      parityPrefix,
      image,
    }));
  }

  if (checks.includes("a11y")) {
    for (const page of crawl.pages) {
      if (page.ok && /text\/html/i.test(page.contentType)) {
        findings.push(...checkA11y({ page }));
      }
    }
  }

  if (checks.includes("links")) {
    findings.push(...await checkLinks({
      discovered: crawl.discovered,
      pages: crawl.pages,
      origin: crawl.origin,
      includeExternal,
      fetchOptions,
    }));
  }

  if (checks.includes("parity")) {
    findings.push(...await checkParity({
      pages: crawl.pages,
      origin: crawl.origin,
      parityPrefix,
      fetchOptions,
    }));
  }

  const ordered = sortFindings(dedupe(findings));

  return buildReport({
    requestedUrl: start.href,
    finalUrl: startPage?.finalUrl || start.href,
    startedAt,
    durationMs: Date.now() - started,
    pages: crawl.pages,
    findings: ordered,
    checks,
    robots: crawl.robots,
    sitemap: crawl.sitemap,
    truncated: crawl.truncated,
  });
}
