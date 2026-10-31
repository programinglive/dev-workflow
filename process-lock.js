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

function defaultIsAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;

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
export function acquireProcessLock({ dir, pid = process.pid, now = Date.now(), isAlive = defaultIsAlive }) {
  const existing = readProcessLock({ dir });

  if (existing && existing.pid !== pid && isAlive(existing.pid)) {
    return { acquired: false, holder: existing };
  }

  const tookOverFrom = existing && existing.pid !== pid ? existing.pid : undefined;

  const payload = { pid, startedAt: now, host: safeHostname() };

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(processLockPath({ dir }), JSON.stringify(payload), "utf8");
  } catch {
    // Tidak bisa menulis penanda bukan alasan mematikan server.
    return { acquired: true, wrote: false };
  }

  return tookOverFrom ? { acquired: true, tookOverFrom } : { acquired: true };
}

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
  if (!result || result.acquired !== false || !result.holder) return null;

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
