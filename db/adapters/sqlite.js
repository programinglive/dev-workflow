import { safeLog } from '../../security/sanitizer.js';
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import os from "os";
import path from "path";
import { DbAdapter, normalizeTaskType } from "./base.js";
import { assertSafeKnowledge, classify } from '../../security/policy.js';
import { ensureSchema } from "../schema.js";
import { normalizeProjectPath } from "../session-key.js";
import { StateConflict, StateUnavailable } from "../errors.js";

/**
 * Menentukan lokasi berkas database state.
 *
 * MENGAPA TIDAK LAGI MENCARI `package.json`
 * -----------------------------------------
 * Versi sebelumnya berjalan naik dari `INIT_CWD` mencari `package.json`, berhenti
 * di tempat pertama yang punya, lalu menaruh `.state/dev-workflow.db` di sana.
 * Diukur 2 November 2026: direktori kerja sesi ini (`Documents\Default Project`)
 * tidak punya `package.json`, akar drive juga tidak, sehingga pencarian berhenti
 * di `C:\` dan database dibuat di `C:\.state\dev-workflow.db`.
 *
 * Akibatnya berkas sumber kebenaran TIDAK ikut bila folder proyek disalin atau
 * di-backup, dan dokumentasi yang menyebut `<proyek>/.state/` menjadi bohong.
 *
 * Jangkar yang dipakai sekarang: direktori `.state` milik berkas state sesi itu
 * sendiri - tempat seluruh state lain sudah tinggal. Bila berkas state belum
 * diketahui, `.state` di bawah direktori kerja.
 *
 * `DEV_WORKFLOW_DB_PATH` tetap menang, karena tes dan CLI membutuhkannya.
 */
export function resolveDbPath({ stateFile = null, env = process.env, cwd = process.cwd() } = {}) {
  const override = typeof env?.DEV_WORKFLOW_DB_PATH === "string" ? env.DEV_WORKFLOW_DB_PATH.trim() : "";
  if (override) return override;

  const dbName = "dev-workflow.db";

  // 1. Dari berkas state: cari segmen `.state`, lalu taruh di dalamnya.
  if (typeof stateFile === "string" && stateFile.trim() !== "") {
    const resolved = path.resolve(stateFile);
    const parts = resolved.split(path.sep);

    const index = parts.lastIndexOf(".state");
    if (index > 0) {
      return path.join(parts.slice(0, index + 1).join(path.sep), dbName);
    }

    // Berkas state di luar tata letak `.state` (path eksplisit untuk tes/CLI).
    return path.join(path.dirname(resolved), dbName);
  }

  // 2. Tanpa berkas state: `.state` di bawah direktori kerja.
  const workDir = path.resolve(cwd || process.cwd());
  return path.join(workDir, ".state", dbName);
}

/**
 * Apakah proses ini bagian dari `node --test`.
 *
 * Dua jalur: proses anak membawa `NODE_TEST_CONTEXT`, sedangkan proses utama
 * membawa `--test` di argumennya.
 */
export function isTestProcess({ argv = process.argv, env = process.env } = {}) {
  if (env && env.NODE_TEST_CONTEXT) return true;
  return Array.isArray(argv) && argv.includes("--test");
}

/** Apakah berkas database berada di direktori sementara sistem. */
export function isTempDatabasePath(dbPath) {
  const value = typeof dbPath === "string" ? dbPath.trim() : "";
  if (value === "") return false;
  if (value === ":memory:") return true;

  const resolved = path.resolve(value).toLowerCase();
  const temp = path.resolve(os.tmpdir()).toLowerCase();
  return resolved === temp || resolved.startsWith(temp + path.sep);
}

/**
 * Kunci sesi untuk snapshot tingkat proyek.
 *
 * Bukan nama sesi sungguhan, dan sengaja tidak mungkin bertabrakan dengan
 * `ses_*`, `proc-*`, `pid-*`, atau `legacy-project`.
 */
const COMPAT_SESSION_KEY = "compat-project";

const DB_FILENAME = "dev-workflow.db";
const FREQUENCY_FORMATS = {
    daily: "%Y-%m-%d",
    monthly: "%Y-%m",
    yearly: "%Y",
};

export class SqliteAdapter extends DbAdapter {
    constructor(config = {}) {
        super(config);
        this.db = null;
    }

