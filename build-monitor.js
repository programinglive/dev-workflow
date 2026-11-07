import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const monitorModulePath = existsSync(path.join(currentDir, "monitor-server", "build-monitor.cjs"))
  ? "./monitor-server/build-monitor.cjs"
  : "../monitor-server/build-monitor.cjs";
const buildMonitor = require(monitorModulePath);

export const {
  VALID_BUILD_STATUSES,
  normalizeBuildState,
  formatBuildStatusBlock,
  extractActiveBuildFromEvents,
  formatElapsedShort,
  statusBadge,
} = buildMonitor;
