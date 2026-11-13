/**
 * Release lock.
 *
 * Two AI sessions can work the same Clinic clone. If both run the release
 * script, they create two release commits and two tags, and the second push
 * either fails or rewrites the first. The lock makes "who is releasing" a fact
 * instead of a convention.
 *
 * The lock lives in `.git/`, so every session on the same clone sees it and it
 * is never committed. It expires, so a crashed session cannot block releases
 * forever.
 */

import fs from "node:fs";
import path from "node:path";

const LOCK_FILE = "devwf-release.lock.json";
const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function lockPath(projectDir) {
  return path.join(projectDir, ".git", LOCK_FILE);
}

export function readReleaseLock(projectDir) {
  if (!projectDir) return null;
  try {
    const raw = fs.readFileSync(lockPath(projectDir), "utf8");
    const lock = JSON.parse(raw);
    if (!lock || typeof lock !== "object") return null;
    if (lock.expiresAt && Date.now() > Date.parse(lock.expiresAt)) return null;
    return lock;
  } catch {
    return null;
  }
}

export function acquireReleaseLock({ projectDir, tag, sessionId, machine } = {}) {
  if (!projectDir) {
    return { ok: false, error: "projectDir wajib diisi supaya lock bisa ditempatkan." };
  }

  const existing = readReleaseLock(projectDir);
  if (existing && existing.sessionId && existing.sessionId !== sessionId) {
    return {
      ok: false,
      error:
        `Rilis sedang dipegang sesi lain (${existing.sessionId}` +
        `${existing.machine ? " di " + existing.machine : ""}) untuk tag ${existing.tag || "(belum ditentukan)"}. ` +
        `Jangan jalankan release script sampai lock itu dilepas atau kedaluwarsa.`,
      holder: existing,
    };
  }

  const lock = {
    sessionId: sessionId || "unknown",
    machine: machine || "",
    tag: tag || "",
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
  };

  try {
    fs.mkdirSync(path.dirname(lockPath(projectDir)), { recursive: true });
    fs.writeFileSync(lockPath(projectDir), JSON.stringify(lock, null, 2));
  } catch (error) {
    return { ok: false, error: `Tidak bisa menulis lock: ${error.message}` };
  }

  return { ok: true, lock };
}

export function releaseReleaseLock({ projectDir, sessionId, force = false } = {}) {
  if (!projectDir) {
    return { ok: false, error: "projectDir wajib diisi." };
  }

  const existing = readReleaseLock(projectDir);
  if (!existing) {
    return { ok: true, released: false, note: "Tidak ada lock aktif." };
  }

  if (!force && existing.sessionId && existing.sessionId !== sessionId) {
    return {
      ok: false,
      error: `Lock dipegang sesi lain (${existing.sessionId}). Pakai force hanya kalau sesi itu sudah mati.`,
      holder: existing,
    };
  }

  try {
    fs.unlinkSync(lockPath(projectDir));
  } catch {
    /* already gone */
  }

  return { ok: true, released: true };
}
