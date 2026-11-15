import { safeLog } from './security/sanitizer.js';
import { createRequire } from "node:module";
import fs from "fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync, unlinkSync, linkSync, renameSync } from "fs";
import { AsyncLocalStorage } from "node:async_hooks";
import os from "os";
import path from "path";
import { assertSafeKnowledge } from './security/policy.js';
import { sanitize } from './security/sanitizer.js';
import { normalizeItems as normalizeDodItems, mergeDefinitionOfDone as mergeDodItems } from './tools/handler-modules/dod.js';
import { resolveSessionKeyWithSource, sanitizeSessionKey, normalizeProjectPath } from './db/session-key.js';
import { StateUnavailable, StateConflict } from './db/errors.js';
import { resolveDbPath, SqliteAdapter } from './db/adapters/sqlite.js';
import {buildTaskProvenance} from './task-provenance.js';
import { recordAiSession, currentSessionContext } from './ai-sessions.js';
import { captureRepository } from './repository.js';
import { normalizePlan } from './tools/handler-modules/plan.js';
import { fileURLToPath } from "url";
import { pathToFileURL } from "url";
import { createHash, randomUUID } from "crypto";
import {
  projectLockDir,
  withProjectOwnershipFence,
  verifyProjectOwnership,
  getHeldLeaseForDir,
  readProcessLock,
  releaseProcessLock,
  recoverAbandonedLockGate,
  isTrustedGateRecoveryAuthority,
  publishCompleteJsonFile,
  PROCESS_INCARNATION_ID,
  GATE_FILENAME,
  ProjectOwnershipLostError,
  acquireWorktreeMutex,
  releaseWorktreeMutex,
  assertWorktreeCapabilityLive,
  assertWorktreeCapabilityMatches,
  useWorktreeCapability,
  getHeldWorktreeCapability,
  resolveCanonicalWorktreeRoot,
  currentIsAlive,
  currentIsHolderProcess,
  defaultIsHolderProcess,
} from "./process-lock.js";

export { ProjectOwnershipLostError };

/** Async execution context for per-instance WorkflowState serialization (R2-3). */
const serializedExecutionStorage = new AsyncLocalStorage();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Satu laporan monitor berjalan dalam satu waktu; lihat reportToMonitorSafe. */
let monitorInFlight = false;
/**
 * Identitas task yang sedang dilaporkan ke monitor, dipertahankan melewati
 * `reset()`.
 *
 * MASALAH YANG DITUTUP (9 November 2026)
 * --------------------------------------
 * `complete_task`/`drop_task` memanggil `reset()` - yang mengosongkan
 * `taskDescription` DAN `workflowTaskId` - lalu menyimpan. Laporan penutupan
 * itu kehilangan identitas task, sedangkan tabel `sessions` berkunci
 * (session_key, task_id). Jadi laporan penutupan tidak menutup baris task yang
 * tadi dikerjakan: ia menulis baris BARU dengan task_id kosong, sementara baris
 * aslinya tetap pada fase `coding` selamanya. Setelah 15 menit dashboard
 * menyebutnya "mungkin macet" - padahal tasknya sudah selesai dan Factory sudah
 * melaporkannya `done` (terukur pada 3 sesi sekaligus).
 *
 * Nilai ini sengaja disimpan di tingkat modul, bukan di state, karena state
 * memang sudah di-reset saat laporan penutupan dibuat.
 */
let lastReportedTaskId = "";
/** Berapa lama setelah boot laporan tidak ditunggu. */
const BOOT_QUIET_MS = 3000;
const processStartTime = Date.now();
const STATE_DIR = ".state";
const PROJECTS_DIR = "projects";
const STATE_FILENAME = "workflow-state.json";
/** Jejak task yang sedang berjalan saat tata letak state berubah. */
export const STRANDED_TASK_FILENAME = "stranded-task.json";
/** Direktori penunjuk "sesi ini bekerja di proyek mana". */
const SESSIONS_DIR = "sessions";
const LEGACY_STATE_FILENAME = ".workflow-state.json";
const PROJECT_SUMMARY_FILENAME = "project-summary.json";
const USER_ID_FILENAME = "user-id";

let cachedUserId = null;
let cachedUserStateDir = null;

/**
 * Identitas proses MCP ini.
 *
 * MENGAPA ADA
 * -----------
 * Berkas state disimpan per USER (`user-id`), bukan per sesi agen. Dua sesi
 * opencode di mesin yang sama berbagi satu `workflow-state.json`. Akibatnya
 * sesi B menimpa pekerjaan sesi A tanpa jejak: task A tidak pernah masuk
 * `history` karena history hanya ditulis saat task DITUTUP.
 *
 * Token ini dicap ke setiap penulisan supaya kita bisa mengetahui bahwa isi
 * berkas di disk terakhir ditulis oleh proses LAIN, lalu menyelamatkan task
 * yang sedang berjalan itu sebelum kita menimpanya.
 */
