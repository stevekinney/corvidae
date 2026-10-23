/**
 * One AG-UI stream over one native run.
 *
 * A stream is a subscriber, never a consumer: it listens to Bureau's live frames
 * with a listener of its own, reads the run's recorded history without
 * advancing anything, and when the client goes away, or the stream reaches its
 * maximum duration, or it falls too far behind, the stream ends and the native
 * run does not notice. Several streams, native observers, and telemetry can
 * watch one run at once.
 *
 * What a stream opens with depends on how it was reached. A stream that starts or
 * continues a run replays the run's events from the beginning, because its
 * client holds none of them; one that attaches opens with the conversation as a
 * `MESSAGES_SNAPSHOT` and replays only the step still in flight, because
 * everything earlier is in the snapshot. Either way the snapshot and the live
 * tail meet without a gap: the stream subscribes first, buffers what arrives,
 * reads the recorded history, and drops the buffered events the history already
 * held, by the store's own sequence number.
 *
 * @module ag-ui-stream
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import { type Event, EventType, type Interrupt, type RunFinishedOutcome } from '@ag-ui/core';
import { type ConversationHistory, type Message, toAGUIToolMessage } from 'conversationalist';

import type { BureauChildRecord } from '../child-topology-store.ts';
import type { Bureau, PendingReview, RunDetail, ServerFrame } from '../types.ts';
import { toInterrupt } from './ag-ui-interrupts.ts';
import { type AnswerRow, snapshotMessages, snapshotMessagesWithAnswers } from './ag-ui-messages.ts';
import { openPeerStream } from './ag-ui-peer-stream.ts';
import {
  errorOf,
  type NativeTerminal,
  RECORDED,
  RunProjector,
  stepName,
  usageOf,
} from './ag-ui-projection.ts';
import { readSessionOwnedBy, runIsOwnedBy } from './ag-ui-session-owner.ts';
import { type AgUiSink, createAgUiSink } from './ag-ui-sink.ts';
import { type AgUiErrorCode, type EventStamp, stamp } from './ag-ui-vocabulary.ts';

/** What a stream reads from the Bureau. */
export type AgUiStreamBureau = Pick<
  Bureau,
  | 'getRun'
  | 'getSession'
  | 'subscribeLiveFrames'
  | 'subscribeRunSnapshot'
  | 'listPendingReviews'
  | 'pendingHumanWaitsOfRun'
  | 'eventHistory'
  | 'subscribeEventHistory'
  | 'waitForDurableRun'
  | 'children'
  | 'getDurableRun'
  | 'whenRunRecorded'
  | 'sessionInputsDeliveredBy'
>;

export type AgUiStreamEnvironment = {
  readonly bureau: AgUiStreamBureau;
  readonly runtime: Pick<RuntimeServices, 'clock' | 'timers'>;
  readonly maxStreamDurationMs: number;
  readonly liveBufferSize: number;
  readonly keepAliveMs: number;
};

export type OpenRunStream = {
  readonly threadId: string;
  /** The `runId` the AG-UI run carries: the client's on start and resume, the native one on attach. */
  readonly runId: string;
  readonly nativeRunId: string;
  /**
   * The owner the route authorized: the owner of the record it decided on. The stream reads the
   * thread's session and the run again, and treats a record whose own owner is another's as
   * missing, because a thread or run deleted and created again by another owner since the route
   * decided must not hand its data to the caller.
   */
  readonly owner: string;
  /** The parent's native id, on the stream of a child run. */
  readonly parentRunId?: string | undefined;
  /**
   * Set when `nativeRunId` is a child run: Bureau holds no run for it, only the
   * child's record, so the stream is built from the record and ends when the
   * child settles.
   */
  readonly child?: BureauChildRecord | undefined;
  /** Replay the run from its first event, or only the step in flight behind a snapshot. */
  readonly replay: 'beginning' | 'open-step';
  readonly messagesSnapshot: boolean;
  /**
   * Replay of a call the run already settled, ahead of the live tail: a resume
   * after a tool approval replays the approved call before the executed result.
   */
  readonly preludeEvents?: (() => Event[]) | undefined;
  /**
   * The rows a human's answer just appended to the run's conversation. No recorded
   * event carries such a row (it is neither a step's text nor a tool call), so the
   * resume that delivered the answer says what it was. The opening `MESSAGES_SNAPSHOT`
   * carries each one the conversation does not hold yet, as a row of its own, ahead of
   * the step that answers it.
   */
  readonly answerRows?: ReadonlyArray<AnswerRow> | undefined;
  /**
   * The interrupts the resume that opened this stream answered. A process that does not hold the
   * run reads its human waits from durable state, which can still show an answered one pending
   * until the run consumes the answer, so the stream does not end on one of these.
   */
  readonly answered?: ReadonlyArray<string> | undefined;
};

