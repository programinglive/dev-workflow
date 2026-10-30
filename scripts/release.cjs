#!/usr/bin/env node
const { ready, safeLog, flushLogs, assertSafeKnowledge, spawnLogged } = require('../security/log-bridge.cjs');

const spawnSync = spawnLogged;
const fs = require('fs');
const path = require('path');

const { updateReleaseNotes } = require('./update-release-notes.cjs');

const fsFokPreloadPath = path.join(__dirname, 'preload', 'fs-f-ok.cjs');
const FS_FOK_PRELOAD_FLAG = buildPreloadFlag(fsFokPreloadPath);

require('./preload/fs-f-ok.cjs');

const DEFAULT_PRD_RELATIVE_PATH = path.join('docs', 'PRD.md');
const DEFAULT_PRD_DISPLAY_PATH = 'docs/PRD.md';

const VALID_RELEASE_TYPES = new Set([
  'major',
  'minor',
  'patch',
  'premajor',
  'preminor',
  'prepatch',
  'prerelease'
]);

const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const LOCKFILE_PREFERENCES = [
  { manager: 'pnpm', file: 'pnpm-lock.yaml' },
  { manager: 'yarn', file: 'yarn.lock' },
  { manager: 'bun', file: 'bun.lock' },
  { manager: 'npm', file: 'package-lock.json' }
];

function getCliArguments(argv = process.argv) {
  const rawArgs = argv.slice(2);
  if (rawArgs.length === 0) {
    return { releaseType: 'patch', extraArgs: [] };
  }

  // `--release-as` selalu diambil sebagai tipe rilis dan DIBUANG dari extraArgs.
  //
  // Kalau dibiarkan, argumen itu sampai ke standard-version dua kali: sekali
  // dari releaseType, sekali dari extraArgs. yargs lalu mengubahnya menjadi
  // array, dan `semver.inc("1.13.2", ["patch","patch"])` mengembalikan null -
  // rilis menulis `"version": null` dan tag `vnull`.
  const releaseAsIndex = rawArgs.indexOf('--release-as');
  if (releaseAsIndex !== -1) {
    const value = rawArgs[releaseAsIndex + 1];
    if (!value || value.startsWith('-')) {
      throw new Error(
        '--release-as memerlukan nilai tipe rilis (major, minor, patch, atau versi semver).'
      );
    }
    return {
      releaseType: value,
      extraArgs: [...rawArgs.slice(0, releaseAsIndex), ...rawArgs.slice(releaseAsIndex + 2)]
    };
  }

  const inline = rawArgs.find((arg) => arg.startsWith('--release-as='));
  if (inline) {
    const value = inline.slice('--release-as='.length);
    if (!value) {
      throw new Error(
        '--release-as memerlukan nilai tipe rilis (major, minor, patch, atau versi semver).'
      );
    }
    return {
      releaseType: value,
      extraArgs: rawArgs.filter((arg) => arg !== inline)
    };
  }

  if (rawArgs[0].startsWith('-')) {
    return { releaseType: 'patch', extraArgs: rawArgs };
  }

  const [firstArg, ...rest] = rawArgs;
  return { releaseType: firstArg, extraArgs: rest };
}

function getNpmRunArgument(env = process.env) {
  try {
    const npmArgs = JSON.parse(env.npm_config_argv || '{}');
    const original = npmArgs.original || [];
    const releaseIndex = original.lastIndexOf('release');
    if (releaseIndex !== -1) {
      return original[releaseIndex + 1];
    }
  } catch (error) {
    // Ignore JSON parsing issues and fall back to defaults
  }
  return undefined;
}

/**
 * Membuang setiap `--release-as` dari argumen tambahan.
 *
 * Pertahanan lapis kedua: tipe rilis sudah ditentukan lewat `releaseType`, jadi
 * salinan apa pun di `extraArgs` hanya akan menggandakan opsi dan membuat yargs
 * memberinya array - yang berakhir pada `semver.inc(...) === null`.
 */
function stripReleaseAs(extraArgs) {
  if (!Array.isArray(extraArgs)) {
    return [];
  }

  const kept = [];
  for (let index = 0; index < extraArgs.length; index += 1) {
    const arg = extraArgs[index];
    if (arg === '--release-as') {
      index += 1; // lewati nilainya juga
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--release-as=')) {
      continue;
    }
    kept.push(arg);
  }
  return kept;
}

function buildStandardVersionArgs({ releaseType, extraArgs }) {
  const args = [];
  const remainingArgs = stripReleaseAs(extraArgs);

  // Handle --first-release flag
  const isFirstRelease = remainingArgs.includes('--first-release');
  if (isFirstRelease) {
    args.push('--release-as', '0.0.1');
  } else if (releaseType) {
    const normalized = String(releaseType).trim();
    const isValid = VALID_RELEASE_TYPES.has(normalized) || SEMVER_REGEX.test(normalized);
    if (!isValid) {
      const allowed = Array.from(VALID_RELEASE_TYPES).join(', ');
      throw new Error(`Unknown release type "${normalized}". Use one of ${allowed} or a valid semver version.`);
    }
    args.push('--release-as', normalized);
  }

  if (remainingArgs.length > 0) {
    args.push(...remainingArgs.filter((arg) => arg !== '--first-release'));
  }

  return args;
}

