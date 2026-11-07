import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { autoTaskEnabled, pickProject, recordToFactory, factoryTitle } = require("../factory-auto-task.cjs");

/**
 * Pemilik meminta "setiap pekerjaan terekam di Factory". Sebelum ini jalur
 * Factory hanya lewat tool manual, sehingga pekerjaan nyata tidak pernah
 * sampai ke board - dan board diam sejak 31 Oktober tanpa ada yang tahu.
 *
 * Yang dijaga: pencatatan otomatis TIDAK BOLEH menggagalkan start_task, dan
 * kegagalannya harus TERLIHAT (bukan ditelan), karena kegagalan tak terlihat
 * itulah yang membuat masalah kemarin berlangsung dua hari.
 */

test("hanya menyala bila diminta eksplisit", () => {
  assert.equal(autoTaskEnabled({}), false);
  for (const v of ["0", "false", "no", "mati", ""]) {
    assert.equal(autoTaskEnabled({ FACTORY_AUTO_TASK: v }), false, `nilai ${v}`);
  }
  for (const v of ["1", "true", "yes", "TRUE"]) {
    assert.equal(autoTaskEnabled({ FACTORY_AUTO_TASK: v }), true, `nilai ${v}`);
  }
});

test("project dipilih dari nama folder proyek", () => {
  const proyek = [
    { id: "a", name: "programinglive/lain" },
    { id: "b", name: "programinglive/dev-workflow-mcp-server" },
  ];
  assert.equal(pickProject(proyek, "D:\\code\\dev-workflow-mcp-server").id, "b");
  // Tidak ada yang cocok: pakai yang pertama, bukan gagal.
  assert.equal(pickProject(proyek, "D:\\code\\entah").id, "a");
  assert.equal(pickProject([], "x"), null);
});

test("dimatikan: tidak ada permintaan jaringan sama sekali", async () => {
  const hasil = await recordToFactory({ state: { taskDescription: "x" }, env: {} });
  assert.equal(hasil.ok, false);
  assert.equal(hasil.reason, "dimatikan");
});

test("kegagalan dilaporkan sebagai alasan, bukan dilempar", async () => {
  const klienPalsu = {
    readFactoryConfig: () => ({ url: "http://x", pocketBaseUrl: "http://y" }),
    listProjects: async () => {
      throw new Error("jaringan mati");
    },
    createTask: async () => ({}),
  };
  const hasil = await recordToFactory({
    state: { taskDescription: "uji" },
    env: { FACTORY_AUTO_TASK: "1" },
    client: klienPalsu,
  });
  assert.equal(hasil.ok, false);
  assert.match(hasil.reason, /jaringan mati/);
});

test("berhasil: mengembalikan id factory", async () => {
  const klienPalsu = {
    readFactoryConfig: () => ({ url: "http://x", pocketBaseUrl: "http://y" }),
    listProjects: async () => [{ id: "p1", name: "programinglive/dev-workflow-mcp-server" }],
    createTask: async () => ({ id: "task-123" }),
  };
  const hasil = await recordToFactory({
    state: {
      taskDescription: "Kerjakan sesuatu",
      projectDir: "D:\\code\\dev-workflow-mcp-server",
      definitionOfDone: [{ text: "build lulus" }],
      plan: [{ text: "mulai" }],
    },
    env: { FACTORY_AUTO_TASK: "1", DEVWF_MACHINE: "uji" },
    client: klienPalsu,
  });
  assert.equal(hasil.ok, true);
  assert.equal(hasil.id, "task-123");
});

test("tanpa DoD tetap mengirim teks yang sah", async () => {
  let dikirim = null;
  const klienPalsu = {
    readFactoryConfig: () => ({ url: "http://x", pocketBaseUrl: "http://y" }),
    listProjects: async () => [{ id: "p1", name: "x/y" }],
    createTask: async (_cfg, input) => {
      dikirim = input;
      return { id: "t1" };
    },
  };
  const hasil = await recordToFactory({
    state: { taskDescription: "tanpa dod", definitionOfDone: [] },
    env: { FACTORY_AUTO_TASK: "1" },
    client: klienPalsu,
  });
  assert.equal(hasil.ok, true);
  assert.match(dikirim.definitionOfDone, /task selesai dan terverifikasi/);
});

/**
 * Judul kartu Factory dibatasi 3-140 karakter. `start_task` mengirim
 * deskripsi tugas sebagai judul, dan deskripsi yang wajar sering lebih
 * panjang dari 140 - akibatnya kartu tidak pernah dibuat, tetapi
 * `start_task` tetap berhasil dan hanya menyisipkan peringatan kecil.
 * Pekerjaan jadi tidak tercatat tanpa ada yang menyadarinya.
 *
 * Yang benar: potong judulnya, simpan teks lengkap di deskripsi.
 */
test("judul panjang dipotong ke batas Factory, bukan menggagalkan pencatatan", () => {
  const panjang = "x".repeat(200);
  const hasil = factoryTitle(panjang);
  assert.ok(hasil.length <= 140, `judul ${hasil.length} karakter, harus <= 140`);
  assert.ok(hasil.endsWith("…"), "judul yang dipotong diberi tanda elipsis");
});

test("judul yang sudah pendek tidak diubah", () => {
  assert.equal(factoryTitle("Perbaiki login ERP"), "Perbaiki login ERP");
});

test("spasi berlebih dirapikan supaya tidak memakan kuota 140", () => {
  assert.equal(factoryTitle("  a   b  \n c "), "a b c");
});

test("judul tepat 140 karakter dibiarkan utuh", () => {
  const pas = "y".repeat(140);
  assert.equal(factoryTitle(pas), pas);
});

test("judul 141 karakter dipotong menjadi 140", () => {
  const hasil = factoryTitle("z".repeat(141));
  assert.equal(hasil.length, 140);
});