/** The message a mount-minted `RUN_ERROR` carries, by code. */
export function errorEvent(
  code: string,
  message: string,
  context: EventStamp,
  label: {
    readonly durable: boolean;
    readonly cursor?: string | undefined;
    readonly tripwire?: true | undefined;
  } = {
    durable: false,
  },
): Event {
  return stamp({ type: EventType.RUN_ERROR, message, code }, context, label);
}

/**
 * What a stream says when its run took session input and the thread could not be read back: the
 * run itself is over, and what it delivered is in the thread.
 */
const SNAPSHOT_UNAVAILABLE_MESSAGE =
  'The run ended, but the thread could not be read to tell which of your messages it took, so the end of the run cannot be reported. Reload to see the thread as it is.';

type ReadHistory = {
  readonly fence: string | undefined;
  readonly lastCursorByKind: ReadonlyMap<string, string>;
  /** How the run ended, from its last terminal record, when it recorded one. */
  readonly terminal:
    | {
        readonly outcome: NativeTerminal['outcome'];
        readonly detail: unknown;
        readonly recordedAs?: NativeTerminal['recordedAs'];
      }
    | undefined;
};

const TERMINAL_OUTCOME: Readonly<Record<string, NativeTerminal['outcome']>> = {
  [RECORDED.runCompleted]: 'completed',
  [RECORDED.runError]: 'error',
  [RECORDED.runAborted]: 'aborted',
};

async function readRunHistory(bureau: AgUiStreamBureau, nativeRunId: string): Promise<ReadHistory> {
  const lastCursorByKind = new Map<string, string>();
  let fence: string | undefined;
  let since: string | undefined;
  let terminal: ReadHistory['terminal'];
  for (;;) {
    const page = await bureau.eventHistory(
      { kind: 'run', id: nativeRunId },
      since === undefined ? {} : { since },
    );
    if (!('events' in page)) break;
    for (const event of page.events) {
      lastCursorByKind.set(event.kind, event.cursor);
      fence = event.cursor;
      const outcome = TERMINAL_OUTCOME[event.kind];
      if (outcome === undefined) continue;
      // COR-1627: a run that stopped at its step limit recorded `run.error` and then a
      // `run.completed` that carries its finish reason; it ended in the error.
      const payload = event.payload as { finishReason?: unknown } | null | undefined;
      terminal =
        event.kind === RECORDED.runCompleted && payload?.finishReason === 'maximum-steps'
          ? { outcome: 'error', detail: event.payload, recordedAs: RECORDED.runCompleted }
          : { outcome, detail: event.payload };
    }
    if (!page.hasMore || page.nextCursor === undefined) break;
    since = page.nextCursor;
  }
  return { fence, lastCursorByKind, terminal };
}

function pendingFor(bureau: AgUiStreamBureau, nativeRunId: string): PendingReview[] {
  return bureau.listPendingReviews().filter((review) => review.runId === nativeRunId);
}

const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  RECORDED.runCompleted,
  RECORDED.runError,
  RECORDED.runAborted,
]);

