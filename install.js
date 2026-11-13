#!/usr/bin/env node
import { safeLog } from './security/sanitizer.js';

/**
 * Installation script for dev-workflow MCP server
 * Sets up per-project workflow state file in the target project directory
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { runOnboardingSetup } from './cli/onboarding.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function install() {
  try {
    // npm sets INIT_CWD to the directory where `npm install` was originally invoked.
    // Fallback to process.cwd() if it's not present (e.g., older npm versions).
    const projectRoot = process.env.INIT_CWD || process.cwd();

    // If INIT_CWD points inside node_modules, this script is being executed
    // while installing the package itself. In that case, skip creating a state file.
    if (projectRoot.includes(`node_modules${path.sep}`)) {
      safeLog('info', 'ℹ️ Skipping workflow state creation inside node_modules.');
      return;
    }

    const stateDir = path.join(projectRoot, '.state');
    const stateFile = path.join(stateDir, 'workflow-state.json');

    // Create .state directory if it doesn't exist
    await fs.mkdir(stateDir, { recursive: true });

    // Check if state file already exists
    try {
      await fs.access(stateFile);
      safeLog('info', `✓ Workflow state file already exists at ${stateFile}`);
      return;
    } catch {
      // File doesn't exist, create it
    }

    // Create initial workflow state
    const initialState = {
      currentPhase: 'idle',
      taskDescription: '',
      bugFixed: false,
      testsCreated: false,
      testsPassed: false,
      testsSkipped: false,
      testsSkippedReason: '',
      documentationCreated: false,
      readyToCommit: false,
      readyCheckCompleted: false,
      released: false,
      releaseCommand: '',
      releaseNotes: '',
      commitAndPushCompleted: false,
      lastCommitMessage: '',
      lastPushBranch: '',
      history: [],
    };

    await fs.writeFile(stateFile, JSON.stringify(initialState, null, 2));
    safeLog('info', `✓ Created workflow state file at ${stateFile}`);
    safeLog('info', `✓ Each project now has its own isolated workflow history`);
  } catch (error) {
    safeLog('error', '✗ Installation failed:', error.message);
    process.exit(1);
  }
}

async function ensureOnboardingProfile() {
  try {
    const projectRoot = process.env.INIT_CWD || process.cwd();
    if (projectRoot.includes(`node_modules${path.sep}`)) return;
    const setup = await runOnboardingSetup({
      env: process.env,
      skipZettly: process.env.DEVWF_SKIP_ZETTLY === '1',
    });
    if (setup.action === 'PRESERVED_EXISTING_CONNECTION') {
      safeLog('info', '✓ Preserved existing Zettly connection.');
    } else if (setup.action === 'ZETTLY_SKIPPED') {
      safeLog('info', '✓ Initialized local-first standalone profile (Zettly skipped).');
    } else if (setup.action === 'INITIALIZED_LOCAL_FIRST') {
      safeLog('info', '✓ Initialized local-first standalone profile (Zettly optional).');
    }
  } catch (error) {
    safeLog('warn', `⚠️ Onboarding profile note: ${error.message}`);
  }
}

await install();
await ensureOnboardingProfile();
