/**
 * Same-origin discovery for the site audit.
 *
 * The crawler is intentionally boring: breadth-first, one batch at a time, and
 * a hard page budget. It never follows an external origin during discovery, so
 * an audit of one site cannot accidentally walk the whole internet.
 */

import { fetchPage, validateAuditUrl } from "./fetch-page.js";
import { findTagBlocks, getAttribute } from "./html.js";

const SKIP_PROTOCOLS = /^(?:mailto|tel|sms|javascript|data|blob):/i;

export function normalizeUrl(input, baseUrl) {
  if (typeof input !== "string" || input.trim() === "") return null;
  if (SKIP_PROTOCOLS.test(input.trim())) return null;

  let parsed;
  try {
    parsed = new URL(input.trim(), baseUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.hash = "";
  return parsed.href;
}

export function extractLinks(html, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const links = [];
  const seen = new Set();

  for (const block of findTagBlocks(html, "a")) {
    const href = getAttribute(block.tag, "href");
    const url = normalizeUrl(href, baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({ url, external: new URL(url).origin !== origin, foundOn: baseUrl });
  }

  return links;
}

export function parseRobots(text) {
  const disallow = [];
  const allow = [];
  const sitemaps = [];
  let applies = false;

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;

    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      applies = value === "*";
      continue;
    }
    if (!applies) continue;
    if (key === "disallow" && value !== "") disallow.push(value);
    if (key === "allow" && value !== "") allow.push(value);
    if (key === "sitemap" && value !== "") sitemaps.push(value);
  }

  return { disallow, allow, sitemaps };
}

export function isAllowedByRobots(pathname, rules) {
  if (!rules || rules.disallow.length === 0) return true;

  const matches = (prefix) => pathname.startsWith(prefix);
  const blocked = rules.disallow.filter(matches).sort((a, b) => b.length - a.length)[0];
  if (!blocked) return true;

  const permitted = rules.allow.filter(matches).sort((a, b) => b.length - a.length)[0];
  if (!permitted) return false;
  return permitted.length >= blocked.length;
}

async function loadRobots(origin, fetchOptions) {
  const url = `${origin}/robots.txt`;
  const page = await fetchPage(url, { ...fetchOptions, maxBodyBytes: 256 * 1024 });
  if (!page.ok || !/text\/plain|text\//i.test(page.contentType)) {
    return { status: page.status, url, disallow: [], allow: [], sitemaps: [] };
  }
  return { status: page.status, url, ...parseRobots(page.body) };
}

async function loadSitemap(origin, robots, fetchOptions) {
  const url = robots.sitemaps[0] || `${origin}/sitemap.xml`;
  const page = await fetchPage(url, { ...fetchOptions, maxBodyBytes: 1024 * 1024 });
  const urlCount = page.ok ? (page.body.match(/<loc\b/gi) || []).length : 0;
  return { status: page.status, url, urlCount };
}

/**
 * @param {{
 *   startUrl: string,
 *   maxPages?: number,
 *   concurrency?: number,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   maxBodyBytes?: number,
 *   maxRedirects?: number
 * }} options
 */
export async function crawlSite(options = {}) {
  const start = validateAuditUrl(options.startUrl);
  const maxPages = options.maxPages ?? 8;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  const fetchOptions = {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    maxBodyBytes: options.maxBodyBytes,
    maxRedirects: options.maxRedirects,
  };

  const robots = await loadRobots(start.origin, fetchOptions);
  const sitemap = await loadSitemap(start.origin, robots, fetchOptions);

  const pages = [];
  const discovered = new Map();
  const queue = [start.href];
  const seen = new Set(queue);

  while (queue.length > 0 && pages.length < maxPages) {
    const batch = [];
    while (batch.length < concurrency && queue.length > 0 && pages.length + batch.length < maxPages) {
      batch.push(queue.shift());
    }

    const results = await Promise.all(batch.map((url) => fetchPage(url, fetchOptions)));
    for (const page of results) {
      pages.push(page);
      if (!page.ok || !/text\/html/i.test(page.contentType)) continue;

      for (const link of extractLinks(page.body, page.finalUrl)) {
        if (!discovered.has(link.url)) discovered.set(link.url, link.foundOn);
        if (link.external || seen.has(link.url)) continue;
        const pathname = new URL(link.url).pathname;
        if (!isAllowedByRobots(pathname, robots)) continue;
        seen.add(link.url);
        queue.push(link.url);
      }
    }
  }

  return {
    origin: start.origin,
    startUrl: start.href,
    pages,
    discovered: [...discovered.entries()].map(([url, foundOn]) => ({ url, foundOn })),
    robots,
    sitemap,
    truncated: queue.length > 0,
  };
}
