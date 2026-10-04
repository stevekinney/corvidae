import { WorkflowCancelledEvent, WorkflowTimedOutEvent } from '../../events.ts';
import { WorkflowTimeoutError } from '../../timeouts.ts';
import type { TerminationReason } from '../../types.ts';

/** The error a terminated workflow's result promise rejects with. */
export function buildTerminalError(
  workflowId: string,
  status: 'cancelled' | 'timed-out',
  elapsed: number,
  reason: TerminationReason | undefined,
): Error {
  return status === 'timed-out'
    ? new WorkflowTimeoutError(workflowId, 'execution', elapsed, reason)
    : new Error('Workflow cancelled');
}

/** The terminal lifecycle event dispatched for a terminated workflow. */
export function buildTerminalEvent(
  workflowId: string,
  status: 'cancelled' | 'timed-out',
  elapsed: number,
  reason: TerminationReason | undefined,
): WorkflowTimedOutEvent | WorkflowCancelledEvent {
  return status === 'timed-out'
    ? new WorkflowTimedOutEvent(workflowId, 'execution', elapsed, reason)
    : new WorkflowCancelledEvent(workflowId);
}
