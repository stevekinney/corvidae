/**
 * Render-ready mapping for one remote activity's task ledger record on the run
 * page (COR-274). Everything shown is the ledger's own: `weft.tasks.get`
 * answers for the record a timeline entry names (`taskOperationId`), and this
 * module only labels it. Every state, and every terminal disposition, has its
 * own explicit label, and none reads as the activity having run locally.
 */
import { formatDuration, formatRelativeTime } from '../../../lib/format/index.ts';
import type { TaskLedgerDetail } from '../../workers/worker-catalog-types.ts';

/** The label for each ledger state, each terminal disposition, and a terminal record that reports none. */
export const REMOTE_TASK_STATE_LABELS = {
  queued: 'Queued for a worker',
  leased: 'Running on a worker',
  completing: 'Result reported, being recorded',
  cancelling: 'Cancellation requested',
  deadLettered: 'Dead lettered',
  resolved: 'Resolved',
  cancelled: 'Cancelled',
  retryExhausted: 'Retries exhausted',
  terminalUnknown: 'Finished, disposition not reported',
} as const;

export type RemoteTaskStateVariant = 'danger' | 'success' | 'warning';

export interface RemoteTaskState {
  readonly label: string;
  readonly variant: RemoteTaskStateVariant;
}

/** The explicit state of a ledger record: its own label and a tone that is never the only signal. */
export function remoteTaskState(task: TaskLedgerDetail): RemoteTaskState {
  switch (task.state) {
    case 'deadLettered':
      return { label: REMOTE_TASK_STATE_LABELS.deadLettered, variant: 'danger' };
    case 'terminal':
      switch (task.disposition) {
        case 'resolved':
          return { label: REMOTE_TASK_STATE_LABELS.resolved, variant: 'success' };
        case 'cancelled':
          return { label: REMOTE_TASK_STATE_LABELS.cancelled, variant: 'warning' };
        case 'retryExhausted':
          return { label: REMOTE_TASK_STATE_LABELS.retryExhausted, variant: 'danger' };
        case undefined:
          return { label: REMOTE_TASK_STATE_LABELS.terminalUnknown, variant: 'warning' };
      }
      break;
    case 'queued':
    case 'leased':
    case 'completing':
    case 'cancelling':
      return { label: REMOTE_TASK_STATE_LABELS[task.state], variant: 'warning' };
  }
  return { label: REMOTE_TASK_STATE_LABELS.terminalUnknown, variant: 'warning' };
}

/** One labelled value in the panel's description list. */
export interface RemoteTaskField {
  readonly term: string;
  readonly value: string;
}

function backoff(value: number | string): string {
  return typeof value === 'number' ? formatDuration(value) : value;
}

function retryPolicyText(policy: NonNullable<TaskLedgerDetail['retryPolicy']>): string {
  return `Up to ${policy.maxAttempts} attempts, backoff ${backoff(policy.initialBackoff)} × ${policy.backoffMultiplier}, at most ${backoff(policy.maxBackoff)}`;
}

/** The dispatch facts an operator reads for one remote activity, from the ledger record. */
export function remoteTaskFields(task: TaskLedgerDetail, now: number): readonly RemoteTaskField[] {
  return [
    { term: 'Queue', value: task.queue },
    {
      term: 'Attempt',
      value:
        task.retryPolicy === undefined
          ? String(task.attempt)
          : `${task.attempt} of ${task.retryPolicy.maxAttempts}`,
    },
    {
      term: 'Retry policy',
      value: task.retryPolicy === undefined ? 'No retry policy' : retryPolicyText(task.retryPolicy),
    },
    { term: 'Visibility timeout', value: formatDuration(task.visibilityTimeoutMilliseconds) },
    {
      term: 'Schedule-to-close deadline',
      value:
        task.scheduleToCloseDeadline === undefined
          ? 'None'
          : `${formatRelativeTime(task.scheduleToCloseDeadline, now)} (${new Date(task.scheduleToCloseDeadline).toISOString()})`,
    },
    {
      term: 'Header keys',
      value: task.headerKeys.length > 0 ? task.headerKeys.join(', ') : 'None',
    },
    { term: 'Execution token', value: task.workflowExecutionToken ?? 'Not supplied' },
  ];
}
