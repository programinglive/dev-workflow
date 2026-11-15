import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseEnvFile } from "../scripts/env-file.mjs";
import { dependencyClosure, localRequires } from "../scripts/verify-monitor-deployment.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MONITOR_DIR = path.join(ROOT, "monitor-server");

/**
 * The deployment contract: what the unit actually runs, which files it needs,
 * and how its environment file must be read.
 */

test("the environment file keeps values that contain spaces", () => {
  const env = parseEnvFile("IDLE_TTL=30 minutes\nEMPTY_IDLE_TTL=1 minute\n");
  assert.equal(env.IDLE_TTL, "30 minutes");
  assert.equal(env.EMPTY_IDLE_TTL, "1 minute");
});

test("the environment parser ignores comments, blanks and CRLF", () => {
  const env = parseEnvFile("# comment\r\n\r\nDATABASE_URL=postgres://x@127.0.0.1:5432/db\r\n");
  assert.deepEqual(env, { DATABASE_URL: "postgres://x@127.0.0.1:5432/db" });
});

test("the environment parser strips matching quotes and keeps inner spaces", () => {
  const env = parseEnvFile('A="two words"\nB=\'three words\'\nC=plain\n');
  assert.equal(env.A, "two words");
  assert.equal(env.B, "three words");
  assert.equal(env.C, "plain");
});

test("the environment parser never executes a value", () => {
  const env = parseEnvFile("X=$(touch /tmp/should-not-exist)\n");
  assert.equal(env.X, "$(touch /tmp/should-not-exist)");
});

test("the environment parser rejects a line without a key", () => {
  assert.deepEqual(parseEnvFile("=novalue\nnot a pair\n"), {});
});

test("the deployed entrypoint's dependency closure is complete in the repository", async () => {
  // The unit runs monitor.cjs, which is dashboard.cjs under its deployed name.
  const closure = await dependencyClosure({ entry: "dashboard.cjs", dir: MONITOR_DIR });
  assert.deepEqual(closure.missing, [], `missing modules: ${closure.missing.join(", ")}`);
  assert.ok(closure.checked.length > 5, "the closure must include the reaper modules");
  for (const required of [
    "reaper-query.cjs",
    "reaper-scheduler.cjs",
    "reaper-actions.cjs",
    "session-upsert.cjs",
    "sessions-query.cjs",
  ]) {
    assert.ok(closure.checked.includes(required), `${required} must be part of the closure`);
  }
});

test("localRequires finds only relative requires", () => {
  const found = localRequires("const a = require('./a.cjs'); const b = require('pg');");
  assert.deepEqual(found, ["./a.cjs"]);
});

test("the migration is additive and idempotent", () => {
  const sql = readFileSync(path.join(MONITOR_DIR, "migrations", "005-reaper-owner.sql"), "utf8");
  const statements = sql.match(/ALTER TABLE sessions ADD COLUMN IF NOT EXISTS/g) || [];
  assert.equal(statements.length, 5, "all five columns must use IF NOT EXISTS");
  for (const column of [
    "owner_started_at",
    "owner_executable",
    "lease_owner",
    "lease_generation",
    "lease_fencing_token",
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.equal(/DROP\s+COLUMN/i.test(sql), false, "the migration must not drop anything");
  assert.equal(/DELETE\s+FROM/i.test(sql), false, "the migration must not delete rows");
});

test("the deployment procedure warns against sourcing the env file", () => {
  const doc = readFileSync(path.join(ROOT, "docs", "operations", "monitor-deployment.md"), "utf8");
  assert.match(doc, /Never `source \/etc\/devwf-monitor\.env`/);
  assert.match(doc, /IDLE_TTL=30 minutes/);
});
