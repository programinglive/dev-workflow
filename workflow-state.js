import { safeLog } from './security/sanitizer.js';
import fs from "fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync } from "fs";
import path from "path";
import { assertSafeKnowledge } from './security/policy.js';
import { sanitize } from './security/sanitizer.js';
import { normalizeItems as normalizeDodItems, mergeDefinitionOfDone as mergeDodItems } from './tools/handler-modules/dod.js';
import { resolveSessionKeyWithSource, sanitizeSessionKey, normalizeProjectPath } from './db/session-key.js';
import { StateUnavailable, StateConflict } from './db/errors.js';
import { normalizePlan } from './tools/handler-modules/plan.js';
import { fileURLToPath } from "url";
import { pathToFileURL } from "url";
import { createHash } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Satu laporan monitor berjalan dalam satu waktu; lihat reportToMonitorSafe. */
let monitorInFlight = false;
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

function resolveUserId(stateDir) {
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
      try {
        mkdirSync(stateDir, { recursive: true });
        const id = ensureUserIdFile(userIdFile, legacyId);
        cachedUserId = id;
        cachedUserStateDir = stateDir;
        return id;
      } catch {
        // Persisting the legacy ID is best-effort.
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
    try {
      mkdirSync(stateDir, { recursive: true });
      const id = ensureUserIdFile(userIdFile, "default");
      cachedUserId = id;
      cachedUserStateDir = stateDir;
      return id;
    } catch {
      // Best-effort persistence; continue with in-memory fallback.
    }
    cachedUserId = "default";
    cachedUserStateDir = stateDir;
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

function getUserScopedDir(baseDir) {
  const userId = resolveUserId(baseDir);
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
function getCurrentUserId(stateFile = null) {
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
      return resolveUserId(anchorDir);
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
export const SESSION_META_KEY = "ai.opencode/sessionID";

/** Mengambil identitas sesi dari request metadata MCP, atau null. */
export function sessionKeyFromRequest(request) {
  const value = request?.params?._meta?.[SESSION_META_KEY];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
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

export function resolveStateFile({ sessionId = null } = {}) {
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

    const userDir = getUserScopedDir(projectDir);
    const target = path.join(userDir, sessionStateFilename(process.env, sessionId));

    // Dua sumber lama, keduanya hanya menyalin state menganggur:
    //   1. berkas pin bersama (era pra-1.16.0)
    //   2. <proyek>/workflow-state.json (era 1.16.0, satu berkas per proyek)
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
  const userDir = getUserScopedDir(stateDir);
  return path.join(userDir, sessionStateFilename(process.env, sessionId));
}

function canonicalPath(candidate) {
  const resolved = path.resolve(candidate);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Nama subdirektori per proyek: nama folder yang masih terbaca manusia, plus
 * potongan hash supaya dua proyek bernama sama (mis. `clinic` di dua root)
 * tidak bertabrakan.
 */
function projectKey(projectRoot) {
  const resolved = canonicalPath(projectRoot);
  const nama = path.basename(resolved)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "proyek";
  const hash = createHash("sha1").update(resolved.toLowerCase()).digest("hex").slice(0, 10);
  return `${nama}-${hash}`;
}

/**
 * Direktori dasar (`<dasar>`) dari sebuah berkas state.
 *
 * Dicari lewat segmen `projects`, bukan dengan menghitung `dirname`: kedalaman
 * tata letak sudah berubah sekali dan akan berubah lagi.
 */
function resolveBaseDirFromState(stateFile) {
  const resolved = path.resolve(stateFile);
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
    return JSON.parse(readFileSync(sessionPointerPath(baseDir, sessionKey), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Catat proyek yang sedang dikerjakan sesi ini, dan kembalikan letak state
 * yang seharusnya.
 *
 * Dipanggil `start_task` setelah `projectDir` dipin. Tanpa ini, identitas
 * proyek hanya bisa ditebak dari `process.cwd()` - dan di mesin ini semua sesi
 * berjalan dari `Documents\Default Project`, sehingga sesi yang mengerjakan
 * repo berbeda berbagi satu direktori proyek: history tercampur, lock saling
 * menolak, dan rekomendasi satu proyek muncul di proyek lain.
 */
export function pinSessionProject({ stateFile, projectDir }) {
  const target = path.resolve(String(projectDir || ""));
  if (!target) {
    return null;
  }

  // Hanya untuk tata letak BER-PIN yang sudah berbentuk
  // `<dasar>/projects/<proyek>/users/<user>/`. Untuk path state eksplisit
  // (tes, CLI, skrip perbaikan) tidak ada tata letak seperti itu, dan
  // memindahkan berkasnya justru membuat pemanggil membaca berkas kosong.
  if (!path.resolve(stateFile).split(path.sep).includes(PROJECTS_DIR)) {
    return null;
  }

  const baseDir = resolveBaseDirFromState(stateFile);
  const sessionKey = sessionKeyFromStateFile(stateFile);
  const projectDirPath = path.join(baseDir, PROJECTS_DIR, projectKey(target));

  try {
    mkdirSync(path.join(baseDir, SESSIONS_DIR), { recursive: true });
    writeFileSync(
      sessionPointerPath(baseDir, sessionKey),
      JSON.stringify({ projectDir: target, projectDirPath, updatedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
  } catch {
    // Penunjuk gagal ditulis bukan alasan menggagalkan start_task: sesi tetap
    // berjalan, hanya identitas proyeknya kembali ke cwd.
  }

  return {
    projectDirPath,
    stateFile: path.join(getUserScopedDir(projectDirPath), sessionStateFilename(process.env, sessionKey)),
  };
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
    const snapshot = mod.buildSnapshot({
      state,
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
  constructor(stateFilePath = resolveStateFile(), options = {}) {
    this.stateFile = stateFilePath;
    // Dipakai tes untuk menyuntikkan kegagalan baca yang nyata (EBUSY/EACCES)
    // tanpa harus benar-benar mengunci berkas di sistem operasi.
    this.fs = options.fs || fs;
    // History milik proyek, state milik sesi. Dalam tata letak nyata keduanya
    // berkas berbeda; untuk path eksplisit keduanya menunjuk berkas yang sama.
    this.historyFile = resolveHistoryFile(stateFilePath);
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
    this.sessionId = options.sessionId || null;

    // Versi baris yang kita pegang. `null` berarti "belum pernah menyimpan".
    this.stateVersion = null;

    // Berapa entri riwayat yang SUDAH ada di tabel. Dipakai supaya penyimpanan
    // hanya mengirim entri baru, bukan meng-upsert seluruh riwayat setiap kali.
    this._syncedHistoryCount = 0;
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
      commitAndPushCompleted: false,
      lastCommitMessage: "",
      lastPushBranch: "",
      // SHA yang benar-benar ter-push. Dipakai rekomendasi tindak lanjut untuk
      // membaca diff commit ini (TODO baru, jumlah berkas) tanpa menebak HEAD.
      lastCommitSha: "",
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
      // Urutan kerja yang sedang dijalankan. Terpisah dari `definitionOfDone`:
      // DoD adalah syarat selesai, ini adalah rencana langkahnya. Rencana tidak
      // menjadi gerbang - ia hanya membuat progres bisa dibaca.
      plan: [],
      history: [],
      taskType: "",
      workflowTaskId: "",
      zettly: null,
      zettlyOutbox: [],
      activeBuild: null,
      buildHistory: [],
    };
  }

  /**
   * Berpindah ke state milik sesi tertentu.
   *
   * Satu proses MCP bisa melayani beberapa sesi bergantian, jadi state harus
   * ditentukan per panggilan - bukan sekali saat proses start. Mengembalikan
   * true bila berkas benar-benar berpindah.
   */
  async useSession(sessionId) {
    // Identitas sesi HARUS disimpan: kunci baris SQLite memakainya. Sebelumnya
    // `sessionId` hanya dipakai untuk memilih nama berkas, sehingga kunci state
    // jatuh ke environment - dan satu variabel environment membuat semua sesi
    // di proses ini berbagi satu baris.
    const explicit = typeof sessionId === "string" ? sessionId.trim() : "";
    const target = resolveStateFile({ sessionId });
    if (target === this.stateFile && explicit === this.sessionId) return false;

    this.sessionId = explicit || null;
    this.stateFile = target;
    this.historyFile = resolveHistoryFile(target);
    this.stateVersion = null;
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
      commitAndPushCompleted: false,
      lastCommitMessage: "",
      lastPushBranch: "",
      // SHA yang benar-benar ter-push. Dipakai rekomendasi tindak lanjut untuk
      // membaca diff commit ini (TODO baru, jumlah berkas) tanpa menebak HEAD.
      lastCommitSha: "",
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
      // Urutan kerja yang sedang dijalankan. Terpisah dari `definitionOfDone`:
      // DoD adalah syarat selesai, ini adalah rencana langkahnya. Rencana tidak
      // menjadi gerbang - ia hanya membuat progres bisa dibaca.
      plan: [],
      history: [],
      taskType: "",
    };
    await this.load();
    return true;
  }

  async load() {
    // Berkas bernama lama (`.workflow-state.json`) dipindahkan ke nama sekarang
    // SEBELUM apa pun dibaca. Tanpa ini, pengguna yang memutakhirkan dari versi
    // pra-1.16 akan tampak kehilangan seluruh state-nya.
    await migrateLegacyStateFile(this.stateFile);

    const db = await this._db();
    const { key: sessionKey } = this._sessionKey();
    const userId = getCurrentUserId(this.stateFile);
    const projectPath = this._projectPath();

    // Migrasi berkas JSON lama dijalankan SEKALI per database, bukan tiap load.
    await this._ensureMigrated(db, projectPath);

    const row = await db.loadStateVersioned({ userId, projectPath, sessionKey });
    this.stateVersion = row?.version ?? null;

    if (!row) {
      // Sesi ini belum punya baris. Bila berkas JSON-nya ada, adopsi sekali
      // supaya task yang sedang berjalan tidak hilang saat pemutakhiran.
      const adopted = await this._adoptLegacyJsonIfPresent(db, userId, projectPath, sessionKey);
      if (!adopted) {
        // Benar-benar sesi baru: state default dari constructor sudah tepat.
        // History proyek tetap dibaca supaya rekomendasi tidak buta.
        await this._hydrateHistoryFromDatabase(db, userId, projectPath);
        await this.mergeSharedHistory();
        this.loadedTask = "";
        // Ekspor awal supaya alat yang membaca JSON tidak menemui berkas hilang
        // hanya karena sesinya belum pernah menyimpan.
        await this._exportJson();
        try {
          await this.updateProjectSummary();
        } catch (error) {
          safeLog("warn", `Ringkasan proyek awal gagal ditulis: ${error.message}`);
        }
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
    await this.mergeSharedHistory();
    this.loadedTask = this.state.taskDescription || "";
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
  async mergeSharedHistory() {
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
    if (merged > 0) {
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
  }

  async ensurePrimaryFile() {
    assertSafeKnowledge(this.state);
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
    ensureCompatibilityLinks(this.stateFile).catch(() => { });

    return created;
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
    assertSafeKnowledge(this.state);

    const db = await this._db();
    const { key: sessionKey, source: keySource } = this._sessionKey();
    const userId = getCurrentUserId(this.stateFile);
    const projectPath = this._projectPath();

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
            owner: { processMarker: PROCESS_TOKEN, pid: process.pid, updatedAt: new Date().toISOString() },
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
    await this._exportJson();

    try {
      await this.writeHistoryFile();
      await this.updateProjectSummary();
    } catch (error) {
      safeLog("warn", `Riwayat/ringkasan gagal diperbarui: ${error.message}`);
    }

    // History milik PROYEK, jadi masuk tabel bersama - bukan hanya berkas.
    try {
      await this._syncHistoryToDatabase(db, userId, projectPath);
    } catch (error) {
      safeLog("warn", `Sinkronisasi history ke database gagal: ${error.message}`);
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
  async readDiskState() {
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
        const cadangan = await backupDamagedFile(this.stateFile, this.fs);
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
  async _adoptLegacyJsonIfPresent(db, userId, projectPath, sessionKey) {
    const hasil = await readJsonStateFile(this.stateFile, this.fs);

    if (hasil.status === "missing") return null;

    if (hasil.status === "corrupt") {
      const cadangan = await backupDamagedFile(this.stateFile, this.fs);
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

    try {
      await db.saveStateVersioned({ userId, projectPath, sessionKey, state, expectedVersion: null });
      safeLog("info", `State sesi "${sessionKey}" diadopsi dari berkas JSON ke SQLite.`);
      return state;
    } catch {
      // Ada penulis lain yang lebih dulu menyiapkan baris ini; biarkan ia menang.
      return null;
    }
  }

  /** Kunci sesi untuk baris state, beserta asalnya untuk dicatat. */
  _sessionKey() {
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
    // Penanda HARUS memuat proyek. Satu database bisa melayani beberapa proyek
    // (jalur database dicari lewat package.json terdekat), dan penanda global
    // membuat proyek pertama yang dimuat mematikan migrasi untuk semua proyek
    // lain - diam-diam, karena barisnya tetap tercatat "selesai".
    const marker = `legacy-json-v1:${projectPath}`;

    const done = db.db
      .prepare("SELECT name FROM migration_log WHERE name = ?")
      .get(marker);
    if (done) return null;

    const baseDir = path.join(projectPath, STATE_DIR);
    const { migrateLegacyJson } = await import("./db/migrate-legacy.js");
    const result = await migrateLegacyJson(db, { baseDir });

    safeLog(
      "info",
      `Migrasi JSON lama (${projectPath}): ${result.sessions} sesi masuk, ` +
        `${result.legacyFallback} cadangan, ${result.skipped} dilewati.`,
    );

    db.db
      .prepare("INSERT OR IGNORE INTO migration_log (name, applied_at) VALUES (?, datetime('now'))")
      .run(marker);

    return result;
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
  async _syncHistoryToDatabase(db, userId, projectPath) {
    if (typeof db.insertHistoryEntry !== "function") return { skipped: 0, sent: 0 };

    const history = Array.isArray(this.state.history) ? this.state.history : [];
    const from = Math.min(this._syncedHistoryCount || 0, history.length);
    let skipped = 0;
    let sent = 0;

    for (const entry of history.slice(from)) {
      try {
        await db.insertHistoryEntry(userId, projectPath, entry);
        sent += 1;
        this._syncedHistoryCount = from + sent;
      } catch (error) {
        skipped += 1;
        safeLog("warn", `Entri history dilewati: ${error.message}`);
      }
    }

    // Ringkasan hanya perlu dihitung ulang bila ada yang berubah.
    if (sent > 0) {
      try {
        await db.updateSummaryForUser(userId, projectPath);
      } catch (error) {
        safeLog("warn", `Ringkasan proyek gagal diperbarui: ${error.message}`);
      }
    }

    return { skipped, sent };
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
  async _exportJson() {
    try {
      const tmp = `${this.stateFile}.tmp-${process.pid}`;
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));
      await fs.rename(tmp, this.stateFile);

      // Cermin ke lokasi kompatibilitas lama. Tetap dilakukan karena alat lama
      // membaca jalur itu; yang berubah hanya statusnya - sekarang salinan,
      // bukan sumber kebenaran.
      await ensureCompatibilityLinks(this.stateFile);
      return true;
    } catch (error) {
      safeLog("warn", `Ekspor JSON gagal ditulis (state tetap tersimpan di SQLite): ${error.message}`);
      return false;
    }
  }

  async updateProjectSummary() {
    assertSafeKnowledge(this.state);
    const summaryPath = path.join(path.dirname(this.stateFile), PROJECT_SUMMARY_FILENAME);
    const summary = this.generateProjectSummaryData();
    assertSafeKnowledge(summary);
    await fs.mkdir(path.dirname(summaryPath), { recursive: true });
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
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
      commitAndPushCompleted: false,
      lastCommitMessage: "",
      lastPushBranch: "",
      // SHA yang benar-benar ter-push. Dipakai rekomendasi tindak lanjut untuk
      // membaca diff commit ini (TODO baru, jumlah berkas) tanpa menebak HEAD.
      lastCommitSha: "",
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
      activeBuild: null,
      buildHistory: [],
    };

    return { archivedTask };
  }

  addToHistory(entry) {
    this.state.history.push({
      classification: this.state.classification || "INTERNAL",
      ...(this.state.workflowTaskId ? {workflowTaskId:this.state.workflowTaskId,zettlyTodoId:this.state.zettly?.todoId||null} : {}),
      ...entry,
      timestamp: new Date().toISOString(),
    });
  }
}
