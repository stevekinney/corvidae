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

import { type BaseEvent, type Event, EventType } from '@ag-ui/core';

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
  'REVIEW_ROUND_CHANGED',
] as const;

export type AgUiErrorCode = (typeof AG_UI_ERROR_CODES)[number];

/**
 * The `name` of the `CUSTOM` event that announces one managed asset a message carries. Its `value`
 * is an {@link AssetPartAnnouncement}. A client branches on the name, so it is a one-way door.
 */
export const ASSET_PART_EVENT_NAME = 'bureau.asset-part';

/**
 * The `name` of the `CUSTOM` event that announces one memory record a model wrote with its
 * `memory_store` tool. Its `value` is a {@link MemoryWrittenAnnouncement}. A client branches on the
 * name, so it is a one-way door.
 */
export const MEMORY_WRITTEN_EVENT_NAME = 'bureau.memory-written';

/**
 * The `name` of the `CUSTOM` event that announces a run parked itself until a later time with
 * `scheduleWakeup`. Its `value` is a {@link WakeupScheduledAnnouncement}. A client branches on the
 * name, so it is a one-way door.
 */
export const WAKEUP_SCHEDULED_EVENT_NAME = 'bureau.wakeup-scheduled';

/**
 * The `name` of the `CUSTOM` event that announces a child run started for the run being streamed.
 * Its `value` is a {@link ChildRunStartedAnnouncement}. A client branches on the name, so it is a
 * one-way door.
 */
export const CHILD_RUN_STARTED_EVENT_NAME = 'bureau.child-run-started';

/**
 * The `name` of the `CUSTOM` event that announces a child run of the run being streamed reached an
 * end. Its `value` is a {@link ChildRunSettledAnnouncement}. A client branches on the name, so it
 * is a one-way door.
 */
export const CHILD_RUN_SETTLED_EVENT_NAME = 'bureau.child-run-settled';

/**
 * The `value` of a {@link MEMORY_WRITTEN_EVENT_NAME} event, sent once for each `memory_store` call
 * of the run whose result says the record was stored (`stored: true`). It is derived from that
 * call's result, which names the record, the collection it went to, and its memory class.
 * Content is never sent: the Memory page is where a record is read.
 */
export type MemoryWrittenAnnouncement = {
  /**
   * The assistant row the `memory_store` call belongs to (`<runId>:step:<n>`, the `parentMessageId`
   * of its `TOOL_CALL_START`), so a client draws the note under the message that wrote it.
   */
  readonly messageId: string;
  /** The memory record's id: the `id` the call's result returned. */
  readonly recordId: string;
  /** The collection the record was written to. */
  readonly collection: string;
  /** The record's memory class, for example `episodic`. */
  readonly class: string;
  /** The native `AgentRun.id` the write belongs to. */
  readonly runId: string;
  /** The Bureau session, which is the AG-UI thread. */
  readonly sessionId: string;
};

/**
 * The `value` of a {@link WAKEUP_SCHEDULED_EVENT_NAME} event, sent once for each `scheduleWakeup`
 * call the run accepted (a refused call, made after the step already parked, sends none).
 */
export type WakeupScheduledAnnouncement = {
  /** The native `AgentRun.id` that parked. */
  readonly runId: string;
  /** The duration the run asked to sleep, as it asked: milliseconds, or a duration string such as `6h`. */
  readonly duration: number | string;
  /** The note the run left for itself, when it left one. */
  readonly note?: string;
  /** When the run is due to wake, in milliseconds since the Unix epoch, on Bureau's clock. */
  readonly wakeAt: number;
};

/** The `value` of a {@link CHILD_RUN_STARTED_EVENT_NAME} event. */
export type ChildRunStartedAnnouncement = {
  /** The native id of the run being streamed. */
  readonly parentRunId: string;
  /** The child's own native run id, which a client attaches to at `GET <prefix>/runs/<childRunId>`. */
  readonly childRunId: string;
  /** The catalog agent the child runs as. */
  readonly childAgentName: string;
  /** Whether the child is a durable workflow rather than an in-process call. */
  readonly durable: boolean;
};

/** How a child run ended: the terminal statuses a child run records. */
export type ChildRunSettledStatus = 'completed' | 'failed' | 'aborted';

/** The `value` of a {@link CHILD_RUN_SETTLED_EVENT_NAME} event. */
export type ChildRunSettledAnnouncement = {
  readonly childRunId: string;
  readonly status: ChildRunSettledStatus;
};

/**
 * Whether `event` is one of the live-only announcements: a memory record written, a wakeup
 * scheduled, a child run started or settled. A stream announces them when they happen and never
 * reads them back out of a run's recorded history. (`bureau.asset-part` is not one: it names a part
 * of a message a replay shows.)
 */
export function isLiveAnnouncement(event: Event): boolean {
  return (
    event.type === EventType.CUSTOM &&
    (event.name === MEMORY_WRITTEN_EVENT_NAME ||
      event.name === WAKEUP_SCHEDULED_EVENT_NAME ||
      event.name === CHILD_RUN_STARTED_EVENT_NAME ||
      event.name === CHILD_RUN_SETTLED_EVENT_NAME)
  );
}

/**
 * Whether `event` is one of the `REASONING_*` family. Reasoning is the model's chain of thought:
 * it goes to the run's owner, live, and to no one else, and no snapshot or replay holds it.
 */
export function isReasoningEvent(event: Event): boolean {
  return (
    event.type === EventType.REASONING_START ||
    event.type === EventType.REASONING_MESSAGE_START ||
    event.type === EventType.REASONING_MESSAGE_CONTENT ||
    event.type === EventType.REASONING_MESSAGE_END ||
    event.type === EventType.REASONING_MESSAGE_CHUNK ||
    event.type === EventType.REASONING_END ||
    event.type === EventType.REASONING_ENCRYPTED_VALUE
  );
}

/**
 * The `provider` of the `file` part source an AG-UI message names a managed asset with: `value` is
 * the asset's id. A client that sends or reads an attachment branches on it.
 */
export const ASSET_FILE_PROVIDER = 'bureau';

/**
 * Where an assistant row of a `MESSAGES_SNAPSHOT` keeps the managed assets it carries, in its
 * `metadata`, as a list of {@link AssetPartReference}. An AG-UI assistant message holds text only,
 * so the assets ride beside it, the way Conversationalist keeps cited text parts under
 * `conversationalist:textParts`. A client reads it by name, so it is a one-way door.
 */
export const ASSET_PARTS_METADATA_KEY = 'bureau:assetParts';

/** One managed asset an assistant message carries: its position in the message's parts, and what it is. */
export type AssetPartReference = {
  /** The part's position among the message's parts, as the run's `partIndex` counts them. */
  readonly index: number;
  readonly assetId: string;
  /** The asset's media type; `application/octet-stream` when the part declared none. */
  readonly mediaType: string;
};

/** The `value` of a {@link ASSET_PART_EVENT_NAME} event. */
export type AssetPartAnnouncement = AssetPartReference & { readonly messageId: string };

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
