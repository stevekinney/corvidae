/** Exact, fence-carrying transforms for a saved file-agent identifier change (COR-2428). */

import type { HookScope } from './hooks/hook-types';
import type { WorkflowFileDefinition, WorkflowFileStep } from './workflow-file';

/** Replace only the defined agent reference in an agent activity step. */
function renamedStep(step: WorkflowFileStep, from: string, to: string): WorkflowFileStep {
  if (step['kind'] !== 'activity' || step['handler'] !== 'agent') return step;
  const input = step['input'];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return step;
  const fields = input as Record<string, unknown>;
  if (fields['agent'] !== from) return step;
  return { ...step, input: { ...fields, agent: to } };
}

/** Rewrites only executable agent references, never prose or arbitrary workflow input. */
export function renameWorkflowAgent(
  definition: WorkflowFileDefinition,
  from: string,
  to: string,
): WorkflowFileDefinition {
  return {
    ...definition,
    ...(definition.agent === from ? { agent: to } : {}),
    steps: definition.steps.map((step) => renamedStep(step, from, to)),
  };
}

/** Rewrites only an agent-scoped hook and preserves every other hook field, including its secret. */
export function renameHookScope(
  scope: HookScope | undefined,
  from: string,
  to: string,
): HookScope | undefined {
  return scope?.kind === 'agent' && scope.id === from ? { kind: 'agent', id: to } : scope;
}
