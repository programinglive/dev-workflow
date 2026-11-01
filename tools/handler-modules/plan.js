/**
 * Rencana kerja: URUTAN langkah, bukan syarat selesai.
 *
 * MENGAPA TERPISAH DARI DEFINITION OF DONE
 * ----------------------------------------
 * DoD menjawab "apa yang harus benar sebelum task boleh ditutup". Rencana
 * menjawab "sedang di langkah berapa". Tanpa rencana, agen mengeksekusi tanpa
 * jejak yang bisa dibaca manusia: pengguna hanya melihat hasil akhir, atau
 * tidak melihat apa pun sampai ia bertanya.
 *
 * Rencana SENGAJA tidak menjadi gerbang. Ia alat visibilitas; DoD yang
 * memutuskan boleh-tidaknya commit. Menambah gerbang kedua hanya menambah
 * friksi tanpa menambah bukti.
 *
 * Tanpa MCP dan tanpa filesystem, seperti `dod.js` dan `docs.js`.
 */

export const MAX_PLAN_ITEMS = 15;
export const MIN_PLAN_STEP = 3;
export const MAX_PLAN_STEP = 200;

const STATUSES = new Set(["open", "done"]);

function clamp(value, limit = MAX_PLAN_STEP) {
  const text = String(value ?? "").trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * Validasi rencana yang datang dari agen.
 *
 * Ditolak dengan pesan yang menyebut aturannya, bukan "invalid input": agen
 * yang ditolak harus tahu persis apa yang perlu diperbaiki.
 */
export function validatePlanSteps(steps) {
  if (!Array.isArray(steps)) {
    return {
      ok: false,
      error:
        "plan harus berupa daftar langkah, satu langkah per item, contoh: " +
        '["telusuri handler", "tulis tes gagal", "implementasi"].',
    };
  }

  if (steps.length === 0) {
    return {
      ok: false,
      error:
        "plan wajib berisi minimal satu langkah: urutan kerja yang akan " +
        "dijalankan, supaya progresnya bisa dibaca.",
    };
  }

  if (steps.length > MAX_PLAN_ITEMS) {
    return {
      ok: false,
      error: `plan maksimal ${MAX_PLAN_ITEMS} langkah; dikirim ${steps.length}. Gabungkan langkah yang sejenis.`,
    };
  }

  const items = [];
  const seen = new Map();

  for (const [index, raw] of steps.entries()) {
    const text = clamp(raw);

    if (text === "") {
      return { ok: false, error: `Langkah ke-${index + 1} kosong. Tulis satu langkah yang bisa dikerjakan.` };
    }

    if (text.length < MIN_PLAN_STEP) {
      return {
        ok: false,
        error: `Langkah "${text}" terlalu pendek (minimal ${MIN_PLAN_STEP} karakter).`,
      };
    }

    if (String(raw ?? "").trim().length > MAX_PLAN_STEP) {
      return {
        ok: false,
        error: `Langkah ke-${index + 1} lebih dari ${MAX_PLAN_STEP} karakter. Ringkas jadi satu langkah.`,
      };
    }

    const key = text.toLowerCase();
    if (seen.has(key)) {
      return {
        ok: false,
        error: `Langkah "${text}" duplikat dengan langkah ke-${seen.get(key) + 1}.`,
      };
    }
    seen.set(key, index);
    items.push(text);
  }

  return { ok: true, items };
}

/**
 * Normalisasi rencana dari disk.
 *
 * Berbeda dari `validatePlanSteps`: di sini tujuannya JANGAN gagal. Berkas state
 * ditulis versi lama atau oleh proses lain; satu entri rusak tidak boleh membuat
 * workflow tidak bisa dimuat.
 */
export function normalizePlan(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  const plan = [];
  let counter = 0;

  for (const entry of raw) {
    const source = typeof entry === "string" ? { text: entry } : entry && typeof entry === "object" ? entry : null;
    if (!source) continue;

    const text = clamp(source.text);
    if (text === "") continue;
    if (plan.length >= MAX_PLAN_ITEMS) break;

    counter += 1;
    const id = typeof source.id === "string" && source.id.trim() !== "" ? source.id.trim() : `plan-${counter}`;

    plan.push({
      id,
      text,
      status: STATUSES.has(source.status) ? source.status : "open",
      updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : "",
    });
  }

  return plan;
}

/** Buat rencana baru dari daftar teks yang sudah lolos validasi. */
export function createPlan(steps) {
  const list = Array.isArray(steps) ? steps : [];
  return list.map((text, index) => ({
    id: `plan-${index + 1}`,
    text: clamp(text),
    status: "open",
    updatedAt: new Date().toISOString(),
  }));
}

export function planProgress(plan) {
  const list = Array.isArray(plan) ? plan : [];
  const done = list.filter((item) => item.status === "done").length;
  return {
    total: list.length,
    done,
    open: list.length - done,
    next: list.find((item) => item.status !== "done") || null,
  };
}

/**
 * Satu baris progres untuk ditempel di setiap respons tool.
 *
 * Ringkas dengan sengaja: blok ini muncul di SETIAP panggilan, jadi ia harus
 * cukup kecil untuk tidak menenggelamkan jawaban tool itu sendiri.
 */
export function renderPlanShort(plan) {
  const list = Array.isArray(plan) ? plan : [];
  if (list.length === 0) {
    return "";
  }

  const progress = planProgress(list);
  const next = progress.next ? ` — berikutnya: ${progress.next.text}` : " — semua langkah selesai";
  return `📋 Rencana ${progress.done}/${progress.total}${next}`;
}

/** Daftar penuh, untuk `get_workflow_status`. */
export function renderPlanFull(plan) {
  const list = Array.isArray(plan) ? plan : [];
  if (list.length === 0) {
    return "Rencana: belum ada rencana untuk task ini - isi dengan 'set_plan' { steps: [...] }.";
  }

  const progress = planProgress(list);
  const lines = list.map(
    (item) => `${item.status === "done" ? "[x]" : "[ ]"} ${item.text}`,
  );

  return `Rencana: ${progress.done}/${progress.total} selesai\n${lines.join("\n")}`;
}
