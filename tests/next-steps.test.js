import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateAiSuggestions,
  collectSignals,
  buildRecommendations,
  renderRecommendations,
} from "../tools/handler-modules/next-steps.js";

test("validateAiSuggestions menolak lebih dari 5, terlalu pendek, terlalu panjang", () => {
  assert.equal(validateAiSuggestions(Array(6).fill("saran yang cukup panjang")).ok, false);
  assert.equal(validateAiSuggestions(["pendek"]).ok, false);
  assert.equal(validateAiSuggestions(["x".repeat(201)]).ok, false);
  assert.deepEqual(validateAiSuggestions(["saran yang cukup panjang"]).items, [
    "saran yang cukup panjang",
  ]);
  assert.deepEqual(validateAiSuggestions([]).items, []);
  assert.deepEqual(validateAiSuggestions(undefined).items, []);
});

test("validateAiSuggestions membuang entri kosong dan menolak bukan array", () => {
  assert.deepEqual(validateAiSuggestions(["", "  ", "saran yang cukup panjang"]).items, [
    "saran yang cukup panjang",
  ]);
  assert.equal(validateAiSuggestions("bukan array").ok, false);
});

test("collectSignals menandai DoD yang di-waive sebagai prioritas tinggi", () => {
  const signals = collectSignals({
    state: {
      definitionOfDone: [
        {
          id: "dod-1",
          text: "login terverifikasi",
          status: "waived",
          waivedReason: "butuh akun staging",
        },
      ],
      history: [],
    },
  });
  assert.equal(signals[0].priority, "high");
  assert.match(signals[0].title, /login terverifikasi/);
  assert.match(signals[0].title, /butuh akun staging/);
});

test("collectSignals menyebut tes yang di-skip dan dokumentasi yang di-waive", () => {
  const signals = collectSignals({
    state: {
      testsSkipped: true,
      testsSkippedReason: "tidak ada harness",
      documentationWaived: true,
      documentationWaiverReason: "refactor internal",
      history: [],
    },
  });
  assert.ok(signals.some((s) => /tidak ada harness/.test(s.title)));
  assert.ok(signals.some((s) => /refactor internal/.test(s.title)));
});

test("collectSignals mengambil TODO dari commitInspection, maksimal 5", () => {
  const todos = Array.from({ length: 7 }, (_, i) => ({
    path: "src/a.js",
    line: i + 1,
    text: `TODO: ke-${i}`,
  }));
  const signals = collectSignals({
    state: { history: [] },
    commitInspection: { paths: ["src/a.js"], todos },
  });
  const todoSignal = signals.find((s) => /TODO/.test(s.title));
  assert.match(todoSignal.title, /5 TODO/);
  assert.match(todoSignal.title, /src\/a\.js:1/);
});

test("collectSignals mendeteksi pola bugfix berulang dan diff besar", () => {
  const history = Array.from({ length: 5 }, () => ({ taskType: "bugfix" }));
  const signals = collectSignals({
    state: { history },
    commitInspection: {
      paths: Array.from({ length: 16 }, (_, i) => `src/f${i}.js`),
      todos: [],
    },
  });
  assert.ok(signals.some((s) => /bugfix/.test(s.title)));
  assert.ok(signals.some((s) => /16 berkas/.test(s.title)));
});

test("collectSignals menandai berkas kotor yang tertinggal", () => {
  const signals = collectSignals({
    state: { history: [] },
    statusOutput: " M lain.txt",
    dirtyAtStart: [{ path: "lain.txt" }],
  });
  assert.ok(signals.some((s) => s.priority === "high" && /tertinggal/.test(s.title)));
});

test("collectSignals tidak mengarang saat tidak ada sinyal", () => {
  assert.deepEqual(collectSignals({ state: { history: [] } }), []);
});

test("buildRecommendations mengurutkan prioritas, membuang duplikat, memotong 6", () => {
  const signals = [
    { priority: "low", source: "signal", title: "a" },
    { priority: "high", source: "signal", title: "b" },
    { priority: "high", source: "signal", title: "B" },
    { priority: "medium", source: "signal", title: "c" },
    { priority: "low", source: "signal", title: "d" },
    { priority: "low", source: "signal", title: "e" },
    { priority: "low", source: "signal", title: "f" },
    { priority: "low", source: "signal", title: "g" },
  ];
  const out = buildRecommendations({ signals, aiSuggestions: ["saran dari sesi ini"] });
  assert.equal(out.filter((i) => i.source === "signal").length, 6);
  assert.equal(out[0].title, "b");
  assert.equal(out.at(-1).source, "ai");
});

test("renderRecommendations menyebut fakta dan saran secara terpisah", () => {
  const text = renderRecommendations([
    { priority: "high", source: "signal", title: "DoD dilewati" },
    { priority: "medium", source: "ai", title: "refreshToken rapuh" },
  ]);
  assert.match(text, /Dari fakta sesi ini:/);
  assert.match(text, /Saran sesi ini:/);
  assert.match(text, /\[tinggi\] DoD dilewati/);
  assert.match(text, /refreshToken rapuh/);
});

test("renderRecommendations menyatakan terus terang bila kosong", () => {
  assert.match(renderRecommendations([]), /Tidak ada sinyal/);
});
