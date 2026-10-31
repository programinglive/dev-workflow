/**
 * Satu penanda "proses MCP mana yang sedang hidup" per direktori state.
 *
 * Kenapa perlu: 31 Oktober 2026 ada DUA proses dev-workflow MCP hidup
 * bersamaan. Yang lebih tua memegang password Factory lama di memorinya, yang
 * lebih muda memegang yang baru, jadi tool yang sama menjawab berbeda
 * tergantung proses mana yang melayaninya - dan keduanya menulis berkas state
 * workflow yang sama.
 *
 * Modul ini TIDAK membunuh proses lain. Membunuh proses secara otomatis adalah
 * tindakan berbahaya (ada guard tersendiri untuk itu). Yang dilakukan: proses
 * kedua mengetahui bahwa ia bukan satu-satunya, lalu melaporkannya, sehingga
 * pengguna bisa menutup OpenCode dan memulai ulang dengan bersih.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import os from "os";
import path from "path";

export const LOCK_FILENAME = "mcp-process.lock";

/** Lokasi berkas lock untuk satu direktori state. */
export function processLockPath({ dir }) {
  return path.join(dir, LOCK_FILENAME);
}

/**
 * Direktori `.state` milik PROYEK untuk sebuah berkas state.
 *
 * Kenapa bukan `path.dirname(stateFile)` saja: berkas state sesi berada di
 * `.state/users/<user>/`, dan direktori user bisa BERBEDA antar proses (id user
 * dibuat per direktori state). Pada 31 Oktober 2026 dua proses MCP hidup
 * bersamaan tetapi hanya satu lock file yang tercipta, karena masing-masing
 * menulis ke direktori user-nya sendiri - jadi keduanya tidak pernah saling
 * melihat dan peringatan proses ganda tidak muncul.
 *
 * Lock harus satu per PROYEK, bukan per user. Fungsi ini naik sampai menemukan
 * direktori bernama `.state` dan memakai direktori itu. Kalau tidak ada (state
 * di luar tata letak itu), pakai direktori berkasnya sendiri.
 */
export function projectLockDir(stateFilePath) {
  const resolved = path.resolve(stateFilePath);
  let current = path.dirname(resolved);
  const { root } = path.parse(current);

  while (true) {
    if (path.basename(current) === ".state") {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current || current === root) {
      break;
    }

    current = parent;
  }

  return path.dirname(resolved);
}

/**
 * Membaca isi lock, atau null bila tidak ada / tidak terbaca.
 *
 * Berkas rusak sengaja dianggap "tidak ada lock": penanda yang tidak bisa
 * dibaca tidak boleh membuat server gagal start. Lebih baik dua proses
 * bertabrakan daripada server tidak hidup sama sekali.
 */
