/**
 * Isolasi state untuk seluruh proses tes.
 *
 * MASALAH NYATA
 * -------------
 * `resolveStateFile()` memilih proyek dari `process.cwd()`. Karena tes dijalankan
 * dari akar paket ini, dan akar paket punya `package.json`, setiap
 * `new WorkflowState()` tanpa argumen menulis ke `.state/workflow-state.json`
 * MILIK REPO.
 *
 * Akibatnya, 31 Oktober 2026, menjalankan `npm test` di tengah pekerjaan
 * menghapus task yang sedang berjalan: `get_workflow_status` tiba-tiba
 * melaporkan task bernama sebuah tes, dan seluruh langkah workflow (feature
 * flow, tes, dokumentasi) hilang. Diukur saat itu: 16 dari 53 berkas tes
 * mengubah `.state/workflow-state.json` milik repo.
 *
 * Berkas ini dijalankan lewat `node --import ./tests/setup-env.js --test`,
 * sekali per proses tes, SEBELUM modul mana pun dimuat.
 *
 * Yang diarahkan ke direktori sementara hanya dua hal yang memang menulis:
 * state workflow dan basis data state. Tes yang sengaja menguji pemilihan path
 * menghapus variabel ini sendiri, jadi perilaku aslinya tetap bisa diuji.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Satu direktori per proses tes: cukup unik, dan mudah dibersihkan.
const stateDir = mkdtempSync(path.join(tmpdir(), "dev-workflow-test-state-"));

process.env.DEV_WORKFLOW_STATE_FILE = path.join(stateDir, "workflow-state.json");
process.env.DEV_WORKFLOW_DB_PATH = path.join(stateDir, "workflow-state.db");

// Cermin kompatibilitas menulis ke `<paket>/.state/workflow-state.json` tanpa
// peduli di mana state sebenarnya berada. Itulah jalur yang membuat tes
// menghapus task yang sedang berjalan. Matikan selama tes.
process.env.DEV_WORKFLOW_NO_COMPAT_LINKS = "1";

// Penanda supaya tes bisa membuktikan isolasi ini aktif.
process.env.DEV_WORKFLOW_TEST_STATE_DIR = stateDir;

function cleanup() {
  try {
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows kadang masih menahan handle SQLite. Direktori ini ada di tmpdir,
    // jadi sisa berkasnya tidak merusak apa pun - jangan gagalkan tes karenanya.
  }
}

process.once("exit", cleanup);
