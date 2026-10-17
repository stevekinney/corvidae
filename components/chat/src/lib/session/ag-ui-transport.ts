import { EventType, type Event as AGUIEvent } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import type { ConversationHistory } from '../components/chat/conversation-model.ts';
import { AGUIChatTransportError } from './ag-ui-transport-error.ts';
import {
  callChunk,
  callDelta,
  callResult,
  closeCallLane,
  closeTextLane,
  endCall,
  endText,
  finishStep,
  startCall,
  startStep,
  startText,
  textChunk,
  textDelta,
} from './ag-ui-transport-messages.ts';
import {
  closeReasoningLane,
  endMessage,
  endSpan,
  messageChunk,
  messageDelta,
  recordEncryptedValue,
  startMessage,
  startSpan,
} from './ag-ui-transport-reasoning.ts';
import { adoptSnapshot, failRun, finishRun, startRun } from './ag-ui-transport-run.ts';
import { createMapperState, protocolError, type MapperState } from './ag-ui-transport-state.ts';
import type { ChatSessionRequest, ChatSessionTransport } from './session-controller-support.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

export {
  AGUIChatTransportError,
  type AGUIChatTransportErrorKind,
} from './ag-ui-transport-error.ts';
export { UNSTARTED_RUN_ID } from './ag-ui-transport-state.ts';

/**
 * The AG-UI 1.0 event types this transport reads and deliberately does not
 * act on. Each is validated against the `@ag-ui/core` schema like any other
 * event, then produces no frame and changes no state: the chat transcript has
 * nowhere to put application state, activity, raw provider events, custom
 * events, or the lifecycle of a subagent. The one thing they do is end an open
 * `TEXT_MESSAGE_CHUNK` or `TOOL_CALL_CHUNK` run, as any event that is not a
 * chunk does.
 */
export const AG_UI_UNSUPPORTED_EVENT_TYPES = [
  EventType.STATE_SNAPSHOT,
  EventType.STATE_DELTA,
  EventType.ACTIVITY_SNAPSHOT,
  EventType.ACTIVITY_DELTA,
  EventType.RAW,
  EventType.CUSTOM,
  EventType.SUBAGENT_STARTED,
  EventType.SUBAGENT_FINISHED,
  EventType.SUBAGENT_ERROR,
] as const satisfies readonly EventType[];

const unsupportedTypes: ReadonlySet<EventType> = new Set(AG_UI_UNSUPPORTED_EVENT_TYPES);

