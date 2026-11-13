import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDocumentationPath,
  isSourcePath,
  isGateSatisfied,
  evaluateDocGate,
  formatRelativeAge,
  renderDocGateFailure,
} from "../tools/handler-modules/docs.js";

test("isDocumentationPath mengenali berkas dokumentasi", () => {
  for (const p of [
    "README.md",
    "readme",
    "src/README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "docs/guide/any.txt",
    "doc/api.yaml",
    "notes/design.mdx",
  ]) {
    assert.equal(isDocumentationPath(p), true, p);
  }
});

test("isDocumentationPath menolak non-dokumentasi dan fixture tes", () => {
  for (const p of ["src/app.js", "package.json", "tests/fixtures/sample.md", "test/data/readme.md"]) {
    assert.equal(isDocumentationPath(p), false, p);
  }
});

test("isSourcePath mengenali source dan menolak config/tes/lockfile", () => {
  for (const p of ["src/app.js", "src/View.vue", "app/Http/Controllers/Foo.php", "cmd/main.go"]) {
    assert.equal(isSourcePath(p), true, p);
  }
  for (const p of [
    "src/app.test.js",
    "tests/helper.js",
    "node_modules/x/index.js",
    "package-lock.json",
    "README.md",
    "docker-compose.yml",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(isSourcePath(p), false, p);
  }
});

test("evaluateDocGate: hanya source berubah tanpa doc -> needs-docs", () => {
  const r = evaluateDocGate({
    changedPaths: ["src/a.js"],
    dirtyAtStart: [],
    declaredFiles: [],
    hasDocumentation: true,
    waived: false,
  });
  assert.equal(r.status, "needs-docs");
  assert.deepEqual(r.sourceChanged, ["src/a.js"]);
});

test("evaluateDocGate: source dan doc berubah -> ok", () => {
  const r = evaluateDocGate({
    changedPaths: ["src/a.js", "README.md"],
    dirtyAtStart: [],
    declaredFiles: [],
    hasDocumentation: true,
    waived: false,
  });
  assert.equal(r.status, "ok");
});

test("evaluateDocGate: doc yang sudah kotor sejak awal tidak dihitung", () => {
  const r = evaluateDocGate({
    changedPaths: ["src/a.js", "README.md"],
    dirtyAtStart: [{ path: "README.md" }],
    declaredFiles: [],
    hasDocumentation: true,
    waived: false,
  });
  assert.equal(r.status, "needs-docs");
});

test("evaluateDocGate: doc kotor sejak awal yang disebut eksplisit dihitung", () => {
  const r = evaluateDocGate({
    changedPaths: ["src/a.js", "README.md"],
    dirtyAtStart: [{ path: "README.md" }],
    declaredFiles: ["README.md"],
    hasDocumentation: true,
    waived: false,
  });
  assert.equal(r.status, "ok");
});

test("evaluateDocGate: doc dihapus tetap dihitung sebagai perubahan dokumentasi", () => {
  const r = evaluateDocGate({
    changedPaths: ["src/a.js", "README.md"],
    dirtyAtStart: [],
    declaredFiles: [],
    hasDocumentation: true,
    waived: false,
  });
  assert.equal(r.status, "ok");
});

test("evaluateDocGate: tanpa dokumentasi di repo -> no-docs", () => {
  const r = evaluateDocGate({
    changedPaths: ["src/a.js"],
    dirtyAtStart: [],
    declaredFiles: [],
    hasDocumentation: false,
    waived: false,
  });
  assert.equal(r.status, "no-docs");
});

test("evaluateDocGate: waiver menang atas segalanya", () => {
  const r = evaluateDocGate({
    changedPaths: ["src/a.js"],
    dirtyAtStart: [],
    declaredFiles: [],
    hasDocumentation: false,
    waived: true,
  });
  assert.equal(r.status, "waived");
});

test("evaluateDocGate: hanya config/tes/lockfile berubah -> ok", () => {
  for (const changed of [
    ["package.json"],
    ["src/a.test.js"],
    ["package-lock.json"],
    [".github/workflows/ci.yml"],
  ]) {
    const r = evaluateDocGate({
      changedPaths: changed,
      dirtyAtStart: [],
      declaredFiles: [],
      hasDocumentation: true,
      waived: false,
    });
    assert.equal(r.status, "ok", changed.join(","));
  }
});

test("evaluateDocGate: tanpa perubahan sama sekali -> ok", () => {
  const r = evaluateDocGate({
    changedPaths: [],
    dirtyAtStart: [],
    declaredFiles: [],
    hasDocumentation: true,
    waived: false,
  });
  assert.equal(r.status, "ok");
});

test("formatRelativeAge menghitung hari", () => {
  const now = new Date("2026-11-01T00:00:00Z");
  assert.equal(formatRelativeAge("2026-11-01T00:00:00Z", now), "hari ini");
  assert.equal(formatRelativeAge("2026-10-31T00:00:00Z", now), "1 hari lalu");
  assert.equal(formatRelativeAge("2026-10-18T00:00:00Z", now), "14 hari lalu");
  assert.equal(formatRelativeAge("", now), "");
});

test("renderDocGateFailure menyebut berkas, README, dan dua jalan keluar", () => {
  const text = renderDocGateFailure({
    sourceChanged: ["src/a.js", "src/b.js"],
    readmePath: "README.md",
    readmeAge: "14 hari lalu",
    legacy: false,
  });
  assert.match(text, /2 berkas source berubah/);
  assert.match(text, /src\/a\.js/);
  assert.match(text, /README\.md — commit terakhir 14 hari lalu/);
  assert.match(text, /create_documentation/);
  assert.match(text, /waive_documentation/);
  assert.match(text, /Tidak ada yang di-commit/);
});

test("isGateSatisfied", () => {
  for (const s of ["ok", "waived", "no-docs", "unknown"]) {
    assert.equal(isGateSatisfied(s), true, s);
  }
  assert.equal(isGateSatisfied("needs-docs"), false);
});
