import { exec as execCallback, execFile as execFileCallback } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { sanitize } from './security/sanitizer.js';

const execPromise = promisify(execCallback);
const execFilePromise = promisify(execFileCallback);

/**
 * Direktori paket server MCP ini.
 *
 * Penting: repo ini juga repo git. Kalau git dijalankan di sini, hasilnya
 * "No changes detected" sementara perubahan proyek tidak pernah ter-commit -
 * persis bug yang terjadi 29 Oktober 2026 saat `commit_and_push` melaporkan
 * commit `docs(release): catat rilis 1.12.3` milik repo paket, bukan repo kerja.
 */
export const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(startDir) {
  if (!startDir) {
    return null;
  }

  let current = path.resolve(startDir);
  const { root } = path.parse(current);

  while (true) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
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
 * Menentukan direktori repo proyek tempat git boleh dijalankan.
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
export function resolveWorkingDirectory({ explicit = "", env = process.env, candidates = [] } = {}) {
  if (explicit) {
    const root = findRepoRoot(explicit);
    if (!root) {
      throw new Error(`Direktori "${explicit}" bukan repo git (tidak ada .git).`);
    }
    return root;
  }

  const envDir = (env.WORKFLOW_PROJECT_DIR || env.PROJECT_DIR || "").trim();
  if (envDir) {
    const root = findRepoRoot(envDir);
    if (!root) {
      throw new Error(`WORKFLOW_PROJECT_DIR "${envDir}" bukan repo git (tidak ada .git).`);
    }
    return root;
  }

  const found = candidates.map((candidate) => findRepoRoot(candidate)).filter(Boolean);

  const projectRepo = found.find((dir) => !samePath(dir, PACKAGE_DIR));
  if (projectRepo) {
    return projectRepo;
  }

  // Hanya repo paket yang ditemukan. Itu hanya mungkin bila salah satu kandidat
  // benar-benar berada di dalamnya, jadi pemanggil memilih repo ini dengan sadar.
  if (found.some((dir) => samePath(dir, PACKAGE_DIR))) {
    return path.resolve(PACKAGE_DIR);
  }

  throw new Error(
    "Tidak bisa menentukan repo proyek: tidak ada repository git pada " +
    `${candidates.filter(Boolean).map((candidate) => `"${candidate}"`).join(", ") || "direktori kerja"}. ` +
    "Set WORKFLOW_PROJECT_DIR ke direktori proyek, atau jalankan server MCP dari dalam direktori proyek.",
  );
}

function getDefaultCwd(command) {
  try {
    return resolveWorkingDirectory({
      env: process.env,
      candidates: [process.cwd(), process.env.INIT_CWD],
    });
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
  const {executable,arguments:args,...runtimeOptions}=options;
  const execOptions = runtimeOptions.cwd ? runtimeOptions : { ...runtimeOptions, cwd: getDefaultCwd(executable || command) };
  try { return sanitize(await (executable ? execFilePromise(executable,args,{...execOptions,shell:false}) : execPromise(command, execOptions))); }
  catch(error) {
    const safe=new Error(sanitize(error.message));
    safe.code=error.code;
    safe.stdout=sanitize(error.stdout || '');
    safe.stderr=sanitize(error.stderr || '');
    throw safe;
  }
}
