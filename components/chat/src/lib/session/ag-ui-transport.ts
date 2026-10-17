import {
  EventType,
  type Event as AGUIEvent,
  type Message as AGUIMessage,
  type TokenUsage as AGUITokenUsage,
  type ToolMessage as AGUIToolMessage,
} from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import {
  appendAGUIMessages,
  fromAGUIMessages,
  fromAGUIToolMessage,
  type TokenUsage,
} from 'conversationalist';
import { isJSONValue } from '../components/chat/builders.ts';
import type { ConversationHistory, JSONValue } from '../components/chat/conversation-model.ts';
import { AGUIChatTransportError } from './ag-ui-transport-error.ts';
import type { ChatSessionRequest, ChatSessionTransport } from './session-controller-support.ts';
import type { ChatStreamBlock, ChatStreamEvent } from './stream-event-codec.ts';

export {
  AGUIChatTransportError,
  type AGUIChatTransportErrorKind,
} from './ag-ui-transport-error.ts';

/**
 * The AG-UI 1.0 event types this transport reads and deliberately does not
 * act on. Each is validated against the `@ag-ui/core` schema like any other
 * event, then produces no frame and changes no state: the chat transcript has
 * nowhere to put application state, activity, raw provider events, custom
 * events, or the lifecycle of a subagent.
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

/** The wire version these frames speak: the first one with `run.started` and message identity. */
const WIRE_VERSION = 3;

type OpenText = { step: number; text: string };
type OpenCall = { name: string; args: string };
type OpenReasoning = { block: ChatStreamBlock; messageOpen: boolean };

/** Everything the mapping remembers about one run, and nothing about any other. */
type MapperState = {
  /** History the run's messages are appended to; replaced wholesale by a `MESSAGES_SNAPSHOT`. */
  base: ConversationHistory;
  /** Messages the run produced since `base`, in AG-UI form. */
  messages: AGUIMessage[];
  /** Assistant text, in order, for `run.completed.content`. */
  texts: string[];
  sequence: number;
  runId: string | undefined;
  finished: boolean;
  step: number;
  blockIndex: number;
  openText: Map<string, OpenText>;
  /** Text messages from a role the session already owns (user, developer, system). */
  foreignText: Set<string>;
  openCalls: Map<string, OpenCall>;
  settledCalls: Set<string>;
  openSteps: Map<string, ChatStreamBlock>;
  openReasoning: Map<string, OpenReasoning>;
  encryptedValues: Map<string, string>;
  /** The message a `TEXT_MESSAGE_CHUNK` run is currently extending. */
  textChunk: string | undefined;
  callChunk: string | undefined;
  reasoningChunk: string | undefined;
};

