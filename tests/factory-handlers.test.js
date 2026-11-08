import { test } from "node:test";
import assert from "node:assert";

import {
  handleListFactoryTasks,
  handleClaimFactoryTask,
  handleSyncTaskStatus,
  handleUpdateFactoryTask,
} from "../tools/handler-modules/factory-handlers.js";
import { clearTokenCache } from "../factory-client.js";

const TASK_ID = "33333333-3333-4333-8333-333333333333";
const BACKLOG_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const WORKSPACE = {
  projects: [{ id: "p1", name: "programinglive/dev-workflow-mcp-server" }],
  tasks: [
    {
      id: TASK_ID,
      projectId: "p1",
      title: "Sambungkan MCP ke Factory",
      description: "",
      acceptance: "npm test hijau",
      definitionOfDone: "- [ ] sesi kerja tercatat",
      priority: "high",
      status: "running",
      createdAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:00:00.000Z",
      work: {
        id: "sess-1",
        state: "active",
        activityStatus: "active",
        step: "Menulis klien",
        summary: "",
        device: { id: DEVICE_ID, name: "HELLOWORLD" },
        startedAt: "2026-10-26T01:00:00.000Z",
      },
    },
    {
      id: "11111111-1111-4111-8111-111111111111",
      projectId: "p1",
      title: "Task backlog",      description: "",
      acceptance: "selesai",
      definitionOfDone: "- [ ] tes lulus",
      priority: "normal",
      status: "backlog",
      createdAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
      work: null,
    },
  ],
  events: [],
};

function setEnv() {
  process.env.FACTORY_URL = "https://factory.test";
  process.env.FACTORY_TOKEN = "tok";
  process.env.FACTORY_DEVICE_ID = DEVICE_ID;
  process.env.FACTORY_MACHINE_ID = "HELLOWORLD";
  clearTokenCache();
}

function clearEnv() {
  for (const key of [
    "FACTORY_URL",
    "FACTORY_TOKEN",
    "FACTORY_DEVICE_ID",
    "FACTORY_MACHINE_ID",
    "FACTORY_EMAIL",
    "FACTORY_PASSWORD",
  ]) {
    delete process.env[key];
  }
  clearTokenCache();
}

