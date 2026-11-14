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

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  renameSync,
} from "fs";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import os from "os";
import path from "path";

export const LOCK_FILENAME = "mcp-process.lock";

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

/** Direktori lock dan lease aktif yang dipegang proses ini. */
let rememberedLockDir = null;
let rememberedLeaseId = null;
let rememberedPid = null;

/** Hanya untuk tes: mengganti pemeriksa "proses hidup". */
let isAliveOverride = null;

export function generateLeaseId(pid = process.pid, now = Date.now()) {
  let suffix = "";
  try {
    suffix = randomUUID().slice(0, 8);
  } catch {
    suffix = Math.random().toString(16).slice(2, 10);
  }
  return `lease-${pid}-${now}-${suffix}`;
}

export function getRememberedLockLease() {
  return {
    dir: rememberedLockDir,
    leaseId: rememberedLeaseId,
    pid: rememberedPid,
  };
}

/** Lokasi berkas lock untuk satu direktori state. */
export function processLockPath({ dir }) {
  return path.join(dir, LOCK_FILENAME);
}

/**
 * Direktori `.state` milik PROYEK untuk sebuah berkas state.
 *
 * Lock harus satu per PROYEK, bukan per user. Fungsi ini naik sampai menemukan
 * direktori proyek di bawah `projects/<proyek>` atau direktori `.state`.
 */
export function projectLockDir(stateFilePath) {
  const resolved = path.resolve(stateFilePath);
  let current = path.dirname(resolved);
  const { root } = path.parse(current);

  {
    let probe = path.dirname(resolved);
    const { root: probeRoot } = path.parse(probe);
    while (true) {
      if (path.basename(path.dirname(probe)) === "projects") {
        return probe;
      }
      const parent = path.dirname(probe);
      if (parent === probe || probe === probeRoot) {
        break;
      }
      probe = parent;
    }
  }

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
 * Membaca status berkas lock secara eksplisit:
 *   - missing: berkas tidak ada
 *   - ok: berkas valid dengan pid numerik
 *   - corrupt: berkas ada tetapi bukan JSON valid / pid tidak valid
 *   - unreadable: berkas ada tetapi gagal dibaca karena izin/IO
 */
export function readProcessLockDetailed({ dir }) {
  const file = processLockPath({ dir });
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { status: "missing", lock: null };
    }
    return { status: "unreadable", lock: null, error };
  }

  try {
    const clean = typeof raw === "string" && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(clean);
    if (!parsed || typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid) || parsed.pid <= 0) {
      return { status: "corrupt", lock: null, raw };
    }
    return { status: "ok", lock: parsed };
  } catch (error) {
    return { status: "corrupt", lock: null, error, raw };
  }
}

/**
 * Membaca isi lock, atau null bila tidak ada / tidak terbaca.
 */
export function readProcessLock({ dir }) {
  const res = readProcessLockDetailed({ dir });
  return res.status === "ok" ? res.lock : null;
}

function defaultIsAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

/**
 * Apakah proses dengan PID itu benar-benar pemegang lock dev-workflow?
 *
 * Mengembalikan true/false bila bisa dipastikan, null bila tidak - dan null
 * diperlakukan sebagai "masih hidup" (fail-closed) supaya perilaku aman tidak
 * berubah bila pemeriksaan sistem gagal.
 */
export function defaultIsHolderProcess(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return null;

  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000,
          windowsHide: true,
        },
      );
      const text = String(out || "").trim();
      if (!text || /^INFO:/i.test(text)) {
        // Jika PID tidak ditemukan di tabel proses OS nyata (mis. PID sintetis
        // pada unit test yang mem-mock isAlive), kembalikan null agar keputusan
        // tetap mengikuti isAlive.
        return null;
      }
      const firstLine = text.split(/\r?\n/)[0] || "";
      const match = /^"([^"]+)"/.exec(firstLine);
      if (!match) return null;
      const imageName = match[1].toLowerCase();
      return imageName === "node.exe";
    } catch {
      return null;
    }
  }

  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const command = String(out || "").trim();
    if (!command) return false;
    return /ManagedMCP|dev-workflow|node/i.test(command);
  } catch {
    return null;
  }
}

function safeHostname() {
  try {
    return os.hostname();
  } catch {
    return "";
  }
}

function lockStamp(lock) {
  const value = Number(lock?.heartbeatAt ?? lock?.updatedAt ?? lock?.startedAt);
  return Number.isFinite(value) ? value : 0;
}

