import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = readFileSync(path.join(ROOT, "scripts", "deploy-monitor.ps1"), "utf8");
const { visibleMachines } = require("../monitor-server/machines-query.cjs");

test("the deploy script never strips read access from its own SSH key", () => {
  // Proven on Windows: granting only SYSTEM makes the private key unreadable to
  // the process that runs ssh, so every upload fails with "Permission denied".
  assert.doesNotMatch(SCRIPT, /\*S-1-5-17-18:F/i);
  assert.doesNotMatch(SCRIPT, /\/inheritance:r\s*\/grant:r\s*'\*S-1-5-18:F'/i);
  assert.match(SCRIPT, /icacls\.exe/);
  assert.match(SCRIPT, /\$aclKeyPath|RUNNER_TEMP/);
});

test("the SSH key is never uploaded before it is readable", () => {
  // The upload reads the key, therefore the ACL must be applied, and read
  // access asserted, before the first upload call in the script body.
  const aclIndex = SCRIPT.indexOf("icacls.exe");
  const readabilityCheck = SCRIPT.indexOf("Get-Content -LiteralPath $keyPath");
  const uploadIndex = SCRIPT.indexOf("Send-DeployFile $artifact.Local");
  assert.ok(aclIndex > -1, "icacls step missing");
  assert.ok(readabilityCheck > -1, "readability assertion missing");
  assert.ok(uploadIndex > -1, "upload call missing");
  assert.ok(aclIndex < uploadIndex, "ACL must be applied before the first upload");
  assert.ok(readabilityCheck < uploadIndex, "read access must be asserted before the first upload");
});

test("the retired machine filter tolerates the driver's Date objects", () => {
  // node-postgres returns timestamptz as Date. The production row is a Date, so
  // a string-only comparison silently keeps the retired machine visible.
  const rows = [
    { machine: "uji", last_seen: new Date("2026-11-03T10:10:45.095Z") },
    { machine: "MMCH", last_seen: new Date("2026-11-09T17:54:33.120Z") },
  ];
  assert.deepEqual(visibleMachines(rows).map((row) => row.machine), ["MMCH"]);
});

test("the same timestamp in any driver representation is filtered", () => {
  const expected = "2026-11-03T10:10:45.095Z";
  const rows = [
    { machine: "uji", last_seen: new Date(expected) },
    { machine: "uji", last_seen: expected },
    { machine: "uji", last_seen: Date.parse(expected) },
    { machine: "uji", last_seen: "2026-11-03T10:10:45.095+00:00" },
  ];
  assert.deepEqual(visibleMachines(rows), []);
});

test("the deploy publishes every module the changed artifacts require", () => {
  // dashboard.cjs requires machines-query.cjs, and machines-query.cjs is the
  // only file that changed. Both must be in the install allowlist.
  assert.match(SCRIPT, /machines\.devwf|machines-query\.cjs/);
  assert.match(SCRIPT, /monitor-server\/dashboard\.cjs/);
});

test("verification fails when the deployed artifacts did not change", () => {
  assert.match(SCRIPT, /previous/i);
  assert.match(SCRIPT, /rollback|restore/i);
});

test("remote commands cannot hang waiting on inherited stdin", () => {
  // Proven during the MMCH rehearsal: a captured `& ssh.exe ...` froze on the
  // runner while the remote command had already returned. Remote commands must
  // close stdin, carry liveness options, and be waited on with redirected
  // streams instead of a captured pipeline. `scp` has no `-n`, so it needs its
  // own guarded option set rather than sharing the ssh one.
  assert.match(SCRIPT, /'-n',\s*'-i'/);
  assert.match(SCRIPT, /ServerAliveInterval/);
  assert.match(SCRIPT, /ServerAliveCountMax/);
  assert.match(SCRIPT, /ConnectTimeout/);
  assert.match(SCRIPT, /Start-Process/);
  assert.match(SCRIPT, /RedirectStandardOutput/);
  assert.doesNotMatch(SCRIPT, /& ssh\.exe\s+@sshOptions/);
  assert.match(SCRIPT, /\$scpOptions\s*=\s*@\('-q'/);
  assert.doesNotMatch(SCRIPT, /scp\.exe'[^\n]*@sshOptions/);
});
