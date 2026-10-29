import { test } from "node:test";
import assert from "node:assert";

import { formatTaskList, mapTaskRecord } from "../factory-client.js";

// Kenapa tes ini ada:
//
// `list_factory_tasks` menampilkan ID 8 karakter, sementara `sync_task_status`
// menuntut UUID penuh. Akibatnya agen tidak bisa memakai tool resminya sendiri:
// harus membaca GET /api/factory lewat skrip lain untuk mendapatkan UUID.
// Ini terjadi pada 29 Oktober 2026 dan memaksa workaround di luar MCP.

const UUID = "e47a715d-5614-414b-abce-d5cbddf14e43";

const TASK = {
  id: UUID,
  taskKey: UUID.slice(0, 8),
  title: "Audit dan gabung task duplikat di Factory board",
  status: "backlog",
  priority: "normal",
  projectName: "beautyworld_repository/erp.beautyworld.co.id",
  acceptance: "Semua task duplikat teridentifikasi dan ditandai",
  work: null,
};

test("formatTaskList menampilkan UUID penuh, bukan potongan 8 karakter", () => {
  const text = formatTaskList([TASK]);

  assert.ok(
    text.includes(UUID),
    `UUID penuh harus tampil supaya bisa dipakai sync_task_status.\nHasil:\n${text}`,
  );
});

test("UUID penuh muncul di baris judul, bukan hanya di metadata", () => {
  const text = formatTaskList([TASK]);
  const titleLine = text.split("\n").find((line) => line.includes(TASK.title)) || "";

  assert.ok(
    titleLine.includes(UUID),
    `Baris judul harus memuat UUID lengkap agar mudah disalin.\nBaris: ${titleLine}`,
  );
});

test("formatTaskList tetap menampilkan task tanpa id tanpa menulis undefined", () => {
  const text = formatTaskList([{ ...TASK, id: null, taskKey: null }]);

  assert.ok(!text.includes("undefined"), `Tidak boleh ada 'undefined'.\nHasil:\n${text}`);
  assert.ok(!text.includes("null"), `Tidak boleh ada 'null'.\nHasil:\n${text}`);
});

test("mapTaskRecord menyimpan id penuh, bukan versi terpotong", () => {
  const mapped = mapTaskRecord({ id: UUID, title: "x", status: "backlog" }, []);

  assert.strictEqual(mapped.id, UUID);
  assert.strictEqual(mapped.taskKey, UUID.slice(0, 8));
});