    getDbPath() {
        // Jalur eksplisit menang (tes, CLI, atau DEV_WORKFLOW_DB_PATH).
        if (this.config.dbPath) {
            return this.config.dbPath;
        }

        // Selain itu, jangkar ke `.state` milik berkas state sesi ini. Tidak
        // pernah ke akar drive: lihat resolveDbPath.
        return resolveDbPath({ stateFile: this.config.stateFile });
    }

    async connect() {
        if (!this.db) {
            const dbPath = this.getDbPath();

            // Penjaga isolasi tes. Database ini adalah SUMBER KEBENARAN state
            // workflow; menjalankan tes yang menulis ke sini berarti mencampur
            // sesi palsu dengan pekerjaan sungguhan, dan pada 2 November 2026
            // itu benar-benar terjadi (2.544 baris riwayat uji di database
            // produksi). Ditangkap SEBELUM berkas dibuka, supaya tidak ada
            // setengah tulisan yang terlanjur masuk.
            if (isTestProcess() && !isTempDatabasePath(dbPath)) {
                throw new StateUnavailable(
                    `Menolak membuka database state di "${dbPath}" dari proses tes. ` +
                        `Tes harus memakai direktori sementara agar tidak menulis ke state sungguhan. ` +
                        `Jalankan dengan '--import ./tests/setup-env.js', atau setel ` +
                        `DEV_WORKFLOW_DB_PATH ke path di dalam tmp.`
                );
            }

            if (this.config.readOnly === true) {
                if (!existsSync(dbPath)) {
                    return null;
                }
                try {
                    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
                } catch (error) {
                    throw new StateUnavailable(
                        `State storage cannot be opened read-only at "${dbPath}": ${error.message}.`,
                        { cause: error },
                    );
                }
                this.db.pragma("busy_timeout = 5000");
                return this.db;
            }

            try {
                // Direktori induk belum tentu ada: pada clone bersih, `.state/`
                // belum pernah dibuat. Tanpa ini SQLite melempar
                // "Cannot open database because the directory does not exist" -
                // hijau di mesin penulis, merah di tempat lain.
                mkdirSync(path.dirname(dbPath), { recursive: true });
                this.db = new Database(dbPath);
            } catch (error) {
                throw new StateUnavailable(
                    `Penyimpanan state tidak bisa dibuka di "${dbPath}": ${error.message}. ` +
                        `Perbaiki izin atau ruang disk sebelum melanjutkan - menulis ke tempat lain ` +
                        `akan membuat pekerjaan sesi ini tidak bisa ditemukan lagi.`,
                    { cause: error },
                );
            }

            // `busy_timeout` penting karena dua proses MCP bisa membuka berkas
            // yang sama. Tanpa ini SQLite langsung melempar SQLITE_BUSY alih-alih
            // menunggu kunci lepas, dan penyimpanan yang seharusnya berhasil
            // gagal hanya karena berpapasan beberapa milidetik.
            this.db.pragma("busy_timeout = 5000");
            this.db.pragma("journal_mode = WAL");
            await this.migrate();
        }
        return this.db;
    }

    /** Menutup koneksi. Dipakai tes dan proses yang berumur pendek. */
    async close() {
        if (this.db) {
            try { this.db.close(); } catch { /* sudah tertutup */ }
            this.db = null;
        }
    }

