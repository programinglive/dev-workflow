import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shellEscape } from "./utils.js";

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

/**
 * What Windows tries when PATHEXT is missing from the environment.
 *
 * cmd resolves a bare name through PATHEXT; a probe that skips that step either
 * finds nothing or runs the wrong file, so the fallback mirrors the shell order.
 */
const WINDOWS_DEFAULT_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];

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
 * Finds the file a bare tool name actually runs on this machine.
 *
 * WHY NOT LET THE SHELL DO IT
 * ---------------------------
 * The old probe built `"npm" "--version"` and handed it to cmd. On Windows npm
 * is a batch shim, and quoting the command name makes `%0` be `"npm"`, so
 * `%~dp0` inside the shim points at the CURRENT DIRECTORY and node cannot find
 * npm-cli.js. npm and gcloud were therefore reported as missing on two machines
 * where both were installed and working. Resolving the absolute path first
 * removes the shell from the question - and the resolved path is also the
 * evidence the fleet report needs ("where does this version come from?").
 *
 * A name carrying a path separator is refused: this resolver answers "where is
 * this tool on PATH", not "run this path".
 *
 * @param {string} tool
 * @param {{ platform?: string, env?: object, isFile?: (p: string) => boolean }} options
 * @returns {string|null} absolute path, or null when the tool is not on PATH
 */
export function resolveExecutable(
  tool,
  { platform = process.platform, env = process.env, isFile = defaultIsFile } = {}
) {
  const name = typeof tool === "string" ? tool.trim() : "";
  if (!name) return null;
  if (name === "." || name === ".." || /[/\\]/.test(name)) return null;

  const pathValue = typeof env.PATH === "string" ? env.PATH : typeof env.Path === "string" ? env.Path : "";
  if (!pathValue) return null;

  const separator = platform === "win32" ? ";" : ":";
  // The platform is injected (tests, cross-platform reports), so the join has to
  // match it rather than whatever host this code happens to run on.
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const directories = pathValue
    .split(separator)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);

  const declared = platform === "win32" ? String(env.PATHEXT || "") : "";
  const extensions =
    platform === "win32"
      ? declared
        ? declared.split(";").filter(Boolean)
        : WINDOWS_DEFAULT_EXTENSIONS
      : [""];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function defaultIsFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Builds the probe `detectToolchain` calls for each tool.
 *
 * TWO EXECUTION PATHS, BECAUSE WINDOWS HAS TWO KINDS OF COMMAND
 * -------------------------------------------------------------
 * A native `.exe` runs directly: no shell, no quoting, an argument array.
 *
 * A `.cmd`/`.bat` shim cannot be spawned directly (node refuses without a
 * shell), and when it does run through cmd the script needs `%~dp0` - derived
 * from `%0` - to point at its own folder. That is why the ABSOLUTE path is
 * passed as one quoted token: `"C:\Program Files\nodejs\npm.cmd" "--version"`.
 * Quoting a bare name instead (`"npm" "--version"`) makes `%~dp0` resolve to the
 * current directory, so npm looked for `C:\Users\...\node_modules\npm\bin`, and
 * npm, gcloud and wrangler were reported as missing on machines that had them.
 *
 * An unresolved tool throws, which `detectToolchain` records as null: absence is
 * a fact to report, not a crash.
 */
export function createToolchainProbe({
  exec,
  resolve = resolveExecutable,
  timeoutMs = 4000,
  platform = process.platform,
} = {}) {
  if (typeof exec !== "function") throw new Error("createToolchainProbe requires an exec function");
  return async (tool, args = []) => {
    const executable = resolve(tool);
    if (!executable) throw new Error(`${tool}_not_found`);

    if (platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
      const command = [executable, ...args].map((token) => shellEscape(token, { platform })).join(" ");
      const { stdout } = await exec(command, { timeout: timeoutMs });
      return stdout;
    }

    const { stdout } = await exec(executable, { executable, arguments: args, timeout: timeoutMs });
    return stdout;
  };
}

/**
 * Compares detected versions against the pinned fleet manifest.
 *
 * Three states, because they need different actions: `ok` (nothing to do),
 * `drift` (a real version difference), and `missing` (the tool is not on PATH -
 * which after the resolver fix means it truly is not installed).
 */
export function compareToolchainToManifest(manifest, detected = {}) {
  const pinned = manifest && typeof manifest.tools === "object" && manifest.tools ? manifest.tools : {};
  const rows = Object.keys(pinned)
    .sort()
    .map((tool) => {
      const expected = pinned[tool];
      const actual = detected && Object.prototype.hasOwnProperty.call(detected, tool) ? detected[tool] : null;
      const status = !actual ? "missing" : actual === expected ? "ok" : "drift";
      return { tool, pinned: expected, actual: actual || null, status };
    });
  const mismatched = rows.filter((row) => row.status !== "ok").map((row) => row.tool);
  return { rows, mismatched, inSync: mismatched.length === 0 };
}

/** Where the pinned manifest lives, next to this module. */
export function fleetManifestPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "managed", "fleet-toolchain.json");
}

/**
 * Reads the pinned fleet manifest.
 *
 * Returns null when it is absent or unreadable: a manifest that cannot be read
 * must not silently become "no pins", because then every machine looks correct.
 */
export function loadFleetManifest({ file = fleetManifestPath() } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

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
