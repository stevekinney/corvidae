/**
 * What the AG-UI mount says on the wire besides the events themselves: the
 * closed set of `RUN_ERROR` codes it mints, the metadata key every event carries
 * under, and the one function that stamps an event with it.
 *
 * The key and the code set are one-way doors: a client branches on both, so a
 * code or a field added later is additive and one removed or renamed is not.
 *
 * @module ag-ui-vocabulary
 */

import type { BaseEvent, Event } from '@ag-ui/core';

/**
 * The `RUN_ERROR` codes the mount itself mints. A native run's own error code
 * passes through on a run that failed (so a client that matches `MAXIMUM_STEPS`
 * still does); these are the ones with no native run behind them.
 */
export const AG_UI_ERROR_CODES = [
  'THREAD_NOT_FOUND',
  'THREAD_BUSY',
  'RUN_NOT_FOUND',
  'INTERRUPT_NOT_FOUND',
  'INTERRUPTS_UNADDRESSED',
  'RUN_CONFLICT',
  'RESUME_CONFLICT',
  'INVALID_INPUT',
  'STREAM_DEADLINE',
  'STREAM_OVERFLOW',
  'RUN_FAILED',
  'CONTINUATION_UNAVAILABLE',
] as const;

export type AgUiErrorCode = (typeof AG_UI_ERROR_CODES)[number];

/** The key every event's `metadata` carries Bureau's own fields under, as `@ag-ui/client` namespaces its own. */
export const BUREAU_METADATA_KEY = '@lostgradient/bureau';

/**
 * What Bureau adds to an event.
 *
 * `durable` is defined by provenance, not by AG-UI type: it is `true` exactly
 * when the event is the projection of one record in Bureau's durable event
 * history, and `cursor` is then that record's opaque cursor. A live-only delta
 * is `durable: false` and carries no cursor, so it can never advance a durable
 * replay cursor. A snapshot is `durable: false` and carries the cursor of the
 * last durable record at the moment it was taken, which is where the durable
 * tail resumes.
 */
export type BureauEventMetadata = {
  /** The native `AgentRun.id`. Absent on an event with no native run behind it (a door refusal). */
  readonly runId?: string;
  /** The Bureau session, which is the AG-UI thread. Absent when `runId` is. */
  readonly sessionId?: string;
  readonly durable: boolean;
  readonly cursor?: string | undefined;
  /** Set on a terminal event when the run ended on a guardrail tripwire. */
  readonly tripwire?: true | undefined;
};

/** Which run an event belongs to, and the clock that dates it. */
export type EventStamp = {
  readonly nativeRunId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly now: () => number;
};

/**
 * Dates `event` and attaches Bureau's metadata. The event is built as a member of
 * `@ag-ui/core`'s `Event` union by its caller, which is what keeps the mount from
 * emitting a shape the protocol does not define; the conformance suite parses
 * every event it receives with the package's own schema as well.
 */
export function stamp<TEvent extends Event>(
  event: TEvent,
  context: EventStamp,
  label: Pick<BureauEventMetadata, 'durable' | 'cursor' | 'tripwire'>,
): TEvent {
  const metadata: BureauEventMetadata = {
    ...(context.nativeRunId === undefined ? {} : { runId: context.nativeRunId }),
    ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
    durable: label.durable,
    ...(label.cursor === undefined ? {} : { cursor: label.cursor }),
    ...(label.tripwire === undefined ? {} : { tripwire: label.tripwire }),
  };
  const base: BaseEvent = {
    type: event.type,
    timestamp: context.now(),
    metadata: { ...event.metadata, [BUREAU_METADATA_KEY]: metadata },
  };
  return { ...event, ...base };
}
