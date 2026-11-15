#!/usr/bin/env node
/**
 * Deterministic English-only check for engineering source.
 *
 * The workflow prompt already tells the AI to write identifiers, comments,
 * docstrings, test descriptions and commit messages in English. That is advice,
 * not enforcement: nothing ever read the source back, so Indonesian text kept
 * landing in tests. This script is the enforcement.
 *
 * WHAT IT CHECKS
 * --------------
 * Source files only (js, mjs, cjs, ts, tsx, jsx). Each file is split into
 * comments, string literals and identifiers, and each part is scanned for
 * Indonesian marker words.
 *
 * A marker of five characters or more is strong enough to flag on its own
 * ("tidak", "harus", "selama", "panggilan"). Shorter markers ("sama", "jam",
 * "isi") are ambiguous with names and loanwords, so they only flag when two
 * different ones appear together. That keeps the check deterministic without
 * turning every proper noun into a failure.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It never rewrites anything. It reports file, line, kind and the markers it
 * found, and exits non-zero. Translation stays a human decision.
 *
 * EXCEPTIONS
 * ----------
 * - Localization paths (locales, i18n, lang, translations) and `*.id.*` files
 *   are skipped: that is product text, not engineering text.
 * - A line carrying `language-allow: <reason>` is skipped. The reason is
 *   required so the exception is reviewable.
 * - `scripts/english-policy-baseline.json` records violations that predate the
 *   gate. They are reported as "baselined" and do not fail the build, but any
 *   new violation does. Removing a baselined violation is always safe; adding
 *   one is not.
 *
 * USAGE
 * -----
 *   node scripts/check-english.mjs                 # fail on new violations
 *   node scripts/check-english.mjs --json          # machine-readable report
 *   node scripts/check-english.mjs --update-baseline
 *   node scripts/check-english.mjs --all           # ignore the baseline
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = path.join(ROOT, 'scripts', 'english-policy-baseline.json');

const SOURCE_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx)$/;
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.state', 'dist', 'out', '.next', '.superpowers',
  'coverage', 'build', '.husky', 'android', 'ios',
]);

/** Product text, not engineering text. */
const EXEMPT_PATH = [
  /(^|[\\/])(?:locales?|i18n|lang|translations?)([\\/]|$)/i,
  /\.(?:id|id-ID)\.(?:json|js|mjs|cjs|ts|tsx)$/i,
  // The checker necessarily contains the Indonesian word list it searches for.
  /(^|[\\/])scripts[\\/]check-english\.mjs$/i,
];

const ALLOW_DIRECTIVE = /language-allow\s*:\s*\S/;

/**
 * Indonesian marker words.
 *
 * Every entry is a word that is Indonesian and not English. The list is
 * deliberately conservative: a missing word is a missed report, while a wrong
 * word blocks a correct commit.
 */
const MARKERS = new Set([
  'adalah', 'alamat', 'ambil', 'angka', 'antara', 'apakah', 'aturan', 'atau',
  'baca', 'bagi', 'bagian', 'bahwa', 'banyak', 'baru', 'bawah', 'belakang',
  'belum', 'benar', 'berarti', 'berakhir', 'berhasil', 'berkas', 'berlaku',
  'bersama', 'berubah', 'besar', 'biasa', 'bila', 'bisa', 'boleh', 'buat',
  'buka', 'cara', 'cari', 'catatan', 'cukup', 'daftar', 'dalam', 'dan',
  'dapat', 'dari', 'dasar', 'datang', 'dengan', 'depan', 'diisi', 'dijaga',
  'ditolak', 'ditulis', 'dulu', 'gagal', 'ganti', 'gunakan', 'halaman',
  'hanya', 'hapus', 'hari', 'harus', 'hasil', 'hilang', 'hitung', 'hidup',
  'hubungi', 'informasi', 'ingin', 'ini', 'isi', 'itu', 'jadi', 'jalankan',
  'jalan', 'jalur', 'jam', 'jangan', 'jumlah', 'juga', 'kalau', 'karena',
  'kartu', 'kata', 'kecil', 'kembali', 'kemudian', 'kepada', 'karena',
  'kartu', 'kata', 'kembali', 'keterangan', 'ketika', 'kirim', 'kita',
  'kosong', 'kunci', 'kurang', 'lama', 'laporan', 'lebih', 'lewat', 'lihat',
  'lalu', 'masa', 'masih', 'masuk', 'mati', 'memakai', 'membuat', 'memiliki',
  'menampilkan', 'mendokumentasikan', 'menggunakan', 'menit', 'muncul',
  'mereka', 'mesin', 'mohon', 'mulai', 'muat', 'nama', 'nilai', 'nyata',
  'pada', 'paling', 'panggilan', 'pastikan', 'pemeriksaan', 'penambahan',
  'pengguna', 'periksa', 'perilaku', 'perlu', 'pertama', 'pesan', 'punya',
  'rotasi', 'salah', 'sama', 'sampai', 'sangat', 'saya', 'sebelum', 'sedang',
  'sedikit', 'sekarang', 'selama', 'selesai', 'semua', 'sering', 'sesi',
  'sesudah', 'setelah', 'setiap', 'simpan', 'supaya', 'sudah', 'tadi',
  'tambah', 'tampil', 'tanpa', 'tetap', 'tetapi', 'teks', 'terima', 'tidak',
  'toleransi', 'tombol', 'tulis', 'tutup', 'ubah', 'untuk', 'wajib', 'waktu',
  'yang',
]);