function sameLockIdentity(a, b) {
  if (!a || !b) return false;
  if (a.pid !== b.pid) return false;
  if (a.leaseId && b.leaseId && a.leaseId !== b.leaseId) return false;
  if (Number.isFinite(a.startedAt) && Number.isFinite(b.startedAt) && a.startedAt !== b.startedAt) {
    return false;
  }
  return true;
}

/**
 * Mengklaim hak pemulihan atas satu berkas lock basi/rusak secara atomik.
 * Hanya satu proses yang berhasil me-rename berkas sumber ke tombstone.
 */
function tryClaimStaleOrCorruptLock(lockFile, expectedLock = null) {
  if (expectedLock) {
    try {
      const currentRaw = readFileSync(lockFile, "utf8");
      const current = JSON.parse(currentRaw);
      if (!sameLockIdentity(current, expectedLock)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  const tombstone = `${lockFile}.stale.${process.pid}.${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    renameSync(lockFile, tombstone);
  } catch {
    return false;
  }
  try {
    unlinkSync(tombstone);
  } catch {
    // Tombstone sudah terpisah dari nama lock utama; aman diabaikan bila gagal dihapus.
  }
  return true;
}

/**
 * Menulis pembaruan lock milik sendiri secara atomik setelah memverifikasi kepemilikan.
 */
function atomicWriteOwnedLock({ dir, expectedPid, expectedLeaseId = null, payload }) {
  const lockFile = processLockPath({ dir });
  const current = readProcessLock({ dir });
  if (!current || current.pid !== expectedPid) {
    return false;
  }
  if (expectedLeaseId && current.leaseId && current.leaseId !== expectedLeaseId) {
    return false;
  }

  const tmpFile = `${lockFile}.tmp.${expectedPid}.${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    writeFileSync(tmpFile, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
    const recheck = readProcessLock({ dir });
    if (!recheck || recheck.pid !== expectedPid) {
      try {
        unlinkSync(tmpFile);
      } catch {}
      return false;
    }
    if (expectedLeaseId && recheck.leaseId && recheck.leaseId !== expectedLeaseId) {
      try {
        unlinkSync(tmpFile);
      } catch {}
      return false;
    }
    renameSync(tmpFile, lockFile);
    return true;
  } catch {
    try {
      unlinkSync(tmpFile);
    } catch {}
    return false;
  }
}

function rememberLockLease({ dir, pid = process.pid, leaseId = null }) {
  rememberedLockDir = dir ? path.resolve(dir) : null;
  rememberedPid = dir ? pid : null;
  rememberedLeaseId = dir ? leaseId : null;
}

/**
 * Mencoba menjadi pemegang lock secara atomik (`wx`) dengan token kepemilikan (`leaseId`).
 *
 * Mengembalikan:
 *   { acquired: true, leaseId }                        -> kita pemegangnya
 *   { acquired: true, tookOverFrom: <pid>, leaseId }   -> pemegang lama sudah mati / basi
 *   { acquired: false, holder: {...} }                 -> ada proses lain yang hidup
 */
export function acquireProcessLock({
  dir,
  pid = process.pid,
  now = Date.now(),
  leaseId = undefined,
  staleMs = undefined,
  allowStaleTakeover = false,
  force = false,
  remember = true,
  isAlive = currentIsAlive(),
  isHolderProcess = defaultIsHolderProcess,
  writeFileImpl = writeFileSync,
}) {
  const resolvedDir = path.resolve(dir);
  const lockFile = processLockPath({ dir: resolvedDir });
  const effectiveLeaseId = leaseId || generateLeaseId(pid, now);
  const host = safeHostname();
  const usingDefaultWriter = writeFileImpl === writeFileSync;
  const shouldConsultDefaultHolder =
    isHolderProcess !== defaultIsHolderProcess ||
    (isAlive === defaultIsAlive && !isAliveOverride);

  // Jalur injeksi writer khusus untuk unit test kegagalan tulis (mis. EACCES).
  if (!usingDefaultWriter) {
    const existing = readProcessLock({ dir: resolvedDir });
    if (existing && existing.pid !== pid && isAlive(existing.pid) && !force) {
      const sameHost = !existing.host || existing.host === host;
      const holderIsOurs =
        sameHost && shouldConsultDefaultHolder ? isHolderProcess(existing.pid, existing) : null;
      if (holderIsOurs !== false) {
        if (!rememberedLockDir && remember) rememberLockDir(resolvedDir);
        return { acquired: false, holder: existing };
      }
    }
    const tookOverFrom = existing && existing.pid !== pid ? existing.pid : undefined;
    const payload = { pid, leaseId: effectiveLeaseId, startedAt: now, heartbeatAt: now, host };
    try {
      mkdirSync(resolvedDir, { recursive: true });
      writeFileImpl(lockFile, JSON.stringify(payload), "utf8");
      if (remember) rememberLockLease({ dir: resolvedDir, pid, leaseId: effectiveLeaseId });
      return tookOverFrom
        ? { acquired: true, recovered: true, tookOverFrom, leaseId: effectiveLeaseId }
        : { acquired: true, leaseId: effectiveLeaseId };
    } catch (error) {
      if (remember && !rememberedLockDir) rememberLockDir(resolvedDir);
      return {
        acquired: true,
        wrote: false,
        error: (error && (error.code || error.message)) || "unknown",
      };
    }
  }

  try {
    mkdirSync(resolvedDir, { recursive: true });
  } catch (error) {
    return {
      acquired: true,
      wrote: false,
      error: (error && (error.code || error.message)) || "unknown",
    };
  }

  let tookOverFrom = undefined;
  const maxAttempts = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const payload = {
      pid,
      leaseId: effectiveLeaseId,
      startedAt: now,
      heartbeatAt: now,
      host,
    };

    try {
      writeFileSync(lockFile, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
      if (remember) {
        rememberLockLease({ dir: resolvedDir, pid, leaseId: effectiveLeaseId });
      }
      return tookOverFrom !== undefined
        ? { acquired: true, recovered: true, tookOverFrom, leaseId: effectiveLeaseId }
        : { acquired: true, leaseId: effectiveLeaseId };
    } catch (createError) {
      if (!createError || createError.code !== "EEXIST") {
        return {
          acquired: true,
          wrote: false,
          error: (createError && (createError.code || createError.message)) || "unknown",
        };
      }
    }

    const detailed = readProcessLockDetailed({ dir: resolvedDir });
    if (detailed.status === "missing") {
      continue;
    }

    if (detailed.status === "unreadable") {
      return {
        acquired: false,
        error: (detailed.error && (detailed.error.code || detailed.error.message)) || "EACCES",
        holder: { pid: -1, startedAt: null, host },
      };
    }

    if (detailed.status === "corrupt") {
      tookOverFrom = "corrupt";
      if (tryClaimStaleOrCorruptLock(lockFile, null)) {
        continue;
      }
      continue;
    }

    const existing = detailed.lock;

    // Proses yang sama memperbarui atau mengambil kembali lock miliknya sendiri.
    if (existing.pid === pid) {
      const updatedPayload = {
        ...existing,
        pid,
        leaseId: effectiveLeaseId,
        startedAt: Number.isFinite(existing.startedAt) ? existing.startedAt : now,
        heartbeatAt: now,
        host: existing.host || host,
      };
      if (atomicWriteOwnedLock({ dir: resolvedDir, expectedPid: pid, payload: updatedPayload })) {
        if (remember) {
          rememberLockLease({ dir: resolvedDir, pid, leaseId: effectiveLeaseId });
        }
        return { acquired: true, leaseId: effectiveLeaseId };
      }
      continue;
    }

    // Pemegang berbeda: periksa apakah proses itu masih hidup dan valid.
    const sameHost = !existing.host || existing.host === host;
    const alive = sameHost ? isAlive(existing.pid) : true;
    const holderIsOurs =
      alive && sameHost && shouldConsultDefaultHolder
        ? isHolderProcess(existing.pid, existing)
        : null;
    const age = now - lockStamp(existing);
    const isStale =
      allowStaleTakeover &&
      Number.isFinite(staleMs) &&
      staleMs > 0 &&
      age > staleMs;

    if (alive && holderIsOurs !== false && !isStale && !force) {
      if (remember && !rememberedLockDir) {
        rememberLockDir(resolvedDir);
      }
      return { acquired: false, holder: existing };
    }

    // Pemegang lama sudah mati, PID-nya dipakai proses bukan-MCP, sudah basi, atau force.
    tookOverFrom = existing.pid;
    if (!tryClaimStaleOrCorruptLock(lockFile, existing)) {
      // Proses lain menang memulihkan lock ini lebih dulu; ulangi loop untuk melihat pemenangnya.
      continue;
    }
  }

  const finalCheck = readProcessLock({ dir: resolvedDir });
  return {
    acquired: false,
    holder: finalCheck || { pid: -1, startedAt: null, host },
  };
}

/** Melepas lock hanya bila memang milik proses (dan lease) kita. */
export function releaseProcessLock({
  dir = rememberedLockDir,
  pid = process.pid,
  leaseId = undefined,
  preserveRemembered = false,
} = {}) {
  if (!dir) return false;
  const resolvedDir = path.resolve(dir);
  const existing = readProcessLock({ dir: resolvedDir });

  if (!existing || existing.pid !== pid) return false;
  if (leaseId && existing.leaseId && existing.leaseId !== leaseId) return false;

  const lockFile = processLockPath({ dir: resolvedDir });
  const tombstone = `${lockFile}.rel.${pid}.${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  let removed = false;
  try {
    renameSync(lockFile, tombstone);
    removed = true;
    try {
      unlinkSync(tombstone);
    } catch {}
  } catch {
    try {
      unlinkSync(lockFile);
      removed = true;
    } catch {
      removed = false;
    }
  }

  if (
    removed &&
    !preserveRemembered &&
    rememberedLockDir &&
    path.resolve(rememberedLockDir) === resolvedDir &&
    (!rememberedPid || rememberedPid === pid)
  ) {
    rememberedLockDir = null;
    rememberedLeaseId = null;
    rememberedPid = null;
  }

  return removed;
}

/**
 * Melepas lock aktif yang sedang diingat proses ini saat keluar (exit handler).
 */
export function releaseActiveProcessLock({ pid = process.pid, fallbackDir = null } = {}) {
  let released = false;
  if (rememberedLockDir) {
    released = releaseProcessLock({
      dir: rememberedLockDir,
      pid,
      leaseId: rememberedLeaseId || undefined,
    });
  }
  if (fallbackDir && (!rememberedLockDir || path.resolve(fallbackDir) !== path.resolve(rememberedLockDir))) {
    const fallbackReleased = releaseProcessLock({ dir: fallbackDir, pid });
    released = released || fallbackReleased;
  }
  return released;
}

/**
 * Memindahkan kepemilikan lock proses dari direktori awal (mis. startup CWD)
 * ke direktori proyek tujuan secara aman:
 *   1. Validasi dan ambil lock pada proyek tujuan terlebih dahulu.
 *   2. Pindahkan ikatan detak jantung (`rememberedLockDir` & `rememberedLeaseId`) ke tujuan.
 *   3. Lepaskan lock asal HANYA bila dimiliki oleh proses ini.
 *   4. Jika gagal mengambil lock tujuan, pertahankan lock asal tanpa perubahan.
 */
export function relocateProcessLock({
  fromDir = rememberedLockDir,
  toDir,
  pid = process.pid,
  now = Date.now(),
  staleMs = DEFAULT_LOCK_STALE_MS,
  force = false,
  isAlive = currentIsAlive(),
  isHolderProcess = defaultIsHolderProcess,
} = {}) {
  if (!toDir) {
    return { ok: false, reason: "missing_target_dir" };
  }

  const targetDir = path.resolve(toDir);
  const sourceDir = fromDir ? path.resolve(fromDir) : null;
  const previousLease = getRememberedLockLease();

  if (sourceDir && sourceDir === targetDir) {
    const existing = readProcessLock({ dir: targetDir });
    if (existing && existing.pid === pid) {
      rememberLockLease({ dir: targetDir, pid, leaseId: existing.leaseId || previousLease.leaseId });
      refreshProcessLock({ dir: targetDir, pid, leaseId: existing.leaseId || undefined, now });
      return {
        ok: true,
        relocated: false,
        fromDir: sourceDir,
        dir: targetDir,
        leaseId: existing.leaseId || previousLease.leaseId,
      };
    }
  }

  const foreign = activeForeignLock({
    dir: targetDir,
    pid,
    now,
    staleMs,
    isAlive,
    isHolderProcess,
  });

  if (foreign && !force) {
    return {
      ok: false,
      reason: "foreign_lock",
      holder: foreign,
      fromDir: sourceDir,
      dir: targetDir,
    };
  }

  const acquired = acquireProcessLock({
    dir: targetDir,
    pid,
    now,
    staleMs,
    allowStaleTakeover: true,
    force,
    remember: true,
    isAlive,
    isHolderProcess,
  });

  if (!acquired.acquired) {
    // Rollback ikatan detak jantung ke direktori asal bila gagal mengambil tujuan.
    if (previousLease.dir) {
      rememberLockLease(previousLease);
    }
    return {
      ok: false,
      reason: "acquire_failed",
      holder: acquired.holder || null,
      fromDir: sourceDir,
      dir: targetDir,
    };
  }

  let releasedSource = false;
  if (sourceDir && sourceDir !== targetDir) {
    releasedSource = releaseProcessLock({
      dir: sourceDir,
      pid,
      leaseId:
        previousLease.dir && path.resolve(previousLease.dir) === sourceDir
          ? previousLease.leaseId || undefined
          : undefined,
      preserveRemembered: true,
    });
  }

  return {
    ok: true,
    relocated: Boolean(sourceDir && sourceDir !== targetDir),
    releasedSource,
    fromDir: sourceDir,
    dir: targetDir,
    leaseId: acquired.leaseId,
    tookOverFrom: acquired.tookOverFrom,
  };
}

/**
 * Pesan yang dicatat saat proses lain sudah memegang lock, atau null bila tidak
 * ada yang perlu dilaporkan.
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
 * Menyegarkan penanda milik kita sendiri dengan pemeriksaan kepemilikan (compare-owner).
 *
 * Mengembalikan false bila penanda bukan milik kita, leaseId tidak cocok, atau
 * berkas sudah dipindahkan ke proyek lain.
 */
export function refreshProcessLock({
  dir = rememberedLockDir,
  pid = process.pid,
  leaseId = undefined,
  now = Date.now(),
  writeFileImpl = writeFileSync,
} = {}) {
  if (!dir) return false;
  const resolvedDir = path.resolve(dir);

  const existing = readProcessLock({ dir: resolvedDir });
  if (!existing || existing.pid !== pid) return false;

  const expectedLeaseId =
    leaseId !== undefined
      ? leaseId
      : rememberedLockDir &&
          path.resolve(rememberedLockDir) === resolvedDir &&
          rememberedPid === pid
        ? rememberedLeaseId
        : null;

  if (expectedLeaseId && existing.leaseId && existing.leaseId !== expectedLeaseId) {
    return false;
  }

  const updated = { ...existing, heartbeatAt: now };

  if (writeFileImpl !== writeFileSync) {
    try {
      writeFileImpl(processLockPath({ dir: resolvedDir }), JSON.stringify(updated), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  return atomicWriteOwnedLock({
    dir: resolvedDir,
    expectedPid: pid,
    expectedLeaseId,
    payload: updated,
  });
}

/**
 * Pemegang lock lain yang masih hidup DAN masih bekerja, atau null.
 */
export function activeForeignLock({
  dir = rememberedLockDir,
  pid = process.pid,
  now = Date.now(),
  staleMs = DEFAULT_LOCK_STALE_MS,
  isAlive = currentIsAlive(),
  isHolderProcess = defaultIsHolderProcess,
} = {}) {
  if (!dir) return null;

  const lock = readProcessLock({ dir });
  if (!lock || lock.pid === pid) return null;
  if (!isAlive(lock.pid)) return null;

  const sameHost = !lock.host || lock.host === safeHostname();
  const shouldConsultDefaultHolder =
    isHolderProcess !== defaultIsHolderProcess ||
    (isAlive === defaultIsAlive && !isAliveOverride);
  if (sameHost && shouldConsultDefaultHolder) {
    const holderIsOurs = isHolderProcess(lock.pid, lock);
    if (holderIsOurs === false) return null;
  }

  const age = now - lockStamp(lock);
  if (age > staleMs) return null;

  return { ...lock, ageMs: age };
}

/** Mengingat direktori lock supaya detak jantung tidak perlu parameter. */
export function rememberLockDir(dir, leaseId = null, pid = process.pid) {
  rememberedLockDir = dir ? path.resolve(dir) : null;
  rememberedLeaseId = dir ? leaseId : null;
  rememberedPid = dir ? pid : null;
}

export function setIsAliveForTests(fn) {
  isAliveOverride = typeof fn === "function" ? fn : null;
}

export function currentIsAlive() {
  return isAliveOverride || defaultIsAlive;
}
