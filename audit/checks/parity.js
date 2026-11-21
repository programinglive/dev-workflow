/**
 * Language route parity.
 *
 * A bilingual site that publishes /about but not /id/about has a hole that no
 * single page reveals. The check pairs each healthy page with its counterpart
 * and only reports a finding when the counterpart is actually missing, so an
 * uncrawled but healthy page does not become a false positive.
 */

import { fetchPage } from "../fetch-page.js";

function normalizePrefix(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const trimmed = value.trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

function counterpartOf(pathname, prefix) {
  if (pathname === prefix) return "/";
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length) || "/";
  return pathname === "/" ? prefix : `${prefix}${pathname}`;
}

export async function checkParity({
  pages = [],
  origin,
  parityPrefix = null,
  fetchOptions = {},
  maxChecks = 10,
} = {}) {
  const prefix = normalizePrefix(parityPrefix);
  if (!prefix) return [];

  const known = new Map();
  for (const page of pages) {
    known.set(page.requestedUrl, page);
    known.set(page.finalUrl, page);
  }

  const findings = [];
  const checked = new Set();
  const candidates = pages.filter((page) => {
    return page.ok && /text\/html/i.test(page.contentType) && page.finalUrl.startsWith(origin);
  });

  for (const page of candidates) {
    if (checked.size >= maxChecks) break;

    const pathname = new URL(page.finalUrl).pathname;
    const counterpartPath = counterpartOf(pathname, prefix);
    const counterpartUrl = `${origin}${counterpartPath}`;
    if (checked.has(counterpartUrl)) continue;
    checked.add(counterpartUrl);

    let counterpart = known.get(counterpartUrl);
    if (!counterpart) {
      counterpart = await fetchPage(counterpartUrl, { ...fetchOptions, readBody: false });
      known.set(counterpartUrl, counterpart);
    }

    if (counterpart.status === 0) {
      findings.push({
        id: "parity.route_missing",
        category: "parity",
        severity: "warn",
        title: "A language counterpart could not be reached",
        detail: `${page.finalUrl} has no reachable counterpart at ${counterpartUrl}.`,
        remediation: "Publish the counterpart route or redirect it to the closest equivalent.",
        url: counterpartUrl,
        evidence: counterpart.error || "request failed",
      });
      continue;
    }

    if (counterpart.status >= 400) {
      findings.push({
        id: "parity.route_missing",
        category: "parity",
        severity: "warn",
        title: "A language counterpart is missing",
        detail: `${page.finalUrl} has no counterpart at ${counterpartUrl} (HTTP ${counterpart.status}).`,
        remediation: "Publish the counterpart route or redirect it to the closest equivalent.",
        url: counterpartUrl,
        evidence: `status ${counterpart.status}; paired with ${page.finalUrl}`,
      });
    }
  }

  return findings;
}
