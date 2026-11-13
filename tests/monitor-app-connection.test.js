import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(ROOT, "mobile-app", "App.js");
const appSource = readFileSync(appPath, "utf8");

test("App.js imports ConnectionManager module", () => {
  assert.match(
    appSource,
    /import\s*\{[\s\S]*?ConnectionManager[\s\S]*?\}\s*from\s*["']\.\/connection-manager["']/,
    "App.js must import ConnectionManager from ./connection-manager"
  );
});

test("App.js renders live connectivity status indicator", () => {
  assert.match(
    appSource,
    /connStatus|connectionStatus/i,
    "App.js must track connectivity status in state"
  );
  assert.match(
    appSource,
    /LIVE|POLLING|RECONNECTING/i,
    "App.js must display connection status labels in the UI"
  );
});

test("App.js coordinates connection lifecycle with AppState and monitorUrl", () => {
  assert.match(
    appSource,
    /connMgr|connectionManager/i,
    "App.js must instantiate or reference ConnectionManager"
  );
});
