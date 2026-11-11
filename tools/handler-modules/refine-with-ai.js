import { textResponse } from './shared.js';
import { validatePlanSteps, normalizePlan, createPlan } from './plan.js';
import { validateItemTexts, nextItemId } from './dod.js';

const MAX_CONTEXT = 8000;

function validatedBugContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = ['symptom', 'observed', 'expected', 'evidence', 'constraints'];
  if (fields.some(key => typeof value[key] !== 'string' || value[key].trim().length < 10 || value[key].length > 1000)) return null;
  if (!Array.isArray(value.reproduction) || value.reproduction.length < 1 || value.reproduction.length > 10 ||
      value.reproduction.some(step => typeof step !== 'string' || step.trim().length < 5 || step.length > 300)) return null;
  return {
    symptom: value.symptom.trim(),
    reproduction: value.reproduction.map(step => step.trim()),
    observed: value.observed.trim(), expected: value.expected.trim(),
    evidence: value.evidence.trim(), constraints: value.constraints.trim(),
  };
}

export async function handleRefineWithAi(args, workflowState) {
  const state = workflowState?.state;
  if (!state || state.currentPhase === 'idle' || !state.workflowTaskId) {
    return { ...textResponse('Start a canonical task before refining it.'), isError: true };
  }
  if (args.taskId !== state.workflowTaskId) {
    return { ...textResponse('Task identity changed. Read the active task and retry with its canonical ID.'), isError: true };
  }
  const description = typeof args.description === 'string' ? args.description.trim() : '';
  const newContext = typeof args.newContext === 'string' ? args.newContext.trim() : '';
  const plan = validatePlanSteps(args.plan);
  const dod = validateItemTexts(args.definitionOfDone);
  if (description.length < 20 || description.length > 2000 || newContext.length < 10 || newContext.length > 4000 || !plan.ok || !dod.ok) {
    return { ...textResponse(`Provide a complete revised description, new context, plan, and definition of done. ${plan.error || dod.error || ''}`), isError: true };
  }
  const bugContext = args.bugContext === undefined ? null : validatedBugContext(args.bugContext);
  if ((state.taskType === 'bugfix' || args.bugContext !== undefined) && !bugContext) {
    return { ...textResponse('Bugfix refinement requires symptom, reproduction steps, observed and expected behavior, evidence, and constraints.'), isError: true };
  }

  const oldPlan = normalizePlan(state.plan);
  const doneSteps = new Map(oldPlan.filter(item => item.status === 'done').map(item => [item.text.toLowerCase(), item]));
  const revisedPlan = createPlan(plan.items).map(item => {
    const previous = doneSteps.get(item.text.toLowerCase());
    return previous ? { ...item, status: 'done', updatedAt: previous.updatedAt } : item;
  });
  const oldDod = Array.isArray(state.definitionOfDone) ? state.definitionOfDone : [];
  const previous = state.refinement || {};
  const sameContext = previous.lastContext === newContext;
  if (sameContext && state.taskDescription === description &&
      oldPlan.map(item => item.text).join('\n') === plan.items.join('\n') &&
      oldDod.map(item => item.text).join('\n') === dod.items.join('\n') &&
      JSON.stringify(previous.bugContext || null) === JSON.stringify(bugContext)) {
    return textResponse(`Refinement revision ${previous.revision} is already saved for canonical task ${state.workflowTaskId}.`);
  }
  const byText = new Map(oldDod.map(item => [item.text.toLowerCase(), item]));
  const proven = oldDod.filter(item => item.status === 'done' || item.status === 'waived');
  if (proven.some(item => !dod.items.some(text => text.toLowerCase() === item.text.toLowerCase()))) {
    return { ...textResponse('The revised definition of done must retain every proven or waived item and its evidence.'), isError: true };
  }
  const revisedDod = [];
  for (const itemText of dod.items) {
    const old = byText.get(itemText.toLowerCase());
    revisedDod.push(old || {
      id: nextItemId([...oldDod, ...revisedDod]), text: itemText, status: 'open', evidence: '',
      waivedReason: '', revision: Number(state.dodRevision) || 0, updatedAt: new Date().toISOString(),
    });
  }
  const context = [previous.context, sameContext ? '' : newContext].filter(Boolean).join('\n');
  if (context.length > MAX_CONTEXT) {
    return { ...textResponse('Combined refinement context exceeds 8,000 characters. Summarize earlier context before retrying.'), isError: true };
  }
  const originalDescription = previous.previousDescription || state.taskDescription;
  const before = {
    taskDescription: state.taskDescription,
    plan: state.plan,
    definitionOfDone: state.definitionOfDone,
    refinement: state.refinement,
    readyCheckCompleted: state.readyCheckCompleted,
    readyToCommit: state.readyToCommit,
  };
  state.taskDescription = description;
  state.plan = revisedPlan;
  state.definitionOfDone = revisedDod;
  state.refinement = {
    previousDescription: originalDescription,
    context,
    lastContext: newContext,
    ...(bugContext ? { bugContext } : {}),
    revision: (Number(previous.revision) || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  state.readyCheckCompleted = false;
  state.readyToCommit = false;
  try {
    const saved = await workflowState.save();
    if (saved?.verified === false) throw new Error('Refined task state was not verified.');
  } catch (error) {
    if (state.workflowTaskId === args.taskId) {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete state[key];
        else state[key] = value;
      }
    }
    throw error;
  }
  const investigation = bugContext ? `\nBug investigation:\nSymptom: ${bugContext.symptom}\nReproduction: ${bugContext.reproduction.join(' -> ')}\nObserved: ${bugContext.observed}\nExpected: ${bugContext.expected}\nEvidence: ${bugContext.evidence}\nConstraints: ${bugContext.constraints}` : '';
  return textResponse(`Refined canonical task ${state.workflowTaskId} (revision ${state.refinement.revision}).\nDescription: ${description}\nPrior description: ${originalDescription}\nContext: ${context}${investigation}\nPlan:\n${revisedPlan.map(item => `- [${item.status === 'done' ? 'x' : ' '}] ${item.text}`).join('\n')}\nDefinition of done:\n${revisedDod.map(item => `- [${item.status === 'done' ? 'x' : ' '}] ${item.text}`).join('\n')}\nNext: follow the revised plan and preserve the linked Todo #${state.zettly?.todoId || 'pending'}.`);
}
