import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

import { SqliteAdapter } from "../db/adapters/sqlite.js";
import { MysqlAdapter } from "../db/adapters/mysql.js";
import { PostgresAdapter } from "../db/adapters/postgres.js";

/**
 * Apakah server database di URL ini benar-benar bisa dihubungi?
 *
 * MENGAPA ADA
 * -----------
 * Tes ini dulu hanya memeriksa apakah variabel lingkungan berisi URL. Di mesin
 * yang punya `DEV_WORKFLOW_DB_URL=mysql://...` di `.env` tapi MySQL-nya tidak
 * jalan, tes langsung gagal dengan `ECONNREFUSED 127.0.0.1:3306` - dan `npm test`
 * jadi merah karena satu service lokal mati, bukan karena kode rusak. Angka
 * merah yang salah itu berbahaya: ia melatih orang mengabaikan hasil tes.
 *
 * Yang dilakukan sekarang: coba sambung ke host:port dengan timeout pendek.
 * Tidak bisa? Tes DILEWATI dengan alasan yang tercetak, bukan dinyatakan lulus.
 * Kalau service-nya hidup, tesnya tetap berjalan dan tetap bisa gagal.
 */
async function canConnect(connectionUrl, timeoutMs = 1500) {
    if (!connectionUrl) return false;

    let host;
    let port;
    try {
        const parsed = new URL(connectionUrl);
        host = parsed.hostname || "127.0.0.1";
        port = Number(parsed.port) || (parsed.protocol.startsWith("postgres") ? 5432 : 3306);
    } catch {
        return false;
    }

    return new Promise((resolve) => {
        const socket = new net.Socket();
        const finish = (reachable) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(reachable);
        };

        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
        socket.connect(port, host);
    });
}

async function probe(connectionUrl, label) {
    if (!connectionUrl) {
        return { reachable: false, reason: `${label} dilewati: URL koneksi tidak diatur` };
    }

    let target = "host tidak terbaca";
    try {
        const parsed = new URL(connectionUrl);
        const port = Number(parsed.port) || (parsed.protocol.startsWith("postgres") ? 5432 : 3306);
        target = `${parsed.hostname || "127.0.0.1"}:${port}`;
    } catch {
        // URL rusak: biarkan tes berjalan supaya kegagalannya jujur dan terbaca.
        return { reachable: true, reason: "" };
    }

    const reachable = await canConnect(connectionUrl);
    return {
        reachable,
        reason: reachable
            ? ""
            : `${label} dilewati: tidak ada server di ${target}. Jalankan service-nya untuk menguji adapter ini.`,
    };
}


// Helper to run common adapter tests
async function runGenericAdapterTests(t, adapter, testUserId, testProject) {
    await t.test("connects and migrates", async () => {
        await adapter.connect();
        // No error means success
    });

    await t.test("inserts and retrieves history", async () => {
        const entry = {
            taskDescription: "Test Task",
            taskType: "feature",
            commitMessage: "feat: test",
            timestamp: new Date().toISOString(),
        };
        await adapter.insertHistoryEntry(testUserId, testProject, entry);

        const history = await adapter.getHistoryForUser(testUserId, testProject, { pageSize: 1 });
        assert.equal(history.entries.length, 1);
        assert.equal(history.entries[0].task_description, "Test Task");
    });

    await t.test("saves and retrieves state", async () => {
        const state = { phase: "testing", count: 123 };
        await adapter.saveState(testUserId, testProject, state);
        const retrieved = await adapter.getState(testUserId, testProject);
        assert.deepEqual(retrieved, state);
    });

    await t.test("history summary aggregation", async () => {
        // already inserted one entry
        const summary = await adapter.getHistorySummary(testUserId, testProject, { frequency: 'daily' });
        assert.ok(summary.length > 0);
    });

    await t.test("project summary update", async () => {
        const summary = await adapter.getSummaryForUser(testUserId, testProject);
        assert.ok(summary);
        assert.ok(summary.totalTasks >= 1);
    });
}

