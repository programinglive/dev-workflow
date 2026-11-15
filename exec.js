import { exec as execCallback, execFile as execFileCallback } from "child_process";
import { existsSync, lstatSync, statSync, readFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sanitize } from './security/sanitizer.js';

const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;
const POST_EXIT_PIPE_GRACE_MS = 150;

function runChildWithPipeCleanup(launcher) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exitCleanupTimer = null;

    const finish = (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (exitCleanupTimer) {
        clearTimeout(exitCleanupTimer);
        exitCleanupTimer = null;
      }
      if (err) {
        err.stdout = err.stdout ?? stdout ?? "";
        err.stderr = err.stderr ?? stderr ?? "";
        reject(err);
      } else {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    };

    const child = launcher(finish);

    // Close stdin immediately so non-interactive tool runs never block on prompts
    try {
      child.stdin?.end?.();
    } catch {
      // Ignore stdin close errors
    }

    // On Windows, grandchild processes spawned with stdio:'inherit' can hold
    // stdout/stderr pipe handles open indefinitely after the direct child exits,
    // preventing child_process.exec from ever emitting 'close'.
    child.once("exit", () => {
      if (settled) return;
      exitCleanupTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.stdout?.destroy?.();
        } catch {
          // Ignore stream destroy error
        }
        try {
          child.stderr?.destroy?.();
        } catch {
          // Ignore stream destroy error
        }
      }, POST_EXIT_PIPE_GRACE_MS);
      exitCleanupTimer.unref?.();
    });
  });
}

/**
 * Direktori paket server MCP ini.
 *
 * Penting: repo ini juga repo git. Kalau git dijalankan di sini, hasilnya
 * "No changes detected" sementara perubahan proyek tidak pernah ter-commit -
 * persis bug yang terjadi 29 Oktober 2026 saat `commit_and_push` melaporkan
 * commit `docs(release): catat rilis 1.12.3` milik repo paket, bukan repo kerja.
 */
