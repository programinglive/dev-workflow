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

/**
 * `git status --porcelain` -> [{code, path}].
 *
 * Dipakai untuk dua hal: mencatat berkas yang SUDAH kotor saat `start_task`
 * (baseline), dan membandingkannya lagi saat commit. Tanpa ini, `git add .`
 * tidak bisa membedakan pekerjaan sesi ini dari pekerjaan sesi lain.
 *
 * Path TIDAK dibaca dengan `slice(3)`: format porcelain adalah `XY path`
 * (X = index, Y = worktree), jadi perubahan yang belum di-stage berbentuk
 * `" M path"` sementara berkas baru berbentuk `"?? path"`. Memotong kolom tetap
 * memakan huruf pertama nama berkas - pernah menghasilkan `nowledge/...`.
 */
export function parseStatusEntries(statusOutput) {
  if (typeof statusOutput !== "string") {
    return [];
  }

  return statusOutput
    .split("\n")
    .filter((line) => line && line.trim().length > 0)
    .map((line) => {
      const match = /^\s*([MADRCU?!]{1,2})\s+(.*)$/.exec(line);
      if (!match) {
        return null;
      }
      const rawPath = match[2].trim();
      const target = rawPath.includes(" -> ")
        ? rawPath.split(" -> ").pop().trim()
        : rawPath;
      return target ? { code: match[1], path: target } : null;
    })
    .filter(Boolean);
}

/**
 * Berkas yang sudah kotor SEBELUM task dimulai dan masih kotor sekarang.
 *
 * Ini satu-satunya atribusi yang bisa dipercaya: berkas yang sudah kotor di
 * baseline bukan hasil pekerjaan sesi ini. Berkas baru yang muncul selama task
 * sengaja TIDAK masuk sini - tidak ada cara membedakan berkas baru milik kita
 * dari berkas baru milik sesi lain, dan menebaknya akan menghasilkan tuduhan
 * palsu yang membuat fitur ini diabaikan.
 */
export function foreignDirtyEntries(baselineEntries, statusOutput) {
  const baseline = new Set(
    (Array.isArray(baselineEntries) ? baselineEntries : [])
      .map((entry) => String(entry?.path || "").trim())
      .filter(Boolean),
  );
  if (baseline.size === 0) {
    return [];
  }

  return parseStatusEntries(statusOutput).filter((entry) => baseline.has(entry.path));
}

/**
 * Apakah SELURUH working tree hanya berisi berkas yang sudah kotor sejak
 * `start_task`.
 *
 * Dipakai `perform_release`. Sebelumnya rilis menuntut working tree benar-benar
 * bersih, dan itu benar selama commit menyapu semua. Setelah `commit_and_push`
 * sengaja MENINGGALKAN pekerjaan sesi lain, syarat itu berubah jadi jebakan:
 * rilis menolak selamanya dan menyarankan "commit or stash", padahal
 * meng-commit berkas itu justru yang kita cegah.
 *
 * Mengembalikan false kalau baseline kosong: tanpa baseline tidak ada dasar
 * untuk menyatakan sesuatu "bukan milik kita", jadi perilaku lama dipertahankan.
 */
export function hasOnlyForeignChanges(baselineEntries, statusOutput) {
  const baseline = new Set(
    (Array.isArray(baselineEntries) ? baselineEntries : [])
      .map((entry) => String(entry?.path || "").trim())
      .filter(Boolean),
  );
  if (baseline.size === 0) {
    return false;
  }

  const current = parseStatusEntries(statusOutput);
  if (current.length === 0) {
    return false;
  }

  return current.every((entry) => baseline.has(entry.path));
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

/**
 * SHA commit yang sedang di HEAD.
 *
 * Dipakai untuk membuktikan bahwa push benar-benar mengirim commit ini, bukan
 * hanya "git push" yang keluar 0 tanpa memindahkan apa pun.
 */
export async function getHeadSha() {
  const { stdout } = await exec("git rev-parse HEAD");
  return stdout.trim();
}

/**
 * SHA yang tercatat pada remote-tracking ref `origin/<branch>`.
 * Melempar bila branch itu belum ada di remote.
 */
export async function getRemoteBranchSha(branch) {
  const { stdout } = await exec("git rev-parse", {
    executable: "git",
    arguments: ["rev-parse", `origin/${branch}`],
  });
  return stdout.trim();
}

export async function getStatusOutput() {
  const { stdout } = await exec("git status --porcelain");
  return stdout;
}

/**
 * Direktori teratas repo tempat git BENAR-BENAR berjalan.
 *
 * `git rev-parse --show-toplevel` menjawab dari repo yang aktif, bukan dari
 * tebakan kita tentang direktori mana yang dimaksud. Dipakai untuk memastikan
 * laporan `commit_and_push` menyebut repo yang sama dengan yang di-commit.
 */
export async function getToplevel() {
  const { stdout } = await exec("git rev-parse --show-toplevel");
  return stdout.trim();
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
