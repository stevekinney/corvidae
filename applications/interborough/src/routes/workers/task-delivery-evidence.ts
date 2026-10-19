/**
 * Trust-boundary validation and presentation for a task's transport-level
 * result delivery history (`weft.tasks.deliveries`) and a dead-lettered
 * attempt's retained result (`weft.tasks.deadletters.get`) (COR-284).
 *
 * The ledger's attempt `disposition` says what the ledger decided about an
 * attempt; a delivery says what the server answered to one `taskResult`
 * submission on the wire: acknowledged (`applied`, `duplicate`, or
 * `dead-lettered`) or rejected with a code. A rejected submission never
 * reaches the ledger, so these are different evidence and are shown apart.
 *
 * @module
 */
import type { HttpClient } from '@lostgradient/weft';

import type { AttemptBadgeVariant } from './task-attempt-evidence.ts';

type Operations = HttpClient['operations'];

export type TaskDeliveriesOutput = Awaited<ReturnType<Operations['weft.tasks.deliveries']>>;
export type TaskDelivery = TaskDeliveriesOutput['deliveries'][number];
export type DeadLetterOutput = Awaited<ReturnType<Operations['weft.tasks.deadletters.get']>>;
export type DeadLetterPayload = DeadLetterOutput['payload'];

/** A `weft.tasks.deliveries` response the dashboard refuses to render. */
export class MalformedTaskDeliveriesError extends Error {
  constructor() {
    super('Weft returned a malformed task delivery history.');
    this.name = 'MalformedTaskDeliveriesError';
  }
}

/** A `weft.tasks.deadletters.get` response the dashboard refuses to render. */
export class MalformedDeadLetterError extends Error {
  constructor() {
    super('Weft returned a malformed dead-letter record.');
    this.name = 'MalformedDeadLetterError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15;
}

function isOptional(value: unknown, check: (candidate: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

const DISPOSITIONS: ReadonlySet<unknown> = new Set(['applied', 'duplicate', 'dead-lettered']);
const REJECTION_CODES: ReadonlySet<unknown> = new Set([
  'stale-attempt',
  'worker-mismatch',
  'attempt-token-mismatch',
  'queue-mismatch',
  'revision-mismatch',
  'conflicting-content',
  'commit-rejected',
]);
const SUBMITTED_STATUSES: ReadonlySet<unknown> = new Set(['completed', 'failed', 'cancelled']);
const TRANSPORTS: ReadonlySet<unknown> = new Set(['webSocket', 'longPoll']);

function isDelivery(value: unknown): value is TaskDelivery {
  if (!isRecord(value)) return false;
  const common =
    isOptional(value['attempt'], isCount) &&
    isString(value['attemptTokenDigest']) &&
    TRANSPORTS.has(value['transport']) &&
    isOptional(value['workerId'], isString) &&
    SUBMITTED_STATUSES.has(value['submittedStatus']) &&
    isTimestamp(value['receivedAt']);
  if (!common) return false;
  if (value['outcome'] === 'acknowledged') {
    return (
      DISPOSITIONS.has(value['disposition']) &&
      (value['oversizedPayload'] === undefined || value['oversizedPayload'] === true)
    );
  }
  return (
    value['outcome'] === 'rejected' &&
    REJECTION_CODES.has(value['rejectionCode']) &&
    isString(value['reason'])
  );
}

function isTaskDeliveries(value: unknown): value is TaskDeliveriesOutput {
  return (
    isRecord(value) &&
    isString(value['operationId']) &&
    Array.isArray(value['deliveries']) &&
    value['deliveries'].every(isDelivery) &&
    isCount(value['historyLimit']) &&
    isCount(value['droppedCount'])
  );
}

/** Validates a `weft.tasks.deliveries` response at the dashboard's trust boundary. */
export function parseTaskDeliveries(value: unknown): TaskDeliveriesOutput {
  if (!isTaskDeliveries(value)) throw new MalformedTaskDeliveriesError();
  return value;
}

function isPayload(value: unknown): value is DeadLetterPayload {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'value':
      return isCount(value['serializedBytes']);
    case 'absent':
      return true;
    case 'omitted':
      return (
        value['reason'] === 'exceeds-max-bytes' &&
        isCount(value['serializedBytes']) &&
        isCount(value['maxBytes'])
      );
    default:
      return false;
  }
}

function isDeadLetter(value: unknown): value is DeadLetterOutput {
  return (
    isRecord(value) &&
    isString(value['operationId']) &&
    isCount(value['attempt']) &&
    isString(value['attemptTokenDigest']) &&
    (value['pendingStatus'] === 'completed' || value['pendingStatus'] === 'failed') &&
    isString(value['resultDigest']) &&
    isTimestamp(value['deadLetteredAt']) &&
    isString(value['persistenceFailureReason']) &&
    isOptional(value['error'], isString) &&
    isPayload(value['payload'])
  );
}

/** Validates a `weft.tasks.deadletters.get` response at the dashboard's trust boundary. */
export function parseDeadLetter(value: unknown): DeadLetterOutput {
  if (!isDeadLetter(value)) throw new MalformedDeadLetterError();
  return value;
}

export interface DeliveryPresentation {
  readonly label: string;
  readonly variant: AttemptBadgeVariant;
  /** What the server did with the submission, in a sentence. */
  readonly explanation: string;
}

const REJECTION_EXPLANATION: Readonly<Record<string, string>> = {
  'stale-attempt': 'A newer attempt owns the task, so this result was fenced out.',
  'worker-mismatch': 'The submitting worker is not the worker that holds the attempt.',
  'attempt-token-mismatch': 'The attempt token does not match the attempt that was leased.',
  'queue-mismatch': 'The task was submitted from a different queue than it was leased on.',
  'revision-mismatch': 'The result names a workflow revision other than the dispatched one.',
  'conflicting-content':
    'The attempt had already settled with different content; the first result stands.',
  'commit-rejected': 'The ledger refused to commit the result.',
};

/** Spells out one delivery's outcome in text, so no status rests on color alone. */
export function presentDelivery(delivery: TaskDelivery): DeliveryPresentation {
  if (delivery.outcome === 'rejected') {
    return {
      label: `Rejected · ${delivery.rejectionCode}`,
      variant: 'danger',
      explanation:
        REJECTION_EXPLANATION[delivery.rejectionCode] ??
        'The server refused the submission before it reached the ledger.',
    };
  }
  switch (delivery.disposition) {
    case 'applied':
      return {
        label: 'Acknowledged · applied',
        variant: 'success',
        explanation: 'The result was committed to the ledger.',
      };
    case 'duplicate':
      return {
        label: 'Acknowledged · duplicate',
        variant: 'neutral',
        explanation: 'The same result had already been committed; nothing changed.',
      };
    case 'dead-lettered':
      return {
        label: 'Acknowledged · dead-lettered',
        variant: 'danger',
        explanation:
          'The result was received but could not be persisted, so it was retained as a dead letter.',
      };
  }
}
