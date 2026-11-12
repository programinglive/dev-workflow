/**
 * Task Identity & Cross-System Mapping Engine
 * Part of Zettly <-> DevWorkflow Integration Contract v1
 *
 * Establishes immutable, schema-validated mapping between:
 * - DevWorkflow Task ID (canonical execution identity)
 * - Zettly Todo ID (human control plane item)
 * - Zettly Focus ID (active container context)
 * - Zettly Drawing ID (visual Mermaid/TLDraw canvas)
 * - Execution ID / Session ID (active agent worker)
 * - Git Worktree & Branch (isolated workspace)
 */

import { randomUUID, createHash } from 'node:crypto';

/**
 * Validates canonical task identifier.
 * Accepts UUIDs, CUIDs, or legacy workflow-sha prefixes.
 */
export function isValidTaskId(id) {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed);
}

/**
 * Normalizes a positive integer identifier (e.g. Zettly Todo/Focus/Drawing ID).
 */
export function normalizePositiveInt(value) {
  if (value == null) return null;
  const num = Number(value);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

/**
 * Creates an immutable TaskIdentity object with stable cross-system bindings.
 */
export function createTaskIdentity(params = {}) {
  const taskId = isValidTaskId(params.taskId) ? params.taskId.trim() : randomUUID();
  const zettlyTodoId = normalizePositiveInt(params.zettlyTodoId ?? params.todoId ?? params.zettly?.todoId);
  const focusId = normalizePositiveInt(params.focusId ?? params.focus?.id);
  const drawingId = normalizePositiveInt(params.drawingId ?? params.zettly?.externalLinks?.drawing?.id);
  const executionId = typeof params.executionId === 'string' && params.executionId.trim()
    ? params.executionId.trim()
    : randomUUID();
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : null;
  const worktree = typeof params.worktree === 'string' ? params.worktree.trim() : null;
  const gitBranch = typeof params.gitBranch === 'string' ? params.gitBranch.trim() : (typeof params.branch === 'string' ? params.branch.trim() : null);
  const repo = typeof params.repo === 'string' ? params.repo.trim() : (typeof params.projectDir === 'string' ? params.projectDir.trim() : null);

  const identity = {
    taskId,
    zettly: Object.freeze({
      todoId: zettlyTodoId,
      focusId: focusId,
      drawingId: drawingId,
    }),
    execution: Object.freeze({
      executionId,
      sessionId,
      worktree,
    }),
    git: Object.freeze({
      repo,
      branch: gitBranch,
    }),
    createdAt: params.createdAt || new Date().toISOString(),

    /** Generates a SHA-256 digest of this identity mapping for tamper detection */
    digest() {
      const payload = JSON.stringify({
        taskId: this.taskId,
        todoId: this.zettly.todoId,
        focusId: this.zettly.focusId,
        drawingId: this.zettly.drawingId,
        executionId: this.execution.executionId,
      });
      return createHash('sha256').update(payload).digest('hex');
    },

    /** Exports to backward-compatible WorkflowState.state properties */
    toStateDelta() {
      return {
        workflowTaskId: this.taskId,
        zettly: {
          taskId: this.taskId,
          todoId: this.zettly.todoId,
          externalLinks: this.zettly.drawingId ? { drawing: { id: this.zettly.drawingId } } : {},
        },
      };
    },

    /** Metadata payload suitable for embedding into Zettly Draw document.meta */
    toZettlyMeta() {
      return {
        workflowTaskId: this.taskId,
        zettlyTodoId: this.zettly.todoId,
        executionId: this.execution.executionId,
      };
    },
  };

  return Object.freeze(identity);
}

/**
 * Extracts a normalized TaskIdentity from existing WorkflowState state object.
 */
export function extractTaskIdentity(state = {}) {
  const zettly = state.zettly || {};
  const drawingId = zettly.externalLinks?.drawing?.id;
  const focusId = state.focus?.id;

  return createTaskIdentity({
    taskId: state.workflowTaskId,
    zettlyTodoId: zettly.todoId,
    focusId,
    drawingId,
    sessionId: state.sessionId,
    repo: state.projectDir,
    gitBranch: state.lastPushBranch,
  });
}
