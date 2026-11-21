/**
 * Reachability and transport signals.
 *
 * The audit can only judge what the server returned. A page that answers 200
 * but takes four seconds or ships an uncompressed megabyte is still a finding,
 * because the visitor pays that cost on every visit.
 */

export const SLOW_TTFB_MS = 1500;
export const VERY_SLOW_TTFB_MS = 3000;
export const LARGE_HTML_BYTES = 500 * 1024;
export const VERY_LARGE_HTML_BYTES = 1024 * 1024;

export function checkReachability({ pages = [], startPage = null } = {}) {
  const findings = [];
  const start = startPage || pages[0];
  if (!start) return findings;

  if (!start.ok) {
    findings.push({
      id: "reachability.http_error",
      category: "reachability",
      severity: "error",
      title: "The start page did not load",
      detail: start.error
        ? `The request failed: ${start.error}`
        : `The server answered with HTTP ${start.status}.`,
      remediation: "Confirm the URL, DNS, TLS, and the server health before auditing further.",
      url: start.requestedUrl,
      evidence: start.error ? start.error : `status: ${start.status}`,
    });
    return findings;
  }

  if (start.redirects.length > 0) {
    findings.push({
      id: "reachability.redirected",
      category: "reachability",
      severity: "info",
      title: "The start page redirects",
      detail: `The request followed ${start.redirects.length} redirect(s) before reaching ${start.finalUrl}.`,
      remediation: "Link directly to the final URL so every visitor avoids the extra round trip.",
      url: start.requestedUrl,
      evidence: start.redirects.map((hop) => `${hop.status} ${hop.url}`).join(" -> "),
    });
  }

  if (start.ttfbMs > VERY_SLOW_TTFB_MS) {
    findings.push({
      id: "reachability.very_slow_ttfb",
      category: "reachability",
      severity: "error",
      title: "The first byte arrives very slowly",
      detail: `The server took ${start.ttfbMs} ms to return the first byte of the start page.`,
      remediation: "Check origin latency, server-side rendering cost, and CDN cache hit rate.",
      url: start.finalUrl,
      evidence: `ttfb: ${start.ttfbMs} ms`,
    });
  } else if (start.ttfbMs > SLOW_TTFB_MS) {
    findings.push({
      id: "reachability.slow_ttfb",
      category: "reachability",
      severity: "warn",
      title: "The first byte arrives slowly",
      detail: `The server took ${start.ttfbMs} ms to return the first byte of the start page.`,
      remediation: "Check origin latency, server-side rendering cost, and CDN cache hit rate.",
      url: start.finalUrl,
      evidence: `ttfb: ${start.ttfbMs} ms`,
    });
  }

  if (start.bytes > VERY_LARGE_HTML_BYTES) {
    findings.push({
      id: "reachability.very_large_html",
      category: "reachability",
      severity: "error",
      title: "The HTML document is very large",
      detail: `The start page HTML is ${start.bytes} bytes before assets.`,
      remediation: "Move repeated data out of the HTML, paginate, or stream less markup.",
      url: start.finalUrl,
      evidence: `bytes: ${start.bytes}`,
    });
  } else if (start.bytes > LARGE_HTML_BYTES) {
    findings.push({
      id: "reachability.large_html",
      category: "reachability",
      severity: "warn",
      title: "The HTML document is large",
      detail: `The start page HTML is ${start.bytes} bytes before assets.`,
      remediation: "Move repeated data out of the HTML, paginate, or stream less markup.",
      url: start.finalUrl,
      evidence: `bytes: ${start.bytes}`,
    });
  }

  const encoded = Boolean(start.headers["content-encoding"]);
  if (!encoded && start.bytes > 1024) {
    findings.push({
      id: "reachability.uncompressed",
      category: "reachability",
      severity: "warn",
      title: "The HTML is not compressed",
      detail: "The response has no Content-Encoding, so the document travels at full size.",
      remediation: "Enable Brotli or gzip compression for HTML at the CDN or origin.",
      url: start.finalUrl,
      evidence: "content-encoding: (absent)",
    });
  }

  if (start.contentType && !/text\/html/i.test(start.contentType)) {
    findings.push({
      id: "reachability.content_type",
      category: "reachability",
      severity: "warn",
      title: "The start page is not served as HTML",
      detail: `The response Content-Type is ${start.contentType}.`,
      remediation: "Serve the page as text/html so the browser renders it as a document.",
      url: start.finalUrl,
      evidence: `content-type: ${start.contentType}`,
    });
  }

  for (const page of pages) {
    if (page.status >= 400) {
      findings.push({
        id: "reachability.page_error",
        category: "reachability",
        severity: "error",
        title: "A crawled page returned an error",
        detail: `HTTP ${page.status} was returned for ${page.finalUrl}.`,
        remediation: "Fix the route or remove the link that points to it.",
        url: page.finalUrl,
        evidence: `status: ${page.status}`,
      });
    }
  }

  return findings;
}