/** Whether this process holds the run and it has not recorded its end. */
export function runIsGoing(bureau: Pick<Bureau, 'getRun'>, nativeRunId: string): boolean {
  const detail = bureau.getRun(nativeRunId);
  if (detail === undefined) return false;
  if (detail.status !== 'running' && detail.status !== 'aborting') return false;
  return !detail.events.some((event) => TERMINAL_EVENTS.has(event.event));
}

/**
 * The reviews of a run that a client can be asked to answer now: the ones the
 * interrupt that ends the AG-UI run would carry. A run that is still going has
 * not stored its conversation, so an approval it has gated cannot have its
 * outcome written yet; it is offered once the run has settled, and until then
 * only a human wait the run is parked on is.
 */
export function interruptibleReviews(
  bureau: Pick<Bureau, 'getRun' | 'listPendingReviews'>,
  nativeRunId: string,
): PendingReview[] {
  const pending = bureau.listPendingReviews().filter((review) => review.runId === nativeRunId);
  return runIsGoing(bureau, nativeRunId)
    ? pending.filter((review) => review.kind === 'human-wait')
    : pending;
}

/**
 * The row a settled child's final text is, under the id a child run's rows have
 * (`<childRunId>:step:<n>`, `n` the child's last step), or `undefined` when the
 * child has no final text or its step count cannot be read from its durable run.
 */
async function childResultRow(
  bureau: Pick<Bureau, 'getDurableRun'>,
  record: BureauChildRecord,
): Promise<{ readonly id: string; readonly content: string } | undefined> {
  const content = record.status === 'completed' ? record.outcome?.content : undefined;
  if (content === undefined || content === '') return undefined;
  const state = await bureau.getDurableRun(record.childRunId).catch(() => undefined);
  const result: unknown = state?.result;
  const steps =
    typeof result === 'object' && result !== null
      ? (result as { steps?: unknown }).steps
      : undefined;
  if (typeof steps !== 'number' || !Number.isInteger(steps) || steps < 1) return undefined;
  return { id: `${record.childRunId}:step:${steps - 1}`, content };
}

/** The call a `tool-call` row announces, as the assistant message it belongs to is named. */
function parentOfCallRow(rowId: string, callId: string): string {
  const suffix = `:call:${callId}`;
  return rowId.endsWith(suffix) && rowId.length > suffix.length
    ? rowId.slice(0, -suffix.length)
    : rowId;
}

/**
 * The events that show a tool call the conversation already holds, and the
 * result row it is waiting under: what a client needs to draw the approval card
 * for a call it did not watch run. `executed` carries the arguments the call ran
 * with when an approval overrode the ones the conversation holds.
 */
export function replayCall(
  history: ConversationHistory | undefined,
  callId: string,
  context: EventStamp,
  executed?: { readonly arguments: unknown },
): Event[] {
  const rows: Message[] =
    history === undefined ? [] : history.ids.map((id) => history.messages[id]!);
  const callRow = rows.find((row) => row.toolCall?.id === callId);
  if (callRow?.toolCall === undefined) return [];
  const call = callRow.toolCall;
  const resultRow = rows.find((row) => row.toolResult?.callId === callId);
  const live = <TEvent extends Event>(event: TEvent): TEvent =>
    stamp(event, context, { durable: false });
  const shown = executed === undefined ? call.arguments : executed.arguments;
  const args = typeof shown === 'string' ? shown : JSON.stringify(shown);
  const events: Event[] = [
    live({
      type: EventType.TOOL_CALL_START,
      toolCallId: callId,
      toolCallName: call.name,
      parentMessageId: parentOfCallRow(callRow.id, callId),
    }),
    live({ type: EventType.TOOL_CALL_ARGS, toolCallId: callId, delta: args }),
    live({ type: EventType.TOOL_CALL_END, toolCallId: callId }),
  ];
  if (resultRow?.toolResult !== undefined) {
    events.push(
      live({
        type: EventType.TOOL_CALL_RESULT,
        messageId: resultRow.id,
        toolCallId: callId,
        content: toAGUIToolMessage(resultRow.id, resultRow.toolResult, {}).content,
        role: 'tool',
      }),
    );
  }
  return events;
}

