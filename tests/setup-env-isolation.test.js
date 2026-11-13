import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Suite TIDAK boleh menulis ke dashboard produksi.
 *
 * MASALAH NYATA (1 November 2026): `setup-env.js` sudah mengisolasi state dan
 * basis data, tetapi tidak menyentuh `DEVWF_MONITOR_URL`. Di mesin yang memang
 * memakai dashboard - variabel itu ada di environment-nya - setiap `npm test`
 * mengirim sesi palsu dari suite ke dashboard sungguhan. Akibatnya sembilan
 * kartu "Task sesi X", "Task tanpa metadata", dan "Task milik sesi A/B"
 * muncul di layar tablet, dan sesi yang benar tenggelam di antaranya.
 *
 * Tes ini menjalankan proses anak dengan URL monitor terisi, lalu membaca apa
 * yang tersisa setelah `setup-env.js` dijalankan. Yang diuji adalah perilaku
 * berkas itu sendiri, bukan nilai di proses tes ini.
 */
function envAfterSetup() {
  const script = "process.stdout.write(JSON.stringify(process.env.DEVWF_MONITOR_URL ?? null))";
  const result = spawnSync(
    process.execPath,
    ["--no-deprecation", "--import", "./tests/setup-env.js", "-e", script],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, DEVWF_MONITOR_URL: "http://127.0.0.1:3100" },
    },
  );
  assert.equal(result.status, 0, `proses anak gagal: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("setup-env mengosongkan DEVWF_MONITOR_URL milik mesin", () => {
  assert.equal(envAfterSetup(), "");
});

test("setup-env tetap mengisolasi state dan basis data", () => {
  // Penjaga regresi: kalau seseorang menghapus isolasi state sambil
  // memperbaiki monitor, tes ini harus gagal.
  const script =
    "process.stdout.write(JSON.stringify({" +
    "state: process.env.DEV_WORKFLOW_STATE_FILE, db: process.env.DEV_WORKFLOW_DB_PATH," +
    "dir: process.env.DEV_WORKFLOW_TEST_STATE_DIR, links: process.env.DEV_WORKFLOW_NO_COMPAT_LINKS}))";
  const result = spawnSync(
    process.execPath,
    ["--no-deprecation", "--import", "./tests/setup-env.js", "-e", script],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env } },
  );
  assert.equal(result.status, 0, `proses anak gagal: ${result.stderr}`);
  const env = JSON.parse(result.stdout);

  assert.ok(env.state && env.state.endsWith("workflow-state.json"), "state harus diarahkan ke tmpdir");
  assert.ok(env.db && env.db.endsWith("workflow-state.db"), "db harus diarahkan ke tmpdir");
  assert.equal(env.dir && env.dir.includes("dev-workflow-test-state-"), true);
  assert.equal(env.links, "1");
});
