/**
 * Aturan gerbang dokumentasi, sebagai fungsi murni.
 *
 * MENGAPA BERKAS, BUKAN LABEL
 * ---------------------------
 * Sampai 1 November 2026 langkah dokumentasi ditutup oleh `documentationType`
 * yang dipilih sendiri agen: `"inline-comments"` sama sahnya dengan `"README"`.
 * Tidak ada satu pun pembacaan working tree, jadi README bisa tertinggal
 * berbulan-bulan sementara `check_ready_to_commit` melaporkan
 * "Documentation created ✅". Gerbang ini menilai berkas yang benar-benar
 * berubah, atau waiver dengan alasan tertulis.
 *
 * Semua di sini tanpa MCP dan tanpa filesystem, seperti `dod.js`: aturan
 * "kapan dokumentasi dianggap diperbarui" harus bisa dibaca dan diuji tanpa
 * menyalakan server.
 */

export const MIN_WAIVER_REASON = 15;
export const MAX_WAIVER_REASON = 500;

/** Ekstensi yang dianggap source code. */
const SOURCE_EXTENSIONS = new Set([
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "vue", "svelte",
  "php", "py", "rb", "go", "rs", "java", "kt", "kts", "cs",
  "c", "h", "cc", "cpp", "hpp", "swift", "dart", "scala",
  "sh", "bash", "ps1", "sql", "graphql", "proto",
  "ex", "exs", "lua", "r", "pl", "clj", "elm", "zig",
]);

/** Ekstensi dokumentasi yang dihitung di mana pun kecuali direktori tes. */
const DOC_EXTENSIONS = new Set(["md", "mdx", "rst", "adoc"]);

/**
 * Nama berkas dokumentasi di akar repo mana pun.
 *
 * Hanya berlaku untuk nama TANPA ekstensi source. Sebelumnya aturan ini
 * mencocokkan batang nama, sehingga `src/security.js`, `lib/agents.ts`, dan
 * `src/architecture.js` dianggap dokumentasi - dan `isSourcePath` menolaknya
 * sebagai source. Akibatnya task yang hanya mengubah `security.js` lolos dari
 * gerbang tanpa satu pun berkas dokumentasi tersentuh.
 */
const DOC_BASENAMES = [
  "readme",
  "changelog",
  "contributing",
  "architecture",
  "security",
  "code_of_conduct",
  "agents",
];

/** Ekstensi yang sah mengikuti nama dokumentasi di atas. */
const DOC_NAME_EXTENSIONS = new Set(["md", "mdx", "rst", "adoc", "txt", "html", "htm"]);

/** Direktori yang isinya tidak pernah dianggap source milik proyek. */
const IGNORED_DIRS = new Set([
  "node_modules", "vendor", "dist", "build", ".git", ".next", "target", "__pycache__",
]);

/**
 * @zettly-code DWF-TOOL-PROFILES-006
 * @purpose Keep the documentation gate honest when the active tool profile does not expose a waiver tool.
 */
import { getToolProfile, isToolAllowedInProfile } from "../../src/tool-profiles.js";

export function normalizePath(value) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/**
 * Kunci pembanding path, untuk HIMPUNAN dan pencocokan.
 *
 * Windows tidak membedakan huruf besar/kecil, dan git kadang melaporkan
 * ejaan dari index, bukan ejaan yang diketik agen. Perbandingan string mentah
 * membuat deklarasi yang BENAR ditolak dengan pesan "tidak muncul di working
 * tree" - menyesatkan, dan memaksa agen menebak ejaan.
 *
 * Dipakai di tiga tempat (`evaluateDocGate`, verifikasi `create_documentation`,
 * dan `foreignDirtyPaths`). Tiga salinan perbandingan path adalah cara bug ini
 * bertahan, jadi semuanya memakai fungsi ini.
 */
