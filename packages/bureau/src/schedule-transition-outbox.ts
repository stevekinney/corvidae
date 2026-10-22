/**
 * COR-194 — the pending record a schedule pause, resume, or cancel commits in the same storage
 * write as the schedule's own new state (Weft's `ScheduleTransitionOptions.additionalOperations`).
 * A process that dies between that commit and the durable history and audit records the
 * transition owes leaves the fact behind for the next boot to record, instead of losing it.
 *
 * The key is `bureau-schedule-transition:<scheduleId>:<committedAtMs>:<ordinal>`, with the schedule
 * id percent-encoded so a `:` in it cannot shift the fields. The Bureau mints the ordinal before
 * the call, because Weft computes the schedule's next revision inside the transition, after the
 * operation is built. The zero-padded commit time ahead of it makes a prefix scan return one
 * schedule's pending transitions in the order they committed. The key is also the dedupe key both
 * records are written under, so the live drain, a retry, and the boot pass write each fact once
 * between them.
 */
import { type BatchOperation, decode, encode } from '@lostgradient/weft';

/** The prefix every pending schedule transition is stored under, outside Weft's reserved prefixes. */
export const SCHEDULE_TRANSITION_KEY_PREFIX = 'bureau-schedule-transition:';

/** The durable record kind of each Bureau schedule transition. */
export type ScheduleTransitionKind = 'schedule.paused' | 'schedule.resumed' | 'schedule.cancelled';

/** A schedule transition committed with the schedule's state and not yet recorded. */
export interface PendingScheduleTransition {
  readonly kind: ScheduleTransitionKind;
  readonly scheduleId: string;
  /** When the transition was committed, and the time both of its records carry. */
  readonly committedAtMs: number;
}

const TRANSITION_KINDS: ReadonlySet<string> = new Set<ScheduleTransitionKind>([
  'schedule.paused',
  'schedule.resumed',
  'schedule.cancelled',
]);

/** The storage key of one pending transition, and the dedupe key its records are written under. */
export function scheduleTransitionKey(
  transition: PendingScheduleTransition,
  ordinal: string,
): string {
  const committedAt = String(Math.max(0, Math.trunc(transition.committedAtMs))).padStart(16, '0');
  return `${SCHEDULE_TRANSITION_KEY_PREFIX}${encodeURIComponent(transition.scheduleId)}:${committedAt}:${ordinal}`;
}

/** The operation that writes `transition`'s pending record under `key`. */
export function scheduleTransitionOperation(
  key: string,
  transition: PendingScheduleTransition,
): BatchOperation {
  return {
    type: 'put',
    key,
    value: encode({
      schemaVersion: 1,
      kind: transition.kind,
      scheduleId: transition.scheduleId,
      committedAtMs: transition.committedAtMs,
    }),
  };
}

/** Reads a stored pending transition back, or `undefined` for a value this build did not write. */
export function decodeScheduleTransition(bytes: Uint8Array): PendingScheduleTransition | undefined {
  let value: unknown;
  try {
    value = decode(bytes);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const kind: unknown = Reflect.get(value, 'kind');
  const scheduleId: unknown = Reflect.get(value, 'scheduleId');
  const committedAtMs: unknown = Reflect.get(value, 'committedAtMs');
  if (
    Reflect.get(value, 'schemaVersion') !== 1 ||
    typeof kind !== 'string' ||
    !TRANSITION_KINDS.has(kind) ||
    typeof scheduleId !== 'string' ||
    typeof committedAtMs !== 'number' ||
    !Number.isFinite(committedAtMs)
  ) {
    return undefined;
  }
  return { kind: kind as ScheduleTransitionKind, scheduleId, committedAtMs };
}
