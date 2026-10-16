/**
 * Pure presentation logic for a task's lease clocks, fenced attempt history,
 * and cancellation evidence, all read from one `weft.tasks.get` response.
 *
 * Three rules keep this honest about what the ledger actually says:
 *
 * - **Attempts are fenced.** The history is ordered by `attempt`, then
 *   `claimedAt`. An attempt's displayed lease window ends at the earlier of
 *   its own `dispositionAt` and the next attempt's `claimedAt`, so an older
 *   attempt's late disposition can never draw over a newer attempt's window.
 *   A disposition recorded after a newer claim is shown as fenced evidence,
 *   not as a longer window. A window never ends before it starts: when a
 *   lower attempt's claim is later than the next attempt's (or than its own
 *   disposition), its window is clamped to zero length at its own claim.
 * - **Acknowledgement belongs to the owning attempt.** Worker acknowledgement
 *   of a cancellation is reported only when the attempt record whose
 *   `attempt` matches the task's current `attempt` carries
 *   `disposition: 'cancelled'`. A cancellation request on the task, or a
 *   cancelled disposition on an older attempt, never reads as acknowledged.
 * - **Expiry is not cancellation.** A lease that ran out is reported as an
 *   expired clock; it says nothing about cancellation, and cancellation
 *   wording never appears on a clock.
 *
 * @module
 */
import type {
  TaskAttemptDisposition,
  TaskAttemptRecord,
  TaskLedgerDetail,
} from './worker-catalog-types.ts';

const ATTEMPT_DISPOSITIONS: ReadonlySet<string> = new Set<TaskAttemptDisposition>([
  'leased',
  'requeued',
  'retryExhausted',
  'resolved',
  'cancelled',
  'deadLettered',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/** Every string field of Weft's published `WorkerExecutionIdentity` (`executionIdentitySchema`). */
const EXECUTION_IDENTITY_STRING_FIELDS = [
  'workerId',
  'manifestDigest',
  'sdkVersion',
  'runtimeName',
  'runtimeVersion',
  'deploymentName',
  'buildId',
  'artifactDigest',
  'workflowType',
  'workflowRevision',
  'activityName',
  'activityContractHash',
] as const;

/** An attempt's observed identity is always complete, so a partial one is drift. */
function isExecutionIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    EXECUTION_IDENTITY_STRING_FIELDS.every((field) => typeof value[field] === 'string') &&
    isFiniteNumber(value['protocolVersion'])
  );
}

/** Validates one attempt record at the dashboard's trust boundary. */
export function isTaskAttemptRecord(value: unknown): value is TaskAttemptRecord {
  return (
    isRecord(value) &&
    isFiniteNumber(value['attempt']) &&
    typeof value['attemptTokenDigest'] === 'string' &&
    isFiniteNumber(value['claimedAt']) &&
    typeof value['disposition'] === 'string' &&
    ATTEMPT_DISPOSITIONS.has(value['disposition']) &&
    isFiniteNumber(value['dispositionAt']) &&
    isOptionalString(value['dispositionReason']) &&
    isOptionalNumber(value['lastHeartbeatAt']) &&
    isOptionalNumber(value['sessionGeneration']) &&
    (value['executionIdentity'] === undefined || isExecutionIdentity(value['executionIdentity']))
  );
}

/** Validates the whole `attempts` array; every entry must be a well-formed record. */
export function isTaskAttemptList(value: unknown): value is readonly TaskAttemptRecord[] {
  return Array.isArray(value) && value.every(isTaskAttemptRecord);
}

/** Exact, timezone-independent rendering of a ledger instant. */
export function exactTimestamp(timestampMs: number): string {
  // Validation rejects unrepresentable instants first; this guard keeps a
  // stray one from throwing a RangeError mid-render.
  const date = new Date(timestampMs);
  return typeof timestampMs === 'number' && Number.isFinite(date.getTime())
    ? date.toISOString()
    : 'Invalid timestamp';
}

/** Attempts ordered by attempt number, then by claim time. Never mutates its input. */
export function orderAttempts(attempts: readonly TaskAttemptRecord[]): TaskAttemptRecord[] {
  return attempts.toSorted(
    (left, right) => left.attempt - right.attempt || left.claimedAt - right.claimedAt,
  );
}

const DISPOSITION_LABEL: Readonly<Record<TaskAttemptDisposition, string>> = {
  leased: 'Leased',
  requeued: 'Requeued',
  retryExhausted: 'Retry exhausted',
  resolved: 'Resolved',
  cancelled: 'Cancelled',
  deadLettered: 'Dead lettered',
};

export type AttemptBadgeVariant = 'success' | 'warning' | 'danger' | 'neutral';

const DISPOSITION_VARIANT: Readonly<Record<TaskAttemptDisposition, AttemptBadgeVariant>> = {
  leased: 'neutral',
  requeued: 'warning',
  retryExhausted: 'danger',
  resolved: 'success',
  cancelled: 'warning',
  deadLettered: 'danger',
};

