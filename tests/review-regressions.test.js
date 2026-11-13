import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  isDocumentationPath,
  isSourcePath,
  evaluateDocGate,
  pathKey,
} from "../tools/handler-modules/docs.js";
import { collectSignals } from "../tools/handler-modules/next-steps.js";
import { resolveStateFile, STRANDED_TASK_FILENAME } from "../workflow-state.js";

/**
 * Regresi dari review independen 1 November 2026 (laporan reviewer, 17 temuan).
 *
 * Setiap tes di sini mengunci satu jalan pintas atau satu kesalahan yang
 * ditemukan SETELAH 1.16.0/1.17.0 dirilis. Tanpa berkas ini, semuanya bisa
 * kembali tanpa ada yang gagal.
 */

test("berkas source tidak boleh dianggap dokumentasi", () => {
  // Sebelum perbaikan: `src/security.js`, `lib/agents.ts`, dan
  // `src/architecture.js` dianggap dokumentasi SEKALIGUS bukan source - jadi
  // task yang hanya mengubah salah satunya lolos gerbang tanpa satu pun berkas
  // dokumentasi tersentuh, dan `files: ["src/security.js"]` diterima sebagai bukti.
  for (const p of ["src/security.js", "lib/agents.ts", "src/architecture.js", "app/security.php"]) {
    assert.equal(isDocumentationPath(p), false, `${p} tidak boleh dianggap dokumentasi`);
    assert.equal(isSourcePath(p), true, `${p} harus dianggap source`);
  }
});

test("nama dokumentasi tanpa ekstensi dan berekstensi dokumentasi tetap dikenali", () => {
  for (const p of ["README", "README.md", "readme.rst", "docs/readme.txt", "SECURITY.md", "AGENTS.md", "CHANGELOG.md"]) {
    assert.equal(isDocumentationPath(p), true, p);
  }
});

test("pathKey menyatukan ejaan pada Windows", () => {
  if (process.platform !== "win32") return;
  assert.equal(pathKey("README.md"), pathKey("readme.md"));
  assert.equal(pathKey(".\\docs\\A.md"), pathKey("docs/a.md"));
});

test("evaluateDocGate tidak menghitung doc yang disebut dengan ejaan berbeda", () => {
  const r = evaluateDocGate({
    changedPaths: ["src/a.js", "README.md"],
    dirtyAtStart: [{ path: "readme.md" }],
    declaredFiles: ["readme.md"],
    hasDocumentation: true,
    waived: false,
  });
  // `declaredFiles` mengklaim "readme.md"; berkas yang kotor sejak awal adalah
  // "README.md" dengan ejaan lain. Di Windows keduanya berkas yang sama, jadi
  // klaimnya harus dihitung - bukan ditolak diam-diam.
  assert.equal(r.status, "ok");
});

test("collectSignals menyebut dokumentasi yang dicatat bukan sebagai README", () => {
  const signals = collectSignals({
    state: { history: [], documentationCreated: true, documentationType: "inline-comments" },
  });
  assert.ok(
    signals.some((s) => /inline-comments/.test(s.title)),
    "sinyal documentationType (yang kesembilan) harus ada",
  );
});

test("collectSignals tidak menyebutnya saat dokumentasi di-waive", () => {
  const signals = collectSignals({
    state: {
      history: [],
      documentationCreated: true,
      documentationType: "inline-comments",
      documentationWaived: true,
      documentationWaiverReason: "refactor internal",
    },
  });
  assert.ok(!signals.some((s) => /inline-comments/.test(s.title)));
});

test("state bertask aktif saat migrasi meninggalkan jejak yang bisa dilaporkan", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "dwf-strand-"));
  const repo = path.join(base, "repo");
  await mkdir(path.join(repo, ".git"), { recursive: true });

  const pinLama = process.env.DEV_WORKFLOW_STATE_FILE;
  const cwdLama = process.cwd();
  try {
    process.env.DEV_WORKFLOW_STATE_FILE = path.join(base, "state", "workflow-state.json");
    process.chdir(repo);

    // Resolusi pertama menentukan direktori proyek.
    const target = resolveStateFile({ sessionId: "ses_STRAND" });
    const projectDir = path.dirname(path.dirname(path.dirname(target)));
    const lama = path.join(projectDir, "workflow-state.json");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      lama,
      JSON.stringify({
        currentPhase: "documentation",
        taskDescription: "task yang sedang berjalan saat upgrade",
        projectDir: repo,
      }),
      "utf8",
    );

    // Sesi lain memicu migrasi.
    const target2 = resolveStateFile({ sessionId: "ses_LAIN" });
    const strandedPath = path.join(projectDir, STRANDED_TASK_FILENAME);

    assert.equal(existsSync(target2), false, "task aktif tidak boleh disalin ke sesi baru");
    assert.ok(existsSync(strandedPath), "jejak task yang tidak dipindahkan harus ditulis");
    const jejak = JSON.parse(readFileSync(strandedPath, "utf8"));
    assert.match(jejak.taskDescription, /sedang berjalan saat upgrade/);
  } finally {
    process.chdir(cwdLama);
    if (pinLama === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
    else process.env.DEV_WORKFLOW_STATE_FILE = pinLama;
    await rm(base, { recursive: true, force: true });
  }
});

test("user-id dibaca dari jangkar proyek, bukan dibuat ulang di direktori user", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "dwf-uid-"));
  const repo = path.join(base, "repo");
  await mkdir(path.join(repo, ".git"), { recursive: true });

  const pinLama = process.env.DEV_WORKFLOW_STATE_FILE;
  const cwdLama = process.cwd();
  try {
    process.env.DEV_WORKFLOW_STATE_FILE = path.join(base, "state", "workflow-state.json");
    process.chdir(repo);

    const target = resolveStateFile({ sessionId: "ses_UID" });
    const projectDir = path.dirname(path.dirname(path.dirname(target)));
    const akar = path.join(projectDir, "user-id");
    assert.ok(existsSync(akar), "user-id harus ditulis di akar proyek");

    // Inti temuan reviewer: `getCurrentUserId` dulu membaca dari
    // `users/<user>/user-id` dan MEMBUAT id baru di sana bila tidak ada.
    assert.equal(
      existsSync(path.join(path.dirname(target), "user-id")),
      false,
      "tidak boleh ada user-id kedua di direktori user",
    );
  } finally {
    process.chdir(cwdLama);
    if (pinLama === undefined) delete process.env.DEV_WORKFLOW_STATE_FILE;
    else process.env.DEV_WORKFLOW_STATE_FILE = pinLama;
    await rm(base, { recursive: true, force: true });
  }
});
