/**
 * Read-only discovery of workflow sessions on this machine.
 *
 * WHY NOT ASK THE MONITOR
 * -----------------------
 * `drop` and `complete` must change a session's own state file and report the
 * outcome to Zettly. The monitor knows the session's *name*; only the machine
 * holds its *state*. So the target is resolved here, on disk.
 *
 * WHY AMBIGUITY IS A REFUSAL
 * --------------------------
 * The same session key can appear under two users (two people, one project, or
 * a copied state directory). Picking one would silently act on a coin flip, and
 * the losing side is a deleted task. Two matches is therefore an error that
 * names both paths and asks for a narrower target.
 *
 * Nothing in this module writes. It is discovery and parsing only.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliError } from "./args.js";

const STATE_FILE_PATTERN = /^workflow-state\.(.+)\.json$/;

function findProjectsDir(root) {
  const direct = path.join(root, "projects");
  if (existsSync(direct)) return direct;

  // A caller may point at the directory that CONTAINS `projects`.
  if (path.basename(root) === "projects" && existsSync(root)) return root;

  // ...or at one project directory, which holds `users/`.
  if (existsSync(path.join(root, "users"))) {
    const parent = path.dirname(root);
    if (path.basename(parent) === "projects") return parent;
  }

  throw new CliError(
    `No "projects" directory under ${root}. Point DEVWF_STATE_ROOT at the base state directory.`
  );
}

/** Every state file under the tree, with its user directory for messages. */
function collectStateFiles({ root, key = null }) {
  const projectsDir = findProjectsDir(root);
  const matches = [];

  for (const projectEntry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const usersDir = path.join(projectsDir, projectEntry.name, "users");
    if (!existsSync(usersDir)) continue;

    for (const userEntry of readdirSync(usersDir, { withFileTypes: true })) {
      if (!userEntry.isDirectory()) continue;
      const userDir = path.join(usersDir, userEntry.name);

      for (const name of readdirSync(userDir)) {
        const match = STATE_FILE_PATTERN.exec(name);
        if (!match) continue;
        if (key !== null && match[1] !== key) continue;
        matches.push({
          key: match[1],
          user: userEntry.name,
          project: projectEntry.name,
          file: path.join(userDir, name),
        });
      }
    }
  }
  return matches;
}

function readStateFile(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new CliError(`State file is unreadable: ${file} (${String(error?.message || error)})`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new CliError(`State file is corrupt and cannot be parsed: ${file}`);
  }
  if (!state || typeof state !== "object") {
    throw new CliError(`State file does not contain an object: ${file}`);
  }
  return state;
}

/** Resolves exactly one session by key. Zero or many matches is a refusal. */
export function findSession({ root, key }) {
  const target = typeof key === "string" ? key.trim() : "";
  if (!target) {
    throw new CliError("A session key is required. There is no implicit current session.");
  }

  const matches = collectStateFiles({ root, key: target });
  if (matches.length === 0) {
    throw new CliError(
      `Unknown session "${target}": no workflow-state.${target}.json under ${root}.`
    );
  }
  if (matches.length > 1) {
    const where = matches.map((m) => `${m.project}/${m.user}`).join(", ");
    throw new CliError(
      `Session "${target}" is ambiguous: found under ${where}. Remove the stale copy before acting.`
    );
  }

  const found = matches[0];
  return { ...found, state: readStateFile(found.file) };
}

/** Every session in the tree, for `devwf list` on a machine without a monitor. */
export function listSessions({ root }) {
  return collectStateFiles({ root }).map((entry) => {
    const state = readStateFile(entry.file);
    return {
      key: entry.key,
      user: entry.user,
      project: entry.project,
      file: entry.file,
      phase: typeof state.currentPhase === "string" ? state.currentPhase : "idle",
      taskDescription:
        typeof state.taskDescription === "string" ? state.taskDescription : "",
    };
  });
}
