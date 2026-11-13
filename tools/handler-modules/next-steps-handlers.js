import { textResponse } from "./shared.js";
import { renderRecommendations } from "./next-steps.js";

/**
 * Tampilkan rekomendasi tersimpan dari task terakhir.
 *
 * History adalah catatan PROYEK, bukan sesi (`workflow-state.js`), jadi
 * rekomendasi yang dicatat sesi lain terbaca dari sini. Entri lama dari sebelum
 * fitur ini ada tidak punya `recommendations`; itu dilewati, bukan dianggap
 * error.
 */
export async function handleNextSteps(args, workflowState) {
  const history = Array.isArray(workflowState.state.history) ? workflowState.state.history : [];

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    const items = Array.isArray(entry?.recommendations) ? entry.recommendations : [];
    if (items.length === 0) continue;

    const when = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "waktu tidak tercatat";
    const task = entry.taskDescription ? `Task: ${entry.taskDescription}` : "Task: (tanpa deskripsi)";

    return textResponse(
      `${renderRecommendations(items)}\n\n` +
        `— dari task terakhir: ${task} (${when})`,
    );
  }

  const recent = history.slice(-5).reverse();
  const recap = recent.length > 0
    ? `\n\n📜 Task terakhir:\n` +
      recent
        .map((entry, index) => ` ${index + 1}. ${entry.taskDescription || "(tanpa deskripsi)"} (${entry.taskType || "other"})`)
        .join("\n")
    : "\n\nBelum ada task yang tercatat untuk proyek ini.";

  return textResponse(
    `Belum ada rekomendasi tersimpan. Rekomendasi dicatat saat 'complete_task' — ` +
      `sertakan 'nextSteps' di sana supaya sesi berikutnya punya titik mulai.${recap}`
  );
}
