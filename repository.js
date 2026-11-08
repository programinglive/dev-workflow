/**
 * Repository identity for a task.
 *
 * A task card that only says "clinic" does not answer "where is the project?".
 * The local path is the direct answer for the machine that runs the session, and
 * the git remote is the answer that still works from another device.
 *
 * This module is best-effort by design: a task outside a git repository is
 * valid, and a failing `git` call must never stop `start_task`.
 */

import { exec as execCallback } from "node:child_process";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalize the two `git` outputs. Kept pure so it can be tested without git.
 */
export function parseRepositoryOutput({ toplevel, remote } = {}) {
  return {
    path: text(toplevel).split(/\r?\n/)[0] || "",
    remote: text(remote).split(/\r?\n/)[0] || "",
  };
}

async function defaultExec(command, options) {
  return new Promise((resolve, reject) => {
    execCallback(command, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** Quote a path for use as a shell argument without changing its meaning. */
function quote(value) {
  const raw = String(value || "");
  if (process.platform === "win32") return `"${raw.replace(/"/g, '\\"')}"`;
  return `'${raw.replace(/'/g, "'\\''")}'`;
}

/**
 * Read the repository root and origin URL for `dir`.
 *
 * Returns `{ path: "", remote: "" }` for a directory that is not a git
 * repository, and never throws.
 */
export async function captureRepository({ dir, execImpl = defaultExec } = {}) {
  const target = text(dir);
  if (!target) return { path: "", remote: "" };

  const run = async (command) => {
    try {
      const result = await execImpl(command, { timeout: 5000 });
      return text(result && result.stdout);
    } catch {
      return "";
    }
  };

  const toplevel = await run(`git -C ${quote(target)} rev-parse --show-toplevel`);
  if (!toplevel) return { path: "", remote: "" };
  const remote = await run(`git -C ${quote(target)} remote get-url origin`);
  return parseRepositoryOutput({ toplevel, remote });
}

export { quote as quoteShellArgument };
