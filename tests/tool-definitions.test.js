import { test } from "node:test";
import assert from "node:assert";

import { getToolList } from "../tools/definitions.js";

/**
 * Kontrak tool `sync_task_status`.
 *
 * Skema tool adalah satu-satunya tempat yang menentukan status apa yang boleh
 * diminta agen. Kalau sebuah status sudah didukung Factory dan sudah ditangani
 * lapisan klien, tetapi lupa dicantumkan di sini, agen akan ditolak sebelum
 * permintaan pernah dikirim — persis yang terjadi pada `done`: Factory sudah
 * menerima `done` dari `review`, klien sudah memetakannya ke `move_task`, tapi
 * enum di skema masih menolaknya, sehingga approval task tidak bisa dikerjakan
 * dari agen dan harus diklik manual di UI.
 */
function syncTaskStatusTool() {
  const tool = getToolList().find((item) => item.name === "sync_task_status");
  assert.ok(tool, "tool sync_task_status harus terdaftar");
  return tool;
}

test("sync_task_status menerima done sebagai langkah approval", () => {
  const statuses = syncTaskStatusTool().inputSchema.properties.status.enum;
  assert.ok(
    statuses.includes("done"),
    `enum harus memuat 'done', isinya: ${statuses.join(", ")}`,
  );
});

test("sync_task_status tetap menolak running", () => {
  const statuses = syncTaskStatusTool().inputSchema.properties.status.enum;
  assert.ok(
    !statuses.includes("running"),
    "'running' hanya boleh lewat claim_factory_task, bukan sync_task_status",
  );
});

test("sync_task_status tetap menerima seluruh status lain yang sah", () => {
  const statuses = syncTaskStatusTool().inputSchema.properties.status.enum;
  for (const status of ["backlog", "queued", "review", "blocked", "paused", "cancelled"]) {
    assert.ok(statuses.includes(status), `enum kehilangan '${status}'`);
  }
});

test("deskripsi sync_task_status menyebut done sebagai langkah approval", () => {
  const tool = syncTaskStatusTool();
  const teks = `${tool.description} ${tool.inputSchema.properties.status.description || ""}`;
  assert.match(teks, /done/i);
  assert.match(teks, /review/i, "harus menjelaskan bahwa done hanya dari review");
});