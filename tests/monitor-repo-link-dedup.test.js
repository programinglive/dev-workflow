import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { renderTaskMetadata } = require("../monitor-server/task-metadata.cjs");

const session = {
  machine: "HELLOWORLD",
  agent_tool: "opencode",
  task: "Repair stale monitor session controls",
  repo_path: "D:/code/dev-workflow-mcp-server",
  repo_remote: "https://github.com/programinglive/dev-workflow-mcp-server",
  repo_url: "https://github.com/programinglive/dev-workflow-mcp-server",
  repo_label: "programinglive/dev-workflow-mcp-server",
};

test("the repository URL is printed once across the whole card", () => {
  // A card is the metadata block plus the clickable repository chip that
  // dashboard.cjs renders next to it. The owner reported the same git link
  // appearing twice, so the combined card must contain the address once.
  const chip = `<a class="repo-link" href="${session.repo_url}">🔗 ${session.repo_label} ↗</a>`;
  const card = renderTaskMetadata(session) + chip;
  const occurrences = card.split(session.repo_url).length - 1;
  assert.equal(occurrences, 1, `repository URL rendered ${occurrences} times on the card`);
});

test("the metadata line carries the local path, not a second link", () => {
  const html = renderTaskMetadata(session);
  assert.equal(html.split(session.repo_url).length - 1, 0, "metadata must not repeat the chip URL");
  assert.equal(html.split(session.repo_path).length - 1, 1, "metadata must show the path once");
});

test("a card with only a remote still shows exactly one address", () => {
  const noPath = { ...session, repo_path: "" };
  const chip = `<a class="repo-link" href="${noPath.repo_url}">🔗 ${noPath.repo_label} ↗</a>`;
  const card = renderTaskMetadata(noPath) + chip;
  assert.equal(card.split(noPath.repo_url).length - 1, 1);
});