    /**
     * Menyimpan state sesi dengan pemeriksaan versi.
     *
     * `expectedVersion === null` berarti "baris ini seharusnya belum ada".
     * Selain itu, tulisan hanya diterima bila versi di disk masih sama - kalau
     * tidak, ada penulis lain yang lebih dulu dan pemanggil harus membaca ulang.
     * Ini yang mengubah "yang terakhir menang" menjadi "yang basi ditolak".
     */
    async saveStateVersioned({ userId, projectPath, sessionKey, state, expectedVersion = null }) {
        await this.connect();
        const normalizedPath = normalizeProjectPath(projectPath);
        const json = JSON.stringify(state);

        return this.db.transaction(() => {
            if (expectedVersion === null) {
                const info = this.db
                    .prepare(
                        `INSERT INTO workflow_state (user_id, project_path, session_key, state_json, version, updated_at)
                         VALUES (?, ?, ?, ?, 1, datetime('now'))
                         ON CONFLICT(user_id, project_path, session_key) DO NOTHING`,
                    )
                    .run(userId, normalizedPath, sessionKey, json);

                if (info.changes === 0) {
                    const current = this.db
                        .prepare(
                            "SELECT version FROM workflow_state WHERE user_id = ? AND project_path = ? AND session_key = ?",
                        )
                        .get(userId, normalizedPath, sessionKey);
                    throw new StateConflict(
                        `State untuk sesi "${sessionKey}" sudah ada di versi ${current?.version ?? "?"}.`,
                        { sessionKey, expectedVersion: null, actualVersion: current?.version ?? null },
                    );
                }
                return { version: 1 };
            }

            const info = this.db
                .prepare(
                    `UPDATE workflow_state
                        SET state_json = ?, version = version + 1, updated_at = datetime('now')
                      WHERE user_id = ? AND project_path = ? AND session_key = ? AND version = ?`,
                )
                .run(json, userId, normalizedPath, sessionKey, expectedVersion);

            if (info.changes === 0) {
                const current = this.db
                    .prepare(
                        "SELECT version FROM workflow_state WHERE user_id = ? AND project_path = ? AND session_key = ?",
                    )
                    .get(userId, normalizedPath, sessionKey);
                throw new StateConflict(
                    `State sesi "${sessionKey}" sudah berubah (versi di disk ${current?.version ?? "tidak ada"}, ` +
                        `kita memegang ${expectedVersion}). Muat ulang state sebelum melanjutkan.`,
                    { sessionKey, expectedVersion, actualVersion: current?.version ?? null },
                );
            }

            return { version: expectedVersion + 1 };
        })();
    }

    /**
     * Membaca state satu sesi.
     *
     * Mengembalikan `null` bila barisnya belum ada - itu keadaan normal sesi
     * baru, bukan kegagalan. Isi yang rusak TIDAK dikembalikan sebagai `null`:
     * "gagal membaca" tidak pernah berarti "kosong".
     */
    async loadStateVersioned({ userId, projectPath, sessionKey }) {
        await this.connect();
        const normalizedPath = normalizeProjectPath(projectPath);

        const row = this.db
            .prepare(
                "SELECT state_json, version FROM workflow_state WHERE user_id = ? AND project_path = ? AND session_key = ?",
            )
            .get(userId, normalizedPath, sessionKey);

        if (!row) return null;

        try {
            return { state: JSON.parse(row.state_json), version: row.version };
        } catch (error) {
            throw new StateUnavailable(
                `State sesi "${sessionKey}" tersimpan tetapi isinya rusak dan tidak bisa dibaca. ` +
                    `Penyimpanan ini sengaja TIDAK diganti dengan state kosong, karena itu membuat ` +
                    `task yang sedang berjalan hilang tanpa jejak.`,
                { cause: error },
            );
        }
    }

