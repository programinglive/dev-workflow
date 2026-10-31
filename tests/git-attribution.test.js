import test from "node:test";
import assert from "node:assert/strict";

import { parseStatusEntries, foreignDirtyEntries } from "../git-helpers.js";

/**
 * Baseline/attribution guard.
 *
 * `commit_and_push` memakai `git add .`, yang men-staging seluruh working tree.
 * Tanpa pembanding baseline, pekerjaan sesi lain yang kebetulan ada di repo
 * yang sama ikut ter-commit dan tidak bisa dipisahkan lagi sesudahnya.
 */

test("parseStatusEntries membaca kode dan path dari porcelain", () => {
  // Bentuk asli `git status --porcelain`: X = index, Y = worktree.
  // Perubahan belum di-stage => " M path" (satu spasi di depan).
  const entries = parseStatusEntries(" M knowledge/billing.yaml\n?? catatan.md\nA  src/app.js\n");

  assert.deepEqual(entries, [
    { code: "M", path: "knowledge/billing.yaml" },
    { code: "??", path: "catatan.md" },
    { code: "A", path: "src/app.js" },
  ]);
});

test("parseStatusEntries tidak memakan huruf pertama nama berkas", () => {
  // Kalau path dibaca dengan slice(3), " M knowledge/..." menjadi
  // "nowledge/..." dan berkasnya tidak pernah cocok dengan baseline.
  const [entry] = parseStatusEntries(" M a.txt\n");
  assert.equal(entry.path, "a.txt");
});

test("parseStatusEntries memakai path tujuan untuk rename", () => {
  const entries = parseStatusEntries("R  lama.js -> baru.js\n");

  assert.deepEqual(entries, [{ code: "R", path: "baru.js" }]);
});

test("parseStatusEntries aman untuk masukan kosong atau bukan string", () => {
  assert.deepEqual(parseStatusEntries(""), []);
  assert.deepEqual(parseStatusEntries("\n\n"), []);
  assert.deepEqual(parseStatusEntries(null), []);
  assert.deepEqual(parseStatusEntries(undefined), []);
});

test("foreignDirtyEntries hanya menyebut yang sudah kotor sejak baseline", () => {
  const baseline = [{ code: "M", path: "knowledge/billing.yaml" }];
  const status = [
    "M knowledge/billing.yaml", // sudah kotor sebelum task -> bukan milik kita
    "M src/index.js",           // muncul selama task -> milik kita
    "?? catatan-baru.md",       // berkas baru -> tidak bisa dipastikan, jangan dituduh
  ].join("\n");

  assert.deepEqual(foreignDirtyEntries(baseline, status), [
    { code: "M", path: "knowledge/billing.yaml" },
  ]);
});

test("foreignDirtyEntries kosong bila baseline kosong", () => {
  // Baseline kosong berarti working tree bersih saat task dimulai: tidak ada
  // yang bisa dituduh, dan perilaku lama (`git add .`) dipertahankan.
  assert.deepEqual(foreignDirtyEntries([], "M src/index.js"), []);
  assert.deepEqual(foreignDirtyEntries(undefined, "M src/index.js"), []);
});

test("foreignDirtyEntries mengabaikan berkas baseline yang sudah hilang dari status", () => {
  // Berkas yang kotor di baseline lalu dikembalikan ke HEAD tidak lagi muncul;
  // ia tidak boleh dilaporkan seolah masih menggantung.
  const baseline = [
    { code: "M", path: "sudah-dibersihkan.js" },
    { code: "M", path: "masih-kotor.js" },
  ];

  assert.deepEqual(
    foreignDirtyEntries(baseline, "M masih-kotor.js\n"),
    [{ code: "M", path: "masih-kotor.js" }],
  );
});

test("foreignDirtyEntries tidak mencocokkan sebagian nama berkas", () => {
  // 'app.js' di baseline tidak boleh membuat 'src/app.js' dianggap asing.
  const baseline = [{ code: "M", path: "app.js" }];

  assert.deepEqual(foreignDirtyEntries(baseline, "M src/app.js\n"), []);
});