export function readProcessLock({ dir }) {
  const file = processLockPath({ dir });

  if (!existsSync(file)) return null;

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function defaultIsAlive(pid) {  if (!Number.isFinite(pid) || pid <= 0) return false;

  try {
    // Sinyal 0 tidak mengirim apa pun; ia hanya memeriksa apakah proses ada.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM berarti proses ADA tetapi milik pengguna lain.
    return error && error.code === "EPERM";
  }
}

/**
 * Mencoba menjadi pemegang lock.
 *
 * Mengembalikan:
 *   { acquired: true }                        -> kita pemegangnya
 *   { acquired: true, tookOverFrom: <pid> }   -> pemegang lama sudah mati
 *   { acquired: false, holder: {...} }        -> ada proses lain yang hidup
 */
export function acquireProcessLock({
  dir,
  pid = process.pid,
  now = Date.now(),
  isAlive = defaultIsAlive,
  writeFileImpl = writeFileSync,
}) {
  const existing = readProcessLock({ dir });

  if (existing && existing.pid !== pid && isAlive(existing.pid)) {
    rememberLockDir(dir);
    return { acquired: false, holder: existing };
  }

  const tookOverFrom = existing && existing.pid !== pid ? existing.pid : undefined;

  const payload = { pid, startedAt: now, heartbeatAt: now, host: safeHostname() };

  try {
    mkdirSync(dir, { recursive: true });
    writeFileImpl(processLockPath({ dir }), JSON.stringify(payload), "utf8");
  } catch (error) {
    // Tidak bisa menulis penanda bukan alasan mematikan server, TETAPI juga
    // tidak boleh ditelan: sampai 31 Oktober 2026 kegagalan ini hanya
    // mengembalikan { acquired: true } sehingga sistem tampak sehat padahal
    // tidak ada penanda apa pun di disk. Simpan sebabnya supaya bisa dilaporkan.
    return {
      acquired: true,
      wrote: false,
      error: (error && (error.code || error.message)) || "unknown",
    };
  }

  return tookOverFrom ? { acquired: true, tookOverFrom } : { acquired: true };}

/** Melepas lock hanya bila memang milik kita. */
export function releaseProcessLock({ dir, pid = process.pid }) {
  const existing = readProcessLock({ dir });

  if (!existing || existing.pid !== pid) return false;

  try {
    unlinkSync(processLockPath({ dir }));
    return true;
  } catch {
    return false;
  }
}

function safeHostname() {
  try {
    return os.hostname();
  } catch {
    return "";
  }
}

/**
 * Pesan yang dicatat saat proses lain sudah memegang lock, atau null bila tidak
 * ada yang perlu dilaporkan.
 *
 * Dipisah dari `acquireProcessLock` supaya bisa diuji tanpa menyentuh proses
 * nyata, dan supaya pemanggil bebas memilih tidak menampilkan apa pun.
 */
export function lockWarning(result) {
  if (!result) return null;

  if (result.wrote === false) {
    return (
      `Tidak bisa menulis penanda proses ke ${LOCK_FILENAME} (${result.error}). ` +
      "Deteksi proses MCP ganda tidak akan bekerja sampai ini diperbaiki."
    );
  }

  if (result.acquired !== false || !result.holder) return null;

  const started = Number.isFinite(result.holder.startedAt)
    ? new Date(result.holder.startedAt).toISOString()
    : "waktu tidak diketahui";

  return (
    `Proses dev-workflow MCP lain (PID ${result.holder.pid}, hidup sejak ${started}) ` +
    "masih berjalan dan memakai direktori state yang sama. " +
    "Proses yang lebih tua memegang environment saat ia dijalankan, jadi kredensial Factory " +
    "dan state workflow bisa berbeda antar proses. Tutup OpenCode lalu buka lagi untuk " +
    "memastikan hanya satu proses yang hidup."
  );
}

/**
 * Berapa lama penanda proses dianggap masih "baru saja bekerja".
 *
 * Dipakai untuk membedakan sesi yang benar-benar aktif dari proses MCP yang
 * tertinggal hidup setelah jendela OpenCode-nya ditutup. Tanpa batas ini,
 * "satu penulis per repo" hanya bisa ditegakkan dengan memblokir sesi yang sah.
 */
export const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;

/** Interval detak jantung; sepertiga dari batas basi, supaya ada toleransi. */
export const HEARTBEAT_MS = Math.floor(DEFAULT_LOCK_STALE_MS / 3);

/** Direktori lock yang terakhir dipegang proses ini (diisi acquireProcessLock). */
let rememberedLockDir = null;

function lockStamp(lock) {
  const value = Number(lock?.heartbeatAt ?? lock?.startedAt);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Menyegarkan penanda milik kita sendiri.
 *
 * Mengembalikan false bila penanda bukan milik kita atau tidak bisa ditulis.
 * Tidak pernah melempar: gagal menyegarkan penanda tidak boleh mematikan server,
 * tetapi juga tidak boleh diam-diam dianggap berhasil.
 */
export function refreshProcessLock({ dir = rememberedLockDir, pid = process.pid, now = Date.now(), writeFileImpl = writeFileSync } = {}) {
  if (!dir) return false;

  const existing = readProcessLock({ dir });
  if (!existing || existing.pid !== pid) return false;

  try {
    writeFileImpl(processLockPath({ dir }), JSON.stringify({ ...existing, heartbeatAt: now }), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Pemegang lock lain yang masih hidup DAN masih bekerja, atau null.
 *
 * Inilah yang membuat aturan "satu penulis per repo" punya gigi: pemanggil bisa
 * menolak memulai pekerjaan alih-alih menimpanya. Penanda yang basi (tidak ada
 * detak dalam `staleMs`) diabaikan, karena proses MCP yang tertinggal hidup
 * bukan alasan memblokir sesi baru.
 */
export function activeForeignLock({
  dir = rememberedLockDir,
  pid = process.pid,
  now = Date.now(),
  staleMs = DEFAULT_LOCK_STALE_MS,
  isAlive = defaultIsAlive,
} = {}) {
  if (!dir) return null;

  const lock = readProcessLock({ dir });
  if (!lock || lock.pid === pid) return null;
  if (!isAlive(lock.pid)) return null;

  const age = now - lockStamp(lock);
  if (age > staleMs) return null;

  return { ...lock, ageMs: age };
}

/** Mengingat direktori lock supaya detak jantung tidak perlu parameter. */
export function rememberLockDir(dir) {
  rememberedLockDir = dir || null;
}

/** Hanya untuk tes: mengganti pemeriksa "proses hidup". */
let isAliveOverride = null;
export function setIsAliveForTests(fn) {
  isAliveOverride = typeof fn === "function" ? fn : null;
}

export function currentIsAlive() {
  return isAliveOverride || defaultIsAlive;
}