    async migrate() {
        // 1. Create tables if they don't exist (new installs get the correct schema immediately)
        const createHistory = `
      CREATE TABLE IF NOT EXISTS workflow_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        project_path TEXT DEFAULT '',
        task_description TEXT NOT NULL,
        task_type TEXT NOT NULL,
        commit_message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        forced INTEGER DEFAULT 0,
        force_reason TEXT,
        dropped INTEGER DEFAULT 0,
        drop_reason TEXT,
        UNIQUE(user_id, project_path, timestamp, task_description)
      )
    `;
        // Note: project_summary definition
        const createSummary = `
      CREATE TABLE IF NOT EXISTS project_summary (
        user_id TEXT,
        project_path TEXT DEFAULT '',
        total_tasks INTEGER DEFAULT 0,
        task_types TEXT DEFAULT '{}',
        last_active DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        recent_tasks TEXT DEFAULT '[]',
        PRIMARY KEY (user_id, project_path)
      )
    `;
        this.db.exec(createHistory);
        if(!this.db.prepare('PRAGMA table_info(workflow_history)').all().some(col=>col.name==='classification')) {
            this.db.exec("ALTER TABLE workflow_history ADD COLUMN classification TEXT NOT NULL DEFAULT 'INTERNAL'");
        }

        // 2. MIGRATION: Handle existing databases (workflow_history)
        try {
            const tableInfo = this.db.prepare("PRAGMA table_info(workflow_history)").all();
            if (!tableInfo.some(col => col.name === 'project_path')) {
                // Add column to existing table
                this.db.exec("ALTER TABLE workflow_history ADD COLUMN project_path TEXT DEFAULT ''");

                // Re-create index to include new column
                this.db.exec("DROP INDEX IF EXISTS idx_workflow_history_user");
                // We need to fix the UNIQUE constraint if possible, but SQLite ALTER TABLE limitations make that hard.
                // For now, ensuring the column exists allows the new INSERT logic (inserting '') to work.
                // Duplicate entries from old schema (with no project_path) effectively mean project_path='' which matches new default.
            }
        } catch (e) {
            safeLog('error', "Migration error (workflow_history):", e.message);
        }

        // 3. MIGRATION: Handle project_summary (Drop and Recreate if schema mismatch)
        // Since it's a cache and we're changing the Primary Key, it's safer/easier to just drop it.
        let recreateSummary = false;
        try {
            const summaryInfo = this.db.prepare("PRAGMA table_info(project_summary)").all();
            // If table exists but missing project_path, drop it
            if (summaryInfo.length > 0 && !summaryInfo.some(col => col.name === 'project_path')) {
                this.db.exec("DROP TABLE IF EXISTS project_summary");
                recreateSummary = true;
            }
        } catch (e) {
            // Ignore
        }

        this.db.exec(createSummary); // Will create if we dropped it or if it didn't exist

        // 4. Create Indexes (Safe now that columns exist)
        const idxHistory = `CREATE INDEX IF NOT EXISTS idx_workflow_history_user_project ON workflow_history(user_id, project_path)`;
        const idxSummary = `CREATE INDEX IF NOT EXISTS idx_project_summary_user_project ON project_summary(user_id, project_path)`;

        // START FIX: Create explicit UNIQUE index to support ON CONFLICT clause for migrated tables
        // The original table constraint was UNIQUE(user_id, timestamp, task_description).
        // The new Insert statement relies on UNIQUE(user_id, project_path, timestamp, task_description).
        // We must ensure this index exists for ON CONFLICT to work.
        const idxUnique = `CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_history_entry_v2 ON workflow_history(user_id, project_path, timestamp, task_description)`;
        // END FIX

        this.db.exec(idxHistory);
        this.db.exec(idxSummary);
        this.db.exec(idxUnique);

        // Skema v1 ada di `db/schema.js` supaya migrasi bisa diuji tanpa
        // membuka koneksi. Dijalankan SESUDAH migrasi lama di atas, karena
        // `CREATE TABLE IF NOT EXISTS` tidak akan menambah kolom `classification`
        // pada tabel yang sudah terlanjur ada - itulah tugas ALTER di atas.
        ensureSchema(this.db);
    }

    async insertHistoryEntry(userId, projectPath, entry) {
        await this.connect();
        const normalizedProjectPath = normalizeProjectPath(projectPath);

        // Timestamp: pakai jam SQLite, bukan jam proses.
        //
        // MASALAH NYATA: jam mesin yang meleset membuat sebuah entri tampak
        // "besok", sehingga urutannya kacau terhadap baris yang ditulis proses
        // lain dengan jam benar - dan rekap per hari menghitungnya di hari yang
        // salah. `entry.timestamp` tetap dihormati bila pemanggil memang
        // memberikannya (mis. memulihkan riwayat lama).
        const timestamp = entry.timestamp || null;
        const sqlTimestamp = "COALESCE(?, datetime('now'))";

        const stmt = this.db.prepare(`
      INSERT INTO workflow_history
      (user_id, project_path, task_description, task_type, commit_message, timestamp, forced, force_reason, dropped, drop_reason, classification)
      VALUES (?, ?, ?, ?, ?, ${sqlTimestamp}, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, project_path, timestamp, task_description) DO UPDATE SET
        commit_message=excluded.commit_message,
        forced=excluded.forced,
        force_reason=excluded.force_reason,
        dropped=excluded.dropped,
        drop_reason=excluded.drop_reason, classification=excluded.classification
    `);

        stmt.run(
            userId,
            normalizedProjectPath,
            entry.taskDescription,
            normalizeTaskType(entry.taskType),
            entry.commitMessage,
            timestamp,
            entry.forced ? 1 : 0,
            entry.forceReason || null,
            entry.dropped ? 1 : 0,
            entry.dropReason || null,
            classify(entry)
        );

        await this.updateSummaryForUser(userId, normalizedProjectPath);
    }

