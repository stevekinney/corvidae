import { type JSONValue, type OnStepHook } from '@lostgradient/operative';
import { TERMINAL_REVIEW_STATUSES } from './review-closing-events';
import type { ApprovalPeerRecovery, PendingReview } from './types';

export function omitKeysWithPrefix(
  record: Record<string, JSONValue>,
  prefix: string,
): Record<string, JSONValue> {
  const remaining: Record<string, JSONValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith(prefix)) remaining[key] = value;
  }
  return remaining;
}

/** Narrows JSON's readonly array union before spreading object metadata. */
export function isJsonObject(value: JSONValue | undefined): value is Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * COR-1828 — the tools a person allowed for the rest of a chat: the `approvalGrants` entry of the
 * session's metadata, a list of tool ids (`namespace:name@version`, COR-1950: a tool whose
 * definition changed is a different id, so its grant no longer applies), or of names for an
 * approval that was not signed. It lives and dies with the session, so deleting the
 * chat ends the grant, and a fork (which copies the owner and its provenance only) starts with none.
 */
export function approvalGrantsOf(metadata: Record<string, JSONValue> | undefined): string[] {
  const held = metadata?.['approvalGrants'];
  return Array.isArray(held)
    ? held.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function omitKey(
  record: Record<string, JSONValue>,
  omittedKey: string,
): Record<string, JSONValue> {
  const { [omittedKey]: _omitted, ...remaining } = record;
  return remaining;
}

/**
 * A set of review ids that tells `onAdd` whenever one is added (COR-1622). The ids of the approvals
 * that left (decided, expired, found invalid) are kept in two such sets, and each addition is a
 * moment the Bureau may hold no tool approval any more, which stops its expiry sweep's own timer.
 */
export class NotifyingReviewIdSet extends Set<string> {
  constructor(private readonly onAdd: () => void) {
    super();
  }

  override add(value: string): this {
    super.add(value);
    this.onAdd();
    return this;
  }
}

export function stringValues(values: readonly JSONValue[]): string[] {
  const strings: string[] = [];
  for (const value of values) {
    if (typeof value === 'string') strings.push(value);
  }
  return strings;
}

/**
 * COR-1717 — one approval whose resolution started (the marker is written before the approved tool
 * runs). `startedAt` is epoch milliseconds; a session written before the marker carried it holds a
 * bare id, which reads as a record with `startedAt` undefined.
 */
interface ApprovalResolutionStartedRecord {
  id: string;
  startedAt: number | undefined;
  peerRecovery?: ApprovalPeerRecovery;
}

/** Reads the started marker in either form, dropping entries that are neither. */
export function readApprovalResolutionStarted(
  value: JSONValue | undefined,
): ApprovalResolutionStartedRecord[] {
  if (!Array.isArray(value)) return [];
  const records: ApprovalResolutionStartedRecord[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      records.push({ id: entry, startedAt: undefined });
    } else if (isJsonObject(entry) && typeof entry['id'] === 'string') {
      const startedAt = entry['startedAt'];
      records.push({
        id: entry['id'],
        startedAt: typeof startedAt === 'number' ? startedAt : undefined,
        ...(isJsonObject(entry['peerRecovery']) &&
        entry['peerRecovery']['version'] === 1 &&
        typeof entry['peerRecovery']['toolDefinitionRevision'] === 'string' &&
        entry['peerRecovery']['toolDefinitionRevision'].length > 0 &&
        typeof entry['peerRecovery']['durableOperationKey'] === 'string' &&
        isJsonObject(entry['peerRecovery']['request']) &&
        typeof entry['peerRecovery']['request']['reviewId'] === 'string' &&
        typeof entry['peerRecovery']['request']['round'] === 'number' &&
        Number.isInteger(entry['peerRecovery']['request']['round']) &&
        entry['peerRecovery']['request']['round'] >= 0 &&
        entry['peerRecovery']['request']['decision'] === 'approve' &&
        typeof entry['peerRecovery']['request']['principal'] === 'string' &&
        typeof entry['peerRecovery']['request']['digest'] === 'string' &&
        isJsonObject(entry['peerRecovery']['arguments']) &&
        typeof entry['peerRecovery']['arguments']['message'] === 'string' &&
        entry['peerRecovery']['arguments']['message'].trim().length > 0
          ? { peerRecovery: entry['peerRecovery'] as unknown as ApprovalPeerRecovery }
          : {}),
      });
    }
  }
  return records;
}

/** Serializes started records; a record without `startedAt` omits the key (JSON has no undefined). */
export function writeApprovalResolutionStarted(
  records: readonly ApprovalResolutionStartedRecord[],
): JSONValue[] {
  return records.map((record) =>
    record.startedAt === undefined
      ? {
          id: record.id,
          ...(record.peerRecovery === undefined
            ? {}
            : { peerRecovery: record.peerRecovery as unknown as JSONValue }),
        }
      : {
          id: record.id,
          startedAt: record.startedAt,
          ...(record.peerRecovery === undefined
            ? {}
            : { peerRecovery: record.peerRecovery as unknown as JSONValue }),
        },
  );
}

export function omitStartedRecord(value: JSONValue | undefined, omittedId: string): JSONValue[] {
  return writeApprovalResolutionStarted(
    readApprovalResolutionStarted(value).filter((record) => record.id !== omittedId),
  );
}