export interface AttemptHistoryEntry {
  readonly key: string;
  readonly record: TaskAttemptRecord;
  /** `true` for the attempt whose number matches the task's current attempt. */
  readonly owning: boolean;
  readonly dispositionLabel: string;
  readonly dispositionVariant: AttemptBadgeVariant;
  readonly windowStart: number;
  /** End of the displayed lease window, or `undefined` while this attempt still holds it. */
  readonly windowEnd: number | undefined;
  /** The attempt that claimed the task after this one, when one exists. */
  readonly supersededBy: TaskAttemptRecord | undefined;
  /** `true` when this attempt's disposition was recorded after a newer attempt claimed the task. */
  readonly dispositionFenced: boolean;
}

function attemptWindowEnd(
  record: TaskAttemptRecord,
  next: TaskAttemptRecord | undefined,
): number | undefined {
  const ownEnd = record.disposition === 'leased' ? undefined : record.dispositionAt;
  const end =
    next === undefined
      ? ownEnd
      : ownEnd === undefined
        ? next.claimedAt
        : Math.min(ownEnd, next.claimedAt);
  // A window never ends before it starts: when the next attempt's claim (or
  // this attempt's own disposition) predates this claim, the window is empty.
  return end === undefined ? undefined : Math.max(end, record.claimedAt);
}

/** Builds the fenced, chronological attempt history for a task. */
export function buildAttemptHistory(
  attempts: readonly TaskAttemptRecord[],
  currentAttempt: number,
): AttemptHistoryEntry[] {
  const ordered = orderAttempts(attempts);
  return ordered.map((record, index) => {
    const next = ordered[index + 1];
    return {
      key: `${record.attempt}:${record.claimedAt}:${record.attemptTokenDigest}`,
      record,
      owning: record.attempt === currentAttempt && next === undefined,
      dispositionLabel: DISPOSITION_LABEL[record.disposition],
      dispositionVariant: DISPOSITION_VARIANT[record.disposition],
      windowStart: record.claimedAt,
      windowEnd: attemptWindowEnd(record, next),
      supersededBy: next,
      dispositionFenced:
        next !== undefined &&
        record.disposition !== 'leased' &&
        record.dispositionAt > next.claimedAt,
    };
  });
}

/**
 * Attempts mounted per page of history. A task with no retry policy is
 * requeued without limit, so its history can grow unbounded; the view shows
 * the newest page and loads older ones on request.
 */
export const ATTEMPT_HISTORY_PAGE_SIZE = 25;

/** The attempt record that owns the task's current attempt, if the ledger has recorded one. */
export function owningAttempt(task: TaskLedgerDetail): TaskAttemptRecord | undefined {
  return buildAttemptHistory(task.attempts, task.attempt).find((entry) => entry.owning)?.record;
}

/**
 * The `dispositionReason` Weft's task reconciliation writes on the owning
 * attempt when a `cancelling` record's grace period elapses with no
 * cooperative `taskResult(status: 'cancelled')`. That force settlement also
 * records the attempt as `cancelled`, but the server does not know whether
 * the activity stopped, and `weft.tasks.get` does not project the ledger's
 * `uncertain` flag. A worker's own cooperative acknowledgement records no
 * reason, so this exact string is the only evidence that tells the two apart.
 * A test reads `server/runtime/task-reconciliation.ts` to keep it in step.
 */
export const GRACE_PERIOD_SETTLEMENT_REASON =
  'cancellation deadline elapsed with no cooperative result';

export type CancellationStatus =
  | 'not-requested'
  | 'requested'
  | 'acknowledged'
  | 'settled-after-grace-period'
  | 'cancelled-unacknowledged';

export interface CancellationEvidence {
  readonly status: CancellationStatus;
  readonly statusLabel: string;
  readonly variant: AttemptBadgeVariant;
  readonly reason: string | undefined;
  readonly requestedAt: number | undefined;
  /** Text describing worker acknowledgement, grounded in the owning attempt only. */
  readonly acknowledgement: string;
  /** Older attempts that recorded a cancelled disposition; never treated as acknowledgement. */
  readonly earlierCancelledAttempts: readonly number[];
}

function isGracePeriodSettlement(owner: TaskAttemptRecord | undefined): boolean {
  return (
    owner?.disposition === 'cancelled' && owner.dispositionReason === GRACE_PERIOD_SETTLEMENT_REASON
  );
}

