/**
 * Report assembly and scoring.
 *
 * Scoring is deliberately simple and explainable: a category starts at 100 and
 * loses a fixed amount per finding. A number a reader can reproduce by hand is
 * more useful than a weighted model nobody trusts.
 */

export const SEVERITY_WEIGHT = Object.freeze({ error: 25, warn: 8, info: 1 });
export const SEVERITY_ORDER = Object.freeze(["error", "warn", "info"]);

export function scoreCategory(findings) {
  const penalty = findings.reduce((total, finding) => {
    return total + (SEVERITY_WEIGHT[finding.severity] ?? 0);
  }, 0);
  return Math.max(0, 100 - penalty);
}

export function summarize(findings) {
  const summary = { errors: 0, warnings: 0, infos: 0 };
  for (const finding of findings) {
    if (finding.severity === "error") summary.errors += 1;
    else if (finding.severity === "warn") summary.warnings += 1;
    else summary.infos += 1;
  }
  return summary;
}

export function buildReport({
  requestedUrl,
  finalUrl,
  startedAt,
  durationMs,
  pages = [],
  findings = [],
  checks = [],
  robots = null,
  sitemap = null,
  truncated = false,
} = {}) {
  const counts = summarize(findings);

  const categories = {};
  for (const name of checks) {
    const categoryFindings = findings.filter((finding) => finding.category === name);
    categories[name] = {
      score: scoreCategory(categoryFindings),
      findings: categoryFindings.length,
    };
  }

  const scores = Object.values(categories).map((category) => category.score);
  const score = scores.length > 0
    ? Math.round(scores.reduce((total, value) => total + value, 0) / scores.length)
    : 100;

  const status = counts.errors > 0 ? "fail" : counts.warnings > 0 ? "warn" : "pass";

  return {
    schemaVersion: 1,
    tool: "site_audit",
    requestedUrl,
    finalUrl,
    startedAt,
    durationMs,
    summary: {
      status,
      score,
      errors: counts.errors,
      warnings: counts.warnings,
      infos: counts.infos,
      pagesScanned: pages.length,
      truncated,
    },
    pages: pages.map((page) => ({
      url: page.finalUrl,
      status: page.status,
      ok: page.ok,
      ttfbMs: page.ttfbMs,
      bytes: page.bytes,
      truncated: page.truncated,
      contentType: page.contentType,
      redirects: page.redirects.length,
    })),
    categories,
    robots,
    sitemap,
    findings,
  };
}

export function formatHumanReport(report) {
  const lines = [];
  const { summary } = report;

  lines.push(`Site audit: ${report.finalUrl || report.requestedUrl}`);
  lines.push(
    `Status: ${summary.status.toUpperCase()} | Score: ${summary.score}/100 | ` +
    `Errors: ${summary.errors} | Warnings: ${summary.warnings} | Info: ${summary.infos}`,
  );
  lines.push(
    `Pages scanned: ${summary.pagesScanned} | Duration: ${report.durationMs} ms` +
    (summary.truncated ? " | Crawl budget reached" : ""),
  );

  if (report.findings.length === 0) {
    lines.push("");
    lines.push("No findings. The audited surface matches the v1 baseline.");
    return lines.join("\n");
  }

  for (const severity of SEVERITY_ORDER) {
    const group = report.findings.filter((finding) => finding.severity === severity);
    if (group.length === 0) continue;

    lines.push("");
    lines.push(`${severity.toUpperCase()} (${group.length})`);
    for (const finding of group) {
      lines.push(`- [${finding.id}] ${finding.title}`);
      lines.push(`  URL: ${finding.url}`);
      lines.push(`  Why: ${finding.detail}`);
      lines.push(`  Fix: ${finding.remediation}`);
    }
  }

  return lines.join("\n");
}
