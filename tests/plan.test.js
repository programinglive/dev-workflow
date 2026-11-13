import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validatePlanSteps,
  normalizePlan,
  planProgress,
  renderPlanShort,
  renderPlanFull,
  MIN_PLAN_STEP,
  MAX_PLAN_STEP,
  MAX_PLAN_ITEMS,
} from "../tools/handler-modules/plan.js";

/**
 * Rencana kerja: URUTAN langkah, bukan syarat selesai.
 *
 * Definition of Done menjawab "apa yang harus benar sebelum task boleh
 * ditutup". Rencana menjawab "sedang di langkah berapa". Tanpa rencana, agen
 * mengeksekusi tanpa jejak yang bisa dibaca manusia, dan pengguna hanya melihat
 * hasil akhir - atau tidak sama sekali sampai ia bertanya.
 */

test("validatePlanSteps menerima daftar yang sah", () => {
  const r = validatePlanSteps(["Telusuri handler", "Tulis tes gagal", "Implementasi"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.items, ["Telusuri handler", "Tulis tes gagal", "Implementasi"]);
});

test("validatePlanSteps menolak daftar kosong, bukan array, dan kepanjangan", () => {
  assert.equal(validatePlanSteps([]).ok, false);
  assert.equal(validatePlanSteps("bukan array").ok, false);
  assert.equal(validatePlanSteps(Array(MAX_PLAN_ITEMS + 1).fill("langkah yang cukup")).ok, false);
});

test("validatePlanSteps menolak langkah terlalu pendek, terlalu panjang, dan duplikat", () => {
  assert.equal(validatePlanSteps(["ab"]).ok, false);
  assert.equal(validatePlanSteps(["x".repeat(MAX_PLAN_STEP + 1)]).ok, false);
  const dup = validatePlanSteps(["Tulis tes", "tulis TES"]);
  assert.equal(dup.ok, false, "duplikat harus ditolak tanpa memandang huruf besar/kecil");
  assert.ok(MIN_PLAN_STEP <= 3);
});

test("validatePlanSteps menyebut aturan dalam pesan galat", () => {
  const r = validatePlanSteps([]);
  assert.equal(r.ok, false);
  assert.match(r.error, /langkah/i);
});

test("normalizePlan membuang entri rusak tanpa melempar", () => {
  const plan = normalizePlan([
    { id: "plan-1", text: "langkah satu", status: "done" },
    { id: "plan-2", text: 42 },
    null,
    "langkah telanjang",
    { text: "" },
  ]);
  assert.equal(plan.length, 3);
  assert.equal(plan[0].status, "done");
  assert.equal(plan[1].status, "open");
  assert.equal(plan[2].status, "open");
});

test("planProgress menghitung selesai dan langkah berikutnya", () => {
  const plan = normalizePlan([
    { id: "plan-1", text: "satu", status: "done" },
    { id: "plan-2", text: "dua", status: "done" },
    { id: "plan-3", text: "tiga", status: "open" },
  ]);
  const p = planProgress(plan);
  assert.equal(p.done, 2);
  assert.equal(p.total, 3);
  assert.equal(p.next.text, "tiga");
});

test("planProgress aman untuk rencana kosong", () => {
  const p = planProgress([]);
  assert.equal(p.total, 0);
  assert.equal(p.next, null);
});

test("renderPlanShort menampilkan progres ringkas dengan langkah berikutnya", () => {
  const plan = normalizePlan([
    { id: "plan-1", text: "Telusuri kode", status: "done" },
    { id: "plan-2", text: "Tulis tes", status: "open" },
    { id: "plan-3", text: "Implementasi", status: "open" },
  ]);
  const text = renderPlanShort(plan);
  assert.match(text, /1\/3/);
  assert.match(text, /berikutnya: Tulis tes/);
  // Sengaja ringkas: blok ini muncul di setiap respons tool, jadi hanya
  // progres dan langkah berikutnya yang ditampilkan - bukan seluruh daftar.
  assert.doesNotMatch(text, /Implementasi/);
});

test("renderPlanShort menyatakan selesai saat semua langkah ditandai", () => {
  const plan = normalizePlan([
    { id: "plan-1", text: "satu", status: "done" },
    { id: "plan-2", text: "dua", status: "done" },
  ]);
  assert.match(renderPlanShort(plan), /semua langkah selesai/);
});

test("renderPlanShort tidak memakan tempat saat rencana kosong", () => {
  assert.equal(renderPlanShort([]), "");
});

test("renderPlanFull menandai setiap langkah", () => {
  const plan = normalizePlan([
    { id: "plan-1", text: "Telusuri kode", status: "done" },
    { id: "plan-2", text: "Tulis tes", status: "open" },
  ]);
  const text = renderPlanFull(plan);
  assert.match(text, /\[x\] Telusuri kode/);
  assert.match(text, /\[ \] Tulis tes/);
});

test("renderPlanFull menyatakan terus terang saat belum ada rencana", () => {
  assert.match(renderPlanFull([]), /belum ada rencana/i);
});
