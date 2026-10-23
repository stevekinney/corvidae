import {
  BudgetExceededError,
  ElicitationDeniedError,
  GuardrailTripwireError,
  MaximumStepsExceededError,
} from './errors';
import type { FinishReason } from './types';

/**
 * Whether each finish reason is a failure (COR-1627): the one map every surface reads, so a run
 * that stops for a reason is a failure everywhere or nowhere. A failure fires `run.error` before
 * `run.completed`, turns the run record to `error`, and ends an attached AG-UI stream with
 * `RUN_ERROR`. `stop-condition` is a normal stop and `aborted` has its own `run.aborted` event, so
 * neither is a failure here; a caller that counts an abort as unsuccessful says so beside its
 * call. `satisfies Record<FinishReason, boolean>` makes a finish reason added without being
 * classified here fail the type-check.
 */
export const FAILURE_BY_FINISH_REASON = {
  error: true,
  tripwire: true,
  'maximum-steps': true,
  'elicitation-denied': true,
  'budget-exceeded': true,
  'stop-condition': false,
  aborted: false,
} as const satisfies Record<FinishReason, boolean>;

/**
 * Whether `value` is a finish reason that ends a run as a failure: `error`, `tripwire`,
 * `maximum-steps`, `elicitation-denied`, or `budget-exceeded`. Returns `false` for
 * `stop-condition` and `aborted`, and for anything that is not a known finish reason.
 */
export function isFailureFinishReason(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    Object.hasOwn(FAILURE_BY_FINISH_REASON, value) &&
    FAILURE_BY_FINISH_REASON[value as FinishReason]
  );
}

/**
 * The finish reason a run that ended on `error` finishes with (COR-1627): the one classification
 * `makeErrorResult` (a fresh run), `classifyErrorFinishReason` (a durable run's checkpoint), and
 * Bureau's `run.error` payload all read, so an error is the same finish reason wherever it is
 * reported. An elicitation denial, a spent budget, a tripwire, and a step limit are their own
 * reasons; any other error is `error`.
 */
export function finishReasonOfError(error: unknown): FinishReason {
  if (error instanceof ElicitationDeniedError) return 'elicitation-denied';
  if (error instanceof BudgetExceededError) return 'budget-exceeded';
  if (error instanceof GuardrailTripwireError) return 'tripwire';
  if (error instanceof MaximumStepsExceededError) return 'maximum-steps';
  return 'error';
}