const PROCESS_TOKEN = `proc-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;

/**
 * Berapa kali `state_writer_history` ditulis proses ini.
 *
 * Dipakai retensi: tabel itu bertambah satu baris setiap `save()` tetapi hanya
 * dibaca untuk jendela 60 detik, jadi tanpa pemangkasan ia tumbuh tanpa batas.
 */
let writerHistoryWrites = 0;

/**
 * Langkah workflow yang hanya boleh MAJU dalam satu task.
 *
 * Hanya flag PENCAPAIAN. Gerbang kualitas (`readyToCommit`,
 * `readyCheckCompleted`, `commitAndPushCompleted`, `released`) SENGAJA tidak
 * masuk: keempatnya direset ketika langkah sebelumnya diulang, dan memaksa
 * nilainya tetap true akan melemahkan gerbang yang justru ingin ditegakkan.
 */
const MONOTONIC_STEP_FIELDS = [
  "featureFlowCreated",
  "bugFixed",
  "testsCreated",
  "testsPassed",
  "documentationCreated",
];

/**
 * JSON dari berkas state, dengan toleransi BOM.
 *
 * PowerShell menulis BOM (EF BB BF) di awal berkas, dan `JSON.parse` menolaknya.
 * Kegagalannya tidak kelihatan: `load()` menangkapnya lalu memperlakukan state
 * sebagai kosong, sehingga task yang sedang berjalan hilang tanpa pesan - persis
 * yang terjadi 1 November 2026 ketika skrip perbaikan menulis ulang
 * `.state/workflow-state.json` lewat `Set-Content -Encoding UTF8`.
 */
function parseStateJson(text) {
  const bersih = typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(bersih);
}

/**
 * Membaca JSON dengan TIGA hasil yang BERBEDA.
 *
 * Audit 2 November 2026: beberapa jalur tulis memakai `try { readFile } catch
 * { return null }`. Pola itu menyamakan "berkas tidak ada" dengan "berkas gagal
 * dibaca" (EBUSY/EMFILE - berkas sedang dipegang proses lain, umum di Windows
 * dan OneDrive) dan dengan "isi berkas rusak". Pemanggil lalu menulis ulang
 * berkas dari nol dan menghapus data yang sebenarnya masih ada.
 *
 * Karena itu hasilnya eksplisit:
 *   missing    - berkas memang belum ada; aman dianggap kosong
 *   ok         - isi berhasil dibaca
 *   corrupt    - berkas ada tapi isinya bukan JSON; isi asli harus DISALIN
 *                sebelum ditimpa
 *   unreadable - berkas ada tapi gagal dibaca; JANGAN ditimpa sama sekali
 */
export async function readJsonStateFile(filePath, fsImpl = fs) {
  let raw;
  try {
    raw = await fsImpl.readFile(filePath, "utf-8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    return { status: "unreadable", error };
  }
  try {
    return { status: "ok", data: parseStateJson(raw), raw };
  } catch (error) {
    return { status: "corrupt", error, raw };
  }
}

/**
 * Menyimpan berkas yang rusak ke samping sebelum ditimpa.
 *
 * Isi yang tidak bisa di-parse tetap bukti: siapa tahu task apa yang sedang
 * berjalan saat berkas terpotong. Membuangnya diam-diam berarti kehilangan
 * satu-satunya jejak.
 */
export async function backupDamagedFile(filePath, fsImpl = fs, now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const target = `${filePath}.corrupt-${stamp}`;
  try {
    await fsImpl.rename(filePath, target);
    return target;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function migrateOwnerMetadata(value) {
  if(value?.owner && !value.owner.processMarker && /^proc-[A-Za-z0-9-]+$/.test(value.owner.token || '')) {
    value.owner.processMarker=value.owner.token;
    delete value.owner.token;
  }
  return value;
}

function generateUserId() {
  const timestamp = Date.now().toString(16);
  const randomSuffix = Math.random().toString(16).slice(2, 10);
  return `user-${timestamp}-${randomSuffix}`;
}

/**
 * Menulis berkas identitas user TANPA pernah menimpa identitas yang sudah ada.
 *
 * Dua proses MCP bisa start bersamaan pada instalasi baru: keduanya membuat ID
 * berbeda, penulis terakhir menang, dan riwayat sesi pertama menempel pada ID
 * yang tidak pernah tersimpan. Karena itu pembuatan berkas memakai flag `wx`
 * (gagal bila sudah ada), lalu membaca pemenangnya.
 *
 * Berkas yang ADA tetapi tidak terbaca tidak pernah ditimpa: identitas di
 * dalamnya masih dipakai baris riwayat yang sudah tercatat.
 */
export function ensureUserIdFile(userIdFile, candidateId) {
  try {
    writeFileSync(userIdFile, candidateId, { encoding: "utf-8", flag: "wx" });
    return candidateId;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  try {
    const existing = readFileSync(userIdFile, "utf-8").trim();
    if (existing) return existing;
  } catch {
    return candidateId;
  }

  // Berkas ada dan terbaca, isinya kosong: tidak ada identitas yang bisa hilang.
  writeFileSync(userIdFile, candidateId, "utf-8");
  return candidateId;
}

function resolveUserId(stateDir, { skipWrites = false } = {}) {
  const envUserId = (process.env.DEV_WORKFLOW_USER_ID || "").trim();
  if (envUserId) {
    cachedUserId = envUserId;
    cachedUserStateDir = stateDir;
    return envUserId;
  }

  if (cachedUserId && cachedUserStateDir === stateDir) {
    return cachedUserId;
  }

  const userIdFile = path.join(stateDir, USER_ID_FILENAME);

  try {
    if (existsSync(userIdFile)) {
      const stored = readFileSync(userIdFile, "utf-8").trim();
      if (stored) {
        cachedUserId = stored;
        cachedUserStateDir = stateDir;
        return stored;
      }
    }
  } catch {
    // Berkas identitas tidak terbaca. JANGAN membuat ID baru menimpanya:
    // seluruh riwayat pengguna akan terlepas dari dirinya sendiri. Alur di
    // bawah hanya menulis bila berkasnya benar-benar bisa dibuat baru.
  }

  const usersDir = path.join(stateDir, "users");

  try {
    const entries = readdirSync(usersDir, { withFileTypes: true });
    const candidateDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    if (candidateDirs.length === 1) {
      const legacyId = candidateDirs[0];
      if (!skipWrites) {
        try {
          mkdirSync(stateDir, { recursive: true });
          const id = ensureUserIdFile(userIdFile, legacyId);
          cachedUserId = id;
          cachedUserStateDir = stateDir;
          return id;
        } catch {
          // Persisting the legacy ID is best-effort.
        }
      }
      cachedUserId = legacyId;
      cachedUserStateDir = stateDir;
      return legacyId;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      // Unexpected error accessing users directory – fall through to generate new ID.
    }
  }

  const legacyDefaultPath = path.join(usersDir, "default", STATE_FILENAME);
  if (existsSync(legacyDefaultPath)) {
    if (!skipWrites) {
      try {
        mkdirSync(stateDir, { recursive: true });
        const id = ensureUserIdFile(userIdFile, "default");
        cachedUserId = id;
        cachedUserStateDir = stateDir;
        return id;
      } catch {
        // Best-effort persistence; continue with in-memory fallback.
      }
    }
    cachedUserId = "default";
    cachedUserStateDir = stateDir;
    return "default";
  }

  if (skipWrites) {
    return "default";
  }

  const generatedId = generateUserId();
  try {
    mkdirSync(stateDir, { recursive: true });
    const id = ensureUserIdFile(userIdFile, generatedId);
    cachedUserId = id;
    cachedUserStateDir = stateDir;
    return id;
  } catch {
    // Ignore persistence errors; continue with in-memory ID.
  }

  cachedUserId = generatedId;
  cachedUserStateDir = stateDir;
  return generatedId;
}

function hasProjectMarkers(candidate) {
  if (!candidate) {
    return false;
  }

  const resolved = path.resolve(candidate);
  return (
    existsSync(path.join(resolved, "package.json")) || existsSync(path.join(resolved, ".git"))
  );
}

function normalizeAndStoreCandidate(list, candidate) {
  if (!candidate) {
    return;
  }

  const resolved = path.resolve(candidate);
  if (!list.includes(resolved)) {
    list.push(resolved);
  }
}

function addAncestorCandidates(list, start) {
  if (!start) {
    return;
  }

  let current = path.resolve(start);
  while (!isRootPath(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    if (!isRootPath(parent)) {
      normalizeAndStoreCandidate(list, parent);
    }
    current = parent;
  }
}

function selectProjectRoot(candidates, moduleRoot) {
  const cwdResolved = path.resolve(process.cwd());
  const prioritized = [];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const resolved = path.resolve(candidate);
    if (prioritized.some((entry) => entry.resolved === resolved)) {
      continue;
    }

    prioritized.push({
      resolved,
      hasMarkers: hasProjectMarkers(resolved),
      isRoot: isRootPath(resolved),
      isCwdAncestor: cwdResolved === resolved || cwdResolved.startsWith(`${resolved}${path.sep}`),
    });
  }

  const ancestorWithMarkers = prioritized.find((entry) => entry.isCwdAncestor && entry.hasMarkers);
  if (ancestorWithMarkers) {
    return ancestorWithMarkers.resolved;
  }

  const ancestorWithoutMarkers = prioritized
    .filter((entry) => entry.isCwdAncestor && !entry.hasMarkers && !entry.isRoot)
    .sort((a, b) => b.resolved.length - a.resolved.length);
  if (ancestorWithoutMarkers.length > 0) {
    return ancestorWithoutMarkers[0].resolved;
  }

  if (moduleRoot) {
    const moduleResolved = path.resolve(moduleRoot);
    const moduleEntry = prioritized.find((entry) => entry.resolved === moduleResolved && !entry.isRoot);
    if (moduleEntry) {
      return moduleEntry.resolved;
    }
  }

  const withMarkers = prioritized.find((entry) => entry.hasMarkers);
  if (withMarkers) {
    return withMarkers.resolved;
  }

  const nonRoot = prioritized.find((entry) => !entry.isRoot);
  if (nonRoot) {
    return nonRoot.resolved;
  }

  return prioritized.length > 0 ? prioritized[0].resolved : null;
}

function getUserScopedDir(baseDir, { skipWrites = false } = {}) {
  const userId = resolveUserId(baseDir, { skipWrites });
  return path.join(baseDir, "users", userId);
}

/**
 * Identitas user untuk baris database milik state ini.
 *
 * MENGAPA TIDAK MEMBACA CACHE MODUL
 * ---------------------------------
 * Versi sebelumnya hanya memakai `cachedUserId`, yang terisi lewat
 * `resolveUserId()` - dan itu hanya dipanggil dari `resolveStateFile()`.
 * Pemanggil yang membuat `WorkflowState` dengan path EKSPLISIT (skrip
 * perbaikan, CLI, tes) tidak pernah memicunya, sehingga `syncToDatabase()`
 * diam-diam menulis baris dengan `user_id = "default"`.
 *
 * Akibat nyata 30 Oktober 2026: satu proyek punya riwayat di dua identitas
 * (`user-…` dan `default`) dalam database yang sama, dan 150 baris duplikat
 * harus dibersihkan manual.
 *
 * Membaca langsung dari direktori `.state` milik state ini membuat hasilnya
 * tidak bergantung pada direktori kerja proses, tidak bergantung pada urutan
 * pemanggilan, dan tidak bocor antar proyek dalam satu proses.
 */
function getCurrentUserId(stateFile = null, { skipWrites = false } = {}) {
  const envUserId = (process.env.DEV_WORKFLOW_USER_ID || "").trim();
  if (envUserId) {
    return envUserId;
  }

  if (stateFile) {
    const stateDir = path.dirname(path.resolve(stateFile));

    // SATU JANGKAR PER PROYEK.
    //
    // Di tata letak `projects/<proyek>/users/<user>/`, berkas state berada satu
    // tingkat di bawah direktori user, sedangkan `getUserScopedDir` menulis
    // `user-id` di direktori PROYEK. Membaca dari `stateDir` apa adanya membuat
    // jalur ini membuat id BARU di `users/<user>/user-id`, lalu `syncToDatabase`
    // mencatat riwayat dengan user_id yang berbeda dari sebelumnya - kelas bug
    // 30 Oktober 2026 (150 baris duplikat), dengan sebab yang berbeda.
    const anchorDir =
      path.basename(path.dirname(stateDir)) === "users"
        ? path.dirname(path.dirname(stateDir))
        : stateDir;

    const userIdFile = path.join(anchorDir, USER_ID_FILENAME);

    try {
      const stored = readFileSync(userIdFile, "utf-8").trim();
      if (stored) {
        return stored;
      }
    } catch {
      // Berkas belum ada: jatuh ke pencarian di bawah.
    }

    // .state langsung (bukan .state/users/<id>): pakai resolveUserId, yang
    // menangani migrasi id lama maupun pembuatan id baru.
    try {
      return resolveUserId(anchorDir, { skipWrites });
    } catch {
      // Biarkan jatuh ke nilai cadangan di bawah.
    }
  }

  if (cachedUserId) {
    return cachedUserId;
  }

  return "default";
}

async function migrateLegacyStateFile(targetPath) {
  const stateDir = path.dirname(targetPath);
  if (path.basename(stateDir) !== STATE_DIR) {
    return;
  }

  const projectRoot = path.dirname(stateDir);
  const legacyPath = path.join(projectRoot, LEGACY_STATE_FILENAME);

  if (legacyPath === targetPath) {
    return;
  }

  try {
    await fs.access(legacyPath);
  } catch {
    return;
  }

  await fs.mkdir(stateDir, { recursive: true });
  const migrated = migrateOwnerMetadata(parseStateJson(await fs.readFile(legacyPath, 'utf8')));
  assertSafeKnowledge(migrated);

  try {
    await fs.access(targetPath);
    await fs.unlink(legacyPath);
    return;
  } catch {
    // New state file doesn't exist yet; fall through to migrate.
  }

  await fs.writeFile(targetPath, JSON.stringify(migrated, null, 2), { flag: 'wx' });
  await fs.unlink(legacyPath);
}

function isRootPath(candidate) {
  if (!candidate) {
    return true;
  }

  const resolved = path.resolve(candidate);
  return path.parse(resolved).root === resolved;
}

function findProjectRoot(startDir) {
  if (!startDir) {
    return null;
  }

  let current = path.resolve(startDir);
  const { root } = path.parse(current);

  while (true) {
    const hasPackageJson = existsSync(path.join(current, "package.json"));
    const hasGitDir = existsSync(path.join(current, ".git"));
    if (hasPackageJson || hasGitDir) {
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

function getCompatibilityPaths(primaryPath) {
  const resolvedPrimary = path.resolve(primaryPath);
  const candidates = new Set();
  const moduleDir = __dirname;

  const directCandidate = path.resolve(moduleDir, STATE_DIR, STATE_FILENAME);
  if (directCandidate !== resolvedPrimary) {
    candidates.add(directCandidate);
  }

  const possibleDistDirs = [
    path.join(moduleDir, "dist"),
    path.join(path.dirname(moduleDir), "dist"),
  ];

  for (const distDir of possibleDistDirs) {
    const candidate = path.resolve(distDir, STATE_DIR, STATE_FILENAME);
    if (candidate !== resolvedPrimary) {
      candidates.add(candidate);
    }
  }

  return Array.from(candidates);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureCompatibilityLinks(primaryPath) {
  // Cermin kompatibilitas ditulis ke `<paket>/.state/workflow-state.json`,
  // BUKAN ke lokasi state yang sebenarnya. Itu benar untuk pemakaian nyata
  // (CLI dan dasbor web membaca jalur lama), tetapi merusak saat tes: setiap
  // WorkflowState yang dibuat tes - meski di direktori sementara - menimpa
  // state repo, dan 31 Oktober 2026 itu menghapus task yang sedang berjalan di
  // tengah `npm test`.
  //
  // Tes mematikan cermin ini lewat DEV_WORKFLOW_NO_COMPAT_LINKS=1 (lihat
  // tests/setup-env.js). Perilaku produksi tidak berubah.
  if (process.env.DEV_WORKFLOW_NO_COMPAT_LINKS === "1") {
    return;
  }

  const resolvedPrimary = path.resolve(primaryPath);

  if (!(await pathExists(resolvedPrimary))) {
    return;
  }
  assertSafeKnowledge(parseStateJson(await fs.readFile(resolvedPrimary, 'utf8')));

  const compatibilityPaths = getCompatibilityPaths(resolvedPrimary);

  for (const compatPath of compatibilityPaths) {
    try {
      await fs.mkdir(path.dirname(compatPath), { recursive: true });
    } catch {
      // Ignore directory creation errors; we'll surface them on actual writes.
    }

    try {
      const compatStat = await fs.lstat(compatPath);
      if (compatStat.isSymbolicLink()) {
        const target = await fs.readlink(compatPath);
        if (path.resolve(path.dirname(compatPath), target) === resolvedPrimary) {
          continue;
        }
        await fs.unlink(compatPath);
      } else if (compatStat.isFile()) {
        const [primaryStat, existingStat] = await Promise.all([
          fs.stat(resolvedPrimary),
          fs.stat(compatPath),
        ]);
        if (primaryStat.dev === existingStat.dev && primaryStat.ino === existingStat.ino) {
          continue;
        }
        await fs.unlink(compatPath);
      } else {
        await fs.unlink(compatPath);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        // Unexpected error accessing legacy path; skip mirroring to avoid breaking primary file.
        continue;
      }
    }

    try {
      await fs.link(resolvedPrimary, compatPath);
      continue;
    } catch (error) {
      if (!["EEXIST", "EXDEV", "EPERM"].includes(error.code)) {
        continue;
      }
      if (error.code === "EEXIST") {
        continue;
      }
    }

    try {
      await fs.symlink(resolvedPrimary, compatPath);
      continue;
    } catch (error) {
      if (error.code === "EEXIST") {
        continue;
      }
      if (!["EPERM", "ENOTSUP", "EEXIST"].includes(error.code)) {
        // If symlink fails for another reason, skip to avoid interfering with primary file.
        continue;
      }
    }

    try {
      await fs.copyFile(resolvedPrimary, compatPath);
    } catch {
      // Final fallback failed; ignore to avoid disrupting primary save.
    }
  }
}

/**
 * Identitas sesi agen ini.
 *
 * MENGAPA ADA
 * -----------
 * Berkas state dulu disimpan per USER, jadi beberapa proses MCP berbagi satu
 * `workflow-state.json`. Akibatnya `start_task` di satu sesi mengganti task
 * sesi lain di tengah jalan, dan gerbang kualitas (ready check, tests, docs)
 * ikut dibagi sehingga sesi B bisa memakai hasil sesi A untuk commit.
 *
 * Sekarang task dan gerbangnya milik SESI; `history` tetap milik PROYEK.
 *
 * MENGAPA BUKAN ENV SAJA
 * ----------------------
 * Percobaan pertama membaca `OPENCODE_SESSION_ID` dari environment. OpenCode
 * tidak men-set variabel itu, sehingga hampir semua berkas jatuh ke
 * `pid-<pid>`; karena satu proses MCP dipakai bergantian oleh beberapa sesi,
 * sesi-sesi itu tetap berbagi satu berkas dan saling menimpa.
 *
 * OpenCode v2 mengirim identitas sesi per panggilan di
 * `CallToolRequest.params._meta["ai.opencode/sessionID"]`. Itu sumber utama
 * sekarang; env tetap dibaca sebagai cadangan untuk tes dan pemanggil lain.
 */
/**
 * The session-identity metadata key each real client sends.
 *
 * Captured from the installed clients, not guessed:
 *   - OpenCode    `ai.opencode/sessionID`
 *   - Codex       `sessionId` (with `threadId` as the same value)
 *   - Antigravity `antigravity.google/conversation_id`
 *
 * A client that sends none of these is refused for a session-scoped tool. The
 * keys are per client so one client's identity can never stand in for another's.
 */
export const SESSION_META_KEYS = {
  opencode: ["ai.opencode/sessionID"],
  codex: ["sessionId", "threadId"],
  // Only the conversation id. `root_conversation_id` is deliberately NOT
  // accepted: child conversations share a root, so falling back to it would let
  // two different conversations select the same state.
  antigravity: ["antigravity.google/conversation_id"],
};

// A session key becomes a file name and a database key, so it is restricted to
// a conservative charset. Anything else is refused rather than sanitised: a
// value that needs cleaning is not a value we should trust.
const SESSION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

// Windows reserves these device names, with or without an extension, so
// `sessions/con.json` is not a usable file name.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function normalizeSessionKey(value) {
  if (typeof value !== "string") return null;
  // No trimming: a padded value is a different value, and silently accepting
  // " victim " as "victim" would let a caller choose an identity it did not
  // actually present.
  if (value !== value.trim()) return null;
  if (!SESSION_KEY_PATTERN.test(value)) return null;
  if (WINDOWS_RESERVED.test(value)) return null;
  return value;
}

/**
 * The session identity a request carries, or null.
 *
 * `agent` scopes which keys are accepted. `device-entry.cjs` sets DEVWF_AGENT
 * for each client, so a Codex server does not accept an Antigravity
 * conversation id even if one is present. An unknown agent accepts any known
 * key, which keeps a directly launched server working, but every known key that
 * is present must agree: a request cannot present two identities and let the
 * first one win.
 */
export function sessionKeyFromRequest(request, { agent = process.env.DEVWF_AGENT } = {}) {
  const meta = request?.params?._meta;
  if (!meta || typeof meta !== "object") return null;
  const scoped = SESSION_META_KEYS[String(agent || "").toLowerCase()];
  const keys = scoped || [
    ...SESSION_META_KEYS.opencode,
    ...SESSION_META_KEYS.antigravity,
    ...SESSION_META_KEYS.codex,
  ];

  let resolved = null;
  for (const key of keys) {
    const raw = meta[key];
    if (raw === undefined || raw === null) continue;
    const normalized = normalizeSessionKey(raw);
    // A present but invalid identity is a refusal, not a reason to try the next
    // key: the caller presented something it should not have.
    if (!normalized) return null;
    if (resolved !== null && resolved !== normalized) return null;
    resolved = normalized;
  }
  return resolved;
}

/**
 * Kunci sesi untuk nama berkas ekspor dan untuk baris database.
 *
 * Satu implementasi saja, di `db/session-key.js`. Versi lokal yang dulu ada di
 * sini berbeda dari versi baru di satu hal yang penting - ia masih mengembalikan
 * `pid-<pid>` - sehingga nama berkas dan kunci baris bisa menunjuk sesi yang
 * berbeda untuk masukan yang sama.
 */
export function resolveSessionKey(env = process.env, explicitSessionId = null) {
  return resolveSessionKeyWithSource(env, explicitSessionId).key;
}

/** Nama berkas state untuk sesi ini, di direktori user yang sama. */
function sessionStateFilename(env = process.env, explicitSessionId = null) {
  return `workflow-state.${resolveSessionKey(env, explicitSessionId)}.json`;
}

/** State file name from a session key that is already canonical (no re-hash). */
function sessionStateFilenameForKey(sessionKey) {
  return `workflow-state.${sessionKey}.json`;
}

/**
 * Berkas tempat `history` bersama disimpan.
 *
 * Dalam tata letak nyata (`.state/users/<user>/`) history dipisahkan dari state
 * sesi supaya catatan proyek tidak terpecah per sesi. Pemanggil yang memberi
 * path eksplisit di luar tata letak itu tetap memakai satu berkas, persis
 * seperti sebelumnya.
 */
export function resolveHistoryFile(stateFilePath) {
  const resolved = path.resolve(stateFilePath);

  // Tata letak per proyek: `<dasar>/projects/<proyek>/users/<user>/<berkas>`.
  // History harus di akar PROYEK, bukan di direktori user - kalau tidak,
  // rekomendasi dan riwayat task terpecah per sesi dan sesi berikutnya tidak
  // bisa membacanya. Dicari lewat segmen `projects`, bukan dengan menghitung
  // `dirname` berkali-kali: kedalaman berubah, dan angka `dirname` diam-diam
  // menghasilkan root yang salah.
  const segments = resolved.split(path.sep);
  const projectIndex = segments.lastIndexOf("projects");
  if (projectIndex >= 0 && segments.length > projectIndex + 3) {
    const projectDir = segments.slice(0, projectIndex + 2).join(path.sep);
    return path.join(projectDir, STATE_FILENAME);
  }

  const dir = path.dirname(resolved);
  const inUserTree = path.basename(path.dirname(dir)) === "users";
  return inUserTree ? path.join(dir, STATE_FILENAME) : resolved;
}

/**
 * Induk direktori `.state` untuk sebuah berkas state.
 *
 * Dulu ini dihitung dengan empat `dirname` berurutan, yang hanya benar selama
 * tata letaknya tepat `<root>/.state/users/<user>/<berkas>`. Begitu kedalaman
 * berubah (mis. state sesi ditaruh di subdirektori), angka itu diam-diam
 * menghasilkan root yang salah dan baris database tercatat di proyek lain.
 *
 * Sekarang dicari dengan sengaja: naik sampai menemukan direktori `.state`,
 * lalu ambil induknya. Tidak bergantung pada kedalaman.
 */
export function resolveProjectRootForState(stateFilePath) {
  const resolved = path.resolve(stateFilePath);
  let current = path.dirname(resolved);

  for (;;) {
    if (path.basename(current) === STATE_DIR) {
      return path.dirname(current);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Di luar tata letak `.state` (mis. path eksplisit untuk tes): pakai
  // direktori yang memuat berkasnya.
  return path.dirname(resolved);
}

export function resolveStateFile({ sessionId = null, skipMigrationWrites = false } = {}) {
  const customPath = process.env.DEV_WORKFLOW_STATE_FILE;
  const moduleRoot = path.resolve(__dirname, "..");
  const cwdResolved = path.resolve(process.cwd());
  const initCwd = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : null;

  // 1. Prefer the project rooted at the current working directory
  let projectRoot = findProjectRoot(cwdResolved);

  // 2. Fall back to the project rooted at INIT_CWD if different
  if (!projectRoot && initCwd) {
    projectRoot = findProjectRoot(initCwd);
  }

  if (customPath) {
    const resolvedCustom = path.resolve(customPath);

    /*
     * Pin = DIREKTORI DASAR, bukan satu berkas untuk semua proyek.
     *
     * 1 November 2026: satu berkas bersama membuat semua proyek berbagi satu
     * slot task. Dua sesi saling menimpa, penjaga "sesi lain" menyala untuk
     * proyek yang tidak berhubungan, dan bukti DoD satu task tertulis ke task
     * proyek lain. Sekarang tiap proyek punya direktori sendiri di bawah
     * `<dasar>/projects/<proyek>/`, dan di dalamnya tiap SESI punya berkasnya
     * sendiri di `users/<user>/`.
     *
     * MENGAPA PER SESI, BUKAN HANYA PER PROYEK
     * ----------------------------------------
     * Per-proyek saja tidak cukup: dua jendela OpenCode pada repo yang sama
     * tetap berbagi satu berkas. Diukur 1 November 2026 - `resolveStateFile`
     * dengan dua `sessionId` berbeda menjawab path yang SAMA, karena
     * `sessionId` diterima sebagai parameter lalu tidak dipakai.
     *
     * MENGAPA JALUR CADANGAN TIDAK BOLEH MENGEMBALIKAN BERKAS PIN
     * ----------------------------------------------------------
     * `findProjectRoot(cwd)` null berarti direktori kerja bukan repo - dan itu
     * keadaan normal di mesin ini (`Documents\Default Project`). Dulu fungsi ini
     * mengembalikan berkas pin apa adanya, sehingga isolasi per proyek tidak
     * pernah aktif, berapa kali pun server di-restart. Sekarang direktori proyek
     * dibentuk dari direktori kerja pemanggil, satu-satunya identitas yang
     * tersedia. `projectKey` menambahkan potongan hash, jadi dua direktori kerja
     * berbeda tidak bertabrakan.
     *
     * MENGAPA TIDAK MEMAKAI `projectRoot` HASIL FALLBACK
     * -------------------------------------------------
     * `projectRoot` di atas bisa berasal dari `INIT_CWD`, yang diisi npm dengan
     * tempat perintah dijalankan - bukan tempat sesi bekerja. Diukur di suite
     * penuh: dua direktori kerja berbeda sama-sama dianggap proyek paket ini,
     * lalu kembali berbagi satu berkas state. Identitas di sini dihitung ulang
     * dari `process.cwd()` saja.
     */
    const baseDir = path.dirname(resolvedCustom);
    const sessionKey = resolveSessionKey(process.env, sessionId);

    /*
     * MENGAPA ADA PENUNJUK PER SESI
     * -----------------------------
     * `process.cwd()` milik PROSES MCP, dan sering bukan tempat sesi bekerja:
     * di mesin ini semua sesi dijalankan dari `Documents\Default Project`.
     * Diukur 1 November 2026: satu direktori `projects/Default-Project-<hash>/`
     * berisi state dari sesi yang mengerjakan `D:\code\belajar`, repo uji, dan
     * repo ini sekaligus. History, lock, dan rekomendasi tercampur antar proyek
     * yang tidak berhubungan - dan `start_task` saling menolak.
     *
     * `start_task` mencatat proyek yang BENAR di sini begitu `projectDir`
     * dipin, sehingga panggilan berikutnya memakai proyek itu, bukan cwd proses.
     */
    const pointer = readSessionPointer(baseDir, sessionKey);
    // Penunjuk dianggap sah hanya bila repo aslinya DAN direktori state-nya
    // masih ada. Repo yang dipindah atau dihapus meninggalkan penunjuk basi;
    // memakainya berarti state nyasar ke proyek yang sudah tidak ada.
    const pointedProjectDir =
      pointer?.projectDirPath &&
      pointer?.projectDir &&
      existsSync(pointer.projectDirPath) &&
      existsSync(pointer.projectDir)
        ? pointer.projectDirPath
        : "";

    const identityRoot =
      (pointedProjectDir && pointer.projectDir) ||
      findProjectRoot(path.resolve(process.cwd())) ||
      path.resolve(process.cwd());

    const projectDir = pointedProjectDir || path.join(baseDir, PROJECTS_DIR, projectKey(identityRoot));

    const userDir = getUserScopedDir(projectDir, { skipWrites: Boolean(skipMigrationWrites) });
    const target = path.join(userDir, sessionStateFilename(process.env, sessionId));

    // Dua sumber lama, keduanya hanya menyalin state menganggur:
    //   1. berkas pin bersama (era pra-1.16.0)
    //   2. <proyek>/workflow-state.json (era 1.16.0, satu berkas per proyek)
    if (!skipMigrationWrites) {
      migrateStateToSession({
        sourcePath: resolvedCustom,
        targetPath: target,
        projectRoot: identityRoot,
        projectDir,
      });
      migrateStateToSession({
        sourcePath: path.join(projectDir, STATE_FILENAME),
        targetPath: target,
        projectRoot: identityRoot,
        projectDir,
      });
    }

    return target;
  }

  // 4. Fall back to the project containing this module
  if (!projectRoot) {
    projectRoot = findProjectRoot(moduleRoot);
  }

  // 5. Final fallback: use a non-root working directory or the module root
  if (!projectRoot) {
    projectRoot = !isRootPath(cwdResolved) ? cwdResolved : moduleRoot;
  }

  const stateDir = path.join(projectRoot, STATE_DIR);
  const userDir = getUserScopedDir(stateDir, { skipWrites: Boolean(skipMigrationWrites) });
  return path.join(userDir, sessionStateFilename(process.env, sessionId));
}

export function canonicalProjectPath(candidate) {
  let raw = String(candidate || "").trim();
  if (!raw || raw.includes("\0")) {
    return "";
  }
  if (process.platform !== "win32" && raw.includes("\\")) {
    raw = raw.replace(/\\/g, "/");
  }
  const resolved = path.resolve(raw);
  let real = resolved;
  try {
    real = realpathSync(resolved);
  } catch {
    real = resolved;
  }
  const normalized = path.normalize(real);
  const parsed = path.parse(normalized);
  const stripped = normalized === parsed.root ? normalized : normalized.replace(/[\\/]+$/, "");
  if (/^[a-z]:[\\/]/i.test(stripped)) {
    return stripped[0].toUpperCase() + stripped.slice(1);
  }
  return stripped;
}

function canonicalPath(candidate) {
  return canonicalProjectPath(candidate);
}

/**
 * Nama subdirektori per proyek: nama folder yang masih terbaca manusia, plus
 * potongan hash supaya dua proyek bernama sama (mis. `clinic` di dua root)
 * tidak bertabrakan.
 */
export function projectKey(projectRoot) {
  const resolved = canonicalProjectPath(projectRoot);
  const nama = path.basename(resolved)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "proyek";
  const hashInput = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const hash = createHash("sha1").update(hashInput).digest("hex").slice(0, 10);
  return `${nama}-${hash}`;
}

/**
 * Authoritative canonical project identity resolver.
 * Resolves relative paths, symlinks/junctions, separator differences, and
 * Windows drive-letter casing without mutating any state on disk.
 */
export function resolveCanonicalProjectIdentity(projectDir, { mustExist = false } = {}) {
  if (typeof projectDir !== "string" || projectDir.trim() === "" || projectDir.includes("\0")) {
    return {
      ok: false,
      error: "INVALID_PROJECT_DIR",
      message: "projectDir must be a non-empty valid filesystem path.",
    };
  }
  const resolved = path.resolve(projectDir.trim());
  if (mustExist && !existsSync(resolved)) {
    return {
      ok: false,
      error: "PROJECT_DIR_NOT_FOUND",
      message: `Project directory does not exist: ${resolved}`,
    };
  }
  const canonical = canonicalProjectPath(resolved);
  if (!canonical) {
    return {
      ok: false,
      error: "INVALID_PROJECT_DIR",
      message: "projectDir could not be canonicalized.",
    };
  }
  const bucketKey = projectKey(canonical);
  const comparisonKey =
    process.platform === "win32" || process.platform === "darwin"
      ? canonical.replace(/\\/g, "/").toLowerCase()
      : canonical.replace(/\\/g, "/");
  return {
    ok: true,
    raw: projectDir,
    projectDir: canonical,
    bucketKey,
    comparisonKey,
  };
}

/**
 * Pre-resolve the target project's state bucket and session state file
 * BEFORE mutating session pointers or checking locks.
 *
 * This prevents startup-CWD false lock collisions when two MCP clients launch
 * in the same working directory (e.g. C:\Users\mahardhika) and then call
 * start_task with an explicit target projectDir.
 */
export function resolveTargetProjectState({ stateFile, projectDir, skipWrites = false } = {}) {
  let rawState = String(stateFile || "");
  if (process.platform !== "win32" && rawState.includes("\\")) {
    rawState = rawState.replace(/\\/g, "/");
  }
  const resolvedState = path.resolve(rawState);
  const hasTargetProject = typeof projectDir === "string" && projectDir.trim() !== "";
  const canonicalTarget = hasTargetProject ? canonicalProjectPath(projectDir) : "";

  if (canonicalTarget && resolvedState.split(path.sep).includes(PROJECTS_DIR)) {
    const baseDir = resolveBaseDirFromState(resolvedState);
    const sessionKey = sessionKeyFromStateFile(resolvedState);
    const bucketKey = projectKey(canonicalTarget);
    const projectDirPath = path.join(baseDir, PROJECTS_DIR, bucketKey);
    const targetStateFile = path.join(
      getUserScopedDir(projectDirPath, { skipWrites }),
      sessionStateFilenameForKey(sessionKey),
    );
    return {
      isPinnedLayout: true,
      projectDir: canonicalTarget,
      bucketKey,
      projectDirPath,
      stateFile: targetStateFile,
    };
  }

  return {
    isPinnedLayout: false,
    projectDir: canonicalTarget,
    bucketKey: canonicalTarget ? projectKey(canonicalTarget) : "",
    projectDirPath: path.dirname(resolvedState),
    stateFile: resolvedState,
  };
}

/**
 * Parse owner.updatedAt from either numeric epoch milliseconds or ISO 8601
 * strings (F5 remediation: `save()` writes ISO strings while legacy tests may
 * pass numeric timestamps).
 */
export function parseOwnerTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return NaN;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) return numeric;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function hasLiveProcessLockForPid(projectDirPath, targetPid) {
  if (!Number.isFinite(targetPid) || targetPid <= 0) return false;
  const dirsToInspect = new Set();
  if (projectDirPath) {
    const resolved = path.resolve(projectDirPath);
    dirsToInspect.add(resolved);
    if (path.basename(path.dirname(resolved)) === PROJECTS_DIR) {
      const projectsRoot = path.dirname(resolved);
      if (existsSync(projectsRoot)) {
        try {
          for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              dirsToInspect.add(path.join(projectsRoot, entry.name));
            }
          }
        } catch {}
      }
    }
  }
  for (const dir of dirsToInspect) {
    const lock = readProcessLock({ dir });
    if (lock && Number(lock.pid) === targetPid) {
      return true;
    }
  }
  return false;
}

/**
 * Inspect the target project's state file(s) for an active live task owned by
 * a foreign process. Checks both the target session state file and sibling
 * session state files inside the target project bucket.
 */
export function findActiveForeignTaskInProject({
  projectDirPath,
  targetStateFile,
  ownPid = process.pid,
  now = Date.now(),
  staleMs = 10 * 60 * 1000,
  isAlive = () => true,
  isHolderProcess = currentIsHolderProcess(),
} = {}) {
  const candidateFiles = new Set();
  const targetResolved = targetStateFile ? path.resolve(targetStateFile) : null;
  const targetSessionKey = targetResolved ? sessionKeyFromStateFile(targetResolved) : null;
  if (targetResolved) {
    candidateFiles.add(targetResolved);
  }
  if (projectDirPath && existsSync(projectDirPath)) {
    const rootState = path.join(projectDirPath, STATE_FILENAME);
    if (existsSync(rootState)) candidateFiles.add(path.resolve(rootState));
    const usersRoot = path.join(projectDirPath, "users");
    if (existsSync(usersRoot)) {
      try {
        for (const uEntry of readdirSync(usersRoot, { withFileTypes: true })) {
          if (!uEntry.isDirectory()) continue;
          const uDir = path.join(usersRoot, uEntry.name);
          for (const fEntry of readdirSync(uDir, { withFileTypes: true })) {
            if (fEntry.isFile() && fEntry.name.startsWith("workflow-state") && fEntry.name.endsWith(".json")) {
              candidateFiles.add(path.resolve(path.join(uDir, fEntry.name)));
            }
          }
        }
      } catch {
        // Best-effort directory scan; individual unreadable entries are skipped.
      }
    }
  }

  for (const file of candidateFiles) {
    if (!existsSync(file)) continue;
    try {
      const disk = parseStateJson(readFileSync(file, "utf8"));
      if (!disk || typeof disk !== "object") continue;
      const phase = typeof disk.currentPhase === "string" ? disk.currentPhase : "idle";
      const description = typeof disk.taskDescription === "string" ? disk.taskDescription.trim() : "";
      const ownerPid = Number(disk.owner?.pid);
      const ownerMarker = typeof disk.owner?.processMarker === "string" ? disk.owner.processMarker.trim() : "";
      const fileSessionKey = sessionKeyFromStateFile(file);
      const differentSessionInSameProcess =
        Boolean(targetResolved) &&
        path.resolve(file) !== targetResolved &&
        Boolean(targetSessionKey) &&
        Boolean(fileSessionKey) &&
        fileSessionKey !== targetSessionKey;
      const foreignOwner =
        Number.isFinite(ownerPid) &&
        ownerPid > 0 &&
        (ownerPid !== ownPid ||
          (ownerMarker !== "" && ownerMarker !== PROCESS_TOKEN) ||
          differentSessionInSameProcess);
      if (phase === "idle" || description === "" || !foreignOwner) continue;

      if (!isAlive(ownerPid)) continue;

      const shouldConsultDefaultHolder =
        isHolderProcess !== defaultIsHolderProcess ||
        isAlive === currentIsAlive();
      if (shouldConsultDefaultHolder) {
        const holderCheck = isHolderProcess(ownerPid, disk.owner);
        if (holderCheck === false) continue;
      }

      const ownerSeenAt = parseOwnerTimestamp(disk.owner?.updatedAt);
      const holdsLiveLock = hasLiveProcessLockForPid(projectDirPath, ownerPid);
      const ownerFresh =
        holdsLiveLock || (Number.isFinite(ownerSeenAt) && now - ownerSeenAt < staleMs);

      if (ownerFresh) {
        return {
          file,
          disk,
          phase,
          description,
          ownerPid,
          ownerSeenAt,
        };
      }
    } catch {
      // Ignore corrupt or unreadable sibling files during foreign-task scan.
    }
  }
  return null;
}

/**
 * Direktori dasar (`<dasar>`) dari sebuah berkas state.
 *
 * Dicari lewat segmen `projects`, bukan dengan menghitung `dirname`: kedalaman
 * tata letak sudah berubah sekali dan akan berubah lagi.
 */
function resolveBaseDirFromState(stateFile) {
  let raw = String(stateFile || "");
  if (process.platform !== "win32" && raw.includes("\\")) {
    raw = raw.replace(/\\/g, "/");
  }
  const resolved = path.resolve(raw);
  const segments = resolved.split(path.sep);
  const index = segments.lastIndexOf(PROJECTS_DIR);
  if (index > 0) {
    return segments.slice(0, index).join(path.sep);
  }
  return path.dirname(resolved);
}

/**
 * Kunci sesi dari nama berkas state.
 *
 * Berkasnya sudah berbentuk `workflow-state.<sesi>.json`, jadi kuncinya tidak
 * perlu dioper ulang. Memakai `resolveSessionKey(env, null)` di sini SALAH:
 * pemanggil yang memberi `sessionId` eksplisit akan membaca penunjuk dengan
 * kunci itu, sementara penunjuk ditulis dengan kunci env - dua kunci berbeda,
 * dan pengalihan proyek tidak pernah terbaca.
 */
function sessionKeyFromStateFile(stateFile) {
  const base = path.basename(path.resolve(stateFile));
  const match = /^workflow-state\.(.+)\.json$/.exec(base);
  return match ? match[1] : resolveSessionKey(process.env, null);
}

function sessionPointerPath(baseDir, sessionKey) {
  return path.join(baseDir, SESSIONS_DIR, `${sessionKey}.json`);
}

/** Proyek yang tercatat untuk sesi ini, atau null. */
export function readSessionPointer(baseDir, sessionKey) {
  try {
    const ptr = JSON.parse(readFileSync(sessionPointerPath(baseDir, sessionKey), "utf-8"));
    // A focus binding is a different record type. It has no owner key and
    // carries a binding timestamp, so reading one as a session pointer would
    // attach a session to a project it never worked on.
    if (ptr && typeof ptr === "object" && !ptr.ownerKey && (ptr.boundAt !== undefined || ptr.repoKey !== undefined)) {
      return null;
    }
    if (ptr && ptr.ownerKey && ptr.ownerKey !== sessionKey) {
      return null;
    }
    return ptr;
  } catch {
    return null;
  }
}

export function captureSessionPointerSnapshot(stateFile) {
  const resolved = path.resolve(String(stateFile || ""));
  if (!resolved.split(path.sep).includes(PROJECTS_DIR)) {
    return { applicable: false, file: null, raw: null };
  }
  const baseDir = resolveBaseDirFromState(resolved);
  const sessionKey = sessionKeyFromStateFile(resolved);
  const file = sessionPointerPath(baseDir, sessionKey);
  try {
    const raw = readFileSync(file, "utf8");
    return { applicable: true, file, raw };
  } catch {
    return { applicable: true, file, raw: null };
  }
}

function withSessionPointerDb(baseDir, fn) {
  const sessionsDir = path.join(baseDir, SESSIONS_DIR);
  mkdirSync(sessionsDir, { recursive: true });
  const ptrDbFile = path.join(sessionsDir, "session-pointers.sqlite");
  let ptrDb = null;
  try {
    let Database;
    try {
      Database = createRequire(import.meta.url)("better-sqlite3");
    } catch {
      Database = createRequire(path.join(process.cwd(), "package.json"))("better-sqlite3");
    }
    ptrDb = new Database(ptrDbFile, { timeout: 5000 });
    ptrDb.pragma("journal_mode = DELETE");
    ptrDb.pragma("busy_timeout = 5000");
    ptrDb.exec(`
      CREATE TABLE IF NOT EXISTS session_pointers (
        session_key TEXT PRIMARY KEY,
        owner_key TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        project_dir TEXT NOT NULL,
        project_dir_path TEXT NOT NULL,
        focus_id INTEGER,
        updated_at_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        acquire_seq INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 1
      )
    `);
    const cols = ptrDb.prepare("PRAGMA table_info(session_pointers)").all();
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("acquire_seq")) {
      ptrDb.exec("ALTER TABLE session_pointers ADD COLUMN acquire_seq INTEGER NOT NULL DEFAULT 0");
    }
    if (!colNames.has("generation")) {
      ptrDb.exec("ALTER TABLE session_pointers ADD COLUMN generation INTEGER NOT NULL DEFAULT 1");
    }
    let outcome;
    const tx = ptrDb.transaction(() => {
      outcome = fn(ptrDb);
    });
    tx.immediate();
    return outcome;
  } finally {
    if (ptrDb) {
      try {
        ptrDb.close();
      } catch {
        // Ignore close cleanup errors.
      }
    }
  }
}

export function restoreSessionPointerSnapshot(snapshot, journal = null, { kernelCapability = null } = {}) {
  if (!snapshot || !snapshot.applicable || !snapshot.file) {
    return { ok: true, notApplicable: true };
  }
  let snapObj = null;
  if (snapshot.raw) {
    try {
      snapObj = JSON.parse(snapshot.raw);
    } catch {
      snapObj = null;
    }
  }
  const capProjectDir =
    snapObj?.projectDir || journal?.sourceProjectDir || journal?.targetProjectDir || "";
  const cap = kernelCapability || (capProjectDir ? getHeldWorktreeCapability(capProjectDir) : null);

  const fileSessionKey = path.basename(snapshot.file).replace(/^pointer-/, "").replace(/\.json$/, "");
  if (!capProjectDir || !fileSessionKey) {
    throw new ProjectOwnershipLostError(
      `Ownership mismatch during restoreSessionPointerSnapshot: missing destination projectDir or sessionKey`,
      {
        reason: !capProjectDir ? "invalid_target_worktree" : "missing_session_key",
        projectDir: capProjectDir,
        sessionKey: fileSessionKey,
      },
    );
  }
  if ((journal?.sessionKey && journal.sessionKey !== fileSessionKey) || (snapObj?.ownerKey && snapObj.ownerKey !== fileSessionKey)) {
    throw new ProjectOwnershipLostError(
      `Ownership mismatch during restoreSessionPointerSnapshot: pointer file session (${fileSessionKey}) disagrees with journal/snapshot session`,
      {
        reason: "pointer_session_mismatch",
        projectDir: capProjectDir,
        fileSessionKey,
        journalSessionKey: journal?.sessionKey || null,
        snapshotOwnerKey: snapObj?.ownerKey || null,
      },
    );
  }
  const sessionKey = fileSessionKey;

  const isAuthorizedRecovery =
    String(cap?.ownerKey || "").startsWith(`recovery:${sessionKey}:`) &&
    journal?.sessionKey === sessionKey &&
    (!snapObj?.ownerKey || snapObj.ownerKey === sessionKey);

  assertWorktreeCapabilityMatches({
    capability: cap,
    operation: "restoreSessionPointerSnapshot",
    ownerKey: isAuthorizedRecovery ? cap.ownerKey : sessionKey,
    projectDir: capProjectDir,
    allowDrainingInFlight: true,
  });

  const ptrParent = path.dirname(snapshot.file);
  const baseDir =
    path.basename(ptrParent) === "sessions" ? path.dirname(ptrParent) : resolveBaseDirFromState(snapshot.file);

  try {
    return withSessionPointerDb(baseDir, (ptrDb) => {
      const dbRow = ptrDb
        .prepare(
          "SELECT owner_key, lease_id, updated_at_ms, acquire_seq, generation FROM session_pointers WHERE session_key = ?",
        )
        .get(sessionKey);

      let curPtr = null;
      if (existsSync(snapshot.file)) {
        try {
          const parsed = JSON.parse(readFileSync(snapshot.file, "utf8"));
          if (parsed && typeof parsed === "object") curPtr = parsed;
        } catch {
          // Corrupt pointer file will be restored/removed atomically.
        }
      }

      const candidates = [];
      if (dbRow) {
        candidates.push({
          ownerKey: dbRow.owner_key,
          leaseId: dbRow.lease_id,
          updatedAtMs: Number(dbRow.updated_at_ms || 0),
          acquireSeq: Number(dbRow.acquire_seq || 0),
          generation: Number(dbRow.generation || 1),
        });
      }
      if (curPtr) {
        candidates.push({
          ownerKey: curPtr.ownerKey,
          leaseId: curPtr.leaseId,
          updatedAtMs: Number(
            curPtr.updatedAtMs || (curPtr.updatedAt ? Date.parse(curPtr.updatedAt) : 0) || 0,
          ),
          acquireSeq: Number(curPtr.acquireSeq || 0),
          generation: Number(curPtr.generation || 1),
        });
      }

      const journalStartedAt = Number(journal?.startedAtMs || journal?.startedAt || 0);
      const journalAcquireSeq = Number(journal?.acquireSeq || 0);
      const snapTs = Number(
        snapObj?.updatedAtMs || (snapObj?.updatedAt ? Date.parse(snapObj.updatedAt) : 0) || 0,
      );
      const snapSeq = Number(snapObj?.acquireSeq || 0);
      for (const cur of candidates) {
        if (cur.ownerKey && sessionKey && cur.ownerKey !== sessionKey) {
          return { ok: true, skippedNewerOwner: true };
        }
        const newerThanJournal =
          journal &&
          Number.isFinite(journalStartedAt) &&
          journalStartedAt > 0 &&
          (cur.updatedAtMs > journalStartedAt ||
            (cur.updatedAtMs === journalStartedAt &&
              journalAcquireSeq > 0 &&
              cur.acquireSeq > journalAcquireSeq)) &&
          (!Number.isFinite(snapTs) || cur.updatedAtMs !== snapTs || cur.acquireSeq !== snapSeq);
        const newerThanSnapshotSameMs =
          Number.isFinite(snapTs) &&
          snapTs > 0 &&
          (cur.updatedAtMs > snapTs ||
            (cur.updatedAtMs === snapTs &&
              cur.acquireSeq > snapSeq &&
              cur.leaseId &&
              cur.leaseId !== snapObj?.leaseId));
        if (newerThanJournal || newerThanSnapshotSameMs) {
          return { ok: true, skippedNewerOwner: true };
        }
      }

      const expectedGeneration = Number(dbRow?.generation ?? 0);
      const nextGeneration = dbRow ? expectedGeneration + 1 : 1;
      if (snapshot.raw === null) {
        if (dbRow) {
          const delRes = ptrDb
            .prepare("DELETE FROM session_pointers WHERE session_key = ? AND COALESCE(generation, 1) = ?")
            .run(sessionKey, expectedGeneration);
          if (delRes.changes !== 1) {
            return { ok: true, skippedNewerOwner: true };
          }
        }
        if (existsSync(snapshot.file)) unlinkSync(snapshot.file);
      } else {
        const focus = Number(snapObj?.focusId);
        const restoredTs = Number.isFinite(snapTs) && snapTs > 0 ? snapTs : Date.now();
        const restoredSeq = snapSeq > 0 ? snapSeq : 0;
        const upsertRes = dbRow
          ? ptrDb
              .prepare(
                `UPDATE session_pointers SET
                   owner_key = ?,
                   lease_id = ?,
                   project_dir = ?,
                   project_dir_path = ?,
                   focus_id = ?,
                   updated_at_ms = ?,
                   updated_at = ?,
                   acquire_seq = ?,
                   generation = ?
                 WHERE session_key = ? AND COALESCE(generation, 1) = ?`,
              )
              .run(
                String(snapObj?.ownerKey || sessionKey),
                String(snapObj?.leaseId || cap.token || ""),
                String(snapObj?.projectDir || capProjectDir || ""),
                String(snapObj?.projectDirPath || ""),
                Number.isSafeInteger(focus) && focus > 0 ? focus : null,
                restoredTs,
                String(snapObj?.updatedAt || new Date(restoredTs).toISOString()),
                restoredSeq,
                nextGeneration,
                sessionKey,
                expectedGeneration,
              )
          : ptrDb
              .prepare(
                `INSERT INTO session_pointers (
                   session_key, owner_key, lease_id, project_dir, project_dir_path, focus_id, updated_at_ms, updated_at, acquire_seq, generation
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                sessionKey,
                String(snapObj?.ownerKey || sessionKey),
                String(snapObj?.leaseId || cap.token || ""),
                String(snapObj?.projectDir || capProjectDir || ""),
                String(snapObj?.projectDirPath || ""),
                Number.isSafeInteger(focus) && focus > 0 ? focus : null,
                restoredTs,
                String(snapObj?.updatedAt || new Date(restoredTs).toISOString()),
                restoredSeq,
                nextGeneration,
              );
        if (upsertRes.changes !== 1) {
          return { ok: true, skippedNewerOwner: true };
        }
        mkdirSync(path.dirname(snapshot.file), { recursive: true });
        const tmpFile = `${snapshot.file}.tmp.${process.pid}.${Date.now()}`;
        writeFileSync(tmpFile, snapshot.raw, "utf8");
        renameSync(tmpFile, snapshot.file);
      }
      return { ok: true, skippedNewerOwner: false };
    });
  } catch (error) {
    return { ok: false, error: error?.code || error?.message || "SESSION_POINTER_RESTORE_FAILED" };
  }
}