export const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function isValidGitHeadContent(headContent) {
  const trimmed = String(headContent || "").trim();
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(trimmed)) return true;
  const refMatch = /^ref:[ \t]*([^\s\r\n]+)$/.exec(trimmed);
  if (!refMatch) return false;
  const ref = refMatch[1];
  if (!ref.startsWith("refs/")) return false;
  if (ref.includes("..") || ref.includes("//") || ref.includes("@{") || ref.endsWith("/") || ref.endsWith(".")) {
    return false;
  }
  if (/[ ~^:?*[\\]/.test(ref)) return false;
  for (let i = 0; i < ref.length; i += 1) {
    const code = ref.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  const parts = ref.split("/");
  return parts.length >= 2 && parts.every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

function isValidGitHead(headPath) {
  try {
    if (!existsSync(headPath)) return false;
    if (!statSync(headPath).isFile()) return false;
    return isValidGitHeadContent(readFileSync(headPath, "utf8"));
  } catch {
    return false;
  }
}

function isValidGitMarker(dir) {
  const gitPath = path.join(dir, ".git");
  let gitStat = null;
  try {
    gitStat = statSync(gitPath);
  } catch {
    return false;
  }
  if (gitStat.isFile()) {
    try {
      const content = readFileSync(gitPath, "utf8");
      const match = /^gitdir:\s*(.+)$/m.exec(content);
      if (!match || !match[1]) return false;
      const targetGitDir = path.resolve(dir, match[1].trim());
      if (!statSync(targetGitDir).isDirectory()) return false;
      return isValidGitHead(path.join(targetGitDir, "HEAD"));
    } catch {
      return false;
    }
  }
  if (gitStat.isDirectory()) {
    return isValidGitHead(path.join(gitPath, "HEAD"));
  }
  return false;
}

function findRepoRoot(startDir) {
  if (!startDir) {
    return null;
  }

  let current = path.resolve(startDir);
  const { root } = path.parse(current);

  while (true) {
    const markerPath = path.join(current, ".git");
    let markerPresent = false;
    try {
      lstatSync(markerPath);
      markerPresent = true;
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") {
        markerPresent = true;
      }
    }
    if (markerPresent) {
      return isValidGitMarker(current) ? current : null;
    }

    if (current === root) {
      return null;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * Direktori repo proyek yang aktif untuk pemanggilan ini.
 *
 * Kenapa ada: `WORKFLOW_PROJECT_DIR` adalah satu nilai global untuk seluruh
 * proses MCP. Di mesin ini nilainya `D:\code\clinic`, sehingga sesi yang
 * sebenarnya bekerja di repo lain tetap menjalankan git di clinic — dan
 * `commit_and_push` melaporkan "No changes detected" seolah sudah selesai.
 *
 * Direktori aktif diisi dari state sesi (`projectDir`), yang ditentukan saat
 * `start_task` atau saat `commit_and_push`/`perform_release` dipanggil dengan
 * argumen `projectDir` eksplisit.
 */
let activeProjectDir = "";

export function setActiveProjectDir(dir) {
  activeProjectDir = dir ? path.resolve(dir) : "";
  return activeProjectDir;
}

export function getActiveProjectDir() {
  return activeProjectDir;
}

function repoRootOrThrow(dir, message) {
  const root = findRepoRoot(dir);
  if (!root) {
    throw new Error(message);
  }
  return root;
}

/**
 * Menentukan direktori repo proyek, sekaligus melaporkan DARI MANA asalnya.
 *
 * Urutan (per 30 Oktober 2026):
 *   1. explicit  - argumen `projectDir` pada panggilan tool
 *   2. pinned    - `projectDir` yang dicatat `start_task` untuk sesi ini
 *   3. env       - WORKFLOW_PROJECT_DIR / PROJECT_DIR (setelan operator, global)
 *   4. cwd       - direktori kerja sesi (kandidat)
 *
 * `env` tetap di atas `cwd` karena ia setelan operator yang disengaja: kalau
 * seseorang menunjuk repo lewat env, ia bermaksud demikian.
 *
 * Yang berubah: env sekarang bisa DIKALAHKAN per sesi lewat `projectDir`, dan
 * bila env dipakai sementara direktori sesi menunjuk repo lain, konfliknya
 * dilaporkan (`conflict`). Sebelumnya tidak ada jalan keluar sama sekali:
 * satu nilai global membajak semua sesi, `git status` di repo yang salah
 * menjawab "bersih", dan workflow melaporkan sukses palsu.
 *
 * `source` dan `conflict` dipakai tool untuk memberi tahu pengguna repo mana
 * yang dipakai - dan kapan ia kemungkinan salah.
 */
function assertExistingDirectory(dir, label = "Direktori") {
  const trimmed = typeof dir === "string" ? dir.trim() : "";
  if (!trimmed || trimmed.includes("\0")) {
    throw new Error(`${label} "${dir}" tidak valid.`);
  }
  const resolved = path.resolve(trimmed);
  let stat = null;
  try {
    stat = statSync(resolved);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    throw new Error(`${label} "${resolved}" tidak ada atau bukan direktori yang valid.`);
  }
  return resolved;
}

export function resolveProjectDir({ explicit = "", pinned = "", env = process.env, candidates = [] } = {}) {
  if (explicit) {
    const resolvedExplicit = assertExistingDirectory(explicit, "projectDir");
    return {
      dir: repoRootOrThrow(resolvedExplicit, `Direktori "${explicit}" bukan repo git (tidak ada .git).`),
      source: "explicit",
      conflict: null,
    };
  }

  if (pinned) {
    const resolvedPinned = assertExistingDirectory(pinned, "projectDir sesi");
    return {
      dir: repoRootOrThrow(
        resolvedPinned,
        `projectDir sesi "${pinned}" bukan repo git (tidak ada .git). ` +
        "Perbaiki dengan memanggil 'start_task' lagi dengan projectDir yang benar.",
      ),
      source: "pinned",
      conflict: null,
    };
  }

  const found = candidates.map((candidate) => findRepoRoot(candidate)).filter(Boolean);
  const cwdRepo = found.find((dir) => !samePath(dir, PACKAGE_DIR)) || null;
  const packageCandidate = found.some((dir) => samePath(dir, PACKAGE_DIR));

  const envDir = (env.WORKFLOW_PROJECT_DIR || env.PROJECT_DIR || "").trim();
  if (envDir) {
    const envRepo = repoRootOrThrow(envDir, `WORKFLOW_PROJECT_DIR "${envDir}" bukan repo git (tidak ada .git).`);
    return {
      dir: envRepo,
      source: "env",
      // Direktori sesi menunjuk repo lain: kemungkinan besar env ini milik
      // proyek lain, dan git akan berjalan di repo yang salah.
      conflict: cwdRepo && !samePath(cwdRepo, envRepo) ? { envDir: envRepo, cwdDir: cwdRepo } : null,
    };
  }

  if (cwdRepo) {
    return { dir: cwdRepo, source: "cwd", conflict: null };
  }

  // Hanya repo paket yang ditemukan. Itu hanya mungkin bila salah satu kandidat
  // benar-benar berada di dalamnya, jadi pemanggil memilih repo ini dengan sadar.
  if (packageCandidate) {
    return { dir: path.resolve(PACKAGE_DIR), source: "cwd", conflict: null };
  }

  throw new Error(
    "Tidak bisa menentukan repo proyek: tidak ada repository git pada " +
    `${candidates.filter(Boolean).map((candidate) => `"${candidate}"`).join(", ") || "direktori kerja"}. ` +
    "Sebutkan 'projectDir' pada 'start_task' (disarankan), atau set WORKFLOW_PROJECT_DIR, " +
    "atau jalankan server MCP dari dalam direktori proyek.",
  );
}

/**
 * Penentu direktori repo proyek tempat git boleh dijalankan.
 *
 * Urutan: eksplisit -> WORKFLOW_PROJECT_DIR/PROJECT_DIR -> kandidat.
 *
 * Repo paket MCP sengaja tidak dipilih sebagai cadangan: dulu server pernah
 * menjalankan git di repo-nya sendiri saat cwd proyek gagal diresolusi, lalu
 * melaporkan "No changes detected" sementara perubahan proyek tidak pernah
 * ter-commit.
 *
 * Tetapi kandidat yang MEMANG berada di dalam repo paket berarti pemanggil
 * sengaja bekerja di sana - misalnya saat mengembangkan server MCP ini sendiri.
 * Membuangnya tanpa syarat membuat `commit_and_push` mustahil dipakai di repo
 * paket, jadi kandidat seperti itu diterima. Repo proyek lain tetap menang.
 */
export function resolveWorkingDirectory(options = {}) {
  return resolveProjectDir(options).dir;
}

function getDefaultCwd(command) {
  try {
    return resolveProjectDir({
      explicit: activeProjectDir,
      env: process.env,
      candidates: [process.cwd(), process.env.INIT_CWD],
    }).dir;
  } catch (error) {
    // Perintah non-git (echo, npm run release, ...) tidak butuh repo proyek.
    // Yang berbahaya hanya git: di sana cwd menentukan repo mana yang diubah.
    if (/^\s*git\b/i.test(String(command))) {
      throw error;
    }
    return process.cwd();
  }
}

export async function exec(command, options = {}) {
  const { executable, arguments: args, ...runtimeOptions } = options;
  const baseOptions = {
    windowsHide: true,
    maxBuffer: DEFAULT_MAX_BUFFER,
    ...runtimeOptions,
  };
  const execOptions = baseOptions.cwd
    ? baseOptions
    : { ...baseOptions, cwd: getDefaultCwd(executable || command) };
  try {
    const rawResult = await runChildWithPipeCleanup((cb) =>
      executable
        ? execFileCallback(executable, args, { ...execOptions, shell: false }, cb)
        : execCallback(command, execOptions, cb)
    );
    return sanitize(rawResult);
  } catch (error) {
    const safe = new Error(sanitize(error.message));
    safe.code = error.code;
    safe.stdout = sanitize(error.stdout || "");
    safe.stderr = sanitize(error.stderr || "");
    throw safe;
  }
}