function loadPackageJson(cwd = process.cwd()) {
  try {
    const packageJsonPath = path.join(cwd, 'package.json');
    const contents = fs.readFileSync(packageJsonPath, 'utf8');
    return JSON.parse(contents);
  } catch (error) {
    return null;
  }
}

/**
 * Memastikan package.json berisi versi semver yang sah SETELAH rilis berjalan.
 *
 * MENGAPA ADA
 * -----------
 * 30 Oktober 2026 `perform_release` menulis `"version": null` ke package.json
 * dan membuat tag `vnull`, lalu mem-push keduanya. Penyebabnya argumen
 * `--release-as` terkirim dua kali sehingga `semver.inc()` mengembalikan null.
 *
 * `SEMVER_REGEX` sudah ada saat itu, tetapi hanya dipakai memvalidasi tipe
 * rilis MASUKAN. Hasil rilis tidak pernah diperiksa, jadi kerusakan baru
 * terlihat setelah tag keluar dari mesin.
 *
 * Fungsi ini menutup celah itu: standard-version dianggap belum berhasil
 * sebelum package.json terbukti berisi semver yang sah.
 */
function verifyReleaseVersion({ cwd = process.cwd(), readFileSync = fs.readFileSync } = {}) {
  const packageJsonPath = path.join(cwd, 'package.json');

  let contents;
  try {
    contents = readFileSync(packageJsonPath, 'utf8');
  } catch (error) {
    throw new Error(`Tidak bisa membaca ${packageJsonPath}; hasil rilis tidak dapat diverifikasi.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${packageJsonPath} bukan JSON yang sah setelah rilis; hasilnya tidak dapat diverifikasi.`);
  }

  const version = parsed?.version;

  if (typeof version !== 'string' || !SEMVER_REGEX.test(version.trim())) {
    throw new Error(
      `Rilis gagal: package.json berisi version ${JSON.stringify(version)}, bukan semver yang sah. ` +
      'Tag tidak boleh di-push. Periksa argumen --release-as, lalu pulihkan dengan ' +
      `"git tag -d v${String(version)}" dan "git reset --hard HEAD~1" bila perlu.`
    );
  }

  return version.trim();
}

function detectPackageManager({ env = process.env, cwd = process.cwd() } = {}) {
  const userAgent = env.npm_config_user_agent || '';
  if (userAgent.startsWith('pnpm/')) return 'pnpm';
  if (userAgent.startsWith('yarn/')) return 'yarn';
  if (userAgent.startsWith('bun/')) return 'bun';

  for (const { manager, file } of LOCKFILE_PREFERENCES) {
    if (fs.existsSync(path.join(cwd, file))) {
      return manager;
    }
  }

  return 'npm';
}

function buildTestCommand(packageManager) {
  switch (packageManager) {
    case 'pnpm':
      return { command: 'pnpm', args: ['test'] };
    case 'yarn':
      return { command: 'yarn', args: ['test'] };
    case 'bun':
      return { command: 'bun', args: ['test'] };
    default:
      return { command: 'npm', args: ['test'] };
  }
}

function runProjectTests({ spawn = spawnSync, env = process.env, cwd = process.cwd() } = {}) {
  const packageJson = loadPackageJson(cwd);
  const scripts = packageJson && packageJson.scripts ? packageJson.scripts : {};

  if (!scripts.test) {
    safeLog('info', 'ℹ️  Skipping tests: no "test" script detected in package.json');
    return { status: 0 };
  }

  const packageManager = detectPackageManager({ env, cwd });
  const { command, args } = buildTestCommand(packageManager);

  safeLog('info', `🧪 Running tests with ${packageManager} ${args.join(' ')}`.trim());
  // Windows package-manager launchers are .cmd files, not native executables.
  // Only the fixed, allowlisted manager and literal test subcommand enter cmd.
  const executable = process.platform === 'win32' ? (env.ComSpec || 'cmd.exe') : command;
  const testArgs = process.platform === 'win32' ? ['/d', '/s', '/c', `${command} test`] : args;
  return spawn(executable, testArgs, {
    stdio: 'inherit',
    env,
    cwd
  });
}

