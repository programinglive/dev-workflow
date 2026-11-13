#!/usr/bin/env node
/**
 * Apakah dev-workflow MCP yang sedang dipakai sudah ketinggalan?
 *
 * MENGAPA DUA SUMBER
 * ------------------
 * `README.md` mendukung dua cara pasang, dan "update" berarti hal berbeda:
 *   - lewat `git clone`  -> `origin` punya commit yang belum ada di lokal
 *   - lewat npm          -> `latest` di registry lebih tinggi dari `package.json`
 *
 * Pada 1 November 2026 clone di mesin pemilik proyek berada di 1.15.1 sementara
 * npm `latest` masih 1.15.0. Arahnya bisa dua-duanya, jadi skrip ini
 * MEMBANDINGKAN dan melaporkan, bukan menyimpulkan salah satu.
 *
 * MENGAPA TIDAK DIJALANKAN OTOMATIS
 * ----------------------------------
 * Tidak ada pemeriksaan jaringan saat MCP berjalan dan tidak ada baris di
 * `get_workflow_status`: jalur tool yang dipanggil paling sering tidak boleh
 * menunggu jaringan.
 *
 * Inti keputusan (`buildReport`) murni supaya bisa diuji tanpa jaringan.
 */

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const PACKAGE_NAME = "@programinglive/dev-workflow-mcp-server";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const TIMEOUT_MS = 5000;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function compareVersions(a, b) {
  const parse = (value) => {
    const [core, ...rest] = String(value ?? "").trim().split("-");
    return {
      parts: core.split(".").map((piece) => Number.parseInt(piece, 10) || 0),
      prerelease: rest.join("-"),
    };
  };

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.parts.length, right.parts.length);

  for (let index = 0; index < length; index += 1) {
    const l = left.parts[index] ?? 0;
    const r = right.parts[index] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }

  // Versi tanpa sufiks menang atas versi dengan sufiks.
  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease && right.prerelease) return 1;
  return 0;
}

/**
 * Susun laporan dari hasil ketiga pemeriksaan.
 *
 * `errors` berisi kegagalan per sumber. Exit code 2 berarti TIDAK ADA satu pun
 * sumber yang berhasil diperiksa - itu berbeda dari "tidak ada update", dan
 * membedakannya adalah inti kejujuran skrip ini.
 */
