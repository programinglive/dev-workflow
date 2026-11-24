import test from "node:test";
import assert from "node:assert/strict";

import { scanSecrets } from "../security/scanner.js";
import { assertSafeKnowledge } from "../security/policy.js";

test("GitHub OIDC permission assignments are not treated as credentials", () => {
  const benign = [
    "id-token: write",
    "id-token: read",
    "id-token: none",
    "permissions:\n  id-token: write\n  contents: read",
    "combined with `id-token: write` permission",
  ];
  for (const text of benign) assert.deepEqual(scanSecrets(text), [], text);
});

test("history projections containing OIDC permission prose remain writable", () => {
  const payload = { history: [{ commitMessage: "ci: grant id-token: write in publish workflow" }] };
  assert.doesNotThrow(() => assertSafeKnowledge(payload));
});

test("a real credential assigned to id-token is still rejected", () => {
  assert.ok(scanSecrets("id-token: actual-secret-value").length > 0);
});

test("ordinary sensitive assignments are still rejected", () => {
  assert.ok(scanSecrets("password: hunter2").length > 0);
});
