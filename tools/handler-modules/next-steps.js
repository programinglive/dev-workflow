/**
 * Rekomendasi pekerjaan selanjutnya, sebagai fungsi murni.
 *
 * MENGAPA DIPISAH FAKTA DAN OPINI
 * -------------------------------
 * Saran yang selalu muncul untuk semua task akan diabaikan, dan itu merusak
 * kepercayaan pada butir yang benar-benar penting. Karena itu setiap butir
 * "fakta" di sini punya sumber yang bisa ditunjuk (item DoD yang dilewati, tes
 * yang di-skip, TODO yang baru masuk diff, berkas yang tertinggal), dan saran
 * dari agen diberi label sendiri. MCP tidak pernah mengarang.
 *
 * Tanpa MCP dan tanpa filesystem, seperti `dod.js` dan `docs.js`.
 */

export const MAX_RECOMMENDATIONS = 6;
export const MAX_AI_SUGGESTIONS = 5;
export const MIN_AI_SUGGESTION = 10;
export const MAX_AI_SUGGESTION = 200;

const MAX_TODO_SIGNALS = 5;
const MAX_TITLE = 300;
const LARGE_DIFF_FILES = 15;
const BUGFIX_LOOKBACK = 5;
const BUGFIX_THRESHOLD = 3;

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const PRIORITY_LABEL = { high: "tinggi", medium: "sedang", low: "rendah" };

function clamp(value, limit = MAX_TITLE) {
  const text = String(value ?? "").trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * Validasi saran dari agen.
 *
 * Argumen yang tidak valid DITOLAK dengan penjelasan, bukan dibuang diam-diam:
 * saran yang hilang tanpa pesan membuat agen mengira sarannya tersimpan.
 * Array kosong berarti "tidak dikirim" dan selalu sah.
 */
export function validateAiSuggestions(raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, items: [] };
  }

  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error:
        "nextSteps harus berupa daftar teks, contoh: " +
        '["perbaiki refreshToken", "tambah tes retry"]',
    };
  }

  const items = [];
  for (const entry of raw) {
    if (entry === undefined || entry === null) continue;
    // Sengaja TIDAK dipotong di sini: memotong lebih dulu membuat saran
    // kepanjangan lolos sebagai 200 karakter yang sah.
    const text = String(entry).trim();
    if (text === "") continue;
    items.push(text);
  }

  if (items.length > MAX_AI_SUGGESTIONS) {
    return {
      ok: false,
      error: `nextSteps maksimal ${MAX_AI_SUGGESTIONS} butir; dikirim ${items.length}.`,
    };
  }

  const tooLong = items.find((text) => text.length > MAX_AI_SUGGESTION);
  if (tooLong) {
    return {
      ok: false,
      error:
        `Saran sepanjang ${tooLong.length} karakter melebihi batas ${MAX_AI_SUGGESTION}. ` +
        "Ringkas menjadi satu langkah.",
    };
  }

  const tooShort = items.find((text) => text.length < MIN_AI_SUGGESTION);
  if (tooShort) {
    return {
      ok: false,
      error:
        `Saran "${tooShort}" terlalu pendek (minimal ${MIN_AI_SUGGESTION} karakter). ` +
        "Tulis satu langkah yang bisa dikerjakan orang lain tanpa bertanya.",
    };
  }

  return { ok: true, items };
}

/**
 * Kumpulkan tindak lanjut dari fakta sesi.
 *
 * Semua masukan bersifat opsional: pemanggil tanpa `git` tetap mendapat sinyal
 * dari state. Yang tidak bisa diperiksa tidak dikarang - ia dilewati.
 */
