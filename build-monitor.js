import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const buildMonitor = require("./monitor-server/build-monitor.cjs");

export const {
  VALID_BUILD_STATUSES,
  normalizeBuildState,
  formatBuildStatusBlock,
  extractActiveBuildFromEvents,
  formatElapsedShort,
  statusBadge,
} = buildMonitor;
