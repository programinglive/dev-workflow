/**
 * Link integrity.
 *
 * Discovery already fetched some of the links, so the check first reuses those
 * responses and only requests what is still unknown. That keeps the audit close
 * to the crawl budget instead of doubling it.
 */

import { fetchPage } from "../fetch-page.js";

const MAX_INTERNAL_CHECKS = 50;
const MAX_EXTERNAL_CHECKS = 20;

function statusOf(page) {
  return page.ok ? 200 : page.status;
}

export async function checkLinks({
  discovered = [],
  pages = [],
  origin,
  includeExternal = false,
  fetchOptions = {},
  maxInternal = MAX_INTERNAL_CHECKS,
  maxExternal = MAX_EXTERNAL_CHECKS,
} = {}) {
  const findings = [];
  const known = new Map();
  for (const page of pages) {
    known.set(page.requestedUrl, page);
    known.set(page.finalUrl, page);
  }

  const internal = [];
  const external = [];
  const seen = new Set();

  for (const link of discovered) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    const parsed = new URL(link.url);
    if (parsed.origin === origin) internal.push(link);
    else external.push(link);
  }

  const toFetch = internal.filter((link) => !known.has(link.url)).slice(0, maxInternal);
  const externalToFetch = includeExternal ? external.slice(0, maxExternal) : [];

  const fetched = await Promise.all([
    ...toFetch.map((link) => fetchPage(link.url, { ...fetchOptions, readBody: false })),
    ...externalToFetch.map((link) => fetchPage(link.url, { ...fetchOptions, readBody: false })),
  ]);

  for (const page of fetched) {
    known.set(page.requestedUrl, page);
    known.set(page.finalUrl, page);
  }

  for (const link of internal) {
    const page = known.get(link.url);
    if (!page) continue;

    if (page.status === 0) {
      findings.push({
        id: "links.unreachable_link",
        category: "links",
        severity: "error",
        title: "An internal link could not be reached",
        detail: `${link.url} failed: ${page.error || "unknown error"}.`,
        remediation: "Fix the URL or the server route.",
        url: link.url,
        evidence: `found on ${link.foundOn}`,
      });
      continue;
    }

    if (statusOf(page) >= 400) {
      findings.push({
        id: "links.broken_link",
        category: "links",
        severity: "error",
        title: "An internal link returns an error",
        detail: `${link.url} answered HTTP ${page.status}.`,
        remediation: "Restore the route, update the link, or redirect it to the new location.",
        url: link.url,
        evidence: `status ${page.status}; found on ${link.foundOn}`,
      });
      continue;
    }

    if (page.redirects.length > 0) {
      findings.push({
        id: "links.redirected_link",
        category: "links",
        severity: "info",
        title: "An internal link redirects",
        detail: `${link.url} redirects to ${page.finalUrl}.`,
        remediation: "Point the link at its final destination.",
        url: link.url,
        evidence: `final: ${page.finalUrl}`,
      });
    }
  }

  if (includeExternal) {
    for (const link of externalToFetch) {
      const page = known.get(link.url);
      if (!page) continue;
      if (page.status === 0 || page.status >= 400) {
        findings.push({
          id: "links.external_unreachable",
          category: "links",
          severity: "warn",
          title: "An external link could not be verified",
          detail: page.status === 0
            ? `${link.url} failed: ${page.error || "unknown error"}.`
            : `${link.url} answered HTTP ${page.status}.`,
          remediation: "Confirm the destination is still live, or remove the link.",
          url: link.url,
          evidence: `found on ${link.foundOn}`,
        });
      }
    }
  }

  return findings;
}
