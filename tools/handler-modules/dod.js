/**
 * Aturan Definition of Done, sebagai fungsi murni.
 *
 * Semua di sini sengaja tanpa MCP dan tanpa filesystem: aturan "kapan sebuah
 * task benar-benar selesai" harus bisa dibaca dan diuji tanpa menyalakan
 * server. Handler di `dod-handlers.js` hanya memvalidasi, mengubah state, lalu
 * menyimpan.
 *
 * MENGAPA PER ITEM, BUKAN SATU TEKS
 * ---------------------------------
 * DoD bisa datang sebagai teks checklist. Itu cukup untuk gerbang
 * "tidak boleh kosong", tetapi tidak bisa membedakan "sudah dibuktikan" dari
 * "ditulis lalu dilupakan". Di sini tiap item punya status sendiri, bukti
 * sendiri, dan revisi saat ia dibuktikan.
 */

export const MAX_ITEMS = 20;
export const MIN_TEXT = 3;
export const MAX_TEXT = 300;
export const MIN_EVIDENCE = 5;
export const MAX_EVIDENCE = 500;

const STATUSES = new Set(["open", "done", "waived"]);

/** Peringkat status untuk penggabungan antar-proses: makin tinggi makin kuat. */
const STATUS_RANK = { open: 0, waived: 1, done: 2 };