export function omitStartedRecordsWithPrefix(
  value: JSONValue | undefined,
  prefix: string,
): JSONValue[] {
  return writeApprovalResolutionStarted(
    readApprovalResolutionStarted(value).filter((record) => !record.id.startsWith(prefix)),
  );
}

/**
 * `WorkflowStatus` values (Weft `core/types/identity.ts`) a workflow can
 * still be forcibly terminated from. Mirrors Weft's own internal
 * `FORCIBLY_TERMINABLE_STATUSES` (`core/engine/termination/cleanup.ts`),
 * which is not exported on the public `@lostgradient/weft` barrel, and
 * operative's parallel (also module-private) `TERMINAL_WORKFLOW_STATUSES`
 * set in `durable/active-run-adapter.ts`. Kept local rather than exported
 * from either package, since neither exposes the underlying constant for
 * `bureau` to import.
 */
/** How many audit records one page of a review-closing check reads (COR-1613). */
export const AUDIT_PAGE_SIZE = 500;

/**
 * Whether an audit record is a terminal record of a review at a round (COR-1613). A record that
 * names no round is round 0, and a review with no round, a human wait, matches any.
 */
function closesReviewRound(
  record: { readonly type: string; readonly detail: unknown },
  reviewId: string,
  round: number | undefined,
): boolean {
  if (!record.type.startsWith('review.')) return false;
  if (!TERMINAL_REVIEW_STATUSES.has(record.type.split('.').pop() ?? '')) return false;
  const detail = record.detail;
  if (detail === null || typeof detail !== 'object') return false;
  const reviewDetail = (detail as Record<string, unknown>)['review'];
  if (reviewDetail === null || typeof reviewDetail !== 'object') return false;
  const fields = reviewDetail as Record<string, unknown>;
  if (fields['id'] !== reviewId) return false;
  if (round === undefined) return true;
  const recorded = fields['round'];
  return (typeof recorded === 'number' ? recorded : 0) === round;
}

/**
 * The status an audit record closes a review round with (COR-1622), or `undefined` when it is not a
 * terminal record of that round. {@link closesReviewRound}'s rule, with the status it found.
 */
export function closingStatusOfRound(
  record: { readonly type: string; readonly detail: unknown },
  reviewId: string,
  round: number | undefined,
): string | undefined {
  return closesReviewRound(record, reviewId, round) ? record.type.split('.').pop() : undefined;
}

/**
 * What closing a canceled fire's review needs to know to find the closing's records (COR-1622): the
 * review's id and kind, its run, and the round it stood at (`0` for a human wait). Not the review
 * itself, which only a record that is to be written needs in full.
 */
export type CanceledReviewTarget = {
  readonly id: string;
  readonly runId: string;
  readonly kind: 'tool-approval' | 'human-wait';
  readonly round: number;
};

/**
 * The trailing `onStep` hook that records a step's pending tool approvals —
 * registered as `bureau:pending-approval-persist`.
 *
 * A named factory rather than the inline closure it was, because COR-567
 * classifies this registration `effectful` and COR-1267 requires each
 * `effectful` registration to be provable idempotent by a test that invokes it
 * twice. A closure written inline inside `createBureau` is reachable only by
 * dispatching a whole interactive run and then contriving a second execution of
 * the same step; the handler itself is the unit under test, so it has a name.
 *
 * Idempotent by key, not by append: the review id is
 * `approval:${runId}:${callId}`, derived from the step's own tool call, so a
 * crashed step re-running from its boundary produces the SAME id, and both
 * writes it performs — the in-memory override map and the session-metadata
 * persist — are keyed writes.
 */
export function createPendingApprovalPersistHook(
  runId: string,
  sessionId: string,
  overrides: Map<string, Extract<PendingReview, { kind: 'tool-approval' }>['approval']>,
  persist: (
    sessionId: string,
    reviewId: string,
    approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval'],
  ) => Promise<void>,
): OnStepHook {
  return async (stepResult) => {
    for (const stepResultItem of stepResult.results) {
      if (stepResultItem.outcome !== 'action_required' || !stepResultItem.pendingApproval) {
        continue;
      }
      const reviewId = `approval:${runId}:${stepResultItem.pendingApproval.callId}`;
      overrides.set(reviewId, stepResultItem.pendingApproval);
      await persist(sessionId, reviewId, stepResultItem.pendingApproval);
    }
  };
}

/**
 * COR-1596 — the trailing `onStep` hook that hands each tool approval a schedule fire's step left
 * pending to `register`, registered as `bureau:scheduled-fire-approvals`.
 *
 * A named factory for the reason `createPendingApprovalPersistHook` is one: COR-567 classifies the
 * registration `effectful`, so a replayed step runs it again, and it is idempotent because the
 * review id is `approval:${runId}:${callId}`, derived from the step's own tool call.
 */
export function createScheduledFireApprovalHook(
  runId: string,
  register: (
    reviewId: string,
    approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval'],
    stepWasFinal: boolean,
  ) => void | Promise<void>,
): OnStepHook {
  return async (stepResult) => {
    for (const result of stepResult.results) {
      if (result.outcome !== 'action_required' || !result.pendingApproval) continue;
      await register(
        `approval:${runId}:${result.pendingApproval.callId}`,
        result.pendingApproval,
        stepResult.final,
      );
    }
  };
}

/** COR-2009: the audit record of an approved tool call that ran (`tool.settled`, with its review). */
export type ApprovedCallAudit = {
  readonly runId: string;
  readonly type: 'tool.settled';
  readonly detail: Readonly<Record<string, unknown>>;
};