function text(response) {
  return response?.content?.[0]?.text ?? "";
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    return handler(call);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// ---------------------------------------------------------------------------

test("list tool explains how to configure Factory instead of failing", async () => {
  clearEnv();
  const out = text(await handleListFactoryTasks({}));

  assert.match(out, /not configured/i);
  assert.match(out, /FACTORY_URL/);
  assert.match(out, /FACTORY_TOKEN/);
  assert.doesNotMatch(out, /secret/i);
});

test("list tool renders the real board", async () => {
  setEnv();
  const stub = stubFetch((call) => (call.url.endsWith("/api/factory") ? json(WORKSPACE) : json({}, 500)));
  try {
    const out = text(await handleListFactoryTasks({}));

    assert.match(out, /Sambungkan MCP ke Factory/);
    assert.match(out, /running/);
    assert.match(out, /dev-workflow-mcp-server/);
  } finally {
    stub.restore();
    clearEnv();
  }
});

test("list tool includes backlog by default", async () => {
  setEnv();
  const stub = stubFetch((call) => (call.url.endsWith("/api/factory") ? json(WORKSPACE) : json({}, 500)));
  try {
    const out = text(await handleListFactoryTasks({}));
    assert.match(out, /Task backlog/);
    assert.match(out, /backlog/);
  } finally {
    stub.restore();
    clearEnv();
  }
});

test("claim tool refuses without a recordId", async () => {
  setEnv();
  try {
    const out = text(await handleClaimFactoryTask({}, { workflowState: null }));
    assert.match(out, /recordId/i);
  } finally {
    clearEnv();
  }
});

test("sync tool refuses an unknown status", async () => {
  setEnv();
  try {
    const out = text(await handleSyncTaskStatus({ recordId: "r1", status: "shipped" }));
    assert.doesNotMatch(out, /Updated/);
    assert.match(out, /Unknown status/);
  } finally {
    clearEnv();
  }
});

test("sync tool explains that running comes from claiming", async () => {
  setEnv();
  try {
    const out = text(await handleSyncTaskStatus({ recordId: "r1", status: "running" }));
    assert.match(out, /claim_factory_task/);
  } finally {
    clearEnv();
  }
});

test("sync tool can mark a task done, and reports server errors instead of blocking it locally", async () => {
  setEnv();
  try {
    // Factory menolak done untuk task yang belum sampai review (409). Di tes ini
    // jaringan tidak tersedia, jadi yang dibuktikan adalah: handler TIDAK lagi
    // menolak done di sisi klien, dan kegagalan diteruskan apa adanya.
    const out = text(await handleSyncTaskStatus({ recordId: "r1", status: "done" }));
    assert.doesNotMatch(out, /human/i);
    assert.match(out, /Could not update the task/i);
  } finally {
    clearEnv();
  }
});

test("sync tool requires a reason when blocking", async () => {
  setEnv();
  try {
    const out = text(await handleSyncTaskStatus({ recordId: "r1", status: "blocked" }));
    assert.doesNotMatch(out, /Updated/);
    assert.match(out, /reason/i);
  } finally {
    clearEnv();
  }
});

// ---------------------------------------------------------------------------
// Handler wiring
// ---------------------------------------------------------------------------

test("claim handler opens a work session and starts the local workflow", async () => {
  setEnv();
  const stub = stubFetch((call) => {
    if (call.url.endsWith("/api/factory")) return json(WORKSPACE);
    if (call.url.endsWith("/api/work")) return json({ session: { id: "sess-new", state: "active" } });
    return json({}, 500);
  });

  const saved = [];
  const workflowState = {
    state: { currentPhase: "idle", taskDescription: "", taskType: "" },
    reset() { this.state = { currentPhase: "idle", taskDescription: "", taskType: "" }; },
    async save() { saved.push({ ...this.state }); },
  };

  try {
    const out = text(await handleClaimFactoryTask({ recordId: BACKLOG_ID, step: "Mulai kerja" }, { workflowState }));

    assert.match(out, /Claimed/);
    assert.match(out, /running/);
    assert.match(
      out,
      /Imported 1 definition-of-done item\(s\) from the board, all OPEN/,
      "kriteria selesai diimpor sebagai rencana, bukan bukti",
    );
    assert.match(out, /dod-1: tes lulus/, "setiap item harus disebut beserta id-nya");
    assert.strictEqual(workflowState.state.currentPhase, "coding");
    assert.strictEqual(workflowState.state.dodSource, "factory");
    assert.strictEqual(workflowState.state.definitionOfDone[0].status, "open");
    assert.strictEqual(workflowState.state.definitionOfDone[0].text, "tes lulus");
    assert.match(workflowState.state.taskDescription, /Sambungkan MCP ke Factory|Task backlog/);
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(workflowState.state.taskOrigin.system,'factory');
    assert.strictEqual(workflowState.state.taskOrigin.id,BACKLOG_ID);
    assert.strictEqual(workflowState.state.zettly.externalLinks.factory.id,BACKLOG_ID);
    const identity=workflowState.state.workflowTaskId;
    workflowState.state.zettly.todoId=42;
    await handleClaimFactoryTask({recordId:BACKLOG_ID,step:'Continue the same work'}, {workflowState});
    assert.strictEqual(workflowState.state.workflowTaskId,identity,'A repeated claim must preserve the canonical identity');
    assert.strictEqual(workflowState.state.zettly.todoId,42,'A repeated claim must reuse the known Zettly Todo');

    const start = stub.calls.find((call) => call.url.endsWith("/api/work"));
    assert.ok(start, "a POST /api/work should be sent");
    assert.strictEqual(start.body.action, "start");
    assert.strictEqual(start.body.step, "Mulai kerja");
  } finally {
    stub.restore();
    clearEnv();
  }
});

test("claim handler asks the server and explains a missing takeover reason", async () => {
  setEnv();
  const stub = stubFetch((call) => {
    if (call.url.endsWith("/api/factory")) return json(WORKSPACE);
    if (call.url.endsWith("/api/work")) {
      return json(
        {
          error: "Task sedang dikerjakan di perangkat lain. Ambil alih dengan menyertakan alasan takeover.",
          takeoverRequired: true,
          holder: { deviceName: "MMCH", agent: "Codex", lastSeenAt: "2026-10-27T06:00:31.249Z" },
        },
        409,
      );
    }
    return json({}, 500);
  });

  try {
    const out = text(await handleClaimFactoryTask({ recordId: TASK_ID }, { workflowState: null }));

    assert.match(out, /MMCH/, "pesan harus menyebut perangkat yang memegang task");
    assert.match(out, /Codex/);
    assert.match(out, /Sambungkan MCP ke Factory/, "pesan harus menyebut judul task yang sebenarnya");
    assert.match(out, /takeoverReason/, "pesan harus menunjukkan parameter yang perlu diisi");
    assert.match(out, /3-500/, "pesan harus menyebut panjang alasan yang diterima");
    assert.doesNotMatch(out, /already has an active work session/);

    const start = stub.calls.find((call) => call.url.endsWith("/api/work"));
    assert.ok(start, "server harus tetap ditanya, bukan ditolak di sisi klien");
    assert.strictEqual(start.body.action, "start");
  } finally {
    stub.restore();
    clearEnv();
  }
});

test("claim handler forwards a takeover reason", async () => {
  setEnv();
  const stub = stubFetch((call) => {
    if (call.url.endsWith("/api/factory")) return json(WORKSPACE);
    if (call.url.endsWith("/api/work")) return json({ session: { id: "sess-new", state: "active" }, tookOver: true });
    return json({}, 500);
  });

  try {
    const out = text(
      await handleClaimFactoryTask(
        { recordId: TASK_ID, step: "Lanjut", takeoverReason: "Pemilik lama offline 3 hari, saya lanjutkan." },
        { workflowState: null },
      ),
    );

    assert.match(out, /Claimed/);
    const start = stub.calls.find((call) => call.url.endsWith("/api/work"));
    assert.strictEqual(start.body.takeoverReason, "Pemilik lama offline 3 hari, saya lanjutkan.");
  } finally {
    stub.restore();
    clearEnv();
  }
});

test("claim handler claims a task held by another device when no reason is needed", async () => {
  setEnv();
  const stub = stubFetch((call) => {
    if (call.url.endsWith("/api/factory")) return json(WORKSPACE);
    if (call.url.endsWith("/api/work")) return json({ session: { id: "sess-resumed", state: "active" } });
    return json({}, 500);
  });

  try {
    const out = text(await handleClaimFactoryTask({ recordId: TASK_ID, step: "Lanjut" }, { workflowState: null }));
    assert.match(out, /Claimed/, "server yang memutuskan, bukan klien");
    const start = stub.calls.find((call) => call.url.endsWith("/api/work"));
    assert.ok(start, "permintaan harus dikirim ke server");
  } finally {
    stub.restore();
    clearEnv();
  }
});

test("sync handler finishes the session for review", async () => {
  setEnv();
  const stub = stubFetch((call) => {
    if (call.url.endsWith("/api/factory")) return json(WORKSPACE);
    if (call.url.endsWith("/api/work")) {
      return json({ session: { id: "sess-1", state: "review", summary: "Selesai, minta review." } });
    }
    return json({}, 500);
  });

  try {
    const out = text(await handleSyncTaskStatus({ recordId: TASK_ID, status: "review", reason: "Selesai, minta review." }));

    assert.match(out, /Updated/);
    assert.match(out, /review/);
    assert.match(
      out,
      /Definition of done:\n- \[ \] sesi kerja tercatat/,
      "checklist harus dibaca lagi saat melaporkan selesai, bukan hanya saat claim",
    );
    const finish = stub.calls.find((call) => call.url.endsWith("/api/work"));
    assert.strictEqual(finish.body.action, "finish");
    assert.strictEqual(finish.body.deviceId, DEVICE_ID);
  } finally {
    stub.restore();
    clearEnv();
  }
});

test("sync handler reports a Factory error instead of claiming success", async () => {
  setEnv();
  const stub = stubFetch((call) => {
    if (call.url.endsWith("/api/factory")) return json(WORKSPACE);
    if (call.url.endsWith("/api/work")) return json({ error: "Sesi dimiliki perangkat lain." }, 409);
    return json({}, 500);
  });

  try {
    const out = text(await handleSyncTaskStatus({ recordId: TASK_ID, status: "review", reason: "Selesai." }));
    assert.doesNotMatch(out, /Updated/);
    assert.match(out, /perangkat lain|Could not update/);
  } finally {
    stub.restore();
    clearEnv();
  }
});

// ---------------------------------------------------------------------------
// update_factory_task
// ---------------------------------------------------------------------------

test("update tool refuses a request without any field, without touching the network", async () => {
  setEnv();
  const stub = stubFetch(() => json(WORKSPACE));
  try {
    const out = text(await handleUpdateFactoryTask({ recordId: BACKLOG_ID }));
    assert.match(out, /at least one field/i);
    assert.equal(stub.calls.length, 0, "tidak boleh menghubungi Factory untuk permintaan kosong");
  } finally {
    stub.restore();
    clearEnv();
  }
});

test("update tool fills the definition of done of an existing task", async () => {
  setEnv();
  const stub = stubFetch((call) => {
    if (call.method === "GET") return json(WORKSPACE);
    return json({ ok: true, id: BACKLOG_ID, updatedAt: "2026-10-29T00:00:01.000Z" });
  });
  try {
    const out = text(await handleUpdateFactoryTask({ recordId: BACKLOG_ID, definitionOfDone: "- [ ] tes lulus" }));
    assert.match(out, /Updated/);
    const post = stub.calls.find((call) => call.method === "POST");
    assert.equal(post.body.action, "update_task");
    assert.deepEqual(post.body.task, { definitionOfDone: "- [ ] tes lulus" });
    assert.equal(post.body.expectedUpdatedAt, "2026-10-25T00:00:00.000Z");
  } finally {
    stub.restore();
    clearEnv();
  }
});

test("update tool tells the agent to reload when Factory reports a stale task", async () => {
  setEnv();
  const stub = stubFetch((call) => {
    if (call.method === "GET") return json(WORKSPACE);
    return json({ error: "Task sudah berubah. Muat ulang sebelum mengedit." }, 409);
  });
  try {
    const out = text(await handleUpdateFactoryTask({ recordId: BACKLOG_ID, definitionOfDone: "- [ ] tes lulus" }));
    assert.match(out, /Could not update the task/);
    assert.match(out, /Reload the task/);
  } finally {
    stub.restore();
    clearEnv();
  }
});
