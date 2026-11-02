import test from "node:test";
import assert from "node:assert/strict";
import fsAsli from "node:fs/promises";
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkflowState, ensureUserIdFile } from "../workflow-state.js";

/**
 * TES PERILAKU: "GAGAL MEMBACA" TIDAK BOLEH BERARTI "TIDAK ADA ISI"
 * =================================================================
 * Audit 2 November 2026 menemukan tiga jalur tulis yang memperlakukan
 * kegagalan baca sebagai "kosong", lalu MENIMPA data yang sebenarnya masih ada:
 *
 *   1. history bersama (`writeHistoryFile`) - kegagalan baca berkas history
 *      membuat berkas ditulis ulang dari nol, menghapus riwayat SEMUA sesi
 *      lain di proyek itu.
 *   2. berkas state (`readDiskState` -> `save`) - kegagalan baca membuat state
 *      di memori menimpa state yang lebih baru milik proses MCP lain.
 *   3. berkas identitas user (`userIdFile`) - berkas yang tidak terbaca
 *      diganti ID baru, sehingga seluruh riwayat pengguna terlepas.
 *
 * Ketiganya tidak bisa ditangkap tes yang memeriksa bentuk kode. Tes ini
 * menjalankan kode SUNGGUHAN terhadap berkas SUNGGUHAN, dan menyuntikkan
 * kegagalan baca yang REALISTIS (EBUSY: berkas sedang dipegang proses lain -
 * umum di Windows/OneDrive, tempat proyek ini berada).
 */

/** fs tiruan: gagal untuk path tertentu, sisanya diteruskan ke fs asli. */
function fsGagal(gagalUntuk, kode = "EBUSY") {
  return {
    ...fsAsli,
    async readFile(file, ...rest) {
      if (path.resolve(String(file)) === path.resolve(gagalUntuk)) {
        const error = new Error(`${kode}: resource busy or locked, open '${file}'`);
        error.code = kode;
        throw error;
      }
      return fsAsli.readFile(file, ...rest);
    },
  };
}

