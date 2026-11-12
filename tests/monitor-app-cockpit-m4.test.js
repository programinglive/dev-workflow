import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(path.join(ROOT, "mobile-app", "App.js"), "utf8");

test("Xiaomi Pad 6 Cockpit UX Optimization (Milestone M4)", async (t) => {
  await t.test("imports cockpit-mode helpers and defines cockpitMode state", () => {
    assert.match(app, /from "\.\/cockpit-mode"/);
    assert.match(app, /const \[cockpitMode, setCockpitMode\] = useState\("cockpit"\)/);
  });

  await t.test("renders the KPI summary strip and 3 mode switcher pills (Cockpit, Focus, Governance)", () => {
    assert.match(app, /COCKPIT_MODES\.map/);
    assert.match(app, /computeCockpitKpis/);
    assert.match(app, /cockpitMode === "cockpit"/);
    assert.match(app, /cockpitMode === "focus"/);
    assert.match(app, /cockpitMode === "governance"/);
  });

  await t.test("enforces >= 48dp minimum touch targets on tablet navigation and mode controls", () => {
    assert.match(app, /minHeight:\s*48/);
    assert.match(app, /MIN_TOUCH_TARGET_DP/);
  });
});
