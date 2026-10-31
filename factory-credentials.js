/**
 * Membaca ulang kredensial Factory dari berkas konfigurasi OpenCode.
 *
 * Kenapa perlu: proses MCP mewarisi environment saat ia di-spawn dan tidak
 * pernah memuat ulang. 31 Oktober 2026 otomasi Factory mati berjam-jam dengan
 * pesan "login failed (HTTP 400). Check FACTORY_EMAIL and FACTORY_PASSWORD"
 * padahal password di `~/.config/opencode/opencode.json` sudah benar dan login
 * langsung ke PocketBase menjawab 200. Penyebabnya: proses MCP hidup sejak
 * 30 Oktober dan memegang password LAMA di memorinya.
 *
 * Modul ini TIDAK menyimpan rahasia baru ke disk. Ia hanya membaca berkas yang
 * sudah ada dan sudah berisi rahasia itu.
 */

import { readFileSync } from "fs";
import os from "os";
import path from "path";

/** Nama server di blok `mcp` pada konfigurasi OpenCode. */
export const DEFAULT_SERVER_NAME = "dev-workflow";

/**
 * Berkas kredensial bawaan: konfigurasi OpenCode.
 *
 * Bisa diarahkan lewat `FACTORY_CREDENTIALS_FILE` bila konfigurasinya di tempat
 * lain (misalnya berkas khusus tanpa isi lain).
 */
export function defaultCredentialsFile(env = process.env) {
  const explicit = clean(env.FACTORY_CREDENTIALS_FILE);
  if (explicit) return explicit;

  const home = clean(env.HOME) || clean(env.USERPROFILE) || os.homedir();
  const configHome = clean(env.XDG_CONFIG_HOME) || path.join(home, ".config");

  return path.join(configHome, "opencode", "opencode.json");
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Mengambil blok `environment` milik server MCP kita dari teks konfigurasi.
 *
 * Dua bentuk didukung, karena keduanya ada di lapangan:
 *   { mcp: { "<nama>": {...} } }            (konfigurasi lama)
 *   { mcp: { servers: { "<nama>": {...} } } } (konfigurasi OpenCode di mesin ini)
 *
 * Mengembalikan null bila teks bukan JSON, tidak punya `mcp`, atau tidak punya
 * blok server yang diminta. Mengambil server LAIN akan lebih buruk daripada
 * tidak mengambil apa pun: kredensial proyek lain bisa terpakai.
 */
export function extractFactoryEnv(text, { serverName = DEFAULT_SERVER_NAME } = {}) {
  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const mcp = parsed && parsed.mcp;
  if (!mcp || typeof mcp !== "object") return null;

  const block = mcp[serverName] || (mcp.servers && mcp.servers[serverName]);
  if (!block || typeof block !== "object") return null;

  const environment = block.environment;
  if (!environment || typeof environment !== "object") return null;

  return environment;
}

/**
 * Membandingkan kredensial yang sedang dipakai proses dengan yang ada di berkas.
 *
 * Mengembalikan null bila tidak ada yang bisa disegarkan (berkas tidak ada,
 * rusak, atau tanpa blok server kita). Selain itu objek dengan kredensial
 * TERBARU, plus `changed` yang menandakan apakah ia berbeda dari yang dipakai.
 */
export function refreshFactoryCredentials(
  config = {},
  { env = process.env, readFileImpl = readFileSync, serverName = DEFAULT_SERVER_NAME } = {}
) {
  const file = defaultCredentialsFile(env);

  let text;
  try {
    text = String(readFileImpl(file, "utf8"));
  } catch {
    return null;
  }

  const environment = extractFactoryEnv(text, { serverName });
  if (!environment) return null;

  const token = clean(environment.FACTORY_TOKEN);
  const email = clean(environment.FACTORY_EMAIL);
  const password = clean(environment.FACTORY_PASSWORD);

  const current = {
    token: clean(config.token),
    email: clean(config.email),
    password: clean(config.password),
  };

  const changed =
    token !== current.token || email !== current.email || password !== current.password;

  return {
    token,
    email,
    password,
    changed,
    source: "file",
    file,
  };
}

/**
 * Pesan gagal login yang bisa ditindaklanjuti.
 *
 * Dua hal yang membedakannya dari pesan lama ("check FACTORY_EMAIL and
 * FACTORY_PASSWORD"): ia menyebut KAPAN proses ini hidup, dan ia menyebut
 * apakah kredensial di berkas berbeda dari yang sedang dipakai. Tanpa itu,
 * pengguna disuruh memeriksa password yang sebenarnya sudah benar.
 */
export function describeLoginFailure({ status, processStartedAt, credentialsChanged = false }) {
  const started = processStartedAt instanceof Date ? processStartedAt.toISOString() : "";

  const lines = [
    `Factory login failed (HTTP ${status}).`,
    started
      ? `Proses MCP ini hidup sejak ${started} dan memakai environment yang diwarisi saat itu - ia tidak pernah memuat ulang berkas konfigurasi.`
      : "Proses MCP ini memakai environment yang diwarisi saat ia dijalankan.",
  ];

  if (credentialsChanged) {
    lines.push(
      "Kredensial di berkas konfigurasi BERBEDA dari yang sedang dipakai proses ini. " +
        "Kredensial terbaru sudah dicoba dan tetap ditolak, jadi kemungkinan besar " +
        "password-nya memang salah, atau akunnya belum bisa login."
    );
  } else {
    lines.push(
      "Kredensial di berkas konfigurasi SAMA dengan yang dipakai, atau berkasnya tidak ditemukan."
    );
  }

  lines.push(
    "Periksa FACTORY_EMAIL/FACTORY_PASSWORD, atau set FACTORY_TOKEN. " +
      "Bila password baru saja diubah, restart OpenCode agar proses MCP memakai kredensial terbaru."
  );

  return lines.join(" ");
}
