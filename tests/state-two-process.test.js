import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteAdapter } from "../db/adapters/sqlite.js";
import { enqueue } from "../db/replicate.js";

/**
 * Dua PROSES sungguhan, bukan dua promise.
 *
 * Sampai 1.20.3 semua pengujian konkurensi berjalan di satu proses. Node
 * mengeksekusi JavaScript-nya satu per satu, sehingga tes seperti itu tidak bisa
 * membedakan "klaim baris bekerja" dari "klaim tidak pernah diuji": penguras
 * kedua selalu melihat baris sudah diklaim dan berhenti, tanpa pernah benar-benar
 * berpapasan.
 *
 * YANG TERBUKTI DI SINI (masing-masing diperiksa dengan mutasi: kode dirusak
 * sengaja, tes harus gagal, lalu dipulihkan):
 *
 *   1. Tidak ada penulisan yang hilang saat dua proses menulis sesi yang sama.
 *   2. Penjagaan `version` benar-benar menolak penulis basi antar proses -
 *      diukur dengan jeda antara membaca dan menulis, karena tanpa jeda kedua
 *      proses berselang-seling rapi dan pemeriksaan itu tidak pernah berjalan.
 *   3. Dua penguras antrean yang sama tidak mengirim satu baris dua kali.
 *      Mutasi yang menghapus klaim membuat "kunci-0" terkirim dua kali.
 *
 * YANG TIDAK TERBUKTI DI SINI, dan sengaja tidak diklaim:
 *
 *   `busy_timeout = 5000` tidak bisa dibuktikan oleh tes ini. Transaksi
 *   `better-sqlite3` bersifat sinkron dan sangat pendek, sehingga mutasi yang
 *   menghapus `busy_timeout` tetap lulus. Pragma itu dipertahankan sebagai
 *   pertahanan terhadap penulis yang lebih lambat (mis. proses lain yang sedang
 *   menjalankan VACUUM atau migrasi), bukan karena tes ini membuktikannya.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const childPath = path.join(here, "helpers", "db-writer-child.mjs");

async function withDb(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "devwf-2proc-"));
  const dbPath = path.join(dir, "state.db");
  const adapter = new SqliteAdapter({ dbPath });
  await adapter.connect();
  try {
    await fn({ dir, dbPath, adapter });
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/** Menjalankan satu proses anak dan mengembalikan hasilnya. */
function runChild(env) {
  return new Promise((resolve, reject) => {
    const child = fork(childPath, [], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`proses anak melewati batas waktu. stderr: ${err.slice(0, 500)}`));
    }, 45000);

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`proses anak keluar ${code}. stderr: ${err.slice(0, 500)}`));
        return;
      }
      const line = out.trim().split("\n").filter(Boolean).pop();
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`keluaran anak bukan JSON: ${out.slice(0, 300)}`));
      }
    });
  });
}

test("dua proses menulis sesi yang sama: tidak ada yang hilang", async () => {
  await withDb(async ({ dir, dbPath, adapter }) => {
    const userId = "u";
    const projectPath = "p";
    const sessionKey = "ses_dua_proses";

    // Baris awal, supaya kedua proses memperebutkan versi yang sama.
    await adapter.saveStateVersioned({
      userId, projectPath, sessionKey,
      state: { counter: 0 },
      expectedVersion: null,
    });

    const rounds = 8;
    const env = { CHILD_DB: dbPath, CHILD_MODE: "state", CHILD_SESSION: sessionKey, CHILD_ROUNDS: String(rounds) };

    // Kedua anak dijalankan BERSAMAAN dengan penulisan induk, bukan berurutan.
    const [a, b] = await Promise.all([
      runChild(env),
      runChild({ ...env, CHILD_SESSION: sessionKey }),
    ]);

    for (const [name, result] of [["anak A", a], ["anak B", b]]) {
      assert.equal(
        result.errors.length,
        0,
        `${name} tidak boleh gagal: ${JSON.stringify(result.errors)}`,
      );
    }

    // Setiap putaran berakhir dengan satu penulisan berhasil: percobaan ulang di
    // anak menangani konflik versi, dan itu memang perilaku yang dirancang.
    assert.equal(a.ok, rounds, `anak A harus menyelesaikan ${rounds} putaran, dapat ${a.ok}`);
    assert.equal(b.ok, rounds, `anak B harus menyelesaikan ${rounds} putaran, dapat ${b.ok}`);

    const final = await adapter.loadStateVersioned({ userId, projectPath, sessionKey });
    assert.ok(final, "baris harus tetap ada");

    // Versi = 1 (baris awal) + jumlah penulisan yang berhasil. Tidak ada
    // penulisan yang hilang, dan tidak ada yang menimpa tanpa menaikkan versi.
    assert.equal(
      final.version,
      1 + a.ok + b.ok,
      "setiap penulisan yang berhasil harus menaikkan versi tepat satu",
    );

    // Hitungan juga tidak boleh mundur: dua penulis menambah, bukan menimpa.
    assert.equal(
      final.state.counter,
      a.ok + b.ok,
      "hitungan harus mencerminkan seluruh penambahan dari kedua proses",
    );

    // Berkas WAL boleh ada; yang penting tidak ada sisa transaksi yang menggantung.
    assert.equal(existsSync(path.join(dir, "state.db")), true);
  });
});

