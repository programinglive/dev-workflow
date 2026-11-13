import { test } from "node:test";
import assert from "node:assert";

import { getToolList } from "../tools/definitions.js";

/**
 * Kontrak pensiunnya Factory.
 *
 * Factory sudah tidak dipakai. Tool-nya harus hilang dari daftar, bukan sekadar
 * tidak dipanggil: skema tool adalah satu-satunya tempat agen belajar tool apa
 * yang ada, jadi menyisakan nama di sini berarti mengundang agen memakainya.
 */
test("tidak ada tool Factory yang masih terdaftar", () => {
  const sisa = getToolList()
    .map((item) => item.name)
    .filter((name) => /factory/i.test(name) || name === "sync_task_status");
  assert.deepEqual(sisa, [], `tool Factory masih terdaftar: ${sisa.join(", ")}`);
});

/**
 * Kontrak gerbang dokumentasi dan rekomendasi tindak lanjut.
 *
 * Skema tool adalah satu-satunya tempat agen belajar bahwa `files` adalah bukti
 * yang diterima dan bahwa `nextSteps` boleh dikirim. Kalau properti itu hilang
 * dari skema, gerbangnya tetap ada tetapi tidak ada cara sah memenuhinya.
 */
function toolByName(name) {
  const tool = getToolList().find((item) => item.name === name);
  assert.ok(tool, `tool ${name} harus terdaftar`);
  return tool;
}

test("create_documentation menerima files sebagai bukti gerbang", () => {
  const files = toolByName("create_documentation").inputSchema.properties.files;
  assert.ok(files, "create_documentation harus punya properti 'files'");
  assert.equal(files.type, "array");
  assert.equal(files.items.type, "string");
  assert.ok(
    /working tree/i.test(files.description),
    "deskripsi harus menyebut bahwa berkas diverifikasi terhadap working tree",
  );
});

test("waive_documentation terdaftar dengan alasan wajib", () => {
  const tool = toolByName("waive_documentation");
  assert.deepEqual(tool.inputSchema.required, ["reason"]);
  assert.equal(tool.inputSchema.properties.reason.type, "string");
});

test("next_steps terdaftar tanpa argumen", () => {
  const tool = toolByName("next_steps");
  assert.equal(tool.inputSchema.type, "object");
  assert.deepEqual(Object.keys(tool.inputSchema.properties || {}), []);
});

test("complete_task menerima nextSteps maksimal 5 butir", () => {
  const nextSteps = toolByName("complete_task").inputSchema.properties.nextSteps;
  assert.ok(nextSteps, "complete_task harus punya properti 'nextSteps'");
  assert.equal(nextSteps.type, "array");
  assert.equal(nextSteps.maxItems, 5);
});

test("run_full_workflow menerima documentationFiles dan documentationWaiverReason", () => {
  const props = toolByName("run_full_workflow").inputSchema.properties;
  assert.ok(props.documentationFiles, "harus punya documentationFiles");
  assert.ok(props.documentationWaiverReason, "harus punya documentationWaiverReason");
});
