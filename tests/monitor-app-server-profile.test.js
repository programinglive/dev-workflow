import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(ROOT, "mobile-app", "App.js");
const appSource = readFileSync(appPath, "utf8");

test("App.js integrates server-profile module", () => {
  assert.match(
    appSource,
    /import\s*\{[\s\S]*?ServerProfileStore[\s\S]*?normalizeServerUrl[\s\S]*?testServerConnection[\s\S]*?\}\s*from\s*["']\.\/server-profile["']/,
    "App.js must import headless server-profile utilities"
  );
  assert.match(
    appSource,
    /export\s+const\s+profileStore\s*=\s*new\s+ServerProfileStore/,
    "App.js must instantiate and export profileStore"
  );
});

test("App.js wires dynamic monitorUrl state into polling and requests", () => {
  assert.match(
    appSource,
    /const\s*\[monitorUrl,\s*setMonitorUrl\]\s*=\s*useState/,
    "App.js must manage monitorUrl in React state for runtime switching"
  );
  assert.match(
    appSource,
    /const\s+MONITOR_URL\s*=\s*monitorUrl;/,
    "App.js must bind MONITOR_URL to dynamic state"
  );
  assert.match(
    appSource,
    /useCallback\(async\s*\(\)\s*=>\s*\{[\s\S]*?fetch\(MONITOR_URL\s*\+\s*"\/api\/sessions"/,
    "ambil() must fetch sessions from dynamic MONITOR_URL"
  );
});

test("App.js provides accessible triggers to switch server", () => {
  assert.match(
    appSource,
    /<ModalServer/,
    "App.js must render ModalServer component"
  );
  assert.match(
    appSource,
    /function\s+ModalServer\s*\(/,
    "App.js must declare ModalServer component"
  );
  assert.match(
    appSource,
    /⚙\s*Ganti\s*Server\s*Monitor/,
    "Info tab must contain a button to open server configuration"
  );
  assert.match(
    appSource,
    /⚙\s*Ganti\s*Alamat\s*Server/,
    "Connection error banner must provide immediate server change button"
  );
});

test("DetailSesi and Kartu accept dynamic monitorUrl prop", () => {
  assert.match(
    appSource,
    /<DetailSesi[\s\S]*?monitorUrl=\{MONITOR_URL\}/,
    "App must pass monitorUrl prop to DetailSesi modal"
  );
  assert.match(
    appSource,
    /function\s+DetailSesi\s*\(\{[\s\S]*?monitorUrl/,
    "DetailSesi must declare monitorUrl parameter"
  );
  assert.match(
    appSource,
    /function\s+Kartu\s*\(\{[\s\S]*?monitorUrl/,
    "Kartu must declare monitorUrl parameter"
  );
});
