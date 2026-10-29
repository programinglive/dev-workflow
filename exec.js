import { exec as execCallback } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";

const execPromise = promisify(execCallback);

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
 * Repo paket MCP selalu dilewati; kalau tidak ada pilihan lain, lebih baik
 * gagal dengan pesan jelas daripada commit ke repo yang salah.
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
  const usable = found.find((dir) => !samePath(dir, PACKAGE_DIR));
  if (usable) {
    return usable;
  }

  throw new Error(
    "Tidak bisa menentukan repo proyek: satu-satunya kandidat adalah repo paket server MCP. " +
    "Set WORKFLOW_PROJECT_DIR ke direktori proyek, atau jalankan server MCP dari direktori proyek.",
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

export function exec(command, options = {}) {
  const execOptions = options.cwd ? options : { ...options, cwd: getDefaultCwd(command) };
  return execPromise(command, execOptions);
}
