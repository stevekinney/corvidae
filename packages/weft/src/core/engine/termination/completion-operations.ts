/** Builders for the single batch `completeWorkflow` commits. */
import type { BatchOperation } from '../../../storage/interface.ts';
import { KEYS } from '../../../storage/interface.ts';
import { encode } from '../../codec.ts';
import { buildIndexOperations } from '../../search-attributes.ts';
import type { SearchAttributeValue, WorkflowState } from '../../types.ts';
import { buildRetainedTerminalSearchAttributes } from '../attributes-tags.ts';

export function buildCompletedWorkflowState(
  state: WorkflowState,
  result: unknown,
  now: number,
  terminalCleanupToken: string | undefined,
): WorkflowState {
  return {
    ...state,
    status: 'completed' as const,
    result,
    updatedAt: now,
    ...(terminalCleanupToken !== undefined ? { terminalCleanupToken } : {}),
  };
}

export function appendSearchAttributeOperations(
  operations: BatchOperation[],
  workflowId: string,
  currentAttributes: Record<string, SearchAttributeValue> | undefined,
): void {
  if (currentAttributes === undefined || Object.keys(currentAttributes).length === 0) return;
  const retainedAttributes = buildRetainedTerminalSearchAttributes(currentAttributes);
  operations.push(...buildIndexOperations(workflowId, currentAttributes, retainedAttributes));
  if (Object.keys(retainedAttributes).length > 0) {
    operations.push({
      type: 'put',
      key: KEYS.attribute(workflowId),
      value: encode(retainedAttributes),
    });
  } else {
    operations.push({ type: 'delete', key: KEYS.attribute(workflowId) });
  }
}