/**
 * Maps an AG-UI 1.0 event stream onto the native chat wire, version 3.
 *
 * Every event is validated against the pinned `@ag-ui/core` schema first, and
 * an invalid one throws an {@link AGUIChatTransportError}, which fails the run.
 * The native wire does not change; this is a one-way projection onto it:
 *
 * - `RUN_STARTED` becomes `run.started`.
 * - An assistant `TEXT_MESSAGE_*` run becomes an `assistant.step.*` pair around
 *   `stream:text-delta` frames addressed by `messageId`. Text from any other
 *   role is the session's own and is skipped.
 * - `TOOL_CALL_START`, `TOOL_CALL_ARGS` and `TOOL_CALL_END` become
 *   `stream:tool-call-*` frames, and the end also yields the `tool_call` frame
 *   that gives the call a row; `TOOL_CALL_RESULT` becomes `tool_result`.
 * - `STEP_*` and `REASONING_*` become `stream:block-*` frames (`metadata` and
 *   `thinking` blocks), which the session observes but does not render.
 * - `MESSAGES_SNAPSHOT` replaces the history the run is assembled on top of.
 * - `RUN_FINISHED` becomes the `run.completed` terminal, carrying that history
 *   plus everything the run produced; a `cancelled` outcome becomes
 *   `run.aborted`. `RUN_ERROR` becomes `run.error`.
 * - The types in {@link AG_UI_UNSUPPORTED_EVENT_TYPES} change nothing.
 *
 * `options.conversation` is the history the run was asked from, which is what
 * the terminal frame reconciles against when the stream sends no snapshot.
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
      if (unsupportedTypes.has(event.type)) continue;
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

function createMapperState(base: ConversationHistory): MapperState {
  return {
    base,
    messages: [],
    texts: [],
    sequence: 0,
    runId: undefined,
    finished: false,
    step: 0,
    blockIndex: 0,
    openText: new Map(),
    foreignText: new Set(),
    openCalls: new Map(),
    settledCalls: new Set(),
    openSteps: new Map(),
    openReasoning: new Map(),
    encryptedValues: new Map(),
    textChunk: undefined,
    callChunk: undefined,
    reasoningChunk: undefined,
  };
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

function protocolError(message: string): AGUIChatTransportError {
  return new AGUIChatTransportError('protocol', message);
}

function assertCanAccept(state: MapperState, event: AGUIEvent): void {
  if (state.finished) throw protocolError(`${event.type} arrived after the run ended.`);
  if (event.type !== EventType.RUN_STARTED && state.runId === undefined)
    throw protocolError(`${event.type} arrived before RUN_STARTED.`);
}

/** The envelope for the next frame; calling it in frame order keeps `sequence` increasing. */
function wire(state: MapperState): { wireVersion: typeof WIRE_VERSION; sequence: number } {
  return { wireVersion: WIRE_VERSION, sequence: state.sequence++ };
}

function* reduceEvent(state: MapperState, event: AGUIEvent): Generator<ChatStreamEvent> {
  // A chunk event extends one message or call; any other event ends it.
  if (event.type !== EventType.TEXT_MESSAGE_CHUNK) yield* closeTextChunk(state);
  if (event.type !== EventType.TOOL_CALL_CHUNK) yield* closeCallChunk(state);
  switch (event.type) {
    case EventType.RUN_STARTED:
      yield* startRun(state, event.runId);
      return;
    case EventType.RUN_FINISHED:
      yield* finishRun(state, event);
      return;
    case EventType.RUN_ERROR:
      state.finished = true;
      yield {
        type: 'run.error',
        error: {
          name: 'AGUIRunError',
          message: event.code === undefined ? event.message : `${event.message} (${event.code})`,
          kind: 'generate',
          code: 'UNKNOWN',
        },
        ...wire(state),
      };
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
      yield* startCall(state, event.toolCallId, event.toolCallName);
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
      yield* startReasoning(state, event.messageId);
      return;
    case EventType.REASONING_MESSAGE_START:
      startReasoningMessage(state, event.messageId);
      return;
    case EventType.REASONING_MESSAGE_CONTENT:
      yield* reasoningDelta(state, event.messageId, event.delta, false);
      return;
    case EventType.REASONING_MESSAGE_CHUNK:
      yield* reasoningChunk(state, event);
      return;
    case EventType.REASONING_MESSAGE_END:
      requireReasoning(state, event.messageId).messageOpen = false;
      return;
    case EventType.REASONING_END:
      yield* endReasoning(state, event.messageId);
      return;
    case EventType.REASONING_ENCRYPTED_VALUE:
      if (event.subtype === 'message')
        recordEncryptedValue(state, event.entityId, event.encryptedValue);
      return;
    // Every other type is unsupported and was filtered before this point.
  }
}

function* startRun(state: MapperState, runId: string): Generator<ChatStreamEvent> {
  if (state.runId !== undefined) throw protocolError('RUN_STARTED arrived twice.');
  state.runId = runId;
  yield { type: 'run.started', runId, ...wire(state) };
}

