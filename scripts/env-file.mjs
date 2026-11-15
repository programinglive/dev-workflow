/**
 * Safe parser for an environment file.
 *
 * `/etc/devwf-monitor.env` contains values with spaces (`IDLE_TTL=30 minutes`).
 * Sourcing that file into a shell splits the value and runs `minutes` as a
 * command, which is exactly what happened during the release check:
 *
 *   sh: 2: /etc/devwf-monitor.env: minutes: not found
 *
 * This parser reads `KEY=value` pairs literally, so a value keeps its spaces and
 * nothing in the file is ever executed.
 */

/**
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(equals + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/**
 * Read and parse an environment file. A missing file is an empty map, not a
 * crash: the caller decides whether the absence is fatal.
 *
 * @param {string} filePath
 * @param {{readFile: (path: string, encoding: string) => Promise<string>}} fsLike
 */
export async function readEnvFile(filePath, fsLike) {
  try {
    return parseEnvFile(await fsLike.readFile(filePath, 'utf8'));
  } catch {
    return {};
  }
}