/**
 * Opens the stream and returns its response. The response is a live stream: it
 * has not finished when this returns, and finishes when the run does or the
 * stream is ended some other way.
 */
export function openRunStream(
  environment: AgUiStreamEnvironment,
  request: OpenRunStream,
): Response {
  const { bureau, runtime } = environment;
  const stampContext: EventStamp = {
    nativeRunId: request.nativeRunId,
    sessionId: request.threadId,
    now: () => runtime.clock.now(),
  };
  const projector = new RunProjector(request.nativeRunId, stampContext);

  let sink: AgUiSink;
  let ended = false;
  let unsubscribeFrames: (() => void) | undefined;
  let unsubscribeSnapshots: (() => void) | undefined;
  const buffer: ServerFrame[] = [];
  let highestSequence = -1;
  let opened = false;
  let lastState = '';
  let lastRevision = 0;
  let tail: Promise<void> = Promise.resolve();
  const childWait = new AbortController();
  const cleanups: Array<() => void> = [];

  const dispose = (): void => {
    ended = true;
    childWait.abort();
    for (const cleanup of cleanups.splice(0)) cleanup();
    unsubscribeFrames?.();
    unsubscribeFrames = undefined;
    unsubscribeSnapshots?.();
    unsubscribeSnapshots = undefined;
    buffer.length = 0;
  };

  const enqueue = (task: () => Promise<void>): void => {
    const runTask = async (): Promise<void> => {
      if (ended) return;
      try {
        await task();
      } catch (error) {
        fail('RUN_FAILED', error instanceof Error ? error.message : 'The stream failed');
      }
    };
    tail = tail.then(runTask);
  };

  const fail = (code: AgUiErrorCode, message: string): void => {
    if (ended) return;
    const event = errorEvent(code, message, stampContext);
    dispose();
    sink.finish(event);
  };

  sink = createAgUiSink({
    timers: runtime.timers,
    maxStreamDurationMs: environment.maxStreamDurationMs,
    keepAliveMs: environment.keepAliveMs,
    liveBufferSize: environment.liveBufferSize,
    onDeadline: () => {
      fail('STREAM_DEADLINE', 'The stream reached its maximum duration; attach again.');
    },
    onClosed: dispose,
  });

  const writeEvents = (events: ReadonlyArray<Event>): void => {
    for (const event of events) {
      if (ended) return;
      if (opened ? !sink.writeLive(event) : (sink.writeOpening(event), false)) {
        fail('STREAM_OVERFLOW', 'The stream fell too far behind; attach again.');
        return;
      }
    }
  };

  const stateSnapshot = (snapshot: {
    revision: number;
    status: string;
    assessment?: string | undefined;
  }): Event => {
    lastRevision = Math.max(lastRevision, snapshot.revision);
    return stamp(
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: {
          revision: lastRevision,
          status: snapshot.status,
          ...(snapshot.assessment === undefined ? {} : { assessment: snapshot.assessment }),
          pendingInterruptIds: interruptibleReviews(bureau, request.nativeRunId).map(
            (review) => review.id,
          ),
        },
      },
      stampContext,
      { durable: false },
    );
  };

  const stateKey = (snapshot: { status: string; assessment?: string | undefined }): string =>
    JSON.stringify([
      snapshot.status,
      snapshot.assessment,
      interruptibleReviews(bureau, request.nativeRunId).map((review) => review.id),
    ]);

  /**
   * A run that itself took input the client sent while it was going ends with the thread as a
   * `MESSAGES_SNAPSHOT`, before its terminal event, whichever way it ended. The input never
   * streams as an event of its own, so the snapshot is how a client that holds the input's row
   * (under the id it sent the input with) learns the run delivered it, and where in the thread the
   * run put it. Which inputs a run delivered is the durable delivery record's answer
   * (`Bureau.sessionInputsDeliveredBy`), and the thread is read once the session has recorded the
   * run's end (`Bureau.whenRunRecorded`), however long that takes: no count of turns decides
   * whether the snapshot is sent.
   *
   * Resolves `false` when the run delivered input and the snapshot could not be produced, because
   * the delivery record or the session could not be read, or the session does not hold what the
   * run delivered. The stream then ends with an error and never with a success that leaves the
   * snapshot out: a client that is told success and given no snapshot resends an input the run
   * already took.
   */
  const writeDeliveredInputs = async (): Promise<boolean> => {
    try {
      const delivered = await bureau.sessionInputsDeliveredBy(
        request.nativeRunId,
        request.threadId,
      );
      if (delivered.length === 0) return true;
      await bureau.whenRunRecorded(request.nativeRunId);
      const session = await readSessionOwnedBy(bureau, request.threadId, request.owner);
      const history = session?.conversationHistory;
      if (history === undefined || !delivered.every((id) => history.ids.includes(id))) {
        return false;
      }
      writeEvents([
        stamp(
          { type: EventType.MESSAGES_SNAPSHOT, messages: snapshotMessages(history) },
          stampContext,
          { durable: false },
        ),
      ]);
      return true;
    } catch {
      return false;
    }
  };

  const finishAs = async (terminal: NativeTerminal): Promise<void> => {
    const closing = projector.closeOpen();
    const history = await readRunHistory(bureau, request.nativeRunId).catch(() => undefined);
    const kind =
      terminal.recordedAs ??
      (terminal.outcome === 'completed'
        ? RECORDED.runCompleted
        : terminal.outcome === 'error'
          ? RECORDED.runError
          : RECORDED.runAborted);
    const label = {
      durable: true,
      ...(history?.lastCursorByKind.get(kind) === undefined
        ? {}
        : { cursor: history.lastCursorByKind.get(kind) }),
      ...(terminal.tripwire ? { tripwire: true as const } : {}),
    };
    writeEvents(closing);
    if (ended) return;
    const { threadId, runId } = request;
    const snapshotWritten = await writeDeliveredInputs();
    if (ended) return;
    let last: Event;
    if (terminal.outcome === 'error') {
      const { code, message } = errorOf(terminal.detail);
      last = errorEvent(code, message, stampContext, label);
    } else if (!snapshotWritten) {
      last = errorEvent('RUN_FAILED', SNAPSHOT_UNAVAILABLE_MESSAGE, stampContext, label);
    } else if (terminal.outcome === 'aborted') {
      last = stamp(
        {
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
          outcome: { type: 'cancelled' },
        },
        stampContext,
        label,
      );
    } else {
      const interrupts = pendingFor(bureau, request.nativeRunId).map(toInterrupt);
      const outcome: RunFinishedOutcome =
        interrupts.length > 0 ? { type: 'interrupt', interrupts } : { type: 'success' };
      last = stamp(
        {
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
          outcome,
          usage: usageOf(terminal.detail),
        },
        stampContext,
        label,
      );
    }
    dispose();
    sink.finish(last, label.cursor);
  };

  const interruptNow = (interrupts: Interrupt[]): void => {
    writeEvents(projector.closeOpen());
    if (ended) return;
    const last = stamp(
      {
        type: EventType.RUN_FINISHED,
        threadId: request.threadId,
        runId: request.runId,
        outcome: { type: 'interrupt', interrupts },
      },
      stampContext,
      { durable: false },
    );
    dispose();
    sink.finish(last);
  };

  /** Applies one projection. Returns whether the stream is over. */
  const apply = async (projection: ReturnType<RunProjector['handleRecorded']>): Promise<void> => {
    writeEvents(projection.events);
    if (ended) return;
    if (projection.terminal !== undefined) {
      await finishAs(projection.terminal);
      return;
    }
    if (projection.parked === true) {
      const parked = pendingFor(bureau, request.nativeRunId).filter(
        (review) => review.kind === 'human-wait',
      );
      if (parked.length > 0) interruptNow(parked.map(toInterrupt));
    }
  };

  const processFrame = async (frame: ServerFrame): Promise<void> => {
    if (frame.type === 'event') {
      if (frame.sequence <= highestSequence) return;
      highestSequence = frame.sequence;
      await apply(projector.handleRecorded(frame.event, frame.detail));
      return;
    }
    if (frame.type === 'stream:text-delta') {
      await apply(projector.handleTextDelta(frame.content, frame.accumulated));
    }
  };

  const drain = async (): Promise<void> => {
    for (;;) {
      if (ended) return;
      const frame = buffer.shift();
      if (frame === undefined) return;
      await processFrame(frame);
    }
  };

  // The stream listens before it reads anything, so nothing falls between the
  // recorded history and the live tail; the buffered frames the history already
  // held are dropped by sequence.
  unsubscribeFrames = bureau.subscribeLiveFrames((frame) => {
    const relevant =
      (frame.type === 'event' || frame.type === 'stream:text-delta') &&
      frame.runId === request.nativeRunId;
    if (!relevant || ended) return;
    buffer.push(frame);
    if (opened) enqueue(drain);
  });

  /**
   * A child run's stream. Bureau holds no run for a child, only its record, so
   * there are no steps to project: the stream is the record as it stands, then
   * the record the child settles into. Its events are not part of any durable
   * history this mount reads, so none is labelled durable.
   */
  const openChild = async (record: BureauChildRecord): Promise<void> => {
    const { threadId, runId } = request;
    const durably = { durable: false } as const;
    const resultRow = await childResultRow(bureau, record);
    writeEvents([
      stamp(
        {
          type: EventType.RUN_STARTED,
          threadId,
          runId,
          ...(request.parentRunId === undefined ? {} : { parentRunId: request.parentRunId }),
        },
        stampContext,
        durably,
      ),
      stamp(
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages:
            resultRow === undefined
              ? []
              : [{ id: resultRow.id, role: 'assistant', content: resultRow.content }],
        },
        stampContext,
        durably,
      ),
      stamp(
        {
          type: EventType.STATE_SNAPSHOT,
          snapshot: { revision: record.revision, status: record.status, pendingInterruptIds: [] },
        },
        stampContext,
        durably,
      ),
    ]);
    if (ended) return;
    opened = true;
    let settled = record;
    if (record.status === 'running') {
      const waited = await bureau.children.wait(
        { parentRunId: record.parentRunId, childRunId: record.childRunId },
        { signal: childWait.signal },
      );
      if (ended) return;
      if (waited.outcome === 'not-found') {
        fail('RUN_NOT_FOUND', `Run "${request.nativeRunId}" was not found`);
        return;
      }
      if (waited.outcome !== 'settled') {
        // Nothing in this process is observing the child (it is between a restart
        // and its reattachment); a later attach finds it observed.
        fail('RUN_FAILED', 'The child run is not being observed yet; attach again');
        return;
      }
      settled = waited.child;
      // The client holds no result yet: it is the message the child ends with.
      const settledRow = await childResultRow(bureau, settled);
      if (ended) return;
      if (settledRow !== undefined) {
        writeEvents([
          stamp(
            { type: EventType.TEXT_MESSAGE_START, messageId: settledRow.id, role: 'assistant' },
            stampContext,
            durably,
          ),
          stamp(
            {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: settledRow.id,
              delta: settledRow.content,
            },
            stampContext,
            durably,
          ),
          stamp(
            { type: EventType.TEXT_MESSAGE_END, messageId: settledRow.id },
            stampContext,
            durably,
          ),
        ]);
        if (ended) return;
      }
    }
    let last: Event;
    if (settled.status === 'failed') {
      last = errorEvent(
        'RUN_FAILED',
        settled.outcome?.reason ?? 'The child run failed',
        stampContext,
      );
    } else {
      last = stamp(
        {
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
          outcome: settled.status === 'aborted' ? { type: 'cancelled' } : { type: 'success' },
        },
        stampContext,
        durably,
      );
    }
    dispose();
    sink.finish(last);
  };

  const peerContext = (): Parameters<typeof openPeerStream>[0] => ({
    bureau,
    timers: runtime.timers,
    stampContext,
    threadId: request.threadId,
    runId: request.runId,
    nativeRunId: request.nativeRunId,
    owner: request.owner,
    answered: new Set(request.answered ?? []),
    answerRows: request.answerRows ?? [],
    preludeEvents: () => request.preludeEvents?.() ?? [],
    replayCall: (history, callId) => replayCall(history, callId, stampContext),
    writeEvents,
    isEnded: () => ended,
    markOpened: () => {
      opened = true;
    },
    onDispose: (cleanup) => {
      if (ended) cleanup();
      else cleanups.push(cleanup);
    },
    interruptNow,
    fail,
    finish: (last, cursor) => {
      dispose();
      sink.finish(last, cursor);
    },
  });

  const open = async (): Promise<void> => {
    if (request.child !== undefined) {
      // The route authorized the run id on the owner `getOwner` reports, which reads run attribution
      // before the child record. A child id can be chosen by whoever dispatches it, so the record
      // located under an authorized id can be another owner's; refuse it as a missing run.
      if (!runIsOwnedBy(request.child, request.owner)) {
        fail('RUN_NOT_FOUND', `Run "${request.nativeRunId}" was not found`);
        return;
      }
      await openChild(request.child);
      return;
    }
    const history = await readRunHistory(bureau, request.nativeRunId).catch(() => undefined);
    const session = await readSessionOwnedBy(bureau, request.threadId, request.owner);
    const detail: RunDetail | undefined = bureau.getRun(request.nativeRunId);
    // A run held under another owner's name is not the one the route authorized. Nothing has been
    // written yet, so the stream is one error.
    if (detail !== undefined && !runIsOwnedBy(detail, request.owner)) {
      fail('RUN_NOT_FOUND', `Run "${request.nativeRunId}" was not found`);
      return;
    }
    // A run no process-local state names, held by another process or settled with an approval no
    // process restored, is streamed from its durable state.
    if (detail === undefined && pendingFor(bureau, request.nativeRunId).length === 0) {
      const durable = await bureau.getDurableRun(request.nativeRunId).catch(() => undefined);
      if (durable !== undefined && durable !== null) {
        await openPeerStream(peerContext(), durable, history?.fence);
        return;
      }
    }
    const conversation: ConversationHistory | undefined =
      detail?.transcript ?? session?.conversationHistory;
    const fence = history?.fence;
    const liveness = detail?.liveness;
    // A run Bureau no longer holds (recovered after a restart, or removed by
    // retention) has no liveness to read: it is reported as it was left, with no
    // assessment, because no liveness assessment was made of it.
    const synthesized = { revision: lastRevision, status: 'terminal' };
    const snapshot = liveness ?? synthesized;

    writeEvents([
      stamp(
        {
          type: EventType.RUN_STARTED,
          threadId: request.threadId,
          runId: request.runId,
          ...(request.parentRunId === undefined ? {} : { parentRunId: request.parentRunId }),
        },
        stampContext,
        { durable: false },
      ),
    ]);
    // A run Bureau no longer holds has no events to replay, so a start retried
    // against it is shown the conversation as well, as an attach is.
    const answerRows = request.answerRows ?? [];
    if (request.messagesSnapshot || detail === undefined || answerRows.length > 0) {
      // The answers a resume delivered ride in the snapshot (a row the run has not appended yet).
      projector.holds(conversation?.ids ?? []);
      writeEvents([
        stamp(
          {
            type: EventType.MESSAGES_SNAPSHOT,
            messages: snapshotMessagesWithAnswers(conversation, answerRows),
          },
          stampContext,
          { durable: false, ...(fence === undefined ? {} : { cursor: fence }) },
        ),
      ]);
    }
    writeEvents([stateSnapshot(snapshot)]);
    lastState = stateKey(snapshot);
    writeEvents(request.preludeEvents?.() ?? []);

    // Replay what the client has not seen, through the same projection the live
    // tail uses, so a replayed step and a live one cannot differ.
    const recorded = detail?.events ?? [];
    let from = 0;
    if (request.replay === 'open-step') {
      from = recorded.length;
      let openAt: number | undefined;
      for (const [index, event] of recorded.entries()) {
        if (event.event === RECORDED.stepStarted) openAt = index;
        if (event.event === RECORDED.stepCompleted) openAt = undefined;
      }
      if (openAt !== undefined) from = openAt;
    }
    let ending: NativeTerminal | undefined;
    for (const event of recorded.slice(from)) {
      highestSequence = Math.max(highestSequence, event.sequence);
      const projection = projector.handleRecorded(event.event, event.detail);
      writeEvents(projection.events);
      if (ended) return;
      if (projection.terminal !== undefined) ending = projection.terminal;
      else if (projection.parked === true) {
        const parked = pendingFor(bureau, request.nativeRunId).filter(
          (review) => review.kind === 'human-wait',
        );
        if (parked.length > 0) {
          interruptNow(parked.map(toInterrupt));
          return;
        }
      }
    }
    for (const event of recorded) highestSequence = Math.max(highestSequence, event.sequence);

    // A run parked on a human wait has finished its step natively (the park is
    // taken when the loop ends), so a stream that opens on it has no park event
    // left to replay; the pending review is what says the run is waiting.
    if (ending === undefined && detail !== undefined && detail.status === 'running') {
      const waiting = pendingFor(bureau, request.nativeRunId).filter(
        (review) => review.kind === 'human-wait',
      );
      if (waiting.length > 0) {
        interruptNow(waiting.map(toInterrupt));
        return;
      }
    }

    // A delta that arrived while the stream was reading was cut before the
    // replay, which the replay's events do not include: the next delta carries
    // the text accumulated so far, so replaying a stale one would only repeat it.
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      if (buffer[index]!.type === 'stream:text-delta') buffer.splice(index, 1);
    }
    opened = true;
    if (ending !== undefined) {
      await finishAs(ending);
      return;
    }
    if (detail === undefined || (detail.status !== 'running' && detail.status !== 'aborting')) {
      // A settled run with an approval pending: its call is replayed, and the
      // interrupt that is still waiting on it ends the AG-UI run.
      const pending = pendingFor(bureau, request.nativeRunId);
      if (pending.length > 0 && request.replay === 'open-step') {
        for (const review of pending) {
          if (review.kind === 'tool-approval') {
            writeEvents(replayCall(conversation, review.approval.callId, stampContext));
          }
        }
        // The same fact the start stream ends on, so it carries the same label
        // and cursor: the run completed, and the interrupt is what is left.
        if (detail?.status === 'error' || detail?.status === 'aborted') {
          interruptNow(pending.map(toInterrupt));
        } else {
          await finishAs({
            outcome: 'completed',
            detail: { error: detail?.error, usage: detail?.usage },
            tripwire: false,
          });
        }
        return;
      }
      if (detail === undefined) {
        // The run is not held, so how it ended is what its durable record says:
        // never an outcome the stream made up.
        if (history?.terminal === undefined) {
          fail('RUN_FAILED', `Run "${request.nativeRunId}" recorded no outcome`);
          return;
        }
        await finishAs({ ...history.terminal, tripwire: false });
        return;
      }
      await finishAs({
        outcome:
          detail.status === 'error'
            ? 'error'
            : detail.status === 'aborted'
              ? 'aborted'
              : 'completed',
        detail: { error: detail.error, usage: detail.usage },
        tripwire: false,
      });
      return;
    }

    try {
      const subscription = bureau.subscribeRunSnapshot(request.nativeRunId, (next) => {
        enqueue(async () => {
          const key = stateKey(next);
          if (key === lastState) return;
          lastState = key;
          writeEvents([stateSnapshot(next)]);
        });
      });
      unsubscribeSnapshots = () => subscription.unsubscribe();
    } catch {
      // A run Bureau no longer holds has no liveness to follow.
    }
    await drain();
  };

  enqueue(open);
  return sink.response;
}

export { stepName };