export function pathKey(value) {
  const normalized = normalizePath(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function segmentsOf(p) {
  return normalizePath(p).split("/").filter(Boolean);
}

function basenameOf(p) {
  const parts = segmentsOf(p);
  return (parts[parts.length - 1] || "").toLowerCase();
}

function extensionOf(p) {
  const name = basenameOf(p);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

/**
 * Sama dengan `isTestFilePath` di `git-helpers.js`. Sengaja disalin, bukan
 * diimpor: `git-helpers.js` memanggil `exec`, dan aturan gerbang harus tetap
 * murni supaya bisa diuji tanpa repo.
 */
function isTestPath(p) {
  const normalized = normalizePath(p);
  if (!normalized) return false;
  if (/\.(test|spec)\.[^.]+$/i.test(normalized)) return true;
  return /(\/|^)(__tests__|tests?|spec)\//i.test(normalized);
}

function hasIgnoredDir(p) {
  return segmentsOf(p).slice(0, -1).some((segment) => IGNORED_DIRS.has(segment.toLowerCase()));
}

function hasDocDir(p) {
  return segmentsOf(p)
    .slice(0, -1)
    .some((segment) => {
      const lower = segment.toLowerCase();
      return lower === "docs" || lower === "doc";
    });
}

export function isDocumentationPath(filePath) {
  const normalized = normalizePath(filePath);
  if (!normalized) return false;
  // Fixture dan berkas bantuan tes bukan dokumentasi proyek.
  if (isTestPath(normalized)) return false;

  const base = basenameOf(normalized);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const suffix = dot > 0 ? base.slice(dot + 1) : "";

  // Nama dokumentasi dikenali dari BATANG nama, tetapi hanya bila ekstensinya
  // kosong atau memang ekstensi dokumentasi. Tanpa syarat ekstensi ini,
  // `src/security.js` lolos sebagai dokumentasi dan gerbangnya mati diam-diam.
  if (DOC_BASENAMES.includes(stem) && (dot <= 0 || DOC_NAME_EXTENSIONS.has(suffix))) {
    return true;
  }

  if (hasDocDir(normalized)) return true;

  return DOC_EXTENSIONS.has(extensionOf(normalized));
}

export function isSourcePath(filePath) {
  const normalized = normalizePath(filePath);
  if (!normalized) return false;
  if (isDocumentationPath(normalized)) return false;
  if (isTestPath(normalized)) return false;
  if (hasIgnoredDir(normalized)) return false;

  return SOURCE_EXTENSIONS.has(extensionOf(normalized));
}

/**
 * Status gerbang yang tidak menghalangi commit.
 *
 * `"unknown"` ikut lolos dengan sengaja: kalau git tidak tersedia, gerbang
 * tidak bisa diperiksa, dan gerbang yang diam-diam memblokir lebih buruk
 * daripada gerbang yang mengaku tidak tahu.
 */
export function isGateSatisfied(status) {
  return status === "ok" || status === "waived" || status === "no-docs" || status === "unknown";
}

/**
 * Menilai apakah dokumentasi ikut diperbarui.
 *
 * Berkas dokumentasi yang SUDAH kotor sebelum `start_task` tidak dihitung,
 * kecuali disebut eksplisit di `declaredFiles`. Alasannya sama dengan
 * `foreignDirtyEntries` di `git-helpers.js`: berkas yang sudah kotor di
 * baseline tidak bisa dibedakan dari pekerjaan sesi lain, dan `commit_and_push`
 * justru menolak memasukkannya. Menyebutnya di `declaredFiles` adalah klaim
 * eksplisit atas satu berkas, dan klaim itu tercatat.
 */
export function evaluateDocGate({
  changedPaths = [],
  dirtyAtStart = [],
  declaredFiles = [],
  hasDocumentation = false,
  waived = false,
} = {}) {
  const changed = [...new Set((Array.isArray(changedPaths) ? changedPaths : []).map(normalizePath))]
    .filter(Boolean);
  const dirty = new Set(
    (Array.isArray(dirtyAtStart) ? dirtyAtStart : [])
      .map((entry) => pathKey(entry?.path ?? entry))
      .filter(Boolean),
  );
  const declared = new Set(
    (Array.isArray(declaredFiles) ? declaredFiles : []).map(pathKey).filter(Boolean),
  );

  const sourceChanged = changed.filter((p) => !dirty.has(pathKey(p)) && isSourcePath(p));
  const docsTouched = changed.filter(
    (p) => isDocumentationPath(p) && (!dirty.has(pathKey(p)) || declared.has(pathKey(p))),
  );

  let status;
  if (waived) {
    status = "waived";
  } else if (!hasDocumentation) {
    status = "no-docs";
  } else if (sourceChanged.length === 0) {
    status = "ok";
  } else if (docsTouched.length > 0) {
    status = "ok";
  } else {
    status = "needs-docs";
  }

  return { status, sourceChanged, docsTouched };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `"2026-10-18T..."` -> `"14 hari lalu"`. Kosong bila tanggalnya tidak ada. */
export function formatRelativeAge(iso, now = new Date()) {
  if (typeof iso !== "string" || iso.trim() === "") {
    return "";
  }
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) {
    return "";
  }
  const days = Math.floor((now.getTime() - then.getTime()) / DAY_MS);
  if (!Number.isFinite(days) || days <= 0) {
    return "hari ini";
  }
  return days === 1 ? "1 hari lalu" : `${days} hari lalu`;
}

/**
 * Pesan penolakan yang dibaca agen.
 *
 * Menyebut berkas yang berubah, umur README, dan DUA jalan keluar. Jalan keluar
 * kedua penting: tanpa waiver yang eksplisit, agen akan mencari cara lain untuk
 * lolos (mis. memilih `documentationType: "inline-comments"`), dan gerbang ini
 * kembali menjadi ritual.
 */
export function renderDocGateFailure({
  sourceChanged = [],
  readmePath = "",
  readmeAge = "",
  profile = getToolProfile(),
} = {}) {
  const list = sourceChanged.map((p) => `   • ${p}`).join("\n");
  const count = sourceChanged.length;

  const readmeLine = readmePath
    ? `README di repo ini: ${readmePath}${readmeAge ? ` — commit terakhir ${readmeAge}` : ""}`
    : "Repo ini tidak punya README di akar maupun direktori docs/.";

  return (
    `❌ Documentation updated for code changes\n\n` +
    `${count} berkas source berubah, tidak satu pun berkas dokumentasi:\n${list}\n\n` +
    `${readmeLine}\n\n` +
    `Pilih satu:\n` +
    ` 1. Perbarui README/docs, lalu:\n` +
    `    create_documentation { documentationType: "README",\n` +
    `                           files: ["README.md"], summary: "..." }\n` +
    (isToolAllowedInProfile("waive_documentation", profile)
      ? ` 2. Kalau perubahan ini memang tidak mengubah apa pun yang didokumentasikan:\n` +
        `    waive_documentation { reason: "..." }   ← alasan masuk history, bukan hilang\n\n`
      : ` 2. A documentation waiver is not available in profile '${profile}'.\n` +
        `    Set DEVWF_TOOL_PROFILE=full (or update the documentation) and re-run this check.\n\n`) +
    `Tidak ada yang di-commit.`
  );
}