function acknowledgementText(task: TaskLedgerDetail, owner: TaskAttemptRecord | undefined): string {
  if (owner === undefined) return `No record for attempt ${task.attempt} yet`;
  if (owner.disposition !== 'cancelled') {
    return `Not acknowledged · attempt ${owner.attempt} is ${DISPOSITION_LABEL[owner.disposition].toLowerCase()}`;
  }
  if (isGracePeriodSettlement(owner)) {
    return `Not acknowledged · Weft settled attempt ${owner.attempt} at ${exactTimestamp(owner.dispositionAt)} after the cancellation grace period elapsed`;
  }
  const reason = owner.dispositionReason ? ` · ${owner.dispositionReason}` : '';
  return `Acknowledged by attempt ${owner.attempt} at ${exactTimestamp(owner.dispositionAt)}${reason}`;
}

/** Derives cancellation intent and acknowledgement from the ledger, never from lease timing. */
export function describeCancellation(task: TaskLedgerDetail): CancellationEvidence {
  const owner = owningAttempt(task);
  const settledAfterGracePeriod = isGracePeriodSettlement(owner);
  const acknowledged = owner?.disposition === 'cancelled' && !settledAfterGracePeriod;
  const requested =
    task.state === 'cancelling' ||
    task.cancellationRequestedAt !== undefined ||
    task.cancellationReason !== undefined ||
    task.disposition === 'cancelled';
  const earlierCancelledAttempts = orderAttempts(task.attempts)
    .filter((record) => record.disposition === 'cancelled' && record !== owner)
    .map((record) => record.attempt);

  let status: CancellationStatus = 'not-requested';
  if (acknowledged) status = 'acknowledged';
  else if (settledAfterGracePeriod) status = 'settled-after-grace-period';
  else if (task.state === 'terminal' && task.disposition === 'cancelled') {
    status = 'cancelled-unacknowledged';
  } else if (requested) status = 'requested';

  const presentation: Readonly<
    Record<CancellationStatus, { label: string; variant: AttemptBadgeVariant }>
  > = {
    'not-requested': { label: 'Not requested', variant: 'neutral' },
    requested: { label: 'Requested · awaiting worker acknowledgement', variant: 'warning' },
    acknowledged: { label: 'Acknowledged by owning attempt', variant: 'success' },
    'settled-after-grace-period': {
      label: 'Settled after grace period · no worker acknowledgement',
      variant: 'warning',
    },
    'cancelled-unacknowledged': {
      label: 'Cancelled · no worker acknowledgement recorded',
      variant: 'warning',
    },
  };

  return {
    status,
    statusLabel: presentation[status].label,
    variant: presentation[status].variant,
    reason: task.cancellationReason,
    requestedAt: task.cancellationRequestedAt,
    acknowledgement:
      status === 'not-requested' && !acknowledged
        ? 'No cancellation to acknowledge'
        : acknowledgementText(task, owner),
    earlierCancelledAttempts,
  };
}

export type LeaseClockState = 'active' | 'expired' | 'not-set' | 'settled';

export interface LeaseClock {
  readonly id: 'session-lease' | 'attempt-lease' | 'execution-deadline';
  readonly label: string;
  readonly description: string;
  readonly deadline: number | undefined;
  readonly state: LeaseClockState;
  readonly stateLabel: string;
  readonly variant: AttemptBadgeVariant;
}

const SETTLED_STATES: ReadonlySet<TaskLedgerDetail['state']> = new Set([
  'terminal',
  'deadLettered',
]);

function clockState(
  task: TaskLedgerDetail,
  deadline: number | undefined,
  now: number,
): LeaseClockState {
  if (SETTLED_STATES.has(task.state)) return 'settled';
  if (deadline === undefined) return 'not-set';
  return deadline > now ? 'active' : 'expired';
}

function clock(
  id: LeaseClock['id'],
  label: string,
  description: string,
  deadline: number | undefined,
  task: TaskLedgerDetail,
  now: number,
  notSetLabel: string,
): LeaseClock {
  const state = clockState(task, deadline, now);
  const stateLabel = {
    active: 'Active',
    expired: 'Expired',
    'not-set': notSetLabel,
    settled: 'Settled · no longer running',
  }[state];
  const variant: AttemptBadgeVariant =
    state === 'active' ? 'success' : state === 'expired' ? 'danger' : 'neutral';
  return { id, label, description, deadline, state, stateLabel, variant };
}

/** The three independent deadlines a running task is held to, each with its own state. */
export function buildLeaseClocks(task: TaskLedgerDetail, now: number): readonly LeaseClock[] {
  return [
    clock(
      'session-lease',
      'Session lease',
      'Visibility lease the owning worker session renews with each heartbeat.',
      task.leaseDeadline,
      task,
      now,
      'Not leased',
    ),
    clock(
      'attempt-lease',
      'Attempt lease',
      'Hard limit on this attempt; heartbeats never extend it.',
      task.attemptDeadline,
      task,
      now,
      'No attempt limit',
    ),
    clock(
      'execution-deadline',
      'Absolute execution deadline',
      'Schedule-to-close limit across every attempt and retry.',
      task.scheduleToCloseDeadline,
      task,
      now,
      'No deadline',
    ),
  ];
}
