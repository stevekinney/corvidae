/** Exact, fence-carrying transforms for a saved file-agent identifier change (COR-2428). */

import type { Hook, HookScope } from './hooks/hook-types';
import type { WorkflowFileDefinition, WorkflowFileStep } from './workflow-file';

export interface AgentRenameScheduleSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly agentName: string;
}

export interface AgentRenameWorkflowSnapshot {
  readonly id: string;
  readonly hash: string;
  readonly definition: WorkflowFileDefinition;
}

export interface AgentRenameHookSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly scope: HookScope;
}

/** Replace only the defined agent reference in an agent activity step. */
function renamedStep(step: WorkflowFileStep, from: string, to: string): WorkflowFileStep {
  if (step['kind'] !== 'activity' || step['handler'] !== 'agent') return step;
  const input = step['input'];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return step;
  if (input['agent'] !== from) return step;
  return { ...step, input: { ...input, agent: to } };
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
export function renameHookScope(scope: HookScope, from: string, to: string): HookScope {
  return scope.kind === 'agent' && scope.id === from ? { kind: 'agent', id: to } : scope;
}

/** Whether the hook still carries exactly the source scope a captured mutation may replace. */
export function hookStillNames(snapshot: AgentRenameHookSnapshot, hook: Hook, from: string): boolean {
  return (
    hook.id === snapshot.id &&
    hook.revision === snapshot.revision &&
    hook.scope.kind === 'agent' &&
    hook.scope.id === from
  );
}
