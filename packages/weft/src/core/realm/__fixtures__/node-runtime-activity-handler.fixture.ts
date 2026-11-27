import type { WorkerWorkflowContext } from '../../../workers/workflow-runner.ts';
import type { RevisionRealmWorkflowHandler } from './revision-realm-generator-worker-entry.ts';

export const NODE_RUNTIME_WORKFLOW_NAME = 'node-runtime-activity-workflow';

export const nodeRuntimeActivityHandler: RevisionRealmWorkflowHandler = async function* (
  context: WorkerWorkflowContext,
  input: unknown,
) {
  const fail = input === 'fail';
  const result: unknown = yield {
    id: `node-runtime:${context.workflowId}:activity`,
    workflowId: context.workflowId,
    kind: 'activity',
    queue: 'default',
    activityName: fail ? 'throw' : 'echo',
    input,
    attempt: 1,
    retryPolicy: {
      maxAttempts: 1,
      initialBackoff: 0,
      backoffMultiplier: 1,
      maxBackoff: 0,
    },
    scheduledAt: Date.now(),
  };
  return result;
};
