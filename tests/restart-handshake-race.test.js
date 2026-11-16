import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Cross-process single-winner proof.
 *
 * A read followed by an atomic replace is NOT a compare-and-swap: two processes
 * can both read "unclaimed" and both replace, and the second silently wins.
 * `link(2)` is the primitive the OS guarantees exactly one creator for, so this
 * test races real processes and asserts a single winner.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, "..", "monitor-server", "restart-handshake-store.cjs");

const childScript = `
const store = require(process.argv[1]);
const stateFile = process.argv[2];
const who = process.argv[3];
const result = store.tryClaimHandshake(stateFile, { sessionKey: who, at: Date.now() });
process.stdout.write(JSON.stringify({ who, ok: result.ok, code: result.code || null }));
`;

function runClaim(stateFile, who) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", childScript, STORE, stateFile, who], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("close", () => {
      try { resolve(JSON.parse(out)); } catch { resolve({ who, ok: false, code: "NO_OUTPUT" }); }
    });
  });
}

test("exactly one of many concurrent processes wins the handover claim", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claim-race-"));
  const stateFile = path.join(dir, "workflow-state.ses_x.json");
  fs.writeFileSync(stateFile, "{}", "utf8");

  const contenders = Array.from({ length: 8 }, (_, i) => `ses_contender_${i}`);
  const results = await Promise.all(contenders.map((who) => runClaim(stateFile, who)));

  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok);

  assert.equal(winners.length, 1, `exactly one winner, got ${winners.length}: ${JSON.stringify(results)}`);
  assert.equal(losers.length, contenders.length - 1);
  assert.ok(losers.every((r) => r.code === "ALREADY_CLAIMED"), JSON.stringify(losers));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a second run after a winner is refused, and the winner survives", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claim-race2-"));
  const stateFile = path.join(dir, "workflow-state.ses_y.json");
  fs.writeFileSync(stateFile, "{}", "utf8");

  const first = await runClaim(stateFile, "ses_first");
  const second = await runClaim(stateFile, "ses_second");
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.code, "ALREADY_CLAIMED");

  const { readClaim } = await import("../monitor-server/restart-handshake-store.cjs");
  assert.equal(readClaim(stateFile).sessionKey, "ses_first");

  fs.rmSync(dir, { recursive: true, force: true });
});