function* finishRun(
  state: MapperState,
  event: Extract<AGUIEvent, { type: EventType.RUN_FINISHED }>,
): Generator<ChatStreamEvent> {
  if (event.runId !== state.runId)
    throw protocolError(`RUN_FINISHED named run ${event.runId}, not ${state.runId}.`);
  const open = [
    ...state.openText.keys(),
    ...state.openCalls.keys(),
    ...state.openSteps.keys(),
    ...state.openReasoning.keys(),
  ];
  if (open.length > 0)
    throw protocolError(`RUN_FINISHED arrived while ${open.join(', ')} was still open.`);
  state.finished = true;
  if (event.outcome?.type === 'cancelled') {
    yield { type: 'run.aborted', reason: 'cancelled', ...wire(state) };
    return;
  }
  yield {
    type: 'run.completed',
    conversation: assembleConversation(state),
    content: state.texts.join('\n\n'),
    usage: sumUsage(event.usage ?? []),
    finishReason: event.outcome?.type === 'interrupt' ? 'interrupt' : 'stop',
    ...wire(state),
  };
}

function assembleConversation(state: MapperState): ConversationHistory {
  try {
    return appendAGUIMessages(state.base, state.messages);
  } catch (error) {
    throw new AGUIChatTransportError(
      'history',
      'The messages this run produced could not be assembled into a conversation.',
      { cause: error },
    );
  }
}

function sumUsage(usages: ReadonlyArray<AGUITokenUsage>): TokenUsage {
  let prompt = 0;
  let completion = 0;
  let total = 0;
  for (const usage of usages) {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    prompt += input;
    completion += output;
    total += usage.totalTokens ?? input + output;
  }
  return { prompt, completion, total };
}

function adoptSnapshot(state: MapperState, messages: AGUIMessage[]): void {
  try {
    state.base = fromAGUIMessages(messages);
  } catch (error) {
    throw new AGUIChatTransportError(
      'history',
      'MESSAGES_SNAPSHOT could not be converted to a conversation.',
      { cause: error },
    );
  }
  // The snapshot is authoritative about everything before it, including
  // whatever this run had already produced.
  state.messages = [];
}

function newBlock(
  state: MapperState,
  id: string,
  type: ChatStreamBlock['type'],
  content: string,
): ChatStreamBlock {
  return { id, type, index: state.blockIndex++, content, complete: false };
}

function* startStep(state: MapperState, stepName: string): Generator<ChatStreamEvent> {
  if (state.openSteps.has(stepName)) throw protocolError(`Step ${stepName} started twice.`);
  const block = newBlock(state, `step:${stepName}:${state.blockIndex}`, 'metadata', stepName);
  state.openSteps.set(stepName, block);
  yield { type: 'stream:block-start', block: { ...block }, ...wire(state) };
}

function* finishStep(state: MapperState, stepName: string): Generator<ChatStreamEvent> {
  const block = state.openSteps.get(stepName);
  if (block === undefined) throw protocolError(`Step ${stepName} finished without starting.`);
  state.openSteps.delete(stepName);
  yield { type: 'stream:block-complete', block: { ...block, complete: true }, ...wire(state) };
}

function* startText(
  state: MapperState,
  messageId: string,
  role: string,
): Generator<ChatStreamEvent> {
  if (state.openText.has(messageId) || state.foreignText.has(messageId))
    throw protocolError(`Text message ${messageId} started twice.`);
  if (role !== 'assistant') {
    state.foreignText.add(messageId);
    return;
  }
  const open = { step: state.step++, text: '' };
  state.openText.set(messageId, open);
  yield { type: 'assistant.step.started', step: open.step, messageId, ...wire(state) };
}

function* textDelta(
  state: MapperState,
  messageId: string,
  delta: string,
): Generator<ChatStreamEvent> {
  const open = state.openText.get(messageId);
  if (open === undefined) {
    if (state.foreignText.has(messageId)) return;
    throw protocolError(`Text content arrived for unopened message ${messageId}.`);
  }
  open.text += delta;
  yield {
    type: 'stream:text-delta',
    content: delta,
    accumulated: open.text,
    messageId,
    ...wire(state),
  };
}

function* endText(state: MapperState, messageId: string): Generator<ChatStreamEvent> {
  const open = state.openText.get(messageId);
  if (open === undefined) {
    if (state.foreignText.delete(messageId)) return;
    throw protocolError(`Text message ${messageId} ended without starting.`);
  }
  state.openText.delete(messageId);
  if (open.text.length > 0) {
    state.messages.push({ id: messageId, role: 'assistant', content: open.text });
    state.texts.push(open.text);
  }
  yield { type: 'assistant.step.completed', step: open.step, messageId, ...wire(state) };
}

