/**
 * Migrasi dari tata letak berkas JSON ke SQLite.
 *
 * Tata letak lama menyimpan state per sesi di dalam direktori proyek:
 *
 *   <root>/.state/projects/<kunci-proyek>/users/<user>/workflow-state.<sesi>.json
 *   <root>/.state/users/<user>/workflow-state.<sesi>.json          (lebih lama)
 *
 * MENGAPA JSON YANG MENANG, BUKAN BARIS DATABASE
 * ----------------------------------------------
 * `save()` lama menulis berkas JSON lebih dulu, lalu menyalinnya ke tabel
 * `workflow_state`. Bila penyalinan sempat gagal, isi tabel justru LEBIH TUA
 * daripada berkasnya. Dan tabel itu berkunci per proyek, sehingga isinya milik
 * sesi mana pun yang menulis terakhir. Berkas JSON satu-satunya sumber yang
 * benar per sesi.
 *
 * Berkas lama TIDAK dihapus: dipindah ke `.state/legacy-json/<stempel>/` supaya
 * masih bisa dibandingkan bila ada yang janggal.
 */

import { readdir, readFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { safeLog } from "../security/sanitizer.js";
import { sanitizeSessionKey, normalizeProjectPath } from "./session-key.js";

const STATE_FILE_PREFIX = "workflow-state.";
const LEGACY_FALLBACK_KEY = "legacy-project";

/**
 * Menghitung path proyek yang dipakai baris database.
 *
 * Sama persis dengan `resolveProjectRootForState` di `workflow-state.js`:
 * direktori INDUK dari `.state`. Dipakai di sini supaya baris hasil migrasi
 * benar-benar cocok dengan baris yang nanti ditulis `save()`; kalau berbeda,
 * semua hasil migrasi menjadi yatim dan tidak pernah terbaca.
 */
function projectPathFor(baseDir) {
  return normalizeProjectPath(path.dirname(path.resolve(baseDir)));
}

/** Mengambil kunci sesi dari nama berkas `workflow-state.<kunci>.json`. */
function sessionKeyFromFilename(filename) {
  if (!filename.startsWith(STATE_FILE_PREFIX) || !filename.endsWith(".json")) return null;
  const middle = filename.slice(STATE_FILE_PREFIX.length, -".json".length);
  if (middle === "") return null;
  return sanitizeSessionKey(middle);
}

async function readDirSafe(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Mengumpulkan semua berkas state lama sebagai { userId, sessionKey, filePath }.
 *
 * Dua tata letak dibaca sekaligus: `projects/<proyek>/users/<user>/` (sejak
 * 1.17) dan `users/<user>/` (sebelumnya). Keduanya memakai aturan nama berkas
 * yang sama.
 */
async function collectLegacyStateFiles(baseDir) {
  const found = [];

  const projectsRoot = path.join(baseDir, "projects");
  for (const projectEntry of await readDirSafe(projectsRoot)) {
    if (!projectEntry.isDirectory()) continue;

    const usersRoot = path.join(projectsRoot, projectEntry.name, "users");
    for (const userEntry of await readDirSafe(usersRoot)) {
      if (!userEntry.isDirectory()) continue;
      const userDir = path.join(usersRoot, userEntry.name);

      for (const file of await readDirSafe(userDir)) {
        if (!file.isFile()) continue;
        const sessionKey = sessionKeyFromFilename(file.name);
        if (!sessionKey) continue;
        found.push({ userId: userEntry.name, sessionKey, filePath: path.join(userDir, file.name) });
      }
    }
  }

  const legacyUsersRoot = path.join(baseDir, "users");
  for (const userEntry of await readDirSafe(legacyUsersRoot)) {
    if (!userEntry.isDirectory()) continue;
    const userDir = path.join(legacyUsersRoot, userEntry.name);

    for (const file of await readDirSafe(userDir)) {
      if (!file.isFile()) continue;
      const sessionKey = sessionKeyFromFilename(file.name);
      if (!sessionKey) continue;
      found.push({ userId: userEntry.name, sessionKey, filePath: path.join(userDir, file.name) });
    }
  }

  return found;
}

function insertStateRow(adapter, { userId, projectPath, sessionKey, state, keySource }) {
  return adapter.db
    .prepare(
      `INSERT OR IGNORE INTO workflow_state
         (user_id, project_path, session_key, state_json, version, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'))`,
    )
    .run(userId, projectPath, sessionKey, JSON.stringify(state));
}

function recordWriter(adapter, { userId, projectPath, sessionKey, keySource }) {
  adapter.db
    .prepare(
      `INSERT INTO state_writer (user_id, project_path, session_key, pid, process_token, key_source, last_write_at)
       VALUES (?, ?, ?, 0, 'migration', ?, datetime('now'))
       ON CONFLICT(user_id, project_path, session_key) DO UPDATE SET
         key_source = excluded.key_source,
         last_write_at = excluded.last_write_at`,
    )
    .run(userId, projectPath, sessionKey, keySource);
}

/**
 * Menjalankan migrasi.
 *
 * Idempoten: `INSERT OR IGNORE` pada kunci yang sama, dan pemindahan berkas
 * hanya terjadi sekali. Pemanggilan kedua melaporkan nol sesi baru.
 *
 * Berkas yang rusak DILEWATI dan dilaporkan, bukan menggagalkan seluruh migrasi:
 * satu berkas rusak tidak boleh membuat ratusan task lain tidak bisa dibaca.
 * Sebaliknya, kegagalan MENGHITUNG ulang tetap menggagalkan migrasi - lihat
 * pemanggil di `workflow-state.js`.
 */
export async function migrateLegacyJson(adapter, { baseDir } = {}) {
  if (!baseDir) throw new Error("baseDir wajib diisi untuk migrasi JSON lama.");

  const projectPath = projectPathFor(baseDir);
  const files = await collectLegacyStateFiles(baseDir);

  const result = { sessions: 0, skipped: 0, legacyFallback: 0, movedTo: "" };
  const parsed = [];

  for (const file of files) {
    try {
      const raw = await readFile(file.filePath, "utf-8");
      const state = JSON.parse(raw);
      parsed.push({ ...file, state });
    } catch (error) {
      result.skipped += 1;
      safeLog("warn", `Migrasi melewati berkas rusak "${file.filePath}": ${error.message}`);
    }
  }

  // Tulis semuanya dalam satu transaksi: kalau gagal di tengah, tidak ada
  // setengah migrasi yang tertinggal dan dianggap selesai.
  adapter.db.transaction(() => {
    for (const entry of parsed) {
      const info = insertStateRow(adapter, {
        userId: entry.userId,
        projectPath,
        sessionKey: entry.sessionKey,
        state: entry.state,
      });
      if (info.changes === 1) result.sessions += 1;
      recordWriter(adapter, {
        userId: entry.userId,
        projectPath,
        sessionKey: entry.sessionKey,
        keySource: "legacy-file",
      });
    }

    // Cadangan untuk pengguna yang berhak atas baris lama tetapi tidak punya
    // satu pun berkas JSON. Tanpa ini, state mereka hilang sama sekali.
    const candidates = adapter.db
      .prepare(
        `SELECT user_id, state_json FROM workflow_state_legacy l
          WHERE project_path = ?
            AND updated_at = (SELECT max(updated_at) FROM workflow_state_legacy
                               WHERE user_id = l.user_id AND project_path = l.project_path)
            AND user_id NOT IN (
              SELECT user_id FROM workflow_state
               WHERE project_path = ? AND session_key <> ?
            )`,
      )
      .all(projectPath, projectPath, LEGACY_FALLBACK_KEY);

    for (const row of candidates) {
      let state;
      try {
        state = JSON.parse(row.state_json);
      } catch {
        result.skipped += 1;
        continue;
      }
      const info = insertStateRow(adapter, {
        userId: row.user_id,
        projectPath,
        sessionKey: LEGACY_FALLBACK_KEY,
        state,
      });
      if (info.changes === 1) result.legacyFallback += 1;
      recordWriter(adapter, {
        userId: row.user_id,
        projectPath,
        sessionKey: LEGACY_FALLBACK_KEY,
        keySource: "legacy-db",
      });
    }
  })();

  // Berkas lama dipindah setelah data dipastikan masuk. Kalau pemindahan gagal,
  // data sudah aman di database dan berkasnya tinggal di tempatnya.
  if (parsed.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const targetRoot = path.join(baseDir, "legacy-json", stamp);

    for (const entry of parsed) {
      try {
        const projectSegment = path
          .relative(baseDir, entry.filePath)
          .replace(/[\\/]/g, "_");
        const targetPath = path.join(targetRoot, projectSegment);
        await mkdir(path.dirname(targetPath), { recursive: true });
        await rename(entry.filePath, targetPath);
        result.movedTo = targetRoot;
      } catch (error) {
        safeLog("warn", `Gagal memindahkan berkas lama "${entry.filePath}": ${error.message}`);
      }
    }
  }

  return result;
}

export { LEGACY_FALLBACK_KEY };