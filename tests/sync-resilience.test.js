import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

import { WorkflowState } from "../workflow-state.js";

async function makeState(t) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-resilience-"));
    const stateFile = path.join(tmpDir, "workflow-state.json");
    const state = new WorkflowState(stateFile);
    await state.load();
    t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
    return state;
}

test("syncToDatabase keeps going after one entry fails", async (t) => {
    const state = await makeState(t);

    const inserted = [];
    const summaryCalls = [];
    const saveCalls = [];

    // Inject the db facade: the point is that one failing insert must not skip
    // the entries after it, the summary, or the state.
    const db = {
        insertHistoryEntry: async (userId, project, entry) => {
            if (entry.taskDescription === "poison") throw new Error("NOT NULL constraint failed: workflow_history.task_type");
            inserted.push(entry.taskDescription);
        },
        updateSummaryForUser: async (userId, project) => {
            summaryCalls.push(project);
        },
        saveState: async (userId, project, value) => {
            saveCalls.push(project);
        },
    };

    state.state.history = [
        { taskDescription: "poison", taskType: "other", timestamp: "2026-10-26T08:16:48.014Z" },
        { taskDescription: "after poison", taskType: "feature", timestamp: "2026-10-27T08:16:48.014Z" },
    ];

    await state.syncToDatabase({ db });

    await t.test("kept inserting the entries after the failure", () => {
        assert.deepEqual(inserted, ["after poison"]);
    });

    await t.test("still refreshed the project summary", () => {
        assert.equal(summaryCalls.length, 1);
    });

    await t.test("still saved the workflow state", () => {
        assert.equal(saveCalls.length, 1);
    });
});

test("syncToDatabase does not throw when every insert fails", async (t) => {
    const state = await makeState(t);

    let summaryCalls = 0;
    let saveCalls = 0;

    state.state.history = [{ taskDescription: "poison", taskType: "other", timestamp: "2026-10-26T08:16:48.014Z" }];

    const db = {
        insertHistoryEntry: async () => {
            throw new Error("database is locked");
        },
        updateSummaryForUser: async () => {
            summaryCalls++;
        },
        saveState: async () => {
            saveCalls++;
        },
    };

    await assert.doesNotReject(() => state.syncToDatabase({ db }));
    assert.equal(summaryCalls, 1);
    assert.equal(saveCalls, 1);
});
