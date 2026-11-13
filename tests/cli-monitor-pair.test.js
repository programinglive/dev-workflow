import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../cli/args.js";
import { runCommand } from "../cli/commands.js";

test("parseArgs parses pair subcommand with optional --url and --json flags", () => {
  const args = parseArgs(["pair"]);
  assert.equal(args.command, "pair");
  assert.equal(args.json, false);
  assert.equal(args.url, undefined);

  const custom = parseArgs(["pair", "--url", "http://192.168.1.50:3100", "--json"]);
  assert.equal(custom.command, "pair");
  assert.equal(custom.url, "http://192.168.1.50:3100");
  assert.equal(custom.json, true);
});

test("runCommand executes pair and outputs pairing instructions", async () => {
  const lines = [];
  const out = { write: (msg) => lines.push(msg) };

  const res = await runCommand({
    args: { command: "pair", url: "http://127.0.0.1:3100", json: false },
    out,
  });

  assert.equal(res.ok, true);
  const text = lines.join("\n");
  assert.match(text, /devwf:\/\/pair\?v=1/);
  assert.match(text, /Verification Code:/);
  assert.match(text, /\d{3}-\d{3}/);
});

test("runCommand executes pair with --json and outputs parseable JSON", async () => {
  const lines = [];
  const out = { write: (msg) => lines.push(msg) };

  const res = await runCommand({
    args: { command: "pair", url: "http://127.0.0.1:3100", json: true },
    out,
  });

  assert.equal(res.ok, true);
  assert.equal(lines.length, 1);
  const json = JSON.parse(lines[0]);
  assert.equal(json.ok, true);
  assert.ok(json.challengeId.startsWith("ch_"));
  assert.ok(json.qrPayload.startsWith("devwf://pair?v=1"));
  assert.match(json.verificationCode, /^\d{3}-\d{3}$/);
});
