/**
 * Proses anak untuk tes dua-proses.
 *
 * Dipisah ke berkas sendiri karena `child_process.fork` menjalankan berkas utuh,
 * bukan fungsi. Argumennya lewat environment supaya tidak ada ambiguitas urutan.
 *
 * Mode:
 *   state  - menulis state sesi yang sama berulang-ulang, dengan satu percobaan
 *            ulang saat kena konflik versi.
 *   queue  - menguras satu antrean replika bersama, mencatat setiap kiriman ke
 *            berkas log supaya induk bisa menghitung kiriman ganda.
 */

import { appendFileSync, existsSync } from "node:fs";
import { SqliteAdapter } from "../../db/adapters/sqlite.js";
import { drainSync } from "../../db/replicate.js";

const dbPath = process.env.CHILD_DB;
const mode = process.env.CHILD_MODE;
const sessionKey = process.env.CHILD_SESSION;
const rounds = Number(process.env.CHILD_ROUNDS || "10");
const logFile = process.env.CHILD_LOG;
// Jeda antara MEMBACA versi dan MENULIS. Tanpa jeda, dua proses berselang-seling
// rapi dan tidak pernah benar-benar bertabrakan - sehingga penjagaan versi tidak
// teruji sama sekali. Dengan jeda, keduanya memegang versi yang sama.
const delayMs = Number(process.env.CHILD_DELAY_MS || "0");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const adapter = new SqliteAdapter({ dbPath });
await adapter.connect();

/**
 * Barrier start.
 *
 * `fork` butuh ~100-300 ms untuk sampai ke sini, sehingga tanpa barrier proses
 * pertama sudah menyelesaikan seluruh pekerjaannya sebelum yang kedua mulai -
 * dan tes konkurensi hanya menguji satu proses dua kali.
 */
const barrier = process.env.CHILD_BARRIER;
if (barrier) {
  const deadline = Date.now() + 20000;
  while (!existsSync(barrier)) {
    if (Date.now() > deadline) throw new Error("barrier tidak pernah dibuka");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let ok = 0;
let conflicts = 0;
const errors = [];

if (mode === "state") {
  const userId = "u";
  const projectPath = "p";

  for (let i = 0; i < rounds; i += 1) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await adapter.loadStateVersioned({ userId, projectPath, sessionKey });
      const state = {
        ...(current?.state || {}),
        worker: sessionKey,
        counter: Number(current?.state?.counter || 0) + 1,
      };
      if (delayMs > 0) await sleep(delayMs);
      try {
        await adapter.saveStateVersioned({
          userId,
          projectPath,
          sessionKey,
          state,
          expectedVersion: current ? current.version : null,
        });
        ok += 1;
        break;
      } catch (error) {
        if (error?.code === "STATE_CONFLICT") {
          conflicts += 1;
          continue;
        }
        errors.push(String(error?.message || error));
        break;
      }
    }
  }
} else if (mode === "queue") {
  // Pengirim mencatat setiap baris yang benar-benar terkirim. Induk menghitung
  // baris log: satu kunci tidak boleh muncul dua kali walau dua proses menguras.
  const replica = {
    push: async (row) => {
      appendFileSync(logFile, `${row.dedupe_key}\n`);
    },
  };
  for (let i = 0; i < rounds; i += 1) {
    try {
      await drainSync({ replica, limit: 5, budgetMs: 800, adapter });
      ok += 1;
    } catch (error) {
      errors.push(String(error?.message || error));
    }
  }
} else {
  errors.push(`mode tidak dikenal: ${mode}`);
}

await adapter.close();
process.stdout.write(JSON.stringify({ ok, conflicts, errors }) + "\n", () => {
  if (typeof process.disconnect === "function" && process.connected) {
    process.disconnect();
  }
});
