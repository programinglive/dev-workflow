import { test } from "node:test";
import assert from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGitFacade } from "../git-facade.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const HANDLER_DIR = path.join(ROOT, "tools", "handler-modules");

/**
 * Regression guard for "git.getStatusOutput is not a function".
 *
 * The handlers receive a `git` object built by index.js. Unit tests inject a
 * mock that provides every method, so a method missing from the real facade
 * only shows up in production. This test reads the handler sources, collects
 * every `git.<name>` they reference, and requires the facade to provide all of
 * them.
 */
async function gitMethodsUsedByHandlers() {
  const files = (await readdir(HANDLER_DIR)).filter((name) => name.endsWith(".js"));
  const used = new Set();

  for (const file of files) {
    const source = await readFile(path.join(HANDLER_DIR, file), "utf-8");
    // Ignore comments so prose about `git.something` cannot add false positives.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const match of code.matchAll(/\bgit\.([A-Za-z_$][\w$]*)/g)) {
      used.add(match[1]);
    }
  }

  return [...used].sort();
}

test("the git facade provides every helper the handlers call", async () => {
  const facade = createGitFacade();
  const used = await gitMethodsUsedByHandlers();

  assert.ok(used.length > 0, "handlers should reference at least one git helper");

  const missing = used.filter((name) => typeof facade[name] !== "function");
  assert.deepStrictEqual(missing, [], `index.js must expose these git helpers: ${missing.join(", ")}`);
});

test("the git facade does not expose undefined values", () => {
  const facade = createGitFacade();
  for (const [name, value] of Object.entries(facade)) {
    assert.strictEqual(typeof value, "function", `git.${name} should be a function`);
  }
});

test("the git facade includes getStatusOutput", () => {
  // commit_and_push uses it to check that a test file is part of the change.
  // It was missing once, which broke every commit through the MCP.
  assert.strictEqual(typeof createGitFacade().getStatusOutput, "function");
});
