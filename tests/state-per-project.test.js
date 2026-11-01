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
  // Sejak 1.17.0 berkasnya per SESI, bukan `workflow-state.json` bersama.
  // Struktur: <dasar>/projects/<proyek>/users/<user>/workflow-state.<sesi>.json
  assert.match(path.basename(hasil), /^workflow-state\..+\.json$/);
  assert.equal(path.basename(path.dirname(path.dirname(path.dirname(path.dirname(hasil))))), "projects");
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

test("proyek yang sama memisahkan berkas per sesi", () => {
  const root = tmp();
  const proyek = buatProyek(root, "clinic");
  const pin = path.join(root, "state", "workflow-state.json");

  // SEBELUM 1.17.0 tes ini menagih KEDUANYA SAMA - dan justru itu bugnya:
  // dua jendela OpenCode pada satu repo saling menghapus Definition of Done.
  // `sessionId` diterima sebagai parameter lalu tidak dipakai di jalur pin.
  const hasil = dengan(pin, proyek, () => [
    resolveStateFile({ sessionId: "sesi-a" }),
    resolveStateFile({ sessionId: "sesi-b" }),
  ]);

  assert.notEqual(hasil[0], hasil[1], "dua sesi tidak boleh berbagi satu berkas state");
  assert.match(path.basename(hasil[0]), /sesi-a/);
  assert.match(path.basename(hasil[1]), /sesi-b/);
});

test("lock penjaga ikut per proyek, bukan satu untuk semua", () => {
  const root = tmp();
  const a = buatProyek(root, "clinic");
  const b = buatProyek(root, "portal");
  const pin = path.join(root, "state", "workflow-state.json");

  const lockA = dengan(pin, a, () => projectLockDir(resolveStateFile()));
  const lockB = dengan(pin, b, () => projectLockDir(resolveStateFile()));

  assert.notEqual(lockA, lockB);
  // Lock berhenti di direktori PROYEK. Sejak 1.17.0 berkas state ada satu
  // tingkat lebih dalam (`users/<user>/`), jadi lock bukan lagi dirname(state).
  assert.match(lockA.replace(/\\/g, "/"), /projects\/clinic-[a-f0-9]+$/);
  assert.equal(lockA, path.dirname(path.dirname(path.dirname(dengan(pin, a, () => resolveStateFile())))));
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

test("state lama menganggur dimigrasikan sekali, berkas lama tetap ada", () => {
  const root = tmp();
  const proyek = buatProyek(root, "clinic");
  const base = path.join(root, "state");
  fs.mkdirSync(base, { recursive: true });
  const lama = path.join(base, "workflow-state.json");
  fs.writeFileSync(lama, JSON.stringify({
    currentPhase: "idle",
    taskDescription: "",
    projectDir: proyek,
    marker: "menganggur",
  }));

  const baru = dengan(path.join(base, "workflow-state.json"), proyek, () => resolveStateFile());

  assert.ok(fs.existsSync(baru), "state proyek harus dibuat dari state lama");
  const isi = JSON.parse(fs.readFileSync(baru, "utf8"));
  assert.equal(isi.marker, "menganggur");
  assert.ok(fs.existsSync(lama), "berkas lama tidak boleh dihapus");
});

test("state lama yang masih punya task aktif TIDAK dimigrasikan", () => {
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

  // Menyalinnya akan membuat sesi baru mewarisi fase dan DoD task sesi lain.
  assert.equal(fs.existsSync(baru), false, "task aktif tidak boleh menyeberang ke sesi baru");
  assert.ok(fs.existsSync(lama), "task itu tetap terlihat di berkas lamanya");
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

test("tanpa proyek yang dikenali, state tetap terpisah per direktori kerja", () => {
  const root = tmp();
  const pin = path.join(root, "state", "workflow-state.json");

  // SEBELUM 1.17.0 tes ini menagih `hasil === pin` - satu berkas bersama untuk
  // seluruh mesin. Itu justru bug yang membuat isolasi tidak pernah aktif di
  // direktori kerja yang bukan repo (`Documents\Default Project`).
  const hasil = dengan(pin, root, () => resolveStateFile({ sessionId: "sesi-a" }));

  assert.notEqual(hasil, pin, "pin bukan lagi satu berkas bersama");
  assert.match(hasil.replace(/\\/g, "/"), /projects\/.+\/users\/.+\/workflow-state\.sesi-a\.json$/);
});

test("state di dalam tata letak .state tetap bisa dilacak ke akar proyeknya", () => {
  const root = tmp();
  const proyek = buatProyek(root, "clinic");
  const berkas = path.join(proyek, ".state", "users", "user-1", "workflow-state.json");

  assert.equal(resolveProjectRootForState(berkas), proyek);
});