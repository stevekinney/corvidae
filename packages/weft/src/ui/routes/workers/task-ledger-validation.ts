/**
 * Validates a `weft.tasks.get` response at the dashboard's trust boundary
 * (COR-124). The generated client types the output loosely, but Weft builds
 * it from a discriminated union on `state` (and, for `terminal`, on
 * `disposition`), so this mirrors that union: each state's required fields,
 * their types, and the correlations between them. Every instant must be a
 * timestamp a `Date` can represent, so a drifted payload reaches the
 * malformed-response state instead of throwing while it renders.
 *
 * @module
 */
import { isTaskAttemptList } from './task-attempt-evidence.ts';
import type { TaskLedgerDetail } from './worker-catalog-types.ts';

type Fields = Record<string, unknown>;

/** ECMAScript's representable time range, in milliseconds either side of the epoch. */
const MAX_TIME_VALUE_MS = 8.64e15;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A number a `Date` can represent and format, so `toISOString()` never throws. */
export function isTimestamp(value: unknown): value is number {
  return isFiniteNumber(value) && Math.abs(value) <= MAX_TIME_VALUE_MS;
}

function isCount(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

function optional(value: unknown, check: (candidate: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

function isString(value: unknown): boolean {
  return typeof value === 'string';
}

function isResultStatus(value: unknown): boolean {
  return value === 'completed' || value === 'failed';
}

function every(value: Fields, fields: readonly string[], check: (v: unknown) => boolean) {
  return fields.every((field) => check(value[field]));
}

function isDuration(value: unknown): boolean {
  return isFiniteNumber(value) || typeof value === 'string';
}

function isRetryPolicy(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value['maxAttempts']) &&
    isFiniteNumber(value['backoffMultiplier']) &&
    isDuration(value['initialBackoff']) &&
    isDuration(value['maxBackoff']) &&
    optional(
      value['nonRetryableErrors'],
      (errors) => Array.isArray(errors) && errors.every(isString),
    )
  );
}

function isExecutionRequirement(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((field) => optional(field, isString));
}

/** Fields every state carries (`taskDetailBaseFields`). */
function hasBaseFields(value: Fields): boolean {
  return (
    every(value, ['operationId', 'workflowType', 'activityName', 'queue'], isString) &&
    every(
      value,
      ['workflowId', 'workflowExecutionToken', 'workflowRevision', 'fairShareKey'],
      (field) => optional(field, isString),
    ) &&
    optional(value['stickyWorkflowId'], isString) &&
    Array.isArray(value['headerKeys']) &&
    value['headerKeys'].every(isString) &&
    isFiniteNumber(value['visibilityTimeoutMilliseconds']) &&
    isTimestamp(value['createdAt']) &&
    isCount(value['attempt']) &&
    optional(value['priority'], isFiniteNumber) &&
    optional(value['scheduleToCloseDeadline'], isTimestamp) &&
    optional(value['retryPolicy'], isRetryPolicy) &&
    optional(value['executionRequirement'], isExecutionRequirement) &&
    isTaskAttemptList(value['attempts'])
  );
}

/** Attempt counters every state but `terminal` carries. */
function hasAttemptCounters(value: Fields): boolean {
  return (
    isCount(value['retryCount']) &&
    isCount(value['requeueCount']) &&
    optional(value['lastRequeueReason'], isString)
  );
}

/** The holder fields `leased`, `completing`, and `cancelling` carry. */
function hasLeaseHolderFields(value: Fields): boolean {
  return (
    every(
      value,
      ['leaseDeadline', 'firstQueuedAt', 'lastQueuedAt', 'startedAt', 'lastHeartbeatAt'],
      isTimestamp,
    ) && optional(value['attemptDeadline'], isTimestamp)
  );
}

function hasPendingResult(value: Fields): boolean {
  return isResultStatus(value['pendingStatus']) && isString(value['resultDigest']);
}

function isTerminal(value: Fields): boolean {
  if (
    !isTimestamp(value['terminalAt']) ||
    typeof value['adopted'] !== 'boolean' ||
    !optional(value['adoptedAt'], isTimestamp)
  ) {
    return false;
  }
  switch (value['disposition']) {
    case 'resolved':
      return (
        isString(value['resultDigest']) &&
        isResultStatus(value['resultStatus']) &&
        optional(value['error'], isString)
      );
    case 'cancelled':
      return isString(value['cancellationReason']);
    case 'retryExhausted':
      return isString(value['error']);
    default:
      return false;
  }
}

function hasStateFields(value: Fields): boolean {
  switch (value['state']) {
    case 'queued':
      return (
        hasAttemptCounters(value) &&
        every(value, ['availableAt', 'firstQueuedAt', 'lastQueuedAt'], isTimestamp) &&
        every(value, ['lastDispatchedAt', 'startedAt'], (field) => optional(field, isTimestamp))
      );
    case 'leased':
      return hasAttemptCounters(value) && hasLeaseHolderFields(value);
    case 'completing':
      return hasAttemptCounters(value) && hasLeaseHolderFields(value) && hasPendingResult(value);
    case 'cancelling':
      return (
        hasAttemptCounters(value) &&
        hasLeaseHolderFields(value) &&
        isString(value['cancellationReason']) &&
        isTimestamp(value['cancellationRequestedAt'])
      );
    case 'terminal':
      return isTerminal(value);
    case 'deadLettered':
      return (
        hasAttemptCounters(value) &&
        hasPendingResult(value) &&
        isTimestamp(value['deadLetteredAt']) &&
        isString(value['persistenceFailureReason']) &&
        optional(value['error'], isString)
      );
    default:
      return false;
  }
}

const OPTIONAL_TIMESTAMP_FIELDS = [
  'availableAt',
  'firstQueuedAt',
  'lastQueuedAt',
  'lastDispatchedAt',
  'startedAt',
  'lastHeartbeatAt',
  'leaseDeadline',
  'attemptDeadline',
  'cancellationRequestedAt',
  'terminalAt',
  'adoptedAt',
  'deadLetteredAt',
] as const;

const OPTIONAL_STRING_FIELDS = [
  'lastRequeueReason',
  'resultDigest',
  'cancellationReason',
  'error',
  'persistenceFailureReason',
] as const;

/**
 * The view reads several fields regardless of state (cancellation intent,
 * lease clocks), so any of them that is present must be well typed even on
 * a state that does not require it.
 */
function hasWellTypedOptionalFields(value: Fields): boolean {
  return (
    every(value, OPTIONAL_TIMESTAMP_FIELDS, (field) => optional(field, isTimestamp)) &&
    every(value, OPTIONAL_STRING_FIELDS, (field) => optional(field, isString)) &&
    every(value, ['retryCount', 'requeueCount'], (field) => optional(field, isCount)) &&
    every(value, ['pendingStatus', 'resultStatus'], (field) => optional(field, isResultStatus)) &&
    optional(value['adopted'], (field) => typeof field === 'boolean')
  );
}

/** True only for a response that is one coherent branch of `weft.tasks.get`'s union. */
export function isTaskLedgerDetail(value: unknown): value is TaskLedgerDetail {
  return (
    isRecord(value) &&
    hasBaseFields(value) &&
    hasWellTypedOptionalFields(value) &&
    hasStateFields(value)
  );
}
