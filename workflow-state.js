import { safeLog } from './security/sanitizer.js';
import fs from "fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import path from "path";
import { assertSafeKnowledge } from './security/policy.js';
import { sanitize } from './security/sanitizer.js';
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_DIR = ".state";
const STATE_FILENAME = "workflow-state.json";
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
    // Ignore read errors; we'll generate a new ID below.
  }

  const usersDir = path.join(stateDir, "users");

  try {
    const entries = readdirSync(usersDir, { withFileTypes: true });
    const candidateDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    if (candidateDirs.length === 1) {
      const legacyId = candidateDirs[0];
      try {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(userIdFile, legacyId, "utf-8");
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
      writeFileSync(userIdFile, "default", "utf-8");
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
    writeFileSync(userIdFile, generatedId, "utf-8");
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

function getCurrentUserId() {
  const envUserId = (process.env.DEV_WORKFLOW_USER_ID || "").trim();
  if (envUserId) {
    return envUserId;
  }

  if (cachedUserId) {
    return cachedUserId;
  }

  if (cachedUserStateDir) {
    return resolveUserId(cachedUserStateDir);
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
  const migrated = migrateOwnerMetadata(JSON.parse(await fs.readFile(legacyPath, 'utf8')));
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
  const resolvedPrimary = path.resolve(primaryPath);

  if (!(await pathExists(resolvedPrimary))) {
    return;
  }
  assertSafeKnowledge(JSON.parse(await fs.readFile(resolvedPrimary, 'utf8')));

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

export function resolveSessionKey(env = process.env, explicitSessionId = null) {
  const fromRequest = typeof explicitSessionId === "string" ? explicitSessionId.trim() : "";
  if (fromRequest) return sanitizeSessionKey(fromRequest);

  for (const candidate of [env.DEV_WORKFLOW_SESSION_ID, env.OPENCODE_SESSION_ID, env.CLIENT_SESSION_ID]) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (value) return sanitizeSessionKey(value);
  }
  return `pid-${process.pid}`;
}

function sanitizeSessionKey(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "session").slice(0, 64);
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
  if (customPath) {
    return path.resolve(customPath);
  }

  const moduleRoot = path.resolve(__dirname, "..");
  const cwdResolved = path.resolve(process.cwd());
  const initCwd = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : null;

  // 1. Prefer the project rooted at the current working directory
  let projectRoot = findProjectRoot(cwdResolved);

  // 2. Fall back to the project rooted at INIT_CWD if different
  if (!projectRoot && initCwd) {
    projectRoot = findProjectRoot(initCwd);
  }

  // 3. Fall back to the project containing this module
  if (!projectRoot) {
    projectRoot = findProjectRoot(moduleRoot);
  }

  // 4. Final fallback: use a non-root working directory or the module root
  if (!projectRoot) {
    projectRoot = !isRootPath(cwdResolved) ? cwdResolved : moduleRoot;
  }

  const stateDir = path.join(projectRoot, STATE_DIR);
  const userDir = getUserScopedDir(stateDir);
  return path.join(userDir, sessionStateFilename(process.env, sessionId));
}

export class WorkflowState {
  constructor(stateFilePath = resolveStateFile()) {
    this.stateFile = stateFilePath;
    // History milik proyek, state milik sesi. Dalam tata letak nyata keduanya
    // berkas berbeda; untuk path eksplisit keduanya menunjuk berkas yang sama.
    this.historyFile = resolveHistoryFile(stateFilePath);
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
      featureFlowCreated: false,
      featureFlowDescription: "",
      history: [],
      taskType: "",
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
    const target = resolveStateFile({ sessionId });
    if (target === this.stateFile) return false;

    this.stateFile = target;
    this.historyFile = resolveHistoryFile(target);
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
      featureFlowCreated: false,
      featureFlowDescription: "",
      history: [],
      taskType: "",
    };
    await this.load();
    return true;
  }

  async load() {
    await migrateLegacyStateFile(this.stateFile);
    try {
      const data = await fs.readFile(this.stateFile, "utf-8");
      const parsed = sanitize(migrateOwnerMetadata(JSON.parse(data)));
      this.state = {
        ...this.state,
        ...parsed,
      };
      // Ensure compatibility mirrors exist whenever the primary file is present
      // Run this as non-blocking to speed up startup
      ensureCompatibilityLinks(this.stateFile).catch(() => { });
      await this.mergeSharedHistory();
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
      if (typeof this.state.featureFlowCreated !== "boolean") {
        this.state.featureFlowCreated = false;
      }
      if (typeof this.state.featureFlowDescription !== "string") {
        this.state.featureFlowDescription = "";
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      // Missing file is fine; bootstrap fresh artifacts for downstream consumers.
      await this.ensurePrimaryFile();
      // Sesi baru tetap harus melihat riwayat proyek yang sudah ada.
      await this.mergeSharedHistory();
    }
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

    const shared = await this.readHistoryFile();
    const merged = this.mergeDiskHistory(shared);
    if (merged > 0) {
      await this.writeHistoryFile();
    }
    return merged;
  }

  async readHistoryFile() {
    try {
      const data = await fs.readFile(this.historyFile, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /** Menulis hanya `history` ke berkas bersama, tanpa task milik sesi ini. */
  async writeHistoryFile() {
    if (this.historyFile === this.stateFile) {
      return;
    }

    const shared = (await this.readHistoryFile()) || {};
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

  async save() {
    assertSafeKnowledge(this.state);
    const reconciled = await this.reconcileWithDisk();
    assertSafeKnowledge(this.state);
    this.state.owner = {
      processMarker: PROCESS_TOKEN,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(this.stateFile, JSON.stringify(this.state, null, 2));
    // History ditulis ke berkas bersama supaya sesi lain melihat task yang
    // selesai di sini, sementara task yang sedang berjalan tetap milik sesi.
    await this.writeHistoryFile();
    await ensureCompatibilityLinks(this.stateFile);
    await this.updateProjectSummary();
    await this.syncToDatabase();
    this.lastReconcile = reconciled;
    return reconciled;
  }

  /**
   * Baca isi berkas state APA ADANYA dari disk (bukan dari memori).
   * Mengembalikan null kalau belum ada / rusak.
   */
  async readDiskState() {
    try {
      const data = await fs.readFile(this.stateFile, "utf-8");
      return sanitize(migrateOwnerMetadata(JSON.parse(data)));
    } catch {
      return null;
    }
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
    const result = { mergedHistory: 0, preservedTask: null, foreignToken: null };
    const disk = await this.readDiskState();
    if (!disk) {
      return result;
    }

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

  async updateProjectSummary() {
    assertSafeKnowledge(this.state);
    const summaryPath = path.join(path.dirname(this.stateFile), PROJECT_SUMMARY_FILENAME);
    const summary = this.generateProjectSummaryData();
    assertSafeKnowledge(summary);
    await fs.mkdir(path.dirname(summaryPath), { recursive: true });
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  }

  async syncToDatabase() {
    assertSafeKnowledge(this.state);
    try {
      const { insertHistoryEntry, updateSummaryForUser, saveState } = await import("./db/index.js");
      const userId = getCurrentUserId();
      // projectRoot dipakai sebagai identitas proyek di database. Ditentukan
      // lewat resolveProjectRootForState, bukan dengan menghitung `dirname`
      // berkali-kali: jumlah itu hanya benar untuk satu kedalaman tertentu.
      const projectRoot = resolveProjectRootForState(this.stateFile);

      for (const entry of this.state.history || []) {
        await insertHistoryEntry(userId, projectRoot, entry);
      }
      await updateSummaryForUser(userId, projectRoot);
      await saveState(userId, projectRoot, this.state);
    } catch (error) {
      // Database sync failed; log it but don't crash
      safeLog('error', "Database sync failed:", error.message);
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
      featureFlowCreated: false,
      featureFlowDescription: "",
      history,
      taskType: "",
    };

    return { archivedTask };
  }

  addToHistory(entry) {
    this.state.history.push({
      classification: this.state.classification || "INTERNAL",
      ...entry,
      timestamp: new Date().toISOString(),
    });
  }
}
