#!/usr/bin/env node
import { safeLog } from '../security/sanitizer.js';

/**
 * Installs husky git hooks when running inside a git checkout, and does
 * nothing otherwise.
 *
 * `prepare` runs on every `npm install`, including when the package is
 * installed from the registry as a dependency. In that case there is no .git
 * directory, and `husky` exits non-zero, which fails the consumer's install.
 * The `husky || true` idiom does not help on Windows, where npm runs scripts
 * through cmd.exe.
 */

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(path.join(projectRoot, '.git'))) {
  safeLog('info', 'Not a git checkout - skipping husky install.');
  process.exit(0);
}

try {
  // Resolve the local binary rather than relying on PATH: npm scripts get
  // node_modules/.bin on PATH, but a direct `node scripts/...` invocation does
  // not, and on Windows `husky` is a .cmd shim.
  const huskyBin = path.join(
    projectRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'husky.cmd' : 'husky',
  );
  const command = existsSync(huskyBin) ? `"${huskyBin}"` : 'husky';
  execSync(command, { cwd: projectRoot, stdio: 'inherit', shell: true });
} catch (error) {
  // Never fail an install because git hooks could not be set up.
  safeLog('warn', `Could not install husky hooks: ${error.message}`);
}

process.exit(0);