    async updateSummaryForUser(userId, projectPath) {
        await this.connect();
        const normalizedProjectPath = normalizeProjectPath(projectPath);

        const getHistory = this.db.prepare(`
      SELECT classification, task_type, timestamp, task_description
      FROM workflow_history
      WHERE user_id = ? AND project_path = ?
      ORDER BY timestamp DESC
      LIMIT 20
    `);
        const rows = getHistory.all(userId, normalizedProjectPath);

        const taskTypes = {};
        for (const row of rows) {
            taskTypes[row.task_type] = (taskTypes[row.task_type] || 0) + 1;
        }

        assertSafeKnowledge(rows);
        const recentTasks = rows.slice(0, 5).map(r => ({
            classification: r.classification,
            description: r.task_description,
            type: r.task_type,
            timestamp: r.timestamp,
        }));

        const lastActive = rows[0]?.timestamp || null;

        const upsert = this.db.prepare(`
      INSERT INTO project_summary
      (user_id, project_path, total_tasks, task_types, last_active, recent_tasks, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, project_path) DO UPDATE SET
        total_tasks=excluded.total_tasks,
        task_types=excluded.task_types,
        last_active=excluded.last_active,
        recent_tasks=excluded.recent_tasks,
        updated_at=excluded.updated_at
    `);

        upsert.run(
            userId,
            normalizedProjectPath,
            rows.length,
            JSON.stringify(taskTypes),
            lastActive,
            JSON.stringify(recentTasks),
            new Date().toISOString()
        );
    }

    async getSummaryForUser(userId, projectPath) {
        await this.connect();
        const normalizedProjectPath = normalizeProjectPath(projectPath);

        const stmt = this.db.prepare(`
      SELECT * FROM project_summary WHERE user_id = ? AND project_path = ?
    `);
        const row = stmt.get(userId, normalizedProjectPath);

        if (!row) return null;
        return {
            totalTasks: row.total_tasks,
            taskTypes: JSON.parse(row.task_types),
            lastActive: row.last_active,
            recentTasks: JSON.parse(row.recent_tasks),
            updatedAt: row.updated_at,
        };
    }

    buildHistoryFilters({ startDate, endDate }) {
        const clauses = [];
        const params = [];
        if (startDate) {
            clauses.push("DATE(timestamp) >= DATE(?)");
            params.push(startDate);
        }
        if (endDate) {
            clauses.push("DATE(timestamp) <= DATE(?)");
            params.push(endDate);
        }
        return { clauses, params };
    }

    async getHistoryForUser(userId, projectPath, options = {}) {
        await this.connect();
        const normalizedProjectPath = normalizeProjectPath(projectPath);

        const { page = 1, pageSize = 20, startDate, endDate } = options;
        const sanitizedPage = Math.max(1, Number.isFinite(Number(page)) ? Math.floor(Number(page)) : 1);
        const sanitizedPageSize = Math.min(100, Math.max(1, Number.isFinite(Number(pageSize)) ? Math.floor(Number(pageSize)) : 20));
        const offset = (sanitizedPage - 1) * sanitizedPageSize;

        const { clauses, params } = this.buildHistoryFilters({ startDate, endDate });
        const where = ["user_id = ?", "project_path = ?", ...clauses].join(" AND ");

        const countStmt = this.db.prepare(`SELECT COUNT(*) as total FROM workflow_history WHERE ${where}`);
        const total = countStmt.get(userId, normalizedProjectPath, ...params).total;

        const rowsStmt = this.db.prepare(`
      SELECT *
      FROM workflow_history
      WHERE ${where}
      ORDER BY timestamp DESC
      LIMIT ?
      OFFSET ?
    `);
        const entries = rowsStmt.all(userId, normalizedProjectPath, ...params, sanitizedPageSize, offset);

        return {
            entries,
            total,
            page: sanitizedPage,
            pageSize: sanitizedPageSize,
        };
    }

    async getHistorySummary(userId, projectPath, options = {}) {
        await this.connect();
        const normalizedProjectPath = normalizeProjectPath(projectPath);

        const { startDate, endDate, frequency = "daily" } = options;
        const format = FREQUENCY_FORMATS[frequency] || FREQUENCY_FORMATS.daily;
        const { clauses, params } = this.buildHistoryFilters({ startDate, endDate });
        const where = ["user_id = ?", "project_path = ?", ...clauses].join(" AND ");

        const stmt = this.db.prepare(`
      SELECT strftime('${format}', timestamp) AS period, COUNT(*) AS count
      FROM workflow_history
      WHERE ${where}
      GROUP BY period
      ORDER BY period DESC
    `);

        return stmt
            .all(userId, normalizedProjectPath, ...params)
            .map((row) => ({ period: row.period, count: row.count }));
    }

