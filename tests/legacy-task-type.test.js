import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

import { SqliteAdapter } from "../db/adapters/sqlite.js";

async function makeAdapter(t) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-tasktype-"));
    const adapter = new SqliteAdapter({ dbPath: path.join(tmpDir, "test.db") });
    await adapter.connect();
    t.after(async () => {
        try {
            adapter.db?.close();
        } catch {
            // already closed
        }
        await fs.rm(tmpDir, { recursive: true, force: true });
    });
    return adapter;
}

test("legacy history entries without taskType do not abort the database sync", async (t) => {
    const adapter = await makeAdapter(t);
    const user = "legacy-user";
    const project = "/legacy/project";

    // Entries written by older versions: `dropped` markers carry no taskType at
    // all, and some forced entries carry an empty string. Both used to reach the
    // adapter as `undefined`, which better-sqlite3 binds as NULL and SQLite
    // rejects with `NOT NULL constraint failed: workflow_history.task_type`.
    await t.test("accepts an entry with no taskType", async () => {
        await adapter.insertHistoryEntry(user, project, {
            taskDescription: "",
            commitMessage: "",
            dropped: true,
            dropReason: "Beralih ke Fase 1-3 arsip activity_log",
            timestamp: "2026-10-26T08:16:48.014Z",
        });
    });

    await t.test("accepts an entry with a null taskType", async () => {
        await adapter.insertHistoryEntry(user, project, {
            taskDescription: "forced entry",
            taskType: null,
            commitMessage: "feat: x",
            forced: true,
            forceReason: "pivot",
            timestamp: "2026-10-29T13:00:50.419Z",
        });
    });

    await t.test("keeps an explicit taskType", async () => {
        await adapter.insertHistoryEntry(user, project, {
            taskDescription: "real task",
            taskType: "bugfix",
            commitMessage: "fix: y",
            timestamp: "2026-10-30T01:00:00.000Z",
        });
    });

    await t.test("persisted every entry", async () => {
        const history = await adapter.getHistoryForUser(user, project, { pageSize: 10 });
        assert.equal(history.entries.length, 3);
    });

    await t.test("falls back to 'other' instead of NULL", async () => {
        const row = adapter.db
            .prepare("SELECT task_type FROM workflow_history WHERE user_id = ? AND timestamp = ?")
            .get(user, "2026-10-26T08:16:48.014Z");
        assert.equal(row.task_type, "other");
    });

    await t.test("leaves no NULL or empty task_type behind", async () => {
        const { n } = adapter.db
            .prepare(
                "SELECT COUNT(*) AS n FROM workflow_history WHERE user_id = ? AND (task_type IS NULL OR task_type = '')",
            )
            .get(user);
        assert.equal(n, 0);
    });
});

test("one bad entry does not stop the remaining entries from syncing", async (t) => {
    const adapter = await makeAdapter(t);
    const user = "loop-user";
    const project = "/loop/project";

    // Mirrors WorkflowState.syncToDatabase(): insert each entry, then update the
    // summary and the state. A single throw used to abort the whole loop, so the
    // summary and state were never written for that project.
    const history = [
        { taskDescription: "legacy drop", dropped: true, timestamp: "2026-10-26T08:16:48.014Z" },
        { taskDescription: "legacy drop 2", dropped: true, timestamp: "2026-10-27T02:06:07.314Z" },
        { taskDescription: "new work", taskType: "feature", commitMessage: "feat: z", timestamp: "2026-10-30T02:00:00.000Z" },
    ];

    for (const entry of history) {
        await adapter.insertHistoryEntry(user, project, entry);
    }
    await adapter.updateSummaryForUser(user, project);
    await adapter.saveState(user, project, { currentPhase: "idle" });

    await t.test("synced all three entries", async () => {
        const { n } = adapter.db
            .prepare("SELECT COUNT(*) AS n FROM workflow_history WHERE user_id = ?")
            .get(user);
        assert.equal(n, 3);
    });

    await t.test("updated the project summary", async () => {
        const summary = await adapter.getSummaryForUser(user, project);
        assert.ok(summary);
        assert.equal(summary.totalTasks, 3);
    });

    await t.test("saved the workflow state", async () => {
        const state = await adapter.getState(user, project);
        assert.deepEqual(state, { currentPhase: "idle" });
    });
});