function* textChunk(
  state: MapperState,
  event: Extract<AGUIEvent, { type: EventType.TEXT_MESSAGE_CHUNK }>,
): Generator<ChatStreamEvent> {
  const messageId = event.messageId ?? state.textChunk;
  if (messageId === undefined)
    throw protocolError('The first TEXT_MESSAGE_CHUNK of a message must carry a messageId.');
  if (state.textChunk !== messageId) {
    yield* closeTextChunk(state);
    yield* startText(state, messageId, event.role ?? 'assistant');
    state.textChunk = messageId;
  }
  if (event.delta !== undefined && event.delta.length > 0)
    yield* textDelta(state, messageId, event.delta);
}

function* closeTextChunk(state: MapperState): Generator<ChatStreamEvent> {
  const messageId = state.textChunk;
  if (messageId === undefined) return;
  state.textChunk = undefined;
  yield* endText(state, messageId);
}

function* startCall(
  state: MapperState,
  toolCallId: string,
  name: string,
): Generator<ChatStreamEvent> {
  if (state.openCalls.has(toolCallId) || state.settledCalls.has(toolCallId))
    throw protocolError(`Tool call ${toolCallId} started twice.`);
  state.openCalls.set(toolCallId, { name, args: '' });
  yield { type: 'stream:tool-call-start', toolName: name, blockId: toolCallId, ...wire(state) };
}

function* callDelta(
  state: MapperState,
  toolCallId: string,
  delta: string,
): Generator<ChatStreamEvent> {
  const call = state.openCalls.get(toolCallId);
  if (call === undefined) throw protocolError(`Arguments arrived for unopened call ${toolCallId}.`);
  call.args += delta;
  // Cumulative, like every other producer of this frame.
  yield {
    type: 'stream:tool-call-delta',
    toolName: call.name,
    blockId: toolCallId,
    partialArguments: call.args,
    ...wire(state),
  };
}

function* endCall(state: MapperState, toolCallId: string): Generator<ChatStreamEvent> {
  const call = state.openCalls.get(toolCallId);
  if (call === undefined) throw protocolError(`Tool call ${toolCallId} ended without starting.`);
  state.openCalls.delete(toolCallId);
  state.settledCalls.add(toolCallId);
  const args = parseArguments(call.args);
  state.messages.push({
    id: `${toolCallId}:call`,
    role: 'assistant',
    toolCalls: [
      {
        id: toolCallId,
        type: 'function',
        function: { name: call.name, arguments: call.args === '' ? '{}' : call.args },
      },
    ],
  });
  yield {
    type: 'stream:tool-call-complete',
    toolName: call.name,
    blockId: toolCallId,
    arguments: args,
    ...wire(state),
  };
  yield { type: 'tool_call', id: toolCallId, name: call.name, arguments: args, ...wire(state) };
}

function* callChunk(
  state: MapperState,
  event: Extract<AGUIEvent, { type: EventType.TOOL_CALL_CHUNK }>,
): Generator<ChatStreamEvent> {
  const toolCallId = event.toolCallId ?? state.callChunk;
  if (toolCallId === undefined)
    throw protocolError('The first TOOL_CALL_CHUNK of a call must carry a toolCallId.');
  if (state.callChunk !== toolCallId) {
    yield* closeCallChunk(state);
    if (event.toolCallName === undefined)
      throw protocolError(`The first TOOL_CALL_CHUNK of ${toolCallId} must carry a toolCallName.`);
    yield* startCall(state, toolCallId, event.toolCallName);
    state.callChunk = toolCallId;
  }
  if (event.delta !== undefined && event.delta.length > 0)
    yield* callDelta(state, toolCallId, event.delta);
}

