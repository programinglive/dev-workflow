import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";

/**
 * Uji end-to-end lewat transport stdio sungguhan.
 *
 * Unit test membuktikan `handleToolCall` membaca `_meta`, tapi tidak
 * membuktikan MCP SDK benar-benar meneruskannya dari klien ke handler. Kalau
 * SDK membuang `_meta`, seluruh perbaikan identitas sesi tidak ada gunanya -
 * dan itu persis jenis kesalahan yang terjadi sebelumnya (env var yang tidak
 * pernah di-set, dianggap ada).
 *
 * Tes ini menyalakan server seperti OpenCode menyalakannya, mengirim
 * `tools/call` dengan `_meta["ai.opencode/sessionID"]`, lalu memeriksa berkas
 * state yang benar-benar dibuat di disk.
 */

const SERVER = new URL("../index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SESSION_META_KEY = "ai.opencode/sessionID";

function startServer(env, cwd) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      }
    }
  });

  let nextId = 1;
  const send = (payload) =>
    new Promise((resolve, reject) => {
      const id = payload.id ?? nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout menunggu respons id ${id}`)), 15000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
    });

  const initialize = async () => {
    await send({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  };

  return { child, send, initialize, stop: () => child.kill() };
}

test("MCP SDK meneruskan _meta sessionID sampai ke state di disk", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "mcp-meta-e2e-"));
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "fixture" }));

  const server = startServer({
    DEV_WORKFLOW_USER_ID: "user-e2e",
    DEV_WORKFLOW_DB_PATH: path.join(tmpdir(), `mcp-meta-e2e-${process.pid}.db`),
    DOTENV_CONFIG_PATH: path.join(projectRoot, "empty.env"),
  }, projectRoot);

  try {
    await writeFile(path.join(projectRoot, "empty.env"), "");
    await server.initialize();

    // Sesi A memulai task.
    await server.send({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "start_task",
        arguments: { description: "Task sesi A lewat stdio", type: "feature" },
        _meta: { [SESSION_META_KEY]: "ses_E2E_AAA" },
      },
    });

    // Sesi B memulai task lain pada server yang SAMA.
    await server.send({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "start_task",
        arguments: { description: "Task sesi B lewat stdio", type: "bugfix" },
        _meta: { [SESSION_META_KEY]: "ses_E2E_BBB" },
      },
    });

    // Berkas state harus dibuat per sesi, bukan per pid.
    const stateDirs = await readdir(projectRoot, { withFileTypes: true }).catch(() => []);
    const stateDir = stateDirs.find((entry) => entry.name === ".state");
    assert.ok(stateDir, "direktori .state harus dibuat");

    const usersDir = path.join(projectRoot, ".state", "users");
    const users = await readdir(usersDir);
    assert.ok(users.length > 0, "harus ada direktori user");

    const files = await readdir(path.join(usersDir, users[0]));
    const sessionFiles = files.filter((name) => name.startsWith("workflow-state.") && name.includes("ses_E2E"));

    assert.ok(
      sessionFiles.length >= 2,
      `harus ada berkas state per sesi (ses_E2E_AAA dan ses_E2E_BBB), dapat: ${JSON.stringify(files)}`,
    );
    assert.ok(
      !files.some((name) => name.includes(`pid-${server.child.pid}`)),
      `tidak boleh jatuh ke pid-${server.child.pid}: ${JSON.stringify(files)}`,
    );
  } finally {
    server.stop();
    await once(server.child, "exit").catch(() => {});
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
