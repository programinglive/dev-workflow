import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a connected MCP process keeps its taskless session visible with heartbeats", { timeout: 10000 }, async (t) => {
  const reports = [];
  const monitor = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === "POST" && req.url === "/api/session") {
      reports.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  monitor.listen(0, "127.0.0.1");
  await once(monitor, "listening");

  const stateDir = mkdtempSync(path.join(os.tmpdir(), "devwf-heartbeat-test-"));
  const child = spawn(process.execPath, [path.join(ROOT, "index.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      DEV_WORKFLOW_DB_TYPE: "sqlite",
      DEV_WORKFLOW_STATE_FILE: path.join(stateDir, "workflow-state.json"),
      DEV_WORKFLOW_DB_PATH: path.join(stateDir, "workflow-state.db"),
      DEV_WORKFLOW_NO_COMPAT_LINKS: "1",
      DEVWF_MONITOR_URL: `http://127.0.0.1:${monitor.address().port}`,
      DEVWF_MACHINE: "heartbeat-test",
      DEVWF_AGENT: "opencode",
      DEVWF_MONITOR_HEARTBEAT_MS: "150",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  child.stdout.resume();
  t.after(async () => {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
    monitor.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  const deadline = Date.now() + 5000;
  while (reports.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.ok(reports.length >= 2, `expected repeated reports, got ${reports.length}`);
  for (const report of reports.slice(0, 2)) {
    assert.equal(report.machine, "heartbeat-test");
    assert.equal(report.phase, "idle");
    assert.equal(report.task, "");
    assert.equal(report.agentTool, "opencode");
    assert.ok(report.sessionKey);
  }
});
