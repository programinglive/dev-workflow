import { test } from "node:test";
import assert from "node:assert";

import { stripNpmNotices } from "./test-helpers.js";

// The build test asserts that the vite build produced no unexpected stderr.
// npm itself can emit `npm warn` lines (for example a user-level .npmrc setting
// that does not apply to this project). Those are not build errors, and letting
// them fail the suite makes a clean build look broken on some machines.

test("stripNpmNotices removes npm warn lines", () => {
  const stderr = [
    "npm warn install-scripts .npmrc allow-scripts setting is being ignored because --allow-scripts was passed on the command line",
    "npm warn Unknown user config \"legacy-peer-deps\".",
  ].join("\n");

  assert.strictEqual(stripNpmNotices(stderr).trim(), "");
});

test("stripNpmNotices removes npm notice and npm error headings that are not build failures", () => {
  const stderr = ["npm notice", "npm notice New minor version of npm available!"].join("\n");

  assert.strictEqual(stripNpmNotices(stderr).trim(), "");
});

test("stripNpmNotices keeps real build errors", () => {
  const stderr = [
    "npm warn some config noise",
    "error during build:",
    "RollupError: Could not resolve \"./missing.js\" from src/index.js",
  ].join("\n");

  const cleaned = stripNpmNotices(stderr);

  assert.match(cleaned, /error during build/);
  assert.match(cleaned, /Could not resolve/);
  assert.doesNotMatch(cleaned, /npm warn/);
});

test("stripNpmNotices strips ANSI colour codes", () => {
  const stderr = "\u001b[31merror during build\u001b[39m";

  assert.strictEqual(stripNpmNotices(stderr), "error during build");
});

test("stripNpmNotices removes Rollup annotation warnings from third-party code", () => {
  const stderr = [
    "node_modules/zod/v4/core/util.js (400:0): A comment",
    "",
    '"// Wrapped in a `@__PURE__` IIFE: esbuild never tree-shakes."',
    "",
    'in "node_modules/zod/v4/core/util.js" contains an annotation that Rollup cannot interpret due to the position of the comment. The comment will be removed to avoid issues.',
  ].join("\n");

  assert.strictEqual(stripNpmNotices(stderr).trim(), "");
});

test("stripNpmNotices handles empty input", () => {
  assert.strictEqual(stripNpmNotices(""), "");
});
