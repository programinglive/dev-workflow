/**
 * Skema penyimpanan state, satu tempat.
 *
 * Dipisah dari adapter supaya migrasi bisa diuji tanpa membuka koneksi ke
 * database sungguhan, dan supaya tidak ada dua salinan DDL yang bisa berbeda.
 *
 * KUNCI DESAIN
 * ------------
 * `workflow_state` dikunci `(user_id, project_path, session_key)`. Kunci inilah
 * yang membuat tabrakan antar sesi mustahil: dua sesi tidak pernah menunjuk
 * baris yang sama. Kolom `version` menjadi lapis kedua untuk kasus dua proses
 * memakai kunci yang sama - di sana tulisan kedua ditolak, bukan ditimpa.
 *
 * MENGAPA TABEL LAMA DIARSIPKAN
 * -----------------------------
 * Versi sebelum ini punya `workflow_state` berkunci `(user_id, project_path)`.
 * `CREATE TABLE IF NOT EXISTS` tidak bisa mengubah kunci tabel yang sudah ada,
 * jadi tabel itu harus diganti. Isinya TIDAK dibuang: baris lama adalah state
 * PENULIS TERAKHIR untuk sebuah proyek, bukan state sesi mana pun, sehingga ia
 * dipindahkan ke `workflow_state_legacy` dan hanya dipakai sebagai cadangan bila
 * berkas JSON sebuah proyek sudah hilang.
 */

export const SCHEMA_VERSION = 1;

/** Tabel yang bentuknya tidak berubah oleh migrasi ini. */
const DDL_BASE = [
  `CREATE TABLE IF NOT EXISTS workflow_state_legacy (
     user_id      TEXT NOT NULL,
     project_path TEXT NOT NULL,
     state_json   TEXT NOT NULL,
     updated_at   TEXT,
     archived_at  TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS state_writer_history (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id       TEXT NOT NULL,
     project_path  TEXT NOT NULL,
     session_key   TEXT NOT NULL,
     process_token TEXT NOT NULL,
     written_at    TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS state_writer (
     user_id       TEXT NOT NULL,
     project_path  TEXT NOT NULL,
     session_key   TEXT NOT NULL,
     pid           INTEGER NOT NULL,
     process_token TEXT NOT NULL,
     key_source    TEXT NOT NULL,
     last_write_at TEXT NOT NULL,
     PRIMARY KEY (user_id, project_path, session_key)
   )`,

  `CREATE TABLE IF NOT EXISTS sync_queue (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     kind            TEXT NOT NULL,
     dedupe_key      TEXT NOT NULL,
     payload         TEXT NOT NULL,
     attempts        INTEGER NOT NULL DEFAULT 0,
     last_error      TEXT,
     next_attempt_at TEXT,
     created_at      TEXT NOT NULL,
     UNIQUE (kind, dedupe_key)
   )`,

  `CREATE TABLE IF NOT EXISTS schema_version (
     version    INTEGER PRIMARY KEY,
     applied_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS migration_log (
     name       TEXT PRIMARY KEY,
     applied_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS workflow_history (
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
     classification TEXT NOT NULL DEFAULT 'INTERNAL',
     UNIQUE(user_id, project_path, timestamp, task_description)
   )`,

  `CREATE TABLE IF NOT EXISTS project_summary (
     user_id TEXT,
     project_path TEXT DEFAULT '',
     total_tasks INTEGER DEFAULT 0,
     task_types TEXT DEFAULT '{}',
     last_active DATETIME,
     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     recent_tasks TEXT DEFAULT '[]',
     PRIMARY KEY (user_id, project_path)
   )`,
];

const DDL_STATE = `CREATE TABLE IF NOT EXISTS workflow_state (
   user_id      TEXT NOT NULL,
   project_path TEXT NOT NULL,
   session_key  TEXT NOT NULL,
   state_json   TEXT NOT NULL,
   version      INTEGER NOT NULL DEFAULT 0,
   updated_at   TEXT NOT NULL,
   PRIMARY KEY (user_id, project_path, session_key)
 )`;

const DDL_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_workflow_history_user_project ON workflow_history(user_id, project_path)`,
  `CREATE INDEX IF NOT EXISTS idx_project_summary_user_project ON project_summary(user_id, project_path)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_history_entry_v2 ON workflow_history(user_id, project_path, timestamp, task_description)`,
  `CREATE INDEX IF NOT EXISTS idx_sync_queue_due ON sync_queue(next_attempt_at)`,
];

function tableExists(db, name) {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

/**
 * Memindahkan isi `workflow_state` bentuk lama ke `workflow_state_legacy`
 * lalu mengganti tabelnya dengan bentuk baru.
 *
 * Idempoten: bila tabel sudah berbentuk baru (punya `session_key`), tidak ada
 * yang dikerjakan. Bila tabel belum ada sama sekali, juga tidak ada.
 */
export function archiveLegacyState(db) {
  if (!tableExists(db, "workflow_state")) return { archived: 0 };

  const columns = columnNames(db, "workflow_state");
  if (columns.includes("session_key")) return { archived: 0 };

  db.exec(DDL_BASE[0]);

  const count = db.prepare("SELECT count(*) AS c FROM workflow_state").get().c;

  if (count > 0) {
    db.prepare(
      `INSERT INTO workflow_state_legacy (user_id, project_path, state_json, updated_at, archived_at)
       SELECT user_id, project_path, state_json, updated_at, datetime('now') FROM workflow_state`,
    ).run();
  }

  db.exec("DROP TABLE workflow_state");
  db.exec(DDL_STATE);

  return { archived: count };
}

/**
 * Membuat seluruh tabel yang dibutuhkan dan menandai versi skema.
 *
 * Idempoten: `CREATE ... IF NOT EXISTS`, dan `schema_version` hanya ditulis bila
 * belum ada. Pemanggilan kedua tidak menghapus atau menggandakan apa pun.
 */
export function ensureSchema(db) {
  for (const statement of DDL_BASE) db.exec(statement);

  const archived = archiveLegacyState(db);

  db.exec(DDL_STATE);
  for (const statement of DDL_INDEXES) db.exec(statement);

  const existing = db
    .prepare("SELECT version FROM schema_version WHERE version = ?")
    .get(SCHEMA_VERSION);

  if (!existing) {
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (?, datetime('now'))",
    ).run(SCHEMA_VERSION);
  }

  return { version: SCHEMA_VERSION, archived: archived.archived };
}