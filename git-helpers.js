import { exec } from "./exec.js";

export async function hasStagedChanges() {
  const { stdout } = await exec("git status --porcelain");
  return stdout
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      const indexStatus = line[0];
      return indexStatus && indexStatus !== " " && indexStatus !== "?";
    });
}

/**
 * Apakah ada perubahan yang belum di-commit?
 *
 * MENGAPA TIDAK `catch { return false }`
 * --------------------------------------
 * Dulu fungsi ini menelan setiap error git dan menjawab `false`. Pemanggil
 * membacanya sebagai "tidak ada perubahan", lalu `commit_and_push` menjawab
 * "No changes detected. Assuming commit and push already completed" - sukses
 * palsu, padahal tidak ada commit sama sekali.
 *
 * Yang terjadi 30 Oktober 2026: server MCP dijalankan dengan cwd direktori sesi
 * OpenCode (`Documents\Default Project`) yang bukan repo git. `git status`
 * gagal, error ditelan, delapan berkas tidak pernah ter-commit, dan tool tetap
 * melaporkan berhasil.
 *
 * "Tidak tahu" bukan "tidak ada perubahan". Sekarang error diteruskan supaya
 * pemanggil bisa melaporkan masalah sebenarnya.
 */
export async function hasWorkingChanges() {
  const { stdout } = await exec("git status --porcelain");
  return stdout.split("\n").some((line) => line && line.trim().length > 0);
}

export function workingTreeSummary(statusOutput) {
  if (typeof statusOutput !== "string" || statusOutput.trim() === "") {
    return {
      hasChanges: false,
      lines: [],
    };
  }

  const lines = statusOutput
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return {
    hasChanges: lines.length > 0,
    lines,
  };
}

function isTestFilePath(filePath) {
  if (!filePath) {
    return false;
  }

  if (/\.(test|spec)\.[^.]+$/i.test(filePath)) {
    return true;
  }

  return /(\/|^)(__tests__|tests?|spec)\//i.test(filePath);
}

function extractPathFromStatusLine(line) {
  if (!line || line.length < 4) {
    return "";
  }

  const rawPath = line.slice(3).trim();
  if (!rawPath) {
    return "";
  }

  if (rawPath.includes(" -> ")) {
    const parts = rawPath.split(" -> ");
    return parts[parts.length - 1].trim();
  }

  return rawPath;
}

export function containsTestFilesInStatus(statusOutput) {
  if (typeof statusOutput !== "string" || statusOutput.trim() === "") {
    return false;
  }

  return statusOutput
    .split("\n")
    .map((line) => extractPathFromStatusLine(line))
    .some((path) => isTestFilePath(path));
}

function parseNameStatusLine(line) {
  if (!line) {
    return null;
  }

  const parts = line.split("\t").map((part) => part.trim());
  const status = parts[0];
  if (!status) {
    return null;
  }

  if (status.startsWith("R") || status.startsWith("C")) {
    const originalPath = parts[1] || "";
    const newPath = parts[2] || originalPath;
    return {
      status,
      path: newPath,
      originalPath,
    };
  }

  return {
    status,
    path: parts[1] || "",
    originalPath: "",
  };
}

export async function getStagedChanges() {
  const { stdout } = await exec("git diff --cached --name-status");
  return stdout
    .split("\n")
    .map((line) => parseNameStatusLine(line))
    .filter(Boolean);
}

export async function hasTestChanges() {
  const { stdout } = await exec("git status --porcelain");
  return containsTestFilesInStatus(stdout);
}

export async function getLastCommitMessage() {
  const { stdout } = await exec("git log -1 --pretty=%B");
  return stdout.trim();
}

export async function getCurrentBranch() {
  const { stdout } = await exec("git rev-parse --abbrev-ref HEAD");
  return stdout.trim();
}

export async function getStatusOutput() {
  const { stdout } = await exec("git status --porcelain");
  return stdout;
}

export async function getPrimaryBranch() {
  try {
    // Check if 'main' exists on origin
    const { stdout: mainCheck } = await exec("git rev-parse --verify origin/main");
    if (mainCheck.trim()) {
      return "main";
    }
  } catch {
    // main doesn't exist, fall through to master check
  }

  try {
    // Check if 'master' exists on origin
    const { stdout: masterCheck } = await exec("git rev-parse --verify origin/master");
    if (masterCheck.trim()) {
      return "master";
    }
  } catch {
    // master doesn't exist either
  }

  // Fallback to current branch if neither main nor master exist
  return await getCurrentBranch();
}