/**
 * Maps an AG-UI 1.0 event stream onto the native chat wire, version 3.
 *
 * Every event is validated against the pinned `@ag-ui/core` schema first, and
 * an invalid or out-of-order one throws an {@link AGUIChatTransportError},
 * which fails the run. The native wire does not change; this is a one-way
 * projection onto it:
 *
 * - `RUN_STARTED` becomes `run.started`, keeping its thread and parent run. A
 *   `RUN_ERROR` that arrives first is preceded by a `run.started` with run id
 *   `ag-ui:unstarted` (and the error's thread, if it names one), because a
 *   version 3 stream opens that way. `RUN_ERROR` becomes `run.error` with the
 *   backend's message and its code as `backendCode`; the wire `code` is the
 *   same string only on an exact match with a code the wire has, else `UNKNOWN`.
 * - An assistant `TEXT_MESSAGE_*` run becomes an `assistant.step.*` pair around
 *   `stream:text-delta` frames addressed by `messageId`. A version 3 stream has
 *   one open step at a time, so messages that overlap are written one after
 *   another in the order they started: a later message's step and deltas wait
 *   until the earlier one ends. Text from any other
 *   role (the user's own echoed message, a system or developer message) is the
 *   session's own and is not added to history.
 * - `TOOL_CALL_START`, `TOOL_CALL_ARGS` and `TOOL_CALL_END` become
 *   `stream:tool-call-*` frames, and the end also yields the `tool_call` frame
 *   that gives the call a row; `TOOL_CALL_RESULT` becomes `tool_result`.
 * - `STEP_*` become `metadata` blocks. `REASONING_START` and `REASONING_END`
 *   name a span, which is one `thinking` block; `REASONING_MESSAGE_*` events
 *   name messages inside it, keyed by their own ids, and
 *   `REASONING_ENCRYPTED_VALUE` names a message. A `REASONING_MESSAGE_CHUNK`
 *   with no span open gets an implicit span that lasts as long as the chunk run. The session observes blocks
 *   and does not render them.
 * - Events that carry a `subagentRunId` belong to a subagent, not to this
 *   thread, and are skipped (as are such messages in a snapshot).
 * - `RUN_FINISHED` becomes the `run.completed` terminal, and a `cancelled`
 *   outcome becomes `run.aborted`. Its `interrupt` outcome also completes the
 *   run, with finish reason `interrupt`, and the interrupt details are dropped
 *   for now: the resume flow will map them to elicitation. That is a two-way
 *   door. A `REASONING_ENCRYPTED_VALUE` for a tool call is not kept either,
 *   because the history is the server's and the client never replays provider
 *   reasoning, and AG-UI's per-event `metadata` is not merged into the
 *   conversation.
 * - The types in {@link AG_UI_UNSUPPORTED_EVENT_TYPES} change nothing.
 *
 * The client's rows are authoritative. `options.conversation` is the history
 * the run was asked from, and the terminal frame's conversation is that
 * history, grown by every `MESSAGES_SNAPSHOT` and then by the messages the run
 * produced, merged by message id: a snapshot or a streamed message can add
 * rows the client lacks and can never delete or rewrite one it has. Messages
 * land in the order they started, however they end. Message ids are the
 * backend's, kept as the row ids, so a backend that echoes the client's ids
 * (as the AG-UI run input carries them) is merged row for row. A snapshot that
 * shares no message, and no tool call, with a thread the client already holds is
 * not a copy of that thread: its earlier history is not merged, so a backend
 * that renames everything cannot add the whole history a second time, but the
 * messages after its last user message (all of it, when it holds none because
 * it snapshots only what it owns) are this turn's output and are kept. A message
 * still streaming is left out of a snapshot, because its whole row is written
 * when it ends. A tool call is filed under the assistant message it names as its
 * parent (joining it, or being that message's first call), so it gets the row id
 * a snapshot of the same thread gives it; a call that names no parent is a
 * message of its own, and a snapshot's copy of it is skipped by call id.
 */
export async function* mapAGUIEventsToChatStream(
  events: AsyncIterable<unknown> | Iterable<unknown>,
  options: { conversation: ConversationHistory },
): AsyncGenerator<ChatStreamEvent> {
  const state = createMapperState(options.conversation);
  let index = 0;
  for await (const raw of events) {
    const eventIndex = index++;
    try {
      const event = parseEvent(raw, eventIndex);
      if (isSubagentEvent(event)) continue;
      if (unsupportedTypes.has(event.type)) {
        yield* closeLanes(state);
        continue;
      }
      assertCanAccept(state, event);
      yield* reduceEvent(state, event);
    } catch (error) {
      throw error instanceof AGUIChatTransportError ? withIndex(error, eventIndex) : error;
    }
  }
  if (!state.finished)
    throw new AGUIChatTransportError(
      'incomplete-stream',
      'The AG-UI stream ended before RUN_FINISHED or RUN_ERROR.',
    );
}

/**
 * A chat session transport that runs each turn against an AG-UI backend.
 *
 * `openStream` starts the backend run for one controller turn and returns its
 * events, already parsed from whatever the backend speaks. Pair this with
 * `executionOwner: 'server'`: the AG-UI backend runs the whole turn, so the
 * client has no step left to continue.
 */
export function createAGUIChatTransport(
  openStream: (
    request: ChatSessionRequest,
  ) =>
    | AsyncIterable<unknown>
    | Iterable<unknown>
    | Promise<AsyncIterable<unknown> | Iterable<unknown>>,
): ChatSessionTransport {
  return async (request) =>
    mapAGUIEventsToChatStream(await openStream(request), { conversation: request.conversation });
}

function isAGUIEvent(value: unknown): value is AGUIEvent {
  return EventSchemas.safeParse(value).success;
}

function parseEvent(raw: unknown, eventIndex: number): AGUIEvent {
  if (isAGUIEvent(raw)) return raw;
  const cause = EventSchemas.safeParse(raw).error;
  throw new AGUIChatTransportError(
    'invalid-event',
    `AG-UI event ${eventIndex} does not satisfy the @ag-ui/core event schema${cause === undefined ? '' : `: ${cause.message}`}.`,
    { cause },
  );
}