/** A marker this long is unambiguous enough to flag on its own. */
const STRONG_LENGTH = 5;

function words(text) {
  return String(text).toLowerCase().match(/[a-z]+/g) || [];
}

function splitIdentifier(text) {
  return String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_$]+/g, ' ')
    .toLowerCase()
    .match(/[a-z]+/g) || [];
}

/**
 * @returns {string[]|null} the markers that make this text a violation
 */
export function findViolation(text, { identifier = false } = {}) {
  const tokens = identifier ? splitIdentifier(text) : words(text);
  const hits = [...new Set(tokens.filter((word) => MARKERS.has(word)))];
  if (hits.length === 0) return null;
  if (hits.some((word) => word.length >= STRONG_LENGTH)) return hits;
  if (hits.length >= 2) return hits;
  return null;
}

/**
 * Split a source file into comments, string literals and identifiers.
 *
 * Template literals are treated as one string. The monitor embeds its browser
 * script inside a template literal, so code inside `${...}` is not re-parsed;
 * that is a known, documented limit, not a silent pass.
 *
 * Regular-expression literals are skipped entirely: a pattern is not prose, and
 * scanning one produces false positives such as `tombolReaper` inside
 * `/function tombolReaper\(/`.
 */
export function scanSource(source) {
  const comments = [];
  const strings = [];
  const identifiers = [];
  let index = 0;
  let line = 1;
  let lastSignificant = '';
  const length = source.length;

  const REGEX_PRECEDERS = new Set([
    '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';',
    '+', '-', '*', '%', '<', '>', '~', '^', '',
  ]);

  while (index < length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '\n') {
      line += 1;
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      const start = index;
      const startLine = line;
      while (index < length && source[index] !== '\n') index += 1;
      comments.push({ line: startLine, text: source.slice(start, index) });
      continue;
    }

    if (char === '/' && next === '*') {
      const start = index;
      const startLine = line;
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') line += 1;
        index += 1;
      }
      index += 2;
      comments.push({ line: startLine, text: source.slice(start, index) });
      continue;
    }

    if (char === '/' && REGEX_PRECEDERS.has(lastSignificant)) {
      // Try to read a regex literal. A newline before the closing slash means
      // this was division after all, so rewind and treat it as an operator.
      let cursor = index + 1;
      let inClass = false;
      let closed = false;
      while (cursor < length) {
        const current = source[cursor];
        if (current === '\\') {
          cursor += 2;
          continue;
        }
        if (current === '\n') break;
        if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) {
          closed = true;
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      if (closed) {
        index = cursor;
        lastSignificant = '/';
        continue;
      }
    }

    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      const start = index;
      const startLine = line;
      index += 1;
      while (index < length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        if (source[index] === '\n') line += 1;
        index += 1;
      }
      strings.push({ line: startLine, text: source.slice(start, index) });
      lastSignificant = quote;
      continue;
    }

    if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      while (index < length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      identifiers.push({ line, text: source.slice(start, index) });
      lastSignificant = 'a';
      continue;
    }

    if (!/\s/.test(char)) lastSignificant = char;
    index += 1;
  }

  return { comments, strings, identifiers };
}

