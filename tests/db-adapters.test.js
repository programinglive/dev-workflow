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
 * Is the database server at this URL actually reachable?
 *
 * WHY THIS EXISTS
 * ---------------
 * This test used to check only whether the environment variable held a URL. On
 * a machine where `.env` has `DEV_WORKFLOW_DB_URL=mysql://...` but MySQL is not
 * running, the test failed with `ECONNREFUSED 127.0.0.1:3306` - and `npm test`
 * turned red because one local service was down, not because the code was
 * broken. A false red is dangerous: it trains people to ignore test results.
 *
 * What it does now: attempt to connect to host:port with a short timeout.
 * Cannot connect? The test is SKIPPED with a printed reason, not reported as a
 * pass. If the service is up, the test still runs and can still fail.
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
        return { reachable: false, reason: `${label} skipped: connection URL is not configured` };
    }

    let target = "unreadable host";
    try {
        const parsed = new URL(connectionUrl);
        const port = Number(parsed.port) || (parsed.protocol.startsWith("postgres") ? 5432 : 3306);
        target = `${parsed.hostname || "127.0.0.1"}:${port}`;
    } catch {
        // Broken URL: let the test run so the failure is honest and readable.
        return { reachable: true, reason: "" };
    }

    const reachable = await canConnect(connectionUrl);
    return {
        reachable,
        reason: reachable
            ? ""
            : `${label} skipped: no server at ${target}. Start the service to test this adapter.`,
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

        // `dbPath`, not `connectionUrl`: SqliteAdapter only reads
        // `config.dbPath`. The old version passed connectionUrl, which was
        // ignored, so this test silently wrote to the repo's
        // `.state/dev-workflow.db` - and failed in a clean clone that did not
        // have that folder yet.
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
 * SQLite is always tested, so it must not depend on the state of the machine.
 *
 * Two real defects found on 31 Oct 2026 while running `npm test` in a clean
 * clone (a worktree without a `.state` folder):
 *
 *   1. `connect()` opened the DB at `<projectRoot>/.state/` without creating
 *      the directory first. In the main repo this passed only because `.state/`
 *      happened to exist - green on the author's machine, red in a new clone.
 *   2. The old test passed `connectionUrl`, while `SqliteAdapter` only reads
 *      `config.dbPath`. That meant the test wrote to the repo's real `.state`
 *      DB, not to the temporary directory it had prepared.
 */
test("SqliteAdapter creates the DB parent directory when it is missing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-mkdir-"));
    const nested = path.join(tmpDir, "not", "yet", "created");
    const adapter = new SqliteAdapter({ dbPath: path.join(nested, "test.db") });

    try {
        await adapter.connect();
        assert.ok(
            (await fs.stat(path.join(nested, "test.db"))).isFile(),
            "the DB file must be created in a directory that did not exist before",
        );
    } finally {
        if (adapter.db) adapter.db.close();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

test("SqliteAdapter uses the configured dbPath, not the repo .state", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-path-"));
    const wanted = path.join(tmpDir, "test-choice.db");
    const adapter = new SqliteAdapter({ dbPath: wanted });

    try {
        assert.equal(adapter.getDbPath(), wanted);
        assert.ok(
            !adapter.getDbPath().includes(`${path.sep}.state${path.sep}`),
            "the test must not touch the repo's .state",
        );
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});
