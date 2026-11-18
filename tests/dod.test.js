import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ITEMS,
  MAX_TEXT,
  MIN_EVIDENCE,
  validateItemTexts,
  normalizeItems,
  parseChecklist,
  isSatisfied,
  nextItemId,
  openItems,
  renderChecklist,
  summarize,
  mergeDefinitionOfDone,
} from "../tools/handler-modules/dod.js";

test("validateItemTexts menerima daftar yang sah dan mengembalikan teks ter-trim", () => {
  const result = validateItemTexts(["  build lulus  ", "halaman login terverifikasi"]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.items, ["build lulus", "halaman login terverifikasi"]);
});

test("validateItemTexts menolak daftar kosong dan bukan daftar", () => {
  assert.equal(validateItemTexts([]).ok, false);
  assert.match(validateItemTexts([]).error, /minimal satu/i);
  assert.equal(validateItemTexts("build lulus").ok, false);
  assert.equal(validateItemTexts(undefined).ok, false);
});

test("validateItemTexts menolak teks terlalu pendek dan terlalu panjang", () => {
  const short = validateItemTexts(["ok"]);
  assert.equal(short.ok, false);
  assert.match(short.error, /3/);

  const long = validateItemTexts(["x".repeat(MAX_TEXT + 1)]);
  assert.equal(long.ok, false);
  assert.match(long.error, new RegExp(String(MAX_TEXT)));
});

test("validateItemTexts menolak lebih dari 20 item", () => {
  const items = Array.from({ length: MAX_ITEMS + 1 }, (_, index) => `kondisi nomor ${index + 1}`);
  const result = validateItemTexts(items);

  assert.equal(result.ok, false);
  assert.match(result.error, new RegExp(String(MAX_ITEMS)));
});

test("validateItemTexts menolak item kosong di tengah daftar", () => {
  const result = validateItemTexts(["build lulus", "   "]);

  assert.equal(result.ok, false);
});

test("validateItemTexts menolak duplikat tanpa memandang huruf besar kecil", () => {
  const result = validateItemTexts(["Build Lulus", "build lulus"]);

  assert.equal(result.ok, false);
  assert.match(result.error, /duplikat/i);
});

test("parseChecklist mengambil butir berkotak dan membuang kotaknya", () => {
  const result = parseChecklist("- [ ] build lulus\n- [x] tes lama hijau\n* [X] deploy dicoba");

  assert.deepEqual(result.items, ["build lulus", "tes lama hijau", "deploy dicoba"]);
  assert.equal(result.truncated, false);
});

test("parseChecklist mengambil butir tanpa kotak", () => {
  const result = parseChecklist("- build lulus\n+ migrasi jalan\n* rollback dicoba");

  assert.deepEqual(result.items, ["build lulus", "migrasi jalan", "rollback dicoba"]);
});

test("parseChecklist mengabaikan heading, baris kosong, dan paragraf prosa", () => {
  const board = [
    "## Kondisi selesai",
    "",
    "Sebelum menutup task, pastikan semuanya sudah benar.",
    "- [ ] build lulus",
    "  ",
    "### Catatan",
    "Jangan lupa update changelog.",
  ].join("\n");

  const result = parseChecklist(board);

  assert.deepEqual(result.items, ["build lulus"]);
});

test("parseChecklist memotong teks kepanjangan dan menandainya", () => {
  const result = parseChecklist(`- [ ] ${"y".repeat(MAX_TEXT + 50)}`);

  assert.equal(result.items[0].length, MAX_TEXT);
  assert.equal(result.truncated, true);
});

test("parseChecklist membatasi 20 item dan menandainya", () => {
  const board = Array.from({ length: MAX_ITEMS + 5 }, (_, index) => `- [ ] kondisi ${index + 1}`).join("\n");
  const result = parseChecklist(board);

  assert.equal(result.items.length, MAX_ITEMS);
  assert.equal(result.truncated, true);
});

test("parseChecklist membuang duplikat dan menandainya", () => {
  const result = parseChecklist("- [ ] build lulus\n- [ ] Build Lulus");

  assert.deepEqual(result.items, ["build lulus"]);
  assert.equal(result.truncated, true);
});

test("parseChecklist mengembalikan daftar kosong untuk papan tanpa checklist", () => {
  const result = parseChecklist("Tidak ada daftar di sini.\n\n## Heading saja");

  assert.deepEqual(result.items, []);
  assert.equal(result.truncated, false);
});

test("isSatisfied hanya menerima waive atau done pada revisi yang sama", () => {
  const base = { id: "dod-1", text: "build lulus", revision: 2 };

  assert.equal(isSatisfied({ ...base, status: "done" }, 2), true);
  assert.equal(isSatisfied({ ...base, status: "done" }, 3), false, "bukti basi tidak memenuhi");
  assert.equal(isSatisfied({ ...base, status: "waived" }, 3), true, "waive bertahan melewati revisi");
  assert.equal(isSatisfied({ ...base, status: "open" }, 2), false);
});

test("nextItemId melanjutkan nomor tertinggi yang ada", () => {
  assert.equal(nextItemId([]), "dod-1");
  assert.equal(nextItemId([{ id: "dod-1" }, { id: "dod-7" }]), "dod-8");
  assert.equal(nextItemId([{ id: "lain" }]), "dod-1");
});

