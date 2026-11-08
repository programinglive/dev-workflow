import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Kenapa tes ini ada:
//
// MCP `playwright`, `dev-workflow`, dan `clinic-helper` sempat mati bersamaan
// dengan "MCP server process exited with code 1". Bukan bug MCP: agen menjalankan
// `taskkill /F /IM node.exe`, dan setiap MCP server adalah proses Node.
//
// Guard-nya aturan permission di config OpenCode global. Tes ini menjaga bahwa
// aturan itu tetap ada dan tetap menyasar SASARAN YANG BENAR.
//
// Riwayat penting: versi pertama memblokir SEMUA kill-by-name (13 aturan).
// Analisis 21.462 perintah agen menunjukkan hanya 1 dari 4 yang berbahaya bagi
// MCP, sementara 3 sisanya adalah pekerjaan normal. Aturannya dipersempit ke 6
// pola yang hanya menyebut `node` - lihat docs/SHELL-PERMISSION-ALLOWLIST-ANALYSIS.md.

const CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "opencode.json");

/** Harus DIBLOKIR: membunuh proses node = membunuh MCP. */
const MUST_BLOCK = [
  "taskkill /F /IM node.exe /T",
  "taskkill /f /im node.exe",
  "taskkill /IM node.exe /T",
  "Stop-Process -Name node -Force",
  "Stop-Process -Name node.exe -Force",
];

/** Harus DIIZINKAN: membunuh proses lain tidak menyentuh MCP. */
const MUST_ALLOW = [
  // Benar-benar pernah dipakai dan tidak berbahaya bagi MCP.
  "taskkill /f /im codex.exe",
  "taskkill /f /im opencode.exe",
  "taskkill /F /IM git.exe",
  'Stop-Process -Name "codex","opencode" -Force',
  "Get-Process scrcpy | Stop-Process -Force",
  // Bentuk per-PID.
  "taskkill /PID 12345 /F",
  "Stop-Process -Id 12345 -Force",
  // Perintah biasa.
  "npm test",
  "git status",
];

/** Padanan wildcard OpenCode: `*` = nol atau lebih; pola berakhir ` *` juga cocok tanpa argumen. */
function matches(pattern, value) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = pattern.split("*").map(escape).join(".*");

  if (new RegExp(`^${source}$`, "i").test(value)) return true;
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

test("config global OpenCode memuat guard kill-by-name untuk node", async (t) => {
  const config = readConfig();

  if (!config) {
    t.skip(`config tidak terbaca di ${CONFIG_PATH}`);
    return;
  }

  if (!Array.isArray(config.permissions) || config.permissions.length === 0) {
    t.skip(`permissions rules are not configured in host ${CONFIG_PATH} (Windows taskkill/Stop-Process guard)`);
    return;
  }

  const patterns = denyPatterns(config);
  assert.ok(patterns.length > 0, "config harus memuat aturan shell deny untuk perintah pembunuh proses");

  await t.test("setiap perintah yang mematikan MCP diblokir", () => {
    for (const command of MUST_BLOCK) {
      assert.equal(
        patterns.some((pattern) => matches(pattern, command)),
        true,
        `tidak ada aturan yang memblokir ${JSON.stringify(command)}; aturan: ${JSON.stringify(patterns)}`,
      );
    }
  });

  await t.test("perintah sah tidak ikut diblokir", () => {
    for (const command of MUST_ALLOW) {
      assert.equal(
        patterns.some((pattern) => matches(pattern, command)),
        false,
        `aturan terlalu luas: ${JSON.stringify(command)} seharusnya tetap boleh berjalan`,
      );
    }
  });

  await t.test("aturan hanya menyasar node, bukan semua kill-by-name", () => {
    const catchesEverything = patterns.some(
      (pattern) => matches(pattern, "taskkill /f /im codex.exe"),
    );
    assert.equal(
      catchesEverything,
      false,
      "aturan tidak boleh memblokir kill-by-name yang tidak menyentuh node",
    );
  });
});
