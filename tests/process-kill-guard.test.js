import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Kenapa tes ini ada:
//
// `playwright`, `dev-workflow`, dan `clinic-helper` sempat mati bersamaan
// dengan pesan "MCP server process exited with code 1". Ternyata bukan bug
// MCP-nya: agen menjalankan `taskkill /F /IM node.exe`, dan setiap MCP server
// adalah proses Node. Tiga proses playwright mati dalam 26 milidetik.
//
// Guard-nya adalah aturan permission di config OpenCode global. Tes ini menjaga
// dua hal:
//   1. aturan itu masih ada di config;
//   2. polanya masih cocok dengan bentuk perintah yang benar-benar membunuh
//      seluruh MCP, dan TIDAK cocok dengan bentuk per-PID yang sah.

const CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "opencode.json");

/** Bentuk perintah nyata yang pernah membunuh MCP (lihat docs/MCP-PROCESS-SAFETY.md). */
const DANGEROUS_COMMANDS = [
  "taskkill /F /IM node.exe /T",
  "taskkill /F /IM node.exe",
  "taskkill /f /im codex.exe",
  "taskkill /IM node.exe /T",
  "Stop-Process -Name node -Force",
  "Stop-Process -Name node.exe",
  "stop-process -name node",
  "Get-Process node | Stop-Process -Force",
  "Get-Process -Name node | Stop-Process",
];

/**
 * Bentuk yang harus tetap boleh berjalan.
 *
 * Catatan: bentuk pipa `Get-Process -Id 12345 | Stop-Process` sengaja TIDAK
 * ada di sini. Aturan pipa tidak bisa membedakan pemilihan berdasarkan `-Id`
 * dari pemilihan berdasarkan nama, jadi bentuk pipa diblokir seluruhnya dan
 * pemakaian yang sah diminta memakai `Stop-Process -Id <pid>` langsung.
 */
const SAFE_COMMANDS = [
  "taskkill /PID 12345 /F",
  "taskkill /pid 12345 /f",
  "taskkill /PID 999999 /F /T",
  "Stop-Process -Id 12345 -Force",
  "Stop-Process -Id 12345",
  "npm test",
  "git status",
];

/**
 * Padanan wildcard OpenCode: `*` = nol atau lebih karakter.
 *
 * Dokumentasi menambahkan satu aturan khusus: pola yang berakhir dengan ` *`
 * juga cocok dengan perintah TANPA argumen (`"git status *"` cocok untuk
 * `git status`). Pemodelan itu ikut diuji di sini supaya guard tidak
 * diam-diam bergantung pada perilaku yang salah dipahami.
 */
function matches(pattern, value) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = pattern.split("*").map(escape).join(".*");

  if (new RegExp(`^${source}$`, "i").test(value)) {
    return true;
  }

  if (pattern.endsWith(" *")) {
    return new RegExp(`^${escape(pattern.slice(0, -2))}$`, "i").test(value);
  }

  return false;
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

function denyPatterns(config) {
  const rules = Array.isArray(config?.permissions) ? config.permissions : [];
  return rules
    .filter((rule) => rule?.action === "shell" && rule?.effect === "deny")
    .map((rule) => rule.resource);
}

test("config global OpenCode masih memuat guard kill-by-image-name", async (t) => {
  const config = readConfig();

  if (!config) {
    t.skip(`config tidak terbaca di ${CONFIG_PATH}`);
    return;
  }

  const patterns = denyPatterns(config);
  assert.ok(
    patterns.length > 0,
    "config harus memuat setidaknya satu aturan shell deny untuk perintah pembunuh proses",
  );

  await t.test("setiap perintah berbahaya tertangkap minimal satu aturan", () => {
    for (const command of DANGEROUS_COMMANDS) {
      const blocked = patterns.some((pattern) => matches(pattern, command));
      assert.equal(
        blocked,
        true,
        `tidak ada aturan yang memblokir ${JSON.stringify(command)}; aturan saat ini: ${JSON.stringify(patterns)}`,
      );
    }
  });

  await t.test("bentuk per-PID yang sah tidak ikut diblokir", () => {
    for (const command of SAFE_COMMANDS) {
      const blocked = patterns.some((pattern) => matches(pattern, command));
      assert.equal(
        blocked,
        false,
        `aturan terlalu luas: ${JSON.stringify(command)} seharusnya tetap boleh berjalan`,
      );
    }
  });
});

test("pola guard yang didokumentasikan menutup bentuk perintah yang pernah gagal", async (t) => {
  // Pola yang sama dengan docs/MCP-PROCESS-SAFETY.md, diuji tanpa perlu config.
  const documented = [
    "taskkill */IM *",
    "taskkill */im *",
    "taskkill */F /IM *",
    "taskkill */f /im *",
    "Stop-Process *-Name*",
    "stop-process *-name*",
    "ps *Stop-Process*-Name*",
    "Get-Process *| Stop-Process*",
    "Get-Process *|Stop-Process*",
    "gps *| spps*",
    "killall *",
    "pkill *",
    "wmic process *delete*",
  ];

  await t.test("menangkap semua bentuk berbahaya", () => {
    for (const command of DANGEROUS_COMMANDS) {
      assert.equal(
        documented.some((pattern) => matches(pattern, command)),
        true,
        `pola terdokumentasi tidak menutup ${JSON.stringify(command)}`,
      );
    }
  });

  await t.test("tidak menangkap bentuk per-PID", () => {
    for (const command of SAFE_COMMANDS) {
      assert.equal(
        documented.some((pattern) => matches(pattern, command)),
        false,
        `pola terdokumentasi terlalu luas untuk ${JSON.stringify(command)}`,
      );
    }
  });

  await t.test("bentuk pipa diblokir walau memilih berdasarkan -Id", () => {
    // Keterbatasan yang disengaja: aturan pola tidak bisa membedakan
    // `Get-Process -Id 1` dari `Get-Process -Name node` di dalam pipa.
    // Bentuk pipa diblokir seluruhnya, dan pemakaian sah diarahkan ke
    // `Stop-Process -Id <pid>`.
    for (const command of [
      "Get-Process -Id 12345 | Stop-Process",
      "Get-Process node | Stop-Process -Force",
    ]) {
      assert.equal(
        documented.some((pattern) => matches(pattern, command)),
        true,
        `bentuk pipa harus diblokir: ${JSON.stringify(command)}`,
      );
    }
  });

  await t.test("wildcard `*` cocok juga dengan nol karakter", () => {
    // OpenCode: `*` = nol atau lebih karakter, termasuk `/`.
    assert.equal(matches("taskkill */IM *", "taskkill /IM node.exe"), true);
    assert.equal(matches("taskkill *", "taskkill"), true);
  });
});