function clampText(value, limit = MAX_TEXT) {
  const text = String(value ?? "").trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * Validasi daftar teks DoD yang datang dari agen.
 *
 * Dipakai `start_task` dan `set_definition_of_done`. Menolak dengan pesan yang
 * menyebut aturannya, bukan sekadar "invalid input", karena agen yang ditolak
 * harus tahu persis apa yang harus diperbaiki.
 */
export function validateItemTexts(texts) {
  if (!Array.isArray(texts)) {
    return {
      ok: false,
      error:
        "definitionOfDone harus berupa daftar teks, satu kondisi per item, " +
        'contoh: ["build lulus", "halaman login terverifikasi"].',
    };
  }

  if (texts.length === 0) {
    return {
      ok: false,
      error:
        "definitionOfDone wajib berisi minimal satu item: kondisi konkret yang harus " +
        "benar sebelum task boleh dianggap selesai.",
    };
  }

  if (texts.length > MAX_ITEMS) {
    return {
      ok: false,
      error: `definitionOfDone maksimal ${MAX_ITEMS} item; dikirim ${texts.length}. Gabungkan kondisi yang sejenis.`,
    };
  }

  const items = [];
  const seen = new Map();

  for (const [index, raw] of texts.entries()) {
    const text = clampText(raw);

    if (text === "") {
      return { ok: false, error: `Item DoD ke-${index + 1} kosong. Setiap item harus berisi kondisi yang bisa dibuktikan.` };
    }

    if (text.length < MIN_TEXT) {
      return {
        ok: false,
        error: `Item DoD "${text}" terlalu pendek (minimal ${MIN_TEXT} karakter). Tulis kondisi yang bisa diperiksa, contoh: "build lulus".`,
      };
    }

    if (String(raw ?? "").trim().length > MAX_TEXT) {
      return {
        ok: false,
        error: `Item DoD ke-${index + 1} lebih dari ${MAX_TEXT} karakter. Ringkas jadi satu kondisi.`,
      };
    }

    const key = text.toLowerCase();
    if (seen.has(key)) {
      return {
        ok: false,
        error: `Item DoD "${text}" duplikat dengan item ke-${seen.get(key) + 1}. Setiap kondisi hanya boleh muncul sekali.`,
      };
    }
    seen.set(key, index);
    items.push(text);
  }

  return { ok: true, items };
}

/**
 * Normalisasi state yang dibaca dari disk.
 *
 * Berbeda dari `validateItemTexts`: di sini tujuannya JANGAN gagal. Berkas state
 * ditulis versi lama, atau oleh proses lain yang sedang berjalan; satu entri
 * rusak tidak boleh membuat seluruh workflow tidak bisa dimuat. Entri yang tidak
 * bisa diselamatkan dibuang, sisanya diperbaiki.
 */
export function normalizeItems(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  const items = [];
  const usedIds = new Set();

  for (const entry of raw) {
    const source = typeof entry === "string" ? { text: entry } : entry && typeof entry === "object" ? entry : null;
    if (!source) continue;

    const text = clampText(source.text);
    if (text === "") continue;
    if (items.length >= MAX_ITEMS) break;

    let id = typeof source.id === "string" ? source.id.trim() : "";
    if (id === "" || usedIds.has(id)) {
      id = nextItemId(items.concat(Array.from(usedIds, (value) => ({ id: value }))));
    }
    usedIds.add(id);

    const status = STATUSES.has(source.status) ? source.status : "open";
    const revision = Number.isFinite(Number(source.revision)) && Number(source.revision) >= 0
      ? Math.trunc(Number(source.revision))
      : 0;

    items.push({
      id,
      text,
      status,
      evidence: status === "done" ? clampText(source.evidence, MAX_EVIDENCE) : "",
      waivedReason: status === "waived" ? clampText(source.waivedReason, MAX_EVIDENCE) : "",
      revision,
      updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : "",
    });
  }

  return items;
}

/**
 * Membaca checklist (markdown) menjadi daftar teks.
 *
 * Butir `- [x]` tetap diimpor sebagai item BIASA (status `open` di sisi
 * pemanggil): checklist adalah rencana kerja, bukan bukti. Kalau kotak centang
 * dipercaya apa adanya, agen bisa mewarisi klaim orang lain tanpa pernah
 * menjalankan apa pun di mesin ini.
 */
export function parseChecklist(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const items = [];
  const seen = new Set();
  let truncated = false;

  for (const line of lines) {
    if (items.length >= MAX_ITEMS) {
      truncated = true;
      break;
    }

    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^#{1,6}\s/.test(trimmed)) continue;

    const checkbox = trimmed.match(/^[-*+]\s*\[[ xX]\]\s*(.+)$/);
    const bullet = checkbox ? null : trimmed.match(/^[-*+]\s+(.+)$/);
    const captured = checkbox?.[1] ?? bullet?.[1];
    if (!captured) continue;

    let item = captured.trim();
    if (item === "") continue;

    if (item.length > MAX_TEXT) {
      item = item.slice(0, MAX_TEXT);
      truncated = true;
    }

    const key = item.toLowerCase();
    if (seen.has(key)) {
      truncated = true;
      continue;
    }
    seen.add(key);
    items.push(item);
  }

  return { items, truncated };
}

/**
 * Apakah satu item sudah memenuhi syaratnya.
 *
 * Item `done` hanya memenuhi bila dibuktikan pada revisi yang sedang berlaku.
 * Saat perubahan kerja baru muncul setelah commit, `dodRevision` naik dan bukti
 * lama otomatis tidak lagi berlaku - tanpa perlu menulis ulang item mana pun.
 * Item `waived` tetap memenuhi, karena waiver adalah keputusan, bukan bukti.
 */
export function isSatisfied(item, revision) {
  if (!item) return false;
  if (item.status === "waived") return true;
  if (item.status !== "done") return false;
  return Number(item.revision) === Number(revision);
}

function maxItemNumber(items) {
  let max = 0;
  for (const item of items) {
    const match = /^dod-(\d+)$/.exec(String(item?.id ?? ""));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

export function nextItemId(items) {
  return `dod-${maxItemNumber(items) + 1}`;
}

export function openItems(items, revision) {
  return (Array.isArray(items) ? items : []).filter((item) => !isSatisfied(item, revision));
}

export function summarize(items, revision) {
  const list = Array.isArray(items) ? items : [];
  const waivedReasons = [];
  let done = 0;
  let waived = 0;

  for (const item of list) {
    if (item.status === "waived") {
      waived += 1;
      if (item.waivedReason) waivedReasons.push(item.waivedReason);
      continue;
    }
    if (isSatisfied(item, revision)) done += 1;
  }

  return {
    total: list.length,
    done,
    waived,
    open: list.length - done - waived,
    waivedReasons,
  };
}

/**
 * Daftar item yang belum terpenuhi, LENGKAP dengan id-nya.
 *
 * `renderChecklist` sengaja hanya menampilkan kondisi (untuk dibaca manusia).
 * Pesan penolakan butuh id, karena tanpa id agen tidak tahu item mana yang
 * harus dibuktikan lewat `mark_dod_item`.
 */
export function renderOutstanding(items, revision) {
  return openItems(items, revision)
    .map((item) => {
      const state = item.status === "done" ? "bukti basi, perlu konfirmasi ulang" : "terbuka";
      return `- ${item.id} [${state}]: ${item.text}`;
    })
    .join("\n");
}

export function renderChecklist(items, revision) {  const list = Array.isArray(items) ? items : [];

  return list
    .map((item) => {
      const text = String(item.text ?? "");
      if (item.status === "waived") {
        return `- [~] ${text} — dilewati: ${item.waivedReason || "(tanpa alasan)"}`;
      }
      if (item.status === "done" && !isSatisfied(item, revision)) {
        return `- [!] ${text} — bukti basi, perlu konfirmasi ulang`;
      }
      if (item.status === "done") {
        return `- [x] ${text} — bukti: ${item.evidence}`;
      }
      return `- [ ] ${text}`;
    })
    .join("\n");
}

/**
 * Menggabungkan DoD milik proses ini dengan yang ada di disk.
 *
 * Dua proses MCP bisa melayani task yang sama. Kalau array digabung begitu saja
 * dengan "yang terakhir menulis menang", proses yang memegang state basi akan
 * menghapus bukti yang baru dicatat proses lain. Karena itu per id dipilih entri
 * yang lebih kuat menurut (peringkat status, revisi), dan item yang hanya ada di
 * salah satu sisi tetap dipertahankan.
 */
export function mergeDefinitionOfDone(memoryItems, diskItems) {
  const memory = Array.isArray(memoryItems) ? memoryItems : [];
  const disk = Array.isArray(diskItems) ? diskItems : [];

  const stronger = (a, b) => {
    const rankA = STATUS_RANK[a.status] ?? 0;
    const rankB = STATUS_RANK[b.status] ?? 0;
    if (rankA !== rankB) return rankA > rankB ? a : b;
    return Number(a.revision) >= Number(b.revision) ? a : b;
  };

  const diskById = new Map();
  for (const item of disk) {
    if (item?.id) diskById.set(item.id, item);
  }

  const merged = [];
  const seen = new Set();

  for (const item of memory) {
    if (!item?.id) continue;
    seen.add(item.id);
    const fromDisk = diskById.get(item.id);
    merged.push(fromDisk ? stronger(item, fromDisk) : item);
  }

  for (const item of disk) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }

  return merged;
}