export function collectSignals({
  state = {},
  commitInspection = null,
  statusOutput = "",
  dirtyAtStart = [],
} = {}) {
  const signals = [];
  const push = (priority, title) => {
    const text = clamp(title);
    if (text) signals.push({ priority, source: "signal", title: text });
  };

  const dodItems = Array.isArray(state.definitionOfDone) ? state.definitionOfDone : [];
  for (const item of dodItems) {
    if (item?.status !== "waived") continue;
    const reason = item.waivedReason ? `: ${item.waivedReason}` : "";
    push("high", `DoD "${item.text}" dilewati${reason}`);
  }

  if (state.testsSkipped) {
    push("high", `Tes di-skip: ${state.testsSkippedReason || "(tanpa alasan)"}`);
  }

  if (state.documentationWaived) {
    push(
      "high",
      `Dokumentasi dikecualikan: ${state.documentationWaiverReason || "(tanpa alasan)"}`,
    );
  }

  const foreign = foreignDirtyPaths(statusOutput, dirtyAtStart);
  if (foreign.length > 0) {
    push(
      "high",
      `${foreign.length} berkas tertinggal tanpa di-commit (pekerjaan sesi lain): ` +
        foreign.slice(0, 3).join(", "),
    );
  }

  const todos = Array.isArray(commitInspection?.todos) ? commitInspection.todos : [];
  if (todos.length > 0) {
    const shown = todos.slice(0, MAX_TODO_SIGNALS);
    const where = shown.map((todo) => `${todo.path}:${todo.line}`).join(", ");
    const total = todos.length > MAX_TODO_SIGNALS ? ` (${todos.length} total)` : "";
    push("medium", `${shown.length} TODO baru masuk diff${total}: ${where}`);
  }

  const history = Array.isArray(state.history) ? state.history : [];
  const recent = history.slice(-BUGFIX_LOOKBACK);
  const bugfixes = recent.filter((entry) => entry?.taskType === "bugfix").length;
  if (bugfixes >= BUGFIX_THRESHOLD) {
    push(
      "medium",
      `${bugfixes} dari ${recent.length} task terakhir bertipe bugfix — ` +
        "pertimbangkan memperbaiki akar masalahnya, bukan gejalanya",
    );
  }

  const changedFiles = Array.isArray(commitInspection?.paths) ? commitInspection.paths.length : 0;
  if (changedFiles > LARGE_DIFF_FILES) {
    push(
      "low",
      `Diff menyentuh ${changedFiles} berkas — task berikutnya sebaiknya dipecah`,
    );
  }

  if (state.releaseSkipped) {
    push("low", `Rilis di-skip: ${state.releaseSkippedReason || "(tanpa alasan)"}`);
  }

  // Sembilan sinyal, sesuai tabel spec. Yang terakhir mudah terlewat karena
  // hanya terlihat setelah beberapa task: dokumentasi selalu dicatat, tetapi
  // tidak pernah benar-benar menyentuh README.
  if (
    state.documentationCreated &&
    !state.documentationWaived &&
    state.documentationType !== "README" &&
    state.documentationType !== "API-docs"
  ) {
    push(
      "low",
      `Dokumentasi dicatat sebagai "${state.documentationType}", bukan README atau API-docs — ` +
        "pastikan README memang tidak perlu berubah",
    );
  }

  return signals;
}

/**
 * Berkas yang sudah kotor sebelum task dimulai dan masih kotor sekarang.
 *
 * Disalin dari `git-helpers.js` (`foreignDirtyEntries`) karena aturan ini harus
 * tetap murni. Baseline kosong berarti tidak ada dasar menyebut sesuatu "bukan
 * milik kita", jadi hasilnya kosong.
 */
function foreignDirtyPaths(statusOutput, dirtyAtStart) {
  const baseline = new Set(
    (Array.isArray(dirtyAtStart) ? dirtyAtStart : [])
      .map((entry) => String(entry?.path ?? entry ?? "").trim())
      .filter(Boolean),
  );
  if (baseline.size === 0 || typeof statusOutput !== "string" || statusOutput.trim() === "") {
    return [];
  }

  return statusOutput
    .split("\n")
    .filter((line) => line && line.trim() !== "")
    .map((line) => {
      const match = /^\s*([MADRCU?!]{1,2})\s+(.*)$/.exec(line);
      if (!match) return "";
      const rawPath = match[2].trim();
      return rawPath.includes(" -> ") ? rawPath.split(" -> ").pop().trim() : rawPath;
    })
    .filter((p) => p && baseline.has(p));
}

/**
 * Urutkan, buang duplikat, potong, lalu tambahkan saran agen.
 *
 * Saran agen selalu di BELAKANG fakta: fakta lebih murah dipercaya, dan butir
 * pertama yang dibaca agen berikutnya menentukan apa yang dikerjakannya.
 */
export function buildRecommendations({ signals = [], aiSuggestions = [] } = {}) {
  const seen = new Set();
  const facts = [];

  const sorted = (Array.isArray(signals) ? signals : [])
    .filter((item) => item && item.title)
    .slice()
    .sort(
      (a, b) =>
        (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9),
    );

  for (const item of sorted) {
    const key = String(item.title).trim().toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    facts.push({
      priority: item.priority || "low",
      source: "signal",
      title: clamp(item.title),
    });
    if (facts.length >= MAX_RECOMMENDATIONS) break;
  }

  const suggestions = (Array.isArray(aiSuggestions) ? aiSuggestions : [])
    .map((text) => clamp(text, MAX_AI_SUGGESTION))
    .filter(Boolean)
    .slice(0, MAX_AI_SUGGESTIONS)
    .map((title) => ({ priority: "medium", source: "ai", title }));

  return [...facts, ...suggestions];
}

export function renderRecommendations(items = []) {
  const list = Array.isArray(items) ? items : [];
  const facts = list.filter((item) => item.source === "signal");
  const suggestions = list.filter((item) => item.source === "ai");

  if (facts.length === 0 && suggestions.length === 0) {
    return "🔮 Saran pekerjaan selanjutnya\n\nTidak ada sinyal yang perlu ditindaklanjuti dari sesi ini.";
  }

  const lines = ["🔮 Saran pekerjaan selanjutnya", ""];
  let counter = 0;

  if (facts.length > 0) {
    lines.push("Dari fakta sesi ini:");
    for (const item of facts) {
      counter += 1;
      lines.push(` ${counter}. [${PRIORITY_LABEL[item.priority] || item.priority}] ${item.title}`);
    }
    lines.push("");
  }

  if (suggestions.length > 0) {
    lines.push("Saran sesi ini:");
    for (const item of suggestions) {
      counter += 1;
      lines.push(` ${counter}. ${item.title}`);
    }
  }

  return lines.join("\n").trimEnd();
}