function fingerprint(relativePath, kind, text) {
  return createHash('sha256')
    .update(`${relativePath}|${kind}|${String(text).trim()}`)
    .digest('hex')
    .slice(0, 16);
}

function isExempt(relativePath) {
  return EXEMPT_PATH.some((pattern) => pattern.test(relativePath));
}

async function walk(dir, files = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), files);
      continue;
    }
    if (!SOURCE_EXT.test(entry.name)) continue;
    files.push(path.join(dir, entry.name));
  }
  return files;
}

/**
 * @returns {Promise<Array<{file:string,line:number,kind:string,text:string,markers:string[],fingerprint:string}>>}
 */
export async function collectViolations({ root = ROOT } = {}) {
  const files = await walk(root);
  const violations = [];

  for (const absolute of files) {
    const relativePath = path.relative(root, absolute).split(path.sep).join('/');
    if (isExempt(relativePath)) continue;

    const source = await fs.readFile(absolute, 'utf8');
    const lines = source.split('\n');
    const { comments, strings, identifiers } = scanSource(source);

    const parts = [
      ...comments.map((part) => ({ ...part, kind: 'comment' })),
      ...strings.map((part) => ({ ...part, kind: 'string' })),
      ...identifiers.map((part) => ({ ...part, kind: 'identifier' })),
    ];

    for (const part of parts) {
      const markers = findViolation(part.text, { identifier: part.kind === 'identifier' });
      if (!markers) continue;
      const sourceLine = lines[part.line - 1] || '';
      if (ALLOW_DIRECTIVE.test(sourceLine)) continue;
      violations.push({
        file: relativePath,
        line: part.line,
        kind: part.kind,
        text: part.text.replace(/\s+/g, ' ').trim().slice(0, 160),
        markers,
        fingerprint: fingerprint(relativePath, part.kind, part.text),
      });
    }
  }

  return violations;
}

async function readBaseline() {
  try {
    const raw = await fs.readFile(BASELINE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed.fingerprints) ? parsed.fingerprints : []);
  } catch {
    return new Set();
  }
}

async function writeBaseline(violations) {
  const fingerprints = [...new Set(violations.map((item) => item.fingerprint))].sort();
  const payload = {
    note: 'Pre-existing Indonesian engineering text recorded before the English-only gate existed. New violations fail the build; this list may only shrink.',
    generatedAt: new Date().toISOString(),
    count: fingerprints.length,
    fingerprints,
  };
  await fs.writeFile(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return fingerprints.length;
}

function format(violation) {
  return `${violation.file}:${violation.line} [${violation.kind}] ${violation.markers.join(', ')} :: ${violation.text}`;
}

async function main(argv) {
  const json = argv.includes('--json');
  const updateBaseline = argv.includes('--update-baseline');
  const ignoreBaseline = argv.includes('--all');
  const rootFlag = argv.indexOf('--root');
  const root = rootFlag > -1 && argv[rootFlag + 1] ? path.resolve(argv[rootFlag + 1]) : ROOT;

  const violations = await collectViolations({ root });

  if (updateBaseline) {
    const count = await writeBaseline(violations);
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, baseline: count }, null, 2)}\n`);
    } else {
      process.stdout.write(`English policy baseline written: ${count} fingerprint(s).\n`);
    }
    return 0;
  }

  const baseline = ignoreBaseline ? new Set() : await readBaseline();
  const fresh = violations.filter((item) => !baseline.has(item.fingerprint));
  const baselined = violations.length - fresh.length;

  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok: fresh.length === 0,
      total: violations.length,
      baselined,
      fresh: fresh.map(({ fingerprint, ...rest }) => rest),
    }, null, 2)}\n`);
    return fresh.length === 0 ? 0 : 1;
  }

  if (fresh.length === 0) {
    process.stdout.write(
      `English policy: OK (${baselined} baselined violation(s), 0 new).\n`,
    );
    return 0;
  }

  process.stderr.write('English policy: new Indonesian engineering text found.\n');
  process.stderr.write('Write comments, test descriptions, identifiers and assertion messages in English.\n');
  process.stderr.write('If the text is localized product copy, add `language-allow: <reason>` on that line.\n\n');
  for (const violation of fresh) process.stderr.write(`  ${format(violation)}\n`);
  process.stderr.write(`\n${fresh.length} new violation(s); ${baselined} baselined.\n`);
  return 1;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
