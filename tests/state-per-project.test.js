/**
 * Isolasi state per PROYEK saat DEV_WORKFLOW_STATE_FILE dipasang.
 *
 * Kejadian 1 November 2026: config mesin ini memasang satu berkas state untuk
 * semua lokasi OpenCode. Akibatnya semua proyek berbagi satu slot task, penjaga
 * "sesi lain sedang mengerjakan proyek ini" menyala untuk proyek yang tidak
 * berhubungan, dan dua sesi saling menimpa - sampai bukti DoD milik satu task
 * tertulis ke task proyek lain.
 *
 * Aturan yang diuji di sini: pin = direktori dasar, state tinggal di
 * `<dasar>/projects/<proyek>/workflow-state.json`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateFile, resolveHistoryFile, resolveProjectRootForState } from "../workflow-state.js";
import { projectLockDir } from "../process-lock.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dw-proyek-"));
}

function buatProyek(root, nama) {
  const dir = path.join(root, nama);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  return dir;
}

/** Jalankan fn dengan cwd dan DEV_WORKFLOW_STATE_FILE tertentu, lalu pulihkan. */
function dengan(pin, cwd, fn) {
  const cwdLama = process.cwd();
  const pinLama = process.env.DEV_WORKFLOW_STATE_FILE;
  const initLama = process.env.INIT_CWD;
  try {
    if (pin === null) delete process.env.DEV_WORKFLOW_STATE_FILE;
    else process.env.DEV_WORKFLOW_STATE_FILE = pin;
    // npm test mengisi INIT_CWD dengan akar repo; biarkan tes menentukan sendiri
    // proyek mana yang sedang dipakai.
    delete process.env.INIT_CWD;
    process.chdir(cwd);
    return fn();
  } finally {
    process.chdir(cwdLama);
    if (pinLama === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
    else process.env.DEV_WORKFLOW_STATE_FILE = pinLama;
    if (initLama === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = initLama;
  }
}

test("dengan pin, state tinggal di subdirektori proyek - bukan di berkas pin", () => {
  const root = tmp();
  const proyek = buatProyek(root, "clinic");
  const pin = path.join(root, "state", "workflow-state.json");

  const hasil = dengan(pin, proyek, () => resolveStateFile());

  assert.notEqual(path.dirname(hasil), path.join(root, "state"));
  assert.equal(path.basename(hasil), "workflow-state.json");
  assert.equal(path.basename(path.dirname(path.dirname(hasil))), "projects");
  assert.ok(hasil.startsWith(path.join(root, "state")), hasil);
});

test("dua proyek berbeda tidak berbagi berkas state", () => {
  const root = tmp();
  const a = buatProyek(root, "clinic");
  const b = buatProyek(root, "portal");
  const pin = path.join(root, "state", "workflow-state.json");

  const stateA = dengan(pin, a, () => resolveStateFile());
  const stateB = dengan(pin, b, () => resolveStateFile());

  assert.notEqual(stateA, stateB);
});

test("proyek yang sama tetap satu berkas, apa pun nama sesinya", () => {
  const root = tmp();
  const proyek = buatProyek(root, "clinic");
  const pin = path.join(root, "state", "workflow-state.json");

  const hasil = dengan(pin, proyek, () => [
    resolveStateFile({ sessionId: "sesi-a" }),
    resolveStateFile({ sessionId: "sesi-b" }),
  ]);

  assert.equal(hasil[0], hasil[1]);
});

test("lock penjaga ikut per proyek, bukan satu untuk semua", () => {
  const root = tmp();
  const a = buatProyek(root, "clinic");
  const b = buatProyek(root, "portal");
  const pin = path.join(root, "state", "workflow-state.json");

  const lockA = dengan(pin, a, () => projectLockDir(resolveStateFile()));
  const lockB = dengan(pin, b, () => projectLockDir(resolveStateFile()));

  assert.notEqual(lockA, lockB);
  assert.equal(lockA, path.dirname(dengan(pin, a, () => resolveStateFile())));
});

test("riwayat proyek tidak tercampur dengan proyek lain", () => {
  const root = tmp();
  const a = buatProyek(root, "clinic");
  const b = buatProyek(root, "portal");
  const pin = path.join(root, "state", "workflow-state.json");

  const histA = dengan(pin, a, () => resolveHistoryFile(resolveStateFile()));
  const histB = dengan(pin, b, () => resolveHistoryFile(resolveStateFile()));

  assert.notEqual(histA, histB);
});

test("state lama dimigrasikan sekali bila memang milik proyek ini", () => {
  const root = tmp();
  const proyek = buatProyek(root, "clinic");
  const base = path.join(root, "state");
  fs.mkdirSync(base, { recursive: true });
  const lama = path.join(base, "workflow-state.json");
  fs.writeFileSync(lama, JSON.stringify({
    currentPhase: "commit",
    taskDescription: "task yang sedang berjalan",
    projectDir: proyek,
  }));

  const baru = dengan(path.join(base, "workflow-state.json"), proyek, () => resolveStateFile());

  assert.ok(fs.existsSync(baru), "state proyek harus dibuat dari state lama");
  const isi = JSON.parse(fs.readFileSync(baru, "utf8"));
  assert.equal(isi.taskDescription, "task yang sedang berjalan");
  assert.ok(fs.existsSync(lama), "berkas lama tidak boleh dihapus");
});

test("state lama milik proyek LAIN tidak dimigrasikan", () => {
  const root = tmp();
  const proyek = buatProyek(root, "clinic");
  const proyekLain = buatProyek(root, "portal");
  const base = path.join(root, "state");
  fs.mkdirSync(base, { recursive: true });
  const lama = path.join(base, "workflow-state.json");
  fs.writeFileSync(lama, JSON.stringify({
    currentPhase: "commit",
    taskDescription: "task proyek portal",
    projectDir: proyekLain,
  }));

  const baru = dengan(path.join(base, "workflow-state.json"), proyek, () => resolveStateFile());

  assert.equal(fs.existsSync(baru), false, "task proyek lain tidak boleh menyeberang");
});

test("tanpa proyek yang dikenali, pin tetap dipakai apa adanya", () => {
  const root = tmp();
  const pin = path.join(root, "state", "workflow-state.json");

  const hasil = dengan(pin, root, () => resolveStateFile());

  assert.equal(hasil, pin);
});

test("state di dalam tata letak .state tetap bisa dilacak ke akar proyeknya", () => {
  const root = tmp();
  const proyek = buatProyek(root, "clinic");
  const berkas = path.join(proyek, ".state", "users", "user-1", "workflow-state.json");

  assert.equal(resolveProjectRootForState(berkas), proyek);
});