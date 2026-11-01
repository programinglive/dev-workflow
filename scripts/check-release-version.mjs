#!/usr/bin/env node
/**
 * Apakah tag yang memicu rilis benar-benar cocok dengan versi yang akan
 * diterbitkan?
 *
 * MENGAPA PEMERIKSAAN INI ADA
 * ---------------------------
 * `github-release.yml` checkout `ref: main`, tetapi versi yang diterbitkan
 * diambil dari nama tag. Kalau tag dibuat dari commit yang tidak ada di main,
 * keduanya berbeda dan tidak ada yang menyadarinya sampai npm menolak:
 *
 *   31 Oktober 2026, tag v1.15.1 dibuat dari feat/dod-lock-guard sementara
 *   main masih 1.15.0. Build berhasil, lalu `npm publish` gagal dengan
 *   "You cannot publish over the previously published versions: 1.15.0."
 *   Pesan itu tidak menyebut tag sama sekali, jadi penyebabnya tidak terlihat
 *   dari log rilis.
 *
 * Kegagalan yang jelas dan murah lebih baik daripada kegagalan npm setelah
 * lima menit build. Karena itu pemeriksaan ini dijalankan sebelum `npm ci`
 * dan sebelum `npm publish`.
 *
 * Inti keputusan (`checkReleaseVersion`) murni supaya bisa diuji tanpa
 * menyentuh file asli maupun registry.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function normalizeVersion(tag) {
  return String(tag ?? "").trim().replace(/^v/i, "");
}

export function checkReleaseVersion({ tag, packageVersion }) {
  const expected = normalizeVersion(tag);
  const actual = String(packageVersion ?? "").trim();

  if (!expected) {
    return {
      ok: false,
      message:
        "Nama tag kosong. Pemeriksaan versi butuh tag (mis. v1.15.1) lewat --tag atau GITHUB_REF_NAME.",
    };
  }

  if (!actual) {
    return {
      ok: false,
      message: `package.json tidak punya field version, jadi tag ${tag} tidak bisa dicocokkan.`,
    };
  }

  if (expected !== actual) {
    return {
      ok: false,
      message: [
        `Tag ${tag} menunjuk versi ${expected}, tetapi package.json berisi ${actual}.`,
        "Workflow rilis membangun dan menerbitkan paket dari isi checkout (main), bukan dari isi tag,",
        "jadi rilis ini akan mencoba menerbitkan versi yang salah.",
        "Perbaikan: jalankan rilis dari main setelah versi package.json di-bump, lalu buat ulang tag.",
      ].join(" "),
    };
  }

  return { ok: true, message: `Tag ${tag} cocok dengan package.json ${actual}.` };
}

async function readPackageVersion(packagePath) {
  const raw = await readFile(packagePath, "utf8");
  const parsed = JSON.parse(raw);
  return parsed.version;
}

async function main(argv = process.argv) {
  const args = argv.slice(2);
  const tagIndex = args.indexOf("--tag");
  const packageIndex = args.indexOf("--package");

  const tag = tagIndex !== -1 ? args[tagIndex + 1] : process.env.GITHUB_REF_NAME;
  const packagePath =
    packageIndex !== -1 ? path.resolve(args[packageIndex + 1]) : path.join(ROOT, "package.json");

  let packageVersion;
  try {
    packageVersion = await readPackageVersion(packagePath);
  } catch (error) {
    console.error(`Tidak bisa membaca ${packagePath}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const result = checkReleaseVersion({ tag, packageVersion });
  if (result.ok) {
    console.log(result.message);
    return;
  }

  console.error(result.message);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