/**
 * The project this session has already established, read from its own state file.
 *
 * `start_task` uses this to answer "is this the same repository I was already
 * working in?". A pointer whose directory no longer exists is stale - the
 * project was moved or deleted - and is ignored, so a removed checkout cannot
 * block a new project forever.
 */
export function readSessionProject({ stateFile } = {}) {
  const resolved = path.resolve(String(stateFile || ""));
  if (!resolved.split(path.sep).includes(PROJECTS_DIR)) return null;

  const baseDir = resolveBaseDirFromState(resolved);
  const sessionKey = sessionKeyFromStateFile(resolved);
  const pointer = readSessionPointer(baseDir, sessionKey);
  if (!pointer) return null;

  const projectDir = typeof pointer.projectDir === "string" ? pointer.projectDir.trim() : "";
  if (!projectDir) return null;
  if (!existsSync(projectDir)) return null;

  return {
    projectDir,
    projectDirPath: typeof pointer.projectDirPath === "string" ? pointer.projectDirPath : "",
    focusId: Number.isSafeInteger(Number(pointer.focusId)) && Number(pointer.focusId) > 0 ? Number(pointer.focusId) : null,
    updatedAt: typeof pointer.updatedAt === "string" ? pointer.updatedAt : "",
  };
}

/**
 * Records the project this session is currently working on, and returns the state
 * location it should use.
 */
