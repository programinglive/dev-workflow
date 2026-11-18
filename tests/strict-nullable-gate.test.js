import test from "node:test";
import assert from "node:assert/strict";
import {
  findUnnormalizedNullableDateAssignments,
  evaluateStrictNullableInputGate,
} from "../tools/handler-modules/status-handlers.js";

test("findUnnormalizedNullableDateAssignments flags bare ?? null on *_date and *_at keys in app/ PHP files", () => {
  const diff = [
    "diff --git a/app/Services/Purchasing/GoodReceiveService.php b/app/Services/Purchasing/GoodReceiveService.php",
    "index 1111111..2222222 100644",
    "--- a/app/Services/Purchasing/GoodReceiveService.php",
    "+++ b/app/Services/Purchasing/GoodReceiveService.php",
    "@@ -190,6 +190,8 @@ class GoodReceiveService",
    "+                    'production_date' => $item['production_date'] ?? null,",
    "+                    'expired_at' => $item['expired_at'] ?? null,",
    "+                    'batch_number' => $this->nullableTrimmed($item['batch_number'] ?? null),",
  ].join("\n");

  const findings = findUnnormalizedNullableDateAssignments(diff);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].file, "app/Services/Purchasing/GoodReceiveService.php");
  assert.match(findings[0].line, /production_date/);
  assert.match(findings[1].line, /expired_at/);
});

test("findUnnormalizedNullableDateAssignments allows normalized expressions and non-app files", () => {
  const diff = [
    "diff --git a/app/Services/Purchasing/GoodReceiveService.php b/app/Services/Purchasing/GoodReceiveService.php",
    "--- a/app/Services/Purchasing/GoodReceiveService.php",
    "+++ b/app/Services/Purchasing/GoodReceiveService.php",
    "+                    'production_date' => $this->nullableTrimmed($item['production_date'] ?? null),",
    "+                    'expired_at' => filled($item['expired_at'] ?? null) ? $item['expired_at'] : null,",
    "-                    'legacy_date' => $item['legacy_date'] ?? null,",
    "diff --git a/tests/Feature/ExampleTest.php b/tests/Feature/ExampleTest.php",
    "--- a/tests/Feature/ExampleTest.php",
    "+++ b/tests/Feature/ExampleTest.php",
    "+                    'production_date' => $item['production_date'] ?? null,",
  ].join("\n");

  const findings = findUnnormalizedNullableDateAssignments(diff);
  assert.deepEqual(findings, []);
});

test("evaluateStrictNullableInputGate skips when projectDir is missing", () => {
  const res = evaluateStrictNullableInputGate({ state: {} });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
});
