import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pluginPath = path.join(repoRoot, 'managed', 'plugins', 'dev-workflow-guard.ts');

// Node 22.18+ strips TypeScript types natively; older Node 20/22.x runners
// fall back to typescript.transpileModule so CI passes on every Node >= 20.
let pluginModule;
try {
  pluginModule = await import(pathToFileURL(pluginPath).href);
} catch (err) {
  if (err?.code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw err;
  const ts = (await import('typescript')).default;
  const source = fs.readFileSync(pluginPath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const encoded = Buffer.from(transpiled.outputText, 'utf8').toString('base64');
  pluginModule = await import(`data:text/javascript;base64,${encoded}`);
}
const {
  default: DevWorkflowGuardPlugin,
  evaluateToolCall,
  isGatedTool,
  isRegistrationTool,
  _resetGuardState,
} = pluginModule;

test('dev-workflow-guard plugin exports dual OpenCode 1.x and 2.x entrypoints', () => {
  assert.equal(DevWorkflowGuardPlugin.id, 'dev-workflow-guard');
  assert.equal(typeof DevWorkflowGuardPlugin.setup, 'function');
  assert.equal(typeof DevWorkflowGuardPlugin.server, 'function');
});

test('recognizes start_task and resume_session across MCP naming conventions', () => {
  assert.equal(isRegistrationTool('start_task'), true);
  assert.equal(isRegistrationTool('dev-workflow_start_task'), true);
  assert.equal(isRegistrationTool('mcp_dev-workflow_start_task'), true);
  assert.equal(isRegistrationTool('dev-workflow:resume_session'), true);
  assert.equal(isRegistrationTool('bash'), false);
  assert.equal(isRegistrationTool('read'), false);
});

test('blocks bash/shell/edit/write before start_task and unlocks immediately after', async () => {
  _resetGuardState();
  delete process.env.DEVWF_GUARD_DISABLED;

  assert.equal(isGatedTool('bash'), true);
  assert.equal(isGatedTool('edit'), true);
  assert.equal(isGatedTool('write'), true);
  assert.equal(isGatedTool('read'), false);

  // Read-only and MCP discovery tools are allowed before registration.
  assert.doesNotThrow(() => evaluateToolCall('read', 'sess-1'));
  assert.doesNotThrow(() => evaluateToolCall('dev-workflow_get_current_focus', 'sess-1'));
  assert.doesNotThrow(() => evaluateToolCall('zettly_priority_queue', 'sess-1'));

  // Mutating / shell tools are blocked before start_task.
  assert.throws(
    () => evaluateToolCall('bash', 'sess-1'),
    /\[dev-workflow-guard\] BLOCKED.*start_task/i,
  );
  assert.throws(
    () => evaluateToolCall('edit', 'sess-1'),
    /\[dev-workflow-guard\] BLOCKED.*start_task/i,
  );

  // Registering sess-1 unlocks sess-1 only, not sess-2.
  assert.doesNotThrow(() => evaluateToolCall('dev-workflow_start_task', 'sess-1'));
  assert.doesNotThrow(() => evaluateToolCall('bash', 'sess-1'));
  assert.doesNotThrow(() => evaluateToolCall('edit', 'sess-1'));

  assert.throws(
    () => evaluateToolCall('bash', 'sess-2'),
    /\[dev-workflow-guard\] BLOCKED.*start_task/i,
  );

  // OpenCode 1.x server() hook works identically.
  const hooks1x = await DevWorkflowGuardPlugin.server();
  assert.throws(
    () => hooks1x['tool.execute.before']({ tool: 'write', sessionID: 'sess-3' }),
    /\[dev-workflow-guard\] BLOCKED/,
  );
  hooks1x['tool.execute.before']({ tool: 'dev-workflow_resume_session', sessionID: 'sess-3' });
  assert.doesNotThrow(() => hooks1x['tool.execute.before']({ tool: 'write', sessionID: 'sess-3' }));

  // OpenCode 2.x setup() hook works identically.
  let registeredHandler = null;
  await DevWorkflowGuardPlugin.setup({
    tool: {
      hook: async (name, fn) => {
        if (name === 'execute.before') registeredHandler = fn;
      },
    },
  });
  assert.equal(typeof registeredHandler, 'function');
  assert.throws(
    () => registeredHandler({ tool: 'shell', sessionID: 'sess-4' }),
    /\[dev-workflow-guard\] BLOCKED/,
  );
  registeredHandler({ tool: 'start_task', sessionID: 'sess-4' });
  assert.doesNotThrow(() => registeredHandler({ tool: 'shell', sessionID: 'sess-4' }));
});

test('respects DEVWF_GUARD_DISABLED=1 escape hatch', () => {
  _resetGuardState();
  process.env.DEVWF_GUARD_DISABLED = '1';
  try {
    assert.doesNotThrow(() => evaluateToolCall('bash', 'sess-bypass'));
  } finally {
    delete process.env.DEVWF_GUARD_DISABLED;
  }
});

test('rollout.cjs syncs dev-workflow-guard.ts plugin to OpenCode plugins directory', () => {
  const rolloutSrc = fs.readFileSync(path.join(repoRoot, 'managed', 'rollout.cjs'), 'utf8');
  assert.match(rolloutSrc, /dev-workflow-guard\.ts/);
  assert.match(rolloutSrc, /syncOpenCodePlugins/);
});