    /**
     * Snapshot state tingkat PROYEK, bukan tingkat sesi.
     *
     * Dipertahankan untuk pemanggil lama dan untuk tes adaptor. Nilainya
     * ditulis ke kunci sesi khusus `compat-project`, supaya ia tidak pernah
     * bertabrakan dengan state hidup milik sesi sungguhan - dulu baris ini yang
     * dipakai bergantian oleh semua sesi, dan itu bug yang sedang diperbaiki.
     */
    /**
     * Berapa proses BERBEDA menulis sesi ini dalam 60 detik terakhir.
     *
     * `state_writer` hanya menyimpan satu baris per sesi, jadi dua proses yang
     * bergantian menulis tidak terlihat di sana. Riwayat penulis inilah yang
     * membuat pertikaian bisa dideteksi - dan dilaporkan, bukan ditebak.
     */
    contenders(userId, projectPath, sessionKey, windowSeconds = 60) {
        const normalizedPath = normalizeProjectPath(projectPath);
        const row = this.db
            .prepare(
                `SELECT count(DISTINCT process_token) AS c FROM state_writer_history
                  WHERE user_id = ? AND project_path = ? AND session_key = ?
                    AND written_at > datetime('now', '-' || ? || ' seconds')`,
            )
            .get(userId, normalizedPath, sessionKey, Math.max(1, Math.trunc(windowSeconds)));
        return row?.c ?? 0;
    }

    /**
     * Membuang riwayat penulis yang lebih tua dari `days`.
     *
     * Tabel ini tumbuh satu baris setiap `save()`. Tanpa retensi, pada sesi yang
     * panjang ia menjadi tabel terbesar di database - padahal isinya hanya
     * dipakai untuk jendela 60 detik.
     */
    pruneWriterHistory({ days = 7 } = {}) {
        const umur = Math.max(1, Math.trunc(days));
        const info = this.db
            .prepare(
                `DELETE FROM state_writer_history
                  WHERE written_at < datetime('now', '-' || ? || ' days')`,
            )
            .run(umur);
        return info.changes;
    }

    /**
     * State sisa yang tersimpan tetapi tidak bisa dijangkau sesi mana pun.
     *
     * Dua bentuk: `legacy-project` (cadangan untuk proyek yang berkas JSON-nya
     * sudah hilang) dan baris `pid-*` dari era sebelum kunci sesi berubah. Kedua
     * duanya data pengguna yang masih berharga, jadi ditampilkan - bukan
     * dibiarkan tidak terlihat.
     */
    findOrphanStates(userId, projectPath) {
        const normalizedPath = normalizeProjectPath(projectPath);
        const rows = this.db
            .prepare(
                `SELECT session_key, state_json, updated_at FROM workflow_state
                  WHERE user_id = ? AND project_path = ?
                    AND (session_key = 'legacy-project' OR session_key LIKE 'pid-%')
                  ORDER BY updated_at DESC`,
            )
            .all(userId, normalizedPath);

        const hasil = [];
        for (const row of rows) {
            try {
                const state = JSON.parse(row.state_json);
                hasil.push({
                  sessionKey: row.session_key,
                  taskDescription: state?.taskDescription || "",
                  phase: state?.currentPhase || "idle",
                  updatedAt: row.updated_at,
                });
            } catch {
                // Baris rusak tidak boleh menyembunyikan baris lain.
                hasil.push({ sessionKey: row.session_key, taskDescription: "", phase: "rusak", updatedAt: row.updated_at });
            }
        }
        return hasil;
    }

    async saveState(userId, projectPath, state) {
        await this.connect();
        const normalizedProjectPath = normalizeProjectPath(projectPath);

        this.db.prepare(`
      INSERT INTO workflow_state (user_id, project_path, session_key, state_json, version, updated_at)
      VALUES (?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(user_id, project_path, session_key) DO UPDATE SET
        state_json = excluded.state_json,
        version = workflow_state.version + 1,
        updated_at = datetime('now')
    `).run(userId, normalizedProjectPath, COMPAT_SESSION_KEY, JSON.stringify(state));
    }

    async getState(userId, projectPath) {
        await this.connect();
        const normalizedProjectPath = normalizeProjectPath(projectPath);

        const row = this.db.prepare(`
      SELECT state_json FROM workflow_state
       WHERE user_id = ? AND project_path = ? AND session_key = ?
    `).get(userId, normalizedProjectPath, COMPAT_SESSION_KEY);

        if (!row) return null;
        try {
            return JSON.parse(row.state_json);
        } catch {
            return null;
        }
    }
}
