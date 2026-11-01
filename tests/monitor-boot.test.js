import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Boot server tidak boleh menunggu jaringan monitor.
 *
 * Diukur 1 November 2026: satu permintaan HTTP 1,2 detik di jalur boot cukup
 * membuat startup melewati batas 2 detik yang dituntut Studio. Tes ini memakai
 * URL yang MENGGANTUNG, jadi kalau jalur boot menunggu, waktunya melonjak.
 *
 * Batas di sini longgar dengan sengaja: tes ini menguji KETIADAAN penantian
 * jaringan, bukan kecepatan mesin. Batas 2 detik yang ketat dipegang oleh
 * `startup-resilience.test.js`, yang mengukur boot tanpa monitor.
 */
const BOUND_MS = 6000;

function startServer(env) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn("node", [path.join(ROOT, "index.js")], {
      env: { ...process.env, DEV_WORKFLOW_DB_TYPE: "sqlite", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("server tidak siap dalam 10 detik"));
    }, 10000);
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("running on stdio")) {
        clearTimeout(timer);
        const duration = Date.now() - start;
        child.kill();
        resolve(duration);
      }
    });
    child.on("error", reject);
  });
}

test("boot tidak menunggu monitor yang menggantung", async () => {
  // Alamat tidak terjangkau: koneksi menggantung sampai timeout. Kalau jalur
  // boot menunggu laporan, waktu di sini akan melewati batas.
  const duration = await startServer({
    DEVWF_MONITOR_URL: "http://10.255.255.1:3100",
    DEVWF_MACHINE: "boot-test",
  });
  assert.ok(duration < BOUND_MS, `boot menunggu monitor: ${duration}ms`);
});

test("boot tanpa monitor juga siap", async () => {
  const duration = await startServer({ DEVWF_MONITOR_URL: "" });
  assert.ok(duration < BOUND_MS, `boot melambat: ${duration}ms`);
});