test("openItems hanya menyisakan item yang belum memenuhi", () => {
  const items = [
    { id: "dod-1", status: "done", revision: 1 },
    { id: "dod-2", status: "open", revision: 0 },
    { id: "dod-3", status: "waived", revision: 0 },
    { id: "dod-4", status: "done", revision: 0 },
  ];

  assert.deepEqual(
    openItems(items, 1).map((item) => item.id),
    ["dod-2", "dod-4"],
  );
});

test("summarize menghitung per status dan mengumpulkan alasan waive", () => {
  const items = [
    { id: "dod-1", status: "done", revision: 1, evidence: "npm test" },
    { id: "dod-2", status: "open", revision: 0 },
    { id: "dod-3", status: "waived", revision: 0, waivedReason: "staging mati" },
  ];

  assert.deepEqual(summarize(items, 1), {
    total: 3,
    done: 1,
    waived: 1,
    open: 1,
    waivedReasons: ["staging mati"],
  });
});

test("summarize memperlakukan bukti basi sebagai terbuka", () => {
  const items = [{ id: "dod-1", status: "done", revision: 1, evidence: "npm test" }];

  assert.equal(summarize(items, 2).done, 0);
  assert.equal(summarize(items, 2).open, 1);
});

test("renderChecklist membedakan terbukti, dilewati, basi, dan terbuka", () => {
  const items = [
    { id: "dod-1", text: "build lulus", status: "done", revision: 2, evidence: "npm test 450 pass" },
    { id: "dod-2", text: "deploy staging", status: "waived", revision: 0, waivedReason: "staging mati" },
    { id: "dod-3", text: "migrasi aman", status: "done", revision: 1, evidence: "migrate:fresh" },
    { id: "dod-4", text: "login terverifikasi", status: "open", revision: 0 },
  ];

  const rendered = renderChecklist(items, 2).split("\n");

  assert.match(rendered[0], /^\- \[x\] build lulus/);
  assert.match(rendered[0], /npm test 450 pass/);
  assert.match(rendered[1], /^\- \[~\] deploy staging/);
  assert.match(rendered[1], /staging mati/);
  assert.match(rendered[2], /^\- \[!\] migrasi aman/);
  assert.match(rendered[2], /konfirmasi ulang/i);
  assert.match(rendered[3], /^\- \[ \] login terverifikasi/);
});

test("normalizeItems membersihkan state lama tanpa melempar", () => {
  assert.deepEqual(normalizeItems(undefined), []);
  assert.deepEqual(normalizeItems("bukan array"), []);

  const items = normalizeItems([
    { id: "dod-1", text: "  build lulus  ", status: "asing", evidence: 7, revision: "2" },
    { text: "tanpa id" },
    { id: "dod-1", text: "id dobel" },
    { id: "dod-9", text: "   " },
  ]);

  assert.equal(items.length, 3, "entri tanpa teks dibuang");
  assert.equal(items[0].text, "build lulus");
  assert.equal(items[0].status, "open", "status asing menjadi open");
  assert.equal(items[0].evidence, "");
  assert.equal(items[0].revision, 2, "revisi numerik dibaca");
  assert.equal(items[1].id, "dod-2", "id hilang diberi nomor lanjutan");
  assert.equal(items[2].id, "dod-3", "id dobel diberi nomor baru");
});

test("normalizeItems juga menerima daftar teks polos", () => {
  const items = normalizeItems(["build lulus", "tes hijau"]);

  assert.deepEqual(items.map((item) => item.text), ["build lulus", "tes hijau"]);
  assert.deepEqual(items.map((item) => item.status), ["open", "open"]);
});

test("mergeDefinitionOfDone mempertahankan bukti yang lebih kuat", () => {
  const memory = [
    { id: "dod-1", text: "build lulus", status: "open", revision: 0 },
    { id: "dod-2", text: "tes hijau", status: "open", revision: 0 },
  ];
  const disk = [
    { id: "dod-1", text: "build lulus", status: "done", revision: 0, evidence: "npm test" },
    { id: "dod-2", text: "tes hijau", status: "done", revision: 1, evidence: "node --test" },
  ];

  const merged = mergeDefinitionOfDone(memory, disk);

  assert.equal(merged.find((item) => item.id === "dod-1").status, "done");
  assert.equal(merged.find((item) => item.id === "dod-2").revision, 1);
});

test("mergeDefinitionOfDone memilih revisi lebih tinggi dan menyimpan item unik", () => {
  const memory = [
    { id: "dod-1", text: "build lulus", status: "done", revision: 3, evidence: "ulang" },
    { id: "dod-3", text: "hanya di memori", status: "open", revision: 0 },
  ];
  const disk = [
    { id: "dod-1", text: "build lulus", status: "done", revision: 1, evidence: "lama" },
    { id: "dod-2", text: "hanya di disk", status: "waived", revision: 0 },
  ];

  const merged = mergeDefinitionOfDone(memory, disk);

  assert.equal(merged.length, 3);
  assert.equal(merged.find((item) => item.id === "dod-1").evidence, "ulang");
  assert.ok(merged.find((item) => item.id === "dod-2"));
  assert.ok(merged.find((item) => item.id === "dod-3"));
});

test("MIN_EVIDENCE dipakai handler untuk menolak bukti terlalu pendek", () => {
  assert.equal(MIN_EVIDENCE, 5);
});