/** Stamps the position of the event that failed, which only the loop knows. */
function withIndex(error: AGUIChatTransportError, eventIndex: number): AGUIChatTransportError {
  return new AGUIChatTransportError(error.kind, error.message, { eventIndex, cause: error.cause });
}

function isSubagentEvent(event: AGUIEvent): boolean {
  return 'subagentRunId' in event && event.subagentRunId !== undefined;
}

function assertCanAccept(state: MapperState, event: AGUIEvent): void {
  if (state.finished) throw protocolError(`${event.type} arrived after the run ended.`);
  if (
    event.type !== EventType.RUN_STARTED &&
    event.type !== EventType.RUN_ERROR &&
    state.runId === undefined
  )
    throw protocolError(`${event.type} arrived before RUN_STARTED.`);
}

/** Ends every open chunk run: any event that is not a chunk of its own kind does. */
function* closeLanes(state: MapperState): Generator<ChatStreamEvent> {
  yield* closeTextLane(state);
  yield* closeCallLane(state);
  yield* closeReasoningLane(state);
}

function* reduceEvent(state: MapperState, event: AGUIEvent): Generator<ChatStreamEvent> {
  // A chunk event extends one message, call, or reasoning message; any other
  // event ends it.
  if (event.type !== EventType.TEXT_MESSAGE_CHUNK) yield* closeTextLane(state);
  if (event.type !== EventType.TOOL_CALL_CHUNK) yield* closeCallLane(state);
  if (event.type !== EventType.REASONING_MESSAGE_CHUNK) yield* closeReasoningLane(state);
  switch (event.type) {
    case EventType.RUN_STARTED:
      yield* startRun(state, event);
      return;
    case EventType.RUN_FINISHED:
      yield* finishRun(state, event);
      return;
    case EventType.RUN_ERROR:
      yield* failRun(state, event);
      return;
    case EventType.STEP_STARTED:
      yield* startStep(state, event.stepName);
      return;
    case EventType.STEP_FINISHED:
      yield* finishStep(state, event.stepName);
      return;
    case EventType.TEXT_MESSAGE_START:
      yield* startText(state, event.messageId, event.role ?? 'assistant');
      return;
    case EventType.TEXT_MESSAGE_CONTENT:
      yield* textDelta(state, event.messageId, event.delta);
      return;
    case EventType.TEXT_MESSAGE_END:
      yield* endText(state, event.messageId);
      return;
    case EventType.TEXT_MESSAGE_CHUNK:
      yield* textChunk(state, event);
      return;
    case EventType.TOOL_CALL_START:
      yield* startCall(state, event.toolCallId, event.toolCallName, event.parentMessageId);
      return;
    case EventType.TOOL_CALL_ARGS:
      yield* callDelta(state, event.toolCallId, event.delta);
      return;
    case EventType.TOOL_CALL_END:
      yield* endCall(state, event.toolCallId);
      return;
    case EventType.TOOL_CALL_CHUNK:
      yield* callChunk(state, event);
      return;
    case EventType.TOOL_CALL_RESULT:
      yield* callResult(state, event);
      return;
    case EventType.MESSAGES_SNAPSHOT:
      adoptSnapshot(state, event.messages);
      return;
    case EventType.REASONING_START:
      yield* startSpan(state, event.messageId);
      return;
    case EventType.REASONING_MESSAGE_START:
      startMessage(state, event.messageId);
      return;
    case EventType.REASONING_MESSAGE_CONTENT:
      yield* messageDelta(state, event.messageId, event.delta);
      return;
    case EventType.REASONING_MESSAGE_CHUNK:
      yield* messageChunk(state, event);
      return;
    case EventType.REASONING_MESSAGE_END:
      endMessage(state, event.messageId);
      return;
    case EventType.REASONING_END:
      yield* endSpan(state, event.messageId);
      return;
    case EventType.REASONING_ENCRYPTED_VALUE:
      if (event.subtype === 'message')
        recordEncryptedValue(state, event.entityId, event.encryptedValue);
      return;
    // Every other type is unsupported and was handled before this point.
  }
}
