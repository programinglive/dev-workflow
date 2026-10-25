import { test } from 'node:test';
import assert from 'node:assert';
import { readFile, access } from 'fs/promises';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import path from 'path';

import { stripNpmNotices } from './test-helpers.js';

const exec = promisify(execCallback);

test('build generates dist/index.mjs file', async () => {
  const { stderr } = await exec('npx cross-env NODE_ENV=development npm run build:server');
  // Allow the known vite warning about node:process
  const knownWarning = '[plugin vite:resolve] Module "node:process" has been externalized for browser compatibility';
  const tailwindOutput = '≈ tailwindcss';
  const browserslistWarning = 'Browserslist: caniuse-lite is outdated';
  // npm's own warn/notice lines come from user-level npm configuration and say
  // nothing about this build; strip them along with ANSI codes.
  const actualStderr = stripNpmNotices(stderr);
  assert(
    actualStderr.trim() === '' || actualStderr.includes(knownWarning) || actualStderr.includes(tailwindOutput) || actualStderr.includes(browserslistWarning),
    `Build should not have unexpected errors: ${actualStderr}`
  );

  // Verify the file exists
  const distPath = path.join(process.cwd(), 'dist', 'index.mjs');
  await access(distPath);

  // Verify it contains expected content
  const content = await readFile(distPath, 'utf-8');
  assert(content.includes('main'), 'Bundle should contain main function');
  assert(content.length > 1000, 'Bundle should be substantial');
});

test('build script exists in package.json', async () => {
  const packagePath = path.join(process.cwd(), 'package.json');
  const content = await readFile(packagePath, 'utf-8');
  const pkg = JSON.parse(content);

  assert.strictEqual(typeof pkg.scripts['build:server'], 'string');
  assert(pkg.scripts['build:server'].includes('vite build'));
});

test('Hero component fetches npm downloads directly', async () => {
  const heroPath = path.join(process.cwd(), 'web', 'components', 'Hero.tsx');
  const heroContent = await readFile(heroPath, 'utf-8');

  // Verify it fetches npm downloads directly from npm API
  assert(heroContent.includes('api.npmjs.org'), 'Hero should fetch downloads from npm API');
  // Downloads come from the npm API; the displayed version comes from
  // WEB_VERSION (see commit b579113 "sync version badges with package
  // metadata"), so the old useState-based version assertion no longer applies.
  assert(
    heroContent.includes('useState<number | null>(null)'),
    'Hero should track download count in state'
  );
  assert(heroContent.includes('WEB_VERSION'), 'Hero should render the shared WEB_VERSION badge');
});

test('Netlify deployment configuration exists for static export', async () => {
  const netlifyTomlPath = path.join(process.cwd(), 'web', 'netlify.toml');
  await access(netlifyTomlPath);
  
  const content = await readFile(netlifyTomlPath, 'utf-8');
  assert(content.includes('[build]'), 'netlify.toml should have build section');
  assert(content.includes('npm run build'), 'netlify.toml should have build command');
  assert(content.includes('publish = "out"'), 'netlify.toml should publish out directory for static export');
});

test('Web package.json does not include better-sqlite3', async () => {
  const webPackagePath = path.join(process.cwd(), 'web', 'package.json');
  const content = await readFile(webPackagePath, 'utf-8');
  const pkg = JSON.parse(content);
  
  assert(!pkg.dependencies['better-sqlite3'], 'Web should not depend on better-sqlite3 for Netlify compatibility');
});

test('Next.js config uses static export for Netlify', async () => {
  const nextConfigPath = path.join(process.cwd(), 'web', 'next.config.ts');
  const content = await readFile(nextConfigPath, 'utf-8');
  
  assert(content.includes("output: 'export'"), 'next.config.ts should use static export');
  assert(content.includes('unoptimized: true'), 'next.config.ts should disable image optimization for static export');
});
