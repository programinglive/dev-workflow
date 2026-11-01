'use strict';

/**
 * Tool AI apa yang menjalankan sesi ini.
 *
 * MENGAPA PERLU
 * -------------
 * Pemilik memakai tiga alat berbeda terhadap server MCP yang sama - Codex,
 * Antigravity, dan OpenCode - dan ingin melihat di dashboard mana yang
 * menghasilkan sesi. Tanpa label, semua kartu tampak sama.
 *
 * DARI MANA BUKTINYA
 * ------------------
 * Tidak ada satu pun sinyal yang selalu ada, jadi dipakai berurutan dan
 * hasilnya TIDAK PERNAH diklaim lebih pasti daripada buktinya:
 *
 *   1. `DEVWF_AGENT`         - diisi eksplisit di config tiap alat (paling pasti)
 *   2. metadata MCP dari host - Codex mengirim `codex/...`, OpenCode mengirim
 *                              `ai.opencode/...` pada `params._meta`
 *   3. nama proses induk     - cadangan terakhir
 *
 * Bila tidak ada yang cocok, hasilnya "unknown" - bukan tebakan.
 *
 * Berkas ini tidak menyentuh jaringan, hanya membaca string.
 */

const DEFAULT_TOOL = 'unknown';

/** Pola pada kunci metadata MCP yang menandakan alat pemanggilnya. */
const META_PATTERNS = [
  { pola: /^codex\//i, tool: 'codex' },
  { pola: /^ai\.opencode\//i, tool: 'opencode' },
  { pola: /^opencode\//i, tool: 'opencode' },
  { pola: /^antigravity\//i, tool: 'antigravity' },
  { pola: /^google\.antigravity/i, tool: 'antigravity' },
];

/** Pola pada nama proses/perintah, dipakai sebagai cadangan. */
const PROCESS_PATTERNS = [
  { pola: /antigravity/i, tool: 'antigravity' },
  { pola: /\bcodex\b/i, tool: 'codex' },
  { pola: /opencode/i, tool: 'opencode' },
];

/**
 * Kenali tool dari beberapa petunjuk yang mungkin tersedia.
 *
 * @param {object} args
 * @param {object} [args.env]           environment proses
 * @param {Array<string>} [args.metaKeys] kunci `_meta` dari request MCP
 * @param {string} [args.commandLine]   nama perintah/proses induk
 * @returns {string} nama tool huruf kecil, atau 'unknown'
 */
function detectTool({ env = {}, metaKeys = [], commandLine = '' } = {}) {
  const eksplisit = String((env && env.DEVWF_AGENT) || '').trim().toLowerCase();
  if (eksplisit) return eksplisit;

  for (const kunci of Array.isArray(metaKeys) ? metaKeys : []) {
    const teks = String(kunci || '');
    for (const { pola, tool } of META_PATTERNS) {
      if (pola.test(teks)) return tool;
    }
  }

  const cmd = String(commandLine || '');
  if (cmd) {
    for (const { pola, tool } of PROCESS_PATTERNS) {
      if (pola.test(cmd)) return tool;
    }
  }

  return DEFAULT_TOOL;
}

module.exports = { detectTool, DEFAULT_TOOL, META_PATTERNS, PROCESS_PATTERNS };
