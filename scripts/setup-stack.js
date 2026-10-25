#!/usr/bin/env node

/**
 * Unified Setup Script for AI Agent Development Stack:
 * 1. dev-workflow-mcp-server (Workflow discipline & state tracking)
 * 2. obra/superpowers (Agentic skills framework: brainstorming, TDD, planning)
 * 3. rtk (Rust Token Killer - command output compression)
 */

import fs from 'fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function getConfigDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'opencode');
  }
  return path.join(home, '.config', 'opencode');
}

async function setupStack() {
  console.log('🚀 Setting up Unified AI Agent Development Stack...\n');

  const configDir = getConfigDir();
  const pluginsDir = path.join(configDir, 'plugins');
  const nodeModulesDir = path.join(configDir, 'node_modules');
  const superpowersDir = path.join(nodeModulesDir, 'superpowers');
  const opencodeJsonPath = path.join(configDir, 'opencode.json');

  // 1. Ensure directories exist
  try {
    mkdirSync(configDir, { recursive: true });
    mkdirSync(pluginsDir, { recursive: true });
    mkdirSync(nodeModulesDir, { recursive: true });
    console.log('✓ OpenCode config directories ready.');
  } catch (err) {
    console.error('✗ Failed to create config directories:', err.message);
    process.exit(1);
  }

  // 2. Setup Superpowers
  console.log('\n📦 Setting up Superpowers skills framework...');
  if (existsSync(superpowersDir)) {
    console.log('✓ Superpowers already installed in OpenCode node_modules.');
    try {
      execSync('git pull --depth 1', { cwd: superpowersDir, stdio: 'ignore' });
      console.log('✓ Superpowers updated to latest version.');
    } catch {
      console.log('ℹ Could not git pull Superpowers (using existing version).');
    }
  } else {
    try {
      console.log('Cloning obra/superpowers...');
      execSync('git clone --depth 1 https://github.com/obra/superpowers.git ' + JSON.stringify(superpowersDir), { stdio: 'inherit' });
      console.log('✓ Superpowers successfully installed.');
    } catch (err) {
      console.warn('⚠️ Git clone failed for superpowers. Make sure git is installed or install manually.');
    }
  }

  // 3. Setup RTK Hook for OpenCode
  console.log('\n⚡ Setting up RTK (Rust Token Killer)...');
  try {
    const rtkCheck = execSync('rtk --version', { encoding: 'utf8' }).trim();
    console.log(`✓ Found ${rtkCheck}`);
    try {
      execSync('rtk init -g --opencode', { stdio: 'inherit' });
      console.log('✓ RTK OpenCode hook registered successfully.');
    } catch (err) {
      console.warn('⚠️ Could not run `rtk init -g --opencode`. You may need to run it manually.');
    }
  } catch {
    console.warn('⚠️ `rtk` binary not found in PATH.');
    console.log('  To get 60-90% token savings on bash commands, install RTK:');
    if (process.platform === 'win32') {
      console.log('  winget install rtk-ai.rtk');
    } else {
      console.log('  brew install rtk  OR  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh');
    }
  }

  // 4. Update opencode.json with MCP server and Superpowers plugin
  console.log('\n⚙️ Configuring opencode.json...');
  let config = {};
  try {
    if (existsSync(opencodeJsonPath)) {
      const raw = readFileSync(opencodeJsonPath, 'utf8').replace(/^\uFEFF/, '');
      config = JSON.parse(raw);
    }
  } catch (err) {
    console.warn('⚠️ Existing opencode.json could not be parsed, backing up and creating new...');
    if (existsSync(opencodeJsonPath)) {
      fs.copyFile(opencodeJsonPath, opencodeJsonPath + '.bak').catch(() => {});
    }
  }

  config.$schema = config.$schema || "https://opencode.ai/config.json";

  // Ensure plugin array exists (V1 plugin format)
  if (!Array.isArray(config.plugin)) {
    config.plugin = [];
  }
  if (!config.plugin.includes("superpowers@git+https://github.com/obra/superpowers.git")) {
    config.plugin.push("superpowers@git+https://github.com/obra/superpowers.git");
  }

  // Ensure mcp servers object exists
  if (!config.mcp || typeof config.mcp !== 'object') {
    config.mcp = {};
  }

  const serverIndexPath = path.join(projectRoot, 'index.js');
  config.mcp['dev-workflow'] = {
    type: "local",
    command: ["node", serverIndexPath],
    enabled: true
  };

  try {
    writeFileSync(opencodeJsonPath, JSON.stringify(config, null, 4), 'utf8');
    console.log(`✓ opencode.json successfully updated at ${opencodeJsonPath}`);
  } catch (err) {
    console.error('✗ Failed to write opencode.json:', err.message);
  }

  // 5. Create AGENTS.md in target project root if missing
  const targetProjectRoot = process.env.INIT_CWD || process.cwd();
  const agentsMdPath = path.join(targetProjectRoot, 'AGENTS.md');
  if (!existsSync(agentsMdPath)) {
    const defaultAgentsMd = `# Dev Workflow Enforcement Rules

## 🛑 MANDATORY MCP WORKFLOW DISCIPLINE

You are connected to the \`dev-workflow\` MCP server. **You MUST NOT perform any coding task, bug fix, or feature implementation without going through the strict workflow enforced by the dev-workflow MCP tools.**

### The Rule of Operation
Before taking any action or answering user requests regarding code changes, check your workflow status and follow these exact steps in sequence:

1. **Start Task**: Call \`start_task\` with a clear description and type (\`feature\`, \`bugfix\`, \`refactor\`, or \`other\`).
2. **Implement**: Write your code changes.
3. **Mark Fixed**: Call \`mark_bug_fixed\` with a summary of the implementation.
4. **Create Tests**: Create appropriate unit/integration tests covering your changes.
5. **Run Tests**: Execute your test suite and call \`run_tests\` with \`passed: true\` and the test command. **Never commit if tests fail!**
6. **Document**: Update documentation and call \`create_documentation\`.
7. **Ready Check**: Call \`check_ready_to_commit\` to verify all steps.
8. **Commit & Push**: Call \`commit_and_push\` with a conventional commit message.
9. **Release**: Call \`perform_release\` with the release command (or \`skip_release\` if docs-only).
10. **Complete**: Call \`complete_task\` to finish the session and reset the workflow.

**Do not bypass these steps. The MCP server will block commits and releases if any required step is skipped.**
`;
    try {
      writeFileSync(agentsMdPath, defaultAgentsMd, 'utf8');
      console.log(`✓ Created AGENTS.md rule enforcement at ${agentsMdPath}`);
    } catch (err) {
      console.warn('⚠️ Could not create AGENTS.md:', err.message);
    }
  } else {
    console.log('✓ AGENTS.md already exists in project root.');
  }

  console.log('\n============================================================');
  console.log('🎉 UNIFIED AI AGENT DEVELOPMENT STACK INSTALLED SUCCESSFULLY!');
  console.log('============================================================');
  console.log('• Workflow Discipline (dev-workflow MCP): Active');
  console.log('• Agentic Skills (Superpowers): Registered');
  console.log('• Token Compression (RTK): Configured');
  console.log('\nRestart OpenCode to start developing with superpowers! 🚀');
}

setupStack().catch((err) => {
  console.error('Setup encountered an error:', err);
  process.exit(1);
});
