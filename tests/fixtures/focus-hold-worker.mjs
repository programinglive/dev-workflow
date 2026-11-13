/**
 * One operating-system process that OWNS a focus lock and holds it.
 *
 * Used to prove that a live lock owner is not displaced merely because the lock
 * record looks old. The worker writes the lock file naming its own PID, then
 * stays alive. The parent rewrites `startedAt` to a past timestamp and tries to
 * claim the same focus.
 *
 *   node focus-hold-worker.mjs <lockFile>
 *
 * Prints "HELD" once the lock exists, then holds until stdin closes or 10s pass.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const [lockFile] = process.argv.slice(2);

mkdirSync(path.dirname(lockFile), { recursive: true });
writeFileSync(
  lockFile,
  JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now() }),
  "utf8",
);

process.stdout.write("HELD\n");

await new Promise((resolve) => {
  const timer = setTimeout(resolve, 10_000);
  process.stdin.on("end", () => {
    clearTimeout(timer);
    resolve();
  });
  process.stdin.resume();
});