export function pinSessionProject({
  stateFile,
  projectDir,
  focusId = null,
  expectedLeaseId = null,
  requireLease = false,
  kernelCapability = null,
  requireKernelMutex = false,
  expectedOwnerKey = null,
}) {
  const target = canonicalProjectPath(projectDir);
  if (!target) {
    return null;
  }

  // Only for PINNED layouts already shaped as
  // `<base>/projects/<project>/users/<user>/`.
  if (!path.resolve(stateFile).split(path.sep).includes(PROJECTS_DIR)) {
    return null;
  }

  const baseDir = resolveBaseDirFromState(stateFile);
  const sessionKey = sessionKeyFromStateFile(stateFile);
  if (expectedOwnerKey && expectedOwnerKey !== sessionKey) {
    throw new ProjectOwnershipLostError(
      `Session pointer owner override rejected in pinSessionProject: expectedOwnerKey "${expectedOwnerKey}" does not match destination session "${sessionKey}".`,
      { operation: "pinSessionProject", expectedOwnerKey, destinationSessionKey: sessionKey },
    );
  }
  const projectDirPath = path.join(baseDir, PROJECTS_DIR, projectKey(target));
  const focus = Number(focusId);

  const cap = kernelCapability || getHeldWorktreeCapability(target);
  assertWorktreeCapabilityMatches({
    capability: cap,
    operation: "pinSessionProject",
    ownerKey: sessionKey,
    projectDir: target,
    allowDrainingInFlight: true,
  });

  const ptrFile = sessionPointerPath(baseDir, sessionKey);
  let refusal = null;
  let pointerWriteError = null;
  const nowMs = Date.now();
  const capUpdatedMs = Number(cap.acquiredAt || 0);
  const capAcquireSeq = Number(cap.acquireSeq || 0);
  const effectiveUpdatedAtMs = capUpdatedMs > 0 ? capUpdatedMs : nowMs;
  const payload = {
    projectDir: target,
    projectDirPath,
    ownerKey: cap.ownerKey,
    leaseId: cap.token,
    focusId: Number.isSafeInteger(focus) && focus > 0 ? focus : null,
    updatedAtMs: effectiveUpdatedAtMs,
    updatedAt: new Date(effectiveUpdatedAtMs).toISOString(),
    acquireSeq: capAcquireSeq,
  };

  try {
    withSessionPointerDb(baseDir, (ptrDb) => {
      const dbRow = ptrDb
        .prepare("SELECT owner_key, lease_id, updated_at_ms, acquire_seq, generation FROM session_pointers WHERE session_key = ?")
        .get(sessionKey);

      let filePtr = null;
      if (existsSync(ptrFile)) {
        try {
          const parsed = JSON.parse(readFileSync(ptrFile, "utf8"));
          if (parsed && typeof parsed === "object") filePtr = parsed;
        } catch {
          // Corrupt pointer will be replaced atomically under the live capability + SQLite write lock.
        }
      }

      const candidates = [];
      if (dbRow) {
        candidates.push({
          ownerKey: dbRow.owner_key,
          leaseId: dbRow.lease_id,
          updatedAtMs: Number(dbRow.updated_at_ms || 0),
          acquireSeq: Number(dbRow.acquire_seq || 0),
          generation: Number(dbRow.generation || 1),
        });
      }
      if (filePtr) {
        candidates.push({
          ownerKey: filePtr.ownerKey,
          leaseId: filePtr.leaseId,
          updatedAtMs: Number(filePtr.updatedAtMs || (filePtr.updatedAt ? Date.parse(filePtr.updatedAt) : 0) || 0),
          acquireSeq: Number(filePtr.acquireSeq || 0),
          generation: Number(filePtr.generation || 1),
        });
      }

      for (const existingPtr of candidates) {
        if (existingPtr.ownerKey && existingPtr.ownerKey !== sessionKey) {
          refusal = {
            ok: false,
            error: "pointer_owned_by_other_session",
            projectDirPath,
            stateFile: path.join(getUserScopedDir(projectDirPath), sessionStateFilenameForKey(sessionKey)),
          };
          return;
        }
        const isSupersededByWallClock = existingPtr.updatedAtMs > capUpdatedMs;
        const isSameMsOlderOrEqualSeq =
          existingPtr.updatedAtMs === capUpdatedMs &&
          capAcquireSeq > 0 &&
          existingPtr.acquireSeq >= capAcquireSeq;
        if (
          existingPtr.leaseId &&
          existingPtr.leaseId !== cap.token &&
          (isSupersededByWallClock || isSameMsOlderOrEqualSeq)
        ) {
          refusal = {
            ok: false,
            error: "superseded_by_newer_pointer",
            projectDirPath,
            stateFile: path.join(getUserScopedDir(projectDirPath), sessionStateFilenameForKey(sessionKey)),
          };
          return;
        }
      }

      const expectedGeneration = Number(dbRow?.generation ?? 0);
      const nextGeneration = dbRow ? expectedGeneration + 1 : 1;
      const writeRes = dbRow
        ? ptrDb
            .prepare(
              `UPDATE session_pointers SET
                 owner_key = ?,
                 lease_id = ?,
                 project_dir = ?,
                 project_dir_path = ?,
                 focus_id = ?,
                 updated_at_ms = ?,
                 updated_at = ?,
                 acquire_seq = ?,
                 generation = ?
               WHERE session_key = ? AND generation = ?`,
            )
            .run(
              payload.ownerKey,
              payload.leaseId,
              payload.projectDir,
              payload.projectDirPath,
              payload.focusId,
              payload.updatedAtMs,
              payload.updatedAt,
              capAcquireSeq,
              nextGeneration,
              sessionKey,
              expectedGeneration,
            )
        : ptrDb
            .prepare(
              `INSERT INTO session_pointers (
                 session_key, owner_key, lease_id, project_dir, project_dir_path, focus_id, updated_at_ms, updated_at, acquire_seq, generation
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              sessionKey,
              payload.ownerKey,
              payload.leaseId,
              payload.projectDir,
              payload.projectDirPath,
              payload.focusId,
              payload.updatedAtMs,
              payload.updatedAt,
              capAcquireSeq,
              nextGeneration,
            );
      if (writeRes.changes !== 1) {
        refusal = {
          ok: false,
          error: "superseded_by_newer_pointer",
          projectDirPath,
          stateFile: path.join(getUserScopedDir(projectDirPath), sessionStateFilenameForKey(sessionKey)),
        };
        return;
      }

      // A session whose key looks like a focus id (`focus-42`) shares the
      // legacy flat filename with Focus 42's pre-upgrade binding. Move that
      // binding into the nested layout first, otherwise this pointer write
      // would silently erase it and free the focus for another project.
      //
      // A file that exists but cannot be parsed is not "no binding": it may be
      // a damaged focus binding, and overwriting it would destroy the evidence.
      // Refuse the pointer write instead of guessing.
      const strandedRead = readFocusBindingRecordDetailed(ptrFile);
      if (strandedRead.status === "unreadable") {
        throw new Error("FOCUS_BINDING_MIGRATION_FAILED");
      }
      const strandedBinding = strandedRead.record;
      if (strandedBinding) {
        if (!strandedBinding.focusId) {
          throw new Error("FOCUS_BINDING_MIGRATION_FAILED");
        }
        const nested = focusBindingPath(baseDir, strandedBinding.focusId);
        mkdirSync(path.dirname(nested), { recursive: true });

        // link(2) is an exclusive create: it fails with EEXIST instead of
        // replacing a binding a concurrent claim may have written between the
        // read above and this write. rename(2) would silently overwrite it.
        let linked = false;
        try {
          linkSync(ptrFile, nested);
          linked = true;
        } catch (error) {
          if (error?.code !== "EEXIST") throw new Error("FOCUS_BINDING_MIGRATION_FAILED");
        }

        if (!linked) {
          // Same acceptance rule as claimFocusBindingUnderLock: the same repo
          // key OR the same project directory is the same claim. Comparing only
          // the key would reject a checkout whose remote key changed across
          // versions even though the directory is identical.
          const alreadyNested = readFocusBindingRecord(nested);
          if (!alreadyNested) {
            throw new Error("FOCUS_BINDING_CONFLICT");
          }
          const strandedKey = strandedBinding.repoKey || "";
          const nestedKey = alreadyNested.repoKey || "";
          const sameKey = Boolean(strandedKey) && Boolean(nestedKey) && strandedKey === nestedKey;
          const sameDir =
            Boolean(strandedBinding.projectDir) &&
            Boolean(alreadyNested.projectDir) &&
            normalizeRepoPathForBinding(strandedBinding.projectDir) ===
              normalizeRepoPathForBinding(alreadyNested.projectDir);
          if (!sameKey && !sameDir) {
            throw new Error("FOCUS_BINDING_CONFLICT");
          }
        }

        // The nested record now exists; the flat name is free for the pointer.
        try {
          unlinkSync(ptrFile);
        } catch {
          throw new Error("FOCUS_BINDING_MIGRATION_FAILED");
        }
      }

      const tmpFile = `${ptrFile}.tmp.${process.pid}.${nowMs}`;
      writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");
      renameSync(tmpFile, ptrFile);
    });
  } catch (err) {
    pointerWriteError = err?.code || err?.message || "SESSION_POINTER_WRITE_FAILED";
  }

  if (refusal) {
    return refusal;
  }

  return {
    ok: !pointerWriteError,
    error: pointerWriteError,
    projectDirPath,
    stateFile: path.join(getUserScopedDir(projectDirPath), sessionStateFilenameForKey(sessionKey)),
  };
}

/**
 * Focus binding to a verified repository.
 *
 * WHY THIS EXISTS
 * ---------------
 * 13 November 2026: the Clinic focus was active, and a session working on
 * DBPinball called `start_task` without a `focusId`. The tool fell back to the
 * current focus and attached DBPinball work to the Clinic focus. A focus is a
 * container for one project's work; silently attaching foreign work to it makes
 * the focus a liar.
 *
 * The binding is stored next to the session pointers, so it is per project and
 * survives a restart. It is advisory only for the project it already names: the
 * guard in `repository-identity.js` decides whether a task may start, and the
 * binding decides whether the requested focus belongs to that project.
 */
function focusBindingPath(baseDir, focusId) {
  return path.join(baseDir, SESSIONS_DIR, "focus-bindings", `focus-${focusId}.json`);
}

/**
 * Legacy focus-binding location, before the `focus-bindings/` subdirectory.
 *
 * A session pointer is also named `focus-<id>.json` when a session key happens
 * to look like a focus id, so a record read from this path is only accepted when
 * it is genuinely a focus binding. `readFocusBindingRecord` enforces that.
 */
function legacyFocusBindingPath(baseDir, focusId) {
  return path.join(baseDir, SESSIONS_DIR, `focus-${focusId}.json`);
}

/**
 * Lock file that serializes claims on one focus.
 *
 * WHY A LOCK AND NOT `rename`
 * ---------------------------
 * A temp file renamed into place is atomic per write, but it is NOT
 * first-writer-wins: two processes that both read "no binding" would both write
 * a temp file and both rename, and the second would silently replace the first.
 * The claim decision ("is this focus free?") and the write must be one critical
 * section, which needs real mutual exclusion across operating-system processes.
 *
 * `link(2)` is the atomic primitive: the operating system guarantees exactly one
 * creator, and the record is complete before the name appears. The holder is
 * recorded so a confirmed-dead process can be detected and its lock recovered
 * instead of blocking the focus forever.
 */
const FOCUS_LOCK_TIMEOUT_MS = 2_000;
const FOCUS_LOCK_POLL_MS = 20;

function focusLockPath(baseDir, focusId) {
  return path.join(baseDir, SESSIONS_DIR, `focus-${focusId}.lock`);
}

function readFocusLockRecord(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Is the current holder confirmed gone?
 *
 * LIVENESS RULE
 * -------------
 * Elapsed time alone never proves abandonment. A live process may legitimately
 * hold a focus lock for longer than any timeout, and stealing it because the
 * timestamp is old would let two processes own one focus - the exact defect the
 * lock exists to prevent.
 *
 *   - owner confirmed dead        -> stale, recoverable
 *   - owner confirmed alive       -> NOT stale, regardless of age
 *   - liveness unknown            -> NOT stale (fail closed)
 *   - record unreadable           -> NOT stale (fail closed)
 *   - different host              -> NOT stale (cannot verify a remote PID)
 *
 * PID reuse makes a dead owner look alive; that is fail-closed and safe. The
 * bounded acquisition timeout reports the block instead of stealing the lock.
 */
function focusLockIsStale(file, { isAlive = defaultPidIsAlive, hostname = os.hostname() } = {}) {
  const record = readFocusLockRecord(file);
  if (!record) return false;

  const pid = Number(record.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  // A lock written by another machine cannot be verified from here. Stealing it
  // would be a guess, so it is treated as live.
  const host = typeof record.host === "string" ? record.host.trim() : "";
  if (host && hostname && host !== hostname) return false;

  // Our own process holding the lock is a re-entrancy bug, not a stale lock.
  if (pid === process.pid) return false;

  return !isAlive(pid);
}

/**
 * Claim the right to recover one stale lock.
 *
 * Two processes can both observe the same stale lock. Renaming it is atomic and
 * succeeds for exactly one of them, so only that process proceeds to create a
 * new lock. The loser retries the atomic create and finds the winner's lock.
 */
/**
 * Recover a stale focus lock and atomically acquire a fresh lock under
 * SQLite `BEGIN IMMEDIATE` serialization (`withSessionPointerDb`), so two
 * delayed observers cannot race on a recovery lock file or evict a newly
 * created successor lock.
 */
function tryRecoverAndAcquireFocusLock(baseDir, file, lockToken) {
  try {
    return withSessionPointerDb(baseDir, () => {
      if (!focusLockIsStale(file)) {
        return false;
      }
      const tombstone = `${file}.stale.${process.pid}.${Date.now()}`;
      try {
        renameSync(file, tombstone);
      } catch {
        return false;
      }
      try {
        unlinkSync(tombstone);
      } catch {
        // The tombstone is harmless; the lock itself is already gone.
      }
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(
        temporary,
        JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now(), token: lockToken }),
      );
      try {
        linkSync(temporary, file);
      } finally {
        try {
          unlinkSync(temporary);
        } catch {
          // Best-effort cleanup of the temp name.
        }
      }
      return true;
    });
  } catch {
    return false;
  }
}

function releaseOwnedFocusLock(lock) {
  if (!lock?.file) return;
  try {
    if (lock.token && existsSync(lock.file)) {
      const current = JSON.parse(readFileSync(lock.file, "utf8"));
      if (current?.token && current.token !== lock.token) {
        return;
      }
    }
    unlinkSync(lock.file);
  } catch {
    // Releasing is best-effort; a leftover lock is broken as stale later.
  }
}

function defaultPidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

async function acquireFocusLock({ baseDir, focusId, timeoutMs = FOCUS_LOCK_TIMEOUT_MS }) {
  const file = focusLockPath(baseDir, focusId);
  mkdirSync(path.join(baseDir, SESSIONS_DIR), { recursive: true });
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);

  for (;;) {
    try {
      const lockToken = randomUUID();
      // Write the record to a temp file and hard-link it into place. `link` is
      // atomic and fails when the target exists, and the content is complete
      // before the name appears - so a crash can never leave an unreadable lock.
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(
        temporary,
        JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now(), token: lockToken }),
      );
      try {
        linkSync(temporary, file);
      } finally {
        try {
          unlinkSync(temporary);
        } catch {
          // Best-effort cleanup of the temp name.
        }
      }
      return { ok: true, file, token: lockToken };
    } catch (error) {
      if (error.code !== "EEXIST") return { ok: false, code: "FOCUS_LOCK_UNWRITABLE" };

      if (focusLockIsStale(file)) {
        // Serialize stale-check + tombstone + fresh lock creation inside SQLite BEGIN IMMEDIATE.
        const recoveredToken = randomUUID();
        if (tryRecoverAndAcquireFocusLock(baseDir, file, recoveredToken)) {
          return { ok: true, file, token: recoveredToken };
        }
      }

      if (Date.now() >= deadline) return { ok: false, code: "FOCUS_CLAIM_TIMEOUT" };
      await new Promise((resolve) => setTimeout(resolve, FOCUS_LOCK_POLL_MS));
    }
  }
}

/**
 * Bind a focus to a verified repository, exclusively.
 *
 * LIFECYCLE
 * ---------
 * - First writer wins under a cross-process lock. Two processes claiming the
 *   same focus for different projects produce exactly one success; the loser
 *   re-reads and reports `FOCUS_BOUND_TO_ANOTHER_PROJECT`.
 * - A binding whose project directory no longer exists is stale. It is replaced
 *   on the next legitimate use, so a deleted or moved checkout cannot block
 *   project recovery forever.
 * - Retirement is explicit: `retireFocusBinding` takes the same lock and removes
 *   the record. Nothing else deletes it.
 */
export async function claimFocusBinding({
  stateFile,
  focusId,
  projectDir,
  repoKey,
  timeoutMs,
  kernelCapability = null,
  requireKernelMutex = false,
  expectedOwnerKey = null,
} = {}) {
  const id = Number(focusId);
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, reason: "INVALID_FOCUS" };

  const cap = kernelCapability || (projectDir ? getHeldWorktreeCapability(projectDir) : null);
  const effectiveOwnerKey = expectedOwnerKey || (stateFile ? sessionKeyFromStateFile(stateFile) : null);
  const enforceFocusCap = Boolean(kernelCapability || requireKernelMutex || cap);
  const validateFocusCap = () => {
    if (enforceFocusCap) {
      assertWorktreeCapabilityMatches({
        capability: cap,
        operation: "claimFocusBinding",
        ownerKey: effectiveOwnerKey,
        projectDir: projectDir || null,
        allowDrainingInFlight: true,
      });
    }
  };
  validateFocusCap();

  const runClaim = async () => {
    const baseDir = resolveBaseDirFromState(stateFile);
    const lock = await acquireFocusLock({ baseDir, focusId: id, timeoutMs });
    if (!lock.ok) return { ok: false, reason: lock.code };

    try {
      validateFocusCap();
      return claimFocusBindingUnderLock({ baseDir, focusId: id, projectDir, repoKey });
    } finally {
      releaseOwnedFocusLock(lock);
    }
  };

  return cap ? await useWorktreeCapability(cap, runClaim) : await runClaim();
}

function claimFocusBindingUnderLock({ baseDir, focusId, projectDir, repoKey }) {
  const target = focusBindingPath(baseDir, focusId);
  // The binding lives in its own subdirectory so a session pointer named
  // `focus-<id>.json` can never collide with it.
  mkdirSync(path.dirname(target), { recursive: true });
  const requestedDir = path.resolve(String(projectDir || ""));
  const requestedKey = typeof repoKey === "string" ? repoKey.trim() : "";

  const bindingState = readFocusBindingState(baseDir, focusId);
  // A damaged record is NOT "unbound". Overwriting it would destroy the only
  // evidence of who owned the focus, and the write would silently steal it.
  if (bindingState.unreadable) {
    return {
      ok: false,
      reason: "FOCUS_BINDING_UNREADABLE",
      unreadablePaths: bindingState.unreadablePaths,
      error: bindingState.unreadableReason,
    };
  }
  if (bindingState.conflict) {
    return { ok: false, existing: bindingState.nested, reason: "FOCUS_BINDING_CONFLICT" };
  }
  const existing = bindingState.record;
  let replacingStale = false;

  if (existing) {
    const sameKey = Boolean(existing.repoKey) && Boolean(requestedKey) && existing.repoKey === requestedKey;
    const sameDir =
      Boolean(existing.projectDir) &&
      normalizeRepoPathForBinding(existing.projectDir) === normalizeRepoPathForBinding(requestedDir);
    if (sameKey || sameDir) {
      return { ok: true, existing, reason: "ALREADY_BOUND" };
    }
    if (existing.projectDir && !existsSync(existing.projectDir)) {
      replacingStale = true;
    } else {
      return { ok: false, existing, reason: "FOCUS_BOUND_TO_ANOTHER_PROJECT" };
    }
  }

  const record = {
    focusId,
    projectDir: requestedDir,
    repoKey: requestedKey,
    boundAt: new Date().toISOString(),
  };

  try {
    // Atomic write: a crash mid-write must not leave truncated JSON, because a
  // truncated record reads as "unbound" and would free the focus for another
  // project.
  const claimTmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(claimTmp, JSON.stringify(record, null, 2), "utf8");
  renameSync(claimTmp, target);
    return { ok: true, existing: record, reason: replacingStale ? "REBOUND_STALE" : "BOUND" };
  } catch {
    return { ok: false, reason: "FOCUS_BINDING_UNWRITABLE" };
  }
}

/** Backward-compatible name; both share the one exclusive implementation. */
export function writeFocusBinding(options = {}) {
  return claimFocusBinding(options);
}

/**
 * Retire a focus binding explicitly.
 *
 * Takes the same lock as a claim, so a retirement cannot interleave with a
 * concurrent claim and erase a binding that was just written.
 */
export async function retireFocusBinding({
  stateFile,
  focusId,
  projectDir,
  repoKey,
  reason = "",
  kernelCapability = null,
  requireKernelMutex = false,
  expectedOwnerKey = null,
} = {}) {
  const id = Number(focusId);
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, reason: "INVALID_FOCUS" };

  const cap = kernelCapability || (projectDir ? getHeldWorktreeCapability(projectDir) : null);
  const effectiveOwnerKey = expectedOwnerKey || (stateFile ? sessionKeyFromStateFile(stateFile) : null);
  const enforceRetireCap = Boolean(kernelCapability || requireKernelMutex || cap);
  const validateRetireCap = () => {
    if (enforceRetireCap) {
      assertWorktreeCapabilityMatches({
        capability: cap,
        operation: "retireFocusBinding",
        ownerKey: effectiveOwnerKey,
        projectDir: projectDir || null,
        allowDrainingInFlight: true,
      });
    }
  };
  validateRetireCap();

  const runRetire = async () => {
    const baseDir = resolveBaseDirFromState(stateFile);
    const lock = await acquireFocusLock({ baseDir, focusId: id });
    if (!lock.ok) return { ok: false, reason: lock.code };

    try {
      validateRetireCap();
      const target = focusBindingPath(baseDir, id);
      const legacyTarget = legacyFocusBindingPath(baseDir, id);
      const bindingState = readFocusBindingState(baseDir, id);
      // Refuse to delete a record we could not read: retiring it would erase
      // the damage instead of preserving it for inspection.
      if (bindingState.unreadable) {
        return {
          ok: false,
          reason: "FOCUS_BINDING_UNREADABLE",
          unreadablePaths: bindingState.unreadablePaths,
          error: bindingState.unreadableReason,
        };
      }
      if (bindingState.conflict) {
        return { ok: false, existing: bindingState.nested, reason: "FOCUS_BINDING_CONFLICT" };
      }

      const existing = bindingState.record;
      if (!existing) return { ok: true, retired: false, reason: "NOT_BOUND" };

      const requestedDir = projectDir ? path.resolve(String(projectDir)) : "";
      const requestedKey = typeof repoKey === "string" ? repoKey.trim() : "";
      if (existing.projectDir) {
        if (
          !requestedDir ||
          normalizeRepoPathForBinding(existing.projectDir) !== normalizeRepoPathForBinding(requestedDir)
        ) {
          return { ok: false, existing, reason: "FOCUS_BOUND_TO_ANOTHER_PROJECT" };
        }
      }
      if (existing.repoKey) {
        if (requestedKey && existing.repoKey !== requestedKey) {
          return { ok: false, existing, reason: "FOCUS_BOUND_TO_ANOTHER_PROJECT" };
        }
        if (!existing.projectDir && !requestedKey) {
          return { ok: false, existing, reason: "FOCUS_BOUND_TO_ANOTHER_PROJECT" };
        }
      }
      if (enforceRetireCap && !requestedDir && !requestedKey) {
        return { ok: false, existing, reason: "FOCUS_BOUND_TO_ANOTHER_PROJECT" };
      }

      try {
        // The nested file exists only when this focus was claimed after the
        // layout change. Unlinking it unconditionally would throw for a
        // legacy-only binding and make it impossible to retire.
        try {
          unlinkSync(target);
        } catch {
          // no nested record
        }
        // A legacy binding at the flat path is retired too, so a stale record
        // cannot resurrect the claim after the new one is gone. Only unlink it
        // when it really is a focus binding: the same filename can hold a
        // session pointer, which must survive.
        if (readFocusBindingRecord(legacyTarget)) {
          try {
            unlinkSync(legacyTarget);
          } catch {
            // already gone
          }
        }
        // Report honestly: a file that is still readable after the unlink
        // attempts means the binding is still active.
        if (readFocusBindingRecord(target) || readFocusBindingRecord(legacyTarget)) {
          return { ok: false, existing, reason: "RETIRE_FAILED" };
        }
        return {
          ok: true,
          retired: true,
          previous: existing,
          reason: typeof reason === "string" ? reason.trim() : "",
        };
      } catch {
        return { ok: false, reason: "RETIRE_FAILED" };
      }
    } finally {
      releaseOwnedFocusLock(lock);
    }
  };

  return cap ? await useWorktreeCapability(cap, runRetire) : await runRetire();
}

/** The repository a focus is already bound to, or null. */
export function readFocusBinding({ stateFile, focusId } = {}) {
  const id = Number(focusId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const baseDir = resolveBaseDirFromState(stateFile);
  return (
    readFocusBindingRecord(focusBindingPath(baseDir, id)) ||
    readFocusBindingRecord(legacyFocusBindingPath(baseDir, id))
  );
}

/**
 * Capture the current focus binding so a failed transition can be rolled back.
 *
 * `raw` is the file content, `raw: null` means "there was no binding". A file
 * that exists but cannot be read is NOT the same as an absent one: recording it
 * as `raw: null` would make the restore path delete a damaged but real record.
 * That case is reported as unreadable and the caller must not roll back over it.
 */
export function captureFocusBindingSnapshot({ stateFile, focusId } = {}) {
  const id = Number(focusId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { applicable: false, file: null, raw: null, focusId: null, baseDir: null };
  }
  const baseDir = resolveBaseDirFromState(stateFile);
  const file = focusBindingPath(baseDir, id);
  try {
    const raw = readFileSync(file, "utf8");
    try {
      JSON.parse(raw);
    } catch {
      return { applicable: true, file, raw: null, focusId: id, baseDir, unreadable: "FOCUS_BINDING_MALFORMED" };
    }
    return { applicable: true, file, raw, focusId: id, baseDir, unreadable: null };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { applicable: true, file, raw: null, focusId: id, baseDir, unreadable: null };
    }
    return {
      applicable: true,
      file,
      raw: null,
      focusId: id,
      baseDir,
      unreadable: error?.code || "FOCUS_BINDING_UNREADABLE",
    };
  }
}

export async function restoreFocusBindingSnapshot(snapshot, journal = null) {
  if (!snapshot || !snapshot.applicable || !snapshot.file || !snapshot.baseDir || !snapshot.focusId) {
    return { ok: true, notApplicable: true };
  }
  // A snapshot of a damaged record cannot be restored by deleting it: that
  // would destroy the only evidence of who owned the focus.
  if (snapshot.unreadable) {
    return { ok: false, error: "FOCUS_BINDING_UNREADABLE", reason: snapshot.unreadable };
  }
  const lock = await acquireFocusLock({ baseDir: snapshot.baseDir, focusId: snapshot.focusId });
  if (!lock || !lock.ok) {
    return { ok: false, error: lock?.reason || "FOCUS_LOCK_BUSY" };
  }
  try {
    if (existsSync(snapshot.file) && journal) {
      try {
        const cur = JSON.parse(readFileSync(snapshot.file, "utf8"));
        const curTs = cur?.boundAt ? Date.parse(cur.boundAt) : NaN;
        if (Number.isFinite(curTs) && Number.isFinite(Number(journal.startedAt)) && curTs > Number(journal.startedAt) + 5) {
          let snapTs = NaN;
          if (snapshot.raw) {
            try {
              snapTs = Date.parse(JSON.parse(snapshot.raw)?.boundAt || "");
            } catch {}
          }
          if (!Number.isFinite(snapTs) || curTs !== snapTs) {
            return { ok: true, skippedNewerOwner: true };
          }
        }
      } catch {}
    }
    if (snapshot.raw === null) {
      if (existsSync(snapshot.file)) unlinkSync(snapshot.file);
    } else {
      mkdirSync(path.dirname(snapshot.file), { recursive: true });
      writeFileSync(snapshot.file, snapshot.raw, "utf8");
    }
    return { ok: true, skippedNewerOwner: false };
  } catch (error) {
    return { ok: false, error: error?.code || error?.message || "FOCUS_BINDING_RESTORE_FAILED" };
  } finally {
    if (lock && lock.ok && lock.file) {
      try {
        unlinkSync(lock.file);
      } catch {}
    }
  }
}

function transitionJournalPath(baseDir, sessionKey) {
  return path.join(baseDir, SESSIONS_DIR, `transition-${sessionKey}.journal.json`);
}

function writeJournalFileAtomic(journalFile, payload) {
  mkdirSync(path.dirname(journalFile), { recursive: true });
  const tmpFile = `${journalFile}.tmp.${process.pid}.${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");
  renameSync(tmpFile, journalFile);
}

function captureFileSnapshot(filePath) {
  if (!filePath) return { file: null, existed: false, raw: null };
  const resolved = path.resolve(filePath);
  try {
    if (!existsSync(resolved)) {
      return { file: resolved, existed: false, raw: null };
    }
    return { file: resolved, existed: true, raw: readFileSync(resolved, "utf8") };
  } catch {
    return { file: resolved, existed: false, raw: null };
  }
}

function isStateSupersededByNewerOwner(currentObj, snap, journal, role) {
  if (!currentObj || typeof currentObj !== "object" || !journal) return false;
  const currentJournalId = currentObj.transitionJournalId || null;
  if (currentJournalId && currentJournalId === journal.journalId) {
    // Written by this exact crashed transition: safe to roll back.
    return false;
  }
  if (currentJournalId && currentJournalId !== journal.journalId) {
    // Written by a different, newer transition.
    return true;
  }
  const curPid = Number(currentObj?.owner?.pid);
  const curUpdatedAt = currentObj?.owner?.updatedAt ? Date.parse(currentObj.owner.updatedAt) : NaN;
  if (role === "target") {
    // Target state belongs to a newer owner if it has an active task or different PID
    // and was not stamped with our journalId.
    if (Number.isFinite(curPid) && curPid > 0 && curPid !== journal.pid) {
      return true;
    }
    if (Number.isFinite(curUpdatedAt) && curUpdatedAt > (journal.startedAt || 0) && (!snap || !snap.existed)) {
      return true;
    }
  } else {
    // Source state: if a newer PID or newer timestamp (after journal started) modified it
    // without our journalId, do not overwrite newer legitimate state.
    if (Number.isFinite(curPid) && curPid > 0 && curPid !== journal.pid) {
      return true;
    }
    if (Number.isFinite(curUpdatedAt) && curUpdatedAt > (journal.startedAt || 0)) {
      return true;
    }
  }
  return false;
}

function restoreFileSnapshot(snap, journal = null, role = "source") {
  if (!snap || !snap.file) return { ok: true, skipped: false };
  try {
    if (existsSync(snap.file)) {
      try {
        const curObj = JSON.parse(readFileSync(snap.file, "utf8"));
        if (isStateSupersededByNewerOwner(curObj, snap, journal, role)) {
          return { ok: true, skippedNewerOwner: true };
        }
      } catch {}
    } else if (!snap.existed || snap.raw === null) {
      return { ok: true, alreadyAbsent: true };
    }

    if (!snap.existed || snap.raw === null) {
      if (existsSync(snap.file)) unlinkSync(snap.file);
    } else {
      mkdirSync(path.dirname(snap.file), { recursive: true });
      const tmp = `${snap.file}.restore.${process.pid}.${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      writeFileSync(tmp, snap.raw, "utf8");
      renameSync(tmp, snap.file);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.code || error?.message || "FILE_RESTORE_FAILED" };
  }
}

function restoreFocusBindingSnapshotSync(snapshot, journal = null) {
  if (!snapshot || !snapshot.applicable || !snapshot.file) {
    return { ok: true, notApplicable: true };
  }
  if (snapshot.unreadable) {
    return { ok: false, error: "FOCUS_BINDING_UNREADABLE", reason: snapshot.unreadable };
  }
  let lockFile = null;
  if (snapshot.baseDir && snapshot.focusId) {
    const candidateLock = focusLockPath(snapshot.baseDir, snapshot.focusId);
    try {
      mkdirSync(path.join(snapshot.baseDir, SESSIONS_DIR), { recursive: true });
      const tmp = `${candidateLock}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now() }));
      try {
        linkSync(tmp, candidateLock);
        lockFile = candidateLock;
      } catch (err) {
        if (err?.code === "EEXIST" && focusLockIsStale(candidateLock) && tryRecoverStaleLock(candidateLock)) {
          linkSync(tmp, candidateLock);
          lockFile = candidateLock;
        } else {
          return { ok: false, error: "FOCUS_LOCK_BUSY" };
        }
      } finally {
        try {
          unlinkSync(tmp);
        } catch {}
      }
    } catch (error) {
      return { ok: false, error: error?.code || error?.message || "FOCUS_LOCK_ERROR" };
    }
  }
  try {
    if (existsSync(snapshot.file) && journal) {
      try {
        const cur = JSON.parse(readFileSync(snapshot.file, "utf8"));
        const curTs = cur?.boundAt ? Date.parse(cur.boundAt) : NaN;
        if (Number.isFinite(curTs) && Number.isFinite(Number(journal.startedAt)) && curTs > Number(journal.startedAt) + 5) {
          let snapTs = NaN;
          if (snapshot.raw) {
            try {
              snapTs = Date.parse(JSON.parse(snapshot.raw)?.boundAt || "");
            } catch {}
          }
          if (!Number.isFinite(snapTs) || curTs !== snapTs) {
            return { ok: true, skippedNewerOwner: true };
          }
        }
      } catch {}
    }
    if (snapshot.raw === null) {
      if (existsSync(snapshot.file)) unlinkSync(snapshot.file);
    } else {
      mkdirSync(path.dirname(snapshot.file), { recursive: true });
      writeFileSync(snapshot.file, snapshot.raw, "utf8");
    }
    return { ok: true, skippedNewerOwner: false };
  } catch (error) {
    return { ok: false, error: error?.code || error?.message || "FOCUS_BINDING_RESTORE_FAILED" };
  } finally {
    if (lockFile) {
      try {
        unlinkSync(lockFile);
      } catch {}
    }
  }
}

async function captureDbRowSnapshot(stateFile, sessionKey) {
  if (!stateFile) return null;
  const resolved = path.resolve(stateFile);
  const userId = getCurrentUserId(resolved);
  const projectPath = normalizeProjectPath(resolveProjectRootForState(resolved));
  try {
    const mod = await import("./db/index.js");
    const db = await mod.getLocalAdapter({ stateFile: resolved });
    await db.connect();
    const rawRow = db.db
      .prepare(
        "SELECT state_json, version, updated_at FROM workflow_state WHERE user_id = ? AND project_path = ? AND session_key = ?",
      )
      .get(userId, projectPath, sessionKey);
    return {
      stateFile: resolved,
      userId,
      projectPath,
      sessionKey,
      existed: Boolean(rawRow),
      stateJson: rawRow ? rawRow.state_json : null,
      version: rawRow ? rawRow.version : null,
      updatedAt: rawRow ? rawRow.updated_at : null,
    };
  } catch {
    return {
      stateFile: resolved,
      userId,
      projectPath,
      sessionKey,
      existed: false,
      stateJson: null,
      version: null,
      updatedAt: null,
    };
  }
}

async function restoreDbRowSnapshot(dbSnap, journal = null, role = "source") {
  if (!dbSnap || !dbSnap.stateFile) return { ok: true, skipped: false };
  try {
    const mod = await import("./db/index.js");
    const db = await mod.getLocalAdapter({ stateFile: dbSnap.stateFile });
    await db.connect();

    const currentRow = db.db
      .prepare(
        "SELECT state_json, version, updated_at FROM workflow_state WHERE user_id = ? AND project_path = ? AND session_key = ?",
      )
      .get(dbSnap.userId, dbSnap.projectPath, dbSnap.sessionKey);

    if (currentRow && currentRow.state_json) {
      let curObj = null;
      try {
        curObj = JSON.parse(currentRow.state_json);
      } catch {}
      if (curObj && isStateSupersededByNewerOwner(curObj, dbSnap, journal, role)) {
        return { ok: true, skippedNewerOwner: true };
      }
      if (
        role === "source" &&
        dbSnap.existed &&
        Number.isFinite(Number(dbSnap.version)) &&
        Number.isFinite(Number(currentRow.version)) &&
        Number(currentRow.version) > Number(dbSnap.version) &&
        (!curObj || curObj.transitionJournalId !== journal?.journalId)
      ) {
        return { ok: true, skippedNewerOwner: true };
      }
    }

    if (!dbSnap.existed || dbSnap.stateJson === null) {
      db.db
        .prepare(
          "DELETE FROM workflow_state WHERE user_id = ? AND project_path = ? AND session_key = ?",
        )
        .run(dbSnap.userId, dbSnap.projectPath, dbSnap.sessionKey);
      db.db
        .prepare(
          "DELETE FROM state_writer WHERE user_id = ? AND project_path = ? AND session_key = ?",
        )
        .run(dbSnap.userId, dbSnap.projectPath, dbSnap.sessionKey);
    } else {
      db.db
        .prepare(
          `INSERT INTO workflow_state (user_id, project_path, session_key, state_json, version, updated_at)
           VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
           ON CONFLICT(user_id, project_path, session_key) DO UPDATE SET
             state_json = excluded.state_json,
             version = excluded.version,
             updated_at = excluded.updated_at`,
        )
        .run(
          dbSnap.userId,
          dbSnap.projectPath,
          dbSnap.sessionKey,
          dbSnap.stateJson,
          dbSnap.version,
          dbSnap.updatedAt,
        );
    }

    // R3-4: Never delete or overwrite `project_summary`, so the
    // project summary and newer task history are never lost.
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.code || error?.message || "DB_RESTORE_FAILED" };
  }
}

/**
 * Starts the durable transition journal before
 * mutating the focus, the session pointer, or the target state file (R2-4).
 */
export async function beginTransitionJournal({
  sourceStateFile,
  targetStateFile,
  sourceProjectDir = "",
  targetProjectDir = "",
  sessionId = null,
  focusId = null,
  stagedLock = null,
  priorStateSnapshot = null,
  priorStateVersion = null,
  priorLoadedTask = "",
  priorBoundLease = null,
  priorActiveProjectDir = "",
} = {}) {
  const resolvedSource = path.resolve(String(sourceStateFile || ""));
  const resolvedTarget = path.resolve(String(targetStateFile || resolvedSource));
  const isPinned = resolvedSource.split(path.sep).includes(PROJECTS_DIR) || resolvedTarget.split(path.sep).includes(PROJECTS_DIR);
  const baseDir = isPinned
    ? resolveBaseDirFromState(resolvedTarget.split(path.sep).includes(PROJECTS_DIR) ? resolvedTarget : resolvedSource)
    : path.dirname(resolvedSource);
  const sessionKey = sessionKeyFromStateFile(resolvedSource) || resolveSessionKey(process.env, sessionId);
  const journalFile = transitionJournalPath(baseDir, sessionKey);

  const sourceHistoryFile = resolveHistoryFile(resolvedSource);
  const sourceSummaryFile = path.join(path.dirname(resolvedSource), PROJECT_SUMMARY_FILENAME);
  const targetHistoryFile = resolveHistoryFile(resolvedTarget);
  const targetSummaryFile = path.join(path.dirname(resolvedTarget), PROJECT_SUMMARY_FILENAME);

  const sourceDbSnapshot = await captureDbRowSnapshot(resolvedSource, sessionKey);
  const targetDbSnapshot =
    resolvedTarget === resolvedSource
      ? sourceDbSnapshot
      : await captureDbRowSnapshot(resolvedTarget, sessionKey);

  const sourceStateSnap = captureFileSnapshot(resolvedSource);
  const targetStateSnap = captureFileSnapshot(resolvedTarget);
  const priorSessionPointer = captureSessionPointerSnapshot(resolvedSource);
  const priorFocusBinding =
    Number.isSafeInteger(Number(focusId)) && Number(focusId) > 0
      ? captureFocusBindingSnapshot({ stateFile: resolvedSource, focusId: Number(focusId) })
      : null;

  const extractSnapProjectDir = (snap) => {
    if (!snap || typeof snap.raw !== "string" || !snap.raw.trim()) return "";
    try {
      const obj = JSON.parse(snap.raw);
      return typeof obj?.projectDir === "string" ? obj.projectDir.trim() : "";
    } catch {
      return "";
    }
  };

  const resolvedSourceProjectDir =
    (typeof sourceProjectDir === "string" && sourceProjectDir.trim()) ||
    extractSnapProjectDir(sourceStateSnap) ||
    extractSnapProjectDir(priorSessionPointer) ||
    (typeof priorStateSnapshot?.projectDir === "string" && priorStateSnapshot.projectDir.trim()) ||
    (typeof priorActiveProjectDir === "string" && priorActiveProjectDir.trim()) ||
    "";
  const resolvedTargetProjectDir =
    (typeof targetProjectDir === "string" && targetProjectDir.trim()) ||
    extractSnapProjectDir(targetStateSnap) ||
    resolvedSourceProjectDir ||
    "";

  const journal = {
    journalId: randomUUID(),
    phase: "STAGED",
    pid: process.pid,
    incarnationId: PROCESS_INCARNATION_ID,
    startedAt: Date.now(),
    baseDir,
    sessionKey,
    journalFile,
    sourceProjectDir: resolvedSourceProjectDir,
    targetProjectDir: resolvedTargetProjectDir,
    sourceStateFile: resolvedSource,
    sourceHistoryFile,
    targetStateFile: resolvedTarget,
    targetHistoryFile,
    sourceStateSnap,
    targetStateSnap,
    sourceDbSnapshot,
    targetDbSnapshot,
    priorSessionPointer,
    priorFocusBinding,
    fromLockDir: stagedLock?.fromDir || null,
    fromLeaseId:
      stagedLock?.heldSourceLease?.leaseId ||
      stagedLock?.previousLease?.leaseId ||
      null,
    toLockDir: stagedLock?.dir || null,
    toLeaseId: stagedLock?.leaseId || null,
    relocatedLock: Boolean(stagedLock?.relocated),
    priorInMemory: {
      state: priorStateSnapshot,
      stateVersion: priorStateVersion,
      loadedTask: priorLoadedTask,
      boundLease: priorBoundLease,
      activeProjectDir: priorActiveProjectDir,
    },
  };

  // R3-5: A failed transition journal write MUST fail the transition (fail-closed).
  writeJournalFileAtomic(journalFile, journal);

  return journal;
}

/**
 * Authoritative Commit Point for a transition (R2-4 + R3-5).
 * A failure while marking `COMMITTED` throws so rollback runs.
 */
export function markTransitionJournalCommitted(journal) {
  if (!journal || !journal.journalFile) {
    throw new Error("Cannot mark missing transition journal as committed.");
  }
  journal.phase = "COMMITTED";
  journal.committedAt = Date.now();
  writeJournalFileAtomic(journal.journalFile, journal);
  return true;
}

export function completeTransitionJournal(journal) {
  if (!journal || !journal.journalFile) return false;
  if (existsSync(journal.journalFile)) {
    unlinkSync(journal.journalFile);
  }
  return true;
}

function acquireJournalRecoveryLock(journalFile, journalId, { isAlive = currentIsAlive(), isHolderProcess = currentIsHolderProcess() } = {}) {
  const recoverLockFile = `${journalFile}.recover.lock`;
  const recoverToken = `jrec-${process.pid}-${PROCESS_INCARNATION_ID}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    publishCompleteJsonFile(
      recoverLockFile,
      {
        pid: process.pid,
        incarnationId: PROCESS_INCARNATION_ID,
        token: recoverToken,
        journalId: journalId || null,
        startedAt: Date.now(),
        host: os.hostname(),
      },
      { replaceIfExists: false, pid: process.pid },
    );
    return { ok: true, recoverLockFile, token: recoverToken };
  } catch (error) {
    if (error && error.code === "EEXIST") {
      try {
        const existing = JSON.parse(readFileSync(recoverLockFile, "utf8"));
        if (existing && !isJournalOwnerConfirmedDead(existing, { isAlive, isHolderProcess })) {
          return { ok: false, reason: "recovery_in_progress", recoverLockFile, holder: existing };
        }
        return { ok: false, reason: "recovery_lock_abandoned", recoverLockFile, holder: existing };
      } catch {
        return { ok: false, reason: "recovery_lock_abandoned", recoverLockFile, holder: null };
      }
    }
    return { ok: false, reason: "recovery_lock_error", error: error?.code || error?.message || "EACCES" };
  }
}

function releaseJournalRecoveryLock(lockHandle) {
  if (!lockHandle || !lockHandle.ok || !lockHandle.recoverLockFile) return;
  try {
    if (existsSync(lockHandle.recoverLockFile)) {
      const disk = JSON.parse(readFileSync(lockHandle.recoverLockFile, "utf8"));
      if (disk && disk.token === lockHandle.token) {
        unlinkSync(lockHandle.recoverLockFile);
      }
    }
  } catch {}
}

function releaseOrphanedLockFromJournal(dir, expectedLeaseId, deadPid, { recoveryAuthority = null } = {}) {
  if (!dir || !expectedLeaseId) return { ok: false, reason: "missing_args" };
  const resolvedDir = path.resolve(dir);
  const gateFile = path.join(resolvedDir, GATE_FILENAME);
  if (existsSync(gateFile)) {
    try {
      const gateData = JSON.parse(readFileSync(gateFile, "utf8"));
      if (gateData && gateData.pid === deadPid && gateData.token) {
        if (!isTrustedGateRecoveryAuthority(recoveryAuthority)) {
          return { ok: false, reason: "abandoned_gate_requires_trusted_authority", gateFile };
        }
        const gateRec = recoverAbandonedLockGate({
          dir: resolvedDir,
          expectedToken: gateData.token,
          recoveryAuthority,
        });
        if (!gateRec.ok) {
          return { ok: false, reason: gateRec.reason || "gate_recovery_failed", gateFile };
        }
      }
    } catch {}
  }
  const lock = readProcessLock({ dir: resolvedDir });
  if (lock && lock.leaseId === expectedLeaseId) {
    return releaseProcessLock({
      dir: resolvedDir,
      pid: lock.pid,
      leaseId: expectedLeaseId,
      preserveRemembered: true,
    });
  }
  return { ok: true, alreadyAbsent: true };
}

function rollbackJournalFilesAndLocksSync(
  journal,
  { isCrashRecovery = false, recoveryAuthority = null, skipFocusSync = false, supersededByNewerOwner = false } = {},
) {
  if (!journal) return { ok: true };

  const results = [];
  if (journal.targetStateFile && journal.targetStateFile !== journal.sourceStateFile) {
    results.push(restoreFileSnapshot(journal.targetStateSnap, journal, "target"));
  }
  results.push(restoreFileSnapshot(journal.sourceStateSnap, journal, "source"));

  const anySuperseded =
    supersededByNewerOwner || results.some((r) => Boolean(r && r.skippedNewerOwner));

  if (!anySuperseded && journal.priorSessionPointer && journal.priorSessionPointer.applicable) {
    const ptrRes = restoreSessionPointerSnapshot(journal.priorSessionPointer, journal);
    if (ptrRes && ptrRes.ok === false) {
      return { ok: false, error: ptrRes.error || "SESSION_POINTER_RESTORE_FAILED" };
    }
  }
  if (!anySuperseded && !skipFocusSync && journal.priorFocusBinding && journal.priorFocusBinding.applicable) {
    const focusRes = restoreFocusBindingSnapshotSync(journal.priorFocusBinding, journal);
    if (focusRes && focusRes.ok === false) {
      return { ok: false, error: focusRes.error || "FOCUS_BINDING_RESTORE_FAILED" };
    }
  }

  if (isCrashRecovery && journal.relocatedLock && journal.toLockDir && journal.toLockDir !== journal.fromLockDir) {
    releaseOrphanedLockFromJournal(journal.toLockDir, journal.toLeaseId, journal.pid, { recoveryAuthority });
  }

  const failed = results.find((r) => r && r.ok === false);
  return failed ? { ok: false, error: failed.error } : { ok: true, skippedNewerOwner: anySuperseded };
}

function extractVerifiedJournalWorktrees(journal) {
  if (!journal || typeof journal !== "object") {
    return { ok: false, reason: "invalid_journal", worktrees: [] };
  }
  const parseRawDir = (raw) => {
    if (typeof raw !== "string" || !raw.trim()) return "";
    try {
      const obj = JSON.parse(raw);
      return typeof obj?.projectDir === "string" ? obj.projectDir.trim() : "";
    } catch {
      return "";
    }
  };
  const rawDirs = [
    journal.sourceProjectDir,
    journal.targetProjectDir,
    parseRawDir(journal.sourceStateSnap?.raw),
    parseRawDir(journal.targetStateSnap?.raw),
    parseRawDir(journal.sourceDbSnapshot?.stateJson),
    parseRawDir(journal.targetDbSnapshot?.stateJson),
    parseRawDir(journal.priorSessionPointer?.raw),
    parseRawDir(journal.priorFocusBinding?.raw),
    journal.priorInMemory?.state?.projectDir,
    journal.priorInMemory?.activeProjectDir,
  ]
    .map((d) => (typeof d === "string" ? d.trim() : ""))
    .filter(Boolean);

  if (rawDirs.length === 0) {
    return { ok: false, reason: "missing_worktree_identity", worktrees: [] };
  }

  const byKey = new Map();
  for (const dir of rawDirs) {
    const wt = resolveCanonicalWorktreeRoot(dir);
    if (!wt.ok) {
      return { ok: false, reason: wt.error || "invalid_worktree_identity", worktrees: [] };
    }
    if (!byKey.has(wt.canonicalKey)) {
      byKey.set(wt.canonicalKey, wt);
    }
  }
  const sorted = Array.from(byKey.values()).sort((a, b) =>
    a.canonicalKey.localeCompare(b.canonicalKey),
  );
  return { ok: true, worktrees: sorted };
}

/**
 * Rolls back all transition changes (both target and source) idempotently
 * when a transition step fails before `COMMITTED` (R2-4 + R3-4).
 */
export async function rollbackTransitionJournal(
  journal,
  { workflowState = null, stagedLock = null, setActiveProjectDirFn = null, recoveryAuthority = null, hooks = null } = {},
) {
  if (!journal) return false;

  try {
    if (
      workflowState &&
      typeof workflowState.close === "function" &&
      workflowState.stateFile !== journal.sourceStateFile
    ) {
      await workflowState.close();
    }
  } catch {}

  const verifiedWorktrees = extractVerifiedJournalWorktrees(journal);
  if (!verifiedWorktrees.ok || verifiedWorktrees.worktrees.length === 0) {
    // Missing or invalid worktree identity: fail closed and preserve journal evidence on disk.
    return false;
  }

  const acquiredRecoveryCaps = [];
  const recoveryOwnerKey = `recovery:${journal.sessionKey || process.pid}:${randomUUID()}`;
  const assertAllRecoveryCapsLive = (operation) => {
    for (const cap of acquiredRecoveryCaps) {
      assertWorktreeCapabilityMatches({
        capability: cap,
        operation,
        ownerKey: recoveryOwnerKey,
        projectDir: cap.worktreeRoot,
        allowDrainingInFlight: true,
      });
    }
  };
  const runUnderRecoveryCaps = async (fn) => {
    let runner = fn;
    for (let i = acquiredRecoveryCaps.length - 1; i >= 0; i -= 1) {
      const cap = acquiredRecoveryCaps[i];
      const next = runner;
      runner = () => useWorktreeCapability(cap, next, { operation: "rollbackTransitionJournal" });
    }
    return await runner();
  };
  try {
    for (const wt of verifiedWorktrees.worktrees) {
      const m = await acquireWorktreeMutex({
        projectDir: wt.worktreeRoot,
        timeoutMs: 25,
        ownerKey: recoveryOwnerKey,
      });
      if (!m.ok || !m.capability || m.alreadyHeld) {
        // Required worktree mutex could not be exclusively acquired: fail closed and preserve journal.
        return false;
      }
      acquiredRecoveryCaps.push(m.capability);
    }

    return await runUnderRecoveryCaps(async () => {
      if (typeof hooks?.onBeforeRestore === "function") {
        await hooks.onBeforeRestore({ journal, capabilities: acquiredRecoveryCaps });
      }

      assertAllRecoveryCapsLive("rollbackTransitionJournal:restoreDb");
      let targetDbRes = { ok: true };
      if (journal.targetDbSnapshot && journal.targetStateFile !== journal.sourceStateFile) {
        targetDbRes = await restoreDbRowSnapshot(journal.targetDbSnapshot, journal, "target");
      }
      const sourceDbRes = journal.sourceDbSnapshot
        ? await restoreDbRowSnapshot(journal.sourceDbSnapshot, journal, "source")
        : { ok: true };

      if (!targetDbRes.ok || !sourceDbRes.ok) {
        // R3-5: Keep the journal on disk as evidence when the DB restore fails.
        return false;
      }

      const dbSuperseded = Boolean(targetDbRes.skippedNewerOwner || sourceDbRes.skippedNewerOwner);

      assertAllRecoveryCapsLive("rollbackTransitionJournal:rollbackFiles");
      const fileRes = rollbackJournalFilesAndLocksSync(journal, {
        isCrashRecovery: !stagedLock,
        recoveryAuthority,
        skipFocusSync: true,
        supersededByNewerOwner: dbSuperseded,
      });
      if (!fileRes.ok) {
        return false;
      }

      if (!dbSuperseded && !fileRes.skippedNewerOwner && journal.priorFocusBinding && journal.priorFocusBinding.applicable) {
        assertAllRecoveryCapsLive("rollbackTransitionJournal:restoreFocus");
        const focusRes = await restoreFocusBindingSnapshot(journal.priorFocusBinding, journal);
        if (!focusRes || focusRes.ok === false) {
          return false;
        }
      }

      if (workflowState && journal.priorInMemory) {
        workflowState.stateFile = journal.sourceStateFile;
        workflowState.historyFile = journal.sourceHistoryFile;
        workflowState.stateVersion = journal.priorInMemory.stateVersion;
        workflowState.loadedTask = journal.priorInMemory.loadedTask;
        if (journal.priorInMemory.state) {
          workflowState.state = structuredClone(journal.priorInMemory.state);
        }
        if (typeof workflowState.bindLockLease === "function") {
          workflowState.bindLockLease(journal.priorInMemory.boundLease);
        }
      }

      if (typeof setActiveProjectDirFn === "function" && journal.priorInMemory) {
        setActiveProjectDirFn(journal.priorInMemory.activeProjectDir || "");
      }

      if (typeof hooks?.onBeforeCompleteJournal === "function") {
        await hooks.onBeforeCompleteJournal({ journal, capabilities: acquiredRecoveryCaps });
      }

      assertAllRecoveryCapsLive("rollbackTransitionJournal:completeJournal");
      completeTransitionJournal(journal);
      return true;
    });
  } finally {
    for (const cap of acquiredRecoveryCaps) {
      try {
        await releaseWorktreeMutex(cap);
      } catch {}
    }
  }
}

function isJournalOwnerConfirmedDead(journal, { isAlive = currentIsAlive(), isHolderProcess = currentIsHolderProcess() } = {}) {
  const jPid = Number(journal?.pid);
  if (!Number.isFinite(jPid) || jPid <= 0) return true;
  if (jPid === process.pid) {
    return Boolean(journal.incarnationId && journal.incarnationId !== PROCESS_INCARNATION_ID);
  }
  if (!isAlive(jPid)) return true;
  const shouldConsultHolder =
    isHolderProcess !== defaultIsHolderProcess ||
    isAlive === currentIsAlive();
  if (shouldConsultHolder && isHolderProcess(jPid, journal) === false) {
    return true;
  }
  return false;
}

/**
 * Synchronous reconciliation of transition journals abandoned by a dead process.
 * Called by `resolveStateFile` so the session pointer and the JSON file are restored
 * immediately before the caller chooses a session state file.
 */
export function reconcilePendingTransitionJournalsSync({
  baseDir = null,
  stateFile = null,
  isAlive = currentIsAlive(),
  isHolderProcess = currentIsHolderProcess(),
  recoveryAuthority = null,
} = {}) {
  const resolvedBase = baseDir
    ? path.resolve(baseDir)
    : stateFile
      ? resolveBaseDirFromState(stateFile)
      : null;
  if (!resolvedBase) return [];

  const sessionsDir = path.join(resolvedBase, SESSIONS_DIR);
  if (!existsSync(sessionsDir)) return [];

  const reconciled = [];
  let entries = [];
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("transition-") || !entry.name.endsWith(".journal.json")) {
      continue;
    }
    const journalFile = path.join(sessionsDir, entry.name);
    let journal;
    try {
      journal = JSON.parse(readFileSync(journalFile, "utf8"));
    } catch {
      continue;
    }
    if (!journal || !isJournalOwnerConfirmedDead(journal, { isAlive, isHolderProcess })) {
      continue;
    }

    const recLock = acquireJournalRecoveryLock(journalFile, journal.journalId, { isAlive, isHolderProcess });
    if (!recLock.ok) {
      reconciled.push({
        journalId: journal.journalId,
        sessionKey: journal.sessionKey,
        action: recLock.reason || "recovery_skipped",
      });
      continue;
    }

    try {
      if (!existsSync(journalFile)) continue;
      // Under Option B, synchronous journal recovery cannot acquire async OS worktree
      // mutexes and therefore MUST NOT mutate files, pointers, focus bindings, or delete
      // journal evidence. Preserve the journal for async mutex-fenced recovery.
      reconciled.push({
        journalId: journal.journalId,
        sessionKey: journal.sessionKey,
        action: "sync_recovery_unsupported_requires_async_worktree_mutex",
      });
    } finally {
      releaseJournalRecoveryLock(recLock);
    }
  }

  return reconciled;
}

/**
 * Full reconciliation (including the SQLite rows in the target & source databases) of
 * transition journals abandoned by a process that died abruptly (R2-4 + R3-4).
 */
export async function reconcilePendingTransitionJournals({
  baseDir = null,
  stateFile = null,
  isAlive = currentIsAlive(),
  isHolderProcess = currentIsHolderProcess(),
  recoveryAuthority = null,
  hooks = null,
} = {}) {
  const resolvedBase = baseDir
    ? path.resolve(baseDir)
    : stateFile
      ? resolveBaseDirFromState(stateFile)
      : null;
  if (!resolvedBase) return [];

  const sessionsDir = path.join(resolvedBase, SESSIONS_DIR);
  if (!existsSync(sessionsDir)) return [];

  const reconciled = [];
  let entries = [];
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("transition-") || !entry.name.endsWith(".journal.json")) {
      continue;
    }
    const journalFile = path.join(sessionsDir, entry.name);
    let journal;
    try {
      journal = JSON.parse(readFileSync(journalFile, "utf8"));
    } catch {
      continue;
    }
    if (!journal || !isJournalOwnerConfirmedDead(journal, { isAlive, isHolderProcess })) {
      continue;
    }

    const recLock = acquireJournalRecoveryLock(journalFile, journal.journalId, { isAlive, isHolderProcess });
    if (!recLock.ok) {
      reconciled.push({
        journalId: journal.journalId,
        sessionKey: journal.sessionKey,
        action: recLock.reason || "recovery_skipped",
      });
      continue;
    }

    try {
      if (typeof hooks?.onRecoveryLockAcquired === "function") {
        await hooks.onRecoveryLockAcquired({ journal, recoverLockFile: recLock.recoverLockFile });
      }
      if (!existsSync(journalFile)) continue;
      // Re-read journal under exclusive recovery lock before taking action.
      journal = JSON.parse(readFileSync(journalFile, "utf8"));
      journal.journalFile = journalFile;
      if (journal.phase === "COMMITTED") {
        const verifiedWorktrees = extractVerifiedJournalWorktrees(journal);
        if (!verifiedWorktrees.ok || verifiedWorktrees.worktrees.length === 0) {
          reconciled.push({
            journalId: journal.journalId,
            sessionKey: journal.sessionKey,
            action: "committed_cleanup_failed_invalid_worktree",
          });
          continue;
        }
        const acquiredCaps = [];
        const recoveryOwnerKey = `recovery:${journal.sessionKey || process.pid}:${randomUUID()}`;
        let allAcquired = true;
        try {
          for (const wt of verifiedWorktrees.worktrees) {
            const m = await acquireWorktreeMutex({
              projectDir: wt.worktreeRoot,
              timeoutMs: 25,
              ownerKey: recoveryOwnerKey,
            });
            if (!m.ok || !m.capability || m.alreadyHeld) {
              allAcquired = false;
              break;
            }
            acquiredCaps.push(m.capability);
          }
          if (!allAcquired) {
            reconciled.push({
              journalId: journal.journalId,
              sessionKey: journal.sessionKey,
              action: "committed_cleanup_worktree_mutex_busy",
            });
            continue;
          }
          let runCleanup = async () => {
            for (const cap of acquiredCaps) {
              assertWorktreeCapabilityMatches({
                capability: cap,
                operation: "reconcilePendingTransitionJournals:committedCleanup",
                ownerKey: recoveryOwnerKey,
                projectDir: cap.worktreeRoot,
                allowDrainingInFlight: true,
              });
            }
            if (journal.relocatedLock && journal.fromLockDir && journal.fromLockDir !== journal.toLockDir) {
              releaseOrphanedLockFromJournal(journal.fromLockDir, journal.fromLeaseId, journal.pid, { recoveryAuthority });
            }
            completeTransitionJournal(journal);
          };
          for (let i = acquiredCaps.length - 1; i >= 0; i -= 1) {
            const cap = acquiredCaps[i];
            const next = runCleanup;
            runCleanup = () => useWorktreeCapability(cap, next, { operation: "reconcilePendingTransitionJournals:committedCleanup" });
          }
          try {
            await runCleanup();
            reconciled.push({
              journalId: journal.journalId,
              sessionKey: journal.sessionKey,
              action: "committed_cleanup",
              sourceStateFile: journal.sourceStateFile,
              targetStateFile: journal.targetStateFile,
            });
          } catch (err) {
            reconciled.push({
              journalId: journal.journalId,
              sessionKey: journal.sessionKey,
              action: "committed_cleanup_failed",
              error: err?.code || err?.message || "CLEANUP_FAILED",
            });
          }
        } finally {
          for (const cap of acquiredCaps) {
            try {
              await releaseWorktreeMutex(cap);
            } catch {}
          }
        }
      } else {
        const rolledBack = await rollbackTransitionJournal(journal, { recoveryAuthority, hooks });
        reconciled.push({
          journalId: journal.journalId,
          sessionKey: journal.sessionKey,
          action: rolledBack ? "rolled_back" : "rollback_failed_evidence_preserved",
          sourceStateFile: journal.sourceStateFile,
          targetStateFile: journal.targetStateFile,
        });
      }
    } finally {
      releaseJournalRecoveryLock(recLock);
    }
  }

  return reconciled;
}

/**
 * Read one focus binding file and report WHY it produced no record.
 *
 * A binding that cannot be read is not the same as a binding that does not
 * exist. Treating them alike is silent ownership loss: a truncated or
 * permission-denied record would read as "unbound", and the next claim would
 * overwrite it with another project's claim, destroying the only evidence of
 * who owned the focus.
 *
 * The three outcomes are therefore distinct:
 *   - `absent`     - ENOENT, the focus genuinely has no binding here;
 *   - `ok`         - the file parsed; `record` is the binding, or null when the
 *                    file is a session pointer or not a binding at all;
 *   - `unreadable` - the file exists but cannot be trusted (malformed JSON,
 *                    EACCES, EISDIR, ...). Callers must fail closed.
 *
 * @returns {{status: "absent"|"ok"|"unreadable", record: object|null, error: string|null}}
 */
function readFocusBindingRecordDetailed(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { status: "absent", record: null, error: null };
    }
    return {
      status: "unreadable",
      record: null,
      error: error?.code || "FOCUS_BINDING_UNREADABLE",
    };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { status: "unreadable", record: null, error: "FOCUS_BINDING_MALFORMED" };
  }

  // A session pointer is a different record type that can share the legacy
  // `focus-<id>.json` name. Accepting it as a focus binding would let a
  // session key masquerade as a focus claim.
  if (data && typeof data === "object" && typeof data.ownerKey === "string" && data.ownerKey.trim()) {
    return { status: "ok", record: null, error: null };
  }
  // Anything that is not an object cannot be a binding. A parseable but
  // structurally invalid payload is damage, not absence: treating it as
  // "unbound" would let a claim overwrite the only record of who owned it.
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { status: "unreadable", record: null, error: "FOCUS_BINDING_INVALID" };
  }
  const boundRepoKey = typeof data?.repoKey === "string" ? data.repoKey.trim() : "";
  const boundProjectDir = typeof data?.projectDir === "string" ? data.projectDir.trim() : "";
  if (!boundRepoKey && !boundProjectDir) {
    return { status: "unreadable", record: null, error: "FOCUS_BINDING_INVALID" };
  }
  return {
    status: "ok",
    record: {
      focusId: Number(data?.focusId) || null,
      repoKey: boundRepoKey,
      projectDir: boundProjectDir,
      boundAt: typeof data?.boundAt === "string" ? data.boundAt : "",
    },
    error: null,
  };
}

/**
 * Backward-compatible reader: the binding record, or null.
 *
 * Callers that must distinguish "absent" from "unreadable" use
 * `readFocusBindingRecordDetailed` instead. This wrapper is for paths where a
 * null simply means "nothing to act on" and a damaged file is handled by the
 * claim/retire gate that reads the detailed form.
 */
function readFocusBindingRecord(file) {
  return readFocusBindingRecordDetailed(file).record;
}

/**
 * Read both binding locations for one focus and detect a disagreement.
 *
 * The nested record is the current layout; the flat record is the pre-upgrade
 * layout. Two records for one focus that name different projects is a conflict:
 * acting on either one would let one project delete or block the other's claim.
 *
 * `unreadable` is true when either location exists but could not be parsed or
 * read. That is not the same as unbound, and every mutating caller must refuse
 * rather than treat the damaged record as absent.
 *
 * @returns {{
 *   record: object|null,
 *   nested: object|null,
 *   legacy: object|null,
 *   conflict: boolean,
 *   unreadable: boolean,
 *   unreadableReason: string|null,
 *   unreadablePaths: string[]
 * }}
 */
function readFocusBindingState(baseDir, focusId) {
  const nestedPath = focusBindingPath(baseDir, focusId);
  const legacyPath = legacyFocusBindingPath(baseDir, focusId);
  const nestedRead = readFocusBindingRecordDetailed(nestedPath);
  const legacyRead = readFocusBindingRecordDetailed(legacyPath);
  const nested = nestedRead.record;
  const legacy = legacyRead.record;

  const unreadablePaths = [];
  let unreadableReason = null;
  if (nestedRead.status === "unreadable") {
    unreadablePaths.push(nestedPath);
    unreadableReason = nestedRead.error;
  }
  if (legacyRead.status === "unreadable") {
    unreadablePaths.push(legacyPath);
    unreadableReason = unreadableReason || legacyRead.error;
  }

  let conflict = false;
  if (nested && legacy) {
    // The same acceptance rule the claim path and the pointer migration use:
    // the same repository key OR the same project directory is the same claim.
    // Keying only on the remote would report a conflict for one checkout whose
    // remote identity changed across versions.
    const nestedKey = nested.repoKey || "";
    const legacyKey = legacy.repoKey || "";
    const sameKey = Boolean(nestedKey) && Boolean(legacyKey) && nestedKey === legacyKey;
    const sameDir =
      Boolean(nested.projectDir) &&
      Boolean(legacy.projectDir) &&
      normalizeRepoPathForBinding(nested.projectDir) === normalizeRepoPathForBinding(legacy.projectDir);
    conflict = !sameKey && !sameDir;
  }

  return {
    record: nested || legacy,
    nested,
    legacy,
    conflict,
    unreadable: unreadablePaths.length > 0,
    unreadableReason,
    unreadablePaths,
  };
}

function normalizeRepoPathForBinding(value) {
  const resolved = path.resolve(String(value || "")).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Salin satu berkas state lama ke berkas sesi, sekali.
 *
 * Dipakai dua sumber:
 *   1. berkas pin bersama (`.state/workflow-state.json`, era pra-1.16.0)
 *   2. `<proyek>/workflow-state.json` (era 1.16.0, satu berkas per proyek)
 *
 * ATURAN
 * ------
 * - Berkas lama tidak pernah dihapus. Ia menyimpan riwayat era sebelumnya, dan
 *   menghapusnya adalah tindakan yang tidak bisa dibatalkan.
 * - Hanya disalin bila `projectDir` di dalamnya memang proyek ini. State milik
 *   proyek lain tidak boleh dipindahkan - memindahkannya justru mengulang
 *   kesalahan yang sedang diperbaiki.
 * - State yang PUNYA TASK AKTIF tidak disalin. Menyalinnya membuat sesi baru
 *   mewarisi fase dan DoD task yang sedang dikerjakan sesi lain - persis
 *   kehilangan yang sedang diperbaiki, hanya dengan arah berlawanan. Task itu
 *   tetap terlihat di berkas lamanya dan di history.
 * - Ditulis dengan flag `wx`: dua sesi bisa memanggil ini serempak untuk proyek
 *   yang sama, dan yang kedua tidak boleh menimpa state yang sudah mulai diisi
 *   yang pertama.
 *
 * Best-effort: kegagalan migrasi tidak boleh menghalangi server hidup.
 */
function migrateStateToSession({ sourcePath, targetPath, projectRoot, projectDir }) {
  try {
    if (!existsSync(sourcePath) || existsSync(targetPath)) {
      return;
    }

    const data = parseStateJson(readFileSync(sourcePath, "utf8"));

    const pemilik = typeof data?.projectDir === "string" ? data.projectDir.trim() : "";
    // Berkas tanpa `projectDir` tidak boleh disalin: ia tidak bisa dibuktikan
    // milik proyek ini, dan menyalinnya memindahkan task antar proyek - persis
    // kesalahan yang sedang diperbaiki.
    if (!pemilik) {
      return;
    }
    if (projectRoot) {
      const sama = canonicalPath(pemilik).toLowerCase() === canonicalPath(projectRoot).toLowerCase();
      if (!sama) {
        return;
      }
    }

    const phase = typeof data?.currentPhase === "string" ? data.currentPhase : "idle";
    const description = typeof data?.taskDescription === "string" ? data.taskDescription.trim() : "";
    if (phase !== "idle" || description !== "") {
      // Task yang sedang berjalan TIDAK disalin, tetapi juga tidak boleh
      // menghilang tanpa jejak: sesi baru akan melihat "Phase: idle" dan mengira
      // tidak ada apa-apa, lalu DoD lama hilang dari semua permukaan workflow.
      // Jejaknya ditulis sekali (flag `wx`) supaya `get_workflow_status` bisa
      // melaporkannya.
      if (projectDir && description !== "") {
        try {
          mkdirSync(projectDir, { recursive: true });
          writeFileSync(
            path.join(projectDir, STRANDED_TASK_FILENAME),
            JSON.stringify(
              { taskDescription: description, phase, sourcePath, detectedAt: new Date().toISOString() },
              null,
              2,
            ),
            { encoding: "utf8", flag: "wx" },
          );
        } catch {
          // Sudah tercatat oleh panggilan sebelumnya.
        }
      }
      return;
    }

    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx" });
  } catch {
    // Berkas sudah ada (sesi lain menang lebih dulu) atau tidak bisa ditulis:
    // keduanya bukan alasan menggagalkan start server.
  }
}

/**
 * Pindahkan sekali state lama (satu berkas bersama) ke berkas proyeknya.
 *
 * Dipertahankan untuk tata letak pra-1.16.0 (`.state/workflow-state.json`).
 *
 * Hanya dipindahkan bila `projectDir` di dalamnya memang proyek ini; state
 * milik proyek lain dibiarkan, karena memindahkannya justru mengulang
 * kesalahan yang sedang diperbaiki. Berkas lama tidak dihapus - ia juga
 * menyimpan riwayat era sebelumnya.
 *
 * Best-effort: kegagalan migrasi tidak boleh menghalangi server hidup.
 */
function migrateLegacyProjectState(legacyPath, targetPath, projectRoot) {
  migrateStateToSession({ sourcePath: legacyPath, targetPath, projectRoot });
}

/**
 * Kirim ringkasan sesi ke dashboard. Tidak pernah melempar.
 *
 * Dipanggil setelah state benar-benar tersimpan - kalau dilaporkan lebih
 * dulu, dashboard bisa menampilkan fase yang tidak pernah terjadi.
 */
/**
 * Kirim ringkasan sesi ke dashboard. Tidak pernah melempar.
 *
 * MENGAPA IMPOR DIPISAH
 * ---------------------
 * `workflow-state.js` disalin sendirian oleh beberapa tes ke direktori
 * sementara, sehingga impor relatif apa pun di berkas ini akan mematahkan
 * seluruh modul hanya karena fitur pinggiran ini. Monitor ditemukan lewat
 * `PACKAGE_ROOT` (lihat exec.js) atau direktori berkas ini sendiri, dan bila
 * tidak ditemukan laporan cukup dilewati.
 */
export async function reportToMonitorSafe({ state, stateFile, createdAt }) {
  try {
    // In-flight guard: `startup-resilience.test.js` menuntut MCP hidup di bawah
    // 2 detik. Laporan yang ditunggu menambah latensi jaringan ke jalur boot.
    // Satu laporan yang sudah berjalan cukup; yang berikutnya dilewati.
    if (monitorInFlight) {
      return false;
    }
    const base = path.basename(String(stateFile || ""));
    const match = /^workflow-state\.(.+)\.json$/.exec(base);
    const monitorPath = path.join(__dirname, "monitor.js");
    if (!existsSync(monitorPath)) {
      return false;
    }
    const mod = await import(pathToFileURL(monitorPath).href);
    // Identitas task diambil dari state bila masih ada (laporan rutin), atau
    // dari nilai terakhir yang kita laporkan (laporan penutupan sesudah reset).
    // Tanpa ini, penutupan menulis baris baru dan kartu lamanya tertinggal.
    const liveTaskId = String((state && state.workflowTaskId) || "");
    if (liveTaskId) lastReportedTaskId = liveTaskId;
    const reportedState =
      liveTaskId || !lastReportedTaskId
        ? state
        : { ...(state || {}), workflowTaskId: lastReportedTaskId };
    const snapshot = mod.buildSnapshot({
      state: reportedState,
      sessionKey: match ? match[1] : "",
      projectPath: (state && state.projectDir) || "",
      // Waktu mulai TASK diambil dari state (`taskStartedAt`), yang bertahan
      // melewati restart proses. Cadangan: waktu mulai sesi proses.
      sessionStartedAt: (state && state.taskStartedAt) || createdAt || "",
    });

    // Penutupan task HARUS tetap terkirim walau sesi ini sudah lama idle.
    //
    // MASALAH NYATA (1 November 2026): sesi berhenti melapor setelah 74 menit
    // padahal prosesnya masih hidup. Penyebabnya bukan kerusakan - implementasi
    // ini memang hanya melapor saat `save()` dipanggil, jadi sesi yang
    // menganggur tidak mengirim apa pun dan dashboard memakainya sebagai
    // penanda umur. Akibatnya task yang SUDAH selesai tetap tampak "mungkin
    // macet" sampai jendela 2 jam habis.
    //
    // Snapshot yang fase-nya `idle` adalah bukti penutupan; itu selalu dikirim
    // dan selalu ditunggu, karena inilah satu-satunya kabar yang membuat kartu
    // di tablet hilang. Laporan rutin tetap mengikuti aturan boot di bawah.
    const isClosure = String((state && state.currentPhase) || "") === "idle";
    if (isClosure) {
      monitorInFlight = true;
      try {
        return await mod.reportSnapshot({ snapshot });
      } finally {
        monitorInFlight = false;
      }
    }

    // Selama proses baru boot, laporan TIDAK ditunggu. Server MCP harus siap
    // di bawah 2 detik, dan satu permintaan jaringan di jalur boot sudah cukup
    // untuk melewatinya (terukur 2109ms). Sesudah jendela ini, laporan ditunggu
    // supaya proses CLI yang keluar cepat tidak membunuhnya.
    const booting = Date.now() - processStartTime < BOOT_QUIET_MS;
    if (booting) {
      void mod.reportSnapshot({ snapshot }).catch(() => false);
      return false;
    }

    monitorInFlight = true;
    try {
      return await mod.reportSnapshot({ snapshot });
    } finally {
      monitorInFlight = false;
    }
  } catch {
    return false;
  }
}

export class WorkflowState {
  constructor(stateFilePath = undefined, options = {}) {
    this._hasExplicitStateFile = Boolean(stateFilePath);
    const resolvedInitialStateFile = stateFilePath || resolveStateFile({ skipMigrationWrites: true });
    this.stateFile = resolvedInitialStateFile;
    // Dipakai tes untuk menyuntikkan kegagalan baca yang nyata (EBUSY/EACCES)
    // tanpa harus benar-benar mengunci berkas di sistem operasi.
    this.fs = options.fs || fs;
    // History milik proyek, state milik sesi. Dalam tata letak nyata keduanya
    // berkas berbeda; untuk path eksplisit keduanya menunjuk berkas yang sama.
    this.historyFile = resolveHistoryFile(resolvedInitialStateFile);
    // Task yang terakhir kita baca dari / tulis ke disk. Dipakai untuk
    // membedakan "task ini milik kita" dari "task ini ditulis proses lain
    // sesudah kita memuat" - tanpa ini penulis basi menang tanpa perlawanan.
    this.loadedTask = "";
    // Kapan sesi ini mulai melapor. Dipakai dashboard untuk menghitung sudah
    // berapa lama task berjalan.
    //
    // MASALAH NYATA (2 November 2026): properti ini dibaca di dua tempat tetapi
    // TIDAK PERNAH diisi, sehingga `started_at` di dashboard selalu kosong dan
    // durasi task tidak mungkin dihitung. Pemilik memintanya secara eksplisit:
    // "setiap task mesti ada counter timenya".
    this.sessionStartedAt = new Date().toISOString();
    // Penomoran export dalam proses ini; lihat _exportJson().
    this._exportSeq = 0;
    // Konflik penyimpanan terakhir, dibaca oleh lapisan tool untuk memberi tahu
    // pengguna. Null berarti penyimpanan terakhir aman.
    this.lastConflict = null;

    // Penyimpanan state sekarang SQLite, bukan berkas JSON.
    //
    // `options.db` bisa diinjeksi supaya tes memakai database sementara tanpa
    // menyentuh yang asli. `options.replica` adalah tujuan salinan best-effort
    // (Postgres untuk dashboard); bila kosong, antrean replika tidak dipakai.
    this.dbAdapter = options.db || null;
    this.replica = options.replica || null;

    // Identitas sesi untuk kunci baris. Diisi dispatcher lewat `useSession`, atau
    // lewat `options.sessionId` pada pemanggil seperti tes dan CLI.
    const inferredSessionMatch = resolvedInitialStateFile
      ? /^workflow-state\.(.+)\.json$/.exec(path.basename(String(resolvedInitialStateFile)))
      : null;
    const inferredSessionKey =
      inferredSessionMatch &&
      !inferredSessionMatch[1].startsWith("user-") &&
      !inferredSessionMatch[1].startsWith("proc-")
        ? inferredSessionMatch[1]
        : null;
    const explicitCanonicalKey =
      typeof options.canonicalSessionKey === "string" && options.canonicalSessionKey.trim() !== ""
        ? options.canonicalSessionKey.trim()
        : null;
    this.sessionId = options.sessionId || explicitCanonicalKey || inferredSessionKey;
    this._canonicalSessionKey =
      explicitCanonicalKey || (!options.sessionId && inferredSessionKey ? inferredSessionKey : null);

    // Versi baris yang kita pegang. `null` berarti "belum pernah menyimpan".
    this.stateVersion = null;

    // Berapa entri riwayat yang SUDAH ada di tabel. Dipakai supaya penyimpanan
    // hanya mengirim entri baru, bukan meng-upsert seluruh riwayat setiap kali.
    this._syncedHistoryCount = 0;

    // Project ownership lease bound to this WorkflowState instance (F5).
    this.boundLockLease = options.boundLockLease || null;
    // Live OS-owned kernel mutex capability (Option B).
    this.boundKernelCapability = options.boundKernelCapability || null;
    this.requireKernelMutex = Boolean(options.requireKernelMutex || this.boundKernelCapability);
    // In-process serialization queue so concurrent async calls do not
    // scramble `this.state` / `this.stateFile` / `this.stateVersion`.
    this._opQueue = Promise.resolve();
    this._inSerializedOp = 0;
    this.state = {
      currentPhase: "idle",
      classification: "INTERNAL",
      taskDescription: "",
      bugFixed: false,
      testsCreated: false,
      testsPassed: false,
      testsSkipped: false,
      testsSkippedReason: "",
      documentationCreated: false,
      // Bukti berkas untuk gerbang dokumentasi. `documentationCreated` hanya
      // berarti "agen mengaku sudah"; daftar ini berisi path yang benar-benar
      // berubah di working tree, atau waiver dengan alasan tertulis.
      documentationFiles: [],
      documentationWaived: false,
      documentationWaiverReason: "",
      readyToCommit: false,
      readyCheckCompleted: false,
      released: false,
      releaseSkipped: false,
      releaseSkippedReason: "",
      releaseCommand: "",
      releaseNotes: "",
      // Rekaman rilis yang benar-benar sampai ke produksi lewat CI/CD.
      // `released` hanya berarti "perintah rilis dijalankan"; ini menyimpan tag,
      // pipeline, dan site yang sudah menerimanya. Tanpa ini, upload langsung ke
      // server tidak meninggalkan jejak apa pun di MCP.
      deployment: null,
      commitAndPushCompleted: false,
      lastCommitMessage: "",
      lastPushBranch: "",
      // SHA yang benar-benar ter-push. Dipakai rekomendasi tindak lanjut untuk
      // membaca diff commit ini (TODO baru, jumlah berkas) tanpa menebak HEAD.
      lastCommitSha: "",
      // Mesin pemilik task ini. Dipakai checkpoint supaya mesin lain tahu siapa
      // yang memegang state hidup, dan supaya handoff bisa menyebut asal/tujuan.
      machine: "",
      // Rekaman checkpoint. `baseSha` diambil saat start_task sehingga daftar
      // commit milik sesi ini bisa dihitung tanpa menebak, dan `handover` dicatat
      // bila task diserahkan ke mesin lain.
      checkpoint: { checkpointedAt: null, summary: "", baseSha: null, commits: [], handover: null },
      // Repo proyek untuk sesi ini. Ditentukan saat start_task, dipakai semua
      // operasi git berikutnya. Kosong berarti ikuti urutan resolusi di exec.js.
      projectDir: "",
      featureFlowCreated: false,
      featureFlowDescription: "",
      // Definition of Done milik task ini. Aturan dan bentuk itemnya ada di
      // tools/handler-modules/dod.js; di sini hanya disimpan.
      definitionOfDone: [],
      dodSource: "",
      dodFactoryTaskId: "",
      // Naik setiap ada perubahan kerja baru setelah commit tercatat, sehingga
      // bukti item `done` yang lama otomatis tidak lagi berlaku.
      dodRevision: 0,
      // README-first preflight evidence: bounded discovery of README, AGENTS.md
      // and documented CLI entrypoints, recorded at start_task and revalidated
      // at resume_session. Null means the task predates the preflight.
      preflight: null,
      // Urutan kerja yang sedang dijalankan. Terpisah dari `definitionOfDone`:
      // DoD adalah syarat selesai, ini adalah rencana langkahnya. Rencana tidak
      // menjadi gerbang - ia hanya membuat progres bisa dibaca.
      plan: [],
      history: [],
      taskType: "",
      workflowTaskId: "",
      zettly: null,
      zettlyOutbox: [],
      taskOrigin: null,
      zettlyContext: null,
      focus: null,
      activeBuild: null,
      buildHistory: [],
    };
  }

  /**
   * Bind an active process lock lease to this WorkflowState instance so all
   * subsequent persistence mutations verify exclusive ownership under the
   * cross-process gate (F5).
   */
  bindLockLease(lease) {
    if (!lease || !lease.leaseId) {
      this.boundLockLease = null;
      return null;
    }
    this.boundLockLease = {
      dir: lease.dir ? path.resolve(String(lease.dir)) : projectLockDir(this.stateFile),
      leaseId: String(lease.leaseId),
    };
    return this.boundLockLease;
  }

  /**
   * Serialize in-process async mutations against this WorkflowState instance
   * (F5 / R2-3). Re-entrancy is scoped strictly to the current AsyncLocalStorage
   * execution context (`serializedExecutionStorage`) so independent concurrent
   * async requests in the same process never bypass the queue.
   */
  async runSerialized(fn) {
    const activeMap = serializedExecutionStorage.getStore();
    const existingCap = activeMap instanceof Map ? activeMap.get(this) : null;
    if (
      existingCap &&
      existingCap.active === true &&
      existingCap.epoch === this._activeSerializationEpoch
    ) {
      return await fn();
    }
    const previous = this._opQueue;
    let releaseQueue;
    this._opQueue = new Promise((resolve) => {
      releaseQueue = resolve;
    });
    await previous.catch(() => {});
    this._serializationEpoch = (this._serializationEpoch || 0) + 1;
    const epoch = this._serializationEpoch;
    this._activeSerializationEpoch = epoch;
    const capability = { active: true, epoch };
    const nextMap = new Map(activeMap instanceof Map ? activeMap : []);
    nextMap.set(this, capability);
    this._inSerializedOp += 1;
    try {
      return await serializedExecutionStorage.run(nextMap, fn);
    } finally {
      capability.active = false;
      if (this._activeSerializationEpoch === epoch) {
        this._activeSerializationEpoch = 0;
      }
      nextMap.delete(this);
      this._inSerializedOp -= 1;
      releaseQueue();
    }
  }

  _resolveFencingContext() {
    const dir = projectLockDir(this.stateFile);
    const heldForDir = getHeldLeaseForDir(dir);
    if (heldForDir && heldForDir.leaseId) {
      if (
        !this.boundLockLease ||
        path.resolve(String(this.boundLockLease.dir || "")) === path.resolve(dir)
      ) {
        this.boundLockLease = { dir: path.resolve(dir), leaseId: heldForDir.leaseId };
      }
    }
    const boundMatchesDir =
      this.boundLockLease &&
      this.boundLockLease.leaseId &&
      (!this.boundLockLease.dir ||
        path.resolve(String(this.boundLockLease.dir)) === path.resolve(dir));
    return {
      dir,
      expectedLeaseId: boundMatchesDir
        ? this.boundLockLease.leaseId
        : heldForDir?.leaseId || null,
      requireLease: Boolean(boundMatchesDir || heldForDir?.leaseId),
    };
  }

  bindKernelCapability(capability) {
    this.boundKernelCapability = capability || null;
    if (capability) {
      this.requireKernelMutex = true;
    }
    return this.boundKernelCapability;
  }

  _capabilityMatchesSession(cap) {
    if (!cap || typeof cap !== "object") return false;
    if (typeof cap.ownerKey !== "string" || cap.ownerKey.trim() === "") return false;
    const explicitSessionKey =
      (typeof this._sessionKey === "function" ? this._sessionKey()?.key : "") ||
      this.sessionId ||
      "";
    const stateFileKey = this.stateFile ? path.resolve(String(this.stateFile)) : "";
    if (explicitSessionKey && cap.ownerKey === explicitSessionKey) return true;
    if (stateFileKey && cap.ownerKey === stateFileKey) return true;
    if (!explicitSessionKey && !stateFileKey && cap.ownerKey === String(process.pid)) return true;
    return false;
  }

  _resolveKernelCapability() {
    if (this.boundKernelCapability) {
      return this._capabilityMatchesSession(this.boundKernelCapability)
        ? this.boundKernelCapability
        : null;
    }
    if (this.state?.projectDir) {
      const cap = getHeldWorktreeCapability(this.state.projectDir);
      return this._capabilityMatchesSession(cap) ? cap : null;
    }
    return null;
  }

  _assertKernelOwnership(operation, { allowDrainingInFlight = false } = {}) {
    if (!this.requireKernelMutex && !this.boundKernelCapability) {
      return null;
    }
    const cap = this._resolveKernelCapability();
    assertWorktreeCapabilityLive(cap, { operation, allowDrainingInFlight });
    if (!this._capabilityMatchesSession(cap)) {
      const explicitSessionKey =
        (typeof this._sessionKey === "function" ? this._sessionKey()?.key : "") ||
        this.sessionId ||
        "";
      throw new ProjectOwnershipLostError(
        `Worktree capability session mismatch before ${operation}: capability belongs to "${cap.ownerKey}", not session "${explicitSessionKey || this.stateFile || process.pid}".`,
        {
          operation,
          capabilityOwnerKey: cap.ownerKey,
          sessionKey: explicitSessionKey || this.stateFile || String(process.pid),
        },
      );
    }
    if (this.state?.projectDir) {
      const wt = resolveCanonicalWorktreeRoot(this.state.projectDir);
      if (!wt.ok || wt.canonicalKey !== cap.canonicalKey) {
        throw new ProjectOwnershipLostError(
          `Project ownership mismatch before ${operation}: capability is for "${cap.worktreeRoot}", not "${wt.ok ? wt.worktreeRoot : this.state.projectDir}".`,
          {
            operation,
            capabilityWorktree: cap.worktreeRoot,
            targetWorktree: wt.ok ? wt.worktreeRoot : this.state.projectDir,
            reason: wt.ok ? "capability_worktree_mismatch" : "invalid_target_worktree",
          },
        );
      }
    }
    return cap;
  }

  async _withOwnershipFence(operation, fn) {
    const cap = this._assertKernelOwnership(operation, { allowDrainingInFlight: false });
    if (cap) {
      return await useWorktreeCapability(cap, fn, { operation });
    }
    return await fn();
  }

  /**
   * Berpindah ke state milik sesi tertentu.
   *
   * Satu proses MCP bisa melayani beberapa sesi bergantian, jadi state harus
   * ditentukan per panggilan - bukan sekali saat proses start. Mengembalikan
   * true bila berkas benar-benar berpindah.
   */
  async useSession(sessionId) {
    return await this.runSerialized(async () => {
      // Identitas sesi HARUS disimpan: kunci baris SQLite memakainya. Sebelumnya
      // `sessionId` hanya dipakai untuk memilih nama berkas, sehingga kunci state
      // jatuh ke environment - dan satu variabel environment membuat semua sesi
      // di proses ini berbagi satu baris.
      const explicit = typeof sessionId === "string" ? sessionId.trim() : "";
      const target = resolveStateFile({
        sessionId,
        skipMigrationWrites: Boolean(this.requireKernelMutex || this.boundKernelCapability),
      });
      if (target === this.stateFile && explicit === this.sessionId) return false;

      const prevCap = this.boundKernelCapability;
      this.sessionId = explicit || null;
      this._canonicalSessionKey = null;
      this.stateFile = target;
      this.historyFile = resolveHistoryFile(target);
      this.stateVersion = null;
      this.boundKernelCapability = null;
      if (prevCap && prevCap._isStartupPlaceholder === true && this.state.currentPhase === "idle") {
        try {
          await releaseWorktreeMutex(prevCap);
        } catch {
          // Best-effort release of unused startup placeholder capability
        }
      }
      // Mulai dari state bersih, lalu muat milik sesi itu. Menyalin state sesi
      // sebelumnya akan membuat sesi baru mewarisi gerbang kualitas sesi lain.
      this.state = {
        currentPhase: "idle",
        taskDescription: "",
        bugFixed: false,
        testsCreated: false,
        testsPassed: false,
        testsSkipped: false,
        testsSkippedReason: "",
        documentationCreated: false,
        // Bukti berkas untuk gerbang dokumentasi. `documentationCreated` hanya
        // berarti "agen mengaku sudah"; daftar ini berisi path yang benar-benar
        // berubah di working tree, atau waiver dengan alasan tertulis.
        documentationFiles: [],
        documentationWaived: false,
        documentationWaiverReason: "",
        readyToCommit: false,
        readyCheckCompleted: false,
        released: false,
        releaseSkipped: false,
        releaseSkippedReason: "",
        releaseCommand: "",
        releaseNotes: "",
        // Rekaman rilis yang benar-benar sampai ke produksi lewat CI/CD.
        // `released` hanya berarti "perintah rilis dijalankan"; ini menyimpan tag,
        // pipeline, dan site yang sudah menerimanya. Tanpa ini, upload langsung ke
        // server tidak meninggalkan jejak apa pun di MCP.
        deployment: null,
        commitAndPushCompleted: false,
        lastCommitMessage: "",
        lastPushBranch: "",
        // SHA yang benar-benar ter-push. Dipakai rekomendasi tindak lanjut untuk
        // membaca diff commit ini (TODO baru, jumlah berkas) tanpa menebak HEAD.
        lastCommitSha: "",
        // Mesin pemilik task ini. Dipakai checkpoint supaya mesin lain tahu siapa
        // yang memegang state hidup, dan supaya handoff bisa menyebut asal/tujuan.
        machine: "",
        // Rekaman checkpoint. `baseSha` diambil saat start_task sehingga daftar
        // commit milik sesi ini bisa dihitung tanpa menebak, dan `handover` dicatat
        // bila task diserahkan ke mesin lain.
        checkpoint: { checkpointedAt: null, summary: "", baseSha: null, commits: [], handover: null },
        // Repo proyek untuk sesi ini. Ditentukan saat start_task, dipakai semua
        // operasi git berikutnya. Kosong berarti ikuti urutan resolusi di exec.js.
        projectDir: "",
        featureFlowCreated: false,
        featureFlowDescription: "",
        // Definition of Done milik task ini. Aturan dan bentuk itemnya ada di
        // tools/handler-modules/dod.js; di sini hanya disimpan.
        definitionOfDone: [],
        dodSource: "",
        dodFactoryTaskId: "",
        // Naik setiap ada perubahan kerja baru setelah commit tercatat, sehingga
        // bukti item `done` yang lama otomatis tidak lagi berlaku.
        dodRevision: 0,
        // README-first preflight evidence: bounded discovery of README, AGENTS.md
        // and documented CLI entrypoints, recorded at start_task and revalidated
        // at resume_session. Null means the task predates the preflight.
        preflight: null,
        // Urutan kerja yang sedang dijalankan. Terpisah dari `definitionOfDone`:
        // DoD adalah syarat selesai, ini adalah rencana langkahnya. Rencana tidak
        // menjadi gerbang - ia hanya membuat progres bisa dibaca.
        plan: [],
        history: [],
        taskType: "",
      };
      if (this.requireKernelMutex) {
        const sKey = this._sessionKey()?.key || this.sessionId || "";
        const preBound = getHeldWorktreeCapability(this._projectPath());
        if (preBound && sKey && preBound.ownerKey === sKey) {
          this.boundKernelCapability = preBound;
        }
      }
      await this.load();
      if (this.state?.projectDir) {
        const cap = getHeldWorktreeCapability(this.state.projectDir);
        const sKey = this._sessionKey()?.key || this.sessionId || "";
        if (cap && sKey && cap.ownerKey === sKey) {
          this.boundKernelCapability = cap;
        }
      }
      return true;
    });
  }

  async load(options = {}) {
    this._lastLoadCommittedSqlite = false;
    const explicitSkipWrites = options?.skipWrites === true;
    let hasLiveCap = false;
    if (this.requireKernelMutex || this.boundKernelCapability) {
      try {
        hasLiveCap = Boolean(this._assertKernelOwnership("load", { allowDrainingInFlight: true }));
      } catch {
        hasLiveCap = false;
      }
    }
    const hasEnforcedLockWithoutCap =
      (this.requireKernelMutex || this.boundKernelCapability) && !hasLiveCap;
    const skipWrites = explicitSkipWrites || hasEnforcedLockWithoutCap;

    // Berkas bernama lama (`.workflow-state.json`) dipindahkan ke nama sekarang
    // SEBELUM apa pun dibaca. Tanpa ini, pengguna yang memutakhirkan dari versi
    // pra-1.16 akan tampak kehilangan seluruh state-nya.
    if (!skipWrites) {
      await this._withOwnershipFence("load.migrateLegacyStateFile", async () => {
        await migrateLegacyStateFile(this.stateFile);
      });
    }

    const { key: sessionKey } = this._sessionKey();
    const userId = getCurrentUserId(this.stateFile, { skipWrites });
    const projectPath = this._projectPath();

    // True read-only path: when skipWrites is true and no injected dbAdapter is present,
    // open any existing SQLite DB strictly read-only (no WAL pragma, no schema migration)
    // and never create a missing SQLite DB file before ownership is acquired.
    let roAdapter = null;
    let db = null;
    if (skipWrites && !this.dbAdapter) {
      if (existsSync(resolveDbPath({ stateFile: this.stateFile }))) {
        roAdapter = new SqliteAdapter({ stateFile: this.stateFile, readOnly: true });
        const roConn = await roAdapter.connect();
        db = roConn ? roAdapter : null;
      }
    } else {
      db = await this._db();
    }

    try {
    // Migrasi berkas JSON lama dijalankan SEKALI per database, bukan tiap load.
    if (!skipWrites && db) {
      await this._withOwnershipFence("load.ensureMigrated", async () => {
        await this._ensureMigrated(db, projectPath);
      });
    }

    let row = null;
    if (db) {
      try {
        row = await db.loadStateVersioned({ userId, projectPath, sessionKey });
      } catch (err) {
        if (!(skipWrites && /no such table/i.test(String(err?.message || "")))) {
          throw err;
        }
      }
    }
    this.stateVersion = row?.version ?? null;

    if (!row) {
      // Sesi ini belum punya baris. Bila berkas JSON-nya ada, adopsi sekali
      // supaya task yang sedang berjalan tidak hilang saat pemutakhiran.
      const adopted = await this._adoptLegacyJsonIfPresent(db, userId, projectPath, sessionKey, {
        skipWrites: explicitSkipWrites,
      });
      if (!adopted) {
        // Benar-benar sesi baru: state default dari constructor sudah tepat.
        // History proyek tetap dibaca supaya rekomendasi tidak buta.
        if (db) {
          await this._hydrateHistoryFromDatabase(db, userId, projectPath);
        }
        await this.mergeSharedHistory({ skipWrites });
        this.loadedTask = "";
        if (!skipWrites) {
          // Initial export so tools that read the JSON do not find a missing file
          // just because the session never saved. If during the initial load
          // the project is held by a foreign writer, do not write an empty export.
          await this._exportJson({ allowSkipIfForeignLock: true });
          try {
            await this.updateProjectSummary({ allowSkipIfForeignLock: true });
          } catch (error) {
            safeLog("warn", `Ringkasan proyek awal gagal ditulis: ${error.message}`);
          }
        }
        return;
      }
      if (explicitSkipWrites) {
        const parsedAdopted = sanitize(migrateOwnerMetadata(adopted));
        this.state = {
          ...this.state,
          ...parsedAdopted,
        };
        if (db) {
          await this._hydrateHistoryFromDatabase(db, userId, projectPath);
        }
        await this.mergeSharedHistory({ skipWrites });
        this.loadedTask = this.state.taskDescription || "";
        return;
      }
    }

    const current = row ?? (await db.loadStateVersioned({ userId, projectPath, sessionKey }));
    this.stateVersion = current?.version ?? null;

    const parsed = sanitize(migrateOwnerMetadata(current.state));
    this.state = {
      ...this.state,
      ...parsed,
    };
    // Riwayat dipulihkan dari TABEL, karena ia tidak lagi ikut di `state_json`.
    await this._hydrateHistoryFromDatabase(db, userId, projectPath);
    } finally {
      if (roAdapter) {
        await roAdapter.close();
      }
    }
    await this.mergeSharedHistory({ skipWrites });
    this.loadedTask = this.state.taskDescription || "";
      // A state written before checkpoints existed has no `checkpoint` field.
      // Normalise it here rather than in every reader, so callers can assume the
      // shape. Old sessions simply have an empty checkpoint, not a broken one.
      if (!this.state.checkpoint || typeof this.state.checkpoint !== "object") {
        this.state.checkpoint = { checkpointedAt: null, summary: "", baseSha: null, commits: [], handover: null };
      }
      if (typeof this.state.machine !== "string") {
        this.state.machine = "";
      }
      if (typeof this.state.testsCreated !== "boolean") {
        this.state.testsCreated = false;
      }
      if (typeof this.state.testsSkipped !== "boolean") {
        this.state.testsSkipped = false;
      }
      if (typeof this.state.testsSkippedReason !== "string") {
        this.state.testsSkippedReason = "";
      }
      if (typeof this.state.readyCheckCompleted !== "boolean") {
        this.state.readyCheckCompleted = false;
      }
      if (typeof this.state.released !== "boolean") {
        this.state.released = false;
      }
      if (typeof this.state.releaseSkipped !== "boolean") {
        this.state.releaseSkipped = false;
      }
      if (typeof this.state.releaseSkippedReason !== "string") {
        this.state.releaseSkippedReason = "";
      }
      if (typeof this.state.commitAndPushCompleted !== "boolean") {
        this.state.commitAndPushCompleted = false;
      }
      if (typeof this.state.releaseCommand !== "string") {
        this.state.releaseCommand = "";
      }
      if (typeof this.state.releaseNotes !== "string") {
        this.state.releaseNotes = "";
      }
      if (typeof this.state.lastCommitMessage !== "string") {
        this.state.lastCommitMessage = "";
      }
      if (typeof this.state.lastPushBranch !== "string") {
        this.state.lastPushBranch = "";
      }
      if (typeof this.state.projectDir !== "string") {
        this.state.projectDir = "";
      }
      if (typeof this.state.featureFlowCreated !== "boolean") {
        this.state.featureFlowCreated = false;
      }
      if (typeof this.state.featureFlowDescription !== "string") {
        this.state.featureFlowDescription = "";
      }
      // Berkas state yang ditulis sebelum fitur DoD ada tidak punya field ini.
      // Ia harus muncul sebagai "belum punya DoD", bukan undefined yang membuat
      // gerbang melempar TypeError.
      this.state.definitionOfDone = normalizeDodItems(this.state.definitionOfDone);
      if (typeof this.state.dodSource !== "string") {
        this.state.dodSource = "";
      }
      if (typeof this.state.dodFactoryTaskId !== "string") {
        this.state.dodFactoryTaskId = "";
      }
      if (!Number.isFinite(Number(this.state.dodRevision)) || Number(this.state.dodRevision) < 0) {
        this.state.dodRevision = 0;
      } else {
        this.state.dodRevision = Math.trunc(Number(this.state.dodRevision));
      }
      // Berkas state yang ditulis sebelum gerbang dokumentasi ada tidak punya
      // field ini. Ia harus muncul sebagai "belum ada bukti berkas", bukan
      // undefined yang membuat perbandingan panjang melempar TypeError.
      this.state.documentationFiles = Array.isArray(this.state.documentationFiles)
        ? this.state.documentationFiles
            .filter((entry) => typeof entry === "string" && entry.trim() !== "")
        : [];
      if (typeof this.state.documentationWaived !== "boolean") {
        this.state.documentationWaived = false;
      }
      if (typeof this.state.documentationWaiverReason !== "string") {
        this.state.documentationWaiverReason = "";
      }
      if (typeof this.state.lastCommitSha !== "string") {
        this.state.lastCommitSha = "";
      }
      // Berkas state dari versi sebelum fitur rencana tidak punya field ini.
      this.state.plan = normalizePlan(this.state.plan);
  }

  /**
   * Menyatukan `history` sesi ini dengan `history` bersama.
   *
   * History adalah catatan proyek: task yang selesai di satu sesi harus
   * terlihat dari sesi lain, dan entri yang sama tidak boleh berganda walau
   * berkali-kali disimpan.
   */
  async mergeSharedHistory({ skipWrites = false } = {}) {
    if (this.historyFile === this.stateFile) {
      return 0;
    }

    const hasil = await this.readHistoryFile();
    if (hasil.status === "unreadable" || hasil.status === "corrupt") {
      // Membaca untuk MENGGABUNG tidak boleh menghapus apa pun: kalau tidak
      // terbaca, lewati penggabungan dan biarkan berkasnya utuh. Penulisan
      // nanti akan menolak dengan alasan yang jelas (lihat writeHistoryFile).
      return 0;
    }
    const shared = hasil.status === "ok" ? hasil.data : null;
    const merged = this.mergeDiskHistory(shared);
    if (merged > 0 && !skipWrites) {
      await this.writeHistoryFile();
    }
    return merged;
  }

  /**
   * Hasil baca history bersama, LENGKAP dengan statusnya.
   *
   * Dulu fungsi ini mengembalikan `null` untuk semua kegagalan, sehingga
   * "gagal membaca" tidak bisa dibedakan dari "belum ada history".
   */
  async readHistoryFile() {
    return readJsonStateFile(this.historyFile, this.fs);
  }

  /** Menulis hanya `history` ke berkas bersama, tanpa task milik sesi ini. */
  async writeHistoryFile() {
    if (this.historyFile === this.stateFile) {
      return;
    }

    return await this._withOwnershipFence("writeHistoryFile", async () => {
      const hasil = await readJsonStateFile(this.historyFile, this.fs);

      // Berkas ada tetapi gagal dibaca (EBUSY/EACCES/EMFILE). Menulis sekarang
      // berarti menghapus riwayat seluruh sesi lain di proyek ini - hanya karena
      // berkasnya sedang dipegang proses lain sesaat.
      if (hasil.status === "unreadable") {
        throw new Error(
          `History bersama "${this.historyFile}" tidak bisa dibaca ` +
            `(${hasil.error?.code || hasil.error?.message}). Penulisan dibatalkan ` +
            `supaya riwayat sesi lain tidak terhapus.`,
        );
      }

      let shared = {};
      if (hasil.status === "corrupt") {
        const cadangan = await backupDamagedFile(this.historyFile, this.fs);
        console.warn(
          `⚠️ History bersama rusak; isi aslinya disimpan di "${cadangan}" sebelum ditulis ulang.`,
        );
      } else if (hasil.status === "ok") {
        shared = hasil.data && typeof hasil.data === "object" ? hasil.data : {};
        if (shared.history !== undefined && !Array.isArray(shared.history)) {
          const cadangan = await backupDamagedFile(this.historyFile, this.fs);
          console.warn(
            `⚠️ Kolom history di "${this.historyFile}" bukan daftar; isi aslinya disimpan di "${cadangan}".`,
          );
          shared = { ...shared, history: [] };
        }
      }

      const merged = Array.isArray(shared.history) ? shared.history.slice() : [];
      const seen = new Set(merged.map((entry) => this.historyKey(entry)));
      for (const entry of this.state.history || []) {
        const key = this.historyKey(entry);
        if (!seen.has(key)) {
          merged.push(entry);
          seen.add(key);
        }
      }

      const payload = { ...shared, history: merged };
      assertSafeKnowledge(payload);
      await fs.mkdir(path.dirname(this.historyFile), { recursive: true });
      await fs.writeFile(this.historyFile, JSON.stringify(payload, null, 2));
    });
  }

  async ensurePrimaryFile() {
    return await this._withOwnershipFence("ensurePrimaryFile", async () => {
      assertSafeKnowledge(this.state);
      if (!this._hasExplicitStateFile) {
        const materialized = resolveStateFile({
          sessionId: this.sessionId,
          skipMigrationWrites: false,
        });
        if (materialized && materialized !== this.stateFile) {
          this.stateFile = materialized;
          this.historyFile = resolveHistoryFile(materialized);
        }
      }
      let created = false;
      try {
        await fs.access(this.stateFile);
      } catch {
        await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
        await fs.writeFile(this.stateFile, JSON.stringify(this.state, null, 2));
        created = true;
      }

      // Always ensure a fresh project summary so dependent tooling can read it immediately.
      await this.updateProjectSummary();
      await ensureCompatibilityLinks(this.stateFile).catch(() => {});

      return created;
    });
  }

  /**
   * Gabungkan kemajuan langkah dari disk bila task-nya sama.
   *
   * Hanya menyentuh flag yang MONOTON dalam satu task. Field yang bisa turun
   * dengan sengaja (mis. `readyCheckCompleted` yang direset `create_tests`)
   * tidak digabung, karena itu bagian dari alur normal satu proses.
   *
   * `reconciled` sudah memuat state disk terbaru; `this.state` adalah milik
   * proses ini. Kalau task berbeda atau disk idle, tidak ada yang digabung:
   * itu task lain, atau task baru yang memang harus mulai dari nol.
   */
  mergeMonotonicProgress(reconciled) {
    const diskTask = (reconciled?.diskTask || "").trim();
    const ourTask = (this.state.taskDescription || "").trim();
    if (!diskTask || !ourTask || diskTask !== ourTask) {
      return;
    }
    if ((reconciled?.diskPhase || "idle") === "idle") {
      return;
    }

    // Harus dari `reconciled` yang BARU dibaca. `lastReconcile` adalah hasil
    // penyimpanan sebelumnya, sehingga bisa tertinggal satu putaran - dan
    // justru itu yang membuat penggabungan gagal menangkap langkah terbaru.
    const disk = reconciled?.diskState;
    if (!disk) {
      return;
    }

    // Kemajuan hanya boleh maju. Sekali sebuah langkah tercapai di proses mana
    // pun, langkah itu tetap tercapai.
    for (const field of MONOTONIC_STEP_FIELDS) {
      if (disk[field] === true && this.state[field] !== true) {
        this.state[field] = true;
      }
    }
  }

  /**
   * Gabungkan item DoD dengan milik disk bila task-nya sama.
   *
   * Sama seperti `mergeMonotonicProgress`, ini hanya berlaku untuk task yang
   * SAMA. `start_task` mengganti task, dan pada saat itu DoD memang harus mulai
   * dari nol - bukan mewarisi bukti task sebelumnya.
   *
   * Bedanya, DoD digabung per item dengan aturan "yang lebih kuat menang",
   * bukan OR boolean: dua proses MCP bisa melayani task yang sama, dan proses
   * yang memegang state basi tidak boleh menghapus bukti item yang baru dicatat
   * proses lain.
   */
  mergeDefinitionOfDone(reconciled) {
    const diskTask = (reconciled?.diskTask || "").trim();
    const ourTask = (this.state.taskDescription || "").trim();
    if (!diskTask || !ourTask || diskTask !== ourTask) {
      return 0;
    }
    if ((reconciled?.diskPhase || "idle") === "idle") {
      return 0;
    }

    const disk = reconciled?.diskState;
    if (!disk) {
      return 0;
    }

    const before = Array.isArray(this.state.definitionOfDone) ? this.state.definitionOfDone : [];
    const merged = mergeDodItems(before, normalizeDodItems(disk.definitionOfDone));
    this.state.definitionOfDone = merged;

    // Revisi hanya boleh maju: revisi yang lebih tinggi berarti ada perubahan
    // kerja baru yang sudah diketahui proses lain. Mundur berarti bukti basi
    // diam-diam dihidupkan kembali.
    const diskRevision = Number(disk.dodRevision);
    if (Number.isFinite(diskRevision) && diskRevision > Number(this.state.dodRevision || 0)) {
      this.state.dodRevision = Math.trunc(diskRevision);
    }

    return merged.length - before.length;
  }

  async save(options = {}) {
    return await this.runSerialized(async () => {
      return await this._withOwnershipFence("save", async () => {
        return await this._saveUnderFence(options);
      });
    });
  }

  async _saveUnderFence(options = {}) {
    this._lastSaveCommittedSqlite = false;
    assertSafeKnowledge(this.state);

    const db = await this._db();
    const { key: sessionKey, source: keySource } = this._sessionKey();
    const userId = getCurrentUserId(this.stateFile);
    const projectPath = this._projectPath();

    // Capture repository identity at the start of a task.
    // Best-effort: no git, no repo, or failing commands must not stop start_task.
    // An empty result is stored too, so a non-repository project is not probed
    // again on every save.
    if (this.state.projectDir && !this.state.repository) {
      try {
        const repo = await captureRepository({ dir: this.state.projectDir });
        this.state.repository = { path: repo.path, remote: repo.remote };
      } catch (error) {
        this.state.repository = { path: "", remote: "" };
      }
    }

    // Index the current AI session for resumable access from Zettly Todo.
    // Only OpenCode sessions (`ses_...`) can be resumed; Codex/Antigravity keys
    // (`proc-...`) are process-only and marked as such.
    if (this.state.workflowTaskId) {
      try {
        const context = currentSessionContext({ key: sessionKey, env: process.env });
        recordAiSession(this.state, {
          key: sessionKey,
          agent: context.agent,
          machine: context.machine,
          title: context.title,
          source: keySource,
          phase: this.state.currentPhase || "idle",
          now: Date.now(),
        });
      } catch (error) {
        // AI session indexing is best-effort. Failures are logged but never block.
      }
    }

    // Baca baris SESI INI dari SQLite. `null` berarti sesi baru - bukan
    // kegagalan. Isi yang rusak melempar dari adapter, dan itu memang benar:
    // "gagal membaca" tidak boleh berubah menjadi "kosong".
    const existing = await db.loadStateVersioned({ userId, projectPath, sessionKey });
    const reconciled = this._reconciledFrom(existing);

    // Penulis basi tidak boleh menang.
    //
    // Bug 29 Okt 2026: satu proses MCP memegang state lama, lalu menyimpan
    // sesudah proses lain memulai task baru. Task baru tertimpa dan pemanggil
    // tetap diberi tahu "berhasil". Pemeriksaan ini tetap ada, tetapi sekarang
    // membaca baris milik sesi ini saja - bukan berkas yang dipakai bersama.
    const conflict = this.detectStaleOverwrite(reconciled, options);
    this.mergeMonotonicProgress(reconciled);
    this.mergeDefinitionOfDone(reconciled);

    if (conflict) {
      this._adoptState(existing?.state ?? null);
      this.lastConflict = conflict;
      await this._exportJson();
      return { ...reconciled, conflict, verified: false };
    }
    this.lastConflict = null;

    this.state.owner = {
      processMarker: PROCESS_TOKEN,
      pid: process.pid,
      // Process identity for the reaper: a PID alone is not proof of
      // ownership, so record when this process started and which executable
      // owns it. Both are stable for the life of the process.
      startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
      executable: process.execPath,
      updatedAt: new Date().toISOString(),
    };

    let written;
    // `history` TIDAK ikut ke `state_json`.
    //
    // Riwayat sudah tersimpan di tabel `workflow_history`, dan menyimpannya dua
    // kali membuat setiap langkah workflow menulis ulang seluruh riwayat. Yang
    // diukur di mesin ini: 96 KB per simpan, 74% di antaranya riwayat, dan
    // angkanya naik terus seiring usia proyek - di jalur terpanas sistem.
    const { history: _omitHistory, ...persistedState } = this.state;
    this._assertKernelOwnership("save_commit", { allowDrainingInFlight: true });

    try {
      written = await db.saveStateVersioned({
        userId,
        projectPath,
        sessionKey,
        state: persistedState,
        // Versi yang KITA PEGANG, bukan yang barusan dibaca ulang. Memakai
        // hasil baca ulang membuat pemeriksaan versi tidak pernah menolak
        // apa pun: celah antara baca dan tulis nyaris nol, sehingga dua proses
        // pada sesi yang sama sama-sama "berhasil" dan yang kalah menimpa
        // `currentPhase`, `plan`, dan `documentationFiles` tanpa perlawanan.
        expectedVersion: this.stateVersion,
      });
    } catch (error) {
      if (error?.code === "STATE_CONFLICT") {
        // Ada penulis lain yang lebih dulu pada kunci yang sama.
        //
        // Satu percobaan ulang, dengan baris TERSIMPAN sebagai dasar: kita hanya
        // menyumbang kemajuan yang bersifat monoton (langkah yang sudah tercapai)
        // dan bukti DoD. Fase, rencana, dan daftar berkas tetap milik baris
        // tersimpan, karena penulis basi tidak boleh mengembalikannya.
        //
        // Bila percobaan kedua juga bentrok, baru dilaporkan: dua penulis yang
        // benar-benar bersamaan tidak boleh saling menimpa berkali-kali.
        const ourFlags = {};
        for (const field of MONOTONIC_STEP_FIELDS) {
          if (this.state[field] === true) ourFlags[field] = true;
        }
        const ourDod = normalizeDodItems(this.state.definitionOfDone);
        const ourRevision = Number(this.state.dodRevision) || 0;

        const latest = await db.loadStateVersioned({ userId, projectPath, sessionKey });

        if (latest) {
          this.state = {
            ...latest.state,
            ...ourFlags,
            definitionOfDone: mergeDodItems(
              normalizeDodItems(latest.state.definitionOfDone),
              ourDod,
            ),
            dodRevision: Math.max(Number(latest.state.dodRevision) || 0, ourRevision),
            owner: {
              processMarker: PROCESS_TOKEN,
              pid: process.pid,
              startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
              executable: process.execPath,
              updatedAt: new Date().toISOString(),
            },
          };

          try {
            const { history: _omitRetryHistory, ...retryState } = this.state;
            written = await db.saveStateVersioned({
              userId,
              projectPath,
              sessionKey,
              state: retryState,
              expectedVersion: latest.version,
            });
          } catch (retryError) {
            if (retryError?.code !== "STATE_CONFLICT") throw retryError;
            written = null;
          }
        }

        if (!written) {
          const winner = await db.loadStateVersioned({ userId, projectPath, sessionKey });
          this._adoptState(winner?.state ?? null);
          this.lastConflict = {
            diskTask: winner?.state?.taskDescription || "",
            staleTask: "",
            diskPhase: winner?.state?.currentPhase || "idle",
            reason: error.message,
          };
          await this._exportJson();
          return { ...reconciled, conflict: this.lastConflict, verified: false };
        }
      } else {
        throw error;
      }
    }

    this._lastSaveCommittedSqlite = true;
    this.stateVersion = written.version;
    this.lastReconcile = reconciled;
    this.loadedTask = this.state.taskDescription || "";

    // Catat siapa yang menulis, supaya dua proses pada kunci yang sama bisa
    // terlihat di `get_workflow_status` alih-alih hanya terasa sebagai keanehan.
    try {
      db.db
        .prepare(
          `INSERT INTO state_writer (user_id, project_path, session_key, pid, process_token, key_source, last_write_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(user_id, project_path, session_key) DO UPDATE SET
             pid = excluded.pid,
             process_token = excluded.process_token,
             key_source = excluded.key_source,
             last_write_at = datetime('now')`,
        )
        .run(userId, projectPath, sessionKey, process.pid, PROCESS_TOKEN, keySource);

      // Riwayat penulis: `state_writer` hanya menyimpan SATU baris per sesi,
      // sehingga dua proses yang bergantian menulis tidak terlihat di sana.
      // Riwayat inilah yang membuat pertikaian bisa dideteksi dan dilaporkan.
      db.db
        .prepare(
          `INSERT INTO state_writer_history (user_id, project_path, session_key, process_token, written_at)
           VALUES (?, ?, ?, ?, datetime('now'))`,
        )
        .run(userId, projectPath, sessionKey, PROCESS_TOKEN);

      // Retensi: tabel ini bertambah satu baris setiap `save()` tetapi hanya
      // dipakai untuk jendela 60 detik. Tanpa pemangkasan ia menjadi tabel
      // terbesar di database. Dijalankan sesekali, bukan setiap simpan.
      writerHistoryWrites += 1;
      if (writerHistoryWrites % 200 === 0) {
        try {
          db.pruneWriterHistory({ days: 7 });
        } catch (error) {
          safeLog("warn", `Retensi riwayat penulis gagal: ${error.message}`);
        }
      }
    } catch (error) {
      safeLog("warn", `Gagal mencatat penulis state: ${error.message}`);
    }

    // Berikutnya semuanya opsional: ekspor, history, ringkasan, replika, monitor.
    // Tidak satu pun boleh menggagalkan penyimpanan yang sudah berhasil - itu
    // kelas bug yang membuat dokumentasi hilang karena hal lain gagal.
    const postCommitProjectionErrors = [];
    const prevRepairMarkersJson = JSON.stringify({
      pendingProjectionRepair: this.state?.pendingProjectionRepair || null,
      pendingHistorySummaryRepairKeys: this.state?.pendingHistorySummaryRepairKeys || null,
    });
    const exportOk = await this._exportJson();
    this._lastExportJsonOk = exportOk !== false;
    if (exportOk === false) {
      postCommitProjectionErrors.push("exportJson:EXPORT_RETURNED_FALSE");
    }

    try {
      await this.writeHistoryFile();
      await this.updateProjectSummary();
    } catch (error) {
      if (error instanceof ProjectOwnershipLostError || error?.code === "PROJECT_OWNERSHIP_LOST") {
        throw error;
      }
      postCommitProjectionErrors.push(`summaryOrHistory:${error.message}`);
      safeLog("warn", `Riwayat/ringkasan gagal diperbarui: ${error.message}`);
    }

    // History milik PROYEK, jadi masuk tabel bersama - bukan hanya berkas.
    try {
      const histRes = await this._syncHistoryToDatabase(db, userId, projectPath);
      if (histRes?.skipped > 0) {
        postCommitProjectionErrors.push(`syncHistoryDb:SKIPPED_${histRes.skipped}`);
      }
      if (histRes?.summaryFailed) {
        postCommitProjectionErrors.push(`syncHistorySummary:${histRes.summaryError || "FAILED"}`);
      }
    } catch (error) {
      postCommitProjectionErrors.push(`syncHistoryDb:${error.message}`);
      safeLog("warn", `Sinkronisasi history ke database gagal: ${error.message}`);
    }
    this._lastPostCommitProjectionErrors = postCommitProjectionErrors;

    if (postCommitProjectionErrors.length > 0) {
      const existingRepair =
        this.state?.pendingProjectionRepair && typeof this.state.pendingProjectionRepair === "object"
          ? this.state.pendingProjectionRepair
          : {};
      this.state.pendingProjectionRepair = {
        ...existingRepair,
        errors: [...postCommitProjectionErrors],
        failedAt: new Date().toISOString(),
      };
    } else if (this.state?.pendingProjectionRepair) {
      const hasUnresolvedTransitionRepair = Boolean(
        this.state.pendingProjectionRepair.triggerError ||
          (Array.isArray(this.state.pendingProjectionRepair.repairErrors) &&
            this.state.pendingProjectionRepair.repairErrors.length > 0),
      );
      if (hasUnresolvedTransitionRepair) {
        delete this.state.pendingProjectionRepair.errors;
      } else {
        delete this.state.pendingProjectionRepair;
      }
    }

    const nextRepairMarkersJson = JSON.stringify({
      pendingProjectionRepair: this.state?.pendingProjectionRepair || null,
      pendingHistorySummaryRepairKeys: this.state?.pendingHistorySummaryRepairKeys || null,
    });
    if (nextRepairMarkersJson !== prevRepairMarkersJson && typeof db.saveStateVersioned === "function") {
      try {
        this._assertKernelOwnership("save_repair_marker", { allowDrainingInFlight: true });
        const { history: _omitHistory2, ...persistedRepairState } = this.state;
        const repairWritten = await db.saveStateVersioned({
          userId,
          projectPath,
          sessionKey,
          state: persistedRepairState,
          expectedVersion: this.stateVersion,
        });
        if (repairWritten && Number.isFinite(Number(repairWritten.version))) {
          this.stateVersion = repairWritten.version;
        }
      } catch (repairPersistErr) {
        postCommitProjectionErrors.push(`persistRepairMarker:${repairPersistErr.message}`);
      }
    }

    // Sambungkan antrean replika: laporan yang gagal terkirim ke dashboard
    // ditampung di sini, bukan ditelan. Kegagalannya tidak pernah menggagalkan
    // penyimpanan - lihat _replicate.
    await this._replicate(db, userId, projectPath, sessionKey);
    await this.verifyPersisted(this.loadedTask);

    // Laporan ke dashboard pusat. DITUNGGU tetapi berbatas waktu keras di
    // dalam `reportSnapshot`: proses CLI yang keluar segera setelah simpan akan
    // membunuh permintaan yang belum terkirim, dan dashboard lalu tidak pernah
    // melihat sesi itu. Bila monitor mati, laporan gagal dalam ~1,2 detik dan
    // penyimpanan tetap berhasil - laporan tidak pernah melempar.
    await reportToMonitorSafe({
      state: this.state,
      stateFile: this.stateFile,
      createdAt: this.sessionStartedAt || "",
    });

    return { ...reconciled, verified: true, version: written.version };
  }

  /**
   * Apakah penyimpanan ini akan menimpa task berjalan milik proses lain?
   *
   * Konflik hanya kalau SEMUA ini benar:
   *   - disk memuat task yang SEDANG berjalan (bukan idle),
   *   - task di disk bukan task yang terakhir kita muat (jadi ditulis orang
   *     lain sesudah kita membaca),
   *   - task di disk bukan task yang akan kita tulis (jadi bukan kita sendiri),
   *   - pemanggil tidak menyatakan maksud mengganti task.
   *
   * `start_task` memang bermaksud mengganti task, jadi ia memakai
   * `allowReplaceRunningTask: true` dan tetap menang - tetapi task yang diganti
   * diarsipkan oleh `reconcileWithDisk`, bukan dihapus.
   */
  detectStaleOverwrite(reconciled, options = {}) {
    if (options.allowReplaceRunningTask === true) {
      return null;
    }
    const diskTask = reconciled?.diskTask || "";
    const diskPhase = reconciled?.diskPhase || "idle";
    if (!diskTask || diskPhase === "idle") {
      return null;
    }
    if (diskTask === this.loadedTask) {
      return null;
    }
    if (diskTask === (this.state.taskDescription || "")) {
      return null;
    }
    return {
      diskTask,
      staleTask: this.state.taskDescription || "",
      diskPhase,
    };
  }

  /**
   * Pastikan tulisan kita benar-benar bertahan.
   *
   * Tanpa ini, proses yang kalah balapan tetap melaporkan sukses. Lebih baik
   * gagal terang-terangan daripada memberi tahu "berhasil" untuk state yang
   * sudah ditimpa proses lain.
   */
  async verifyPersisted(expectedTask) {
    // Dibaca ulang dari SQLite, bukan dari berkas: berkas JSON kini hanya
    // ekspor, dan menganggapnya bukti kebenaran berarti memeriksa cermin.
    const db = await this._db();
    const { key: sessionKey } = this._sessionKey();
    const userId = getCurrentUserId(this.stateFile);
    const projectPath = this._projectPath();

    const row = await db.loadStateVersioned({ userId, projectPath, sessionKey });
    if (!row) return true;

    const actual = row.state?.taskDescription || "";
    if (actual !== (expectedTask || "")) {
      // StateConflict, bukan Error biasa: lapisan tool sudah punya jawaban yang
      // menyuruh agen memuat ulang state. Error biasa berakhir sebagai
      // "Internal server error", dan agen mengira itu bug sementara.
      throw new StateConflict(
        `State workflow tidak bertahan: yang ditulis "${expectedTask}" tetapi tersimpan "${actual}". ` +
        `Proses MCP lain menimpanya. Muat ulang state sebelum melanjutkan.`,
        { sessionKey, expectedVersion: this.stateVersion, actualVersion: row.version },
      );
    }
    return true;
  }

  /**
   * Baca isi berkas state APA ADANYA dari disk (bukan dari memori).
   * Mengembalikan null kalau belum ada / rusak.
   */
  async readDiskState({ skipWrites = false } = {}) {
    let terakhir = null;
    // Berkas state bisa terkunci sesaat (OneDrive, antivirus, proses MCP lain).
    // Percobaan ulang singkat mencegah kegagalan sesaat berubah menjadi
    // "anggap kosong, lalu timpa" - pola yang menghapus pekerjaan sesi lain.
    for (let percobaan = 0; percobaan < 3; percobaan += 1) {
      const hasil = await readJsonStateFile(this.stateFile, this.fs);

      if (hasil.status === "ok") {
        return sanitize(migrateOwnerMetadata(hasil.data));
      }
      if (hasil.status === "missing") {
        return null;
      }
      if (hasil.status === "corrupt") {
        if (skipWrites) {
          throw new Error(`State file "${this.stateFile}" is corrupt and cannot be read.`);
        }
        const cadangan = await this._withOwnershipFence(
          "readDiskState.backupDamaged",
          async () => backupDamagedFile(this.stateFile, this.fs),
        );
        throw new Error(
          `Berkas state "${this.stateFile}" rusak dan tidak bisa dibaca. ` +
            `Isi aslinya disimpan di "${cadangan}". Perbaiki atau hapus berkas itu ` +
            `sebelum melanjutkan - menimpanya berarti kehilangan jejak task yang sedang berjalan.`,
        );
      }

      terakhir = hasil;
      if (percobaan < 2) await new Promise((selesai) => setTimeout(selesai, 25));
    }

    throw new Error(
      `Berkas state "${this.stateFile}" tidak bisa dibaca ` +
        `(${terakhir?.error?.code || terakhir?.error?.message}). Penulisan dibatalkan ` +
        `supaya pekerjaan sesi lain tidak tertimpa.`,
    );
  }

  /** True kalau berkas di disk terakhir ditulis proses MCP lain. */
  isForeignWrite(diskState) {
    const token = diskState?.owner?.processMarker;
    return typeof token === "string" && token.length > 0 && token !== PROCESS_TOKEN;
  }

  historyKey(entry) {
    return `${entry?.timestamp || ""}|${entry?.taskDescription || ""}`;
  }

  mergeDiskHistory(diskState) {
    if (!diskState || !Array.isArray(diskState.history)) {
      return 0;
    }
    if (!Array.isArray(this.state.history)) {
      this.state.history = [];
    }
    const seen = new Set(this.state.history.map((entry) => this.historyKey(entry)));
    let added = 0;
    for (const entry of diskState.history) {
      const key = this.historyKey(entry);
      if (!seen.has(key)) {
        this.state.history.push(entry);
        seen.add(key);
        added += 1;
      }
    }
    return added;
  }

  /**
   * Rekonsiliasi sebelum menulis: jangan buang pekerjaan proses lain.
   *
   * 1. Gabungkan `history` dari disk supaya catatan task lain tidak hilang.
   * 2. Kalau disk memuat task yang SEDANG BERJALAN milik proses lain, arsipkan
   *    ke `history` sebagai `interrupted` sebelum kita menimpanya.
   *
   * Tanpa langkah 2, task itu lenyap tanpa jejak - itulah bug yang menyebabkan
   * pekerjaan resize docker-alma tidak pernah muncul di view_history.
   */
  async reconcileWithDisk() {
    const result = {
      mergedHistory: 0,
      preservedTask: null,
      foreignToken: null,
      diskTask: "",
      diskPhase: "idle",
      // Dipakai mergeMonotonicProgress: state tersimpan apa adanya, supaya flag
      // langkah yang sudah dicapai proses lain bisa digabung.
      diskState: null,
    };

    // Sumbernya SQLite, bukan berkas JSON. Berkas JSON kini hanya ekspor, dan
    // membaca ekspor untuk memutuskan "apakah ada task lain" berarti memutuskan
    // berdasarkan salinan yang bisa saja sudah tertinggal.
    const db = await this._db();
    const { key: sessionKey } = this._sessionKey();
    const row = await db.loadStateVersioned({
      userId: getCurrentUserId(this.stateFile),
      projectPath: this._projectPath(),
      sessionKey,
    });

    const disk = row?.state ?? null;
    if (!disk) {
      return result;
    }
    result.diskState = disk;

    result.diskTask = disk.taskDescription || "";
    result.diskPhase = disk.currentPhase || "idle";
    result.mergedHistory = this.mergeDiskHistory(disk);

    if (!this.isForeignWrite(disk)) {
      return result;
    }

    result.foreignToken = disk.owner.processMarker;

    const hasRunningTask =
      typeof disk.taskDescription === "string" &&
      disk.taskDescription.trim() !== "" &&
      disk.currentPhase &&
      disk.currentPhase !== "idle";

    if (!hasRunningTask) {
      return result;
    }

    const alreadyArchived = this.state.history.some(
      (entry) => entry.interrupted && entry.taskDescription === disk.taskDescription
    );
    if (alreadyArchived) {
      return result;
    }

    this.state.history.push({
      classification: disk.classification || "INTERNAL",
      taskDescription: disk.taskDescription,
      taskType: disk.taskType || "other",
      commitMessage: disk.lastCommitMessage || "",
      interrupted: true,
      dropped: true,
      dropReason:
        "Ditimpa proses agen lain: state workflow dipakai bersama antar sesi di mesin ini",
      interruptedAtPhase: disk.currentPhase,
      interruptedBy: disk.owner.processMarker,
      timestamp: new Date().toISOString(),
    });
    result.preservedTask = disk.taskDescription;
    return result;
  }

  /**
   * Tutup koneksi state database.
   *
   * KENAPA ADA
   * ----------
   * Adapter SQLite memegang berkas `.db`, `-wal`, dan `-shm` selama terbuka.
   * Tanpa cara menutup, sebuah proses yang membuat `WorkflowState` sementara -
   * tes, skrip sekali jalan, atau CLI - meninggalkan berkas terkunci. Di Windows
   * itu membuat direktori sementara tidak bisa dihapus (EBUSY), dan di Linux
   * berkas `-wal` tetap tertinggal.
   *
   * Idempoten: memanggilnya dua kali, atau pada state yang belum pernah menyentuh
   * database, tidak melakukan apa pun.
   */
  async close() {
    const adapter = this.dbAdapter;
    this.dbAdapter = null;
    if (adapter && typeof adapter.close === "function") {
      await adapter.close();
    }
  }

  /**
   * Adapter SQLite yang dipakai menyimpan state hidup.
   *
   * Dimuat malas supaya modul ini tetap bisa diimpor oleh tes yang tidak
   * menyentuh database sama sekali.
   */
  async _db() {
    if (!this.dbAdapter) {
      const mod = await import("./db/index.js");
      // `getLocalAdapter`, bukan `getAdapter`: penyimpanan state hidup SELALU
      // SQLite, apa pun isi DEV_WORKFLOW_DB_TYPE. `stateFile` menentukan lokasi
      // berkasnya: `.state` milik proyek ini, bukan akar drive.
      this.dbAdapter = await mod.getLocalAdapter({ stateFile: this.stateFile });
    } else if (typeof this.dbAdapter.connect === "function") {
      // Adapter yang diinjeksi belum tentu sudah tersambung. `connect()`
      // idempoten, jadi memanggilnya di sini aman dan menghilangkan urutan
      // pemanggilan yang mudah salah.
      await this.dbAdapter.connect();
    }
    return this.dbAdapter;
  }

  /**
   * Mengadopsi berkas JSON sesi ini HANYA bila database belum punya barisnya.
   *
   * Ini jalur migrasi, bukan jalur baca. Sesi yang sudah punya baris tidak akan
   * pernah menyentuh berkas JSON lagi - itulah janji yang dijaga desain ini.
   * Tanpa adopsi, task yang sedang berjalan saat pemutakhiran dipasang akan
   * hilang, dan itu kerugian yang tidak bisa diterima.
   *
   * Berkas yang RUSAK atau TIDAK TERBACA tetap menggagalkan load: memulai dari
   * nol berarti melupakan task yang sedang berjalan.
   */
  async _adoptLegacyJsonIfPresent(db, userId, projectPath, sessionKey, { skipWrites = false } = {}) {
    const hasil = await readJsonStateFile(this.stateFile, this.fs);

    if (hasil.status === "missing") return null;

    if (hasil.status === "corrupt") {
      if (skipWrites) {
        throw new StateUnavailable(
          `State file "${this.stateFile}" is corrupt and cannot be read, ` +
            `so the session state "${sessionKey}" must not start from empty.`,
        );
      }
      const cadangan = await this._withOwnershipFence(
        "_adoptLegacyJsonIfPresent.backupDamaged",
        async () => backupDamagedFile(this.stateFile, this.fs),
      );
      throw new StateUnavailable(
        `Berkas state "${this.stateFile}" rusak dan tidak bisa dibaca, ` +
          `sehingga state sesi "${sessionKey}" tidak boleh dimulai dari kosong. ` +
          `Isi aslinya disimpan di "${cadangan}". Perbaiki atau hapus berkas itu ` +
          `sebelum melanjutkan - memulai dari state kosong akan membuat agen lupa ` +
          `task yang sedang berjalan.`,
      );
    }

    if (hasil.status === "unreadable") {
      throw new StateUnavailable(
        `Berkas state "${this.stateFile}" tidak bisa dibaca ` +
          `(${hasil.error?.code || hasil.error?.message}). Memulai dari state kosong ` +
          `akan membuat pekerjaan sesi ini hilang tanpa jejak.`,
      );
    }

    const state = sanitize(migrateOwnerMetadata(hasil.data));
    if (!state || typeof state !== "object") return null;
    if (skipWrites) {
      return state;
    }

    const performAdopt = async () => {
      try {
        await db.saveStateVersioned({ userId, projectPath, sessionKey, state, expectedVersion: null });
        this._lastLoadCommittedSqlite = true;
        safeLog("info", `State sesi "${sessionKey}" diadopsi dari berkas JSON ke SQLite.`);
        return state;
      } catch {
        // Ada penulis lain yang lebih dulu menyiapkan baris ini; biarkan ia menang.
        return null;
      }
    };
    if (this.requireKernelMutex || this.boundKernelCapability) {
      if (!this._resolveKernelCapability()) {
        throw new ProjectOwnershipLostError(
          `Project ownership lost before adoptLegacyJson: capability_not_held.`,
          { operation: "adoptLegacyJson", reason: "capability_not_held" },
        );
      }
      return await this._withOwnershipFence("adoptLegacyJson", performAdopt);
    }
    return await performAdopt();
  }

  /** Kunci sesi untuk baris state, beserta asalnya untuk dicatat. */
  _sessionKey() {
    if (this._canonicalSessionKey) {
      return { key: this._canonicalSessionKey, source: "state-file" };
    }
    return resolveSessionKeyWithSource(process.env, this.sessionId);
  }

  /**
   * Menjalankan migrasi berkas JSON lama SEKALI per database.
   *
   * Ditandai di `migration_log`, bukan dihitung ulang tiap load. Tanpa penanda,
   * setiap start proses akan memindai seluruh pohon `.state` - dan pada mesin
   * dengan ratusan berkas itu memperlambat setiap panggilan pertama.
   */
  async _ensureMigrated(db, projectPath) {
    const enforceScoped = Boolean(this.requireKernelMutex || this.boundKernelCapability);
    const { key: sessionKey } = this._sessionKey();
    const userId = getCurrentUserId(this.stateFile);
    const scopedProjectDir = this.state?.projectDir || this._resolveCanonicalStateProjectDir?.() || "";
    const allowedProjectSlug = scopedProjectDir
      ? projectKey(canonicalProjectPath(scopedProjectDir) || scopedProjectDir)
      : null;

    // When kernel mutex enforcement is active, migration MUST stay strictly scoped
    // to the verified session/user/project owned by the held capability.
    const marker = enforceScoped
      ? `legacy-json-v1:${projectPath}:${userId}:${sessionKey}:${allowedProjectSlug || "default"}`
      : `legacy-json-v1:${projectPath}`;

    const done = db.db
      .prepare("SELECT name FROM migration_log WHERE name = ?")
      .get(marker);
    if (done) return null;

    if (enforceScoped && !this._resolveKernelCapability()) {
      // Do not perform unfenced migration writes when kernel mutex enforcement is active without a held capability.
      return null;
    }

    const runMigration = async () => {
      const baseDir = path.join(projectPath, STATE_DIR);
      const { migrateLegacyJson } = await import("./db/migrate-legacy.js");
      const result = await migrateLegacyJson(
        db,
        enforceScoped
          ? {
              baseDir,
              allowedSessionKey: sessionKey,
              allowedUserId: userId,
              allowedProjectSlug,
            }
          : { baseDir },
      );

      if (result.sessions > 0 || result.legacyFallback > 0) {
        this._lastLoadCommittedSqlite = true;
      }

      safeLog(
        "info",
        `Migrasi JSON lama (${projectPath}): ${result.sessions} sesi masuk, ` +
          `${result.legacyFallback} cadangan, ${result.skipped} dilewati.`,
      );

      db.db
        .prepare("INSERT OR IGNORE INTO migration_log (name, applied_at) VALUES (?, datetime('now'))")
        .run(marker);

      return result;
    };

    if (enforceScoped) {
      return await this._withOwnershipFence("ensureMigrated", runMigration);
    }
    return await runMigration();
  }

  /**
   * Menyalin riwayat ke tabel `workflow_history`.
   *
   * Hanya entri yang BELUM tersimpan yang dikirim. Sebelumnya seluruh riwayat
   * di-upsert setiap penyimpanan: pada riwayat 85 entri itu berarti 85 upsert
   * per langkah workflow, dan angkanya tumbuh seiring usia proyek.
   *
   * `_syncedHistoryCount` diisi saat `load()` dari jumlah baris yang sudah ada,
   * dan dinaikkan setiap kali entri berhasil dikirim. Satu entri yang gagal
   * tidak menghentikan sisanya - dulu kegagalan pertama membatalkan seluruh
   * fungsi sehingga riwayat berhenti tersimpan tanpa ada yang tahu.
   */
  async _syncHistoryToDatabase(db = null, userId = null, projectPath = null) {
    const resolvedDb = db || (await this._db());
    const resolvedUserId = userId || getCurrentUserId(this.stateFile);
    const resolvedProjectPath = projectPath || this._projectPath();
    if (typeof resolvedDb.insertHistoryEntry !== "function") return { skipped: 0, sent: 0, summaryFailed: false, summaryError: null };

    const history = Array.isArray(this.state.history) ? this.state.history : [];
    const from = Math.min(this._syncedHistoryCount || 0, history.length);
    let skipped = 0;
    let sent = 0;

    for (const entry of history.slice(from)) {
      try {
        await resolvedDb.insertHistoryEntry(resolvedUserId, resolvedProjectPath, entry);
        sent += 1;
        this._syncedHistoryCount = from + sent;
      } catch (error) {
        skipped += 1;
        safeLog("warn", `Entri history dilewati: ${error.message}`);
      }
    }

    // The summary only needs recomputation when something changed or a previous repair is pending
    // for this user+project pair (both in-memory and persisted in state/pendingProjectionRepair).
    if (!(this._pendingHistorySummaryRepairKeys instanceof Set)) {
      this._pendingHistorySummaryRepairKeys = new Set();
    }
    const repairKey = `${resolvedUserId || ""}::${resolvedProjectPath || ""}`;
    const persistedRepairMap =
      this.state?.pendingHistorySummaryRepairKeys &&
      typeof this.state.pendingHistorySummaryRepairKeys === "object" &&
      !Array.isArray(this.state.pendingHistorySummaryRepairKeys)
        ? this.state.pendingHistorySummaryRepairKeys
        : {};
    const persistedRepairErrors = Array.isArray(this.state?.pendingProjectionRepair?.repairErrors)
      ? this.state.pendingProjectionRepair.repairErrors
      : [];
    const hasPendingSummaryRepair =
      this._pendingHistorySummaryRepairKeys.has(repairKey) ||
      persistedRepairMap[repairKey] === true ||
      persistedRepairErrors.some((entry) => String(entry).startsWith("syncHistorySummary:"));
    let summaryFailed = false;
    let summaryError = null;
    if (sent > 0 || hasPendingSummaryRepair) {
      try {
        await resolvedDb.updateSummaryForUser(resolvedUserId, resolvedProjectPath);
        this._pendingHistorySummaryRepairKeys.delete(repairKey);
        if (this.state?.pendingHistorySummaryRepairKeys && typeof this.state.pendingHistorySummaryRepairKeys === "object") {
          delete this.state.pendingHistorySummaryRepairKeys[repairKey];
          if (Object.keys(this.state.pendingHistorySummaryRepairKeys).length === 0) {
            delete this.state.pendingHistorySummaryRepairKeys;
          }
        }
      } catch (error) {
        this._pendingHistorySummaryRepairKeys.add(repairKey);
        if (this.state && typeof this.state === "object") {
          const prev =
            this.state.pendingHistorySummaryRepairKeys &&
            typeof this.state.pendingHistorySummaryRepairKeys === "object" &&
            !Array.isArray(this.state.pendingHistorySummaryRepairKeys)
              ? this.state.pendingHistorySummaryRepairKeys
              : {};
          this.state.pendingHistorySummaryRepairKeys = { ...prev, [repairKey]: true };
        }
        summaryFailed = true;
        summaryError = error?.message || String(error);
        safeLog("warn", `Failed to update the project summary: ${summaryError}`);
      }
    }

    return { skipped, sent, summaryFailed, summaryError };
  }

  /**
   * Memulihkan riwayat dari tabel, bukan dari `state_json`.
   *
   * Riwayat dikeluarkan dari `state_json` supaya setiap penyimpanan tidak
   * menulis ulang seluruh riwayat. Tabelnya sudah lama ada dan berkunci per
   * PROYEK - tempat yang benar untuk catatan proyek.
   */
  async _hydrateHistoryFromDatabase(db, userId, projectPath) {
    const history = this.state.history || [];

    if (typeof db.getHistoryForUser !== "function") {
      this._syncedHistoryCount = history.length;
      return 0;
    }

    try {
      const result = await db.getHistoryForUser(userId, projectPath, { pageSize: 100, page: 1 });
      const stored = (result?.entries || []).map((row) => ({
        classification: row.classification || "INTERNAL",
        taskDescription: row.task_description || "",
        taskType: row.task_type || "other",
        commitMessage: row.commit_message || "",
        timestamp: row.timestamp,
        ...(row.forced ? { forced: true, forceReason: row.force_reason || "" } : {}),
        ...(row.dropped ? { dropped: true, dropReason: row.drop_reason || "" } : {}),
      }));

      // Urutan tabel menurun (terbaru dulu); memori memakai urutan naik.
      const merged = [...stored].reverse();
      const existingKeys = new Set(
        history.map((entry) => `${entry.timestamp}|${entry.taskDescription}`),
      );
      for (const entry of merged) {
        const key = `${entry.timestamp}|${entry.taskDescription}`;
        if (!existingKeys.has(key)) {
          history.push(entry);
          existingKeys.add(key);
        }
      }
      this.state.history = history;
      this._syncedHistoryCount = history.length;
      return merged.length;
    } catch (error) {
      safeLog("warn", `Riwayat tidak bisa dibaca dari database: ${error.message}`);
      this._syncedHistoryCount = history.length;
      return 0;
    }
  }

  /**
   * Mengirim salinan state ke dashboard, dengan antrean sebagai penampung.
   *
   * Antrean ini BUKAN jalur kedua. Dashboard tetap menerima data dari satu
   * tempat: `reportSnapshot`. Yang berubah: kalau pengiriman gagal - server mati,
   * laptop di luar jaringan - laporannya masuk antrean dan dicoba lagi pada
   * penyimpanan berikutnya. Sebelumnya laporan itu ditelan, dan dashboard tidak
   * pernah tahu ada langkah yang terlewat.
   *
   * Tidak pernah melempar: penyimpanan state sudah berhasil sebelum ini.
   */
  async _replicate(db, userId, projectPath, sessionKey) {
    try {
      const monitorPath = path.join(__dirname, "monitor.js");
      if (!existsSync(monitorPath)) return;
      const mod = await import(pathToFileURL(monitorPath).href);

      // Tanpa tujuan yang dikonfigurasi dan tanpa replika yang diinjeksi, tidak
      // ada gunanya mengisi antrean: tidak akan pernah ada yang mengurasnya.
      if (!this.replica && !mod.monitorUrl()) return;

      const snapshot = mod.buildSnapshot({
        state: this.state,
        sessionKey,
        projectPath: this.state.projectDir || "",
        sessionStartedAt: this.state.taskStartedAt || this.sessionStartedAt || "",
      });

      const { enqueue, drainSync } = await import("./db/replicate.js");
      await enqueue(db, "snapshot", `${userId}|${projectPath}|${sessionKey}`, JSON.stringify(snapshot));

      const replica = this.replica || {
        // `reportSnapshot` mengembalikan `false` saat gagal - termasuk saat
        // server menolak atau jaringannya putus - dan TIDAK melempar. Antrean
        // membaca "selesai tanpa error" sebagai terkirim, jadi `false` harus
        // diubah menjadi lemparan. Tanpa ini barisnya dihapus tanpa pernah
        // sampai, dan antreannya kosong padahal dashboard tidak menerima apa pun.
        push: async (row) => {
          const terkirim = await mod.reportSnapshot({ snapshot: JSON.parse(row.payload) });
          if (!terkirim) {
            throw new Error("dashboard tidak menerima laporan (tidak terjangkau atau menolak)");
          }
        },
      };

      await drainSync({ replica, budgetMs: 1200, adapter: db });
    } catch (error) {
      safeLog("warn", `Replika state gagal: ${error.message}`);
    }
  }

  /** Identitas penyimpanan sesi ini, dalam satu objek. */
  _storageIds() {
    return {
      userId: getCurrentUserId(this.stateFile),
      projectPath: this._projectPath(),
      sessionKey: this._sessionKey().key,
    };
  }

  /**
   * Identitas proyek yang dipakai baris database. Sama dengan yang dipakai migrasi.
   *
   * Dinormalkan supaya satu proyek tidak menjadi dua baris hanya karena ejaannya
   * berbeda (`D:\Code\Foo` vs `d:/code/foo`). Tanpa ini, `state_writer` dan
   * `workflow_state` bisa menunjuk proyek yang sama dengan dua ejaan.
   */
  _projectPath() {
    return normalizeProjectPath(resolveProjectRootForState(this.stateFile));
  }

  /**
   * Membentuk objek `reconciled` dari baris database, bukan dari berkas.
   *
   * Bentuknya sengaja dibuat sama dengan hasil `reconcileWithDisk` supaya
   * `detectStaleOverwrite`, `mergeMonotonicProgress`, dan `mergeDefinitionOfDone`
   * tetap bisa dipakai apa adanya - aturan penggabungannya masih benar, yang
   * berubah hanya sumber datanya.
   */
  _reconciledFrom(existing) {
    const state = existing?.state ?? null;
    return {
      diskState: state,
      diskTask: state?.taskDescription || "",
      diskPhase: state?.currentPhase || "idle",
      diskVersion: existing?.version ?? null,
      fromDatabase: true,
    };
  }

  /** Mengambil state pemenang setelah konflik. */
  _adoptState(otherState) {
    if (!otherState) return false;
    const ourHistory = Array.isArray(this.state.history) ? this.state.history : [];
    this.state = { ...otherState, history: ourHistory };
    this.loadedTask = this.state.taskDescription || "";
    return true;
  }

  /**
   * Menulis salinan JSON sebagai ekspor.
   *
   * Ini BUKAN sumber kebenaran lagi, dan kegagalan menulisnya tidak boleh
   * menggagalkan penyimpanan: tugasnya memudahkan pembacaan manual dan alat
   * lama, bukan menjaga data.
   */
  async _exportJson(options = {}) {
    try {
      return await this._withOwnershipFence("_exportJson", async () => {
        // Nama temp harus unik per PANGGILAN, bukan per proses. Dua export
        // bersamaan dalam satu proses dulu memakai nama yang sama, sehingga satu
        // rename menang dan yang lain gagal ENOENT - peringatan yang membuat
        // proses sehat terlihat rusak.
        const tmp = `${this.stateFile}.tmp-${process.pid}-${++this._exportSeq}`;
        await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));

        // Windows NTFS melempar EPERM bila file target sedang dikunci oleh rename/write
        // bersamaan dalam proses yang sama. Coba ulang beberapa kali dengan jeda singkat.
        let renamed = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            await fs.rename(tmp, this.stateFile);
            renamed = true;
            break;
          } catch (renameErr) {
            if ((renameErr.code === 'EPERM' || renameErr.code === 'EBUSY' || renameErr.code === 'EACCES') && attempt < 9) {
              await new Promise((res) => setTimeout(res, 10 * (attempt + 1)));
              continue;
            }
            throw renameErr;
          }
        }
        if (!renamed) {
          throw new Error('Rename failed after retries');
        }

        // Cermin ke lokasi kompatibilitas lama. Tetap dilakukan karena alat lama
        // membaca jalur itu; yang berubah hanya statusnya - sekarang salinan,
        // bukan sumber kebenaran.
        await ensureCompatibilityLinks(this.stateFile);
        return true;
      });
    } catch (error) {
      if (error instanceof ProjectOwnershipLostError || error?.code === "PROJECT_OWNERSHIP_LOST") {
        if (options.allowSkipIfForeignLock === true && !this.boundLockLease) {
          return false;
        }
        throw error;
      }
      safeLog("warn", `Ekspor JSON gagal ditulis (state tetap tersimpan di SQLite): ${error.message}`);
      return false;
    }
  }

  async updateProjectSummary(options = {}) {
    try {
      return await this._withOwnershipFence("updateProjectSummary", async () => {
        assertSafeKnowledge(this.state);
        const summaryPath = path.join(path.dirname(this.stateFile), PROJECT_SUMMARY_FILENAME);
        const summary = this.generateProjectSummaryData();
        assertSafeKnowledge(summary);
        await fs.mkdir(path.dirname(summaryPath), { recursive: true });
        await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
      });
    } catch (error) {
      if (
        (error instanceof ProjectOwnershipLostError || error?.code === "PROJECT_OWNERSHIP_LOST") &&
        options.allowSkipIfForeignLock === true &&
        !this.boundLockLease
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Menyalin history, ringkasan, dan state ke database.
   *
   * `db` dapat diinjeksi untuk pengujian; pemanggil biasa tidak mengirimnya.
   *
   * Satu entri yang gagal TIDAK boleh menghentikan sisanya. Dulu kegagalan
   * pertama (mis. entri lama tanpa `task_type`) membatalkan seluruh fungsi,
   * sehingga `updateSummaryForUser` dan `saveState` ikut terlewat dan riwayat
   * proyek diam-diam berhenti tersimpan sama sekali.
   */
  async syncToDatabase(options = {}) {
    return await this._withOwnershipFence("syncToDatabase", async () => {
      assertSafeKnowledge(this.state);
      const db = options.db ?? (await import("./db/index.js"));
      const userId = getCurrentUserId(this.stateFile);
      // projectRoot dipakai sebagai identitas proyek di database. Ditentukan
      // lewat resolveProjectRootForState, bukan dengan menghitung `dirname`
      // berkali-kali: jumlah itu hanya benar untuk satu kedalaman tertentu.
      const projectRoot = resolveProjectRootForState(this.stateFile);

      let skipped = 0;
      for (const entry of this.state.history || []) {
        try {
          await db.insertHistoryEntry(userId, projectRoot, entry);
        } catch (error) {
          skipped++;
          safeLog("error", "History entry skipped:", error.message);
        }
      }
      if (skipped > 0) {
        safeLog("error", `History sync skipped ${skipped} entr${skipped === 1 ? "y" : "ies"}.`);
      }

      try {
        await db.updateSummaryForUser(userId, projectRoot);
        await db.saveState(userId, projectRoot, this.state);
      } catch (error) {
        // Ringkasan dan state tetap opsional: jangan pernah menggagalkan save().
        safeLog("error", "Database sync failed:", error.message);
      }
    });
  }

  generateProjectSummaryData() {
    const history = this.state.history || [];
    if (!history || history.length === 0) {
      return {
        totalTasks: 0,
        taskTypes: {},
        lastActive: null,
        recentTasks: [],
        updatedAt: new Date().toISOString(),
      };
    }

    const taskTypes = {};
    const recentTasks = history.slice(-20);

    for (const entry of recentTasks) {
      const type = entry.taskType || "other";
      taskTypes[type] = (taskTypes[type] || 0) + 1;
    }

    const totalTasks = history.length;
    const lastTask = history[history.length - 1];
    const lastActive = lastTask ? lastTask.timestamp : null;

    return {
      totalTasks,
      taskTypes,
      lastActive,
      recentTasks: history.slice(-5).reverse().map((e) => ({
        description: e.taskDescription,
        type: e.taskType,
        timestamp: e.timestamp,
      })),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Reset ke keadaan idle.
   *
   * `archive` sengaja OPT-IN (default false). Pemanggil yang sudah menulis
   * `addToHistory` sendiri - complete_task, force_complete_task, drop_task -
   * akan menghasilkan entri ganda kalau reset ikut mengarsipkan.
   *
   * `start_task` memakai `{ archive: true }` supaya task yang sedang berjalan
   * tidak lenyap saat diganti task baru.
   */
  reset(options = {}) {
    const archive = options.archive === true;
    const previous = this.state || {};
    const history = Array.isArray(previous.history) ? previous.history.slice() : [];

    const hasRunningTask =
      typeof previous.taskDescription === "string" &&
      previous.taskDescription.trim() !== "" &&
      previous.currentPhase &&
      previous.currentPhase !== "idle";

    let archivedTask = null;
    if (archive && hasRunningTask) {
      archivedTask = previous.taskDescription;
      history.push({
        classification: previous.classification || "INTERNAL",
        ...buildTaskProvenance(previous),
        taskDescription: previous.taskDescription,
        taskType: previous.taskType || "other",
        commitMessage: previous.lastCommitMessage || "",
        interrupted: true,
        dropped: true,
        dropReason:
          options.reason || "Diganti start_task berikutnya sebelum task selesai",
        interruptedAtPhase: previous.currentPhase,
        timestamp: new Date().toISOString(),
      });
    }

    this.state = {
      currentPhase: "idle",
      classification: "INTERNAL",
      taskDescription: "",
      bugFixed: false,
      testsCreated: false,
      testsPassed: false,
      testsSkipped: false,
      testsSkippedReason: "",
      documentationCreated: false,
      // Bukti berkas untuk gerbang dokumentasi. `documentationCreated` hanya
      // berarti "agen mengaku sudah"; daftar ini berisi path yang benar-benar
      // berubah di working tree, atau waiver dengan alasan tertulis.
      documentationFiles: [],
      documentationWaived: false,
      documentationWaiverReason: "",
      readyToCommit: false,
      readyCheckCompleted: false,
      released: false,
      releaseSkipped: false,
      releaseSkippedReason: "",
      releaseCommand: "",
      releaseNotes: "",
      // Rekaman rilis yang benar-benar sampai ke produksi lewat CI/CD.
      // `released` hanya berarti "perintah rilis dijalankan"; ini menyimpan tag,
      // pipeline, dan site yang sudah menerimanya. Tanpa ini, upload langsung ke
      // server tidak meninggalkan jejak apa pun di MCP.
      deployment: null,
      commitAndPushCompleted: false,
      lastCommitMessage: "",
      lastPushBranch: "",
      // SHA yang benar-benar ter-push. Dipakai rekomendasi tindak lanjut untuk
      // membaca diff commit ini (TODO baru, jumlah berkas) tanpa menebak HEAD.
      lastCommitSha: "",
      // Mesin pemilik task ini. Dipakai checkpoint supaya mesin lain tahu siapa
      // yang memegang state hidup, dan supaya handoff bisa menyebut asal/tujuan.
      machine: "",
      // Rekaman checkpoint. `baseSha` diambil saat start_task sehingga daftar
      // commit milik sesi ini bisa dihitung tanpa menebak, dan `handover` dicatat
      // bila task diserahkan ke mesin lain.
      checkpoint: { checkpointedAt: null, summary: "", baseSha: null, commits: [], handover: null },
      // Repo proyek untuk sesi ini. Ditentukan saat start_task, dipakai semua
      // operasi git berikutnya. Kosong berarti ikuti urutan resolusi di exec.js.
      projectDir: "",
      featureFlowCreated: false,
      featureFlowDescription: "",
      // Definition of Done milik task ini. Aturan dan bentuk itemnya ada di
      // tools/handler-modules/dod.js; di sini hanya disimpan.
      definitionOfDone: [],
      dodSource: "",
      dodFactoryTaskId: "",
      // Naik setiap ada perubahan kerja baru setelah commit tercatat, sehingga
      // bukti item `done` yang lama otomatis tidak lagi berlaku.
      dodRevision: 0,
      // README-first preflight evidence: bounded discovery of README, AGENTS.md
      // and documented CLI entrypoints, recorded at start_task and revalidated
      // at resume_session. Null means the task predates the preflight.
      preflight: null,
      // Urutan kerja yang sedang dijalankan. Terpisah dari `definitionOfDone`:
      // DoD adalah syarat selesai, ini adalah rencana langkahnya. Rencana tidak
      // menjadi gerbang - ia hanya membuat progres bisa dibaca.
      plan: [],
      history,
      taskType: "",
      workflowTaskId: "",
      // Kartu sebelumnya dalam sesi ini, untuk rantai Zettelkasten.
      // Diisi start_task sebelum reset() menghapus identitas task lama.
      parentTask: null,
      zettly: null,
      zettlyOutbox: Array.isArray(previous.zettlyOutbox) ? previous.zettlyOutbox : [],
      taskOrigin: null,
      zettlyContext: null,
      focus: null,
      activeBuild: null,
      buildHistory: [],
      ...(previous.pendingProjectionRepair && typeof previous.pendingProjectionRepair === "object"
        ? { pendingProjectionRepair: previous.pendingProjectionRepair }
        : {}),
      ...(previous.pendingFocusCleanup && typeof previous.pendingFocusCleanup === "object"
        ? { pendingFocusCleanup: previous.pendingFocusCleanup }
        : {}),
      ...(previous.pendingHistorySummaryRepairKeys &&
      typeof previous.pendingHistorySummaryRepairKeys === "object" &&
      !Array.isArray(previous.pendingHistorySummaryRepairKeys) &&
      Object.keys(previous.pendingHistorySummaryRepairKeys).length > 0
        ? { pendingHistorySummaryRepairKeys: previous.pendingHistorySummaryRepairKeys }
        : {}),
    };

    return { archivedTask };
  }

  addToHistory(entry) {
    this.state.history.push({
      classification: this.state.classification || "INTERNAL",
      ...(this.state.workflowTaskId ? {workflowTaskId:this.state.workflowTaskId,zettlyTodoId:this.state.zettly?.todoId||null} : {}),
      ...buildTaskProvenance(this.state),
      ...entry,
      timestamp: new Date().toISOString(),
    });
  }
}