test("Database Adapters", async (t) => {
    // 1. SQLite (Always Test)
    await t.test("SqliteAdapter", async (t) => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-test-"));
        const dbPath = path.join(tmpDir, "test.db");

        // `dbPath`, bukan `connectionUrl`: SqliteAdapter hanya membaca
        // `config.dbPath`. Versi lama mengirim connectionUrl yang diabaikan,
        // sehingga tes ini diam-diam menulis ke `.state/dev-workflow.db` milik
        // repo - dan gagal di clone bersih yang belum punya folder itu.
        const adapter = new SqliteAdapter({ dbPath });

        try {
            await runGenericAdapterTests(t, adapter, "user-sqlite", tmpDir);
        } finally {
            if (adapter.db) adapter.db.close();
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    });

    // 2. MySQL (Conditional)
    // Check specific test variable OR generic one if it maps to mysql
    const mysqlUrl = process.env.TEST_MYSQL_URL ||
        (process.env.DEV_WORKFLOW_DB_URL && process.env.DEV_WORKFLOW_DB_URL.startsWith("mysql") ? process.env.DEV_WORKFLOW_DB_URL : null);
    const mysqlProbe = await probe(mysqlUrl, "MysqlAdapter");

    await t.test("MysqlAdapter", { skip: mysqlProbe.reachable ? false : mysqlProbe.reason }, async (t) => {
        const adapter = new MysqlAdapter({ connectionUrl: mysqlUrl });
        try {
            // We use a random user ID to avoid clashing with verification script data
            // although verification cleaned up mostly.
            const testId = `test-mysql-${Date.now()}`;
            const testProj = process.cwd();
            await runGenericAdapterTests(t, adapter, testId, testProj);
        } finally {
            if (adapter.pool) await adapter.pool.end();
        }
    });

    // 3. PostgreSQL (Conditional)
    const pgUrl = process.env.TEST_POSTGRES_URL ||
        (process.env.DEV_WORKFLOW_DB_URL && process.env.DEV_WORKFLOW_DB_URL.startsWith("postgres") ? process.env.DEV_WORKFLOW_DB_URL : null);
    const pgProbe = await probe(pgUrl, "PostgresAdapter");

    await t.test("PostgresAdapter", { skip: pgProbe.reachable ? false : pgProbe.reason }, async (t) => {
        const adapter = new PostgresAdapter({ connectionUrl: pgUrl });
        try {
            const testId = `test-pg-${Date.now()}`;
            const testProj = process.cwd();
            await runGenericAdapterTests(t, adapter, testId, testProj);
        } finally {
            if (adapter.pool) await adapter.pool.end();
        }
    });
});

/**
 * SQLite selalu diuji, jadi ia tidak boleh bergantung pada keadaan mesin.
 *
 * Dua cacat nyata yang ditemukan 31 Okt 2026 saat menjalankan `npm test` di
 * clone bersih (worktree tanpa folder `.state`):
 *
 *   1. `connect()` membuka DB di `<projectRoot>/.state/` tanpa membuat
 *      direktorinya lebih dulu. Di repo utama ini lolos hanya karena `.state/`
 *      kebetulan sudah ada - jadi hijau di mesin penulis, merah di clone baru.
 *   2. Tes lama mengirim `connectionUrl`, padahal `SqliteAdapter` hanya membaca
 *      `config.dbPath`. Artinya tes itu menulis ke DB `.state` repo yang
 *      sebenarnya, bukan ke direktori sementara yang ia siapkan.
 */
test("SqliteAdapter membuat direktori induk DB bila belum ada", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-mkdir-"));
    const nested = path.join(tmpDir, "belum", "ada", "sama-sekali");
    const adapter = new SqliteAdapter({ dbPath: path.join(nested, "test.db") });

    try {
        await adapter.connect();
        assert.ok(
            (await fs.stat(path.join(nested, "test.db"))).isFile(),
            "berkas DB harus terbentuk di direktori yang tadinya tidak ada",
        );
    } finally {
        if (adapter.db) adapter.db.close();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

test("SqliteAdapter memakai dbPath dari konfigurasi, bukan .state repo", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-path-"));
    const wanted = path.join(tmpDir, "pilihan-tes.db");
    const adapter = new SqliteAdapter({ dbPath: wanted });

    try {
        assert.equal(adapter.getDbPath(), wanted);
        assert.ok(
            !adapter.getDbPath().includes(`${path.sep}.state${path.sep}`),
            "tes tidak boleh menyentuh .state milik repo",
        );
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});
