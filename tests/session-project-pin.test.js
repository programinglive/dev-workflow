import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  resolveStateFile,
  pinSessionProject,
  readSessionPointer,
  resolveSessionKey,
} from "../workflow-state.js";

/**
 * Identitas proyek harus mengikuti PROYEK yang dikerjakan, bukan cwd proses.
 *
 * Ditemukan lewat smoke test 1 November 2026, bukan lewat unit test: semua sesi
 * di mesin ini dijalankan dari `Documents\Default Project`, sehingga
 * `process.cwd()` menunjuk direktori yang sama untuk semua proyek. Hasilnya satu
 * direktori `projects/Default-Project-<hash>/` berisi state dari sesi yang
 * mengerjakan `D:\code\belajar`, repo uji, dan repo dev-workflow sekaligus -
 * history tercampur, lock saling menolak, dan rekomendasi satu proyek muncul di
 * proyek lain.
 */

async function withPinned(fn) {
  const base = await mkdtemp(path.join(tmpdir(), "dwf-pin-"));
  const pinLama = process.env.DEV_WORKFLOW_STATE_FILE;
  const cwdLama = process.cwd();
  try {
    process.env.DEV_WORKFLOW_STATE_FILE = path.join(base, "state", "workflow-state.json");
    return await fn(base);
  } finally {
    process.chdir(cwdLama);
    if (pinLama === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
    else process.env.DEV_WORKFLOW_STATE_FILE = pinLama;
    await rm(base, { recursive: true, force: true });
  }
}

test("tanpa penunjuk, identitas jatuh ke cwd", async () => {
  await withPinned(async (base) => {
    const kerja = path.join(base, "kerja");
    await mkdir(kerja, { recursive: true });
    process.chdir(kerja);

    const a = resolveStateFile({ sessionId: "ses_PIN1" });
    assert.match(a.replace(/\\/g, "/"), /projects\/kerja-[a-f0-9]+\/users\//);
  });
});

test("penunjuk sesi mengalihkan state ke proyek yang benar-benar dikerjakan", async () => {
  await withPinned(async (base) => {
    const kerja = path.join(base, "Documents", "Default Project");
    const proyek = path.join(base, "code", "belajar");
    await mkdir(kerja, { recursive: true });
    await mkdir(path.join(proyek, ".git"), { recursive: true });
    process.chdir(kerja);

    // Sebelum dipin: mengikuti cwd.
    const sebelum = resolveStateFile({ sessionId: "ses_PIN2" });
    assert.match(sebelum.replace(/\\/g, "/"), /Default-Project-/);

    // start_task memanggil ini setelah projectDir dipin.
    const pinned = pinSessionProject({ stateFile: sebelum, projectDir: proyek });
    assert.ok(pinned, "pinSessionProject harus mengembalikan letak baru");

    // Sesudah dipin: mengikuti PROYEK, bukan cwd.
    const sesudah = resolveStateFile({ sessionId: "ses_PIN2" });
    assert.equal(sesudah, pinned.stateFile);
    assert.match(sesudah.replace(/\\/g, "/"), /projects\/belajar-[a-f0-9]+\/users\//);
    assert.notEqual(sesudah, sebelum);
  });
});

test("dua sesi di cwd yang sama tetapi proyek berbeda tidak lagi tercampur", async () => {
  await withPinned(async (base) => {
    const kerja = path.join(base, "Documents", "Default Project");
    const belajar = path.join(base, "code", "belajar");
    const clinic = path.join(base, "code", "clinic");
    await mkdir(kerja, { recursive: true });
    await mkdir(path.join(belajar, ".git"), { recursive: true });
    await mkdir(path.join(clinic, ".git"), { recursive: true });
    process.chdir(kerja);

    const a0 = resolveStateFile({ sessionId: "ses_A" });
    const b0 = resolveStateFile({ sessionId: "ses_B" });
    pinSessionProject({ stateFile: a0, projectDir: belajar });
    pinSessionProject({ stateFile: b0, projectDir: clinic });

    const a1 = resolveStateFile({ sessionId: "ses_A" });
    const b1 = resolveStateFile({ sessionId: "ses_B" });

    assert.match(a1.replace(/\\/g, "/"), /projects\/belajar-/);
    assert.match(b1.replace(/\\/g, "/"), /projects\/clinic-/);
    assert.notEqual(a1, b1);
  });
});

test("penunjuk disimpan per sesi, bukan per mesin", async () => {
  await withPinned(async (base) => {
    const kerja = path.join(base, "kerja");
    const proyek = path.join(base, "code", "satu");
    await mkdir(kerja, { recursive: true });
    await mkdir(path.join(proyek, ".git"), { recursive: true });
    process.chdir(kerja);

    const stateFile = resolveStateFile({ sessionId: "ses_PIN3" });
    pinSessionProject({ stateFile, projectDir: proyek });

    const baseDir = path.join(base, "state");
    const key = resolveSessionKey(process.env, "ses_PIN3");
    const pointer = readSessionPointer(baseDir, key);

    assert.ok(pointer, "penunjuk harus tertulis");
    assert.equal(path.resolve(pointer.projectDir), path.resolve(proyek));
    // Sesi lain tidak ikut teralihkan.
    assert.equal(readSessionPointer(baseDir, "ses_LAIN"), null);
  });
});

test("penunjuk yang menunjuk direktori hilang diabaikan, bukan membuat crash", async () => {
  await withPinned(async (base) => {
    const kerja = path.join(base, "kerja");
    const proyek = path.join(base, "code", "sementara");
    await mkdir(kerja, { recursive: true });
    await mkdir(path.join(proyek, ".git"), { recursive: true });
    process.chdir(kerja);

    const stateFile = resolveStateFile({ sessionId: "ses_PIN4" });
    pinSessionProject({ stateFile, projectDir: proyek });

    // Proyeknya dipindah/dihapus setelah dipin.
    await rm(proyek, { recursive: true, force: true });

    const sesudah = resolveStateFile({ sessionId: "ses_PIN4" });
    assert.match(sesudah.replace(/\\/g, "/"), /projects\/kerja-[a-f0-9]+\/users\//);
  });
});
