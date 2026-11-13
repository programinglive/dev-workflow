/**
 * Which command-line tools the fleet is expected to have.
 *
 * OWNER REQUEST (10 November 2026)
 * --------------------------------
 * "We must all have the same tools: gh, glab, wrangler, gcloud, etc." A device
 * that is missing one of these cannot run the same work as the others, and the
 * failure only shows up later as a confusing command-not-found in the middle of
 * a task. Reporting the versions makes the gap visible before it bites.
 *
 * WHY A FIXED LIST AND NOT "WHATEVER IS INSTALLED"
 * -----------------------------------------------
 * The point is parity, which needs a shared expectation. Listing whatever
 * happens to exist on one machine would make every machine look complete.
 */
export const REQUIRED_TOOLS = ["gh", "glab", "wrangler", "gcloud", "node", "npm"];

/** How each tool is asked for its version. */
const VERSION_ARGS = {
  gh: ["--version"],
  glab: ["--version"],
  wrangler: ["--version"],
  gcloud: ["--version"],
  node: ["--version"],
  npm: ["--version"],
};

/**
 * Extracts a version from one tool's own output.
 *
 * Every tool prints differently: `gh version 2.40.1 (date)`, `v20.11.0`,
 * `Google Cloud SDK 458.0.0` followed by component lines. A single semver-shaped
 * match handles all of them, and the leading `v` is dropped so `v20.11.0` and
 * `20.11.0` compare equal.
 *
 * Returns null when nothing version-shaped is present. Null means "missing or
 * unreadable", which the monitor shows as missing rather than inventing a value.
 */
export function parseToolVersion(tool, output) {
  const text = typeof output === "string" ? output : "";
  if (!text.trim()) return null;

  // gcloud prints the SDK version on the first line and component versions
  // below it; taking the first match keeps the SDK version.
  const match = /(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)/.exec(text);
  if (!match) return null;
  return match[1];
}

/**
 * Detects the version of every required tool.
 *
 * BOUNDED ON PURPOSE
 * ------------------
 * This runs inside the MCP server, which must never hang on a slow or missing
 * binary. Each probe gets its own timeout, a failure is recorded as null, and
 * the whole result is cached for the life of the process: a tool does not change
 * version mid-session, and re-probing on every snapshot would spawn processes
 * dozens of times per task.
 *
 * @param {{ run?: (tool: string, args: string[]) => Promise<string>, timeoutMs?: number }} options
 * @returns {Promise<Record<string, string|null>>}
 */
export async function detectToolchain({ run, timeoutMs = 4000 } = {}) {
  const result = {};
  if (typeof run !== "function") {
    for (const tool of REQUIRED_TOOLS) result[tool] = null;
    return result;
  }

  await Promise.all(
    REQUIRED_TOOLS.map(async (tool) => {
      try {
        const output = await Promise.race([
          run(tool, VERSION_ARGS[tool] || ["--version"]),
          new Promise((resolve) => setTimeout(() => resolve(""), timeoutMs)),
        ]);
        result[tool] = parseToolVersion(tool, output);
      } catch {
        // A missing binary is a fact to report, not an error to raise.
        result[tool] = null;
      }
    })
  );

  return result;
}

let cached = null;

/**
 * The process-wide toolchain, detected once.
 *
 * A failed detection is cached too: retrying on every snapshot would spawn the
 * same failing processes over and over for no new information.
 */
export async function toolchainOnce({ run } = {}) {
  if (cached) return cached;
  cached = await detectToolchain({ run });
  return cached;
}

/** Test hook: forget the cached result. */
export function resetToolchainCache() {
  cached = null;
}
