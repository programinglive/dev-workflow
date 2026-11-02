import { SqliteAdapter } from "./adapters/sqlite.js";
import { MysqlAdapter } from "./adapters/mysql.js";
import { PostgresAdapter } from "./adapters/postgres.js";
import { databaseConnectionUrl } from '../security/config.js';

let adapterInstance = null;

export async function getAdapter() {
  if (adapterInstance) {
    return adapterInstance;
  }

  const type = (process.env.DEV_WORKFLOW_DB_TYPE || "sqlite").toLowerCase();
  const config = {
    connectionUrl: databaseConnectionUrl(),
    dbPath: process.env.DEV_WORKFLOW_DB_PATH // optional override for sqlite
  };

  switch (type) {
    case "mysql":
      adapterInstance = new MysqlAdapter(config);
      break;
    case "postgres":
    case "postgresql":
      adapterInstance = new PostgresAdapter(config);
      break;
    case "sqlite":
    default:
      adapterInstance = new SqliteAdapter(config);
      break;
  }

  await adapterInstance.connect();
  return adapterInstance;
}

// Proxies for backward compatibility (though call sites need to handle Promises now)

export async function insertHistoryEntry(userId, projectPath, entry) {
  const db = await getAdapter();
  await db.insertHistoryEntry(userId, projectPath, entry);
}

export async function updateSummaryForUser(userId, projectPath) {
  const db = await getAdapter();
  await db.updateSummaryForUser(userId, projectPath);
}

export async function getSummaryForUser(userId, projectPath) {
  const db = await getAdapter();
  return await db.getSummaryForUser(userId, projectPath);
}

export async function getHistoryForUser(userId, projectPath, options) {
  const db = await getAdapter();
  return await db.getHistoryForUser(userId, projectPath, options);
}

export async function getHistorySummary(userId, projectPath, options) {
  const db = await getAdapter();
  return await db.getHistorySummary(userId, projectPath, options);
}

export async function saveState(userId, projectPath, state) {
  const db = await getAdapter();
  await db.saveState(userId, projectPath, state);
}

/**
 * Menyimpan state hidup satu sesi, dengan pemeriksaan versi.
 *
 * Berbeda dari `saveState` di atas yang berkunci `(user, proyek)` dan karena itu
 * dipakai bergantian oleh semua sesi pada proyek yang sama.
 */
export async function saveStateVersioned(input) {
  const db = await getAdapter();
  return db.saveStateVersioned(input);
}

/**
 * Membaca state hidup satu sesi.
 *
 * `null` berarti sesi ini belum pernah menyimpan - keadaan normal sesi baru.
 * Isi rusak melempar `StateUnavailable`, bukan mengembalikan `null`.
 */
export async function loadStateVersioned(input) {
  const db = await getAdapter();
  return db.loadStateVersioned(input);
}

/** Menitipkan satu perubahan ke antrean replika. Lihat db/replicate.js. */
export async function enqueueSync(kind, dedupeKey, payload) {
  const { enqueue } = await import("./replicate.js");
  const db = await getAdapter();
  return enqueue(db, kind, dedupeKey, payload);
}

/** Mengirim isi antrean replika sebentar saja. Tidak pernah melempar. */
export async function drainSync(options = {}) {
  const { drainSync: drain } = await import("./replicate.js");
  return drain(options);
}

/** Jumlah dan umur baris yang belum terkirim ke replika. */
export async function queueDepth() {
  const { queueDepth: depth } = await import("./replicate.js");
  return depth();
}

export async function getState(userId, projectPath) {
  const db = await getAdapter();
  return await db.getState(userId, projectPath);
}