export function buildReport({ localVersion, npmVersion, localSha, remoteSha, errors = [] } = {}) {
  const findings = [];
  const list = Array.isArray(errors) ? errors.filter(Boolean) : [];

  const gitChecked = Boolean(localSha && remoteSha);
  const npmChecked = Boolean(npmVersion);

  let needsUpdate = false;

  if (!gitChecked) {
    findings.push({ level: "unknown", message: "Clone: tidak bisa diperiksa." });
  } else if (localSha !== remoteSha) {
    needsUpdate = true;
    // SHA berbeda hanya berarti TIDAK SINKRON. Arahnya tidak bisa diketahui
    // dari dua SHA saja: lokal bisa tertinggal, bisa juga lebih maju dengan
    // commit yang belum di-push. Menyimpulkan "tertinggal" lalu menyarankan
    // `git pull` justru berbahaya di kasus kedua.
    findings.push({
      level: "update",
      message:
        `Clone TIDAK SINKRON dengan origin (lokal ${String(localSha).slice(0, 7)}, ` +
        `remote ${String(remoteSha).slice(0, 7)}) - arah belum diketahui.`,
    });
  } else {
    findings.push({ level: "ok", message: `Clone: sinkron dengan origin (${String(localSha).slice(0, 7)}).` });
  }

  if (!npmChecked) {
    findings.push({ level: "unknown", message: "npm: tidak bisa diperiksa." });
  } else {
    const order = compareVersions(npmVersion, localVersion);
    if (order > 0) {
      needsUpdate = true;
      findings.push({
        level: "update",
        message: `npm punya versi lebih baru: ${npmVersion} (terpasang ${localVersion}).`,
      });
    } else if (order < 0) {
      findings.push({
        level: "ok",
        message: `npm: versi terpasang (${localVersion}) lebih baru dari rilis publik (${npmVersion}).`,
      });
    } else {
      findings.push({ level: "ok", message: `npm: ${npmVersion} sama dengan versi terpasang.` });
    }
  }

  const checkedCount = (gitChecked ? 1 : 0) + (npmChecked ? 1 : 0);
  let exitCode;
  if (checkedCount === 0) {
    exitCode = 2;
  } else {
    exitCode = needsUpdate ? 1 : 0;
  }

  const lines = ["dev-workflow MCP — pemeriksaan versi", ""];
  lines.push(`Terpasang : ${localVersion || "(tidak diketahui)"}`);
  lines.push(`npm latest: ${npmVersion || "(tidak bisa diperiksa)"}`);
  lines.push("");

  for (const finding of findings) {
    const icon = finding.level === "ok" ? "✅" : finding.level === "update" ? "⚠️" : "❔";
    lines.push(`${icon} ${finding.message}`);
  }

  if (list.length > 0) {
    lines.push("");
    lines.push("Sumber yang gagal:");
    for (const error of list) {
      lines.push(`   • ${error}`);
    }
    lines.push("Tidak bisa diperiksa bukan berarti mutakhir.");
  }

  lines.push("");

  if (exitCode === 2) {
    lines.push("Tidak ada satu pun sumber yang berhasil diperiksa (exit 2).");
  } else if (exitCode === 1) {
    lines.push("Perbarui:");
    if (gitChecked && localSha !== remoteSha) {
      lines.push(`  cd ${ROOT}`);
      lines.push("  git log --oneline origin/HEAD..HEAD   # commit lokal yang belum ter-push");
      lines.push("  git log --oneline HEAD..origin/HEAD   # commit remote yang belum di lokal");
      lines.push("  git pull   # bila remote lebih maju");
      lines.push("  git push   # bila lokal lebih maju");
      lines.push("  npm install");
    }
    if (npmChecked && compareVersions(npmVersion, localVersion) > 0) {
      lines.push(`  npm install -g ${PACKAGE_NAME}@latest`);
    }
    lines.push("  lalu restart proses MCP (kode lama tetap di memori sampai proses mati)");
  } else {
    lines.push("Tidak ada yang perlu diperbarui.");
  }

  return {
    exitCode,
    findings,
    human: lines.join("\n"),
    json: {
      localVersion: localVersion || "",
      npmVersion: npmVersion || "",
      localSha: localSha || "",
      remoteSha: remoteSha || "",
      needsUpdate,
      errors: list,
      exitCode,
    },
  };
}

async function readLocalVersion() {
  const raw = await readFile(path.join(ROOT, "package.json"), "utf8");
  return JSON.parse(raw).version || "";
}

async function readGitShas() {
  const { stdout: local } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    timeout: TIMEOUT_MS,
  });
  const { stdout: remoteOut } = await execFileAsync("git", ["ls-remote", "origin", "HEAD"], {
    cwd: ROOT,
    timeout: TIMEOUT_MS,
  });
  return {
    localSha: String(local).trim(),
    remoteSha: String(remoteOut).trim().split(/\s+/)[0] || "",
  };
}

async function readNpmVersion() {
  if (typeof fetch !== "function") {
    throw new Error("fetch tidak tersedia di Node ini");
  }
  const response = await fetch(REGISTRY_URL, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`registry menjawab HTTP ${response.status}`);
  }
  const body = await response.json();
  return String(body.version || "");
}

export async function main(argv = process.argv) {
  const asJson = argv.includes("--json");
  const errors = [];

  let localVersion = "";
  try {
    localVersion = await readLocalVersion();
  } catch (error) {
    errors.push(`package.json: ${error.message}`);
  }

  let localSha = "";
  let remoteSha = "";
  try {
    const shas = await readGitShas();
    localSha = shas.localSha;
    remoteSha = shas.remoteSha;
  } catch (error) {
    // Instalasi lewat npm tidak punya `.git`; itu bukan kegagalan.
    errors.push(`git: ${error.message}`);
  }

  let npmVersion = "";
  try {
    npmVersion = await readNpmVersion();
  } catch (error) {
    errors.push(`npm: ${error.message}`);
  }

  const report = buildReport({ localVersion, npmVersion, localSha, remoteSha, errors });
  console.log(asJson ? JSON.stringify(report.json, null, 2) : report.human);
  process.exitCode = report.exitCode;
  return report.exitCode;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(`Pemeriksaan gagal: ${error.message}`);
    process.exitCode = 2;
  });
}