async function withLayout(callback) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "write-safety-"));
  // Tata letak nyata: history milik PROYEK, state milik SESI.
  const userDir = path.join(tempDir, "users", "alice");
  // State per sesi memakai nama berkas berisi kunci sesi; history bersama
  // memakai nama polos di direktori user yang sama.
  const stateFile = path.join(userDir, "workflow-state.ses-uji.json");
  const historyFile = path.join(userDir, "workflow-state.json");
  await mkdir(userDir, { recursive: true });

  try {
    await callback({ tempDir, stateFile, historyFile });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const ENTRI_LAMA = [
  {
    classification: "INTERNAL",
    taskDescription: "pekerjaan sesi lain yang sudah selesai",
    taskType: "bugfix",
    commitMessage: "fix: punya sesi lain",
    timestamp: "2026-11-01T10:00:00.000Z",
  },
  {
    classification: "INTERNAL",
    taskDescription: "pekerjaan sesi lain yang lebih lama",
    taskType: "feature",
    commitMessage: "feat: punya sesi lain",
    timestamp: "2026-10-31T10:00:00.000Z",
  },
];

test("history bersama yang TIDAK TERBACA tidak ditimpa", async () => {
  await withLayout(async ({ stateFile, historyFile }) => {
    await writeFile(historyFile, JSON.stringify({ history: ENTRI_LAMA }, null, 2));

    const tugas = new WorkflowState(stateFile, { fs: fsGagal(historyFile) });
    tugas.state.history = [
      { taskDescription: "tugas sesi ini", timestamp: "2026-11-02T10:00:00.000Z" },
    ];

    await assert.rejects(
      () => tugas.writeHistoryFile(),
      /tidak bisa dibaca/i,
      "menulis harus DITOLAK, bukan diam-diam menghapus riwayat sesi lain",
    );

    const isi = JSON.parse(await readFile(historyFile, "utf-8"));
    assert.equal(isi.history.length, 2, "kedua entri sesi lain harus tetap ada");
    assert.deepEqual(isi.history, ENTRI_LAMA);
  });
});

test("history bersama yang RUSAK disalin dulu sebelum ditulis ulang", async () => {
  await withLayout(async ({ stateFile, historyFile }) => {
    const rusak = '{"history": [ {"taskDescription": "terpotong';
    await writeFile(historyFile, rusak);

    const tugas = new WorkflowState(stateFile);
    tugas.state.history = [
      { taskDescription: "tugas sesi ini", timestamp: "2026-11-02T10:00:00.000Z" },
    ];

    await tugas.writeHistoryFile();

    const berkas = await readdir(path.dirname(historyFile));
    const cadangan = berkas.filter((nama) => nama.includes(".corrupt-"));
    assert.equal(cadangan.length, 1, "berkas rusak harus disimpan, bukan dibuang");
    assert.equal(
      await readFile(path.join(path.dirname(historyFile), cadangan[0]), "utf-8"),
      rusak,
      "cadangan harus berisi isi asli byte demi byte",
    );

    const baru = JSON.parse(await readFile(historyFile, "utf-8"));
    assert.equal(baru.history.length, 1);
  });
});

test("history bersama tetap digabung normal (tidak ada regresi)", async () => {
  await withLayout(async ({ stateFile, historyFile }) => {
    await writeFile(historyFile, JSON.stringify({ history: ENTRI_LAMA }, null, 2));

    const tugas = new WorkflowState(stateFile);
    tugas.state.history = [
      { taskDescription: "tugas sesi ini", timestamp: "2026-11-02T10:00:00.000Z" },
    ];

    await tugas.writeHistoryFile();

    const isi = JSON.parse(await readFile(historyFile, "utf-8"));
    assert.equal(isi.history.length, 3, "entri lama + entri baru");
    assert.ok(isi.history.some((e) => e.taskDescription === "tugas sesi ini"));
    assert.ok(
      isi.history.some((e) => e.taskDescription === "pekerjaan sesi lain yang sudah selesai"),
    );
  });
});

test("berkas state yang TIDAK TERBACA tidak ditimpa oleh state di memori", async () => {
  await withLayout(async ({ stateFile }) => {
    const milikSesiLain = {
      currentPhase: "coding",
      taskDescription: "pekerjaan sesi lain yang masih berjalan",
      taskType: "feature",
      history: [],
      owner: { processMarker: "proc-other", pid: 4242, updatedAt: new Date().toISOString() },
    };
    await writeFile(stateFile, JSON.stringify(milikSesiLain, null, 2));

    const tugas = new WorkflowState(stateFile, { fs: fsGagal(stateFile) });
    tugas.state.currentPhase = "coding";
    tugas.state.taskDescription = "tugas proses ini yang sudah basi";

    await assert.rejects(
      () => tugas.save(),
      /tidak bisa dibaca/i,
      "menyimpan harus DITOLAK, bukan menimpa pekerjaan proses lain",
    );

    const isi = JSON.parse(await readFile(stateFile, "utf-8"));
    assert.equal(isi.taskDescription, "pekerjaan sesi lain yang masih berjalan");
  });
});

test("berkas state yang RUSAK disalin dulu, lalu gagal dengan suara keras", async () => {
  await withLayout(async ({ stateFile }) => {
    const rusak = '{"currentPhase": "coding", "taskDescription": "terpotong';
    await writeFile(stateFile, rusak);

    const tugas = new WorkflowState(stateFile);
    // State yang rusak TIDAK boleh diganti state kosong diam-diam: agen akan
    // lupa task yang sedang berjalan dan mulai menimpa pekerjaan itu.
    await assert.rejects(
      () => tugas.load(),
      /rusak dan tidak bisa dibaca/i,
      "memuat state rusak harus gagal keras, bukan diam-diam mulai dari nol",
    );

    const cadangan = (await readdir(path.dirname(stateFile))).filter((nama) =>
      nama.includes(".corrupt-"),
    );
    assert.equal(cadangan.length, 1, "state rusak harus disimpan");
    assert.equal(await readFile(path.join(path.dirname(stateFile), cadangan[0]), "utf-8"), rusak);

    // Setelah operator memperbaiki/menghapus berkasnya, sesi bisa jalan lagi.
    // (Berkasnya sendiri sudah dipindahkan menjadi cadangan di atas.)
    await tugas.load();
    tugas.state.taskDescription = "task baru";
    await tugas.save();
    assert.equal(JSON.parse(await readFile(stateFile, "utf-8")).taskDescription, "task baru");
  });
});

/**
 * Identitas user: berkas `user-id` menentukan pemilik seluruh riwayat.
 * Kalau ia dibuat ulang, riwayat pengguna tidak hilang dari disk tetapi
 * TERLEPAS dari pemiliknya - sama merusaknya dengan menghapus.
 */
test("berkas identitas yang sudah ada TIDAK ditimpa ID baru", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "user-id-"));
  const userIdFile = path.join(tempDir, "user-id");
  try {
    // Simulasi dua proses MCP start bersamaan: yang kalah balapan harus
    // memakai ID pemenang, bukan menimpanya.
    await writeFile(userIdFile, "user-pemenang", "utf-8");

    assert.equal(ensureUserIdFile(userIdFile, "user-kalah"), "user-pemenang");
    assert.equal(await readFile(userIdFile, "utf-8"), "user-pemenang");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("berkas identitas baru dibuat bila memang belum ada", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "user-id-"));
  const userIdFile = path.join(tempDir, "user-id");
  try {
    assert.equal(ensureUserIdFile(userIdFile, "user-baru"), "user-baru");
    assert.equal(await readFile(userIdFile, "utf-8"), "user-baru");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("berkas identitas kosong boleh diisi, karena tidak ada identitas yang hilang", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "user-id-"));
  const userIdFile = path.join(tempDir, "user-id");
  try {
    await writeFile(userIdFile, "   \n", "utf-8");
    assert.equal(ensureUserIdFile(userIdFile, "user-baru"), "user-baru");
    assert.equal(await readFile(userIdFile, "utf-8"), "user-baru");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("berkas identitas yang TIDAK TERBACA tidak dihapus atau ditimpa", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "user-id-"));
  const userIdFile = path.join(tempDir, "user-id");
  try {
    // Direktori di posisi berkas: readFileSync gagal (EISDIR) - mewakili
    // berkas yang sedang dipegang proses lain (EBUSY) di Windows.
    await mkdir(userIdFile);

    assert.equal(ensureUserIdFile(userIdFile, "user-baru"), "user-baru");
    const stat = await import("node:fs/promises").then((m) => m.stat(userIdFile));
    assert.ok(stat.isDirectory(), "berkas yang tidak terbaca tidak boleh diganti");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