function runRelease({
  argv = process.argv,
  env = process.env,
  spawn = spawnSync,
  cwd = process.cwd(),
  dependencies = {}
} = {}) {
  const { releaseType: cliReleaseType, extraArgs } = getCliArguments(argv);
  const inferredReleaseType = cliReleaseType || getNpmRunArgument(env);
  const standardVersionArgs = buildStandardVersionArgs({
    releaseType: inferredReleaseType,
    extraArgs
  });

  const checkWorkingTreeClean = dependencies.isWorkingTreeClean || (() => isWorkingTreeClean({ cwd }));
  const workingTreeClean = checkWorkingTreeClean();
  if (!workingTreeClean) {
    throw new Error('Working tree has uncommitted changes. Commit or stash before running release.');
  }

  ensurePrdPresence({ cwd, dependencies });

  const testResult = runProjectTests({ spawn, env, cwd });
  if (!testResult || testResult.error || testResult.status !== 0) {
    return { ...testResult, status: testResult?.status || 1 };
  }

  const standardVersionBin = require.resolve('standard-version/bin/cli.js');
  const childEnv = appendPreloadToNodeOptions(env, FS_FOK_PRELOAD_FLAG);
  const releaseResult = spawn(process.execPath, [standardVersionBin, ...standardVersionArgs], {
    stdio: 'inherit',
    env: childEnv,
    cwd
  });

  if (!releaseResult || releaseResult.error || releaseResult.status !== 0) {
    return { ...releaseResult, status: releaseResult?.status || 1 };
  }

  // Rilis hanya dianggap berhasil setelah package.json terbukti berisi semver
  // yang sah. Tanpa pemeriksaan ini, `version: null` dan tag `vnull` lolos
  // sampai di-push (kejadian 30 Oktober 2026).
  let releasedVersion;
  try {
    releasedVersion = verifyReleaseVersion({ cwd });
  } catch (error) {
    safeLog('error', error.message);
    return { status: 1, error };
  }
  safeLog('info', `✅ Released ${releasedVersion}`);

  const releaseNotesPath = dependencies.releaseNotesPath || path.join('docs', 'release-notes', 'RELEASE_NOTES.md');
  const updateNotes = dependencies.updateReleaseNotes || ((options = {}) => updateReleaseNotes({ rootDir: cwd, ...options }));

  let notesUpdated = false;
  try {
    notesUpdated = updateNotes();
  } catch (error) {
    safeLog('warn', `⚠️  Skipping release notes update: ${error.message}`);
  }

  if (notesUpdated) {
    const gitAddResult = spawnSync('git', ['add', releaseNotesPath], { stdio: 'inherit', cwd });
    if (!gitAddResult || typeof gitAddResult.status !== 'number' || gitAddResult.status !== 0) {
      safeLog('warn', '⚠️  Release notes updated but failed to stage. Please add manually: git add ' + releaseNotesPath);
    }
  }

  return releaseResult;
}
if (require.main === module) {
  (async()=>{
    let exitCode=0;
    try {await ready;const result=runRelease();exitCode=result.status ?? 1;}
    catch(error){safeLog('error',error);exitCode=1;}
    await flushLogs();process.exitCode=exitCode;
  })();
}

module.exports = {
  VALID_RELEASE_TYPES,
  SEMVER_REGEX,
  getCliArguments,
  getNpmRunArgument,
  buildStandardVersionArgs,
  loadPackageJson,
  verifyReleaseVersion,
  detectPackageManager,
  runProjectTests,
  runRelease,
  isWorkingTreeClean,
  ensurePrdPresence
};

function ensurePrdPresence({ cwd = process.cwd(), dependencies = {} } = {}) {
  const {
    fsExistsSync = fs.existsSync,
    logger = console,
    prdRelativePath = DEFAULT_PRD_RELATIVE_PATH,
    prdDisplayPath = DEFAULT_PRD_DISPLAY_PATH
  } = dependencies;

  const resolvedPath = path.isAbsolute(prdRelativePath)
    ? prdRelativePath
    : path.join(cwd, prdRelativePath);

  if (fsExistsSync(resolvedPath)) {
    return true;
  }

  const warn = typeof logger?.warn === 'function' ? logger.warn.bind(logger) : ((message)=>safeLog('warn',message));
  warn(`⚠️  Product Requirements Document missing (${prdDisplayPath}). Add ${DEFAULT_PRD_DISPLAY_PATH} so teams understand release expectations.`);
  return false;
}

function buildPreloadFlag(filePath) {
  const resolved = path.resolve(filePath);
  const escaped = resolved.includes(' ')
    ? `"${resolved.replace(/"/g, '\"')}"`
    : resolved;
  return `--require ${escaped}`;
}

function appendPreloadToNodeOptions(env, preloadFlag) {
  const nextEnv = { ...env };
  const existing = typeof nextEnv.NODE_OPTIONS === 'string' ? nextEnv.NODE_OPTIONS.trim() : '';
  nextEnv.NODE_OPTIONS = existing ? `${existing} ${preloadFlag}` : preloadFlag;
  return nextEnv;
}

function isWorkingTreeClean({ cwd = process.cwd() } = {}) {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8'
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    const message = stderr || 'Failed to determine working tree status.';
    throw new Error(message);
  }

  const output = typeof result.stdout === 'string' ? result.stdout : '';
  return output.trim().length === 0;
}