test("konflik versi benar-benar terjadi antar proses, bukan hanya secara teori", async () => {
  await withDb(async ({ dbPath, adapter }) => {
    const userId = "u";
    const projectPath = "p";
    const sessionKey = "ses_bentrok";

    await adapter.saveStateVersioned({
      userId, projectPath, sessionKey,
      state: { counter: 0 },
      expectedVersion: null,
    });

    // Satu putaran, dengan jeda antara membaca dan menulis. Kedua proses
    // membaca versi 1, lalu sama-sama mencoba menulis dengan versi itu.
    // Tanpa jeda, keduanya berselang-seling rapi dan pemeriksaan versi tidak
    // pernah dieksekusi - tes akan lulus tanpa membuktikan apa pun.
    const env = {
      CHILD_DB: dbPath,
      CHILD_MODE: "state",
      CHILD_SESSION: sessionKey,
      CHILD_ROUNDS: "1",
      CHILD_DELAY_MS: "400",
    };

    const [a, b] = await Promise.all([runChild(env), runChild(env)]);
    const totalConflicts = a.conflicts + b.conflicts;

    assert.ok(
      totalConflicts > 0,
      `dua proses yang memegang versi sama harus memicu konflik versi; dapat ${totalConflicts}`,
    );

    // Pelajaran dari percobaan pertama: "yang kalah tidak boleh menimpa" BUKAN
    // berarti "yang kalah tidak boleh berhasil". Anak mengulang setelah konflik,
    // dan itu memang rancangannya - pekerjaannya tidak hilang.
    //
    // Yang harus benar: konflik BENAR-BENAR terjadi (kalau tidak, penjagaan versi
    // belum terbukti apa pun), dan setelah pengulangan kedua penambahan masuk.
    const final = await adapter.loadStateVersioned({ userId, projectPath, sessionKey });
    assert.equal(final.state.counter, 2, "kedua penambahan harus masuk, tidak ada yang hilang");
    assert.equal(final.version, 3, "1 baris awal + 2 penulisan yang berhasil");
  });
});

test("dua proses menguras satu antrean: setiap baris terkirim tepat sekali", async () => {
  await withDb(async ({ dir, dbPath, adapter }) => {
    const logFile = path.join(dir, "terkirim.log");
    const barrier = path.join(dir, "go");

    // Lima baris siap kirim.
    for (let i = 0; i < 5; i += 1) {
      await enqueue(adapter, "snapshot", `kunci-${i}`, JSON.stringify({ n: i }));
    }

    const env = {
      CHILD_DB: dbPath,
      CHILD_MODE: "queue",
      CHILD_ROUNDS: "6",
      CHILD_LOG: logFile,
      CHILD_BARRIER: barrier,
    };

    const both = Promise.all([runChild(env), runChild(env)]);

    // Beri kedua anak waktu sampai ke barrier, lalu buka pintunya bersamaan.
    // Tanpa ini, anak pertama menyelesaikan seluruh antrean sebelum yang kedua
    // sempat mulai, dan klaim baris tidak pernah diuji.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await writeFile(barrier, "go");

    await both;

    const isi = existsSync(logFile) ? await readFile(logFile, "utf-8") : "";
    const terkirim = isi.split("\n").filter(Boolean);

    const hitung = new Map();
    for (const key of terkirim) hitung.set(key, (hitung.get(key) || 0) + 1);

    for (const [key, jumlah] of hitung) {
      assert.equal(jumlah, 1, `"${key}" terkirim ${jumlah} kali; klaim baris harus mencegah duplikat`);
    }

    assert.equal(hitung.size, 5, `kelima baris harus terkirim, dapat ${hitung.size}`);

    const sisa = adapter.db.prepare("SELECT count(*) AS c FROM sync_queue").get().c;
    assert.equal(sisa, 0, "antrean harus kosong setelah semua terkirim");
  });
});