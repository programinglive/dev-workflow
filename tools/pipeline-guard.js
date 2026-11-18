import { execFileSync } from "node:child_process";

const ACTIVE_GITLAB_STATUSES = new Set([
  "running",
  "pending",
  "preparing",
  "waiting_for_resource",
  "created",
]);

const ACTIVE_GITHUB_STATUSES = new Set([
  "in_progress",
  "queued",
  "waiting",
  "pending",
  "requested",
]);

/**
 * Parse a git origin remote URL into `{ provider, slug }`, or `null` if unknown.
 */
export function parseRemoteProvider(remoteUrl) {
  const raw = String(remoteUrl || "").trim();
  if (!raw) return null;

  const gitlabMatch = /gitlab\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/i.exec(raw);
  if (gitlabMatch) {
    return { provider: "gitlab", slug: gitlabMatch[1] };
  }

  const githubMatch = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/i.exec(raw);
  if (githubMatch) {
    return { provider: "github", slug: githubMatch[1] };
  }

  return null;
}

function defaultExec(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
    windowsHide: true,
  }).trim();
}

/**
 * Check if a CI/CD pipeline is currently active for the repository to prevent
 * concurrent deploy/release race conditions across multiple AI agent sessions.
 */
export function checkActivePipelinesBeforeRelease({
  projectDir,
  execFileSyncFn = null,
} = {}) {
  const run = execFileSyncFn || ((cmd, args) => defaultExec(cmd, args, projectDir));

  let remoteUrl = "";
  try {
    remoteUrl = String(run("git", ["remote", "get-url", "origin"]) || "").trim();
  } catch {
    return { ok: true, skipped: true, active: [], provider: null, message: "" };
  }

  const parsed = parseRemoteProvider(remoteUrl);
  if (!parsed) {
    return { ok: true, skipped: true, active: [], provider: null, message: "" };
  }

  try {
    if (parsed.provider === "gitlab") {
      const encoded = encodeURIComponent(parsed.slug);
      const raw = run("glab", ["api", `projects/${encoded}/pipelines?per_page=10`]);
      const list = JSON.parse(raw || "[]");
      const active = Array.isArray(list)
        ? list.filter((p) => ACTIVE_GITLAB_STATUSES.has(String(p?.status || "").toLowerCase()))
        : [];
      if (active.length === 0) {
        return { ok: true, skipped: false, active: [], provider: "gitlab", message: "" };
      }
      const lines = active
        .map((p) => `  • #${p.id} (${p.status}) ref=${p.ref || "-"} ${p.web_url || ""}`.trimEnd())
        .join("\n");
      return {
        ok: false,
        skipped: false,
        provider: "gitlab",
        active,
        message:
          `⚠️ Release/deploy blocked: ${active.length} active GitLab pipeline(s) already running for ${parsed.slug}.\n` +
          `Wait for the active pipeline to finish before starting a new release to avoid race conditions:\n${lines}`,
      };
    }

    if (parsed.provider === "github") {
      const raw = run("gh", [
        "run",
        "list",
        "--repo",
        parsed.slug,
        "--limit",
        "10",
        "--json",
        "databaseId,status,displayTitle,headBranch,url",
      ]);
      const list = JSON.parse(raw || "[]");
      const active = Array.isArray(list)
        ? list.filter((r) => ACTIVE_GITHUB_STATUSES.has(String(r?.status || "").toLowerCase()))
        : [];
      if (active.length === 0) {
        return { ok: true, skipped: false, active: [], provider: "github", message: "" };
      }
      const lines = active
        .map((r) => `  • #${r.databaseId} (${r.status}) branch=${r.headBranch || "-"} ${r.url || ""}`.trimEnd())
        .join("\n");
      return {
        ok: false,
        skipped: false,
        provider: "github",
        active,
        message:
          `⚠️ Release/deploy blocked: ${active.length} active GitHub Actions workflow(s) already running for ${parsed.slug}.\n` +
          `Wait for the active workflow to finish before starting a new release to avoid race conditions:\n${lines}`,
      };
    }
  } catch {
    return { ok: true, skipped: true, active: [], provider: parsed.provider, message: "" };
  }

  return { ok: true, skipped: true, active: [], provider: null, message: "" };
}
