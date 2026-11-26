/**
 * @zettly-code DWF-USER-CONFIG-001
 * @purpose Load optional user-owned configuration from outside the repository, with empty defaults committed in the package.
 */
import fs from 'node:fs';
import path from 'node:path';

export function loadUserConfig(envVar, defaultRelativePath, root = process.cwd()) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(path.join(root, defaultRelativePath), 'utf8')) || {};
  } catch {
    data = {};
  }
  const override = process.env[envVar];
  if (typeof override === 'string' && override.trim()) {
    try {
      const extra = JSON.parse(fs.readFileSync(path.resolve(override), 'utf8')) || {};
      data = { ...data, ...extra };
    } catch {
      // A broken user config must not break startup; empty defaults remain.
    }
  }
  return data;
}
