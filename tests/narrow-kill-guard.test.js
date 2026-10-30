import test from "node:test";
import assert from "node:assert";

// Kenapa tes ini ada:
//
// Aturan guard yang terpasang pada 30 Oktober 2026 memblokir SEMUA kill-by-name.
// Analisis 21.462 perintah agen (docs/SHELL-PERMISSION-ALLOWLIST-ANALYSIS.md)
// menunjukkan hanya SATU yang benar-benar berbahaya bagi MCP:
//
//   taskkill /F /IM node.exe /T
//
// Tiga lainnya menyasar proses lain dan aman untuk MCP:
//
//   Stop-Process -Name "codex","opencode" -Force
//   taskkill /f /im codex.exe; taskkill /f /im opencode.exe
//   taskkill /F /IM git.exe
//
// Tes ini mengunci perilaku aturan SEMPIT yang diusulkan: hanya membunuh proses
// bernama node yang perlu ditahan, sisanya dibiarkan.

const NARROW_PATTERNS = [
  "taskkill */IM node*",
  "taskkill */im node*",
  "Stop-Process *-Name*node*",
  "stop-process *-name*node*",
  "Get-Process node*| Stop-Process*",
  "Get-Process *| Stop-Process*node*",
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

function blockedBy(command) {
  return NARROW_PATTERNS.some((pattern) => matches(pattern, command));
}

test("aturan sempit menahan perintah yang benar-benar menjatuhkan MCP", async (t) => {
  // Satu-satunya perintah dari log yang mematikan ketiga MCP dalam 386ms.
  const lethal = [
    "taskkill /F /IM node.exe /T",
    "taskkill /f /im node.exe",
    "taskkill /IM node.exe /T",
    "taskkill /F /IM node.exe /T 2>$null; Write-Host done",
  ];

  await t.test("taskkill yang menyasar node diblokir", () => {
    for (const command of lethal) {
      assert.equal(blockedBy(command), true, `harus diblokir: ${JSON.stringify(command)}`);
    }
  });

  await t.test("Stop-Process -Name yang menyebut node diblokir", () => {
    for (const command of [
      "Stop-Process -Name node -Force",
      "Stop-Process -Name node.exe -Force",
      "stop-process -name node",
    ]) {
      assert.equal(blockedBy(command), true, `harus diblokir: ${JSON.stringify(command)}`);
    }
  });
});

test("aturan sempit membiarkan perintah yang aman bagi MCP", async (t) => {
  const harmless = [
    // Benar-benar pernah dijalankan, dan tidak berbahaya bagi MCP.
    "taskkill /f /im codex.exe",
    "taskkill /f /im opencode.exe",
    "taskkill /F /IM git.exe",
    'Stop-Process -Name "codex","opencode" -Force',
    "Get-Process scrcpy | Stop-Process -Force",
    // Bentuk per-PID tetap sah.
    "taskkill /PID 12345 /F",
    "Stop-Process -Id 12345 -Force",
    // Perintah biasa.
    "npm test",
    "git status",
  ];

  await t.test("kill-by-name selain node dibiarkan", () => {
    for (const command of harmless) {
      assert.equal(blockedBy(command), false, `tidak boleh diblokir: ${JSON.stringify(command)}`);
    }
  });
});

test("aturan sempit lebih presisi daripada aturan lebar", () => {
  const wide = ["taskkill */IM *", "taskkill */im *"];

  // Kasus nyata: satu berbahaya, tiga tidak.
  const realWorld = [
    "taskkill /F /IM node.exe /T", // berbahaya
    "taskkill /f /im codex.exe", // aman
    "taskkill /f /im opencode.exe", // aman
    "taskkill /F /IM git.exe", // aman
  ];

  const wideBlocked = realWorld.filter((c) => wide.some((p) => matches(p, c))).length;
  const narrowBlocked = realWorld.filter((c) => blockedBy(c)).length;

  assert.equal(wideBlocked, 4, "aturan lebar memblokir keempatnya");
  assert.equal(narrowBlocked, 1, "aturan sempit hanya memblokir yang berbahaya");
  assert.ok(
    narrowBlocked < wideBlocked,
    "inilah alasan persempitan: presisi, bukan kehati-hatian yang lebih besar",
  );
});

test("aturan sempit tetap tidak bisa menangkap perintah dinamis", () => {
  // Keterbatasan yang sama pada kedua pilihan; dicatat supaya tidak dilupakan.
  const dynamic = '$cmd = "Stop-Pro" + "cess"; & $cmd -Name node';
  assert.equal(blockedBy(dynamic), false, "pola teks tidak bisa membaca perakitan runtime");
});
