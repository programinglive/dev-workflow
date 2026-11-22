import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const REQUIRED_ONBOARDING_DOCS = [
  "docs/getting-started/installation.md",
  "docs/getting-started/first-task.md",
  "docs/getting-started/setup-wizard.md",
  "docs/integrations/claude-code.md",
  "docs/integrations/codex.md",
  "docs/integrations/opencode.md",
  "docs/integrations/antigravity.md",
  "docs/integrations/generic-mcp-client.md",
  "docs/integrations/android-companion.md",
  "docs/troubleshooting/installation.md",
  "docs/troubleshooting/mcp-connection.md",
  "docs/troubleshooting/authentication.md",
];

test("README.md is universal, local-first, uses public npm install, and has zero broken relative links", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(readme, /npm install -g @programinglive\/dev-workflow/);
  assert.match(readme, /devwf setup/);
  assert.match(readme, /devwf doctor/);
  assert.match(readme, /LOCAL_FIRST_STANDALONE/);
  assert.doesNotMatch(readme, /v1\.29\+/);
  assert.doesNotMatch(readme, /Public npm publication is not yet active/i);

  const linkRe = /\[[^\]]+\]\(([^)#]+)\)/g;
  const broken = [];
  let m;
  while ((m = linkRe.exec(readme)) !== null) {
    const target = m[1].trim();
    if (/^(?:https?:|mailto:)/i.test(target)) continue;
    const resolved = path.resolve(ROOT, target);
    if (!fs.existsSync(resolved)) {
      broken.push(target);
    }
  }
  assert.deepEqual(broken, [], `Broken relative links in README.md: ${broken.join(", ")}`);
});

test("all required universal onboarding, MCP client integration, and troubleshooting docs exist", () => {
  const missing = REQUIRED_ONBOARDING_DOCS.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  assert.deepEqual(missing, [], `Missing required documentation files: ${missing.join(", ")}`);
});