function* closeCallChunk(state: MapperState): Generator<ChatStreamEvent> {
  const toolCallId = state.callChunk;
  if (toolCallId === undefined) return;
  state.callChunk = undefined;
  yield* endCall(state, toolCallId);
}

function parseArguments(args: string): JSONValue {
  if (args === '') return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return isJSONValue(parsed) ? parsed : args;
  } catch {
    // Kept as written, like the conversation model does: the arguments are
    // the model's, and a malformed string is data about what it produced.
    return args;
  }
}

function* callResult(
  state: MapperState,
  event: Extract<AGUIEvent, { type: EventType.TOOL_CALL_RESULT }>,
): Generator<ChatStreamEvent> {
  if (!state.settledCalls.has(event.toolCallId))
    throw protocolError(`A result arrived for tool call ${event.toolCallId}, which has not ended.`);
  const message: AGUIToolMessage = {
    id: event.messageId,
    role: 'tool',
    toolCallId: event.toolCallId,
    content: event.content,
  };
  state.messages.push(message);
  yield { type: 'tool_result', ...fromAGUIToolMessage(message), ...wire(state) };
}

function startReasoningMessage(state: MapperState, messageId: string): void {
  const reasoning = requireReasoning(state, messageId);
  if (reasoning.messageOpen) throw protocolError(`Reasoning message ${messageId} started twice.`);
  reasoning.messageOpen = true;
}

function* reasoningChunk(
  state: MapperState,
  event: Extract<AGUIEvent, { type: EventType.REASONING_MESSAGE_CHUNK }>,
): Generator<ChatStreamEvent> {
  const messageId = event.messageId ?? state.reasoningChunk;
  if (messageId === undefined)
    throw protocolError('The first REASONING_MESSAGE_CHUNK must carry a messageId.');
  state.reasoningChunk = messageId;
  if (event.delta !== undefined && event.delta.length > 0)
    yield* reasoningDelta(state, messageId, event.delta, true);
}

function requireReasoning(state: MapperState, messageId: string): OpenReasoning {
  const reasoning = state.openReasoning.get(messageId);
  if (reasoning === undefined)
    throw protocolError(`Reasoning ${messageId} was used before REASONING_START.`);
  return reasoning;
}

function* startReasoning(state: MapperState, messageId: string): Generator<ChatStreamEvent> {
  if (state.openReasoning.has(messageId))
    throw protocolError(`Reasoning ${messageId} started twice.`);
  const block = newBlock(state, messageId, 'thinking', '');
  state.openReasoning.set(messageId, { block, messageOpen: false });
  yield { type: 'stream:block-start', block: { ...block }, ...wire(state) };
}

function* reasoningDelta(
  state: MapperState,
  messageId: string,
  delta: string,
  chunk: boolean,
): Generator<ChatStreamEvent> {
  const reasoning = requireReasoning(state, messageId);
  if (!chunk && !reasoning.messageOpen)
    throw protocolError(`Reasoning content arrived outside message ${messageId}.`);
  reasoning.block.content += delta;
  yield {
    type: 'stream:block-delta',
    block: { ...reasoning.block },
    delta,
    ...wire(state),
  };
}

function* endReasoning(state: MapperState, messageId: string): Generator<ChatStreamEvent> {
  const reasoning = requireReasoning(state, messageId);
  state.openReasoning.delete(messageId);
  if (state.reasoningChunk === messageId) state.reasoningChunk = undefined;
  const encryptedValue = state.encryptedValues.get(messageId);
  state.messages.push({
    id: messageId,
    role: 'reasoning',
    content: reasoning.block.content,
    ...(encryptedValue === undefined ? {} : { encryptedValue }),
  });
  yield {
    type: 'stream:block-complete',
    block: { ...reasoning.block, complete: true },
    ...wire(state),
  };
}

function recordEncryptedValue(state: MapperState, entityId: string, encryptedValue: string): void {
  state.encryptedValues.set(entityId, encryptedValue);
  // The value can trail the reasoning it belongs to.
  state.messages = state.messages.map((message) =>
    message.role === 'reasoning' && message.id === entityId
      ? { ...message, encryptedValue }
      : message,
  );
}
